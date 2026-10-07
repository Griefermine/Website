# Erklärung von `src/main.js`

## Überblick

Die Datei `src/main.js` ist die zentrale Steuerdatei der Weboberfläche. Sie verbindet:

1. die HTML-Seite,
2. die Kommunikation mit dem Backend,
3. den gespeicherten Zustand der Anwendung,
4. die Darstellung von Bots, Statistiken und Logs,
5. die Klicks und Eingaben des Benutzers.

Man kann sich `main.js` wie einen Dirigenten vorstellen: Die einzelnen Dateien enthalten die Instrumente, aber `main.js` entscheidet, wann welches Instrument gespielt wird.

Der Ablauf lässt sich grob so zusammenfassen:

```text
Webseite wird geladen
        ↓
main.js startet
        ↓
Buttons und Eingabefelder werden angeschlossen
        ↓
Bots, Sprachen und Logs werden vom Backend geladen
        ↓
Die Oberfläche wird gezeichnet
        ↓
Live-Änderungen werden über den Event-Stream empfangen
        ↓
Die Oberfläche wird bei Änderungen aktualisiert
```

---

## 1. Die benötigten Dateien importieren

Ganz oben werden andere Dateien eingebunden:

```js
import './styles.css';
```

Damit wird die CSS-Datei geladen. Sie bestimmt das Aussehen der Seite. Ohne diesen Import wären die HTML-Elemente zwar vorhanden, aber nicht mit dem vorgesehenen Layout und Design formatiert.

### Kommunikation mit dem Backend

```js
import { api } from './api.js';
```

Das Objekt `api` enthält Funktionen für Anfragen an das Backend. Beispiele:

```js
api.languages();
api.list();
api.start(id);
api.stop(id);
api.create(config);
api.remove(id);
```

Ein Aufruf wie:

```js
await api.start(id);
```

sendet im Hintergrund eine Anfrage an das Backend, damit der Bot mit dieser ID gestartet wird.

### Zustand der Anwendung

```js
import {
  clearLogs,
  getState,
  prependLogs,
  removeBot,
  setState,
  subscribe,
  upsertBot,
} from './state.js';
```

Diese Funktionen verwalten die Daten, die sich die Oberfläche aktuell merkt. Der Zustand sieht ungefähr so aus:

```js
{
  bots: [],
  languages: [],
  logs: [],
  connected: false,
  filter: 'all',
  query: '',
  selectedBotId: null,
  logLevelFilter: 'all'
}
```

Die wichtigsten Funktionen:

### `getState()`

Liest den aktuellen Zustand:

```js
const state = getState();
console.log(state.bots);
```

### `setState(...)`

Ändert einen Teil des Zustands:

```js
setState({ query: 'python' });
```

Danach werden automatisch alle angemeldeten Darstellungen aktualisiert.

### `upsertBot(bot)`

Fügt einen Bot hinzu oder aktualisiert ihn, falls er bereits vorhanden ist. Das Wort `upsert` ist eine Mischung aus „update“ und „insert“:

```js
upsertBot(bot);
```

### `removeBot(id)`

Entfernt den Bot mit der angegebenen ID aus dem Zustand.

### `prependLogs(lines)`

Fügt neue Log-Zeilen vorne in die gespeicherte Liste ein.

### `clearLogs()`

Entfernt die aktuell gespeicherten Logs aus der Oberfläche.

### `subscribe(...)`

Registriert eine Funktion, die bei jeder Änderung des Zustands ausgeführt wird.

### Funktionen für die Darstellung

```js
import { renderBots, renderStats } from './ui/dashboard.js';
import { renderLogs } from './ui/logs.js';
```

Diese Funktionen zeichnen die jeweiligen Bereiche neu:

```js
renderStats(); // Statistik-Karten
renderBots();  // Bot-Karten
renderLogs();  // Log-Zeilen
```

Weitere Importe:

```js
import { openBotForm } from './ui/botForm.js';
import { openPanel } from './ui/panel.js';
import { toast } from './ui/toast.js';
```

- `openBotForm` öffnet das Formular zum Erstellen oder Bearbeiten eines Bots.
- `openPanel` öffnet die individuelle Seite eines Bots.
- `toast` zeigt eine kurze Nachricht auf der Webseite an.

Beispiele für Toast-Nachrichten:

```text
Bot gestartet
Bot gelöscht
Backend nicht erreichbar
```

---

## 2. Die Funktion `$`

```js
const $ = (selector) => document.querySelector(selector);
```

Diese Funktion ist eine Abkürzung für `document.querySelector(...)`.

Statt:

```js
document.querySelector('#search');
```

kann später geschrieben werden:

```js
$('#search');
```

Das Zeichen `$` hat hier keine besondere Bedeutung. Es ist lediglich der Name der Funktion.

Beispiel:

```js
const button = $('#new-bot');
```

Damit wird das HTML-Element gesucht, das so aussieht:

```html
<button id="new-bot">
  + Bot anlegen
</button>
```

---

## 3. Die Funktion `withBusy`

```js
const withBusy = async (button, task) => {
  if (!button) return task();
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    return await task();
  } catch (error) {
    toast(error.message, 'error');
    return undefined;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};
```

