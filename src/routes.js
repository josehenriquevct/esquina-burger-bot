import { Router } from 'express';
import { config } from './config.js';
import { processarMensagem, processarPedidoInterno, transcreverAudio } from './ai.js';
import { enviarMensagem, mostrarDigitando, parseWebhook, baixarMidiaBase64 } from './evolution.js';
import { adicionarMensagem, salvarConversa, getConversa, upsertCliente, fb } from './firebase.js';
import {
  verificarRateLimit,
  verificarWebhookToken,
  verificarBotToken,
  sanitizarMensagem,
} from './security.js';
import { emitirNfce, consultarNfce, cancelarNfce, nfceStatus } from './nfce.js';
import { gerarPixQr, consultarPagamento, pixStatus } from './pix.js';

var router = Router();

function phoneKey(t) { return String(t || '').replace(/\D+/g, ''); }

function isNumeroInterno(telefone) {
  var tel = phoneKey(telefone);
  var interno = phoneKey(config.telefoneInterno);
  return interno && tel === interno;
}

function authMiddleware(req, res, next) {
  if (!verificarBotToken(req)) {
    return res.status(401).json({ error: 'Nao autorizado' });
  }
  next();
}

// ── Dedupe de webhook por message.key.id ──────────────────────
// Evolution API pode reenviar o mesmo evento (retry, reconexão) —
// sem isso o bot processa duas vezes e duplica mensagens no histórico
// / itens no carrinho.
var webhooksVistos = new Map(); // id -> timestamp
var WEBHOOK_TTL_MS = 10 * 60 * 1000;
function webhookJaProcessado(id) {
  if (!id) return false;
  var agora = Date.now();
  if (webhooksVistos.size > 1000) {
    for (var entry of webhooksVistos) {
      if (agora - entry[1] > WEBHOOK_TTL_MS) webhooksVistos.delete(entry[0]);
    }
  }
  if (webhooksVistos.has(id)) return true;
  webhooksVistos.set(id, agora);
  return false;
}

// ── Fila de processamento por telefone (evita msgs simultaneas) ──

var filaPorTelefone = new Map();

async function processarComFila(telefone, texto, pushName, imagemData) {
  var anterior = filaPorTelefone.get(telefone) || Promise.resolve();
  var atual = anterior.then(async function() {
    try {
      await adicionarMensagem(telefone, { role: 'user', texto: texto, pushName: pushName });
      mostrarDigitando(telefone, 3500).catch(function() {});
      var resposta = await processarMensagem(telefone, texto, pushName, imagemData);
      if (resposta === null) {
        console.log('Pausado para humano: ' + telefone);
        return;
      }
      if (!resposta) {
        // Resposta vazia intencional — uma tool (ex: enviar_foto_cardapio) ja
        // cobriu tudo que o cliente precisava. Nao envia texto extra.
        console.log('Sem follow-up de texto — tool cobriu a resposta');
        return;
      }
      await enviarMensagem(telefone, resposta);
      await adicionarMensagem(telefone, { role: 'assistant', texto: resposta });
    } catch (e) {
      console.error('Erro ' + telefone + ':', e);
      var fallback = 'Ops, tive um probleminha. Pode tentar de novo? Se preferir, diga "atendente" que chamo alguem.';
      try {
        await enviarMensagem(telefone, fallback);
        await adicionarMensagem(telefone, { role: 'assistant', texto: fallback, erro: true });
      } catch (ignored) {}
    }
  });
  filaPorTelefone.set(telefone, atual);
  atual.finally(function() {
    if (filaPorTelefone.get(telefone) === atual) filaPorTelefone.delete(telefone);
  });
  return atual;
}

// ── Fila para pedidos internos ────────────────────────────────

async function processarInternoComFila(telefone, texto) {
  var anterior = filaPorTelefone.get(telefone) || Promise.resolve();
  var atual = anterior.then(async function() {
    try {
      mostrarDigitando(telefone, 3000).catch(function() {});
      var resposta = await processarPedidoInterno(telefone, texto);
      if (resposta) {
        await enviarMensagem(telefone, resposta);
      }
    } catch (e) {
      console.error('Erro pedido interno ' + telefone + ':', e);
      try {
        await enviarMensagem(telefone, 'Nao entendi o pedido. Manda o audio de novo?');
      } catch (ignored) {}
    }
  });
  filaPorTelefone.set(telefone, atual);
  atual.finally(function() {
    if (filaPorTelefone.get(telefone) === atual) filaPorTelefone.delete(telefone);
  });
  return atual;
}

