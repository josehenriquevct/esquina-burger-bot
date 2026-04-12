// ============================================
// Esquina Burger - Bot WhatsApp (v2)
// ============================================
// Comportamento:
//  - NÃO apresenta cardápio por padrão (a maioria já sabe o que quer)
//  - Envia IMAGEM do cardápio só quando o cliente pede explicitamente
//  - Se não pediu batata, oferece batata
//  - Se não pediu bebida, oferece bebida
//  - Pergunta retirada x entrega
//      retirada -> não pede endereço, só avisa que avisará quando pronto
//      entrega  -> pede endereço e cadastra cliente automaticamente
//  - Salva conversas em bot_conversas/{telefone} no schema do PDV
//  - Cria pedido em pedidos_abertos/{push} no schema que o PDV importa
//  - Respeita pausa humana (status === 'pausado_humano' => não responde)
// ============================================

const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp } = require('firebase/app');
const {
  getDatabase, ref, push, set, update, get, onValue, serverTimestamp
} = require('firebase/database');

// ---------- Config ----------
const PORT              = process.env.PORT || 3000;
const GEMINI_KEY        = process.env.GEMINI_API_KEY;
const FIREBASE_DB_URL   = process.env.FIREBASE_DB_URL;
const EVOLUTION_URL     = process.env.EVOLUTION_URL || 'https://evolution-api-1ne0.srv1540257.hstgr.cloud';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE_NAME     = process.env.EVOLUTION_INSTANCE || 'esquina-burger';
const RESTAURANT_NAME   = process.env.RESTAURANTE_NOME || 'Esquina Burger';
// Fallbacks - sobrescritos em runtime pelos valores que vêm do PDV via Firebase (bot_config/*)
const DEFAULT_DELIVERY_FEE = parseFloat(process.env.TAXA_ENTREGA || '5.00');
const POLL_INTERVAL_MS  = parseInt(process.env.POLL_INTERVAL_MS || '8000', 10);
const HISTORY_LIMIT     = 20;
// Só processa mensagens recebidas APÓS o bot subir — ignora histórico antigo
// (evita reprocessar tudo após cada redeploy e duplicar pedidos)
const BOT_STARTED_AT    = Math.floor(Date.now() / 1000);
// Tempo mínimo entre 2 pedidos do mesmo telefone (em ms) — trava contra duplicação
const PEDIDO_LOCK_MS    = 3 * 60 * 1000;

// ============================================
// ESTADO DINÂMICO (vem do Firebase em tempo real)
// ============================================
// O PDV escreve em bot_config/cardapio, bot_config/entrega e bot_config/bot.
// O bot escuta esses paths e atualiza essas variáveis automaticamente.
let CARDAPIO_LIVE = [];
let ENTREGA_CFG = { taxa: DEFAULT_DELIVERY_FEE, bairros: [], minimo: 0 };
let BOT_CFG = {
  menuImageUrl: process.env.MENU_IMAGE_URL || '',
  chavePix: process.env.PIX_KEY || '46.757.307/0001-32',
  tipoChavePix: process.env.PIX_TIPO || 'CNPJ',
  nomeRecebedor: process.env.PIX_NOME || 'Esquina Burger',
  // Horário de funcionamento (configurável via PDV)
  horarioAtivo: true,        // se false, aceita pedido 24h
  horaAbertura: '18:00',     // HH:MM
  horaFechamento: '23:30',   // HH:MM (se < abertura, entende que vira o dia)
  diasFuncionamento: [0,1,2,3,4,5,6], // 0=dom, 1=seg, ... 6=sab
  msgFechado: 'Opa! Nosso atendimento já encerrou por hoje 😴. Abrimos todo dia das 18h às 23h30. Valeu pela preferência, te esperamos!',
  // Entrega: quando false, bot só aceita retirada (ex: folga do entregador)
  entregaAtiva: true,
};

// Verifica se o restaurante está aberto AGORA (no fuso local do servidor)
function estaAberto() {
  if (!BOT_CFG.horarioAtivo) return true;
  const agora = new Date();
  // Fuso Brasil (UTC-3)
  const brasil = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = brasil.getDay();
  const hhmm = brasil.getHours() * 60 + brasil.getMinutes();
  const dias = Array.isArray(BOT_CFG.diasFuncionamento) ? BOT_CFG.diasFuncionamento : [0,1,2,3,4,5,6];
  if (!dias.includes(dia)) return false;
  const parse = (s) => {
    const [h,m] = String(s||'').split(':').map(Number);
    return (h||0)*60 + (m||0);
  };
  const abre = parse(BOT_CFG.horaAbertura);
  const fecha = parse(BOT_CFG.horaFechamento);
  if (fecha > abre) {
    // Mesmo dia: aberto entre abre e fecha
    return hhmm >= abre && hhmm < fecha;
  } else {
    // Vira o dia: ex: 18:00 até 02:00
    return hhmm >= abre || hhmm < fecha;
  }
}

