# Erklärung von `api.js`

Diese Datei ist eine kleine **Übersetzungsschicht zwischen der Weboberfläche und dem Server**.

Einfach gesagt:

- Die Oberfläche möchte zum Beispiel „zeige alle Bots“ oder „starte Bot Nummer 3“ ausführen.
- `api.js` übersetzt diesen Wunsch in eine HTTP-Anfrage an den Server.
- Der Server antwortet.
- `api.js` liest die Antwort und gibt die Daten an die Oberfläche zurück.

Die Datei liegt im Projekt unter `src/api.js`.

---

## 1. Die zentrale Funktion `request`

Der wichtigste Teil der Datei ist diese Funktion:

```js
const request = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
};
```

Sie erledigt die wiederkehrende Arbeit für **alle** Anfragen. Dadurch muss nicht jede einzelne API-Funktion immer wieder denselben Code für `fetch`, JSON und Fehlerbehandlung enthalten.

### 1.1 `async`

```js
const request = async (...) => {
```

`async` bedeutet: Die Funktion arbeitet mit Vorgängen, die etwas dauern können.

Eine Anfrage über das Internet ist nicht sofort fertig. Der Browser muss:

1. die Anfrage abschicken,
2. auf den Server warten,
3. die Antwort empfangen,
4. die Antwort auswerten.

Eine `async`-Funktion liefert deshalb ein sogenanntes **Promise** zurück. Ein Promise kann man sich als Zusage vorstellen: „Ich liefere dir später das Ergebnis.“

### 1.2 `path` und `options`

```js
const request = async (path, options = {}) => {
```

Die Funktion bekommt zwei Eingaben:

- `path`: den Weg zur gewünschten Server-Funktion, zum Beispiel `'/bots'`
- `options`: zusätzliche Einstellungen für die Anfrage, zum Beispiel die HTTP-Methode oder Daten, die gesendet werden sollen

```js
options = {};
```

Wenn keine Einstellungen übergeben werden, verwendet JavaScript ein leeres Objekt. So funktioniert auch ein einfacher Aufruf:

```js
request('/health');
```

ohne dass `options` ausdrücklich angegeben werden muss.

### 1.3 Die Anfrage mit `fetch`

```js
const response = await fetch(`/api${path}`, {
```

`fetch` ist eine eingebaute Browser-Funktion zum Senden von HTTP-Anfragen.

Vor `path` wird immer `/api` gesetzt. Aus

```js
request('/bots');
```

wird also tatsächlich eine Anfrage an:

```text
/api/bots
```

Das anfängliche `/` bedeutet: Die Adresse beginnt am aktuellen Host der Webanwendung. Wenn die Anwendung beispielsweise unter `http://localhost:5173` läuft, geht die Anfrage an:

```text
http://localhost:5173/api/bots
```

`await` wartet, bis der Server geantwortet hat. Ohne `await` würde das Programm sofort weitermachen, obwohl die Antwort noch gar nicht angekommen ist.

### 1.4 Standard-Header

```js
headers: { 'content-type': 'application/json' },
```

Ein Header ist eine Zusatzinformation über eine HTTP-Anfrage.

Der Header `content-type: application/json` sagt dem Server:

> „Die Daten, die ich sende, sind im JSON-Format.“

JSON ist eine Textdarstellung von Daten. Ein JavaScript-Objekt wie dieses:

```js
{ name: 'Mein Bot', language: 'javascript' }
```

wird als JSON ungefähr so übertragen:

```json
{ "name": "Mein Bot", "language": "javascript" }
```

### 1.5 Optionen mit `...options` hinzufügen

```js
...options,
```

Die drei Punkte sind der **Spread-Operator**. Er kopiert alle Eigenschaften aus `options` in die Einstellungen für `fetch`.

Beispiel:

```js
request('/bots', {
  method: 'POST',
  body: { name: 'Mein Bot' },
});
```

Die Einstellungen für `fetch` enthalten dadurch:

```js
{
  headers: { 'content-type': 'application/json' },
  method: 'POST',
  body: { name: 'Mein Bot' }
}
```

So können die einzelnen API-Funktionen festlegen, ob sie zum Beispiel `POST`, `PATCH`, `PUT` oder `DELETE` verwenden.

### 1.6 Den Anfrage-Inhalt in JSON umwandeln

