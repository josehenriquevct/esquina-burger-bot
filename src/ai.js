// ── Modulo de IA — Claude (chat + tools + imagem) + Gemini (so audio) ──
// Claude Haiku 4.5 faz chat, function calling e analise de imagem. Claude
// nao suporta audio como input, entao transcricao continua usando Gemini
// 2.5-flash-lite (cota free generosa, suficiente pro volume de audios).
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { systemPrompt, promptInterno } from './prompts.js';
import { TOOL_DECLARATIONS, executarTool } from './tools.js';
import { carregarEstado, salvarEstado, limparEstado, mergeClienteSalvo, totalCarrinho } from './state.js';
import { getConversa, getConfigLoja, salvarConversa, buscarPedidoAbertoDoCliente } from './firebase.js';

var anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
var MODELO = config.anthropic.model;
var MODELO_FALLBACK = config.anthropic.modeloFallback;
var CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '30000', 10);
var CLAUDE_MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS || '1024', 10);

// Gemini reservado pra transcricao de audio (Claude nao suporta audio)
var genAI = new GoogleGenerativeAI(config.gemini.apiKey);
var GEMINI_AUDIO_MODEL = config.gemini.model;

// Falhas consecutivas por telefone — auto-pausa pra humano apos 2 falhas
var falhasPorTelefone = new Map();
var LIMITE_FALHAS = 2;

// Palavras-chave que pausam pra humano sem passar pelo modelo
var PALAVRAS_ESCALA_HUMANO = [
  'veio errado', 'pedido errado', 'lanche errado', 'chegou errado',
  'veio faltando', 'veio sem', 'veio incompleto', 'chegou faltando',
  'estornar', 'estorno', 'reembolso', 'reembolsar',
  'falar com atendente', 'chamar atendente', 'falar com humano',
  'atendimento humano', 'quero uma pessoa',
];

// Detecta erros que justificam tentar o modelo de fallback
function isErroModeloBloqueado(erro) {
  if (!erro) return false;
  if (erro instanceof Anthropic.RateLimitError) return true;
  if (erro instanceof Anthropic.InternalServerError) return true;
  var status = erro.status || 0;
  if (status === 429 || status === 529 || status >= 500) return true;
  var msg = String(erro.message || '');
  return /overloaded|rate.?limit|exceeded/i.test(msg);
}

// Promise.race com timeout pra evitar chamada pendurada travar a fila
function comTimeout(promise, ms, mensagemErro) {
  if (!mensagemErro) mensagemErro = 'timeout';
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error(mensagemErro)); }, ms);
    promise.then(
      function (v) { clearTimeout(t); resolve(v); },
      function (e) { clearTimeout(t); reject(e); }
    );
  });
}

// Extrai texto concatenado de response.content (array de blocks)
function extrairTexto(content) {
  if (!Array.isArray(content)) return '';
  var partes = [];
  for (var i = 0; i < content.length; i++) {
    if (content[i] && content[i].type === 'text' && content[i].text) {
      partes.push(content[i].text);
    }
  }
  return partes.join('\n').trim();
}

// Extrai tool_use blocks de response.content
function extrairToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(function (b) { return b && b.type === 'tool_use'; });
}

// Faz a chamada ao Claude com fallback automatico se o modelo principal
// retornar 429/500. Retorna a response final.
async function chamarClaude(params) {
  try {
    return await comTimeout(
      anthropic.messages.create(Object.assign({}, params, { model: MODELO })),
      CLAUDE_TIMEOUT_MS,
      'claude-timeout'
    );
  } catch (e) {
    if (isErroModeloBloqueado(e) && MODELO_FALLBACK && MODELO_FALLBACK !== MODELO) {
      console.warn('Modelo ' + MODELO + ' falhou (' + String(e.message).slice(0, 80) + '). Tentando fallback ' + MODELO_FALLBACK);
      return await comTimeout(
        anthropic.messages.create(Object.assign({}, params, { model: MODELO_FALLBACK })),
        CLAUDE_TIMEOUT_MS,
        'claude-timeout-fb'
      );
    }
    throw e;
  }
}

// ── Transcricao de audio via Gemini ────────────────────────────

export async function transcreverAudio(base64Audio, mimetype) {
  if (!mimetype) mimetype = 'audio/ogg';
  try {
    var model = genAI.getGenerativeModel({ model: GEMINI_AUDIO_MODEL });
    var result = await model.generateContent([
      { inlineData: { mimeType: mimetype, data: base64Audio } },
      { text: 'Transcreva exatamente o que a pessoa esta falando neste audio. Retorne APENAS o texto falado, sem explicacoes, sem aspas. Se nao entender, retorne "[audio nao compreendido]".' },
    ]);
    var transcricao = result.response.text();
    if (transcricao) transcricao = transcricao.trim();
    if (!transcricao) return '[audio nao compreendido]';
    console.log('Transcricao: "' + transcricao.slice(0, 80) + (transcricao.length > 80 ? '...' : '') + '"');
    return transcricao;
  } catch (e) {
    console.error('Erro ao transcrever audio:', e.message);
    return '[erro ao transcrever audio]';
  }
}

