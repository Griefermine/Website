# SECURITY_FIXES_V9.md

# Bot-Hub – Sicherheits-Härtung für GitHub Copilot / WebStorm

## Ziel

Überarbeite die aktuelle Bot-Hub-Version gezielt hinsichtlich der verbleibenden Sicherheitsrisiken.

WICHTIG:

- Die bestehende zentrale Discord-OAuth-Authentifizierung der Haupt-Webseite MUSS erhalten bleiben.
- Die Bot-Webseiten MÜSSEN weiterhin den zentralen OAuth-Prozess des Hubs verwenden können.
- Main-Session, Panel-Token und Runtime-BOT_HUB_TOKEN müssen getrennt bleiben.
- Keine Authentifizierung nur im Frontend implementieren.
- Keine Secrets in Logs, Fehlerseiten, Responses oder Tests ausgeben.
- Bestehende Rollen und Permissions dürfen nicht versehentlich abgeschwächt werden.
- Keine unnötige komplette Neuschreibung der Auth-Architektur.
- Vor jeder Änderung betroffene Dateien lesen und bestehende Funktionen wiederverwenden.

---

# 1. PRIORITÄT KRITISCH/HOCH – Echte Isolation der Bot-Prozesse

## Problem

Die Hub-Anwendung kann Pfade innerhalb des Projektverzeichnisses kontrollieren, aber ein laufender Bot-Prozess ist nicht automatisch auf seinen eigenen Workspace beschränkt.

Alle Bots dürfen nicht einfach als derselbe Betriebssystem-Benutzer laufen und dadurch die Dateien anderer Bots lesen.

Beispiel:

```text
Bot A
bots/bot-a/

Bot B
bots/bot-b/
```

Wenn beide unter demselben Unix-Benutzer laufen und Dateirechte passen, kann Bot A möglicherweise:

```text
bots/bot-b/.env
bots/bot-b/data/*
bots/bot-b/*
```

lesen.

Eine reine `cwd`-Prüfung reicht dafür NICHT.

## Ziel

Jeder Bot soll auf Betriebssystemebene möglichst vom Hub und von anderen Bots getrennt werden.

Bevorzugte Reihenfolge:

### Option A – Container/Sandbox

Wenn das Projekt bereits Container-Unterstützung besitzt oder diese ohne großen Architekturbruch ergänzt werden kann:

```text
Hub
 ├── Container Bot A
 ├── Container Bot B
 └── Container Bot C
```

Jeder Container darf nur auf seinen eigenen Workspace zugreifen.

### Option B – eigener Unix-Benutzer

Wenn Container nicht verwendet werden:

```text
Hub User
Bot A User
Bot B User
Bot C User
```

Der Bot-Prozess wird unter dem zugehörigen Bot-User gestartet.

Die Bot-User dürfen keine Dateien anderer Bot-User lesen.

## Anforderungen

- Kein Bot darf das Hub-`.env` lesen.
- Kein Bot darf `data/access.json` lesen.
- Kein Bot darf `data/bots.json` lesen.
- Kein Bot darf den Workspace eines anderen Bots lesen oder verändern.
- Kein Bot darf SSH-Keys oder sonstige Benutzerdaten des Hub-Benutzers lesen.
- Bot-Prozesse dürfen keine unnötigen Root-Rechte besitzen.
- Niemals einen Bot als `root` starten.
- Falls Linux/User Isolation implementiert wird, dokumentiere die erforderlichen Rechte und Fehlerfälle.

## Wichtig

Die Bot-Webseite muss trotz Prozessisolierung weiterhin über die freigegebenen Hub-API-/OAuth-Endpunkte funktionieren.

Prozessisolierung darf NICHT bedeuten, dass die Bot-Webseite den zentralen OAuth-Prozess nicht mehr verwenden kann.

---

# 2. PRIORITÄT HOCH – Workspace exakt an bot.id binden

## Problem