```js
body: options.body ? JSON.stringify(options.body) : undefined,
```

Hier wird geprüft, ob überhaupt ein `body` vorhanden ist.

- Wenn `options.body` vorhanden ist, wird er mit `JSON.stringify` in JSON-Text umgewandelt.
- Wenn kein `body` vorhanden ist, wird `undefined` verwendet. Dann wird kein Anfrage-Inhalt gesendet.

Beispiel:

```js
options.body = { force: true };
```

wird zu:

```json
{ "force": true }
```

Das ist nötig, weil `fetch` Daten nicht automatisch als JSON-Text verschickt.

### 1.7 Die Serverantwort als Text lesen

```js
const text = await response.text();
```

Die Antwort des Servers wird zunächst vollständig als Text gelesen.

Auch wenn der Server JSON zurückgibt, kommt die Antwort zunächst als Zeichenkette an. `await` wartet wieder, bis der Text vollständig empfangen wurde.

### 1.8 JSON-Antwort in JavaScript-Daten umwandeln

```js
const data = text ? JSON.parse(text) : {};
```

Diese Zeile bedeutet:

- Gibt es Antworttext, wird er mit `JSON.parse` in ein JavaScript-Objekt umgewandelt.
- Gibt es keinen Antworttext, wird stattdessen ein leeres Objekt `{}` verwendet.

Beispiel:

```json
{ "id": 7, "name": "Mein Bot" }
```

wird zu einem JavaScript-Objekt:

```js
{
  id: 7,
  name: 'Mein Bot'
}
```

Ein leerer Antwortkörper kann beispielsweise bei einer erfolgreichen Löschaktion vorkommen. Durch `{}` bleibt das Ergebnis trotzdem ein gültiger JavaScript-Wert.

### 1.9 Fehler prüfen

```js
if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
```

`response.ok` ist bei einer erfolgreichen HTTP-Antwort `true`. Bei einem Fehler, zum Beispiel `404` oder `500`, ist es `false`.

Wenn ein Fehler vorliegt, wird ein Fehlerobjekt erstellt:

- Gibt es im Server-Ergebnis eine verständliche Fehlermeldung unter `data.error`, wird diese verwendet.
- Sonst wird der HTTP-Status verwendet, zum Beispiel `HTTP 404`.

Beispiel einer Serverantwort:

```json
{ "error": "Bot wurde nicht gefunden" }
```

Dann wird ein Fehler mit der Nachricht `Bot wurde nicht gefunden` ausgelöst. Der aufrufende Code kann diesen Fehler dann anzeigen oder anderweitig behandeln.

### 1.10 Erfolgreiche Daten zurückgeben

```js
return data;
```

Wenn kein Fehler gefunden wurde, gibt die Funktion die vom Server gelesenen Daten zurück.

Ein Aufruf sieht für andere Teile der Oberfläche zum Beispiel so aus:

```js
const bots = await api.list();
```

`bots` enthält dann die vom Server gelieferten Bot-Daten.

---

## 2. Die möglichen Ereignisarten

```js
const STREAM_TYPES = [
  'snapshot',
  'created',
  'bot',
  'deleted',
  'log',
  'panel',
  'toast',
];
```

Diese Liste enthält Namen für Ereignisse, die der Server über eine dauerhafte Verbindung an den Browser schicken kann.

Die Namen bedeuten wahrscheinlich:

- `snapshot`: ein vollständiger aktueller Zustand
- `created`: etwas wurde erstellt
- `bot`: ein Ereignis, das einen Bot betrifft
- `deleted`: etwas wurde gelöscht
- `log`: eine neue Log-Zeile
- `panel`: eine Änderung an einem Bot-Panel
- `toast`: eine kurze Nachricht für den Benutzer, zum Beispiel eine Erfolgsmeldung

Die Liste selbst führt noch keine Verbindung aus. Sie beschreibt nur, auf welche Arten von Nachrichten `api.js` reagieren soll.

---

## 3. Abonnenten und die Stream-Verbindung

```js
const listeners = new Set();
let source = null;
```

### 3.1 `listeners`

`listeners` ist ein `Set`, also eine Sammlung von Einträgen ohne Duplikate.

Darin werden Funktionen gespeichert, die informiert werden möchten, wenn ein Ereignis eintrifft. Ein solcher Eintrag wird oft **Listener** oder **Callback** genannt.

