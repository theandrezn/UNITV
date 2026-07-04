#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/unitv}"

cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main

npm ci
npm run build

if [[ ! -f .env.local ]]; then
  echo "Missing $APP_DIR/.env.local. Create it before starting the app." >&2
  exit 1
fi

pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/tmp/unitv-pm2-startup.txt

echo "Deploy complete."
