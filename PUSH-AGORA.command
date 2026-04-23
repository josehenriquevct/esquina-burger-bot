#!/bin/bash
cd "$(dirname "$0")"
echo "🚀 Commitando e fazendo push pro GitHub..."
echo ""
git add package.json
git commit -m "fix: adicionar node-fetch e dotenv nas dependencias

Estavam faltando no package.json causando crash no Railway.
evolution.js e firebase.js importam node-fetch,
index.js importa dotenv/config."
echo ""
git push origin main
echo ""
if [ $? -eq 0 ]; then
  echo "✅ PUSH FEITO COM SUCESSO!"
  echo ""
  echo "🚂 Railway vai fazer deploy automático em ~1 minuto."
  echo "Confira em: https://railway.app"
else
  echo "❌ Erro no push."
fi
echo ""
echo "Pressione qualquer tecla pra fechar..."
read -n 1