Diese Hilfsfunktion kümmert sich darum, dass ein Button während einer laufenden Aktion nicht mehrfach angeklickt werden kann.

### Kein Button vorhanden

```js
if (!button) return task();
```

Wenn kein Button übergeben wurde, wird die eigentliche Aufgabe direkt ausgeführt.

### Ursprünglichen Text merken

```js
const label = button.textContent;
```

Wenn der Button vorher `Starten` hieß, wird dieser Text gespeichert, damit er später wiederhergestellt werden kann.

### Button sperren

```js
button.disabled = true;
button.textContent = '…';
```

Der Button ist während der Anfrage nicht anklickbar und zeigt drei Punkte an. So weiß der Benutzer, dass gerade etwas passiert. Gleichzeitig werden doppelte Anfragen verhindert.

### Aufgabe ausführen

```js
try {
  return await task();
}
```

`task` ist eine Funktion, die von außen übergeben wird. Zum Beispiel:

```js
withBusy(button, async () => {
  await api.start(id);
});
```

`await` wartet, bis die Anfrage beendet ist.

### Fehler anzeigen

```js
catch (error) {
  toast(error.message, 'error');
  return undefined;
}
```

Wenn die Aufgabe scheitert, wird die Fehlermeldung als rote Toast-Nachricht angezeigt.

### Aufräumen

```js
finally {
  button.disabled = false;
  button.textContent = label;
}
```

Der `finally`-Block wird immer ausgeführt, egal ob die Aufgabe erfolgreich war oder einen Fehler hatte. Der Button wird wieder aktiviert und erhält seinen ursprünglichen Text zurück.

---

## 4. Die Funktion `run`

```js
const run = (id, action, button) =>
  withBusy(button, async () => {
    const { bot } = await api[action](id);
    if (bot) upsertBot(bot);

    const checking =
      bot?.status === 'checking' ||
      bot?.status === 'installing';

    const verb = {
      start: checking ? 'startet (prüft Bibliotheken)' : 'gestartet',
      stop: 'gestoppt',
      kill: 'abgeschossen',
      restart: 'neu gestartet',
    }[action];

    toast(`${bot?.name ?? 'Bot'} ${verb}`, 'success');
  });
```

Diese Funktion bündelt mehrere ähnliche Aktionen:

- Bot starten,
- Bot stoppen,
- Bot beenden,
- Bot neu starten.

### Dynamischer API-Aufruf

Wenn diese Funktion so aufgerufen wird:

```js
run(id, 'start', button);
```

dann wird intern Folgendes ausgeführt:

```js
api['start'](id);
```

Das ist dasselbe wie:

```js
api.start(id);
```

Bei:

```js
run(id, 'restart', button);
```

wird entsprechend `api.restart(id)` ausgeführt.

### Antwort des Backends übernehmen

```js
const { bot } = await api[action](id);
```

Das Backend liefert wahrscheinlich eine Antwort wie:

```js
{
  bot: {
    id: 'abc123',
    name: 'Mein Discord Bot',
    status: 'running'
  }
}
```

Durch die Schreibweise `{ bot }` wird die Eigenschaft `bot` direkt aus der Antwort herausgenommen.

### Bot im Zustand aktualisieren

```js
if (bot) upsertBot(bot);
```

Wenn das Backend einen aktualisierten Bot zurückgibt, wird dieser gespeichert. Dadurch kann sich die Anzeige beispielsweise von `Gestoppt` zu `Läuft` ändern.

### Status prüfen

```js
const checking =
  bot?.status === 'checking' ||
  bot?.status === 'installing';
```

Das Zeichen `?.` heißt optionales Verkettungszeichen. Es verhindert einen Fehler, wenn `bot` nicht existiert. In diesem Fall ergibt der Ausdruck einfach `undefined`.

Der Code prüft, ob gerade Bibliotheken geprüft oder installiert werden.

### Erfolgstext bestimmen

```js
const verb = {
  start: checking ? 'startet (prüft Bibliotheken)' : 'gestartet',
  stop: 'gestoppt',
  kill: 'abgeschossen',
  restart: 'neu gestartet',
}[action];
```

Das Objekt funktioniert hier wie ein Wörterbuch. Bei `action === 'stop'` wird `gestoppt` ausgewählt. Bei `action === 'restart'` wird `neu gestartet` ausgewählt.

Beim Start gibt es eine Sondermeldung, wenn zuerst Bibliotheken geprüft oder installiert werden.

### Erfolgsmeldung

```js
toast(`${bot?.name ?? 'Bot'} ${verb}`, 'success');
```

Beispiel:

```text
Mein Bot gestartet
```

`??` bedeutet: Wenn links kein Wert vorhanden ist, wird der rechte Wert benutzt. Gibt es keinen Bot-Namen, wird also einfach `Bot` verwendet.

---

## 5. Die Funktion `openForm`

