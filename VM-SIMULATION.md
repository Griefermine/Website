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
 23. **Secrets nur noch verschlüsselt at-rest (Vault-Maßnahme)**:
     `data/secrets/*.env` (Bot-Discord-Tokens, DB-Passwörter) lagen im
     Klartext auf der Platte; das OAuth-Client-Secret stand in der `.env`,
     wovor der Hub beim Start selbst warnt. Neu: `server/vault.js`
     (AES-256-GCM-Umschläge `vault:v1:<iv>:<tag>:<ct>`, AAD = Schlüssel-
     name → kein Umschichten zwischen Einträgen; GCM-Tag → Manipulation
     wirft laut statt leer zu sein). `secrets.js` versiegelt beim Schreiben
     und entschlüsselt beim Lesen transparent – alle Aufrufer sehen wie
     bisher Klartext, alter Klartext bleibt lesbar. `bootstrapSecretVault`
     (Aufruf in `manager.js`) versiegelt beim Start alle Klartext-Reste und
     zieht `DISCORD_CLIENT_*` aus der Umgebung in den verschlüsselten
     `data/secrets/hub.env` um (Vault-Wert gewinnt gegen die Umgebung,
     `_FILE`-Indirektion in `auth.js` gewinnt gegen beides und verhindert
     Duplikate). Master-Key AUSSERHALB von `data/`: Produktion
     `BOT_HUB_KEY_FILE=/etc/bot-hub/master.key` (root:bot-hub 0640,
     deploy-full.sh erzeugt ihn), Entwicklung fällt auf
     `<projectRoot>/.secrets.key` zurück – existiert kein Key, bleibt das
     alte Klartext-Verhalten (Tests, Entwickler). Der Bot-Container sieht
     weiterhin nur seine gespritzten Umgebungsvariablen (Angriffskette
     „kompromittierter Bot liest data/" bleibt wirkungslos); ehrliche
     Grenze: Der Bot-Prozess muss sein eigenes Token nutzen können, und
     wer Hub-Prozess + Key-Datei komplett lesen kann, kommt weiter (dagegen
     hilft nur Festplattenverschlüsselung). Tests: `secrets-vault.test.js`.

 24. **Vault v2 + Session-Vault nach Red-Team-Runde**: Die Durchspiele-Runde
     fand zwei echte Schwachstellen (beide empirisch demonstriert, dann
     behoben): (a) v1-Umschläge banden als AAD nur den Schlüsselnamen – ein
     Umschlag aus `botA.env` ließ sich nach `botB.env` kopieren und entschlüsselte
     dort. v2 bindet Dateiname UND Schlüsselname (`vault:v2:`, AAD
     `id\u0000key`); v1 bleibt lesbar, `bootstrapSecretVault` hebt alle
     v1-Dateien beim Start auf v2. (b) `data/sessions.json` lag als Klartext
     in `data/` – eine Datenordner-Kopie war ein Login-Vorrat. Jetzt schreibt
     `auth.js` die Datei als einzelnen Vault-Umschlag (Altbestand wird beim
     ersten Load hochgezogen). Drittens dokumentiert: Das Simulations-VM
     nutzt Laptop-Swap (dm-2 + zram) – Seiten des Hub-Prozesses (Key-Material!)
     können unverschlüsselt den Datenträger erreichen; auf echtem VPS Swap
     deaktivieren oder verschlüsseln, Laptop: Full-DiskEncryption.
     Firewall-Prüfsummen: Key 0640 root:bot-hub, Gruppe leer; bot-hub darf
     Key weder überschreiben noch löschen noch den Ordner anzapfen
     (root:root 0755); www-data liest weder Key noch `.env` noch sessions
     noch Secrets; Bot-Container hat keine Host-Mounts, kein docker.sock,
     kein `/opt/bot-hub`; HTTP-Traversierung auf `master.key`/`.env` bleibt
     400/404/SPA-Fallback ohne Inhalt; Lateral-Tests mit echtem
     BOT_HUB_TOKEN: eigene Routes 200, fremde Bot-Ids 401, Rate-Feedback
     einheitlich 401.

 25. **MySQL-Anbindung hing sich in NAT-losen Umgebungen fest**: der
     Provisionierer verband sich auf `127.0.0.1:<publizierter Port>` – in der
     Simulations-VM setzt Docker die Port-NAT-Regeln aber nicht (DOCKER-Kette
     der nat-Tabelle leer), der Hub lief 180 s in `waitForAdmin` und der
     Dashboard-Port blieb 502. Fix: festes internes Netz
     (`BOT_HUB_MYSQL_NETWORK_CIDR`, Standard 172.30.252.0/24; n+1 Gateway,
     n+2 MySQL, n+3 phpMyAdmin) – Hub und Tests verbinden die statischen
     Container-Adressen. (Die Loopback-Publikation fiel später als leere
     Zusage ganz weg – Maßnahme 26.) Zweiter Fund aus demselben Durchlauf:
     ein Abbruch nach `docker create` hinterließ einen Container mit
     Init-Passwort, das der Neustart überschrieb → nie wieder reinkommen
     ohne Reset. Jetzt wird eine vorhandene `mysql-init.env` wiederverwendet,
     und ohne sie nennt der Hub den Grund samt `BOT_HUB_MYSQL_RESET=1` statt
     zu hungern. phpMyAdmin-Tests verbinden jetzt ebenfalls über das Netz
     (`mysql-container.test.js`).

**MySQL/phpMyAdmin in der Simulations-VM (Betriebsnotiz).** Die Anbindung
läuft über das feste interne Netz `172.30.252.0/24`: `.2` = MySQL, `.3` =
phpMyAdmin. Wegen der NAT-losen VM ist der Hinweis im Hub-Log
(`http://127.0.0.1:8081`) hier nicht benutzbar – von außen gilt stattdessen:

    docker exec bot-hub-vm curl -s http://172.30.252.3/        # Login-Seite
    docker exec bot-hub-vm bash -c 'mysql -h 172.30.252.2 …'   # (client ist
      nicht installiert; Zugangsdaten: data/secrets/db.env + phpmyadmin.env,
      transparent lesbar über readSecretValues als bot-hub)

