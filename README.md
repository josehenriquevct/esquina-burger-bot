# Esquina Burger — Bot de WhatsApp com IA

Atendente virtual do Esquina Burger que atende pelo WhatsApp, monta pedidos, cadastra clientes e envia direto para o PDV (impressão automática nas 2 vias).

## Como funciona

```
Cliente WhatsApp → Evolution API → Este bot (Gemini) → Firebase → PDV → Impressora
```

1. Cliente manda mensagem no WhatsApp da loja
2. Evolution API recebe e dispara webhook para este bot
3. Bot envia para o Google Gemini que entende o pedido usando function calling
4. Gemini monta o pedido passo a passo (cardápio, cliente, endereço, pagamento)
5. Quando finaliza, escreve em `pedidos_abertos/` do Firebase com `autoAceito: true`
6. PDV (aba master) detecta, imprime as 2 vias automaticamente
7. Cliente recebe confirmação e previsão de entrega

## Stack

- Node.js 20+
- Express
- Google Gemini 2.0 Flash (function calling)
- Firebase Realtime Database (REST)
- Evolution API (WhatsApp não-oficial)

## Passo-a-passo de deploy

### 1. Criar projeto no Railway

1. Acesse https://railway.app e crie uma conta (pode usar login do GitHub)
2. Crie um **novo projeto** → "Deploy from GitHub repo" (ou use deploy direto do CLI)
3. Crie um **repositório no GitHub** e faça upload desta pasta `esquina-bot/` inteira
4. Conecte o repositório ao Railway

### 2. Subir uma instância da Evolution API

O bot precisa conversar com uma instância da Evolution API. Você tem 2 opções:

**Opção A — Evolution API no mesmo Railway (recomendado):**

1. No seu projeto do Railway, clique em **"+ New"** → **"Deploy Docker Image"**
2. Use a imagem: `atendai/evolution-api:latest`
3. Adicione estas variáveis de ambiente:
   ```
   SERVER_URL=https://[URL-PUBLICA-DESSA-SERVICE].up.railway.app
   AUTHENTICATION_API_KEY=troque-por-uma-chave-aleatoria-forte
   DATABASE_ENABLED=false
   CACHE_REDIS_ENABLED=false
   CACHE_LOCAL_ENABLED=true
   WEBHOOK_GLOBAL_ENABLED=true
   WEBHOOK_GLOBAL_URL=https://[URL-DO-SEU-BOT].up.railway.app/webhook
   CONFIG_SESSION_PHONE_CLIENT=Esquina Burger
   ```
4. Deploy e anote a URL pública

**Opção B — Usar um serviço Evolution como UazAPI ou similar:**

Várias empresas brasileiras oferecem Evolution API hospedada. Custam entre R$ 30-150/mês. Anote a URL base e API key.

### 3. Configurar variáveis de ambiente do BOT no Railway

No serviço do bot, vá em **Variables** e adicione:

```
GEMINI_API_KEY=AIzaSyXXX           # Pegue em aistudio.google.com/app/apikey
GEMINI_MODEL=gemini-2.0-flash
EVOLUTION_URL=https://evolution-xxx.up.railway.app
EVOLUTION_API_KEY=a-mesma-do-passo-2
EVOLUTION_INSTANCE=esquina-burger
FIREBASE_DB_URL=https://esquina-burger-default-rtdb.firebaseio.com
RESTAURANTE_NOME=Esquina Burger
RESTAURANTE_UNIDADE=Vicentinópolis
TAXA_ENTREGA=5.00
HORARIO_FUNCIONAMENTO=Terça a Domingo, 18h às 23h
ENDERECO_LOJA=Rua Principal, 123 - Vicentinópolis
WEBHOOK_TOKEN=troque-por-um-token-secreto
PORT=3000
```

### 4. Criar a instância do WhatsApp

1. No bot ou via Postman, chame:
   ```
   POST https://evolution-xxx.up.railway.app/instance/create
   Headers: apikey: SUA_EVOLUTION_API_KEY
   Body: {
     "instanceName": "esquina-burger",
     "qrcode": true,
     "integration": "WHATSAPP-BAILEYS"
   }
   ```
2. Pegue o QR code retornado e escaneie com o WhatsApp do celular da loja
3. Pronto — o WhatsApp da loja agora está conectado ao bot

### 5. Testar

Envie uma mensagem de teste para o WhatsApp da loja ("oi") de outro número. Em alguns segundos o bot deve responder.

Ou teste sem WhatsApp direto pelo endpoint:
```
POST https://seu-bot.up.railway.app/test
Body: { "telefone": "5564999999999", "texto": "oi, queria um duplo blade" }
```

### 6. No PDV (Esquina Burger Sistema)

1. Abra o sistema e faça login como admin
2. Vá na nova aba **"Atendimento WhatsApp"** que vamos adicionar no PDV
3. Marque a opção **"Esta aba é master (recebe pedidos do bot)"**
4. Deixe essa aba aberta sempre — é ela que vai auto-aceitar e imprimir os pedidos do bot

## Custos mensais estimados

- **Railway (bot + Evolution):** ~R$ 30-50/mês
- **Google Gemini 2.0 Flash:** R$ 0 no tier gratuito (até 1500 requisições/dia e 1M tokens/minuto). Pago só se passar disso — ainda assim é ~5x mais barato que Claude Haiku.
- **Total:** ~R$ 30-50/mês

## Estrutura dos arquivos

```
esquina-bot/
├── package.json
├── railway.json
├── .env.example
├── src/
│   ├── index.js       # Servidor Express + webhook
│   ├── ai.js          # Gemini + function calling para montar pedidos
│   ├── evolution.js   # Cliente Evolution API
│   ├── firebase.js    # Cliente Firebase Realtime DB
│   ├── cardapio.js    # Cardápio espelho do PDV
│   └── prompts.js     # System prompt da IA
```

## Manutenção

- **Mudou algo no cardápio do PDV?** Atualize também `src/cardapio.js` e faça deploy. Idealmente migre isso para ler do Firebase para ficar sincronizado automaticamente.
- **Bot respondendo errado?** Ajuste o `system prompt` em `src/prompts.js`.
- **Quer desligar o bot?** Basta pausar o serviço no Railway.

## Problemas comuns

- **Bot não responde:** verifique logs no Railway. Provavelmente o webhook não está configurado ou a Evolution API não está com a instância conectada.
- **Pedidos não imprimem:** verifique se o PDV está com a aba master ativada E com a central de impressão aberta (`esquina-burger-impressora.html`).
- **Gemini dá erro 401/403:** GEMINI_API_KEY inválida. Gere uma nova em aistudio.google.com/app/apikey.
- **Gemini dá erro 429:** Passou do limite do tier gratuito (1500 req/dia). Espere ou habilite billing no Google AI Studio.