```js
const openForm = (bot) => {
  const state = getState();

  openBotForm({
    bot,
    languages: state.languages,
    onSubmit: async (config) => {
      try {
        const { bot: saved } = bot
          ? await api.update(bot.id, config)
          : await api.create(config);

        upsertBot(saved);
        if (bot) {
          toast('Bot aktualisiert', 'success');
          return;
        }
        toast(
          `${saved.name} angelegt – jetzt die Dateien hochladen`,
          'success',
        );
        openForm(saved);
      } catch (error) {
        toast(error.message, 'error');
      }
    },
  });
};
```

Diese Funktion öffnet das Formular zum Anlegen oder Bearbeiten eines Bots.

### Neues Formular oder Bearbeiten?

Für einen neuen Bot wird sie so aufgerufen:

```js
openForm(null);
```

Für einen bestehenden Bot:

```js
openForm(bot);
```

Der Wert `bot` entscheidet also, welcher Fall vorliegt.

### Sprachen an das Formular übergeben

```js
const state = getState();
```

Danach bekommt das Formular die verfügbaren Sprachen:

```js
languages: state.languages
```

Dadurch kann es beispielsweise diese Auswahl anzeigen:

```text
Python
JavaScript
Java
Kotlin
Go
C#
Rust
```

### Formular absenden

Beim Absenden ruft das Formular die Funktion `onSubmit` auf und übergibt eine Konfiguration:

```js
{
  name: 'Mein Bot',
  language: 'python',
  entrypoint: 'bot.py',
  command: 'python3 bot.py',
  autoRestart: true
}
```

### Bestehenden Bot aktualisieren

Wenn `bot` existiert:

```js
await api.update(bot.id, config);
```

### Neuen Bot erstellen

Wenn `bot` nicht existiert:

```js
await api.create(config);
```

Diese Entscheidung wird mit dem Bedingungsoperator getroffen:

```js
bot ? api.update(...) : api.create(...)
```

Das bedeutet:

```js
if (bot) {
  // bearbeiten
} else {
  // neu erstellen
}
```

### Ergebnis speichern

```js
upsertBot(saved);
```

Der vom Backend zurückgegebene Bot wird in der Oberfläche gespeichert.

### Ergebnis melden

Beim Bearbeiten:

```js
toast('Bot aktualisiert', 'success');
```

Beim Erstellen:

```js
toast(`${saved.name} angelegt – jetzt die Dateien hochladen`, 'success');
```

Der Text nennt den zweiten Schritt mit, weil der Startordner eines neuen Bots
noch leer ist.

Fehler werden ebenfalls angezeigt:

```js
catch (error) {
  toast(error.message, 'error');
}
```

### Nach dem Anlegen das Formular wieder öffnen

```js
openForm(saved);
```

Das passiert nur beim Erstellen. Der Grund ist einfach: ohne diesen Schritt wäre
nirgends zu sehen, wohin die Dateien des neuen Bots gehören. Beim Bearbeiten
wäre das Doppelarbeit – das Formular ist ja schon offen.

---

## 6. Die Funktion `wireControls`

```js
const wireControls = () => {
```

Diese Funktion verbindet die HTML-Elemente mit ihren Aktionen. Ein sichtbarer Button würde sonst nur existieren, aber nichts tun.

---

## 7. Buttons zum Anlegen eines Bots

```js
$('#new-bot').addEventListener('click', () => openForm(null));
$('#empty-new-bot').addEventListener('click', () => openForm(null));
```

Es gibt zwei Stellen, an denen ein neuer Bot angelegt werden kann:

1. der Button oben in der Kopfzeile,
2. der Button im leeren Zustand, wenn noch keine Bots existieren.

Bei einem Klick wird jeweils:

```js
openForm(null);
```

aufgerufen. `null` bedeutet hier: Es gibt noch keinen Bot, also soll ein neues Formular geöffnet werden.

---

## 8. Das Suchfeld

```js
$('#search').addEventListener('input', (event) =>
  setState({ query: event.target.value }),
);
```

Das HTML enthält:

```html
<input id="search" type="search" placeholder="Suchen …" />
```

Bei jeder Eingabe wird der Text gelesen:

```js
event.target.value
```

Wenn der Benutzer `python` eingibt, wird gespeichert:

```js
setState({ query: 'python' });
```

Die Suche kann unter anderem in diesen Eigenschaften suchen:

- Bot-Name,
- Programmiersprache,
- Framework,
- Beschreibung.

Da `setState` die Abonnenten benachrichtigt, werden die Bot-Karten direkt neu gezeichnet.

---

## 9. Die Statusfilter

```js
$('#filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;

  setState({ filter: button.dataset.filter });

  for (const item of $('#filters').children) {
    item.classList.toggle('is-active', item === button);
  }
});
```

Im HTML gibt es beispielsweise:

```html
<button data-filter="all">Alle</button>
<button data-filter="running">Läuft</button>
<button data-filter="stopped">Gestoppt</button>
<button data-filter="crashed">Abgestürzt</button>
```

### Herausfinden, welcher Filter angeklickt wurde

```js
const button = event.target.closest('[data-filter]');
```

`closest` sucht das nächstgelegene Element, das das Attribut `data-filter` besitzt.

### Filter speichern

