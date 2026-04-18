// ── Geração de PIX QR Code dinâmico via Mercado Pago ──────────
// Docs: https://www.mercadopago.com.br/developers/pt/reference/payments/_payments/post
// Precisa setar MERCADO_PAGO_TOKEN (Access Token) no Railway.
// Enquanto não tiver o token, retorna stub pra PDV mostrar aviso.
import fetch from 'node-fetch';
import { config } from './config.js';

const MP_URL = 'https://api.mercadopago.com';

function pixConfigurado() {
  return !!(config.mercadoPago && config.mercadoPago.accessToken);
}

// Cria um pagamento PIX dinâmico com valor pre-preenchido
export async function gerarPixQr(pedido) {
  if (!pixConfigurado()) {
    return {
      sucesso: false,
      status: 'aguardando_token',
      msg: 'Access Token do Mercado Pago nao configurado. Configure MERCADO_PAGO_TOKEN no Railway.',
    };
  }

  const valor = Number(pedido.total || 0);
  if (valor <= 0) return { sucesso: false, erro: 'Valor invalido' };

  const tk = config.mercadoPago.accessToken;
  const nomeCliente = (pedido.cliente && pedido.cliente.nome) || 'Cliente';
  const telCliente = (pedido.cliente && pedido.cliente.telefone) || '';
  const codigo = pedido.codigoConfirmacao || pedido.id || Date.now();

  const body = {
    transaction_amount: Number(valor.toFixed(2)),
    description: `Esquina Burger · Pedido #${codigo}`,
    payment_method_id: 'pix',
    payer: {
      email: telCliente ? `${telCliente}@esquinaburger.com` : 'cliente@esquinaburger.com',
      first_name: nomeCliente.split(' ')[0] || 'Cliente',
    },
    external_reference: String(codigo),
    notification_url: config.mercadoPago.webhookUrl || undefined,
  };

  try {
    const res = await fetch(`${MP_URL}/v1/payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tk}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `pedido-${codigo}-${Date.now()}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('MP erro:', data);
      return { sucesso: false, erro: data.message || 'Erro ao gerar PIX', detalhes: data };
    }
    const txo = data.point_of_interaction?.transaction_data;
    return {
      sucesso: true,
      id: data.id,
      status: data.status,
      qr_code: txo?.qr_code, // string pra copia-cola
      qr_code_base64: txo?.qr_code_base64, // imagem base64 PNG
      ticket_url: txo?.ticket_url,
      expira_em: data.date_of_expiration,
      valor,
    };
  } catch (e) {
    console.error('Erro MP PIX:', e.message);
    return { sucesso: false, erro: e.message };
  }
}

// Consulta o status de um pagamento
export async function consultarPagamento(paymentId) {
  if (!pixConfigurado()) return { sucesso: false, status: 'aguardando_token' };
  const tk = config.mercadoPago.accessToken;
  try {
    const res = await fetch(`${MP_URL}/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${tk}` },
    });
    const data = await res.json().catch(() => ({}));
    return {
      sucesso: res.ok,
      id: data.id,
      status: data.status, // 'approved' | 'pending' | 'rejected' | ...
      status_detail: data.status_detail,
      valor: data.transaction_amount,
      pago_em: data.date_approved,
      external_reference: data.external_reference,
    };
  } catch (e) {
    return { sucesso: false, erro: e.message };
  }
}

export function pixStatus() {
  return {
    configurado: pixConfigurado(),
    temToken: !!(config.mercadoPago && config.mercadoPago.accessToken),
  };
}
