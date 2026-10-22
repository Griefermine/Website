# Veröffentlichen

Ein Release ist ein Archiv aus Quelltext – nicht der Ordner, in dem entwickelt
wird. Der Unterschied ist der ganze Punkt: im Arbeitsverzeichnis liegen `.env`,
`data/` mit den Secret-Dateien, die Workspaces fremder Bots, `.git` mit der
ganzen Historie und `node_modules`. Genau das ist in einem früheren Stand
mitgenommen worden.

Deshalb gilt: **nie von Hand packen**, sondern immer über die beiden Skripte,
und am Ende steht eine Prüfung des fertigen Pakets, nicht des Plans dazu.

## Ablauf

```bash
# 1. Alles grün, was der CI-Job auch prüft
npm ci
npm run format:check
npm test
npm run build

# 2. Repo prüfen (was Git kennt, darf keine Geheimnisse enthalten)
npm run release:scan

# 3. Artefakt bauen und das Artefakt selbst prüfen
npm run release:build
```

`release:build` schreibt nach `release/bot-hub-release.tar.gz` (mit `--out
<pfad>` wohin sonst) und meldet Pfad, Version, SHA-256, Größe, Dateianzahl und
das Scan-Ergebnis. `release/` ist über `.gitignore` ausgeschlossen.

Danach von Hand gegenprüfen – eine Prüfung, die niemand liest, ist ein Gefühl:

```bash
tar -tzf release/bot-hub-release.tar.gz | sort | head -30
tar -tzf release/bot-hub-release.tar.gz | wc -l
sha256sum release/bot-hub-release.tar.gz
```

Die Prüfsumme gehört zur Veröffentlichung (Release-Note, Download-Seite). Ohne
sie weiß niemand, ob das Paket unten am Ziel noch das Paket von hier ist.

## Was im Artefakt steckt

`scripts/release-manifest.json` ist eine **Allowlist**: was nicht drinsteht,
wandert nicht ins Paket. Das ist die umgekehrte Richtung einer Denylist – bei einer
Denylist entscheidet ein neues Verzeichnis, ob etwas hineingerät.

Enthalten: `server/`, `src/`, `public/`, `documents/`, `deploy/`, `scripts/`,
`test/`, `index.html`, `vite.config.js`, `package.json`, `package-lock.json`,
`.env.example`, `.gitignore`, `.prettierrc`, `.prettierignore`, `README*`,
`LICENSE*` und `.github/workflows/ci.yml`.

Nicht enthalten – und dafür gibt es keine Ausnahme: `data/` (Geheimnisse,
Bot-Speicher), `bots/` (fremde Workspace-Inhalte), `.env`, Zertifikate und
Schlüssel, Datenbanken (`.sqlite`, Dumps), `.git/`, `node_modules/`, `dist/` und
Symlinks jeder Art.

`dist/` fehlt bewusst: das Artefakt ist Quelltext, die Oberfläche entsteht auf
der Zielmaschine mit `npm ci && npm run build`. Ein vorgefertigtes `dist/` wäre
ein Bündel Programmcode, das niemand gelesen hat, der es ausliefert.

Zusätzlich zur Allowlist wirkt eine harte Denylist
(`scripts/scan-rules.mjs`) gegen die fertige Dateiliste. Trifft ein Pfad beide,
gewinnt die Denylist, und der Bau bricht mit `Allowlist-Lücke` ab.

## Was der Artefakt-Scan kann

Gelesen wird das Archiv im Speicher (ZIP und `tar.gz`, eigener Leser, ohne
Hilfsprogramme). Ausgepackt wird nichts – ein Archiv, das beim Prüfen schon
Dateien auf die Platte legt, ist nicht prüfbar, sondern gefährlich.

Gefunden und abgelehnt werden:

- **Pfade, die aus dem Ziel ausbrechen**: `../`, absolute Pfade, Pfade, die nach
  der Normalisierung woanders landen, Einträge, die beim Entpacken ein
  Verzeichnis überschreiben würden.
- **Symlinks und harte Links** im Archiv: ein Verweis auf `/etc/passwd` oder auf
  `../../data/secrets` ist kein Dateiinhalt, sondern ein Angriff auf die
  Umgebung.
- **Zip-Bomben**: zu viele Einträge, zu große Einzeldateien, zu hohes Verhältnis
  von gepackt zu ungepackt, zu tiefe Verschachtelung, und Archive in Archiven.