```js
setState({ filter: button.dataset.filter });
```

Beim Klick auf `Läuft` wird daraus:

```js
setState({ filter: 'running' });
```

### Aktiven Filter hervorheben

```js
for (const item of $('#filters').children) {
  item.classList.toggle('is-active', item === button);
}
```

Alle Filter werden durchlaufen. Nur der geklickte Filter bekommt die CSS-Klasse `is-active`. Dadurch sieht der Benutzer, welcher Filter aktiv ist.

---

## 10. Klicks in der Bot-Liste

```js
$('#bot-grid').addEventListener('click', (event) => {
```

Die Bot-Karten werden dynamisch in dieses Element eingefügt:

```html
<div id="bot-grid"></div>
```

Statt jeden einzelnen Button jeder Karte separat anzuschließen, gibt es nur einen Listener am gemeinsamen Container. Diese Technik heißt Event Delegation.

### Geklickte Aktion finden

```js
const button = event.target.closest('[data-action]');
if (!button) return;
```

Die dynamisch erzeugten Buttons besitzen beispielsweise:

```html
<button data-action="toggle" data-id="123">
  Starten
</button>
```

oder:

```html
<button data-action="logs" data-id="123">
  Logs
</button>
```

### Aktion und ID lesen

```js
const { action, id } = button.dataset;
```

Aus:

```html
<button data-action="restart" data-id="123">
```

werden:

```js
action === 'restart';
id === '123';
```

### Passenden Bot suchen

```js
const state = getState();
const bot = state.bots.find((item) => item.id === id);
if (!bot) return;
```

In der gespeicherten Bot-Liste wird der Bot mit der passenden ID gesucht. Wenn kein passender Bot gefunden wird, wird die Verarbeitung beendet.

---

## 11. Starten oder Stoppen mit `toggle`

```js
if (action === 'toggle')
  return run(
    id,
    bot.status === 'running' ? 'stop' : 'start',
    button,
  );
```

Der Button hat immer die Aktion `toggle`, entscheidet aber abhängig vom Status:

```js
bot.status === 'running' ? 'stop' : 'start'
```

Das ist kurz geschrieben für:

```js
if (bot.status === 'running') {
  action = 'stop';
} else {
  action = 'start';
}
```

Das Ergebnis:

```text
Bot läuft    → Klick → Bot stoppen
Bot gestoppt → Klick → Bot starten
```

---

## 12. Bibliotheken installieren

```js
if (action === 'install')
  return withBusy(button, async () => {
    await api.install(id);

    upsertBot({
      ...bot,
      status: 'checking',
      depsStatus: 'checking',
    });

    toast(`Installiere ${bot.framework} für ${bot.name} …`);
  });
```

### Installation anfordern

```js
await api.install(id);
```

Das Backend prüft und installiert die für den Bot notwendigen Abhängigkeiten.

### Vorläufigen Status anzeigen

```js
upsertBot({
  ...bot,
  status: 'checking',
  depsStatus: 'checking',
});
```

Die drei Punkte `...bot` kopieren alle bisherigen Bot-Eigenschaften. Anschließend werden nur `status` und `depsStatus` überschrieben.

So kann die Oberfläche anzeigen:

```text
Prüfe …
```

### Hinweis anzeigen

```js
toast(`Installiere ${bot.framework} für ${bot.name} …`);
```

Beispiel:

```text
Installiere discord.js für Mein Bot …
```

---

## 13. Bot neu starten

```js
if (action === 'restart') return run(id, 'restart', button);
```

Hier wird die gemeinsame Funktion `run` verwendet. Dadurch wird:

```js
api.restart(id);
```

aufgerufen und anschließend der Zustand aktualisiert.

---

## 14. Eigene Bot-Seite öffnen

```js
if (action === 'panel') return openPanel(bot);
```

Ein Bot kann eine eigene Bedienoberfläche besitzen. Mit `openPanel(bot)` wird diese geöffnet.

---

## 15. Logs eines Bots anzeigen

```js
if (action === 'logs') {
  setState({
    selectedBotId: state.selectedBotId === id ? null : id,
  });

  document
    .getElementById('log-panel')
    ?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });

  return undefined;
}
```

### Bot auswählen oder Auswahl entfernen

```js
state.selectedBotId === id ? null : id
```

Das bedeutet:

- Ist dieser Bot bereits ausgewählt, wird die Auswahl entfernt.
- Ist er nicht ausgewählt, wird er ausgewählt.

Beispiel:

```text
Klick auf Bot A       → nur Logs von Bot A
Klick erneut auf Bot A → Logs aller Bots
```

### Zum Log-Bereich scrollen

```js
document
  .getElementById('log-panel')
  ?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });
```

Die Webseite scrollt weich zum Log-Bereich. `block: 'center'` versucht, den Bereich in der Mitte des Fensters anzuzeigen.

---

## 16. Bot bearbeiten

```js
if (action === 'edit') return openForm(bot);
```

Das Formular wird mit dem bestehenden Bot geöffnet. Dadurch sind die bisherigen Werte bereits eingetragen und können verändert werden.

### Der Startordner gehört dazu

