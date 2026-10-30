# Lokale Docker-Netzwerkisolation

## Zweck und Geltungsbereich

Dieses Profil trennt Bot-Container auf einem einzelnen Bothub-Host. Es ist für
den lokalen Betrieb auf **nativem Linux mit Docker Engine und Docker's
iptables-/DOCKER-USER-Firewall-Integration** ausgelegt.

Es ist nicht als Sicherheitsgrenze für ein öffentliches Multi-Tenant-SaaS
gedacht, in dem beliebige fremde Benutzer Container auf einem gemeinsamen
Host starten. Rootful Docker und eine mögliche Kompromittierung des Hub-Hosts
bleiben eigenständige Risiken.

Docker Desktop auf Windows/macOS, Podman, Rootless Docker sowie Docker mit
nativem nftables-Backend werden durch dieses erste Profil nicht freigegeben.
Der Hub verweigert dort den lokalen Containerbetrieb, statt auf das normale
Docker-Standardnetz zurückzufallen.

## Gewünschtes Verhalten

Ein Bot-Container darf:

- öffentliche IPv4-Ziele erreichen, darunter Discord, öffentliche APIs und
  Paket-Registries;
- den internen Bothub-Bot-API-Listener am Gateway des eigenen Docker-Netzes
  über TCP-Port 8788 erreichen, sofern der jeweilige API-Endpunkt ein gültiges
  Runtime- oder Panel-Token akzeptiert.

Ein Bot-Container darf standardmäßig nicht:

- einen anderen Bot-Container direkt erreichen;
- andere lokale Docker-Netze oder deren Dienste erreichen;
- beliebige Dienste auf dem Bothub-Host erreichen;
- private LAN-, Router-, NAS-, Drucker-, VPN- oder sonstige geroutete
  Host-Netze erreichen;
- Loopback-, Link-Local-, Cloud-Metadata-, CGNAT- oder andere reservierte
  IPv4-Ziele erreichen.

IPv6 ist im lokalen Bot-Netzwerk für dieses Profil deaktiviert. Dadurch soll
kein ungeprüfter IPv6-Ausgang die IPv4-Regeln umgehen.

## Einmalige Einrichtung

Voraussetzungen:

- Linux mit Docker Engine;
- Docker verwendet die iptables-/DOCKER-USER-Integration;
- `iptables`, `iproute2`, `systemd`, `sudo` und `visudo` sind installiert;
- der Hub läuft unter einem normalen Benutzer, nicht als root;
- der Setup-Aufruf erfolgt über `sudo`, damit das Skript den Hub-Benutzer
  über `SUDO_USER` bestimmen kann.

Im Projektverzeichnis:

```bash
sudo bash scripts/setup-local-network.sh
```

Das Skript erstellt das Docker-Netz `bot-hub-local`, sofern es noch nicht
existiert. Docker wählt das IPv4-Subnetz dynamisch über IPAM, damit keine
Subnetzadresse fest im Quellcode angenommen werden muss.

Das Netz wird mit folgenden Eigenschaften erstellt:

- Bridge-Driver;
- Docker Inter-Container Communication (`enable_icc`) deaktiviert;
- IP-Masquerading aktiviert, damit öffentliche ausgehende Verbindungen
  weiterhin funktionieren;
- `Internal=false`, da ein internes Docker-Netz keinen normalen
  Internetzugang bereitstellen würde;
- IPv6 deaktiviert;
- Bothub-Profillabel `com.bothub.security-profile=local-v1`.

Das Skript installiert außerdem den root-eigenen Prüfer unter
`/usr/local/sbin/bot-hub-local-network-firewall`, die systemd-Unit
`bot-hub-local-network-firewall.service` und eine enge sudoers-Regel. Der
Hub-Benutzer darf damit ausschließlich den Firewall-Status prüfen, aber
keine beliebigen Root-Befehle über diesen Eintrag starten.

Prüfen:

```bash
systemctl status bot-hub-local-network-firewall.service
sudo /usr/local/sbin/bot-hub-local-network-firewall check
```

Die Unit wird nach Docker gestartet und wendet die eigenen Firewall-Regeln
erneut an, wenn Docker neu gestartet wird. Während einer erneuten Anwendung
wird die Bot-Bridge temporär vollständig gesperrt. Schlägt die Regelanwendung
fehl, bleibt diese Sperre bestehen; die Bridge wird nicht offen weitergeführt.

## Firewall-Modell

Das Setup verwaltet ausschließlich die eigenen Chains
`BOTHUB_LOCAL_INPUT` und `BOTHUB_LOCAL_FORWARD`. Es überschreibt keine
Docker-eigenen Chains.

Auf dem Host gilt:

- von der Bot-Bridge wird nur TCP 8788 an die dynamische Gateway-Adresse
  zugelassen;
- jeder andere Zugriff aus der Bot-Bridge auf Host-Dienste wird verworfen.

Für weitergeleitete Pakete gilt:

