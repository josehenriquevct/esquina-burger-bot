// ── Poller de pagamentos PIX ───────────────────────────────────
// Fica checando Mercado Pago de tempos em tempos pra ver se pedidos
// pendentes de PIX foram pagos. Quando aprovado, marca no Firebase
// (pedidos_abertos/{key}.pago=true, pix_status='approved') pra o PDV
// refletir visualmente e manda confirmação pelo WhatsApp pro cliente.
import { fb } from './firebase.js';
import { consultarPagamento, pixStatus } from './pix.js';
import { enviarMensagem } from './evolution.js';
import { adicionarMensagem } from './firebase.js';

const INTERVALO_MS = parseInt(process.env.PIX_POLL_INTERVALO_MS || '30000', 10);
const MAX_IDADE_MS = 2 * 60 * 60 * 1000; // só acompanha pedidos das últimas 2h

async function checarPagamentos() {
  if (!pixStatus().configurado) return; // sem token, não faz nada

  let pedidos;
  try {
    pedidos = await fb.get('pedidos_abertos');
  } catch (e) {
    return;
  }
  if (!pedidos || typeof pedidos !== 'object') return;

  const agora = Date.now();
  for (const [key, p] of Object.entries(pedidos)) {
    try {
      if (!p || typeof p !== 'object') continue;
      if (p.pago === true) continue; // já confirmado
      if (!p.pix_payment_id) continue; // não é pedido PIX ou não gerou QR
      if ((p.criadoEm || 0) < agora - MAX_IDADE_MS) continue;

      const r = await consultarPagamento(p.pix_payment_id);
      if (!r.sucesso) continue;

      // Atualiza status se mudou
      if (r.status && r.status !== p.pix_status) {
        await fb.patch(`pedidos_abertos/${key}`, {
          pix_status: r.status,
          pix_status_detail: r.status_detail || null,
        }).catch(() => {});
      }

      if (r.status === 'approved' && !p.pago) {
        // PAGO! marca no Firebase e notifica cliente
        await fb.patch(`pedidos_abertos/${key}`, {
          pago: true,
          pagoEm: Date.now(),
          pix_status: 'approved',
        }).catch(() => {});

        const tel = (p.cliente && p.cliente.telefone) ? String(p.cliente.telefone).replace(/\D+/g, '') : '';
        if (tel) {
          const nome = (p.cliente && p.cliente.nome) ? p.cliente.nome.split(' ')[0] : '';
          const saud = nome ? `${nome}, ` : '';
          const valor = Number(r.valor || p.total || 0).toFixed(2).replace('.', ',');
          const msg = `${saud}recebi seu PIX de R$ ${valor}! ✅ Pedido confirmado, já tá sendo preparado!`;
          try {
            await enviarMensagem(tel, msg);
            await adicionarMensagem(tel, { role: 'assistant', texto: msg, auto: 'pix_aprovado' });
          } catch (e) {
            console.warn('Erro notificando pagamento aprovado:', e.message);
          }
        }
        console.log(`💰 PIX aprovado — pedido ${p.codigoConfirmacao || key} (R$ ${r.valor})`);
      }
    } catch (err) {
      // silencioso
    }
  }
}

export function iniciarPixPoller() {
  if (!pixStatus().configurado) {
    console.log('💳 Mercado Pago nao configurado — poller PIX desligado');
    return;
  }
  console.log(`💳 Poller de pagamentos PIX ligado (checa a cada ${INTERVALO_MS / 1000}s)`);
  setTimeout(checarPagamentos, 8000);
  setInterval(checarPagamentos, INTERVALO_MS);
}
