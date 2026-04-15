// ── Módulo de segurança ────────────────────────────────────────
import crypto from 'crypto';
import { config } from './config.js';

// ── Rate Limiter por telefone ──────────────────────────────────
// Limita mensagens por minuto para evitar abuso/spam

const rateLimitMap = new Map();
const JANELA_MS = 60_000; // 1 minuto

export function verificarRateLimit(telefone) {
  const agora = Date.now();
  const limite = config.seguranca.rateLimitPorMinuto;

  if (!rateLimitMap.has(telefone)) {
    rateLimitMap.set(telefone, []);
  }

  const timestamps = rateLimitMap.get(telefone);

  // Remove timestamps antigos (fora da janela)
  while (timestamps.length && timestamps[0] < agora - JANELA_MS) {
    timestamps.shift();
  }

  if (timestamps.length >= limite) {
    return false; // bloqueado
  }

  timestamps.push(agora);
  return true; // permitido
}

// Limpa rate limit map periodicamente (evita memory leak)
setInterval(() => {
  const agora = Date.now();
  for (const [tel, ts] of rateLimitMap) {
    // Remove entries sem atividade nos últimos 5 minutos
    if (!ts.length || ts[ts.length - 1] < agora - 300_000) {
      rateLimitMap.delete(tel);
    }
  }
}, 120_000); // A cada 2 minutos

// ── Validação de webhook (HMAC) ────────────────────────────────
// Verifica se o webhook veio realmente da Evolution API

export function verificarWebhookToken(req) {
  if (!config.webhookToken) return true; // sem token = sem verificação

  const token = req.headers['x-webhook-token'] || req.query?.token;
  if (!token) return false;

  // Comparação timing-safe para evitar timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token, 'utf8'),
      Buffer.from(config.webhookToken, 'utf8')
    );
  } catch {
    return false;
  }
}

// ── Verificação de token da API ────────────────────────────────

export function verificarBotToken(req) {
  if (!config.botToken) return false; // SEM token = BLOQUEIA tudo

  // Só aceita via header (nunca query string)
  const token = req.headers['x-bot-token'];
  if (!token) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(token, 'utf8'),
      Buffer.from(config.botToken, 'utf8')
    );
  } catch {
    return false;
  }
}

// ── Sanitização de input ───────────────────────────────────────

export function sanitizarMensagem(texto) {
  if (!texto || typeof texto !== 'string') return '';

  let limpo = texto.trim();

  // Limita tamanho
  if (limpo.length > config.seguranca.maxTamanhoMsg) {
    limpo = limpo.slice(0, config.seguranca.maxTamanhoMsg);
  }

  // Remove caracteres de controle (exceto newlines)
  limpo = limpo.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return limpo;
}

// ── CORS configurável ──────────────────────────────────────────

export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowedOrigins = config.seguranca.corsOrigins;

  if (allowedOrigins.length > 0) {
    // CORS restrito: só permite origens configuradas
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  } else {
    // Fallback: só permite se vier sem origin (mesmo servidor) ou localhost
    if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Nunca expõe token via query string
  // Headers de segurança
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'");

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ── Middleware de log seguro ───────────────────────────────────
// Nunca loga tokens, API keys ou dados sensíveis

export function logRequest(req, res, next) {
  const { method, path } = req;
  // Não loga health checks pra não poluir
  if (path === '/' || path === '/status') return next();
  console.log(`📋 ${method} ${path} — ${req.ip || 'unknown'}`);
  next();
}
