// Cardapio lido do Firebase (sincronizado pelo PDV)
import { fb } from './firebase.js';

let CARDAPIO = [];
let ADICIONAIS = [];
let ultimaAtualizacao = 0;
const CACHE_MS = 60000;

const LABELS = {
  combos: 'COMBOS', burgers: 'HAMBURGUERES',
  porcoes: 'ACOMPANHAMENTOS', bebidas: 'BEBIDAS',
  extras: 'MONTE O SEU',
};

async function carregarCardapio() {
  const agora = Date.now();
  if (CARDAPIO.length && agora - ultimaAtualizacao < CACHE_MS) return;
  try {
    const data = await fb.get('bot_config/cardapio');
    if (data?.itens && Array.isArray(data.itens)) {
      CARDAPIO = data.itens.filter(i => !i.esgotado);
      if (data.itens[0]?.adicionais) ADICIONAIS = data.itens[0].adicionais;
      ultimaAtualizacao = agora;
      console.log('📋 Cardapio atualizado:', CARDAPIO.length, 'itens');
    }
  } catch (e) {
    console.warn('Erro cardapio Firebase:', e.message);
  }
}

export async function buscarItem(query) {
  await carregarCardapio();
  if (!query) return null;
  const q = String(query).toLowerCase().trim();
  return CARDAPIO.find(i => String(i.id) === q)
    || CARDAPIO.find(i => i.nome.toLowerCase() === q)
    || CARDAPIO.find(i => i.nome.toLowerCase().includes(q))
    || CARDAPIO.find(i => {
         const n = i.nome.toLowerCase().replace(/^\d+\s*-\s*/, '');
         return n.includes(q) || q.includes(n.split(' ')[0]);
       })
    || null;
}

export async function buscarAdicional(query) {
  await carregarCardapio();
  if (!query) return null;
  const q = String(query).toLowerCase().trim();
  return ADICIONAIS.find(a => a.nome.toLowerCase().includes(q)) || null;
}

export async function itensPorCategoria(categoria) {
  await carregarCardapio();
  const itens = CARDAPIO.filter(i => i.cat === categoria);
  return {
    categoria: LABELS[categoria] || categoria,
    itens: itens.map(i => ({ id: i.id, nome: i.nome, preco: i.preco, desc: i.desc })),
  };
}

export async function cardapioResumo() {
  await carregarCardapio();
  const cats = { burgers: [], combos: [], porcoes: [], bebidas: [] };
  CARDAPIO.forEach(i => { if (cats[i.cat]) cats[i.cat].push(i); });
  let txt = '';
  for (const k of Object.keys(cats)) {
    if (!cats[k].length) continue;
    txt += '\n== ' + (LABELS[k] || k) + ' ==\n';
    cats[k].forEach(i => {
      txt += '[' + i.id + '] ' + i.nome + ' — R$ ' + i.preco.toFixed(2).replace('.', ',') + '\n';
      if (i.desc) txt += '    ' + i.desc + '\n';
    });
  }
  if (ADICIONAIS.length) {
    txt += '\n== ADICIONAIS / MONTE O SEU ==\n';
    ADICIONAIS.forEach(a => {
      txt += '[' + a.id + '] ' + a.nome + ' — R$ ' + a.preco.toFixed(2).replace('.', ',') + '\n';
    });
  }
  return txt.trim();
}