// ── Rotas ─────────────────────────────────────────────────────

router.get('/', function(req, res) {
  res.json({ status: 'online', service: 'Esquina Burger Bot' });
});

router.get('/status', async function(req, res) {
  var entregaAtiva = true;
  try {
    var botCfg = (await fb.get('bot_config/bot')) || {};
    entregaAtiva = botCfg.entregaAtiva !== false;
  } catch (ignored) {}
  res.json({
    online: true,
    entrega_ativa: entregaAtiva,
    timestamp: new Date().toISOString(),
  });
});

// ── Webhook principal (Evolution API) ─────────────────────────

router.post('/webhook', async function(req, res) {
  // Valida token do webhook ANTES de qualquer coisa. Se WEBHOOK_TOKEN
  // estiver vazio, a função retorna true (compatibilidade), mas deve
  // ser configurada em produção.
  if (!verificarWebhookToken(req)) {
    return res.status(401).json({ error: 'Webhook token inválido' });
  }
  res.json({ ok: true });

  var evento = req.body && req.body.event;
  if (evento && evento !== 'messages.upsert' && evento !== 'MESSAGES_UPSERT') return;

  // Dedupe por message.key.id — Evolution reenvia o mesmo webhook em
  // caso de retry/reconexão, e sem isso duplicamos msgs e itens.
  var rawId = (req.body && req.body.data && req.body.data.key && req.body.data.key.id)
           || (req.body && req.body.key && req.body.key.id);
  if (webhookJaProcessado(rawId)) {
    console.log('Webhook duplicado ignorado: ' + rawId);
    return;
  }

  var msg = parseWebhook(req.body);
  if (!msg) return;

  if (!verificarRateLimit(msg.telefone)) {
    console.warn('Rate limit: ' + msg.telefone);
    return;
  }

  msg.texto = sanitizarMensagem(msg.texto);

  // ── NUMERO INTERNO (funcionario) ────────────────────────────
  if (isNumeroInterno(msg.telefone)) {
    console.log('MSG INTERNA de ' + msg.telefone + ': ' + (msg.audio ? '[AUDIO]' : msg.texto.slice(0, 80)));

    // Audio do funcionario -> transcreve e processa como pedido
    if (msg.audio && msg.messageKey) {
      try {
        mostrarDigitando(msg.telefone, 5000).catch(function() {});
        var midia = await baixarMidiaBase64(msg.messageKey);
        if (midia && midia.base64) {
          var transcricao = await transcreverAudio(midia.base64, midia.mimetype);
          if (transcricao && transcricao.indexOf('[erro') === -1 && transcricao.indexOf('[audio') === -1) {
            processarInternoComFila(msg.telefone, transcricao).catch(function(e) { console.error('Erro fila interna:', e); });
          } else {
            await enviarMensagem(msg.telefone, 'Nao entendi o audio. Manda de novo mais perto do mic?');
          }
        } else {
          await enviarMensagem(msg.telefone, 'Nao consegui baixar o audio. Tenta de novo?');
        }
      } catch (e) {
        console.error('Erro audio interno:', e);
        try { await enviarMensagem(msg.telefone, 'Erro ao processar audio. Tenta de novo?'); } catch (ig) {}
      }
      return;
    }

    // Texto do funcionario -> tambem processa como pedido
    if (msg.texto && msg.texto !== '[figurinha]') {
      processarInternoComFila(msg.telefone, msg.texto).catch(function(e) { console.error('Erro fila interna:', e); });
      return;
    }
    return;
  }

  // ── CLIENTE NORMAL ──────────────────────────────────────────

  if (!msg.texto && !msg.audio && !msg.image) return;

  console.log('Msg de ' + msg.telefone + ' (' + (msg.pushName || '?') + '): ' + msg.texto.slice(0, 80));

  // Sticker sozinha → não processa com Gemini, só confirma brevemente
  if (msg.texto === '[figurinha]') {
    enviarMensagem(msg.telefone, 'Recebi sua figurinha 😄 Se quiser fazer um pedido, é só me dizer!').catch(function() {});
    return;
  }

  // Localizacao (pin GPS): salva no cliente e guarda como "localizacaoRecente"
  // na conversa — o processarMensagem vai puxar pro estado. NÃO chama
  // adicionarMensagem aqui (antes duplicava, porque processarComFila
  // também salva a msg do cliente).
  if (msg.localizacao) {
    try {
      // Preserva o endereço textual que veio no pin (se houver)
      var enderecoTexto = msg.localizacao.endereco || 'Localização (GPS)';
      await upsertCliente({
        telefone: msg.telefone,
        endereco: enderecoTexto,
        localizacao: msg.localizacao,
      });
      await salvarConversa(msg.telefone, { localizacaoRecente: msg.localizacao });
      console.log('Localizacao recebida de ' + msg.telefone + ': ' + msg.localizacao.lat + ', ' + msg.localizacao.lng);
    } catch (e) {
      console.error('Erro localizacao:', e.message);
    }
  }

  // Audio do cliente -> transcreve
  if (msg.audio && msg.messageKey) {
    try {
      mostrarDigitando(msg.telefone, 5000).catch(function() {});
      var midiaAudio = await baixarMidiaBase64(msg.messageKey);
      if (midiaAudio && midiaAudio.base64) {
        var transcricaoCliente = await transcreverAudio(midiaAudio.base64, midiaAudio.mimetype);
        if (transcricaoCliente && transcricaoCliente.indexOf('[erro') === -1 && transcricaoCliente.indexOf('[audio') === -1) {
          msg.texto = sanitizarMensagem(transcricaoCliente);
        } else {
          msg.texto = '[O cliente enviou audio mas nao foi possivel entender. Peca para digitar.]';
        }
      } else {
        msg.texto = '[O cliente enviou audio mas nao foi possivel baixar. Peca para digitar.]';
      }
    } catch (e) {
      msg.texto = '[O cliente enviou audio mas houve erro. Peca para digitar.]';
    }
  }

  // Imagem do cliente -> baixa e passa para analise
  var imagemData = null;
  if (msg.image && msg.messageKey) {
    try {
      mostrarDigitando(msg.telefone, 3000).catch(function() {});
      var midiaImg = await baixarMidiaBase64(msg.messageKey);
      if (midiaImg && midiaImg.base64) {
        imagemData = { base64: midiaImg.base64, mimetype: midiaImg.mimetype || 'image/jpeg' };
        console.log('Imagem recebida de ' + msg.telefone + ' (' + imagemData.mimetype + ')');
      }
    } catch (e) {
      console.error('Erro ao baixar imagem:', e.message);
    }
  }

  processarComFila(msg.telefone, msg.texto, msg.pushName, imagemData).catch(function(e) { console.error('Erro fila:', e); });
});