function getCardapio()    { return CARDAPIO_LIVE.length ? CARDAPIO_LIVE : CARDAPIO_FALLBACK; }
function getDeliveryFee(bairro) {
  if (bairro && Array.isArray(ENTREGA_CFG.bairros)) {
    const norm = (s) => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
    const hit = ENTREGA_CFG.bairros.find(b => norm(b.nome) === norm(bairro));
    if (hit && Number.isFinite(Number(hit.taxa))) return Number(hit.taxa);
  }
  return Number(ENTREGA_CFG.taxa) || DEFAULT_DELIVERY_FEE;
}
function getMenuImageUrl() { return BOT_CFG.menuImageUrl || process.env.MENU_IMAGE_URL || ''; }

// Cardápio fallback (só usado se o PDV ainda não tiver sincronizado nada)
const CARDAPIO_FALLBACK = [
  // Hambúrgueres
  { id: 1, categoria: 'hamburguer', nome: 'X-Burger',        preco: 18.00 },
  { id: 2, categoria: 'hamburguer', nome: 'X-Salada',        preco: 20.00 },
  { id: 3, categoria: 'hamburguer', nome: 'X-Bacon',         preco: 23.00 },
  { id: 4, categoria: 'hamburguer', nome: 'X-Egg',           preco: 21.00 },
  { id: 5, categoria: 'hamburguer', nome: 'X-Tudo',          preco: 28.00 },
  { id: 6, categoria: 'hamburguer', nome: 'X-Frango',        preco: 22.00 },
  { id: 7, categoria: 'hamburguer', nome: 'X-Calabresa',     preco: 22.00 },
  { id: 8, categoria: 'hamburguer', nome: 'X-Esquina',       preco: 30.00 },
  // Combos
  { id: 20, categoria: 'combo', nome: 'Combo 1 (X-Burger + Batata + Refri)', preco: 32.00 },
  { id: 21, categoria: 'combo', nome: 'Combo 2 (X-Tudo + Batata + Refri)',   preco: 42.00 },
  // Porções (batata)
  { id: 30, categoria: 'porcao', nome: 'Batata Frita P', preco: 10.00 },
  { id: 31, categoria: 'porcao', nome: 'Batata Frita M', preco: 15.00 },
  { id: 32, categoria: 'porcao', nome: 'Batata Frita G', preco: 20.00 },
  // Bebidas
  { id: 40, categoria: 'bebida', nome: 'Coca-Cola Lata',     preco: 6.00  },
  { id: 41, categoria: 'bebida', nome: 'Coca-Cola 600ml',    preco: 9.00  },
  { id: 42, categoria: 'bebida', nome: 'Coca-Cola 2L',       preco: 14.00 },
  { id: 43, categoria: 'bebida', nome: 'Guaraná Lata',       preco: 6.00  },
  { id: 44, categoria: 'bebida', nome: 'Guaraná 600ml',      preco: 8.00  },
  { id: 45, categoria: 'bebida', nome: 'Guaraná 2L',         preco: 12.00 },
  { id: 46, categoria: 'bebida', nome: 'Suco Lata',          preco: 6.00  },
  { id: 47, categoria: 'bebida', nome: 'Água Mineral',       preco: 4.00  },
  { id: 48, categoria: 'bebida', nome: 'Água com Gás',       preco: 5.00  },
  { id: 49, categoria: 'bebida', nome: 'Heineken Long Neck', preco: 10.00 },
  { id: 50, categoria: 'bebida', nome: 'Skol Lata',          preco: 6.00  },
  { id: 51, categoria: 'bebida', nome: 'Brahma Lata',        preco: 6.00  },
  { id: 52, categoria: 'bebida', nome: 'Energético',         preco: 12.00 },
];

function cardapioParaPrompt() {
  const lista = getCardapio();
  if (!lista.length) return '(cardápio ainda sincronizando do PDV...)';
  // Agrupa por categoria pra ficar mais legível pro Gemini
  const grupos = {};
  lista.forEach(i => {
    const cat = i.cat || i.categoria || 'outros';
    (grupos[cat] = grupos[cat] || []).push(i);
  });
  const ordem = ['burgers','combos','porcoes','bebidas','outros'];
  const cats = Object.keys(grupos).sort((a,b) => {
    const ai = ordem.indexOf(a); const bi = ordem.indexOf(b);
    return (ai<0?99:ai) - (bi<0?99:bi);
  });
  return cats.map(cat => {
    const head = `── ${cat.toUpperCase()} ──`;
    const linhas = grupos[cat].map(i => {
      const esgotado = !!(i.esgotado || (i.controlaEstoque && (Number(i.estoque)||0) <= 0));
      return `${i.id} | ${i.nome}${i.desc ? ' — '+i.desc : ''} | R$ ${Number(i.preco).toFixed(2)}${esgotado ? ' | ❌ ESGOTADO' : ''}`;
    }).join('\n');
    return head + '\n' + linhas;
  }).join('\n');
}

function temBatataNoPedido(itens) {
  const ids = (getCardapio() || [])
    .filter(i => /batata|fritas/i.test(i.nome) || (i.cat||'').toLowerCase() === 'porcoes')
    .map(i => i.id);
  return (itens || []).some(i => ids.includes(i.id));
}
function temBebidaNoPedido(itens) {
  const ids = (getCardapio() || [])
    .filter(i => (i.cat||i.categoria||'').toLowerCase().includes('bebida'))
    .map(i => i.id);
  return (itens || []).some(i => ids.includes(i.id));
}

