# Bot-Hub im WLAN und Internet bereitstellen

Der Hub und die Vite-Entwicklungsserver lauschen standardmäßig nur lokal (`127.0.0.1`). Dadurch werden sie weder im WLAN noch versehentlich im Internet veröffentlicht. LAN-Zugriff wird nur ausdrücklich eingeschaltet; im Internet ist ausschließlich der TLS-Reverse-Proxy erreichbar.

## WLAN

1. Lege eine lokale `.env` aus `.env.example` an und setze für den gebauten Hub `HOST=0.0.0.0`. Für `npm run dev` zusätzlich `VITE_HOST=0.0.0.0` setzen. Das öffnet die Entwicklungsserver im LAN; setze es danach wieder auf `127.0.0.1`.
2. Baue und starte die Anwendung mit `npm run build` und `npm start`.
3. Ermittle die LAN-Adresse des Rechners (`hostname -I` unter Linux) und öffne auf einem anderen WLAN-Gerät `http://<LAN-IP>:8787`.
4. Falls eine Host-Firewall aktiv ist, erlaube eingehendes TCP für den Hub-Port **nur aus dem lokalen Netz**. Nie diesen Port im Router weiterleiten.

`npm run dev` ist standardmäßig nur lokal erreichbar. Für WLAN-Entwicklung `VITE_HOST=0.0.0.0` setzen; die API wird dabei lokal an den Hub auf Port `8787` weitergereicht. Für den normalen Betrieb ist der gebaute Hub auf einem einzelnen Port vorzuziehen.

## Internetzugriff

Nur der TLS-Reverse-Proxy soll von außen erreichbar sein. Eine Portweiterleitung auf `8787` veröffentlicht ein Verwaltungs- und Bot-Ausführungssystem unverschlüsselt. Caddy oder Nginx auf demselben Rechner terminiert HTTPS und leitet intern an Loopback weiter:

```
Internet → Router: TCP 80/443 → Reverse-Proxy:80/443 → 127.0.0.1:8787
```

Im Router nur **TCP 80 und TCP 443** auf die feste DHCP-Reservierung bzw. LAN-IP des Proxy-/Hub-Rechners weiterleiten. TCP 80 wird für Weiterleitung und automatische Zertifikatsausstellung gebraucht; wenn du DNS-Challenges nutzt, kann es geschlossen bleiben. Port `8787`, der interne Bot-API-Port `8788`, Vite (`5173`), MySQL (`3306`/`3307`), phpMyAdmin (`8081`) und SSH nicht ins Internet weiterleiten. Die Host-Firewall sollte dieselben Eingangsports beschränken. Für eine eigene Domain muss deren DNS auf die öffentliche IP des Anschlusses zeigen; bei wechselnder IP ist Dynamic DNS nötig.

Setze für die öffentliche Adresse mindestens diese Werte in der echten `.env` bzw. im Dienst. Für den Betrieb des Hubs ist außerdem ein eigener, unprivilegierter Linux-Benutzer und aktivierter Containerbetrieb erforderlich; die Produktionsprüfung verweigert sonst den Start:

```
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
BOT_HUB_URL=https://hub.deine-domain.example
DISCORD_REDIRECT_URI=https://hub.deine-domain.example/api/auth/discord/callback
BOT_HUB_SECURE_COOKIES=1
```

Der Hub verweigert in `production` den Start, wenn `HOST` nicht auf Loopback zeigt. So kann eine versehentliche Router-Weiterleitung von Port `8787` den unverschlüsselten HTTP-Backend-Port nicht veröffentlichen. Für WLAN-Zugriff ebenfalls den TLS-Proxy und die HTTPS-Adresse nutzen.

Produktions-Bots laufen im internen Docker-Netz `bot-hub-discord`; parallele Paket-Installer nutzen `bot-hub-dependencies`. Beide Bridges schalten direkte Container-zu-Container-Verbindungen ab. Das Ubuntu-/Debian-Setup erstellt die Netze; der Hub verweigert den Start, wenn Peer-Isolation fehlt. Bei einem Upgrade von der älteren Netzkonfiguration müssen Hub und Bots gestoppt sowie alte Bot-Container und Bridges entfernt werden, bevor das Setup erneut ausgeführt wird. Squid läuft im Host-Netz und lauscht ausschließlich an den privaten Bridge-Gateways `172.30.250.1:3128` und `172.30.251.1:3128`. Die Host-Firewall erlaubt dort nur die jeweiligen Proxy-Verbindungen; sonstige Zugriffe auf Host-Dienste werden verworfen. Squid erlaubt Bots nur HTTPS auf TCP 443 zu `discord.com` und `discord.gg`, Installern nur zu den Paket-Registries; private Zieladressen werden gesperrt. Für interne Status- und Panel-Aufrufe gibt es zusätzlich den Hub-Port `8788` am Bot-Gateway. Die Einrichtung samt Host-Firewall liegt unter `deploy/discord-egress/`.

