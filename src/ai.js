// Integração com Google Gemini com function calling
// Cada cliente tem seu histórico em memória + Firebase

import { GoogleGenerativeAI } from '@google/generative-ai';
import { systemPrompt } from './prompts.js';
import { CARDAPIO, buscarItem } from './cardapio.js';
import { criarPedidoAberto, upsertCliente, salvarConversa, getConversa, fb } from './firebase.js';
import { enviarImagem } from './evolution.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// gemini-2.5-flash: rápido, barato, generoso no tier grátis, suporta tool use + áudio
const MODELO = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// URL da imagem do cardápio (hospedada no GitHub)
const CARDAPIO_IMG_URL = process.env.CARDAPIO_IMG_URL || 'https://raw.githubusercontent.com/josehenriquevct/esquina-burger-bot/main/cardapio.png';

// Status de aberto/fechado é lido do Firebase (config.loja_aberta)
// O PDV controla isso — José pode abrir/fechar direto pela interface

/**
 * Transcreve áudio usando Gemini (multimodal)
 * @param {string} base64Audio - áudio em base64
 * @param {string} mimetype - tipo do áudio (ex: audio/ogg, audio/mpeg)
 * @returns {Promise<string>} texto transcrito
 */
export async function transcreverAudio(base64Audio, mimetype = 'audio/ogg') {
  try {
    const model = genAI.getGenerativeModel({ model: MODELO });
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimetype,
          data: base64Audio,
        },
      },
      {
        text: 'Transcreva exatamente o que a pessoa está falando neste áudio. Retorne APENAS o texto falado, sem explicações, sem aspas, sem prefixos como "Transcrição:". Se não entender, retorne "[áudio não compreendido]".',
      },
    ]);

    const transcricao = result.response.text()?.trim();
    if (!transcricao) return '[áudio não compreendido]';

    console.log(`🎤 Transcrição: "${transcricao.slice(0, 80)}${transcricao.length > 80 ? '...' : ''}"`);
    return transcricao;
  } catch (e) {
    console.error('Erro ao transcrever áudio:', e.message);
    return '[erro ao transcrever áudio]';
  }
}

// ── Estado por cliente (em memória) ─────────────────────────────
const carrinhos = new Map();
const dadosClientes = new Map();

function getCarrinho(telefone) {
  if (!carrinhos.has(telefone)) carrinhos.set(telefone, []);
  return carrinhos.get(telefone);
}
function getDados(telefone) {
  if (!dadosClientes.has(telefone)) dadosClientes.set(telefone, { telefone });
  return dadosClientes.get(telefone);
}
function limparEstado(telefone) {
  carrinhos.delete(telefone);
  dadosClientes.delete(telefone);
}

