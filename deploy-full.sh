#!/bin/bash
#
# Bot-Hub Full Deployment Script for Ubuntu/Debian
# Installiert und konfiguriert alle notwendigen Komponenten
#
# Verwendung: sudo bash deploy-full.sh
#

set -Ee -o pipefail

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

# TLS ist beim Standard-Deployment verpflichtend. Domain und Kontaktadresse
# werden vor Systemänderungen abgefragt bzw. aus der Umgebung übernommen.
BOT_HUB_DOMAIN="$BOT_HUB_DOMAIN"
BOT_HUB_LE_EMAIL="$BOT_HUB_LE_EMAIL"
if [ -z "$BOT_HUB_DOMAIN" ]; then
    if [ -r /dev/tty ]; then
        read -r -p "Öffentliche Bot-Hub-Domain (z. B. hub.example.org): " BOT_HUB_DOMAIN </dev/tty
    else
        log_error "BOT_HUB_DOMAIN fehlt. Nichtinteraktiv: BOT_HUB_DOMAIN und BOT_HUB_LE_EMAIL setzen."
        exit 1
    fi
fi
if [ -z "$BOT_HUB_LE_EMAIL" ]; then
    if [ -r /dev/tty ]; then
        read -r -p "E-Mail für Let's Encrypt Ablaufmeldungen: " BOT_HUB_LE_EMAIL </dev/tty
    else
        log_error "BOT_HUB_LE_EMAIL fehlt. Bitte eine erreichbare E-Mail-Adresse setzen."
        exit 1
    fi
