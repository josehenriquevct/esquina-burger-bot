// ── Modulo de IA — integracao com Google Gemini ────────────────
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { systemPrompt, promptInterno } from './prompts.js';
import { TOOL_DECLARATIONS, executarTool } from './tools.js';
import { carregarEstado, salvarEstado, limparEstado, mergeClienteSalvo } from './state.js';
import { getConversa, getConfigLoja, salvarConversa } from './firebase.js';

var genAI = new GoogleGenerativeAI(config.gemini.apiKey);
var MODELO = config.gemini.model;
var MODELO_FALLBACK = config.gemini.modeloFallback;
var GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '25000', 10);

// Detecta erros que indicam bloqueio/cota do modelo (403 denied access, 429
// quota exceeded). Quando acontecem, o bot tenta uma vez com MODELO_FALLBACK
// antes de desistir — evita travar a loja inteira por problema de billing.
function isErroModeloBloqueado(erro) {
  var msg = String(erro && erro.message || '');
  return /\b403\b|\b429\b|denied access|quota|rate.?limit|exceeded/i.test(msg);
}

// Falhas consecutivas do Gemini por telefone (in-memory).
// Quando passa do limite, auto-pausa pra humano — evita cliente preso
// num loop de "Desculpe, tive um problema aqui. Pode repetir?".
var falhasGeminiPorTelefone = new Map();
var LIMITE_FALHAS_GEMINI = 2;

// Palavras-chave de reclamacao / suporte: pausa pra humano imediatamente,
// SEM chamar Gemini. Quando cliente sinaliza problema sério, melhor errar
// pra mais (atendente humano) do que deixar o bot tropeçar.
// Lista enxuta: so frases inequivocas, pra minimizar falso-positivo.
var PALAVRAS_ESCALA_HUMANO = [
  'veio errado', 'pedido errado', 'lanche errado', 'chegou errado',
  'veio faltando', 'veio sem', 'veio incompleto', 'chegou faltando',
  'estornar', 'estorno', 'reembolso', 'reembolsar',
  'falar com atendente', 'chamar atendente', 'falar com humano',
  'atendimento humano', 'quero uma pessoa',
];

// Promise.race com timeout — evita Gemini pendurado travar a fila
function comTimeout(promise, ms, mensagemErro) {
  if (!mensagemErro) mensagemErro = 'timeout';
  return new Promise(function(resolve, reject) {
    var t = setTimeout(function() { reject(new Error(mensagemErro)); }, ms);
    promise.then(
      function(v) { clearTimeout(t); resolve(v); },
      function(e) { clearTimeout(t); reject(e); }
    );
  });
}

// ── Transcricao de audio via Gemini ────────────────────────────

