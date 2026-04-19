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

// Atualiza um pedido aberto existente (usado quando cliente altera pedido
// antes do PDV aceitar). Preserva codigoConfirmacao e criadoEm.
export async function atualizarPedidoAberto(key, pedido) {
  var atual = (await fb.get('pedidos_abertos/' + key)) || {};
  var payload = Object.assign({}, atual, pedido, {
    alterado: true,
    atualizadoEm: Date.now(),
    codigoConfirmacao: atual.codigoConfirmacao || pedido.codigoConfirmacao,
    criadoEm: atual.criadoEm || Date.now(),
    status: atual.status || 'aguardando',
  });
  await fb.put('pedidos_abertos/' + key, payload);
  return Object.assign({ key: key }, payload);
}

// Busca o pedido aberto mais recente do cliente ainda não aceito pelo PDV.
// Usado pra detectar "alteração de pedido" — se cliente pede algo e ainda
// tem pedido em status=aguardando de até N minutos atrás, atualiza em vez
// de duplicar.
export async function buscarPedidoAbertoDoCliente(telefone, minutosLimite) {
  if (minutosLimite === undefined) minutosLimite = 30;
  var key = phoneKey(telefone);
  var todos = (await fb.get('pedidos_abertos')) || {};
  var limite = Date.now() - minutosLimite * 60 * 1000;
  var candidatos = Object.entries(todos).filter(function(entry) {
    var p = entry[1];
    if (!p || typeof p !== 'object') return false;
    var telPedido = phoneKey(p && p.cliente && p.cliente.telefone || '');
    if (telPedido !== key) return false;
    if ((p.criadoEm || 0) < limite) return false;
    if (p.status === 'cancelado' || p.status === 'entregue') return false;
    return true;
  }).sort(function(a, b) { return (b[1].criadoEm || 0) - (a[1].criadoEm || 0); });
  if (!candidatos.length) return null;
  return Object.assign({ key: candidatos[0][0] }, candidatos[0][1]);
}

// ── Estado da sessão do cliente (carrinho + dados parciais) ────
// Persiste em bot_conversas/{tel}/estado. Antes ficava em Map em RAM
// e sumia a cada restart do Railway — cliente no meio do pedido perdia tudo.
export async function getEstadoCliente(telefone) {
  var key = phoneKey(telefone);
  return (await fb.get('bot_conversas/' + key + '/estado')) || null;
}

export async function salvarEstadoCliente(telefone, estado) {
  var key = phoneKey(telefone);
  var limpo = {
    carrinho: Array.isArray(estado && estado.carrinho) ? estado.carrinho : [],
    dados: (estado && estado.dados && typeof estado.dados === 'object') ? estado.dados : { telefone: key },
    pedidoKeyExistente: (estado && estado.pedidoKeyExistente) || null,
    atualizadoEm: Date.now(),
  };
  await fb.put('bot_conversas/' + key + '/estado', limpo);
}

export async function limparEstadoCliente(telefone) {
  var key = phoneKey(telefone);
  await fb.del('bot_conversas/' + key + '/estado');
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

    // Calcula estado da loja: aberta | antes_abrir | depois_fechar | dia_fechado
    var lojaAberta = true;
    var estadoLoja = 'aberta';
    var abreEm = '';
    var horarioAtivo = botCfg.horarioAtivo === true;

    if (horarioAtivo && botCfg.horaAbertura && botCfg.horaFechamento) {
      var agora = new Date();
      var brTime = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      var horaAtual = brTime.getHours() * 60 + brTime.getMinutes();
      var diaSemana = brTime.getDay(); // 0=dom, 5=sex, 6=sab
      var partsAbre = botCfg.horaAbertura.split(':').map(Number);
      var minAbre = partsAbre[0] * 60 + (partsAbre[1] || 0);

      // Usa horaFechamentoFDS em sex (5) e sab (6) se estiver preenchido
      var fechaUsado = botCfg.horaFechamento;
      if ((diaSemana === 5 || diaSemana === 6) && botCfg.horaFechamentoFDS) {
        fechaUsado = botCfg.horaFechamentoFDS;
      }
      var partsFecha = fechaUsado.split(':').map(Number);
      var minFecha = partsFecha[0] * 60 + (partsFecha[1] || 0);
      abreEm = botCfg.horaAbertura;

      // Dia nao funciona = dia_fechado
      if (Array.isArray(botCfg.diasFuncionamento) && botCfg.diasFuncionamento.indexOf(diaSemana) === -1) {
        lojaAberta = false;
        estadoLoja = 'dia_fechado';
      } else if (minAbre < minFecha) {
        // Horario normal (ex: 18h-23h)
        if (horaAtual < minAbre) {
          lojaAberta = false;
          estadoLoja = 'antes_abrir'; // ainda vai abrir hoje
        } else if (horaAtual > minFecha) {
          lojaAberta = false;
          estadoLoja = 'depois_fechar'; // ja fechou
        } else {
          lojaAberta = true;
        }
      } else {
        // Cruza meia-noite (ex: 18h abre, 01h fecha do dia seguinte)
        if (horaAtual >= minAbre || horaAtual <= minFecha) {
          lojaAberta = true;
        } else {
          // Entre fecha e abre = fechado. Como abre hoje ainda, antes_abrir.
          lojaAberta = false;
          estadoLoja = 'antes_abrir';
        }
      }
    }

    return {
      entrega_ativa: botCfg.entregaAtiva !== false,
      taxa_entrega: entregaCfg.taxa || 5,
      horario_ativo: horarioAtivo,
      horario_abre: botCfg.horaAbertura || '',
      horario_fecha: botCfg.horaFechamento || '',
      loja_aberta: lojaAberta,
      estado_loja: estadoLoja, // aberta | antes_abrir | depois_fechar | dia_fechado
      aceita_agendamento: estadoLoja === 'antes_abrir',
      abre_em: abreEm,
      msg_fechado: botCfg.msgFechado || 'Estamos fechados no momento. Volte no nosso horario de funcionamento.',
      chave_pix: botCfg.chavePix || '',
      tipo_chave_pix: botCfg.tipoChavePix || '',
      nome_recebedor: botCfg.nomeRecebedor || '',
      menu_image_url: botCfg.menuImageUrl || '',
      menu_image_url2: botCfg.menuImageUrl2 || '',
    };
  } catch (e) {
    console.warn('Erro ao ler config da loja:', e.message);
    return {};
  }
}
