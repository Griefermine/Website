#!/bin/bash
#
# Bot-Hub Full Deployment Script for Ubuntu/Debian
# Installiert und konfiguriert alle notwendigen Komponenten
#
# Verwendung: sudo bash deploy-full.sh
#

set -e

# Farben für Ausgabe
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging
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

# Projektverzeichnis ermitteln
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"

log_info "Bot-Hub Full Deployment Script"
log_info "Projektverzeichnis: $PROJECT_DIR"
echo ""

# ============================================
# 1. System-Update
# ============================================
log_info "Step 1: System-Update..."
apt update && apt upgrade -y
log_success "System aktualisiert"

# ============================================
# 2. Notwendige Pakete installieren
# ============================================
log_info "Step 2: Grundlegende Pakete installieren..."
apt install -y \
    curl \
    wget \
    git \
    gnupg \
    lsb-release \
    software-properties-common \
    apt-transport-https \
    ca-certificates \
    ufw \
    nginx \
    fail2ban

log_success "Grundpakete installiert"

# ============================================
# 3. Docker installieren
# ============================================
log_info "Step 3: Docker installieren..."

if ! command -v docker &> /dev/null; then
    log_info "Docker wird installiert..."
    
    # Docker's offizielles GPG-Key hinzufügen
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    
    # Docker Repository hinzufügen
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    apt update
    apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    # Docker für aktuellen User aktivieren (falls nicht root)
    if [ -n "$SUDO_USER" ]; then
        usermod -aG docker "$SUDO_USER"
        log_warn "User $SUDO_USER wurde zur docker-Gruppe hinzugefügt. Bitte aus- und wieder einloggen."
    fi
    
    log_success "Docker installiert"
else
    log_info "Docker ist bereits installiert"
fi

# ============================================
# 4. Node.js 22 installieren
# ============================================
log_info "Step 4: Node.js 22 installieren..."

if ! command -v node &> /dev/null; then
    log_info "Node.js wird installiert..."
    
    # NodeSource Repository hinzufügen
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    
    apt install -y nodejs
    
    log_success "Node.js $(node -v) installiert"
