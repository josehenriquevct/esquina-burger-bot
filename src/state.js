// ── Estado por cliente (persistido no Firebase) ────────────────
// Antes era Map em RAM — sumia a cada restart do Railway, cliente no
// meio do pedido perdia o carrinho. Agora o estado carrega/salva do
// Firebase a cada mensagem (bot_conversas/{tel}/estado).
import {
  getCliente,
  getEstadoCliente,
  salvarEstadoCliente,
  limparEstadoCliente,
} from './firebase.js';

function phoneKey(t) { return String(t || '').replace(/\D+/g, ''); }

// Carrega o estado da sessão (carrinho + dados parciais). Sempre
// retorna um objeto válido, mesmo se não existir ainda no Firebase.
export async function carregarEstado(telefone) {
  const tel = phoneKey(telefone);
  try {
    const e = await getEstadoCliente(tel);
    if (e && typeof e === 'object') {
      return {
        carrinho: Array.isArray(e.carrinho) ? e.carrinho : [],
        dados: (e.dados && typeof e.dados === 'object') ? e.dados : { telefone: tel },
        pedidoKeyExistente: e.pedidoKeyExistente || null,
      };
    }
  } catch (err) {
    console.warn('carregarEstado falhou:', err.message);
  }
  return { carrinho: [], dados: { telefone: tel }, pedidoKeyExistente: null };
}

export async function salvarEstado(telefone, estado) {
  try {
    await salvarEstadoCliente(phoneKey(telefone), estado);
  } catch (err) {
    console.warn('salvarEstado falhou:', err.message);
  }
}

export async function limparEstado(telefone) {
  try {
    await limparEstadoCliente(phoneKey(telefone));
  } catch (err) {
    console.warn('limparEstado falhou:', err.message);
  }
}

// Puxa dados de cliente recorrente do Firebase (se houver) pra dentro
// do estado atual — só preenche campos que ainda estão vazios.
export async function mergeClienteSalvo(estado) {
  if (!estado || !estado.dados || estado.dados._carregouFirebase) return estado;
  try {
    const salvo = await getCliente(estado.dados.telefone);
    if (salvo) {
      if (salvo.nome && !estado.dados.nome) estado.dados.nome = salvo.nome;
      if (salvo.endereco && !estado.dados.endereco) estado.dados.endereco = salvo.endereco;
      if (salvo.bairro && !estado.dados.bairro) estado.dados.bairro = salvo.bairro;
      if (salvo.referencia && !estado.dados.referencia) estado.dados.referencia = salvo.referencia;
      if (salvo.localizacao && !estado.dados.localizacao) estado.dados.localizacao = salvo.localizacao;
      if (salvo.nome) console.log(`👤 Cliente reconhecido: ${salvo.nome} (${estado.dados.telefone})`);
    }
  } catch (e) {
    console.warn('Erro ao buscar cliente salvo:', e.message);
  }
  estado.dados._carregouFirebase = true;
  return estado;
}

// Total do carrinho de um estado
export function totalCarrinho(estado) {
  if (!estado || !Array.isArray(estado.carrinho)) return 0;
  return estado.carrinho.reduce((s, i) => s + (i.subtotal || 0), 0);
}

// Remove item do carrinho pelo nome (substring, do mais recente pro mais antigo)
export function removerDoCarrinho(estado, nome) {
  if (!estado || !Array.isArray(estado.carrinho)) return null;
  const alvo = String(nome || '').toLowerCase();
  if (!alvo) return null;
  for (let i = estado.carrinho.length - 1; i >= 0; i--) {
    if (estado.carrinho[i].nome.toLowerCase().includes(alvo)) {
      return estado.carrinho.splice(i, 1)[0];
    }
  }
  return null;
}