// ── Analisar imagem via Claude ─────────────────────────────────
// Claude tem visao nativa e costuma reconhecer comprovantes PIX melhor
// que o Gemini lite.

export async function analisarImagem(base64Img, mimetype) {
  if (!mimetype) mimetype = 'image/jpeg';
  try {
    var resp = await comTimeout(
      anthropic.messages.create({
        model: MODELO,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimetype, data: base64Img } },
            { type: 'text', text: 'Analise esta imagem. Se for um comprovante de pagamento Pix, extraia: valor, data/hora, nome do pagador e nome do recebedor. Responda EXATAMENTE neste formato: "[COMPROVANTE PIX DETECTADO: valor=R$XX,XX | pagador=NOME | recebedor=NOME | data=DD/MM/AAAA HH:MM]". Se NAO for um comprovante de pagamento, responda exatamente: "[IMAGEM ANALISADA: nao e comprovante]". Nao adicione nenhum outro texto.' },
          ],
        }],
      }),
      CLAUDE_TIMEOUT_MS,
      'claude-img-timeout'
    );
    var analise = extrairTexto(resp.content);
    if (!analise) return '[IMAGEM ANALISADA: nao e comprovante]';
    console.log('Analise imagem: ' + analise.slice(0, 100));
    return analise;
  } catch (e) {
    console.error('Erro ao analisar imagem:', e.message);
    return '[erro ao analisar imagem]';
  }
}

// ── Validacao de total na resposta do Claude ────────────────────
// Claude as vezes apresenta resumo com items e total alucinados (ja
// observado nos pedidos cod 8664 e 2331: bot mostrou Total R$ 47 mas
// o carrinho real tinha 3 itens somando R$ 80 + taxa, cliente foi
// cobrado R$ 83). Antes de devolver a resposta pro cliente, a gente
// extrai todos os "Total: R$ X" do texto e compara com o total real
// do estado. Se divergir mais de 50 centavos, substituimos a resposta
// inteira pelo resumo correto gerado pelo backend — a verdade vem do
// estado, nao da prosa do Claude.
async function validarTotalNaResposta(texto, estado) {
  if (!texto || !estado || !Array.isArray(estado.carrinho) || estado.carrinho.length === 0) {
    return texto;
  }
  var matches = [];
  // \btotal\b nao bate em "subtotal" (palavra contigua, sem word boundary
  // interno). Captura "Total: R$X", "Total — R$X", "Total ficou em R$X",
  // "valor R$X", etc — ate 25 chars entre "total" e "R$".
  var re = /\b(?:total|valor)\b[^\n]{0,25}?r\$\s*(\d+(?:[.,]\d{1,2})?)/gi;
  var m;
  while ((m = re.exec(texto)) !== null) {
    matches.push(parseFloat(m[1].replace(',', '.')));
  }
  if (!matches.length) return texto;

  var subtotal = totalCarrinho(estado);
  var taxa = 0;
  if (estado.dados && estado.dados.tipo === 'delivery') {
    try {
      var cfgLoja = await getConfigLoja();
      taxa = (cfgLoja && typeof cfgLoja.taxa_entrega === 'number')
        ? cfgLoja.taxa_entrega
        : parseFloat(config.restaurante.taxaEntrega || '0');
    } catch (e) {
      taxa = parseFloat(config.restaurante.taxaEntrega || '0');
    }
  }
  var totalReal = subtotal + taxa;

  var todosBatem = matches.every(function (v) { return Math.abs(v - totalReal) < 0.5; });
  if (todosBatem) return texto;

  console.warn('[guardrail] total na resposta do Claude divergente. Claude=[' + matches.join(',') + '] real=' + totalReal + ' — substituindo pelo resumo correto');
  var resumoCorreto = await construirResumoParaCliente(estado);
  return resumoCorreto || ('O total correto do seu pedido e R$ ' + totalReal.toFixed(2).replace('.', ',') + '. Confirma?');
}

// ── Curto-circuito de confirmacao ───────────────────────────────
// Claude as vezes reapresenta resumo quando cliente diz "confirma" apos
// ja ter visto um resumo. Quando o estado esta todo preenchido e o
// cliente claramente confirmou, a gente finaliza direto.

// Forma "curta" de confirmacao. Deliberadamente restrito — nao captura
// frases longas que podem conter info extra (ex: "confirma com entrega
// pra amanha" — isso precisa ir pro Claude porque tem requisito novo).
var REGEX_CONFIRMACAO_CURTA = /^\s*(confirma(r|do|do sim)?|isso(\s*mesmo)?|pode(\s*ser|\s*confirmar|\s*sim|\s*finalizar)?|sim|ok|okay|beleza|certo|claro|perfeito|fechou?|fecha(r)?|finaliza(r)?|ta\s*bom|tudo\s*certo|(eh|e)\s*isso|vai\s*sim|bora(\s*la)?|manda|manda\s*ver|pode\s*mandar|👍|✅)\s*[.!]*\s*$/i;

function ehConfirmacaoCurta(texto) {
  return REGEX_CONFIRMACAO_CURTA.test(String(texto || ''));
}

