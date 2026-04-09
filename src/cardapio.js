// Cardápio do Esquina Burger — espelho do PDV/loja
// Sempre que atualizar no PDV, atualize aqui também OU migre para ler do Firebase
export const CARDAPIO = [
  // ── COMBOS ──────────────────────────────────────────────────────
  { id: 1,  nome: 'Combo Duplo Blade',        desc: '2 hambúrgueres blade artesanais, cheddar, bacon, cebola caramelizada + fritas 300g + refri lata', preco: 74.90, cat: 'combos' },
  { id: 2,  nome: 'Combo Duplo Bacon',        desc: '2 hambúrgueres bovinos, cheddar, bacon crocante + fritas 100g + refri lata', preco: 47.90, cat: 'combos' },

  // ── BURGERS ─────────────────────────────────────────────────────
  { id: 3,  nome: "01 - Junior's Burger",     desc: 'Pão, hambúrguer bovino, queijo, alface, tomate e molho da casa', preco: 24.00, cat: 'burgers' },
  { id: 4,  nome: '02 - Big Chesserburguer',  desc: 'Pão, hambúrguer bovino, queijo cheddar duplo e molho especial', preco: 25.00, cat: 'burgers' },
  { id: 5,  nome: '03 - Smoke Burger',        desc: 'Pão, hambúrguer bovino, queijo, bacon, cebola caramelizada e molho barbecue', preco: 26.00, cat: 'burgers' },
  { id: 6,  nome: '04 - Duplo Blade',         desc: '2 hambúrgueres blade artesanais, queijo cheddar, bacon, cebola caramelizada e molho da casa', preco: 34.00, cat: 'burgers' },
  { id: 7,  nome: '05 - Duplo Bacon',         desc: '2 hambúrgueres bovinos, queijo cheddar, bacon crocante e molho especial', preco: 36.00, cat: 'burgers' },
  { id: 8,  nome: '06 - Esquina Burger',      desc: 'Nosso especial: 2 hambúrgueres blade, queijo duplo, bacon, ovo, cebola caramelizada, alface, tomate e molho da casa', preco: 62.00, cat: 'burgers' },
  { id: 9,  nome: '07 - Bacon Burger',        desc: 'Pão, hambúrguer bovino, queijo, muito bacon e molho especial', preco: 28.00, cat: 'burgers' },
  { id: 10, nome: '08 - Blade Artesanal',     desc: 'Pão, hambúrguer blade artesanal, queijo, alface, tomate e molho da casa', preco: 27.00, cat: 'burgers' },

  // ── ACOMPANHAMENTOS ─────────────────────────────────────────────
  { id: 11, nome: 'Fritas 100g',              desc: 'Porção individual de fritas crocantes', preco: 8.00,  cat: 'porcoes' },
  { id: 12, nome: 'Porção de Fritas 300g',    desc: 'Porção grande de fritas crocantes para compartilhar', preco: 20.00, cat: 'porcoes' },
  { id: 13, nome: 'Porção Cheddar e Bacon',   desc: 'Fritas com cheddar cremoso e bacon crocante por cima', preco: 35.00, cat: 'porcoes' },

  // ── BEBIDAS ─────────────────────────────────────────────────────
  { id: 14, nome: 'Coca-Cola Lata 350ml',     desc: 'Refrigerante Coca-Cola gelado', preco: 8.00,  cat: 'bebidas' },
  { id: 15, nome: 'Coca-Cola Zero Lata',      desc: 'Refrigerante Coca-Cola Zero gelado', preco: 8.00,  cat: 'bebidas' },
  { id: 16, nome: 'Coca-Cola 600ml',          desc: 'Coca-Cola garrafa 600ml', preco: 10.00, cat: 'bebidas' },
  { id: 17, nome: 'Sprite Lata 350ml',        desc: 'Refrigerante Sprite gelado', preco: 8.00,  cat: 'bebidas' },
  { id: 18, nome: 'Fanta Laranja Lata',       desc: 'Refrigerante Fanta Laranja gelado', preco: 8.00,  cat: 'bebidas' },
  { id: 19, nome: 'Guaraná Zero Lata',        desc: 'Refrigerante Guaraná Zero gelado', preco: 8.00,  cat: 'bebidas' },
  { id: 20, nome: 'Pepsi 2 Litros',           desc: 'Refrigerante Pepsi 2L', preco: 15.00, cat: 'bebidas' },
  { id: 21, nome: 'Suco de Laranja Natural',  desc: 'Suco de laranja natural 500ml', preco: 13.00, cat: 'bebidas' },
  { id: 22, nome: 'Água sem Gás 500ml',       desc: 'Água mineral sem gás', preco: 5.00,  cat: 'bebidas' },
  { id: 23, nome: 'Água com Gás 500ml',       desc: 'Água mineral com gás', preco: 5.00,  cat: 'bebidas' },

  // ── MONTE O SEU (ingredientes avulsos) ──────────────────────────
  { id: 25, nome: 'Pão de Hambúrguer',        desc: 'Pão brioche', preco: 4.00,  cat: 'extras' },
  { id: 26, nome: 'Hambúrguer 130g',          desc: 'Hambúrguer bovino extra', preco: 8.00,  cat: 'extras' },
  { id: 27, nome: 'Queijo Cheddar',           desc: 'Fatia extra de cheddar', preco: 7.00,  cat: 'extras' },
  { id: 28, nome: 'Queijo Mussarela',         desc: 'Fatia extra de mussarela', preco: 7.00,  cat: 'extras' },
  { id: 29, nome: 'Bacon',                    desc: 'Porção extra de bacon crocante', preco: 8.00,  cat: 'extras' },
  { id: 30, nome: 'Cebola Caramelizada',      desc: 'Porção de cebola caramelizada', preco: 4.00,  cat: 'extras' },
  { id: 31, nome: 'Ovo',                      desc: 'Ovo extra', preco: 3.00,  cat: 'extras' },
  { id: 32, nome: 'Alface',                   desc: 'Folhas de alface', preco: 3.00,  cat: 'extras' },
  { id: 33, nome: 'Tomate',                   desc: 'Rodelas de tomate', preco: 3.00,  cat: 'extras' },
  { id: 34, nome: 'Salada Completa',          desc: 'Alface, tomate, cebola roxa e picles', preco: 6.00,  cat: 'extras' },
  { id: 35, nome: 'Molho Extra',              desc: 'Porção de molho da casa', preco: 4.00,  cat: 'extras' },
];

