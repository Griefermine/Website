/**
 * Beispiel-Bot (JavaScript / discord.js)
 *
 * Start über den Bot-Hub oder manuell:
 *   DISCORD_BOT_TOKEN=... node bots/javascript-echo/index.js
 *
 * Ohne Token oder ohne discord.js läuft Demo-Modus mit Log-Ausgaben.
 *
 * Dieser Bot bringt seine eigene Seite über die Hub-API mit – also ohne
 * `bot-hub.json`. Wird er vom Hub gestartet, findet er in der Umgebung
 * BOT_HUB_URL und BOT_HUB_TOKEN und meldet sich damit an.
 */

import { createServer } from 'node:http';
import { botHubApi as api } from './api.js';

const connected = api.connected;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const levels = ['debug', 'info', 'info', 'info', 'warn', 'error'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (level, message) =>
  console.log(`[${level.toUpperCase().padEnd(5)}] ${message}`);

const started = Date.now();
let echoes = 0;
let latency = null;
let guilds = 0;

/** Kurze Meldung als Toast im Dashboard. */
const notify = (message, kind = 'info') =>
  api
    .notify(message, kind)
    .catch((error) => log('warn', `notify fehlgeschlagen: ${error.message}`));

/** Empfangene Einstellungen landen hier. */
let config = {
  greeting: '🏓 Pong!',
  typing: true,
  timeout: 10,
};

/* ------------------------------------------------------------------ *
 * Eigene Seite im Dashboard
 * ------------------------------------------------------------------ */

// `settings` heißt der Feld-Container in der Hub-API – unter `fields`
// würden die Einstellungen stillschweigend verworfen.
const MANIFEST = {
  title: 'Echo-Steuerung',
  icon: '⚡',
  description: 'Laufzeit angemeldet – der Hub fragt diese Werte hier ab.',
  settings: [
    {
      key: 'greeting',
      type: 'text',
      label: 'Begrüßung',
      description: 'Antwort auf !ping.',
      default: '🏓 Pong!',
    },
    {
      key: 'typing',
      type: 'boolean',
      label: 'Beim Antworten tippen',
      default: true,
    },
    {
      key: 'timeout',
      type: 'number',
      label: 'Timeout (Sekunden)',
      description: 'Wie lange der Tipp-Indikator stehen bleibt.',
      default: 10,
      min: 1,
      max: 60,
    },
  ],
  commands: [
    {
      id: 'reload',
      label: 'Einstellungen neu laden',
      description: 'Liest die Einstellungen aus dem Dashboard neu.',
    },
    {
      id: 'status',
      label: 'Status melden',
      description: 'Schickt die aktuellen Live-Werte sofort an das Dashboard.',
    },
  ],
};

/**
 * Kleiner HTTP-Server auf Loopback: der Hub ruft hier die Aktionen der
 * Bot-Seite auf. Ohne ihn gäbe es für die Knöpfe weder Skript noch Adresse.
 */
const startCallbackServer = () =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', async () => {
        let call = {};
        try {
          call = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          /* kaputte Nutzlast – die ID reicht für die Antwort trotzdem */
        }
        const reply = (body) => {
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
          });
          response.end(JSON.stringify(body));
        };

        try {
          if (call.id === 'reload') {
            const fresh = await api.settings();
            config = { ...config, ...(fresh?.settings ?? {}) };
            log('info', `Einstellungen neu geladen: ${JSON.stringify(config)}`);
            await publish();
            return reply({ ok: true, settings: config });
          }
          if (call.id === 'status') {
            const state = await publish();
            return reply({ ok: true, state });
          }
          reply({ ok: false, error: `Unbekannte Aktion "${call.id}"` });
        } catch (error) {
          log('error', `Aktion ${call.id} fehlgeschlagen: ${error.message}`);
          reply({ ok: false, error: error.message });
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });

/** Meldet Seite, Einstellungen und Aktionen beim Hub an. */
const register = async () => {
  await api.registerPanel(MANIFEST);
  const url = await startCallbackServer();
  await api.callback(url);
  const { settings } = await api.settings();
  log('info', `Seite angemeldet – Aktionen laufen über ${url}`);
  log('info', `Einstellungen: ${JSON.stringify(settings ?? {})}`);
  return settings ?? {};
};

/* ------------------------------------------------------------------ *
 * Live-Werte und Einstellungen
 * ------------------------------------------------------------------ */

/** Live-Werte für die eigene Seite im Dashboard. */
const publish = async () => {
  const state = {
    status: token ? 'online' : 'demo',
    ping: latency,
    guilds,
    echoes,
    uptime: `${Math.floor((Date.now() - started) / 1000)} s`,
  };
  if (!connected) return state;
  await api
    .publish(state)
    .catch((error) => log('warn', `state fehlgeschlagen: ${error.message}`));
  return state;
};

