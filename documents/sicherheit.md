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

```dotenv
DISCORD_BOT_TOKEN="…"
API_KEY="…"
```

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

## Startschutz

Zwei Konfigurationen führen zum Abbruch statt zu einem unsicheren Betrieb:

```text
[hub] ABBRUCH: BOT_HUB_TEST_MODE=1 hebt Anmeldung und Rate-Limits auf und ist nur mit NODE_ENV=test erlaubt …
[hub] ABBRUCH: BOT_HUB_CONTAINER_MODE=disabled ist in Produktion nicht erlaubt …
[hub] ABBRUCH: Bot-Speicher: BOT_HUB_DB_HOST="10.0.0.5" ist nicht lokal …
```

Der Testmodus heißt `BOT_HUB_TEST_MODE=1` und verlangt zusätzlich
`NODE_ENV=test`. Er fällt bewusst weg: keine Anmeldung, keine
Ratenbegrenzung, Bot-Prozesse laufen direkt auf dem Rechner und der
Discord-Endpunkt lässt sich auf Loopback umleiten. `NODE_ENV=test` allein
schaltet nichts frei – die Schranken bleiben dann stehen. Wer nur
`BOT_HUB_TEST_MODE=1` setzt, bekommt den Abbruch: lieber ein deutlicher Fehler
als ein offener Hub.

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
- **`BOT_HUB_CONTAINER_URL`.** Der Eintrag `host.docker.internal` ist eine
  bewusste Öffnung und gehört nur gesetzt, wenn ein Bot den Hub braucht.
  Ohne diese Variable erreicht ein Bot-Prozess den Hub nicht: `127.0.0.1` ist im
  Container der Container selbst. Der Hub weist beim Start darauf hin. Für
  Meldungen aus einem Bot heraus (`/api/hub/state`, `/api/hub/notify`) ist also
  entweder `BOT_HUB_CONTAINER_URL` zu setzen oder in `BOT_HUB_URL` eine Adresse
  einzutragen, die auch aus dem Container erreichbar ist.

## Was nach einem Neustart beachtet werden muss

Geänderte Regeln greifen erst mit einem neuen Hub-Prozess – der Server läuft
im Entwicklungsbetrieb ohne `--watch`. Nach dem Neustart gelten zusätzlich:

- Bot-Container aus älteren Versionen werden einmalig ersetzt (Label
  `bot-hub.config`), unter anderem mit dem `/shared`-Mount.
- Der Discord-Login der Bot-Seiten prüft jetzt die Ziel-Guild und bindet den
  Callback an den Browser, der ihn gestartet hat.
- Reste abgebrochener Schreibvorgänge (`data/secrets/.env.bot-hub.tmp-*`) werden
  beim Start entfernt.
