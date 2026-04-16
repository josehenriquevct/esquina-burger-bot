// ── Modulo de IA — integracao com Google Gemini ────────────────
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { systemPrompt, promptInterno } from './prompts.js';
import { TOOL_DECLARATIONS, executarTool } from './tools.js';
import { getDados, carregarClienteFirebase } from './state.js';
import { getConversa, getConfigLoja } from './firebase.js';

var genAI = new GoogleGenerativeAI(config.gemini.apiKey);
var MODELO = config.gemini.model;

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

  // Carrega dados do cliente (memoria + Firebase)
  var dados = await carregarClienteFirebase(telefone);
  if (pushName && !dados.nome_whatsapp) dados.nome_whatsapp = pushName;

  // Config da loja (entrega_ativa, etc.)
  var configLoja = await getConfigLoja();

  // Passa dados salvos do cliente pro prompt
  var loc = dados.localizacao || null;
  configLoja.cliente_salvo = {
    nome: dados.nome || '',
    endereco: dados.endereco || '',
    bairro: dados.bairro || '',
    referencia: dados.referencia || '',
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
  // Gemini requires first message to be 'user'
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }

  // Inicializa chat com Gemini
  var sysPrompt = await systemPrompt(configLoja);
  var model = genAI.getGenerativeModel({
    model: MODELO,
    tools: TOOL_DECLARATIONS,
    systemInstruction: sysPrompt,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  var chat = model.startChat({ history: history });

  var result;
  try {
    result = await chat.sendMessage(texto);
  } catch (e) {
    console.error('Gemini sendMessage erro:', e.message);
    return 'Desculpe, tive um problema aqui. Pode repetir?';
  }

  // Loop de tool use (ate 8 iteracoes)
  for (var j = 0; j < 8; j++) {
    var response = result.response;
    var calls = (typeof response.functionCalls === 'function') ? response.functionCalls() : null;

    if (!calls || calls.length === 0) {
      try {
        var txt = response.text();
        return (txt && txt.trim()) ? txt.trim() : 'Desculpe, nao consegui entender. Pode repetir?';
      } catch (e2) {
        return 'Desculpe, nao consegui entender. Pode repetir?';
      }
    }

    var functionResponses = [];
    for (var k = 0; k < calls.length; k++) {
      try {
        var r = await executarTool(telefone, calls[k].name, calls[k].args || {});
        functionResponses.push({ functionResponse: { name: calls[k].name, response: r } });
      } catch (e3) {
        functionResponses.push({ functionResponse: { name: calls[k].name, response: { erro: e3.message } } });
      }
    }

    try {
      result = await chat.sendMessage(functionResponses);
    } catch (e4) {
      console.error('Gemini follow-up erro:', e4.message);
      return 'Desculpe, tive um problema aqui. Pode tentar de novo?';
    }
  }

  try {
    return result.response.text() || 'Desculpe, tive um problema. Pode repetir?';
  } catch (e5) {
    return 'Desculpe, tive um problema. Pode repetir?';
  }
}

// ── Processar pedido interno (funcionario manda audio) ─────────

export async function processarPedidoInterno(telefone, texto) {
  console.log('PEDIDO INTERNO de ' + telefone + ': ' + texto.slice(0, 100));

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
    result = await chat.sendMessage(texto);
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
        var r = await executarTool(telefone, calls[k].name, calls[k].args || {});
        functionResponses.push({ functionResponse: { name: calls[k].name, response: r } });
      } catch (e3) {
        functionResponses.push({ functionResponse: { name: calls[k].name, response: { erro: e3.message } } });
      }
    }

    try {
      result = await chat.sendMessage(functionResponses);
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
