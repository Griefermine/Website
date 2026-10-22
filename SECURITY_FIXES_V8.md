# SECURITY_FIXES_V8.md

# Bot-Hub – OAuth- und Security-Härtung für GitHub Copilot / WebStorm

## Ziel

Überarbeite die aktuelle Bot-Hub-Version so, dass:

1. der Discord-OAuth-Login der Haupt-Webseite gegen Login-CSRF / Account-Switching abgesichert ist,
2. die einzelnen Bot-Workspaces strikt voneinander isoliert sind,
3. Bot-Webseiten weiterhin kontrolliert den zentralen OAuth-Prozess der Haupt-Webseite verwenden können,
4. Main-Session, Panel-Token und Runtime-BOT_HUB_TOKEN getrennt bleiben,
5. Panel-Commands nicht mehr über unkontrolliertes `/bin/sh -c` laufen,
6. keine echten Secrets im Repository, ZIP-Archiv oder in Testdaten liegen,
7. kritische Routen Rate-Limits besitzen,
8. abgelaufene OAuth-/Session-Daten bereinigt werden,
9. bestehende Rollen, Permissions und Panel-Funktionen weiter funktionieren.

WICHTIG:

- Den zentralen OAuth-Prozess NICHT entfernen.
- Die Bot-Webseite MUSS weiterhin den OAuth-Prozess der Haupt-Webseite nutzen können.
- OAuth-Zugriff ist erlaubt; Dateisystemzugriff zwischen Bots ist es nicht.
- Keine Secrets in Logs oder Fehlermeldungen ausgeben.
- Bestehende serverseitige Rollen-/Permission-Prüfungen beibehalten.
- Änderungen möglichst klein und nachvollziehbar implementieren.

---

# 1. HOCH – Haupt-OAuth browsergebunden machen

## Problem

Der OAuth-State der Haupt-Webseite darf nicht nur eine Ablaufzeit besitzen. Er muss an den Browser gebunden sein, der den Login gestartet hat.

## Umsetzung

Beim Aufruf von:

```text
GET /api/auth/discord/login
```

eine zufällige Pre-Auth-Session bzw. State-ID erzeugen und serverseitig speichern.

Speichern:

```text
state
expiresAt
preAuthSessionId
optional: codeVerifier
used
```

Die Browser-Bindung erfolgt über ein Cookie:

```text
HttpOnly
SameSite=Lax
Secure in Production
kurze Lebensdauer
```

Beim Callback:

```text
GET /api/auth/discord/callback?code=...&state=...
```

muss der Server prüfen:

- State existiert
- State ist nicht abgelaufen
- State gehört zur aktuellen Pre-Auth-Browser-Session
- State wurde noch nicht benutzt
- bei PKCE: code_verifier passt

Nach erfolgreichem Callback:

```text
State sofort löschen
```

Einen State niemals zweimal akzeptieren.

## PKCE

PKCE aktivieren, sofern der verwendete Discord-OAuth-Flow es unterstützt:

```text
code_verifier
    -> SHA-256 / S256
    -> code_challenge
    -> Discord OAuth
```

Den `code_verifier` serverseitig an die Pre-Auth-Session binden.

Nicht ausreichend:

```js
if (state && state.expiresAt > Date.now()) {
  // login
}
```

---

# 2. HOCH – Bot-Webseiten müssen den zentralen OAuth weiterhin nutzen können

Die Workspace-Isolation darf den OAuth-Zugriff der Bot-Webseite NICHT verhindern.

Erlaubter Ablauf:

```text
Bot-Webseite
    |
    v
Haupt-Webseite / OAuth-Endpunkt
    |
    v
Discord OAuth
    |
    v
Haupt-Webseite
    |
    v
Bot-/Panel-Session
```

Die Bot-Webseite darf dabei nicht die Haupt-Session per JavaScript auslesen.

NICHT:

```js
document.cookie;
```

NICHT:

```js
localStorage.getItem('main-session-token');
```

Keine geheimen Haupt-Session-Tokens in die Bot-Webseite injizieren.

