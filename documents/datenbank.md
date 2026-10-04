# Bot-Speicher

Jeder Bot bekommt einen eigenen Bereich in einer Datenbank des Hubs und erreicht
ihn über die Hub-API. Der Hub spricht wahlweise SQLite oder MySQL – der Bot
bekommt davon nichts mit und erhält auch keine Zugangsdaten.

Für den Hub selbst ändert sich nichts: `data/bots.json`, `data/access.json` und
`data/secrets/*.env` bleiben, wie sie waren. Neu ist nur der Bereich, in dem ein
Bot seine eigenen Werte ablegt.

## Was der Hub zusichert

- **Die Trennung steckt im Token.** Welcher Bot schreibt, entscheidet allein
  `BOT_HUB_TOKEN`. Eine Bot-ID lässt sich auch in einem anderen Feld nicht
  mitschicken – im Pfad steckt sie nicht.
- **Kein SQL vom Bot.** Der Hub bietet fertige Operationen an (lesen, schreiben,
  auflisten, löschen). Werte werden als Parameter eingesetzt, nie in eine
  Abfrage eingefügt.
- **Nur dieser Rechner.** MySQL wird nur über Loopback (`127.0.0.1`, `::1`,
  `localhost`) oder einen Unix-Socket erreicht. Jede andere Adresse bricht den
  Start ab, statt es zu versuchen.
- **Kein Weg für die Bot-Seite.** Die eingebettete Seite kennt den Panel-Token
  und damit keinen Zugriff. `/api/hub/db` verlangt den Laufzeit-Token des
  laufenden Prozesses; mit dem Panel-Token antwortet die Route mit `403`.
- **Grenzen.** 64 KiB je Wert, 200 Einträge je Liste, Namen und Schlüssel aus
  einem festen Muster. Alles darüber wird abgelehnt, nicht gekürzt.

## Die Routen

Alle Routen liegen unter `/api/hub/db` und brauchen den Laufzeit-Token als
`Authorization: Bearer …`.

| Methode  | Pfad                                 | Zweck                                                                           |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| `GET`    | `/api/hub/db`                        | `{ database: { driver, ready, maxValueBytes } }`                                |
| `GET`    | `/api/hub/db/<sammlung>`             | Liste: `{ collection, prefix, limit, offset, total, entries }`                  |
| `GET`    | `/api/hub/db/<sammlung>/<schlüssel>` | `{ entry: { key, value, createdAt, updatedAt } }`                               |
| `PUT`    | `/api/hub/db/<sammlung>/<schlüssel>` | legt an oder überschreibt: `{ entry: { collection, key, created, updatedAt } }` |
| `DELETE` | `/api/hub/db/<sammlung>/<schlüssel>` | `{ removed: true }` oder `{ removed: false }`                                   |

`PUT` erwartet genau ein Feld:

```json
{ "value": { "text": "hallo", "anzahl": 3 } }
```

`value` darf jeder JSON-Wert sein – Objekt, Liste, Text, Zahl, `true`, `null`.
`GET` auf einen unbekannten Schlüssel antwortet mit `404`.

Die Liste lässt sich über Suchparameter steuern:

| Parameter | Bedeutung                                              |
| --------- | ------------------------------------------------------ |
| `prefix`  | nur Schlüssel, die so beginnen (höchstens 128 Zeichen) |
| `limit`   | 1 bis 200, Standard 100                                |
| `offset`  | 0 bis 100000                                           |

`total` zählt alle Treffer, nicht nur die Seite. Sortiert wird nach Schlüssel,
und zwar in beiden Treibern gleich – ohne ASCII-Vergleich setzt MySQL die
eigene Kollation voraus.

Namen und Schlüssel:

```text
Sammlung   a–z, 0–9, _ und -, 1–32 Zeichen, beginnend mit a–z oder 0–9
Schlüssel  Buchstaben, Ziffern und . _ : @ -, 1–128 Zeichen
```

Ein Schlüssel wie `user:1` oder `discord:1234567890` ist also erlaubt; ein
Leerzeichen nicht. `%` und `_` sind in einem `prefix` erlaubt und gelten dort als
gewöhnliche Zeichen – der Hub escaped sie, bevor er sie an `LIKE` gibt.