- **Inhalte**: Token-Muster, Private Keys, `-----BEGIN … PRIVATE KEY-----`,
  belegte Zuweisungen in `*.env` und in Quelltext, `.env.example` mit echten
  Werten statt Platzhaltern.

Die Fundmeldung nennt Datei, Zeile und Muster – **nie den Wert**. Ein Fund in
einer committeten Datei ist nach dem Löschen der Datei nicht erledigt: er steht
in der Historie und muss rotiert werden.

## Exit-Codes

| Code | Bedeutung                                             |
| ---: | ----------------------------------------------------- |
|    0 | freigegeben                                           |
|    1 | Findings – etwas hat in einem Release nichts verloren |
|    2 | nicht prüfbar (Archiv fehlt, lesbar, oder ist keins)  |

`2` ist absichtlich nicht „grün mit Warnung“. Ein Scanner, der nichts prüfen
konnte und 0 meldet, ist der Grund, warum Releases durchrutschen.

## Continuous Integration

`.github/workflows/ci.yml` läuft bei Push auf `main`, bei Pull Requests und auf
Knopfdruck. Er protokolliert zuerst, **was** geprüft wurde – Node- und
npm-Version, Commit, SHA-256 der Lockdatei, Zeitpunkt – und stellt dann die
Registry-Erreichbarkeit vor die Schwachstellenprüfung: eine nicht erreichbare
Registry ist ein Abbruch, nicht „keine Schwachstellen“. Danach folgen
`npm ci`, `npm run format:check`,
`npm test`, `npm run build`,
`npm audit --omit=dev` (blockierend) und das Audit der Entwicklungsabhängigkeiten
(informatierend), Abhängigkeitsverzeichnis als SBOM, Repo-Scan, Artefakt-Bau mit
anschließendem Artefakt-Scan. Hochgeladen werden Paket, SHA-256, Stand,
Testbericht, Audits und SBOM.

Der Formatprüfung unterliegt der gepflegte Quelltext; `bots/**` und `data/` sind
in `.prettierignore` ausgeschlossen, weil der Hub sie für Bot-Benutzer selbst
schreibt und ihre Prüfsummen (`start-sync.json`) über das nächste Spiegeln
entscheiden.

Daneben laufen zwei Jobs, die nicht denselben Takt haben: ein MySQL-Job, der
sich die Datenbank über denselben Provisionierer wie im Betrieb stellt und rot
wird, wenn er sie nicht erreicht (ein leer grüner Datenbank-Job wäre eine
Feldaussage) – und ein wöchentlicher Historien-Job mit vollständigem Checkout,
der den eigenen Historien-Scan und ein gepflegtes Secret-Tool über die ganze
Vergangenheit laufen lässt.

## Historie prüfen

Der Repo-Scan beantwortet die Frage nach dem aktuellen Stand. Für die Historie
gibt es `npm run release:scan:history`: er liest jeden Blob, den die Historie
kennt (Pfade aus `ls-tree` je Commit, Inhalte über `cat-file`), und meldet
Fundstellen ohne Wert. Ein Fund ist hier nicht durch Löschen erledigt:

1. Wert widerrufen bzw. rotieren.
2. Prüfen, ob die Historie verbreitet wurde (Forks, Klone, CI-Artefakte).
3. Erst danach die Historie umschreiben – und die alten Referenzen abmelden.

Zwei Grenzen dieses Scans gehören dazu: er kennt nur die eigenen Muster (deshalb
läuft in CI zusätzlich ein gepflegtes Tool), und er prüft keine Blob-Inhalte über
1 MiB sowie keine Binärdateien. Ist ein Blob unlesbar, meldet er das als Fund –
ein Loch in der Prüfung ist kein „frei“.

Der Stand dieses Repositorys: ein Fund in der Historie war der Wert von
`DISCORD_CLIENT_SECRET` in `.env.example` des allerersten Commits – 27 Zeichen,
kleingeschrieben, mit Bindestrichen, keine Ziffern, beginnend mit einem
Hinweiswort. Das ist ein Dokumentationsplatzhalter, kein brauchbares Client-
Secret; die spätere Fassung derselben Zeile ist ein Platzhalter derselben Art.
Die Platzhalterliste erkennt diese Form jetzt ausdrücklich (nur als komplette
Wertkette aus Hinweiswort und durch Trenner verbundenen Stücken – ein Token, das
zufällig so anfängt, fällt nicht durch dieses Raster). Wer den Wert im
Discord-Entwicklerportal wiedererkennt, rotiert ihn trotzdem.

