#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
log_info() { printf '[INFO] %s\n' "$1"; }
log_warn() { printf '[WARN] %s\n' "$1"; }
log_error() { printf '[ERROR] %s\n' "$1" >&2; }
[[ "$EUID" -eq 0 ]] || { log_error "Bitte mit sudo/root ausführen."; exit 1; }
DOMAIN="${1:-${BOT_HUB_DOMAIN:-}}"
EMAIL="${2:-${BOT_HUB_LE_EMAIL:-}}"
[[ -n "$DOMAIN" ]] || { log_error "Aufruf: sudo bash setup-tls.sh domain.example.org mail@example.org"; exit 2; }
[[ -n "$EMAIL" ]] || { log_error "Let's Encrypt E-Mail fehlt."; exit 2; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] || { log_error "Ungültiger DNS-Domainname."; exit 2; }
[[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+(\.[^[:space:]@]+)+$ ]] || { log_error "Ungültige Kontakt-E-Mail."; exit 2; }
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NGINX_SITE=/etc/nginx/sites-available/bot-hub
NGINX_LINK=/etc/nginx/sites-enabled/bot-hub
WEBROOT=/var/lib/letsencrypt
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

install -d -o root -g root -m 0755 /etc/letsencrypt
install -d -o root -g www-data -m 0750 "$WEBROOT"
install -d -o root -g www-data -m 0750 "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y certbot nginx python3-certbot-nginx

# Certbot aktualisiert Zertifikatsdateien auf der Platte. nginx lädt sie erst
# nach einem Reload neu; diesen lösen wir nach jeder erfolgreichen Erneuerung
# explizit aus. Der Hook bleibt bei wiederholten Deployments identisch.
RENEWAL_HOOK=/etc/letsencrypt/renewal-hooks/deploy/10-bot-hub-reload-nginx
install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy
hook_tmp="$(mktemp /etc/letsencrypt/renewal-hooks/deploy/.bot-hub-reload.XXXXXX)"
cat >"$hook_tmp" <<'HOOK'
#!/usr/bin/env bash
set -Eeuo pipefail
/usr/sbin/nginx -t
/bin/systemctl reload nginx
HOOK
install -o root -g root -m 0750 "$hook_tmp" "$RENEWAL_HOOK"
rm -f "$hook_tmp"

# Vor Zertifikatsausstellung ist Port 80 ausschließlich für ACME offen.
# Bei Certbot-Fehlern wird niemals die App unverschlüsselt ausgeliefert.
site_tmp="$(mktemp /etc/nginx/sites-available/.bot-hub-http.XXXXXX)"
trap 'rm -f "${site_tmp:-}"' EXIT
cat >"$site_tmp" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 404; }
}
EOF
install -o root -g root -m 0644 "$site_tmp" "$NGINX_SITE"
rm -f "$site_tmp"
ln -sfn "$NGINX_SITE" "$NGINX_LINK"
nginx -t
systemctl reload nginx

log_info "Beantrage/erneuere Let's Encrypt-Zertifikat für $DOMAIN ..."
certbot certonly --webroot --webroot-path "$WEBROOT" --domain "$DOMAIN" \
  --email "$EMAIL" --agree-tos --non-interactive --keep-until-expiring
[[ -s "$CERT_DIR/fullchain.pem" && -s "$CERT_DIR/privkey.pem" ]] || { log_error "Zertifikatsdateien fehlen."; exit 1; }

tls_tmp="$(mktemp /etc/nginx/sites-available/.bot-hub-tls.XXXXXX)"
trap 'rm -f "${tls_tmp:-}" "${site_tmp:-}"' EXIT
cat >"$tls_tmp" <<EOF
server {
    listen 443 ssl http2;
    server_name $DOMAIN;
    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
server {
    listen 80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
install -o root -g root -m 0644 "$tls_tmp" "$NGINX_SITE"
rm -f "$tls_tmp"
nginx -t
systemctl reload nginx

if [[ -f "$PROJECT_DIR/.env" ]]; then
  [[ ! -L "$PROJECT_DIR/.env" ]] || { log_error ".env darf kein Symlink sein."; exit 1; }
  install -o root -g bot-hub -m 0640 "$PROJECT_DIR/.env" "$PROJECT_DIR/.env.backup"
  env_tmp="$(mktemp "$PROJECT_DIR/.env.tmp.XXXXXX")"
  trap 'rm -f "${env_tmp:-}" "${tls_tmp:-}" "${site_tmp:-}"' EXIT
  awk '!/^(BOT_HUB_URL|DISCORD_REDIRECT_URI|BOT_HUB_SECURE_COOKIES)=/ { print }' "$PROJECT_DIR/.env" >"$env_tmp"
  printf 'BOT_HUB_URL=https://%s\nDISCORD_REDIRECT_URI=https://%s/api/auth/discord/callback\nBOT_HUB_SECURE_COOKIES=1\n' "$DOMAIN" "$DOMAIN" >>"$env_tmp"
  chown root:bot-hub "$env_tmp"
  chmod 0640 "$env_tmp"
  mv -f "$env_tmp" "$PROJECT_DIR/.env"
  trap - EXIT
  systemctl restart bot-hub
else
  log_warn ".env fehlt: TLS ist aktiv, aber OAuth-Einstellungen müssen noch eingerichtet werden."
fi

if systemctl list-unit-files certbot.timer --no-legend | grep -q '^certbot.timer'; then
  systemctl enable --now certbot.timer
  systemctl is-active --quiet certbot.timer || { log_error "certbot.timer ist nicht aktiv."; exit 1; }
else
  log_error "certbot.timer fehlt; automatische Erneuerung ist nicht gewährleistet."
  exit 1
fi
certbot renew --dry-run
log_info "HTTPS aktiv: https://$DOMAIN"
log_info "HTTP leitet auf HTTPS um; ACME-Challenges bleiben erreichbar."