## Der Weg aus dem Bot heraus

### JavaScript und TypeScript

`bots/shared/api.js` bringt die Methoden mit; sie funktionieren für beide
Sprachen, weil TypeScript die Datei ohne Änderung liest.

```js
import { botHubApi as hub } from './api.js';

await hub.db.set('notizen', `user:${message.author.id}`, {
  text: 'hallo',
  zeit: Date.now(),
});

const wert = await hub.db.get('notizen', `user:${message.author.id}`);
// { text: 'hallo', zeit: 1758000000000 } oder null

const seite = await hub.db.list('notizen', { prefix: 'user:', limit: 20 });
// { entries: [{ key, value, createdAt, updatedAt }], total, limit, offset }

await hub.db.remove('notizen', `user:${message.author.id}`);
```

Läuft der Bot ohne Hub (manuell gestartet), liefern die Aufrufe `null`, wie bei
den übrigen Funktionen dieses Moduls.

### Python

`hub_link.py`, nur mit der Standardbibliothek:

```python
from hub_link import db_get, db_list, db_remove, db_set

db_set("notizen", f"user:{message.author.id}", {"text": "hallo"})
wert = db_get("notizen", f"user:{message.author.id}")
seite = db_list("notizen", prefix="user:", limit=20)
db_remove("notizen", f"user:{message.author.id}")
```

`db_get` gibt `None` zurück, wenn es den Schlüssel nicht gibt – und schreibt
dabei keine Fehlermeldung, denn „nicht vorhanden" ist hier eine normale Antwort.

### Java und Kotlin

`HubLink.java`, nur mit dem JDK:

```java
hub.dbSet("notizen", "user:" + event.getUser().getId(), "{\"text\":\"hallo\"}");
String wert = hub.dbGet("notizen", "user:" + event.getUser().getId());
String seite = hub.dbList("notizen", "user:", 20, 0);
hub.dbRemove("notizen", "user:" + event.getUser().getId());
```

Die Werte werden als JSON-Text übergeben und auch so zurückgegeben – die Fassade
bringt absichtlich keinen eigenen JSON-Weg mit, der Bot liest den Text mit
seinem Parser. `dbSet` erwartet gültiges JSON (`"hallo"`, nicht `hallo`).

### Weitere Sprachen

Der HTTP-Vertrag ist absichtlich klein und in jedem Bot-Sprache-Client mit
Standardbibliothek aufzusetzen: `GET`, `PUT`, `DELETE` auf den Pfaden oben,
`Authorization: Bearer $BOT_HUB_TOKEN`, JSON ein und aus. Für Go, C#, Rust und
TypeScript-eigene Anbindungen gibt es bisher keine fertige Datei – hier hilft
dieser Abschnitt, oder es gibt eine Hub-Anbindung als Auftrag.

## SQLite oder MySQL

### SQLite (Standard)

Ohne jede Konfiguration. Der Hub legt beim Start `data/db/bot-hub.sqlite` an,
das Verzeichnis mit `0700`, die Datei mit `0600` – ein Ort, an dem nicht
geschrieben werden darf, fällt also sofort auf und nicht erst beim ersten Bot,
der etwas speichern will. Benutzt wird `node:sqlite` aus der
Node-Standardbibliothek; ein zusätzliches Paket ist nicht nötig.

Ein anderer Ort:

```env
BOT_HUB_DB=sqlite
BOT_HUB_DB_FILE=/var/lib/bot-hub/speicher.sqlite
```

Liegt die Datei außerhalb von `data/`, weist der Hub beim Start darauf hin. Das
ist erlaubt – aber sie darf nicht im Arbeitsordner eines Bots liegen, sonst
könnte dieser sie direkt lesen und die API umgehen.

Sichern heißt: Datei kopieren. Im laufenden Betrieb eignen sich
`sqlite3 data/db/bot-hub.sqlite ".backup ziel.sqlite"` oder ein Kopieren der
drei Dateien (`-wal`, `-shm`), solange der Hub schreibt.