// Detecta perguntas de valor — "quanto fica?", "quanto deu?", "qual o
// total?", "quanto a taxa?", etc. Quando cliente pergunta valor, Claude
// as vezes some mentalmente e erra (visto na conversa da Nadja: 2 Juniors
// no carrinho mas Claude disse "1 lanche = R$ 35"). Curto-circuito devolve
// o resumo do estado real, calculado pelo backend.
var REGEX_PERGUNTA_VALOR = /\b(quanto|qual)\b.{0,40}\b(fica|deu|da|dá|sai|saiu|custa|é|e|ficou|vai\s*dar|total|taxa|valor|preco|preço)\b|\b(total|valor)\b\s*[\?]?\s*$|\bme\s+da\s+o\s+total\b|\bsoma\b.*\b(quanto|total|valor)\b/i;

function ehPerguntaDeValor(texto) {
  var t = String(texto || '').trim();
  if (t.length > 60) return false; // frases longas — provavelmente nao e so pergunta
  return REGEX_PERGUNTA_VALOR.test(t);
}

function estadoProntoParaFinalizar(estado) {
  if (!estado || !Array.isArray(estado.carrinho) || estado.carrinho.length === 0) return false;
  var d = estado.dados || {};
  if (!d.nome && !d.nome_whatsapp) return false;
  if (!d.tipo) return false;
  if (!d.pagamento) return false;
  if (d.tipo === 'delivery') {
    var loc = d.localizacao;
    var temEnd = !!d.endereco || (loc && loc.lat && loc.lng);
    if (!temEnd) return false;
  }
  // Se esta alterando pedido existente, nao curto-circuita — deixa Claude
  // lidar (pode precisar confirmar as mudancas explicitamente).
  if (estado.pedidoKeyExistente) return false;
  return true;
}

// Monta a mensagem final de confirmacao do pedido no mesmo formato que
// Claude geraria — codigo + total + aviso por tipo.
function gerarMensagemFinalizacao(rFinal, estado) {
  var codigo = rFinal.codigoConfirmacao || '????';
  var totalStr = 'R$ ' + Number(rFinal.total || 0).toFixed(2).replace('.', ',');
  var tipo = (estado.dados && estado.dados.tipo) || 'retirada';
  var pixEnviado = rFinal.pix_enviado;
  var rastreioLink = rFinal.rastreioLink || '';
  var linhas = [];
  linhas.push('Pedido confirmado! Código: *' + codigo + '*. Total: *' + totalStr + '*.');
  if (pixEnviado) {
    linhas.push('O QR Code PIX e o código copia-cola já foram enviados pra você — é só escanear ou copiar e colar no app do banco.');
  }
  if (tipo === 'delivery') {
    linhas.push('Chega em 30 a 40 min — te aviso quando sair pra entrega! 🛵');
    if (rastreioLink) linhas.push('Rastreio: ' + rastreioLink);
  } else {
    linhas.push('Assim que ficar pronto eu te aviso! 🍔');
  }
  return linhas.join('\n\n');
}

// ── Contexto de estado (carrinho + pedido parcial) ─────────────
// Injetado num bloco separado do system prompt (sem cache_control) pra
// que Claude sempre saiba o que tem no carrinho e o que o cliente ja
// informou. Lista QTD + NOME dos itens — NAO inclui total, pra forcar
// Claude a chamar ver_pedido_atual quando precisar falar valor.
function construirContextoEstado(estado) {
  if (!estado) return '';
  var linhas = [];
  var carrinho = estado.carrinho || [];
  if (carrinho.length > 0) {
    linhas.push('ESTADO ATUAL DO PEDIDO (voce tem acesso real-time a isso, nao precisa chamar ver_pedido_atual so pra lembrar):');
    linhas.push('Itens no carrinho:');
    for (var i = 0; i < carrinho.length; i++) {
      var it = carrinho[i];
      var obs = it.obs ? ' (' + it.obs + ')' : '';
      linhas.push('  - ' + it.qtd + 'x ' + it.nome + obs);
    }
  } else {
    linhas.push('ESTADO ATUAL: carrinho vazio.');
  }
  var d = estado.dados || {};
  var parciais = [];
  if (d.nome) parciais.push('nome=' + d.nome);
  if (d.tipo) parciais.push('tipo=' + d.tipo);
  if (d.pagamento) parciais.push('pagamento=' + d.pagamento + (d.troco ? ' (troco pra ' + d.troco + ')' : ''));
  if (d.endereco) parciais.push('endereco=' + d.endereco);
  if (d.localizacao && d.localizacao.lat) parciais.push('localizacao=GPS');
  if (d.agendadoPara) parciais.push('agendado_para=' + d.agendadoPara);
  if (parciais.length) linhas.push('Dados ja coletados: ' + parciais.join('; '));
  if (estado.pedidoKeyExistente) linhas.push('ATENCAO: cliente esta ALTERANDO um pedido existente (id=' + estado.pedidoKeyExistente + '). Ao chamar finalizar_pedido, o sistema atualiza o pedido em vez de duplicar.');
  linhas.push('Lembre: para INFORMAR o valor total ao cliente, ainda use ver_pedido_atual (tem o calculo exato com taxa de entrega).');

  // ── Oportunidades de upsell (so sinaliza, Claude decide quando oferecer) ──
  // Detecta por heuristica de nome (carrinho real de pedido de hamburgueria).
  if (carrinho.length > 0 && process.env.UPSELL_ATIVO !== 'false') {
    var temBurger = carrinho.some(function (i) {
      return /burger|blade|bacon|lanche|esquina/i.test(i.nome) && !/bacon.*extra|bacon$/i.test(i.nome);
    });
    var temPorcao = carrinho.some(function (i) {
      return /frita|porcao|porção|cheddar.*bacon/i.test(i.nome);
    });
    var temBebida = carrinho.some(function (i) {
      return /coca|refri|suco|agua|água|guaran|sprite|fanta|bebida/i.test(i.nome);
    });
    if (temBurger && !temPorcao) {
      linhas.push('\n🍟 UPSELL OBRIGATORIO — fritas: carrinho tem burger sem fritas. ANTES de pedir nome/tipo/pagamento, quando cliente disser "so isso"/"acabou"/"fechou"/"e so", sua PRIMEIRA pergunta DEVE ser: "Quer uma fritas pra acompanhar? Tem a 100g por R$ 8 ou a Cheddar e Bacon por R$ 35." (NAO pule direto pra dados). Se cliente recusar ("nao", "nao quero"), vai pros dados. Se aceitar, chame adicionar_item.');
    } else if (temBurger && !temBebida) {
      linhas.push('\n🥤 UPSELL OBRIGATORIO — bebida: carrinho tem lanche sem bebida. ANTES de pedir nome/tipo/pagamento, quando cliente disser "so isso"/"acabou", pergunte: "Quer uma bebida pra acompanhar? Coca lata R$ 8, 600ml R$ 10 ou 2L R$ 15." Se cliente recusar, vai pros dados. Se aceitar, adicione.');
    }
    // NAO oferece upsell em turnos futuros: se ja ofereceu e cliente recusou,
    // o historico mostra isso, Claude respeita. Nao precisa flag de estado.
  }

  return linhas.join('\n');
}

