# Bot-Hub – Security-Fixes für V6

## Zweck

Dieses Dokument ist als Arbeitsauftrag für GitHub Copilot in WebStorm gedacht.
Bitte **den bestehenden Code verbessern**, nicht die Architektur komplett neu schreiben.
Priorität: Sicherheitskorrektheit, Rückwärtskompatibilität, kleine nachvollziehbare Änderungen.

## Ausgangslage

Die aktuelle Version ist V5. Bereits vorhanden und beibehalten werden sollen:

- Discord OAuth für das Hauptpanel
- serverseitige Rollen und Permissions
- Owner/Admin-Hierarchie
- Runtime-/Panel-Token mit getrennten Scopes
- Token-Widerruf beim Stoppen eines Bots
- gehärtetes CORS
- `realpath`-Prüfung für Panel-Dateien
- `.env`-Einträge im `.gitignore`

Nicht entfernen oder durch schwächere Checks ersetzen.

---

# P0 – Bot-Prozesse dürfen keine Hub-Secrets erben

## Problem

In `server/manager.js` verwendet `botEnv()` aktuell sinngemäß:

```js
return {
  ...process.env,
  ...bot.env,
  ...
};
```

Damit erhalten Bot-Prozesse und auch Dependency-Befehle sämtliche Umgebungsvariablen des Hub-Prozesses.
Das kann z. B. `DISCORD_CLIENT_SECRET`, Session-Secrets oder weitere Infrastruktur-Secrets an nicht vertrauenswürdigen Bot-Code weitergeben.

## Ziel

Keine pauschale Weitergabe von `process.env` mehr.
Nur ausdrücklich erlaubte Variablen dürfen einen Bot-Prozess erreichen.

## Umsetzung

In `server/manager.js`:

1. `...process.env` aus `botEnv()` entfernen.
2. Eine kleine Allowlist für ungefährliche Laufzeitvariablen anlegen, z. B.:
   - `PATH` bzw. `Path`
   - `HOME` (nur wenn tatsächlich erforderlich)
   - `LANG` (nur wenn erforderlich)
   - `TMPDIR` / Windows-Äquivalent nur wenn erforderlich
   - `VIRTUAL_ENV`
   - `PIP_DISABLE_PIP_VERSION_CHECK`
   - `npm_config_yes`
3. Bot-spezifische Werte weiterhin explizit setzen:
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `BOT_NAME`
   - `BOT_HUB_ID`
   - `BOT_HUB_URL`
   - `BOT_HUB_TOKEN` nur für den echten Bot-Prozess, nie für beliebige Hilfsprozesse ohne Runtime-Anforderung.
4. `bot.env` darf nur die absichtlich konfigurierten Bot-Umgebungsvariablen enthalten.
5. Niemals automatisch Variablen aus dem Hub-Prozess übernehmen, deren Namen `SECRET`, `TOKEN`, `PASSWORD`, `KEY`, `COOKIE`, `SESSION`, `PRIVATE` oder ähnlich enthalten.
6. Keine Änderung an der bestehenden Runtime-Token-Prüfung.

## Erwartetes Prinzip

```js
const safeEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  LANG: process.env.LANG ?? '',
  ...bot.env,
};

return {
  ...safeEnv,
  ...botSpecificValues,
};
```

Die konkrete Allowlist darf kleiner sein, wenn einzelne Variablen nicht benötigt werden.

## Tests

Ergänze Tests, die sicherstellen:

- `DISCORD_CLIENT_SECRET` aus der Hub-Umgebung ist **nicht** in `botEnv()` vorhanden.
- ein absichtlich gesetztes `TEST_SECRET` ist **nicht** vorhanden.
- `DISCORD_BOT_TOKEN` ist weiterhin vorhanden, wenn es für den Bot vorgesehen ist.
- `BOT_HUB_TOKEN` wird nur bei `runtime: true` gesetzt.
- bestehende PATH-/Virtualenv-Funktionalität bleibt erhalten.

---

# P0 – Separaten Discord-OAuth-Login des Bot-Panels korrekt routen

## Problem

`server/auth.js` lässt die Bot-Panel-OAuth-Routen absichtlich ohne bestehende Hauptsession durch:

