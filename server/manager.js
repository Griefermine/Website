import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
  isAbsolute,
  relative,
  delimiter,
} from 'node:path';
import { LANGUAGES, fillDeps, getFramework, getLanguage } from './languages.js';
import { httpError, readBody, sendJson, MIME, MASK } from './util.js';
import {
  configurePanel,
  ensurePanel,
  handleHubRoutes,
  handlePanelRoutes,
  hubEnv,
  hydratePanel,
  publicPanel,
  revokeRuntimeToken,
  syncBotEnv,
} from './panel.js';

const PROJECT_ROOT = resolve(process.env.BOT_DASHBOARD_ROOT || process.cwd());
const DATA_FILE = join(PROJECT_ROOT, 'data', 'bots.json');
const MAX_LOG_LINES = 800;
const MAX_BOTS = 24;
const INSTALL_TIMEOUT = 15 * 60 * 1000;

const bots = new Map();
const listeners = new Set();
const dirty = new Set();

let persistTimer = null;
const schedulePersist = () => {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flush();
  }, 250);
};

const flush = () => {
  dirty.clear();
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    writeFileSync(DATA_FILE, `${JSON.stringify(toFile(), null, 2)}\n`);
  } catch (error) {
    console.error('[hub] Speichern fehlgeschlagen:', error.message);
  }
};

const toFile = () =>
  [...bots.values()].map(({ child, busy, logs, restartTimer, ...rest }) => {
    const { secretEnv, ...safeSecretEnv } = rest.secretEnv;
    // Live-Zustand der Bot-Seite gehört nicht in die Datei.
    const { state, ...panel } = rest.panel ?? {};
    return {
      ...rest,
      secretEnv: safeSecretEnv,
      panel: rest.panel ? panel : rest.panel,
    };
  });

/* ------------------------------------------------------------------ *
 * Pfad-Sicherheit: Bots dürfen nur innerhalb des Projektordners
 * gestartet werden, damit der Server keine fremden Befehle ausführt.
 * ------------------------------------------------------------------ */
const safeProjectPath = (input, fallback = '.') => {
  const candidate = isAbsolute(input)
    ? input
    : join(PROJECT_ROOT, input || fallback);
  const full = resolve(candidate);
  const rel = relative(PROJECT_ROOT, full);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return full;
};

const SECRET_KEYS = /^(.*(token|secret|password|passwort|key|dsn|webhook).*)$/i;

const maskValue = (value) => {
  const text = String(value ?? '');
  if (text.length < 9) return '••••••••';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
};

const maskEnv = (env) => {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SECRET_KEYS.test(key) ? maskValue(value) : value;
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
  };
};

const setStatus = (bot, status, extra = {}) => {
  bot.status = status;
  Object.assign(bot, extra);
  dirty.add(bot.id);
  schedulePersist();
  broadcast('bot', publicBot(bot));
};