// ---------- Init ----------
if (!GEMINI_KEY)      console.warn('⚠️  GEMINI_API_KEY não definida');
if (!FIREBASE_DB_URL) console.warn('⚠️  FIREBASE_DB_URL não definida');
if (!EVOLUTION_API_KEY) console.warn('⚠️  EVOLUTION_API_KEY não definida');

const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const firebaseApp = initializeApp({ databaseURL: FIREBASE_DB_URL });
const db = getDatabase(firebaseApp);

// ============================================
// LIVE CONFIG SUBSCRIBE - PDV escreve, bot lê
// ============================================
function subscribeBotConfig() {
  // Cardápio
  onValue(ref(db, 'bot_config/cardapio'), (snap) => {
    const v = snap.val();
    if (v && Array.isArray(v.itens)) {
      CARDAPIO_LIVE = v.itens;
      console.log(`✓ Cardápio sincronizado: ${v.itens.length} itens (${new Date(v.atualizadoEm||Date.now()).toLocaleString('pt-BR')})`);
    }
  }, (err) => console.error('subscribe cardapio:', err.message));

  // Entrega
  onValue(ref(db, 'bot_config/entrega'), (snap) => {
    const v = snap.val();
    if (v) {
      ENTREGA_CFG = {
        taxa: Number(v.taxa) || DEFAULT_DELIVERY_FEE,
        bairros: Array.isArray(v.bairros) ? v.bairros : [],
        minimo: Number(v.minimo) || 0,
      };
      console.log(`✓ Entrega sincronizada: taxa R$ ${ENTREGA_CFG.taxa.toFixed(2)} | ${ENTREGA_CFG.bairros.length} bairros | mínimo R$ ${ENTREGA_CFG.minimo.toFixed(2)}`);
    }
  }, (err) => console.error('subscribe entrega:', err.message));

  // Bot (URL da imagem do cardápio etc)
  onValue(ref(db, 'bot_config/bot'), (snap) => {
    const v = snap.val();
    if (v) {
      BOT_CFG = {
        menuImageUrl: v.menuImageUrl || '',
        chavePix: v.chavePix || '46.757.307/0001-32',
        tipoChavePix: v.tipoChavePix || 'CNPJ',
        nomeRecebedor: v.nomeRecebedor || 'Esquina Burger',
        horarioAtivo: v.horarioAtivo !== false,
        horaAbertura: v.horaAbertura || '18:00',
        horaFechamento: v.horaFechamento || '23:30',
        diasFuncionamento: Array.isArray(v.diasFuncionamento) ? v.diasFuncionamento : [0,1,2,3,4,5,6],
        msgFechado: v.msgFechado || 'Opa! Nosso atendimento já encerrou por hoje 😴. Abrimos todo dia das 18h às 23h30. Valeu pela preferência, te esperamos!',
        entregaAtiva: v.entregaAtiva !== false,
      };
      console.log(`✓ Bot config sincronizada: imagem ${BOT_CFG.menuImageUrl ? 'OK' : 'NÃO'} | Pix ${BOT_CFG.chavePix} | horário ${BOT_CFG.horaAbertura}-${BOT_CFG.horaFechamento} ativo=${BOT_CFG.horarioAtivo} | entrega=${BOT_CFG.entregaAtiva}`);
    }
  }, (err) => console.error('subscribe bot:', err.message));
}
subscribeBotConfig();

// ============================================
// NOTIFICAÇÕES DO PDV (saiu para entrega, etc)
// ============================================
function subscribeNotificacoes() {
  onValue(ref(db, 'bot_notificacoes'), (snap) => {
    const all = snap.val();
    if (!all || typeof all !== 'object') return;
    Object.entries(all).forEach(async ([key, notif]) => {
      if (!notif || notif.enviado) return;
      try {
        const phone = String(notif.telefone || '').replace(/\D/g, '');
        if (!phone || !notif.mensagem) return;
        console.log(`📨 Enviando notificação ${key} para ${phone}`);
        await enviarTexto(phone, notif.mensagem);
        await salvarMensagem(phone, { role: 'bot', texto: notif.mensagem, timestamp: Date.now() });
        // Marca como enviado e guarda pedidoId pra rastrear confirmação
        await update(ref(db, `bot_notificacoes/${key}`), { enviado: true, enviadoEm: Date.now() });
        // Se é notificação de saiu_entrega, salva na conversa do cliente pra saber que aguarda confirmação
        if (notif.tipo === 'saiu_entrega' && notif.pedidoId) {
          await update(ref(db, `bot_conversas/${phone}`), {
            aguardandoConfirmacao: true,
            pedidoIdConfirmacao: notif.pedidoId,
            confirmacaoDesde: Date.now()
          });
          console.log(`📨 ${phone} aguardando confirmação de entrega do pedido #${notif.pedidoId}`);
        }
      } catch (e) {
        console.error(`📨 Erro enviando notificação ${key}:`, e.message);
      }
    });
  }, (err) => console.error('subscribe notificacoes:', err.message));
}
subscribeNotificacoes();

const app = express();
app.use(express.json({ limit: '5mb' }));

const processedMessages = new Set();

