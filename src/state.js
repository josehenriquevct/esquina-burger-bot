// ── Gerenciamento de estado por cliente ─────────────────────────
// Carrinho e dados do cliente em memória com fallback Firebase
import { getCliente } from './firebase.js';

const carrinhos = new Map();
const dadosClientes = new Map();

// ── Carrinho ───────────────────────────────────────────────────

export function getCarrinho(telefone) {
  if (!carrinhos.has(telefone)) carrinhos.set(telefone, []);
  return carrinhos.get(telefone);
}

export function adicionarAoCarrinho(telefone, item) {
  const carrinho = getCarrinho(telefone);
  carrinho.push(item);
  return carrinho;
}

export function removerDoCarrinho(telefone, nome) {
  const carrinho = getCarrinho(telefone);
  const idx = carrinho.findIndex(i => i.nome.toLowerCase().includes(String(nome).toLowerCase()));
  if (idx === -1) return null;
  return carrinho.splice(idx, 1)[0];
}

export function totalCarrinho(telefone) {
  return getCarrinho(telefone).reduce((s, i) => s + i.subtotal, 0);
}

// ── Dados do cliente ───────────────────────────────────────────

export function getDados(telefone) {
  if (!dadosClientes.has(telefone)) dadosClientes.set(telefone, { telefone });
  return dadosClientes.get(telefone);
}

// Carrega dados salvos do Firebase (cliente que já comprou antes)
export async function carregarClienteFirebase(telefone) {
  const dados = getDados(telefone);
  if (dados._carregouFirebase) return dados;

  try {
    const salvo = await getCliente(telefone);
    if (salvo) {
      if (salvo.nome && !dados.nome) dados.nome = salvo.nome;
      if (salvo.endereco && !dados.endereco) dados.endereco = salvo.endereco;
      if (salvo.bairro && !dados.bairro) dados.bairro = salvo.bairro;
      if (salvo.referencia && !dados.referencia) dados.referencia = salvo.referencia;
      if (salvo.localizacao && !dados.localizacao) dados.localizacao = salvo.localizacao;
      if (salvo.nome) console.log(`👤 Cliente reconhecido: ${salvo.nome} (${telefone})`);
    }
  } catch (e) {
    console.warn('Erro ao buscar cliente salvo:', e.message);
  }

  dados._carregouFirebase = true;
  return dados;
}

// ── Limpar estado (após finalizar ou cancelar pedido) ──────────

export function limparEstado(telefone) {
  carrinhos.delete(telefone);
  dadosClientes.delete(telefone);
}

export function limparCarrinho(telefone) {
  carrinhos.set(telefone, []);
}