else
    NODE_VERSION=$(node -v)
    log_info "Node.js ist bereits installiert: $NODE_VERSION"
    
    # Prüfen, ob Version 22+
    MAJOR=$(echo $NODE_VERSION | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$MAJOR" -lt 22 ]; then
        log_warn "Node.js Version ist < 22. Empfohlen wird Node.js 22+"
    fi
fi

# ============================================
# 5. Projekt einrichten
# ============================================
log_info "Step 5: Projekt einrichten..."

# Bot-Hub Benutzer erstellen
if ! id "bot-hub" &>/dev/null; then
    log_info "Bot-Hub Benutzer erstellen..."
    useradd -r -s /bin/false bot-hub
    log_success "Bot-Hub Benutzer erstellt"
else
    log_info "Bot-Hub Benutzer existiert bereits"
fi

# `useradd -r` legt kein Home an, aber npm braucht ~/.npm als Cache – sonst
# scheitert `npm ci` mit EACCES beim Anlegen von /home/bot-hub.
BOT_HUB_HOME="$(getent passwd bot-hub | cut -d: -f6)"
if [ -n "$BOT_HUB_HOME" ] && [ ! -d "$BOT_HUB_HOME" ]; then
    log_info "Home-Verzeichnis für npm-Cache anlegen: $BOT_HUB_HOME"
    mkdir -p "$BOT_HUB_HOME"
    chown bot-hub:bot-hub "$BOT_HUB_HOME"
fi

# Projektverzeichnis berechtigen
chown -R bot-hub:bot-hub "$PROJECT_DIR"

# Der Hub steuert Bot-Container über den Socket und validiert in Produktion
# die Egress-Netzwerke per `docker network inspect` – ohne Gruppenmitglied-
# schaft bricht der Produktionsstart mit "Discord-Ausgangsfilter: Docker-Netz
# fehlt", weil der Dienst den Socket nicht lesen darf.
usermod -aG docker bot-hub

# In Projektverzeichnis wechseln
cd "$PROJECT_DIR"

# Abhängigkeiten installieren
log_info "Node.js Abhängigkeiten installieren..."
sudo -u bot-hub npm ci --include=dev
log_success "Abhängigkeiten installiert"

# Frontend bauen
log_info "Frontend bauen..."
sudo -u bot-hub npm run build
log_success "Frontend gebaut"

# .env.example kopieren falls .env nicht existiert
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        chown bot-hub:bot-hub .env
        chmod 600 .env
        log_warn ".env erstellt aus .env.example - bitte konfigurieren!"
    else
        log_error ".env.example nicht gefunden!"
        exit 1
    fi
else
    log_info ".env existiert bereits"
fi

# ============================================
# 6. Docker-Netzwerk einrichten
# ============================================
log_info "Step 6: Docker-Netzwerk einrichten..."

if [ -d "deploy/discord-egress" ]; then
    cd deploy/discord-egress
    
    # Host-Firewall-Setup ausführen
    if [ -f "setup-ubuntu-debian.sh" ]; then
        log_info "Host-Firewall einrichten..."
        # --enable ist Pflicht: ohne Aktivierung bricht das Setup bewusst vor
        # den Bot-Netzwerken ab (exit 0), und der Hub findet in Produktion
        # kein `bot-hub-discord`-Netz. --hub-user schreibt die sudoers-Regel,
        # damit der Dienst-User den Root-Prüfer des Firewall-Audits aufrufen
        # darf – ohne ihn verweigert der Hub in Produktion den Start.
        bash setup-ubuntu-debian.sh --enable --hub-user bot-hub
        log_success "Host-Firewall eingerichtet"
    else
        log_warn "setup-ubuntu-debian.sh nicht gefunden"
    fi
    
    # Docker Compose starten
    log_info "Docker Compose für Discord-Egress starten..."
    docker compose up -d
    log_success "Docker-Netzwerk gestartet"
    
    cd "$PROJECT_DIR"
else
    log_error "deploy/discord-egress Verzeichnis nicht gefunden!"
    exit 1
fi

# ============================================
# 7. Systemd Service erstellen
# ============================================
log_info "Step 7: Systemd Service erstellen..."

cat > /etc/systemd/system/bot-hub.service <<EOF
[Unit]
Description=Bot-Hub
After=network.target docker.service

[Service]
Type=simple
User=bot-hub
WorkingDirectory=$PROJECT_DIR
Environment="NODE_ENV=production"
# Ohne EnvironmentFile liest der Hub-Prozess die .env nie – Discord-Credentials,
# BOT_HUB_URL und Digest-Pins bleiben sonst wirkungslos (der Server lädt kein
# dotenv selbst). Das "-" Präfix macht die Datei optional. Werte mit
# Sonderzeichen (z. B. JSON in BOT_HUB_CONTAINER_IMAGES) in der .env einfach
# in einfache Hochkommata setzen: KEY='{"a":"b"}'
EnvironmentFile=-$PROJECT_DIR/.env
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
log_success "Systemd Service erstellt"

# ============================================
# 8. Verzeichnisse und Rechte einrichten
# ============================================
log_info "Step 8: Verzeichnisse und Rechte einrichten..."

sudo -u bot-hub bash -c "
cd '$PROJECT_DIR'
mkdir -p data/secrets data/db
chmod 700 data data/secrets data/db
chmod 600 data/bots.json data/access.json 2>/dev/null || true
"

log_success "Verzeichnisse und Rechte eingerichtet"

# ============================================
# 9. Firewall verifizieren (UFW gehört zum Egress-Setup)
# ============================================
log_info "Step 9: Firewall prüfen..."

# Die Firewall-Hoheit liegt bei setup-ubuntu-debian.sh (Step 6): das Skript
# aktiviert UFW und lässt gezielt nur Hub-HTTPS (80/443) sowie SSH aus der
# erkannten Admin-Gegenstelle zu. Eine pauschale `ufw allow 22/tcp`-Regel von
# "Anywhere" würde die Eingangs-Prüfung des Egress-Setups brechen, deshalb
# wird UFW hier nur verifiziert und nicht eigenmädig neu bepackt.
if ufw status | grep -q "Status: active"; then
    # Der Eingangsaudit des Egress-Setups erlaubt exakt 80/tcp und 443/tcp
    # (Hub-HTTPS) plus SSH aus der erkannten Admin-Gegenstelle – nur diese
    # beiden Ports öffnen wir hier nach, wenn sie fehlen.
    ufw status | grep -q "80/tcp" || ufw allow 80/tcp
    ufw status | grep -q "443/tcp" || ufw allow 443/tcp
    log_success "UFW aktiv; Hub-Ports 80/443 freigehalten"
else
    log_warn "UFW ist nicht aktiv. Starte 'bash deploy/discord-egress/setup-ubuntu-debian.sh --enable' (Schritt 6) und prüfe 'sudo ufw status numbered'."
fi

# ============================================
# 10. nginx konfigurieren
# ============================================
log_info "Step 10: nginx konfigurieren..."

# Backup der default config
if [ -f /etc/nginx/sites-available/default ]; then
    mv /etc/nginx/sites-available/default /etc/nginx/sites-available/default.backup
fi

# Bot-Hub nginx config erstellen
cat > /etc/nginx/sites-available/bot-hub <<'EOF'
server {
    listen 80;
    server_name _;
    
    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    
    # Temporary redirect to HTTPS (wird später konfiguriert)
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket support
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

ln -sf /etc/nginx/sites-available/bot-hub /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# nginx testen und neustarten
nginx -t
if [ $? -eq 0 ]; then
    systemctl reload nginx
    log_success "nginx konfiguriert und neu gestartet"
else
    log_error "nginx Konfiguration fehlerhaft!"
    exit 1
fi

# ============================================
# 11. Service starten
# ============================================
log_info "Step 11: Bot-Hub Service starten..."

systemctl enable bot-hub
systemctl start bot-hub

# Warten und Status prüfen
sleep 3
if systemctl is-active --quiet bot-hub; then
    log_success "Bot-Hub Service läuft"
else
    log_error "Bot-Hub Service konnte nicht gestartet werden"
    journalctl -u bot-hub -n 20 --no-pager
    exit 1
fi

# ============================================
# 12. Abschluss und Hinweise
# ============================================
echo ""
log_success "========================================="
log_success "Deployment erfolgreich abgeschlossen!"
log_success "========================================="
echo ""
log_info "Nächste Schritte:"
echo ""
echo "1. .env Datei konfigurieren:"
echo "   nano $PROJECT_DIR/.env"
echo ""
echo "   WICHTIGE Variablen:"
echo "   - DISCORD_CLIENT_ID=ihre-client-id"
echo "   - DISCORD_CLIENT_SECRET=ihre-client-secret"
echo "   - BOT_HUB_OWNER_IDS=ihre-discord-id"
echo "   - BOT_HUB_URL=https://ihre-domain.de"
echo "   - DISCORD_REDIRECT_URI=https://ihre-domain.de/api/auth/discord/callback"
echo "   - BOT_HUB_SECURE_COOKIES=1"
echo "   - BOT_HUB_CONTAINER_NETWORK=bot-hub-discord"
echo "   - BOT_HUB_REQUIRE_IMAGE_DIGEST=1"
echo ""
echo "2. Service neu starten:"
echo "   systemctl restart bot-hub"
echo ""
echo "3. Logs prüfen:"
echo "   journalctl -u bot-hub -f"
echo ""
echo "4. TLS einrichten (Let's Encrypt):"
echo "   apt install certbot python3-certbot-nginx"
echo "   certbot --nginx -d ihre-domain.de"
echo ""
echo "5. Für HTTPS: nginx config anpassen:"
echo "   nano /etc/nginx/sites-available/bot-hub"
echo ""
log_warn "WICHTIG: Die .env Datei MUSS konfiguriert werden bevor der Hub produktiv genutzt wird!"
echo ""
log_info "Service Status:"
systemctl status bot-hub --no-pager
echo ""
