// ── Módulo de IA — integração com Google Gemini ────────────────
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';
import { systemPrompt } from './prompts.js';
import { TOOL_DECLARATIONS, executarTool } from './tools.js';
import { getDados, carregarClienteFirebase } from './state.js';
import { getConversa, getConfigLoja } from './firebase.js';

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
const MODELO = config.gemini.model;

// ── Transcrição de áudio via Gemini ────────────────────────────

export async function transcreverAudio(base64Audio, mimetype = 'audio/ogg') {
  try {
    const model = genAI.getGenerativeModel({ model: MODELO });
    const result = await model.generateContent([
      { inlineData: { mimeType: mimetype, data: base64Audio } },
      { text: 'Transcreva exatamente o que a pessoa esta falando neste audio. Retorne APENAS o texto falado, sem explicacoes, sem aspas. Se nao entender, retorne "[audio nao compreendido]".' },
    ]);

    const transcricao = result.response.text()?.trim();
    if (!transcricao) return '[audio nao compreendido]';

    console.log(`🎤 Transcrição: "${transcricao.slice(0, 80)}${transcricao.length > 80 ? '...' : ''}"`);
    return transcricao;
  } catch (e) {
    console.error('Erro ao transcrever áudio:', e.message);
    return '[erro ao transcrever audio]';
  }
}

// ── Processar mensagem do cliente ──────────────────────────────

export async function processarMensagem(telefone, texto, pushName) {
  // Se pausado para humano, não responde
  const conversaAtual = await getConversa(telefone).catch(() => null);
  if (conversaAtual?.status === 'pausado_humano') return null;

  // Carrega dados do cliente (memória + Firebase)
  const dados = await carregarClienteFirebase(telefone);
  if (pushName && !dados.nome_whatsapp) dados.nome_whatsapp = pushName;

  // Config da loja (entrega_ativa, etc.)
  const configLoja = await getConfigLoja();
  // Se fora do horário, responde com mensagem de fechado
  if (configLoja.horario_ativo && !configLoja.loja_aberta && configLoja.msg_fechado) {
    return configLoja.msg_fechado;
  }

  // Passa dados salvos do cliente pro prompt
  const loc = dados.localizacao || null;
  configLoja.cliente_salvo = {
    nome: dados.nome || '',
    endereco: dados.endereco || '',
    bairro: dados.bairro || '',
    referencia: dados.referencia || '',
    temLocalizacao: !!(loc?.lat && loc?.lng),
  };

  // Monta histórico (últimas 20 msgs, formato Gemini)
  const historicoRaw = (conversaAtual?.mensagens || []).slice(-20);
  const history = historicoRaw
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.texto || m.content || '' }],
    }))
    .filter(m => m.parts[0].text);

  // Inicializa chat com Gemini
  const model = genAI.getGenerativeModel({
    model: MODELO,
    tools: TOOL_DECLARATIONS,
    systemInstruction: await systemPrompt(configLoja),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  const chat = model.startChat({ history });

  let result;
  try {
    result = await chat.sendMessage(texto);
  } catch (e) {
    console.error('Gemini sendMessage erro:', e.message);
    return 'Desculpe, tive um problema aqui. Pode repetir?';
  }

  // Loop de tool use (até 8 iterações)
  for (let i = 0; i < 8; i++) {
    const response = result.response;
    const calls = typeof response.functionCalls === 'function' ? response.functionCalls() : null;

    if (!calls || calls.length === 0) {
      try {
        const txt = response.text();
        return (txt && txt.trim()) || 'Desculpe, não consegui entender. Pode repetir?';
      } catch {
        return 'Desculpe, não consegui entender. Pode repetir?';
      }
    }

    // Executa todas as tools pedidas
    const functionResponses = [];
    for (const call of calls) {
      try {
        const r = await executarTool(telefone, call.name, call.args || {});
        functionResponses.push({ functionResponse: { name: call.name, response: r } });
      } catch (e) {
        functionResponses.push({ functionResponse: { name: call.name, response: { erro: e.message } } });
      }
    }

    try {
      result = await chat.sendMessage(functionResponses);
    } catch (e) {
      console.error('Gemini follow-up erro:', e.message);
      return 'Desculpe, tive um problema aqui. Pode tentar de novo?';
    }
  }

  // Se saiu do loop por limite
  try {
    return result.response.text() || 'Desculpe, tive um problema. Pode repetir?';
  } catch {
    return 'Desculpe, tive um problema. Pode repetir?';
  }
}
