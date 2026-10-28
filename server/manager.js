import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
  isAbsolute,
  relative,
  sep,
  delimiter,
} from 'node:path';
import { LANGUAGES, fillDeps, getFramework, getLanguage } from './languages.js';
import * as dateien from './botFiles.js';
import {
  cleanupTempEnvFiles,
  dotenvKey,
  readSecretValues,
  removeSecretValues,
  bootstrapSecretVault,
  storeSecretValues,
} from './secrets.js';
import {
  httpError,
  isEvalFlag,
  parseDotenv,
  readBody,
  safeDecode,
  sendJson,
  withBotCredentials,
  MIME,
  MASK,
} from './util.js';
import {
  configurePanel,
  ensurePanel,
  handleHubRoutes,
  handlePanelRoutes,
  hubEnv,
  hydratePanel,
  identify,
  issuePanelBootstrapToken,
  panelPageOrigin,
  panelToken,
  publicPanel,
  revokeBotSessions,
  revokeRuntimeToken,
  syncBotEnv,
} from './panel.js';
import {
  accessState,
  configureAccess,
  configureSessionStore,
  currentUser,
  handleAuthRoutes,
  hasPermission,
  purgeBotAccess,
  removeAccess,
  requiresAuthentication,
  secureCookies,
  updateAccess,
} from './auth.js';
import {
  containerRuntimeEnabled,
  containerRuntimeName,
  cleanupExecEnvFile,
  dependencyRunArgs,
  ensureContainer,
  ensureDotnetCliHome,
  execArgs,
  stopContainer,
  removeContainer,
} from './containers.js';
import { database } from './database.js';
import { ensurePanelScaffold, migrateScaffold } from './panelScaffold.js';

const PROJECT_ROOT = resolve(process.env.BOT_DASHBOARD_ROOT || process.cwd());
const DATA_FILE = join(PROJECT_ROOT, 'data', 'bots.json');
const ACCESS_FILE = join(PROJECT_ROOT, 'data', 'access.json');
const SESSIONS_FILE = join(PROJECT_ROOT, 'data', 'sessions.json');
const MAX_LOG_LINES = 800;
// Untergrenze für Bot-Slots. In Tests wird sie über BOT_HUB_MAX_BOTS gesenkt,
// um Parallelität gegen die Obergrenze zu prüfen, ohne 24 Bots anlegen zu
// müssen. Der Default bleibt 24; ein Wert unter 1 wäre unsinnig und wird
// darum auf 1 begrenzt.
const MAX_BOTS = Math.max(
  1,
  Number(process.env.BOT_HUB_MAX_BOTS) > 0
    ? Number(process.env.BOT_HUB_MAX_BOTS)
    : 24,
);

/**
 * Obergrenze für den JSON-Body einer Datei-Route. Rechnet man die Quotation
 * mit, muss das Limit über der Datei liegen, sonst wäre eine Datei an der
 * Grenze von der Grenze zu retten.
 */
const MAX_FILE_BODY_BYTES = dateien.MAX_FILE_BYTES * 2;
const INSTALL_TIMEOUT = 15 * 60 * 1000;
// Upload-Limits (V19 #5/#14): pro Bot+Session/IP/Route begrenzt.
const MAX_UPLOADS_PER_MINUTE = 60;
const MAX_UPLOAD_BYTES_PER_MINUTE = 8 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_ACTIVE_UPLOADS = 256;
const MAX_RATE_BUCKETS = 10_000;
const MAX_PENDING_OUTPUT = 8 * 1024;
const uploadBytes = new Map();
const concurrentUploads = new Map();
let activeUploadCount = 0;
const rateBuckets = new Map();
const trustedProxyAddresses = () =>
  new Set(
    String(process.env.BOT_HUB_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
const clientAddress = (req) => {
  const remote = String(req.socket.remoteAddress ?? '').toLowerCase();
  if (!trustedProxyAddresses().has(remote)) return remote;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  // Walk from the directly connected proxy toward the client. Ignore only
  // explicitly trusted proxy hops; never accept a client-supplied leftmost
  // address when an untrusted hop appears before it.
  let candidate = remote;
  const trusted = trustedProxyAddresses();
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    candidate = forwarded[index];
    if (!trusted.has(candidate)) return candidate;
  }
  return candidate;
};
/**
 * P1-G: Eine einzige kanonische Pfad-Auflösung für Rate-Limits, Routing und
 * Audit. Der Router zerlegt `split('/').filter(Boolean)` und ignoriert damit
 * leerer Segmente und Abschluss-Slashes; tat der Rate-Limiter das nicht,
 * wären `/api/bots`, `/api/bots/` und `/api//bots` drei verschiedene Buckets
 * – und jedes davon ein Weg, das Limit zu umgehen.
 *
 * Prozent-Kodierung wird hier bewusst NICHT dekodiert: `new URL()` hat bereits
 * genau einmal normalisiert, und mehrfaches Dekodieren (`%252f` → `%2f` →
 * `/`) wäre genau die Mehrdeutigkeit, die wir ausschließen wollen. Gefährliche
 * Rohformen (`..`, kodierte Slashes) prüfen die Routen selbst gegen ihre
 * jeweils dekodierten Parameter.
 */
const canonicalPathname = (pathname) => {
  const collapsed = String(pathname ?? '').replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/'))
    return collapsed.slice(0, -1);
  return collapsed;
};

/**
 * Schlüssel-Pfad für den Rate-Limit-Bucket: kanonisch UND pro Segment genau
 * einmal prozent-dekodiert – exakt so, wie der Router segmentweise dekodiert.
 * Würde der Limiter `%62ots` als eigenen Pfad sehen, während der Router darin
 * `bots` erkennt, wäre die Prozentkodierung ein zweiter, limitfreier Bucket –
 * genau die Umgehung, die P1-G verbietet. Doppelte Kodierung (`%2562f`) wird
 * bewusst NICHT ein zweites Mal gelöst: sie bleibt ein anderer, dann
 * unauflösbarer Pfad (404), nie ein Routing-Trick.
 */
const rateLimitPath = (url) => {
  const parts = canonicalPathname(url.pathname).split('/');
  return parts
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part; // ungültige Kodierung: roh behalten, Router scheitert daran
      }
    })
    .join('/');
};

/**
 * V25b (DoS-Vektor): Bei vollen Buckets durfte nicht pauschal 429 gegeben
 * werden – ein Angreifer konnte mit tausenden frischen Keys/Identitäten
 * legitime Inhaber aus ihren Buckets verdrängen, ohne selbst je ein Limit zu
 * sehen. Stattdessen wird bei Kapazitätsüberschreitung zuerst bereinigt:
 * abgelaufene Buckets sind ohnehin frei, und reicht das nicht, weicht der am
 * längsten unangetastete Bucket (lastTouched) – der steht als Nächstes ohnehin
 * zum Ablauf an und kostet seinen Inhaber am wenigsten. Bestehende Zähler
 * werden beim Sweeping nie resettet; nur echte Verdrängung oder Ablauf macht
 * einen Bucket frei. Das pauschale 429 bleibt als letzte Notbremse, wenn der
 * Speicherdruck nach der Bereinigung immer noch akut ist.
 */
const takeRateBucket = (key, limit, now) => {
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    if (!bucket && rateBuckets.size >= MAX_RATE_BUCKETS) {
      // Erste Stufe: abgelaufene Buckets aussortieren (identisch zur
      // Bedeutung des regulären rateCleanup – hier nur früher).
      for (const [altSchluessel, altBucket] of rateBuckets) {
        if (altBucket.expiresAt <= now) rateBuckets.delete(altSchluessel);
      }
      // Zweite Stufe: den am längsten unangetasteten Bucket verdrängen.
      if (rateBuckets.size >= MAX_RATE_BUCKETS) {
        let aeltesterSchluessel = null;
        let aeltesteBeruehrung = Infinity;
        for (const [altSchluessel, altBucket] of rateBuckets) {
          if (altBucket.lastTouched < aeltesteBeruehrung) {
            aeltesteBeruehrung = altBucket.lastTouched;
            aeltesterSchluessel = altSchluessel;
          }
        }
        if (aeltesterSchluessel !== null)
          rateBuckets.delete(aeltesterSchluessel);
      }
      // Notbremse: Speicherdruck ist nach Bereinigung immer noch akut
      // (praktisch nur, wenn gar nichts verdrängbar ist).
      if (rateBuckets.size >= MAX_RATE_BUCKETS)
        return httpError(429, 'Zu viele Anfragen');
    }
    bucket = { count: 0, expiresAt: now + 60_000, lastTouched: now };
    rateBuckets.set(key, bucket);
  } else {
    bucket.lastTouched = now;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    const error = httpError(429, 'Zu viele Anfragen');
    error.retryAfter = Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000));
    return error;
  }
  return null;
};
const rateLimit = (req, url) => {
  if (process.env.BOT_HUB_TEST_MODE === '1') return null;
  // P1-G: dieselbe kanonische Form wie fürs Routing – inklusive einfacher
  // Prozent-Dekodierung, damit kodierte Varianten denselben Bucket treffen.
  const path = rateLimitPath(url);
  let limit = 0;
  let rateClass = '';
  if (/^\/api\/auth\/discord\/(?:login|callback)$/.test(path)) {
    limit = 30;
    rateClass = 'auth';
  } else if (/\/panel\/discord\/(?:login|callback)(?:\/|$)/.test(path)) {
    limit = 10;
    rateClass = 'panel-oauth';
  } else if (
    /\/panel\/commands(?:\/|$)/.test(path) ||
    /\/(?:start|restart|install)(?:\/|$)/.test(path)
  ) {
    limit = 60;
    rateClass = 'actions';
  } else if (/^\/api\/hub(?:\/|$)/.test(path)) {
    limit = 120;
    rateClass = 'hub';
  } else if (/\/files(?:\/|$)/.test(path)) {
    limit = MAX_UPLOADS_PER_MINUTE;
    rateClass = 'files';
  } else if (
    /^\/api\/logs(?:\/|$)/.test(path) ||
    /^\/api\/bots\/[^/]+\/logs(?:\/|$)/.test(path)
  ) {
    // V25b: Beide Log-Pfade (global und pro Bot) waren bisher undrosselt.
    // Die Antworten können bis zu 500 Zeilen Log enthalten – ohne Klasse
    // war das ein billiger Weg, den Hub mit teuren Reads zuzuschütten.
    limit = 300;
    rateClass = 'logs';
  }
  const now = Date.now();
  const ip = clientAddress(req);
  const userId = currentUser(req)?.id;
  const identity = userId ? `user:${userId}` : `ip:${ip}`;
  if (limit) {
    const baseLimit = takeRateBucket(`${ip}:${rateClass}:ip`, limit, now);
    if (baseLimit) return baseLimit;
    const userLimit = userId
      ? takeRateBucket(`${identity}:${rateClass}`, limit, now)
      : null;
    if (userLimit) return userLimit;
  }

  let mutationLimit = 0;
  let mutationClass = '';
  if (req.method === 'POST' && path === '/api/bots') {
    mutationLimit = 10;
    mutationClass = 'bot-create';
  } else if (/^\/api\/bots\/[^/]+$/.test(path)) {
    if (req.method === 'DELETE') {
      mutationLimit = 20;
      mutationClass = 'bot-delete';
    } else if (req.method === 'PATCH') {
      mutationLimit = 60;
      mutationClass = 'bot-update';
    }
  } else if (/^\/api\/access(?:\/|$)/.test(path) && req.method !== 'GET') {
    mutationLimit = 30;
    mutationClass = 'access-change';
  }
  if (mutationLimit) {
    const key = `${identity}:${mutationClass}`;
    const byIdentity = takeRateBucket(key, mutationLimit, now);
    if (byIdentity) return byIdentity;
    return takeRateBucket(`${ip}:${mutationClass}:ip`, mutationLimit, now);
  }
  return null;
};
const rateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.expiresAt <= now) rateBuckets.delete(key);
  }
  for (const [key, bucket] of uploadBytes) {
    if (bucket.expiresAt <= now) uploadBytes.delete(key);
  }
}, 60_000);
rateCleanup.unref();

const uploadKeyOf = (req, url) => {
  const remote = String(req.socket.remoteAddress ?? '');
  const cookie = String(req.headers.cookie ?? '');
  const session =
    cookie
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith('bot_hub_session=')) ?? remote;
  const botId = url.pathname.split('/')[3] ?? '';
  return `${session}:${botId}:${remote}`;
};

const takeUploadSlot = (req, url) => {
  if (process.env.BOT_HUB_TEST_MODE === '1') return null;
  const key = uploadKeyOf(req, url);
  const now = Date.now();
  const cur = concurrentUploads.get(key) ?? 0;
  if (
    cur >= MAX_CONCURRENT_UPLOADS ||
    activeUploadCount >= MAX_ACTIVE_UPLOADS
  ) {
    const error = httpError(
      429,
      'Zu viele parallele Uploads – bitte kurz warten.',
    );
    error.retryAfter = 5;
    return error;
  }
  concurrentUploads.set(key, cur + 1);
  activeUploadCount += 1;
  return key;
};

const releaseUploadSlot = (key) => {
  if (!key || !concurrentUploads.has(key)) return;
  const cur = concurrentUploads.get(key);
  activeUploadCount = Math.max(0, activeUploadCount - 1);
  if (cur <= 1) concurrentUploads.delete(key);
  else concurrentUploads.set(key, cur - 1);
};

const clearBotUploadState = (botId) => {
  const marker = `:${botId}:`;
  for (const [key, count] of concurrentUploads) {
    if (key.includes(marker)) {
      activeUploadCount = Math.max(0, activeUploadCount - count);
      concurrentUploads.delete(key);
    }
  }
  for (const key of uploadBytes.keys())
    if (key.includes(marker)) uploadBytes.delete(key);
};

const takeUploadBytes = (req, url, incomingBytes) => {
  if (process.env.BOT_HUB_TEST_MODE === '1') return null;
  const key = uploadKeyOf(req, url);
  const now = Date.now();
  const bucket = uploadBytes.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    if (!bucket && uploadBytes.size >= MAX_RATE_BUCKETS)
      return httpError(429, 'Zu viele Upload-Anfragen');
    uploadBytes.set(key, { bytes: incomingBytes, expiresAt: now + 60_000 });
    return null;
  }
  bucket.bytes += incomingBytes;
  if (bucket.bytes > MAX_UPLOAD_BYTES_PER_MINUTE) {
    const error = httpError(429, 'Upload-Volumen pro Minute überschritten.');
    error.retryAfter = Math.ceil((bucket.expiresAt - now) / 1000);
    return error;
  }
  return null;
};

const bots = new Map();
const listeners = new Set();
const dirty = new Set();
/**
 * P1-H: Reservierte, aber noch nicht abgeschlossene Bot-Erstellungen. Die
 * wirksame Zahl ist `bots.size + pendingBotCreations`; die Reservierung wird
 * nach Body-Lesen/Validierung unmittelbar vor dem ersten Ressourcen-Schritt
 * gesetzt und im `finally` wieder freigegeben. Ohne sie sähen mehrere
 * parallele POST-Requests dieselbe freie Kapazität und überschritten MAX_BOTS.
 * Ein Bot im Löschvorgang bleibt bis zum Abschluss im `bots`-Map – die Zahl
 * bleibt dadurch in beide Richtungen konservativ.
 */
let pendingBotCreations = 0;

/**
 * Bots im Löschvorgang: Während DELETE läuft, werden Start, Restart,
 * Installation, Konfigurations- und Datei-/Panel-Schreibzugriffe mit 409
 * abgewiesen, damit kein paralleler Request den Bot reaktiviert. Lesezugriffe
 * bleiben erlaubt.
 */
const deletingBots = new Set();
/**
 * P1-J: Vorbereitete Löschung. DELETE markiert den Bot hier, BEVOR es auf
 * den Lifecycle-Lock wartet: eine laufende Installation hält den Lock noch,
 * darf aber keinen weiteren Installationsschritt mehr beginnen und keine neue
 * Installation darf anlaufen. `deletingBots` bleibt der eigentliche In-Flight
 * Marker (davon prüft `assertNoDeleteInFlight` den Retry-Fall ab).
 */
