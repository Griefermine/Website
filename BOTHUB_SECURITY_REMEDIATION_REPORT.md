# Bot-Hub — Sicherheits-Nachrüstung V27: Abschlussbericht

Stand: 30.10.2026 · Zweig `audit/v27-live-validation` (aufgebaut auf
`pr/bot-hub-scaffold`, Spitze zur Baseline `9576b44`) · 612 Tests, 0 Fehler
(`npm test`, zuletzt nach Maßnahme 53)

## A. Auftrag und Arbeitsweise

Verifiziert wurden alle elf Problembereiche (5.1–5.11) des Auditberichts **am
tatsächlichen Code** — jedes Zitat mit Datei und Zeile, jede Behauptung nur
dann als Befund geführt, wenn der Code sie trägt. Klassifikation pro Bereich:
bestätigt / praktisch reproduziert / teilweise bestätigt / nicht reproduziert /
widerlegt / nicht geprüft. Gefixt wurde ausschließlich, was existiert.

Live geprüft wurde in einer **isolierten Schleifen-Umgebung auf dem Laptop**
(nur 127.0.0.1, keine echten Discord-Daten, keine Rotation echter Werte); die
VM blieb auf Anweisung ausgeschaltet. Commits sind lokal auf dem Zweig; ein
Push fand nicht statt.

## B. Klassifikation der elf Bereiche

| Bereich | Urteil | Kernbeweis |
|---|---|---|
| 5.1 Sessions/Vault/Exec-Sweep | **bestätigt → behoben (44/45/46)** | Sitzungsklartext in `data/sessions.json` (behoben: SHA-256-Speicher, Migration beim Laden auth.js:114/460); Produktions-Rückfall auf Klartext-Secrets war warnungsfrei (behoben: Preflight-Error preflight.js:230/268, Schreibverbot secrets.js:170); Sweep konnte frische Exec-Dateien löschen (behoben: 10-min-Schwelle containers.js:634) |
| 5.2 TOCTOU Panel | **theoretisch bestätigt → behoben (50/53)** | `statSync(path)` → `createReadStream(path)` und `existsSync/statSync` → `readFileSync(path)` im Manifest-Leser; Fenster mikrosekundengroß, praktisch schwer trafbar, Abwehr folgenlos billig (panel.js `openPanelFile`, fd-Lesen) |
| 5.3 .NET-Init im Workspace | **teilweise bestätigt → behoben (51)** | Bestehende Schutzmaßnahmen (UID-Abbildung, cap-drop, read-only) wirken; aber: Vorprüfungsfehler wurde geschluckt und der root-Lauf lief trotzdem; `EEXIST` nach `unlink` still akzeptiert; `set -e && for …` im gelieferten Skript war ungültige Shell (durch `sh -n` reproduziert) |
| 5.4 Workspace-Quota | **teilweise bestätigt → gemessen (49)** | `quotaAllows` deckt nur Hub-Schreibvorgänge ab; harte Grenze je Workspace bleibt bewusste Betriebsentscheidung (`documents/sicherheit.md`). Was fehlte: jegliche Messung des freien Platzes — jetzt `statfs`-Guard mit 422 vor Anlage und Installation |
| 5.5 Proxy/Raten | **bestätigt → behoben (47)** | `::ffff:127.0.0.1` vs. `127.0.0.1` wurde zeichengetreu verglichen: `X-Forwarded-For` verwarf man selbst bei konfiguriertem Vertrauen → alle Besucher teilten einen Eimer; jetzt kanonisch (manager.js:143–176), live bewiesen (30/429-Grenze pro Besucheradresse) |
| 5.6 Auth-Kette ungeprüft | **bestätigt → behoben (48)** | Die ganze Suite lief mit `BOT_HUB_TEST_MODE=1`, der genau diese Kette abschaltet; jetzt 15 Fälle echter HTTP-Kette gegen Mock-Discord ohne Testmodus; Nebenfund: unbekannter `error`-Parameter ließ die Anmeldung bisher erfolgreich durchlaufen |
| 5.7 viewer-Rechtewiderspruch | **Produktentscheidung → vereinheitlicht (45)** | botbezogene Rechte sind für „Eingeschränkt“ gedacht (Maßnahme 37/WEB-01); Server und UI folgen jetzt derselben Grenze, Label korrigiert. Ein Widerspruch im Code blieb unter keiner Lesart |
| 5.8 (Vault/Doku) | **bestätigt → dokumentiert/geprüft (46)** | `vaultStatus()` meldet „kein Schlüssel“ vs. „unbrauchbarer Schlüssel“ ohne Werte auszugeben; Preflight-Check 1 + Tests |
| 5.9 nginx-Härtung | **praktisch reproduziert → behoben (47)** | setup-tls.sh-Heredoc-Bug mit echtem `nginx -t` reproduziert (`[emerg] invalid number of arguments in "proxy_set_header"`, Beleg `/tmp/opencode/tlsproof/`); Host-Durchreichung jetzt `$http_host`, `client_max_body_size 2m` in allen Vorlagen, alle drei bestehen `nginx -t`. Kein `limit_req` im Hub-Stack (die Besucheradresse kennt erst der Hub — Maßnahme 47 schließt dort) |
| 5.10 Token in URL/panelToken | **nicht reproduziert (bewusst so)** | Panel-Token liegt nie dauerhaft in der URL: nur ein einmaliges 60-Sekunden-Bootstrap-Token (`?bootstrap=`), danach `HttpOnly`-Cookie; `publicPanel` enthält kein `panelToken` (panel.js:2943ff.); Bot-Löschung widerruft sofort (live: 200 → 404). Abweichung zur Behauptung dokumentiert |
| 5.11 CI/Release | **bestätigt (nur CI-Referenzen) → behoben (52)** | Release-INHALTE waren bereits durch den Artefakt-Scanner abgedeckt (22 Tests); offen waren die verschiebbaren `@v4`-Tags und der Gitleaks-Registry-Tag — jetzt volle SHAs bzw. `@sha256`-Digest, gelöst per `git ls-remote`/`docker image inspect` (nichts geraten) |

