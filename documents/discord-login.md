# Discord-Anmeldung

Die Discord-Anmeldung schützt das komplette Dashboard und alle normalen
`/api`-Routen. Die Bot-eigene Panel-Anmeldung bleibt zusätzlich verfügbar.
Jedes externe Bot-Panel kann denselben OAuth-Mechanismus verwenden; die
Zugangsdaten werden ausschließlich aus der lokalen `.env` des jeweiligen Bots
gelesen.

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
Wenn ein Panel OAuth-Daten in seiner `.env` enthält, ist diese Anmeldung für
alle Änderungen und Aktionen verbindlich. Lesen der Panel-Daten bleibt über
die bestehende Panel-Session möglich; Einstellungen speichern und Panel-
Befehle ausführen werden serverseitig abgewiesen, solange keine gültige
bot-eigene Discord-Session vorliegt. Der OAuth-Login kann nach dem Öffnen der
geschützten Bot-Seite ohne eine zusätzliche zentrale Hub-Session abgeschlossen
werden; Panel-Token und serverseitiger OAuth-State binden den Vorgang eindeutig
an diesen Bot.

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
   # alternativ akzeptiert die API auch:
   # DISCORD_CLIENT_TOKEN=dein-client-token
   # optional: vollständige Discord-OAuth-Authorize-URL
   DISCORD_OAUTH_URL=https://discord.com/oauth2/authorize
   ```

   `DISCORD_CLIENT_SECRET` ist trotz der OAuth-URL erforderlich. Die URL
   enthält nur öffentliche Authorize-Parameter; das Secret darf nicht in die
   URL geschrieben werden. Wenn die URL `client_id=...` enthält, kann
   `DISCORD_CLIENT_ID` alternativ weggelassen werden.

   Diese Datei gehört zum jeweiligen externen Bot. `.env` bleibt lokal und wird
   nicht in Git aufgenommen; der Hub liest sie nur serverseitig. Der Client-
   Token bzw. das Client-Secret wird niemals an die Panel-Webseite ausgeliefert.

5. Den Hub starten. Eine Root-Datei `.env` ist dafür nicht erforderlich:

   ```bash
   npm run dev:hub
   ```

   Für die Weboberfläche in einem zweiten Terminal:

   ```bash
   npm run dev:web
   ```

Die Anwendung verwendet die OAuth2-Scopes `identify` und `guilds`. Das Client-
Secret bzw. der Client-Token bleibt ausschließlich auf dem Server und wird
nicht an den Browser ausgeliefert.

## Adresse des Hubs: lokal oder auf einer Domain

`HOST` und `BOT_HUB_URL` beantworten zwei verschiedene Fragen und dürfen nicht
verwechselt werden:

- `HOST` – Adresse, auf der der Hub **lauscht**. `0.0.0.0` nimmt Verbindungen
  auf allen Interfaces an. Das ist nötig, weil die Bots im Container den Hub
  über `host.docker.internal` (siehe `BOT_HUB_CONTAINER_URL`) erreichen und ein
  Zugriff auf `127.0.0.1` von außen nicht möglich wäre.
- `BOT_HUB_URL` – Adresse, die der Hub **ausgibt**: Discord-Redirect, Panel-Links
  und die Hub-URL für die Bots. Der Hub bildet sie ausschließlich aus dieser
  Variablen, nicht aus dem `Host`-Header der Anfrage.

### Lokale Entwicklung

```dotenv
HOST=0.0.0.0
BOT_HUB_URL=http://127.0.0.1:8787
```

Das ist die richtige Einstellung, solange der Hub nur auf diesem Rechner
geöffnet wird. Der Discord-Redirect lautet dann
`http://127.0.0.1:8787/api/auth/discord/callback` – Discord erlaubt
unverschlüsselte URLs ausschließlich für Loopback-Adressen.

### Später auf einer Domain

1. TLS davor setzen (Caddy/nginx). Der Hub selbst spricht weiter nur HTTP und
   darf auf `0.0.0.0` bleiben, damit die Container ihn erreichen.
