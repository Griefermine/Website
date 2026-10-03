# Isolierte Bot-Umgebungen

Jeder Bot wird außerhalb des Testmodus in einem eigenen Container ausgeführt.
Der Container wird beim ersten Start automatisch erstellt, bekommt nur den
Workspace dieses Bots als `/workspace` eingebunden und bleibt für spätere
Starts erhalten. Abhängigkeiten, Build-Schritte und der eigentliche Bot-Prozess
laufen vollständig im Container.

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