// ============================================
// PROMPT
// ============================================
function buildSystemPrompt(estado) {
  const taxa = getDeliveryFee(estado?.bairro);
  const minimo = ENTREGA_CFG.minimo || 0;
  const minimoTxt = minimo > 0 ? `\n11.1. O pedido mínimo para entrega é R$ ${minimo.toFixed(2)}. Se o cliente pedir entrega abaixo desse valor, avise educadamente.` : '';
  const entregaOff = !BOT_CFG.entregaAtiva;
  const regraEntrega = entregaOff
    ? `⚠️ ATENÇÃO IMPORTANTÍSSIMA: HOJE NÃO ESTAMOS FAZENDO ENTREGA (o entregador está de folga). Só aceitamos RETIRADA no local. Se o cliente pedir entrega/delivery, explique com simpatia: "Opa, hoje o entregador tá de folga e infelizmente não tô fazendo entrega 😔. Mas se preferir retirar no local é super rápido, em poucos minutos já tá pronto pra você buscar!" NUNCA aceite pedido de entrega hoje. Se insistir, reforce que só retirada. O campo "tipo" no estado DEVE ser sempre "retirada" — jamais "entrega".`
    : '';
  return `Você é o atendente virtual do restaurante "${RESTAURANT_NAME}" no WhatsApp.
${regraEntrega}
Sua função é tirar pedidos rapidamente e de forma simpática.

REGRAS DE COMPORTAMENTO (siga sempre):
1. NÃO apresente o cardápio sem ser perguntado. A maioria dos clientes já sabe o que quer.
2. Se o cliente pedir o cardápio, o menu, "o que tem", os preços, etc. -> retorne action="enviar_cardapio".
3. Você só fala português, em tom informal e direto, com no máximo 2-3 frases por mensagem.
4. Pergunte uma coisa de cada vez. Não envie blocos longos.
5. Quando o cliente disser o que quer, identifique itens do cardápio (use os IDs abaixo).
6. Antes de fechar o pedido:
   - Se o cliente NÃO pediu nenhuma porção de batata, ofereça batata uma única vez.
   - Se o cliente NÃO pediu nenhuma bebida, ofereça bebida uma única vez.
7. ${entregaOff ? 'NÃO pergunte se é retirada ou entrega — hoje SÓ EXISTE RETIRADA. Informe isso diretamente ao cliente e siga o pedido como retirada. NÃO peça endereço.' : 'Pergunte se é RETIRADA ou ENTREGA.\n   - Retirada: NÃO peça endereço. Diga apenas que vai avisar quando estiver pronto.\n   - Entrega: peça o endereço completo (rua, número, bairro, ponto de referência se tiver).'}
8. Pergunte a forma de pagamento (pix, dinheiro, cartão). Se for dinheiro, pergunte se precisa de troco e para quanto.
9. Confirme o resumo do pedido (itens, total, tipo, pagamento) e só então retorne action="finalizar_pedido" com o JSON do pedido.
10. Se o cliente apenas conversar (oi, bom dia, etc), responda educado, sem encher de informação.
10.1. COMPROVANTE DE PIX / IMAGEM / FOTO: se o pedido JÁ foi finalizado e o cliente mandar uma imagem, um comprovante, uma mensagem do tipo "paguei", "pago", "comprovante", "enviei o pix", "ta aí", "segue" ou qualquer confirmação de pagamento, NÃO abra pedido novo, NÃO peça itens, NÃO mostre cardápio. Apenas agradeça, confirme o recebimento e avise que já vai sair (ex: "Recebemos seu comprovante! Já tá saindo 🛵"). Retorne action="responder" e NUNCA action="finalizar_pedido" nessa situação.
10.2. Se o estado atual já tem itens e tipo definidos, considere que há um pedido em andamento/finalizado — qualquer mensagem curta depois disso é sobre ESSE pedido, não um novo.
10.3. ALTERAÇÃO DE PEDIDO: Se o cliente já fez um pedido e depois quer adicionar mais itens, remover algo, trocar item ou fazer qualquer alteração, ajude normalmente. Monte o pedido COMPLETO atualizado (todos os itens anteriores + as mudanças) e retorne action="finalizar_pedido" com o pedido completo. O sistema vai atualizar o pedido existente automaticamente.
11. Taxa de entrega: R$ ${taxa.toFixed(2)} (some no total quando for entrega).${minimoTxt}
13. ITENS ESGOTADOS: se um item do cardápio estiver marcado com "❌ ESGOTADO", NÃO o ofereça. Se o cliente pedir esse item, avise com simpatia: "Poxa, esse item tá esgotado no momento 😔. Mas temos outras opções ótimas!" e sugira algo similar. NUNCA inclua item esgotado no pedido.
14. MONTE SEU LANCHE / EXTRAS: o cliente pode montar o proprio lanche escolhendo ingredientes avulsos da categoria extras (Pao R$4, Hamburguer R$8, Cheddar R$7, Mussarela R$7, Bacon R$8, Cebola R$4, Ovo R$3, Alface R$3, Tomate R$3, Maionese Caseira R$4, Molho da Casa R$4, Molho Barbecue R$4). Quando pedir "quero montar meu lanche", guie pelos ingredientes e calcule somando cada item. O cliente tambem pode adicionar extras a qualquer lanche (ex: "Junior com adicional de bacon" = preco do Junior + R$8 do bacon). SEMPRE use precos individuais dos extras, nunca agrupe.
14. MONTE SEU LANCHE / EXTRAS: o cliente pode montar o proprio lanche escolhendo ingredientes avulsos da categoria extras (Pao R$4, Hamburguer R$8, Cheddar R$7, Mussarela R$7, Bacon R$8, Cebola R$4, Ovo R$3, Alface R$3, Tomate R$3, Maionese Caseira R$4, Molho da Casa R$4, Molho Barbecue R$4). Quando pedir "quero montar meu lanche", guie pelos ingredientes e calcule somando cada item. O cliente tambem pode adicionar extras a qualquer lanche (ex: "Junior com adicional de bacon" = preco do Junior + R$8 do bacon). SEMPRE use precos individuais dos extras, nunca agrupe.
12. CHAVE PIX (use SEMPRE esta, NUNCA invente placeholder, NUNCA escreva "chavepixaleatoria" ou "CNPJ/CPF" genérico):
    - Tipo: ${BOT_CFG.tipoChavePix || 'CNPJ'}
    - Chave: ${BOT_CFG.chavePix || '46.757.307/0001-32'}
    - Recebedor: ${BOT_CFG.nomeRecebedor || RESTAURANT_NAME}
    Quando o cliente pedir o Pix, envie EXATAMENTE no formato:
    "Total: R$ X,XX\nChave Pix (${BOT_CFG.tipoChavePix || 'CNPJ'}): ${BOT_CFG.chavePix || '46.757.307/0001-32'}\nRecebedor: ${BOT_CFG.nomeRecebedor || RESTAURANT_NAME}\nMande o comprovante aqui quando pagar."

CARDÁPIO (id | nome | preço):
${cardapioParaPrompt()}

FORMATO DE RESPOSTA (OBRIGATÓRIO):
Responda SEMPRE com um único objeto JSON puro, sem markdown, sem texto fora do JSON, neste formato:

{
  "reply": "string - mensagem que será enviada ao cliente",
  "action": "responder" | "enviar_cardapio" | "finalizar_pedido",
  "estado": {
    "ofereci_batata": boolean,
    "ofereci_bebida": boolean,
    "tipo": "retirada" | "entrega" | null,
    "nome_cliente": "string | null",
    "endereco": "string | null",
    "bairro": "string | null",
    "referencia": "string | null",
    "pagamento": "pix" | "dinheiro" | "cartao" | null,
    "troco_para": number | null
  },
  "pedido": {
    "itens": [ { "id": number, "nome": "string", "preco": number, "qtd": number, "obs": "string" } ],
    "subtotal": number,
    "taxa_entrega": number,
    "total": number
  }
}

Se action != "finalizar_pedido", "pedido" pode ser objeto vazio {}. Sempre preencha "estado" com o que você sabe até agora.`;
}

