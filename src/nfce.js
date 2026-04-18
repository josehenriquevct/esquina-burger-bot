// ── Emissão de NFC-e via FocusNFe ──────────────────────────────
// Gateway: https://focusnfe.com.br/doc/
// Quando o certificado A1 estiver configurado (CERTIFICADO_A1_BASE64 +
// CERTIFICADO_A1_SENHA + FOCUSNFE_TOKEN), a emissão passa a ser real.
// Até lá, o endpoint responde "aguardando certificado" mas já valida
// estrutura e dados do pedido pra não dar surpresa quando ligar.
import fetch from 'node-fetch';
import { config } from './config.js';
import { fb } from './firebase.js';

function configuradoParaEmitir() {
  const f = config.fiscal;
  return !!(f.focusNfeToken && f.certificadoBase64 && f.certificadoSenha && f.ie);
}

// Referencia unica da nota (usada pela FocusNFe pra idempotencia)
function gerarRef(pedidoKey) {
  return `nfce-${pedidoKey}-${Date.now()}`;
}

// Monta o payload FocusNFe a partir do pedido do Firebase
export function montarPayloadNfce(pedido, ref) {
  const f = config.fiscal;
  const itens = Array.isArray(pedido.itens) ? pedido.itens : [];

  const valorTotal = Number(pedido.total || 0).toFixed(2);
  const pagamento = String(pedido.pagamento || 'dinheiro').toLowerCase();

  // Formas de pagamento NFC-e (tabela oficial SEFAZ)
  const forma = {
    dinheiro: '01',
    cartao: '03', // Cartao de credito (nao diferencia debito/credito aqui)
    credito: '03',
    debito: '04',
    pix: '17',
    fiado: '99', // Outros
  }[pagamento] || '01';

  return {
    natureza_operacao: 'Venda de Mercadoria',
    data_emissao: new Date().toISOString().slice(0, 19),
    tipo_documento: '1',
    local_destino: '1',
    finalidade_emissao: '1',
    cnpj_emitente: f.cnpj,
    nome_emitente: f.razaoSocial,
    nome_fantasia_emitente: f.nomeFantasia,
    logradouro_emitente: f.endereco,
    numero_emitente: f.numero,
    bairro_emitente: f.bairro,
    municipio_emitente: f.municipio,
    uf_emitente: f.uf,
    cep_emitente: f.cep,
    inscricao_estadual_emitente: f.ie,
    regime_tributario_emitente: String(f.regimeTributario), // '1' = Simples Nacional

    // Consumidor (NFC-e sem CPF fica "consumidor nao identificado")
    nome_destinatario: pedido.cliente?.nome || null,
    cpf_destinatario: pedido.cliente?.cpf || null,

    items: itens.map((item, idx) => ({
      numero_item: idx + 1,
      codigo_produto: String(item.id || idx + 1),
      descricao: String(item.nome || 'Item').slice(0, 120),
      cfop: f.cfopDefault,
      unidade_comercial: 'UN',
      quantidade_comercial: Number(item.qtd || 1).toFixed(4),
      valor_unitario_comercial: Number(item.preco || 0).toFixed(2),
      valor_bruto: Number(item.subtotal || item.preco * item.qtd || 0).toFixed(2),
      unidade_tributavel: 'UN',
      quantidade_tributavel: Number(item.qtd || 1).toFixed(4),
      valor_unitario_tributavel: Number(item.preco || 0).toFixed(2),
      origem: '0', // 0 = Nacional
      icms_situacao_tributaria: f.csosnDefault, // Simples Nacional usa CSOSN
      ncm: String(item.ncm || f.ncmDefault),
      pis_situacao_tributaria: '49', // Outras Operacoes de Saida (Simples)
      cofins_situacao_tributaria: '49',
    })),

    formas_pagamento: [{
      forma_pagamento: forma,
      valor_pagamento: valorTotal,
    }],

    valor_produtos: valorTotal,
    valor_total: valorTotal,
    valor_desconto: Number(pedido.desconto || 0).toFixed(2),
    informacoes_adicionais_contribuinte: `Pedido #${pedido.codigoConfirmacao || ''}`.slice(0, 500),

    // Referencia interna
    _ref: ref,
  };
}