2. In `.env` die öffentliche Adresse eintragen:

   ```dotenv
   BOT_HUB_URL=https://hub.example.de
   DISCORD_REDIRECT_URI=https://hub.example.de/api/auth/discord/callback
   BOT_HUB_SECURE_COOKIES=1
   NODE_ENV=production
   ```

   `BOT_HUB_CONTAINER_URL` bleibt unverändert, damit die Bots im Container den
   Hub weiter über `host.docker.internal` erreichen.

3. Im Discord-Entwicklerportal unter _OAuth2 → Redirects_ genau
   `https://hub.example.de/api/auth/discord/callback` eintragen. Discord
   vergleicht Zeichen für Zeichen – Groß-/Kleinschreibung, `http`/`https` und ein
   Slash am Ende zählen.
4. Der Reverse-Proxy muss den `Host`-Header unverändert durchreichen
   (`reverse_proxy 127.0.0.1:8787` genügt), sonst beantwortet der Hub
   Browser-Anfragen mit 403.

Beim Start prüft der Hub diese Kombination und warnt, wenn die URLs nicht
zusammenpassen oder unverschlüsselt außerhalb von Loopback liegen.

Wenn das Dashboard bereits angemeldet ist und eine Bot-eigene Seite geöffnet
wird, übernimmt der Hub diese Anmeldung automatisch für das ausgewählte Panel.
Dabei wird nur eine neue, kurzlebige serverseitige Panel-Session gesetzt:
Discord-Access-Tokens, OAuth-Codes und Geheimnisse werden weder in die URL noch
in ein iframe oder an den Bot weitergegeben. Ist keine zentrale Hub-Anmeldung
vorhanden, bleibt der normale Login der Bot-Seite verfügbar.

### Wer sich am Panel anmelden darf

Der Login der Bot-Seite ist keine offene Anmeldung. Der Hub akzeptiert ihn nur,
wenn alle drei Bedingungen zutreffen:

1. **Die richtige Guild.** Maßgeblich ist `guildId` des Bots, also der Server,
   für den er konfiguriert ist. Wer in einem _anderen_ Server
   „Server verwalten" hat, bekommt keinen Zugriff. Ist `guildId` leer, zählt
   jeder Server, in dem der Bot installiert ist.
2. **Die passende Berechtigung.** Administrator oder **Server verwalten** in
   diesem Server. Ein Discord-Konto ohne jede Berechtigung wird abgewiesen –
   es entsteht dann gar keine Sitzung, und das Token wird sofort wieder
   verworfen.
3. **Der installierte Bot.** Lässt sich mit dem Bot-Token prüfen, in welchen
   Servern der Bot ist. Fehlt der Token, wird auf diesen Punkt verzichtet
   (sonst wäre das Panel eines noch nicht konfigurierten Bots nie bedienbar);
   die Berechtigungsprüfung bleibt.

Die Meldung im Log sagt, welcher Grund greift:

```text
[hub] Discord-Anmeldung für <Bot> abgewiesen: keine Berechtigung in der Ziel-Guild <id>.
```

### Die Bot-Seite läuft auf der Adresse des Callbacks

`/api/bots/<id>/panel/open` leitet **absolut** auf die Adresse weiter, die auch
den Discord-Callback bekommt – also auf `DISCORD_REDIRECT_URI` des Bots bzw.
`BOT_HUB_URL`. Das ist Absicht: Das Bindungs-Cookie des Logins gilt nur für den
Host, bei dem es gesetzt wurde, und der Callback kommt über genau diesen Host
zurück. Ein relativer Link würde die Seite im Entwicklungsbetrieb über den
Vite-Port (`localhost:5173`) laden, dann landet das Cookie bei `localhost` und
der Callback käme bei `127.0.0.1:8787` an – ohne Cookie, mit der Meldung
„anderer Browser“. Zusätzlich darf die sandboxed Bot-Seite aus diesem Grund gar
nicht erst über den Vite-Port geladen werden: ihre Abrufe an den Hub gingen
dann ins Leere. Wer die Seite im Dashboard öffnet, landet deshalb automatisch auf
der Hub-Adresse; im Browser ist danach `http://127.0.0.1:8787/…` zu sehen.

