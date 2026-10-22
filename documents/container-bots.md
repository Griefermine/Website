# Isolierte Bot-Umgebungen

Jeder Bot wird außerhalb des Testmodus in einem eigenen Container ausgeführt.
Der Container wird beim ersten Start automatisch erstellt, bekommt nur den
Workspace dieses Bots als `/workspace` eingebunden und bleibt für spätere
Starts erhalten. Abhängigkeiten, Build-Schritte und der eigentliche Bot-Prozess
laufen vollständig im Container.

## Startordner und Workspace

Zu jedem Bot gehören zwei Ordner, und der Unterschied ist der ganze Punkt:

```
bots/<id>/startordner/   der Startordner – vom Betreiber gepflegt
bots/<id>/workspace/     der Workspace – was als /workspace einhängt
```

Der Hub legt den Startordner selbst an. Es gibt kein Feld, in dem man einen
Pfad einträgt: ein getippter Pfad ist der eine Fehler, der erst auffällt, wenn
der Bot seinen Einstiegspunkt nicht findet. Dateien kommen über das Panel
(hier hochladen, dort bearbeiten, löschen) oder – für alle, die lieber ihren
Editor daneben offen haben – direkt auf die Platte.

Beim **Anlegen**, beim **Bearbeiten**, beim **Hochladen einer Datei** und beim
**Start** spiegelt der Hub den Startordner in den Workspace. Das ist der Punkt
der Trennung: der Bot bekommt die Dateien, aber nie den Ordner, in dem sie
liegen. Schreibt er in seinen Workspace – `node_modules`, Caches, ein
Exportversuch –, landet das im Workspace und nicht zwischen den Quelldateien.

### Die Merkliste

`bots/<id>/start-sync.json` (neben dem Startordner, also außerhalb des
gemounteten Workspace) merkt sich für jede geschriebene Datei ihre Größe und
eine Prüfsumme des Inhalts. Daraus folgt:

- **Neue und geänderte Dateien** werden kopiert. Ob etwas sich geändert hat,
  entscheidet der Inhalt, nicht der Zeitstempel – Dateisysteme, die auf
  Sekunden runden, liefern für dieselbe Datei verschiedene Zahlen, und in der
  Sekunde, in der der Bot eine Datei anfasst, wäre eine Änderung über den
  Zeitstempel gar nicht zu sehen.
- **Gelöschte Dateien** verschwinden auch im Workspace. Nur, was in der
  Merkliste steht, wird entfernt.
- **Was der Bot selbst erzeugt hat**, steht nicht in der Merkliste und bleibt:
  `node_modules`, `.venv`, Caches. Ein Spiegel, der sie mitnehmen würde, würde
  bei jedem Start die Installation des Bots wieder über den Haufen werfen.
- **Was der Bot im Container verändert** hat, wird zurückgeschrieben. Der
  Startordner ist die Quelle; sonst gewönne der Bot mit der Zeit das Recht,
  die eigene Quelle zu überschreiben.

### Was nicht übernommen wird

`.env`, `.env.*` und `.git` bleiben im Startordner und kommen nicht in den
Workspace. Geheimnisse kommen aus den Umgebungsvariablen des Bots
(`data/secrets/<id>.env`), und sie in den Container zu legen hieße, sie jedem
Prozess des Bots zu geben, der dieselbe UID hat. Übersprungene Einträge werden
gemeldet, nicht verschwiegen – ein still fehlendes `config.py` ist schlimmer
als ein Hinweis im Protokoll. Symlinks im Startordner werden ebenfalls
übersprungen: ein Verweis auf `/etc` ist kein Dateiinhalt, den man kopieren
kann.

Eine Quelldatei namens `secrets.py` ist übrigens Quellcode und gehört in den
Bot. Anders als bei der Migration alter Bot-Ordner wird hier nichts an der
Benennung erraten.

### Grenzen

- **Nur Text.** Maximal 512 kB je Datei. Bilder, `.jar` und andere Binärdaten
  haben hier keinen Platz – ein Bot baut seine `.jar` im Container, nicht über
  den Hub.
- **Bots aus der Zeit vor dem Startordner.** Ihr `Arbeitsordner` (ein Unterordner
  im Workspace) bleibt, wie er ist; der Startordner wird beim nächsten Hub-Start
  daneben angelegt und von da an gespiegelt. Der Einstiegspunkt eines solchen
  Bots muss dort liegen, wo sein bisheriges Feld es hinlegt.
