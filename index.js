// ── Esquina Burger Bot — Servidor Principal ────────────────────
import express from 'express';
import { config, validarConfig } from './src/config.js';
import { corsMiddleware, logRequest } from './src/security.js';
import routes from './src/routes.js';

// Valida configuração na inicialização
const erros = validarConfig();
if (erros.length && config.nodeEnv === 'production') {
  console.error('❌ Não é possível iniciar com configurações faltando em produção.');
  process.exit(1);
}

const app = express();

// Limite de payload (evita ataques de payload gigante)
app.use(express.json({ limit: '1mb' }));

// Segurança: CORS configurável + headers de proteção
app.use(corsMiddleware);

// Log de requisições (sem dados sensíveis)
app.use(logRequest);

// Desativa header que expõe o framework
app.disable('x-powered-by');

// Trust proxy (Railway roda atrás de proxy)
app.set('trust proxy', 1);

// Monta todas as rotas
app.use('/', routes);

// Handler de erro global (nunca expõe detalhes internos)
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err.message);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Inicia servidor
app.listen(config.port, () => {
  console.log(`🍔 Esquina Burger Bot rodando na porta ${config.port}`);
  console.log(`   Ambiente: ${config.nodeEnv}`);
  console.log(`   Webhook:    POST /webhook`);
  console.log(`   Status:     GET  /status`);
  console.log(`   Conversas:  GET  /conversas (protegido)`);
  console.log(`   Pausar:     POST /pausar (protegido)`);
  console.log(`   Retomar:    POST /retomar (protegido)`);
  console.log(`   Send:       POST /send (protegido)`);
  console.log(`   Entrega:    POST /entrega (protegido)`);
  console.log(`   Backup:     GET  /backup (protegido)`);
});
// v2.0.1
