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

// ── Fila de processamento por telefone (evita msgs simultaneas) ──

var filaPorTelefone = new Map();

async function processarComFila(telefone, texto, pushName, imagemData) {
  var anterior = filaPorTelefone.get(telefone) || Promise.resolve();
  var atual = anterior.then(async function() {
    try {
      await adicionarMensagem(telefone, { role: 'user', texto: texto, pushName: pushName });
      mostrarDigitando(telefone, 2000).catch(function() {});
      var resposta = await processarMensagem(telefone, texto, pushName, imagemData);
      if (!resposta) {
        console.log('Pausado para humano: ' + telefone);
        return;
      }
      await enviarMensagem(telefone, resposta);
      await adicionarMensagem(telefone, { role: 'assistant', texto: resposta });
    } catch (e) {
      console.error('Erro ' + telefone + ':', e);
      try {
        await enviarMensagem(telefone,
          'Ops, tive um probleminha. Pode tentar de novo? Se preferir, diga "atendente" que chamo alguem.'
        );
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
  res.json({ ok: true });

  var evento = req.body && req.body.event;
  if (evento && evento !== 'messages.upsert' && evento !== 'MESSAGES_UPSERT') return;

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

  // Localizacao
  if (msg.localizacao) {
    try {
      await upsertCliente({ telefone: msg.telefone, endereco: 'Localizacao', localizacao: msg.localizacao });
      await adicionarMensagem(msg.telefone, { role: 'user', texto: msg.texto, pushName: msg.pushName });
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

router.post('/send', authMiddleware, async function(req, res) {
  var tel = phoneKey(req.body && req.body.telefone);
  var texto = sanitizarMensagem(req.body && req.body.texto);
  if (!tel || !texto) return res.status(400).json({ error: 'telefone e texto obrigatorios' });
  try {
    await enviarMensagem(tel, texto);
    await adicionarMensagem(tel, { role: 'assistant', texto: texto, manual: true });
    res.json({ ok: true });
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
