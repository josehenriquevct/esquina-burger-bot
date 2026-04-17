// ── Definição e execução das tools do Gemini ───────────────────
import { config } from './config.js';
import { buscarItem, buscarAdicional, itensPorCategoria } from './cardapio.js';
import { totalCarrinho, removerDoCarrinho } from './state.js';
import {
  criarPedidoAberto,
  atualizarPedidoAberto,
  buscarPedidoAbertoDoCliente,
  upsertCliente,
  salvarConversa,
  getConfigLoja,
  fb,
} from './firebase.js';
import { enviarImagem } from './evolution.js';

// ── Declarações das tools (formato Gemini) ─────────────────────

export const TOOL_DECLARATIONS = [{
  functionDeclarations: [
    {
      name: 'ver_cardapio_categoria',
      description: 'Retorna os itens de uma categoria do cardápio.',
      parameters: {
        type: 'OBJECT',
        properties: {
          categoria: {
            type: 'STRING',
            enum: ['combos', 'burgers', 'porcoes', 'bebidas', 'extras'],
            description: 'Categoria do cardápio',
          },
        },
        required: ['categoria'],
      },
    },
    {
      name: 'enviar_foto_cardapio',
      description: 'Envia a foto/imagem do cardápio completo para o cliente pelo WhatsApp. Use SEMPRE que o cliente pedir para ver o cardápio ou menu.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'adicionar_item',
      description: 'Adiciona um item do cardápio ao pedido atual. Funciona com itens normais E com adicionais/extras (ex: bacon extra, ovo extra).',
      parameters: {
        type: 'OBJECT',
        properties: {
          nome_ou_id: { type: 'STRING', description: 'Nome do item ou ID numérico' },
          quantidade: { type: 'NUMBER', description: 'Quantidade' },
          observacao: { type: 'STRING', description: 'Observação opcional (ex: "sem cebola")' },
        },
        required: ['nome_ou_id', 'quantidade'],
      },
    },
    {
      name: 'remover_item',
      description: 'Remove um item do pedido atual pelo nome (remove a ocorrência mais recente com esse nome).',
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
      description: 'Retorna o carrinho atual com itens, quantidades e total.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'salvar_cliente',
      description: 'Salva ou atualiza dados do cliente. Use assim que tiver o nome.',
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
      description: 'Define: salao, delivery ou retirada.',
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
      description: 'Define a forma de pagamento.',
      parameters: {
        type: 'OBJECT',
        properties: {
          pagamento: { type: 'STRING', enum: ['pix', 'debito', 'credito', 'dinheiro'] },
          troco: { type: 'STRING', description: 'Se dinheiro, valor para troco' },
        },
        required: ['pagamento'],
      },
    },
    {
      name: 'finalizar_pedido',
      description: 'Finaliza o pedido e envia para a cozinha. Requer: itens no carrinho, nome, tipo, pagamento, e endereço (se delivery). Se houver pedido aberto recente (alteração), o sistema ATUALIZA em vez de criar duplicado.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'cancelar_pedido',
      description: 'Limpa o carrinho e dados parciais da sessão atual.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'carregar_pedido_recente',
      description: 'Carrega no carrinho o último pedido do cliente (se ainda não aceito pelo PDV) para permitir ADICIONAR/REMOVER/ALTERAR itens. Use SEMPRE que o cliente quiser alterar um pedido que acabou de fazer. Depois de alterar, chame finalizar_pedido que o sistema ATUALIZA o pedido existente em vez de criar um novo.',
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'transferir_humano',
      description: 'Transfere para atendente humano. Use em reclamações ou pedido explícito.',
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

const PAGAMENTOS_VALIDOS = ['pix', 'debito', 'credito', 'dinheiro'];
const TIPOS_VALIDOS = ['salao', 'delivery', 'retirada'];
const CATEGORIAS_VALIDAS = ['combos', 'burgers', 'porcoes', 'bebidas', 'extras'];

// ── Helpers ────────────────────────────────────────────────────

function normalizarQuantidade(valor) {
  const n = typeof valor === 'number' ? valor : parseInt(valor, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(50, Math.floor(n));
}

// Taxa de entrega: prioriza config do Firebase, senão env
async function taxaEntrega() {
  try {
    const cfg = await getConfigLoja();
    if (cfg && typeof cfg.taxa_entrega === 'number') return cfg.taxa_entrega;
  } catch {}
  const env = parseFloat(config.restaurante.taxaEntrega);
  return Number.isFinite(env) ? env : 5;
}

// ── Executor ───────────────────────────────────────────────────
// O estado vem do processarMensagem; mutações ficam no objeto e são
// persistidas no Firebase ao final do processamento da mensagem.

export async function executarTool(telefone, nome, args, estado) {
  if (!estado) {
    // Defesa: se chamado sem estado, não quebra mas registra
    console.error('executarTool chamado sem estado — ' + nome);
    return { sucesso: false, erro: 'Estado indisponível' };
  }
  const carrinho = estado.carrinho;
  const dados = estado.dados;

  switch (nome) {
    // ── Cardápio ─────────────────────────────────────────────
    case 'ver_cardapio_categoria': {
      if (!CATEGORIAS_VALIDAS.includes(args.categoria)) {
        return { sucesso: false, erro: 'Categoria inválida. Use: ' + CATEGORIAS_VALIDAS.join(', ') };
      }
      return await itensPorCategoria(args.categoria);
    }

    case 'enviar_foto_cardapio': {
      try {
        await enviarImagem(telefone, config.cardapioImgUrl, 'Nosso cardápio completo! 🍔🔥');
        console.log(`🖼 Foto do cardápio enviada para ${telefone}`);
        return { sucesso: true, mensagem: 'Foto do cardápio enviada com sucesso' };
      } catch (e) {
        console.error('Erro ao enviar foto do cardápio:', e.message);
        return { sucesso: false, erro: 'Não consegui enviar a foto, mas posso listar os itens em texto' };
      }
    }

    // ── Carrinho ─────────────────────────────────────────────
    case 'adicionar_item': {
      // Procura primeiro no cardápio principal, depois nos adicionais
      let item = await buscarItem(args.nome_ou_id);
      if (!item) item = await buscarAdicional(args.nome_ou_id);
      if (!item) return { sucesso: false, erro: `Item "${args.nome_ou_id}" não encontrado no cardápio.` };

      const qtd = normalizarQuantidade(args.quantidade);
      const obs = args.observacao ? String(args.observacao).slice(0, 200) : '';
      carrinho.push({
        id: item.id, nome: item.nome, preco: item.preco, qtd,
        obs,
        subtotal: item.preco * qtd,
      });
      return {
        sucesso: true,
        adicionado: `${qtd}x ${item.nome}`,
        preco_unitario: item.preco,
        subtotal_item: item.preco * qtd,
        carrinho_total: totalCarrinho(estado),
      };
    }

    case 'remover_item': {
      const removido = removerDoCarrinho(estado, args.nome);
      if (!removido) return { sucesso: false, erro: 'Item não encontrado no carrinho' };
      return { sucesso: true, removido: removido.nome };
    }

    case 'ver_pedido_atual': {
      if (!carrinho.length) return { vazio: true };
      const subtotal = totalCarrinho(estado);
      const taxa = dados.tipo === 'delivery' ? await taxaEntrega() : 0;
      return {
        itens: carrinho.map(i => ({ qtd: i.qtd, nome: i.nome, preco: i.preco, obs: i.obs, subtotal: i.subtotal })),
        subtotal,
        taxa_entrega: taxa,
        total: subtotal + taxa,
        tipo: dados.tipo || '',
        cliente: {
          nome: dados.nome || '',
          endereco: dados.endereco || '',
          bairro: dados.bairro || '',
          pagamento: dados.pagamento || '',
        },
        alteracao_pedido: !!estado.pedidoKeyExistente,
      };
    }

    // ── Cliente ──────────────────────────────────────────────
    case 'salvar_cliente': {
      if (args.nome) dados.nome = String(args.nome).slice(0, 80);
      if (args.endereco) dados.endereco = String(args.endereco).slice(0, 200);
      if (args.bairro) dados.bairro = String(args.bairro).slice(0, 80);
      if (args.referencia) dados.referencia = String(args.referencia).slice(0, 200);
      return { sucesso: true, cliente: { ...dados } };
    }

    // ── Pedido ───────────────────────────────────────────────
    case 'definir_tipo_pedido': {
      if (!TIPOS_VALIDOS.includes(args.tipo)) {
        return { sucesso: false, erro: 'Tipo inválido. Use: salao, delivery ou retirada' };
      }
      if (args.tipo === 'delivery') {
        try {
          const cfgLoja = await getConfigLoja();
          if (cfgLoja && cfgLoja.entrega_ativa === false) {
            return { sucesso: false, erro: 'Entrega DESATIVADA hoje. Ofereça retirada ou salão.' };
          }
        } catch (e) {
          console.warn('Erro ao checar config entrega:', e.message);
        }
      }
      dados.tipo = args.tipo;
      return { sucesso: true, tipo: args.tipo };
    }

    case 'definir_pagamento': {
      if (!PAGAMENTOS_VALIDOS.includes(args.pagamento)) {
        return { sucesso: false, erro: 'Pagamento inválido. Aceitos: pix, debito, credito, dinheiro' };
      }
      dados.pagamento = args.pagamento;
      if (args.troco) dados.troco = String(args.troco).slice(0, 40);
      return { sucesso: true, pagamento: args.pagamento, troco: dados.troco || '' };
    }

    case 'carregar_pedido_recente': {
      const p = await buscarPedidoAbertoDoCliente(telefone, 30);
      if (!p) return { sucesso: false, erro: 'Nenhum pedido recente encontrado pra alterar' };
      if (p.status && p.status !== 'aguardando') {
        return { sucesso: false, erro: 'Pedido já está sendo preparado, não dá pra alterar mais. Transfira pra atendente.' };
      }
      estado.carrinho = Array.isArray(p.itens) ? p.itens.map(i => ({
        id: i.id, nome: i.nome, preco: i.preco, qtd: i.qtd, obs: i.obs || '', subtotal: i.subtotal,
      })) : [];
      // Merge dados do cliente do pedido anterior nos dados atuais (sem sobrescrever)
      if (p.cliente) {
        if (p.cliente.nome && !dados.nome) dados.nome = p.cliente.nome;
        if (p.cliente.endereco && !dados.endereco) dados.endereco = p.cliente.endereco;
        if (p.cliente.bairro && !dados.bairro) dados.bairro = p.cliente.bairro;
        if (p.cliente.referencia && !dados.referencia) dados.referencia = p.cliente.referencia;
        if (p.cliente.localizacao && !dados.localizacao) dados.localizacao = p.cliente.localizacao;
      }
      if (p.tipo && !dados.tipo) dados.tipo = p.tipo;
      if (p.pagamento && !dados.pagamento) dados.pagamento = p.pagamento;
      if (p.troco && !dados.troco) dados.troco = p.troco;
      estado.pedidoKeyExistente = p.key;
      return {
        sucesso: true,
        itens_carregados: estado.carrinho.length,
        total_atual: p.total || 0,
        tipo: p.tipo || '',
      };
    }

    case 'finalizar_pedido': {
      // Validações
      if (!carrinho.length) return { sucesso: false, erro: 'Carrinho vazio' };
      // Fallback: usa pushName do WhatsApp se cliente não deu nome
      if (!dados.nome && dados.nome_whatsapp) dados.nome = dados.nome_whatsapp;
      if (!dados.nome) return { sucesso: false, erro: 'Falta nome do cliente' };
      if (!dados.tipo) return { sucesso: false, erro: 'Falta tipo (salão/delivery/retirada)' };
      // Se tem localização GPS, endereço textual não é obrigatório
      const temLocGps = dados.localizacao && dados.localizacao.lat && dados.localizacao.lng;
      if (dados.tipo === 'delivery' && !dados.endereco && !temLocGps) {
        return { sucesso: false, erro: 'Falta endereço para delivery (pode ser texto ou pin GPS)' };
      }
      if (!dados.pagamento) return { sucesso: false, erro: 'Falta forma de pagamento' };

      const subtotal = totalCarrinho(estado);
      const taxa = dados.tipo === 'delivery' ? await taxaEntrega() : 0;
      const total = subtotal + taxa;

      // Salva cliente no Firebase
      try {
        await upsertCliente({
          nome: dados.nome,
          telefone: dados.telefone || telefone,
          endereco: dados.endereco || '',
          bairro: dados.bairro || '',
          referencia: dados.referencia || '',
          localizacao: dados.localizacao || null,
        });
      } catch (e) {
        console.warn('upsertCliente falhou:', e.message);
      }

      const loc = dados.localizacao || null;
      const mapsLink = loc && loc.lat && loc.lng
        ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}`
        : '';

      const pedido = {
        itens: carrinho.map(i => ({
          id: i.id, nome: i.nome, preco: i.preco, qtd: i.qtd,
          obs: i.obs || '', subtotal: i.subtotal,
        })),
        subtotal, taxa, desconto: 0, total,
        tipo: dados.tipo,
        pagamento: dados.pagamento,
        troco: dados.troco || '',
        cliente: {
          nome: dados.nome,
          telefone: dados.telefone || telefone,
          endereco: dados.endereco || '',
          bairro: dados.bairro || '',
          referencia: dados.referencia || '',
          localizacao: loc,
          mapsLink,
        },
      };

      try {
        let criado;
        let alterado = false;
        if (estado.pedidoKeyExistente) {
          // ALTERAÇÃO: atualiza o pedido existente em vez de criar novo
          criado = await atualizarPedidoAberto(estado.pedidoKeyExistente, pedido);
          alterado = true;
        } else {
          criado = await criarPedidoAberto(pedido);
        }
        // Marca pra limpar o estado ao final do processamento da msg
        estado._limpar = true;

        // Link de rastreio para delivery
        const rastreioLink = dados.tipo === 'delivery' && config.publicUrl
          ? `https://${config.publicUrl}/rastreio/${criado.key}`
          : '';

        return {
          sucesso: true,
          pedido_id: criado.key,
          total,
          alterado,
          codigoConfirmacao: criado.codigoConfirmacao,
          rastreioLink,
          instrucao_codigo: alterado
            ? `Pedido ATUALIZADO. Informe ao cliente que as mudanças foram registradas. Código: ${criado.codigoConfirmacao}.${rastreioLink ? ` Rastreio: ${rastreioLink}` : ''}`
            : `Informe ao cliente o código de confirmação: ${criado.codigoConfirmacao}. O entregador vai pedir esse código na entrega.${rastreioLink ? ` Rastreio: ${rastreioLink}` : ''}`,
        };
      } catch (e) {
        return { sucesso: false, erro: 'Falha ao salvar pedido: ' + e.message };
      }
    }

    case 'cancelar_pedido': {
      // Limpa tudo — antes só zerava o carrinho, mantendo nome/endereco/pagamento
      // errados do cliente que cancelou porque a info tava errada.
      estado.carrinho = [];
      const manter = {
        telefone: dados.telefone,
        nome_whatsapp: dados.nome_whatsapp || '',
        _carregouFirebase: dados._carregouFirebase,
      };
      estado.dados = manter;
      estado.pedidoKeyExistente = null;
      return { sucesso: true };
    }

    case 'transferir_humano': {
      await salvarConversa(telefone, { status: 'pausado_humano', motivoTransferencia: args.motivo || '' });
      return { sucesso: true, mensagem: 'Conversa marcada para atendente humano' };
    }

    default:
      return { erro: 'Tool desconhecida: ' + nome };
  }
}