Benötigt ein Bot beim Einrichten Pakete, lädt der Hub sie in einem separaten,
kurzlebigen Container herunter. Dieser hat nur den Workspace, keine
Bot-Secrets und Zugang zu einer Domain-Allowlist für npm, PyPI, Maven/Gradle,
Go, crates.io und NuGet. Das Paketnetz ist intern und gegen Host-Dienste
gesperrt. Der normale Bot-Container wird nie daran angeschlossen und behält
auch nach der Installation ausschließlich den Discord-Ausgang. Nicht
freigegebene Paket-CDNs oder Git-Repositories sind absichtlich blockiert.
Paketmanager und Pakete können beim Installieren fremden Code ausführen; der
Installer bekommt deshalb keine Bot-Secrets. Prüfe und vertraue den Paketen,
die du installierst. Der Proxy kann HTTPS-CONNECT nach Ziel-Domain filtern, aber
keine URL-Pfade oder TLS-Inhalte prüfen; Installationscode kann daher weiterhin
auf Dateien des eigenen Workspace zugreifen.

### Ubuntu/Debian-Server mit UFW

Das Skript richtet UFW, gefilterte Host-Proxys und Docker-Egress-Regeln ein.
Docker Engine, Docker Compose v2 und ein fertiger Hub-/Reverse-Proxy-Dienst
müssen bereits installiert sein. Das installiert nicht die Hub-Anwendung, TLS,
DNS oder die Router-Portweiterleitung. Das Setup startet Docker neu; laufende
Container werden dabei unterbrochen. Den Hub-Dienst nach dem Setup ebenfalls
neu starten.

Zuerst Regeln vorbereiten, ohne eine inaktive Firewall einzuschalten:

```sh
sudo ./deploy/discord-egress/setup-ubuntu-debian.sh
```

Das Skript setzt UFW auf eingehend und ausgehend verweigern, ergänzt TCP 80/443
und setzt eine frühe Ausgangssperre vor die normalen UFW-Regeln. Nur Squid (UID 13) darf DNS und TCP 443 direkt erreichen. Hub und Caddy gehen über den
Loopback-Proxy `127.0.0.1:3129` (Discord, ACME und freigegebene Callbacks),
Docker-Image-Downloads über `127.0.0.1:3130` (Docker Hub und MCR) und APT über
`127.0.0.1:3131` (Paketquellen). Squid prüft dafür getrennte Domainlisten.
Andere Hostprozesse erhalten keinen direkten Internetzugang. DNS-Anfragen
werden nur für Squid und den erkannten lokalen System-DNS-Dienst freigegeben.

Docker-Bridge-Container dürfen keine neuen Verbindungen zu Nicht-Docker-Netzen
aufbauen; neu eingehende Verbindungen zu veröffentlichten Docker-Ports werden
ebenfalls verworfen. Etablierte Verbindungen bleiben erhalten, damit lokale
Hub-/Datenbank-Kommunikation funktioniert. Produktions-Bots nutzen weiter nur
den internen Discord-Proxy und die private Hub-API. Bestehende UFW-Regeln werden
nicht gelöscht. Das Setup verweigert die Aktivierung, wenn zusätzliche
eingehende `ALLOW`-Regeln außer 80/443 und der exakt konfigurierten SSH-Quelle
vorhanden sind. Mit `sudo ufw status numbered` prüfen und unerwünschte Regeln
vor dem erneuten Setup gezielt löschen.

UFW wird nur mit `--enable` eingeschaltet. Wenn du per SSH arbeitest, erlaubt
das Skript dabei automatisch nur die aktuelle Gegenstelle am erkannten SSH-Port.
Für einen festen Verwaltungszugang etwa `--ssh-cidr 192.168.1.0/24 --ssh-port
22` verwenden. Ohne SSH-Sitzung und ohne `--ssh-cidr` wird SSH nicht
freigegeben. Regeln aktivieren und Proxy starten:

```sh
sudo ./deploy/discord-egress/setup-ubuntu-debian.sh --enable --ssh-cidr 192.168.1.0/24 --ssh-port 22 --hub-user bot-hub
```