const deletePending = new Set();
/**
 * Sperrprüfung für den Delete-Lifecycle: In-Flight-Löschungen (Speicher) und
 * persistente Zustände (`deleting`/`cleanup_failed`, über Neustarts hinweg)
 * blockieren Start, Restart, Installation sowie Konfigurations-, Datei- und
 * Panel-Schreibzugriffe mit 409. Lesezugriffe und ein erneuter DELETE bleiben
 * erlaubt, damit der Cleanup wiederholbar ist.
 */
const isDeleteLocked = (bot) =>
  Boolean(
    bot &&
    (deletingBots.has(bot.id) ||
      deletePending.has(bot.id) ||
      bot.deleteState === 'deleting' ||
      bot.deleteState === 'cleanup_failed'),
  );
const lifecycleConflict = () =>
  Object.assign(
    httpError(409, 'Bot wird gerade gelöscht oder Cleanup steht aus'),
    { code: 'BOT_LIFECYCLE_CONFLICT' },
  );
const assertNotDeleting = (bot) => {
  if (isDeleteLocked(bot)) throw lifecycleConflict();
};
/**
 * Lock nur für In-Flight-Löschungen: Ein erneuter DELETE auf einem Bot in
 * `cleanup_failed` muss den Cleanup wiederholen dürfen (Retry), nur eine
 * gerade laufende Löschung desselben Bots wird mit 409 abgewiesen.
 */
const assertNoDeleteInFlight = (bot) => {
  if (bot && deletingBots.has(bot.id)) throw lifecycleConflict();
};

// Serialisiert die kurzen synchronen Mutationsschritte pro Bot. Request-Bodies
// werden vor dem Aufruf gelesen; so kann ein langsamer Upload DELETE nicht
// hinter einer gehaltenen Sperre festhalten. Die Mutation prüft den aktuellen
// Lifecycle-Zustand erneut, nachdem sie die Sperre erhalten hat.
const lifecycleQueues = new Map();
const withBotLifecycleLock = async (botId, operation) => {
  const previous = lifecycleQueues.get(botId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  lifecycleQueues.set(botId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (lifecycleQueues.get(botId) === current) lifecycleQueues.delete(botId);
  }
};

let persistTimer = null;
// `persistForced` markiert eine Persistenz, die NICHT von der `dirty`-Menge
// abhängt: nach der Secret-Migration müssen alle Bots neu geschrieben werden,
// auch wenn kein einzelner Datensatz als geändert gilt. Ohne dieses Flag
// kehrte flush() wegen einer leeren dirty-Menge ohne Schreiben zurück – und
// die migrierten Geheimnisse blieben für immer im Klartext in bots.json.
let persistForced = false;
const schedulePersist = (force = false) => {
  if (force) persistForced = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flush();
  }, 250);
};

const flush = (strict = false) => {
  if (!dirty.size && !persistForced) return;
  // Atomar: tmp schreiben + fsync + rename. Ein Absturz hinterlässt nie eine
  // halb geschriebene bots.json, sondern höchstens eine tmp-Leiche. Der
  // Temp-Name ist zufällig: `<bots.json>.<pid>.tmp` wäre erratbar und damit
  // ein Ziel für Symlink-Angriffe lokaler Nutzer; `wx` öffnet garantiert neu.
  const tmp = join(
    dirname(DATA_FILE),
    `.bots.json.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, `${JSON.stringify(toFile(), null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, DATA_FILE);
    dirty.clear();
    persistForced = false;
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp-Leiche ist harmlos, der Fehler zählt */
    }
    // Der Timer darf nie abstürzen; ein irreversibler Delete muss einen
    // Persistenzfehler dagegen als Teilfehler melden statt ihn zu schlucken.
    console.error('[hub] Speichern fehlgeschlagen:', error.message);
    if (strict) throw error;
  }
};

/* ------------------------------------------------------------------ *
 * Geheimnisse: nur in data/secrets/<bot-id>.env (0600), nie in bots.json
 * ------------------------------------------------------------------ */

const readSecretFile = (id) => readSecretValues(PROJECT_ROOT, id);

/**
 * Liest die Geheimnisse eines Bots und holt Altbestände aus bots.json in die
 * Datei mit 0600 Rechten. Die Secret-Datei ist die kanonische Quelle: ein
 * Wert aus der Datei gewinnt immer gegen ein Legacy-Feld aus bots.json.
 * Sonst würde ein alter Stand eine längst vollzogene Rotation zurücksetzen
 * (befund P0-A). Legacy-Werte dienen nur als Erstbefüllung.
 *
 * Rückgabe `migrated: false` bedeutet: Die Legacy-Werte sind noch NICHT
 * sicher in der Secret-Datei. `bots.json` behält sie dann weiter – sonst
 * gingen sie beim nächsten Umschreiben der Übersicht verloren.
 */
const migrateSecrets = (config) => {
  const legacyEnv = { ...(config.secretEnv ?? {}) };
  const legacyPanel = { ...(config.panel?.secretSettings ?? {}) };
  const envKeys = new Set([
    ...Object.keys(legacyEnv),
    ...(Array.isArray(config.secretKeys) ? config.secretKeys : []),
  ]);
  const panelKeys = new Set([
    ...Object.keys(legacyPanel),
    ...(Array.isArray(config.panel?.secretKeys) ? config.panel.secretKeys : []),
  ]);
  if (!envKeys.size && !panelKeys.size)
    return { secretEnv: {}, secretSettings: {}, migrated: true };

  const stored = readSecretFile(config.id);
  const secretEnv = {};
  const secretSettings = {};
  const carryOver = {};
  // Gleiche Normalisierung wie beim Schreiben der .env – sonst findet der
  // Hub ein geheimes Panel-Feld nach dem ersten Speichern nicht wieder.
  for (const key of envKeys) {
    const fileKey = dotenvKey(key);
    const value = stored[fileKey] ?? legacyEnv[key];
    if (value === undefined) continue;
    secretEnv[key] = String(value);
    carryOver[fileKey] = String(value);
  }
  for (const key of panelKeys) {
    const fileKey = dotenvKey(key);
    const value = stored[fileKey] ?? legacyPanel[key];
    if (value === undefined) continue;
    secretSettings[key] = String(value);
    carryOver[fileKey] = String(value);
  }
  // Nur Legacy-Werte, die in der kanonischen Datei (noch) fehlen, müssen
  // überhaupt geschrieben werden. Ein Bot ohne Altbestand verlangt keinen
  // Schreibvorgang – und darf auch nicht an einem scheitern, der gar
  // nicht nötig wäre.
  const needsStore =
    Object.entries(legacyEnv).some(
      ([key, value]) =>
        value !== undefined && stored[dotenvKey(key)] !== String(value),
    ) ||
    Object.entries(legacyPanel).some(
      ([key, value]) =>
        value !== undefined && stored[dotenvKey(key)] !== String(value),
    );
  if (!needsStore) return { secretEnv, secretSettings, migrated: true };
  try {
    storeSecretValues(PROJECT_ROOT, config.id, carryOver);
    return { secretEnv, secretSettings, migrated: true };
  } catch (error) {
    // Ohne sichere Ablage bleiben die Werte im Speicher UND werden durch
    // `pendingLegacySecrets` in bots.json konserviert – sonst wäre der
    // letzte bekannte Stand beim nächsten Umschreiben verloren. Es wird
    // kein Erfolg geloggt und kein Wert ausgegeben.
    console.error(
      `[hub] Geheimnisse für ${config.name} konnten nicht in data/secrets gesichert werden:`,
      error.message,
    );
    return {
      secretEnv: { ...secretEnv, ...legacyEnv },
      secretSettings: { ...secretSettings, ...legacyPanel },
      migrated: false,
      pendingLegacySecrets: {
        secretEnv: legacyEnv,
        secretSettings: legacyPanel,
      },
    };
  }
};

/**
 * `bots.json` ist die Übersicht der Bots, nicht der Geheimnisspeicher. Werte
 * gehen nicht hinein, nur die Namen der Schlüssel - die liegen in
 * `data/secrets/<id>.env` (Verzeichnis 0700, Datei 0600).
 *
 * Einzige Ausnahme: ein Bot mit `pendingLegacySecrets` – dessen Migration ist
 * beim Lesen fehlgeschlagen. Die Legacy-Werte wandern zurück in die Datei,
 * damit sie nicht verloren gehen, und werden beim nächsten Start erneut
 * migriert.
 */
const toFile = () =>
  [...bots.values()].map(
    ({
      child,
      busy,
      logs,
      restartTimer,
      pendingLegacySecrets,
      runtimeToken, // Internal: nur Wert-Redaktion, nie die Datei
      ...rest
    }) => {
      const secured = !pendingLegacySecrets;
      const secretKeys = Object.keys(rest.secretEnv ?? {});
      // Live-Zustand der Bot-Seite gehört nicht in die Datei.
      const { state, secretSettings, ...panel } = rest.panel ?? {};
      return {
        ...rest,
        secretEnv: secured ? {} : { ...(pendingLegacySecrets.secretEnv ?? {}) },
        secretKeys,
        panel: rest.panel
          ? {
              ...panel,
              secretSettings: secured
                ? {}
                : { ...(pendingLegacySecrets.secretSettings ?? {}) },
              secretKeys: Object.keys(secretSettings ?? {}),
            }
          : rest.panel,
      };
    },
  );

/* ------------------------------------------------------------------ *
 * Pfad-Sicherheit: Bots dürfen nur innerhalb des Projektordners
 * gestartet werden, damit der Server keine fremden Befehle ausführt.
 * ------------------------------------------------------------------ */
const safeProjectPath = (
  input,
  fallback = '.',
  { nurProjekt = false } = {},
) => {
  const candidate = isAbsolute(input)
    ? input
    : join(PROJECT_ROOT, input || fallback);
  const full = resolve(candidate);
  const rel = relative(PROJECT_ROOT, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    const root = realpathSync(PROJECT_ROOT);
    const trusted = realpathSync(full);
    const trustedRel = relative(root, trusted);
    if (trustedRel.startsWith('..') || isAbsolute(trustedRel)) return null;
    // Im Betrieb gehört der Startordner eines Bots in sein eigenes Verzeichnis
    // unter `bots/`. Das ist die Schranke, die einen Bot davon abhält, im
    // Ordner eines anderen oder in `data/` zu starten. Im Testmodus entfällt
    // sie: die Testbots laufen aus einem fremden Verzeichnis, und eine
    // Schranke, die nur zufällig nicht greift, wäre schlimmer als keine.
    const workspaceBase = join(root, 'bots');
    if (!nurProjekt && existsSync(workspaceBase)) {
      const workspaceRoot = realpathSync(workspaceBase);
      const workspaceRel = relative(workspaceRoot, trusted);
      if (
        workspaceRel.startsWith('..') ||
        isAbsolute(workspaceRel) ||
        !workspaceRel
      )
        return null;
    }
    return trusted;
  } catch {
    return null;
  }
};

const legacyWorkspace = (input) => {
  if (!input || isAbsolute(String(input))) return null;
  const candidate = resolve(PROJECT_ROOT, String(input));
  const botsRoot = resolve(PROJECT_ROOT, 'bots');
  const relativeToBots = relative(botsRoot, candidate);
  if (
    !relativeToBots ||
    relativeToBots.startsWith('..') ||
    isAbsolute(relativeToBots)
  )
    return null;
  const [botDirectory] = relativeToBots.split(sep);
  if (!botDirectory || botDirectory === '.') return null;
  const workspace = resolve(botsRoot, botDirectory);
  try {
    const trustedBotsRoot = realpathSync(botsRoot);
    const trustedWorkspace = realpathSync(workspace);
    const trustedRelative = relative(trustedBotsRoot, trustedWorkspace);
    if (
      !trustedRelative ||
      trustedRelative.startsWith('..') ||
      isAbsolute(trustedRelative) ||
      trustedRelative.split(sep).length !== 1
    )
      return null;
    return { workspace: trustedWorkspace, candidate };
  } catch {
    return null;
  }
};

const sensitiveWorkspaceEntry = (source) =>
  /^(?:\.env(?:\..*)?|\.git|\.npmrc|\.pypirc|id_(?:rsa|ed25519)|authorized_keys|known_hosts|.*(?:secret|credential|password|token).*)$/i.test(
    source,
  );

const migrateWorkspace = (id, source, target) => {
  try {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    cpSync(source, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      dereference: false,
      filter: (entry) => !sensitiveWorkspaceEntry(entry.split(sep).pop() || ''),
    });
    const envFile = join(source, '.env');
    // Die .env des Bots wandert mit in den geschützten Bereich, damit sie
    // weder im Workspace liegen bleibt noch beim nächsten Speichern verloren
    // geht. Vorhandene Geheimnisse werden dabei nicht überschrieben.
    if (existsSync(envFile))
      storeSecretValues(
        PROJECT_ROOT,
        id,
        parseDotenv(readFileSync(envFile, 'utf8')),
      );
  } catch (error) {
    console.error(
      `[hub] Workspace-Migration für ${id} fehlgeschlagen:`,
      error.message,
    );
  }
};

const safeBotPath = (bot, input = '.') => {
  if (process.env.BOT_HUB_TEST_MODE === '1')
    return safeProjectPath(input, '.', { nurProjekt: true });
  const workspaceInput = bot.workspaceRoot || `bots/${bot.id}/workspace`;
  if (isAbsolute(workspaceInput)) return null;
  const workspace = resolve(PROJECT_ROOT, workspaceInput);
  const relativeInput = String(input || '.');
  if (isAbsolute(relativeInput) || relativeInput === '~') return null;
  const candidate = resolve(workspace, relativeInput);
  const lexical = relative(workspace, candidate);
  if (lexical.startsWith('..') || isAbsolute(lexical)) return null;
  try {
    const trustedBotsRoot = realpathSync(resolve(PROJECT_ROOT, 'bots'));
    const trustedWorkspace = realpathSync(workspace);
    const workspaceRelative = relative(trustedBotsRoot, trustedWorkspace);
    if (
      !workspaceRelative ||
      workspaceRelative.startsWith('..') ||
      isAbsolute(workspaceRelative)
    )
      return null;
    const trustedCandidate = realpathSync(candidate);
    const trustedRelative = relative(trustedWorkspace, trustedCandidate);
    if (trustedRelative.startsWith('..') || isAbsolute(trustedRelative))
      return null;
    return trustedCandidate;
  } catch {
    return null;
  }
};

const workspaceConfig = (config) => {
  const dedicatedRoot = `bots/${config.id}/workspace`;
  if (config.workspaceRoot === dedicatedRoot) {
    return {
      workspaceRoot: dedicatedRoot,
      cwd: String(config.cwd || '.'),
    };
  }
  const configuredRoot = config.workspaceRoot || config.cwd;
  const migrated = legacyWorkspace(configuredRoot);
  if (migrated) {
    const sourceRoot = migrated.workspace;
    const targetRoot = resolve(PROJECT_ROOT, dedicatedRoot);
    migrateWorkspace(config.id, sourceRoot, targetRoot);
    return {
      workspaceRoot: dedicatedRoot,
      cwd: relative(sourceRoot, migrated.candidate) || '.',
    };
  }
  return {
    workspaceRoot: dedicatedRoot,
    cwd: String(config.cwd || '.'),
  };
};

const SECRET_KEYS = /^(.*(token|secret|password|passwort|key|dsn|webhook).*)$/i;

/**
 * Geheimnisse werden vollständig maskiert. Ein Teil des Wertes (etwa die
 * ersten vier Zeichen eines Discord-Tokens) verrät Struktur und Länge und
 * verringert die Entropie – als Anzeige reicht die Maske, die der Browser
 * bereits als "unverändert lassen" interpretiert.
 */
const maskEnv = (env) => {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SECRET_KEYS.test(key) ? MASK : value;
  }
  return out;
};

const secretValues = (config, incoming) => {
  const stored = config.secretEnv ?? {};
  const next = { ...stored };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === undefined || value === null) continue;
    if (value === '' || value === MASK) {
      continue;
    }
    next[key] = String(value);
  }
  return next;
};

