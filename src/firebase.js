// Cliente simples do Firebase Realtime Database via REST
// Usa a mesma URL que o PDV — sem precisar de service account
import fetch from 'node-fetch';

const DB_URL = process.env.FIREBASE_DB_URL;
if (!DB_URL) throw new Error('FIREBASE_DB_URL não configurado');

const base = DB_URL.replace(/\/$/, '');

async function req(method, path, body) {
  const url = `${base}/${path}.json`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Firebase ${method} ${path} → ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const fb = {
  get:    (path)        => req('GET',    path),
  put:    (path, body)  => req('PUT',    path, body),
  post:   (path, body)  => req('POST',   path, body),
  patch:  (path, body)  => req('PATCH',  path, body),
  del:    (path)        => req('DELETE', path),
};

// ── Helpers de conversas ──────────────────────────────────────────
// Usamos o telefone como chave (só dígitos)
function phoneKey(telefone) {
  return String(telefone).replace(/\D+/g, '');
}

export async function getConversa(telefone) {
  const key = phoneKey(telefone);
  const c = await fb.get(`bot_conversas/${key}`);
  return c || null;
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
  // Mantém últimas 40 mensagens para não inchar
  if (conversa.mensagens.length > 40) {
    conversa.mensagens = conversa.mensagens.slice(-40);
  }
  conversa.ultimaMsg = msg.texto || '';
  conversa.atualizadoEm = Date.now();
  await fb.put(`bot_conversas/${key}`, conversa);
  return conversa;
}

// Escreve um pedido em pedidos_abertos com autoAceito=true
// O PDV (quando for master tab) vai pegar, auto-aceitar e imprimir
export async function criarPedidoAberto(pedido) {
  const key = `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    ...pedido,
    origem: 'whatsapp-bot',
    autoAceito: true,
    status: 'aguardando',
    criadoEm: Date.now(),
  };
  await fb.put(`pedidos_abertos/${key}`, payload);
  return { key, ...payload };
}

// Upsert de cliente em /clientes_bot (o PDV pode puxar depois)
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