`openBotForm` hängt beim Öffnen den Startordner in das Formular ein:

```js
mountStartFolder(startOrdner, bot);
```

Der Abschnitt zeigt den Pfad auf dem Server, die Liste der Dateien und zwei
Knöpfe: **Dateien hochladen** und **In den Container übernehmen**. Jeder dieser
Vorgänge spiegelt sofort in den Workspace des Bots – was hier hochgeladen wird,
läuft danach im Container, ohne dass noch etwas anzuklicken wäre.

Beim Speichern des Formulars spiegelt der Hub ebenfalls. Das ist der Grund, warum
ein `cwd`-Feld im Formular nichts mehr verloren hat: Der Betreiber gibt keinen
Pfad mehr an, sondern Dateien. Was davon im Container ankommt, entscheidet der
Hub.

Für einen neuen Bot (`bot === null`) gibt es noch keine Kennung und damit nichts
zu zeigen. Der Abschnitt sagt das dann ausdrücklich, statt eine leere Liste zu
zeigen, die nach einem Fehler aussieht.

---

## 17. Bot löschen

```js
if (action === 'delete') {
  if (
    !confirm(
      `"${bot.name}" und alle zugehörigen Dateien sowie gespeicherten Bot-Daten wirklich löschen? ` +
        'Diese Aktion kann nicht rückgängig gemacht werden.',
    )
  )
    return undefined;

  return withBusy(button, async () => {
    await api.remove(id);
    removeBot(id);
    toast(`${bot.name} gelöscht`);
  });
}
```

### Sicherheitsabfrage

Vor dem Löschen wird gefragt:

```text
"Mein Bot" und alle zugehörigen Dateien sowie gespeicherten Bot-Daten wirklich löschen?
Diese Aktion kann nicht rückgängig gemacht werden.
```

Ein Löschen entfernt vollständig und unwiderruflich:

```text
Bot-Datensatz und bots.json-Eintrag
bots/<id>/ (Startordner und Workspace, inkl. node_modules und Panel-Seiten)
data/secrets/<id>.env
Bot-Datenbankdaten und Quota-Zähler
Bot-Container (wenn die Container-Runtime aktiv ist)
Runtime-/Panel-Tokens und Sitzungen (sofort ungültig)
botbezogene Discord-OAuth-Zustände
Per-Bot-Rechte aller Benutzer für diese Bot-ID
```

Läuft gerade ein Löschvorgang oder ist ein Cleanup fehlgeschlagen
(`cleanup_failed`), sind Start, Restart und Schreibzugriffe gesperrt (409),
bis ein erneuter Delete den idempotenten Cleanup vollendet – auch über
Hub-Neustarts hinweg (Startup-Recovery).

Wenn der Benutzer abbricht, wird nichts weiter ausgeführt:

```js
return undefined;
```

### Bot beim Backend löschen

```js
await api.remove(id);
```

Die Konfiguration wird auf dem Server gelöscht.

### Bot lokal entfernen

```js
removeBot(id);
```

Danach wird der Bot aus der Liste der Oberfläche entfernt. Die zugehörigen lokalen Log-Zeilen werden ebenfalls entfernt.

### Erfolgsmeldung

```js
toast(`${bot.name} gelöscht`);
```

---

## 18. Auswahl der Log-Quelle

```js
$('#log-scope').addEventListener('change', (event) =>
  setState({
    selectedBotId: event.target.value || null,
  }),
);
```

Das Auswahlfeld enthält später beispielsweise:

```html
<select id="log-scope">
  <option value="">Alle Bots</option>
  <option value="123">🤖 Mein Bot</option>
</select>
```

Wenn `Alle Bots` ausgewählt wird, ist der Wert leer. Dann wird `null` gespeichert:

```js
selectedBotId: null
```

Bei einem bestimmten Bot wird dessen ID gespeichert:

```js
selectedBotId: '123'
```

---

## 19. Log-Level auswählen

```js
$('#log-level').addEventListener('change', (event) =>
  setState({
    logLevelFilter: event.target.value,
  }),
);
```

Das Log-Level kann beispielsweise sein:

```text
Alle Level
Fehler
Warnungen
Info
Debug
System
```

Wählt der Benutzer `Fehler`, wird gespeichert:

```js
logLevelFilter: 'error'
```

Anschließend zeigt `renderLogs()` nur noch Fehler-Logs an.

---

## 20. Logs leeren

```js
$('#log-clear').addEventListener('click', () => clearLogs());
```

Beim Klick auf `Leeren` werden die aktuell im Frontend gespeicherten Logs entfernt.

```js
clearLogs();
```

Das leert die Anzeige in dieser Sitzung. Es ist nicht automatisch dasselbe wie das Löschen historischer Log-Dateien auf dem Server.

---

## 21. Alle Bots starten

```js
$('#start-all').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const stopped = getState().bots.filter(
      (bot) => bot.status !== 'running',
    );

    const results = await Promise.allSettled(
      stopped.map((bot) => api.start(bot.id)),
    );

    const ok = results.filter(
      (result) => result.status === 'fulfilled',
    ).length;

    toast(
      `${ok}/${stopped.length} Bot(s) gestartet`,
      ok ? 'success' : 'error',
    );
  }),
);
```