Stattdessen bestehende serverseitige OAuth-/Panel-Handshakes weiterverwenden und härten.

Jede Anfrage muss serverseitig prüfen:

```text
Benutzer
Bot-ID
Session
Token
Permission
Aktion
Ablaufzeit
```

---

# 3. HOCH – Token-Trennung beibehalten

Diese Werte dürfen niemals gleichgesetzt werden:

```text
Main Session
!=
Panel Token
!=
Runtime BOT_HUB_TOKEN
```

## Main Session

Für die Haupt-Webseite und deren serverseitig geschützte Funktionen.

## Panel Token

Nur für den zugehörigen Bot.

Kein globaler Admin-Zugriff.

## Runtime Token

Nur für den jeweiligen Bot und dessen `/api/hub/*`-Funktionen.

Ein Runtime-Token darf niemals Zugriff auf andere Bots vermitteln.

---

# 4. HOCH – Per-Bot-Workspace strikt isolieren

## Problem

Nur `PROJECT_ROOT` zu validieren reicht nicht. Ein Bot darf nicht auf das Verzeichnis eines anderen Bots oder auf globale Projektdateien zugreifen.

## Zielstruktur

```text
bots/
  python-echo/
    workspace/
      ...
  javascript-echo/
    workspace/
      ...
```

Für Bot A darf ausschließlich gelten:

```text
bots/bot-a/workspace/**
```

Verboten:

```text
bots/bot-b/**
PROJECT_ROOT/.env
PROJECT_ROOT/data/**
PROJECT_ROOT/server/**
```

## cwd

`cwd` darf nicht mehr beliebig auf einen Pfad innerhalb von `PROJECT_ROOT` zeigen.

Stattdessen:

```js
const botRoot = getBotWorkspace(botId);
const cwd = botRoot;
```

Falls ein Unterverzeichnis erlaubt werden soll, darf es nur unter diesem Workspace liegen.

## Pfadprüfung

Für jeden Pfad:

1. `resolve()` bzw. `realpath()` verwenden,
2. kanonischen Pfad bestimmen, wenn möglich,
3. prüfen, dass er innerhalb des Bot-Workspaces liegt.

Blockieren:

```text
../
../../
/absolute/path
~
Symlink -> außerhalb des Workspace
```

Symlink-Escape ausdrücklich testen.

---

# 5. HOCH – Panel-Commands nicht mehr mit unkontrolliertem `sh -c`

Aktuell problematisch:

```js
spawn('/bin/sh', ['-c', command.run], ...)
```

Ein Manifest-String darf nicht automatisch Shell-Metazeichen interpretieren.

Nicht direkt als Shell-Befehl ausführen:

```text
;
&&
||
|
>
<
$
$(...)
`...`
```

## Besser

Manifest:

```json
{
  "commands": {
    "start": {
      "executable": "node",
      "args": ["server.js"]
    }
  }
}
```

oder:

```json
{
  "commands": {
    "start": {
      "executable": "./start.sh",
      "args": []
    }
  }
}
```

Ausführung:

```js
spawn(executable, args, {
  cwd: botWorkspace,
  env: sanitizedEnvironment,
});
```

Lokale Executables müssen innerhalb des Bot-Workspaces liegen.

Keine absoluten Pfade aus untrusted Manifesten akzeptieren.

Falls Shell-Skripte ausdrücklich nötig sind:

```js
spawn('/bin/sh', [validatedAbsoluteScriptPath], ...)
```

Der Script-Pfad muss vorher strikt innerhalb des Bot-Workspaces validiert werden.

---

# 6. MITTEL – Secrets aus Repository und Archiven entfernen

Prüfen:

```text
.env
bots/*/.env
data/bots.json
data/access.json
```

Echte Discord-Tokens und Client-Secrets:

1. aus Repository und Archiven entfernen,
2. sofort rotieren/revoken, falls bereits geteilt,
3. nicht in Testdaten verwenden.

Nur:

```text
.env.example
```

mit Platzhaltern versionieren.

Beispiel:

