# 🖥️ Bot-Hub „VPS-Simulation" per Docker (lokal auf dem Laptop)

Da kein Root-Server verfügbar ist, wird ein echter Cloud-Server als
**Ubuntu-24.04-Container mit systemd** simuliert. Darauf läuft das
unveränderte `deploy-full.sh` – exakt wie auf einem VPS.

Image-Bau: `/tmp/opencode/bot-hub-vm/Dockerfile`

## Container starten (falls gelöscht)

```bash
cd /tmp/opencode/bot-hub-vm
docker build -t bot-hub-vm:latest .
docker run -d --name bot-hub-vm --hostname bot-hub-vm \
  --privileged --cgroupns=host \
  --tmpfs /run --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -p 127.0.0.1:8080:80 -p 127.0.0.1:8443:443 -p 127.0.0.1:2222:22 \
  bot-hub-vm:latest
```

Projekt hinüberkopieren (wie `scp` auf einen echten Server):

```bash
cd ~/WebstormProjects/untitled
docker exec bot-hub-vm mkdir -p /opt/bot-hub
tar --exclude=node_modules --exclude=.git --exclude=dist \
    --exclude=data --exclude=release --exclude=.idea --exclude=bots \
    -cf - . | docker exec -i bot-hub-vm tar -xf - -C /opt/bot-hub
```

Deployment starten:

```bash
docker exec -d bot-hub-vm bash -c \
  'cd /opt/bot-hub && DEBIAN_FRONTEND=noninteractive bash deploy-full.sh > /var/log/deploy-full.log 2>&1'
```

## Alles Wichtige auf einen Blick

| Was | Befehl / Adresse |
|---|---|
| Deploy-Fortschritt | `docker exec bot-hub-vm tail -f /var/log/deploy-run9.log` |
| **Bot-Hub im Browser** | **https://localhost:8443** (Self-Signed → Zertifikatswarnung mit „Fortgeschritten → fortfahren" bestätigen) |
| HTTP-Variante (nur Redirect) | http://localhost:8080 |
| SSH in die VM | `ssh root@localhost -p 2222` (Passwort: `vmdemo`) |
| Hub-Status (in der VM) | `systemctl status bot-hub` |
| Hub-Logs (in der VM) | `journalctl -u bot-hub -f` |
| VM stoppen / starten | `docker stop bot-hub-vm` / `docker start bot-hub-vm` |
| VM löschen | `docker rm -f bot-hub-vm` |

## Bekannte Grenzen der Simulation

- **Nur localhost:** Die VM ist absichtlich nur am Laptop erreichbar
  (Ports sind auf `127.0.0.1` gemappt). Kein öffentliches Internet.
- **Discord-Login:** Läuft über das eingerichtete Self-Signed-TLS:
  nginx-443-Block in `/etc/nginx/sites-available/bot-hub` (Zertifikate in
  `/etc/nginx/ssl/`), `.env` setzt `BOT_HUB_URL=https://localhost:8443` und
  `DISCORD_REDIRECT_URI=https://localhost:8443/api/auth/discord/callback`
  (im Discord Developer Portal hinterlegt). Login-Flow: Hub-Seite öffnen →
  „Mit Discord einloggen" (nie die Discord-URL direkt aufrufen – der
  PKCE-State kommt sonst nicht zustande).
- **Kein 24/7:** Der Hub schläft, wenn der Laptop schläft. Für
  Dauerbetrieb bleibt ein VPS (z. B. Hetzner ~4 €/Monat) oder ein
  Heimserver die richtige Wahl.
- **Docker-in-Docker:** Die Bot-Container laufen in der *internen*
  Docker-Instanz der VM, sauber getrennt vom Laptop-Docker. Nach einem
  `docker start bot-hub-vm` zuerst `systemctl start docker` in der VM
  (apt/policy-rc.d verhindert den Autostart im Container).

## Gefundene und behobene Deployment-Bugs