### Nicht laufende Bots finden

```js
const stopped = getState().bots.filter(
  (bot) => bot.status !== 'running',
);
```

Es werden alle Bots herausgesucht, die gerade nicht laufen.

### Startanfragen gleichzeitig senden

```js
stopped.map((bot) => api.start(bot.id))
```

Für jeden gefundenen Bot wird eine Startanfrage erstellt.

```js
const results = await Promise.allSettled(...);
```

`Promise.allSettled` wartet auf alle Anfragen, auch wenn einzelne davon fehlschlagen. Dadurch kann die Anwendung trotzdem melden, wie viele Bots erfolgreich waren.

### Erfolgreiche Anfragen zählen

```js
const ok = results.filter(
  (result) => result.status === 'fulfilled',
).length;
```

Gezählt werden nur die erfolgreich beendeten Anfragen.

Beispiel:

```text
3/5 Bot(s) gestartet
```

---

## 22. Alle Bots stoppen

```js
$('#stop-all').addEventListener('click', (event) =>
  withBusy(event.target, async () => {
    const running = getState().bots.filter(
      (bot) => bot.status === 'running',
    );

    const results = await Promise.allSettled(
      running.map((bot) => api.stop(bot.id)),
    );

    const ok = results.filter(
      (result) => result.status === 'fulfilled',
    ).length;

    toast(`${ok}/${running.length} Bot(s) gestoppt`, 'success');
  }),
);
```

Das funktioniert wie `Alle starten`, nur umgekehrt:

1. Nur laufende Bots werden herausgesucht.
2. Für jeden laufenden Bot wird `api.stop(...)` aufgerufen.
3. Es wird gezählt, wie viele Anfragen erfolgreich waren.
4. Eine Zusammenfassung wird angezeigt.

---

## 23. Das Log-Auswahlfeld neu aufbauen

```js
const renderScopeOptions = () => {
  const state = getState();
  const select = $('#log-scope');

  select.replaceChildren(
    new Option('Alle Bots', ''),
    ...state.bots.map(
      (bot) => new Option(`${bot.emoji} ${bot.name}`, bot.id),
    ),
  );

  select.value = state.selectedBotId ?? '';
};
```

### Alte Optionen löschen

```js
select.replaceChildren(...)
```

Alle bisherigen Optionen des Auswahlfeldes werden entfernt.

### Option für alle Bots hinzufügen

```js
new Option('Alle Bots', '')
```

Das erzeugt sinngemäß:

```html
<option value="">Alle Bots</option>
```

### Für jeden Bot eine Option erzeugen

```js
state.bots.map(
  (bot) => new Option(`${bot.emoji} ${bot.name}`, bot.id),
)
```

Aus:

```js
{
  id: '123',
  emoji: '🤖',
  name: 'Mein Bot'
}
```

wird:

```html
<option value="123">🤖 Mein Bot</option>
```

### Auswahl wiederherstellen

```js
select.value = state.selectedBotId ?? '';
```

Wenn zuvor ein Bot ausgewählt war, bleibt diese Auswahl bestehen. Wenn keiner ausgewählt ist, wird `Alle Bots` gewählt.

---

## 24. Die Verbindungsanzeige

```js
const renderConnection = () => {
  const pill = $('#connection');
  const connected = getState().connected;

  pill.textContent = connected
    ? 'Verbunden'
    : 'Verbindung prüfen …';

  pill.className = `pill ${
    connected ? 'pill--ok' : 'pill--danger'
  }`;
};
```

Im HTML gibt es:

```html
<span id="connection" class="pill pill--idle">
  Verbinde …
</span>
```

Die Funktion ändert Text und CSS-Klasse:

Bei einer funktionierenden Verbindung:

```text
Verbunden
```

mit:

```text
pill pill--ok
```

Bei einem Fehler:

```text
Verbindung prüfen …
```

mit:

```text
pill pill--danger
```

---

## 25. Die Startfunktion `bootstrap`

```js
const bootstrap = async () => {
```

`bootstrap` ist die Startfunktion der gesamten Anwendung. Sie wird am Ende der Datei aufgerufen.

---

## 26. Auf Zustandsänderungen reagieren

```js
const select = $('#log-scope');

subscribe((state) => {
  renderStats();
  renderBots();
  renderLogs();
  renderConnection();

  if (select.dataset.sig !== String(state.bots.length)) {
    renderScopeOptions();
    select.dataset.sig = String(state.bots.length);
  }
});
```

Mit `subscribe` meldet sich `main.js` beim Zustandssystem an. Immer wenn sich Daten ändern, werden folgende Bereiche aktualisiert:

```js
renderStats();
renderBots();
renderLogs();
renderConnection();
```

Das ist der Grund, warum sich die Oberfläche automatisch verändert, wenn beispielsweise ein Bot gestartet wird.

### Warum `select.dataset.sig`?

```js
if (select.dataset.sig !== String(state.bots.length))
```

`dataset.sig` speichert hier eine kleine Signatur, nämlich die zuletzt bekannte Anzahl an Bots.