```env
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
BOT_HUB_OWNER_IDS=
BOT_HUB_URL=
```

Keine echten Werte.

---

# 7. MITTEL – Dateirechte härten

Unter Linux/Unix:

```bash
chmod 600 .env
chmod 600 data/bots.json
chmod 600 data/access.json
chmod 600 bots/*/.env
```

Beim Erstellen sensibler Dateien möglichst direkt `0600` setzen.

---

# 8. MITTEL – Rate Limiting

Rate-Limits für mindestens:

```text
/api/auth/discord/login
/api/auth/discord/callback
/api/panel/*/auth/*
/api/panel/*/commands
/api/panel/*/start
/api/panel/*/restart
/api/panel/*/install
/api/hub/*
```

Berücksichtigen:

```text
IP
Session
Bot-ID
Route
```

Zusätzlich begrenzen:

- parallele Installationen,
- parallele Starts/Restarts,
- SSE-Verbindungen pro Session/Bot.

Bei Überschreitung:

```http
429 Too Many Requests
```

---

# 9. MITTEL – OAuth-/Session-Cleanup

Alle 1–5 Minuten abgelaufene Einträge löschen:

```text
OAuth states
Pre-Auth sessions
Main sessions
Panel sessions
temporäre OAuth-Daten
```

Cleanup darf keine aktiven Sessions löschen.

---

# 10. NIEDRIG/MITTEL – CSP des Bot-Panels härten

Die bestehende Sandbox beibehalten, aber die CSP schrittweise einschränken.

Nach Möglichkeit entfernen:

```text
unsafe-eval
default-src *
```

Externe Quellen explizit whitelisten.

Dabei insbesondere:

```text
script-src
style-src
connect-src
img-src
font-src
```

Nur Quellen freigeben, die die Bot-Webseiten tatsächlich benötigen.

---

# 11. Production-URL fest konfigurieren

In Production:

```env
BOT_HUB_URL=https://example.com
```

verwenden.

Nicht blind vom Client kontrollierte Werte aus:

```text
Host
X-Forwarded-Proto
X-Forwarded-Host
```

für OAuth-URLs übernehmen.

Falls Forwarded-Header benötigt werden, nur dem bekannten Reverse Proxy vertrauen.

Discord Redirect URI exakt auf die konfigurierte Production-URL abstimmen.

---

# 12. Tests – OAuth

## Test 1: Normaler Login

```text
Browser A -> OAuth -> Discord -> callback
```

Erwartung:

```text
Login erfolgreich
```

## Test 2: Fremder State

State aus Browser A in Browser B verwenden.

Erwartung:

```text
401/403
Login wird abgelehnt
```

## Test 3: Wiederverwendung

Callback zweimal senden.

Erwartung:

```text
erster Callback: erfolgreich
zweiter Callback: abgelehnt
```

## Test 4: Abgelaufener State

Erwartung:

```text
401/403
```

## Test 5: Bot-Webseite

Bot-Webseite startet OAuth über Haupt-Webseite.

Erwartung:

```text
Discord Login funktioniert
Panel-Session wird korrekt erzeugt
```

## Test 6: Cookie-Isolation

Bot-Webseite kann das HttpOnly-Hauptsession-Cookie nicht per JavaScript auslesen.

---

# 13. Tests – Workspace-Isolation

Testen:

```text
Bot A -> eigener Workspace
Bot A -> Bot B Workspace
Bot A -> PROJECT_ROOT/.env
Bot A -> PROJECT_ROOT/data
Bot A -> ../
Bot A -> absolute Pfade
Bot A -> Symlink außerhalb
```

Nur der eigene Workspace darf erfolgreich sein.

---

# 14. Tests – Command Injection

Normale Befehle müssen funktionieren:

```text
node app.js
python app.py
./start.sh
```

Folgende Inhalte dürfen NICHT als zusätzliche Shell-Befehle ausgeführt werden:

```text
foo; touch hacked
foo && touch hacked
foo | touch hacked
$(touch hacked)
`touch hacked`
```

Keine Datei außerhalb des vorgesehenen Workspaces darf entstehen.

