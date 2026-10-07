import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  chmodSync,
  cpSync,
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
  storeSecretValues,
} from './secrets.js';
import {
  httpError,
  isEvalFlag,
  parseDotenv,
  readBody,
  sendJson,
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
  ensureContainer,
  execArgs,
  stopContainer,
  removeContainer,
} from './containers.js';
import { database } from './database.js';
import { ensurePanelScaffold, migrateScaffold } from './panelScaffold.js';

const PROJECT_ROOT = resolve(process.env.BOT_DASHBOARD_ROOT || process.cwd());
const DATA_FILE = join(PROJECT_ROOT, 'data', 'bots.json');
const ACCESS_FILE = join(PROJECT_ROOT, 'data', 'access.json');
const MAX_LOG_LINES = 800;
const MAX_BOTS = 24;

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
const rateLimit = (req, url) => {
  if (process.env.BOT_HUB_TEST_MODE === '1') return null;
  const path = url.pathname;
  let limit = 0;
  let rateClass = '';
  if (/^\/api\/auth\/discord\/(?:login|callback)$/.test(path)) {
    limit = 30;
    rateClass = 'auth';
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
  } else return null;
  const now = Date.now();
  const trustedProxies = new Set(
    String(process.env.BOT_HUB_TRUSTED_PROXIES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const remoteAddress = String(req.socket.remoteAddress ?? '');
  const forwarded =
    trustedProxies.has(remoteAddress) && req.headers['x-forwarded-for'];
  const ip = String(forwarded || remoteAddress)
    .split(',')
    .pop()
    .trim();
  const key = `${ip}:${rateClass}`;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.expiresAt <= now) {
    if (!bucket && rateBuckets.size >= MAX_RATE_BUCKETS)
      return httpError(429, 'Zu viele Anfragen');
    rateBuckets.set(key, { count: 1, expiresAt: now + 60_000 });
    return null;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    const error = httpError(429, 'Zu viele Anfragen');
    error.retryAfter = Math.ceil((bucket.expiresAt - now) / 1000);
    return error;
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
  if (!key) return;
  const cur = concurrentUploads.get(key) ?? 1;
  activeUploadCount = Math.max(0, activeUploadCount - 1);
  if (cur <= 1) concurrentUploads.delete(key);
  else concurrentUploads.set(key, cur - 1);
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
 * Bots im Löschvorgang: Während DELETE läuft, werden Start, Restart,
 * Installation, Konfigurations- und Datei-/Panel-Schreibzugriffe mit 409
 * abgewiesen, damit kein paralleler Request den Bot reaktiviert. Lesezugriffe
 * bleiben erlaubt.
 */
const deletingBots = new Set();
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
      bot.deleteState === 'deleting' ||
      bot.deleteState === 'cleanup_failed'),
  );
const assertNotDeleting = (bot) => {
  if (isDeleteLocked(bot))
    throw httpError(
      409,
      'Bot wird gerade gelöscht oder Cleanup steht aus – erst Cleanup abschließen',
    );
};
/**
 * Lock nur für In-Flight-Löschungen: Ein erneuter DELETE auf einem Bot in
 * `cleanup_failed` muss den Cleanup wiederholen dürfen (Retry), nur eine
 * gerade laufende Löschung desselben Bots wird mit 409 abgewiesen.
 */
const assertNoDeleteInFlight = (bot) => {
  if (bot && deletingBots.has(bot.id))
    throw httpError(409, 'Bot wird gerade gelöscht – bitte kurz warten');
};

let persistTimer = null;
const schedulePersist = () => {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flush();
  }, 250);
};

