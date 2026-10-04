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
- **Ein Löschen im Panel löscht keine Dateien.** Wie bisher bleiben Workspace
  und Container stehen; der Startordner kommt hinzu. Wer einen Bot endgültig
  weghaben will, entfernt `bots/<id>` von Hand.

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
- Der Hub muss für Container erreichbar sein. Deshalb bindet der mitgelieferte
  Server standardmäßig an `0.0.0.0`.

Die Laufzeit lässt sich über `.env` konfigurieren:

```dotenv
BOT_HUB_CONTAINER_RUNTIME=docker
BOT_HUB_CONTAINER_PREFIX=bot-hub
BOT_HUB_CONTAINER_URL=http://host.docker.internal:8787
```

Pro Sprache wird ein passendes offizielles Image verwendet (unter anderem
Python, Node.js, Java, Go, .NET und Rust). Das Workspace-Verzeichnis ist die
einzige Projektablage, die in den Container gemountet wird. Mit
`BOT_HUB_CONTAINER_MODE=disabled` kann die Container-Ausführung nur für
kompatible lokale Entwicklungs- oder Diagnosefälle abgeschaltet werden.

## Grenzen der Isolation

Was der Hub beim Erstellen festlegt:

| Grenze     | Wert                                                              |
| ---------- | ----------------------------------------------------------------- |
| Rechte     | kein `--privileged`, `--cap-drop ALL`, `no-new-privileges:true`   |
| Prozesse   | `--init`, `--pids-limit 256`                                      |
| Ressourcen | `--memory 512m`, `--cpus 2` (überschreibbar)                      |
| Netzwerk   | nur das Docker-Netz des Projekts, kein `host`, kein Docker-Socket |
| Mounts     | `<workspace>:/workspace`, `bots/shared:/shared:ro`                |

Was Docker von sich aus nicht kann: eine Firewall je Container, eine
Ausgangs-Filterung oder die Trennung zweier Container, die auf demselben Hub
laufen. Das sind keine Lücken dieser Konfiguration, sondern Grenzen der
Laufzeit – entscheidend ist deshalb, wem du einen Workspace gibst.

`BOT_HUB_CONTAINER_URL` schaltet zusätzlich `host.docker.internal` frei. Der
Eintrag erlaubt einem Bot jeden Dienst auf dem Host, auch SSH und alles, was
sonst dort läuft. Er wird deshalb nur gesetzt, wenn ein Bot den Hub wirklich
braucht – ohne diese Variable bekommt kein Container einen Weg zum Host.

### Container im Produktivbetrieb

`NODE_ENV=production` mit abgeschalteter Container-Ausführung bricht den Start
ab. Auf einem Server, auf dem Bots ungeschützt mitlaufen würden, ist das der
Unterschied zwischen einem Konfigurationsfehler und einem Vorfall:

```text
[hub] ABBRUCH: BOT_HUB_CONTAINER_MODE=disabled ist in Produktion nicht erlaubt …
```

Außerhalb der Produktion warnt der Hub laut, statt den Start zu verweigern.

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