Die Oberfläche kann sich also anmelden und sagen:

```js
api.events((type, payload) => {
  console.log(type, payload);
});
```

Sobald ein Server-Ereignis eintrifft, wird diese Funktion aufgerufen.

Ein `Set` verhindert, dass exakt dieselbe Funktion mehrfach gespeichert wird.

### 3.2 `source`

```js
let source = null;
```

`source` wird später die Verbindung zum Ereignis-Stream enthalten.

Am Anfang gibt es noch keine Verbindung, daher ist der Wert `null`.

---

## 4. Einen Ereignis-Stream öffnen

```js
const openStream = () => {
  if (source) return;
  source = new EventSource('/api/events');
```

`EventSource` ist eine Browser-Technik für **Server-Sent Events**, kurz SSE.

Damit kann der Server eine Verbindung zum Browser offen halten und jederzeit neue Ereignisse schicken. Das ist nützlich für Live-Updates, ohne dass die Oberfläche ständig nachfragen muss.

Die Verbindung geht an:

```text
/api/events
```

Die erste Zeile ist wichtig:

```js
if (source) return;
```

Wenn bereits eine Verbindung existiert, wird die Funktion sofort beendet. So wird verhindert, dass aus Versehen mehrere identische Streams für dieselbe Oberfläche aufgebaut werden.

---

## 5. Ereignisse des Streams empfangen

```js
for (const type of STREAM_TYPES) {
  source.addEventListener(type, (event) => {
    const payload = JSON.parse(event.data);
    for (const listener of listeners) listener(type, payload);
  });
}
```

Die Schleife geht jeden Ereignisnamen aus `STREAM_TYPES` durch.

Für jeden Typ wird ein Ereignisempfänger eingerichtet:

```js
source.addEventListener(type, (event) => {
```

Wenn zum Beispiel ein `log`-Ereignis ankommt, wird der zugehörige Code ausgeführt.

### 5.1 Die Daten aus der Nachricht lesen

```js
const payload = JSON.parse(event.data);
```

`event.data` enthält die vom Server gesendeten Daten als Text. Da die Anwendung JSON erwartet, wird der Text mit `JSON.parse` wieder in JavaScript-Daten umgewandelt.

Beispiel einer Nachricht:

```json
{ "botId": 3, "message": "Bot gestartet" }
```

Danach kann der Code mit `payload.botId` und `payload.message` arbeiten.

### 5.2 Alle angemeldeten Stellen informieren

```js
for (const listener of listeners) listener(type, payload);
```

Jede gespeicherte Listener-Funktion wird aufgerufen. Sie bekommt zwei Werte:

1. `type`: der Ereignisname, zum Beispiel `'log'`
2. `payload`: die dazugehörigen Daten

Mehrere Bereiche der Oberfläche können denselben Stream verwenden. Dadurch muss zum Beispiel ein Bot-Fenster keine eigene zweite Serververbindung aufbauen.

---

## 6. Öffnen und Fehler des Streams weitergeben

```js
source.addEventListener('open', () => {
  for (const listener of listeners) listener('open', null);
});
source.addEventListener('error', () => {
  for (const listener of listeners) listener('error', null);
});
```

Das Ereignis `open` wird ausgelöst, wenn die Verbindung erfolgreich geöffnet wurde. Alle Listener werden dann mit folgendem Aufruf informiert:

```js
listener('open', null);
```

Das Ereignis `error` wird ausgelöst, wenn beim Stream ein Problem auftritt. Auch dann werden alle Listener informiert:

```js
listener('error', null);
```

Bei diesen beiden Ereignissen gibt es keine Nutzdaten, deshalb wird `null` übergeben.

---

## 7. Das öffentliche `api`-Objekt

```js
export const api = {
```

`export` macht das Objekt für andere Dateien verfügbar. Eine andere Datei kann es beispielsweise so importieren:

```js
import { api } from './api.js';
```

Danach können die dort enthaltenen Funktionen benutzt werden.

Die Funktionen sind absichtlich kurz. Sie legen nur den passenden URL-Pfad, die HTTP-Methode und gegebenenfalls den Inhalt fest. Die eigentliche gemeinsame Arbeit erledigt `request`.

---

## 8. Allgemeine Informationen

```js
health: () => request('/health'),
languages: () => request('/languages'),
list: () => request('/bots'),
```