```text
/api/bots/:id/panel/discord/*
```

In `server/manager.js` wird anschließend aber für `action === 'panel'` trotzdem zuerst eine normale Permission verlangt:

```js
permission(req.method === 'GET' || panelLogout ? 'panel.read' : 'panel.manage');
```

Dadurch kann der separate Bot-Panel-Login ohne Hauptsession mit `403` abgewiesen werden, bevor `panelDiscordAuth()` ihn erreicht.

## Ziel

Diese Routen müssen ohne Hauptsession erreichbar sein:

```text
GET /api/bots/:id/panel/discord/config
GET /api/bots/:id/panel/discord/login
GET /api/bots/:id/panel/discord/callback
```

Alle anderen Panel-Routen bleiben normal geschützt.

## Umsetzung

In `server/manager.js`:

1. Vor der normalen `panel.read` / `panel.manage`-Prüfung erkennen, ob die Route eine Bot-Panel-Discord-Auth-Route ist.
2. Diese Auth-Routen direkt an `handlePanelRoutes(...)` weiterreichen.
3. Danach für alle übrigen `panel`-Routen die bestehende Permission-Prüfung unverändert anwenden.
4. `discord/logout` darf nur entsprechend der bestehenden Sicherheitslogik verwendet werden. Eine Logout-Route darf nicht versehentlich alle Session-Schutzmechanismen umgehen.

Beispielstruktur:

```js
if (action === 'panel') {
  const isDiscordAuthRoute =
    /^\/panel\/discord\/(config|login|callback)$/.test(rest);

  if (isDiscordAuthRoute) {
    return handlePanelRoutes(bot, req, res, url, currentAuthSession(req));
  }

  const panelLogout = ...;
  permission(req.method === 'GET' || panelLogout ? 'panel.read' : 'panel.manage');
  return handlePanelRoutes(bot, req, res, url, currentAuthSession(req));
}
```

Die exakte Struktur an den vorhandenen Router anpassen.

## Tests

Mindestens folgende Fälle testen:

- ohne Hauptsession: `/discord/login` funktioniert und antwortet mit `302` auf Discord.
- ohne Hauptsession: `/discord/callback` wird nach erfolgreichem State-Flow verarbeitet.
- ohne Hauptsession: normale Panel-Settings bleiben `401/403`.
- Viewer ohne `panel.read`: kein Zugriff auf normale Panel-Routen.
- Benutzer mit `panel.read`: GET-Panel weiterhin möglich.

---

# P1 – `/api/health` keine lokalen Pfade preisgeben

## Problem

`/api/health` ist ohne Login erreichbar und liefert aktuell:

```js
{
  ok: true,
  projectRoot: PROJECT_ROOT,
  bots: bots.size
}
```

Der absolute Projektpfad ist unnötige Information.

## Ziel

Nur minimale Health-Informationen zurückgeben.

## Umsetzung

Bevorzugt:

```js
return sendJson(res, 200, {
  ok: true,
  bots: bots.size,
});
```

Keinen absoluten Dateipfad, keine Secrets und keine Benutzer-/Systeminformationen liefern.

## Tests

Prüfen, dass die Response keinen String `projectRoot` und keinen absoluten Projektpfad enthält.

---

# P1 – Bootstrap-Owner nicht blind an den ersten Login vergeben

## Problem

`server/auth.js` macht aktuell den ersten unbekannten Benutzer automatisch zum `owner`:

```js
const firstUser = Object.keys(access.users).length === 0;
role: firstUser ? 'owner' : 'viewer';
```

Bei einem öffentlich erreichbaren frischen Server wird dadurch der erste eingeloggte Discord-Account Owner.

## Ziel

Initiale Owner-Zuweisung muss explizit konfigurierbar sein.

## Umsetzung

Eine Umgebungsvariable einführen, z. B.:

```env
BOT_HUB_OWNER_IDS=123456789012345678
```

Mehrere IDs durch Komma trennen.

Regeln:

1. Falls `BOT_HUB_OWNER_IDS` gesetzt ist, darf **nur** eine dort enthaltene Discord-ID initial als Owner angelegt werden.
2. Ein nicht freigeschalteter erster Benutzer wird maximal `viewer`.
3. Bei keiner konfigurierten Owner-ID darf das bisherige Bootstrap-Verhalten nicht stillschweigend zu einem öffentlichen Vollzugriff führen.
4. Bestehende gespeicherte Owner dürfen durch das neue Bootstrap nicht entwertet werden.
5. `access.manage`-Hierarchie und Schutz des letzten Owners beibehalten.

## Tests

- konfigurierte Owner-ID -> erster Login wird Owner.
- nicht konfigurierte ID -> kein Owner.
- bereits vorhandene Owner bleiben Owner.
- mehrere konfigurierte IDs funktionieren deterministisch.

---

# P1 – Arbeitsverzeichnis eines Bots vollständig realpath-basiert absichern

## Problem

Panel-Dateien werden bereits stärker über `realpath` geprüft. Das eigentliche Bot-Arbeitsverzeichnis muss dieselbe Sicherheitslogik verwenden.

## Ziel

Ein Bot darf sein Arbeitsverzeichnis nie außerhalb des erlaubten Projekt-/Bot-Bereichs auflösen, auch nicht über Symlinks.

## Umsetzung

In `server/manager.js` eine zentrale Funktion erstellen, z. B.:

```js
resolveTrustedBotDir(bot);
```

Regeln:

1. Kandidatenpfad mit `resolve()` bilden.
2. Existierenden Pfad mit `realpathSync()` bzw. async `realpath()` auflösen.
3. Mit dem vertrauenswürdigen Projektroot vergleichen.
4. Relative Pfade nur erlauben, wenn sie wirklich innerhalb des erlaubten Root-Bereichs liegen.
5. Symlink-Ausbruch außerhalb des Roots muss `400/403` ergeben.
6. Dieselbe Funktion für Start, Install, Dependency-Check, Manifest und relevante Dateioperationen verwenden.

Nicht nur String-Checks verwenden.

## Tests

- `../` -> abgelehnt.
- absoluter Pfad außerhalb -> abgelehnt.
- Symlink innerhalb des Bots -> auflösen und nur erlauben, wenn Ziel innerhalb des erlaubten Roots liegt.
- Symlink nach `/etc` oder einen anderen externen Ort -> abgelehnt.

---

# P1 – Runtime-Token nicht aus Query-Parametern akzeptieren

## Problem

`server/panel.js` akzeptiert Tokens auch über:

```text
?token=...
```

Tokenwerte in URLs können leichter in Logs, Browser-Historien, Proxies oder Analytics landen.

## Ziel

Token-Nutzung primär über Header.

## Umsetzung

Bevorzugte Header:

```text
X-Bot-Hub-Token
Authorization: Bearer <token>
```

Für produktive Runtime-/Panel-Aktionen:

1. Header zuerst prüfen.
2. Query-Parameter standardmäßig deaktivieren.
3. Falls Kompatibilität zwingend erforderlich ist, Query-Token nur hinter explizitem Development-Schalter akzeptieren und niemals standardmäßig aktivieren.

Dokumentation und Frontend/Bridge entsprechend anpassen.

## Tests

- korrekter Header -> funktioniert.
- falscher Header -> `401`.
- Query-Token ohne Dev-Schalter -> `401`.
- Panel-Token bleibt auf Panel-Scope beschränkt.

---

# P1 – Secrets aus Repository und Beispieldaten entfernen

## Problem

Keine echten Credentials im Repository, in Beispiel-Bots, `data/`, `.env` oder Git-Historie.

Das aktuelle Projekt enthält laut Sicherheitsprüfung Secret-Dateien und gespeicherte Bot-Credentials.

## Umsetzung

1. Keine echten Tokens/Client-Secrets in Git.
2. `.env.example` darf nur Platzhalter enthalten.
3. Keine echte `data/bots.json` committen.
4. Lokale Runtime-Dateien in `.gitignore` lassen.
5. Bereits verwendete Credentials nach Entfernung aus dem Repo **rotieren/widerrufen**.
6. Prüfen, dass `.gitignore` nicht durch Negationen versehentlich `.env` wieder aktiviert.

Nicht versuchen, echte Secretwerte in diesen Patch einzubauen.

---

