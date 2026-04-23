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
  // gemini-2.0-flash tem free tier de ~1500 req/dia; 2.5-flash tem apenas 20/dia
  // sem billing — por isso default 2.0. O fallback cobre quando o modelo
  // principal retorna 403/429 em runtime.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    modeloFallback: process.env.GEMINI_MODEL_FALLBACK || 'gemini-2.0-flash',
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

  // ── PIX via Mercado Pago ──
  mercadoPago: {
    accessToken: process.env.MERCADO_PAGO_TOKEN || '',
    webhookUrl: process.env.MERCADO_PAGO_WEBHOOK || '', // opcional: onde MP notifica pagamento
  },

  // ── Fiscal / NFC-e ──
  fiscal: {
    focusNfeUrl: process.env.FOCUSNFE_URL || 'https://api.focusnfe.com.br',
    focusNfeToken: process.env.FOCUSNFE_TOKEN || '',
    focusNfeHomolog: process.env.FOCUSNFE_HOMOLOG === 'true', // true = homologacao
    certificadoBase64: process.env.CERTIFICADO_A1_BASE64 || '', // .pfx em base64
    certificadoSenha: process.env.CERTIFICADO_A1_SENHA || '',
    cnpj: process.env.EMPRESA_CNPJ || '46757307000132',
    razaoSocial: process.env.EMPRESA_RAZAO_SOCIAL || 'ESQUINA HAMBURGUERIA LTDA',
    nomeFantasia: process.env.EMPRESA_NOME_FANTASIA || 'Esquina Burger',
    ie: process.env.EMPRESA_IE || '', // preencher quando souber
    cnae: process.env.EMPRESA_CNAE || '5611203',
    regimeTributario: parseInt(process.env.EMPRESA_REGIME || '1'), // 1=Simples Nacional
    cep: process.env.EMPRESA_CEP || '75555000',
    endereco: process.env.EMPRESA_ENDERECO || 'ENGENHEIRO CLAUDIO NEVES CARDOSO',
    numero: process.env.EMPRESA_NUMERO || '155',
    bairro: process.env.EMPRESA_BAIRRO || 'CENTRO',
    municipio: process.env.EMPRESA_MUNICIPIO || 'VICENTINOPOLIS',
    codMunicipio: process.env.EMPRESA_COD_MUNICIPIO || '5221502', // IBGE de Vicentinopolis-GO
    uf: process.env.EMPRESA_UF || 'GO',
    telefone: process.env.EMPRESA_TELEFONE || '6499596335',
    // Defaults fiscais pro Simples Nacional (CNAE lanchonete)
    cfopDefault: process.env.CFOP_DEFAULT || '5102',
    csosnDefault: process.env.CSOSN_DEFAULT || '102', // 102 = Tributada pelo Simples sem permissao de credito
    ncmDefault: process.env.NCM_DEFAULT || '21069090', // Preparacoes alimenticias diversas
    cestDefault: process.env.CEST_DEFAULT || '',
  },
};

// Validacao na inicializacao
export function validarConfig() {
  const erros = [];
  const avisos = [];

  if (!config.gemini.apiKey) erros.push('GEMINI_API_KEY nao configurada');
  if (config.gemini.model === 'gemini-2.5-flash') {
    avisos.push('GEMINI_MODEL=gemini-2.5-flash tem cota free tier de so 20 req/dia. Considere gemini-2.0-flash (1500/dia) ou habilite billing.');
  }
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