### `health`

```js
api.health();
```

fragt `/api/health` ab. Damit kann geprüft werden, ob der Server erreichbar und gesund ist.

### `languages`

```js
api.languages();
```

fragt `/api/languages` ab. Vermutlich liefert der Server damit die unterstützten Programmiersprachen.

### `list`

```js
api.list();
```

fragt `/api/bots` ab und liefert eine Liste der vorhandenen Bots.

---

## 9. Bots erstellen und verändern

```js
create: (config) => request('/bots', { method: 'POST', body: config }),
```

`create` erstellt einen Bot.

```js
api.create({
  name: 'Mein Bot',
  language: 'javascript',
});
```

Daraus wird eine `POST`-Anfrage an `/api/bots`. `POST` wird üblicherweise verwendet, wenn ein neuer Datensatz erstellt wird.

```js
update: (id, config) =>
  request(`/bots/${id}`, { method: 'PATCH', body: config }),
```

`update` verändert einen vorhandenen Bot. Die ID wird in die URL eingesetzt:

```js
api.update(3, { name: 'Neuer Name' });
```

wird zu:

```text
PATCH /api/bots/3
```

`PATCH` bedeutet normalerweise: Nur die angegebenen Eigenschaften sollen geändert werden, nicht zwingend der komplette Bot.

```js
remove: (id) => request(`/bots/${id}`, { method: 'DELETE' }),
```

`remove` löscht einen Bot:

```text
DELETE /api/bots/3
```

`DELETE` ist die HTTP-Methode für das Löschen.

---

## 10. Bots steuern

```js
start: (id) => request(`/bots/${id}/start`, { method: 'POST' }),
install: (id, force = false) =>
  request(`/bots/${id}/install`, { method: 'POST', body: { force } }),
stop: (id) => request(`/bots/${id}/stop`, { method: 'POST' }),
kill: (id) => request(`/bots/${id}/kill`, { method: 'POST' }),
restart: (id) => request(`/bots/${id}/restart`, { method: 'POST' }),
```

Alle diese Funktionen verwenden `POST`, weil sie eine Aktion auslösen:

- `start(3)` startet Bot 3.
- `install(3)` installiert die benötigten Abhängigkeiten von Bot 3.
- `stop(3)` bittet Bot 3, normal anzuhalten.
- `kill(3)` beendet Bot 3 zwangsweise.
- `restart(3)` startet Bot 3 neu.

### Der Standardwert bei `install`

```js
install: (id, force = false) =>
```

Wenn beim Aufruf kein zweiter Parameter angegeben wird, ist `force` automatisch `false`:

```js
api.install(3);
```

Das entspricht:

```js
api.install(3, false);
```

Möchte man eine erzwungene Installation auslösen, kann man schreiben:

```js
api.install(3, true);
```

Der Server bekommt dann:

```json
{ "force": true }
```

---

## 11. Bot-Logs laden

```js
logs: (id, tail = 200) =>
  request(`${id ? `/bots/${id}` : ''}/logs?tail=${tail}`),
```

Diese Funktion lädt Log-Ausgaben.

Der Ausdruck:

```js
id ? `/bots/${id}` : '';
```

ist ein sogenannter **ternärer Operator**. Er bedeutet:

- Wenn `id` vorhanden ist, wird `/bots/ID` eingesetzt.
- Wenn `id` nicht vorhanden ist, wird ein leerer Text eingesetzt.

Beispiele:

```js
api.logs(3, 50);
```

ergibt den Pfad:

```text
/api/bots/3/logs?tail=50
```

```js
api.logs();
```

ergibt:

```text
/api/logs?tail=200
```

`tail = 200` bedeutet: Wenn keine Anzahl angegeben wird, werden standardmäßig die letzten 200 Log-Einträge angefordert. Der Teil `?tail=50` ist ein Query-Parameter, also eine Zusatzangabe in der URL.

---

## 12. Dateien im Startordner

Der Startordner eines Bots (`bots/<id>/startordner/`) ist die Quelle, aus der
der Hub die Dateien in den Container des Bots spiegelt. Diese sechs Funktionen
sind die Dateiverwaltung im Hub:

```js
files: (id) => request(`/bots/${encodeURIComponent(id)}/files`),
```

Listet alle Dateien auf, die beim Spiegeln in den Container wandern:

```js
api.files('3f2a-…');
```

liefert:

```json
{
  "startordner": "bots/3f2a-…/startordner",
  "dateien": [{ "pfad": "bot.py", "groesse": 42, "mtimeMs": 1730000000000 }],
  "uebersprungen": [".env (Geheimnis)"],
  "mehr": false
}
```

`uebersprungen` nennt die Einträge, die absichtlich nicht mitgenommen werden –
Geheimnisse und Verweise. Sie werden gemeldet, nicht verschwiegen.

```js
fileRead: (id, path) =>
  request(`/bots/${encodeURIComponent(id)}/files/${encodePath(path)}`),
```

Liest eine einzelne Datei und liefert ihren Inhalt als Text.

```js
fileWrite: (id, path, inhalt) =>
  request(`/bots/${encodeURIComponent(id)}/files/${encodePath(path)}`, {
    method: 'PUT',
    body: { inhalt },
  }),
```

Schreibt eine Datei – und spiegelt sie sofort in den Workspace. Man muss danach
nichts weiter anklicken: was hier hochgeladen wird, ist danach im Container.

```js
fileDelete: (id, path) =>
  request(`/bots/${encodeURIComponent(id)}/files/${encodePath(path)}`, {
    method: 'DELETE',
  }),
```

Löscht eine Datei aus dem Startordner und aus dem Workspace.

```js
fileMkdir: (id, path) =>
  request(`/bots/${encodeURIComponent(id)}/files`, {
    method: 'POST',
    body: { ordner: path },
  }),
```

Legt einen Ordner an, damit Unterordner in der Dateiliste auftauchen.

```js
filesSync: (id) =>
  request(`/bots/${encodeURIComponent(id)}/files`, {
    method: 'POST',
    body: { uebernehmen: true },
  }),
```

Übernimmt den ganzen Startordner in den Workspace. Nötig, wenn jemand Dateien
auf dem Server oder neben dem Browser geändert hat.

### Warum `encodePath` und nicht `encodeURIComponent`?

Ein Dateipfad kann einen Schrägstrich enthalten – und der ist genau das Zeichen,
das einen Pfad von einem Dateinamen trennt. Deshalb wird jeder Abschnitt einzeln
kodiert und wieder mit einem Schrägstrich verbunden:

```js
encodePath('src/hilfe.py');
```

ergibt:

```text
src/hilfe.py
```

und `encodePath('mein ordner/x.txt')` ergibt:

```text
mein%20ordner/x.txt
```

Mit einem einzigen `encodeURIComponent` für den ganzen Pfad wäre daraus
`src%2Fhilfe.py` geworden – ein einziger „Dateiname“ mit einem unmöglichen
Zeichen darin.

---

## 13. Panel-Funktionen

Ein Panel ist vermutlich die Bedienoberfläche oder das Statusfenster eines Bots.

```js
panel: (id) => request(`/bots/${id}/panel`),
```

Lädt das Panel eines bestimmten Bots.

```js
panelReload: (id) =>
  request(`/bots/${id}/panel/reload`, { method: 'POST' }),
```

Lädt oder aktualisiert das Panel neu.

```js
panelReset: (id) =>
  request(`/bots/${id}/panel`, { method: 'DELETE' }),
```

Setzt das Panel zurück oder entfernt es.

```js
panelState: (id, state) =>
  request(`/bots/${id}/panel/state`, {
    method: 'PUT',
    body: { state },
  }),
```

Speichert den Zustand eines Panels:

```js
api.panelState(3, { open: true });
```

Dabei wird eine `PUT`-Anfrage mit folgendem Inhalt gesendet:

```json
{ "state": { "open": true } }
```

`PUT` wird häufig verwendet, wenn ein bestimmter Zustand vollständig gespeichert oder ersetzt werden soll.

```js
panelSave: (id, values) =>
  request(`/bots/${id}/panel/settings`, {
    method: 'PUT',
    body: { values },
  }),
```

Speichert Einstellungen des Panels. Zum Beispiel:

```js
api.panelSave(3, {
  theme: 'dark',
  refreshSeconds: 10,
});
```

Die Daten werden als `values` verpackt:

```json
{
  "values": {
    "theme": "dark",
    "refreshSeconds": 10
  }
}
```

