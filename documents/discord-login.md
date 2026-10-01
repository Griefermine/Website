# Discord-Anmeldung

Die Discord-Anmeldung schützt das komplette Dashboard und alle normalen
`/api`-Routen. Die Bot-eigene Panel-Anmeldung bleibt zusätzlich verfügbar.

Für den zentralen Login werden im Hub-Umfeld gesetzt:

```env
DISCORD_CLIENT_ID=deine-client-id
DISCORD_CLIENT_SECRET=dein-client-secret
# optional: initialer Hub-Eigentümer (mehrere IDs mit Komma trennen)
BOT_HUB_OWNER_IDS=deine-discord-user-id
# optional bei Reverse-Proxy oder abweichendem Host:
DISCORD_REDIRECT_URI=https://example.com/api/auth/discord/callback
```

Die Redirect URL in Discord lautet standardmäßig:

```text
https://example.com/api/auth/discord/callback
```

Ohne diese Variablen bleibt das Dashboard gesperrt. Nach erfolgreichem Login
wird eine serverseitige Session im
HttpOnly-Cookie `bot_hub_session` angelegt; Discord-Tokens werden nicht an den
Browser oder in die Bot-Konfiguration weitergegeben.

`BOT_HUB_OWNER_IDS` verhindert, dass ein beliebiger erster Login automatisch
Eigentümer wird. Nur eine konfigurierte ID kann beim erstmaligen Login den
Bootstrap-Eigentümer erhalten; bestehende Eigentümer bleiben unverändert.

Im gesperrten Dashboard wird trotzdem der Button **Mit Discord einloggen**
angezeigt. Damit der Button den OAuth2-Fluss starten kann, müssen
`DISCORD_CLIENT_ID` und `DISCORD_CLIENT_SECRET` in der root `.env` gesetzt sein.

Das Bot-Panel unterstützt die Anmeldung mit einem Discord-Konto per OAuth2.
Nutzer müssen dabei keinen eigenen Discord-Bot-Token in der Webseite
hinterlegen. Nach der Anmeldung werden nur Discord-Server angezeigt, auf denen
der Nutzer Administrator ist oder die Berechtigung **Server verwalten** besitzt.

## Einmalige Einrichtung für den Betreiber

1. In [Discord Developer Portal](https://discord.com/developers/applications)
   eine Application anlegen oder eine vorhandene öffnen.
2. Unter **OAuth2** als Redirect URL die URL des laufenden Bot-Hubs eintragen:

   ```text
   http://localhost:8787/api/bots/<BOT-ID>/panel/discord/callback
   ```

   Bei einem anderen Host oder Port muss die URL entsprechend angepasst werden.
   `<BOT-ID>` ist die ID des jeweiligen Bots.

3. Für die Python-Webseite die Datei
   `bots/python-echo/.env.example` nach `bots/python-echo/.env` kopieren:

   ```bash
   cp bots/python-echo/.env bots/python-echo/.env
   ```

4. In `.env` das neue Client Secret eintragen:

   ```env
   DISCORD_CLIENT_ID=deine-client-id
   DISCORD_CLIENT_SECRET=dein-neues-client-secret
   ```

   Diese Datei gehört nur zum Python-Bot. `.env` bleibt lokal und wird nicht in
   Git aufgenommen; der Hub liest sie beim Aufruf des Python-Panels.

5. Den Hub starten. Eine Root-Datei `.env` ist dafür nicht erforderlich:

   ```bash
   npm run dev:hub
   ```

   Für die Weboberfläche in einem zweiten Terminal:

   ```bash
   npm run dev:web
   ```

Die Anwendung verwendet die OAuth2-Scopes `identify`, `guilds` und
`guilds.members.read`. Das Client-Secret bleibt ausschließlich auf dem Server
und wird nicht an den Browser ausgeliefert.

Wenn das Dashboard bereits angemeldet ist und eine Bot-eigene Seite geöffnet
wird, übernimmt der Hub diese Anmeldung automatisch für das ausgewählte Panel.
Dabei wird nur eine neue, kurzlebige serverseitige Panel-Session gesetzt:
Discord-Access-Tokens, OAuth-Codes und Geheimnisse werden weder in die URL noch
in ein iframe oder an den Bot weitergegeben. Für die Anzeige werden zusätzlich
nur Server berücksichtigt, auf denen der Bot installiert ist und für die der
Nutzer Administratorrechte oder **Server verwalten** besitzt. Ist keine zentrale
Hub-Anmeldung vorhanden, bleibt der normale Login der Bot-Seite verfügbar.

## Wichtig: Konto-Login und Bot-Verbindung

Die Discord-Anmeldung identifiziert den Nutzer und liest seine verwaltbaren
Server. Ein Bot, der sich tatsächlich mit Discord verbindet, benötigt
zusätzlich weiterhin seinen eigenen Bot-Token (`DISCORD_BOT_TOKEN`). Dieser
bleibt eine geheime Server-/Bot-Konfiguration und wird nicht im Browser
angezeigt.