// ============================================
// GEMINI - chamada principal
// ============================================
async function chamarGemini(historico, novaMsg, estadoAtual) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.6,
    },
  });

  const contents = [];
  contents.push({
    role: 'user',
    parts: [{ text: buildSystemPrompt(estadoAtual) }],
  });
  contents.push({
    role: 'model',
    parts: [{ text: '{"reply":"Ok, entendi as regras.","action":"responder","estado":{},"pedido":{}}' }],
  });

  for (const m of historico.slice(-HISTORY_LIMIT)) {
    contents.push({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.texto || m.content || '' }],
    });
  }

  contents.push({
    role: 'user',
    parts: [{
      text: `Estado atual da conversa (para você manter contexto): ${JSON.stringify(estadoAtual || {})}\n\nMensagem do cliente: ${novaMsg}`
    }],
  });

  const resp = await model.generateContent({ contents });
  const txt = resp.response.text();
  try {
    return JSON.parse(txt);
  } catch (e) {
    console.error('Falha ao parsear JSON do Gemini:', txt);
    return {
      reply: 'Opa, deixa eu ver isso aqui rapidinho 😅',
      action: 'responder',
      estado: estadoAtual || {},
      pedido: {},
    };
  }
}

// ============================================
// EVOLUTION API
// ============================================
function numeroLimpo(jid) {
  return String(jid).replace('@s.whatsapp.net', '').replace('@c.us', '');
}

async function enviarTexto(phone, message) {
  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`,
      { number: numeroLimpo(phone), text: message },
      { headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' } }
    );
    console.log(`✓ Texto enviado para ${phone}`);
  } catch (err) {
    console.error('Erro enviarTexto:', err.response?.data || err.message);
  }
}

async function enviarImagem(phone, url, legenda = '') {
  if (!url) {
    return enviarTexto(phone, 'Desculpa, o cardápio em imagem ainda não está configurado. Me diga o que você quer que eu te ajudo!');
  }
  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendMedia/${INSTANCE_NAME}`,
      {
        number: numeroLimpo(phone),
        mediatype: 'image',
        media: url,
        caption: legenda || 'Nosso cardápio 🍔',
      },
      { headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' } }
    );
    console.log(`✓ Imagem enviada para ${phone}`);
  } catch (err) {
    console.error('Erro enviarImagem:', err.response?.data || err.message);
    // fallback texto
    await enviarTexto(phone, 'Te mando o cardápio em texto então:\n\n' + cardapioParaPrompt());
  }
}