---

# 15. Tests – Rollen und Permissions

Vorhandene Rollen weiterhin prüfen:

```text
viewer
operator
admin
owner
```

gegen:

```text
bots.read
bots.manage
bots.control
bots.delete
bots.restart
logs.read
panel.read
panel.manage
access.manage
```

Die serverseitige Rollen-/Hierarchieprüfung darf nicht umgangen werden.

---

# 16. Regression Tests

Ausführen:

```bash
npm test
node --test test/panel.test.js
npm run build
npm audit
```

Wenn `npm audit` wegen fehlendem Netzwerk/Registry nicht ausgeführt werden kann, darf es NICHT als erfolgreich markiert werden. Nur die fehlende Erreichbarkeit dokumentieren.

---

# 17. Akzeptanzkriterien

- [ ] Haupt-OAuth funktioniert weiterhin.
- [ ] Bot-Webseiten können weiterhin den zentralen OAuth-Prozess verwenden.
- [ ] OAuth-State ist browsergebunden.
- [ ] OAuth-State ist nur einmal nutzbar.
- [ ] OAuth-State läuft ab.
- [ ] PKCE ist aktiv, sofern der verwendete Flow es unterstützt.
- [ ] Main Session, Panel Token und Runtime Token bleiben getrennt.
- [ ] Bot A kann nicht auf Bot B zugreifen.
- [ ] Bot kann nicht auf `PROJECT_ROOT/.env` zugreifen.
- [ ] Bot kann nicht auf globale Access-/Bot-Daten zugreifen.
- [ ] Symlink-Escape ist blockiert.
- [ ] Panel-Commands verwenden keine unkontrollierte `sh -c`-Ausführung.
- [ ] Echte Secrets sind nicht im Repository oder Testarchiv.
- [ ] sensible Unix-Dateien sind restriktiv geschützt.
- [ ] kritische Login-/API-Routen besitzen Rate-Limits.
- [ ] alte OAuth-/Session-Daten werden regelmäßig entfernt.
- [ ] bestehende Panel-Funktionen funktionieren.
- [ ] bestehende Rollen und Permissions funktionieren.
- [ ] alle Sicherheitstests bleiben erfolgreich.

---

# 18. Implementierungsreihenfolge

Bitte in dieser Reihenfolge arbeiten:

1. OAuth-State browsergebunden machen.
2. PKCE integrieren.
3. Bot-Panel-OAuth gegen Regressionen testen.
4. Per-Bot-Workspace einführen.
5. alle Pfadoperationen auf den jeweiligen Workspace begrenzen.
6. Symlink-Escape verhindern.
7. Shell-basierte Panel-Commands ersetzen.
8. Secrets entfernen/rotieren.
9. Dateirechte härten.
10. Rate-Limits hinzufügen.
11. Session-/OAuth-Cleanup hinzufügen.
12. CSP härten.
13. Tests ausführen.
14. vollständigen Regressionstest durchführen.

---

# 19. Wichtig für GitHub Copilot

Nicht blind großflächig refactoren.

Vor jeder Änderung:

1. betroffene Datei lesen,
2. vorhandene Auth-/Permission-Architektur nachvollziehen,
3. bestehende sichere Funktionen wiederverwenden,
4. minimale Änderung durchführen,
5. passende Regressionstests ergänzen,
6. Tests ausführen,
7. niemals Secrets in Tests oder Logs ausgeben.

Bei Unsicherheit bestehende Authentifizierungsfunktionen erweitern statt eine zweite parallele Auth-Implementierung zu bauen.

## Endzustand

Das gewünschte Sicherheitsmodell ist:

```text
Zentraler sicherer OAuth
        +
browsergebundener State
        +
PKCE
        +
Bot-spezifische Session
        +
strikte Workspace-Isolation
        +
getrennte Tokens
        +
serverseitige Permissions
```

Die Bot-Webseiten bleiben damit mit dem zentralen OAuth-System kompatibel, ohne Zugriff auf andere Bots oder auf geheime Dateien des Hauptsystems zu erhalten.
