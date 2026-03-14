#!/bin/bash

WRANGLER="npx wrangler"
DATE=$(date "+%Y-%m-%d %H:%M:%S")

echo "=================================="
echo "☁ CLOUDFLARE INFRASTRUCTURE + USAGE REPORT"
echo "Generated: $DATE"
echo "=================================="

echo "🔐 Authentication"
$WRANGLER whoami
echo ""

echo "=================================="
echo "📦 WORKERS"
echo "=================================="
$WRANGLER deployments list
echo ""

echo "=================================="
echo "📬 QUEUES"
echo "=================================="
$WRANGLER queues list
for QUEUE in alert-queue feed-queue job-queue
do
  echo ""
  echo "---- $QUEUE ----"
  $WRANGLER queues info $QUEUE
done
echo ""

echo "=================================="
echo "🗂 KV STORAGE"
echo "=================================="
$WRANGLER kv namespace list
echo ""
echo "Sample KV Keys (first 20):"
$WRANGLER kv key list --namespace-id 9606d0c7fcda4e69bb04cc351bd7fd5a | head -n 20
echo ""

echo "=================================="
echo "🗄 D1 DATABASE"
echo "=================================="
$WRANGLER d1 list
echo ""
echo "D1 Tables:"
$WRANGLER d1 execute job-hunter-db --command="SELECT name FROM sqlite_master WHERE type='table';" --remote
echo ""

echo "=================================="
echo "⏰ CRON TRIGGERS"
echo "=================================="
if [ -f wrangler.toml ]; then
  grep "cron" wrangler.toml || echo "No cron triggers found"
else
  echo "No wrangler.toml found. Cannot list cron triggers."
fi
echo ""

echo "=================================="
echo "✔ REPORT COMPLETE"
echo "=================================="