/**
 * Hört auf Änderungen aus dem Dashboard. Nach einer Aktion in der Oberfläche
 * schickt der Hub zusätzlich `refresh` – dann sofort neue Werte melden.
 */
const watch = async () => {
  let wait = 2000;
  for (;;) {
    try {
      for await (const { name, data } of api.events()) {
        if (name === 'refresh') {
          publish().catch(() => {});
          continue;
        }
        config = { ...config, ...(data?.settings ?? {}) };
        log('info', `Einstellungen: ${JSON.stringify(config)}`);
      }
      wait = 2000;
    } catch (error) {
      log('warn', `Ereignis-Stream beendet (${error.message})`);
    }
    // Ohne neuen Versuch bliebe der Bot für den Rest der Sitzung taub.
    await sleep(wait);
    wait = Math.min(wait * 2, 30000);
  }
};

/* ------------------------------------------------------------------ *
 * Betrieb
 * ------------------------------------------------------------------ */

const demoMode = async () => {
  log('info', `Demo-Modus aktiv (Guild: ${guildId || 'nicht gesetzt'})`);
  await publish();
  for (;;) {
    const level = levels[Math.floor(Math.random() * levels.length)];
    log(level, `simulated event #${100 + Math.floor(Math.random() * 900)}`);
    latency = Math.floor(Math.random() * 90) + 10;
    await publish();
    await sleep(3000);
  }
};

const COMMANDS = {
  '!ping': () => `${config.greeting} ${latency ?? '–'} ms`,
  '!echo': (message) => `Echo: ${message || 'leer'}`,
  '!hilfe': () => 'Befehle: !ping, !echo <Text>, !hilfe',
};

let contentWarned = false;

const realBot = async () => {
  const { Client, GatewayIntentBits } = await import('discord.js');
  // `Messages` gibt es seit discord.js v14 nicht mehr. Für Nachrichten braucht
  // es GuildMessages; den Inhalt liest man nur mit dem privilegierten
  // MessageContent-Intent, der im Developer-Portal freigeschaltet sein muss.
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // v14 nennt das Ereignis noch `ready`, ab v15 heißt es `clientReady`.
  // Beide Namen registrieren, sonst sieht der Bot in v15 nie eine Nachricht –
  // und mit einer Sperre, weil manche v14-Versionen beide feuern.
  client.once('ready', onReady);
  client.once('clientReady', onReady);

  let ready = false;
  async function onReady() {
    if (ready) return;
    ready = true;
    latency = Math.round(client.ws.ping);
    guilds = client.guilds.cache.size;
    log('info', `eingeloggt als ${client.user.tag}`);
    if (guildId) {
      const guild = client.guilds.cache.get(guildId);
      log('info', `Guild: ${guild ? guild.name : 'nicht gefunden'}`);
    }
    await publish();
    await notify(`${client.user.tag} ist bereit.`, 'success');
  }

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    // Leerer Inhalt heißt fast immer: der privilegierte MessageContent-Intent
    // ist im Developer-Portal nicht freigeschaltet.
    if (!message.content) {
      if (!contentWarned) {
        contentWarned = true;
        log(
          'warn',
          'Nachrichteninhalte sind leer – MessageContent-Intent im ' +
            'Discord-Developer-Portal unter Bot > Privileged Gateway Intents ' +
            'freischalten.',
        );
      }
      return;
    }
    const [raw, ...rest] = message.content.trim().split(/\s+/);
    const answer = COMMANDS[raw.toLowerCase()]?.(rest.join(' '));
    if (answer === undefined) return;

    if (config.typing) {
      await message.channel.sendTyping().catch(() => {});
      setTimeout(
        () => message.channel.sendTyping().catch(() => {}),
        config.timeout * 1000,
      ).unref?.();
    }
    await message.reply(answer);
    echoes += 1;
    latency = Math.round(client.ws.ping);
    log('info', `auf ${raw} geantwortet (${latency} ms)`);
    await publish();
  });

  client.on('error', (error) => log('error', `discord.js: ${error.message}`));
  await client.login(token);
};

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

log('info', `javascript-echo startet (Node ${process.version})`);

if (connected) {
  log('info', 'Bot-Hub erkannt');
  try {
    config = { ...config, ...(await register()) };
  } catch (error) {
    log('warn', `Hub-Anmeldung fehlgeschlagen: ${error.message}`);
  }
  watch();
  setInterval(() => publish().catch(() => {}), 20000).unref?.();
}

if (!token) {
  log('warn', 'WARNUNG: DISCORD_BOT_TOKEN fehlt – Demo-Modus');
  await demoMode();
} else {
  try {
    await realBot();
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      log('warn', 'discord.js fehlt – npm install discord.js – Demo-Modus');
      await demoMode();
    } else {
      log('error', `FEHLER beim Start: ${error.message}`);
      process.exit(1);
    }
  }
}