1. **`npm ci --production`** ließ Vite fehlen → Build-Abbruch. Fix: `--include=dev`.
2. **`useradd -r` ohne Home-Verzeichnis** → npm-Cache `EACCES`. Fix: Home wird
   im Skript angelegt.
3. **Relative `$(dirname "$0")`-Pfade** in `setup-ubuntu-debian.sh` nach `cd`
   → `cannot stat './apply-docker-egress.py'`. Fix: absolutes `SCRIPT_DIR`.
4. **Docker 25+ entfernt das Info-Feld `.IPv6`** → Egress-Hook
   „Docker-IPv6-Status lässt sich nicht sicher bestimmen". Fix:
   `detect_ipv6()` liest `EnableIPv6` vom Bridge-Netz (Fallback: altes
   `docker info`) + Warten auf den Daemon-Start (ExecStartPost-Race).
5. **iptables-nft-Backend (Ubuntu 22.04+) verbietet mehrfache `-o`/`-i`-Flags**
   → „multiple -o flags not allowed". Fix: Egress-Ketten in Einzelregeln
   aufgelöst (identische Semantik); `--check` ignoriert jetzt die
   `-N`-Deklarationszeile von `iptables -S`.
6. **`before6.rules` nutzt `ufw6-`-Ketten** → Ankersuche in
   `update-ufw-rules.py` scheiterte immer. Fix: IPv6-Datei bekommt
   `ufw6-before-output`-Anker und -Regeln.
7. **`deploy-full.sh` rief das Egress-Setup ohne `--enable` auf** → ohne
   aktives UFW bricht `setup-ubuntu-debian.sh` bewusst vor dem Anlegen der
   Bot-Netzwerke ab (`exit 0`), der Hub fand in Produktion kein
   `bot-hub-discord`-Netz und verweigerte den Start. Fix: `--enable`.
8. **Doppelte Firewall-Hoheit**: Step 9 von `deploy-full.sh` setzte ein
   pauschales `ufw allow 22/tcp` (Anywhere) – der Eingangs-Audit des
   Egress-Setups erlaubt aber bewusst nur 80/443 plus SSH aus der
   erkannten Admin-Gegenstelle → Setup brach mit „weitere eingehende
   Freigaben" ab. Fix: Step 9 verifiziert nur noch und ergänzt die
   audit-festen Ports 80/443; die UFW-Hoheit liegt beim Egress-Setup.
9. **Audit-Logik in `check-host-firewall.py`**: eine *leere*
   `ssh-management.allow` (Konsolen-Installation ohne SSH-Sitzung) ließ den
   Audit bei jedem Re-Run scheitern (`exists() and expected is None`).
   Fix: nur eine Datei mit unlesbarem Inhalt blockiert jetzt; leer bedeutet
   bewusst „keine Admin-SSH-Freigabe".
10. **`check-host-firewall.py` war Legacy-iptables-only**: (a) `output_guard`
    hardcodierte die v4-Kette `ufw-before-output` – die ip6tables-Tabelle
    heißt dort aber `ufw6-before-output`, der v6-Guard scheiterte immer;
    (b) das nft-Backend (Standard ab Ubuntu 22.04) gibt Regel-Token in
    kanonischer Reihenfolge aus und wiederholt `-m tcp`/`-m udp` – der
    exakte Token-Vergleich schlug daher auch bei v4 fehl. Fix:
    `normalize_rule()` (implizite Protokoll-Matches entfernen, Token
    sortieren; Regel-Reihenfolge bleibt geprüft) + Kettenname je Familie.
11. **`bot-hub`-User ohne Docker-Gruppenmitgliedschaft**: Der Dienst
    validiert in Produktion die Egress-Netzwerke per `docker network
    inspect` – ohne Gruppenrecht bringt er „Docker-Netz bot-hub-discord
    fehlt" (obwohl das Netz existierte). Fix: `usermod -aG docker bot-hub`
    in `deploy-full.sh`.
