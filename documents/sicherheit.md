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
ist durch Löschen der Datei nicht weg; es gehört rotiert.

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
Start aber gemeldet: im Arbeitsordner eines Bots dürfte sie nicht liegen, sonst
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

Vor dem Start kommen noch Warnungen, die den Betrieb nicht aufhalten: belegte
Geheimnisse in `.env`, ein für andere Benutzer lesbares `data/secrets/`, ein
vorhandener Docker-Socket. Sie messen am Projekt-Root (`BOT_DASHBOARD_ROOT`),
nicht am Arbeitsverzeichnis – eine Prüfung am falschen Verzeichnis hält eine
Fehlkonfiguration für eine richtige.

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
- Redirects werden nicht verfolgt. Sonst hebt ein Callback auf dem localhost die
  Schranke auf und der Hub ruft das eigentliche Ziel doch auf.

Für Container, deren Loopback der Hub nicht teilt, gibt es
`BOT_HUB_CALLBACK_ALLOW=host:port,host`. Der Eintrag ist eine bewusste
Ausnahme: Der Hub ruft dann auch Ziele außerhalb des eigenen Rechners auf, und
der Betreiber trägt diese Verantwortung. Eine angemeldete Adresse gilt eine
Stunde und ist an die Bot-ID gebunden; 30 Aufrufe je Bot und Minute.

## Was nicht abgesichert ist

- **Container ohne Netzwerk-Firewall.** Die Grenzen sind Benutzer, Rechte,
  Prozesse, Ressourcen und Mounts (siehe `container-bots.md`). Docker kann
  keine Ausgangsregeln je Container und keine Trennung zweier Container auf
  demselben Hub erzwingen.
- **`bots/shared` ist Vertrauensgrenze.** Jeder Workspace darf daraus lesen.
  Ein Workspace ist damit so vertrauenswürdig wie sein Besitzer.
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
- **`BOT_HUB_CALLBACK_ALLOW`.** Jeder Eintrag nimmt die Loopback-Schranke für
  dieses Ziel aus. Damit ruft der Hub auch Adressen außerhalb des eigenen
  Rechners auf, und ein Bot, der den Hub-Rechner kontrolliert, kann darüber
  interne Dienste erreichen, die er sonst nicht sieht. Nur setzen, wenn das der
  eigene Aufbau ist – ein Loopback, das beide Seiten teilen, braucht es nicht.
- **`BOT_HUB_CONTAINER_URL`.** Der Eintrag `host.docker.internal` ist eine
  bewusste Öffnung und gehört nur gesetzt, wenn ein Bot den Hub braucht.
  Ohne diese Variable erreicht ein Bot-Prozess den Hub nicht: `127.0.0.1` ist im
  Container der Container selbst. Der Hub weist beim Start darauf hin. Für
  Meldungen aus einem Bot heraus (`/api/hub/state`, `/api/hub/notify`) ist also
  entweder `BOT_HUB_CONTAINER_URL` zu setzen oder in `BOT_HUB_URL` eine Adresse
  einzutragen, die auch aus dem Container erreichbar ist.
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