### Warum ein zusätzliches Cookie

Der Login läuft über Discord, kommt also als Weiterleitung im Browser zurück.
Ein Angreifer könnte seinen eigenen Callback-Url an ein Opfer schicken; dessen
Browser übernähme dann die Discord-Sitzung des Angreifers (Login-CSRF). Deshalb
setzt der Hub beim Start des Logins ein kurzlebiges Cookie
(`bot_hub_preauth_<bot-id>`, `HttpOnly`, `SameSite=Lax`, 10 Minuten) und
verlangt es beim Callback wieder. Wird der Callback in einem anderen Browser
geöffnet, gibt es eine klare Meldung statt einer fremden Sitzung:

```text
Diese Discord-Anmeldung wurde in einem anderen Browser oder unter einer
anderen Adresse gestartet. Bitte die Bot-Seite über die Hub-Adresse öffnen und
dort erneut anmelden.
```

Passt das Cookie, aber gehört es zu einem anderen Login-Versuch, lautet die
Meldung entsprechend („gehört zu einem anderen Login-Versuch“). Im Log steht
dazu, welcher Host den Callback geschickt hat und welche Cookies mitkamen – nur
Namen, keine Werte.

### Der Login startet als Navigation, nicht per fetch

Die Bot-Seite läuft in einer Sandbox (Origin `null`). Ein Cookie aus einem
`fetch` dieser Seite ist ein Drittanbieter-Cookie, das der Browser beim
Rücksprung von Discord nicht mitschickt – im echten Browser getestet: Der Login
brach genau daran ab. Deshalb arbeitet der Ablauf in zwei Schritten:

1. Die Seite fragt `…/panel/discord/login?format=json` ab und bekommt nur die
   Start-Adresse `…/panel/discord/login?ticket=…` zurück. Das Ticket ist
   einmalig, 60 Sekunden gültig und merkt sich den Panel-Token der Seite. Ein
   State entsteht hier **nicht**.
2. Der Browser ruft die Start-Adresse als Navigation auf (Pop-up oder derselbe
   Tab). Erst dort legt der Hub den State an, setzt das Bindungs-Cookie und
   leitet zu Discord weiter.

Eigene Bot-Seiten nutzen dafür `hub.discordLogin()` aus `bridge.js` und
öffnen die gelieferte Adresse in einem Fenster. `openDiscordAuthorization` in
`bots/python-echo/panel/panel.js` zeigt das Muster: die Adresse wird geprüft
(entweder `discord.com/oauth2/authorize` oder der Login-Start auf der eigenen
Hub-Adresse), bevor das Fenster darauf zeigt. Wer stattdessen die Discord-Adresse
aus dem JSON selbst aufruft, umgeht die Browser-Bindung und der Callback wird
abgelehnt – das ist die Absicht dieser Sperre.

Als Gegenposten bleibt ein Restrisiko: Wer Zugang zum Hub und einen Panel-Token
hat, kann ein Ticket erzeugen und einem Opfer den Start-Url schicken. Bestätigt
das Opfer den Discord-Dialog, landet die Sitzung beim Panel-Token des
Absenders (nicht beim Opfer). Das ist ein bewusster Kompromiss, weil eine
Browser-Bindung ohne Cookie technisch nicht herstellbar ist; `prompt=consent`
sorgt dafür, dass Discord in jedem Fall nachfragt.

## Wichtig: Konto-Login und Bot-Verbindung

Die Discord-Anmeldung identifiziert den Nutzer und liest seine verwaltbaren
Server. Ein Bot, der sich tatsächlich mit Discord verbindet, benötigt
zusätzlich weiterhin seinen eigenen Bot-Token (`DISCORD_BOT_TOKEN`). Dieser
bleibt eine geheime Server-/Bot-Konfiguration und wird nicht im Browser
angezeigt.
