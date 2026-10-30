# Sicherheitsleitplanken

Dieses Dokument sammelt, welche Grenzen der Hub zieht, wo Geheimnisse liegen
und was ausdrücklich **nicht** abgesichert ist. Es ersetzt keine Details –
die stehen in [container-bots.md](container-bots.md) und
[discord-login.md](discord-login.md).

## Wo Geheimnisse liegen

`data/bots.json` ist eine Übersicht: sie führt die Namen der geheimen
Schlüssel, aber keine Werte.

```json
{
  "id": "…",
  "secretKeys": ["DISCORD_BOT_TOKEN"],
  "panel": { "secretKeys": ["api_key"] }
}
```

Die Werte selbst liegen je Bot in `data/secrets/<bot-id>.env`, geschrieben mit
`0600` in einem Verzeichnis `0700`. Datei und Verzeichnis gehören nicht ins
Git-Repository; `data/` ist bereits ausgeschlossen.

Vor einer Veröffentlichung prüft `npm run release:scan` beides: einmal, was Git
kennt – ein Token, ein Schlüssel, eine belegte Zuweisung in einer Konfigurations-
oder Quelldatei – und einmal, welche Pfade falsch wären (`data/`, `.env`,
Zertifikate, `.sqlite`). Geprüft wird nur, was Git kennt: eine `.env` im
Arbeitsverzeichnis ist über `.gitignore` ausgeschlossen und würde nie
committet, sie zu melden hieße, immer dasselbe zu melden. Findet der Scan
etwas, bricht er mit Exit-Code 1 ab und nennt Datei und Zeile – nie den Wert
selbst. Ein Geheimnis, das einmal committet wurde, bleibt in der Historie und
ist durch Löschen der Datei nicht weg; es gehört rotiert. Für diese Frage gibt es
`npm run release:scan:history`: geprüft wird jeder Blob, den die Historie kennt,
mit den Pfaden aus `ls-tree` je Commit – nicht aus der Objektliste, die Inhalte
dem falschen Dateinamen zuordnen würde. Grenzen und Ablauf stehen in
`release.md`.

Der Repo-Scan beantwortet aber nicht die Frage, was in einem Archiv landet.
Dafür ist `npm run release:build` da: es kopiert nach der Liste
`scripts/release-manifest.json` in ein leeres Verzeichnis, legt daraus
`release/bot-hub-release.tar.gz` und scannt genau dieses Archiv, bevor es als
freigegeben gilt (`node scripts/release-scan.mjs --artifact <pfad>` für ein
vorhandenes). Artefakt-Modus heißt: **nur was in der Liste steht, ist erlaubt** –
nicht „alles außer bekannten Gefahren“. Ablauf, Inhalt und Prüfsumme stehen in
`release.md`. Zusätzlich geprüft werden Pfade, die
nach der Normalisierung aus dem Zielverzeichnis ausbrechen (`..`,
absolut, Symlinks, harte Links), verschachtelte Archive, die ein Entpacken
aufblähen würden, und Geheimnisse in den Dateien selbst. Der Scanner liest ZIP
und `tar.gz` selbst im Speicher; es wird nichts ausgepackt. Exit-Codes: 0
freigegeben, 1 Findings, 2 bedienter Fehler (fehlende Datei, kein Leserecht) –
ein Abbruch wegen eigener Schäden ist nie ein „grün“.

```dotenv
DISCORD_BOT_TOKEN="…"
API_KEY="…"
```

Eine zweite Datei mit derselben Sicherheitstufe trägt das Passwort des
verwalteten MySQL-Containers: `data/secrets/db.env`, ebenfalls `0600` in `0700`.

```dotenv
BOT_HUB_DB_PASSWORD="…"
BOT_HUB_DB_BOOTSTRAPPED="1"
```

Der zweite Eintrag merkt sich, dass der einmalige Admin-Durchlauf stattgefunden
hat. Ohne ihn gäbe es kein Gewissen darüber, ob ein zweiter Durchlauf erlaubt
wäre – und genau der ist es nicht. Das Admin-Passwort selbst steht dort **nicht**:
es existiert nur während des Durchlaufs in `data/secrets/mysql-init.env` und wird
danach gelöscht.

Beim Start liest der Hub diese Datei und trägt die Werte wieder in den
Speicher ein. Frühere Stände, bei denen die Werte noch in `bots.json` standen,
wird er beim ersten Start einmalig umgezogen: erst in die Datei mit `0600`,
danach wird `bots.json` ohne Werte neu geschrieben. An der API ändert sich
nichts – dort waren die Werte schon vorher maskiert (`••••••••`).

Die Datei in `data/secrets/` ist dabei die **einzige Wahrheit**. Ein alter Wert
in `bots.json` kann sie nicht überdecken: beim Umzug gewinnt immer, was schon in
der Datei steht, die Legacy-Werte dienen nur dem ersten Anlegen. Schlägt der
Umzug fehl (Platte voll, Rechte falsch), bleiben die Werte erhalten: der Bot
behält sie so lange in `bots.json`, wie seine Secret-Datei nicht geschrieben ist,
und erst der erfolgreiche Schreibvorgang nimmt sie heraus. Etwas anderes wäre
verkehrt – Werte, die nur im RAM lägen, wären nach dem nächsten Neustart weg,
und ein verlorener Bot-Token ist nicht wiederherstellbar. Nach außen ändert sich
dadurch nichts: die API maskiert auch diese Werte, und die Logs redigieren sie.
Die Redaktion der Logs ist zweistufig: Muster (`KEY=…`, `Bearer …`) werden
überdeckt, und zusätzlich wird jeder konkrete Secret-Wert des Bots ersetzt, den
der Hub kennt (`secretEnv`, geheime Panel-Felder, das Runtime-Token des Panels,
ab acht Zeichen Länge, längste zuerst) – druckt ein Bot seinen Token roh in die
Ausgabe, steht er nicht im Log. Das Runtime-Token selbst verlässt den Prozess
nie: es steht nicht in `bots.json` und nicht in einer API-Antwort.

Nach außen gilt unverändert: ein Geheimnis verlässt den Server nur maskiert
(`••••••••`). Die echten Werte bekommt ausschließlich der Prozess des Bots:
`DISCORD_BOT_TOKEN` direkt aus der Umgebung, die geheimen Panel-Felder als
`BOT_HUB_SETTING_<FELD>` – und im Testbetrieb zusätzlich als Eintrag der
`.env` im Workspace, damit der Bot sie dort findet.

