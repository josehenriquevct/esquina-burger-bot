// Servidor principal do bot do Esquina Burger
// Recebe webhooks da Evolution API, processa com Claude, responde via WhatsApp
import 'dotenv/config';
import express from 'express';
import { processarMensagem } from './ai.js';
import { enviarMensagem, mostrarDigitando, parseWebhook } from './evolution.js';
import { adicionarMensagem } from './firebase.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

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

app.listen(PORT, () => {
  console.log(`🍔 Esquina Burger Bot rodando na porta ${PORT}`);
  console.log(`   Webhook: POST /webhook`);
  console.log(`   Teste:   POST /test { telefone, texto }`);
});