// ── Definição das tools (formato Gemini) ──────────────────────────
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'ver_cardapio_categoria',
      description: 'Retorna os itens de uma categoria do cardápio. Use quando o cliente pedir para ver uma categoria (ex: "quero ver os combos", "quais burgers vocês têm").',
      parameters: {
        type: 'OBJECT',
        properties: {
          categoria: {
            type: 'STRING',
            enum: ['combos', 'burgers', 'porcoes', 'bebidas', 'extras'],
            description: 'Categoria do cardápio a listar',
          },
        },
        required: ['categoria'],
      },
    },
    {
      name: 'enviar_foto_cardapio',
      description: 'Envia a foto/imagem do cardápio completo para o cliente pelo WhatsApp. Use SEMPRE que o cliente pedir para ver o cardápio, o menu, ou perguntar "o que vocês têm". Envie a foto E depois liste as categorias em texto.',
      parameters: {
        type: 'OBJECT',
        properties: {},
      },
    },
    {
      name: 'adicionar_item',
      description: 'Adiciona um item do cardápio ao pedido atual. Se houver observação (ex: sem cebola), inclua no campo observacao.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nome_ou_id: { type: 'STRING', description: 'Nome do item ou ID numérico (ex: "Duplo Blade" ou "6")' },
          quantidade: { type: 'NUMBER', description: 'Quantidade' },
          observacao: { type: 'STRING', description: 'Observação opcional (ex: "sem cebola, bem passado")' },
        },
        required: ['nome_ou_id', 'quantidade'],
      },
    },
    {
      name: 'remover_item',
      description: 'Remove um item do pedido atual pelo nome.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nome: { type: 'STRING', description: 'Nome do item a remover' },
        },
        required: ['nome'],
      },
    },
    {
      name: 'ver_pedido_atual',
      description: 'Retorna o carrinho atual do cliente com itens, quantidades e total. Use para confirmar o pedido com o cliente antes de finalizar.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'salvar_cliente',
      description: 'Salva ou atualiza os dados do cliente. Use assim que tiver o nome. Para delivery, precisa também do endereço, bairro e referência.',
      parameters: {
        type: 'OBJECT',
        properties: {
          nome: { type: 'STRING' },
          endereco: { type: 'STRING' },
          bairro: { type: 'STRING' },
          referencia: { type: 'STRING' },
        },
        required: ['nome'],
      },
    },
    {
      name: 'definir_tipo_pedido',
      description: 'Define o tipo do pedido: salao (come no lugar), delivery (entrega) ou retirada (cliente busca).',
      parameters: {
        type: 'OBJECT',
        properties: {
          tipo: { type: 'STRING', enum: ['salao', 'delivery', 'retirada'] },
        },
        required: ['tipo'],
      },
    },
    {
      name: 'definir_pagamento',
      description: 'Define a forma de pagamento do pedido.',
      parameters: {
        type: 'OBJECT',
        properties: {
          pagamento: { type: 'STRING', enum: ['pix', 'debito', 'credito', 'dinheiro'] },
          troco: { type: 'STRING', description: 'Se dinheiro, valor para troco (ex: "R$ 100")' },
        },
        required: ['pagamento'],
      },
    },
    {
      name: 'finalizar_pedido',
      description: 'FINALIZA o pedido e envia para a cozinha. Só use quando: 1) houver pelo menos 1 item, 2) tiver nome do cliente, 3) tiver tipo definido, 4) se for delivery, tiver endereço completo, 5) tiver forma de pagamento, 6) cliente confirmou explicitamente.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'cancelar_pedido',
      description: 'Limpa o carrinho atual. Use se o cliente pedir para cancelar ou começar de novo.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'transferir_humano',
      description: 'Transfere a conversa para um atendente humano. Use em casos de reclamação séria, dúvida complexa ou se o cliente pedir explicitamente.',
      parameters: {
        type: 'OBJECT',
        properties: {
          motivo: { type: 'STRING' },
        },
        required: ['motivo'],
      },
    },
  ],
}];