## Drei getrennte Berechtigungen

Der Hub kennt drei verschiedene Nachweise. Sie sind nicht austauschbar.

| Nachweis             | Wer hat ihn                                 | Wofür                                    |
| -------------------- | ------------------------------------------- | ---------------------------------------- |
| `bot_hub_session`    | angemeldete Person im Dashboard             | alle `/api`-Routen des Hubs              |
| `bot_hub_panel_<id>` | Person nach Discord-Login auf der Bot-Seite | Routen unter `/api/bots/<id>/panel*`     |
| `BOT_HUB_TOKEN`      | der gestartete Bot-Prozess                  | `/api/hub/*` und Live-Werte an die Seite |

Deshalb ist `GET /api/hub/settings` mit dem Panel-Nachweis auf die nicht
geheimen Werte beschränkt; die vollen Werte einschließlich der Geheimnisse
bekommt nur der Prozess des Bots mit seinem Laufzeit-Token. Umgekehrt sind
`POST /api/hub/state` und `POST /api/hub/notify` dem Prozess vorbehalten – die
Bot-Seite darf lesen, aber keine Bot-Zustände verändern. Sie meldet ihre
Toast-Meldungen über `POST /api/bots/<id>/panel/notify`; der JavaScript-Bridge
kennt überhaupt kein Token mehr.

## Der Bot-Speicher

Unter `/api/hub/db` bekommt jeder Bot einen eigenen Bereich in der Datenbank des
Hubs. Auch hier entscheidet das Token, welcher Bot schreibt: eine Bot-ID wird
weder im Pfad noch im Rumpf angenommen, es gibt kein Feld, sie zu überschreiben.
Mit dem Panel-Token antwortet die Route mit `403`, ohne Token mit `401`.

Drei Dinge sind bewusst eng geführt:

- **Kein SQL vom Bot.** Der Hub bietet vier Operationen an und setzt alle Werte
  als Parameter ein. Namen, Schlüssel, Seitengrößen und die Größe eines Wertes
  werden gegen feste Muster und Grenzen geprüft (64 KiB je Wert, 200 Einträge
  je Liste).
- **Grenzen gelten je Bot, nicht je Collection.** Ein Bot darf insgesamt
  10.000 Einträge, 100 Collections und 100 MiB belegen – über alle Collections
  hinweg. Eine Grenze je Collection wäre umgehbar, indem ein Bot sich viele
  anlegt (100 × 9000). Die Zählung steht in einer eigenen Zeile und wird in
  derselben Transaktion nachgeführt wie der Schreibvorgang; konkurrierende
  Schreibvorgänge können sie deshalb nicht überzählig machen.
- **Eine Listenantwort bleibt unter 4 MiB.** Reißt die Seite diesen Rahmen,
  wird sie gekürzt und `truncated: true` gemeldet. Der Zähler `total` bleibt
  dabei die Wahrheit über alle Zeilen – eine Kürzung soll sichtbar sein, nicht
  still Daten verschlucken.

Daneben Ratenbegrenzungen je Bot: 120 Schreibvorgänge, 60 Löschungen,
240 Lesevorgänge und 120 Abfragen pro Minute. Bei `429` nennt die Antwort
`retryAfter`.

- **MySQL nur auf diesem Rechner.** Ein `BOT_HUB_DB_HOST`, der nicht auf
  Loopback zeigt und kein Unix-Socket ist, bricht den Start ab. `root` als
  Benutzer ebenso, ebenso MySQL im Testmodus ohne ausdrückliche Freigabe.
- **Kein Weg heraus.** Der Hub hat keinen Endpunkt, der einem Bot Werte von
  außen nachliefert, und der Bot-Speicher ist nicht verschlüsselt – wer die
  SQLite-Datei oder die MySQL-Datenbank lesen kann, liest ihn im Klartext. Er
  ist deshalb kein Ersatz für `data/secrets/<bot-id>.env`.

Die SQLite-Datei liegt unter `data/db/` (Verzeichnis `0700`, Datei `0600`). Ein
per `BOT_HUB_DB_FILE` gesetzter Ort außerhalb von `data/` ist erlaubt, wird beim
Start aber gemeldet: im Startordner eines Bots dürfte sie nicht liegen, sonst
könnte dieser sie direkt lesen und die API umgehen. Details in
[datenbank.md](datenbank.md).

## Der eigene MySQL-Container

`BOT_HUB_DB=mysql-container` lässt den Hub seine Datenbank selbst aufsetzen. Für
einen Bot ändert das nichts: er erreicht seinen Bereich weiterhin nur über
`/api/hub/db` und bekommt weiterhin keine Zugangsdaten. Die Grenzen, die dazukommen:

- **Der Admin-Zugang gilt einmal.** Der Container startet mit einem zufälligen
  `root`-Passwort. Der Hub legt damit Datenbank und Arbeitsbenutzer an und führt
  danach `DROP USER IF EXISTS 'root'@'%'` aus. Von außen kann sich danach
  niemand mehr als root anmelden – **auch nicht mit dem richtigen Passwort**;
  `test/mysql-container.test.js` macht genau diesen Versuch. Übrig bleibt
  `root@'localhost'`, erreichbar nur über `docker exec` im Container.
- **Kein Geheimnis in der Argumentliste.** Das Admin-Passwort wird über
  `--env-file data/secrets/mysql-init.env` gereicht (`0600` in einem Verzeichnis
  `0700`), nicht über `--env NAME=WERT`, das in `ps` und in `docker inspect`
  stünde. Die Datei wird nach dem Durchlauf gelöscht, auch dann, wenn er
  fehlschlägt.
- **Kein stiller zweiter Versuch.** Steht der Hub vor einem eingerichteten
  Container und kommt nicht mehr hinein, bricht er ab und nennt
  `BOT_HUB_MYSQL_RESET=1`. Ein erneuter Admin-Durchlauf fände kein
  Admin-Passwort mehr vor und würde nur eine zweite Tür erzeugen, die niemand
  schließt.
- **Nur Loopback, eigenes Netz.** Der Container veröffentlicht
  `127.0.0.1:<Port>:3306`, nie `0.0.0.0`, und hängt an einem eigenen Netz
  (`<präfix>-mysql-net`). Bot-Container laufen auf der Default-Bridge und haben
  dorthin keine Route. Damit erreicht ein Bot die Datenbank weder direkt noch
  über `host.docker.internal` – beides ist im Test mit einem echten Wegwerf-
  Container geprüft.