const hydrate = (config) => ({
  id: config.id,
  name: config.name,
  emoji: config.emoji || '🤖',
  description: config.description || '',
  language: config.language,
  framework: config.framework || '',
  entrypoint: config.entrypoint || '',
  command: config.command || '',
  commandResolved: config.commandResolved || '',
  cwd: config.cwd || '.',
  guildId: config.guildId || '',
  autoRestart: Boolean(config.autoRestart),
  autoInstall: config.autoInstall !== false,
  depsCheck: config.depsCheck || '',
  depsInstall: config.depsInstall || '',
  maxRestarts: Number.isFinite(config.maxRestarts) ? config.maxRestarts : 5,
  env: config.env ?? {},
  secretEnv: config.secretEnv ?? {},
  status: 'stopped',
  pid: null,
  exitCode: config.exitCode ?? null,
  restartCount: config.restartCount ?? 0,
  startedAt: null,
  stoppedAt: null,
  depsStatus: 'unknown',
  depsCommand: '',
  createdAt: config.createdAt ?? Date.now(),
  updatedAt: Date.now(),
  logs: [],
  child: null,
  panel: hydratePanel(config.panel),
});

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
  if (exists) return true;

  pushLine(bot.id, 'system', `Richte ${venv} ein …`);
  const { code } = await runCommand(bot, prepare, {
    dir,
    silent: true,
    timeout: 180000,
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
  const install = fillDeps(bot.depsInstall || language.install, deps);
  const prepare = fillDeps(language.prepare, deps);
  return { language, framework, deps, check, install, prepare, venv };
};

const botEnv = (bot, dir, { runtime = false } = {}) => {
  const venv = venvOf(bot);
  const base = venv && dir ? venvDir(dir, venv) : '';
  const binDirs = base
    ? [join(base, 'bin'), join(base, 'Scripts')].filter((path) =>
        existsSync(path),
      )
    : [];
  const pathVar = process.platform === 'win32' ? 'Path' : 'PATH';
  const currentPath = process.env[pathVar] ?? process.env.PATH ?? '';
  return {
    ...process.env,
    ...bot.env,
    ...(binDirs.length
      ? { [pathVar]: [...binDirs, currentPath].join(delimiter) }
      : {}),
    VIRTUAL_ENV: base || undefined,
    DISCORD_BOT_TOKEN: bot.secretEnv.DISCORD_BOT_TOKEN ?? '',
    DISCORD_GUILD_ID: bot.guildId,
    BOT_NAME: bot.name,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    npm_config_yes: 'true',
    // Nur der echte Bot-Prozess darf sich am Hub anmelden.
    ...(runtime ? hubEnv(bot, dir) : {}),
  };
};

/** Hilfsbefehl ausführen und die Ausgabe in die Logs spiegeln. */
const runCommand = (bot, command, { dir, silent = false, timeout = 120000 }) =>
  new Promise((resolveRun) => {
    if (!silent) pushLine(bot.id, 'system', `$ ${command}`);
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: dir,
      env: botEnv(bot, dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bot.busy = child;

    let pendingOut = '';
    let pendingErr = '';
    child.stdout.on('data', (data) => {
      pendingOut += data.toString();
      const parts = pendingOut.split(/\r?\n/);
      pendingOut = parts.pop() ?? '';
      pushOutput(bot.id, 'deps', parts.join('\n'));
    });
    child.stderr.on('data', (data) => {
      pendingErr += data.toString();
      const parts = pendingErr.split(/\r?\n/);
      pendingErr = parts.pop() ?? '';
      pushOutput(bot.id, 'deps', parts.join('\n'));
    });

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
      if (pendingOut.trim()) pushLine(bot.id, 'deps', pendingOut);
      if (pendingErr.trim()) pushLine(bot.id, 'deps', pendingErr);
      resolveRun({ code: code ?? -1 });
    });
  });