- private, lokale, Link-Local-, CGNAT-, reservierte und Multicast-Ziele werden
  verworfen;
- aktuelle lokale Routen und Host-Adressen (einschließlich gängiger
  Docker-, LAN- und VPN-Routen) werden zusätzlich gesperrt;
- andere öffentliche IPv4-Ziele dürfen passieren.

Die Routenliste wird beim Anwenden und Prüfen neu aus dem Host ermittelt.
Wird ein neues lokales oder VPN-Netz hinzugefügt, muss die Firewall deshalb
erneut angewendet werden:

```bash
sudo /usr/local/sbin/bot-hub-local-network-firewall setup
```

Der Prüfer berechnet die erwarteten Regeln neu. Fehlen Regeln für eine
zwischenzeitlich hinzugekommene lokale Route, schlägt die Prüfung fehl und der
Hub startet nicht mit einer als sicher angenommenen Konfiguration.

## Interne Bot-API

Der Hub bindet im lokalen Profil zusätzlich einen Listener an die dynamisch
ermittelte Docker-Gateway-Adresse auf TCP-Port 8788.

Dieser Listener reicht ausschließlich folgende Pfade an die bestehende
API-Verarbeitung weiter:

- `/api/hub`
- `/api/hub/...`

Dashboard-, Authentifizierungs-, Zugriffsverwaltungs-, Bot-Management- und
sonstige Pfade werden bereits vor dem allgemeinen API-Handler mit HTTP 404
abgewiesen.

Der erlaubte Runtime-API-Endpunkt verlangt weiterhin das vorhandene
Bot-Runtime-Token und führt die bestehenden botbezogenen Berechtigungs- und
Identitätsprüfungen aus. Die neue Netzwerkschnittstelle ersetzt diese
Tokenprüfung nicht.

Die Umgebungsvariable `BOT_HUB_CONTAINER_URL` ist im lokalen Profil nicht
mehr zulässig. Sie konnte mit `host.docker.internal` einen allgemeinen Weg
zu Host-Diensten öffnen. Die Bot-Umgebung erhält die interne Gateway-Adresse
erst, nachdem Netzwerk und Firewall erfolgreich geprüft wurden.

## Migration vorhandener Container

Das neue Netz ändert die Container-Signatur. Beim nächsten Start werden
bestehende, gestoppte Bot-Container mit alter Netzwerkkonfiguration entfernt
und mit dem neuen Netz neu erstellt.

Dabei werden nur Docker-Containerobjekte entfernt. Die Bot-Workspaces,
Startdateien, `data/`, Datenbankdateien, Secrets und Zugangsdaten werden durch
diesen Netzwerkwechsel nicht gelöscht.

Ein laufender Bot-Prozess wird nicht mitten im Betrieb ersetzt. Er muss zuerst
gestoppt und danach neu gestartet werden, damit er die neue Netzwerkkonfiguration
erhält.

Ein bereits vorhandenes Docker-Netz mit dem Namen `bot-hub-local`, dessen
Einstellungen nicht stimmen, wird nicht automatisch gelöscht oder
überschrieben. Der Setup-Lauf bricht in diesem Fall ab. Prüfe zunächst, welche
Container dieses Netz verwenden. Entferne ein fehlerhaftes Netz nur dann
manuell, wenn keine wichtigen Container mehr daran angeschlossen sind; führe
danach das Setup erneut aus.

## Tests und Grenzen

Die Unit-Tests prüfen die Netzwerkkonfiguration, Fail-Closed-Verhalten,
Firewall-Prüfung, Gateway-Ermittlung und die Pfadbegrenzung des internen
Listeners. Die tatsächliche Paketfilterung muss zusätzlich auf einem
Linux-Testhost mit Docker Engine überprüft werden.

Erforderliche Live-Tests vor produktiver Nutzung:

1. Bot A kann Bot B weder per Docker-DNS noch direkt per IP erreichen.
2. Bot A erreicht weder SSH, Datenbank noch andere Dienste auf dem Host.
3. Bot A erreicht weder Router, NAS, andere LAN-Geräte noch VPN-Ziele.
4. Link-Local- und Metadata-Adressen sind nicht erreichbar.
5. Öffentliche HTTPS-APIs und Discord funktionieren weiterhin.
6. `/api/hub/...` funktioniert mit gültigem Token und wird ohne gültiges
   Token abgewiesen.
7. `/api/auth`, `/api/bots`, `/api/access` und Dashboard-Pfade sind über
   Port 8788 nicht erreichbar.
8. Firewall- und Docker-Neustart stellen dieselben Regeln wieder her.
9. Ein fehlender oder fehlerhafter Firewall-Prüfer verhindert den Hub-Start.

Dieses Profil ist eine zusätzliche Netzwerkbegrenzung. Es ersetzt weder
Docker-Updates noch Host-Härtung, sichere Bot-Code-Ausführung, Authentifizierung,
Kernel-Sandboxing oder Backups.