// ============================================
// FIREBASE - conversa
// ============================================
async function lerConversa(phone) {
  const snap = await get(ref(db, `bot_conversas/${phone}`));
  return snap.exists() ? snap.val() : null;
}

async function salvarMensagem(phone, msg, nomeWhats) {
  const conv = (await lerConversa(phone)) || {};
  const mensagens = Array.isArray(conv.mensagens) ? conv.mensagens : [];
  mensagens.push(msg);
  await update(ref(db, `bot_conversas/${phone}`), {
    nome: conv.nome || nomeWhats || phone,
    nome_whatsapp: nomeWhats || conv.nome_whatsapp || '',
    mensagens,
    ultimaMsg: msg.texto || '',
    atualizadoEm: Date.now(),
    status: conv.status || 'ativo',
  });
}

async function atualizarEstado(phone, estado) {
  await update(ref(db, `bot_conversas/${phone}`), { estado });
}

// ============================================
// FIREBASE - cliente
// ============================================
async function cadastrarCliente(phone, dados) {
  const cli = {
    id: Date.now(),
    nome: dados.nome || '',
    telefone: phone,
    endereco: dados.endereco || '',
    bairro: dados.bairro || '',
    obs: dados.referencia || '',
    aniversario: '',
    fiadoHabilitado: false,
    pedidos: 0,
    totalGasto: 0,
    ultimoPedido: null,
    cadastro: new Date().toISOString(),
  };
  await set(ref(db, `clientes/${phone}`), cli);
  return cli;
}

// ============================================
// FIREBASE - pedido (schema esperado por importarPedidoBot)
// ============================================
async function criarPedido(phone, estado, pedido) {
  const tipo = estado.tipo === 'entrega' ? 'delivery'
             : estado.tipo === 'retirada' ? 'retirada'
             : 'delivery';

  const taxa = tipo === 'delivery' ? getDeliveryFee(estado.bairro) : 0;
  const subtotal = pedido.subtotal || (pedido.itens || []).reduce((s,i)=>s+(i.preco*i.qtd),0);
  const total = subtotal + taxa;

  const obj = {
    origem: 'whatsapp-bot',
    criadoEm: Date.now(),
    cliente: {
      nome: estado.nome_cliente || '',
      telefone: phone,
      endereco: estado.endereco || '',
      bairro: estado.bairro || '',
      referencia: estado.referencia || '',
    },
    itens: (pedido.itens || []).map(i => ({
      id: i.id || 0,
      nome: i.nome,
      preco: Number(i.preco) || 0,
      qtd: Number(i.qtd) || 1,
      obs: i.obs || '',
      adicionais: i.adicionais || [],
    })),
    subtotal,
    taxaEntrega: taxa,
    total,
    tipo,
    pagamento: estado.pagamento || 'pix',
    troco: estado.troco_para ? String(estado.troco_para) : '',
  };

  const novo = push(ref(db, 'pedidos_abertos'));
  await set(novo, obj);
  return novo.key;
}