- **Der Arbeitsbenutzer kann nichts außerhalb seiner Datenbank.** Kein
  `GRANT OPTION`, kein `*.*`, kein `FILE`, kein `SUPER`. `CREATE DATABASE` für eine
  zweite Datenbank und jeder Zugriff auf `mysql.user` scheitern.
- **Das Passwort liegt nur in `data/secrets/db.env`.** 48 Zeichen aus
  `crypto.randomBytes`, aus `A–Z a–z 0–9 - _`. Dieses Alphabet ist nicht
  zufällig gewählt: weil es keine Anführungszeichen und keine Backslashes
  enthält, muss der Wert beim Zusammensetzen der `CREATE USER`-Anweisung nicht
  escaped werden. Stattdessen wird er vorher gegen genau dieses Muster geprüft
  und abgelehnt, wenn er nicht passt.
- **Kein Weg zu `BOT_HUB_DB_PASSWORD` in `.env`.** Bei diesem Treiberwert wird
  die Variable abgelehnt, genau wie `BOT_HUB_DB_HOST` und `BOT_HUB_DB_SOCKET`.
- **Ein Healthcheck, der ohne Passwort auskommt.** `mysqladmin ping -h 127.0.0.1`
  antwortet mit „mysqld is alive", sobald der Server Verbindungen annimmt – auch
  dann, wenn der Zugang abgewiesen wird. Das ist hier der entscheidende Punkt:
  nach `DROP USER 'root'@'%'` gibt es kein Passwort mehr, mit dem sich ein
  Healthcheck anmelden könnte. Er misst „nimmt mysqld Verbindungen an?",
  und das bleibt er auch ohne Adminzugang.

