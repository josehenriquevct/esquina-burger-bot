// ── Configuracao centralizada ──────────────────────────────────
import 'dotenv/config';

export const config = {
  // Servidor
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'production',
  botToken: process.env.BOT_TOKEN || '',
  webhookToken: process.env.WEBHOOK_TOKEN || '',

  // Seguranca
  seguranca: {
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    rateLimitPorMinuto: parseInt(process.env.RATE_LIMIT_POR_MINUTO || '20'),
    maxTamanhoMsg: parseInt(process.env.MAX_TAMANHO_MSG || '2000'),
  },

  // Restaurante
  restaurante: {
    nome: process.env.RESTAURANTE_NOME || 'Esquina Burger',
    unidade: process.env.RESTAURANTE_UNIDADE || 'Vicentinopolis',
    endereco: process.env.ENDERECO_LOJA || 'Rua Principal, 123 - Vicentinopolis',
    horario: process.env.HORARIO_FUNCIONAMENTO || 'Terca a Domingo, 18h as 23h',
    taxaEntrega: parseFloat(process.env.TAXA_ENTREGA || '5.00'),
  },

  // Gemini
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },

  // Evolution API (WhatsApp)
  evolution: {
    url: (process.env.EVOLUTION_URL || '').replace(/\/$/, ''),
    apiKey: process.env.EVOLUTION_API_KEY || '',
    instance: process.env.EVOLUTION_INSTANCE || '',
  },

  // Firebase
  firebase: {
    dbUrl: process.env.FIREBASE_DB_URL || '',
    authSecret: process.env.FIREBASE_AUTH_SECRET || '',
  },

  // Cardapio (imagem)
  cardapioImgUrl: process.env.CARDAPIO_IMG_URL || 'https://raw.githubusercontent.com/josehenriquevct/esquina-burger-bot/main/cardapio.png',

  // URL publica do bot
  publicUrl: process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BOT_URL || '',

  // Telefone interno (funcionario que manda pedidos por audio)
  telefoneInterno: process.env.TELEFONE_INTERNO || '5564999584599',
};

// Validacao na inicializacao
export function validarConfig() {
  const erros = [];
  const avisos = [];

  if (!config.gemini.apiKey) erros.push('GEMINI_API_KEY nao configurada');
  if (!config.firebase.dbUrl) erros.push('FIREBASE_DB_URL nao configurada');
  if (!config.evolution.url) erros.push('EVOLUTION_URL nao configurada');
  if (!config.evolution.apiKey) erros.push('EVOLUTION_API_KEY nao configurada');
  if (!config.evolution.instance) erros.push('EVOLUTION_INSTANCE nao configurada');

  if (!config.botToken) avisos.push('BOT_TOKEN nao definido - endpoints da API ficam SEM protecao');
  if (!config.webhookToken) avisos.push('WEBHOOK_TOKEN nao definido - webhook aceita qualquer requisicao');
  if (!config.firebase.authSecret) avisos.push('FIREBASE_AUTH_SECRET nao definido - Firebase sem autenticacao REST');
  if (!config.seguranca.corsOrigins.length) avisos.push('CORS_ORIGINS nao definido - usando lista restrita padrao');

  if (erros.length) {
    console.error('Configuracoes OBRIGATORIAS faltando:');
    erros.forEach(function(e) { console.error('  - ' + e); });
  }
  if (avisos.length) {
    console.warn('Avisos de seguranca:');
    avisos.forEach(function(a) { console.warn('  - ' + a); });
  }

  return erros;
}
