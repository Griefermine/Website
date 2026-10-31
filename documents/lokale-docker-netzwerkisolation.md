# Lokale Docker-Netzwerkisolation

## Zweck und Geltungsbereich

Dieses Profil isoliert Bot-Container bei einem lokalen Bothub-Betrieb auf einem nativen Linux-Host mit Docker Engine, systemd und dem Docker-iptables-Backend.

Es ist für einen Betreiber gedacht, der seine eigenen Bots auf seinem eigenen Rechner ausführt. Es ist kein Ersatz für eine sichere Mehrmandanten-Sandbox und keine Garantie gegen Kernel-, Docker-Daemon- oder Host-Kompromittierungen.

Derzeit ausdrücklich nicht freigegeben sind Docker Desktop unter Windows/macOS, Rootless Docker, Podman und Docker mit dem nftables-Backend. Der Hub bricht den Start im lokalen Containerbetrieb auf diesen Plattformen ab, statt still auf das unisolierte Standardnetz auszuweichen.

## Sicherheitsziele

Ein Bot-Container soll:

- keinen anderen Bot-Container direkt erreichen;
- keine anderen Docker-Container oder verwalteten Datenbankcontainer erreichen;
- keine Host-Dienste wie SSH, MySQL oder lokale Verwaltungsoberflächen erreichen;
- keine privaten LAN-, VPN-, Router-, NAS- oder Link-Local-Ziele erreichen;
- keine Cloud-Metadaten-Endpunkte erreichen;
- IPv6 nicht als ungefilterten Ausweichweg nutzen;
- öffentliche Internetziele per TCP und UDP erreichen können, damit Discord, Web-APIs, DNS und andere öffentliche Dienste weiter funktionieren;
- den Hub ausschließlich über dessen gesonderten Runtime-API-Listener erreichen.

Die Firewall blockiert private und reservierte IPv4-Zielbereiche. Sie führt keine Domain-Allowlist. Öffentliche Ziele und öffentliche UDP-Verbindungen bleiben standardmäßig möglich. Anwendungen, die zwingend ein privates LAN-Ziel benötigen, funktionieren mit diesem Profil absichtlich nicht.

## Netzwerkprofil

Das Netzwerk heißt `bot-hub-local`, die Linux-Bridge `br-bothublocal`.

Erwartete Docker-Eigenschaften:

<!-- prettier-ignore -->
| Eigenschaft | Sollwert |
|---|---|
| Driver | `bridge` |
| Scope | `local` |
| Internal | `false` |
| IPv6 | deaktiviert |
| `com.docker.network.bridge.name` | `br-bothublocal` |
| `com.docker.network.bridge.enable_icc` | `false` |
| `com.docker.network.bridge.enable_ip_masquerade` | `true` |

Die Subnetz- und Gateway-Adresse werden von Docker dynamisch vergeben und danach aus `docker network inspect` gelesen. Dadurch wird kein festes privates Subnetz angenommen. `Internal=true` wird bewusst nicht verwendet, weil dieses Docker-Netz dann keinen normalen externen Ausgang hätte.

Die Bot-Container veröffentlichen keine Ports und erhalten keinen `host.docker.internal`-Eintrag. IPv6 wird zusätzlich im Netzwerk-Namespace jedes Bot-Containers über Sysctl deaktiviert. Der einzige private IPv4-Ausnahmepfad ist die tatsächliche Docker-Gateway-Adresse auf TCP-Port `8788`; sowohl im Egress-Filter als auch in der Host-INPUT-Kette ist ausschließlich dieses Ziel für die interne Bot-API erlaubt.

## Einrichtung

1. Hub-Prozess stoppen, damit während der Umstellung keine Bot-Container neu gestartet werden.
2. Im Projektverzeichnis den Benutzer angeben, unter dem Bothub läuft:

   ```bash
   sudo BOT_HUB_USER="$USER" bash scripts/setup-local-docker-isolation.sh
   ```

   Das Skript lädt `br_netfilter`, persistiert das Modul und setzt `net.bridge.bridge-nf-call-iptables=1` über eine eigene Datei in `/etc/sysctl.d/`. Diese Host-weite Kernel-Einstellung sorgt dafür, dass Bridge-Pakete die vorgesehenen iptables-Filter durchlaufen. Anschließend erstellt es das Netzwerk, installiert den root-eigenen Firewall-Helfer unter `/usr/local/sbin/bot-hub-local-firewall`, richtet eng begrenzte sudoers-Rechte für `apply` und `check` ein und installiert einen systemd-Drop-in, der die Firewall nach einem Docker-Daemon-Start erneut anwendet. Kann die Firewall dort nicht angewendet werden, gilt der Docker-Dienststart als fehlgeschlagen.

3. Anschließend Bothub wie gewohnt als normaler Hub-Benutzer starten.

Wenn alte Bothub-Bot-Container aus dem bisherigen Standardnetz vorhanden sind, können sie im Rahmen der Umstellung explizit entfernt werden:

```bash
sudo BOT_HUB_USER="$USER" bash scripts/setup-local-docker-isolation.sh --migrate
```

Das Setup fragt vor dem Entfernen nach. Es entfernt ausschließlich Container mit dem Bothub-Konfigurationslabel, die nicht bereits am neuen Netzwerk hängen. Bot-Dateien und die Verzeichnisse `bots/` und `data/` werden nicht gelöscht. Alternativ kann Bothub veraltete Container beim nächsten Bot-Start anhand der geänderten Container-Signatur ersetzen.

