// Cliente para a Evolution API (WhatsApp)
// Docs: https://doc.evolution-api.com/
import fetch from 'node-fetch';

const URL = (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
const KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE = process.env.EVOLUTION_INSTANCE;

if (!URL || !KEY || !INSTANCE) {
  console.warn('⚠ Evolution API não totalmente configurada. Verifique EVOLUTION_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE');
}

async function evoReq(path, method = 'GET', body) {
  const url = `${URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Evolution ${method} ${path} → ${res.status}: ${txt}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * Envia mensagem de texto para um número via WhatsApp
 * @param {string} telefone - número com DDI+DDD (só dígitos, ex: 5564999999999)
 * @param {string} texto - mensagem
 */
export async function enviarMensagem(telefone, texto) {
  const numero = String(telefone).replace(/\D+/g, '');
  try {
    await evoReq(`/message/sendText/${INSTANCE}`, 'POST', {
      number: numero,
      text: texto,
      delay: 300,
    });
    console.log(`📤 → ${numero}: ${texto.slice(0, 60)}${texto.length > 60 ? '...' : ''}`);
  } catch (e) {
    console.error('Erro ao enviar mensagem:', e.message);
    throw e;
  }
}

/**
 * Marca uma mensagem como "digitando..." (presença)
 */
export async function mostrarDigitando(telefone, duracaoMs = 1500) {
  const numero = String(telefone).replace(/\D+/g, '');
  try {
    await evoReq(`/chat/sendPresence/${INSTANCE}`, 'POST', {
      number: numero,
      presence: 'composing',
      delay: duracaoMs,
    });
  } catch (e) {
    // silencioso — presence não é crítico
  }
}

/**
 * Extrai o texto e o telefone de um webhook de mensagem da Evolution
 * Suporta formato v2 da Evolution API
 */
export function parseWebhook(body) {
  try {
    // Evolution v2: { event, instance, data: { key, message, ... } }
    const data = body?.data || body;
    if (!data) return null;

    // Ignora se é mensagem enviada por nós
    if (data.key?.fromMe === true) return null;

    // Ignora se é grupo (só @s.whatsapp.net, não @g.us)
    const remoteJid = data.key?.remoteJid || '';
    if (!remoteJid.includes('@s.whatsapp.net')) return null;

    const telefone = remoteJid.split('@')[0];
    const msg = data.message || {};

    // Extrai texto de diferentes tipos de mensagem
    let texto = '';
    if (msg.conversation) texto = msg.conversation;
    else if (msg.extendedTextMessage?.text) texto = msg.extendedTextMessage.text;
    else if (msg.imageMessage?.caption) texto = '[imagem] ' + (msg.imageMessage.caption || '');
    else if (msg.audioMessage) texto = '[áudio — transcrição não suportada ainda]';
    else if (msg.stickerMessage) texto = '[figurinha]';
    else return null;

    const pushName = data.pushName || data.notifyName || '';

    return { telefone, texto: texto.trim(), pushName };
  } catch (e) {
    console.error('Erro parseWebhook:', e);
    return null;
  }
}
