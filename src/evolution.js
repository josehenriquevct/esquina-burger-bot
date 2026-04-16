// ── Cliente Evolution API (WhatsApp) ───────────────────────────
import fetch from 'node-fetch';
import { config } from './config.js';

const { url: URL, apiKey: KEY, instance: INSTANCE } = config.evolution;

if (!URL || !KEY || !INSTANCE) {
  console.warn('Evolution API nao configurada. Verifique EVOLUTION_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE');
}

async function evoReq(path, method = 'GET', body) {
  const res = await fetch(URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'apikey': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const txt = await res.text().catch(function() { return ''; });
    throw new Error('Evolution ' + method + ' ' + path + ' -> ' + res.status + ': ' + txt);
  }
  return res.json().catch(function() { return {}; });
}

// ── Enviar mensagem de texto ───────────────────────────────────

export async function enviarMensagem(telefone, texto) {
  const numero = String(telefone).replace(/\D+/g, '');
  await evoReq('/message/sendText/' + INSTANCE, 'POST', {
    number: numero,
    text: texto,
    delay: 300,
  });
  console.log('MSG -> ' + numero + ': ' + texto.slice(0, 60) + (texto.length > 60 ? '...' : ''));
}

// ── Enviar imagem ──────────────────────────────────────────────

export async function enviarImagem(telefone, imageUrl, caption) {
  if (caption === undefined) caption = '';
  const numero = String(telefone).replace(/\D+/g, '');
  await evoReq('/message/sendMedia/' + INSTANCE, 'POST', {
    number: numero,
    mediatype: 'image',
    media: imageUrl,
    caption: caption,
  });
  console.log('Imagem enviada -> ' + numero);
}

// ── Mostrar "digitando..." ─────────────────────────────────────

export async function mostrarDigitando(telefone, duracaoMs) {
  if (duracaoMs === undefined) duracaoMs = 1500;
  var numero = String(telefone).replace(/\D+/g, '');
  try {
    await evoReq('/chat/sendPresence/' + INSTANCE, 'POST', {
      number: numero,
      presence: 'composing',
      delay: duracaoMs,
    });
  } catch (e) {
    // Presence nao e critico
  }
}

// ── Baixar midia (audio, imagem) em base64 ─────────────────────

export async function baixarMidiaBase64(messageKey) {
  try {
    var result = await evoReq('/chat/getBase64FromMediaMessage/' + INSTANCE, 'POST', {
      message: { key: messageKey },
    });
    if (result && result.base64) {
      return { base64: result.base64, mimetype: result.mimetype || 'audio/ogg' };
    }
    return null;
  } catch (e) {
    console.error('Erro ao baixar midia:', e.message);
    return null;
  }
}

// ── Parser de webhook ──────────────────────────────────────────

export function parseWebhook(body) {
  try {
    var data = (body && body.data) ? body.data : body;
    if (!data) return null;

    // Ignora mensagens enviadas por nos
    if (data.key && data.key.fromMe === true) return null;

    // Ignora grupos (so @s.whatsapp.net)
    var remoteJid = (data.key && data.key.remoteJid) ? data.key.remoteJid : '';
    if (remoteJid.indexOf('@s.whatsapp.net') === -1) return null;

    var telefone = remoteJid.split('@')[0];
    var msg = data.message || {};
    var pushName = data.pushName || data.notifyName || '';

    var texto = '';
    var localizacao = null;

    // Texto normal
    if (msg.conversation) {
      texto = msg.conversation;
    }
    else if (msg.extendedTextMessage && msg.extendedTextMessage.text) {
      texto = msg.extendedTextMessage.text;
    }
    // Localizacao (pin GPS)
    else if (msg.locationMessage) {
      var lat = msg.locationMessage.degreesLatitude;
      var lng = msg.locationMessage.degreesLongitude;
      var locNome = msg.locationMessage.name || '';
      var locEndereco = msg.locationMessage.address || '';
      localizacao = { lat: lat, lng: lng, nome: locNome, endereco: locEndereco };
      texto = '[LOCALIZACAO RECEBIDA] Latitude: ' + lat + ', Longitude: ' + lng;
      if (locNome) texto += ', Nome: ' + locNome;
      if (locEndereco) texto += ', Endereco: ' + locEndereco;
    }
    // Imagem (retorna messageKey para download)
    else if (msg.imageMessage) {
      var caption = (msg.imageMessage && msg.imageMessage.caption) ? msg.imageMessage.caption : '';
      texto = caption ? '[imagem] ' + caption : '[imagem enviada]';
      return { telefone: telefone, texto: texto, pushName: pushName, localizacao: null, image: true, messageKey: data.key };
    }
    // Audio
    else if (msg.audioMessage) {
      return { telefone: telefone, texto: '[AUDIO]', pushName: pushName, localizacao: null, audio: true, messageKey: data.key };
    }
    // Figurinha
    else if (msg.stickerMessage) {
      texto = '[figurinha]';
    }
    else {
      return null;
    }

    return { telefone: telefone, texto: texto.trim(), pushName: pushName, localizacao: localizacao };
  } catch (e) {
    console.error('Erro parseWebhook:', e);
    return null;
  }
}
