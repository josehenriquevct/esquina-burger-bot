// ── Configuração centralizada ──────────────────────────────────
import 'dotenv/config';

export const config = {
  // Servidor
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'production',
  botToken: process.env.BOT_TOKEN || '',
  webhookToken: process.env.WEBHOOK_TOKEN || '',

  // Segurança
  seguranca: {
    // Domínios permitidos no CORS (separados por vírgula)
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    // Rate limit: máximo de mensagens por minuto por telefone
    rateLimitPorMinuto: parseInt(process.env.RATE_LIMIT_POR_MINUTO || '20'),
    // Tamanho máximo da mensagem do cliente
    maxTamanhoMsg: parseInt(process.env.MAX_TAMANHO_MSG || '2000'),
  },

  // Restaurante
  restaurante: {
    nome: process.env.RESTAURANTE_NOME || 'Esquina Burger',
    unidade: process.env.RESTAURANTE_UNIDADE || 'Vicentinópolis',
    endereco: process.env.ENDERECO_LOJA || 'Rua Principal, 123 - Vicentinópolis',
    horario: process.env.HORARIO_FUNCIONAMENTO || 'Terça a Domingo, 18h às 23h',
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
    // Secret para autenticar chamadas REST ao Firebase (opcional mas recomendado)
    authSecret: process.env.FIREBASE_AUTH_SECRET || '',
  },

  // Cardápio (imagem)
  cardapioImgUrl: process.env.CARDAPIO_IMG_URL || 'https://raw.githubusercontent.com/josehenriquevct/esquina-burger-bot/main/cardapio.png',

  // URL pública do bot
  publicUrl: process.env.RAILWAY_PUBLIC_DOMAIN || process.env.BOT_URL || '',
};

// Validação na inicialização
export function validarConfig() {
  const erros = [];
  const avisos = [];

  // Obrigatórias
  if (!config.gemini.apiKey) erros.push('GEMINI_API_KEY não configurada');
  if (!config.firebase.dbUrl) erros.push('FIREBASE_DB_URL não configurada');
  if (!config.evolution.url) erros.push('EVOLUTION_URL não configurada');
  if (!config.evolution.apiKey) erros.push('EVOLUTION_API_KEY não configurada');
  if (!config.evolution.instance) erros.push('EVOLUTION_INSTANCE não configurada');

  // Segurança
  if (!config.botToken) avisos.push('BOT_TOKEN não definido — endpoints da API ficam SEM proteção!');
  if (!config.webhookToken) avisos.push('WEBHOOK_TOKEN não definido — webhook aceita qualquer requisição!');
  if (!config.firebase.authSecret) avisos.push('FIREBASE_AUTH_SECRET não definido — Firebase sem autenticação REST');
  if (!config.seguranca.corsOrigins.length) avisos.push('CORS_ORIGINS não definido — usando lista restrita padrão');

  if (erros.length) {
    console.error('❌ Configurações OBRIGATÓRIAS faltando:');
    erros.forEach(e => console.error(`  - ${e}`));
  }
  if (avisos.length) {
    console.warn('⚠ Avisos de segurança:');
    avisos.forEach(a => console.warn(`  - ${a}`));
  }

  return erros;
}