export async function transcreverAudio(base64Audio, mimetype) {
  if (!mimetype) mimetype = 'audio/ogg';
  try {
    var model = genAI.getGenerativeModel({ model: MODELO });
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

// ── Analisar imagem via Gemini (comprovante Pix, etc.) ─────────

export async function analisarImagem(base64Img, mimetype) {
  if (!mimetype) mimetype = 'image/jpeg';
  try {
    var model = genAI.getGenerativeModel({ model: MODELO });
    var result = await model.generateContent([
      { inlineData: { mimeType: mimetype, data: base64Img } },
      { text: 'Analise esta imagem. Se for um comprovante de pagamento Pix, extraia: valor, data/hora, nome do pagador e nome do recebedor. Responda EXATAMENTE neste formato: "[COMPROVANTE PIX DETECTADO: valor=R$XX,XX | pagador=NOME | recebedor=NOME | data=DD/MM/AAAA HH:MM]". Se NAO for um comprovante de pagamento, responda exatamente: "[IMAGEM ANALISADA: nao e comprovante]". Nao adicione nenhum outro texto.' },
    ]);

    var analise = result.response.text();
    if (analise) analise = analise.trim();
    if (!analise) return '[IMAGEM ANALISADA: nao e comprovante]';

    console.log('Analise imagem: ' + analise.slice(0, 100));
    return analise;
  } catch (e) {
    console.error('Erro ao analisar imagem:', e.message);
    return '[erro ao analisar imagem]';
  }
}

// ── Processar mensagem do cliente (fluxo normal) ──────────────

export async function processarMensagem(telefone, texto, pushName, imagemData) {
  // Se pausado para humano, nao responde
  var conversaAtual = await getConversa(telefone).catch(function() { return null; });
  if (conversaAtual && conversaAtual.status === 'pausado_humano') return null;

  // Escalação imediata: cliente sinalizou problema grave. Pausa e entrega
  // pra atendente humano SEM passar pelo Gemini.
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

  // Carrega estado persistido (carrinho + dados parciais) + cliente salvo
  var estado = await carregarEstado(telefone);
  estado.dados.telefone = telefone;
  if (pushName && !estado.dados.nome_whatsapp) estado.dados.nome_whatsapp = pushName;
  await mergeClienteSalvo(estado);

  // Se a conversa recebeu localização recentemente via WhatsApp, joga no estado
  if (conversaAtual && conversaAtual.localizacaoRecente && !estado.dados.localizacao) {
    estado.dados.localizacao = conversaAtual.localizacaoRecente;
  }

  // Config da loja (entrega_ativa, horario, etc.)
  var configLoja = await getConfigLoja();

  // Passa dados salvos do cliente pro prompt
  var loc = estado.dados.localizacao || null;
  configLoja.cliente_salvo = {
    nome: estado.dados.nome || '',
    endereco: estado.dados.endereco || '',
    bairro: estado.dados.bairro || '',
    referencia: estado.dados.referencia || '',
    temLocalizacao: !!(loc && loc.lat && loc.lng),
  };

  // Se tem imagem, analisa antes de mandar pro chat
  if (imagemData && imagemData.base64) {
    try {
      var analise = await analisarImagem(imagemData.base64, imagemData.mimetype || 'image/jpeg');
      console.log('Imagem analisada para ' + telefone + ': ' + analise.slice(0, 80));
      // Se analise falhou, NAO envia "[erro ao analisar imagem]" pro Gemini
      // — ele pode hallucinar que viu o comprovante e confirmar PIX indevido.
      // Em vez disso, instrui a pedir reenvio.
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

  // Monta historico (ultimas 20 msgs, formato Gemini)
  var historicoRaw = (conversaAtual && conversaAtual.mensagens) ? conversaAtual.mensagens.slice(-20) : [];
  var history = [];
  for (var i = 0; i < historicoRaw.length; i++) {
    var m = historicoRaw[i];
    var role = m.role === 'assistant' ? 'model' : 'user';
    var text = m.texto || m.content || '';
    if (!text) continue;
    // Merge consecutive same-role messages
    if (history.length > 0 && history[history.length - 1].role === role) {
      history[history.length - 1].parts[0].text += ' ' + text;
    } else {
      history.push({ role: role, parts: [{ text: text }] });
    }
  }
  // Remove a última msg de user se for igual ao texto atual — evita duplicar
  // a mensagem do cliente no contexto do Gemini (ela é salva antes de processar).
  while (
    history.length > 0 &&
    history[history.length - 1].role === 'user' &&
    (history[history.length - 1].parts[0].text === texto ||
     history[history.length - 1].parts[0].text.endsWith(texto))
  ) {
    history.pop();
  }
  // Gemini requires first message to be 'user'
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }

  // Função helper: persiste ou limpa o estado ao sair do processamento
  var persistir = async function() {
    if (estado._limpar) {
      await limparEstado(telefone);
    } else {
      await salvarEstado(telefone, estado);
    }
  };

  // Inicializa chat com Gemini
  var sysPrompt = await systemPrompt(configLoja);
  var GEN_CONFIG = { temperature: 0.7, maxOutputTokens: 800 };
  function criarModel(nomeModelo) {
    return genAI.getGenerativeModel({
      model: nomeModelo,
      tools: TOOL_DECLARATIONS,
      systemInstruction: sysPrompt,
      generationConfig: GEN_CONFIG,
    });
  }
  var model = criarModel(MODELO);

  var chat = model.startChat({ history: history });

  var result;
  try {
    result = await comTimeout(chat.sendMessage(texto), GEMINI_TIMEOUT_MS, 'gemini-timeout');
    // Sucesso: zera contador de falhas
    falhasGeminiPorTelefone.delete(telefone);
  } catch (e) {
    // Fallback automatico de modelo em caso de 403 (denied access) ou 429
    // (quota). Tenta uma unica vez com MODELO_FALLBACK antes de desistir.
    if (isErroModeloBloqueado(e) && MODELO_FALLBACK && MODELO_FALLBACK !== MODELO) {
      console.warn('Modelo ' + MODELO + ' bloqueado (' + String(e.message).slice(0, 80) + '). Tentando fallback ' + MODELO_FALLBACK);
      try {
        var modelFb = criarModel(MODELO_FALLBACK);
        var chatFb = modelFb.startChat({ history: history });
        result = await comTimeout(chatFb.sendMessage(texto), GEMINI_TIMEOUT_MS, 'gemini-timeout-fb');
        falhasGeminiPorTelefone.delete(telefone);
        model = modelFb;
        chat = chatFb;
      } catch (eFb) {
        console.error('Fallback ' + MODELO_FALLBACK + ' tambem falhou:', eFb.message);
        e = eFb; // segue pro tratamento normal com o erro do fallback
      }
    }
    if (!result) {
    console.error('Gemini sendMessage erro:', e.message);
    await salvarEstado(telefone, estado);

    // Conta falha e auto-escala se passar do limite
    var falhas = (falhasGeminiPorTelefone.get(telefone) || 0) + 1;
    falhasGeminiPorTelefone.set(telefone, falhas);
    if (falhas >= LIMITE_FALHAS_GEMINI) {
      falhasGeminiPorTelefone.delete(telefone);
      try {
        await salvarConversa(telefone, {
          status: 'pausado_humano',
          motivoTransferencia: 'gemini_falhou: ' + String(e.message || '').slice(0, 120),
        });
      } catch (eSalvar) {
        console.warn('Erro ao pausar apos falhas Gemini:', eSalvar.message);
      }
      console.error('Auto-pausado para humano apos ' + falhas + ' falhas Gemini: ' + telefone);
      return 'So um instante, vou te direcionar pra um atendente humano. 🙏';
    }
    return 'Desculpe, tive um problema aqui. Pode repetir?';
    } // fim if (!result)
  }

  // Loop de tool use (ate 8 iteracoes)
  var ultimaToolUsada = '';
  for (var j = 0; j < 8; j++) {
    var response = result.response;
    var calls = (typeof response.functionCalls === 'function') ? response.functionCalls() : null;

    if (!calls || calls.length === 0) {
      var finishReason = response.candidates?.[0]?.finishReason;
      try {
        var txt = response.text();
        if (txt && txt.trim()) {
          await persistir();
          return txt.trim();
        }
        // Texto vazio
        console.error('Gemini retornou texto vazio. Ultima tool:', ultimaToolUsada, 'FinishReason:', finishReason);

        // Retry silencioso quando Gemini retorna texto vazio sem chamar tool:
        // - MALFORMED_FUNCTION_CALL: args invalidos, tentou tool bugada
        // - STOP / OTHER: modelo escolheu nao responder. Retry com HINT
        //   contextual (nudge pra dar resposta). Se so repetir o mesmo input,
        //   Gemini retorna o mesmo vazio.
        const finishMotivoRetry = ['MALFORMED_FUNCTION_CALL', 'STOP', 'OTHER'].includes(finishReason)
          || !finishReason;
        if (finishMotivoRetry && !estado._retryMalformed) {
          estado._retryMalformed = true;
          console.log('Retry silencioso — FinishReason=' + finishReason + ', ultima tool=' + ultimaToolUsada);
          try {
            // Filtra history pra remover Contents sem parts validas (causa
            // "Each Content should have at least one part")
            var historyLimpo = history.filter(function (c) {
              return c && c.parts && c.parts.length > 0 && c.parts[0] && (c.parts[0].text || c.parts[0].functionCall || c.parts[0].functionResponse);
            });
            // Adiciona HINT pra mudar o contexto — sem isso o retry da mesmo resultado
            var textoComHint = String(texto || '').trim() + '\n\n(responda agora em portugues em UMA mensagem curta. Se faltar info, pergunte. Se cliente disse um nome, confirme e siga. Se disse sim/ok, prossiga com o pedido.)';
            var chatRetry = model.startChat({ history: historyLimpo });
            result = await comTimeout(
              chatRetry.sendMessage(textoComHint),
              GEMINI_TIMEOUT_MS,
              'gemini-timeout-retry'
            );
            chat = chatRetry;
            continue;
          } catch (eRetry) {
            console.error('Retry falhou:', eRetry.message);
          }
        }

        await persistir();
        // Cardápio já tem legenda auto-suficiente — não envia texto extra
        if (ultimaToolUsada === 'enviar_foto_cardapio') return '';
        if (ultimaToolUsada === 'finalizar_pedido') return 'Prontinho, pedido na cozinha!';
        // Fallback: cliente pediu cardápio e Gemini travou — manda a foto direto
        var textoLower = String(texto || '').toLowerCase().trim();
        if (/card[áa]pio|menu|\bver\b.*comida|\bo que\b.*tem/.test(textoLower)) {
          console.log('Fallback cardápio: chamando enviar_foto_cardapio diretamente');
          try {
            await executarTool(telefone, 'enviar_foto_cardapio', {}, estado);
            return ''; // legenda da foto já tem "Me diz o que você quer pedir"
          } catch (efb) {
            console.error('Fallback enviar_foto_cardapio falhou:', efb.message);
          }
        }
        // FALLBACKS heuristicos — se Gemini travou mas o texto e claro, responde algo util
        // (evita o loop chato de "Pode repetir, por favor?")

        // 1. "Sim", "Ok", "Pode", "Isso" sem estado pendente → seguir em frente
        if (/^(sim|isso|isso mesmo|pode|pode ser|ok|okay|beleza|certo|claro|perfeito|tudo certo|taokay|ta okay|ta bom|👍|✅)$/i.test(textoLower)) {
          return 'Beleza! Me conta o que mais voce quer pedir, ou se ja ta tudo certo.';
        }
        // 2. "Nao", "nope" → acabou o pedido?
        if (/^(nao|não|so isso|só isso|so|só|s[oó] isso mesmo|fechou|fechar)$/i.test(textoLower)) {
          return 'Certo! Se quiser finalizar o pedido, me diz seu nome, se é entrega ou retirada, e a forma de pagamento.';
        }
        // 3. Parece um NOME (1-2 palavras, primeira letra maiuscula no original, sem digitos)
        var textoOriginal = String(texto || '').trim();
        if (!estado.dados.nome &&
            /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+( [A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+)?$/.test(textoOriginal) &&
            textoOriginal.length >= 3 && textoOriginal.length <= 40) {
          // Provavelmente eh nome. Salva e segue.
          estado.dados.nome = textoOriginal;
          await persistir();
          console.log('Fallback nome: salvo "' + textoOriginal + '"');
          return `Beleza, ${textoOriginal.split(' ')[0]}! Agora me diz se é entrega, retirada ou salão.`;
        }
        return 'Pode repetir, por favor? Nao consegui entender direito.';
      } catch (e2) {
        console.error('Erro ao extrair texto do Gemini:', e2.message);
        await persistir();
        return 'Pode repetir, por favor?';
      }
    }

    var functionResponses = [];
    var fotoCardapioOk = false;
    for (var k = 0; k < calls.length; k++) {
      ultimaToolUsada = calls[k].name;
      try {
        var r = await executarTool(telefone, calls[k].name, calls[k].args || {}, estado);
        functionResponses.push({ functionResponse: { name: calls[k].name, response: r } });
        if (calls[k].name === 'enviar_foto_cardapio' && r && r.sucesso) fotoCardapioOk = true;
      } catch (e3) {
        console.error('Erro na tool ' + calls[k].name + ':', e3.message);
        functionResponses.push({ functionResponse: { name: calls[k].name, response: { erro: e3.message } } });
      }
    }

    // Curto-circuito: se a unica tool chamada foi enviar_foto_cardapio e
    // deu certo, a legenda ja cobre a resposta. Evita um round-trip extra
    // ao Gemini que frequentemente volta com FinishReason=STOP vazio.
    if (fotoCardapioOk && calls.length === 1) {
      await persistir();
      console.log('Foto do cardapio enviada — encerrando sem consultar Gemini novamente');
      return '';
    }

    try {
      result = await comTimeout(chat.sendMessage(functionResponses), GEMINI_TIMEOUT_MS, 'gemini-timeout');
    } catch (e4) {
      console.error('Gemini follow-up erro (apos ' + ultimaToolUsada + '):', e4.message);
      await persistir();
      // Se a última tool foi sucesso, dá uma resposta adequada em vez de "tive problema"
      if (ultimaToolUsada === 'enviar_foto_cardapio') return 'Mandei o cardápio! O que vai querer? 🍔';
      if (ultimaToolUsada === 'finalizar_pedido') return 'Pedido enviado pra cozinha!';
      return 'Tive um problema aqui, pode tentar de novo?';
    }
  }

  await persistir();
  try {
    return result.response.text() || 'Desculpe, tive um problema. Pode repetir?';
  } catch (e5) {
    return 'Desculpe, tive um problema. Pode repetir?';
  }
}

// ── Processar pedido interno (funcionario manda audio) ─────────

export async function processarPedidoInterno(telefone, texto) {
  console.log('PEDIDO INTERNO de ' + telefone + ': ' + texto.slice(0, 100));

  // Pedido interno começa sempre com estado limpo — cada áudio é um pedido novo
  var estado = { carrinho: [], dados: { telefone: telefone }, pedidoKeyExistente: null };

  var sysPrompt = await promptInterno();
  var model = genAI.getGenerativeModel({
    model: MODELO,
    tools: TOOL_DECLARATIONS,
    systemInstruction: sysPrompt,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 512,
    },
  });

  // Sem historico — cada audio e um pedido novo independente
  var chat = model.startChat({ history: [] });

  var result;
  try {
    result = await comTimeout(chat.sendMessage(texto), GEMINI_TIMEOUT_MS, 'gemini-timeout');
  } catch (e) {
    console.error('Gemini pedido interno erro:', e.message);
    return 'Nao entendi o pedido. Pode repetir?';
  }

  // Loop de tool use (ate 10 iteracoes — pedido interno pode ter varios itens)
  for (var j = 0; j < 10; j++) {
    var response = result.response;
    var calls = (typeof response.functionCalls === 'function') ? response.functionCalls() : null;

    if (!calls || calls.length === 0) {
      try {
        var txt = response.text();
        return (txt && txt.trim()) ? txt.trim() : 'Pedido registrado!';
      } catch (e2) {
        return 'Pedido registrado!';
      }
    }

    var functionResponses = [];
    for (var k = 0; k < calls.length; k++) {
      try {
        var r = await executarTool(telefone, calls[k].name, calls[k].args || {}, estado);
        functionResponses.push({ functionResponse: { name: calls[k].name, response: r } });
      } catch (e3) {
        functionResponses.push({ functionResponse: { name: calls[k].name, response: { erro: e3.message } } });
      }
    }

    try {
      result = await comTimeout(chat.sendMessage(functionResponses), GEMINI_TIMEOUT_MS, 'gemini-timeout');
    } catch (e4) {
      console.error('Gemini interno follow-up erro:', e4.message);
      return 'Erro ao registrar pedido. Tenta de novo?';
    }
  }

  try {
    return result.response.text() || 'Pedido registrado!';
  } catch (e5) {
    return 'Pedido registrado!';
  }
}
