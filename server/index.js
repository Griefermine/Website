import { createServer as createServerFactory } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { containerRuntimeEnabled } from './containers.js';
import { createServer, stopAllBots } from './manager.js';
import {
  closeDatabase,
  describeDatabase,
  prepareDatabase,
  resolveDatabaseConfig,
  storeOutsideDataDir,
} from './database.js';

// BOT_HUB_TEST_MODE schaltet Anmeldung, Rate-Limits und Pfadprüfung ab.
// Das darf in einer veröffentlichten Instanz niemals passieren – sonst
// startet der Hub zwar, ist aber für jeden offen erreichbar.
//
// Die Prüfung läuft bewusst umgekehrt: erlaubt ist nur die ausdrückliche
// Testumgebung (NODE_ENV=test). Ein nicht gesetztes NODE_ENV ist der
// unsicherere Default – "nicht production" darf kein Freifahrtschein sein.
if (process.env.BOT_HUB_TEST_MODE === '1' && process.env.NODE_ENV !== 'test') {
  console.error(
    process.env.NODE_ENV
      ? `[hub] ABBRUCH: BOT_HUB_TEST_MODE=1 hebt Anmeldung und Rate-Limits auf und ist nur mit NODE_ENV=test erlaubt (aktuell: ${process.env.NODE_ENV}).`
      : '[hub] ABBRUCH: BOT_HUB_TEST_MODE=1 hebt Anmeldung und Rate-Limits auf und ist nur mit NODE_ENV=test erlaubt (NODE_ENV ist nicht gesetzt).',
  );
  process.exit(1);
}

// Die Container sind die Isolationsgrenze zwischen fremdem Bot-Code und dem
// Host. Ohne sie laeuft jeder Bot mit den Rechten des Hub-Prozesses direkt auf
// dem Rechner, also bricht der Start in Produktion ab, statt stillschweigend
// ungeschuetzt weiterzulaufen. Fuer Tests und Diagnose bleibt der
// Schalter erlaubt - dann aber mit sichtbarer Warnung.
if (process.env.NODE_ENV === 'production' && !containerRuntimeEnabled()) {
  console.error(
    '[hub] ABBRUCH: BOT_HUB_CONTAINER_MODE=disabled ist in Produktion nicht erlaubt – Bots wuerden ohne Isolation auf dem Host laufen.',
  );
  process.exit(1);
}
if (!containerRuntimeEnabled() && process.env.NODE_ENV !== 'test') {
  console.warn(
    '[hub] WARNUNG: Container sind abgeschaltet. Bots laufen ohne Isolation direkt auf diesem Rechner – nur fuer lokale Entwicklung.',
  );
}

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

// Der Bot-Speicher wird wie die Container geprüft: eine Konfiguration, die
// nicht zu diesem Rechner passt, bricht den Start ab, statt erst beim ersten
// Datenbankzugriff eines Bots aufzufallen. Geprüft wird die Konfiguration, nicht
// die Erreichbarkeit - ein Hub darf starten, während MySQL noch hochlaeuft.
let databaseConfig = null;
try {
  databaseConfig = resolveDatabaseConfig();
  await prepareDatabase(databaseConfig);
} catch (error) {
  console.error(`[hub] ABBRUCH: Bot-Speicher: ${error.message}`);
  process.exit(1);
}
const storeOutside = storeOutsideDataDir(databaseConfig);
if (storeOutside)
  console.warn(
    `[hub] HINWEIS: Der Bot-Speicher liegt in ${storeOutside} und damit ausserhalb von data/.\n` +
      '         Das ist erlaubt, solange die Datei nicht im Arbeitsordner eines Bots\n' +
      '         liegt – sonst könnte dieser sie direkt lesen und die API umgehen.',
  );

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Bind-Adresse und ausgehende URL sind zwei verschiedene Dinge: der Hub
 * nimmt auf `HOST` Verbindungen an, beantwortet den Discord-Login aber mit
 * `BOT_HUB_URL` bzw. `DISCORD_REDIRECT_URI`. Zeigen beide auseinander,
 * landet der Login auf dem Gerät, das ihn gestartet hat, statt auf dem Hub.
 */
const warnAboutUrl = () => {
  const configured = String(
    process.env.DISCORD_REDIRECT_URI || process.env.BOT_HUB_URL || '',
  ).trim();
  if (!configured) return;
  let url;
  try {
    url = new URL(configured);
  } catch {
    console.warn(
      `[hub] WARNUNG: "${configured}" ist keine gültige URL – der Discord-Login wird scheitern.`,
    );
    return;
  }
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol === 'http:' && !loopback)
    console.warn(
      `[hub] WARNUNG: "${url.origin}" ist unverschlüsselt und nicht localhost.\n` +
        '         Discord akzeptiert solche Redirect-URIs nicht, Cookies lassen sich\n' +
        '         nicht als Secure markieren. Bitte TLS davor setzen und die\n' +
        '         https-Adresse in BOT_HUB_URL eintragen.',
    );
  if (loopback && host !== '127.0.0.1' && host !== 'localhost')
    console.warn(
      `[hub] HINWEIS: Anmeldung läuft über ${url.origin}, der Hub lauscht auf ${host}.\n` +
        '         Das ist in Ordnung, solange du den Hub nur auf diesem Rechner\n' +
        '         öffnest. Von einem anderen Gerät aus schickt Discord dich zu\n' +
        '         dir selbst zurück – dann brauchst du eine Adresse, die von dort\n' +
        '         erreichbar ist (BOT_HUB_URL, am besten https).',
    );
};

warnAboutUrl();

