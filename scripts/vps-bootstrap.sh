#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/unitv}"
REPO_URL="${REPO_URL:-https://github.com/theandrezn/UNITV.git}"
DOMAIN="${DOMAIN:-_}"
NODE_MAJOR="${NODE_MAJOR:-22}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git nginx

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "v${NODE_MAJOR}"; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

npm install -g pm2

mkdir -p "$(dirname "$APP_DIR")"
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

cat >/etc/nginx/sites-available/unitv <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

ln -sfn /etc/nginx/sites-available/unitv /etc/nginx/sites-enabled/unitv
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

echo "Bootstrap complete. Add $APP_DIR/.env.local, then run scripts/vps-deploy.sh on the server."
