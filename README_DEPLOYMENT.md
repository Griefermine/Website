# 🚀 Bot-Hub Deployment - Schnellstart

## 📦 Was Sie jetzt haben

### 1. **deploy-full.sh** - Full Deployment Skript

Installiert automatisch ALLES:

- ✅ Docker & Docker Compose
- ✅ Node.js 22
- ✅ nginx (Reverse-Proxy)
- ✅ UFW Firewall
- ✅ fail2ban
- ✅ Docker-Netzwerk (bot-hub-discord)
- ✅ Host-Firewall
- ✅ Systemd Service
- ✅ Certbot/Let's Encrypt mit automatischem HTTPS und Zertifikat-Renewal
- ✅ Registry-Digests der Produktions-Container vor dem Start
- ✅ Verzeichnisse und Rechte

### 2. **setup-tls.sh** - TLS/HTTPS Setup

Richtet automatisch HTTPS ein:

- ✅ Let's Encrypt Zertifikat
- ✅ nginx HTTPS Konfiguration
- ✅ Auto-Renewal
- ✅ .env Aktualisierung

### 3. **DEPLOYMENT_GUIDE.md** - Umfassende Anleitung

Enthält alle Schritte und Troubleshooting.

---

## ⚡ 5-Minuten Deployment

### Voraussetzungen

- Ubuntu/Debian Server
- Root-Zugriff
- Domain-Name

### Schritt 1: Projekt auf Server kopieren

```bash
# Via Git
cd /opt
git clone <ihr-repo> bot-hub
cd bot-hub

# Oder via SCP
scp -r /local/path/bot-hub user@server:/opt/
```

### Schritt 2: Full Deployment ausführen

Stelle vorab sicher, dass die Domain per DNS auf den Server zeigt und TCP 80/443
von außen erreichbar ist. Das Skript fragt nach einer öffentlichen Domain und
einer E-Mail-Adresse für Let's Encrypt.

```bash
sudo bash deploy-full.sh
```

Das Skript installiert die Komponenten, richtet Certbot standardmäßig ein,
aktiviert HTTPS/HTTP→HTTPS, richtet die automatische Zertifikatserneuerung ein
und pinnt die Images vor dem Start auf Registry-Digests.

### Schritt 3: .env konfigurieren

```bash
nano .env
```

Minimal-Konfiguration:

```bash
DISCORD_CLIENT_ID=ihre-client-id
DISCORD_CLIENT_SECRET=ihre-client-secret
BOT_HUB_OWNER_IDS=ihre-discord-id
```

### Schritt 4: Service neu starten

```bash
systemctl restart bot-hub
```

### Schritt 5: TLS/HTTPS prüfen

TLS sollte bereits nach dem Deployment aktiv sein. Prüfe bei Bedarf:

```bash
sudo nginx -t
systemctl is-active certbot.timer
sudo certbot renew --dry-run
```

Für eine manuelle Neuausstellung/Neukonfiguration einer bestehenden Installation:

```bash
sudo bash setup-tls.sh ihre-domain.de admin@example.org admin@example.org
```

### Schritt 6: Discord OAuth abschließen

Trage anschließend die Discord-Client-ID, das Client-Secret und deine Owner-ID in
`.env` ein, registriere `https://ihre-domain.de/api/auth/discord/callback`
in der Discord Developer Console und starte den Hub neu.

### Schritt 7: Fertig!

Besuchen Sie: `https://ihre-domain.de`

---

## 📋 Skript-Details

### deploy-full.sh

**Was es tut:**

1. System-Update
2. Pakete installieren (curl, git, nginx, ufw, fail2ban)
3. Docker installieren
4. Node.js 22 installieren
5. Bot-Hub Benutzer erstellen
6. Projekt einrichten (npm ci, build)
7. Docker-Netzwerk einrichten (mit Host-Firewall!)
8. Systemd Service erstellen
9. Verzeichnisse und Rechte einrichten
10. UFW Firewall konfigurieren
11. TLS mit Certbot einrichten und Images auf Digests pinnen
12. Hub hinter HTTPS starten

**Verwendung:**

```bash
sudo bash deploy-full.sh
```

### setup-tls.sh

**Was es tut:**

