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

FOLLOWUPS_WAS_RUNNING="false"
FOLLOWUPS_PID="$(pm2 pid unitv-followups-worker 2>/dev/null | tail -n 1 || true)"
if [[ "$FOLLOWUPS_PID" =~ ^[1-9][0-9]*$ ]]; then
  FOLLOWUPS_WAS_RUNNING="true"
fi

pm2 startOrReload ecosystem.config.cjs --update-env
if [[ "$FOLLOWUPS_WAS_RUNNING" != "true" ]]; then
  pm2 stop unitv-followups-worker >/dev/null
fi
pm2 save
pm2 startup systemd -u root --hp /root >/tmp/unitv-pm2-startup.txt

echo "Deploy complete."