const findJar = (dir) => {
  const candidates = [
    'build/libs',
    'build/install',
    'target',
    'out/production/libs',
    'dist',
  ];
  for (const candidate of candidates) {
    const abs = join(dir, candidate);
    if (!existsSync(abs)) continue;
    let files = [];
    try {
      files = readdirSync(abs);
    } catch {
      continue;
    }
    const jars = files.filter((f) => f.endsWith('.jar'));
    const preferred = jars.filter((f) => !/sources|javadoc/i.test(f));
    const winner = preferred[0] ?? jars[0];
    if (winner) return join(candidate, winner);
  }
  return null;
};

const fillPlaceholders = (command, config, dir) => {
  let value = String(command || '').trim();
  const language = getLanguage(config.language);
  value = value.replace(
    /\{entrypoint\}/gi,
    () => config.entrypoint || language.entrypoint,
  );
  if (/\{(jar|main-?class|class)\}/i.test(value)) {
    const jar = findJar(dir);
    if (jar) value = value.replace(/\{(jar|main-?class|class)\}/gi, jar);
  }
  return value;
};

const LEVEL_HINTS = [
  [
    'error',
    /error|exception|traceback|fatal|critical|panic|failed|fehler|abgestürzt/i,
  ],
  ['warn', /warn|warning|deprecated|achtung/i],
  ['debug', /\bdebug\b|\btrace\b/i],
  [
    'info',
    /\binfo\b|ready|logged in|login|connected|online|gestartet|eingeloggt/i,
  ],
];

const detectLogLevel = (line) => {
  for (const [level, pattern] of LEVEL_HINTS) {
    if (pattern.test(line)) return level;
  }
  return 'log';
};

const pushLine = (botId, stream, line) => {
  const bot = bots.get(botId);
  if (!bot) return;
  const text = line.replace(/\s+$/, '');
  if (!text.trim()) return;
  const chunk = {
    id: randomUUID(),
    botId,
    ts: Date.now(),
    stream,
    level: detectLogLevel(text),
    // Zentral maskiert: REST und SSE nutzen dieselbe Quelle, damit der
    // Live-Stream keine Geheimnisse zeigt, die der REST-Pfad maskiert.
    // V25b: hinter der Muster-Redaktion zusätzlich die konkreten Werte –
    // druckt ein Bot sein Secret roh (ohne KEY=/Bearer-Kontext), greift
    // kein Muster, aber die bekannte Secret-Liste des Bots.
    text: redactKnownSecretValues(redactLogSecrets(text), bot).slice(0, 2000),
  };
  bot.logs.push(chunk);
  if (bot.logs.length > MAX_LOG_LINES)
    bot.logs.splice(0, bot.logs.length - MAX_LOG_LINES);
  broadcast('log', chunk);
};

const redactLogSecrets = (value) => {
  let text = String(value ?? '');
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]');
  text = text.replace(
    /\b((?:DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET|BOT_HUB_TOKEN|PANEL_TOKEN|RUNTIME_TOKEN|CALLBACK_TOKEN|(?:access|refresh|session|oauth|pkce)[_-]?(?:token|secret|code|verifier)|token|secret|password|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1[REDACTED]',
  );
  return text;
};

// Unterhalb dieser Länge lohnt die Wert-Redaktion nicht: ein Zwei-Zeichen-
// „Secret“ würde sonst jede normale Zeile zerhacken.
const MIN_SECRET_VALUE_LENGTH = 8;

/**
 * V25b (Redaction-Lücke): `redactLogSecrets` ist nur muster-basiert. Druckt
 * ein Bot seinen Token roh – ohne Schlüssel-Kontext wie KEY= oder Bearer –,
 * landete der Klartextwert in bot.logs und damit in REST und SSE. Darum
 * werden zusätzlich die konkreten Werte ersetzt, die der Bot als Secrets
 * kennt: die Secret-Umgebung (`secretEnv`), die geheimen Panel-Felder
 * (`panel.secretSettings`) und das bei jedem Spawn neu zugeteilte
 * Runtime-Token (`runtimeToken`, von hubEnv am Bot abgelegt – pro Bot gilt
 * genau eines, Zuteilung ersetzt den Vorgänger, daher Skalar statt Liste).
 * pushLine ist heiß – pro Aufruf läuft einmal die kleine Wertliste durch,
 * kein Regex pro Secret. Leere, Nicht-Text- und Kurzwerte (< 8 Zeichen)
 * werden ignoriert, damit kein Ein-Zeichen-Wert jede Zeile unlesbar macht.
 * Ersetzt wird in Länge absteigend (Härtung F-4): enthielt ein längerer
 * Wert einen kürzeren, hätte das kurze sonst den langen aufgerissen und
 * einen Klartext-Rest stehen lassen.
 */
const redactKnownSecretValues = (text, bot) => {
  let out = String(text ?? '');
  const quellen = [bot?.secretEnv, bot?.panel?.secretSettings];
  const werte = [];
  for (const quelle of quellen) {
    if (!quelle || typeof quelle !== 'object') continue;
    for (const wert of Object.values(quelle)) {
      if (typeof wert !== 'string' || wert.length < MIN_SECRET_VALUE_LENGTH)
        continue;
      werte.push(wert);
      // Secret-Dateien dürfen Rand-Leerzeichen tragen; der Bot druckt den
      // Wert meist getrimmt – beide Formen zählen als derselbe Wert.
      const randlos = wert.trim();
      if (randlos.length >= MIN_SECRET_VALUE_LENGTH && randlos !== wert)
        werte.push(randlos);
    }
  }
  if (
    typeof bot?.runtimeToken === 'string' &&
    bot.runtimeToken.length >= MIN_SECRET_VALUE_LENGTH
  )
    werte.push(bot.runtimeToken);
  werte.sort((a, b) => b.length - a.length);
  for (const wert of werte) {
    if (out.includes(wert)) out = out.split(wert).join('[REDACTED]');
  }
  return out;
};

const pushOutput = (botId, stream, buffer) => {
  for (const line of buffer.split(/\r?\n/)) pushLine(botId, stream, line);
};

// Keep an unterminated child-process line bounded while still accepting later
// lines after an oversized one is discarded.
const outputLineReader = (botId, stream) => {
  let pending = '';
  let discarding = false;
  return {
    write(data) {
      const text = data.toString();
      let start = 0;
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] !== '\n') continue;
        if (discarding) {
          discarding = false;
        } else {
          const line = `${pending}${text.slice(start, i)}`.replace(/\r$/, '');
          pushLine(botId, stream, line);
        }
        pending = '';
        start = i + 1;
      }
      if (discarding) return;
      pending += text.slice(start);
      if (pending.length > MAX_PENDING_OUTPUT) {
        pushLine(botId, stream, '[Ausgabezeile wegen Größenlimit gekürzt]');
        pending = '';
        discarding = true;
      }
    },
    flush() {
      if (!discarding && pending.trim()) pushLine(botId, stream, pending);
      pending = '';
    },
  };
};

const broadcast = (type, payload) => {
  if (!listeners.size) return;
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  // Log-zeilen nur an Clients, die das Bot-Leserecht für genau diesen Bot
  // haben – dasselbe logs.read-Scoping, das auch die REST-Route prüft.
  const logScope =
    type === 'log' && payload?.botId
      ? {
          allowed: bots.has(payload.botId),
          botId: payload.botId,
        }
      : null;
  for (const client of listeners) {
    try {
      if (logScope) {
        if (!logScope.allowed) continue;
        const req = client.__sseReq;
        if (
          !req ||
          !(
            hasPermission(req, 'logs.read', { botId: logScope.botId }) ||
            hasPermission(req, 'logs.read.global') ||
            hasPermission(req, 'bots.manage')
          )
        )
          continue;
      }
      client.write(frame);
    } catch {
      listeners.delete(client);
    }
  }
};

const publicBot = (bot) => {
  // runtimeToken bleibt innen: der Wert gehört nur der Log-Redaktion
  // (redactKnownSecretValues) und darf nie die API oder einen SSE-Rahmen
  // erreichen – Maskierung wie bei secretEnv wäre hier zwecklos, das Feld
  // selbst hat in der öffentlichen Form nichts zu suchen.
  const {
    child,
    busy,
    logs,
    restartTimer,
    pendingLegacySecrets,
    runtimeToken,
    ...rest
  } = bot;
  ensurePanel(bot);
  return {
    ...rest,
    env: maskEnv(bot.env),
    secretEnv: maskEnv(bot.secretEnv),
    secretKeys: Object.keys(bot.secretEnv),
    panel: publicPanel(bot),
    // Nur der Pfad und die Anzahl, nie ein Dateiname: ein Zähler reicht der
    // Oberfläche, und die Liste holt sie sich ohnehin über eine eigene Route.
    startFolder: dateien.startFolderOf(bot),
    fileCount: dateien.count(bot, PROJECT_ROOT),
  };
};

const setStatus = (bot, status, extra = {}) => {
  bot.status = status;
  Object.assign(bot, extra);
  dirty.add(bot.id);
  schedulePersist();
  broadcast('bot', publicBot(bot));
};

const hydrate = (config) => {
  const workspace = workspaceConfig(config);
  const deleteLocked =
    config.deleteState === 'deleting' ||
    config.deleteState === 'cleanup_failed';
  // P1-I: Ein Bot im Delete-Recovery-Zustand bekommt KEINE neuen
  // Runtime-Ressourcen – kein Startordner, kein Scaffold, keine Secrets.
  // Recovery braucht nur die validierte Identität, um idempotent aufzuräumen.
  if (!deleteLocked) {
    // Jeder Bot bekommt seinen Startordner, beim ersten Start genauso wie beim
    // zehnten. Hier muss sichergestellt werden, dass es ihn gibt – nicht nur
    // beim Anlegen, sonst fiele er bei einem Bot, der eine Nacht alt ist,
    // einfach weg.
    dateien.ensureStartFolder(
      { id: config.id, workspaceRoot: workspace.workspaceRoot },
      PROJECT_ROOT,
    );
  }
  const secrets = deleteLocked
    ? { secretEnv: {}, secretSettings: {}, migrated: true }
    : migrateSecrets(config);
  const bot = {
    id: config.id,
    name: config.name,
    emoji: config.emoji || '🤖',
    description: config.description || '',
    language: config.language,
    framework: config.framework || '',
    entrypoint: config.entrypoint || '',
    command: config.command || '',
    commandResolved: config.commandResolved || '',
    cwd: workspace.cwd,
    workspaceRoot: workspace.workspaceRoot,
    guildId: config.guildId || '',
    autoRestart: Boolean(config.autoRestart),
    autoInstall: config.autoInstall !== false,
    depsCheck: config.depsCheck || '',
    depsInstall: config.depsInstall || '',
    maxRestarts: Number.isFinite(config.maxRestarts) ? config.maxRestarts : 5,
    env: config.env ?? {},
    secretEnv: secrets.secretEnv,
    secretKeys: [
      ...new Set([
        ...Object.keys(secrets.secretEnv),
        ...(Array.isArray(config.secretKeys) ? config.secretKeys : []),
      ]),
    ],
    status: 'stopped',
    pid: null,
    exitCode: config.exitCode ?? null,
    restartCount: config.restartCount ?? 0,
    // Persistenter Delete-Lifecycle (V23): 'active' normal, 'deleting' und
    // 'cleanup_failed' sperren Start/Restart/Schreibzugriffe – auch über
    // Hub-Neustarts hinweg, bis Recovery den Cleanup vollendet.
    deleteState: ['deleting', 'cleanup_failed'].includes(config.deleteState)
      ? config.deleteState
      : 'active',
    startedAt: null,
    stoppedAt: null,
    depsStatus: 'unknown',
    depsCommand: '',
    createdAt: config.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    logs: [],
    child: null,
    // Die geheimen Felder des Panels kommen aus dem Secret-Speicher, nicht
    // aus bots.json.
    panel: hydratePanel({
      ...config.panel,
      secretSettings: secrets.secretSettings,
      secretKeys: [
        ...new Set([
          ...Object.keys(secrets.secretSettings),
          ...(Array.isArray(config.panel?.secretKeys)
            ? config.panel.secretKeys
            : []),
        ]),
      ],
    }),
  };
  // Fehlgeschlagene Migration: die Legacy-Werte bleiben am Bot hängen und
  // werden von toFile() zurück in bots.json geschrieben – nie in die API.
  if (!secrets.migrated)
    bot.pendingLegacySecrets = secrets.pendingLegacySecrets;
  return bot;
};

/* ----------------------------- Prozesse ----------------------------- */
const killTree = (child, signal) => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* Prozess ist schon weg */
    }
  }
};

/**
 * P1-J: Eine lang laufende Installation hält den Lifecycle-Lock. DELETE und
 * STOP dürfen nicht minutenlang auf ihr Ende warten – aber den Lock einfach
 * freizugeben, während der Prozess noch in den Workspace schreibt, wäre der
 * alte Delete-/Write-Race. Dieser Helfer terminiert den kind-Prozess erst mit
 * SIGTERM, nach kurzer Gnadenfrist hart mit SIGKILL und wartet auf das
 * tatsächliche Prozessende (`bot.busy` cleared der exit-Handler). Erst dann
 * ist sicher, dass keine Operation mehr schreiben kann.
 * Scheitert das Warten, wirft er 409: der Bot bleibt gesperrt, statt dass
 * Cleanup unter einem laufenden Prozess abläuft.
 */