- **Ein Löschen entfernt alles.** Bots werden samt Startordner, Workspace
  (inkl. Container), Secrets, Datenbankdaten, Tokens, Sitzungen und
  Per-Bot-Rechten vollständig gelöscht. Wer einen Bot endgültig
  weghaben will, löscht ihn im Panel – `bots/<id>` von Hand zu entfernen
  ist nicht mehr nötig und umgeht den sicheren Cleanup (Token-Widerruf,
  Quota-Bereinigung).

Der Container läuft mit derselben UID/GID wie der Bot-Hub-Prozess. Dadurch
bleiben die restriktiven Host-Dateirechte wirksam, ohne dass der Container für
den Zugriff auf den Workspace als privilegierter Root-Prozess laufen muss.

Was sich beim Erstellen nicht mehr ändern lässt – Benutzer, Image, Mounts,
Host-Eintrag –, steht als Kennung im Label `bot-hub.config`. Stimmt sie nicht
mit dem überein, was der Hub gerade braucht, stammt der Container aus einer
älteren Hub-Version und wird beim nächsten Start ersetzt. Läuft in dem Moment
ein Bot darin, bleibt der Container stehen; er wird erst danach ersetzt.

## Voraussetzungen

- Docker Engine (oder ein kompatibler CLI-Ersatz wie Podman)
- Der Benutzer des Bot-Hubs darf Container erstellen und starten.
- Der Hub muss für Container erreichbar sein. In der Entwicklung bindet der
  Server standardmäßig an `0.0.0.0`; in `production` ist der Standard
  `127.0.0.1` und andere Bind-Adressen werden abgelehnt.

Die Laufzeit lässt sich über `.env` konfigurieren:

```dotenv
BOT_HUB_CONTAINER_RUNTIME=docker
BOT_HUB_CONTAINER_PREFIX=bot-hub
# Nur wenn Bots den Hub erreichen müssen; dies gibt ihnen einen Weg zu allen
# Diensten auf dem Host.
# BOT_HUB_CONTAINER_URL=http://host.docker.internal:8787
```

Pro Sprache wird ein passendes offizielles Image verwendet (unter anderem
Python, Node.js, Java, Go, .NET und Rust). Das Workspace-Verzeichnis ist die
einzige Projektablage, die in den Container gemountet wird. Mit
`BOT_HUB_CONTAINER_MODE=disabled` kann die Container-Ausführung nur für
kompatible lokale Entwicklungs- oder Diagnosefälle abgeschaltet werden.

## Grenzen der Isolation

Was der Hub beim Erstellen festlegt:

| Grenze     | Wert                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| Rechte     | kein `--privileged`, `--cap-drop ALL`, `no-new-privileges:true`                                        |
| Prozesse   | `--init`, `--pids-limit 256`                                                                           |
| Ressourcen | `--memory 512m`, `--cpus 2` (überschreibbar)                                                           |
| Netzwerk   | `bridge` in Entwicklung, in Produktion internes `bot-hub-discord` mit Peer-Isolation und Discord-Proxy |
| Mounts     | `<workspace>:/workspace`, `bots/shared:/shared:ro`                                                     |

Docker filtert im Standard-`bridge`-Netz den ausgehenden Verkehr nicht. Dort
können Bots Dienste im LAN und Internet erreichen. In Produktion ist deshalb
ausschließlich das interne Netz `bot-hub-discord` zugelassen. Es hat keinen
direkten Internetweg; der einzige externe Weg ist Squid unter
`http://172.30.250.1:3128`. Die Bridge blockiert direkte Verbindungen zwischen
Bots; Host-Firewall und Squid erlauben ihnen ausschließlich den gefilterten
Proxy sowie die token-geschützte Hub-API. Squid erlaubt HTTPS-CONNECT auf TCP 443 nur zu
`discord.com` und `discord.gg` und verwirft lokale/private Zieladressen. Der
Proxy hat keinen veröffentlichten Host-Port; er lauscht nur auf den privaten
Docker-Gateways. Ein Start ohne korrekt laufenden Proxy oder ohne
`internal=true` und deaktivierte Inter-Container-Kommunikation wird vom Hub
abgelehnt.

Vor dem Hub-Start auf einem Ubuntu-/Debian-Host mit UFW die Regeln vorbereiten:

```sh
sudo ./deploy/discord-egress/setup-ubuntu-debian.sh
```

Das Skript richtet UFW ein und startet den Proxy, sobald UFW aktiv ist. Für
den ersten Start einer inaktiven Firewall muss `--enable` ausdrücklich
angegeben werden. Vorher `sudo ufw status numbered` prüfen und einen sicheren
SSH-Zugang mit `--ssh-cidr` konfigurieren; bei einer laufenden SSH-Sitzung wird
die aktuelle Gegenstelle beim Aktivieren automatisch freigegeben. Ohne
`--enable` bleibt eine inaktive UFW ausgeschaltet. Beispiel und Prüfung:

```sh
sudo ./deploy/discord-egress/setup-ubuntu-debian.sh --enable --ssh-cidr 192.168.1.0/24 --ssh-port 22
sudo ./deploy/discord-egress/check-ubuntu-debian.sh
```

UFW sperrt Zugriffe aus dem Bot-Netz auf Host-Dienste bis auf die eigene
Hub-API an `172.30.250.1:8788`. Zusätzlich verweigert es direkten Host-Egress;
Hub, Caddy, Docker-Image-Downloads und APT nutzen getrennte Loopback-Proxys mit
Domain-Allowlist. Docker-Bridge-Container können weder neue Verbindungen ins
Internet starten noch über veröffentlichte Docker-Ports neue eingehende
Verbindungen annehmen. Das Setup verweigert die Aktivierung bei zusätzlichen
eingehenden UFW-ALLOW-Regeln. Docker wird beim Anwenden der Proxy-Konfiguration
neu gestartet, danach den Hub-Dienst erneut starten. Bei Aufruf des Setups mit
`sudo` erhält der aufrufende Benutzer nur die Berechtigung, den root-eigenen
Firewall-Prüfer auszuführen. Für ein anderes Hub-Konto `--hub-user BENUTZER`
angeben.

`host-firewall.nft` enthält nur die Bridge-INPUT-Regeln und ist keine
vollständige Ausgangs- oder Docker-Forward-Sperre. Sie reicht nicht für den
Produktionsbetrieb; dafür die UFW-Variante verwenden.

Wenn
`172.30.250.0/24` bei dir bereits vergeben ist, ändere das Subnetz in
`compose.yaml`, `squid.conf`, `server/containers.js`, `host-firewall.nft` und
`update-ufw-rules.py` gemeinsam.
Für `172.30.251.0/24` gilt dasselbe; zusätzlich muss die Prüfung in
`server/containers.js` angepasst werden.

Der Hub setzt beim Produktionsstart seinen eigenen globalen HTTP-Proxy auf
`127.0.0.1:3129`. Externe Bot-Callbacks müssen zusätzlich in
`/etc/bot-hub/callback-egress.allow` stehen und HTTPS/443 verwenden. Der Hub
setzt in Produktions-Bot-Befehlen `HTTPS_PROXY`, `HTTP_PROXY`,
`BOT_HUB_DISCORD_PROXY` und `NODE_USE_ENV_PROXY=1`. Das interne Netz blockiert
den Direktweg auch dann, wenn eine Bot-Bibliothek Proxy-Variablen ignoriert.
Eine Bibliothek muss den Proxy trotzdem verwenden, damit Discord funktioniert.
Node.js 22.21+ kann die Proxy-Variablen für seine Standard-HTTP(S)-Agents
verwenden; REST-Bibliotheken mit eigenem Dispatcher brauchen eine explizite
Proxy-Konfiguration. Das Beispiel `bots/javascript-echo` konfiguriert den
discord.js-REST-Agenten. Discord.js Gateway-WebSockets nutzen in Node den
HTTPS-Agenten. Für Python, Java und andere SDKs ist die jeweilige
Proxy-Einstellung der Bibliothek nötig.

Paketmanager laufen beim Einrichten in einem kurzlebigen Installations-Container
mit separatem internem Netz. Nur der Paket-Proxy erreicht eine Domain-Allowlist
für npm, PyPI, Maven/Gradle, Go, crates.io und NuGet. Der Installer erhält nur
den Workspace, keine Bot-Secrets und keinen Weg zu Host-Diensten. Der dauerhafte
Bot-Container bleibt ausschließlich im Discord-Netz. Nicht freigegebene
Paket-CDNs und Git-Repositories sind gesperrt. Allgemeine Webseiten,
Discord-CDN und UDP-Sprachverbindungen bleiben für laufende Bots gesperrt.
Voice-Bots sind mit dieser engen Laufzeitregel absichtlich nicht abgedeckt.
Paketinstallationen können fremde Lifecycle- und Build-Skripte ausführen.
Deshalb erhält der Installer keine Bot-Secrets; installierte Pakete sollten
trotzdem geprüft und nur aus vertrauenswürdigen Quellen bezogen werden.

`BOT_HUB_CONTAINER_URL` schaltet in der Entwicklung `host.docker.internal`
frei. Der Eintrag kann einem Bot Zugriff auf Dienste am Host geben. In
Produktion wird diese Variable abgelehnt; stattdessen erhalten Bots
automatisch die lokale, auf Port `8788` begrenzte Hub-API-Adresse.