const flush = (strict = false) => {
  dirty.clear();
  // Atomar: tmp schreiben + fsync + rename. Ein Absturz hinterlässt nie eine
  // halb geschriebene bots.json, sondern höchstens eine tmp-Leiche.
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(toFile(), null, 2)}\n`, {
      mode: 0o600,
    });
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, DATA_FILE);
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
 * Liest die Geheimnisse eines Bots und holt sie in die Datei mit 0600 Rechten.
 * Der Wert aus bots.json hat Vorrang, weil die Datei sonst einen älteren
 * Stand zurückschreiben würde; anschließend wandert er aus bots.json heraus.
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
    return { secretEnv: {}, secretSettings: {} };

  const stored = readSecretFile(config.id);
  const secretEnv = {};
  const secretSettings = {};
  const carryOver = {};
  // Gleiche Normalisierung wie beim Schreiben der .env – sonst findet der
  // Hub ein geheimes Panel-Feld nach dem ersten Speichern nicht wieder.
  for (const key of envKeys) {
    const fileKey = dotenvKey(key);
    const value = legacyEnv[key] ?? stored[fileKey];
    if (value === undefined) continue;
    secretEnv[key] = String(value);
    carryOver[fileKey] = String(value);
  }
  for (const key of panelKeys) {
    const fileKey = dotenvKey(key);
    const value = legacyPanel[key] ?? stored[fileKey];
    if (value === undefined) continue;
    secretSettings[key] = String(value);
    carryOver[fileKey] = String(value);
  }
  try {
    storeSecretValues(PROJECT_ROOT, config.id, carryOver);
    return { secretEnv, secretSettings };
  } catch (error) {
    // Ohne sichere Ablage bleiben die Werte im Speicher, werden aber nicht
    // aus bots.json entfernt - sonst waeren sie verloren.
    console.error(
      `[hub] Geheimnisse für ${config.name} konnten nicht in data/secrets gesichert werden:`,
      error.message,
    );
    return { secretEnv: { ...secretEnv, ...config.secretEnv }, secretSettings };
  }
};

/**
 * `bots.json` ist die Übersicht der Bots, nicht der Geheimnisspeicher. Werte
 * gehen nicht hinein, nur die Namen der Schlüssel - die liegen in
 * `data/secrets/<id>.env` (Verzeichnis 0700, Datei 0600).
 */
const toFile = () =>
  [...bots.values()].map(({ child, busy, logs, restartTimer, ...rest }) => {
    const secretKeys = Object.keys(rest.secretEnv ?? {});
    // Live-Zustand der Bot-Seite gehört nicht in die Datei.
    const { state, secretSettings, ...panel } = rest.panel ?? {};
    return {
      ...rest,
      secretEnv: {},
      secretKeys,
      panel: rest.panel
        ? {
            ...panel,
            secretSettings: {},
            secretKeys: Object.keys(secretSettings ?? {}),
          }
        : rest.panel,
    };
  });

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
    text: text.slice(0, 2000),
  };
  bot.logs.push(chunk);
  if (bot.logs.length > MAX_LOG_LINES)
    bot.logs.splice(0, bot.logs.length - MAX_LOG_LINES);
  broadcast('log', chunk);
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
  for (const client of listeners) {
    try {
      client.write(frame);
    } catch {
      listeners.delete(client);
    }
  }
};

const publicBot = (bot) => {
  const { child, busy, logs, restartTimer, ...rest } = bot;
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
  // Jeder Bot bekommt seinen Startordner, beim ersten Start genauso wie beim
  // zehnten. Hier muss sichergestellt werden, dass es ihn gibt – nicht nur beim
  // Anlegen, sonst fiele er bei einem Bot, der eine Nacht alt ist, einfach weg.
  dateien.ensureStartFolder(
    { id: config.id, workspaceRoot: workspace.workspaceRoot },
    PROJECT_ROOT,
  );
  const secrets = migrateSecrets(config);
  return {
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

const botEnv = (
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
    ...bot.env,
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
 * Ein Programm im eigenen Ordner des Bots, z.B. der Gradle-Wrapper
 * `./gradlew`.
 *
 * Dafür gilt mehr als "beginnt mit ./": das Ziel muss eine reguläre Datei im
 * Workspace sein, ausführbar, und nach `realpath` immer noch darin liegen. Ein
 * SymLink nach `/usr/bin` wäre sonst ein Weg aus der Prüfung heraus.
 */
const WORKSPACE_PROGRAMS = new Set(['./gradlew', './mvnw', './gradlew.bat']);

const workspaceProgram = (executable, dir) => {
  if (!WORKSPACE_PROGRAMS.has(executable)) return null;
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
  const local = workspaceProgram(executable, dir);
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
  { dir, silent = false, timeout = 120000, systemPython = false },
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
    const env = botEnv(bot, dir, {
      includeSecrets: false,
      useVenv: !systemPython,
    });
    const inContainer = containerRuntimeEnabled();
    const child = spawn(
      inContainer ? containerRuntimeName() : spec.executable,
      inContainer ? execArgs(bot, PROJECT_ROOT, dir, spec, env) : spec.args,
      {
        cwd: inContainer ? PROJECT_ROOT : dir,
        env: inContainer ? process.env : env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    bot.busy = child;

    const outputReader = outputLineReader(bot.id, 'deps');
    const errorReader = outputLineReader(bot.id, 'deps');
    child.stdout.on('data', (data) => outputReader.write(data));
    child.stderr.on('data', (data) => errorReader.write(data));

    const killer = setTimeout(() => {
      pushLine(
        bot.id,
        'system',
        'Zeitüberschreitung – Befehl wird abgebrochen',
      );
      killTree(child, 'SIGTERM');
    }, timeout);
    killer.unref();

    child.on('error', (error) => {
      clearTimeout(killer);
      if (bot.busy === child) bot.busy = null;
      pushLine(bot.id, 'system', `Befehl fehlgeschlagen: ${error.message}`);
      resolveRun({ code: -1 });
    });

    child.on('exit', (code) => {
      clearTimeout(killer);
      if (bot.busy === child) bot.busy = null;
      outputReader.flush();
      errorReader.flush();
      resolveRun({ code: code ?? -1 });
    });
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
  pushLine(
    bot.id,
    'system',
    `Installiere ${info.framework.name} – je nach Sprache kann das ein paar Minuten dauern …`,
  );

  for (const step of plan) {
    const { code } = await runCommand(bot, step.join(' '), {
      dir,
      timeout: INSTALL_TIMEOUT,
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
  try {
    const spec = commandSpec(bot, command, dir, 'start');
    const runtimeEnv = {
      ...botEnv(bot, dir, { runtime: true }),
      FORCE_COLOR: '1',
    };
    const inContainer = containerRuntimeEnabled();
    const spawnOptions = {
      cwd: inContainer ? PROJECT_ROOT : dir,
      env: inContainer ? process.env : runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    };
    const uid = Number(process.env.BOT_HUB_BOT_UID);
    const gid = Number(process.env.BOT_HUB_BOT_GID);
    if (Number.isInteger(uid) && uid > 0) spawnOptions.uid = uid;
    if (Number.isInteger(gid) && gid > 0) spawnOptions.gid = gid;
    child = spawn(
      inContainer ? containerRuntimeName() : spec.executable,
      inContainer
        ? execArgs(bot, PROJECT_ROOT, dir, spec, runtimeEnv)
        : spec.args,
      spawnOptions,
    );
  } catch (error) {
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
        if (!bots.has(bot.id) || deletingBots.has(bot.id)) return;
        startBot(bot.id, { manual: false }).catch((error) => {
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
  if (isDeleteLocked(bot))
    throw httpError(409, 'Bot wird gerade gelöscht – bitte kurz warten');
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
  }

  if (language.check) {
    const state = await checkDependencies(bot, dir);
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
      if (!installed.ok) {
        if (containerRuntimeEnabled()) stopContainer(bot).catch(() => {});
        return publicBot(bot);
      }
    } else {
      setStatus(bot, 'stopped', { depsStatus: 'ready' });
    }
  }

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

const load = () => {
  // Reste abgebrochener Schreibvorgänge enthalten vollständige Geheimnisse.
  cleanupTempEnvFiles(join(PROJECT_ROOT, 'data', 'secrets'));
  if (!existsSync(DATA_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return;
    // Enthielt bots.json noch Geheimnisse, werden sie jetzt in data/secrets
    // gesichert und die Datei anschließend ohne Werte neu geschrieben.
    const withSecrets = parsed.some(
      (config) =>
        Object.keys(config?.secretEnv ?? {}).length ||
        Object.keys(config?.panel?.secretSettings ?? {}).length,
    );
    for (const config of parsed.slice(0, MAX_BOTS)) {
      if (!config?.id || !config?.name) continue;
      const bot = hydrate(config);
      bots.set(config.id, bot);
      // Bestehende Bots ohne Webseite bekommen das Beispiel-Scaffold.
      // Idempotent: vorhandene bot-hub.json/panel-Dateien bleiben unangetastet.
      // Fehler werden geloggt, verhindern aber nie den Start (Verfügbarkeit
      // geht vor Beispielseite; der Bot selbst ist vollständig).
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
    if (withSecrets) {
      schedulePersist();
      console.warn(
        '[hub] Geheimnisse aus bots.json nach data/secrets verschoben.',
      );
    }
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
    await attempt('sessions', async () => revokeBotSessions(id));
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
    .map((teil) => decodeURIComponent(teil))
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
        return sendJson(res, 200, { files: uebernehmen(bot) });
      }
      braucht('files.write');
      const ok = await dateien.withBotLock(bot.id, async () => {
        if (
          typeof body.ordner !== 'string' ||
          !dateien.makeDir(bot, PROJECT_ROOT, body.ordner)
        )
          return false;
        return true;
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
    braucht('files.write');
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
      const limited = takeUploadBytes(req, url, incoming);
      if (limited) throw limited;
      const geschrieben = await dateien.withBotLock(bot.id, async () =>
        dateien.write(bot, PROJECT_ROOT, pfad, body.inhalt),
      );
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
    const ergebnis = await dateien.withBotLock(bot.id, async () =>
      dateien.remove(bot, PROJECT_ROOT, pfad),
    );
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

  const permission = (name) => {
    if (!hasPermission(req, name))
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

  if (resource === 'health')
    return sendJson(res, 200, {
      ok: true,
      bots: bots.size,
    });

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
    permission('logs.read');
    const rawTail = url.searchParams.get('tail') ?? '200';
    const tail = Number(rawTail);
    if (!Number.isInteger(tail) || tail < 1 || tail > 500)
      throw httpError(400, 'tail muss eine ganze Zahl zwischen 1 und 500 sein');
    const scope = id ? bots.get(id) : null;
    if (id && !scope) throw httpError(404, 'Bot nicht gefunden');
    const source = scope
      ? scope.logs
      : [...bots.values()].flatMap((b) => b.logs);
    const lines = source.slice(-tail).sort((a, b) => a.ts - b.ts);
    return sendJson(res, 200, { lines });
  }

  if (resource === 'bots') {
    if (!id) {
      if (req.method === 'GET') permission('bots.read');
      if (req.method === 'GET')
        return sendJson(res, 200, { bots: [...bots.values()].map(publicBot) });
      if (req.method === 'POST') {
        permission('bots.manage');
        if (bots.size >= MAX_BOTS)
          throw httpError(429, `Maximal ${MAX_BOTS} Bots`);
        const body = await readBody(req);
        const config = normaliseConfig(body, null);
        const id = randomUUID();
        if (process.env.BOT_HUB_TEST_MODE !== '1') {
          const workspaceRoot = `bots/${id}/workspace`;
          mkdirSync(resolve(PROJECT_ROOT, workspaceRoot), {
            recursive: true,
            mode: 0o700,
          });
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
      assertNotDeleting(bot);
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
      const uebernommen = uebernehmen(bot);
      const nextBot = { ...bot, ...config };
      syncBotEnv(nextBot);
      Object.assign(bot, config, { updatedAt: Date.now() });
      bot.restartCount = 0;
      dirty.add(bot.id);
      schedulePersist();
      const updated = publicBot(bot);
      broadcast('bot', updated);
      return sendJson(res, 200, { bot: updated, files: uebernommen });
    }
    if (!action && req.method === 'DELETE') {
      permission('bots.delete');
      assertNoDeleteInFlight(bot);
      const result = await deleteBotCompletely(
        bot,
        currentUser(req)?.id ?? null,
      );
      return sendJson(res, 200, result);
    }
    if (action === 'start' && req.method === 'POST') {
      permission('bots.control');
      assertNotDeleting(bot);
      prepareStart(bot);
      setStatus(bot, 'checking', { pid: null, stoppedAt: Date.now() });
      startBot(id).catch((error) => {
        pushLine(id, 'system', `Start fehlgeschlagen: ${error.message}`);
        setStatus(bot, 'error', { exitCode: -1, pid: null });
      });
      return sendJson(res, 202, { bot: publicBot(bot) });
    }
    if (action === 'files') {
      permission('bots.manage');
      if (req.method !== 'GET') assertNotDeleting(bot);
      const handled = await handleFileRoutes(req, res, url, bot);
      if (handled !== false) return handled;
      throw httpError(404, 'Unbekannter Datei-Endpunkt');
    }

    if (action === 'install' && req.method === 'POST') {
      permission('bots.manage');
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
      setStatus(bot, 'checking', { depsStatus: 'checking' });
      installDependencies(bot, dir, { force: body.force === true }).catch(
        (error) => {
          console.error('[hub] Installation fehlgeschlagen:', error);
          setStatus(bot, 'error', { exitCode: -1 });
        },
      );
      return sendJson(res, 202, { bot: publicBot(bot) });
    }
    if (action === 'stop' && req.method === 'POST') {
      permission('bots.control');
      return sendJson(res, 200, { bot: stopBot(id) });
    }
    if (action === 'kill' && req.method === 'POST') {
      permission('bots.control');
      return sendJson(res, 200, { bot: stopBot(id, { signal: 'SIGKILL' }) });
    }
    if (action === 'restart' && req.method === 'POST') {
      permission('bots.restart');
      assertNotDeleting(bot);
      stopBot(id, { signal: 'SIGTERM' });
      const target = bots.get(id);
      if (target) {
        const waitForExit = setInterval(() => {
          if (!target.child) {
            clearInterval(waitForExit);
            setTimeout(() => {
              if (bots.has(id) && !deletingBots.has(id))
                startBot(id).catch(() => {});
            }, 300);
          }
        }, 100);
      }
      return sendJson(res, 200, { bot: publicBot(bots.get(id)) });
    }
    if (action === 'logs' && req.method === 'GET') {
      permission('logs.read');
      const rawTail = url.searchParams.get('tail') ?? '300';
      const tail = Number(rawTail);
      if (!Number.isInteger(tail) || tail < 1 || tail > 500)
        throw httpError(
          400,
          'tail muss eine ganze Zahl zwischen 1 und 500 sein',
        );
      return sendJson(res, 200, { lines: bot.logs.slice(-tail) });
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
      if (panelTokenAuth) return handlePanelRoutes(bot, req, res, url, true);
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
const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
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
    res.setHeader('access-control-allow-credentials', 'true');
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
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'permissions-policy',
      'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    );
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
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
      if (status >= 500) console.error('[hub]', error);
      if (!res.headersSent) {
        if (error.retryAfter) res.setHeader('retry-after', error.retryAfter);
        // Teilfehler (z. B. Bot-Delete) dürfen ihre Detailstruktur mitsenden;
        // Geheimnisse stehen darin nie (nur Schritt + Fehlermeldung).
        const body = { error: error.message };
        if (error.cleanupErrors) body.cleanupErrors = error.cleanupErrors;
        if (error.deleted !== undefined) body.deleted = error.deleted;
        if (error.botId !== undefined) body.botId = error.botId;
        if (error.deleteStatus !== undefined) body.status = error.deleteStatus;
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
});

configureAccess(ACCESS_FILE);

export { stopAllBots };

/* Nur für Tests: die beiden Stellen, an denen ein Befehl oder eine
 * Installationsfolge entsteht. Beides entscheidet, was ein Bot ausführen darf,
 * und gehört damit in den Test statt nur in den Betrieb. */
export const __testing = { commandSpec, resolveInstallPlan, installLabel };