const abortActiveOperation = async (bot, { graceMs = 5000 } = {}) => {
  const proc = bot.busy;
  if (proc) {
    pushLine(bot.id, 'system', 'Laufende Installation wird abgebrochen …');
    killTree(proc, 'SIGTERM');
  }
  let until = Date.now() + graceMs;
  while (bot.busy && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (bot.busy) {
    pushLine(
      bot.id,
      'system',
      'ESKALATION: SIGTERM wirkte nicht, sende SIGKILL',
    );
    killTree(bot.busy, 'SIGKILL');
    until = Date.now() + graceMs;
    while (bot.busy && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (bot.busy) {
    const error = lifecycleConflict();
    error.message =
      'Laufende Installation endet nicht – der Bot bleibt gesperrt, damit kein Cleanup unter einem schreibenden Prozess läuft.';
    throw error;
  }
};

/* --------------------------- Abhängigkeiten -------------------------- */
const venvOf = (bot) => getLanguage(bot.language).venv || '';

const venvDir = (dir, venv) => (isAbsolute(venv) ? venv : join(dir, venv));

/** Legt die virtuelle Umgebung an, damit pip nicht am System-Python scheitert. */
const ensureEnv = async (bot, dir, info) => {
  const { venv, prepare } = info;
  if (!venv || !prepare) return true;
  const base = venvDir(dir, venv);
  const exists =
    existsSync(join(base, 'bin', 'python3')) ||
    existsSync(join(base, 'bin', 'python')) ||
    existsSync(join(base, 'Scripts', 'python.exe'));
  if (exists) {
    const probe = await runCommand(bot, 'python3 -m pip --version', {
      dir,
      silent: true,
      timeout: 30000,
    });
    if (probe.code === 0) return true;
    pushLine(bot.id, 'system', `✗ ${venv} ist unvollständig – repariere pip …`);
    rmSync(base, { recursive: true, force: true });
  } else {
    pushLine(bot.id, 'system', `Richte ${venv} ein …`);
  }

  const { code } = await runCommand(bot, prepare, {
    dir,
    silent: true,
    timeout: 180000,
    systemPython: true,
  });
  if (code === 0) {
    pushLine(bot.id, 'system', `✓ ${venv} bereit`);
    return true;
  }
  pushLine(
    bot.id,
    'system',
    `✗ ${venv} konnte nicht erstellt werden – unter Debian/Ubuntu fehlt oft das Paket python3-venv (sudo apt install python3-venv).`,
  );
  return false;
};

const depsFor = (bot) => {
  const language = getLanguage(bot.language);
  const framework = getFramework(bot.language, bot.framework);
  const venv = language.venv || '';
  const deps = { package: framework.package, module: framework.module, venv };
  const check = fillDeps(bot.depsCheck || language.check, deps);
  const installRaw = bot.depsInstall || language.install;
  // Unterstütze sowohl String- als auch strukturierte Befehle
  const install =
    typeof installRaw === 'string' ? fillDeps(installRaw, deps) : installRaw;
  const prepare = fillDeps(language.prepare, deps);
  return { language, framework, deps, check, install, prepare, venv };
};

/** Obergrenze für einzelne Werte aus der Bot-Konfiguration. */
const MAX_BOT_ENV_VALUE = 32768;

/**
 * Schlüssel, die festlegen, wie ein Prozess Programme findet und lädt.
 * Die setzt der Hub – niemals die Bot-Konfiguration: ein eigenes PATH,
 * LD_PRELOAD, NODE_OPTIONS oder PYTHONSTARTUP macht aus jedem freige-
 * gebenen Binary beliebigen Code und hebt die Allowlist der ausführba-
 * ren Programme auf. `PATH` setzt der Hub später selbst (venv vor Sys-
 * tem-PATH); hier geht es nur darum, dass der Bot ihn nicht setzt.
 */
const isHubControlledEnvKey = (key) => {
  const normalized = String(key).toLowerCase();
  return (
    normalized === 'path' ||
    normalized === 'home' ||
    normalized === 'temp' ||
    normalized.startsWith('tmp') ||
    normalized.startsWith('ld_') ||
    normalized === 'node_options' ||
    normalized.startsWith('python') ||
    normalized.startsWith('git_') ||
    normalized.startsWith('npm_config')
  );
};

/**
 * Die Bot-Umgebung, bereinigt: blockierte Schlüssel und unbrauchbare
 * Werte (kein String, überschnitten) fallen ersatzlos weg. Geloggt wird
 * den Name, nie der Wert. exportiert für die Tests.
 */
const warnedEnvKeys = new Set();
export const usableBotEnv = (bot) => {
  const clean = {};
  for (const [key, value] of Object.entries(bot.env ?? {})) {
    const problem = isHubControlledEnvKey(key)
      ? 'Schlüssel verwaltet der Hub'
      : typeof value !== 'string'
        ? 'Wert ist kein String'
        : value.length > MAX_BOT_ENV_VALUE
          ? `Wert länger als ${MAX_BOT_ENV_VALUE} Zeichen`
          : '';
    if (problem) {
      if (warnedEnvKeys.size > 1000) warnedEnvKeys.clear();
      const note = `${bot.id}:${key}`;
      if (!warnedEnvKeys.has(note)) {
        warnedEnvKeys.add(note);
        console.warn(
          `[hub] "${bot.id}": Bot-Umgebungsvariable "${key}" ignoriert (${problem}).`,
        );
      }
      continue;
    }
    clean[key] = value;
  }
  return clean;
};

export const botEnv = (
  bot,
  dir,
  { runtime = false, includeSecrets = runtime, useVenv = true } = {},
) => {
  const venv = useVenv ? venvOf(bot) : '';
  const base = venv && dir ? venvDir(dir, venv) : '';
  const binDirs = base
    ? [join(base, 'bin'), join(base, 'Scripts')].filter((path) =>
        existsSync(path),
      )
    : [];
  const pathVar = process.platform === 'win32' ? 'Path' : 'PATH';
  const safeEnv = {};
  for (const key of [
    pathVar,
    ...(pathVar === 'Path' ? ['PATH'] : []),
    'HOME',
    'LANG',
    'TMPDIR',
    'TEMP',
    'TMP',
  ]) {
    if (process.env[key] !== undefined) safeEnv[key] = process.env[key];
  }
  const currentPath = safeEnv[pathVar] ?? safeEnv.PATH ?? '';
  return {
    ...safeEnv,
    ...usableBotEnv(bot),
    ...(binDirs.length
      ? { [pathVar]: [...binDirs, currentPath].join(delimiter) }
      : {}),
    VIRTUAL_ENV: base || undefined,
    DISCORD_GUILD_ID: bot.guildId,
    BOT_NAME: bot.name,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    npm_config_yes: 'true',
    // Nur der echte Bot-Prozess darf sich am Hub anmelden.
    ...(includeSecrets
      ? { DISCORD_BOT_TOKEN: bot.secretEnv.DISCORD_BOT_TOKEN ?? '' }
      : {}),
    ...(runtime ? hubEnv(bot, dir) : {}),
  };
};

/** Hilfsbefehl ausführen und die Ausgabe in die Logs spiegeln. */
const parseCommand = (command) => {
  const tokens = [];
  let current = '';
  let quote = '';
  for (const char of String(command ?? '').trim()) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (';&|`$<>'.includes(char)) return null;
    current += char;
  }
  if (quote) return null;
  if (current) tokens.push(current);
  return tokens.length ? tokens : null;
};

/**
 * Ein Programm im eigenen Ordner des Bots: beim Bauen der Gradle-Wrapper
 * `./gradlew`, beim Start zusätzlich das vom Sprach-Preset erzeugte Programm
 * selbst – Rusts Standard-Startbefehl heißt `./target/release/bot`, und ohne
 * diese Freigabe könnte der Hub sein eigenes Preset nicht ausführen.
 *
 * Dafür gilt mehr als "beginnt mit ./": das Ziel muss eine reguläre Datei im
 * Workspace sein, ausführbar, und nach `realpath` immer noch darin liegen. Ein
 * SymLink nach `/usr/bin` wäre sonst ein Weg aus der Prüfung heraus.
 */
const WORKSPACE_PROGRAMS = new Set(['./gradlew', './mvnw', './gradlew.bat']);

const workspaceProgram = (executable, dir, allowAny = false) => {
  if (
    allowAny
      ? !executable.startsWith('./')
      : !WORKSPACE_PROGRAMS.has(executable)
  )
    return null;
  const candidate = resolve(dir, executable);
  let info;
  let real;
  try {
    info = statSync(candidate);
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  if (process.platform !== 'win32' && (info.mode & 0o111) === 0) return null;
  const rel = relative(dir, real);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return real;
};

const commandSpec = (bot, command, dir, purpose = 'start') => {
  const tokens = parseCommand(command);
  if (!tokens) throw httpError(400, 'Ungültiger Befehl');
  const [executable, ...args] = tokens;
  // `./gradlew` ist der einzige erlaubte Pfad: eine Datei im eigenen Ordner des
  // Bots, nicht irgendwo im Dateisystem.
  // Beim Start ist jede ausführbare Datei im Workspace zulässig (Presets wie
  // `./target/release/bot`); beim Bauen bleibt die Liste eng auf die Wrapper.
  const local = workspaceProgram(executable, dir, purpose === 'start');
  if (
    !local &&
    (isAbsolute(executable) ||
      executable.includes('/') ||
      executable.includes('\\'))
  )
    throw httpError(
      400,
      'Das Programm muss aus der freigegebenen Runtime stammen',
    );
  const language = getLanguage(bot.language);
  const allowed = new Set(
    [
      language.runtime,
      ...(bot.language === 'typescript' ? ['npx', 'node'] : []),
      ...(bot.language === 'custom'
        ? ['bash', 'sh', 'node', 'python3', 'python']
        : []),
      ...(purpose === 'dependency'
        ? [
            'test',
            'touch',
            'ls',
            'grep',
            'go',
            'cargo',
            'npm',
            'pip',
            'mvn',
            'dotnet',
            'gradle',
          ]
        : []),
    ].filter(Boolean),
  );
  if (!local && !allowed.has(executable))
    throw httpError(
      400,
      'Programm ist für diese Bot-Sprache nicht freigegeben',
    );
  const framework = getFramework(bot.language, bot.framework);
  const deps = {
    package: framework.package,
    module: framework.module,
    venv: language.venv || '',
  };
  // Sprachen ohne Prüfbefehl (z.B. "Sonstiges") haben hier nichts zu füllen.
  const expectedCheck = fillDeps(language.check || '', deps);
  const expectedPrepare = fillDeps(language.prepare || '', deps);
  const expectedInstall = fillDeps(
    typeof language.install === 'string' ? language.install : '',
    deps,
  );
  const isExpectedDependencyCheck =
    purpose === 'dependency' && command === expectedCheck;
  const isExpectedDependencyCommand =
    purpose === 'dependency' &&
    [expectedPrepare, expectedInstall].includes(command);
  const isPythonPipProbe =
    purpose === 'dependency' && command === 'python3 -m pip --version';
  if (
    args.some((arg) => isEvalFlag(arg)) &&
    !isExpectedDependencyCheck &&
    !isExpectedDependencyCommand &&
    !isPythonPipProbe
  )
    throw httpError(400, 'Interpreter-Evaluationsflags sind nicht erlaubt');
  const safeArgs = args.map((arg) => {
    if (!arg.includes('/') && !arg.startsWith('.')) return arg;
    const candidate = resolve(dir, arg);
    let trusted = candidate;
    try {
      if (existsSync(candidate)) trusted = realpathSync(candidate);
    } catch {
      trusted = candidate;
    }
    if (
      relative(dir, trusted).startsWith('..') ||
      isAbsolute(relative(dir, trusted))
    )
      throw httpError(400, 'Befehl verweist außerhalb des Bot-Workspace');
    return relative(dir, trusted);
  });
  return { executable: local ?? executable, args: safeArgs };
};

const runCommand = (
  bot,
  command,
  {
    dir,
    silent = false,
    timeout = 120000,
    systemPython = false,
    dependencyInstall = false,
  },
) =>
  new Promise((resolveRun) => {
    if (!silent) pushLine(bot.id, 'system', `$ ${command}`);
    let spec;
    try {
      spec = commandSpec(bot, command, dir, 'dependency');
    } catch (error) {
      pushLine(bot.id, 'system', `Befehl abgelehnt: ${error.message}`);
      resolveRun({ code: -1 });
      return;
    }
    const inContainer = containerRuntimeEnabled();
    const temporaryEgress =
      dependencyInstall && inContainer && process.env.NODE_ENV === 'production';
    (async () => {
      let exec = null;
      let child = null;
      let killer = null;
      let settled = false;
      const finish = async (code) => {
        if (settled) return;
        settled = true;
        if (killer) clearTimeout(killer);
        if (bot.busy === child) bot.busy = null;
        if (exec?.envFile) cleanupExecEnvFile(exec.envFile);
        resolveRun({ code });
      };

      try {
        const env = botEnv(bot, dir, {
          includeSecrets: false,
          useVenv: !systemPython,
        });
        if (temporaryEgress) {
          // User-Konfiguration kann Umgebungsvariablen enthalten, die zur
          // Laufzeit gebraucht werden. Installationsskripte erhalten sie
          // absichtlich nicht; private Registry-Credentials sind nicht erlaubt.
          for (const key of Object.keys(bot.env ?? {})) delete env[key];
          exec = dependencyRunArgs(bot, PROJECT_ROOT, dir, spec, env);
        } else {
          exec = inContainer
            ? execArgs(bot, PROJECT_ROOT, dir, spec, env)
            : null;
        }
        // detached + killTree: pip/npm lassen oft Enkelprozesse zurück. Ohne
        // eigene Prozessgruppe trifft der Gruppen-Kill nur den Direktkind-Prozess.
        child = spawn(
          inContainer ? containerRuntimeName() : spec.executable,
          inContainer ? exec.args : spec.args,
          withBotCredentials({
            cwd: inContainer ? PROJECT_ROOT : dir,
            env: inContainer ? process.env : env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          }),
        );
        bot.busy = child;
        const outputReader = outputLineReader(bot.id, 'deps');
        const errorReader = outputLineReader(bot.id, 'deps');
        child.stdout.on('data', (data) => outputReader.write(data));
        child.stderr.on('data', (data) => errorReader.write(data));
        killer = setTimeout(() => {
          pushLine(
            bot.id,
            'system',
            'Zeitüberschreitung – Befehl wird abgebrochen',
          );
          if (exec?.containerName) {
            const stopper = spawn(
              containerRuntimeName(),
              ['stop', '--time', '2', exec.containerName],
              { stdio: 'ignore' },
            );
            stopper.once('error', () => killTree(child, 'SIGTERM'));
            stopper.once('exit', (code) => {
              if (code !== 0) killTree(child, 'SIGTERM');
            });
          } else {
            killTree(child, 'SIGTERM');
          }
        }, timeout);
        killer.unref();
        child.on('error', (error) => {
          pushLine(bot.id, 'system', `Befehl fehlgeschlagen: ${error.message}`);
          void finish(-1);
        });
        child.on('exit', (code) => {
          outputReader.flush();
          errorReader.flush();
          void finish(code ?? -1);
        });
      } catch (error) {
        pushLine(bot.id, 'system', `Befehl fehlgeschlagen: ${error.message}`);
        await finish(-1);
      }
    })();
  });

/** Prüft, ob die gewählte Library schon installiert ist. */
const checkDependencies = async (bot, dir) => {
  const info = depsFor(bot);
  if (!info.check) return { ...info, ok: true, check: '', install: '' };

  setStatus(bot, 'checking', { depsStatus: 'checking' });
  const envReady = await ensureEnv(bot, dir, info);
  if (!envReady) return { ...info, ok: false };
  pushLine(bot.id, 'system', `Prüfe ${info.framework.name} …`);
  const { code } = await runCommand(bot, info.check, {
    dir,
    silent: true,
    timeout: 60000,
  });
  if (code === 0)
    pushLine(
      bot.id,
      'system',
      `✓ ${info.framework.name} ist bereits vorhanden`,
    );
  return { ...info, ok: code === 0 };
};

/** Installiert die Library, falls die Prüfung fehlgeschlagen ist. */
const installDependencies = async (bot, dir, { state, force = false } = {}) => {
  const info = state ?? (await checkDependencies(bot, dir));
  if (info.ok && !force) return { ...info, installed: false, ok: true };

  const plan = resolveInstallPlan(info.install, dir, info.deps);
  if (!plan.length) {
    pushLine(
      bot.id,
      'system',
      `Für ${info.language.label} ist kein Installationsbefehl hinterlegt – bitte manuell installieren.`,
    );
    setStatus(bot, 'stopped', { depsStatus: 'missing' });
    return { ...info, installed: false, ok: false };
  }

  setStatus(bot, 'installing', {
    depsStatus: 'installing',
    depsCommand: installLabel(plan),
  });
  // Maßnahme 35: ohne Erststart-Sentinel im DOTNET_CLI_HOME crasht jeder
  // dotnet-Befehl als Nicht-Root im Container (NuGet-Migrations-Mutex).
  if (containerRuntimeEnabled() && bot.language === 'csharp')
    await ensureDotnetCliHome(bot, PROJECT_ROOT);
  pushLine(
    bot.id,
    'system',
    `Installiere ${info.framework.name} – je nach Sprache kann das ein paar Minuten dauern …`,
  );

  for (const step of plan) {
    // P1-J: Ein Delete, das den Lock freibekommen will, hat Vorrang. Nach
    // dem letzten Schritt schreibt dieser Prozess nicht mehr in den
    // Workspace – erst dann darf der Cleanup Dateien und Container entfernen.
    if (isDeleteLocked(bot)) {
      pushLine(
        bot.id,
        'system',
        'Installation abgebrochen – Löschvorgang hat Vorrang.',
      );
      return { ...info, installed: true, ok: false };
    }
    const { code } = await runCommand(bot, step.join(' '), {
      dir,
      timeout: INSTALL_TIMEOUT,
      dependencyInstall: true,
    });
    if (code !== 0) {
      pushLine(
        bot.id,
        'system',
        `✗ Installation fehlgeschlagen (Exit-Code ${code})`,
      );
      setStatus(bot, 'stopped', { depsStatus: 'failed' });
      return { ...info, installed: true, ok: false };
    }
  }

  pushLine(bot.id, 'system', `✓ ${info.framework.name} installiert`);
  setStatus(bot, 'stopped', { depsStatus: 'ready' });
  return { ...info, installed: true, ok: true };
};

/**
 * Aus einem Installationsbefehl wird eine Folge von Schritten.
 *
 * Ein String bleibt ein Schritt und geht über den bestehenden geprüften Weg.
 * Ein Objekt beschreibt eine Bedingung im Startordner – etwa "nutze den
 * Wrapper im Projekt, wenn es ihn gibt, sonst Maven". Die Bedingung wird hier
 * im Hub ausgewertet; ein `if [ -f ... ]` im Befehl selbst wäre wieder
 * Shell-Syntax und fiele durch die Befehlsprüfung.
 *
 * Wichtig ist die Unterscheidung zwischen *Alternative* und *Folge*: ein
 * else-Zweig, der aus zwei Befehlen besteht, führt beide aus. Ersetzt man den
 * zweiten durch den ersten, bleibt das Projekt uninitialisiert.
 */
const resolveInstallPlan = (install, dir, deps) => {
  if (!install) return [];
  // Auch ein String wird zu einer Argumentliste. Bliebe er hier als Text
  // stehen, würde `step.join(' ')` später jedes Zeichen einzeln trennen.
  if (typeof install === 'string') return [[fillDeps(install, deps)]];
  const fill = (parts) => parts.map((part) => fillDeps(String(part), deps));
  const branch = (node) => {
    if (!node) return [];
    if (Array.isArray(node)) return node.map(fill);
    if (Array.isArray(node.run)) return [fill(node.run)];
    if (Array.isArray(node.sequence)) return node.sequence.map(fill);
    return [];
  };
  if (!install.if) return branch(install);
  const file = String(install.if.file ?? '');
  if (!file || /[/\\]/.test(file)) return branch(install.else);
  const target = join(dir, file);
  const matches = () => {
    try {
      const info = statSync(target);
      if (!info.isFile()) return false;
      if (
        install.if.executable &&
        process.platform !== 'win32' &&
        (info.mode & 0o111) === 0
      )
        return false;
      const rel = relative(dir, realpathSync(target));
      return !rel.startsWith('..') && !isAbsolute(rel);
    } catch {
      return false;
    }
  };
  return branch(matches() ? (install.then ?? install.else) : install.else);
};

/** Nur für Tests und Anzeige: der Installationsbefehl als Text. */
const installLabel = (plan) =>
  plan.map((step) => step.join(' ')).join(' && ') || '—';

const spawnBot = (bot, dir, language) => {
  const command = fillPlaceholders(bot.command, bot, dir) || language.command;
  if (!command) throw httpError(400, 'Kein Startbefehl definiert');

  bot.commandResolved = command;
  ensurePanel(bot);

  let child;
  let exec = null;
  try {
    const spec = commandSpec(bot, command, dir, 'start');
    const runtimeEnv = {
      ...botEnv(bot, dir, { runtime: true }),
      FORCE_COLOR: '1',
    };
    const inContainer = containerRuntimeEnabled();
    const spawnOptions = withBotCredentials({
      cwd: inContainer ? PROJECT_ROOT : dir,
      env: inContainer ? process.env : runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    exec = inContainer
      ? execArgs(bot, PROJECT_ROOT, dir, spec, runtimeEnv)
      : null;
    child = spawn(
      inContainer ? containerRuntimeName() : spec.executable,
      inContainer ? exec.args : spec.args,
      spawnOptions,
    );
    if (exec?.envFile) {
      child.once('exit', () => cleanupExecEnvFile(exec.envFile));
      child.once('error', () => cleanupExecEnvFile(exec.envFile));
    }
  } catch (error) {
    if (exec?.envFile) cleanupExecEnvFile(exec.envFile);
    setStatus(bot, 'error', { exitCode: -1 });
    pushLine(bot.id, 'system', `Start fehlgeschlagen: ${error.message}`);
    throw httpError(500, `Start fehlgeschlagen: ${error.message}`);
  }

  bot.child = child;
  const outputReader = outputLineReader(bot.id, 'stdout');
  const errorReader = outputLineReader(bot.id, 'stderr');
  child.stdout.on('data', (data) => outputReader.write(data));
  child.stderr.on('data', (data) => errorReader.write(data));

  child.on('error', (error) => {
    pushLine(bot.id, 'system', `Prozessfehler: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    bot.child = null;
    revokeRuntimeToken(bot.id);
    outputReader.flush();
    errorReader.flush();
    if (containerRuntimeEnabled()) stopContainer(bot).catch(() => {});
    pushLine(
      bot.id,
      'system',
      `Prozess beendet (code=${code}, signal=${signal ?? '-'})`,
    );

    const crashed = code !== 0 && code !== null;
    const room = bot.autoRestart ? bot.maxRestarts : 0;
    // Kein Auto-Restart während eines Löschvorgangs (siehe startBot).
    if (crashed && bot.restartCount < room && !isDeleteLocked(bot)) {
      const next = bot.restartCount + 1;
      setStatus(bot, 'restarting', {
        exitCode: code,
        restartCount: next,
        stoppedAt: Date.now(),
      });
      pushLine(bot.id, 'system', `Neustart ${next}/${room || '∞'} in 3s …`);
      bot.restartTimer = setTimeout(() => {
        bot.restartTimer = null;
        if (!bots.has(bot.id) || isDeleteLocked(bot)) return;
        withBotLifecycleLock(bot.id, async () => {
          if (bots.get(bot.id) !== bot || isDeleteLocked(bot)) return;
          await startBot(bot.id, { manual: false });
        }).catch((error) => {
          setStatus(bot, 'error', { exitCode: -1 });
          pushLine(
            bot.id,
            'system',
            `Neustart fehlgeschlagen: ${error.message}`,
          );
        });
      }, 3000);
      return;
    }
    setStatus(bot, crashed ? 'crashed' : 'stopped', {
      exitCode: code,
      stoppedAt: Date.now(),
      pid: null,
    });
  });

  setStatus(bot, 'running', {
    pid: child.pid,
    startedAt: Date.now(),
    stoppedAt: null,
    exitCode: null,
    restartCount: bot.manual ? 0 : bot.restartCount,
  });
  pushLine(bot.id, 'system', `▶ ${command} (PID ${child.pid})`);
  return publicBot(bot);
};

const prepareStart = (bot) => {
  if (bot.child) throw httpError(409, `"${bot.name}" läuft bereits`);
  if (bot.busy)
    throw httpError(409, `"${bot.name}" installiert gerade Abhängigkeiten`);
  const dir = safeBotPath(bot, bot.cwd);
  if (!dir)
    throw httpError(
      400,
      'Der Startordner liegt ausserhalb des Workspace dieses Bots',
    );
  if (process.env.BOT_HUB_TEST_MODE !== '1')
    for (const other of bots.values()) {
      if (other.id !== bot.id && safeBotPath(other, other.cwd) === dir)
        throw httpError(
          409,
          'Der Startordner wird bereits von einem anderen Bot verwendet',
        );
    }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw httpError(400, `Ordner "${bot.cwd}" existiert nicht`);
  }
  return dir;
};

/**
 * Den Startordner in den Workspace spiegeln, bevor der Bot startet.
 *
 * Bewusst vor `ensureContainer`: ist der Container schon da und das Spiegeln
 * scheitert, hängt der Betreiber an einem Container, der den alten Code
 * fährt – und die Meldung käme erst, wenn der Bot sich schon meldet. Die
 * Dateien sind die Grundlage, nicht eine Nebensache.
 */
const uebernehmen = (bot) => {
  const ergebnis = dateien.sync(bot, PROJECT_ROOT);
  if (ergebnis.kopiert)
    pushLine(
      bot.id,
      'system',
      `${ergebnis.kopiert} Datei(en) aus dem Startordner übernommen`,
    );
  if (ergebnis.entfernt)
    pushLine(
      bot.id,
      'system',
      `${ergebnis.entfernt} Datei(en) entfernt – im Startordner nicht mehr vorhanden`,
    );
  for (const eintrag of ergebnis.uebersprungen.slice(0, 5))
    pushLine(bot.id, 'system', `Startordner: übersprungen – ${eintrag}`);
  return ergebnis;
};

async function startBot(id, { manual = true } = {}) {
  const bot = bots.get(id);
  if (!bot) throw httpError(404, 'Bot nicht gefunden');
  // Kein (Re-)Start während eines Löschvorgangs: sonst überlebt ein frisch
  // gestarteter Prozess seinen Bot als Waise ohne Verzeichnis und Eintrag.
  if (isDeleteLocked(bot)) throw lifecycleConflict();
  const dir = prepareStart(bot);
  uebernehmen(bot);

  bot.manual = manual;
  bot.env = { ...bot.env };
  const { language } = depsFor(bot);
  if (containerRuntimeEnabled()) {
    try {
      await ensureContainer(bot, PROJECT_ROOT);
      pushLine(
        bot.id,
        'system',
        `Container-Umgebung für ${bot.name} ist bereit`,
      );
    } catch (error) {
      setStatus(bot, 'error', { exitCode: -1 });
      pushLine(
        bot.id,
        'system',
        `Container konnte nicht gestartet werden: ${error.message}`,
      );
      return publicBot(bot);
    }
    if (bots.get(id) !== bot || isDeleteLocked(bot)) throw lifecycleConflict();
  }

  if (language.check) {
    const state = await checkDependencies(bot, dir);
    if (bots.get(id) !== bot || isDeleteLocked(bot)) throw lifecycleConflict();
    if (!state.ok) {
      if (!bot.autoInstall) {
        pushLine(
          bot.id,
          'system',
          `${state.framework.name} fehlt – automatische Installation ist abgeschaltet.`,
        );
        setStatus(bot, 'stopped', { depsStatus: 'missing' });
        if (containerRuntimeEnabled()) stopContainer(bot).catch(() => {});
        return publicBot(bot);
      }
      const installed = await installDependencies(bot, dir, { state });
      if (bots.get(id) !== bot || isDeleteLocked(bot))
        throw lifecycleConflict();
      if (!installed.ok) {
        if (containerRuntimeEnabled()) stopContainer(bot).catch(() => {});
        return publicBot(bot);
      }
    } else {
      setStatus(bot, 'stopped', { depsStatus: 'ready' });
    }
  }

  if (bots.get(id) !== bot || isDeleteLocked(bot)) throw lifecycleConflict();
  return spawnBot(bot, dir, language);
}

function stopBot(id, { signal = 'SIGTERM' } = {}) {
  const bot = bots.get(id);
  if (!bot) throw httpError(404, 'Bot nicht gefunden');
  if (bot.restartTimer) {
    clearTimeout(bot.restartTimer);
    bot.restartTimer = null;
  }
  if (bot.busy) {
    killTree(bot.busy, signal);
    bot.busy = null;
    pushLine(bot.id, 'system', 'Installation abgebrochen');
  }
  if (!bot.child) {
    if (containerRuntimeEnabled()) stopContainer(bot).catch(() => {});
    if (bot.status !== 'stopped')
      setStatus(bot, 'stopped', { pid: null, stoppedAt: Date.now() });
    return publicBot(bot);
  }
  killTree(bot.child, signal);
  setTimeout(() => {
    if (bot.child) {
      pushLine(
        bot.id,
        'system',
        `ESKALATION: ${signal} hat nicht gewirkt, sende SIGKILL`,
      );
      killTree(bot.child, 'SIGKILL');
    }
  }, 6000).unref();
  return publicBot(bot);
}

/* ------------------------------ Storage ----------------------------- */
const stopAllBots = () => {
  for (const bot of bots.values()) {
    if (bot.restartTimer) {
      clearTimeout(bot.restartTimer);
      bot.restartTimer = null;
    }
    killTree(bot.child, 'SIGTERM');
    killTree(bot.busy, 'SIGTERM');
    if (containerRuntimeEnabled()) stopContainer(bot).catch(() => {});
  }
};

/**
 * Feldprüfung für Einträge aus bots.json. Die Datei wird zwar nur vom Hub
 * geschrieben, bleibt aber ein angreifbarer Zustandsträger (korrupte Reste,
 * lokale Manipulation, teilabgeschriebene Migrationen). Ungeprüfte Werte
 * landen in Pfadkomponenten (`bots/<id>/workspace`, `data/secrets/<id>.env`,
 * `rm -rf` beim Löschen) und im Spawn – deshalb: Typ, Länge und erlaubte
 * Zeichen, bevor hydrate irgendetwas damit anfasst. Rückgabe: Ablehnungsgrund
 * oder '' wenn der Eintrag übernehmbar ist.
 */
const ablehnungsgrund = (config) => {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    return 'Eintrag ist kein Objekt';
  if (typeof config.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(config.id))
    return 'id fehlt oder ungültig';
  if (
    typeof config.name !== 'string' ||
    !config.name.trim() ||
    config.name.length > 200
  )
    return `name fehlt oder ungültig (id ${config.id})`;
  for (const feld of [
    'emoji',
    'description',
    'language',
    'framework',
    'entrypoint',
    'command',
    'commandResolved',
    'guildId',
    'depsCheck',
    'depsInstall',
    'cwd',
    'workspaceRoot',
  ]) {
    const wert = config[feld];
    if (wert === undefined) continue;
    if (typeof wert !== 'string')
      return `${feld} ist kein Text (id ${config.id})`;
    if (wert.length > 4096) return `${feld} ist zu lang (id ${config.id})`;
  }
  // Pfadfelder dürfen den Hub-Rahmen nicht verlassen – absolut oder mit
  // Ausstieg ist kein gültiger Workspace-Ausdruck, egal woher er stammt.
  for (const feld of ['cwd', 'workspaceRoot']) {
    const wert = config[feld];
    if (typeof wert !== 'string' || !wert) continue;
    if (
      isAbsolute(wert) ||
      wert.split(/[\\/]/).includes('..') ||
      wert.startsWith('~')
    )
      return `${feld} verlässt den Workspace (id ${config.id})`;
  }
  for (const feld of ['env', 'secretEnv', 'panel']) {
    const wert = config[feld];
    if (wert === undefined) continue;
    if (!wert || typeof wert !== 'object' || Array.isArray(wert))
      return `${feld} ist kein Objekt (id ${config.id})`;
  }
  if (
    config.secretKeys !== undefined &&
    !(
      Array.isArray(config.secretKeys) &&
      config.secretKeys.every((key) => typeof key === 'string')
    )
  )
    return `secretKeys ist keine Textliste (id ${config.id})`;
  return '';
};

const load = () => {
  // Reste abgebrochener Schreibvorgänge enthalten vollständige Geheimnisse.
  cleanupTempEnvFiles(join(PROJECT_ROOT, 'data', 'secrets'));
  if (!existsSync(DATA_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return;
    // Enthielt bots.json noch Geheimnisse, werden sie jetzt in data/secrets
    // gesichert und die Datei anschließend ohne Werte neu geschrieben.
    // Verschoben wird nur, was wirklich gesichert wurde (P0-A): ein Bot mit
    // fehlgeschlagener Migration behält seine Legacy-Werte, sonst wären sie
    // beim Umschreiben der Übersicht verloren.
    let migratedAny = false;
    let migrationFailed = false;
    for (const config of parsed.slice(0, MAX_BOTS)) {
      const grund = ablehnungsgrund(config);
      if (grund) {
        // Ungültige Einträge werden übersprungen und gemeldet, statt den
        // Start crashen zu lassen oder ungeprüfte Werte in Pfade zu schicken.
        console.warn(`[hub] bots.json: Eintrag übersprungen – ${grund}`);
        continue;
      }
      const hadLegacy =
        Object.keys(config.secretEnv ?? {}).length > 0 ||
        Object.keys(config.panel?.secretSettings ?? {}).length > 0;
      const bot = hydrate(config);
      bots.set(config.id, bot);
      if (hadLegacy) {
        if (bot.pendingLegacySecrets) migrationFailed = true;
        else migratedAny = true;
      }
      // Bestehende Bots ohne Webseite bekommen das Beispiel-Scaffold.
      // Idempotent: vorhandene bot-hub.json/panel-Dateien bleiben unangetastet.
      // Fehler werden geloggt, verhindern aber nie den Start (Verfügbarkeit
      // geht vor Beispielseite; der Bot selbst ist vollständig).
      // P1-I: Bots im Delete-Recovery erhalten kein Scaffold und keine
      // Dateiübernahme – sonst legt der Start neue Runtime-Dateien an, die
      // der gleich anschließende Cleanup wegwerfen würde (oder die bleiben).
      if (bot.deleteState !== 'active') continue;
      try {
        // Alte kaputte Hub-Scaffolds (V1) zuerst migrieren – nur eindeutig
        // Hub-generierte Dateien, niemals eigene Seiten. Danach erzeugt das
        // normale Scaffold Fehlendes; Uebernehmen spiegelt in den Workspace.
        const { migrated } = migrateScaffold(bot, PROJECT_ROOT);
        if (migrated.length)
          console.log(
            `[hub] Beispiel-Webseite für ${config.id} migriert: ${migrated.join(', ')}`,
          );
        const { created, error } = ensurePanelScaffold(bot, PROJECT_ROOT);
        if (error)
          console.warn(
            `[hub] Beispiel-Webseite für ${config.id} unvollständig: ${error}`,
          );
        else if (created.length || migrated.length) uebernehmen(bot);
      } catch (error) {
        console.warn(
          `[hub] Beispiel-Webseite für ${config.id} fehlgeschlagen: ${error?.message ?? error}`,
        );
      }
    }
    // Force-Persistenz: die Datenquelle ist migriert, aber kein Bot ist
    // "dirty" – ohne force würde flush() die Bereinigung von bots.json
    // überspringen und die Klartext-Secrets blieben stehen.
    if (migratedAny) {
      schedulePersist(true);
      console.warn(
        '[hub] Geheimnisse aus bots.json nach data/secrets verschoben.',
      );
    }
    if (migrationFailed)
      console.warn(
        '[hub] Einige Secret-Migrationen waren nicht sicher abzuschließen; die betroffenen Werte bleiben bis zum Erfolg in bots.json erhalten.',
      );
  } catch (error) {
    console.error('[hub] bots.json unlesbar:', error.message);
  }
  // Recovery unvollständiger Löschungen: Bots in `deleting`/`cleanup_failed`
  // werden NICHT gestartet, sondern der Cleanup wird erneut versucht. Erfolg
  // entfernt sie endgültig, Fehler belassen `cleanup_failed`. Läuft
  // nebenläufig, damit ein hängender Schritt den Hub-Start nicht blockiert.
  recoverIncompleteDeletes().catch((error) =>
    console.error(
      '[hub] Delete-Recovery fehlgeschlagen:',
      error?.message ?? error,
    ),
  );
};

/**
 * Startup-Recovery für abgebrochene Löschungen (P0 #10): Bots, die beim
 * letzten Lauf in `deleting` oder `cleanup_failed` stehen geblieben sind,
 * werden nie gestartet – stattdessen läuft derselbe idempotente Workflow wie
 * bei DELETE. Erfolg → endgültig entfernt; Fehler → `cleanup_failed` bleibt.
 */
const recoverIncompleteDeletes = async () => {
  for (const bot of [...bots.values()]) {
    if (bot.deleteState !== 'deleting' && bot.deleteState !== 'cleanup_failed')
      continue;
    // Absturz mitten im Delete wird wie cleanup_failed behandelt.
    if (bot.deleteState === 'deleting') bot.deleteState = 'cleanup_failed';
    console.log(
      `${auditTag(bot.id, 'recovery')} RECOVERY-STARTED state=${bot.deleteState}`,
    );
    try {
      await deleteBotCompletely(bot, 'recovery');
    } catch (error) {
      console.error(
        `${auditTag(bot.id, 'recovery')} RECOVERY-FAILED: ${error?.message ?? error}`,
      );
    }
  }
};

/* ------------------------------- HTTP ------------------------------- */
const normaliseConfig = (input, existing) => {
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) throw httpError(400, 'Name fehlt');
  if (name.length > 40)
    throw httpError(400, 'Name ist zu lang (max. 40 Zeichen)');
  const language = getLanguage(input.language ?? existing?.language);
  if (!input.language && !existing) throw httpError(400, 'Sprache fehlt');
  return {
    name,
    emoji: String(input.emoji ?? existing?.emoji ?? '🤖').slice(0, 4) || '🤖',
    description: String(input.description ?? existing?.description ?? '').slice(
      0,
      160,
    ),
    language: input.language ?? existing.language,
    framework: String(
      input.framework ?? existing?.framework ?? language.frameworks[0].name,
    ).slice(0, 40),
    entrypoint: String(
      input.entrypoint ?? existing?.entrypoint ?? language.entrypoint,
    ).slice(0, 200),
    command: String(
      input.command ?? existing?.command ?? language.command,
    ).slice(0, 300),
    cwd: String(input.cwd ?? existing?.cwd ?? '.').slice(0, 200),
    guildId: String(input.guildId ?? existing?.guildId ?? '').slice(0, 40),
    autoRestart: Boolean(input.autoRestart ?? existing?.autoRestart ?? false),
    autoInstall: Boolean(input.autoInstall ?? existing?.autoInstall ?? true),
    depsCheck: String(input.depsCheck ?? existing?.depsCheck ?? '').slice(
      0,
      300,
    ),
    depsInstall: String(input.depsInstall ?? existing?.depsInstall ?? '').slice(
      0,
      300,
    ),
    maxRestarts: Math.min(
      20,
      Math.max(0, Number(input.maxRestarts ?? existing?.maxRestarts ?? 5)),
    ),
    env: input.env ?? existing?.env ?? {},
    secretEnv: secretValues(existing ?? {}, input.secretEnv),
  };
};

/**
 * Zentraler Bot-Löschworkflow: genau eine Stelle kennt die Reihenfolge, kein
 * duplizierter Cleanup anderswo.
 *
 * Persistenter Lifecycle: `deleting` wird VOR dem ersten irreversiblen
 * Schritt gesetzt und sofort persistiert (atomar), `cleanup_failed` bei
 * Teilfehlern ebenfalls. Beide Zustände sperren Start/Restart/Schreibzugriffe
 * – auch über Hub-Neustarts hinweg, bis Recovery den Cleanup vollendet.
 * Phase B widerruft sofort alle Tokens/Sessions (gilt auch bei späterem
 * Fehler), danach folgen C Runtime-Stopp, D DB, E Secrets, F Dateien,
 * G Access-Bereinigung und H finale Persistenz. Antwort 200 nur bei
 * vollständigem Erfolg, sonst 500 mit cleanupErrors – der Bot bleibt
 * gesperrt und erneut löschbar, alle Schritte sind idempotent.
 */
const auditTag = (id, actor) =>
  `[hub] BOT_DELETE bot=${id} actor=${actor ?? '-'} ts=${new Date().toISOString()}`;

/* Go-Modul-Cache & Co. lagern ihre Dateien in Verzeichnissen mit Modus
 * 0555 – bewusst schreibgeschützt. Ohne Owner-Schreibbit scheitern dort
 * sowohl unlink als auch rmdir, und die Bot-Löschung blieb mit EACCES
 * stehen (Maßnahme 32). Vor dem Entfernen erhalten deshalb alle
 * Verzeichnisse im (längst validierten) Bot-Ordner das Owner-Schreibbit;
 * symlinks und tiefer als 64 Ebenen wird nicht gefolgt. Einzelpfade
 * scheitern still – die folgende rm-Spur entscheidet über Erfolg oder
 * Cleanup-Fehler. */
export const openDirsForRemoval = (root, depth = 0) => {
  if (depth > 64) return;
  try {
    const st = lstatSync(root);
    if (!st.isDirectory()) return;
    chmodSync(root, st.mode | 0o700);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink())
        openDirsForRemoval(join(root, entry.name), depth + 1);
    }
  } catch {
    /* restlos ignorieren: wenn schon das Begehen klemmt, muss rm selbst
     * sehen, ob es ohne weiterkommt – der attempt-Wrapper meldet es. */
  }
};

const deleteBotCompletely = async (bot, actor) => {
  const id = bot.id;
  // Fail-fast vor jeder irreversiblen Aktion: eine ungültige ID darf nicht
  // erst Tokens widerrufen und dann am Dateischritt scheitern.
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ||
    id === '.' ||
    id === '..'
  )
    throw httpError(500, 'Bot-Verzeichnis ist ungültig');
  const tag = auditTag(id, actor);
  console.log(`${tag} STARTED`);
  deletingBots.add(id);
  const fail = (steps) => {
    const failure = httpError(
      500,
      `Bot konnte nicht vollständig gelöscht werden (${steps.map((entry) => entry.step).join(', ')}). Erneut versuchen – der Cleanup ist idempotent.`,
    );
    failure.cleanupErrors = steps;
    failure.deleted = false;
    failure.botId = id;
    failure.deleteStatus = 'cleanup_failed';
    return failure;
  };
  const markFailed = (steps) => {
    // Persistenter cleanup_failed-State: Bot bleibt gesperrt, bis ein
    // erneuter DELETE (oder Recovery nach Neustart) ihn vollendet.
    bot.deleteState = 'cleanup_failed';
    try {
      dirty.add(id);
      flush(true);
    } catch (error) {
      console.error(
        `${tag} FAILED step=persist-state: ${error?.message ?? error}`,
      );
    }
  };
  // Lifecycle zuerst persistieren: Stürzt der Hub danach ab, findet Recovery
  // den Bot als `deleting` und vollendet den Cleanup nach dem Neustart.
  const previousState = bot.deleteState ?? 'active';
  bot.deleteState = 'deleting';
  try {
    dirty.add(id);
    flush(true);
  } catch (error) {
    bot.deleteState = previousState;
    deletingBots.delete(id);
    console.error(
      `${tag} FAILED step=persist-state: ${error?.message ?? error}`,
    );
    throw fail([
      { step: 'persist-state', error: error?.message ?? String(error) },
    ]);
  }
  const cleanupErrors = [];
  const attempt = async (step, task) => {
    try {
      await task();
    } catch (error) {
      // Antwortfähig machen: absolute Serverpfade gehören nicht in
      // API-Antworten (nur Schritt + bereinigte Meldung).
      const message = String(error?.message ?? error)
        .split(PROJECT_ROOT)
        .join('[hub]');
      cleanupErrors.push({ step, error: message });
    }
  };
  try {
    await attempt('sessions', async () => {
      revokeBotSessions(id);
      clearBotUploadState(id);
    });
    await attempt('stop', async () => stopBot(id, { signal: 'SIGKILL' }));
    if (containerRuntimeEnabled())
      await attempt('container', async () => removeContainer(bot));
    await attempt('database', async () => database().removeBot(id));
    await attempt('secrets', async () => removeSecretValues(PROJECT_ROOT, id));
    await attempt('files', async () => {
      // Nur ein direktes Kind von bots/ darf entfernt werden; ein
      // fehlerhafter gespeicherter Pfad darf niemals auf andere Hub-Dateien
      // zeigen. lstat + rm entfernt einen möglichen Link selbst, nie dessen
      // Ziel.
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) ||
        id === '.' ||
        id === '..'
      )
        throw new Error('Bot-Verzeichnis ist ungültig');
      const botsPath = join(PROJECT_ROOT, 'bots');
      if (!existsSync(botsPath)) return;
      const projectRoot = realpathSync(PROJECT_ROOT);
      const botsRoot = realpathSync(botsPath);
      const relativeBotsRoot = relative(projectRoot, botsRoot);
      if (
        !relativeBotsRoot ||
        relativeBotsRoot === '..' ||
        relativeBotsRoot.startsWith(`..${sep}`) ||
        isAbsolute(relativeBotsRoot)
      )
        throw new Error('Bot-Verzeichnis liegt außerhalb des Bot-Hubs');
      const botDirectory = join(botsRoot, id);
      const relativeBotDirectory = relative(botsRoot, botDirectory);
      if (
        !relativeBotDirectory ||
        relativeBotDirectory === '..' ||
        relativeBotDirectory.startsWith(`..${sep}`) ||
        isAbsolute(relativeBotDirectory)
      )
        throw new Error('Bot-Verzeichnis ist ungültig');
      try {
        lstatSync(botDirectory);
        openDirsForRemoval(botDirectory);
        rmSync(botDirectory, { recursive: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    });
    await attempt('access', async () => purgeBotAccess(id));
    if (cleanupErrors.length) {
      // Teilfehler: Bot bleibt gesperrt im Bestand (persistent
      // cleanup_failed, nie zurück in einen normalen Zustand), damit ein
      // erneuter DELETE – oder Recovery nach Neustart – den idempotenten
      // Cleanup wiederholen kann.
      for (const { step, error } of cleanupErrors)
        console.error(`${tag} FAILED step=${step}: ${error}`);
      markFailed(cleanupErrors);
      throw fail(cleanupErrors);
    }
    // Lesende Panel-Anfragen dürfen während des Deletes fertiglaufen und dabei
    // Manifest-Caches neu befüllen. Deshalb nach den letzten Await-Punkten
    // sämtliche Runtime-Zustände ein zweites Mal entfernen.
    revokeBotSessions(id);
    clearBotUploadState(id);
    try {
      bots.delete(id);
      dirty.add(id);
      flush(true);
    } catch (error) {
      // Persistenzfehlschlag: Bot zurück in den Bestand und sperren, damit
      // kein scheinbar normaler Bot mit gelöschten Dateien/DB zurückbleibt.
      bots.set(id, bot);
      console.error(`${tag} FAILED step=persist: ${error?.message ?? error}`);
      const steps = [
        { step: 'persist', error: error?.message ?? String(error) },
      ];
      markFailed(steps);
      throw fail(steps);
    }
  } finally {
    deletingBots.delete(id);
  }
  console.log(`${tag} COMPLETED`);
  broadcast('deleted', { id });
  return { deleted: true, botId: id, status: 'deleted' };
};

/**
 * Der Startordner über HTTP.
 *
 *   GET    /api/bots/:id/files?pfad=…        einen Ordner auflisten
 *   GET    /api/bots/:id/files/<pfad>       eine Datei lesen
 *   PUT    /api/bots/:id/files/<pfad>       schreiben, dann spiegeln
 *   DELETE /api/bots/:id/files/<pfad>       löschen, dann spiegeln
 *   POST   /api/bots/:id/files              Ordner anlegen oder übernehmen
 *
 * `DELETE` unterscheidet nicht zwischen Datei und Ordner: was der Explorer als
 * eine Zeile zeigt, wird als ein Zug gelöscht. Im Workspace verschwindet
 * danach nur, was der Hub selbst dorthin geschrieben hat – die Merkliste
 * entscheidet das, nicht die Anfrage.
 *
 * Der Pfad wird aus dem Pfadnamen der URL gelesen und wieder zusammengesetzt –
 * jeder Abschnitt einzeln dekodiert, damit ein Schrägstrich in einem Dateinamen
 * nicht still zu einem Unterordner wird.
 *
 * Jeder schreibende Zugang spiegelt sofort. Das ist die Zusage an den
 * Betreiber: was er hier hochlädt, ist danach im Workspace, ohne dass er noch
 * irgendetwas anklicken muss. Nach dem Schreiben wird gespiegelt, nicht vorher
 * – ein Fehler beim Spiegeln darf die Datei nicht verschlucken, und der
 * Betreiber sieht die Meldung statt eines verschwundenen Uploads.
 */
const handleFileRoutes = async (req, res, url, bot) => {
  const praefix = `/api/bots/${bot.id}/files`;
  if (!url.pathname.startsWith(praefix)) return false;

  const rest = url.pathname.slice(praefix.length);
  const pfad = rest
    .split('/')
    .filter(Boolean)
    .map((teil) => safeDecode(teil))
    .join('/');

  /** Der Ordner, den eine Liste zeigen soll – aus der Anfrage, sonst die Wurzel. */
  const gewaehlterOrdner = () => url.searchParams.get('pfad') ?? '';

  const auflisten = (antwort) => {
    const inhalt = dateien.list(bot, PROJECT_ROOT, gewaehlterOrdner());
    // Die Liste ist die Antwort, kein Beiwerk: sie geht bei jedem Schreibvorgang
    // mit, damit die Oberfläche nach einem Löschen nicht mit einem Bildschirm
    // voller Einträge zurückbleibt, die es nicht mehr gibt.
    if (!inhalt) throw httpError(404, 'Dieser Ordner gibt es nicht (mehr)');
    return sendJson(res, antwort.status, { ...antwort.body, ...inhalt });
  };

  const braucht = (recht) => {
    if (!hasPermission(req, recht, { botId: bot.id }))
      throw httpError(403, `Berechtigung fehlt: ${recht}`);
  };

  if (!pfad) {
    if (req.method === 'GET') {
      braucht('files.read');
      return auflisten({
        status: 200,
        body: { startordner: dateien.startFolderOf(bot) },
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req, MAX_FILE_BODY_BYTES);
      if (body.uebernehmen === true || body.ordner === undefined) {
        braucht('files.write');
        const files = await withBotLifecycleLock(bot.id, async () => {
          assertNotDeleting(bot);
          return uebernehmen(bot);
        });
        return sendJson(res, 200, { files });
      }
      braucht('files.write');
      const ok = await withBotLifecycleLock(bot.id, async () => {
        assertNotDeleting(bot);
        return dateien.withBotLock(bot.id, async () => {
          if (
            typeof body.ordner !== 'string' ||
            !dateien.makeDir(bot, PROJECT_ROOT, body.ordner)
          )
            return false;
          return true;
        });
      });
      if (!ok) throw httpError(400, 'Dieser Ordner kann nicht angelegt werden');
      return auflisten({ status: 201, body: { angelegt: body.ordner } });
    }
    throw httpError(405, 'Methode nicht erlaubt');
  }

  if (req.method === 'GET') {
    braucht('files.read');
    const datei = dateien.read(bot, PROJECT_ROOT, pfad);
    if (!datei) throw httpError(404, 'Datei nicht gefunden');
    return sendJson(res, 200, { pfad, ...datei });
  }
  if (req.method === 'PUT') {
    // Bot-Dateien können durch eigene Startbefehle oder Paket-Skripte
    // ausführbar sein. Quelltext ändern ist deshalb auch eine Laufzeitaktion.
    braucht('files.write');
    braucht('bots.control');
    const slot = takeUploadSlot(req, url);
    if (slot instanceof Error) throw slot;
    // withBotLock serialisiert COUNT → prüfen → write (race-safe Quota).
    try {
      const body = await readBody(req, MAX_FILE_BODY_BYTES);
      // Nur Text. Binärdaten (Bilder, .jar) haben hier keinen Platz, und eine
      // Base64-Hülle täuscht hier eine Dateigrösse vor, die keine ist.
      if (typeof body.inhalt !== 'string')
        throw httpError(400, 'Nur Textdateien sind erlaubt');
      const incoming = Buffer.byteLength(body.inhalt, 'utf8');
      const geschrieben = await withBotLifecycleLock(bot.id, async () => {
        assertNotDeleting(bot);
        const limited = takeUploadBytes(req, url, incoming);
        if (limited) throw limited;
        return dateien.withBotLock(bot.id, async () =>
          dateien.write(bot, PROJECT_ROOT, pfad, body.inhalt),
        );
      });
      if (!geschrieben)
        throw httpError(
          400,
          'Diese Datei kann nicht geschrieben werden (Quota, Pfad oder Typ prüfen)',
        );
      return auflisten({
        status: 200,
        body: { pfad, files: uebernehmen(bot) },
      });
    } finally {
      releaseUploadSlot(typeof slot === 'string' ? slot : null);
    }
  }
  if (req.method === 'DELETE') {
    braucht('files.delete');
    const ergebnis = await withBotLifecycleLock(bot.id, async () => {
      assertNotDeleting(bot);
      return dateien.withBotLock(bot.id, async () =>
        dateien.remove(bot, PROJECT_ROOT, pfad),
      );
    });
    if (!ergebnis) throw httpError(404, 'Datei oder Ordner nicht gefunden');
    if (ergebnis.ueberlimit)
      throw httpError(
        413,
        `Das sind mehr als ${dateien.MAX_REMOVE_ENTRIES} Einträge. Lösch den Ordner auf dem Server – dort ist es ein Befehl statt einer Anfrage.`,
      );
    return auflisten({
      status: 200,
      body: {
        pfad,
        entfernt: ergebnis.eintraege,
        ordnerGeloescht: ergebnis.ordner,
        files: uebernehmen(bot),
      },
    });
  }
  throw httpError(405, 'Methode nicht erlaubt');
};

const handleApi = async (req, res, url) => {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, action] = segments;

  if (resource === 'auth') {
    const handled = await handleAuthRoutes(req, res, url, sendJson, httpError);
    if (handled !== false) return handled;
    throw httpError(404, 'Unbekannter Auth-Endpunkt');
  }

  const panelIdentity =
    resource === 'bots' && id && action === 'panel' ? identify(req, url) : null;
  const panelTokenAuth =
    panelIdentity?.scope === 'panel' && panelIdentity.id === id;
  const isPanelDiscordAuthRoute =
    req.method === 'GET' &&
    /^\/api\/bots\/[^/]+\/panel\/discord\/(?:config|login|callback)$/.test(
      url.pathname,
    );
  const isPanelStaticAsset =
    req.method === 'GET' &&
    /^\/api\/bots\/[^/]+\/panel\/(?:bridge\.js|file\/.+)$/.test(url.pathname);

  if (
    req.headers.origin === 'null' &&
    /^\/api\/bots\/[^/]+\/panel(?:\/|$)/.test(url.pathname) &&
    !panelTokenAuth &&
    !isPanelDiscordAuthRoute &&
    !isPanelStaticAsset
  )
    throw httpError(403, 'Panel-Token erforderlich');

  // Panel- und Unterseiten bleiben immer an die zentrale Hub-Session
  // gebunden. Das Panel-Token ergänzt nur die Rechte der eingebetteten
  // Bot-Seite; es ersetzt die Hauptanmeldung nicht.
  // Ein gültiger Panel-Token darf die Bot-Seite auch ohne zentrale
  // Hub-Anmeldung öffnen. Ein Panel mit lokaler OAuth-Konfiguration erzwingt
  // seine eigene Discord-Anmeldung gezielt an den schreibenden Aktionen.
  if (requiresAuthentication(req, url) && !panelTokenAuth)
    throw httpError(401, 'Discord-Anmeldung erforderlich');

  const permission = (name, botId = null) => {
    if (!hasPermission(req, name, botId ? { botId } : {}))
      throw httpError(403, `Berechtigung fehlt: ${name}`);
  };

  if (resource === 'access') {
    permission('access.manage');
    if (!id && req.method === 'GET')
      return sendJson(res, 200, accessState(req));
    if (id && req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, {
          user: updateAccess(id, body, currentUser(req)?.id),
        });
      } catch (error) {
        throw httpError(400, error.message);
      }
    }
    if (id && req.method === 'DELETE') {
      try {
        removeAccess(id, currentUser(req)?.id);
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        throw httpError(400, error.message);
      }
    }
    throw httpError(405, 'Methode nicht erlaubt');
  }

  if (resource === 'health') return sendJson(res, 200, { ok: true });

  if (resource === 'languages') {
    permission('bots.read');
    return sendJson(res, 200, { languages: LANGUAGES });
  }

  // Vom Bot selbst aufgerufen – Identität läuft über BOT_HUB_TOKEN.
  if (resource === 'hub')
    return handleHubRoutes(req, res, url, (id) => bots.get(id));

  if (resource === 'events') {
    permission('bots.read');
    if (process.env.BOT_HUB_TEST_MODE !== '1') {
      const ip = String(req.socket.remoteAddress ?? 'unknown');
      const cookie = String(req.headers.cookie ?? '');
      const sessionMatch =
        cookie
          .split(';')
          .map((p) => p.trim())
          .find((p) => p.startsWith('bot_hub_session=')) ?? ip;
      const MAX_DASHBOARD_SSE_PER_IP = 10;
      const MAX_DASHBOARD_SSE_PER_SESSION = 3;
      let perIp = 0;
      let perSession = 0;
      for (const entry of listeners) {
        if (entry?.__sseIp === ip) perIp += 1;
        if (entry?.__sseSession === sessionMatch) perSession += 1;
      }
      if (
        perIp >= MAX_DASHBOARD_SSE_PER_IP ||
        perSession >= MAX_DASHBOARD_SSE_PER_SESSION
      ) {
        const error = httpError(
          429,
          'Zu viele Live-Verbindungen – bitte eine schließen.',
        );
        error.retryAfter = 10;
        throw error;
      }
      res.__sseIp = ip;
      res.__sseSession = sessionMatch;
    }
    // Die Anfrage bleibt am Client gespeichert: Log-Ereignisse werden pro Bot
    // gegen die logs.read-Rechte genau dieses Clients gefiltert.
    res.__sseReq = req;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    res.write(
      `event: snapshot\ndata: ${JSON.stringify({ bots: [...bots.values()].map(publicBot) })}\n\n`,
    );
    listeners.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 20000);
    req.on('close', () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return undefined;
  }

  if (resource === 'logs') {
    const rawTail = url.searchParams.get('tail') ?? '200';
    const tail = Number(rawTail);
    if (!Number.isInteger(tail) || tail < 1 || tail > 500)
      throw httpError(400, 'tail muss eine ganze Zahl zwischen 1 und 500 sein');
    const scope = id ? bots.get(id) : null;
    if (id && !scope) throw httpError(404, 'Bot nicht gefunden');
    if (scope) {
      if (!hasPermission(req, 'logs.read', { botId: scope.id }))
        throw httpError(403, 'Berechtigung fehlt: logs.read');
    } else if (
      !hasPermission(req, 'bots.manage') &&
      !hasPermission(req, 'logs.read.global')
    ) {
      throw httpError(403, 'Globale Log-Berechtigung fehlt');
    }
    const source = scope
      ? scope.logs
      : [...bots.values()].flatMap((b) => b.logs);
    const lines = source
      .slice(-tail)
      .sort((a, b) => a.ts - b.ts)
      .map((line) => ({ ...line, text: redactLogSecrets(line.text) }));
    return sendJson(res, 200, { lines });
  }

  if (resource === 'bots') {
    if (!id) {
      if (req.method === 'GET') permission('bots.read');
      if (req.method === 'GET')
        return sendJson(res, 200, { bots: [...bots.values()].map(publicBot) });
      if (req.method === 'POST') {
        permission('bots.manage');
        // Body erst vollständig lesen und validieren, bevor ein Slot belegt
        // wird. Ein langsamer oder ungültiger Request darf die Bot-Kapazität
        // nicht während des gesamten Body-Uploads reservieren.
        const body = await readBody(req);
        const config = normaliseConfig(body, null);
        // P1-H: Prüfen und Reserven in einem Synchronzug – zwischen `if` und
        // `+=` darf kein await liegen, sonst sehen parallele Requests erneut
        // dieselbe freie Kapazität.
        if (bots.size + pendingBotCreations >= MAX_BOTS)
          throw httpError(429, `Maximal ${MAX_BOTS} Bots`);
        pendingBotCreations += 1;
        let angelegterWorkspace = '';
        try {
          const id = randomUUID();
          if (process.env.BOT_HUB_TEST_MODE !== '1') {
            const workspaceRoot = `bots/${id}/workspace`;
            mkdirSync(resolve(PROJECT_ROOT, workspaceRoot), {
              recursive: true,
              mode: 0o700,
            });
            angelegterWorkspace = workspaceRoot;
            config.workspaceRoot = workspaceRoot;
            if (!safeBotPath({ id, workspaceRoot }, config.cwd))
              throw httpError(
                400,
                'Der Startordner muss im eigenen Workspace des Bots liegen',
              );
          }
          const bot = hydrate({ ...config, id });
          syncBotEnv(bot);
          bots.set(id, bot);
          // Ab hier zählt der Bot in `bots.size` mit – das Workspace gehört
          // zum Bot und darf im Fehlerfall nicht mehr wegradiert werden.
          angelegterWorkspace = '';
          // Neuer Bot: Beispiel-Webseite (bot-hub.json + panel/) anlegen,
          // dann in den Workspace spiegeln. Bestehende Dateien bleiben.
          // Fehler brechen das Anlegen nicht ab (der Bot ist auch ohne Beispiel
          // vollständig), werden aber geloggt und in der Antwort gemeldet.
          let scaffold = { created: [], skipped: [] };
          try {
            scaffold = ensurePanelScaffold(bot, PROJECT_ROOT);
            if (scaffold.error)
              console.warn(
                `[hub] Beispiel-Webseite für ${id} unvollständig: ${scaffold.error}`,
              );
          } catch (error) {
            scaffold = {
              created: [],
              skipped: [],
              error: error?.message ?? String(error),
            };
            console.warn(
              `[hub] Beispiel-Webseite für ${id} fehlgeschlagen: ${scaffold.error}`,
            );
          }
          uebernehmen(bot);
          setStatus(bot, 'stopped');
          const fresh = publicBot(bot);
          broadcast('created', fresh);
          return sendJson(res, 201, { bot: fresh, scaffold });
        } catch (error) {
          // Fehlgeschlagene Erstellung: das halbe Workspace wegräumen, damit
          // kein verwaister Ordner ohne Bot-Eintrag zurückbleibt.
          if (angelegterWorkspace) {
            try {
              rmSync(resolve(PROJECT_ROOT, angelegterWorkspace), {
                recursive: true,
                force: true,
              });
              rmSync(dirname(resolve(PROJECT_ROOT, angelegterWorkspace)), {
                force: true,
              });
            } catch {
              /* Aufräumen ist best-effort; der Slot wird trotzdem frei. */
            }
          }
          throw error;
        } finally {
          // Der Slot wird in jedem Pfad freigegeben – nach bots.set zählt der
          // Bot über die Map mit, vorher befreit der Fehlerfall die Reserve.
          pendingBotCreations -= 1;
        }
      }
      throw httpError(405, 'Methode nicht erlaubt');
    }

    const bot = bots.get(id);
    if (!bot) throw httpError(404, 'Bot nicht gefunden');

    if (!action && req.method === 'GET') permission('bots.read');
    if (!action && req.method === 'GET')
      return sendJson(res, 200, { bot: publicBot(bot) });
    if (!action && req.method === 'PATCH') {
      permission('bots.manage');
      const body = await readBody(req);
      const config = normaliseConfig(body, bot);
      if (!safeBotPath(bot, config.cwd))
        throw httpError(
          400,
          'Der Startordner muss im eigenen Workspace des Bots liegen',
        );
      // Vor der Konfiguration, nicht danach: der Startordner ist die Quelle,
      // und eine halb gespeicherte Konfiguration über halb kopierten Dateien
      // ist die unangenehmere Hälfte davon.
      const result = await withBotLifecycleLock(bot.id, async () => {
        assertNotDeleting(bot);
        if (bots.get(bot.id) !== bot)
          throw httpError(404, 'Bot nicht gefunden');
        const uebernommen = uebernehmen(bot);
        const nextBot = { ...bot, ...config };
        syncBotEnv(nextBot);
        Object.assign(bot, config, { updatedAt: Date.now() });
        bot.restartCount = 0;
        dirty.add(bot.id);
        schedulePersist();
        const updated = publicBot(bot);
        broadcast('bot', updated);
        return { bot: updated, files: uebernommen };
      });
      return sendJson(res, 200, result);
    }
    if (!action && req.method === 'DELETE') {
      permission('bots.delete');
      // P1-J: Vor dem Warten auf den Lifecycle-Lock die laufende Installation
      // beenden und ihr Ende abfragen – sonst hängt DELETE hinter einer
      // npm/pip-Installation, die Minuten laufen kann. deletePending sperrt
      // derweil jede neue Installation und jeden weiteren Schritt.
      deletePending.add(bot.id);
      try {
        await abortActiveOperation(bot);
        const result = await withBotLifecycleLock(bot.id, async () => {
          assertNoDeleteInFlight(bot);
          if (bots.get(bot.id) !== bot)
            throw httpError(404, 'Bot nicht gefunden');
          return deleteBotCompletely(bot, currentUser(req)?.id ?? null);
        });
        return sendJson(res, 200, result);
      } finally {
        deletePending.delete(bot.id);
      }
    }
    if (action === 'start' && req.method === 'POST') {
      permission('bots.control');
      const started = await withBotLifecycleLock(id, async () => {
        assertNotDeleting(bot);
        if (bots.get(id) !== bot) throw httpError(404, 'Bot nicht gefunden');
        prepareStart(bot);
        setStatus(bot, 'checking', { pid: null, stoppedAt: Date.now() });
        return publicBot(bot);
      });
      withBotLifecycleLock(id, async () => {
        assertNotDeleting(bot);
        if (bots.get(id) !== bot) return;
        await startBot(id);
      }).catch((error) => {
        if (!bots.has(id) || isDeleteLocked(bot)) return;
        pushLine(id, 'system', `Start fehlgeschlagen: ${error.message}`);
        setStatus(bot, 'error', { exitCode: -1, pid: null });
      });
      return sendJson(res, 202, { bot: started });
    }
    if (action === 'files') {
      // File APIs authorize against the requested bot and the operation's
      // files.read/write/delete permission inside handleFileRoutes.
      if (req.method !== 'GET') assertNotDeleting(bot);
      const handled = await handleFileRoutes(req, res, url, bot);
      if (handled !== false) return handled;
      throw httpError(404, 'Unbekannter Datei-Endpunkt');
    }

    if (action === 'install' && req.method === 'POST') {
      permission('bots.manage');
      // P1-J: Ein vorbereiteter oder laufender Delete blockiert neue
      // Installationen schon vor der Antwort mit 202 – nicht erst in der
      // Lock-Übernahme, die der Anfragende nie zu sehen bekäme.
      assertNotDeleting(bot);
      const dir = safeBotPath(bot, bot.cwd);
      if (!dir)
        throw httpError(
          400,
          'Der Startordner liegt ausserhalb des Workspace dieses Bots',
        );
      if (bot.busy) throw httpError(409, 'Installation läuft bereits');
      const body = await readBody(req);
      const { language, install } = depsFor(bot);
      if (!language.check || !install) {
        throw httpError(
          400,
          `Für ${language.label} ist keine automatische Installation hinterlegt`,
        );
      }
      withBotLifecycleLock(id, async () => {
        assertNotDeleting(bot);
        if (bots.get(id) !== bot) return;
        if (bot.busy) throw httpError(409, 'Installation läuft bereits');
        setStatus(bot, 'checking', { depsStatus: 'checking' });
        try {
          await installDependencies(bot, dir, { force: body.force === true });
        } catch (error) {
          console.error('[hub] Installation fehlgeschlagen:', error);
          if (!isDeleteLocked(bot)) setStatus(bot, 'error', { exitCode: -1 });
        }
      }).catch((error) => {
        if (error.status !== 409 && !isDeleteLocked(bot))
          console.error('[hub] Installation fehlgeschlagen:', error);
      });
      return sendJson(res, 202, { bot: publicBot(bot) });
    }
    if (action === 'stop' && req.method === 'POST') {
      permission('bots.control');
      // P1-J: Stop wartet nicht das Ende einer Installation ab – der
      // Installationsprozess wird zuerst terminiert; der Lock wird dadurch
      // in Sekunden frei, und stopBot räumt ohnehin final auf.
      if (bot.busy) killTree(bot.busy, 'SIGTERM');
      const stopped = await withBotLifecycleLock(id, async () => {
        assertNotDeleting(bot);
        return stopBot(id);
      });
      return sendJson(res, 200, { bot: stopped });
    }
    if (action === 'kill' && req.method === 'POST') {
      permission('bots.control');
      // P1-J: wie stop, nur sofort hart.
      if (bot.busy) killTree(bot.busy, 'SIGKILL');
      const stopped = await withBotLifecycleLock(id, async () => {
        assertNotDeleting(bot);
        return stopBot(id, { signal: 'SIGKILL' });
      });
      return sendJson(res, 200, { bot: stopped });
    }
    if (action === 'restart' && req.method === 'POST') {
      permission('bots.restart');
      const restarted = await withBotLifecycleLock(id, async () => {
        assertNotDeleting(bot);
        stopBot(id, { signal: 'SIGTERM' });
        const target = bots.get(id);
        if (target) {
          const waitForExit = setInterval(() => {
            if (!target.child) {
              clearInterval(waitForExit);
              setTimeout(() => {
                withBotLifecycleLock(id, async () => {
                  if (bots.get(id) === target && !isDeleteLocked(target))
                    await startBot(id);
                }).catch(() => {});
              }, 300);
            }
          }, 100);
        }
        return publicBot(bots.get(id));
      });
      return sendJson(res, 200, { bot: restarted });
    }
    if (action === 'logs' && req.method === 'GET') {
      if (!hasPermission(req, 'logs.read', { botId: bot.id }))
        throw httpError(403, 'Berechtigung fehlt: logs.read');
      const rawTail = url.searchParams.get('tail') ?? '300';
      const tail = Number(rawTail);
      if (!Number.isInteger(tail) || tail < 1 || tail > 500)
        throw httpError(
          400,
          'tail muss eine ganze Zahl zwischen 1 und 500 sein',
        );
      return sendJson(res, 200, {
        lines: bot.logs
          .slice(-tail)
          .map((line) => ({ ...line, text: redactLogSecrets(line.text) })),
      });
    }
    if (action === 'panel') {
      // Lesende Panel-Zugriffe bleiben während eines Löschvorgangs erlaubt,
      // alles Schreibende (Settings, Commands, State, Login/Logout) nicht.
      if (req.method !== 'GET') assertNotDeleting(bot);
      if (req.method === 'GET' && url.pathname.endsWith('/panel/open')) {
        permission('panel.read');
        ensurePanel(bot);
        const manifest = bot.panel?.manifest;
        const requested = url.searchParams.get('page') ?? '';
        const allowed = [
          manifest?.entry,
          ...(manifest?.pages ?? []).map((page) => page.href),
        ].filter(Boolean);
        const href = allowed.includes(requested) ? requested : allowed[0];
        if (!href) throw httpError(404, 'Keine Bot-Seite verfügbar');
        const path = href
          .split('/')
          .map((part) => encodeURIComponent(part))
          .join('/');
        // Absolut und auf der Adresse, die auch den Discord-Callback bekommt:
        // Das Voranmeldungs-Cookie des Logins gilt nur für diesen Host.
        res.writeHead(302, {
          location: `${panelPageOrigin(bot)}/api/bots/${encodeURIComponent(
            bot.id,
          )}/panel/file/${path}?bootstrap=${encodeURIComponent(
            issuePanelBootstrapToken(bot.id),
          )}`,
          'set-cookie': [
            `bot_hub_panel_access_${bot.id}=${panelToken(
              bot.id,
            )}; Max-Age=3600; Path=/api/bots/${encodeURIComponent(
              bot.id,
            )}/panel; HttpOnly; SameSite=Lax${
              secureCookies() ? '; Secure' : ''
            }`,
          ],
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        return res.end();
      }
      if (isPanelDiscordAuthRoute) {
        if (!panelTokenAuth) permission('panel.read');
        return handlePanelRoutes(bot, req, res, url);
      }
      if (isPanelStaticAsset) {
        // Statische Dateien werden in standalone Seiten ohne Origin-Header
        // sowie in Sandbox-Dokumenten ohne Session-Cookie geladen. Die
        // Route prüft Pfad, Dateiendung und sensible Dateinamen separat;
        // Panel-API und Schreibzugriffe bleiben token-/sessiongeschützt.
        return handlePanelRoutes(bot, req, res, url, panelTokenAuth, true);
      }
      if (panelTokenAuth)
        // Das Panel-Token allein darf nur lesen sowie State und Meldungen
        // senden. Einstellungen schreiben und Befehle ausführen verlangt
        // zusätzlich die zentrale Hub-Sitzung mit panel.manage für
        // diesen Bot; ohne sie antwortet die Panel-API mit 403.
        return handlePanelRoutes(
          bot,
          req,
          res,
          url,
          true,
          false,
          hasPermission(req, 'panel.manage', { botId: bot.id }),
        );
      const panelLogout =
        req.method === 'POST' && /\/panel\/discord\/logout$/.test(url.pathname);
      permission(
        req.method === 'GET' || panelLogout ? 'panel.read' : 'panel.manage',
      );
      return handlePanelRoutes(bot, req, res, url);
    }
    throw httpError(405, 'Methode nicht erlaubt');
  }

  throw httpError(404, 'Unbekannter API-Endpunkt');
};

/**
 * Die Oberfläche lädt ausschließlich eigene Dateien. `frame-ancestors 'none'`
 * verhindert zusätzlich, dass eine fremde Seite das Dashboard einbettet und
 * dort Klicks auf Start, Stopp oder Löschen vortäuscht.
 */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

const serveStatic = (req, res, url) => {
  const dist = join(PROJECT_ROOT, 'dist');
  let requested;
  let root;
  try {
    requested = decodeURIComponent(url.pathname);
    root = realpathSync(dist);
  } catch (error) {
    if (error instanceof URIError) throw httpError(400, 'Ungültiger URL-Pfad');
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Frontend nicht gebaut – bitte "npm run build" ausführen.');
  }

  const candidate =
    requested === '/'
      ? join(root, 'index.html')
      : resolve(root, `.${requested}`);
  const candidateRelative = relative(root, candidate);
  if (candidateRelative.startsWith('..') || isAbsolute(candidateRelative)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Datei nicht gefunden.');
  }

  let resolvedCandidate;
  try {
    resolvedCandidate = realpathSync(candidate);
  } catch {
    resolvedCandidate = null;
  }
  const resolvedRelative = resolvedCandidate
    ? relative(root, resolvedCandidate)
    : '';
  const target =
    resolvedCandidate &&
    !resolvedRelative.startsWith('..') &&
    !isAbsolute(resolvedRelative) &&
    statSync(resolvedCandidate).isFile()
      ? resolvedCandidate
      : join(root, 'index.html');
  if (!existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Frontend nicht gebaut – bitte "npm run build" ausführen.');
  }
  const ext = target.slice(target.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    'content-security-policy': APP_CSP,
    'x-frame-options': 'DENY',
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(readFileSync(target));
};

/* ------------------------------------------------------------------ *
 * Browser-API-Aufrufe bleiben Same-Origin. Opaque Panel-Dokumente erhalten
 * CORS nur für statische Dateien, die sie zum Laden von ES-Modulen brauchen.
 * ------------------------------------------------------------------ */
const sameHost = (origin, host) => {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};

const isPanelStaticRoute = (pathname) =>
  /^\/api\/bots\/[^/]+\/panel\/(?:bridge\.js|file\/.+)$/.test(pathname);

const isPanelApiRoute = (pathname) =>
  /^\/api\/bots\/[^/]+\/panel(?:\/|$)/.test(pathname);

const applyCors = (req, res, url) => {
  const origin = req.headers.origin;
  if (!origin) return true; // kein Browser (Bot, curl, Tests)
  if (sameHost(origin, req.headers.host)) return true; // Same-Origin
  if (
    origin === 'null' &&
    (isPanelStaticRoute(url.pathname) || isPanelApiRoute(url.pathname))
  ) {
    res.setHeader('access-control-allow-origin', 'null');
    // Kein allow-credentials: Die Bridge authentifiziert über die Header
    // x-bot-hub-token und x-bot-hub-bootstrap, nie über Cookies. Mit
    // Anmelde-Cookies wäre jede Sandbox-Seite beliebig vieler Herkunft
    // ein Angreifer auf die Panel-API.
    res.setHeader(
      'access-control-allow-headers',
      'content-type, x-bot-hub-token, x-bot-hub-bootstrap',
    );
    res.setHeader(
      'access-control-allow-methods',
      'GET, POST, PUT, DELETE, OPTIONS',
    );
    res.setHeader('vary', 'origin');
    return true;
  }
  return false;
};

export const createServer = () => {
  load();
  return async (req, res) => {
    req.requestId = randomUUID();
    res.setHeader('x-request-id', req.requestId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'permissions-policy',
      'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    );
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    // P1-G: Rate-Limit, Routing und Audit müssen denselben kanonischen Pfad
    // sehen. Ein Request auf `/api//bots/` ist für alle drei genau `/api/bots`
    // – nie ein zweiter, am Limit vorbeilaufender Pfad.
    const canonical = canonicalPathname(url.pathname);
    if (canonical !== url.pathname) url.pathname = canonical;
    if (!applyCors(req, res, url)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({
          error:
            'Herkunft nicht erlaubt – der Hub nimmt nur Aufrufe von dieser Seite an.',
        }),
      );
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    try {
      const limited = rateLimit(req, url);
      if (limited) throw limited;
      if (url.pathname.startsWith('/api/'))
        return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (error) {
      const status = error.status ?? 500;
      const internalError = status >= 500 && status !== 501;
      if (status >= 500) console.error('[hub]', error);
      if (!res.headersSent) {
        if (error.retryAfter) res.setHeader('retry-after', error.retryAfter);
        const body = {
          error: internalError ? 'Interner Serverfehler' : error.message,
          code:
            error.code ??
            (status === 409
              ? 'CONFLICT'
              : status === 429
                ? 'RATE_LIMITED'
                : internalError
                  ? 'INTERNAL_ERROR'
                  : 'REQUEST_FAILED'),
          requestId: req.requestId,
        };
        if (error.deleted !== undefined) body.deleted = error.deleted;
        if (error.botId !== undefined) body.botId = error.botId;
        if (error.deleteStatus !== undefined) body.status = error.deleteStatus;
        if (error.cleanupErrors)
          body.cleanupErrors = error.cleanupErrors.map(({ step }) => ({
            step,
          }));
        return sendJson(res, status, body);
      }
      return res.end();
    }
  };
};

/* Panel-Zustand lebt in panel.js, braucht aber Zugriff auf diese Helfer. */
configurePanel({
  env: (bot, dir) => botEnv(bot, dir),
  broadcast: (type, payload) => broadcast(type, payload),
  touch: (bot) => {
    dirty.add(bot.id);
    schedulePersist();
  },
  lifecycle: (bot, operation) =>
    withBotLifecycleLock(bot.id, async () => {
      assertNotDeleting(bot);
      if (bots.get(bot.id) !== bot) throw httpError(404, 'Bot nicht gefunden');
      return operation();
    }),
});

configureAccess(ACCESS_FILE);
configureSessionStore(SESSIONS_FILE);
// Vault-Bootstrap: Klartext-Reste versiegeln + OAuth-Werte aus .env in den
// verschlüsselten hub.env umziehen lassen. Vor dem ersten Listen, damit
// keine Anfrage Klartext-Umgebungswerte sieht, nachdem der Umzug geplant ist.
bootstrapSecretVault(PROJECT_ROOT);

export { stopAllBots };

/**
 * Beim sauberen Herunterfahren darf ein ausstehender Persistenz-Timer nicht
 * verloren gehen: ein Delete oder eine Secret-Migration, deren Flush noch in
 * den 250 ms wartete, wäre sonst weg. `strict` meldet einen Schreibfehler,
 * damit der Betreiber ihn sieht, statt dass der Prozess ihn verschluckt.
 */
export const flushPersist = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  flush(true);
};

/* Nur für Tests: die beiden Stellen, an denen ein Befehl oder eine
 * Installationsfolge entsteht. Beides entscheidet, was ein Bot ausführen darf,
 * und gehört damit in den Test statt nur in den Betrieb. */
export const __testing = {
  commandSpec,
  resolveInstallPlan,
  installLabel,
  broadcast,
  redactLogSecrets,
  pushLine,
  ablehnungsgrund,
  sseListeners: listeners,
  botMap: bots,
  // P1-G/P1-H/P1-J: Helfer, deren Korrektheit direkt getestet wird, ohne sie
  // über HTTP zu erraten. canonicalPathname beweist die Bucket-Kollaps,
  // MAX_BOTS/creatingReserve die Obergrenze, isDeleteLocked den Abbruch.
  canonicalPathname,
  rateLimitPath,
  MAX_BOTS,
  // V25b: rein additive Test-Zugänge für Bucket-Verdrängung, Log-Rate-
  // Klasse und Wert-Redaktion – kein Verhalten ändert sich dadurch.
  takeRateBucket,
  rateBuckets,
  MAX_RATE_BUCKETS,
  rateLimit,
  redactKnownSecretValues,
  // F-2: publicBot als Test-Zugang, damit die Serialisierung (kein
  // runtimeToken-Leak) direkt geprüft werden kann – rein additiv.
  publicBot,
  isDeleteLocked,
  deletePending,
  deletingBots,
  pendingCreations: () => pendingBotCreations,
  flush,
  schedulePersist,
  dirtySet: dirty,
  toFile,
};
