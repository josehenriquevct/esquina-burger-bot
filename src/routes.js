import { Router } from 'express';
import { config } from './config.js';
import { processarMensagem, transcreverAudio } from './ai.js';
import { enviarMensagem, mostrarDigitando, parseWebhook, baixarMidiaBase64 } from './evolution.js';
import { adicionarMensagem, salvarConversa, getConversa, upsertCliente, fb } from './firebase.js';
import { verificarRateLimit, verificarWebhookToken, verificarBotToken, sanitizarMensagem } from './security.js';

const router = Router();
function phoneKey(t) { return String(t || '').replace(/\D+/g, ''); }
function authMiddleware(req, res, next) {
  if ( !verificarBotToken(req) ) return res.status(401).json({ error: 'Nao autorizado' });
  next();
}
const filaPorTelefone = new Map();
async function processarComFila(telefone, texto, pushName) {
  const anterior = filaPorTelefone.get(telefone) || Promise.resolve();
  const atual = anterior.then(async () => {
    try {
      await adicionarMensagem(telefone, { role: 'user', texto, pushName });
      mostrarDigitando(telefone, 2000).catch(() => {});
      const resposta = await processarMensagem(telefone, texto, pushName);
      if ( !resposta ) return;
      await enviarMensagem(telefone, resposta);
      await adicionarMensagem(telefone, { role: 'assistant', texto: resposta });
    } catch (e) {
      console.error('Erro:', e);
      try { await enviarMensagem(telefone, 'Ops, tive um probleminha. Pode tentar de novo?'); } catch (x) {}
    }
  });
  filaPorTelefone.set(telefone, atual);
  atual.finally(() => { if (filaPorTelefone.get(telefone) === atual) filaPorTelefone.delete(telefone); });
  return atual;
}
router.get('/', (req, res) => { res.json({ status: 'online', service: 'Esquina Burger Bot' }); });
router.get('/status', async (req, res) => {
  let entregaAtiva = true;
  try { const b = (await fb.get('bot_config/bot')) || {}; entregaAtiva = b.entregaAtiva !== false; } catch (e) {}
  res.json({ online: true, entrega_ativa: entregaAtiva, timestamp: new Date().toISOString() });
});
router.post('/webhook', async (req, res) => {
  res.json({ ok: true });
  const evento = req.body?.event;
  if (evento && evento !== 'messages.upsert' && evento !== 'MESSAGES_UPSERT') return;
  const msg = parseWebhook(req.body);
  if ( !msg ) return;
  if ( !verificarRateLimit(msg.telefone) ) return;
  msg.texto = sanitizarMensagem(msg.texto);
  if ( !msg.texto && !msg.audio ) return;
  if (msg.localizacao) {
    try {
      await upsertCliente({ telefone: msg.telefone, endereco: 'Localizacao', localizacao: msg.localizacao });
      await adicionarMensagem(msg.telefone, { role: 'user', texto: msg.texto, pushName: msg.pushName });
    } catch (e) {}
  }
  if (msg.audio && msg.messageKey) {
    try {
      mostrarDigitando(msg.telefone, 5000).catch(() => {});
      const midia = await baixarMidiaBase64(msg.messageKey);
      if (midia?.base64) {
        const t = await transcreverAudio(midia.base64, midia.mimetype);
        msg.texto = (t && t.indexOf('[erro') === -1 && t.indexOf('[audio') === -1) ? sanitizarMensagem(t) : '[audio nao compreendido]';
      } else { msg.texto = '[audio nao baixado]'; }
    } catch (e) { msg.texto = '[erro audio]'; }
  }
  processarComFila(msg.telefone, msg.texto, msg.pushName).catch(e => console.error('Fila:', e));
});
router.post('/test', authMiddleware, async (req, res) => {
  const { telefone, texto, pushName } = req.body;
  if ( !telefone || !texto ) return res.status(400).json({ error: 'obrigatorio' });
  try { res.json({ resposta: await processarMensagem(telefone, sanitizarMensagem(texto), pushName) }); }
  catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});
router.get('/conversas', authMiddleware, async (req, res) => {
  try {
    const todas = (await fb.get('bot_conversas')) || {};
    const lista = Object.entries(todas).map(([tel, c]) => ({
      telefone: tel, nome: c?.nome || '', ultimaMsg: c?.ultimaMsg || '',
      status: c?.status || 'ativo', atualizadoEm: c?.atualizadoEm || 0,
      qtdMsgs: Array.isArray(c?.mensagens) ? c.mensagens.length : 0,
    }));
    lista.sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0));
    res.json({ conversas: lista });
  } catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});
router.get('/conversa/:telefone', authMiddleware, async (req, res) => {
  try { res.json((await getConversa(req.params.telefone)) || { telefone: phoneKey(req.params.telefone), mensagens: [], status: 'ativo' }); }
  catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/pausar', authMiddleware, async (req, res) => {
  const tel = phoneKey(req.body?.telefone);
  if ( !tel ) return res.status(400).json({ error: 'telefone obrigatorio' });
  try { await salvarConversa(tel, { status: 'pausado_humano' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/retomar', authMiddleware, async (req, res) => {
  const tel = phoneKey(req.body?.telefone);
  if ( !tel ) return res.status(400).json({ error: 'telefone obrigatorio' });
  try { await salvarConversa(tel, { status: 'ativo' }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/send', authMiddleware, async (req, res) => {
  const tel = phoneKey(req.body?.telefone);
  const texto = sanitizarMensagem(req.body?.texto);
  if ( !tel || !texto ) return res.status(400).json({ error: 'obrigatorio' });
  try { await enviarMensagem(tel, texto); await adicionarMensagem(tel, { role: 'assistant', texto, manual: true }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/entrega', authMiddleware, async (req, res) => {
  const ativa = req.body?.ativa;
  if (typeof ativa !== 'boolean') return res.status(400).json({ error: 'ativa boolean obrigatorio' });
  try {
    const bot = (await fb.get('bot_config/bot')) || {};
    bot.entregaAtiva = ativa;
    await fb.put('bot_config/bot', bot);
    res.json({ ok: true, entrega_ativa: ativa });
  } catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});
router.get('/backup', authMiddleware, async (req, res) => {
  try {
    const s = { geradoEm: new Date().toISOString(), bot_conversas: (await fb.get('bot_conversas')) || {}, clientes_bot: (await fb.get('clientes_bot')) || {}, pedidos_abertos: (await fb.get('pedidos_abertos')) || {}, bot_config: (await fb.get('bot_config')) || {} };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(s, null, 2));
  } catch (e) { res.status(500).json({ error: 'Erro interno' }); }
});
export default router;