// Resumo do pedido para exibir ao cliente quando Claude nao gera texto
// depois de ver_pedido_atual. Inclui itens com preco, total e dados
// parciais — tudo que um "Confirma?" precisa pra fechar o pedido.
async function construirResumoParaCliente(estado) {
  if (!estado || !Array.isArray(estado.carrinho) || estado.carrinho.length === 0) return '';
  var linhas = ['Seu pedido:'];
  for (var i = 0; i < estado.carrinho.length; i++) {
    var it = estado.carrinho[i];
    var obs = it.obs ? ' (' + it.obs + ')' : '';
    var preco = it.subtotal ? ' — R$ ' + Number(it.subtotal).toFixed(2).replace('.', ',') : '';
    linhas.push('- ' + it.qtd + 'x ' + it.nome + obs + preco);
  }
  var subtotal = totalCarrinho(estado);
  var d = estado.dados || {};
  // Taxa de entrega: prioriza Firebase (gerenciavel no PDV), senao cai
  // na env var. Mesma logica da taxaEntrega() em tools.js.
  var taxa = 0;
  if (d.tipo === 'delivery') {
    try {
      var cfgLoja = await getConfigLoja();
      if (cfgLoja && typeof cfgLoja.taxa_entrega === 'number') {
        taxa = cfgLoja.taxa_entrega;
      } else {
        taxa = parseFloat(config.restaurante.taxaEntrega || '0');
      }
    } catch (e) {
      taxa = parseFloat(config.restaurante.taxaEntrega || '0');
    }
  }
  var total = subtotal + taxa;
  if (taxa) linhas.push('- Taxa de entrega: R$ ' + taxa.toFixed(2).replace('.', ','));
  linhas.push('Total: R$ ' + total.toFixed(2).replace('.', ','));
  var info = [];
  if (d.tipo) info.push('Tipo: ' + d.tipo);
  if (d.pagamento) info.push('Pagamento: ' + d.pagamento + (d.troco ? ' (troco ' + d.troco + ')' : ''));
  if (d.nome) info.push('Nome: ' + d.nome);
  if (d.tipo === 'delivery' && d.endereco) info.push('Endereco: ' + d.endereco);
  if (info.length) linhas.push(info.join(' | '));
  linhas.push('');
  linhas.push('Confirma?');
  return linhas.join('\n');
}

// ── Helpers de historico ───────────────────────────────────────

// Converte o historico do Firebase em messages no formato Anthropic.
// Regras: primeira msg tem que ser user, msgs vazias descartadas. Msgs
// consecutivas de mesmo role sao OK (Claude combina internamente).
function construirHistorico(historicoRaw, textoAtual) {
  var history = [];
  for (var i = 0; i < historicoRaw.length; i++) {
    var m = historicoRaw[i];
    var role = m.role === 'assistant' ? 'assistant' : 'user';
    var text = m.texto || m.content || '';
    if (!text) continue;
    history.push({ role: role, content: String(text) });
  }
  // Remove ultimas msgs do user que repetem o texto atual (evita duplicar)
  while (history.length > 0 && history[history.length - 1].role === 'user') {
    var ultimo = history[history.length - 1].content;
    if (ultimo === textoAtual || ultimo.endsWith(textoAtual)) {
      history.pop();
    } else {
      break;
    }
  }
  // Primeira msg tem que ser user
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }
  // Mensagem atual
  history.push({ role: 'user', content: String(textoAtual) });
  return history;
}

