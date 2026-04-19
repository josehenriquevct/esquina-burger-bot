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

// Normaliza: remove acento, caixa baixa, troca hífen por espaço, tira "NN - "
function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Raiz simples pra plural básico (fritas -> frita, cocas -> coca)
function raiz(w) {
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
}

// Scoring: conta palavras da query que aparecem em nome/compacto/desc.
// Peso maior pro nome. Bonus pra quando a query começa com "x" (lanche).
// Desempate: mais palavras do nome batidas (cobertura), depois menos palavras sobrando.
function encontrarMelhorMatch(lista, qNorm) {
  const palavrasRaw = qNorm.split(' ').filter(Boolean);
  // Detecta "x ..." / "X-..." — usuário tá pedindo um LANCHE (nome começa com "x.")
  const querLanche = palavrasRaw[0] === 'x' || palavrasRaw[0] === 'xis';
  const palavras = palavrasRaw.filter(w => w.length >= 2).map(raiz);
  // Se só "x" foi digitado (sem outro termo), ainda assim mantém a busca
  if (!palavras.length && !querLanche) return null;

  const scored = lista.map(i => {
    const nomeN = normalizar(i.nome);
    const palavrasNome = nomeN.split(' ').filter(Boolean);
    // Compacto sem espaços NEM pontuação — pra pegar "xtudo" vs "x. tudo"
    const nomeCompacto = nomeN.replace(/[\s\.,]+/g, '');
    const descN = normalizar(i.desc || '');
    const ehLanche = /^x\b|^x\./.test(nomeN);
    let score = 0;
    let matches = 0;
    for (const w of palavras) {
      if (palavrasNome.some(p => p === w || p.replace(/\./g,'') === w)) { score += 4; matches++; }
      else if (nomeN.includes(w)) { score += 3; matches++; }
      else if (nomeCompacto.includes(w)) { score += 2; matches++; }
      else if (descN.includes(w)) { score += 1; matches++; }
    }
    // Se o cliente disse "x ..." e o item começa com "X.", é muito mais
    // provável ser o lanche do que um adicional avulso com o mesmo nome
    if (querLanche && ehLanche) score += 5;
    if (querLanche && !ehLanche) score -= 2;
    return { item: i, score, matches, totalPalavrasNome: palavrasNome.length, len: nomeN.length };
  }).filter(s => s.score > 0);

  if (!scored.length) return null;
  // Ordena: maior score → mais matches → menos palavras "sobrando" no nome → nome mais curto
  scored.sort((a, b) =>
    b.score - a.score ||
    b.matches - a.matches ||
    Math.abs(a.totalPalavrasNome - palavras.length) - Math.abs(b.totalPalavrasNome - palavras.length) ||
    a.len - b.len
  );
  return scored[0].item;
}

export async function buscarItem(query) {
  await carregarCardapio();
  if (!query) return null;
  const raw = String(query).toLowerCase().trim();

  // 1. Se a query é só um número, prioriza código visual do menu
  //    ("04 - Duplo Blade" → cliente diz "quero o 4"). Depois id interno.
  if (/^\d+$/.test(raw)) {
    const cleanQ = raw.replace(/^0+/, '') || '0';
    const porCodigo = CARDAPIO.find(i => {
      const m = /^(\d+)\s*-/.exec(i.nome);
      if (!m) return false;
      const cod = m[1].replace(/^0+/, '') || '0';
      return cod === cleanQ;
    });
    if (porCodigo) return porCodigo;
    const porId = CARDAPIO.find(i => String(i.id) === raw);
    if (porId) return porId;
  }

  // 2. Nome exato (ignorando acento/caixa/hífen)
  const qNorm = normalizar(raw);
  if (!qNorm) return null;
  const exato = CARDAPIO.find(i => normalizar(i.nome) === qNorm);
  if (exato) return exato;

  // 3. Scoring por palavras
  return encontrarMelhorMatch(CARDAPIO, qNorm);
}

export async function buscarAdicional(query) {
  await carregarCardapio();
  if (!query) return null;
  const raw = String(query).toLowerCase().trim();
  if (!ADICIONAIS.length) return null;

  // ID exato
  const porId = ADICIONAIS.find(a => String(a.id) === raw);
  if (porId) return porId;

  // Nome exato normalizado
  const qNorm = normalizar(raw);
  if (!qNorm) return null;
  const exato = ADICIONAIS.find(a => normalizar(a.nome) === qNorm);
  if (exato) return exato;

  // Scoring
  return encontrarMelhorMatch(ADICIONAIS, qNorm);
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
      txt += '• ' + i.nome + ' — R$ ' + i.preco.toFixed(2).replace('.', ',') + '\n';
      if (i.desc) txt += '    ' + i.desc + '\n';
    });
  }
  if (ADICIONAIS.length) {
    txt += '\n== ADICIONAIS / MONTE O SEU ==\n';
    ADICIONAIS.forEach(a => {
      txt += '• ' + a.nome + ' — R$ ' + a.preco.toFixed(2).replace('.', ',') + '\n';
    });
  }
  return txt.trim();
}
