// ── Cliente Firebase Realtime Database via REST ────────────────
// Agora com autenticação via auth secret
import fetch from 'node-fetch';
import { config } from './config.js';

if (!config.firebase.dbUrl) {
  throw new Error('FIREBASE_DB_URL não configurado');
}

const base = config.firebase.dbUrl.replace(/\/$/, '');
const authParam = config.firebase.authSecret ? `?auth=${config.firebase.authSecret}` : '';

async function req(method, path, body) {
  // Adiciona auth secret como parâmetro (formato Firebase REST)
  const separator = authParam ? '&' : '?';
  const url = `${base}/${path}.json${authParam}`;

  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    // Nunca loga a URL completa (contém o auth secret)
    throw new Error(`Firebase ${method} ${path} → ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const fb = {
  get:   (path)       => req('GET',    path),
  put:   (path, body) => req('PUT',    path, body),
  post:  (path, body) => req('POST',   path, body),
  patch: (path, body) => req('PATCH',  path, body),
  del:   (path)       => req('DELETE', path),
};

// ── Helpers ────────────────────────────────────────────────────

function phoneKey(telefone) {
  return String(telefone).replace(/\D+/g, '');
}

// ── Conversas ──────────────────────────────────────────────────

export async function getConversa(telefone) {
  return (await fb.get(`bot_conversas/${phoneKey(telefone)}`)) || null;
}

export async function salvarConversa(telefone, dados) {
  const key = phoneKey(telefone);
  const atual = (await fb.get(`bot_conversas/${key}`)) || {};
  const merged = { ...atual, ...dados, atualizadoEm: Date.now() };
  await fb.put(`bot_conversas/${key}`, merged);
  return merged;
}

export async function adicionarMensagem(telefone, msg) {
  const key = phoneKey(telefone);
  const conversa = (await fb.get(`bot_conversas/${key}`)) || {
    telefone: key,
    criadoEm: Date.now(),
    mensagens: [],
    status: 'ativo',
  };

  if (!Array.isArray(conversa.mensagens)) conversa.mensagens = [];
  conversa.mensagens.push({ ...msg, timestamp: Date.now() });

  // Mantém últimas 40 mensagens
  if (conversa.mensagens.length > 40) {
    conversa.mensagens = conversa.mensagens.slice(-40);
  }

  conversa.ultimaMsg = msg.texto || '';
  conversa.atualizadoEm = Date.now();
  await fb.put(`bot_conversas/${key}`, conversa);
  return conversa;
}

// ── Pedidos ────────────────────────────────────────────────────

export async function criarPedidoAberto(pedido) {
  const key = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const codigoConfirmacao = String(Math.floor(1000 + Math.random() * 9000));

  const payload = {
    ...pedido,
    origem: 'whatsapp-bot',
    autoAceito: true,
    status: 'aguardando',
    codigoConfirmacao,
    criadoEm: Date.now(),
  };

  await fb.put(`pedidos_abertos/${key}`, payload);
  return { key, codigoConfirmacao, ...payload };
}

// ── Clientes ───────────────────────────────────────────────────

export async function getCliente(telefone) {
  const key = phoneKey(telefone);
  return (await fb.get(`clientes_bot/${key}`)) || null;
}

export async function upsertCliente(cliente) {
  const key = phoneKey(cliente.telefone);
  if (!key) return null;

  const atual = (await fb.get(`clientes_bot/${key}`)) || {
    id: Date.now(),
    criadoEm: Date.now(),
    pedidos: 0,
    totalGasto: 0,
  };

  const merged = { ...atual, ...cliente, telefone: key, atualizadoEm: Date.now() };
  await fb.put(`clientes_bot/${key}`, merged);
  return merged;
}

// ── Config da loja ─────────────────────────────────────────────

export async function getConfigLoja() {
  try {
    return (await fb.get('config')) || {};
  } catch (e) {
    console.warn('Erro ao ler config da loja:', e.message);
    return {};
  }
}
