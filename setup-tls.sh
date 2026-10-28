#!/bin/bash
#
# Let's Encrypt TLS Setup Script for Bot-Hub
# Richtet automatisch HTTPS mit Let's Encrypt ein
#
# Verwendung: sudo bash setup-tls.sh ihre-domain.de
#

set -e

# Farben
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Prüfen, ob als root ausgeführt
if [ "$EUID" -ne 0 ]; then 
    log_error "Dieses Skript muss als root ausgeführt werden (sudo)"
    exit 1
fi

# Domain als Argument erwarten
if [ -z "$1" ]; then
    log_error "Bitte Domain angeben: sudo bash setup-tls.sh ihre-domain.de"
    exit 1
fi

DOMAIN="$1"
# Maßnahme 41 (Audit SC-07): die Domain wandert in nginx-Konfigurationen und
# sed-Ausdrücke. Erlaubt sind ausschließlich DNS-Zeichen — alles andere (
# Leerzeichen, Zeilenumbrüche, `;`, `"` …) wäre Konfig-Injektion.
if ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'; then
    log_error "Ungültige Domain: '$DOMAIN'"
    exit 1
fi
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log_info "Let's Encrypt TLS Setup für: $DOMAIN"
echo ""

# ============================================
# 1. certbot und nginx plugin installieren
# ============================================
log_info "Step 1: certbot installieren..."

apt update
apt install -y certbot python3-certbot-nginx

log_success "certbot installiert"

# ============================================
# 2. Port 80 prüfen
# ============================================
log_info "Step 2: Port 80 prüfen..."

if command -v nc &> /dev/null; then
    if nc -z localhost 80; then
        log_info "Port 80 ist erreichbar"
    else
        log_error "Port 80 ist nicht erreichbar. nginx muss auf Port 80 laufen!"
        exit 1
    fi
else
    log_warn "netcat nicht verfügbar, Port-Prüfung übersprungen"
fi

# ============================================
# 3. temporäre nginx config für HTTP-only
# ============================================
log_info "Step 3: nginx config für Let's Encrypt Challenge..."

cat > /etc/nginx/sites-available/bot-hub <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

ln -sf /etc/nginx/sites-available/bot-hub /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx

log_success "nginx config für HTTP erstellt"

# ============================================
# 4. Let's Encrypt Zertifikat beantragen
# ============================================
log_info "Step 4: Let's Encrypt Zertifikat beantragen..."
log_warn "Dies kann einige Minuten dauern..."

certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@"$DOMAIN" --redirect

if [ $? -eq 0 ]; then
    log_success "Let's Encrypt Zertifikat erfolgreich beantragt"
else
    log_error "Let's Encrypt beantragung fehlgeschlagen"
    exit 1
fi

# ============================================
# 5. nginx config für HTTPS optimieren
# ============================================
log_info "Step 5: nginx config für HTTPS optimieren..."

cat > /etc/nginx/sites-available/bot-hub <<EOF
server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    # SSL Zertifikat
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    # SSL Security Settings
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security Headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;

    # Proxy zu Bot-Hub
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}

# HTTP zu HTTPS redirect
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://$server_name$request_uri;
}
EOF

nginx -t && systemctl reload nginx

log_success "nginx config für HTTPS erstellt"

# ============================================
# 6. .env Datei aktualisieren
# ============================================
log_info "Step 6: .env Datei aktualisieren..."

if [ -f "$PROJECT_DIR/.env" ]; then
    # Backup erstellen
    cp "$PROJECT_DIR/.env" "$PROJECT_DIR/.env.backup"
    
    # BOT_HUB_URL aktualisieren
    sed -i "s|^BOT_HUB_URL=.*|BOT_HUB_URL=https://$DOMAIN|" "$PROJECT_DIR/.env"
    
    # DISCORD_REDIRECT_URI aktualisieren
    sed -i "s|^DISCORD_REDIRECT_URI=.*|DISCORD_REDIRECT_URI=https://$DOMAIN/api/auth/discord/callback|" "$PROJECT_DIR/.env"
    
    # BOT_HUB_SECURE_COOKIES setzen
    # Maßnahme 41 (Audit SC-05): echtes Upsert – das alte sed war ein
    # No-op, wenn die Zeile fehlte, und der Hub lief mit TLS und un-
    # gesicherten Cookies weiter.
    if grep -q '^BOT_HUB_SECURE_COOKIES=' "$PROJECT_DIR/.env"; then
        sed -i "s|^BOT_HUB_SECURE_COOKIES=.*|BOT_HUB_SECURE_COOKIES=1|" "$PROJECT_DIR/.env"
    else
        printf 'BOT_HUB_SECURE_COOKIES=1\n' >> "$PROJECT_DIR/.env"
    fi
    
    chown bot-hub:bot-hub "$PROJECT_DIR/.env"
    chmod 600 "$PROJECT_DIR/.env"
    
    log_success ".env Datei aktualisiert"
    log_warn "Backup gespeichert unter: $PROJECT_DIR/.env.backup"
else
    log_warn ".env Datei nicht gefunden, bitte manuell konfigurieren"
fi

# ============================================
# 7. Bot-Hub Service neu starten
# ============================================
log_info "Step 7: Bot-Hub Service neu starten..."

systemctl restart bot-hub

sleep 3

if systemctl is-active --quiet bot-hub; then
    log_success "Bot-Hub Service neu gestartet"
else
    log_error "Bot-Hub Service konnte nicht gestartet werden"
    journalctl -u bot-hub -n 20 --no-pager
    exit 1
fi

# ============================================
# 8. Auto-Renewal einrichten
# ============================================
log_info "Step 8: Auto-Renewal einrichten..."

# certbot timer sollte bereits aktiv sein
systemctl status certbot.timer &>/dev/null || systemctl enable certbot.timer

log_success "Auto-Renewal ist aktiviert"

# ============================================
# 9. Abschluss
# ============================================
echo ""
log_success "========================================="
log_success "TLS Setup erfolgreich abgeschlossen!"
log_success "========================================="
echo ""
log_info "Ihre Seite ist jetzt erreichbar unter:"
echo "   https://$DOMAIN"
echo ""
log_info "Nächste Schritte:"
echo ""
echo "1. Discord OAuth App konfigurieren:"
echo "   - Redirect URI: https://$DOMAIN/api/auth/discord/callback"
echo ""
echo "2. .env Datei prüfen:"
echo "   nano $PROJECT_DIR/.env"
echo ""
echo "3. Bot-Hub Status prüfen:"
echo "   systemctl status bot-hub"
echo ""
echo "4. Logs prüfen:"
echo "   journalctl -u bot-hub -f"
echo ""
log_info "Zertifikat Auto-Renewal:"
certbot renew --dry-run
echo ""
