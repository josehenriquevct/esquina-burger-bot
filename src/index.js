// Servidor principal do bot do Esquina Burger
// Recebe webhooks da Evolution API, processa com Gemini, responde via WhatsApp
// Também expõe endpoints REST pra aba Atendimento do PDV
import 'dotenv/config';
import express from 'express';
import { processarMensagem } from './ai.js';
import { enviarMensagem, mostrarDigitando, parseWebhook } from './evolution.js';
import { adicionarMensagem, salvarConversa, getConversa, fb } from './firebase.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS aberto pro PDV no navegador chamar os endpoints (token-protegido nos sensíveis)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token, x-webhook-token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.WEBHOOK_TOKEN || '';
function checkBotToken(req, res) {
  if (!BOT_TOKEN) return true;
  const t = req.headers['x-bot-token'] || req.query.token;
  if (t !== BOT_TOKEN) {
    res.status(401).json({ error: 'Token inválido' });
    return false;
  }
  return true;
}

function phoneKey(t) { return String(t || '').replace(/\D+/g, ''); }

const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;

// Fila simples por telefone para evitar processamento paralelo do mesmo cliente
const filaPorTelefone = new Map();

async function processarComFila(telefone, texto, pushName) {
  const anterior = filaPorTelefone.get(telefone) || Promise.resolve();
  const atual = anterior.then(async () => {
    try {
      // Salva mensagem do cliente
      await adicionarMensagem(telefone, { role: 'user', texto, pushName });

      // Mostra "digitando..."
      mostrarDigitando(telefone, 2000).catch(() => {});

      // Processa com Claude
      const resposta = await processarMensagem(telefone, texto, pushName);

      if (!resposta) {
        console.log(`⏸ ${telefone} — conversa pausada para humano, não respondendo`);
        return;
      }

      // Envia resposta
      await enviarMensagem(telefone, resposta);

      // Salva no histórico
      await adicionarMensagem(telefone, { role: 'assistant', texto: resposta });
    } catch (e) {
      console.error(`❌ Erro ao processar ${telefone}:`, e);
      try {
        await enviarMensagem(
          telefone,
          'Ops, tive um probleminha aqui 😅 Pode tentar de novo daqui a pouquinho? Se preferir, diga "atendente" que chamo alguém pra te ajudar.'
        );
      } catch {}
    }
  });
  filaPorTelefone.set(telefone, atual);
  // Limpa a fila depois que termina (evita memory leak)
  atual.finally(() => {
    if (filaPorTelefone.get(telefone) === atual) {
      filaPorTelefone.delete(telefone);
    }
  });
  return atual;
}

// ── Health check ──
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Esquina Burger Bot',
    timestamp: new Date().toISOString(),
  });
});

// ── Webhook da Evolution API ──
app.post('/webhook', async (req, res) => {
  // Validação de token opcional
  if (WEBHOOK_TOKEN) {
    const token = req.headers['x-webhook-token'] || req.query.token;
    if (token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'Token inválido' });
    }
  }

  // Responde rápido para a Evolution — processamento é assíncrono
  res.json({ ok: true });

  const evento = req.body?.event;
  // Só processa mensagens recebidas
  if (evento && evento !== 'messages.upsert' && evento !== 'MESSAGES_UPSERT') {
    return;
  }

  const msg = parseWebhook(req.body);
  if (!msg) return;

  console.log(`📥 ${msg.telefone} (${msg.pushName || '?'}): ${msg.texto.slice(0, 80)}`);

  // Processa na fila
  processarComFila(msg.telefone, msg.texto, msg.pushName).catch(e =>
    console.error('Erro fila:', e)
  );
});

// ── Endpoint para testar o bot sem WhatsApp ──
app.post('/test', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const { telefone, texto, pushName } = req.body;
    if (!telefone || !texto) {
      return res.status(400).json({ error: 'telefone e texto são obrigatórios' });
    }
    const resposta = await processarMensagem(telefone, texto, pushName);
    res.json({ resposta });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── API pra aba Atendimento do PDV ─────────────────────────────────

// Lista todas as conversas (resumo)
app.get('/conversas', async (req, res) => {
  if (!checkBotToken(req, res)) return;
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
    res.status(500).json({ error: e.message });
  }
});

// Detalhe de uma conversa
app.get('/conversa/:telefone', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const c = await getConversa(req.params.telefone);
    res.json(c || { telefone: phoneKey(req.params.telefone), mensagens: [], status: 'ativo' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pausa a IA pra um contato (humano assume)
app.post('/pausar', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const tel = phoneKey(req.body?.telefone);
    if (!tel) return res.status(400).json({ error: 'telefone obrigatório' });
    await salvarConversa(tel, { status: 'pausado_humano' });
    res.json({ ok: true, telefone: tel, status: 'pausado_humano' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Retoma a IA pra um contato
app.post('/retomar', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const tel = phoneKey(req.body?.telefone);
    if (!tel) return res.status(400).json({ error: 'telefone obrigatório' });
    await salvarConversa(tel, { status: 'ativo' });
    res.json({ ok: true, telefone: tel, status: 'ativo' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Envia uma mensagem manual pelo WhatsApp (humano respondendo)
// Salva no histórico como role:assistant_humano pra diferenciar
app.post('/send', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const tel = phoneKey(req.body?.telefone);
    const texto = String(req.body?.texto || '').trim();
    if (!tel || !texto) return res.status(400).json({ error: 'telefone e texto obrigatórios' });

    await enviarMensagem(tel, texto);
    await adicionarMensagem(tel, { role: 'assistant', texto, manual: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backup completo do Firebase (protegido) — usado pra snapshot local antes de mexer
app.get('/backup', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const snapshot = {
      geradoEm: new Date().toISOString(),
      bot_conversas: (await fb.get('bot_conversas')) || {},
      clientes_bot:  (await fb.get('clientes_bot'))  || {},
      pedidos_abertos: (await fb.get('pedidos_abertos')) || {},
      clientes:  (await fb.get('clientes'))  || {},
      produtos:  (await fb.get('produtos'))  || {},
      pedidos:   (await fb.get('pedidos'))   || {},
      config:    (await fb.get('config'))    || {},
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="firebase-backup.json"');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Status geral do bot (pra aba Atendimento mostrar)
app.get('/status', async (req, res) => {
  res.json({
    online: true,
    instance: process.env.EVOLUTION_INSTANCE || '',
    modelo: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    temGemini: !!process.env.GEMINI_API_KEY,
    temEvolution: !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_API_KEY),
    temFirebase: !!process.env.FIREBASE_DB_URL,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🍔 Esquina Burger Bot rodando na porta ${PORT}`);
  console.log(`   Webhook:    POST /webhook`);
  console.log(`   Teste:      POST /test { telefone, texto }`);
  console.log(`   Conversas:  GET  /conversas`);
  console.log(`   Pausar:     POST /pausar { telefone }`);
  console.log(`   Retomar:    POST /retomar { telefone }`);
  console.log(`   Send:       POST /send { telefone, texto }`);
  console.log(`   Status:     GET  /status`);
});