12. **Setup ohne `--hub-user` aufgerufen**: die sudoers-Regel für den
    Root-Firewall-Prüfer wurde nie geschrieben → der Hub durfte
    `bot-hub-host-firewall-check` nicht ausführen und verweigerte den
    Start. Fix: `--enable --hub-user bot-hub` in `deploy-full.sh`.
13. **`server/containers.js` verglich `command === 'sudo'` mit dem
    absoluten Pfad `/usr/bin/sudo`** → matchte nie, das nackte `sudo` lief
    ohne Argument (nur Usage-Text) und die Firewall-Prüfung scheiterte
    immer. Fix: `asRoot`-Variable, Argumente korrekt zugeordnet.
14. **`squid.conf`: `dstdomain foo.com` matched in Squid 5 NICHT die
    Subdomains** (führender Punkt nötig, empirisch mit 5.7 verifiziert) →
    `registry-1.docker.io`, `gateway.discord.gg`, `deb.debian.org` usw.
    wurden alle verweigert. Fix: alle `dstdomain`-ACLs auf `.domain`
    umgestellt + Kommentar korrigiert.
15. **`acl private_ipv6 dst ... ::ffff:0:0/96 ...`**: Der IPv4-mapped-Bereich
    trifft bei Squid **jede IPv4-Adresse** → `http_access deny private_ipv6`
    blockierte fast das gesamte Internet durch den Proxy. Fix:
    `::ffff:0:0/96` entfernt (echtes IPv4 deckt `private_ipv4` ab).
16. **systemd-Unit ohne `EnvironmentFile`**: Der Hub lädt `.env` nicht
    selbst (kein dotenv), Discord-Credentials/`BOT_HUB_URL`/Digest-Pins
    aus der `.env` wurden ignoriert. Fix: `EnvironmentFile=-…/.env` im
    Unit + JSON-Werte in der `.env` einfach hochkommagiert (systemd
    frisst doppelte Anführungszeichen).
17. **nginx `proxy_set_header Host $host` schluckt den Port**: hinter dem
    Reverse Proxy sah der Hub `Host: localhost` statt `localhost:8443`;
    sein Origin-Abgleich verwarf daher jede CORS-Last (module-Skripte und
    `crossorigin`-Stylesheets senden `Origin`) mit 403 → Seite unstyled,
    „Verbinden …" eingefroren. curl zeigt das nie (sendet kein Origin).
    Fix: `$http_host` in `deploy-full.sh` und `setup-local-tls.sh`.
 18. **Bot-Keep-alive hieß `tail tail -f /dev/null`**: in
     `containerCreateArgs` stand nach `--entrypoint tail` zusätzlich noch
     `tail` als erstes Argument → jeder Bot-Container meldete
     `tail: cannot open 'tail'` im Log. Fix: überflüssiges `tail`-Argument
     entfernt (`server/containers.js`).
 19. **Sessions nur im RAM**: jeder Hub-Neustart loggte alle Benutzer aus
     (401 auf `/api/events` direkt nach Restart). Fix: Persistenz in
     `data/sessions.json` (0600, tmp+fsync+rename wie `access.json`),
     `configureSessionStore()` in `manager.js`; verdrahtet bei Login,
     Logout, Ablauf und Cleanup.
 20. **Falscher HINWEIS im Produktionsmodus**: `index.js` warnte vor dem
     fehlenden `BOT_HUB_CONTAINER_URL`, obwohl Produktions-Bots automatisch
     die private Hub-API (`172.30.250.1:8788`) bekommen – und der empfohlene
     Wert hätte den Hub-Start sogar abbrechen lassen
     (`validateProductionBotNetwork` sperrt die Variable). Fix: Warnung
     nur noch außerhalb von `NODE_ENV=production`.
 21. **Bot-Vorlage ignorierte `HTTPS_PROXY`**: der Hub spritzt dem
     Bot-Container `HTTPS_PROXY`/`BOT_HUB_DISCORD_PROXY` (Squid) und
     `NO_PROXY` (Hub-Gateway) ein, aber das python-echo-Template baute
     `commands.Bot(...)` ohne Proxy → Direktversuch, DNS gibt es im
     isolierten Bot-Netz bewusst nicht →
     `ClientConnectorDNSError: discord.com`. Fix: Template liest
     `HTTPS_PROXY` und übergibt es als `proxy=` an discord.py.
     Daneben: `hub_link: callback fehlgeschlagen (400)` war korrektes
     SSRF-Verhalten – im Container-Betrieb erlaubt der Hub nur extern
     freigegebene HTTPS-Ziele (`--callback-host` beim UFW-Setup, keine
     IPs/Loopback/privat). Das Template registriert den Loopback-Callback
     jetzt nur noch außerhalb des Container-Betriebs.
 22. **Panel-Brücke „Failed to fetch" (Preflight)**: Der ausgelieferte
     Bridge-Code (`BRIDGE_SOURCE` in `panel.js`) sendete
     `credentials: 'include'`; die Panel-Route antwortet wegen
     Null-Origin-Sandbox aber bewusst ohne `access-control-allow-credentials`
     (Header-Token-Auth, keine Cookies – siehe `applyCors`). Brave blockte
     daher jede Panel-API-Last. Fix: `credentials: 'omit'` in der Bridge.
     Achtung bei Änderungen an `BRIDGE_SOURCE`: Es ist ein Template-Literal –
     Backticks im Text zerstücken den String (erst `node --check`!).