// ── Executor das tools ──────────────────────────────────────────
async function executarTool(telefone, nome, args) {
  const carrinho = getCarrinho(telefone);
  const dados = getDados(telefone);

  switch (nome) {
    case 'ver_cardapio_categoria': {
      const itens = CARDAPIO.filter(i => i.cat === args.categoria);
      const lbls = { combos: 'COMBOS', burgers: 'HAMBÚRGUERES', porcoes: 'ACOMPANHAMENTOS', bebidas: 'BEBIDAS', extras: 'MONTE O SEU' };
      return {
        categoria: lbls[args.categoria] || args.categoria,
        itens: itens.map(i => ({ id: i.id, nome: i.nome, preco: i.preco, desc: i.desc })),
      };
    }

    case 'enviar_foto_cardapio': {
      try {
        await enviarImagem(telefone, CARDAPIO_IMG_URL, 'Nosso cardápio completo! 🍔🔥');
        console.log(`🖼 Foto do cardápio enviada para ${telefone}`);
        return { sucesso: true, mensagem: 'Foto do cardápio enviada com sucesso' };
      } catch (e) {
        console.error('Erro ao enviar foto do cardápio:', e.message);
        return { sucesso: false, erro: 'Não consegui enviar a foto, mas posso listar os itens em texto' };
      }
    }

    case 'adicionar_item': {
      const item = buscarItem(args.nome_ou_id);
      if (!item) return { sucesso: false, erro: `Item "${args.nome_ou_id}" não encontrado no cardápio. Peça para o cliente escolher outro.` };

      const qtd = Math.max(1, parseInt(args.quantidade || 1));
      carrinho.push({
        id: item.id, nome: item.nome, preco: item.preco,
        qtd, obs: args.observacao || '',
        subtotal: item.preco * qtd,
      });
      return {
        sucesso: true,
        adicionado: `${qtd}x ${item.nome}`,
        preco_unitario: item.preco,
        subtotal_item: item.preco * qtd,
        carrinho_total: carrinho.reduce((s, i) => s + i.subtotal, 0),
      };
    }

    case 'remover_item': {
      const idx = carrinho.findIndex(i => i.nome.toLowerCase().includes(String(args.nome).toLowerCase()));
      if (idx === -1) return { sucesso: false, erro: 'Item não encontrado no carrinho' };
      const removido = carrinho.splice(idx, 1)[0];
      return { sucesso: true, removido: removido.nome };
    }

    case 'ver_pedido_atual': {
      if (!carrinho.length) return { vazio: true };
      const subtotal = carrinho.reduce((s, i) => s + i.subtotal, 0);
      const taxa = dados.tipo === 'delivery' ? parseFloat(process.env.TAXA_ENTREGA || '5') : 0;
      return {
        itens: carrinho.map(i => ({ qtd: i.qtd, nome: i.nome, preco: i.preco, obs: i.obs, subtotal: i.subtotal })),
        subtotal, taxa_entrega: taxa, total: subtotal + taxa,
        tipo: dados.tipo || '',
        cliente: { nome: dados.nome || '', endereco: dados.endereco || '', bairro: dados.bairro || '', pagamento: dados.pagamento || '' },
      };
    }

    case 'salvar_cliente': {
      if (args.nome) dados.nome = args.nome;
      if (args.endereco) dados.endereco = args.endereco;
      if (args.bairro) dados.bairro = args.bairro;
      if (args.referencia) dados.referencia = args.referencia;
      return { sucesso: true, cliente: { ...dados } };
    }

    case 'definir_tipo_pedido': {
      // Bloqueia delivery se entrega estiver desativada no Firebase
      if (args.tipo === 'delivery') {
        try {
          const config = (await fb.get('config')) || {};
          if (config.entrega_ativa === false) {
            return { sucesso: false, erro: 'Entrega DESATIVADA hoje. Ofereça apenas retirada ou salão ao cliente.' };
          }
        } catch (e) {
          console.warn('Erro ao checar config entrega:', e.message);
        }
      }
      dados.tipo = args.tipo;
      return { sucesso: true, tipo: args.tipo };
    }

    case 'definir_pagamento':
      dados.pagamento = args.pagamento;
      if (args.troco) dados.troco = args.troco;
      return { sucesso: true, pagamento: args.pagamento, troco: dados.troco || '' };

    case 'finalizar_pedido': {
      if (!carrinho.length) return { sucesso: false, erro: 'Carrinho vazio' };
      if (!dados.nome) return { sucesso: false, erro: 'Falta nome do cliente' };
      if (!dados.tipo) return { sucesso: false, erro: 'Falta tipo (salão/delivery/retirada)' };
      if (dados.tipo === 'delivery' && !dados.endereco) return { sucesso: false, erro: 'Falta endereço para delivery' };
      if (!dados.pagamento) return { sucesso: false, erro: 'Falta forma de pagamento' };

      const subtotal = carrinho.reduce((s, i) => s + i.subtotal, 0);
      const taxa = dados.tipo === 'delivery' ? parseFloat(process.env.TAXA_ENTREGA || '5') : 0;
      const total = subtotal + taxa;

      try {
        await upsertCliente({
          nome: dados.nome, telefone: dados.telefone,
          endereco: dados.endereco || '', bairro: dados.bairro || '', referencia: dados.referencia || '',
        });
      } catch (e) { console.warn('upsertCliente falhou:', e.message); }

      // Gera link do Google Maps se tiver localização
      const loc = dados.localizacao || null;
      const mapsLink = loc?.lat && loc?.lng ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : '';

      const pedido = {
        itens: carrinho.map(i => ({
          id: i.id, nome: i.nome, preco: i.preco, qtd: i.qtd, obs: i.obs || '', subtotal: i.subtotal,
        })),
        subtotal, taxa, desconto: 0, total, tipo: dados.tipo,
        pagamento: dados.pagamento, troco: dados.troco || '',
        cliente: {
          nome: dados.nome, telefone: dados.telefone,
          endereco: dados.endereco || '', bairro: dados.bairro || '', referencia: dados.referencia || '',
          localizacao: loc || null,
          mapsLink: mapsLink,
          logado: false, nivel: 'novo',
        },
      };

      try {
        const criado = await criarPedidoAberto(pedido);
        limparEstado(telefone);
        return { sucesso: true, pedido_id: criado.key, total };
      } catch (e) {
        return { sucesso: false, erro: 'Falha ao salvar pedido: ' + e.message };
      }
    }

    case 'cancelar_pedido':
      carrinhos.set(telefone, []);
      return { sucesso: true };

    case 'transferir_humano': {
      await salvarConversa(telefone, { status: 'pausado_humano', motivoTransferencia: args.motivo });
      return { sucesso: true, mensagem: 'Conversa marcada para atendente humano' };
    }

    default:
      return { erro: 'Tool desconhecida: ' + nome };
  }
}

