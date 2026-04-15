// ── Rotas da API (com segurança) ───────────────────────────────
import { Router } from 'express';
import { config } from './config.js';
import { processarMensagem, transcreverAudio } from './ai.js';
import { enviarMensagem, mostrarDigitando, parseWebhook, baixarMidiaBase64 } from './evolution.js';
import { adicionarMensagem, salvarConversa, getConversa, upsertCliente, fb } from './firebase.js';
import {
  verificarRateLimit,
  verificarWebhookToken,
  verificarBotToken,
  sanitizarMensagem,
} from './security.js';

const router = Router();

// ── Helpers ────────────────────────────────────────────────────

function phoneKey(t) { return String(t || '').replace(/\D+/g, ''); }

// Middleware de autenticação para rotas protegidas
function authMiddleware(req, res, next) {
  if (!verificarBotToken(req)) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

// Fila por telefone (evita processamento paralelo do mesmo cliente)
const filaPorTelefone = new Map();

async function processarComFila(telefone, texto, pushName) {
  const anterior = filaPorTelefone.get(telefone) || Promise.resolve();
  const atual = anterior.then(async () => {
    try {
      await adicionarMensagem(telefone, { role: 'user', texto, pushName });
      mostrarDigitando(telefone, 2000).catch(() => {});

      const resposta = await processarMensagem(telefone, texto, pushName);
      if (!resposta) {
        console.log(`⏸ ${telefone} — pausado para humano`);
        return;
      }

      await enviarMensagem(telefone, resposta);
      await adicionarMensagem(telefone, { role: 'assistant', texto: resposta });
    } catch (e) {
      console.error(`❌ Erro ${telefone}:`, e);
      try {
        await enviarMensagem(telefone,
          'Ops, tive um probleminha 😅 Pode tentar de novo? Se preferir, diga "atendente" que chamo alguém.'
        );
      } catch {}
    }
  });

  filaPorTelefone.set(telefone, atual);
  atual.finally(() => {
    if (filaPorTelefone.get(telefone) === atual) filaPorTelefone.delete(telefone);
  });
  return atual;
}

// ═══════════════════════════════════════════════════════════════
// ROTAS PÚBLICAS (sem autenticação)
// ═══════════════════════════════════════════════════════════════

// Health check
router.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Esquina Burger Bot' });
});