### Betriebslehre

* **Startordner schlägt Datei-Editor**: Hat ein Bot einen Startordner,
  synchronisiert der Hub beim Start `startordner/` → `workspace/`
  (`start-sync.json` mit Größe + SHA-256 pro Datei). Direkt ins Workspace
  kopierte Dateien sind damit nach dem nächsten Start weg. Richtig patchen:
  beide Kopien ersetzen und den Hash-Eintrag in `start-sync.json`
  aktualisieren (Größe, sha256, `stand`; Kompakt-JSON, Mode 0600).
* Hub-Neustart nie parallel zum Bot-Start: ein mittendrin abgebrochenes
  `docker create/start` hinterlässt einen Container ohne Netzwerk-Endpoint
  (`EndpointID` leer, kein IP). Symptom: Bot-Container „Up“, aber keine
  Discord-Connection. Heilt: Container löschen und im Hub neu starten.
* Verbindungstest aus dem Bot-Netz (DNS-Scheitern ist Absicht, Auflösung
  passiert im Proxy per CONNECT): `docker run --rm --network
  bot-hub-discord <Bot-Image> python3 -c "import socket;
  print(socket.create_connection(('172.30.250.1', 8788), 4))"` – auch
  Port 3128 (Squid) testen.

## Digest-Pinning der Bot-Images (Produktions-Pflicht)

Der Hub startet in Produktion nur, wenn alle Bot-Images per `@sha256:`-
Digest festgelegt sind (`BOT_HUB_CONTAINER_IMAGES`, JSON-Mapping pro
Sprache). Die Digests holt man ohne Image-Download über die Registry-API:

```
docker manifest inspect -v python:3.12-bookworm \
  | python3 -c 'import json,sys; j=json.load(sys.stdin); print((j if isinstance(j,dict) else j[0])["Descriptor"]["digest"])'
```

Das setzt voraus, dass der Docker-Proxy-Listener die Registry-Domains
durchlässt (siehe Bugs 14/15). In der VM sind die Digests aktuell in
`/opt/bot-hub/.env` gesetzt; bei Tag-Aktualisierungen neu holen.

## Live-Watch (Fehler-Sensor)

In der VM läuft der systemd-Dienst `live-watch`, der laufend sammelt:
HTTP-4xx/5xx (nginx), Hub-Journal-Fehler, Squid-Verweigerungen
(`TCP_DENIED`), nginx-Fehlerlog und innere Docker-Events.

```
docker exec bot-hub-vm cat /var/log/live-watch.log     # Ereignisse ansehen
docker exec bot-hub-vm systemctl restart live-watch    # Log zurücksetzen
```

(Fingerabdruck des letzten Events ist der Zeitstempel im Eintrag.)