Es reicht nicht aus, irgendeinen Pfad unter:

```text
PROJECT_ROOT/bots/
```

zu akzeptieren.

Ein Bot darf ausschließlich seinen eigenen Workspace benutzen.

## Ziel

Feste Zuordnung:

```text
bot.id
  ->
bots/<bot.id>/workspace/
```

Beispiel:

```text
bots/python-echo/workspace/
bots/javascript-echo/workspace/
```

## Regeln

`cwd` darf niemals auf:

```text
bots/<anderer-bot>/
```

zeigen.

Auch nicht auf:

```text
bots/<anderer-bot>/subdir/
```

Es muss geprüft werden:

```js
isPathInside(currentBotWorkspace, candidatePath);
```

mit dem kanonischen Pfad.

## Symlinks

Vor Zugriffen auf existierende Dateien:

```js
realpath();
```

verwenden und danach erneut prüfen.

Blockieren:

```text
../
../../
absolute paths
~
symlink -> anderer Bot
symlink -> PROJECT_ROOT
symlink -> Home-Verzeichnis
```

## Wichtig

`bot.cwd` darf nur ein relativer Unterpfad des eigenen Workspace sein.

Beispiel:

```json
{
  "cwd": "src"
}
```

ist erlaubt.

```json
{
  "cwd": "../bot-b"
}
```

ist verboten.

---

# 3. PRIORITÄT HOCH – Shell-Ausführung beim Bot-Start entfernen

## Problem

In der Bot-Start-/Installationslogik existieren weiterhin Konstruktionen wie:

```js
spawn('/bin/sh', ['-c', command]);
```

Das betrifft insbesondere:

```text
Bot-Start
Dependency-Check
Dependency-Installation
Venv-/Prepare-Schritte
```

Damit kann ein konfigurierter Command unter Umständen als vollständiger Shell-Befehl ausgeführt werden.

## Ziel

Programm und Argumente immer getrennt behandeln.

NICHT:

```js
spawn('/bin/sh', ['-c', command]);
```

BESSER:

```js
spawn(executable, args, {
  cwd: botWorkspace,
  env: sanitizedEnvironment,
});
```

## Manifest-Format

Beispiel:

```json
{
  "start": {
    "executable": "node",
    "args": ["server.js"]
  }
}
```

Python:

```json
{
  "start": {
    "executable": "python3",
    "args": ["main.py"]
  }
}
```

Lokales Skript:

```json
{
  "start": {
    "executable": "./start.sh",
    "args": []
  }
}
```

## Shell-Skripte

Wenn Shell-Skripte ausdrücklich benötigt werden, dann:

```js
spawn('/bin/sh', [validatedScriptPath], ...)
```

Der Script-Pfad muss vorher:

1. aufgelöst,
2. kanonisiert,
3. auf den aktuellen Bot-Workspace begrenzt

werden.

Keine freie Shell-Zeichenkette akzeptieren.

## Regression Tests

Explizit testen:

```text
foo; touch /tmp/pwned
foo && touch /tmp/pwned
foo | touch /tmp/pwned
$(touch /tmp/pwned)
`touch /tmp/pwned`
```

Diese Zeichenfolgen dürfen nicht zu zusätzlicher Befehlsausführung führen.

---

# 4. PRIORITÄT HOCH – Dependency-Installation absichern

Dependency-Installationen sind besonders gefährlich, weil Paketmanager eigene Scripts ausführen können.

Prüfe insbesondere:

```text
npm install
npm ci
pip install
python package preparation
venv creation
```

## Anforderungen

- Ausführung ausschließlich im Bot-Workspace.
- Keine globale Installation.
- Kein Zugriff auf Hub-Secrets.
- Keine globale PATH-Manipulation außerhalb des vorgesehenen Kontexts.
- Kein `sudo`.
- Kein `root`.
- Installationsprozesse müssen unter dem isolierten Bot-Kontext laufen.