export function buscarItem(query) {
  if (!query) return null;
  const q = String(query).toLowerCase().trim();
  // Tenta por ID exato
  const porId = CARDAPIO.find(i => String(i.id) === q);
  if (porId) return porId;
  // Tenta por nome exato
  const exato = CARDAPIO.find(i => i.nome.toLowerCase() === q);
  if (exato) return exato;
  // Tenta por substring
  const parcial = CARDAPIO.find(i => i.nome.toLowerCase().includes(q));
  if (parcial) return parcial;
  // Tenta por palavras-chave (remove prefixo tipo "01 -")
  const porPalavra = CARDAPIO.find(i => {
    const nomeClean = i.nome.toLowerCase().replace(/^\d+\s*-\s*/, '');
    return nomeClean.includes(q) || q.includes(nomeClean.split(' ')[0]);
  });
  return porPalavra || null;
}

export function cardapioResumo() {
  const cats = { combos: [], burgers: [], porcoes: [], bebidas: [], extras: [] };
  CARDAPIO.forEach(i => { if (cats[i.cat]) cats[i.cat].push(i); });
  const lbls = { combos: 'COMBOS', burgers: 'HAMBÚRGUERES', porcoes: 'ACOMPANHAMENTOS', bebidas: 'BEBIDAS', extras: 'MONTE O SEU' };
  let txt = '';
  for (const k of Object.keys(cats)) {
    if (!cats[k].length) continue;
    txt += `\n== ${lbls[k]} ==\n`;
    cats[k].forEach(i => {
      txt += `[${i.id}] ${i.nome} — R$ ${i.preco.toFixed(2).replace('.', ',')}\n`;
      if (i.desc) txt += `    ${i.desc}\n`;
    });
  }
  return txt.trim();
}