// Status (informação básica, sem dados sensíveis)
router.get('/status', async (req, res) => {
  let entregaAtiva = true;
  let lojaAberta = true;
  try {
    const cfg = (await fb.get('config')) || {};
    entregaAtiva = cfg.entrega_ativa !== false;
    lojaAberta = cfg.loja_aberta !== false;
  } catch {}
  res.json({
    online: true,
    entrega_ativa: entregaAtiva,
    loja_aberta: lojaAberta,
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════
// WEBHOOK (autenticação via webhook token)
// ═══════════════════════════════════════════════════════════════

router.post('/webhook', async (req, res) => {
  // Verifica token do webhook (timing-safe)
  if (!verificarWebhookToken(req)) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // Responde rápido — processamento é assíncrono
  res.json({ ok: true });

  const evento = req.body?.event;
  if (evento && evento !== 'messages.upsert' && evento !== 'MESSAGES_UPSERT') return;

  const msg = parseWebhook(req.body);
  if (!msg) return;

  // Rate limiting por telefone
  if (!verificarRateLimit(msg.telefone)) {
    console.warn(`🚫 Rate limit atingido: ${msg.telefone}`);
    return;
  }

  // Sanitiza a mensagem
  msg.texto = sanitizarMensagem(msg.texto);
  if (!msg.texto && !msg.audio) return;

  console.log(`📥 ${msg.telefone} (${msg.pushName || '?'}): ${msg.texto.slice(0, 80)}`);

  // Localização recebida
  if (msg.localizacao) {
    try {
      await upsertCliente({ telefone: msg.telefone, endereco: 'Localização', localizacao: msg.localizacao });
      await adicionarMensagem(msg.telefone, { role: 'user', texto: msg.texto, pushName: msg.pushName });
      console.log(`📍 Localização de ${msg.telefone}`);
    } catch (e) {
      console.error('Erro ao salvar localização:', e.message);
    }
  }

  // Áudio — transcreve antes de processar
  if (msg.audio && msg.messageKey) {
    console.log(`🎤 Áudio de ${msg.telefone}, transcrevendo...`);
    try {
      mostrarDigitando(msg.telefone, 5000).catch(() => {});
      const midia = await baixarMidiaBase64(msg.messageKey);
      if (midia?.base64) {
        const transcricao = await transcreverAudio(midia.base64, midia.mimetype);
        if (transcricao && !transcricao.includes('[erro') && !transcricao.includes('[audio')) {
          msg.texto = sanitizarMensagem(transcricao);
          console.log(`✅ Transcrito: "${msg.texto.slice(0, 80)}"`);
        } else {
          msg.texto = '[O cliente enviou audio mas nao foi possivel entender. Peca para digitar.]';
        }
      } else {
        msg.texto = '[O cliente enviou audio mas nao foi possivel baixar. Peca para digitar.]';
      }
    } catch (e) {
      console.error('Erro áudio:', e.message);
      msg.texto = '[O cliente enviou audio mas houve erro. Peca para digitar.]';
    }
  }

  processarComFila(msg.telefone, msg.texto, msg.pushName).catch(e => console.error('Erro fila:', e));
});

// ═══════════════════════════════════════════════════════════════
// ROTAS PROTEGIDAS (requerem BOT_TOKEN via header x-bot-token)
// ═══════════════════════════════════════════════════════════════

// Teste sem WhatsApp
router.post('/test', authMiddleware, async (req, res) => {
  const { telefone, texto, pushName } = req.body;
  if (!telefone || !texto) return res.status(400).json({ error: 'telefone e texto obrigatórios' });

  try {
    const textoLimpo = sanitizarMensagem(texto);
    const resposta = await processarMensagem(telefone, textoLimpo, pushName);
    res.json({ resposta });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Lista conversas
router.get('/conversas', authMiddleware, async (req, res) => {
  try {
    const todas = (await fb.get('bot_conversas')) || {};
    const lista = Object.entries(todas).map(([tel, c]) => ({
      telefone: tel,
      nome: c?.nome || c?.cliente?.nome || c?.nome_whatsapp || '',
      ultimaMsg: c?.ultimaMsg || '',
      status: c?.status || 'ativo',
      atualizadoEm: c?.atualizadoEm || c?.criadoEm || 0,
      qtdMsgs: Array.isArray(c?.mensagens) ? c.mensagens.length : 0,
    }));
    lista.sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0));
    res.json({ conversas: lista });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Detalhe de conversa
router.get('/conversa/:telefone', authMiddleware, async (req, res) => {
  try {
    const c = await getConversa(req.params.telefone);
    res.json(c || { telefone: phoneKey(req.params.telefone), mensagens: [], status: 'ativo' });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Pausar IA
router.post('/pausar', authMiddleware, async (req, res) => {
  const tel = phoneKey(req.body?.telefone);
  if (!tel) return res.status(400).json({ error: 'telefone obrigatório' });
  try {
    await salvarConversa(tel, { status: 'pausado_humano' });
    res.json({ ok: true, telefone: tel, status: 'pausado_humano' });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Retomar IA
router.post('/retomar', authMiddleware, async (req, res) => {
  const tel = phoneKey(req.body?.telefone);
  if (!tel) return res.status(400).json({ error: 'telefone obrigatório' });
  try {
    await salvarConversa(tel, { status: 'ativo' });
    res.json({ ok: true, telefone: tel, status: 'ativo' });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Enviar mensagem manual
router.post('/send', authMiddleware, async (req, res) => {
  const tel = phoneKey(req.body?.telefone);
  const texto = sanitizarMensagem(req.body?.texto);
  if (!tel || !texto) return res.status(400).json({ error: 'telefone e texto obrigatórios' });
  try {
    await enviarMensagem(tel, texto);
    await adicionarMensagem(tel, { role: 'assistant', texto, manual: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});


  try {
    const cfg = (await fb.get('config')) || {};
    cfg.loja_aberta = aberta;
    cfg.loja_alteradoEm = Date.now();
    await fb.put('config', cfg);
    console.log(`🏪 Loja ${aberta ? 'ABERTA' : 'FECHADA'}`);
    res.json({ ok: true, loja_aberta: aberta });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Liga/desliga entrega
router.post('/entrega', authMiddleware, async (req, res) => {
  const ativa = req.body?.ativa;
  if (typeof ativa !== 'boolean') return res.status(400).json({ error: '"ativa" (boolean) obrigatório' });
  try {
    const cfg = (await fb.get('config')) || {};
    cfg.entrega_ativa = ativa;
    cfg.entrega_alteradoEm = Date.now();
    await fb.put('config', cfg);
    console.log(`🚚 Entrega ${ativa ? 'ATIVADA' : 'DESATIVADA'}`);
    res.json({ ok: true, entrega_ativa: ativa });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Backup (protegido + nunca expõe em mensagens de erro)
router.get('/backup', authMiddleware, async (req, res) => {
  try {
    const snapshot = {
      geradoEm: new Date().toISOString(),
      bot_conversas: (await fb.get('bot_conversas')) || {},
      clientes_bot: (await fb.get('clientes_bot')) || {},
      pedidos_abertos: (await fb.get('pedidos_abertos')) || {},
      config: (await fb.get('config')) || {},
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="backup.json"');
    // Não inclui dados do PDV no backup do bot (clientes, produtos, pedidos do PDV)
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

export default router;
