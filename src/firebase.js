// ── Cliente Firebase Realtime Database via REST ────────────────
import fetch from 'node-fetch';
import { config } from './config.js';

if (!config.firebase.dbUrl) {
  throw new Error('FIREBASE_DB_URL nao configurado');
}

var base = config.firebase.dbUrl.replace(/\/$/, '');
var authParam = config.firebase.authSecret ? ('?auth=' + config.firebase.authSecret) : '';

async function req(method, path, body) {
  var url = base + '/' + path + '.json' + authParam;

  var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);

  var res = await fetch(url, opts);
  if (!res.ok) {
    var txt = await res.text().catch(function() { return ''; });
    throw new Error('Firebase ' + method + ' ' + path + ' -> ' + res.status + ': ' + txt);
  }
  if (res.status === 204) return null;
  return res.json();
}

export var fb = {
  get:   function(path)       { return req('GET',    path); },
  put:   function(path, body) { return req('PUT',    path, body); },
  post:  function(path, body) { return req('POST',   path, body); },
  patch: function(path, body) { return req('PATCH',  path, body); },
  del:   function(path)       { return req('DELETE', path); },
};

// ── Helpers ────────────────────────────────────────────────────

function phoneKey(telefone) {
  return String(telefone).replace(/\D+/g, '');
}

// ── Conversas ──────────────────────────────────────────────────

export async function getConversa(telefone) {
  return (await fb.get('bot_conversas/' + phoneKey(telefone))) || null;
}

export async function salvarConversa(telefone, dados) {
  var key = phoneKey(telefone);
  var atual = (await fb.get('bot_conversas/' + key)) || {};
  var merged = Object.assign({}, atual, dados, { atualizadoEm: Date.now() });
  await fb.put('bot_conversas/' + key, merged);
  return merged;
}

export async function adicionarMensagem(telefone, msg) {
  var key = phoneKey(telefone);
  var conversa = (await fb.get('bot_conversas/' + key)) || {
    telefone: key,
    criadoEm: Date.now(),
    mensagens: [],
    status: 'ativo',
  };

  if (!Array.isArray(conversa.mensagens)) conversa.mensagens = [];
  conversa.mensagens.push(Object.assign({}, msg, { timestamp: Date.now() }));

  if (conversa.mensagens.length > 40) {
    conversa.mensagens = conversa.mensagens.slice(-40);
  }

  conversa.ultimaMsg = msg.texto || '';
  conversa.atualizadoEm = Date.now();
  await fb.put('bot_conversas/' + key, conversa);
  return conversa;
}

// ── Pedidos ────────────────────────────────────────────────────

export async function criarPedidoAberto(pedido) {
  var key = 'bot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var codigoConfirmacao = String(Math.floor(1000 + Math.random() * 9000));

  var payload = Object.assign({}, pedido, {
    origem: 'whatsapp-bot',
    autoAceito: true,
    status: 'aguardando',
    codigoConfirmacao: codigoConfirmacao,
    criadoEm: Date.now(),
  });

  await fb.put('pedidos_abertos/' + key, payload);
  return Object.assign({ key: key, codigoConfirmacao: codigoConfirmacao }, payload);
}

// ── Clientes ───────────────────────────────────────────────────

export async function getCliente(telefone) {
  var key = phoneKey(telefone);
  return (await fb.get('clientes_bot/' + key)) || null;
}

export async function upsertCliente(cliente) {
  var key = phoneKey(cliente.telefone);
  if (!key) return null;

  var atual = (await fb.get('clientes_bot/' + key)) || {
    id: Date.now(),
    criadoEm: Date.now(),
    pedidos: 0,
    totalGasto: 0,
  };

  var merged = Object.assign({}, atual, cliente, { telefone: key, atualizadoEm: Date.now() });
  await fb.put('clientes_bot/' + key, merged);
  return merged;
}

// ── Config da loja (le do bot_config no Firebase) ──────────────

export async function getConfigLoja() {
  try {
    var botCfg = (await fb.get('bot_config/bot')) || {};
    var entregaCfg = (await fb.get('bot_config/entrega')) || {};

    // Calcula se a loja esta aberta
    var lojaAberta = true;
    var horarioAtivo = botCfg.horarioAtivo === true;

    if (horarioAtivo && botCfg.horaAbertura && botCfg.horaFechamento) {
      var agora = new Date();
      var brTime = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      var horaAtual = brTime.getHours() * 60 + brTime.getMinutes();
      var partsAbre = botCfg.horaAbertura.split(':').map(Number);
      var partsFecha = botCfg.horaFechamento.split(':').map(Number);
      var minAbre = partsAbre[0] * 60 + (partsAbre[1] || 0);
      var minFecha = partsFecha[0] * 60 + (partsFecha[1] || 0);

      if (minAbre < minFecha) {
        lojaAberta = horaAtual >= minAbre && horaAtual <= minFecha;
      } else {
        lojaAberta = horaAtual >= minAbre || horaAtual <= minFecha;
      }

      // Verifica dia da semana
      var diaSemana = brTime.getDay();
      if (Array.isArray(botCfg.diasFuncionamento) && botCfg.diasFuncionamento.indexOf(diaSemana) === -1) {
        lojaAberta = false;
      }
    }

    return {
      entrega_ativa: botCfg.entregaAtiva !== false,
      taxa_entrega: entregaCfg.taxa || 5,
      horario_ativo: horarioAtivo,
      horario_abre: botCfg.horaAbertura || '',
      horario_fecha: botCfg.horaFechamento || '',
      loja_aberta: lojaAberta,
      msg_fechado: botCfg.msgFechado || 'Estamos fechados no momento. Volte no nosso horario de funcionamento.',
      chave_pix: botCfg.chavePix || '',
      tipo_chave_pix: botCfg.tipoChavePix || '',
      nome_recebedor: botCfg.nomeRecebedor || '',
      menu_image_url: botCfg.menuImageUrl || '',
    };
  } catch (e) {
    console.warn('Erro ao ler config da loja:', e.message);
    return {};
  }
}