Bei Node-Projekten prüfen, ob eine kontrollierte Konfiguration sinnvoll ist, z. B. kein ungewollter Zugriff auf globale Verzeichnisse.

Bei Python-Projekten ausschließlich das Bot-eigene virtuelle Environment verwenden.

---

# 5. PRIORITÄT HOCH – Panel-Token nicht dauerhaft in der URL halten

## Problem

Das Panel verwendet derzeit einen Panel-Token im URL-Fragment.

Beispielprinzip:

```text
/panel/...#hub=<token>
```

Ein URL-Fragment wird zwar normalerweise nicht als HTTP-Request übertragen, aber JavaScript der geladenen Seite kann:

```js
location.hash;
```

lesen.

Bei eingebundenen Drittanbieter-Skripten oder kompromittiertem Panel-Code kann der Token dadurch ausgelesen werden.

## Ziel

Den dauerhaften Panel-Token NICHT als langfristiges Geheimnis in die URL legen.

## Bevorzugte Lösung

Ein kurzlebiger One-Time-Bootstrap-Token:

```text
Panel öffnen
    ↓
kurzer Bootstrap-Token
    ↓
Server validiert Token
    ↓
Bootstrap-Token sofort invalidieren
    ↓
serverseitige Panel-Session erzeugen
    ↓
HttpOnly + Secure + SameSite Cookie
```

Der dauerhafte Token soll nicht im Browser-JavaScript sichtbar sein.

## Anforderungen

- One-Time-Verwendung.
- sehr kurze Lebensdauer.
- Bindung an Bot-ID.
- Bindung an Benutzer/Session, falls verfügbar.
- kein Wiederverwenden des Bootstrap-Tokens.
- kein Logging des Tokens.

---

# 6. PRIORITÄT HOCH – Panel-CSP weiter härten

Die aktuelle CSP ist bereits besser, aber:

```text
script-src 'unsafe-inline' https:
style-src 'unsafe-inline' https:
connect-src http: https:
```

ist weiterhin weit gefasst.

## Ziel

Schrittweise enger machen:

```text
default-src 'none'
script-src 'self'
style-src 'self' 'unsafe-inline'
connect-src 'self' https://<erlaubte-api-domain>
img-src 'self' data: blob:
font-src 'self'
```

Nur notwendige externe Quellen freigeben.

`unsafe-eval` nicht wieder hinzufügen.

Die bestehende Panel-Sandbox nicht entfernen.

---

# 7. PRIORITÄT MITTEL-HOCH – Rollen und Permissions erzwingen

## Problem

Eine Rolle und eine frei definierbare Permission-Liste dürfen nicht zu widersprüchlichen Sicherheitszuständen führen.

Beispiel:

```text
role = viewer
permissions = ["access.manage"]
```

Das muss verhindert werden, wenn Rollen als Sicherheitsgrenze gedacht sind.

## Ziel

Entscheide eine klare Regel und implementiere sie serverseitig:

### Variante A – Rollen bestimmen Permissions

```text
effectivePermissions = permissionsOfRole(role)
```

Benutzer dürfen keine höher privilegierten Rechte manuell hinzufügen.

ODER:

### Variante B – Custom Permissions erlauben

Dann muss es eine maximale erlaubte Permission-Menge pro Rolle geben:

```text
viewer
  -> nur read permissions

operator
  -> read + definierte control permissions

admin
  -> administrative permissions

owner
  -> vollständige permissions
```

Ein niedrigerer Benutzer darf niemals:

```text
access.manage
```

erhalten, wenn seine Rolle dies nicht erlauben soll.

## Wichtig

Alle Prüfungen serverseitig.

---

# 8. PRIORITÄT MITTEL – Rate Limiting Proxy-sicher machen

## Problem

`X-Forwarded-For` darf nicht blind vertraut werden.

Ein Client könnte sonst selbst:

```http
X-Forwarded-For: 1.2.3.4
```