Was das kostet, steht unter [Was nicht abgesichert
ist](#was-nicht-abgesichert-ist).

## phpMyAdmin (`BOT_HUB_PHPMYADMIN=1`)

Eine reine Verwaltungsoberfläche für dieselbe Datenbank. Sie ist aus, bis man sie
verlangt: ohne die Variable entsteht kein Container, kein Verwaltungsbenutzer
und damit auch **kein zweites Datenbankpasswort**. Für einen Bot ändert sich
nichts – er sieht weder den Container noch das Netz, in dem er hängt.

- **Ein eigener Benutzer, `bot_hub_admin`, mit denselben Rechten wie der Hub.**
  Getrennt sind die **Zugangsdaten**, nicht die Befugnisse: kein `GRANT OPTION`,
  kein `*.*`, kein Zugriff auf `mysql.*`, kein `CREATE DATABASE`. Wer der
  Oberfläche mehr gäbe als dem Hub selbst, bekäme mehr MySQL als der Hub. Der
  Hub stellt unter diesem Benutzer keine Bot-Datenabfrage; er meldet sich damit
  nur an, um zu prüfen, ob der Zugang noch lebt, und um bei
  `BOT_HUB_MYSQL_ROTATE=admin` genau dieses eine Passwort zu ersetzen.
- **Kein Volume, kein Mount, kein docker.sock.** Die Oberfläche bekommt nichts vom
  Host und nichts von den Bots. Es gibt für sie keinen Pfad, über den sie Daten
  herausholen könnte – nicht einmal den, den ein Bot von außen benutzt.
- **uid 33, `cap-drop ALL`, `no-new-privileges`.** Das Image startet sonst als
  root. Dass ein uid 33 trotzdem Port 80 belegen darf, ist eine Eigenschaft des
  Debian-Grundsystems im Image (`net.ipv4.ip_unprivileged_port_start=0`), keine
  zusätzlich vergebene Berechtigung.
- **Nur Loopback.** `127.0.0.1:<Port>:80`, nie `0.0.0.0`. Bot-Container hängen an
  der Default-Bridge und haben zum Netz von MySQL keine Route – für sie ist
  phpMyAdmin genauso unerreichbar wie die Datenbank.
- **Kein `PMA_USER`, kein `PMA_PASSWORD`.** Wer die Werte fest einträgt, legt das
  Passwort in die Container-Umgebung, und die steht für jeden mit Docker-Zugriff
  in `docker inspect`. Ohne die beiden meldet sich jeder selbst an.
- **`PMA_ARBITRARY=0`.** Ohne das darf phpMyAdmin über die Adresse im Formular
  jeden beliebigen Datenbankserver ansteuern, den sein Container sieht – nicht
  nur das eigene MySQL.
- **Kein Passwort im HTML.** Weder in der Anmeldemaske noch auf der Seite danach.
  Das HTML wird im Browser zwischengespeichert, in Lesezeichen mitgenommen und in
  Support-Screenshots weitergereicht.
- **`root` kommt nicht hinein**, auch nicht mit dem richtigen Admin-Passwort aus
  dem einmaligen Durchlauf. phpMyAdmin ist kein Weg an der Zusage vorbei, dass es
  von außen keinen Adminzugang gibt.
- **Das Verwaltungspasswort steht in `data/secrets/phpmyadmin.env`** (`0600` in
  einem Verzeichnis `0700`) und wird **nie** ausgegeben – weder ins Log noch in
  eine Fehlermeldung. Was der Hub anzeigt, ist der Pfad.
- **Vor dem ersten Start setzen.** Der Verwaltungsbenutzer entsteht im selben
  einmaligen Durchlauf wie der Arbeitsbenutzer. Wird die Variable erst danach
  gesetzt, startet der Hub **keinen** Container, an dem sich niemand anmelden
  kann, sondern sagt, dass ein Reset nötig wäre – mit allen Daten.
- **Abschalten heisst stoppen.** Nach dem Entfernen der Variable stoppt der Hub
  den Container beim nächsten Start und sagt es ins Log. Das Passwort in
  `data/secrets/phpmyadmin.env` bleibt dabei liegen, damit sich die Oberfläche
  später mit demselben Benutzer wieder zuschalten lässt; ohne die Datei wüsste
  der Hub nicht mehr, womit er sich anmelden soll, und hielte den Benutzer für
  nie angelegt.
- **Passwörter erneuern ohne Tokens anzufassen.** `BOT_HUB_MYSQL_ROTATE=app` oder
  `=admin` ersetzt das Passwort genau eines Benutzers. Das geht ohne
  Adminrechte, weil ein Benutzer sein eigenes Passwort mit
  `ALTER USER USER() IDENTIFIED BY …` ändern darf. Das Passwort wird dabei **vor**
  dem SQL in die Datei geschrieben; scheitert das `ALTER`, wird der alte Wert
  zurückgeschrieben, damit Datei und MySQL nicht auseinanderlaufen.

Was das kostet, steht unter [Was nicht abgesichert
ist](#was-nicht-abgesichert-ist).

## Startschutz

Zwei Konfigurationen führen zum Abbruch statt zu einem unsicheren Betrieb:

```text
[hub] ABBRUCH: BOT_HUB_TEST_MODE=1 hebt Anmeldung und Rate-Limits auf und ist nur mit NODE_ENV=test erlaubt …
[hub] ABBRUCH: BOT_HUB_CONTAINER_MODE=disabled ist in Produktion nicht erlaubt …
[hub] ABBRUCH: Bot-Speicher: BOT_HUB_DB_HOST="10.0.0.5" ist nicht lokal …
[hub] ABBRUCH: Bot-Speicher: BOT_HUB_DB_PASSWORD ist bei BOT_HUB_DB=mysql-container nicht erlaubt …
[hub] ABBRUCH: Bot-Speicher: BOT_HUB_DB_USER=root ist nicht erlaubt …
[hub] ABBRUCH: Bot-Speicher: BOT_HUB_MYSQL_DATA darf nicht innerhalb von bots/ liegen …
```

Bei `BOT_HUB_DB=mysql-container` kommen vier weitere Gründe dazu, alle davon
eine Ablehnung statt einer stillen Anpassung: Adresse, Socket und Passwort von
Hand, `root` als Arbeitsbenutzer, ein Datenverzeichnis in `bots/`, ein
Datenbank- oder Benutzername, der in SQL etwas anderes wäre als eine Tabelle.

Der Testmodus heißt `BOT_HUB_TEST_MODE=1` und verlangt zusätzlich
`NODE_ENV=test`. Er fällt bewusst weg: keine Anmeldung, keine
Ratenbegrenzung, Bot-Prozesse laufen direkt auf dem Rechner und der
Discord-Endpunkt lässt sich auf Loopback umleiten. `NODE_ENV=test` allein
schaltet nichts frei – die Schranken bleiben dann stehen. Wer nur
`BOT_HUB_TEST_MODE=1` setzt, bekommt den Abbruch: lieber ein deutlicher Fehler
als ein offener Hub.

Zwei weitere Prüfungen können den Start verhindern:

- **Root.** In Produktion startet der Hub nicht als `root`. Sonst bekämen auch
  die Container `root`, und die Trennung zwischen fremdem Bot-Code und dem Host
  träfe nicht mehr.
- **Images ohne Digest.** Ein Tag wie `python:3.12-bookworm` ist eine Liste von
  Namen, die jemand anderes jederzeit umschreiben kann. Mit
  `BOT_HUB_REQUIRE_IMAGE_DIGEST=1` startet der Hub nicht, solange nicht alle
  Images über `BOT_HUB_CONTAINER_IMAGES` auf einen Digest festgelegt sind. Ohne
  diesen Schalter gibt es in Produktion eine deutliche Warnung – die
  Grundeinstellung bleibt veränderlich, damit ein Betrieb nicht an einem fehlenden
  Digest-Pin stehen bleibt. Ein ausgedachter Digest wäre schlimmer als keiner:
  er lässt jeden Pull scheitern, ohne erkennbar zu sein, warum.
- **`data/secrets/` mit fremden Rechten.** Secret-Dateien werden mit `0600`
  angelegt; das nützt nichts, wenn das Verzeichnis sie offen hält. In Produktion
  ist ein `data/secrets/`, das andere Benutzer lesen **oder die Gruppe schreiben**
  darf, ein Abbruch („Bitte auf 700 setzen“), nicht mehr nur ein Hinweis. Ebenso
  abgelehnt: ein Symlink anstelle des Verzeichnisses (gemessen würde das Ziel,
  schützen will man den Pfad) und ein Verzeichnis, das nicht dem Benutzer des
  Hub-Prozesses gehört. Außerhalb der Produktion bleibt beides eine Warnung, damit
  eine Entwicklungsmaschine mit ungewöhnlichen Rechten nicht steht. Geprüft werden
  auch `data/` und `data/db/` – dort liegen Bot-Speicher und `bots.json`; für sie
  gibt es in Produktion eine Warnung, keinen Abbruch. Was der Hub nicht sehen
  kann, prüft der Host: POSIX-ACLs (`getfacl data/secrets`), die Gruppen des
  Servicekontos (`id -Gn`), Backup-Ziele derselben Dateien und die Frage, wer
  außerhalb dieses Kontos auf den Pfad schreiben darf. Die Kommandos dafür stehen
  in `release.md`.

Der Standard-Bind ist in **allen** Modi `127.0.0.1`. `HOST` verschiebt ihn:
außerhalb von Tests mit einer Warnung, in Produktion als Abbruch – der Hub
spricht HTTP und gehört vor einen TLS-Reverse-Proxy, der selbst nur auf
`127.0.0.1` lauscht. Ein Hub, der „nur zum Testen“ auf `0.0.0.0` hängt, ist im
eigenen Netz dasselbe Risiko wie in Produktion: Anmeldung und Panel sind für
jede Person dort erreichbar.

Alle diese Regeln stehen in `server/preflight.js`. Der Test
`test/preflight.test.js` prüft die Entscheidungen, `test/startup.test.js` den
Weg durch einen echten Start.

Vor dem Start kommen noch Warnungen, die den Betrieb nicht aufhalten: belegte
Geheimnisse in `.env`, ein für andere Benutzer lesbares `data/secrets/`, ein
vorhandener Docker-Socket. Sie messen am Projekt-Root (`BOT_DASHBOARD_ROOT`),
nicht am Arbeitsverzeichnis – eine Prüfung am falschen Verzeichnis hält eine
Fehlkonfiguration für eine richtige.

## Ratenbegrenzung und ein Pfad, eine Zählung

Der Hub zählt pro Minute und nach zwei Achsen: der Adresse des Anfragenden und,
wenn angemeldet, zusätzlich der Person. Eine Antwort mit `429` nennt in
`retry-after`, wann es weitergeht.

| Bereich                                               | Grenze |
| ----------------------------------------------------- | -----: |
| Discord-Anmeldung (`/api/auth/discord/…`)             |     30 |
| Panel-Anmeldung (Login und Callback im Bot-Panel)     |     10 |
| Aktionen (Panel-Befehle, `start`/`restart`/`install`) |     60 |
| Bot-API (`/api/hub/…`)                                |    120 |
| Dateiendpunkte                                        |     60 |
| Bots anlegen (`POST /api/bots`)                       |     10 |
| Bots löschen (`DELETE /api/bots/<id>`)                |     20 |
| Bot ändern (`PATCH /api/bots/<id>`)                   |     60 |
| Rechte ändern (`/api/access/…`)                       |     30 |
| Log-Endpunkte (`/api/logs`, `/api/bots/<id>/logs`)    |    300 |

Entscheidend ist, **welcher Pfad gezählt wird**. Gezählt wird dieselbe Form, die
auch das Routing sieht: doppelte und abschließende Schrägstriche werden
zusammengefasst, und jedes Segment genau **einmal** prozent-dekodiert. Ohne das wäre
`/api/%62ots` für den Limiter ein unbekannter Pfad (grenzenlos) und für den
Router `bots` – ein Encoder-Trick als Freifahrtschein. Doppelte Kodierung
(`%2562…`) löst beim Limiter zu `%62…` auf und bleibt damit ein anderer Pfad: er
trifft keinen fremden Bucket und wird später ohnehin abgewiesen.

Zwei weitere Grenzen halten die Begrenzer selbst klein: höchstens 10 000 Eimer.
Ist die Tabelle voll, werden zuerst abgelaufene Eimer eingesammelt und, wenn das
nicht reicht, der am längsten unbeachtete Eimer verdrängt – so sperrt ein einziger
fleißiger Nutzer nicht alle Neuen aus. Erst wenn danach immer noch kein Platz
ist, gibt es `429` (abgewiesen statt Speicher fressend); bestehende Eimer behalten
ihren Zähler. Und `BOT_HUB_MAX_BOTS` (Standard 24) begrenzt, wie
viele Bots ein Hub verwaltet. Die Obergrenze wird **vor** dem ersten Warten
reserviert, nicht danach: sonst legen acht gleichzeitige Anfragen acht Bots an, weil
sieben von ihnen die Zahl noch unbesetzt sehen. Ein Anlegen, das später
scheitert, gibt seinen Platz wieder frei.

## Callback-Adressen

Der Hub ruft für eine Aktion im Panel die Adresse auf, die sich der Bot-Prozess
mit `BOT_HUB_TOKEN` gemeldet hat. Diese Adresse ist der einzige Weg, auf dem der
Hub selbst etwas im Netz aufruft, und damit auch der einzige Weg, auf dem das
passieren könnte, was der Bot nicht darf.

Ohne weiteren Schalter ist **nur Loopback erlaubt**. Das genügt, weil der
Prozess neben dem Hub läuft, und es schließt den Hub als Vermittler für
beliebige Adressen aus:

- geprüft wird die echte Adresse, nicht die Schreibweise. `2130706433`,
  `127.1` und `0x7f.1` stehen nach der Normalisierung durch `new URL` als
  `127.0.0.1` da – geprüft und gespeichert wird dieselbe Adresse;
- bei einem Namen zählt **jede** aufgelöste Adresse. Ein einzelner günstiger
  Eintrag in der Antwort würde sonst genügen, um die Schranke zu umgehen;
- geprüft wird wieder bei jedem Aufruf, nicht nur bei der Anmeldung. Zwischen
  beiden Zeitpunkten kann sich ein DNS-Eintrag geändert haben;
- die Verbindung wird auf genau die Adresse festgelegt (gepinnt), die vorher
  geprüft wurde. Ohne das wäre zwischen Prüfung und Socket ein Fenster für
  DNS-Rebinding: die Prüfung sähe eine öffentliche Adresse, der Socket verbände
  sich mit `127.0.0.1`. Nur wenn der Produktions-Egress-Proxy aktiv ist, entfällt
  der Pin – dort prüft Squid die Zieladresse beim Verbinden selbst. Bei
  Zweifel an der Proxysituation wird immer gepinnt;
- im Container-Betrieb sind Loopback-Ziele komplett abgelehnt (Registrierung
  wie Aufruf). Der Loopback eines Containers ist nicht der Loopback des Hosts –
  der Umweg über den Hub wäre ein Lesekanal auf die lokalen Dienste des Hosts;
- Redirects werden nicht verfolgt. Sonst hebt ein Callback auf dem localhost die
  Schranke auf und der Hub ruft das eigentliche Ziel doch auf.

Für Container, deren Loopback der Hub nicht teilt, sind externe Ziele eine
bewusste Ausnahme. In Entwicklung dient `BOT_HUB_CALLBACK_ALLOW`; Produktion
verwendet ausschließlich die root-eigene Datei
`/etc/bot-hub/callback-egress.allow`, die mit `--callback-host` im UFW-Setup
gepflegt wird. Hub und Squid nutzen dieselbe Allowlist. Externe Ziele müssen
exakte DNS-Namen sein und HTTPS auf Port 443 verwenden. Private Ziele sind nur
über einen ausdrücklich freigegebenen Callback-Namen erreichbar; Loopback,
Link-Local, bekannte Cloud-Metadaten-Adressen, das Well-Known-NAT64-Netz
(`64:ff9b::/96`, das Metadaten-Adressen übersetzen kann) und das
Discard-Netz (`100::/64`) bleiben gesperrt. Eine
angemeldete Adresse gilt eine Stunde und ist an die Bot-ID gebunden; 30 Aufrufe
je Bot und Minute.

## Startordner

Zu jedem Bot gehören zwei Ordner: `bots/<id>/startordner/` ist die Quelle, die
der Betreiber pflegt, `bots/<id>/workspace/` ist die Kopie, die als
`/workspace` in den Container hängt. Der Hub legt den Startordner selbst an
(`0700`), und nur er kommt hinein – der Container sieht ihn nicht.

- **Was der Hub liest, landet im Container.** Der Hub spiegelt alles aus dem
  Startordner in den Workspace. Ein Startordner ist also Vertrauensgrenze in
  derselben Weise wie ein Workspace: wer ihn füllen kann, bestimmt, was der Bot
  ausführt.
- **Symlinks werden nicht mitgenommen.** Ein Verweis im Startordner zeigt auf
  irgendwohin; ihn zu kopieren hieße, dem Bot den Inhalt dort zu geben. Sie
  werden gemeldet und übersprungen. Dasselbe gilt für Pfade, die aus dem
  Startordner hinauszeigen: sie werden abgewiesen, auch wenn ein Symlink sie
  scheinbar hineinführen lässt.
- **`.env` bleibt draußen.** Geheimnisse kommen aus
  `data/secrets/<bot-id>.env` und werden als Umgebung gesetzt. Ein `.env` im
  Startordner in den Container zu legen hieße, es jedem Prozess des Bots zu
  geben, der dieselbe UID hat.
- **Der Startordner ist nicht schreibgeschützt.** Er wird bei jedem Start neu
  gelesen und mit dem Workspace verglichen. Wer einen Bot zur Laufzeit am
  Quellcode vorbeimodifiziert, holt ihn sich beim nächsten Start zurück.
- **`bots/<id>/start-sync.json`** liegt neben dem Startordner und damit außerhalb
  des gemounteten Workspace. Sie merkt sich Größe und Prüfsumme der Dateien, die
  der Hub geschrieben hat, und entscheidet so, was beim nächsten Spiegeln
  entfernt wird. Der Bot sieht sie nicht; sie ist kein Geheimnis, sondern eine
  Liste von Pfaden.

## Löschen, das aufräumt

Ein Bot-Löschvorgang ist ein Zustand, kein Ereignis: `deleteState` steht in
`bots.json`, bevor der erste Ordner verschwindet, und das Löschen ist
idempotent – es kann beliebig oft wiederholt werden.

- **Löschen wartet nicht auf eine Installation.** Eine laufende Installation hält
  das Workspace-Schloss. Würde das Löschen darauf warten, hinge die Oberfläche
  Minuten (eine `pip install`-Sperre kann Stunden dauern). Stattdessen: Delete
  markiert den Bot als „Löschen vorbereitet“, beendet den Installationsprozess
  (`SIGTERM`, nach fünf Sekunden `SIGKILL`), wartet auf sein Ende und übernimmt
  erst dann das Schloss. Zwischen zwei Installationsschritten wird dieselbe
  Markierung geprüft; eine Installation, die während des Löschens weiterlaufen
  wollte, gibt auf. Endet der Prozess auch nach `SIGKILL` nicht, wird das
  Löschen abgelehnt (409) statt aufzuräumen: ein Cleanup unter einem noch
  schreibenden Prozess würde einen halben Workspace hinterlassen.
- **Nach dem endgültigen Löschen schreibt nichts mehr.** Ist der Bot entfernt,
  prüfen Start, Neustart, Installation und Dateiendpunkte die Markierung und
  lehnen ab. Ein Prozess, der nach dem Entfernen noch Dateien anlegt, würde einen
  Bot wieder zum Leben erwecken, den niemand mehr hat.
- **Recovery läuft vor der Initialisierung.** Ein Bot, der beim Start im Zustand
  `deleting` oder `cleanup_failed` aus `bots.json` kommt, bekommt **keinen**
  Startordner, kein Panel-Scaffold, keine Dateiübernahme und keine
  Secret-Datei. Er bekommt nur seine validierte Identität – und wird aufgeräumt.
  Die Reihenfolge ist der eigentliche Punkt: würde erst normal initialisiert,
  entstünde genau das Verzeichnis wieder, das das Recovery löschen will, und ein
  Absturz mitten im Scaffold ließe einen halbfertigen Bot mit fremden Dateien
  stehen (`cleanup_failed` mit Inhalt, der nie gelöscht werden kann).
- **Ein abgebrochenes Löschen ist sichtbar.** Scheitert das Aufräumen (Platte,
  Rechte, ein Prozess, der nicht weicht), bleibt `cleanup_failed` stehen und der
  Hub räumt beim nächsten Start erneut auf. Ein Bot, der „gelöscht“ gemeldet
  wurde, dessen Ordner aber noch da sind, ist kein gelöschter Bot – deshalb wird
  der Zustand protokolliert statt vergessen.

## Der Docker-Daemon ist der Host

Der Hub startet Container, indem er die `docker`-Kommandozeile aufruft – ohne
`DOCKER_HOST`, also am Standard-Socket des Rechners. Das hat eine Konsequenz,
die nicht verhandelbar ist: **Zugriff auf den Daemon ist Zugriff auf den Host.**
Ein Container mit `/var/run/docker.sock` setzt sich selbst Host-Rechte, mountet
`/` und ist damit außerhalb jeder Grenze, die der Hub gezogen hat. Dass der
Node-Prozess nicht als `root` läuft, ändert daran nichts – die Schranke ist die
Socket-Berechtigung, nicht die Benutzerkennung des Hub-Prozesses.

Daraus folgt, was beim Betrieb gilt:

- **Kein Bot-Container bekommt den Socket.** Keine Volume-Angabe, kein Mount,
  kein `-v /var/run/docker.sock:...`. Die Prüfung darauf ist Teil der
  Container-Argumente (`test/containers.test.js` prüft Bot-Start UND den
  Paket-Runner, ohne Docker zu brauchen).
- **Keine erreichbar gemachte Docker-API.** Kein `DOCKER_HOST=tcp://…`, kein
  Port 2375/2376, keine Fernsteuerung des Daemons. Der Daemon bleibt ein
  lokaler Unix-Socket.
- **Socket-Besitz und Rechte.** Gruppe des Sockets ist meist `docker`; jede
  Person in dieser Gruppe ist faktisch Host-`root`. Mitgliederzahl klein halten,
  keine Bot-Benutzer, keine automatischen Wartungsskripte mit dieser Gruppe.
- **Empfohlener Betrieb: rootless.** Rootless Docker oder Podman in der
  Rootless-Kurve verkleinern den Schaden eines entkommenen Prozesses erheblich.
  Kompatibilität ist geprüft für: Netzwerke (selbst angelegte Bridge-Netze, keine
  `--privileged`-Wege), Mounts (nur Workspace und geteilte Bibliothek),
  Ressourcen (`--memory`, `--cpus`, `--pids-limit`), Benutzerabbild
  (`--user <uid>:<gid>`). **Eingeschränkt** ist Dateisystem-Kontingent je
  Workspace – das ist unabhängig vom Daemon offen (siehe unten).
- **Der Hub ist ein einzelner Prozess mit drei Aufgaben.** Oberfläche,
  Autorisierung und Container-Steuerung sitzen zusammen. Eine getrennte
  Orchestrierungsschicht (kleiner Dienst mit festem Operationskatalog, eigene
  Socket-ACL, eigene Benutzer) ist die saubere Trennung und hier **nicht**
  umgesetzt – sie wäre eine Architekturänderung ohne Testgrundlage. Bis dahin:
  der Hub-Prozess selbst ist das Angriffsziel, und er ist so gebaut, dass er
  keine ungeprüften Argumente weiterreicht (Programm-Listen je Sprache,
  Workspace-Pflicht für eigene Programme, kein Shell-Aufruf, keine
  Evaluations-Flags).

Was zusätzlich fehlt und als Risiko zählt: **keine Alarmierung auf unerwartete
Container** und keine Audit-Spur für `docker`-Aufrufe außerhalb des Hubs. Der Hub
protokollisiert seine eigenen Aktionen; was ein anderer Prozess über den Socket
tut, sieht er nicht. Backups von `data/`, `bots/` und der Host-Konfiguration
sind Sache des Betriebs – siehe `container-bots.md`.

## Was nicht abgesichert ist

- **Der freie Platz auf der Platte wird seit Maßnahme 49 immerhin gemessen.**
  Der Hub prüft beim Anlegen eines Bots und vor jeder Installation den für ihn
  schreibbaren freien Platz samt freier Inodes (`BOT_HUB_MIN_FREE_MB`,
  `BOT_HUB_MIN_FREE_INODES`) und lehnt bei Mangel mit einer lesbaren Meldung (HTTP 422, denn 5xx-Antworten versteckt der Hub absichtlich hinter „Interner Serverfehler“) ab, statt eine
  Installation bei halb heruntergeladenen Abhängigkeiten vom vollen Datenträger
  stoppen zu lassen. Was er weiterhin nicht kann, ist eine **harte
  Kontingentgrenze (Quota) je Workspace**: sie wäre nur mit
  Dateisystem-Quota (`btrfs`/`xfs`-Projekte, `dm-setup`) tragfähig, und das ist
  Sache des Betriebs, nicht des Hubs. Ein laufender Bot-Prozess schreibt
  ungeachtet jeder Hub-Prüfung in seinen Workspace, solange der Datenträger
  Raum hat. Zwei Bots, die mit `pip` oder `npm` ihre Abhängigkeiten in den
  Workspace holen, können die Platte des Hosts weiter füllen – und eine volle
  Platte legt nicht nur diesen Hub lahm, sondern alles darauf. **Wer fremde
  Bots betreibt, muss das Kontingent außerhalb setzen** (eigenes Loop-Device
  oder Dateisystem-Quota für `bots/`) – siehe `documents/container-bots.md`.

- **Container ohne Netzwerk-Firewall.** Die Grenzen sind Benutzer, Rechte,
  Prozesse, Ressourcen und Mounts (siehe `container-bots.md`). Docker kann
  keine Ausgangsregeln je Container und keine Trennung zweier Container auf
  demselben Hub erzwingen.
- **`bots/shared` ist Vertrauensgrenze.** Jeder Workspace darf daraus lesen.
  Ein Workspace ist damit so vertrauenswürdig wie sein Besitzer.
- **Der Startordner gibt dem Bot seinen Code, nicht umgekehrt.** Er ist nicht
  schreibgeschützt: wer ihn füllen kann, bestimmt, was der Bot ausführt. Das ist
  keine Lücke, sondern die Aufgabe – der Hub führt Bots, die jemand gebaut hat.
  Abgesichert ist nur die Richtung, die interessiert: der Bot kommt nicht an den
  Ordner selbst und nicht an die Dateien, die nicht für ihn bestimmt sind.
- **Der Bot-Speicher ist kein Geheimnisspeicher.** Er ist lesbar für jeden mit
  Zugriff auf die Datenbankdatei, und er hat keine Rechte auf Bot-Ebene: wer den
  Laufzeit-Token eines Bots hat, hat den ganzen Bereich dieses Bots.
- **Ein Betreiber, mehrere Bots.** Autorisiert wird gegen `guildId` und
  Discord-Berechtigung, nicht gegen ein Mandantenmodell. Für den Betrieb, für
  den der Hub gebaut ist (eine Person, ihre Bots, lokale Maschine), reicht das.
  Wer fremde Bots über denselben Hub betreibt, braucht davor eine zusätzliche
  Schicht.
- **Was der Bot tut.** Ein Bot im eigenen Container darf Netzwerk. Was er
  anrichtet, ist Sache des Codes im Workspace.
- **Die Browser-Bindung des Panel-Logins ist ein Kompromiss.** Der Hub bindet
  den Discord-Callback über ein Cookie, das beim Login-Start gesetzt wird
  (`bot_hub_preauth_<bot-id>`). Weil die Bot-Seite sandboxed ist, muss dieser
  Start als Navigation laufen – ein Cookie aus einem `fetch` erreicht den
  Browser beim Rücksprung von Discord nicht (im echten Browser nachgewiesen).
  Wer Hub-Zugang und einen Panel-Token hat, kann deshalb ein Start-Ticket
  erzeugen und einem Opfer den Start-Url schicken; bestätigt das Opfer den
  Discord-Dialog (`prompt=consent`), gehört die Sitzung zum Panel-Token des
  Absenders. Für den Rückweg gilt weiter: ein Callback in einem fremden Browser
  wird abgewiesen, und die Autorisierung gilt nur für `guildId` plus
  Administrator/**Server verwalten**. Details in `discord-login.md`.
- **Externe Callbacks.** Jeder Eintrag in der Produktions-Allowlist nimmt die
  Loopback-Schranke für dieses Ziel aus. Hub und Squid begrenzen den Aufruf auf
  den freigegebenen Host und HTTPS/443. Eine Kompromittierung des rootful
  Docker-Daemons bleibt eine Host-Root-Vertrauensgrenze und kann die
  Container-Isolation unterlaufen.
- **`BOT_HUB_CONTAINER_URL`.** In Entwicklung kann `host.docker.internal` einem
  Bot Zugriff auf Host-Dienste geben. In Produktion wird die Variable
  abgelehnt. Dort gibt es einen getrennten, auf Port `8788` begrenzten Listener
  für Bot-API-Aufrufe; nftables blockiert aus dem Bot-Netz alle anderen
  Host-Ports.
- **Das Admin-Passwort ist in `docker inspect` sichtbar.** Der MySQL-Container
  bekommt es über `--env-file`, und Docker legt den Inhalt solcher Dateien in
  die Konfiguration des Containers. Wer den Docker-Socket bedienen darf, liest
  es damit – auch nach dem Löschen der Datei, denn der Container existiert ja
  weiter. Das ist keine Lücke, die sich schließen ließe, ohne den Docker-Socket
  selbst abzuschneiden (was der Hub nicht kann, weil er Container startet).
  Verkleinert wird der Schaden dadurch, dass `root@'%'` unmittelbar nach dem
  Durchlauf verschwindet: das Passwort ist danach wertlos. Wer den Socket hat,
  kommt aber über `docker exec` ohnehin an `root@'localhost'` – es bleibt der
  Weg über die lokale Unix-Socket-Autorität des Daemons.
- **`root@'localhost'` bleibt bestehen.** Der Container könnte stattdessen ganz
  ohne root-Benutzer laufen. Dann wäre aber der Weg nach innen dicht, auch für
  jemanden, der aus einem legitimen Grund an die Datenbank muss, und die
  Wiederherstellung nach einem beschädigten Datenspeicher wäre nur noch über
  `BOT_HUB_MYSQL_RESET=1` möglich – also über das Wegwerfen aller Bot-Daten. Die
  Folge dieser Entscheidung ist konkret: **das Admin-Passwort bleibt dauerhaft
  gültig**, und wer eine neue Datenbank oder einen neuen Benutzer braucht, muss
  `data/mysql` verwerfen. Der Zugriff ist an den Docker-Daemon gebunden, nicht
  an das Netz – aber „nur wer den Docker-Socket hat" ist eine echte Schranke,
  keine Redensart.
- **Eine neue Datenbank oder ein neuer Benutzer kostet alle Daten.** Der
  Admin-Durchlauf gibt es genau einmal. Wird danach eine weitere Datenbank
  gebraucht, hilft nur `BOT_HUB_MYSQL_RESET=1`, und das räumt
  `data/mysql` vollständig. Der Hub sagt das beim Start deutlich, statt es
  später zu zeigen.
- **Das Verwaltungspasswort bleibt dauerhaft gültig.** Anders als beim Adminzugang
  kann der Hub ein vergessenes `bot_hub_admin`-Passwort nicht vergessen machen,
  ohne den Container zu verwerfen – deshalb gibt es dafür
  `BOT_HUB_MYSQL_ROTATE=admin`. Praktisch heißt das: wer
  `data/secrets/phpmyadmin.env` liest, hat **dauerhaft** einen vollwertigen
  Datenbankzugang, und eine Kopie der Datei bleibt auch nach dem Löschen brauchbar.
  Das ist der Preis dafür, dass die Oberfläche überhaupt bedienbar ist; ohne
  gespeichertes Passwort gäbe es phpMyAdmin nur mit einer zweiten Datenbank
  `CREATE DATABASE`-Rechten auf `*.*`, und die hätte der Hub nicht vergeben.
- **phpMyAdmin kennt keine Ratenbegrenzung.** Der Hub setzt keine, und das Image
  bietet dafür auch keine Umgebungsvariable. Wer den Loopback-Port erreicht, darf
  beliebig oft raten. Die Schranke ist damit genau die eine: der Port lauscht nur
  auf `127.0.0.1`, und alles, was dort landet, steht schon auf diesem Rechner.
- **Die Oberfläche ist ein zweiter Weg an dieselben Daten vorbei.** Sie kennt
  dieselben Rechte wie der Hub und umgeht dabei die Bot-Trennung: wer sich dort
  einloggt, sieht und ändert den Speicher **aller** Bots, während `/api/hub/db`
  einem Bot nur seinen eigenen Bereich zeigt. Das ist gewollt – es soll ja
  gerade die Sicht des Betreibers sein – und zugleich der Grund, warum die
  Oberfläche abgeschaltet bleibt, wenn sie nicht gebraucht wird. Das Herunterladen
  der Datenbank ist über dieselben Rechte möglich und gehört zur Bedienbarkeit
  dazu, nicht zu einer Lücke: es gibt nichts, was der Bot-Speicher nicht ohnehin
  preisgäbe, sobald jemand Zugriff auf die Datei oder den Docker-Daemon hat.
- **phpMyAdmin lässt sich nur vorher zuschalten.** Der Verwaltungsbenutzer
  entsteht beim ersten Einrichten. Wird `BOT_HUB_PHPMYADMIN=1` erst danach
  gesetzt, hilft nur der Weg über `BOT_HUB_MYSQL_RESET=1` – mit allen Daten. Der
  Hub weist darauf hin und startet nichts, was niemand benutzen könnte.

## Was nach einem Neustart beachtet werden muss

Geänderte Regeln greifen erst mit einem neuen Hub-Prozess – der Server läuft
im Entwicklungsbetrieb ohne `--watch`. Nach dem Neustart gelten zusätzlich:

- Bot-Container aus älteren Versionen werden einmalig ersetzt (Label
  `bot-hub.config`), unter anderem mit dem `/shared`-Mount.
- Der Discord-Login der Bot-Seiten prüft jetzt die Ziel-Guild und bindet den
  Callback an den Browser, der ihn gestartet hat.
- Reste abgebrochener Schreibvorgänge (`data/secrets/.env.bot-hub.tmp-*`) werden
  beim Start entfernt.
- Bereits angemeldete Callback-Adressen gelten ab jetzt nur noch eine Stunde.
  Nach diesem Neustart meldet sich ein Bot, dessen Aktionen auf einem Callback
  laufen, bei Bedarf einmal neu an – ein Aufruf meldet „Callback abgelaufen“
  statt ins Leere zu gehen.
- **Der Bind ist jetzt standardmäßig `127.0.0.1`.** Wer bisher ohne `HOST`
  gestartet ist und von anderen Rechnern an die Oberfläche kam, kann das nicht
  mehr. Wer bewusst extern binden will, setzt `HOST=0.0.0.0` (in Produktion
  zusätzlich den Reverse-Proxy davor), und der Hub sagt beim Start, was er tut.
- **Alte Secret-Werte in `bots.json` überdecken nichts mehr.** Der erste Start
  nach diesem Stand schreibt Werte, die schon in `data/secrets/` liegen, nicht
  zurück. Wer vor dem Update beide Stände hatte, behält den Stand der Datei.
- **Bots im Löschzustand werden vor allem anderen abgearbeitet.** Ein Start mit
  einem Bot, dessen Löschen abgebrochen war, legt deshalb keine Ordner mehr an,
  sondern räumt auf. Wer so einen Bot versehentlich „retten“ wollte, indem er
  `deleteState` aus `bots.json` entfernt, muss die Ordner von Hand prüfen: sie
  können Scaffold-Dateien enthalten, die der Hub nie geschrieben haben dürfte.
- `BOT_HUB_MAX_BOTS` (Standard 24) ist neu und setzt die alte feste Obergrenze
  als Konfiguration fort.