## C. Prozessbefunde (Befunde über den Code hinaus)

1. **Agent-B-Bericht war großteils halluziniert.** Die Symbole
   `servePublicPanelAsset`, `hubPanelRoot`, `filePattern`, `resolveHubCaller`,
   `meta.panelToken`, `auth:'none'` haben im Repo **0 Treffer**; die Befunde
   B-01/02/03/06/10/13/15 sind damit widerlegt bzw. uninspizierbar. Es wurde
   nichts auf dieser Grundlage gefixt. Die Gegenprüfung (Abschnitt E) wurde
   explizit gegen diese Halluzinationsfalle gearbeitet und meldet jetzt nur
   noch belegte Zeilen.
2. **setup-tls.sh-Heredoc** war der einzige Bereich, der sich als zur
   Laufzeit wirklich kaputt erweisen ließ — mit echtem `nginx -t` bewiesen,
   nicht als Lese-Eindruck.
3. **test-Abschaltungen in der eigenen Suite** (`BOT_HUB_TEST_MODE`) sind ein
   strukturelles Risiko: Sie machten Maßnahme 48 nötig. Die Platzprüfung
   (49) ist deshalb bewusst auch im Testmodus aktiv und wird so getestet.

## D. Live-Validierung (isolierte Schleifen-Umgebung)

Aufbau: Mock-Discord (127.0.0.1:18799), Hub (127.0.0.1:18787, `NODE_ENV=test`
OHNE `BOT_HUB_TEST_MODE` — echte Autorisierung), SQLite, Bot-Image lokal
`alpine:3.20`, nginx:1.27-alpine auf 127.0.0.1:80. Skripte und Belege:
`/tmp/opencode/live/`. Nachweisliste:

- Anmeldung über die echte Kette für Eigentümer + Zuschauer (curl
  verifizierter Handshake, Einmal-Codes, echtes PKCE), Rollen sofort wirksam.
- Zuschauer: 403 auf Anlage, Datei-Schreibzugriff, Start/Stopp.
- Echter Container-Bot (alpine), Log „bot lebt“, Stop/Delete mit
  Audit-Spur (`BOT_DELETE … COMPLETED`, `actor=live-eigentuemer`).
- Lösch-Teilfehler (root-eigener Workspace-Ordner): HTTP 500,
  `cleanup_failed`, `deleted:false`, `FAILED step=files: EACCES` im Audit,
  Bot bleibt gesperrt; Recovery beim nächsten Start räumt restlos.
- Sessions: nur `sha256:…`-Schlüssel auf der Platte, Cookie-Wert nirgends;
  Neustart → Sitzung lebt.
- Proxy/Raten: nginx + `BOT_HUB_TRUSTED_PROXIES=127.0.0.1` — 10 Adressen →
  10 Eimer; 35 Anfragen einer Adresse → 30×302 dann 429; erfundener Header
  direkt am Hub wird ignoriert (Eimer bleibt der Socket-Adresse).
- Platz-Guard: 422 mit messbarer Meldung, kein Bot, kein Pfad-Leck.
- Panel: Bootstrap einmalig + `HttpOnly`-Cookie, Symlink als Panel-Datei 400,
  Traversierung 401/404, Zuschauer 403, Token-Widerruf nach Delete.