# P2 – Vite aktualisieren und Dev-Server nicht öffentlich exponieren

## Aktuell

`package.json` verwendet:

```json
"vite": "^5.4.21"
```

## Ziel

- aktuelle kompatible Vite-Version verwenden
- Dev-Server nicht unnötig an `0.0.0.0` binden
- produktiv `vite build` / statische Assets verwenden statt eines öffentlich erreichbaren Dev-Servers

Nach dem Update Lockfile neu erzeugen.

Danach:

```bash
npm audit
npm test
npm run build
```

---

# P2 – Security-Header weiter härten

Bestehende CSP nicht versehentlich kaputtmachen, aber folgende Header prüfen bzw. ergänzen, soweit mit der App kompatibel:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: ...
Content-Security-Policy: möglichst restriktiv
```

Für eingebettete Bot-Panels keine globale CSP einführen, die das Produkt kaputt macht. Die vorhandene Sandbox-/Bridge-Isolation erhalten.

---

# Pflichtregeln für Copilot

1. **Keine Secrets im Code erzeugen oder hart codieren.**
2. Keine Auth-/Permission-Prüfungen aus Bequemlichkeit entfernen.
3. Keine bestehende Permission von `panel.manage`, `bots.manage`, `bots.control`, `bots.delete`, `logs.read` oder `access.manage` abschwächen.
4. Runtime-Token und Panel-Token müssen getrennte Scopes behalten.
5. Bot-Prozesse dürfen niemals automatisch das komplette `process.env` des Hub-Prozesses erhalten.
6. Änderungen möglichst klein und auf die genannten Dateien beschränken.
7. Kommentare nur dort ergänzen, wo die Sicherheitsannahme sonst nicht offensichtlich ist.
8. Nach jeder Änderung Tests ergänzen oder anpassen.
9. Bestehende APIs nur ändern, wenn dies für die Sicherheitskorrektur erforderlich ist.

---

# Abnahmekriterien

Die Änderung ist erst fertig, wenn alle Punkte erfüllt sind:

- [ ] Kein `...process.env` mehr in der Bot-Prozessumgebung.
- [ ] Hub-Secrets sind für Bot-Prozesse nicht sichtbar.
- [ ] Bot-Panel Discord Login/Callback funktionieren ohne Hauptsession.
- [ ] Normale Panel-Aktionen bleiben ohne passende Permission geschützt.
- [ ] `/api/health` verrät keinen absoluten Projektpfad.
- [ ] Initialer Owner kann explizit über Discord-ID(s) festgelegt werden.
- [ ] Bot-Arbeitsverzeichnisse sind auch gegen Symlink-Ausbruch geschützt.
- [ ] Query-Token sind standardmäßig deaktiviert.
- [ ] Keine echten Secrets werden neu ins Repository aufgenommen.
- [ ] `npm test` läuft erfolgreich durch.
- [ ] `npm run build` läuft erfolgreich durch.
- [ ] `npm audit` wurde geprüft und verbleibende Findings dokumentiert.

---

# Empfohlene Reihenfolge

## Schritt 1

`server/manager.js`

- `botEnv()` auf Allowlist umstellen.
- Panel-Discord-Auth-Routen vor der normalen Panel-Permission behandeln.

## Schritt 2

`server/auth.js`

- konfigurierbare Bootstrap-Owner-ID(s) ergänzen.

## Schritt 3

`server/manager.js` / `server/util.js`

- zentrale realpath-basierte Bot-Dir-Prüfung ergänzen und verwenden.
- `/api/health` entschärfen.

## Schritt 4

`server/panel.js`

- Query-Token standardmäßig deaktivieren.
- Header-basierte Tokenprüfung beibehalten.

## Schritt 5

Repository-Hygiene

- Secrets entfernen.
- `.env.example` prüfen.
- `data/` und lokale Laufzeitdaten nicht committen.

## Schritt 6

Dependencies und Tests

- Vite aktualisieren.
- `npm audit`.
- `npm test`.
- `npm run build`.

---

# Wichtig

Keine offensiven Exploit-Skripte oder Payload-Sammlungen hinzufügen. Die Aufgabe ist defensive Absicherung des bestehenden Bot-Hub-Projekts.