// ============================================
// PIPELINE PRINCIPAL
// ============================================
async function processarMensagem(phone, texto, nomeWhats) {
  const conv = (await lerConversa(phone)) || {};

  // Pausa humana - operador assumiu
  if (conv.status === 'pausado_humano') {
    console.log(`⏸  ${phone} pausado por humano - bot não responde`);
    // Ainda salva a msg do cliente pra aparecer no PDV
    await salvarMensagem(phone, {
      role: 'user',
      texto,
      timestamp: Date.now(),
    }, nomeWhats);
    return;
  }

  // Salva msg do cliente
  await salvarMensagem(phone, {
    role: 'user',
    texto,
    timestamp: Date.now(),
  }, nomeWhats);

  // 🕐 VERIFICAÇÃO DE HORÁRIO: se fora do expediente, responde fechado e não processa pedido
  if (!estaAberto()) {
    // Anti-spam: só avisa 1x por hora (pra não encher o saco se o cara mandar 10 msgs)
    const agoraTs = Date.now();
    const ultimoAviso = Number(conv.ultimoAvisoFechado || 0);
    if (agoraTs - ultimoAviso > 60 * 60 * 1000) {
      const msg = BOT_CFG.msgFechado || 'Estamos fechados no momento. Volte no horário de atendimento!';
      await enviarTexto(phone, msg);
      await salvarMensagem(phone, { role: 'bot', texto: msg, timestamp: agoraTs }, nomeWhats);
      await update(ref(db, `bot_conversas/${phone}`), { ultimoAvisoFechado: agoraTs });
      console.log(`🌙 ${phone} - fora do horário, avisou fechado`);
    } else {
      console.log(`🌙 ${phone} - fora do horário, já avisou há ${Math.round((agoraTs-ultimoAviso)/60000)}min, silêncio`);
    }
    return;
  }

  // 🛵 CONFIRMAÇÃO DE ENTREGA: se o cliente está aguardando confirmação e mandou algo que parece "chegou"
  if (conv.aguardandoConfirmacao && conv.pedidoIdConfirmacao) {
    const textoLower = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const confirmaPatterns = /cheg(ou|amo|uei)|receb(i|ido|emos)|ja (ta|esta|chegou)|ok.*cheg|confirm|ta aqui|tô aqui|to aqui|ja peguei|peguei|beleza|tudo certo|recebi sim|obrigad/i;
    if (confirmaPatterns.test(textoLower)) {
      console.log(`🛵 ${phone} confirmou entrega do pedido #${conv.pedidoIdConfirmacao}`);
      const msg = `Show! Que bom que chegou certinho! 😄🎉 Obrigado pela preferência e bom apetite! 🍔`;
      await enviarTexto(phone, msg);
      await salvarMensagem(phone, { role: 'bot', texto: msg, timestamp: Date.now() }, nomeWhats);
      // Notifica PDV via Firebase que entrega foi confirmada
      const confirmKey = 'confirm_' + Date.now() + '_' + conv.pedidoIdConfirmacao;
      await set(ref(db, `bot_confirmacoes/${confirmKey}`), {
        telefone: phone,
        pedidoId: conv.pedidoIdConfirmacao,
        confirmadoEm: Date.now(),
        textoCliente: texto
      });
      // Limpa flag de aguardando
      await update(ref(db, `bot_conversas/${phone}`), {
        aguardandoConfirmacao: false,
        pedidoIdConfirmacao: null,
        confirmacaoDesde: null
      });
      return;
    }
  }

  const historico = (conv.mensagens || []).concat([{ role: 'user', texto }]);
  const estado = conv.estado || {};

  // Chama IA
  const ia = await chamarGemini(historico, texto, estado);

  // Atualiza estado
  const novoEstado = { ...estado, ...(ia.estado || {}) };
  if (!novoEstado.nome_cliente && nomeWhats) novoEstado.nome_cliente = nomeWhats;
  await atualizarEstado(phone, novoEstado);

  // Envia resposta
  if (ia.reply) {
    await enviarTexto(phone, ia.reply);
    await salvarMensagem(phone, {
      role: 'bot',
      texto: ia.reply,
      timestamp: Date.now(),
    }, nomeWhats);
  }

  // Ações
  if (ia.action === 'enviar_cardapio') {
    await enviarImagem(phone, getMenuImageUrl(), 'Cardápio do ' + RESTAURANT_NAME);
  }

  if (ia.action === 'finalizar_pedido' && ia.pedido && (ia.pedido.itens || []).length) {
    // 🚚 TRAVA DE ENTREGA: se entrega desligada e Gemini tentou finalizar como entrega, força retirada
    if (!BOT_CFG.entregaAtiva && (novoEstado.tipo === 'entrega' || ia.pedido.tipo === 'entrega')) {
      console.log(`🚚 ${phone} - entrega desligada, forçando retirada`);
      novoEstado.tipo = 'retirada';
      ia.pedido.tipo = 'retirada';
      novoEstado.endereco = null;
      novoEstado.bairro = null;
      novoEstado.referencia = null;
    }
    // 📦 TRAVA DE ESTOQUE: remove itens esgotados do pedido
    const cardapio = getCardapio();
    if (ia.pedido.itens && ia.pedido.itens.length) {
      ia.pedido.itens = ia.pedido.itens.filter(item => {
        const cat = cardapio.find(c => c.id === item.id);
        if (cat && cat.esgotado) {
          console.log(`📦 ${phone} - removendo item esgotado do pedido: ${item.nome}`);
          return false;
        }
        return true;
      });
      if (!ia.pedido.itens.length) {
        console.log(`📦 ${phone} - pedido ficou vazio após remover esgotados`);
        const msg = 'Poxa, os itens que você pediu estão todos esgotados no momento 😔. Quer ver o cardápio pra escolher outra coisa?';
        await enviarTexto(phone, msg);
        await salvarMensagem(phone, { role: 'bot', texto: msg, timestamp: Date.now() }, nomeWhats);
        return;
      }
    }
    // TRAVA CONTRA DUPLICAÇÃO RÁPIDA (10s) - permite alterações depois
    const ultimoCriadoEm = Number(conv.ultimoPedidoCriadoEm || 0);
    if (ultimoCriadoEm && (Date.now() - ultimoCriadoEm) < 10000) {
      console.log(`⚠ Pedido duplicado ignorado para ${phone} (último há ${Math.round((Date.now()-ultimoCriadoEm)/1000)}s)`);
      return;
    }

    try {
      if (novoEstado.nome_cliente) {
        await cadastrarCliente(phone, {
          nome: novoEstado.nome_cliente,
          endereco: novoEstado.endereco,
          bairro: novoEstado.bairro,
          referencia: novoEstado.referencia,
        });
      }

      // Se já tem pedido recente (menos de 2h), ATUALIZA em vez de criar novo
      const JANELA_ALTERACAO_MS = 2 * 60 * 60 * 1000;
      const pedidoExistente = conv.ultimoPedidoKey;
      const isAlteracao = pedidoExistente && ultimoCriadoEm && (Date.now() - ultimoCriadoEm) < JANELA_ALTERACAO_MS;

      let key;
      if (isAlteracao) {
        const tipo = novoEstado.tipo === 'entrega' ? 'delivery' : novoEstado.tipo === 'retirada' ? 'retirada' : 'delivery';
        const taxa = tipo === 'delivery' ? getDeliveryFee(novoEstado.bairro) : 0;
        const subtotal = ia.pedido.subtotal || (ia.pedido.itens || []).reduce((s,i)=>s+(i.preco*i.qtd),0);
        const total = subtotal + taxa;
        await update(ref(db, `pedidos_abertos/${pedidoExistente}`), {
          itens: (ia.pedido.itens || []).map(i => ({
            id: i.id || 0, nome: i.nome, preco: Number(i.preco) || 0,
            qtd: Number(i.qtd) || 1, obs: i.obs || '', adicionais: i.adicionais || [],
          })),
          subtotal, taxaEntrega: taxa, total, tipo,
          pagamento: novoEstado.pagamento || 'pix',
          troco: novoEstado.troco_para ? String(novoEstado.troco_para) : '',
          cliente: {
            nome: novoEstado.nome_cliente || '', telefone: phone,
            endereco: novoEstado.endereco || '', bairro: novoEstado.bairro || '',
            referencia: novoEstado.referencia || '',
          },
          alteradoEm: Date.now(),
        });
        key = pedidoExistente;
        console.log(`✏️ Pedido atualizado: ${key}`);
      } else {
        key = await criarPedido(phone, novoEstado, ia.pedido);
        console.log(`✅ Pedido criado: ${key}`);
      }

      await update(ref(db, `bot_conversas/${phone}`), {
        ultimoPedidoKey: key,
        ultimoPedidoCriadoEm: Date.now(),
        status: 'pedido_criado',
      });
    } catch (e) {
      console.error('Erro ao criar/atualizar pedido:', e);
    }
  }
}