## Laufzeitprüfung und Fail-Closed-Verhalten

Bei jedem lokalen Hub-Start mit aktiviertem Containerbetrieb werden geprüft:

- Docker Engine läuft und liefert die erwartete Netzwerkkonfiguration;
- der Docker-Netzwerktreiber, die Bridge, ICC, Masquerading, IPv6- und Internal-Eigenschaften entsprechen dem Soll;
- genau eine gültige IPv4-Subnetz-/Gateway-Konfiguration vorhanden ist;
- der root-eigene Firewall-Helfer seine Regeln anwenden und anschließend prüfen kann.

Fehlt das Netzwerk, die Firewall, `DOCKER-USER`, sudo-Berechtigung, `net.bridge.bridge-nf-call-iptables=1` oder eine erwartete Regel, bricht Bothub vor dem Start der Bot-Container ab. Es gibt keinen Rückfall auf `bridge`.

Prüfen lässt sich die installierte Richtlinie mit:

```bash
sudo /usr/local/sbin/bot-hub-local-firewall check
docker network inspect bot-hub-local
```

Der Helfer schreibt nur die eigenen Ketten `BOTHUB_LOCAL_EGRESS` und `BOTHUB_LOCAL_INPUT` um. Er verändert oder leert keine Docker-eigenen Ketten. Eine systemd-Regel wendet die Richtlinie nach einem Docker-Neustart erneut an; beim nächsten Hub-Start wird sie zusätzlich kontrolliert und nötigenfalls wiederhergestellt.

## Interne Bot-API

Der Hub bindet einen zweiten HTTP-Listener an die von Docker vergebene Gateway-Adresse auf TCP-Port `8788`. Dieser Listener nimmt ausschließlich Pfade unter `/api/hub` an. Andere Routen – insbesondere Anmeldung, Dashboard, Bot-Verwaltung und Admin-API – werden mit `404` abgewiesen.

Auch für `/api/hub` ist weiterhin das jeweilige Runtime-Token erforderlich. Der Token bestimmt die Bot-Identität; ein Bot kann nicht durch Übermitteln einer anderen Bot-ID auf fremde Daten zugreifen.

Die lokale Bot-URL wird beim Start aus dem tatsächlichen Docker-Gateway gebildet. `BOT_HUB_CONTAINER_URL` ist nicht mehr zulässig und wird abgewiesen. `BOT_HUB_URL` bleibt die Browser-/öffentliche Hub-Adresse und ist nicht die interne Container-Adresse.

## Gesperrte IPv4-Ziele

Die lokale Egress-Kette blockiert mindestens diese Bereiche:

- `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`;
- `100.64.0.0/10`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`;
- `168.63.129.16/32` (Azure platform IP), zusätzlich zu den Link-Local-Metadatenadressen.
- reservierte, dokumentations- und Benchmark-Netze `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`;
- Multicast und reservierte Bereiche `224.0.0.0/4`, `240.0.0.0/4` sowie `255.255.255.255/32`.

Zusätzlich blockt die Host-INPUT-Kette sämtliche Verbindungen, die vom Bot-Bridge-Interface zum Host eingehen – außer TCP-Port `8788` an der tatsächlichen Docker-Gateway-Adresse.

## Funktionstests nach der Einrichtung

Vor produktiver Verwendung müssen reale Tests auf dem Zielrechner durchgeführt werden. Unit-Tests und die Firewall-Konfigurationsprüfung ersetzen diese nicht.

1. Prüfen, dass ein Bot eine öffentliche HTTPS-Adresse sowie die Discord REST-/Gateway-Dienste erreichen kann.
2. Prüfen, dass öffentliche UDP-Verbindungen bei Bots, die sie benötigen, funktionieren.
3. Prüfen, dass Verbindungen zu Router, NAS, einem anderen LAN-Rechner, privaten VPN-Adressen, `127.0.0.1`, `169.254.169.254` und anderen privaten/reservierten IPv4-Zielen scheitern.
4. Prüfen, dass SSH, MySQL, phpMyAdmin und andere Host-Dienste vom Bot aus nicht erreichbar sind.
5. Zwei Bot-Container starten und den direkten Zugriff zwischen ihnen über IP und Docker-DNS versuchen.
6. Den internen Listener ohne Token aufrufen: Er muss `401` liefern. Einen nicht erlaubten Pfad wie `/api/bots` über denselben Listener aufrufen: Er muss `404` liefern.
7. Den Bot-Hub-Daemon und anschließend den Host neu starten und die Firewall-Regeln erneut prüfen.
8. Die Tests mit ungültigem Runtime-Token und mit einem gültigen Token des jeweils anderen Bots wiederholen.

## Grenzen

Bothub muss für dieses lokale Profil als normaler, nicht privilegierter Linux-Benutzer laufen; nur das installierte Firewall-Hilfsprogramm wird gezielt mit Root-Rechten ausgeführt. Die Isolation hängt weiterhin vom Host-Kernel, Docker-Daemon, Firewall-Backend und den Rechten des Hub-Benutzers ab. Wer den Docker-Daemon kontrolliert, kann Container und Netzwerke verändern. Die Maßnahme ersetzt weder ein Rootless-/MicroVM-Sandboxing noch ein separates Testsystem. Sie ist außerdem kein Ersatz für die weiterhin nötigen Bot-Code-, API-, OAuth- und Dateisystem-Sicherheitsprüfungen.