Auf dem Hub-Host routet Docker ins interne Netz, phpMyAdmin liegt dort auf
`.3:80`. Von einem anderen Rechner: `ssh -L 8081:172.30.252.3:80 user@vps`
(kein 127.0.0.1-Hafen – die Veröffentlichung gibt es auf internen Netzen
nicht, Maßnahme 26). Anlegen/Reset:
`BOT_HUB_DB=mysql-container` + `BOT_HUB_PHPMYADMIN=1` in `.env`; für einen
sauberen Neuaufbau einmalig `BOT_HUB_MYSQL_RESET=1` setzen, Start abwarten,
Zeile **sofort wieder entfernen** (sondern löscht jeder Neustart alle
Bot-Speicher-Daten). Seit Maßnahme 25 läuft die Provisionierung auch unter
einem Root-Hub (Container dann als Image-Benutzer 999 statt Demotion).

 26. **phpMyAdmin/MySQL „nur Loopback“ war auf `--internal`-Netzen eine leere
     Zusage**: Die Container hingen am internen Netz UND sollten auf
     `127.0.0.1:<Hafen>` veröffentlichen. Docker richtet auf internen Netzen
     aber grundsätzlich keine Hafen-Weiterleitung ein – `docker port` bleibt
     leer, es horcht nichts. Der Hub-Log („http://127.0.0.1:8081“) und ein
     Integrations-Test, der genau diesen Loopback-Hörer verlangte, liefen damit
     ins Leere; in der NAT-losen Simulations-VM fiel es als
     `die Bindung ist nicht die erwartete (ist: "")` auf, ist aber kein VM-Artefakt,
     sondern Docker-Verhalten auf jedem Host. Fix: `--publish` für MySQL und
     phpMyAdmin entfernt (die Zusage trägt jetzt das interne Netz selbst, nicht
     eine Schleife), Hinweis/Log nennen die feste Netzadresse n+3, und die Tests
     prüfen jetzt die belastbare Aussage: gar kein Hafen (`docker port` und
     `HostConfig.PortBindings` leer) plus echter Kontakt nur über die
     feste Adresse. Der SSH-Tunnel-Weg bleibt, zielt aber jetzt auf die
     Netzadresse (`ssh -L 8081:<addr>:80 user@server`).

 27. **Admin-Wächter verwechselte „gestoppt“ mit „gelöscht“**: Der Prüfer, ob
     der phpMyAdmin-Benutzer existiert, lief vor dem Start des MySQL-Containers.
     Bei einem bloß entfernten oder gestoppten Container (Wartung,
     Signatur-austausch, Host-Umzug) ist die Datenbank schlicht nicht
     erreichbar – die Antwort „kann nicht rein“ wurde als „Benutzer fehlt,
     Reset empfohlen“ gelesen, und der Hub looppte mit
     Datenvernichtungs-Hinweis. Jetzt prüft der Wächter erst, wenn mysqld läuft
     (ortsgleich mit der Entscheidung), und eine intakte Anlage überlebt das
     Verschwinden ihres Containers ohne RESET. Live ausgelöst und bewiesen:
     Container von Hand entfernt → Korrektur gespielt → Hub rekonstruierte den
     Container und meldete „bereit“, Bot-Daten unversehrt.
 28. **Container-Neuanlage brauchte eine löchrige env-file**: Nach erfolgreicher
     Erst-Einrichtung löscht der Provisionierer seine Init-Datei (root-Passwort-
     reste) – doch `docker create --env-file` verlangt die Datei bei JEDER
     Anlage, auch bei längst eingerichteten Datenvolumina, wo ihr Inhalt
     bedeutungslos ist. Folge: derselbe Crash-Loop wie in 27 aus einem anderen
     Grund. Fix: bei Neuanlage über einem eingerichteten Volumen legt der
     Provisionierer eine Wegwerf-env-file an (0600, im Finally immer gelöscht);
     Fake-Modelle können das nicht fangen (sie erzwingen keine env-file), die
     Live-VM schon – Regressionstest hält immerhin das neue Verhalten fest.
 29. **Der Hub konnte seine eigenen Sprach-Presets nicht starten**: Rusts
     vorgegebener Startbefehl `./target/release/bot` ist ein Pfadprogramm –
     die Befehlsprüfung ließ als ausführbares Programm aber nur die
     Sprach-Runtime und die drei Build-Wrapper (`./gradlew` & Co.) zu. Folge:
     jeder Rust-Bot (und jedes Preset mit eigenem Binary) starb mit
     „Das Programm muss aus der freigegebenen Runtime stammen“, noch ehe der
     Container lief. Zwei Fehlerstellen: (a) die Prüfung erlaubte
     Workspace-Programme nicht beim Startzweck, (b) `execArgs` gab den
     Host-Pfad des Prüfers direkt an `docker exec` weiter, wo er nicht
     existiert. Fix: beim Zweck `start` ist jede ausführbare Datei im
     Workspace zulässig (identische Wachen: reguläre Datei, Ausführbit,
     `realpath` bleibt im Workspace – ein SymLink nach `/bin/sh` scheitert
     weiterhin); Bauen bleibt auf die Wrapper-Liste eng. `execArgs` bildet
     Host-Pfade jetzt auf `/workspace/…` ab, analog zum Paket-Runner.
     Regressionstests: drei in `commands.test.js`, zwei in
     `containers.test.js` (520/520 gesamt).
 30. **Go-Sumdb-Ablage lag auf der read-only-Rootfs**: Das golang-Bild setzt
     `GOPATH=/go`; `go get` verifiziert Modulsummen unter `/go/pkg/sumdb` und
     scheiterte dort mit „no such file or directory“ – jede Go-Anlage war
     damit baunfähig, obwohl `GOMODCACHE`/`GOCACHE` bereits in den Workspace
     zeigten. Fix: `GOPATH=/workspace/.cache/go` in Paket-Runner UND
     Bot-Container (die golang-Standardpfade bleiben als Cache-Ziele
     konsistent). Regressionstest prüft jetzt alle drei Go-Cache-Variablen.
 31. **Maven brauchte eine settings.xml – JVM-Props und Env fielen ins
     Leere**: Im DNS-freien Paketnetz wollte Maven `repo.maven.apache.org`
     selbst auflösen („Temporary failure in name resolution“), Java- und
     Kotlin-Bau unmöglich. Erst startskript-bedingt JAVA_TOOL_OPTIONS
     vermutet (MRELEASE-1073), dann per Probe auf dem Paketnetz bestätigt:
     Maven 3.9s Native-Transport ignoriert JVM-Proxy-Properties (MAVEN_OPTS
     und JAVA_TOOL_OPTIONS, selbst wenn die JVM sie pickt) UND
     HTTP(S)-PROXY-Variablen – einzig `-s settings.xml` wirkt. Fix: Der
     Paket-Runner schreibt `.bot-hub/maven-settings.xml` (nur interne
     Proxy-Adresse, keine Geheimnisse) in den Workspace und übergibt sie
     über `MAVEN_ARGS` (Maven ≥ 3.9.7), ohne Installations-Kommandos
     anzufassen. Regressionstest prüft Datei-Inhalt und MAVEN_ARGS.
 32. **Der Go-Modul-Cache blockierte die Bot-Löschung**: `go` legt seine
     Cache-Verzeichnisse bewusst mit Modus 0555 an – ohne Owner-Schreibbit
     scheitern dort unlink wie rmdir, und der `files`-Cleanup-Schritt des
     Löschens blieb mit EACCES stehen (DELETE 500, `cleanup_failed`,
     wiederholt am selben Punkt). Fix: vor `rmSync` öffnet ein beherzter
     Rundgang (`openDirsForRemoval`) allen Verzeichnissen im bereits
     validierten Bot-Ordner das Owner-Schreibbit – Symlinks werden nicht
     gefolgt, Tiefen über 64 Ebenen abgebrochen; Einzelpfade scheitern
     still, die rm-Spur meldet echte Fehler. Zwei Regressionstests
     (EACCES-Fall + Symlink-Nichtbefolgung). Nebenbefund aus demselben
     Lauf: die Härtung `nosuid,nodev` auf dem Workspace-Bind lehnt dieser
     Docker-Daemon für `--volume` ab („invalid mode“) und blieb daher aus –
     wirkungslos ohnehin, da alle Container `no-new-privileges` +
     `cap-drop ALL` tragen.
 33. **JDA-Proxy: `WebSocketFactory.setProxy` existiert nicht** – der
     Matrix-Java-Bau scheiterte mit „cannot find symbol“. Per javap am
     echten Jar (nv-websocket-client 2.14, JDA 5.0.0-beta.13) verifiziert:
     Die API heißt `factory.getProxySettings().setServer(host).setPort(port)`
     (HTTP-CONNECT), REST separat via `setHttpClientBuilder(OkHttpClient…
     .proxy(java.net.Proxy))`; einen `GatewayProxyBuilder` gibt es in
     beta.13 nicht mehr. Harness (Java + Kotlin) accordingly berichtigt –
     lokaler javac-Smoke-Test gegen die Original-Jars ist grün.
 34. **Docker erzwingt `noexec` auf jedem `--tmpfs`** – selbst wenn man nur
     `rw,nosuid` übergibt, mountet der Daemon `nodev,noexec` dazu (im
     Vergleichscontainer per /proc/mounts belegt). `go run` baut seine
     Binary nach /tmp und starb dort mit „fork/exec …: permission denied“.
     Fix: `TMPDIR`/`GOTMPDIR` zeigen jetzt in den ausführbaren Workspace
     (`.cache/tmp`), der Ordner wird beim Planen von Bot-Start und
     Paket-Runner vorgelegt. Regressionstests prüfen beide Env-Dateien.
 35. **NuGets „NuGet-Migrations“-Mutex kann in dieser Laufzeit nie
     gelingen**: Erster Verdacht (Capabilities/seccomp/IPC) widerlegte sich
     per Gegenprobe – selbst `seccomp=unconfined` + `--ipc host` änderte
     nichts. Der wahre Grund, aus dem .NET-Runtime- und NuGet-Quellcode
     belegt: .NET 8s benannte Mutexe sind eine reine Prozess-Tabelle, aber
     NuGet übergibt den Namen ohne führenden Slash; die Laufzeit mappt ihn
     auf das Windows-Gerät `/dev/Null→NuGet-Migrations` → ENXIO, der
     Konstruktion wirft immer. Vor jedem Restore hilft nur, den
     Migrations-Marker `$XDG_DATA_HOME/NuGet/Migrations/1` vorzuhalten
     (existiert er, ist der Läufer no-op) – zusätzlich zu den
     Erststart-Sentinels des Bildes (Punkt 1, sonst crasht vorher schon der
     CLI-Konfigurator). Ein interner root-Lauf `ensureDotnetCliHome` legt
     beides vor dem ersten Build an und `chown`t auf den
     Workspace-Eigentümer; `XDG_DATA_HOME`/`DOTNET_CLI_HOME` zeigen in den
     Workspace. Gegenprobe im Paket-Netz: „Restored Bot.csproj (7 s)“ ✓.

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

## Secrets-Vault betreiben (Maßnahme 23)

Aktivierung in der VM (einmalig, als root im Container):

```
docker exec bot-hub-vm bash -c '
  umask 077
  node -e "process.stdout.write(require(\"crypto\").randomBytes(32).toString(\"hex\")+\"\n\")" > /etc/bot-hub/master.key
  chmod 640 /etc/bot-hub/master.key && chown root:bot-hub /etc/bot-hub/master.key
  grep -q "^BOT_HUB_KEY_FILE=" /opt/bot-hub/.env || printf "\nBOT_HUB_KEY_FILE=/etc/bot-hub/master.key\n" >> /opt/bot-hub/.env
  systemctl restart bot-hub'
```

Danach beim Hub-Start im Journal (`journalctl -u bot-hub -b | grep vault`):
„Secret-Datei(en) in den Vault verschlüsselt" und „Auth-Werte … umgezogen".
Prüfen, dass nichts mehr im Klartext liegt (die Datei darf den Token nicht
mehr enthalten, `vault:v1:` muss drinstehen):

```
docker exec bot-hub-vm grep -cE "vault:v[12]:" /opt/bot-hub/data/secrets/*.env
```

**Pflicht: Master-Key sichern.** Ohne `/etc/bot-hub/master.key` sind alle Vault-Umschläge unwiederbringlich verloren (AES, kein Backdoor-Zugang). Backup: `docker exec bot-hub-vm cat /etc/bot-hub/master.key` in einen Passwortmanager (außerhalb der VM) legen; niemals ins Repo (`*.key` ist gitignoret). Danach aufräumen: Nach dem Umzug können `DISCORD_CLIENT_SECRET` (und `DISCORD_CLIENT_ID`, `DISCORD_REDIRECT_URI`) aus `/opt/bot-hub/.env` gelöscht werden – der Hub liest sie jetzt aus `data/secrets/hub.env`. Funktionstest danach: `curl -sk -o /dev/null -w "%{http_code}" https://127.0.0.1/api/auth/discord/login` muss 302 liefern (beide Werte aus dem Vault aufgelöst).

Rollback: Die `BOT_HUB_KEY_FILE`-Zeile kann nur entfernt werden, solange noch keine Umschläge geschrieben wurden – sobald Werte versiegelt sind, ist der Key zum Lesen zwingend nötig.


## Sprach-Matrix: alle unterstützten Sprachen live prüfen

`tools/language-matrix.mjs` legt pro Sprache (Python, JavaScript, TypeScript,
Java, Kotlin, Go, C#, Rust, Sonstiges) einen Testbot an, startet ihn und
prüft drei Beweise: Discord-Gateway-Login (Logzeile `READY <sprache>`),
KV-Schreiben über `PUT /api/hub/db/matrix/probe:<sprache>` und Panel-
Lebenszeichen (`POST /api/hub/state`). Bots laufen **seriell** – ein
Discord-Token verträgt keine gleichzeitigen Sitzungen. Der Test-Token wird
nur über die Umgebungsvariable `DISCORD_TEST_TOKEN` übergeben (landet als
`secretEnv` im Vault, wird nie gedruckt).

```
# einmalig: Bilder vorziehen, damit die Matrix nicht an langen Pulls hängt.
# Die VM-Docker-Daemons pullen über das systemd-Drop-in-Proxy (Squid 3128);
# stabile Referenzen sind die Digests aus docker inspect der Hub-Images:
#   docker exec bot-hub-vm docker pull <name>@sha256:<digest>
DISCORD_TEST_TOKEN=$(cat /tmp/opencode/.discord_test_token) \
BOT_SESSION=<id aus data/sessions.json> \
node tools/language-matrix.mjs                 # alle Sprachen
# --only=go,csharp | --keep | --list | --cleanup
# --signature: lege meinen Auswahl-Bot „Kommandante“ (Go, /status mit KV-Zähler) an
```

KV-Nachweis direkt in MySQL (während des Laufs – Zeilen fallen mit dem Bot):

```
# /tmp/opencode/kv-check.sh in die VM kopieren; das Passwort wird darin aus
# dem Vault (db/BOT_HUB_DB_PASSWORD) gelöst, der mysql-Client läuft im
# Container bot-hub-mysql (im VM-Host selbst ist kein mysql installiert):
docker exec bot-hub-vm bash /tmp/kv-check.sh
# Kern der Abfrage: SELECT … FROM bot_hub.bot_store WHERE collection IN
# ('matrix','commander')   – Datenbank heißt bot_hub, Tabelle bot_store.
```

Besonderheiten beim Bot-Code (alle vom Hub gesetzt, nur vom Bot-Code zu
nutzen): Discord geht im Bot-Netz **nur über den Squid-CONNECT-Proxy**
(`HTTPS_PROXY`/`BOT_HUB_DISCORD_PROXY`): discord.py `proxy=`, discordgo
`Dialer.Proxy`, JDA beta.13 hat KEIN `setDefaultProxy` mehr – Gateway über
`WebSocketFactory.setProxy`, REST über `setHttpClientBuilder(OkHttpClient…)` –
Achtung: der Factory-Proxy heißt `getProxySettings().setHost(…).setPort(…)`
(nackte Hosts; `setServer(String)` will eine URI und setzt still leer);
.NET: Env-Proxy wird ignoriert, Discord.Net 3.x verlangt explizit
`DefaultRestClientProvider.Create(true, proxy)` +
`DefaultWebSocketProvider.Create(proxy)`; Rust manuell CONNECT + rustls –
der dortige „tls handshake eof“ war KEIN rustls-/Post-Quantum-Problem
(Gegenproben mit identischer Config handshakten durch denselben Squid),
sondern eine Escape-Falle: aus JS-Template-Literalen geschriebenes
einfaches `\r\n` wird zu ECHTEN CRLFs im Rust-Quelltext, und rustc
normalisiert CRLF in String-Literals zu LF – der Bot sandte ein
LF-only-CONNECT, das Squid mit 200 beantwortete, OHNE auf Tunnel zu
schalten. Vorlagen daher immer mit doppelten Backslashes (`\\r\\n`)
schreiben; ein lokaler Sink-Proxy (HTTP 200 + Byte-Dump) überführt solche
Fälle in Minuten. Die
Hub-API (`BOT_HUB_URL`) ist davon ausgenommen (`NO_PROXY`).

**discord.js-Falle (Bibliotheks-, kein Hub-Fehler):** 14.27 verbindet den
Gateway im WS-Worker über `globalThis.WebSocket` (undici) – ohne jede
Agent-Unterstützung; `ws.agent`-Optionen verpuffen, die Verbindung stirbt
lautlos mit Close-Code 1006 (kein DNS im Bot-Netz). Der Harness startet JS/TS
darum über einen Boot-Shim (`ws-boot.cjs`/`ws-boot.mts` – auf .ts endet der
tsx-Transform mit Top-Level-Await-Fehler, nur .mts läuft als ESM), der VOR dem Laden
der Bibliothek die Module auf der Platte patcht (und damit Main-Thread und
Worker erwischt): undici-Zweig abgeschaltet, `ws` der
`HttpsProxyAgent` untergeschoben. Tückischster Teil: der `ws`-Wrapper muss
seine Selbstreferenz auf sich selbst umbiegen (`ProxyWebSocket.WebSocket =
ProxyWebSocket`), denn ESM-Named-Import `{ WebSocket } from 'ws'` liest
`module.exports.WebSocket` – die kopierte Original-Klasse hätte den
undici-Pfad trotz Patch wieder offen gelassen. Diskussionswürdig für
upstream: Proxy-Doku von discord.js aktualisiert sich nicht zu
@discordjs/ws 1.x.

„Sonstiges“ (ubuntu-Basis, kein Python/Node, kein apt-Archiv
im Paketnetz) beweist nur die Hub-Schiene per `/dev/tcp` – Discord ist damit
in dieser Sprache realistisch nicht prüfbar. Rust nutzt bewusst ein
schlankes Cargo-Setup (`tokio-tungstenite` + rustls) statt Serenity: der
Serenity-Bau wäre in der VM (2 CPU) ein 20-Minuten-Monster; die Schiene
(Cargo-Build → Workspace-Binary → Start) ist identisch geprüft.

**Bug 29** (siehe Bug-Liste) war Voraussetzung: ohne ihn startet kein
Rust-Preset-Bot.
