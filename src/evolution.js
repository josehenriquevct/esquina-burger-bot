// ── Cliente Evolution API (WhatsApp) ───────────────────────────
import fetch from 'node-fetch';
import { config } from './config.js';

const { url: URL, apiKey: KEY, instance: INSTANCE } = config.evolution;

if (!URL || !KEY || !INSTANCE) {
  console.warn('⚠ Evolution API não configurada. Verifique EVOLUTION_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE');
}

async function evoReq(path, method = 'GET', body) {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'apikey': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Evolution ${method} ${path} → ${res.status}: ${txt}`);
  }
  return res.json().catch(() => ({}));
}

// ── Enviar mensagem de texto ───────────────────────────────────

export async function enviarMensagem(telefone, texto) {
  const numero = String(telefone).replace(/\D+/g, '');
  await evoReq(`/message/sendText/${INSTANCE}`, 'POST', {
    number: numero,
    text: texto,
    delay: 300,
  });
  console.log(`📤 → ${numero}: ${texto.slice(0, 60)}${texto.length > 60 ? '...' : ''}`);
}

// ── Enviar imagem ──────────────────────────────────────────────

export async function enviarImagem(telefone, imageUrl, caption = '') {
  const numero = String(telefone).replace(/\D+/g, '');
  await evoReq(`/message/sendMedia/${INSTANCE}`, 'POST', {
    number: numero,
    mediatype: 'image',
    media: imageUrl,
    caption,
  });
  console.log(`🖼 Imagem enviada → ${numero}`);
}

// ── Mostrar "digitando..." ─────────────────────────────────────

export async function mostrarDigitando(telefone, duracaoMs = 1500) {
  const numero = String(telefone).replace(/\D+/g, '');
  try {
    await evoReq(`/chat/sendPresence/${INSTANCE}`, 'POST', {
      number: numero,
      presence: 'composing',
      delay: duracaoMs,
    });
  } catch {
    // Presence não é crítico
  }
}

// ── Baixar mídia (áudio, imagem) em base64 ─────────────────────

export async function baixarMidiaBase64(messageKey) {
  try {
    const result = await evoReq(`/chat/getBase64FromMediaMessage/${INSTANCE}`, 'POST', {
      message: { key: messageKey },
    });
    if (result?.base64) {
      return { base64: result.base64, mimetype: result.mimetype || 'audio/ogg' };
    }
    return null;
  } catch (e) {
    console.error('Erro ao baixar mídia:', e.message);
    return null;
  }
}

// ── Parser de webhook ──────────────────────────────────────────

export function parseWebhook(body) {
  try {
    const data = body?.data || body;
    if (!data) return null;

    // Ignora mensagens enviadas por nós
    if (data.key?.fromMe === true) return null;

    // Ignora grupos (só @s.whatsapp.net)
    const remoteJid = data.key?.remoteJid || '';
    if (!remoteJid.includes('@s.whatsapp.net')) return null;

    const telefone = remoteJid.split('@')[0];
    const msg = data.message || {};
    const pushName = data.pushName || data.notifyName || '';

    let texto = '';
    let localizacao = null;

    // Texto normal
    if (msg.conversation) {
      texto = msg.conversation;
    }
    else if (msg.extendedTextMessage?.text) {
      texto = msg.extendedTextMessage.text;
    }
    // Localização (pin GPS)
    else if (msg.locationMessage) {
      const lat = msg.locationMessage.degreesLatitude;
      const lng = msg.locationMessage.degreesLongitude;
      const nome = msg.locationMessage.name || '';
      const endereco = msg.locationMessage.address || '';
      localizacao = { lat, lng, nome, endereco };
      texto = `[LOCALIZAÇÃO RECEBIDA] Latitude: ${lat}, Longitude: ${lng}` +
              (nome ? `, Nome: ${nome}` : '') +
              (endereco ? `, Endereço: ${endereco}` : '');
    }
    // Imagem
    else if (msg.imageMessage) {
      texto = msg.imageMessage.caption ? '[imagem] ' + msg.imageMessage.caption : '[imagem enviada]';
    }
    // Áudio
    else if (msg.audioMessage) {
      return { telefone, texto: '[ÁUDIO]', pushName, localizacao: null, audio: true, messageKey: data.key };
    }
    // Figurinha
    else if (msg.stickerMessage) {
      texto = '[figurinha]';
    }
    else {
      return null;
    }

    return { telefone, texto: texto.trim(), pushName, localizacao };
  } catch (e) {
    console.error('Erro parseWebhook:', e);
    return null;
  }
}
