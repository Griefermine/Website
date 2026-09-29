# Discord-Anmeldung

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
   cp bots/python-echo/.env.example bots/python-echo/.env
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

Die Anwendung verwendet die OAuth2-Scopes `identify` und `guilds`. Das
Client-Secret bleibt ausschließlich auf dem Server und wird nicht an den
Browser ausgeliefert.

## Wichtig: Konto-Login und Bot-Verbindung

Die Discord-Anmeldung identifiziert den Nutzer und liest seine verwaltbaren
Server. Ein Bot, der sich tatsächlich mit Discord verbindet, benötigt
zusätzlich weiterhin seinen eigenen Bot-Token (`DISCORD_BOT_TOKEN`). Dieser
bleibt eine geheime Server-/Bot-Konfiguration und wird nicht im Browser
angezeigt.