/** Prüft, ob die gewählte Library schon installiert ist. */
const checkDependencies = async (bot, dir) => {
  const info = depsFor(bot);
  if (!info.check) return { ...info, ok: true, check: '', install: '' };

  setStatus(bot, 'checking', { depsStatus: 'checking' });
  await ensureEnv(bot, dir, info);
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
  if (!info.install) {
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
    depsCommand: info.install,
  });
  pushLine(
    bot.id,
    'system',
    `Installiere ${info.framework.name} – je nach Sprache kann das ein paar Minuten dauern …`,
  );
  const { code } = await runCommand(bot, info.install, {
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

  pushLine(bot.id, 'system', `✓ ${info.framework.name} installiert`);
  setStatus(bot, 'stopped', { depsStatus: 'ready' });
  return { ...info, installed: true, ok: true };
};

const spawnBot = (bot, dir, language) => {
  const command = fillPlaceholders(bot.command, bot, dir) || language.command;
  if (!command) throw httpError(400, 'Kein Startbefehl definiert');

  bot.commandResolved = command;
  ensurePanel(bot);

  let child;
  try {
    child = spawn('/bin/sh', ['-c', command], {
      cwd: dir,
      env: {
        ...botEnv(bot, dir, { runtime: true }),
        FORCE_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (error) {
    setStatus(bot, 'error', { exitCode: -1 });
    pushLine(bot.id, 'system', `Start fehlgeschlagen: ${error.message}`);
    throw httpError(500, `Start fehlgeschlagen: ${error.message}`);
  }

  bot.child = child;
  let pendingOut = '';
  let pendingErr = '';
  child.stdout.on('data', (data) => {
    pendingOut += data.toString();
    const parts = pendingOut.split(/\r?\n/);
    pendingOut = parts.pop() ?? '';
    pushOutput(bot.id, 'stdout', parts.join('\n'));
  });
  child.stderr.on('data', (data) => {
    pendingErr += data.toString();
    const parts = pendingErr.split(/\r?\n/);
    pendingErr = parts.pop() ?? '';
    pushOutput(bot.id, 'stderr', parts.join('\n'));
  });

  child.on('error', (error) => {
    pushLine(bot.id, 'system', `Prozessfehler: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    bot.child = null;
    revokeRuntimeToken(bot.id);
    if (pendingOut.trim()) pushLine(bot.id, 'stdout', pendingOut);
    if (pendingErr.trim()) pushLine(bot.id, 'stderr', pendingErr);
    pendingOut = '';
    pendingErr = '';
    pushLine(
      bot.id,
      'system',
      `Prozess beendet (code=${code}, signal=${signal ?? '-'})`,
    );

    const crashed = code !== 0 && code !== null;
    const room = bot.autoRestart ? bot.maxRestarts : 0;
    if (crashed && bot.restartCount < room) {
      const next = bot.restartCount + 1;
      setStatus(bot, 'restarting', {
        exitCode: code,
        restartCount: next,
        stoppedAt: Date.now(),
      });
      pushLine(bot.id, 'system', `Neustart ${next}/${room || '∞'} in 3s …`);
      bot.restartTimer = setTimeout(() => {
        bot.restartTimer = null;
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
  const dir = safeProjectPath(bot.cwd, '.');
  if (!dir) throw httpError(400, 'Arbeitsordner liegt außerhalb des Projekts');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw httpError(400, `Ordner "${bot.cwd}" existiert nicht`);
  }
  return dir;
};

async function startBot(id, { manual = true } = {}) {
  const bot = bots.get(id);
  if (!bot) throw httpError(404, 'Bot nicht gefunden');
  const dir = prepareStart(bot);

  bot.manual = manual;
  bot.env = { ...bot.env };
  const { language } = depsFor(bot);

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
        return publicBot(bot);
      }
      const installed = await installDependencies(bot, dir, { state });
      if (!installed.ok) return publicBot(bot);
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
  }
};

const load = () => {
  if (!existsSync(DATA_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return;
    for (const config of parsed.slice(0, MAX_BOTS)) {
      if (!config?.id || !config?.name) continue;
      bots.set(config.id, hydrate(config));
    }
  } catch (error) {
    console.error('[hub] bots.json unlesbar:', error.message);
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

const handleApi = async (req, res, url) => {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, action] = segments;

  if (resource === 'health')
    return sendJson(res, 200, {
      ok: true,
      projectRoot: PROJECT_ROOT,
      bots: bots.size,
    });

  if (resource === 'languages')
    return sendJson(res, 200, { languages: LANGUAGES });

  // Vom Bot selbst aufgerufen – Identität läuft über BOT_HUB_TOKEN.
  if (resource === 'hub')
    return handleHubRoutes(req, res, url, (id) => bots.get(id));

  if (resource === 'events') {
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
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return undefined;
  }

  if (resource === 'logs') {
    const tail = Math.min(500, Number(url.searchParams.get('tail') ?? 200));
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
      if (req.method === 'GET')
        return sendJson(res, 200, { bots: [...bots.values()].map(publicBot) });
      if (req.method === 'POST') {
        if (bots.size >= MAX_BOTS)
          throw httpError(429, `Maximal ${MAX_BOTS} Bots`);
        const body = await readBody(req);
        const config = normaliseConfig(body, null);
        const id = randomUUID();
        const bot = hydrate({ ...config, id });
        syncBotEnv(bot);
        bots.set(id, bot);
        setStatus(bot, 'stopped');
        const fresh = publicBot(bot);
        broadcast('created', fresh);
        return sendJson(res, 201, { bot: fresh });
      }
      throw httpError(405, 'Methode nicht erlaubt');
    }

    const bot = bots.get(id);
    if (!bot) throw httpError(404, 'Bot nicht gefunden');

    if (!action && req.method === 'GET')
      return sendJson(res, 200, { bot: publicBot(bot) });
    if (!action && req.method === 'PATCH') {
      const body = await readBody(req);
      const config = normaliseConfig(body, bot);
      const nextBot = { ...bot, ...config };
      syncBotEnv(nextBot);
      Object.assign(bot, config, { updatedAt: Date.now() });
      bot.restartCount = 0;
      dirty.add(bot.id);
      schedulePersist();
      const updated = publicBot(bot);
      broadcast('bot', updated);
      return sendJson(res, 200, { bot: updated });
    }
    if (!action && req.method === 'DELETE') {
      stopBot(id, { signal: 'SIGKILL' });
      bots.delete(id);
      dirty.add(id);
      schedulePersist();
      broadcast('deleted', { id });
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'start' && req.method === 'POST') {
      prepareStart(bot);
      setStatus(bot, 'checking', { pid: null, stoppedAt: Date.now() });
      startBot(id).catch((error) => {
        pushLine(id, 'system', `Start fehlgeschlagen: ${error.message}`);
        setStatus(bot, 'error', { exitCode: -1, pid: null });
      });
      return sendJson(res, 202, { bot: publicBot(bot) });
    }
    if (action === 'install' && req.method === 'POST') {
      const dir = safeProjectPath(bot.cwd, '.');
      if (!dir)
        throw httpError(400, 'Arbeitsordner liegt außerhalb des Projekts');
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
    if (action === 'stop' && req.method === 'POST')
      return sendJson(res, 200, { bot: stopBot(id) });
    if (action === 'kill' && req.method === 'POST')
      return sendJson(res, 200, { bot: stopBot(id, { signal: 'SIGKILL' }) });
    if (action === 'restart' && req.method === 'POST') {
      stopBot(id, { signal: 'SIGTERM' });
      const target = bots.get(id);
      if (target) {
        const waitForExit = setInterval(() => {
          if (!target.child) {
            clearInterval(waitForExit);
            setTimeout(() => {
              if (bots.has(id)) startBot(id).catch(() => {});
            }, 300);
          }
        }, 100);
      }
      return sendJson(res, 200, { bot: publicBot(bots.get(id)) });
    }
    if (action === 'logs' && req.method === 'GET') {
      const tail = Math.min(500, Number(url.searchParams.get('tail') ?? 300));
      return sendJson(res, 200, { lines: bot.logs.slice(-tail) });
    }
    if (action === 'panel') return handlePanelRoutes(bot, req, res, url);
    throw httpError(405, 'Methode nicht erlaubt');
  }

  throw httpError(404, 'Unbekannter API-Endpunkt');
};

const serveStatic = (req, res, url) => {
  const dist = join(PROJECT_ROOT, 'dist');
  const requested = decodeURIComponent(url.pathname);
  const candidate =
    requested === '/' ? join(dist, 'index.html') : join(dist, requested);
  const target =
    existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(dist, 'index.html');
  if (!existsSync(target)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Frontend nicht gebaut – bitte "npm run build" ausführen.');
  }
  const ext = target.slice(target.lastIndexOf('.'));
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(readFileSync(target));
};

/* ------------------------------------------------------------------ *
 * CORS
 *
 * Der Hub läuft auf dem eigenen Rechner. Seiten fremder Herkunft (und der
 * Sandboxed-Bot mit Origin "null") dürfen nur die token-geschützten
 * Hub-/Panel-Endpunkte ansprechen – alles andere bleibt Same-Origin.
 * ------------------------------------------------------------------ */
const isPanelRoute = (pathname) =>
  pathname.startsWith('/api/hub') ||
  /\/api\/bots\/[^/]+\/panel(\/|$)/.test(pathname);

const sameHost = (origin, host) => {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};

const applyCors = (req, res, url) => {
  const origin = req.headers.origin;
  if (!origin) return true; // kein Browser (Bot, curl, Tests)
  if (sameHost(origin, req.headers.host)) return true; // Same-Origin
  if (isPanelRoute(url.pathname)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'origin');
    res.setHeader(
      'access-control-allow-headers',
      'content-type, authorization, x-bot-hub-token',
    );
    res.setHeader(
      'access-control-allow-methods',
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );
    res.setHeader('access-control-max-age', '600');
    return true;
  }
  return false;
};

export const createServer = () => {
  load();
  return async (req, res) => {
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
      if (url.pathname.startsWith('/api/'))
        return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (error) {
      const status = error.status ?? 500;
      if (status >= 500) console.error('[hub]', error);
      if (!res.headersSent)
        return sendJson(res, status, { error: error.message });
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

export { stopAllBots };
