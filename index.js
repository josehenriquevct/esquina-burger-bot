// Servidor principal do bot do Esquina Burger
// Recebe webhooks da Evolution API, processa com Gemini, responde via WhatsApp
// Também expõe endpoints REST pra aba Atendimento do PDV

import 'dotenv/config';
import express from 'express';
import { processarMensagem, transcreverAudio } from './ai.js';
import { enviarMensagem, mostrarDigitando, parseWebhook, baixarMidiaBase64 } from './evolution.js';
import { adicionarMensagem, salvarConversa, getConversa, upsertCliente, fb } from './firebase.js';

// Ignora mensagens anteriores ao boot (evita flood pos-redeploy)
const BOT_STARTED_AT = Math.floor(Date.now() / 1000);

// Deduplicação: ignora webhooks repetidos da mesma mensagem
const mensagensProcessadas = new Set();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutos

function jaProcessou(messageId) {
  if (!messageId) return false;
  if (mensagensProcessadas.has(messageId)) return true;
  mensagensProcessadas.add(messageId);
  setTimeout(() => mensagensProcessadas.delete(messageId), DEDUP_TTL_MS);
  return false;
}

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
  if (t !== BOT_TOKEN) { res.status(401).json({ error: 'Token inválido' }); return false; }
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

  // Ignora mensagens anteriores ao boot do bot (evita flood pos-redeploy)
  const msgTs = Number(req.body?.data?.messageTimestamp || 0);
  if (msgTs && msgTs < BOT_STARTED_AT) {
    console.log(`⏭ Ignorando msg antiga de ${msg.telefone} (ts=${msgTs} < boot=${BOT_STARTED_AT})`);
    return;
  }

  // Deduplicação por ID de mensagem (ignora webhook repetido)
  const messageId = req.body?.data?.key?.id;
  if (jaProcessou(messageId)) {
    console.log(`🔁 Msg duplicada ignorada de ${msg.telefone} (id=${messageId})`);
    return;
  }

  console.log(`📥 ${msg.telefone} (${msg.pushName || '?'}): ${msg.texto.slice(0, 80)}`);

  // Se o cliente mandou localização, salva no Firebase com link do Maps
  if (msg.localizacao) {
    try {
      const mapsLink = `https://www.google.com/maps?q=${msg.localizacao.lat},${msg.localizacao.lng}`;
      await upsertCliente({
        telefone: msg.telefone,
        endereco: msg.localizacao.endereco || msg.localizacao.nome || 'Localização GPS',
        localizacao: msg.localizacao,
        mapsLink: mapsLink,
      });
      await adicionarMensagem(msg.telefone, { role: 'user', texto: msg.texto, pushName: msg.pushName });
      console.log(`📍 Localização recebida de ${msg.telefone}: ${msg.localizacao.lat}, ${msg.localizacao.lng} → ${mapsLink}`);
    } catch (e) {
      console.error('Erro ao salvar localização:', e.message);
    }
  }

  // Se o cliente mandou áudio, transcreve antes de processar
  if (msg.audio && msg.messageKey) {
    console.log(`🎤 Áudio recebido de ${msg.telefone}, baixando e transcrevendo...`);
    try {
      // Mostra "gravando áudio..." enquanto transcreve
      mostrarDigitando(msg.telefone, 5000).catch(() => {});

      // Baixa o áudio da Evolution API
      const midia = await baixarMidiaBase64(msg.messageKey);
      if (midia?.base64) {
        // Transcreve usando Gemini
        const transcricao = await transcreverAudio(midia.base64, midia.mimetype);
        if (transcricao && !transcricao.includes('[erro') && !transcricao.includes('[áudio não')) {
          msg.texto = transcricao;
          console.log(`✅ Áudio transcrito: "${transcricao.slice(0, 80)}"`);
        } else {
          msg.texto = '[O cliente enviou um áudio mas não foi possível entender. Peça educadamente para ele digitar a mensagem.]';
          console.log(`⚠ Áudio não compreendido de ${msg.telefone}`);
        }
      } else {
        msg.texto = '[O cliente enviou um áudio mas não foi possível baixar. Peça educadamente para ele digitar a mensagem.]';
        console.log(`⚠ Não conseguiu baixar áudio de ${msg.telefone}`);
      }
    } catch (e) {
      console.error('Erro ao processar áudio:', e.message);
      msg.texto = '[O cliente enviou um áudio mas houve um erro ao processar. Peça educadamente para ele digitar.]';
    }
  }

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalhe de uma conversa
app.get('/conversa/:telefone', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const c = await getConversa(req.params.telefone);
    res.json(c || { telefone: phoneKey(req.params.telefone), mensagens: [], status: 'ativo' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Pausa a IA pra um contato (humano assume)
app.post('/pausar', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const tel = phoneKey(req.body?.telefone);
    if (!tel) return res.status(400).json({ error: 'telefone obrigatório' });
    await salvarConversa(tel, { status: 'pausado_humano' });
    res.json({ ok: true, telefone: tel, status: 'pausado_humano' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Retoma a IA pra um contato
app.post('/retomar', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const tel = phoneKey(req.body?.telefone);
    if (!tel) return res.status(400).json({ error: 'telefone obrigatório' });
    await salvarConversa(tel, { status: 'ativo' });
    res.json({ ok: true, telefone: tel, status: 'ativo' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Backup completo do Firebase (protegido) — usado pra snapshot local antes de mexer
app.get('/backup', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const snapshot = {
      geradoEm: new Date().toISOString(),
      bot_conversas: (await fb.get('bot_conversas')) || {},
      clientes_bot: (await fb.get('clientes_bot')) || {},
      pedidos_abertos: (await fb.get('pedidos_abertos')) || {},
      clientes: (await fb.get('clientes')) || {},
      produtos: (await fb.get('produtos')) || {},
      pedidos: (await fb.get('pedidos')) || {},
      config: (await fb.get('config')) || {},
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="firebase-backup.json"');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Abre/Fecha a loja (PDV controla se está aceitando pedidos) ──
app.post('/loja', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const aberta = req.body?.aberta;
    if (typeof aberta !== 'boolean') return res.status(400).json({ error: 'Campo "aberta" (boolean) é obrigatório' });
    const config = (await fb.get('config')) || {};
    config.loja_aberta = aberta;
    config.loja_alteradoEm = Date.now();
    await fb.put('config', config);
    console.log(`🏪 Loja ${aberta ? 'ABERTA' : 'FECHADA'}`);
    res.json({ ok: true, loja_aberta: aberta });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Liga/Desliga entrega ──
app.post('/entrega', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const ativa = req.body?.ativa;
    if (typeof ativa !== 'boolean') return res.status(400).json({ error: 'Campo "ativa" (boolean) é obrigatório' });
    const config = (await fb.get('config')) || {};
    config.entrega_ativa = ativa;
    config.entrega_alteradoEm = Date.now();
    await fb.put('config', config);
    console.log(`🚚 Entrega ${ativa ? 'ATIVADA' : 'DESATIVADA'}`);
    res.json({ ok: true, entrega_ativa: ativa });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Rastreio ao vivo — página que o cliente abre pra acompanhar a entrega ──
app.get('/rastreio/:pedidoId', async (req, res) => {
  try {
    const pedido = await fb.get(`pedidos_abertos/${req.params.pedidoId}`);
    if (!pedido) return res.status(404).send('Pedido não encontrado');

    const nomeRestaurante = process.env.RESTAURANTE_NOME || 'Esquina Burger';

    // Página HTML com mapa ao vivo
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rastreio - ${nomeRestaurante}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; background: #1a1a1a; color: #fff; }
    .header { background: #222; padding: 16px 20px; text-align: center; }
    .header h1 { font-size: 18px; color: #e63946; }
    .header p { font-size: 13px; color: #aaa; margin-top: 4px; }
    .status { padding: 12px 20px; text-align: center; font-size: 14px; }
    .status.entregando { background: #2d8a4e; }
    .status.aguardando { background: #e6a817; color: #000; }
    .status.entregue { background: #333; }
    #map { width: 100%; height: 60vh; background: #333; }
    .info { padding: 16px 20px; }
    .info p { font-size: 14px; color: #ccc; margin-bottom: 6px; }
    .info .nome { font-size: 16px; font-weight: bold; color: #fff; }
    .atualizado { text-align: center; padding: 8px; font-size: 11px; color: #666; }
  </style>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head>
<body>
  <div class="header">
    <h1>🍔 ${nomeRestaurante}</h1>
    <p>Acompanhe sua entrega em tempo real</p>
  </div>
  <div id="statusBar" class="status aguardando">Localizando entregador...</div>
  <div id="map"></div>
  <div class="info">
    <p class="nome">Pedido #${req.params.pedidoId.slice(-6)}</p>
    <p>👤 ${pedido.cliente?.nome || ''}</p>
    <p>📦 ${(pedido.itens || []).map(i => i.qtd + 'x ' + i.nome).join(', ')}</p>
  </div>
  <div id="atualizacao" class="atualizado"></div>

  <script>
    const FIREBASE_URL = '${process.env.FIREBASE_DB_URL}'.replace(/\\/$/, '');
    const entregadorTel = '${pedido.entregador || ''}';
    const pedidoId = '${req.params.pedidoId}';

    // Inicializa mapa (centro do Brasil como fallback)
    const map = L.map('map').setView([-15.8, -49.8], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    let marker = null;
    let destMarker = null;
    let centered = false;

    // Marca destino se tiver localização do cliente
    const clienteLoc = ${JSON.stringify(pedido.cliente?.localizacao || null)};
    if (clienteLoc && clienteLoc.lat) {
      destMarker = L.marker([clienteLoc.lat, clienteLoc.lng], {
        icon: L.divIcon({ html: '📍', className: 'emoji-icon', iconSize: [30, 30] })
      }).addTo(map).bindPopup('Seu endereço');
    }

    async function atualizar() {
      try {
        // Verifica status do pedido
        const pedidoRes = await fetch(FIREBASE_URL + '/pedidos_abertos/' + pedidoId + '.json');
        const pedidoData = await pedidoRes.json();

        if (!pedidoData) {
          document.getElementById('statusBar').textContent = 'Pedido não encontrado';
          return;
        }

        if (pedidoData.status === 'entregue') {
          document.getElementById('statusBar').className = 'status entregue';
          document.getElementById('statusBar').textContent = '✅ Pedido entregue!';
          return;
        }

        const tel = pedidoData.entregador || entregadorTel;
        if (!tel) {
          document.getElementById('statusBar').className = 'status aguardando';
          document.getElementById('statusBar').textContent = '⏳ Preparando seu pedido...';
          return;
        }

        // Busca localização do entregador
        const res = await fetch(FIREBASE_URL + '/entregadores/' + tel + '.json');
        const entregador = await res.json();

        if (entregador && entregador.localizacao && entregador.localizacao.lat) {
          const lat = entregador.localizacao.lat;
          const lng = entregador.localizacao.lng;

          document.getElementById('statusBar').className = 'status entregando';
          document.getElementById('statusBar').textContent = '🏍 ' + (entregador.nome || 'Entregador') + ' está a caminho!';

          if (!marker) {
            marker = L.marker([lat, lng], {
              icon: L.divIcon({ html: '🏍', className: 'emoji-icon', iconSize: [30, 30] })
            }).addTo(map);
          } else {
            marker.setLatLng([lat, lng]);
          }

          if (!centered) {
            map.setView([lat, lng], 15);
            centered = true;
          }

          const tempo = entregador.localizacao.atualizadoEm;
          if (tempo) {
            const seg = Math.round((Date.now() - tempo) / 1000);
            document.getElementById('atualizacao').textContent = 'Atualizado há ' + seg + ' segundos';
          }
        }
      } catch (e) {
        console.warn('Erro ao atualizar:', e);
      }
    }

    // Atualiza a cada 5 segundos
    atualizar();
    setInterval(atualizar, 5000);
  </script>
</body>
</html>`);
  } catch (e) {
    res.status(500).send('Erro: ' + e.message);
  }
});

// ── Mapa de todos os entregadores (pro PDV) ──
app.get('/entregadores/mapa', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const entregadores = (await fb.get('entregadores')) || {};
    const lista = Object.entries(entregadores).map(([tel, e]) => ({
      telefone: tel,
      nome: e.nome || '',
      online: e.online || false,
      status: e.status || 'pendente',
      localizacao: e.localizacao || null,
      totalEntregas: e.totalEntregas || 0,
    }));
    res.json({ entregadores: lista });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Aprovar/Bloquear entregador (pro PDV) ──
app.post('/entregadores/aprovar', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const tel = phoneKey(req.body?.telefone);
    const acao = req.body?.acao; // 'aprovado' ou 'bloqueado'
    if (!tel || !acao) return res.status(400).json({ error: 'telefone e acao obrigatórios' });
    await fb.patch(`entregadores/${tel}`, { status: acao, aprovadoEm: Date.now() });
    console.log(`👤 Entregador ${tel} → ${acao}`);
    res.json({ ok: true, telefone: tel, status: acao });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Localização de um cliente (pro entregador) ──
app.get('/localizacao/:telefone', async (req, res) => {
  if (!checkBotToken(req, res)) return;
  try {
    const tel = phoneKey(req.params.telefone);
    const cliente = await fb.get(`clientes_bot/${tel}`);
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });
    const loc = cliente.localizacao;
    const mapsLink = loc?.lat && loc?.lng ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : '';
    res.json({
      telefone: tel,
      nome: cliente.nome || '',
      endereco: cliente.endereco || '',
      bairro: cliente.bairro || '',
      referencia: cliente.referencia || '',
      localizacao: loc || null,
      mapsLink: mapsLink,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Status geral do bot (pra aba Atendimento mostrar)
app.get('/status', async (req, res) => {
  let entregaAtiva = true;
  let lojaAberta = false;
  try {
    const config = (await fb.get('config')) || {};
    entregaAtiva = config.entrega_ativa !== false;
    lojaAberta = config.loja_aberta === true;
  } catch {}

  res.json({
    online: true,
    loja_aberta: lojaAberta,
    entrega_ativa: entregaAtiva,
    instance: process.env.EVOLUTION_INSTANCE || '',
    modelo: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    temGemini: !!process.env.GEMINI_API_KEY,
    temEvolution: !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_API_KEY),
    temFirebase: !!process.env.FIREBASE_DB_URL,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🍔 Esquina Burger Bot rodando na porta ${PORT}`);
  console.log(`  Webhook:   POST /webhook`);
  console.log(`  Teste:     POST /test { telefone, texto }`);
  console.log(`  Conversas: GET  /conversas`);
  console.log(`  Pausar:    POST /pausar { telefone }`);
  console.log(`  Retomar:   POST /retomar { telefone }`);
  console.log(`  Send:      POST /send { telefone, texto }`);
  console.log(`  Loja:      POST /loja { aberta: true/false }`);
  console.log(`  Status:    GET  /status`);
});
