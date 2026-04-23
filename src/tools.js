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
import { enviarImagem, enviarMensagem } from './evolution.js';
import { gerarPixQr } from './pix.js';

// ── Declarações das tools (formato Gemini) ─────────────────────

// Formato Anthropic: cada tool é um objeto com input_schema (JSON Schema
// com tipos em minusculo). Diferente de Gemini que agrupa tudo em
// functionDeclarations e usa tipos em maiusculo.
export const TOOL_DECLARATIONS = [
  {
    name: 'ver_cardapio_categoria',
    description: 'Retorna os itens de uma categoria do cardápio.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: {
          type: 'string',
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
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'adicionar_item',
    description: 'Adiciona um item do cardápio ao pedido atual. Funciona com itens normais E com adicionais/extras (ex: bacon extra, ovo extra).',
    input_schema: {
      type: 'object',
      properties: {
        nome_ou_id: { type: 'string', description: 'Nome do item ou ID numérico' },
        quantidade: { type: 'number', description: 'Quantidade' },
        observacao: { type: 'string', description: 'Observação opcional (ex: "sem cebola")' },
      },
      required: ['nome_ou_id', 'quantidade'],
    },
  },
  {
    name: 'remover_item',
    description: 'Remove um item do pedido atual pelo nome (remove a ocorrência mais recente com esse nome). Se o cliente pediu pra remover "o segundo duplo blade", passe "duplo blade" como nome — NUNCA ordinais como "segundo" ou "primeiro".',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome do item a remover (parte do nome do item do cardápio, sem ordinais)' },
      },
      required: ['nome'],
    },
  },
  {
    name: 'ver_pedido_atual',
    description: 'Retorna o carrinho atual com itens, quantidades e total. Use SEMPRE antes de informar o valor do pedido para o cliente.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'salvar_cliente',
    description: 'Salva ou atualiza dados do cliente. Use assim que tiver o nome.',
    input_schema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        endereco: { type: 'string' },
        bairro: { type: 'string' },
        referencia: { type: 'string' },
      },
      required: ['nome'],
    },
  },
  {
    name: 'definir_tipo_pedido',
    description: 'Define: salao, delivery ou retirada. CHAME IMEDIATAMENTE quando o cliente indicar o tipo, mesmo que misturado com outras informações na mesma mensagem.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['salao', 'delivery', 'retirada'] },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'definir_pagamento',
    description: 'Define a forma de pagamento. CHAME IMEDIATAMENTE quando o cliente indicar o pagamento, mesmo que misturado com outras informações na mesma mensagem.',
    input_schema: {
      type: 'object',
      properties: {
        pagamento: { type: 'string', enum: ['pix', 'cartao', 'dinheiro'] },
        troco: { type: 'string', description: 'Se dinheiro, valor para troco' },
      },
      required: ['pagamento'],
    },
  },
  {
    name: 'finalizar_pedido',
    description: 'Finaliza o pedido e envia para a cozinha. Requer: itens no carrinho, nome, tipo, pagamento, e endereço (se delivery). Se houver pedido aberto recente (alteração), o sistema ATUALIZA em vez de criar duplicado.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancelar_pedido',
    description: 'Limpa o carrinho e dados parciais da sessão atual.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'carregar_pedido_recente',
    description: 'Carrega no carrinho o último pedido do cliente (se ainda não aceito pelo PDV) para permitir ADICIONAR/REMOVER/ALTERAR itens. Use SEMPRE que o cliente quiser alterar um pedido que acabou de fazer. Depois de alterar, chame finalizar_pedido que o sistema ATUALIZA o pedido existente em vez de criar um novo.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'agendar_pedido',
    description: 'Marca o pedido para sair/entregar em um horário específico (agendamento). Use quando a loja ainda não abriu e o cliente aceita esperar, ou quando quer pedir pra um horário futuro.',
    input_schema: {
      type: 'object',
      properties: {
        horario: { type: 'string', description: 'Horário desejado (HH:MM formato 24h, ex: "18:30" ou "20:00")' },
      },
      required: ['horario'],
    },
  },
  {
    name: 'transferir_humano',
    description: 'Transfere para atendente humano. Use em reclamações ou pedido explícito.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string' },
      },
      required: ['motivo'],
    },
  },
];