Externe Bot-Callbacks müssen einzeln als exakte DNS-Namen freigegeben sein und
HTTPS auf Port 443 verwenden. Die gleiche root-eigene Datei wird vom Hub und
Squid gelesen:

```sh
sudo ./deploy/discord-egress/setup-ubuntu-debian.sh --enable --ssh-cidr 192.168.1.0/24 --ssh-port 22 --hub-user bot-hub --callback-host bot-gateway.example --callback-host webhook.example.net
```

Ohne `--callback-host` bleiben externe Callbacks gesperrt; Loopback-Callbacks
funktionieren weiter. Die Produktionsvariable `BOT_HUB_CALLBACK_ALLOW` kann
diese Root-Allowlist nicht erweitern. Private Callback-Ziele sind nur über
einen ausdrücklich freigegebenen DNS-Namen erreichbar; Loopback, Link-Local
und bekannte Cloud-Metadaten-Adressen bleiben immer gesperrt. Die Skripte
verwenden keine IP-Wildcards für Callbacks.

Das Setup installiert zusätzlich einen root-eigenen Prüfer und einen
systemd-Hook, der die Docker-Forward-Sperre nach jedem Docker-Neustart erneut
setzt. Der Docker-Daemon wird für Image-Downloads über Squid konfiguriert; APT
und ein vorhandener Caddy-Dienst erhalten ebenfalls Proxy-Einstellungen. Bei
Aufruf mit
`sudo` erhält der aufrufende Benutzer ausschließlich das Recht, genau diesen
Prüfer ohne Passwort auszuführen. Läuft der Hub unter einem anderen Konto,
übergib es explizit mit `--hub-user bot-hub`. Der Hub prüft beim
Produktionsstart die aktiven Ein- und Ausgangsregeln, Proxy-Listener und
Docker-Forward-Sperren und verweigert den Start, wenn ein Teil davon fehlt.

Wenn SSH nicht benötigt wird, genügt `--enable`. Den Zustand danach prüfen:

```sh
sudo ./deploy/discord-egress/check-ubuntu-debian.sh
```

`host-firewall.nft` enthält nur die Bridge-INPUT-Regeln und ist allein keine
vollständige Egress-Firewall. Für den hier beschriebenen Produktionsbetrieb
UFW mit dem Setup-Skript verwenden; eine eigenständige nftables-Installation
wird vom Produktionsprüfer nicht als vollständige Egress-Sperre akzeptiert.
Die Docker-Netze müssen auch bei dieser Variante mit `internal=true` und
`com.docker.network.bridge.enable_icc=false` angelegt werden; die Werte stehen
im Setup-Skript `deploy/discord-egress/setup-ubuntu-debian.sh`.
Hub-Bots bekommen Proxy-Umgebungsvariablen, aber Bibliotheken müssen diese
unterstützen bzw. den Proxy explizit konfigurieren. Das Beispiel
`bots/javascript-echo` konfiguriert REST für discord.js; der Gateway-WebSocket
nutzt unter Node den HTTPS-Agenten. Node.js 22.21+ ist für
`NODE_USE_ENV_PROXY=1` erforderlich.

Der Laufzeitfilter lässt nur die Discord API und Gateway durch. Paketregistries,
allgemeine Webseiten, Discord-CDN und UDP-Sprachverbindungen sind für laufende
Bots gesperrt. Paketdownloads laufen ausschließlich über den separaten
Installations-Container. Voice-Bots benötigen weitere Discord-Ziele und
UDP-Ausgang und sind mit dieser engen Regel absichtlich nicht abgedeckt.

`HOST=127.0.0.1` ist in diesem Fall richtig, weil nur der lokale Reverse-Proxy den Hub erreichen soll. Den exakten Discord-Callback musst du außerdem identisch in der Discord Developer Console hinterlegen. Discord-Anmeldung braucht für eine öffentliche Adresse HTTPS.

Beispiel für Caddy (`/etc/caddy/Caddyfile`):

```
hub.deine-domain.example {
  reverse_proxy 127.0.0.1:8787
}
```

Caddy beschafft und erneuert das TLS-Zertifikat automatisch, wenn DNS und TCP 80/443 von außen erreichbar sind. Wenn dein Anschluss CGNAT nutzt oder eingehende Ports blockiert, funktioniert Router-Portweiterleitung nicht; dann ist ein VPN oder ein Tunnel mit eigener Zugriffskontrolle die passende Alternative.