// ============================================
// POLLING DA EVOLUTION
// ============================================
async function pollMensagens() {
  try {
    const r = await axios.post(
      `${EVOLUTION_URL}/chat/findMessages/${INSTANCE_NAME}`,
      { where: {} },
      { headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' } }
    );
    const msgs = r.data?.messages?.records || r.data?.records || r.data || [];
    for (const m of msgs) {
      const id = m.key?.id || m.id;
      if (!id || processedMessages.has(id)) continue;
      // Ignora mensagens anteriores ao boot do bot (evita reprocessar histórico após redeploy)
      const msgTs = Number(m.messageTimestamp || m.key?.messageTimestamp || 0);
      if (msgTs && msgTs < BOT_STARTED_AT) { processedMessages.add(id); continue; }
      if (m.key?.fromMe) { processedMessages.add(id); continue; }
      const jid = m.key?.remoteJid;
      if (!jid || jid.includes('@g.us')) { processedMessages.add(id); continue; }
      const texto = m.message?.conversation
                 || m.message?.extendedTextMessage?.text
                 || '';
      if (!texto) { processedMessages.add(id); continue; }
      processedMessages.add(id);
      const nome = m.pushName || '';
      console.log(`📩 ${jid}: ${texto}`);
      try {
        await processarMensagem(numeroLimpo(jid), texto, nome);
      } catch (e) {
        console.error('Erro processarMensagem:', e);
      }
    }
  } catch (e) {
    if (e.response?.status !== 404) {
      console.error('Erro polling:', e.response?.data || e.message);
    }
  }
}

// ============================================
// WEBHOOK (preferencial se Evolution disparar)
// ============================================
app.post('/webhook', async (req, res) => {
  try {
    const ev = req.body;
    if (ev.event === 'messages.upsert' || ev.event === 'MESSAGES_UPSERT') {
      const data = ev.data || {};
      const list = Array.isArray(data) ? data : (data.messages || [data]);
      for (const m of list) {
        const id = m.key?.id;
        if (!id || processedMessages.has(id)) continue;
        const msgTs = Number(m.messageTimestamp || m.key?.messageTimestamp || 0);
        if (msgTs && msgTs < BOT_STARTED_AT) { processedMessages.add(id); continue; }
        if (m.key?.fromMe) { processedMessages.add(id); continue; }
        const jid = m.key?.remoteJid;
        if (!jid || jid.includes('@g.us')) { processedMessages.add(id); continue; }
        const texto = m.message?.conversation
                   || m.message?.extendedTextMessage?.text
                   || '';
        if (!texto) { processedMessages.add(id); continue; }
        processedMessages.add(id);
        await processarMensagem(numeroLimpo(jid), texto, m.pushName || '');
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro webhook:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// ENDPOINTS UTIL
// ============================================
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.post('/test', async (req, res) => {
  const { phone, texto, nome } = req.body || {};
  if (!phone || !texto) return res.status(400).json({ error: 'phone e texto obrigatórios' });
  await processarMensagem(phone, texto, nome || 'Teste');
  res.json({ ok: true });
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log(`✓ Bot ${RESTAURANT_NAME} rodando na porta ${PORT}`);
  console.log(`✓ Evolution: ${EVOLUTION_URL} / instância ${INSTANCE_NAME}`);
  console.log(`✓ Firebase: ${FIREBASE_DB_URL}`);
  console.log(`✓ Cardápio e taxa de entrega vêm do PDV via Firebase (bot_config/*) em tempo real`);
  if (POLL_INTERVAL_MS > 0) {
    setInterval(pollMensagens, POLL_INTERVAL_MS);
    pollMensagens();
    console.log(`✓ Polling ativo a cada ${POLL_INTERVAL_MS}ms`);
  }
});  