```js
panelCommand: (id, command, args = {}) =>
  request(`/bots/${id}/panel/commands/${encodeURIComponent(command)}`, {
    method: 'POST',
    body: { args },
  }),
```

Mit `panelCommand` wird ein Befehl für ein Bot-Panel ausgeführt.

```js
api.panelCommand(3, 'say hello', { channel: 'general' });
```

### Warum `encodeURIComponent`?

Befehle können Leerzeichen oder Sonderzeichen enthalten. Solche Zeichen sind in einer URL problematisch.

```js
encodeURIComponent('say hello');
```

macht daraus ungefähr:

```text
say%20hello
```

So bleibt der Befehl ein sicherer und gültiger Teil der URL.

`args = {}` bedeutet, dass ein Befehl auch ohne zusätzliche Argumente aufgerufen werden kann. In diesem Fall wird ein leeres Objekt gesendet:

```json
{ "args": {} }
```

---

## 14. Live-Ereignisse abonnieren

```js
events: (onEvent) => {
  listeners.add(onEvent);
  openStream();
  return () => listeners.delete(onEvent);
},
```

Diese Funktion meldet einen neuen Listener für Live-Ereignisse an.

Beispiel:

```js
const unsubscribe = api.events((type, payload) => {
  if (type === 'log') {
    console.log('Neue Log-Nachricht:', payload);
  }
});
```

Dabei passiert Folgendes:

1. Die Callback-Funktion `onEvent` wird in `listeners` gespeichert.
2. `openStream()` sorgt dafür, dass der gemeinsame SSE-Stream geöffnet wird.
3. Wenn später ein Ereignis eintrifft, wird `onEvent(type, payload)` aufgerufen.

### Abmelden

Die Funktion gibt eine weitere Funktion zurück:

```js
return () => listeners.delete(onEvent);
```

Diese zurückgegebene Funktion ist die Abmeldefunktion. Sie kann so benutzt werden:

```js
unsubscribe();
```

Danach wird der Listener aus der Sammlung entfernt und bekommt keine weiteren Ereignisse.

Wichtig: Die Verbindung selbst wird hier nicht geschlossen. Sie kann weiterhin von anderen Teilen der Oberfläche verwendet werden. So bleibt es bei einer gemeinsamen Verbindung für alle Abonnenten.

---

## 15. Ein kompletter Beispielablauf

Der folgende Code:

```js
const bots = await api.list();
```

läuft gedanklich so ab:

1. `api.list` wird aufgerufen.
2. `api.list` ruft `request('/bots')` auf.
3. `request` hängt `/api` davor.
4. Der Browser sendet eine Anfrage an `/api/bots`.
5. Der Server antwortet, zum Beispiel mit JSON.
6. `response.text()` liest die Antwort.
7. `JSON.parse` wandelt den Text in JavaScript-Daten um.
8. `response.ok` wird geprüft.
9. Bei Erfolg werden die Bot-Daten zurückgegeben.
10. Die Variable `bots` enthält nun das Ergebnis.

Bei einem Fehler, etwa wenn der Server `404` zurückgibt, wird kein normales Ergebnis zurückgegeben. Stattdessen wird ein Fehler ausgelöst:

```js
try {
  const bots = await api.list();
} catch (error) {
  console.error('Bots konnten nicht geladen werden:', error.message);
}
```

---

## 16. Zusammenfassung in einfachen Worten

`api.js` ist die zentrale Fernbedienung der Weboberfläche:

- `request` vereinheitlicht alle HTTP-Anfragen.
- Die Funktionen `health`, `list`, `create`, `update` und `remove` verwalten Bot-Daten.
- `start`, `install`, `stop`, `kill` und `restart` steuern laufende Bots.
- `logs` lädt Protokollausgaben.
- Die `files...`-Funktionen verwalten die Dateien im Startordner eines Bots und
  spiegeln sie in dessen Container.
- Die `panel...`-Funktionen verwalten die Bot-Panels.
- `events` und `EventSource` liefern Live-Änderungen vom Server.
- JSON wird beim Senden erzeugt und beim Empfangen wieder gelesen.
- Fehlerantworten des Servers werden als JavaScript-Fehler weitergegeben.

Die Datei enthält selbst keine Bot-Logik. Sie entscheidet also nicht, **wie** ein Bot gestartet wird. Sie stellt nur die Verbindung her und sagt dem Server, **welche Aktion** ausgeführt werden soll.