// Emite a NFC-e (chama FocusNFe quando configurado)
// Aceita um pedidoKey (lê do Firebase) OU o objeto pedido direto
export async function emitirNfce(pedidoKeyOrObj) {
  let pedido;
  let pedidoKey;
  if (typeof pedidoKeyOrObj === 'string') {
    pedidoKey = pedidoKeyOrObj;
    try {
      pedido = await fb.get(`pedidos_abertos/${pedidoKey}`);
    } catch (e) {
      return { sucesso: false, erro: 'Pedido nao encontrado: ' + e.message };
    }
    if (!pedido) return { sucesso: false, erro: 'Pedido nao existe' };
  } else if (pedidoKeyOrObj && typeof pedidoKeyOrObj === 'object') {
    pedido = pedidoKeyOrObj;
    pedidoKey = pedido.id || pedido.codigoConfirmacao || `manual_${Date.now()}`;
  } else {
    return { sucesso: false, erro: 'Parametro invalido' };
  }

  if (!Array.isArray(pedido.itens) || !pedido.itens.length) {
    return { sucesso: false, erro: 'Pedido sem itens' };
  }

  const ref = gerarRef(pedidoKey);
  const payload = montarPayloadNfce(pedido, ref);

  if (!configuradoParaEmitir()) {
    // Modo stub: registra a tentativa sem chamar FocusNFe
    const stubResp = {
      status: 'aguardando_certificado',
      ref,
      msg: 'Certificado A1 ou token FocusNFe nao configurado. Configure as env vars CERTIFICADO_A1_BASE64, CERTIFICADO_A1_SENHA, FOCUSNFE_TOKEN e EMPRESA_IE no Railway.',
      payload_simulado: payload,
    };
    try {
      await fb.put(`nfce_emitidas/${ref}`, {
        pedidoKey,
        ref,
        status: 'aguardando_certificado',
        payload,
        criadoEm: Date.now(),
      });
    } catch {}
    return { sucesso: false, ...stubResp };
  }

  // Emissão real via FocusNFe
  const url = `${config.fiscal.focusNfeUrl}/v2/nfce?ref=${encodeURIComponent(ref)}`;
  const auth = Buffer.from(`${config.fiscal.focusNfeToken}:`).toString('base64');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.status >= 200 && res.status < 300;
    // Grava resultado no Firebase pra auditoria + UI
    await fb.put(`nfce_emitidas/${ref}`, {
      pedidoKey,
      ref,
      status: data.status || (ok ? 'autorizado' : 'erro'),
      chave: data.chave_nfe || null,
      numero: data.numero || null,
      serie: data.serie || null,
      url_xml: data.caminho_xml_nota_fiscal || null,
      url_danfe: data.caminho_danfe || null,
      qrcode: data.qrcode_nota_fiscal || null,
      url_consulta: data.url_consulta_nf || null,
      erros: data.erros || null,
      criadoEm: Date.now(),
    });
    return { sucesso: ok, ref, ...data };
  } catch (e) {
    console.error('Erro emitindo NFC-e:', e.message);
    return { sucesso: false, erro: e.message, ref };
  }
}

// Consulta o status de uma NFC-e emitida
export async function consultarNfce(ref) {
  if (!configuradoParaEmitir()) {
    return { sucesso: false, status: 'aguardando_certificado' };
  }
  const url = `${config.fiscal.focusNfeUrl}/v2/nfce/${encodeURIComponent(ref)}`;
  const auth = Buffer.from(`${config.fiscal.focusNfeToken}:`).toString('base64');
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Basic ${auth}` } });
    const data = await res.json().catch(() => ({}));
    return { sucesso: res.ok, ...data };
  } catch (e) {
    return { sucesso: false, erro: e.message };
  }
}

// Cancela uma NFC-e (até 30 min após emissão)
export async function cancelarNfce(ref, justificativa) {
  if (!configuradoParaEmitir()) {
    return { sucesso: false, status: 'aguardando_certificado' };
  }
  const url = `${config.fiscal.focusNfeUrl}/v2/nfce/${encodeURIComponent(ref)}`;
  const auth = Buffer.from(`${config.fiscal.focusNfeToken}:`).toString('base64');
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ justificativa: (justificativa || 'Cancelamento solicitado pelo operador').slice(0, 255) }),
    });
    const data = await res.json().catch(() => ({}));
    return { sucesso: res.ok, ...data };
  } catch (e) {
    return { sucesso: false, erro: e.message };
  }
}

export function nfceStatus() {
  return {
    configurado: configuradoParaEmitir(),
    temToken: !!config.fiscal.focusNfeToken,
    temCertificado: !!config.fiscal.certificadoBase64,
    temSenha: !!config.fiscal.certificadoSenha,
    temIE: !!config.fiscal.ie,
    homologacao: !!config.fiscal.focusNfeHomolog,
    empresa: {
      cnpj: config.fiscal.cnpj,
      razaoSocial: config.fiscal.razaoSocial,
      uf: config.fiscal.uf,
      regimeTributario: config.fiscal.regimeTributario,
    },
  };
}