setzen.

## Ziel

Nur einem bekannten Reverse Proxy vertrauen.

Wenn der Request direkt vom Internet kommt:

```text
req.socket.remoteAddress
```

verwenden.

Nur wenn der Request nachweislich vom konfigurierten Proxy kommt:

```text
X-Forwarded-For
```

auswerten.

## Rate Limits

Mindestens für:

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

Zusätzlich:

```text
max SSE per IP
max SSE per session
max SSE per bot
max concurrent installations
max concurrent starts
```

Bei Limit:

```http
429 Too Many Requests
```

---

# 9. PRIORITÄT MITTEL – Secrets vollständig aus Build/ZIP/Testdaten entfernen

Prüfe:

```text
.env
bots/*/.env
data/bots.json
data/access.json
Logs
Testfixtures
ZIP-Exporte
Backups
```

Nur:

```text
.env.example
```

darf Beispielwerte enthalten.

## WICHTIG

Wenn echte Discord-Tokens oder Client-Secrets bereits außerhalb der lokalen Maschine geteilt wurden:

- Token rotieren/revoken.
- Client-Secret rotieren.
- neue Secrets nur lokal bzw. über sichere Secret-Verwaltung setzen.

Keine echten Secrets in:

```text
Markdown
Tests
Screenshots
ZIP-Dateien
Git
Issue-Tickets
Copilot-Prompts
```

---

# 10. PRIORITÄT MITTEL – Dateirechte

Unter Linux/Unix:

```bash
chmod 600 .env
chmod 600 data/access.json
chmod 600 data/bots.json
chmod 600 bots/*/.env
```

Node.js-Dateischreibvorgänge für Secrets direkt mit:

```text
mode: 0o600
```

erzeugen.

Verzeichnisrechte prüfen.

Bots sollen nur die Dateien lesen können, die sie tatsächlich benötigen.

---

# 11. PRIORITÄT MITTEL – OAuth-Scope minimieren

Prüfe, ob der Main-OAuth wirklich:

```text
identify
guilds
guilds.members.read
```

benötigt.

Falls `guilds.members.read` nicht genutzt wird:

```text
entfernen
```

Nur die minimal notwendigen OAuth-Scopes anfordern.

Der Bot-Panel-OAuth soll ebenfalls minimal bleiben.

---

# 12. OAuth nicht unnötig verändern

Der aktuelle OAuth-Sicherheitsmechanismus soll erhalten bleiben:

```text
random state
+
Browser-gebundener Pre-Auth-State
+
PKCE
+
Ablaufzeit
+
Einmalverwendung
```

Bot-Panel-OAuth:

```text
state
+
PKCE
+
Bot-Bindung
+
Panel-Bindung
+
Ablaufzeit
```

NICHT wieder auf einen einfachen, nicht browsergebundenen State zurückbauen.

---

# 13. Zentrale OAuth-Nutzung der Bot-Webseite erhalten

Die Bot-Webseite muss weiterhin diesen Ablauf unterstützen:

```text
Benutzer
   ↓
Bot-Webseite
   ↓
Bot-Hub
   ↓
Discord OAuth
   ↓
Bot-Hub
   ↓
Bot-Panel-Session
   ↓
Bot-Webseite
```

Dabei:

- Main-Session nicht per JavaScript auslesen.
- `HttpOnly`-Cookies beibehalten.
- keine Discord-Tokens an das Frontend schicken.
- keinen Bot-Token an das Frontend schicken.
- keine Runtime-Tokens an das Frontend schicken.

Die Bot-Webseite erhält nur die minimal notwendigen Informationen:

```text
authenticated
user identity
allowed bot
allowed permissions
panel session
```

---

# 14. Bot-Token-Sicherheit

Der eigentliche Discord-Bot-Token muss ausschließlich serverseitig vorhanden sein.

NIEMALS:

```text
window.__CONFIG__
localStorage
sessionStorage
HTML
data-* Attribute
URL
Frontend-JavaScript
```

mit dem Bot-Token befüllen.

Der Browser darf nur serverseitig über APIs mit Bot-Funktionen kommunizieren.

---

# 15. Runtime-Token-Sicherheit

Der `BOT_HUB_TOKEN` darf:

- nur dem jeweiligen Bot gegeben werden,
- nur seine eigenen `/api/hub/*`-Routen erreichen,
- niemals als globale Admin-Identität behandelt werden,
- niemals an andere Bot-Prozesse weitergegeben werden.

Panel-Token:

```text
!= BOT_HUB_TOKEN
```

Main Session:

```text
!= BOT_HUB_TOKEN
```

---

# 16. Tests für die neue Sicherheitsrunde

## Workspace

Testen:

```text
Bot A -> Bot A workspace       ALLOW
Bot A -> Bot B workspace       DENY
Bot A -> PROJECT_ROOT/.env     DENY
Bot A -> data/access.json      DENY
Bot A -> ../                   DENY
Bot A -> absolute path         DENY
Bot A -> symlink outside       DENY
```

## Prozessisolation

Wenn OS-/Container-Isolation implementiert wird:

```text
Bot A -> Bot B files           DENY
Bot A -> Hub .env              DENY
Bot A -> Hub SSH keys          DENY
Bot A -> other bot env         DENY
```

## Commands

```text
node server.js                 ALLOW
python3 main.py                ALLOW
./start.sh                     ALLOW
```

und:

```text
foo; touch /tmp/pwned          DENY
foo && touch /tmp/pwned        DENY
foo | touch /tmp/pwned         DENY
$(touch /tmp/pwned)            DENY
`touch /tmp/pwned`             DENY
```

## Panel Token

Testen:

```text
bootstrap token                einmal ALLOW
bootstrap token zweites Mal    DENY
abgelaufener Token             DENY
falscher botId                 DENY
falsche Session                DENY
```

## Permissions

Testen:

```text
viewer
operator
admin
owner
```

gegen alle bestehenden Permissions.

Ein niedrig privilegierter Benutzer darf nicht durch eine zusätzliche Permission-Liste höher privilegiert werden.

---

# 17. Regression Tests

Nach den Änderungen ausführen:

```bash
npm test
```

```bash
node --test test/panel.test.js
```

```bash
npm run build
```

```bash
npm audit
```

Falls Registry/Netzwerk nicht verfügbar ist:

- `npm audit` nicht als erfolgreich markieren,
- nur dokumentieren, dass die Prüfung wegen fehlender Registry-Erreichbarkeit nicht durchgeführt werden konnte.

Wenn ein bestehender Test aufgrund fehlender Netzwerkkonnektivität scheitert:

- Code-Fehler und Infrastrukturfehler unterscheiden,
- keine Testabdeckung vortäuschen.

---

# 18. Akzeptanzkriterien

- [ ] Haupt-Discord-OAuth funktioniert weiterhin.
- [ ] Browsergebundener OAuth-State bleibt erhalten.
- [ ] PKCE bleibt aktiv.
- [ ] Bot-Webseiten können weiterhin den zentralen Hub-OAuth verwenden.
- [ ] Bot-Webseiten erhalten keine Main-Session-Secrets.
- [ ] Bot-Webseiten erhalten keine Discord-Bot-Tokens.
- [ ] Bot A kann nicht auf Bot B zugreifen.
- [ ] jeder Bot besitzt einen eindeutig gebundenen Workspace.
- [ ] Symlink-Escape ist blockiert.
- [ ] Bot-Prozesse sind auf OS-/Container-Ebene isoliert, sofern technisch möglich.
- [ ] Bots laufen nicht als root.
- [ ] Bot-Start verwendet keine unkontrollierte `sh -c`-Zeichenkette.
- [ ] Dependency-Installation läuft nur im Bot-Kontext.
- [ ] Panel-Token ist nicht dauerhaft als URL-Geheimnis exposed.
- [ ] One-Time-Bootstrap-Tokens werden sofort invalidiert.
- [ ] CSP ist möglichst restriktiv.
- [ ] Rollen können keine unzulässigen Permissions erhalten.
- [ ] Rate Limiting kann nicht einfach über `X-Forwarded-For` umgangen werden.
- [ ] echte Secrets sind nicht in Repository/ZIP/Testdaten.
- [ ] sensible Dateien besitzen restriktive Dateirechte.
- [ ] OAuth-Scopes sind minimal.
- [ ] alle Regressionstests funktionieren.

