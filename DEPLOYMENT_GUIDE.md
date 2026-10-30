# Bot-Hub Deployment Guide

Diese Anleitung erklärt, wie Sie den Bot-Hub auf einem Ubuntu/Debian Server deployen.

## 📋 Voraussetzungen

- Ubuntu 20.04+ oder Debian 11+
- Root-Zugriff oder sudo-Rechte
- Domain-Name (für HTTPS)
- Mindestens 2GB RAM, 2 CPU Kerne

## 🚀 Schnellstart (Full Deployment)

### 1. Projekt auf Server kopieren

```bash
# Via Git
cd /opt
git clone <ihr-repo> bot-hub
cd bot-hub

# Oder via SCP
scp -r /local/path/bot-hub user@server:/opt/
ssh user@server
cd /opt/bot-hub
```

### 2. Full Deployment Skript ausführen

```bash
sudo bash deploy-full.sh
```

**Das Skript installiert automatisch:**

- ✅ System-Updates
- ✅ Docker & Docker Compose
- ✅ Node.js 22
- ✅ nginx
- ✅ UFW Firewall
- ✅ fail2ban
- ✅ Docker-Netzwerk (bot-hub-discord)
- ✅ Host-Firewall
- ✅ Systemd Service
- ✅ Certbot/Let's Encrypt, HTTPS-Proxy, HTTP→HTTPS-Weiterleitung und automatische Zertifikatserneuerung
- ✅ Digest-Pinning für die Produktions-Container-Images
- ✅ Verzeichnisse und Rechte

### 3. .env konfigurieren

```bash
nano .env
```

**WICHTIGE Variablen:**

```bash
DISCORD_CLIENT_ID=ihre-client-id
DISCORD_CLIENT_SECRET=ihre-client-secret
BOT_HUB_OWNER_IDS=ihre-discord-id
HOST=127.0.0.1
PORT=8787
NODE_ENV=production
BOT_HUB_SECURE_COOKIES=1
BOT_HUB_URL=https://ihre-domain.de
DISCORD_REDIRECT_URI=https://ihre-domain.de/api/auth/discord/callback
BOT_HUB_CONTAINER_RUNTIME=docker
BOT_HUB_CONTAINER_NETWORK=bot-hub-discord
BOT_HUB_REQUIRE_IMAGE_DIGEST=1
```

### 4. Service neu starten

```bash
systemctl restart bot-hub
systemctl status bot-hub
```

### 5. TLS/HTTPS (normalerweise automatisch)

`deploy-full.sh` richtet TLS bereits während des Standard-Deployments ein.
Die manuelle Ausführung ist nur für bestehende Installationen oder zur
erneuten Konfiguration nötig:

```bash
sudo bash setup-tls.sh ihre-domain.de admin@example.org
```

**Voraussetzungen für Let's Encrypt:**

- Der Domainname zeigt per DNS auf diesen Server; vorhandene A- und AAAA-Einträge müssen stimmen.
- TCP-Port 80 ist von außen erreichbar (HTTP-01-Challenge); TCP-Port 443 ist für HTTPS freigegeben.
- Das Skript testet die nginx-Konfiguration und aktiviert die automatische Erneuerung einschließlich nginx-Reload nach einer erfolgreichen Erneuerung.
- Das Deployment legt für die Standard-Container und optional verwaltetes MySQL unveränderliche Registry-Digests fest.

### 6. Discord OAuth App konfigurieren

1. Gehen Sie zu https://discord.com/developers/applications
2. Erstellen Sie eine neue Application
3. OAuth2 Tab:
   - Redirect URI: `https://ihre-domain.de/api/auth/discord/callback`
   - Scopes: `identify`, `guilds`
4. .env aktualisieren:
   ```bash
   DISCORD_CLIENT_ID=vom-discord-kopieren
   DISCORD_CLIENT_SECRET=vom-discord-kopieren
   DISCORD_REDIRECT_URI=https://ihre-domain.de/api/auth/discord/callback
   ```

### 7. Service neu starten

```bash
systemctl restart bot-hub
```

### 8. Fertig!

Besuchen Sie: `https://ihre-domain.de`

---

## 📝 Manuelle Schritte (falls Skript fehlschlägt)

### Docker manuell installieren

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

### Node.js 22 manuell installieren

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Docker-Netzwerk manuell einrichten

```bash
cd deploy/discord-egress
sudo ./setup-ubuntu-debian.sh
docker compose up -d
```

### Systemd Service manuell erstellen

```bash
sudo nano /etc/systemd/system/bot-hub.service
```

```ini
[Unit]
Description=Bot-Hub
After=network.target docker.service

[Service]
Type=simple
User=bot-hub
WorkingDirectory=/opt/bot-hub
Environment="NODE_ENV=production"
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable bot-hub
sudo systemctl start bot-hub
```

---