7. **Nach dem Start.** `logs` des Hub-Benutzers lesen: der Hub meldet jede
   Sicherheitswarnung und jeden Abbruch beim Namen.

## Auf der Zielmaschine

Das Archiv sagt nichts über den Betrieb. Vor dem ersten Start eines
öffentlich zugedachten Hubs:

1. **Eigener Benutzer.** Der Hub startet in Produktion nicht als `root`. Ein
   Benutzer ohne Login-Shell, dem `bots/`, `data/` und `release/` gehören.
2. **Rechte.** `data/` und insbesondere `data/secrets/` auf `700`. Ein offenes
   `data/secrets/` verhindert den Produktionsstart – zu Recht.
3. **Bind.** Standard ist `127.0.0.1`. Von außen erreichbar macht man über einen
   Reverse-Proxy mit TLS, der selbst nur auf dem Loopback lauscht. `HOST` auf
   `0.0.0.0` ist in Produktion ein Abbruch, kein Hinweis.
4. **Secrets.** `BOT_HUB_TEST_MODE` bleibt weg. `data/secrets/` entsteht beim
   ersten Anlegen eines Bots; Werte gehören nicht in `.env` im Projekt-Root.
5. **Images.** `BOT_HUB_REQUIRE_IMAGE_DIGEST=1` und
   `BOT_HUB_CONTAINER_IMAGES` mit Digest-Referenzen je Sprache. Der Ablauf, die
   Digests zu erneuern, steht in `container-bots.md`.
6. **Netz.** Der Discord-Ausgangsfilter (`deploy/discord-egress/`) braucht die
   zwei isolierten Bridge-Netzwerke und die Firewall-Regeln daneben; der
   Basiscontainer ist per Digest festgelegt. Sein Inhalt wird über
   `check-host-firewall.py` geprüft, nicht über das Gefühl beim Bauen.
7. **Nach dem Start.** `logs` des Hub-Benutzers lesen: der Hub meldet jede
   Sicherheitswarnung und jeden Abbruch beim Namen.

### Prüfkommandos für den Host

Nur anzeigen, nichts verändern – ein Deployment-Skript, das Rechte „repariert“,
überschreibt im Zweifel Absichten:

```bash
# Rechte und Besitz der Laufzeitdaten (soll sein: 700, kein Symlink, Hub-Benutzer)
stat -c '%A %U:%G %n' data data/db data/secrets data/secrets/*.env
find data -maxdepth 2 -type l                 # Erwartung: keine Ausgabe
getfacl -p data/secrets 2>/dev/null | grep -v '^#'   # Erwartung: keine extra ACL-Einträge

# Wer darf überhaupt? Gruppen des Hub-Benutzers und des Docker-Sockets
id -Gn
stat -c '%A %G %n' /var/run/docker.sock
getent group docker                           # Mitglieder zählen, klein halten

# Bind und TLS: der Hub soll nur den Loopback sehen
ss -ltnp | grep -E ':(8787|8788|80|443)\b'

# Container: kein Socket-Mount, keine privilegierten Optionen
docker ps --format '{{.Names}}' |
  xargs -r docker inspect --format '{{.Name}} {{json .HostConfig.Binds}} {{.HostConfig.Privileged}}'

# Quota (P1-B): exists sie, und greift sie?
findmnt -T bots -o TARGET,FSTYPE,OPTIONS
sudo repquota -a 2>/dev/null | head        # bei xfs/btrfs: Project-Quota prüfen
```

## Aktualisieren der Digest-Pins

Der Digest des Egress-Basisimages ist in `deploy/discord-egress/Dockerfile`
festgeschrieben. Er wird nicht „nebenbei“ aktualisiert, sondern geprüft:

```bash
TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/debian:pull" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -sI -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://registry-1.docker.io/v2/library/debian/manifests/bookworm-slim |
  grep -i docker-content-digest
```

Der Wert muss mit dem übereinstimmen, was die Docker-Hub-Oberfläche für denselben
Tag zeigt. Danach `docker build` gegen den neuen Digest, Proxy neu starten,
Firewall-Prüfung laufen lassen. Ein Digest, den niemand nachgelesen hat, ist
schlechter als gar keiner: er wirkt wie eine Entscheidung.