### MySQL

```env
BOT_HUB_DB=mysql
BOT_HUB_DB_HOST=127.0.0.1
BOT_HUB_DB_PORT=3306
BOT_HUB_DB_NAME=bot_hub
BOT_HUB_DB_USER=bot_hub
```

Das Passwort gehört nach `data/secrets/db.env` (Modus `0600`, Verzeichnis `0700`),
nicht in die `.env` – in einer Prozessliste ist es sonst sichtbar:

```dotenv
BOT_HUB_DB_PASSWORD="…"
```

Die Datei braucht das Paket `mysql2`; es ist als optionale Abhängigkeit
eingetragen und wird nur geladen, wenn `BOT_HUB_DB=mysql` gesetzt ist:

```bash
npm install mysql2
```

Datenbank und Benutzer legt der Hub nicht an – das macht ein Betreiber einmalig
mit möglichst wenig Rechten:

```sql
CREATE DATABASE bot_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'bot_hub'@'localhost' IDENTIFIED BY 'ein-passwort';
GRANT SELECT, INSERT, UPDATE, DELETE ON bot_hub.* TO 'bot_hub'@'localhost';
FLUSH PRIVILEGES;
```

Der Hub legt beim ersten Zugriff nur die Tabelle `bot_store` an. `root` als
Benutzer lehnt er ab.

