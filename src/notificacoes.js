// ── Notificações automáticas de pedido ────────────────────────
// Fica pollando pedidos_abertos em busca de mudanças de status que
// disparam mensagem pro cliente no WhatsApp. Por enquanto só notifica
// quando pedido de delivery sai pra entrega (status=saiu_entrega).
import { fb } from './firebase.js';
import { enviarMensagem } from './evolution.js';
import { adicionarMensagem } from './firebase.js';

const INTERVALO_MS = parseInt(process.env.NOTIF_INTERVALO_MS || '15000', 10);
const MAX_IDADE_MS = 6 * 60 * 60 * 1000; // ignora pedidos > 6h (ja saiu, sem ponto em notificar)

async function checarESaidas() {
  let pedidos;
  try {
    pedidos = await fb.get('pedidos_abertos');
  } catch (e) {
    // Firebase fora do ar, silencioso — tenta de novo no proximo tick
    return;
  }
  if (!pedidos || typeof pedidos !== 'object') return;

  const agora = Date.now();
  for (const [key, p] of Object.entries(pedidos)) {
    try {
      if (!p || typeof p !== 'object') continue;
      // Só pedidos do bot (tem cliente.telefone) — pedidos do PDV não precisam ser notificados
      if (p.origem !== 'whatsapp-bot') continue;
      if (p.notificado_saida === true) continue;
      if (p.status !== 'saiu_entrega') continue;
      if (p.tipo !== 'delivery') continue;
      if ((p.criadoEm || 0) < agora - MAX_IDADE_MS) continue;

      const tel = (p.cliente && p.cliente.telefone) ? String(p.cliente.telefone).replace(/\D+/g, '') : '';
      if (!tel) continue;

      const codigo = p.codigoConfirmacao || (key ? key.slice(-6) : '');
      const nome = (p.cliente && p.cliente.nome) ? p.cliente.nome.split(' ')[0] : '';
      const saudacao = nome ? `${nome}, ` : '';
      const msg = `${saudacao}seu pedido #${codigo} saiu pra entrega! 🛵 Já tá a caminho.`;

      try {
        await enviarMensagem(tel, msg);
        await adicionarMensagem(tel, { role: 'assistant', texto: msg, auto: 'saiu_entrega' });
        // Marca como notificado pra não mandar de novo
        await fb.patch(`pedidos_abertos/${key}`, { notificado_saida: true, notificado_saida_em: Date.now() });
        console.log(`🛵 Notificado saida: ${codigo} → ${tel}`);
      } catch (e) {
        console.error(`Erro notificando saida ${codigo}:`, e.message);
      }
    } catch (err) {
      console.warn('Erro no loop notificacoes:', err.message);
    }
  }
}

export function iniciarNotificacoes() {
  console.log(`📢 Notificacoes de saida ligadas (checando a cada ${INTERVALO_MS / 1000}s)`);
  // Delay inicial pra não bater com o boot
  setTimeout(checarESaidas, 5000);
  setInterval(checarESaidas, INTERVALO_MS);
}