Beispiel:

```js
select.dataset.sig = '3';
```

Solange weiterhin drei Bots existieren, muss das Log-Auswahlfeld nicht neu aufgebaut werden. Wenn ein Bot hinzukommt oder gelöscht wird, ändert sich die Anzahl und die Optionen werden aktualisiert.

---

## 27. Alle Bedienfelder aktivieren

```js
wireControls();
```

Jetzt werden alle Ereignisbehandlungen eingerichtet:

- neuer Bot,
- Suche,
- Statusfilter,
- Bot starten,
- Bot stoppen,
- Bot neu starten,
- Bot löschen,
- Logs anzeigen,
- Log-Level ändern,
- alle Bots starten,
- alle Bots stoppen.

---

## 28. Erste Daten vom Backend laden

```js
try {
  const [{ languages }, { bots }] = await Promise.all([
    api.languages(),
    api.list(),
  ]);

  setState({ languages });

  for (const bot of bots) upsertBot(bot);

  const { lines } = await api.logs(null, 200);
  prependLogs(lines.reverse());
} catch (error) {
  toast(`Backend nicht erreichbar: ${error.message}`, 'error');
}
```

### Sprachen und Bots gleichzeitig laden

```js
const [{ languages }, { bots }] = await Promise.all([
  api.languages(),
  api.list(),
]);
```

Es werden zwei Anfragen gleichzeitig gestartet:

```js
api.languages();
```

lädt die verfügbaren Sprachen.

```js
api.list();
```

lädt die vorhandenen Bots.

`Promise.all` wartet, bis beide Anfragen fertig sind.

### Sprachen speichern

```js
setState({ languages });
```

Die Sprachen werden im zentralen Zustand gespeichert. Das Bot-Formular kann sie anschließend als Auswahl anzeigen.

### Bots speichern

```js
for (const bot of bots) {
  upsertBot(bot);
}
```

Jeder geladene Bot wird einzeln in den Zustand übernommen.

### Die letzten 200 Logs laden

```js
const { lines } = await api.logs(null, 200);
```

`null` bedeutet, dass Logs aller Bots geladen werden. `200` ist die maximale Anzahl der geladenen Log-Zeilen.

### Reihenfolge der Logs anpassen

```js
prependLogs(lines.reverse());
```

`reverse()` dreht die Reihenfolge um. Das ist notwendig, weil `prependLogs` neue Einträge vorne einfügt.

### Fehler beim Laden

```js
catch (error) {
  toast(`Backend nicht erreichbar: ${error.message}`, 'error');
}
```

Wenn das Backend nicht läuft oder eine Anfrage fehlschlägt, wird die genaue Fehlermeldung angezeigt, statt dass die gesamte Oberfläche kommentarlos abbricht.

---

## 29. Live-Ereignisse vom Backend empfangen

```js
api.events((type, payload) => {
```

Danach wird ein dauerhafter Event-Stream registriert. In `api.js` wird dafür `EventSource` verwendet:

```js
source = new EventSource('/api/events');
```

Das ist eine dauerhafte Verbindung vom Backend zum Browser. Der Server kann dadurch jederzeit Ereignisse schicken, ohne dass der Browser ständig nachfragen muss.

Mögliche Ereignisse sind:

- `snapshot`,
- `created`,
- `bot`,
- `deleted`,
- `log`,
- `toast`,
- `open`,
- `error`.

---

## 30. Das `snapshot`-Ereignis

```js
if (type === 'snapshot') {
  setState({ connected: true });

  for (const bot of payload.bots) {
    upsertBot(bot);
  }
}
```

Ein `snapshot` ist eine Momentaufnahme des aktuellen Zustands. Der Server liefert dabei beispielsweise alle momentan bekannten Bots.

Zuerst wird die Verbindung als aktiv markiert:

```js
setState({ connected: true });
```

Danach werden alle Bots übernommen.

---

## 31. Ein neuer oder aktualisierter Bot

```js
else if (type === 'created' || type === 'bot') {
  upsertBot(payload);

  if (type === 'created') {
    toast(`${payload.name} hinzugefügt`, 'success');
  }
}
```

### `created`

Ein neuer Bot wurde angelegt. Er wird gespeichert und eine Meldung erscheint:

```text
Mein Bot hinzugefügt
```

### `bot`

Ein bestehender Bot hat sich verändert. Das kann zum Beispiel passieren, wenn er gestartet, gestoppt oder neu gestartet wurde oder wenn sich sein Installationsstatus verändert hat.

In beiden Fällen wird der Bot mit `upsertBot` aktualisiert.

---

## 32. Ein Bot wurde gelöscht

```js
else if (type === 'deleted') {
  removeBot(payload.id);
}
```

Wenn das Backend mitteilt, dass ein Bot gelöscht wurde, wird er auch lokal entfernt. Dadurch verschwindet er direkt aus der Bot-Liste.

---

## 33. Eine neue Log-Zeile

```js
else if (type === 'log') {
  prependLogs([payload]);
}
```

Das Backend sendet eine einzelne neue Log-Zeile. Sie wird in ein Array verpackt:

```js
[payload]
```

und mit `prependLogs` vorne in die Log-Liste eingefügt. Anschließend wird der Log-Bereich neu gezeichnet.

Ein mögliches Payload kann so aussehen:

```js
{
  id: 'log-123',
  botId: 'bot-1',
  level: 'info',
  text: 'Bot ist online',
  ts: 1790600000000
}
```

---

## 34. Eine Toast-Nachricht vom Bot

```js
else if (type === 'toast') {
  // Meldung, die der Bot selbst an das Dashboard geschickt hat.
  toast(
    `${payload.emoji ?? ''} ${payload.message}`.trim(),
    payload.kind,
  );
}
```

Auch ein Bot selbst kann eine Nachricht an das Dashboard schicken.

Beispiel:

```js
{
  emoji: '✅',
  message: 'Verbindung zu Discord hergestellt',
  kind: 'success'
}
```

Daraus wird:

```text
✅ Verbindung zu Discord hergestellt
```

`trim()` entfernt unnötige Leerzeichen, beispielsweise wenn kein Emoji vorhanden ist.

---

## 35. Event-Stream geöffnet

```js
else if (type === 'open') {
  setState({ connected: true });
}
```

Wenn der Event-Stream erfolgreich geöffnet wurde, wird die Verbindungsanzeige auf `Verbunden` gesetzt.

---

## 36. Fehler im Event-Stream

```js
else if (type === 'error') {
  setState({ connected: false });
}
```

Wenn die dauerhafte Verbindung einen Fehler meldet, wird der Zustand auf nicht verbunden gesetzt. Die Oberfläche zeigt dann:

```text
Verbindung prüfen …
```

---

## 37. Statistiken alle fünf Sekunden aktualisieren

```js
setInterval(() => renderStats(), 5000);
```

Alle 5.000 Millisekunden, also alle fünf Sekunden, werden die Statistik-Karten neu gezeichnet.

Das ist vor allem für Laufzeiten wichtig. Aus:

```text
Laufzeit: 10s
```

soll nach einiger Zeit werden:

```text
Laufzeit: 15s
```

Die Daten des Bots müssen sich dafür nicht geändert haben. Nur die aktuelle Zeitdarstellung muss neu berechnet werden.

---

## 38. Die Anwendung tatsächlich starten

```js
bootstrap();
```

Bis zu dieser Zeile wurden lediglich Funktionen definiert. Erst dieser Aufruf startet die Anwendung wirklich:

1. Zustandsänderungen werden abonniert.
2. Klick- und Eingabeereignisse werden eingerichtet.
3. Sprachen und Bots werden geladen.
4. Die letzten Logs werden geladen.
5. Der Live-Event-Stream wird geöffnet.
6. Die Verbindungsanzeige wird aktualisiert.
7. Die Statistiken werden regelmäßig neu gezeichnet.

---

## Gesamtablauf an einem Beispiel

Angenommen, der Benutzer klickt auf `Starten`.

```text
1. Der Benutzer klickt auf den Button.
2. Der Event-Listener in main.js erkennt den Klick.
3. data-action="toggle" wird gelesen.
4. Der aktuelle Status des Bots wird geprüft.
5. main.js entscheidet sich für api.start(id).
6. withBusy deaktiviert den Button vorübergehend.
7. Das Backend startet den Bot.
8. Das Backend liefert den neuen Bot-Status zurück.
9. upsertBot(bot) aktualisiert den lokalen Zustand.
10. renderBots() zeichnet die Bot-Karte neu.
11. Der Button und das Statusfeld zeigen jetzt "Läuft".
12. Eine Erfolgsmeldung wird angezeigt.
```

Als Codefluss vereinfacht:

```js
// Benutzer klickt auf "Starten"
run(id, 'start', button);

// main.js ruft das Backend auf
const { bot } = await api.start(id);

// Der neue Zustand wird gespeichert
upsertBot(bot);

// Die Oberfläche wird durch subscribe neu gezeichnet
renderBots();

// Der Benutzer sieht den neuen Status
toast('Mein Bot gestartet', 'success');
```

---

## Zusammenfassung

`main.js` ist die Verbindungszentrale der Anwendung. Die Datei:

- lädt CSS und JavaScript-Module,
- kommuniziert über `api` mit dem Backend,
- lädt Bots, Sprachen und Logs,
- verbindet alle Buttons mit ihren Aktionen,
- startet, stoppt, löscht und bearbeitet Bots,
- verwaltet Suche und Filter,
- zeigt und filtert Logs,
- reagiert auf Live-Ereignisse vom Server,
- aktualisiert den Zustand der Anwendung,
- zeichnet Statistiken und Bot-Karten neu,
- zeigt Erfolgs- und Fehlermeldungen an,
- überwacht die Verbindung zum Backend.

Die Datei enthält also vor allem die **Steuerlogik**. Die eigentliche HTML-Struktur steht in `index.html`, die einzelnen Darstellungen liegen in den Dateien unter `src/ui/`, die API-Kommunikation in `src/api.js` und der gemeinsame Zustand in `src/state.js`.