const PAGAMENTOS_VALIDOS = ['pix', 'cartao', 'dinheiro'];
const TIPOS_VALIDOS = ['salao', 'delivery', 'retirada'];
const CATEGORIAS_VALIDAS = ['combos', 'burgers', 'porcoes', 'bebidas', 'extras'];

// ── Helpers ────────────────────────────────────────────────────

function normalizarQuantidade(valor) {
  const n = typeof valor === 'number' ? valor : parseInt(valor, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(50, Math.floor(n));
}

// Detecta pattern "X extra" / "com X extra" em observacoes do cliente
// e converte em itens adicionais separados — garante que o preco do
// extra seja cobrado, independente de Claude ter chamado a tool
// adicionar_item pro adicional ou ter colocado so na obs.
// Retorna { limpa: obs-sem-os-extras, extras: [nome1, nome2, ...] }.
function detectarExtrasNaObs(obs) {
  if (!obs) return { limpa: obs, extras: [] };
  const extras = [];
  const palavrasExtra = ['bacon', 'cheddar', 'muçarela', 'mucarela', 'mussarela', 'queijo', 'ovo', 'cebola', 'salada', 'molho'];
  let limpa = obs;
  for (const pal of palavrasExtra) {
    const re = new RegExp('(?:com\\s+)?\\b' + pal + '\\b\\s+(?:extra|a\\s+mais|adicional)|\\bmais\\s+' + pal + '\\b', 'gi');
    if (re.test(limpa)) {
      extras.push(pal);
      limpa = limpa.replace(re, '');
    }
  }
  // Limpa artefatos: conjunçoes/pontuacao sobrando ("e", "ou", ", ,")
  limpa = limpa
    .replace(/\s+e\s+(?=\s*[,.;]|$)/gi, ' ')
    .replace(/\s+(?:e|ou)\s+/gi, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/[,;]\s*$/g, '')
    .replace(/^\s*[,;e]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(e|ou|,|;|\s)*$/i.test(limpa)) limpa = '';
  return { limpa: limpa, extras: extras };
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
        // Prioriza URLs do Firebase (bot_config/bot.menuImageUrl/menuImageUrl2).
        // Se não houver, cai no CARDAPIO_IMG_URL da env var.
        const cfgLoja = await getConfigLoja();
        const urls = [
          cfgLoja && cfgLoja.menu_image_url,
          cfgLoja && cfgLoja.menu_image_url2,
        ].filter(u => u && typeof u === 'string');
        const envio = urls.length ? urls : [config.cardapioImgUrl];
        for (let i = 0; i < envio.length; i++) {
          const cap = i === 0 ? 'Nosso cardápio! 🍔 Me diz o que você quer pedir' : '';
          await enviarImagem(telefone, envio[i], cap);
        }
        console.log(`🖼 ${envio.length} foto(s) do cardápio enviada(s) para ${telefone}`);
        return {
          sucesso: true,
          instrucao: 'Foto(s) enviada(s). NAO mande mais nenhuma mensagem de texto, o cliente ja viu. Retorne uma resposta vazia.',
        };
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
      let obs = args.observacao ? String(args.observacao).slice(0, 200) : '';

      // Detecta "X extra" na observacao e converte em item adicional separado.
      // Claude as vezes coloca "com bacon extra" na obs em vez de chamar
      // adicionar_item separado pro adicional. Aqui a gente garante que o
      // preco do extra seja cobrado corretamente, independente do que Claude
      // decidiu fazer.
      const extrasDetectados = detectarExtrasNaObs(obs);
      if (extrasDetectados.limpa !== obs) {
        obs = extrasDetectados.limpa;
      }

      carrinho.push({
        id: item.id, nome: item.nome, preco: item.preco, qtd,
        obs,
        subtotal: item.preco * qtd,
      });

      // Adiciona cada extra detectado como item separado (busca no cardapio
      // de adicionais). Se nao achar, ignora silenciosamente.
      const extrasAdicionados = [];
      for (const extra of extrasDetectados.extras) {
        const itemExtra = await buscarAdicional(extra);
        if (itemExtra) {
          carrinho.push({
            id: itemExtra.id, nome: itemExtra.nome, preco: itemExtra.preco, qtd: 1,
            obs: '',
            subtotal: itemExtra.preco,
          });
          extrasAdicionados.push(itemExtra.nome + ' (R$' + itemExtra.preco + ')');
          console.log('[tools] extra auto-adicionado: ' + itemExtra.nome + ' (detectado em obs)');
        }
      }

      return {
        sucesso: true,
        adicionado: `${qtd}x ${item.nome}`,
        preco_unitario: item.preco,
        subtotal_item: item.preco * qtd,
        extras_auto_adicionados: extrasAdicionados,
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
        return { sucesso: false, erro: 'Pagamento inválido. Aceitos: pix, cartao, dinheiro' };
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
        agendadoPara: dados.agendadoPara || null,
        agendado: !!dados.agendadoPara,
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

        // PIX: gera QR dinâmico e envia foto + código copia-cola no WhatsApp
        let pixInfo = null;
        if (dados.pagamento === 'pix' && !alterado) {
          try {
            const pixResp = await gerarPixQr({
              id: criado.key,
              codigoConfirmacao: criado.codigoConfirmacao,
              total,
              cliente: pedido.cliente,
            });
            if (pixResp.sucesso) {
              pixInfo = pixResp;
              // Envia a foto do QR
              if (pixResp.qr_code_base64) {
                try {
                  await enviarImagem(telefone, pixResp.qr_code_base64, `PIX · R$ ${total.toFixed(2).replace('.', ',')}`);
                } catch (imgErr) {
                  console.warn('Erro enviando QR img:', imgErr.message);
                }
              }
              // Envia o código PIX copia-cola (mensagem separada)
              if (pixResp.qr_code) {
                try {
                  await enviarMensagem(telefone, 'Se preferir, copia o código abaixo e cola no app do banco:');
                  await enviarMensagem(telefone, pixResp.qr_code);
                } catch (msgErr) {
                  console.warn('Erro enviando codigo PIX:', msgErr.message);
                }
              }
              // Guarda o paymentId no pedido pra consulta depois
              try {
                await fb.patch(`pedidos_abertos/${criado.key}`, {
                  pix_payment_id: pixResp.id,
                  pix_status: pixResp.status,
                });
              } catch {}
            } else if (pixResp.status !== 'aguardando_token') {
              console.warn('PIX gerar falhou:', pixResp.erro);
            }
          } catch (pixErr) {
            console.error('Erro gerar PIX:', pixErr.message);
          }
        }

        return {
          sucesso: true,
          pedido_id: criado.key,
          total,
          alterado,
          codigoConfirmacao: criado.codigoConfirmacao,
          rastreioLink,
          pix_enviado: !!pixInfo,
          instrucao_codigo: (() => {
            const totalFmt = `R$ ${total.toFixed(2).replace('.', ',')}`;
            if (alterado) {
              return `Pedido ATUALIZADO. Informe ao cliente que as mudanças foram registradas. Código: ${criado.codigoConfirmacao}. Novo total: ${totalFmt}.${rastreioLink ? ` Rastreio: ${rastreioLink}` : ''}`;
            }
            if (pixInfo) {
              return `Informe o cliente: codigo de confirmacao ${criado.codigoConfirmacao}, TOTAL ${totalFmt}, e diga que o QR Code PIX + o codigo copia-cola ja foram enviados separadamente. SEMPRE mencione o valor total na confirmacao. Lembre que o pagamento e confirmado automaticamente.${rastreioLink ? ` Rastreio: ${rastreioLink}` : ''}`;
            }
            return `Informe ao cliente o código de confirmação ${criado.codigoConfirmacao} E o TOTAL ${totalFmt}. SEMPRE mencione o valor total na confirmacao. O entregador vai pedir esse código na entrega.${rastreioLink ? ` Rastreio: ${rastreioLink}` : ''}`;
          })(),
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

    case 'agendar_pedido': {
      const h = String(args.horario || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(h)) {
        return { sucesso: false, erro: 'Horário inválido. Use formato HH:MM (ex: "18:30")' };
      }
      dados.agendadoPara = h;
      return { sucesso: true, agendadoPara: h, mensagem: 'Pedido agendado para ' + h };
    }

    case 'transferir_humano': {
      await salvarConversa(telefone, { status: 'pausado_humano', motivoTransferencia: args.motivo || '' });
      return { sucesso: true, mensagem: 'Conversa marcada para atendente humano' };
    }

    default:
      return { erro: 'Tool desconhecida: ' + nome };
  }
}