// ── Processar mensagem do cliente ──────────────────────────────

export async function processarMensagem(telefone, texto, pushName, imagemData) {
  // Se pausado para humano, nao responde
  var conversaAtual = await getConversa(telefone).catch(function () { return null; });
  if (conversaAtual && conversaAtual.status === 'pausado_humano') return null;

  // Escalacao imediata por palavra-chave
  var textoCheck = String(texto || '').toLowerCase();
  for (var pc = 0; pc < PALAVRAS_ESCALA_HUMANO.length; pc++) {
    if (textoCheck.indexOf(PALAVRAS_ESCALA_HUMANO[pc]) !== -1) {
      try {
        await salvarConversa(telefone, {
          status: 'pausado_humano',
          motivoTransferencia: 'palavra_chave:' + PALAVRAS_ESCALA_HUMANO[pc],
        });
      } catch (eSalvar) {
        console.warn('Erro ao pausar por palavra-chave:', eSalvar.message);
      }
      console.log('Auto-pausado palavra-chave "' + PALAVRAS_ESCALA_HUMANO[pc] + '": ' + telefone);
      return 'Entendi. Vou te transferir pra um atendente humano agora. 🙏 Em instantes alguem te responde aqui.';
    }
  }

  // Carrega estado + dados do cliente salvos
  var estado = await carregarEstado(telefone);
  estado.dados.telefone = telefone;
  if (pushName && !estado.dados.nome_whatsapp) estado.dados.nome_whatsapp = pushName;
  await mergeClienteSalvo(estado);

  if (conversaAtual && conversaAtual.localizacaoRecente && !estado.dados.localizacao) {
    estado.dados.localizacao = conversaAtual.localizacaoRecente;
  }

  var configLoja = await getConfigLoja();
  var loc = estado.dados.localizacao || null;
  configLoja.cliente_salvo = {
    nome: estado.dados.nome || '',
    endereco: estado.dados.endereco || '',
    bairro: estado.dados.bairro || '',
    referencia: estado.dados.referencia || '',
    temLocalizacao: !!(loc && loc.lat && loc.lng),
  };

  // Se tem imagem, analisa e injeta o resultado na msg atual
  if (imagemData && imagemData.base64) {
    try {
      var analise = await analisarImagem(imagemData.base64, imagemData.mimetype || 'image/jpeg');
      console.log('Imagem analisada para ' + telefone + ': ' + analise.slice(0, 80));
      if (analise.indexOf('[erro') !== -1) {
        texto = texto + '\n[Cliente enviou uma imagem mas a analise falhou. Peca pra reenviar ou descrever por texto. NAO confirme pagamento sem ver o comprovante.]';
      } else {
        texto = texto + '\n' + analise;
      }
    } catch (e) {
      console.error('Erro ao analisar imagem:', e.message);
      texto = texto + '\n[Cliente enviou uma imagem mas a analise falhou. Peca pra reenviar ou descrever por texto. NAO confirme pagamento sem ver o comprovante.]';
    }
  }

  // ── Curto-circuito de confirmacao ───────────────────────────────
  // Se o cliente disser uma confirmacao clara ("confirma", "pode", "ok"...)
  // e o estado esta completo (itens + nome + tipo + pagto + endereco se
  // delivery), finaliza DIRETO sem passar pelo Claude. Claude as vezes
  // insiste em perguntar "confirma?" de novo mesmo com o estado pronto —
  // esse atalho evita esse bug e economiza 1 chamada Claude.
  if (ehConfirmacaoCurta(texto) && estadoProntoParaFinalizar(estado)) {
    console.log('Curto-circuito de confirmacao: finalizando direto para ' + telefone);
    try {
      var rFinal = await executarTool(telefone, 'finalizar_pedido', {}, estado);
      if (rFinal && rFinal.sucesso) {
        estado._limpar = true;
        await limparEstado(telefone);
        var msgFinal = gerarMensagemFinalizacao(rFinal, estado);
        return msgFinal;
      }
    } catch (eCurto) {
      console.error('Curto-circuito falhou, caindo no fluxo normal:', eCurto.message);
      // Continua o fluxo normal com o Claude
    }
  }

  // ── Curto-circuito de pergunta de valor ─────────────────────────
  // Cliente perguntou "quanto fica/deu/total/taxa". Claude as vezes
  // soma de cabeca e erra (caso real: pedido cod 3921, 2 Juniors no
  // carrinho mas Claude respondeu "1 lanche = R$ 35", cliente
  // confirmou achando 35 e foi cobrado 59). Aqui devolvemos o resumo
  // calculado pelo backend, sempre correto.
  if (estado.carrinho && estado.carrinho.length > 0 && ehPerguntaDeValor(texto)) {
    console.log('Curto-circuito de pergunta de valor: devolvendo resumo do estado para ' + telefone);
    try {
      var resumoVal = await construirResumoParaCliente(estado);
      if (resumoVal) {
        await salvarEstado(telefone, estado);
        return resumoVal;
      }
    } catch (eVal) {
      console.error('Curto-circuito de valor falhou:', eVal.message);
      // Cai no fluxo normal
    }
  }

  var historicoRaw = (conversaAtual && conversaAtual.mensagens) ? conversaAtual.mensagens.slice(-20) : [];
  var messages = construirHistorico(historicoRaw, texto);

  // System prompt em 2 blocos: (1) estavel, com cache_control — reusa
  // prefixo em msgs sucessivas do mesmo cliente (~90% mais barato);
  // (2) contexto atual do pedido (carrinho, tipo, pagto), volatil,
  // SEM cache pra nao invalidar o prefixo. Isso garante que Claude
  // sempre sabe o estado do carrinho sem precisar chamar ver_pedido_atual
  // so pra se lembrar.
  var sysPrompt = await systemPrompt(configLoja);
  var systemBlocks = [
    { type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } },
  ];

  // Se o estado esta vazio mas o cliente tem pedido aberto recente, busca e
  // injeta a info no contexto — assim Claude sabe que pode alterar via
  // carregar_pedido_recente em vez de responder "pedido em preparo" a seco.
  var pedidoAbertoHint = '';
  if ((!estado.carrinho || estado.carrinho.length === 0) && !estado.pedidoKeyExistente) {
    try {
      var pAberto = await buscarPedidoAbertoDoCliente(telefone, 30);
      if (pAberto) {
        var itensFmt = (pAberto.itens || []).map(function (i) {
          return '  - ' + i.qtd + 'x ' + i.nome + (i.obs ? ' (' + i.obs + ')' : '');
        }).join('\n');
        var codigo = pAberto.codigoConfirmacao || '(nao setado)';
        var totalFmt = 'R$ ' + Number(pAberto.total || 0).toFixed(2).replace('.', ',');
        var statusAtual = pAberto.status || 'aguardando';

        if (statusAtual === 'aguardando') {
          pedidoAbertoHint = '⚠️ ATENCAO CRITICA: CLIENTE TEM PEDIDO ABERTO RECENTE — AINDA NAO ACEITO PELA COZINHA — PODE SER ALTERADO:\n' +
            'Codigo: ' + codigo + '\n' +
            'Status: aguardando (NAO esta em preparo, pode alterar)\n' +
            'Itens:\n' + itensFmt + '\n' +
            'Total atual: ' + totalFmt + '\n\n' +
            'REGRA ABSOLUTA: se o cliente pedir QUALQUER alteracao ("adiciona mais X", "tira Y", "muda pagamento", "esqueci de X", "no pedido que acabei de fazer"):\n' +
            '1. Sua PRIMEIRA tool call OBRIGATORIA e carregar_pedido_recente. Nao responda antes.\n' +
            '2. Use adicionar_item/remover_item conforme pedido.\n' +
            '3. Chame finalizar_pedido (vai ATUALIZAR, nao duplicar).\n' +
            '4. Confirme o NOVO total ao cliente.';
          console.log('Hint injetado (aguardando): ' + telefone + ' pedido ' + codigo);
        } else {
          pedidoAbertoHint = '⚠️ ATENCAO: CLIENTE TEM PEDIDO RECENTE JA ACEITO PELA COZINHA:\n' +
            'Codigo: ' + codigo + '\n' +
            'Status: ' + statusAtual + ' (ja esta em preparo/saiu pra entrega — NAO pode mais ser alterado automaticamente)\n' +
            'Itens:\n' + itensFmt + '\n' +
            'Total: ' + totalFmt + '\n\n' +
            'REGRA ABSOLUTA: se o cliente pedir alteracao desse pedido ("adiciona X", "tira Y", "esqueci de pedir", "no pedido que acabei de fazer"):\n' +
            '1. NAO minta que da pra alterar, NAO diga "liga pra gente" ou "fala com a cozinha" — isso nao resolve nada.\n' +
            '2. Chame transferir_humano IMEDIATAMENTE com motivo "alterar pedido ja aceito - ' + codigo + '" — um atendente humano pode ajustar manualmente no PDV ou enviar junto.\n' +
            '3. Antes de transferir, avise o cliente em uma frase: "Seu pedido ja entrou na cozinha. Vou te passar pra um atendente agora pra ajustar isso pra voce."';
          console.log('Hint injetado (pedido ja aceito): ' + telefone + ' pedido ' + codigo + ' status=' + statusAtual);
        }
      }
    } catch (ePed) {
      console.warn('Erro ao buscar pedido aberto:', ePed.message);
    }
  }

  var contextoEstado = construirContextoEstado(estado);
  if (pedidoAbertoHint) {
    systemBlocks.push({ type: 'text', text: pedidoAbertoHint });
  }
  if (contextoEstado) {
    systemBlocks.push({ type: 'text', text: contextoEstado });
  }

  var persistir = async function () {
    if (estado._limpar) {
      await limparEstado(telefone);
    } else {
      await salvarEstado(telefone, estado);
    }
  };

  // Primeira chamada ao Claude
  var result;
  try {
    result = await chamarClaude({
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemBlocks,
      tools: TOOL_DECLARATIONS,
      messages: messages,
    });
    falhasPorTelefone.delete(telefone);
  } catch (e) {
    console.error('Claude erro inicial:', e.message);
    await salvarEstado(telefone, estado);
    var falhas = (falhasPorTelefone.get(telefone) || 0) + 1;
    falhasPorTelefone.set(telefone, falhas);
    if (falhas >= LIMITE_FALHAS) {
      falhasPorTelefone.delete(telefone);
      try {
        await salvarConversa(telefone, {
          status: 'pausado_humano',
          motivoTransferencia: 'claude_falhou: ' + String(e.message || '').slice(0, 120),
        });
      } catch (eSalvar) { console.warn('Erro ao pausar:', eSalvar.message); }
      console.error('Auto-pausado apos ' + falhas + ' falhas Claude: ' + telefone);
      return 'So um instante, vou te direcionar pra um atendente humano. 🙏';
    }
    return 'Desculpe, tive um problema aqui. Pode repetir?';
  }

  // Loop de tool use
  var ultimaToolUsada = '';
  for (var j = 0; j < 10; j++) {
    // Final — Claude nao quer mais tools, so texto
    if (result.stop_reason === 'end_turn' || result.stop_reason === 'stop_sequence') {
      var txt = extrairTexto(result.content);
      if (txt) {
        await persistir();
        // Guardrail: garante que qualquer "Total: R$ X" no texto bate
        // com o total real do estado. Se divergir, substitui pelo
        // resumo correto. Evita Claude alucinar valor e cliente ser
        // cobrado diferente do que viu.
        return await validarTotalNaResposta(txt, estado);
      }
      // Texto vazio sem tool — fallbacks heuristicos
      console.error('Claude retornou texto vazio. Ultima tool:', ultimaToolUsada, 'StopReason:', result.stop_reason);
      return await tratarRespostaVazia(telefone, texto, ultimaToolUsada, estado, persistir);
    }

    // Tool use — executa todas as tools do turno
    if (result.stop_reason === 'tool_use') {
      var toolUses = extrairToolUses(result.content);
      if (toolUses.length === 0) {
        // Stop reason diz tool_use mas nao veio tool — anomalia, trata como fim
        var txtAnom = extrairTexto(result.content);
        await persistir();
        return txtAnom || 'Pode repetir, por favor?';
      }

      var toolResults = [];
      var fotoCardapioOk = false;
      for (var k = 0; k < toolUses.length; k++) {
        var tu = toolUses[k];
        ultimaToolUsada = tu.name;
        try {
          var r = await executarTool(telefone, tu.name, tu.input || {}, estado);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify(r),
          });
          if (tu.name === 'enviar_foto_cardapio' && r && r.sucesso) fotoCardapioOk = true;
        } catch (eTool) {
          console.error('Erro na tool ' + tu.name + ':', eTool.message);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ erro: eTool.message }),
            is_error: true,
          });
        }
      }

      // Curto-circuito: enviar_foto_cardapio sozinha ja cobre a resposta.
      // A legenda da foto orienta o cliente — evita round-trip extra
      // (economia de tokens e latencia).
      if (fotoCardapioOk && toolUses.length === 1) {
        await persistir();
        console.log('Foto do cardapio enviada — encerrando sem consultar Claude novamente');
        return '';
      }

      // Continua o loop com os resultados das tools
      messages.push({ role: 'assistant', content: result.content });
      messages.push({ role: 'user', content: toolResults });

      try {
        result = await chamarClaude({
          max_tokens: CLAUDE_MAX_TOKENS,
          system: systemBlocks,
          tools: TOOL_DECLARATIONS,
          messages: messages,
        });
      } catch (eFollow) {
        console.error('Claude follow-up erro (apos ' + ultimaToolUsada + '):', eFollow.message);
        await persistir();
        if (ultimaToolUsada === 'enviar_foto_cardapio') return 'Mandei o cardápio! O que vai querer? 🍔';
        if (ultimaToolUsada === 'finalizar_pedido') return 'Pedido enviado pra cozinha!';
        return 'Tive um problema aqui, pode tentar de novo?';
      }
      continue;
    }

    // Outros stop_reasons (max_tokens, pause_turn, refusal) — encerra
    break;
  }

  await persistir();
  var textoFinal = extrairTexto(result.content);
  return textoFinal || 'Desculpe, tive um problema. Pode repetir?';
}

