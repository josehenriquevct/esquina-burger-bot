// ── Modulo de IA — integracao com Google Gemini ────────────────
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { systemPrompt, promptInterno } from './prompts.js';
import { TOOL_DECLARATIONS, executarTool } from './tools.js';
import { carregarEstado, salvarEstado, limparEstado, mergeClienteSalvo } from './state.js';
import { getConversa, getConfigLoja } from './firebase.js';

var genAI = new GoogleGenerativeAI(config.gemini.apiKey);
var MODELO = config.gemini.model;
var GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '25000', 10);

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
      texto = texto + '\n' + analise;
      console.log('Imagem analisada para ' + telefone + ': ' + analise.slice(0, 80));
    } catch (e) {
      console.error('Erro ao analisar imagem:', e.message);
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
  var model = genAI.getGenerativeModel({
    model: MODELO,
    tools: TOOL_DECLARATIONS,
    systemInstruction: sysPrompt,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 800,
    },
  });

  var chat = model.startChat({ history: history });

  var result;
  try {
    result = await comTimeout(chat.sendMessage(texto), GEMINI_TIMEOUT_MS, 'gemini-timeout');
  } catch (e) {
    console.error('Gemini sendMessage erro:', e.message);
    await salvarEstado(telefone, estado);
    return 'Desculpe, tive um problema aqui. Pode repetir?';
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

        // MALFORMED_FUNCTION_CALL: Gemini tentou chamar tool com args inválidos.
        // Retry UMA vez pedindo resposta de texto direta (funciona na maioria dos casos).
        if (finishReason === 'MALFORMED_FUNCTION_CALL' && !estado._retryMalformed) {
          estado._retryMalformed = true;
          console.log('Retry apos MALFORMED_FUNCTION_CALL');
          try {
            result = await comTimeout(
              chat.sendMessage('Responda ao cliente com uma mensagem de texto curta, sem chamar funcao.'),
              GEMINI_TIMEOUT_MS,
              'gemini-timeout-retry'
            );
            continue;
          } catch (eRetry) {
            console.error('Retry malformed falhou:', eRetry.message);
          }
        }

        await persistir();
        // Cardápio já tem legenda auto-suficiente — não envia texto extra
        if (ultimaToolUsada === 'enviar_foto_cardapio') return '';
        if (ultimaToolUsada === 'finalizar_pedido') return 'Prontinho, pedido na cozinha!';
        // Fallback: cliente pediu cardápio e Gemini travou — manda a foto direto
        var textoLower = String(texto || '').toLowerCase();
        if (/card[áa]pio|menu|\bver\b.*comida|\bo que\b.*tem/.test(textoLower)) {
          console.log('Fallback cardápio: chamando enviar_foto_cardapio diretamente');
          try {
            await executarTool(telefone, 'enviar_foto_cardapio', {}, estado);
            return ''; // legenda da foto já tem "Me diz o que você quer pedir"
          } catch (efb) {
            console.error('Fallback enviar_foto_cardapio falhou:', efb.message);
          }
        }
        return 'Pode repetir, por favor?';
      } catch (e2) {
        console.error('Erro ao extrair texto do Gemini:', e2.message);
        await persistir();
        return 'Pode repetir, por favor?';
      }
    }

    var functionResponses = [];
    for (var k = 0; k < calls.length; k++) {
      ultimaToolUsada = calls[k].name;
      try {
        var r = await executarTool(telefone, calls[k].name, calls[k].args || {}, estado);
        functionResponses.push({ functionResponse: { name: calls[k].name, response: r } });
      } catch (e3) {
        console.error('Erro na tool ' + calls[k].name + ':', e3.message);
        functionResponses.push({ functionResponse: { name: calls[k].name, response: { erro: e3.message } } });
      }
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
