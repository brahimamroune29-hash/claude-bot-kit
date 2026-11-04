#!/bin/sh
# usage: deploy/deploy.sh bot@SERVER — ships the code to the server and restarts the bot; the server's .env and data/ stay
set -e
cd "$(dirname "$0")/.."
[ -n "$1" ] || { echo "usage: deploy/deploy.sh bot@SERVER"; exit 1; }
# in a git repo: ship only what is committed
[ -z "$(git status --porcelain 2>/dev/null)" ] || { echo "uncommitted changes — commit first (deploy only what is in git)"; exit 1; }
npm test
rsync -az --delete --exclude .git --exclude .env --exclude '*.db' --exclude '*.db-*' \
  --exclude backups --exclude node_modules --exclude data --exclude media --exclude '*.local.*' ./ "$1:/opt/shop-bot/"
ssh "$1" 'sudo systemctl restart shop-bot && sleep 3 && p=$(sed -n "s/^PORT=//p" /opt/shop-bot/.env) &&
  curl -sf "127.0.0.1:${p:-3000}/health" && echo " ✅ the bot answers" || echo "❌ the bot does not answer: journalctl -u shop-bot -n 50"'