---

# 19. Implementierungsreihenfolge

Bitte in genau dieser Reihenfolge arbeiten:

1. Bot-Workspace eindeutig an `bot.id` binden.
2. Symlink- und Traversal-Prüfung vervollständigen.
3. echte Bot-Prozess-Isolation (Container oder Unix-User) implementieren.
4. Shell-basierte Bot-Start-/Installationsbefehle ersetzen.
5. Dependency-Installation auf den isolierten Bot-Kontext begrenzen.
6. Panel-Token aus der dauerhaften URL-Verwendung entfernen.
7. One-Time-Bootstrap-Session implementieren.
8. Rollen-/Permission-Hierarchie serverseitig härten.
9. Rate Limiting proxy-sicher machen.
10. Secrets aus ZIP/Testdaten entfernen und rotieren.
11. Dateirechte auf 0600 härten.
12. OAuth-Scopes minimieren.
13. CSP weiter härten.
14. komplette Regressionstests ausführen.

---

# 20. Arbeitsweise für GitHub Copilot

Nicht blind alle Dateien umschreiben.

Vor jeder Änderung:

1. betroffene Funktion und ihre Aufrufer lesen,
2. Datenfluss verfolgen,
3. Auth-/Permission-Grenze identifizieren,
4. minimale Änderung durchführen,
5. Tests für die konkrete Sicherheitslücke hinzufügen,
6. bestehende Tests ausführen,
7. keine Geheimnisse in Testausgaben schreiben.

Bei einer Sicherheitsänderung muss Copilot erklären können:

```text
Welche Trust Boundary wurde geändert?
Welche Daten dürfen jetzt wohin?
Welche Tokens existieren?
Welche Permission ist erforderlich?
Welche Tests verhindern eine Regression?
```

Keine Sicherheitsmaßnahme nur im Frontend implementieren.

Alle sicherheitskritischen Prüfungen müssen serverseitig erfolgen.

---

# 21. Endzustand

Das gewünschte Modell ist:

```text
                         DISCORD
                            │
                            ▼
                    ZENTRALER OAUTH
                            │
                     state + PKCE
                            │
                            ▼
                       HUB SESSION
                            │
             ┌──────────────┴──────────────┐
             │                             │
             ▼                             ▼
       Haupt-Webseite                Bot-Webseite
                                             │
                                      Bot-Session
                                             │
                                             ▼
                                      Bot API / Panel
                                             │
                              ┌──────────────┴──────────────┐
                              │                             │
                              ▼                             ▼
                       Bot Workspace                 Bot Runtime
                                                               │
                                                   Bot-spezifischer
                                                   Runtime Token
                                                               │
                                                               ▼
                                                     isolierter Prozess
                                                               │
                                                               ▼
                                                        Discord API
```

Ziel:

```text
OAuth zentral
+
Sessions getrennt
+
Tokens getrennt
+
Bots untereinander isoliert
+
Hub-Dateien geschützt
+
keine unkontrollierte Shell-Ausführung
+
serverseitige Permissions
+
Rate Limiting
+
keine Secrets im Archiv
```

Die zentrale OAuth-Architektur der Haupt-Webseite und die Anmeldung der einzelnen Bot-Webseiten müssen dabei vollständig funktionsfähig bleiben.