## 🔧 Wartung und Monitoring

### Service Status prüfen

```bash
systemctl status bot-hub
```

### Logs ansehen

```bash
# Echtzeit-Logs
journalctl -u bot-hub -f

# Letzte 100 Zeilen
journalctl -u bot-hub -n 100

# Logs seit heute
journalctl -u bot-hub --since today
```

### Docker Logs

```bash
docker logs bot-hub-discord-egress -f
```

### Service neu starten

```bash
systemctl restart bot-hub
```

### Service stoppen

```bash
systemctl stop bot-hub
```

### Update durchführen

```bash
cd /opt/bot-hub
git pull
sudo -u bot-hub npm ci --include=dev
sudo -u bot-hub npm run build
systemctl restart bot-hub
```

---

## 🔒 Sicherheit

### Firewall Status prüfen

```bash
sudo ufw status
```

### Firewall Regeln hinzufügen

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
```

### fail2ban Status

```bash
sudo systemctl status fail2ban
```

### Backups erstellen

```bash
# Automatisches Backup-Skript erstellen
sudo nano /opt/backup-bot-hub.sh
```

```bash
#!/bin/bash
BACKUP_DIR="/opt/backups/bot-hub"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

cd /opt/bot-hub
tar -czf "$BACKUP_DIR/bot-hub-$DATE.tar.gz" \
    data/ \
    .env \
    bots/

# Alte Backups löschen (älter als 7 Tage)
find "$BACKUP_DIR" -name "bot-hub-*.tar.gz" -mtime +7 -delete
```

```bash
chmod +x /opt/backup-bot-hub.sh

# Cronjob für tägliche Backups
sudo crontab -e
# Hinzufügen:
0 2 * * * /opt/backup-bot-hub.sh
```

---

## 🐛 Troubleshooting

### Service startet nicht

```bash
# Logs prüfen
journalctl -u bot-hub -n 50 --no-pager

# .env prüfen
cat .env

# Node.js Version prüfen
node -v  # Sollte v22.x sein

# Docker prüfen
docker ps
docker network ls
```

### Port 80/443 bereits belegt

```bash
sudo netstat -tulpn | grep :80
sudo netstat -tulpn | grep :443

# Service beenden, der den Port belegt
sudo systemctl stop apache2  # Falls Apache läuft
```

### Docker-Netzwerk Probleme

```bash
cd deploy/discord-egress
docker compose down
docker compose up -d
docker logs bot-hub-discord-egress
```

### nginx Fehler

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo journalctl -u nginx -f
```

### Permission Errors

```bash
sudo chown -R bot-hub:bot-hub /opt/bot-hub
sudo chmod 700 /opt/bot-hub/data
sudo chmod 600 /opt/bot-hub/.env
```

---

## 📊 Performance Optimierung

### Memory Limits erhöhen (falls nötig)

```bash
# In .env:
BOT_HUB_CONTAINER_MEMORY=1g
BOT_HUB_CONTAINER_CPUS=2
```

### nginx Buffer erhöhen

```bash
sudo nano /etc/nginx/nginx.conf
```

```nginx
http {
    ...
    client_max_body_size 10M;
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
    proxy_busy_buffers_size 256k;
    ...
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 🔄 Update Strategie

### 1. Test-Environment Update

```bash
cd /opt/bot-hub-test
git pull
sudo -u bot-hub npm ci --include=dev
sudo -u bot-hub npm run build
systemctl restart bot-hub-test
```

### 2. Backup vor Update

```bash
/opt/backup-bot-hub.sh
```

### 3. Production Update

```bash
cd /opt/bot-hub
git pull
sudo -u bot-hub npm ci --include=dev
sudo -u bot-hub npm run build
systemctl restart bot-hub
systemctl status bot-hub
```

---

## 📞 Support

Bei Problemen:

1. Logs prüfen: `journalctl -u bot-hub -f`
2. Docker Logs: `docker logs bot-hub-discord-egress`
3. Sicherheitsstatus: Siehe SECURITY_STATUS_V26.md
4. GitHub Issues: <ihr-repo>/issues

---

## ✅ Deployment Checklist

- [ ] Server vorbereitet (Ubuntu/Debian)
- [ ] Domain auf Server zeigt
- [ ] deploy-full.sh ausgeführt
- [ ] .env konfiguriert
- [ ] Discord OAuth App erstellt
- [ ] HTTPS ist aktiv und Certbot-Erneuerung wurde geprüft
- [ ] Service läuft: `systemctl status bot-hub`
- [ ] HTTPS funktioniert: `https://ihre-domain.de`
- [ ] Discord Login funktioniert
- [ ] Firewall aktiv: `sudo ufw status`
- [ ] Backup-Skript eingerichtet
- [ ] Monitoring konfiguriert

---

## 🎉 Fertig!

Ihr Bot-Hub ist jetzt produktiv bereit!