// ── Processa uma mensagem do cliente ──────────────────────────────
// Retorna a resposta de texto a enviar para o WhatsApp
export async function processarMensagem(telefone, texto, pushName) {
  // Se já está pausada para humano, não responde
  const conversaAtual = await getConversa(telefone).catch(() => null);
  if (conversaAtual?.status === 'pausado_humano') {
    return null;
  }

  const dados = getDados(telefone);
  if (pushName && !dados.nome_whatsapp) dados.nome_whatsapp = pushName;

  // Carrega dados do cliente do Firebase (se já comprou antes, não pede de novo)
  if (!dados._carregouFirebase) {
    try {
      const clienteSalvo = await fb.get(`clientes_bot/${String(telefone).replace(/\\D+/g, '')}`);
      if (clienteSalvo) {
        if (clienteSalvo.nome && !dados.nome) dados.nome = clienteSalvo.nome;
        if (clienteSalvo.endereco && !dados.endereco) dados.endereco = clienteSalvo.endereco;
        if (clienteSalvo.bairro && !dados.bairro) dados.bairro = clienteSalvo.bairro;
        if (clienteSalvo.referencia && !dados.referencia) dados.referencia = clienteSalvo.referencia;
        if (clienteSalvo.localizacao && !dados.localizacao) dados.localizacao = clienteSalvo.localizacao;
        dados._carregouFirebase = true;
        if (clienteSalvo.nome) {
          console.log(`👤 Cliente reconhecido: ${clienteSalvo.nome} (${telefone})`);
        }
      }
    } catch (e) {
      console.warn('Erro ao buscar cliente salvo:', e.message);
    }
    dados._carregouFirebase = true;
  }

  // Busca config da loja no Firebase (entrega_ativa, etc)
  let configLoja = {};
  try { configLoja = (await fb.get('config')) || {}; } catch (e) {
    console.warn('Não conseguiu ler config da loja:', e.message);
  }

  // Verifica se a loja está aberta (controlado pelo PDV no Firebase)
  // config.loja_aberta = true/false — se não existir, assume fechado por segurança
  configLoja.aberto = configLoja.loja_aberta === true;

  // Passa dados do cliente pro prompt (pra IA saber que já tem info salva)
  const loc = dados.localizacao || null;
  configLoja.cliente_salvo = {
    nome: dados.nome || '',
    endereco: dados.endereco || '',
    bairro: dados.bairro || '',
    referencia: dados.referencia || '',
    temLocalizacao: !!(loc?.lat && loc?.lng),
  };

  // Monta histórico a partir do Firebase (últimas 20 msgs, formato Gemini)
  const historicoRaw = (conversaAtual?.mensagens || []).slice(-20);
  const history = historicoRaw
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.texto || m.content || '' }],
    }))
    .filter(m => m.parts[0].text);

  const model = genAI.getGenerativeModel({
    model: MODELO,
    tools: TOOLS,
    systemInstruction: systemPrompt(configLoja),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    },
  });

  const chat = model.startChat({ history });

  let result;
  try {
    result = await chat.sendMessage(texto);
  } catch (e) {
    console.error('Gemini sendMessage erro:', e.message);
    return 'Desculpe, tive um problema aqui. Pode repetir?';
  }

  // Loop de tool use (até 8 iterações)
  let iteracoes = 0;
  while (iteracoes < 8) {
    iteracoes++;
    const response = result.response;
    const calls = (typeof response.functionCalls === 'function') ? response.functionCalls() : null;

    if (!calls || calls.length === 0) {
      // Não há mais chamadas de função — retorna texto final
      try {
        const txt = response.text();
        return (txt && txt.trim()) || 'Desculpe, não consegui entender. Pode repetir?';
      } catch {
        return 'Desculpe, não consegui entender. Pode repetir?';
      }
    }

    // Executa todas as functions pedidas e devolve as respostas
    const functionResponses = [];
    for (const call of calls) {
      try {
        const r = await executarTool(telefone, call.name, call.args || {});
        functionResponses.push({ functionResponse: { name: call.name, response: r } });
      } catch (e) {
        functionResponses.push({ functionResponse: { name: call.name, response: { erro: e.message } } });
      }
    }

    try {
      result = await chat.sendMessage(functionResponses);
    } catch (e) {
      console.error('Gemini follow-up erro:', e.message);
      return 'Desculpe, tive um problema aqui. Pode tentar de novo?';
    }
  }

  // Se saiu do loop por limite, tenta extrair texto do último result
  try {
    return result.response.text() || 'Desculpe, tive um problema. Pode repetir?';
  } catch {
    return 'Desculpe, tive um problema. Pode repetir?';
  }
}