// ── Fallbacks heuristicos quando Claude retorna texto vazio ──────
// Cobre 2 casos: (1) Claude chamou tool e terminou sem texto — resposta
// por tool; (2) Claude nao entendeu o input do cliente — fallback por
// padrao do texto (sim/nao/nome/cardapio).
async function tratarRespostaVazia(telefone, texto, ultimaToolUsada, estado, persistir) {
  await persistir();

  // Respostas por tool (Claude as vezes termina sem texto apos executar tool)
  if (ultimaToolUsada === 'enviar_foto_cardapio') return '';
  if (ultimaToolUsada === 'finalizar_pedido') return 'Prontinho, pedido na cozinha!';
  if (ultimaToolUsada === 'adicionar_item') return 'Anotei! Mais alguma coisa?';
  if (ultimaToolUsada === 'remover_item') return 'Removi! Mais alguma coisa?';
  if (ultimaToolUsada === 'cancelar_pedido') return 'Cancelei! Se quiser comecar de novo, e so pedir.';
  if (ultimaToolUsada === 'ver_cardapio_categoria') return 'Me diz qual voce quer!';
  if (ultimaToolUsada === 'ver_pedido_atual') {
    // Fallback com resumo real — se Claude pulou o texto apos ver_pedido_atual,
    // a gente mesmo gera o resumo com os itens e total. Assim no proximo turno
    // cliente sabe exatamente o que tem e "confirma" vira um finalizar claro.
    var resumo = await construirResumoParaCliente(estado);
    return resumo || 'Esse e o seu pedido. Confirma?';
  }
  if (ultimaToolUsada === 'salvar_cliente') return 'Anotei! Agora me diz se e entrega, retirada ou salao.';
  if (ultimaToolUsada === 'definir_tipo_pedido') return 'Anotei! Como prefere pagar — pix, cartao ou dinheiro?';
  if (ultimaToolUsada === 'definir_pagamento') return 'Anotei! Vou finalizar, confirma pra eu mandar pra cozinha?';
  if (ultimaToolUsada === 'carregar_pedido_recente') return 'Peguei seu pedido aqui. O que voce quer alterar?';
  if (ultimaToolUsada === 'agendar_pedido') return 'Agendado! O que mais voce quer pedir?';
  if (ultimaToolUsada === 'transferir_humano') return 'Ja chamei um atendente. Em instantes alguem te responde.';

  var textoLower = String(texto || '').toLowerCase().trim();
  // Fallback cardapio — cliente pediu, Claude travou: manda a foto direto
  if (/card[áa]pio|menu|\bver\b.*comida|\bo que\b.*tem/.test(textoLower)) {
    console.log('Fallback cardápio: chamando enviar_foto_cardapio diretamente');
    try {
      await executarTool(telefone, 'enviar_foto_cardapio', {}, estado);
      return '';
    } catch (efb) {
      console.error('Fallback enviar_foto_cardapio falhou:', efb.message);
    }
  }

  if (/^(sim|isso|isso mesmo|pode|pode ser|ok|okay|beleza|certo|claro|perfeito|tudo certo|taokay|ta okay|ta bom|👍|✅)$/i.test(textoLower)) {
    return 'Beleza! Me conta o que mais voce quer pedir, ou se ja ta tudo certo.';
  }
  if (/^(nao|não|so isso|só isso|so|só|s[oó] isso mesmo|fechou|fechar)$/i.test(textoLower)) {
    return 'Certo! Se quiser finalizar o pedido, me diz seu nome, se é entrega ou retirada, e a forma de pagamento.';
  }

  var textoOriginal = String(texto || '').trim();
  if (!estado.dados.nome &&
      /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+( [A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+)?$/.test(textoOriginal) &&
      textoOriginal.length >= 3 && textoOriginal.length <= 40) {
    estado.dados.nome = textoOriginal;
    await persistir();
    console.log('Fallback nome: salvo "' + textoOriginal + '"');
    return 'Beleza, ' + textoOriginal.split(' ')[0] + '! Agora me diz se é entrega, retirada ou salão.';
  }
  return 'Pode repetir, por favor? Nao consegui entender direito.';
}

// ── Processar pedido interno (funcionario manda audio) ─────────

export async function processarPedidoInterno(telefone, texto) {
  console.log('PEDIDO INTERNO de ' + telefone + ': ' + texto.slice(0, 100));

  var estado = { carrinho: [], dados: { telefone: telefone }, pedidoKeyExistente: null };
  var sysPrompt = await promptInterno();
  var systemBlocks = [
    { type: 'text', text: sysPrompt, cache_control: { type: 'ephemeral' } },
  ];

  var messages = [{ role: 'user', content: texto }];

  var result;
  try {
    result = await chamarClaude({
      max_tokens: 800,
      system: systemBlocks,
      tools: TOOL_DECLARATIONS,
      messages: messages,
    });
  } catch (e) {
    console.error('Claude pedido interno erro:', e.message);
    return 'Nao entendi o pedido. Pode repetir?';
  }

  for (var j = 0; j < 12; j++) {
    if (result.stop_reason === 'end_turn' || result.stop_reason === 'stop_sequence') {
      var txt = extrairTexto(result.content);
      return txt || 'Pedido registrado!';
    }

    if (result.stop_reason === 'tool_use') {
      var toolUses = extrairToolUses(result.content);
      if (toolUses.length === 0) return extrairTexto(result.content) || 'Pedido registrado!';

      var toolResults = [];
      for (var k = 0; k < toolUses.length; k++) {
        var tu = toolUses[k];
        try {
          var r = await executarTool(telefone, tu.name, tu.input || {}, estado);
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(r) });
        } catch (eTool) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: JSON.stringify({ erro: eTool.message }),
            is_error: true,
          });
        }
      }

      messages.push({ role: 'assistant', content: result.content });
      messages.push({ role: 'user', content: toolResults });

      try {
        result = await chamarClaude({
          max_tokens: 800,
          system: systemBlocks,
          tools: TOOL_DECLARATIONS,
          messages: messages,
        });
      } catch (eFollow) {
        console.error('Claude interno follow-up erro:', eFollow.message);
        return 'Erro ao registrar pedido. Tenta de novo?';
      }
      continue;
    }

    break;
  }

  return extrairTexto(result.content) || 'Pedido registrado!';
}