1. certbot installieren
2. Port 80 prüfen
3. nginx für HTTP-only konfigurieren
4. Let's Encrypt Zertifikat beantragen
5. nginx für HTTPS optimieren
6. .env aktualisieren (HTTPS URLs)
7. Bot-Hub Service neu starten
8. Auto-Renewal einrichten

**Verwendung:**

```bash
sudo bash setup-tls.sh ihre-domain.de
```

---

## 🔒 Sicherheit

### Was automatisch eingerichtet wird:

✅ **Firewall (UFW)**

- Nur Ports 22, 80, 443 offen
- Alles andere geblockt

✅ **Docker-Isolation**

- Isoliertes Netzwerk (bot-hub-discord)
- Host-Firewall aktiv
- Docker-Socket nicht gemountet

✅ **nginx Security Headers**

- X-Frame-Options
- X-Content-Type-Options
- X-XSS-Protection
- HSTS (nach TLS Setup)

✅ **fail2ban**

- Brute-Force Schutz

✅ **Verzeichnisrechte**

- data/: 700
- secrets/: 700
- .env: 600

---

## 📝 Nach dem Deployment

### .env vollständig konfigurieren

```bash
nano .env
```

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
BOT_HUB_CONTAINER_IMAGES={"python":"python:3.12-bookworm@sha256:<digest>","javascript":"node:22-bookworm@sha256:<digest>"}
```

### Discord OAuth App konfigurieren

1. https://discord.com/developers/applications
2. Neue Application erstellen
3. OAuth2 Tab:
   - Redirect URI: `https://ihre-domain.de/api/auth/discord/callback`
   - Scopes: `identify`, `guilds`
4. Client ID und Secret in .env eintragen

### Service neu starten

```bash
systemctl restart bot-hub
systemctl status bot-hub
```

---

## 🧪 Testen

### Service Status

```bash
systemctl status bot-hub
```

### Logs prüfen

```bash
journalctl -u bot-hub -f
```

### HTTPS prüfen

```bash
curl -I https://ihre-domain.de
```

Sollte `200 OK` und `Strict-Transport-Security` Header zurückgeben.

### Docker prüfen

```bash
docker ps
docker network ls
```

Sollte `bot-hub-discord` Netzwerk zeigen.

---

## 🐛 Troubleshooting

### Service startet nicht

```bash
journalctl -u bot-hub -n 50 --no-pager
```

### nginx Fehler

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### Docker Probleme

```bash
cd deploy/discord-egress
docker compose down
docker compose up -d
docker logs bot-hub-discord-egress
```

### Permission Errors

```bash
sudo chown -R bot-hub:bot-hub /opt/bot-hub
sudo chmod 700 /opt/bot-hub/data
```

---

## 📊 Monitoring

### Echtzeit-Logs

```bash
journalctl -u bot-hub -f
```

### Docker Logs

```bash
docker logs bot-hub-discord-egress -f
```

### Firewall Status

```bash
sudo ufw status
```

### Service Neustart

```bash
systemctl restart bot-hub
```

---

## 🔄 Updates

### Projekt aktualisieren

```bash
cd /opt/bot-hub
git pull
sudo -u bot-hub npm ci --include=dev
sudo -u bot-hub npm run build
systemctl restart bot-hub
```

---

## 📚 Dokumentation

- **Sicherheitsstatus:** SECURITY_STATUS_V26.md
- **Deployment Guide:** DEPLOYMENT_GUIDE.md
- **Original Fixes:** SECURITY_FIXES_V10.md

---

## ✅ Deployment Checklist

- [ ] Server vorbereitet (Ubuntu/Debian)
- [ ] Domain auf Server zeigt
- [ ] deploy-full.sh ausgeführt
- [ ] .env konfiguriert
- [ ] Discord OAuth App erstellt
- [ ] HTTPS ist aktiv und Certbot-Erneuerung wurde geprüft
- [ ] Service läuft
- [ ] HTTPS funktioniert
- [ ] Discord Login funktioniert
- [ ] Firewall aktiv

---

## 🎉 Fertig!

Ihr Bot-Hub ist jetzt produktiv bereit mit:

- ✅ Automatischer Installation
- ✅ HTTPS/TLS
- ✅ Firewall
- ✅ Docker-Isolation
- ✅ Systemd Service
- ✅ Auto-Renewal

**Viel Erfolg!** 🚀