fi
if ! [[ "$BOT_HUB_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
    log_error "BOT_HUB_DOMAIN ist kein gültiger öffentlicher DNS-Name."
    exit 1
fi
if ! [[ "$BOT_HUB_LE_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+(\.[^[:space:]@]+)+$ ]]; then
    log_error "BOT_HUB_LE_EMAIL ist keine gültige E-Mail-Adresse."
    exit 1
fi

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

# Maßnahme 41 (Audit SC-11): fail2ban ohne Jail installiert nur Luft. Der
# sshd-Jail kommt aktiv, sonst steht das Paket nur als Beruhigung da.
cat > /etc/fail2ban/jail.d/bot-hub-sshd.conf <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban >/dev/null 2>&1 || true
log_success "fail2ban sshd-Jack aktiv"

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
    # Maßnahme 41 (Audit SC-09): curl | bash auf root ist per Definition
    # Blindvertrauen in den Auslieferer. Getragen wird das bewusst: die
    # Nodesource-Domäne ist der einzige offizielle Weg, der Key landet als
    # apt-keyring (nachträglich prüfbar: `apt-key fingerprint` bzw.
    # `/etc/apt/keyrings/nodesource.gpg`), und alle weiteren Pakete kommen
    # signiert aus dem so angebundenen Repo. Ein Hash-Pin würde bei jedem
    # Upstream-Update brechen.
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

# Quellcode und Git-Historie bleiben root-eigen und für den Dienst nur lesbar.
# npm lifecycle scripts laufen unter einem eigenen Build-Benutzer ohne Docker-
# oder Secret-Gruppenmitgliedschaft. Der Dienst braucht den Docker-Socket für
# die Containersteuerung; bei rootful Docker ist diese Berechtigung selbst
# weiterhin host-root-äquivalent und muss architektonisch separat abgelöst werden.
if ! getent group bot-hub-code >/dev/null; then
    groupadd --system bot-hub-code
fi
usermod -aG bot-hub-code bot-hub
usermod -aG docker bot-hub

if ! id bot-hub-build >/dev/null 2>&1; then
    useradd --system --create-home --home-dir /var/lib/bot-hub-build \
        --shell /usr/sbin/nologin --gid bot-hub-code bot-hub-build
else
    usermod --gid bot-hub-code --groups bot-hub-code --shell /usr/sbin/nologin bot-hub-build
fi
install -d -o bot-hub-build -g bot-hub-code -m 0750 /var/lib/bot-hub-build
install -d -o bot-hub-build -g bot-hub-code -m 0750 /var/lib/bot-hub-build/.npm

# Runtime-Verzeichnisse sind die einzigen Projektbereiche, die der Hub
# beschreiben darf. Symlinks an diesen Grenzen werden nicht akzeptiert.
for runtime_dir in "$PROJECT_DIR/data" "$PROJECT_DIR/bots"; do
    if [ -L "$runtime_dir" ]; then
        log_error "Runtime-Verzeichnis darf kein Symlink sein: $runtime_dir"
        exit 1
    fi
    mkdir -p "$runtime_dir"
    chown -R bot-hub:bot-hub -- "$runtime_dir"
    chmod 0750 "$runtime_dir"
done

# Alles Übrige einschließlich .git wird root:bot-hub-code und nicht für den
# Dienst beschreibbar. Secrets und generierte Build-Verzeichnisse bleiben außen vor.
if [ -L "$PROJECT_DIR/.env" ]; then
    log_error ".env darf kein Symlink sein."
    exit 1
fi
chown root:bot-hub-code "$PROJECT_DIR"
chmod 0750 "$PROJECT_DIR"
for entry in "$PROJECT_DIR"/* "$PROJECT_DIR"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    case "$entry" in
        "$PROJECT_DIR/data"|"$PROJECT_DIR/bots"|"$PROJECT_DIR/node_modules"|"$PROJECT_DIR/dist"|"$PROJECT_DIR/.env"|"$PROJECT_DIR"/.env.backup*)
            continue
            ;;
    esac
    chown -R root:bot-hub-code -- "$entry"
    find "$entry" -type d -exec chmod 0750 {} +
    find "$entry" -type f -exec chmod u+rw,g+r,o-rwx {} +
done

# Die ausgelieferte Beispielbibliothek ist Quellcode, kein Workspace.
if [ -d "$PROJECT_DIR/bots/shared" ] && [ ! -L "$PROJECT_DIR/bots/shared" ]; then
    chown -R root:bot-hub-code -- "$PROJECT_DIR/bots/shared"
    find "$PROJECT_DIR/bots/shared" -type d -exec chmod 0750 {} +
    find "$PROJECT_DIR/bots/shared" -type f -exec chmod u+rw,g+r,o-rwx {} +
fi

# npm ci und Vite dürfen ausschließlich node_modules/dist beschreiben.
for build_dir in "$PROJECT_DIR/node_modules" "$PROJECT_DIR/dist"; do
    if [ -L "$build_dir" ]; then
        log_error "Build-Verzeichnis darf kein Symlink sein: $build_dir"
        exit 1
    fi
    install -d -o bot-hub-build -g bot-hub-code -m 2750 "$build_dir"
    chown -R bot-hub-build:bot-hub-code -- "$build_dir"
    find "$build_dir" -type d -exec chmod 2750 {} +
    find "$build_dir" -type f -exec chmod u+rw,g+r,o-rwx {} +
done

# In Projektverzeichnis wechseln
cd "$PROJECT_DIR"

# Abhängigkeiten installieren und Frontend bauen – absichtlich NICHT als
# bot-hub, da dieser Benutzer den Docker-Socket für den Laufzeitbetrieb benötigt.
log_info "Node.js Abhängigkeiten als isolierter Build-Benutzer installieren..."
umask 0027
sudo -u bot-hub-build env HOME=/var/lib/bot-hub-build npm ci --include=dev
log_success "Abhängigkeiten installiert"

log_info "Frontend als isolierter Build-Benutzer bauen..."
sudo -u bot-hub-build env HOME=/var/lib/bot-hub-build npm run build
log_success "Frontend gebaut"

# .env.example kopieren falls .env nicht existiert
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        chown root:bot-hub .env
        chmod 640 .env
        log_warn ".env erstellt aus .env.example - bitte konfigurieren!"
    else
        log_error ".env.example nicht gefunden!"
        exit 1
    fi
else
    log_info ".env existiert bereits"
fi
chown root:bot-hub .env
chmod 640 .env

# Vault-Master-Key für die Verschlüsselung von data/secrets/*.env (AES-256-GCM).
# Absichtlich AUSSERHALB von data/ und des Projektordners: ein Backup oder Git-
# Unfall, der nur den Datenordner erwischt, gibt dann nichts mehr her. Der Hub
# liest den Pfad über BOT_HUB_KEY_FILE (aus der .env via EnvironmentFile).
mkdir -p /etc/bot-hub
if [ ! -f /etc/bot-hub/master.key ]; then
    # Maßnahme 41 (Audit SC-06): vorher ging der Key über /tmp/master.key.$$
    # (PID-Name = erratbar; ein vorgelegter Symlink wurde als root gefolgt →
    # beliebiger Dateiüberschreib). Jetzt: Direktanlage im root-eigenen
    # /etc/bot-hub unter Umask 077 – kein Welt-lesbarer Zwischenablage-Pfad.
    ( umask 077
      node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex")+"\n")' > /etc/bot-hub/master.key )
    chmod 640 /etc/bot-hub/master.key
    chown root:bot-hub /etc/bot-hub/master.key
    log_success "Vault-Key /etc/bot-hub/master.key erzeugt (root:bot-hub 0640)"
else
    log_info "Vault-Key existiert bereits"
fi
grep -q '^BOT_HUB_KEY_FILE=' .env || printf '\nBOT_HUB_KEY_FILE=/etc/bot-hub/master.key\n' >> .env
grep -q '^BOT_HUB_KEY_FILE=' .env && log_info "BOT_HUB_KEY_FILE in .env eingetragen"

# Maßnahme 47 (Audit 5.5): nginx läuft in dieser Installation auf demselben
# Rechner und lauscht öffentlich, der Hub nur auf 127.0.0.1. Ohne diesen
# Eintrag kann der Hub X-Forwarded-For nicht auswerten und alle Besucher
# teilen sich einen Rate-Limit-Eimer auf die Adresse von nginx (das
# Login-Limit von 30/Min gilt dann für die ganze Installation).
grep -q '^BOT_HUB_TRUSTED_PROXIES=' .env || printf '\nBOT_HUB_TRUSTED_PROXIES=127.0.0.1\n' >> .env
grep -q '^BOT_HUB_TRUSTED_PROXIES=' .env && log_info "BOT_HUB_TRUSTED_PROXIES in .env eingetragen"

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
# Maßnahme 41 (Audit SC-10): Grundhärtung. Kein setuid-Spielraum, /usr//boot/
# /etc read-only für den Prozess (der Master-Key wird nur GELESEN), eigener
# /tmp (Exec-env-Dateien bleiben privat), kein Home-Zugriff. PrivateUsers/
# ProtectKernel* bleiben aus: der Docker-Socket braucht die echte Gruppe.
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

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
# 10. nginx vorbereiten
# ============================================
log_info "Step 10: nginx für das verpflichtende TLS-Setup vorbereiten..."

# Eine vorhandene Bot-Hub-Konfiguration wird erst vom TLS-Skript auf eine
# Challenge-only-Konfiguration und danach auf HTTPS umgestellt. Kein neuer
# unverschlüsselter Reverse-Proxy wird hier veröffentlicht.
if [ -f /etc/nginx/sites-available/default ] && [ ! -e /etc/nginx/sites-available/default.backup ]; then
    mv /etc/nginx/sites-available/default /etc/nginx/sites-available/default.backup
fi
rm -f /etc/nginx/sites-enabled/default
log_success "nginx vorbereitet"

# ============================================
# 11. Certbot-TLS standardmäßig einrichten
# ============================================
log_info "Step 11: Let's Encrypt-Zertifikat automatisch beantragen..."

systemctl enable bot-hub
if ! bash "$PROJECT_DIR/setup-tls.sh" "$BOT_HUB_DOMAIN" "$BOT_HUB_LE_EMAIL"; then
    log_error "TLS-Einrichtung fehlgeschlagen. Deployment wird nicht als erfolgreich gemeldet."
    exit 1
fi

# setup-tls.sh startet den Hub nach dem HTTPS-/Cookie-Upsert neu.
if systemctl is-active --quiet bot-hub; then
    log_success "Bot-Hub läuft hinter HTTPS"
else
    log_error "Bot-Hub Service konnte nicht gestartet werden"
    journalctl -u bot-hub -n 30 --no-pager || true
    exit 1
fi

# ============================================
# 12. Abschluss
# ============================================
echo ""
log_success "========================================="
log_success "Deployment mit HTTPS erfolgreich!"
log_success "========================================="
echo ""
log_info "Bot-Hub: https://$BOT_HUB_DOMAIN"
log_info "Let's Encrypt: certbot.timer ist für automatische Erneuerungen aktiviert."
echo ""
log_info "Noch zu konfigurieren:"
echo "1. .env: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET und BOT_HUB_OWNER_IDS eintragen."
echo "2. In der Discord Developer Console diese Redirect URI registrieren:"
echo "   https://$BOT_HUB_DOMAIN/api/auth/discord/callback"
echo "3. Danach: systemctl restart bot-hub"
echo "4. Logs: journalctl -u bot-hub -f"
echo ""
log_warn "TLS ist eingerichtet; die Discord-OAuth-Werte müssen vor der produktiven Anmeldung gesetzt werden."
echo ""
systemctl status bot-hub --no-pager
echo ""
