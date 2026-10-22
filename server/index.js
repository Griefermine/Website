import { createServer as createServerFactory } from 'node:http';
import {
  containerRuntimeEnabled,
  containerSecurityFacts,
  PRODUCTION_BOT_GATEWAY,
  PRODUCTION_BOT_HUB_PORT,
  validateProductionBotNetwork,
} from './containers.js';
import { createServer, stopAllBots, flushPersist } from './manager.js';
import { collectSecurityFindings, resolveBindHost } from './preflight.js';
import {
  closeDatabase,
  describeDatabase,
  prepareDatabase,
  resolveDatabaseConfig,
  storeOutsideDataDir,
} from './database.js';
import { managedMySqlActive, provisionManagedMySql } from './mysql.js';
import { configureProductionEgress } from './egress.js';

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

// Production Hub requests (Discord OAuth and explicitly allowed callbacks)
// must use the local domain-filtering proxy. This is enabled before any
// outbound request is made and cannot be disabled by an inherited NO_PROXY.
if (process.env.NODE_ENV === 'production') {
  try {
    configureProductionEgress();
  } catch (error) {
    console.error(`[hub] ABBRUCH: Ausgangsproxy: ${error.message}`);
    process.exit(1);
  }
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
// P1-D: Bind-Adresse zentral auflösen. Default ist Loopback; eine öffentliche
// Bindung braucht ein ausdrückliches HOST und wird außerhalb von Tests mit
// Warnung quittiert. In Produktion bricht ein nicht-lokaler HOST ab.
const bind = resolveBindHost(process.env);
const host = bind.host;
for (const warning of bind.warnings) console.warn(`[hub] WARNUNG: ${warning}`);
if (process.env.NODE_ENV === 'production' && bind.errors.length) {
  for (const error of bind.errors) console.error(`[hub] ABBRUCH: ${error}`);
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  try {
    await validateProductionBotNetwork();
  } catch (error) {
    console.error(`[hub] ABBRUCH: Discord-Ausgangsfilter: ${error.message}`);
    process.exit(1);
  }
}

// Der Bot-Speicher wird wie die Container geprüft: eine Konfiguration, die
// nicht zu diesem Rechner passt, bricht den Start ab, statt erst beim ersten
// Datenbankzugriff eines Bots aufzufallen. Geprüft wird die Konfiguration, nicht
// die Erreichbarkeit - ein Hub darf starten, während MySQL noch hochlaeuft.
let databaseConfig = null;
try {
  // Bei `mysql-container` steht vor dem Verbindungsaufbau das Einrichten:
  // Container hochfahren, Datenbank und Arbeitsbenutzer anlegen, den Admin
  // wieder wegschliessen. Erst danach loest `resolveDatabaseConfig` ueberhaupt
  // auf, weil das Passwort erst dabei entsteht.
  if (managedMySqlActive()) {
    const { status, beschreibung, phpmyadmin } = await provisionManagedMySql();
    console.log(
      `[hub] MySQL ${status === 'bereit' ? 'bereit' : 'eingerichtet'}: ${beschreibung}`,
    );
    if (phpmyadmin) {
      console.log(`[hub] phpMyAdmin: ${phpmyadmin}`);
      // Die Oberfläche hört nur auf Loopback, und der Hub setzt davor nichts
      // weiter: kein Rate-Limit, keine zweite Anmeldung. Wer sie von einem
      // anderen Rechner braucht, tunneliert sie – sonst steht sie irgendwann
      // doch im Internet, und dann ist die Schleife offen.
      console.warn(
        '[hub] HINWEIS: phpMyAdmin ist nur über 127.0.0.1 erreichbar. Von einem anderen Rechner aus z. B. mit "ssh -L 8081:127.0.0.1:8081 user@server". Ohne Rate-Limit davor gehört phpMyAdmin nicht ins Internet.',
      );
    }
  }
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
      '         Das ist erlaubt, solange die Datei nicht im Startordner eines Bots\n' +
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

/**
 * Startup-Selbstprüfung – Regeln Leben in `preflight.js`, damit sie ohne den
 * lauschenden Prozess tested werden können. `errors` verhindern den Start.
 */
const securitySelfCheck = () => {
  const { errors, warnings } = collectSecurityFindings({
    facts: containerSecurityFacts(),
  });
  for (const warning of warnings)
    console.warn(`[hub] SICHERHEITS-WARNUNG: ${warning}`);
  if (errors.length === 0) return;
  for (const error of errors)
    console.error(`[hub] SICHERHEITS-FEHLER: ${error}`);
  console.error('[hub] Der Server startet nicht.');
  process.exit(1);
};

securitySelfCheck();

const handler = createServer();
const server = createServerFactory(handler);
const botApiServer =
  process.env.NODE_ENV === 'production' ? createServerFactory(handler) : null;

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
if (botApiServer) {
  botApiServer.on('error', (error) => {
    console.error(`[hub] ABBRUCH: interne Bot-API: ${error.message}`);
    stopAllBots();
    process.exit(1);
  });
  botApiServer.listen(PRODUCTION_BOT_HUB_PORT, PRODUCTION_BOT_GATEWAY, () => {
    console.log(
      `[hub] Interne Bot-API nur im isolierten Docker-Netz: ${PRODUCTION_BOT_GATEWAY}:${PRODUCTION_BOT_HUB_PORT}`,
    );
  });
}

let closing = false;
const shutdown = () => {
  if (closing) process.exit(0);
  closing = true;
  stopAllBots();
  // Ausstehende Persistenz (Delete-Lifecycle, Secret-Migration) vor dem
  // Exit auf die Platte zwingen – sonst verliert der Timer seinen Flush.
  try {
    flushPersist();
  } catch (error) {
    console.error('[hub] Letztes Speichern fehlgeschlagen:', error.message);
  }
  // Eine offene SQLite-Verbindung hält den Prozess sonst fest; MySQL würde
  // beim Beenden ohnehin wegbrechen, deshalb wird beides geschlossen.
  closeDatabase().catch(() => {});
  let remaining = botApiServer ? 2 : 1;
  const closed = () => {
    remaining -= 1;
    if (remaining === 0) process.exit(0);
  };
  server.close(closed);
  botApiServer?.close(closed);
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