### Container im Produktivbetrieb

`NODE_ENV=production` mit abgeschalteter Container-Ausführung bricht den Start
ab. Auf einem Server, auf dem Bots ungeschützt mitlaufen würden, ist das der
Unterschied zwischen einem Konfigurationsfehler und einem Vorfall:

```text
[hub] ABBRUCH: BOT_HUB_CONTAINER_MODE=disabled ist in Produktion nicht erlaubt …
```

Außerhalb der Produktion warnt der Hub laut, statt den Start zu verweigern.

Der Produktionsstandard ist `bot-hub-discord`; ein anderes Netz, einschließlich
`bridge`, wird abgelehnt. Die Netz- und Proxy-Konfiguration liegt unter
`deploy/discord-egress/`. `BOT_HUB_CONTAINER_NETWORK` muss normalerweise nicht
gesetzt werden.

Docker-Netzwerknamen werden in die Container-Signatur aufgenommen; Container
mit einer anderen Netzwerkkonfiguration werden beim nächsten Start ersetzt.

### Images festnageln

`Tag` folgt beim Neustart, was das Registry gerade dazu liefert. Wer eine
Version festhalten will, nennt sie mit Digest:

```dotenv
BOT_HUB_CONTAINER_IMAGES={"python":"python:3.12-bookworm@sha256:…"}
```

Der Wert ist JSON und je Sprache ein einzelnes Image. Alles andere wird
ignoriert – unbekannte Sprachen, Werte, die keine reine Image-Referenz sind,
und kaputtes JSON. Ein solcher Wert kann keinen zusätzlichen Befehl in die
`docker run`-Zeile einschleusen.

## Gemeinsame Bibliothek unter /shared

`bots/shared/api.js` ist der gemeinsame Hub-Client für die Beispiel-Bots. Ein
Workspace importiert daraus mit einem relativen Pfad:

```js
// bots/<id>/workspace/api.js
export { botHubApi } from '../../shared/api.js';
```

Auf dem Host löst das zu `bots/shared/api.js` auf. Im Container hängt der
Workspace als `/workspace`, derselbe Pfad ergibt dort aber `/shared/api.js` –
deshalb bindet der Hub `bots/shared` zusätzlich **schreibgeschützt** als
`/shared` ein. Ohne diesen Mount startet der Bot nicht:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/shared/api.js'
imported from /workspace/api.js
```

Der Mount enthält ausschließlich Client-Code. Workspaces anderer Bots bleiben
außerhalb des Containers, und `/shared` lässt sich nicht beschreiben. Fehlt der
Ordner `bots/shared`, entfällt der Mount. Container aus älteren Hub-Versionen
erkennt der Hub an der fehlenden oder abweichenden Konfigurationskennung und
ersetzt sie beim nächsten Start einmalig.

Bei Python wird die `.venv` beim ersten Start beziehungsweise bei einer
unvollständigen Umgebung mit `pip` repariert. Dadurch werden alte oder auf dem
Host angelegte venvs nicht mehr als gültige Container-Abhängigkeit akzeptiert.

Installationswerkzeuge erhalten im Container ein eigenes beschreibbares Home
unter `/tmp/bot-home`. Dadurch verwendet npm nicht versehentlich das Home des
Hub-Prozesses auf dem Host; npm- und pip-Caches bleiben ebenfalls innerhalb
des Containers.

## Panel-Aktionen

Die Aktionen aus `bot-hub.json` folgen derselben Regel: Sie laufen im
Container des Bots, nicht auf dem Hub-Rechner. Zusätzlich gilt für den
Befehl eine Freigabeliste – nur der Interpreter der Bot-Sprache und
einige harmlose Werkzeuge (`echo`, `cat`, `ls`, …) sind erlaubt.
Netzwerkwerkzeuge wie `curl` oder `wget` sowie Interpreter-Evaluationsflags
(`python3 -c"…"`, `sh -c"…"`, `node --eval=…`) werden abgelehnt, und Pfade in
Argumenten müssen im Workspace des Bots liegen.

Damit kann auch ein Bot, der selbst in einem Container läuft, über sein
eigenes Manifest keine Befehle auf dem Hub-Rechner starten. Ein Manifest
wird als Vertrauensgrenze behandelt: wem du den Workspace eines Bots
givst, dem gibst du auch seine Panel-Aktionen.

Ein fehlgeschlagener Start oder eine Ablehnung landen als `error` im
Log des Bots; die Meldung nennt die Regel, die verletzt wurde.