/**
 * `BOT_HUB_URL` nennt die Adresse, unter der der Hub erreichbar ist – für
 * Browser und für ausgehende Aufrufe des Hubs selbst. Für einen Prozess im
 * Container ist `127.0.0.1` jedoch der Container selbst. Ohne
 * `BOT_HUB_CONTAINER_URL` bekommt der Container auch keinen Weg zum Host
 * (host.docker.internal erlaubt einem Bot jeden Dienst auf diesem Rechner).
 * Beides zusammen führt zu Verbindungsfehlern im Bot, die dort sehr schwer
 * zu deuten sind – deshalb dieser Hinweis.
 */
if (
  containerRuntimeEnabled() &&
  !String(process.env.BOT_HUB_CONTAINER_URL ?? '').trim()
)
  console.warn(
    '[hub] HINWEIS: BOT_HUB_CONTAINER_URL ist nicht gesetzt. Bot-Prozesse\n' +
      `         erreichen den Hub über ${String(process.env.BOT_HUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')} nicht, weil 127.0.0.1 im Container der Container selbst ist.\n` +
      '         Sie brauchen den Hub nur, wenn sie Zustand oder Meldungen melden.\n' +
      '         Dann BOT_HUB_CONTAINER_URL=http://host.docker.internal:8787 setzen\n' +
      '         (schaltet den Host für die Container frei) oder in BOT_HUB_URL eine\n' +
      '         Adresse eintragen, die auch aus dem Container erreichbar ist.',
  );

// Startup Security Self-Check: kritische Bedingungen prüfen, bevor der Server startet
const securitySelfCheck = () => {
  const errors = [];
  const warnings = [];

  // Testmodus darf nicht in Production aktiviert sein
  if (process.env.BOT_HUB_TEST_MODE === '1' && process.env.NODE_ENV === 'production') {
    errors.push('BOT_HUB_TEST_MODE=1 ist in Production nicht erlaubt');
  }

  // Container müssen in Production aktiviert sein
  if (process.env.NODE_ENV === 'production' && !containerRuntimeEnabled()) {
    errors.push('Container sind in Production deaktiviert');
  }

  // BOT_HUB_URL sollte HTTPS sein in Production
  const hubUrl = String(process.env.BOT_HUB_URL ?? '').trim();
  if (process.env.NODE_ENV === 'production' && hubUrl && !hubUrl.startsWith('https://')) {
    errors.push('BOT_HUB_URL muss in Production HTTPS verwenden');
  }

  // .env-Datei sollte nicht existieren oder keine echten Secrets enthalten
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    try {
      const envContent = readFileSync(envPath, 'utf8');
      const hasRealSecrets = /DISCORD_CLIENT_SECRET\s*=\s*\S+/.test(envContent) ||
                            /BOT_HUB_TOKEN\s*=\s*\S+/.test(envContent);
      if (hasRealSecrets) {
        warnings.push('.env enthält möglicherweise echte Secrets – bitte data/secrets/ verwenden');
      }
    } catch {
      // Datei nicht lesbar – ignorieren
    }
  }

  // data/secrets-Verzeichnis sollte existieren und sichere Rechte haben
  const secretsDir = join(process.cwd(), 'data', 'secrets');
  if (!existsSync(secretsDir)) {
    warnings.push('data/secrets/ existiert nicht – wird bei Bedarf erstellt');
  }

  // DB-Datei sollte nicht in bots/ liegen
  const dbFile = String(process.env.BOT_HUB_DB_FILE ?? '').trim();
  if (dbFile && dbFile.startsWith('bots/')) {
    errors.push('BOT_HUB_DB_FILE darf nicht innerhalb von bots/ liegen');
  }

  // Docker Socket sollte nicht gemountet sein
  if (existsSync('/var/run/docker.sock')) {
    warnings.push('Docker Socket ist vorhanden – sicherstellen, dass er nicht in Containers gemountet wird');
  }

  // Ausgabe
  for (const warning of warnings) {
    console.warn(`[hub] SICHERHEITS-WARNUNG: ${warning}`);
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[hub] SICHERHEITS-FEHLER: ${error}`);
    }
    console.error('[hub] Server startet nicht aufgrund kritischer Sicherheitsprobleme.');
    process.exit(1);
  }
};

securitySelfCheck();

const server = createServerFactory(createServer());

// Ein belegter Port ist ein Bedienfehler, kein Absturz. Ohne diese Auswertung
// steht hier ein halber Seitenfehler-Stack, der mehr irritiert als erklärt –
// gerade weil `node --watch` danach auf die nächste Dateiänderung wartet.
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE')
    console.error(
      `[hub] ABBRUCH: Port ${port} auf ${host} ist belegt – vermutlich läuft bereits ein Bot-Hub.\n` +
        `         Wer ihn beenden will:  ss -lptn "sport = :${port}"\n` +
        '         Anderen Port nehmen:  PORT=<freier Port> npm run dev:hub',
    );
  else if (error.code === 'EACCES')
    console.error(
      `[hub] ABBRUCH: Keine Berechtigung für Port ${port}. Ports unter 1024 brauchen Root.`,
    );
  else console.error('[hub] Der Server konnte nicht starten:', error.message);
  stopAllBots();
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(
    `\n  \x1b[95m◆ Bot-Hub\x1b[0m läuft auf \x1b[96mhttp://${host}:${port}\x1b[0m\n`,
  );
  console.log(
    `  Bot-Speicher: \x1b[95m${describeDatabase(databaseConfig)}\x1b[0m` +
      `${databaseConfig.driver === 'sqlite' ? ` → ${databaseConfig.file}` : ''}\n`,
  );
});

let closing = false;
const shutdown = () => {
  if (closing) process.exit(0);
  closing = true;
  stopAllBots();
  // Eine offene SQLite-Verbindung hält den Prozess sonst fest; MySQL würde
  // beim Beenden ohnehin wegbrechen, deshalb wird beides geschlossen.
  closeDatabase().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