- **Nicht live geprüft:** MySQL-Umschaltung (kein lokales Bild, VM aus) —
  bleibt von `npm run test:mysql` abgedeckt; MySQL-Standardbild `mysql:8.4`
  ist ein Floating Tag (überschreibbar per `BOT_HUB_MYSQL_IMAGE`) — im
  Bericht erwähnt, bewusst nicht geändert.

## E. Unabhängige Gegenprüfung und Maßnahme 53

Ein zweiter, nur lesender Prüflauf über dem Endstand (`9fc15b0`) bestätigte
alle Maßnahmen M44–M52 mit Datei:Zeile und meldete drei neue Punkte:

- **NF-1 (behoben, Maßnahme 53):** `readManifest` prüfte `existsSync`/
  `statSync` und las dann `readFileSync` **nach Pfad** — genau das Muster,
  das Maßnahme 50 für die Auslieferung schloss. Jetzt: `O_NOFOLLOW`,
  Größe und Inhalt ausschließlich am geöffneten Deskriptor
  (ein Lesevorgang statt zweier), übergroß = Fehler statt Inhalt;
  4 Regressionstests (echtes Manifest, Symlink wird ignoriert, übergroß,
  kein Deskriptor-Leck). Suite danach grün.
- **NF-2 (Doku):** der Behauptungspfad `deploy/deploy-full.sh` existiert
  nicht; die Einstellung sitzt im `deploy-full.sh` der Projektwurzel und
  wird genau dort getestet. Substanz in Ordnung.
- **NF-3 (info, bewusst hingenommen):** `readToken`s `split('/')[3]` ist auf
  `/api/hub/…`-Routen der Aktionssegment statt der Bot-ID — wirkungslos,
  weil die Bot-Authentifizierung dort über Bearer-Token läuft und die
  Panel-Routen ihre Bindung zusätzlich gegen die Routen-ID prüfen
  (manager.js:2777).
- **NF-4/NF-5 (info, Restrisiken):** Sweep-Schwelle ist mtime-basiert
  (>10 min alte Fremd-Spars könnten beim Restart mitgeräumt werden — im
  Kommentar dokumentiert); der Tausch von **Zwischenverzeichnissen** im
  Fenster realpath→open bleibt theoretisch offen, weil `O_NOFOLLOW` nur die
  letzte Komponente schützt. Beide ohne praktisch treffbaren Hebel
  (Schreiber ist der Workspace-Eigentümer selbst).

## F. Maßnahmen-Register

| Nr | Commit | Testregister |
|---|---|---|
| 44 Exec-Env-Sweep | `4f95baf` | security-audit.test.js (alter Fall + Race-Fall) |
| 45 Sessions/Delegation | `0db84b3` | security-v27-sessions.test.js (10) |
| 46 Vault | `011ef93` | preflight/vault-Fälle (+9) |
| 47 Proxy/TLS-Vorlagen | `eb673f4` | security-v27-proxy.test.js (8), deploy-templates.test.js (7) |
| 48 Auth-Kette | `bf23467` | auth-flow.test.js (15) |
| 49 Datenträgerplatz | `4e3761f` | security-v27-disk.test.js (12), preflight (+3) |
| 50 Panel fd | `7569b3c` | security-v27-toctou.test.js (7) |
| 51 .NET-Init | `8a99466` | security-v27-dotnet-init.test.js (6, inkl. `sh -n` und Symlink-Falle) |
| 52 CI-Pinning | `9fc15b0` | release-scan.test.js (+4 Regel-Tests) |
| 53 Manifest fd | (dieser Zweig) | security-v27-toctou.test.js (+4) |

Baseline 526 Tests (1 Fehler im Altkörper) → Endstand **612 Tests, 0 Fehler**;
`npx prettier --check .` grün; alle Commits ausschließlich lokal auf
`audit/v27-live-validation`, nie gepusht.

## G. Was offen bleibt (ehrliche Liste)

1. Harte Kontingentgrenze je Workspace — weiterhin Betriebsentscheidung
   (Dateisystem-Quota für `bots/`), jetzt immerhin mit Messung und 422.
2. MySQL-Umschaltung und `mysql:8.4`-Floating-Tag — in der Isolation nicht
   live gefahren; nur Integrations-Suite.
3. NF-4/NF-5 (mtime-Schwelle, Zwischenverzeichnis-Fenster) — bewusst
   hingenommen, im Code-Kommentar begründet.
4. Hub als Ein-Prozess-Mischbetrieb (UI + Auth + Container-Steuerung) —
   Architekturänderung ohne Testgrundlage, in `documents/sicherheit.md` als
   begrenzt dokumentiert.
5. Alarmierung auf fremde Container / Audit externer `docker`-Aufrufe — nicht
   umgesetzt (gleicher Eintrag wie vor V27).
6. Push/PR dieser Zweige — steht ausschließlich auf Nutzerwort aus.
