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
  return linhas.join('\n');
}

// Resumo do pedido para exibir ao cliente quando Claude nao gera texto
// depois de ver_pedido_atual. Inclui itens com preco, total e dados
// parciais — tudo que um "Confirma?" precisa pra fechar o pedido.
function construirResumoParaCliente(estado) {
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
  var taxa = d.tipo === 'delivery' ? parseFloat(config.restaurante.taxaEntrega || '0') : 0;
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
      if (pAberto && pAberto.status === 'aguardando') {
        var itensFmt = (pAberto.itens || []).map(function (i) {
          return '  - ' + i.qtd + 'x ' + i.nome + (i.obs ? ' (' + i.obs + ')' : '');
        }).join('\n');
        pedidoAbertoHint = '⚠️ ATENCAO CRITICA: CLIENTE TEM PEDIDO ABERTO RECENTE — AINDA NAO ACEITO PELA COZINHA — PODE SER ALTERADO:\n' +
          'Codigo: ' + (pAberto.codigoConfirmacao || '(nao setado)') + '\n' +
          'Status: aguardando (NAO esta em preparo, pode alterar)\n' +
          'Itens:\n' + itensFmt + '\n' +
          'Total atual: R$ ' + Number(pAberto.total || 0).toFixed(2).replace('.', ',') + '\n' +
          '\n' +
          'REGRA ABSOLUTA: se o cliente pedir QUALQUER alteracao ("adiciona mais X", "tira Y", "muda pagamento", "esqueci de X", "no pedido que acabei de fazer", "no meu ultimo pedido"):\n' +
          '1. Sua PRIMEIRA tool call OBRIGATORIA e carregar_pedido_recente. Nao responda nada antes.\n' +
          '2. Depois use adicionar_item/remover_item conforme pedido.\n' +
          '3. Chame finalizar_pedido (vai ATUALIZAR, nao duplicar).\n' +
          '4. Confirme ao cliente o NOVO total.\n' +
          'NUNCA, JAMAIS responda "esta em preparo" ou "nao da pra alterar". O status e "aguardando", voce pode alterar. So transfira pra humano se carregar_pedido_recente retornar erro.';
        console.log('Hint injetado pra ' + telefone + ': pedido ' + pAberto.codigoConfirmacao + ' aberto recentemente');
      } else if (pAberto) {
        console.log('Pedido aberto encontrado mas status=' + pAberto.status + ' — nao injetando hint');
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
        return txt;
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
    var resumo = construirResumoParaCliente(estado);
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