Hinweis zum `GRANT`: Für das Anlegen der Tabelle braucht der Benutzer zusätzlich
`CREATE`, `ALTER`, `INDEX` und `DROP` auf `bot_hub.*` – sonst startet der Hub
zwar, scheitert aber beim ersten Speichern eines Bots. Genau das nimmt der
Abschnitt [Eigenes MySQL](#eigenes-mysql-bothub_dbmysql-container) einem ab.

Drei Schranken beim Start:

1. `BOT_HUB_DB_HOST` muss auf diesem Rechner liegen – sonst Abbruch mit dem
   Hinweis, dass ein fremder Rechner sonst auf die Bot-Daten zugreifen könnte.
   Alternativ `BOT_HUB_DB_SOCKET=/pfad/mysqld.sock`.
2. `BOT_HUB_TEST_MODE=1` verlangt SQLite. Nur mit dem zusätzlichen
   `BOT_HUB_TEST_MYSQL=1` darf ein Testlauf MySQL anrühren.
3. Unbekannte Zugangsdaten führen nicht zum Abbruch beim Start, sondern zu einem
   Fehler beim ersten Zugriff. Ein Hub darf hochlaufen, während MySQL noch nicht
   bereit ist – anders als SQLite, das eine lokale Datei ist und deshalb sofort
   geöffnet wird.

Unter einem Unix-Socket ist die Verbindung ohne Netz; auf Loopback ohne
Verschlüsselung, was für Verkehr, den niemand mitlesen kann, in Ordnung ist und
im Klartext der Anleitung steht.

## Eigenes MySQL (`BOT_HUB_DB=mysql-container`)

Wer MySQL betreiben will, ohne es selbst aufzusetzen, nimmt diesen Wert:

```env
BOT_HUB_DB=mysql-container
```

Damit startet der Hub seinen **eigenen** MySQL-Container und richtet ihn beim
ersten Start selbst ein. Sonst ändert sich für einen Bot nichts: er erreicht
seinen Bereich weiterhin nur über `/api/hub/db` und bekommt weiterhin keine
Zugangsdaten. Der Unterschied liegt allein darin, wer den Container baut.

Beim ersten Start passiert, in dieser Reihenfolge:

1. Netz `<präfix>-mysql-net` anlegen und Container `<präfix>-mysql` erstellen.
   Daten landen in `data/mysql`.
2. Zwei zufällige Passwörter erzeugen, je 48 Zeichen aus
   `A–Z a–z 0–9 - _`, aus `crypto.randomBytes`. Der Hub verlangt mindestens 30
   Zeichen und lehnt kürzere ab.
3. Das Admin-Passwort in `data/secrets/mysql-init.env` schreiben (Modus `0600`
   in einem Verzeichnis `0700`) und den Container damit starten. MySQL liest es
   genau einmal, beim ersten Initialisieren des Datenspeichers.
4. Warten, bis `mysqld` antwortet, dann als Admin die Datenbank anlegen, den
   Arbeitsbenutzer samt Rechten erzeugen und `FLUSH PRIVILEGES` ausführen.
5. **`DROP USER IF EXISTS 'root'@'%'`** – danach kann sich von außen niemand
   mehr als root anmelden, auch nicht mit dem richtigen Admin-Passwort.
6. Die Datei mit dem Admin-Passwort löschen.
7. Das Arbeitspasswort nach `data/secrets/db.env` (Modus `0600`) schreiben.

`root@'localhost'` bleibt bewusst bestehen. Den kann nur benutzen, wer sich über
`docker exec` im Container befindet – und wer das kann, braucht kein Passwort.

Bei jedem weiteren Start prüft der Hub zuerst, ob er mit dem gespeicherten
Arbeitspasswort hineinkommt. Wenn ja, passiert gar nichts (das dauert unter einer
Sekunde). Wenn nein, bricht er ab **statt** neu einzurichten: ein stiller zweiter
Bootstrap würde einen zweiten Admin-Zugang erzeugen, und genau den gibt es hier
nicht.

### Warum die Rechte so geschnitten sind

Der Arbeitsbenutzer bekommt `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER,
INDEX, DROP, REFERENCES` – und zwar ausschließlich auf `bot_hub.*`:

- Kein `GRANT OPTION`. Der Benutzer kann keine Rechte weitergeben, die er
  nicht hat.
- Nichts außerhalb der Hub-Datenbank. `CREATE DATABASE` für eine zweite
  Datenbank scheitert, ebenso jeder Zugriff auf `mysql.user`.
- Kein `FILE`, kein `SUPER`, kein `PROCESS`. Damit lässt sich weder auf dem
  Server Dateien lesen und schreiben noch etwas über die anderen Prozesse
  herausfinden.
- `CREATE`, `ALTER`, `INDEX` und `DROP` gehören dazu, weil der Treiber seine
  Tabellen beim ersten Verbinden selbst anlegt und spätere Schemaänderungen
  ohne den Hub-Betrieb möglich sein sollen.

Dasselbe in eigener Regie nachzubauen ist möglich, aber mit einem Unterschied:
ein Betreiber hat danach einen Admin-Zugang, den niemand mehr wegnimmt. Genau den
gibt es hier nicht.

### Erreichbarkeit

Der Container veröffentlicht `127.0.0.1:<Port>:3306` – Standardport `3307`, weil
`3306` auf dem Host häufig schon belegt ist. Nie `0.0.0.0`. Er hängt zusätzlich
an einem eigenen Netz, an dem kein Bot-Container hängt: Bot-Container laufen auf
der Default-Bridge und haben dorthin keine Route. Ein Bot erreicht die Datenbank
also weder direkt noch über `host.docker.internal`, selbst wenn
`BOT_HUB_CONTAINER_URL` gesetzt ist – getestet in `test/mysql-container.test.js`.

`BOT_HUB_DB_HOST`, `BOT_HUB_DB_SOCKET` und `BOT_HUB_DB_PASSWORD` werden bei
diesem Treiberwert **abgelehnt**, nicht ignoriert. Wer eines davon setzt,
rechnet mit einer Adresse oder einem Passwort, das es hier nicht gibt; ein
stillschweigendes Übergehen wäre die schlechtere Antwort.

### Wenn etwas nicht geht

**Der Arbeitsbenutzer kommt nicht mehr hinein**, zum Beispiel weil
`data/secrets/db.env` verloren ging. Es gibt keinen zweiten Weg: der
Admin-Zugang von außen ist absichtlich weg, und das war die Zusage. Der Hub
sagt das beim Start auch so und nennt den Ausweg:

```env
BOT_HUB_MYSQL_RESET=1
```

Damit werden Container, Netz und `data/mysql` verworfen und mit neuen Passwörtern
neu angelegt. **Danach sind alle Bot-Daten weg.** Der Hub warnt laut, bevor er
es tut, und räumt am Ende auf.

**Der erste Start dauert zu lange.** mysqld initialisiert erst den
Datenspeicher; je nach Rechner kann das eine Weile brauchen:

```env
BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS=300000
```

Bei „Access denied" ist der Datenspeicher bereits mit einem _anderen_
Admin-Passwort initialisiert worden – dann hilft nur `BOT_HUB_MYSQL_RESET=1`.

### Einstellungen

| Variable                           | Standard     | Zweck                                           |
| ---------------------------------- | ------------ | ----------------------------------------------- |
| `BOT_HUB_MYSQL_IMAGE`              | `mysql:8.4`  | Image des Containers                            |
| `BOT_HUB_MYSQL_DATA`               | `data/mysql` | Datenverzeichnis; darf nicht in `bots/` liegen  |
| `BOT_HUB_MYSQL_MEMORY`             | `1g`         | Speichergrenze des Containers                   |
| `BOT_HUB_MYSQL_CPUS`               | `2`          | CPU-Grenze des Containers                       |
| `BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS` | `180000`     | Wartezeit auf den ersten Start                  |
| `BOT_HUB_MYSQL_RESET`              | –            | `1` verwirft alles und richtet es neu ein       |
| `BOT_HUB_DB_NAME`                  | `bot_hub`    | Name der Datenbank                              |
| `BOT_HUB_DB_USER`                  | `bot_hub`    | Name des Arbeitsbenutzers; `root` ist abgelehnt |
| `BOT_HUB_DB_PORT`                  | `3307`       | Port auf dem Host; 1024–65535                   |

Die letzten drei gelten auch für `BOT_HUB_DB=mysql` – dort sind sie allerdings
Pflicht, weil es ohne sie nichts gäbe.

## Was der Hub nicht kann und nicht beabsichtigt

- **Keine Abfragen über die API.** Ein Bot kann nicht beliebig filtern, sortieren
  oder verbinden. Wer das braucht, führt die Rechnung im Code aus.
- **Keine Migration zwischen SQLite und MySQL.** Beide nutzen dieselbe Tabelle
  und dieselben Anweisungen, aber ein Umzug ist eine eigene Aufgabe.
- **Kein Geheimnisspeicher.** Der Bot-Speicher ist kein Ersatz für
  `data/secrets/<bot-id>.env`. Er ist nicht verschlüsselt, und jeder mit Lesezugriff
  auf die Datei (bzw. auf die MySQL-Datenbank) liest ihn im Klartext.
- **Kein Weg aus dem Hub heraus.** Der Hub hat keinen Endpunkt, der einem Bot
  Daten von außen nachliefert; es gibt keinen Lesezugriff für die Bot-Seite und
  keinen für das Dashboard.
- **Keine Rechte auf Bot-Ebene.** Wer den Laufzeit-Token eines Bots hat, hat
  seinen ganzen Bereich. Es gibt keine Sammlungen, die ein Bot nicht sehen darf.

## Tests

```bash
npm test                # SQLite, inklusive API über einen echten Bot-Prozess
npm run test:mysql      # dieselben Zusicherungen gegen eine echte Datenbank
```

Der MySQL-Lauf braucht einen erreichbaren Server, sonst wird er übersprungen:

```bash
docker run -d --name bothub-db-test \
  -e MYSQL_ROOT_PASSWORD=probe-root -e MYSQL_DATABASE=bothub_probe \
  -e MYSQL_USER=bothub -e MYSQL_PASSWORD=probe-pass \
  -p 127.0.0.1:13306:3306 mariadb:11

npm run test:mysql
```

Abgedeckt sind: Anlegen, Überschreiben, Lesen, Löschen, Trennung zweier Bots,
Zugriff mit dem Panel-Token (`403`), fehlende und falsche Token (`401`),
Grenzwerte für Werte und Seiten, ungültige Namen, ein Schlüssel mit
SQL-Text darin, die Reihenfolge der Liste und – auf MySQL – dieselben Wege über
die HTTP-API mit einem echten Bot-Prozess.