// ── Endpoints da API ──────────────────────────────────────────

router.post('/test', authMiddleware, async function(req, res) {
  var telefone = req.body && req.body.telefone;
  var texto = req.body && req.body.texto;
  var pushName = req.body && req.body.pushName;
  if (!telefone || !texto) return res.status(400).json({ error: 'telefone e texto obrigatorios' });
  try {
    var resposta = await processarMensagem(telefone, sanitizarMensagem(texto), pushName);
    res.json({ resposta: resposta });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/conversas', authMiddleware, async function(req, res) {
  try {
    var todas = (await fb.get('bot_conversas')) || {};
    var lista = Object.entries(todas).map(function(entry) {
      var tel = entry[0];
      var c = entry[1];
      return {
        telefone: tel,
        nome: (c && c.nome) || (c && c.cliente && c.cliente.nome) || (c && c.nome_whatsapp) || '',
        ultimaMsg: (c && c.ultimaMsg) || '',
        status: (c && c.status) || 'ativo',
        atualizadoEm: (c && c.atualizadoEm) || (c && c.criadoEm) || 0,
        qtdMsgs: (c && Array.isArray(c.mensagens)) ? c.mensagens.length : 0,
      };
    });
    lista.sort(function(a, b) { return (b.atualizadoEm || 0) - (a.atualizadoEm || 0); });
    res.json({ conversas: lista });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/conversa/:telefone', authMiddleware, async function(req, res) {
  try {
    var c = await getConversa(req.params.telefone);
    res.json(c || { telefone: phoneKey(req.params.telefone), mensagens: [], status: 'ativo' });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/pausar', authMiddleware, async function(req, res) {
  var tel = phoneKey(req.body && req.body.telefone);
  if (!tel) return res.status(400).json({ error: 'telefone obrigatorio' });
  try {
    await salvarConversa(tel, { status: 'pausado_humano' });
    res.json({ ok: true, telefone: tel, status: 'pausado_humano' });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/retomar', authMiddleware, async function(req, res) {
  var tel = phoneKey(req.body && req.body.telefone);
  if (!tel) return res.status(400).json({ error: 'telefone obrigatorio' });
  try {
    await salvarConversa(tel, { status: 'ativo' });
    res.json({ ok: true, telefone: tel, status: 'ativo' });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// /send auto-pausa a IA: se o humano tá respondendo manualmente, a IA
// não deve voltar a falar até o humano clicar "retomar" pelo PDV.
router.post('/send', authMiddleware, async function(req, res) {
  var tel = phoneKey(req.body && req.body.telefone);
  var texto = sanitizarMensagem(req.body && req.body.texto);
  if (!tel || !texto) return res.status(400).json({ error: 'telefone e texto obrigatorios' });
  try {
    await enviarMensagem(tel, texto);
    await adicionarMensagem(tel, { role: 'assistant', texto: texto, manual: true });
    await salvarConversa(tel, { status: 'pausado_humano' });
    res.json({ ok: true, status: 'pausado_humano' });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/entrega', authMiddleware, async function(req, res) {
  var ativa = req.body && req.body.ativa;
  if (typeof ativa !== 'boolean') return res.status(400).json({ error: '"ativa" (boolean) obrigatorio' });
  try {
    var bot = (await fb.get('bot_config/bot')) || {};
    bot.entregaAtiva = ativa;
    await fb.put('bot_config/bot', bot);
    console.log('Entrega ' + (ativa ? 'ATIVADA' : 'DESATIVADA'));
    res.json({ ok: true, entrega_ativa: ativa });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── PIX QR Code (Mercado Pago) ─────────────────────────────────

router.get('/pix/status', authMiddleware, function(req, res) {
  res.json(pixStatus());
});

router.post('/pix/qr', authMiddleware, async function(req, res) {
  var pedido = req.body && req.body.pedido;
  if (!pedido) return res.status(400).json({ error: 'pedido obrigatorio' });
  try {
    var r = await gerarPixQr(pedido);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao gerar PIX' });
  }
});

router.get('/pix/consulta/:id', authMiddleware, async function(req, res) {
  try {
    var r = await consultarPagamento(req.params.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao consultar pagamento' });
  }
});

// ── NFC-e (emissão de Nota Fiscal do Consumidor) ──────────────

router.get('/nfce/status', authMiddleware, function(req, res) {
  res.json(nfceStatus());
});

router.post('/nfce/emitir', authMiddleware, async function(req, res) {
  var pedidoKey = req.body && req.body.pedidoKey;
  var pedido = req.body && req.body.pedido; // alternativa: corpo do pedido direto
  if (!pedidoKey && !pedido) return res.status(400).json({ error: 'pedidoKey ou pedido obrigatorio' });
  try {
    var r = await emitirNfce(pedidoKey ? String(pedidoKey) : pedido);
    res.json(r);
  } catch (e) {
    console.error('Erro emitir NFCe:', e);
    res.status(500).json({ error: 'Erro interno emitindo NFC-e' });
  }
});

router.get('/nfce/consulta/:ref', authMiddleware, async function(req, res) {
  try {
    var r = await consultarNfce(req.params.ref);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/nfce/cancelar', authMiddleware, async function(req, res) {
  var ref = req.body && req.body.ref;
  var just = req.body && req.body.justificativa;
  if (!ref) return res.status(400).json({ error: 'ref obrigatorio' });
  try {
    var r = await cancelarNfce(String(ref), String(just || ''));
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/backup', authMiddleware, async function(req, res) {
  try {
    var snapshot = {
      geradoEm: new Date().toISOString(),
      bot_conversas: (await fb.get('bot_conversas')) || {},
      clientes_bot: (await fb.get('clientes_bot')) || {},
      pedidos_abertos: (await fb.get('pedidos_abertos')) || {},
      bot_config: (await fb.get('bot_config')) || {},
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="backup.json"');
    res.send(JSON.stringify(snapshot, null, 2));
  } catch (e) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

export default router;
