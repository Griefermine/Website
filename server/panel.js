/**
 * Bot-Erweiterung ("Panel"): eigene Seite, Einstellungen und Aktionen im Hub.
 *
 * Zwei Wege, wie ein Bot anknüpft:
 *
 *   1. Manifest – der Arbeitsordner enthält `bot-hub.json`. Kein Code nötig,
 *      der Hub liest die Datei und rendert Seite, Settings und Aktionen.
 *   2. Laufzeit  – der vom Hub gestartete Prozess meldet sich mit dem Token aus
 *      `BOT_HUB_TOKEN` an und liefert Manifest, Live-Zustand und Aktionen
 *      selbst. Ein Manifest auf der Festplatte hat dabei Vorrang.
 *
 * Alles landet in `bot.panel` und geht über `/api/bots/:id/panel` an den Browser.
 * Der Bot selbst spricht mit `/api/hub/...` (Laufzeit-Token) – beiläufig auch aus
 * seiner eigenen HTML-Seite heraus (Panel-Token, weniger Rechte).
 */

import { spawn } from 'node:child_process';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { httpError, MIME, readBody, sendJson, MASK } from './util.js';

const MANIFEST_NAMES = ['bot-hub.json', 'hub.json', 'bot-hub.panel.json'];
const MANIFEST_MAX_BYTES = 128 * 1024;
// Gehört in die Signatur: sonst gilt ein bereits gespeichertes Manifest als
// "unverändert", obwohl sich die Normalisierung (Feldtypen, Umbenennungen)
// geändert hat. Bei jeder Anpassung an normalisePanel hochzählen.
const MANIFEST_SCHEMA = 'panel-manifest-1';
const MAX_FIELDS = 40;
const MAX_COMMANDS = 20;
const MAX_PAGES = 12;
const MAX_OPTIONS = 60;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_OUTPUT = 32 * 1024;
const MAX_TOKEN = 4096;
const CALLBACK_TIMEOUT = 30000;
const SCRIPT_TIMEOUT = 60000;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const FIELD_TYPES = new Set([
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'secret',
]);

/* ------------------------------------------------------------------ *
 * Abhängigkeiten aus dem manager.js (Zustand liegt dort)
 * ------------------------------------------------------------------ */
let envFor = (bot, dir) => ({ ...process.env });
let broadcastEvent = () => {};
let markDirty = () => {};

export const configurePanel = ({ env, broadcast, touch } = {}) => {
  if (typeof env === 'function') envFor = env;
  if (typeof broadcast === 'function') broadcastEvent = broadcast;
  if (typeof touch === 'function') markDirty = touch;
};

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */
const newToken = () => randomBytes(24).toString('hex');
const runTokens = new Map();
const panelTokens = new Map();
const callbacks = new Map();
const manifestCache = new Map();
const botStreams = new Map();
const discordAuthStates = new Map();
const discordSessions = new Map();
const discordPanelSessions = new Map();
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_MANAGE_GUILD = 0x20n;
const DISCORD_ADMINISTRATOR = 0x8n;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of discordAuthStates) {
    if (value.expiresAt <= now) discordAuthStates.delete(key);
  }
  for (const [key, value] of discordSessions) {
    if (value.expiresAt <= now) discordSessions.delete(key);
  }
}, 60_000);
cleanupTimer.unref();

/** Token für den laufenden Prozess – wird bei jedem Start neu vergeben. */
export const issueRuntimeToken = (id) => {
  const token = newToken();
  runTokens.set(id, token);
  return token;
};

export const revokeRuntimeToken = (id) => {
  runTokens.delete(id);
  callbacks.delete(id);
  for (const res of botStreams.get(id) ?? []) {
    try {
      res.end();
    } catch {
      /* Stream schon zu */
    }
  }
  botStreams.delete(id);
};

/** Token für die eingebettete Seite – darf lesen/speichern, aber nichts anmelden. */
export const panelToken = (id) => {
  let token = panelTokens.get(id);
  if (!token) {
    token = newToken();
    panelTokens.set(id, token);
  }
  return token;
};

const sameToken = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return (
    left.length === right.length &&
    right.length > 0 &&
    timingSafeEqual(left, right)
  );
};

const readToken = (req, url) => {
  const header = String(req.headers.authorization ?? '');
  if (/^bearer\s+/i.test(header))
    return header.replace(/^bearer\s+/i, '').trim();
  const custom = req.headers['x-bot-hub-token'];
  if (custom) return String(custom).trim();
  const cookieName = `bot_hub_panel_access_${url.pathname.split('/')[3] ?? ''}`;
  const cookieToken = String(req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === cookieName)?.[1];
  if (cookieToken) return cookieToken;
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.BOT_HUB_ALLOW_QUERY_TOKEN === '1'
  )
    return String(url.searchParams.get('token') ?? '').trim();
  return '';
};

/** Ermittelt, welcher Bot zu einer Anfrage gehört (Laufzeit- oder Panel-Token). */
export const identify = (req, url) => {
  const token = readToken(req, url).slice(0, MAX_TOKEN);
  if (!token) return null;
  for (const [id, value] of runTokens)
    if (sameToken(token, value)) return { id, scope: 'runtime' };
  for (const [id, value] of panelTokens)
    if (sameToken(token, value)) return { id, scope: 'panel' };
  return null;
};

export const hubBaseUrl = () =>
  String(
    process.env.BOT_HUB_URL || `http://127.0.0.1:${process.env.PORT || 8787}`,
  ).replace(/\/+$/, '');

const parseDotenv = (content) => {
  const values = {};
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
      if (match[2].trim().startsWith('"'))
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
};

const discordConfig = (bot) => {
  // OAuth credentials belong to the bot panel, not to the hub globally.
  // Only the Python Echo panel is currently allowed to use Discord OAuth.
  const pythonBotDir = resolve(projectRoot(), 'bots/python-echo');
  if (
    resolve(projectRoot(), bot.cwd || '.') !== pythonBotDir ||
    bot.language !== 'python'
  )
    return { clientId: '', clientSecret: '' };
  const envPath = join(botDir(bot), '.env');
  try {
    const values = parseDotenv(readFileSync(envPath, 'utf8'));
    return {
      clientId: String(values.DISCORD_CLIENT_ID ?? '').trim(),
      clientSecret: String(values.DISCORD_CLIENT_SECRET ?? '').trim(),
    };
  } catch (error) {
    if (error.code !== 'ENOENT')
      console.error(
        '[hub] Discord-Konfiguration konnte nicht gelesen werden:',
        error.message,
      );
    return { clientId: '', clientSecret: '' };
  }
};

const discordCookie = (req, botId) =>
  String(req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === `bot_hub_panel_${botId}`)?.[1] ?? '';

const panelSessionKey = (req, botId) => {
  const header = String(req.headers['x-bot-hub-token'] ?? '');
  const cookieName = `bot_hub_panel_access_${botId}`;
  const cookie = String(req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === cookieName)?.[1];
  const candidate = header || cookie || '';
  const token = panelTokens.get(botId);
  return token && sameToken(candidate, token) ? `${botId}:${token}` : '';
};

const discordSession = (req, botId) => {
  const cookieId = discordCookie(req, botId);
  const sessionId =
    cookieId || discordPanelSessions.get(panelSessionKey(req, botId));
  const session = discordSessions.get(sessionId);
  if (session?.expiresAt <= Date.now()) {
    discordSessions.delete(sessionId);
    const key = panelSessionKey(req, botId);
    if (discordPanelSessions.get(key) === sessionId)
      discordPanelSessions.delete(key);
    return null;
  }
  return session?.expiresAt > Date.now() ? session : null;
};

const panelCookie = (botId, value, maxAge = 7 * 24 * 60 * 60) =>
  `bot_hub_panel_${botId}=${value}; Max-Age=${maxAge}; Path=/api/bots/${encodeURIComponent(
    botId,
  )}/panel; HttpOnly; SameSite=Lax${
    process.env.NODE_ENV === 'production' ? '; Secure' : ''
  }`;

const discordGuildAllowed = (guild) => {
  try {
    const permissions = BigInt(String(guild.permissions ?? '0'));
    return (
      (permissions & DISCORD_ADMINISTRATOR) === DISCORD_ADMINISTRATOR ||
      (permissions & DISCORD_MANAGE_GUILD) === DISCORD_MANAGE_GUILD
    );
  } catch {
    return false;
  }
};

const discordRequest = async (path, accessToken, scheme = 'Bearer') => {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `${scheme} ${accessToken}` },
  });
  if (!response.ok)
    throw httpError(502, 'Discord-Daten konnten nicht geladen werden');
  return response.json();
};

const botGuilds = async (bot) => {
  const token = String(bot.secretEnv?.DISCORD_BOT_TOKEN ?? '').trim();
  if (!token) return new Set();
  const guilds = await discordRequest('/users/@me/guilds', token, 'Bot');
  return new Set(guilds.map((guild) => String(guild.id)));
};

const discordOrigin = (req) => {
  const configured = String(process.env.BOT_HUB_URL ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.PORT || 8787}`;
};

const panelDiscordAuth = async (bot, req, res, url, rest) => {
  const { clientId, clientSecret } = discordConfig(bot);
  const redirectUri = `${discordOrigin(req)}/api/bots/${bot.id}/panel/discord/callback`;
  if (rest === 'discord/config' && req.method === 'GET')
    return sendJson(res, 200, {
      configured: Boolean(clientId && clientSecret),
      redirectUri,
    });
  if (rest === 'discord/login' && req.method === 'GET') {
    const panelKey = panelSessionKey(req, bot.id);
    if (!panelKey) throw httpError(403, 'Panel-Token erforderlich');
    if (!clientId || !clientSecret)
      throw httpError(
        503,
        'Discord-Login ist für dieses Panel nicht konfiguriert',
      );
    const state = randomBytes(24).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    discordAuthStates.set(state, {
      botId: bot.id,
      panelKey,
      codeVerifier,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify guilds',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'consent',
    });
    res.writeHead(302, {
      location: `https://discord.com/oauth2/authorize?${params}`,
    });
    return res.end();
  }
  if (rest === 'discord/callback' && req.method === 'GET') {
    const state = discordAuthStates.get(url.searchParams.get('state') ?? '');
    discordAuthStates.delete(url.searchParams.get('state') ?? '');
    const code = url.searchParams.get('code');
    if (
      !state ||
      state.botId !== bot.id ||
      state.panelKey !== panelSessionKey(req, bot.id) ||
      state.expiresAt <= Date.now() ||
      !code
    )
      throw httpError(400, 'Ungültige Discord-Anmeldung');
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: state.codeVerifier,
      }),
    });
    if (!tokenResponse.ok) throw httpError(502, 'Discord-Login fehlgeschlagen');
    const token = await tokenResponse.json();
    const [user, guilds, installedGuildIds] = await Promise.all([
      discordRequest('/users/@me', token.access_token),
      discordRequest('/users/@me/guilds', token.access_token),
      botGuilds(bot),
    ]);
    const sessionId = randomUUID();
    discordSessions.set(sessionId, {
      user: {
        id: user.id,
        name: user.global_name ?? user.username,
        avatar: user.avatar,
      },
      guilds: guilds
        .filter(discordGuildAllowed)
        .filter((guild) => installedGuildIds.has(String(guild.id)))
        .map(({ id, name, icon, owner, permissions }) => ({
          id,
          name,
          icon,
          owner: Boolean(owner),
          permissions: String(permissions ?? '0'),
        })),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    const key = panelSessionKey(req, bot.id);
    if (key) discordPanelSessions.set(key, sessionId);
    res.writeHead(302, {
      location: `/api/bots/${bot.id}/panel/file/panel/index.html?discord=connected`,
      'set-cookie': panelCookie(bot.id, sessionId),
    });
    return res.end();
  }
  if (rest === 'discord/session' && req.method === 'GET') {
    const session = discordSession(req, bot.id);
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      user: session?.user ?? null,
      guilds: session?.guilds ?? [],
    });
  }
  if (rest === 'discord/logout' && req.method === 'POST') {
    const sessionId =
      discordCookie(req, bot.id) ||
      discordPanelSessions.get(panelSessionKey(req, bot.id));
    discordSessions.delete(sessionId);
    const key = panelSessionKey(req, bot.id);
    if (discordPanelSessions.get(key) === sessionId)
      discordPanelSessions.delete(key);
    res.setHeader('set-cookie', panelCookie(bot.id, '', 0));
    return sendJson(res, 200, { ok: true });
  }
  return false;
};

/**
 * Verknüpft die zentrale Hub-Sitzung mit dem Panel, ohne OAuth-Codes oder
 * Discord-Access-Tokens an die Bot-Seite zu übergeben.
 */
export const linkHubDiscordSession = async (
  bot,
  req,
  res,
  authSession,
  panelAccessToken = '',
) => {
  if (!authSession?.user) return;
  const cookieSessionId = discordCookie(req, bot.id);
  const existing = discordSession(req, bot.id);
  const panelKey = panelAccessToken
    ? `${bot.id}:${panelAccessToken}`
    : panelSessionKey(req, bot.id);
  if (existing?.user?.id === authSession.user.id) {
    const existingId =
      cookieSessionId || discordPanelSessions.get(panelSessionKey(req, bot.id));
    if (panelKey && existingId) discordPanelSessions.set(panelKey, existingId);
    return;
  }

  const installedGuildIds = await botGuilds(bot);
  const sessionId = randomUUID();
  discordSessions.set(sessionId, {
    user: {
      id: authSession.user.id,
      name: authSession.user.name,
      username: authSession.user.username,
      avatar: authSession.user.avatar ?? null,
    },
    guilds: (authSession.guilds ?? [])
      .filter(discordGuildAllowed)
      .filter((guild) => installedGuildIds.has(String(guild.id)))
      .map(({ id, name, icon, owner, permissions }) => ({
        id,
        name,
        icon: icon ?? null,
        owner: Boolean(owner),
        permissions: String(permissions ?? '0'),
      })),
    expiresAt: Math.min(
      authSession.expiresAt,
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ),
  });
  if (panelKey) discordPanelSessions.set(panelKey, sessionId);
  res.setHeader('set-cookie', panelCookie(bot.id, sessionId));
};

/* ------------------------------------------------------------------ *
 * Eingaben normalisieren
 * ------------------------------------------------------------------ */
const text = (value, max = 160) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

const slug = (value) =>
  String(value ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 40);

const numberOr = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Erlaubt nur relative Pfade ohne ".." – sonst liefert die Funktion ''. */
const safeRelPath = (value) => {
  const raw = text(value, 240).replace(/\\/g, '/');
  if (!raw || isAbsolute(raw) || raw.startsWith('~')) return '';
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.includes('..')) return '';
  return parts.join('/');
};

const coerce = (type, value) => {
  if (type === 'boolean')
    return value === true || value === 'true' || value === 1 || value === '1';
  if (type === 'number') return numberOr(value, 0);
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value).slice(0, 2000);
};

const normaliseOptions = (raw) => {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list.slice(0, MAX_OPTIONS)) {
    const value =
      typeof item === 'object' && item !== null
        ? text(item.value ?? item.label, 120)
        : text(item, 120);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value,
      label: text(
        typeof item === 'object' && item !== null
          ? (item.label ?? item.value)
          : item,
        120,
      ),
    });
  }
  return out;
};

const normaliseField = (raw) => {
  const key = slug(raw?.key);
  if (!key) return null;
  const type = FIELD_TYPES.has(raw?.type) ? raw.type : 'text';
  const field = {
    key,
    type,
    label: text(raw?.label, 80) || key,
    description: text(raw?.description, 200),
    placeholder: text(raw?.placeholder, 80),
    default: coerce(type, raw?.default),
  };
  if (type === 'select') field.options = normaliseOptions(raw?.options);
  if (type === 'number') {
    field.min = raw?.min === undefined ? undefined : numberOr(raw.min, 0);
    field.max = raw?.max === undefined ? undefined : numberOr(raw.max, 0);
    field.step = raw?.step === undefined ? undefined : numberOr(raw.step, 1);
  }
  if (type === 'secret') field.secret = true;
  return field;
};

const normaliseCommand = (raw) => {
  const id = slug(raw?.id);
  if (!id) return null;
  const structured = typeof raw?.executable === 'string';
  const executable = text(raw?.executable, 120);
  const args = Array.isArray(raw?.args)
    ? raw.args.filter((arg) => typeof arg === 'string').map((arg) => text(arg, 240))
    : [];
  const legacy = text(raw?.run, 400);
  const commandText = structured
    ? [executable, ...args].join(' ')
    : legacy;
  if (/[;&|`$<>]/.test(commandText)) return null;
  const parsed = structured
    ? { executable, args }
    : (() => {
        const parts = commandText.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
        return {
          executable: parts.shift()?.replace(/^(['"])|(['"])$/g, '') ?? '',
          args: parts.map((part) => part.replace(/^(['"])|(['"])$/g, '')),
        };
      })();
  if (!parsed.executable && commandText) return null;
  return {
    id,
    label: text(raw?.label, 60) || id,
    description: text(raw?.description, 200),
    run: commandText,
    executable: parsed.executable,
    args: parsed.args,
    danger: Boolean(raw?.danger),
  };
};

const normalisePage = (raw) => {
  const id = slug(raw?.id);
  const href = safeRelPath(raw?.href);
  if (!id || !href) return null;
  return { id, label: text(raw?.label, 60) || id, href };
};

/**
 * Prüft ein Manifest. Ohne nutzbaren Inhalt kommt null zurück – dann zeigt das
 * Dashboard statt einer leeren Seite die Anleitung zum Andocken.
 */
export const normalisePanel = (input) => {
  if (!input || typeof input !== 'object') return null;
  const panel = {
    title: text(input.title, 60) || 'Bot-Seite',
    icon: text(input.icon, 4) || '🧩',
    description: text(input.description, 200),
    entry: safeRelPath(input.entry),
    pages: (Array.isArray(input.pages) ? input.pages : [])
      .map(normalisePage)
      .filter(Boolean)
      .slice(0, MAX_PAGES),
    fields: (Array.isArray(input.settings) ? input.settings : [])
      .map(normaliseField)
      .filter(Boolean)
      .slice(0, MAX_FIELDS),
    commands: (Array.isArray(input.commands) ? input.commands : [])
      .map(normaliseCommand)
      .filter(Boolean)
      .slice(0, MAX_COMMANDS),
  };
  const empty =
    !panel.entry &&
    !panel.pages.length &&
    !panel.fields.length &&
    !panel.commands.length;
  return empty ? null : panel;
};

/* ------------------------------------------------------------------ *
 * Manifest von der Platte
 * ------------------------------------------------------------------ */
const projectRoot = () =>
  resolve(process.env.BOT_DASHBOARD_ROOT || process.cwd());

const botDir = (bot) => {
  const root = realpathSync(projectRoot());
  const dir = realpathSync(resolve(root, bot.cwd || '.'));
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw httpError(400, 'Arbeitsordner liegt außerhalb des Projekts');
  return dir;
};

const dotenvKey = (key) => {
  const normalized = String(key)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
  return /^[A-Z_]/.test(normalized) ? normalized : `_${normalized}`;
};

const dotenvValue = (value) =>
  `"${String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;

/**
 * Spiegelt die im Panel definierten Werte in eine lokale .env-Datei.
 * Die Datei wird absichtlich mit 0600 angelegt, weil sie Secret-Felder
 * enthalten kann.
 */
const writePanelEnv = (bot, settings) => {
  const fields = bot.panel?.manifest?.fields ?? [];
  const values = new Map();
  for (const [key, value] of Object.entries(bot.env ?? {}))
    values.set(dotenvKey(key), value);
  for (const [key, value] of Object.entries(bot.secretEnv ?? {}))
    values.set(dotenvKey(key), value);
  for (const field of fields) {
    const key = dotenvKey(field.key);
    values.set(key, settings[field.key] ?? '');
  }
  if (!values.size) return;

  const content = [...values.entries()]
    .map(([key, value]) => `${key}=${dotenvValue(value)}`)
    .join('\n');
  const dir = botDir(bot);
  const envPath = join(dir, '.env');
  const tempPath = join(dir, `.env.bot-hub.tmp-${process.pid}-${Date.now()}`);

  try {
    writeFileSync(tempPath, `${content}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, envPath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Der ursprüngliche Fehler ist die relevante Diagnose.
    }
    throw httpError(
      500,
      `.env konnte nicht gespeichert werden: ${error.message}`,
    );
  }
};

export const syncBotEnv = (bot) => writePanelEnv(bot, effectiveSettings(bot));

const readManifest = (bot) => {
  let dir;
  try {
    dir = botDir(bot);
  } catch {
    return null;
  }
  const path = MANIFEST_NAMES.map((name) => join(dir, name)).find((file) =>
    existsSync(file),
  );
  if (!path) return null;

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const cached = manifestCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size)
    return cached.value;

  let value = null;
  try {
    if (stat.size > MANIFEST_MAX_BYTES)
      throw new Error('Manifest ist zu groß (max. 128 KB)');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const source = raw?.hub?.panel ?? raw?.panel ?? raw;
    const manifest = normalisePanel(source);
    const content = readFileSync(path);
    value = {
      manifest,
      path,
      signature: createHash('sha1')
        .update(`${MANIFEST_SCHEMA}:${content}`)
        .digest('hex'),
      error: manifest
        ? ''
        : 'Manifest enthält weder Seite noch Einstellungen/Aktionen',
    };
  } catch (error) {
    value = { manifest: null, path, signature: '', error: error.message };
  }
  manifestCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
};

/* ------------------------------------------------------------------ *
 * Zustand am Bot
 * ------------------------------------------------------------------ */
export const emptyPanel = () => ({
  manifest: null,
  source: null,
  path: '',
  signature: '',
  settings: {},
  secretSettings: {},
  state: {},
  error: '',
  registeredAt: null,
  updatedAt: null,
});

export const hydratePanel = (stored) => {
  const panel = { ...emptyPanel(), ...(stored ?? {}) };
  panel.state = {};
  panel.error = text(stored?.error, 200);
  panel.manifest = normalisePanel(stored?.manifest);
  panel.settings = stored?.settings ?? {};
  panel.secretSettings = stored?.secretSettings ?? {};
  return panel;
};

const applyPanel = (bot, { manifest, path, signature, error }, source) => {
  const previous = bot.panel ?? emptyPanel();
  if (previous.source === source && previous.signature === signature) return;

  const settings = {};
  const secretSettings = {};
  for (const field of manifest.fields) {
    const stored = field.secret
      ? previous.secretSettings[field.key]
      : previous.settings[field.key];
    if (stored === undefined) continue;
    if (field.secret) secretSettings[field.key] = String(stored);
    else settings[field.key] = stored;
  }

  bot.panel = {
    manifest,
    source,
    path,
    signature,
    error,
    settings,
    secretSettings,
    state: previous.state ?? {},
    registeredAt: previous.registeredAt ?? Date.now(),
    updatedAt: Date.now(),
  };
  markDirty(bot);
};

/**
 * Manifest bzw. Laufzeit-Anmeldung in `bot.panel` spiegeln.
 * Ein Manifest auf der Platte schlägt immer die Anmeldung des Prozesses.
 */
export const ensurePanel = (bot) => {
  if (!bot.panel) bot.panel = emptyPanel();
  const fromFile = readManifest(bot);
  if (fromFile) {
    if (fromFile.manifest) applyPanel(bot, fromFile, 'manifest');
    else if (!bot.panel.manifest) {
      bot.panel = {
        ...emptyPanel(),
        error: fromFile.error,
        path: fromFile.path,
      };
    }
    return bot.panel;
  }
  if (bot.panel.source === 'manifest') {
    // Werte bleiben erhalten, falls das Manifest nur temporär weg ist.
    bot.panel = {
      ...bot.panel,
      manifest: null,
      source: null,
      signature: '',
      error: 'Manifest nicht gefunden – hat es den Pfad verlassen?',
    };
    markDirty(bot);
  }
  return bot.panel;
};

/** Registrierung eines laufenden Prozesses (Manifest hat Vorrang). */
const registerPanel = (bot, manifest) => {
  const panel = bot.panel ?? emptyPanel();
  if (panel.source === 'manifest')
    throw httpError(
      409,
      `Der Ordner enthält ein Manifest (${panel.path}) – dieses hat Vorrang.`,
    );
  const signature = createHash('sha1')
    .update(JSON.stringify(manifest))
    .digest('hex');
  if (panel.source !== 'runtime' || panel.signature !== signature) {
    applyPanel(
      bot,
      {
        manifest,
        path: '',
        signature,
        error: '',
      },
      'runtime',
    );
    broadcastEvent('panel', { id: bot.id, panel: publicPanel(bot) });
  }
  return publicPanel(bot);
};

/* ------------------------------------------------------------------ *
 * Einstellungen
 * ------------------------------------------------------------------ */
export const effectiveSettings = (bot) => {
  const out = {};
  for (const field of bot.panel?.manifest?.fields ?? [])
    out[field.key] = field.default;
  Object.assign(out, bot.panel?.settings ?? {});
  Object.assign(out, bot.panel?.secretSettings ?? {});
  return out;
};

const publicSettings = (bot) => {
  const secretKeys = new Set(
    (bot.panel?.manifest?.fields ?? [])
      .filter((field) => field.secret)
      .map((field) => field.key),
  );
  return Object.fromEntries(
    Object.entries(effectiveSettings(bot)).filter(
      ([key]) => !secretKeys.has(key),
    ),
  );
};

const defaultsOf = (bot) => {
  const out = {};
  for (const field of bot.panel?.manifest?.fields ?? [])
    out[field.key] = field.default;
  return out;
};

/**
 * Schreibt Einstellungen. `••••••••` bedeutet "unverändert lassen", ein leeres
 * Geheimnis wird entfernt. Unbekannte Schlüssel werden verworfen.
 */
export const saveSettings = (bot, incoming) => {
  const fields = new Map(
    (bot.panel?.manifest?.fields ?? []).map((field) => [field.key, field]),
  );
  if (!fields.size)
    throw httpError(400, 'Dieser Bot hat keine Einstellungen definiert');

  const settings = { ...bot.panel.settings };
  const secretSettings = { ...bot.panel.secretSettings };
  for (const [key, raw] of Object.entries(incoming ?? {})) {
    const field = fields.get(key);
    if (!field) continue;
    if (field.secret) {
      const value = String(raw ?? '');
      if (value === MASK) continue;
      if (value === '') delete secretSettings[key];
      else secretSettings[key] = value.slice(0, 2000);
      continue;
    }
    settings[key] = coerce(field.type, raw);
  }
  if (
    isEqual(settings, bot.panel.settings) &&
    isEqual(secretSettings, bot.panel.secretSettings)
  ) {
    writePanelEnv(bot, effectiveSettings(bot));
    return { changed: false, settings: publicSettings(bot) };
  }

  const nextPanel = {
    ...bot.panel,
    settings,
    secretSettings,
    updatedAt: Date.now(),
  };
  writePanelEnv(bot, {
    ...effectiveSettings({ ...bot, panel: nextPanel }),
  });

  bot.panel = nextPanel;
  markDirty(bot);
  broadcastEvent('panel', { id: bot.id, panel: publicPanel(bot) });
  pushToBot(bot.id, 'settings', { settings: effectiveSettings(bot) });
  return { changed: true, settings: publicSettings(bot) };
};

const isEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ *
 * Live-Zustand für die Bot-Seite
 * ------------------------------------------------------------------ */
export const pushState = (bot, state) => {
  if (!state || typeof state !== 'object' || Array.isArray(state))
    throw httpError(400, 'state muss ein Objekt sein');
  let size = 0;
  try {
    size = JSON.stringify(state).length;
  } catch {
    throw httpError(400, 'state ist nicht serialisierbar');
  }
  if (size > MAX_STATE_BYTES)
    throw httpError(
      413,
      `state ist zu groß (max. ${MAX_STATE_BYTES / 1024} KB)`,
    );
  bot.panel = { ...(bot.panel ?? emptyPanel()), state, updatedAt: Date.now() };
  broadcastEvent('panel', { id: bot.id, state });
  return state;
};

export const notifyUser = (bot, message, kind = 'info') => {
  const text = String(message ?? '').slice(0, 300);
  if (!text) throw httpError(400, 'message fehlt');
  broadcastEvent('toast', {
    botId: bot.id,
    name: bot.name,
    emoji: bot.emoji,
    message: text,
    kind: ['success', 'error', 'info', 'warn'].includes(kind) ? kind : 'info',
  });
  return { ok: true };
};

/* ------------------------------------------------------------------ *
 * Ereignis-Stream für den Bot selbst
 * ------------------------------------------------------------------ */
const pushToBot = (id, type, payload) => {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of botStreams.get(id) ?? []) {
    try {
      res.write(frame);
    } catch {
      botStreams.get(id)?.delete(res);
    }
  }
};

const openBotStream = (bot, req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  res.write(
    `event: settings\ndata: ${JSON.stringify({ settings: effectiveSettings(bot) })}\n\n`,
  );
  if (!botStreams.has(bot.id)) botStreams.set(bot.id, new Set());
  botStreams.get(bot.id).add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 20000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    botStreams.get(bot.id)?.delete(res);
  });
};

/* ------------------------------------------------------------------ *
 * Aktionen (Callback-URL oder Skript)
 * ------------------------------------------------------------------ */
const registerCallback = (bot, url, token) => {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw httpError(400, 'callback.url ist keine gültige URL');
  }
  if (!LOOPBACK.has(parsed.hostname))
    throw httpError(
      400,
      'callback.url muss auf localhost zeigen (127.0.0.1, ::1 oder localhost)',
    );
  callbacks.set(bot.id, { url: parsed.toString(), token: text(token, 200) });
  broadcastEvent('panel', { id: bot.id, panel: publicPanel(bot) });
  return { ok: true, url: parsed.origin };
};

const callCallback = async (bot, hook, command, args) => {
  const payload = JSON.stringify({
    id: command.id,
    label: command.label,
    args: args ?? {},
    settings: effectiveSettings(bot),
    bot: { id: bot.id, name: bot.name, guildId: bot.guildId },
  });
  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bot-hub-token': hook.token,
      },
      body: payload,
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT),
    });
    const raw = (await response.text()).slice(0, MAX_OUTPUT);
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* Antwort war kein JSON – Rohtext reicht */
    }
    return { ok: response.ok, via: 'callback', status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      via: 'callback',
      error: `Callback nicht erreichbar: ${error.message}`,
    };
  }
};

const runScript = (bot, command, args) =>
  new Promise((resolveRun) => {
    const dir = botDir(bot);
    const settings = effectiveSettings(bot);
    const executable = command.executable;
    const commandArgs = command.args ?? [];
    if (
      isAbsolute(executable) ||
      executable.includes('..') ||
      commandArgs.some(
        (arg) =>
          isAbsolute(arg) ||
          arg.split(/[\\/]/).includes('..') ||
          /[;&|`$<>]/.test(arg),
      )
    ) {
      resolveRun({
        ok: false,
        via: 'script',
        error: 'Panel-Befehl enthält einen unzulässigen Pfad oder Shell-Operator',
      });
      return;
    }
    const child = spawn(executable, commandArgs, {
      cwd: dir,
      env: {
        ...envFor(bot, dir),
        ...settingEnv(settings),
        BOT_HUB_ID: bot.id,
        BOT_HUB_NAME: bot.name,
        BOT_HUB_COMMAND: command.id,
        BOT_HUB_COMMAND_LABEL: command.label,
        BOT_HUB_ARGS: JSON.stringify(args ?? {}),
        BOT_HUB_SETTINGS: JSON.stringify(settings),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (data) => {
      out += data.toString();
    });
    child.stderr.on('data', (data) => {
      err += data.toString();
    });

    const killer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, SCRIPT_TIMEOUT);
    killer.unref();

    child.on('error', (error) => {
      clearTimeout(killer);
      resolveRun({ ok: false, via: 'script', error: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(killer);
      const output = out.trim().slice(0, MAX_OUTPUT);
      const errors = err.trim().slice(0, MAX_OUTPUT);
      let data = output;
      try {
        data = JSON.parse(output);
      } catch {
        /* Rohtext reicht */
      }
      resolveRun({
        ok: code === 0,
        via: 'script',
        code: code ?? -1,
        output: output || errors,
        data,
        error: code === 0 ? null : errors || `Exit-Code ${code}`,
      });
    });
  });

/** Bitte den Bot, seine Live-Werte sofort neu zu melden – nicht erst beim
 * nächsten Herzschlag. Geht ins Leere, wenn kein Prozess läuft. */
const askBotForValues = (bot, reason) => {
  if (!bot.child) return;
  pushToBot(bot.id, 'refresh', { reason });
};

export const runAction = async (bot, commandId, args) => {
  ensurePanel(bot);
  const command = (bot.panel?.manifest?.commands ?? []).find(
    (item) => item.id === commandId,
  );
  if (!command) throw httpError(404, `Unbekannte Aktion "${commandId}"`);
  const hook = callbacks.get(bot.id);
  if (hook && bot.child) {
    const result = await callCallback(bot, hook, command, args);
    askBotForValues(bot, `command:${commandId}`);
    return result;
  }
  if (command.run) {
    const result = await runScript(bot, command, args);
    askBotForValues(bot, `command:${commandId}`);
    return result;
  }
  throw httpError(
    501,
    `Für "${command.label}" ist weder ein Skript (run) noch eine Callback-URL hinterlegt.`,
  );
};

/* ------------------------------------------------------------------ *
 * Umgebungsvariablen für Bot und Skripte
 * ------------------------------------------------------------------ */
const settingEnv = (settings) => {
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(settings)) {
    if (count >= MAX_FIELDS) break;
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    if (typeof value === 'object') continue;
    out[`BOT_HUB_SETTING_${key.toUpperCase()}`] = String(value);
    count += 1;
  }
  return out;
};

/** Alles, was der Hub dem gestarteten Prozess mitgibt. */
export const hubEnv = (bot, dir) => {
  const settings = effectiveSettings(bot);
  return {
    BOT_HUB_URL: hubBaseUrl(),
    BOT_HUB_ID: bot.id,
    BOT_HUB_NAME: bot.name,
    BOT_HUB_TOKEN: issueRuntimeToken(bot.id),
    BOT_HUB_MANIFEST: bot.panel?.path || relative(projectRoot(), dir),
    BOT_HUB_PANEL: `/api/bots/${bot.id}/panel`,
    BOT_HUB_SETTINGS: JSON.stringify(settings),
    ...settingEnv(settings),
  };
};

/* ------------------------------------------------------------------ *
 * Öffentliche Form
 * ------------------------------------------------------------------ */
export const publicPanel = (bot) => {
  const panel = bot.panel ?? emptyPanel();
  const manifest = panel.manifest;
  const settings = {};
  const secrets = {};
  for (const field of manifest?.fields ?? []) {
    const value = effectiveSettings(bot)[field.key];
    if (field.secret) secrets[field.key] = value ? MASK : '';
    else settings[field.key] = value;
  }
  return {
    available: Boolean(manifest),
    source: panel.source ?? null,
    manifestPath: panel.path ?? '',
    title: manifest?.title ?? '',
    icon: manifest?.icon ?? '🧩',
    description: manifest?.description ?? '',
    entry: manifest?.entry ?? '',
    pages: manifest?.pages ?? [],
    fields: manifest?.fields ?? [],
    commands: manifest?.commands ?? [],
    settings,
    secrets,
    secretKeys: Object.keys(panel.secretSettings ?? {}),
    defaults: defaultsOf(bot),
    state: panel.state ?? {},
    error: panel.error ?? '',
    online: Boolean(bot.child),
    callback: callbacks.has(bot.id),
    registeredAt: panel.registeredAt ?? null,
    updatedAt: panel.updatedAt ?? null,
  };
};

/* ------------------------------------------------------------------ *
 * Statische Dateien der Bot-Seite
 * ------------------------------------------------------------------ */
const sendFile = (res, path) => {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw httpError(404, 'Datei nicht gefunden');
  }
  if (!stat.isFile()) throw httpError(404, 'Datei nicht gefunden');
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // Panel-Dateien bleiben auch dann in einer opaken Origin, wenn jemand sie
    // direkt statt im Dashboard-iframe öffnet.
    'content-security-policy':
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock; default-src 'none'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' http: https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; base-uri 'none'; frame-ancestors 'self'",
  });
  res.end(readFileSync(path));
};

const servePanelFile = (bot, res, rest, publicStatic = false) => {
  const rel = safeRelPath(decodeURIComponent(rest));
  if (!rel) throw httpError(400, 'Ungültiger Pfad');
  if (publicStatic) {
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    if (
      !new Set([
        '.html',
        '.css',
        '.js',
        '.mjs',
        '.svg',
        '.woff2',
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.webp',
        '.ico',
      ]).has(ext)
    )
      throw httpError(404, 'Datei nicht gefunden');
    const entry =
      bot.panel?.manifest?.entry || bot.panel?.manifest?.pages?.[0]?.href || '';
    const root = entry.includes('/') ? entry.split('/')[0] : '';
    if (root && rel !== root && !rel.startsWith(`${root}/`))
      throw httpError(404, 'Datei nicht gefunden');
  }
  let dir;
  let target;
  try {
    dir = realpathSync(botDir(bot));
    target = realpathSync(join(dir, rel));
  } catch {
    throw httpError(404, 'Datei nicht gefunden');
  }
  const inside = relative(dir, target);
  const parts = inside.split(/[\\/]/);
  const sensitiveName =
    /^(?:\.env(?:\..*)?|\.git|\.npmrc|\.pypirc|id_(?:rsa|ed25519)|authorized_keys|known_hosts|.*(?:secret|credential|password|token).*)$/i;
  if (
    !inside ||
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    parts.some((part) => part.startsWith('.') || sensitiveName.test(part)) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(target)
  )
    throw httpError(400, 'Ungültiger Pfad');
  sendFile(res, target);
};

const BRIDGE_SOURCE = `/* Von \${location.origin}/api/bots/<id>/panel/bridge.js ausgeliefert.
 *
 * Im Bot-Fenster läuft diese Seite in einer Sandbox (opaker Origin) und erreicht
 * den Hub über postMessage an das Elternfenster – nicht über fetch. Im neuen Tab
 * gibt es kein Elternfenster, dann spricht die Seite mit derselben Panel-API
 * direkt, angemeldet mit dem Token aus dem URL-Hash.
 */
const parts = location.pathname.split('/').filter(Boolean);
const botId = parts[0] === 'api' && parts[1] === 'bots' ? (parts[2] ?? '') : '';
const embedded = window.parent !== window;
let token = new URLSearchParams(location.hash.slice(1)).get('hub') ?? '';

const pending = new Map();
let counter = 0;

const ask = (type, extra = {}) =>
  new Promise((resolveCall, rejectCall) => {
    const seq = ++counter;
    pending.set(seq, { resolve: resolveCall, reject: rejectCall });
    parent.postMessage({ source: 'bot-hub-panel', seq, type, ...extra }, '*');
    setTimeout(() => {
      if (!pending.has(seq)) return;
      pending.delete(seq);
      rejectCall(new Error('Zeitüberschreitung – ist das Dashboard noch offen?'));
    }, 15000);
  });

if (embedded) {
  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const data = event.data ?? {};
    if (data.source !== 'bot-hub') return;
    if (data.type === 'hello') token = data.token ?? token;
    if (data.seq && pending.has(data.seq)) {
      const { resolve: done, reject } = pending.get(data.seq);
      pending.delete(data.seq);
      if (data.error) reject(new Error(data.error));
      else done(data.payload ?? {});
    }
  });
}

/* --- Ohne Elternfenster: derselbe Aufruf per fetch an die Panel-API. --- */

const request = async (url, method, body) => {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-bot-hub-token': token },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!response.ok)
    throw new Error(data.error ?? 'HTTP ' + response.status + ' von ' + url);
  return data;
};

const base = '/api/bots/' + encodeURIComponent(botId) + '/panel';
let who = { id: botId, name: '', emoji: '' };
let last = null;

/** Aus dem Hub-Panel die Sicht für die Bot-Seite machen (und merken). */
const view = (panel) => {
  if (!panel) return null;
  last = panel;
  return {
    fields: panel.fields,
    settings: panel.settings,
    secrets: panel.secrets,
    state: panel.state,
    online: panel.online,
    // Nur die sichtbaren Angaben – der Pfad des Skripts bleibt im Hub.
    commands: (panel.commands ?? []).map(
      ({ id, label, description, danger }) => ({ id, label, description, danger }),
    ),
    bot: who,
  };
};

const direct = {
  async 'settings:get'() {
    const data = await request(base, 'GET');
    who = data.bot ?? who;
    return view(data.panel);
  },
  async 'settings:set'({ values }) {
    await request(base + '/settings', 'PUT', { values });
    return direct['settings:get']();
  },
  async command({ id, args }) {
    const { result } = await request(
      base + '/commands/' + encodeURIComponent(id),
      'POST',
      { args },
    );
    // Werte danach neu holen, damit sich die Seite ohne zweiten Klick
    // aktualisiert. Was der Bot erst danach meldet, kommt über den Strom.
    return {
      ok: result.ok,
      result: result.data ?? result,
      payload: await direct['settings:get'](),
    };
  },
  async 'state:set'({ state }) {
    await request(base + '/state', 'PUT', { state });
    return { ok: true, payload: view(last ? { ...last, state } : null) };
  },
  async notify({ message, kind }) {
    await request('/api/hub/notify', 'POST', { message, kind });
    return { ok: true };
  },
  async 'discord:config'() {
    return request(base + '/discord/config', 'GET');
  },
  async 'discord:session'() {
    return request(base + '/discord/session', 'GET');
  },
  async 'discord:logout'() {
    return request(base + '/discord/logout', 'POST', {});
  },
};

const call = (type, extra) =>
  embedded ? ask(type, extra) : direct[type](extra);

/* Der eigene Tab hört auf denselben Ereignisstrom wie das Dashboard und meldet
 * Änderungen über window – so verarbeitet die Seite beides gleich. */
if (!embedded) {
  let refreshing = false;
  setInterval(async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const payload = await direct['settings:get']();
      if (payload) window.postMessage({ source: 'bot-hub', type: 'settings', payload }, '*');
    } catch {
      // Die Seite bleibt benutzbar, auch wenn der Bot vorübergehend stoppt.
    } finally {
      refreshing = false;
    }
  }, 5000);
}

export const hub = {
  get token() {
    return token;
  },
  settings: () => call('settings:get'),
  save: (values) => call('settings:set', { values }),
  command: (id, args = {}) => call('command', { id, args }),
  state: (state) => call('state:set', { state }),
  notify: (message, kind = 'info') => call('notify', { message, kind }),
  discordConfig: () => call('discord:config'),
  discordSession: () => call('discord:session'),
  discordLogout: () => call('discord:logout'),
};

if (embedded) parent.postMessage({ source: 'bot-hub-panel', type: 'ready' }, '*');
`;

/* ------------------------------------------------------------------ *
 * Routen: /api/bots/:id/panel/...
 * ------------------------------------------------------------------ */
export const handlePanelRoutes = async (
  bot,
  req,
  res,
  url,
  authSession = null,
  panelTokenAuth = false,
  publicStatic = false,
) => {
  const parts = url.pathname.split('/').filter(Boolean).slice(3); // ohne api/bots/:id
  if (parts[0] === 'panel') parts.shift();
  const rest = parts.join('/');
  ensurePanel(bot);

  const authResult = await panelDiscordAuth(bot, req, res, url, rest);
  if (authResult !== false) return authResult;

  if (
    panelTokenAuth &&
    !(
      (req.method === 'GET' &&
        (!rest ||
          rest === 'settings' ||
          rest === 'discord/session' ||
          rest === 'discord/config' ||
          rest === 'bridge.js' ||
          rest.startsWith('file/'))) ||
      (req.method === 'PUT' && (rest === 'settings' || rest === 'state')) ||
      (req.method === 'POST' &&
        (rest === 'discord/logout' || rest.startsWith('commands/')))
    )
  )
    throw httpError(403, 'Diese Panel-Aktion ist nur im Dashboard erlaubt');

  if (req.method === 'GET' && !rest) {
    await linkHubDiscordSession(bot, req, res, authSession);
    return sendJson(res, 200, {
      panel: publicPanel(bot),
      // Für die Bot-Seite im neuen Tab: sie hat kein Elternfenster und braucht
      // den Namen für ihren Kopf, sonst bleibt er leer.
      bot: { id: bot.id, name: bot.name, emoji: bot.emoji },
      bridge: {
        token: panelToken(bot.id),
        file: `/api/bots/${bot.id}/panel/bridge.js`,
        base: `/api/bots/${bot.id}/panel`,
      },
    });
  }

  if (req.method === 'POST' && rest === 'reload') {
    const path = bot.panel?.path;
    manifestCache.delete(path);
    // Leere Signatur erzwingt das erneute Einlesen; gespeicherte Werte und
    // Geheimnisse bleiben erhalten, applyPanel übernimmt nur passende Felder.
    bot.panel = { ...(bot.panel ?? emptyPanel()), signature: '' };
    ensurePanel(bot);
    markDirty(bot);
    broadcastEvent('panel', { id: bot.id, panel: publicPanel(bot) });
    return sendJson(res, 200, { panel: publicPanel(bot) });
  }

  if (req.method === 'DELETE' && !rest) {
    callbacks.delete(bot.id);
    bot.panel = emptyPanel();
    markDirty(bot);
    broadcastEvent('panel', { id: bot.id, panel: publicPanel(bot) });
    return sendJson(res, 200, { panel: publicPanel(bot) });
  }

  if (req.method === 'PUT' && rest === 'settings') {
    const body = await readBody(req);
    const result = saveSettings(bot, body.values ?? {});
    return sendJson(res, 200, { panel: publicPanel(bot), ...result });
  }

  if (req.method === 'GET' && rest === 'settings')
    return sendJson(res, 200, { settings: publicSettings(bot) });

  if (req.method === 'PUT' && rest === 'state') {
    const body = await readBody(req);
    return sendJson(res, 200, { state: pushState(bot, body.state ?? {}) });
  }

  if (req.method === 'POST' && rest.startsWith('commands/')) {
    const commandId = decodeURIComponent(rest.slice('commands/'.length));
    const body = await readBody(req);
    const result = await runAction(bot, commandId, body.args ?? {});
    return sendJson(res, 200, { result });
  }

  if (req.method === 'GET' && rest === 'bridge.js') {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(BRIDGE_SOURCE);
  }

  if (req.method === 'GET' && rest.startsWith('file/'))
    return servePanelFile(bot, res, rest.slice('file/'.length), publicStatic);

  throw httpError(405, 'Methode nicht erlaubt');
};

/* ------------------------------------------------------------------ *
 * Routen: /api/hub/... (Aufrufer ist der Bot selbst)
 * ------------------------------------------------------------------ */
const sessionOf = (bot, runtime) => ({
  bot: {
    id: bot.id,
    name: bot.name,
    emoji: bot.emoji,
    language: bot.language,
    framework: bot.framework,
    cwd: bot.cwd,
    guildId: bot.guildId,
    status: bot.status,
  },
  baseUrl: hubBaseUrl(),
  panelUrl: `${hubBaseUrl()}/api/bots/${bot.id}/panel`,
  manifestPath: bot.panel?.path ?? '',
  source: bot.panel?.source ?? null,
  settings: runtime ? effectiveSettings(bot) : publicSettings(bot),
  panelToken: panelToken(bot.id),
  commands: (bot.panel?.manifest?.commands ?? []).map(
    ({ id, label, description, danger }) => ({
      id,
      label,
      description,
      danger,
    }),
  ),
});

export const handleHubRoutes = async (req, res, url, getBot) => {
  const identity = identify(req, url);
  if (!identity)
    throw httpError(
      401,
      'Ungültiges oder fehlendes Token – nutze BOT_HUB_TOKEN aus deiner Umgebung.',
    );
  const bot = getBot(identity.id);
  if (!bot) throw httpError(404, 'Bot nicht gefunden');
  const rest = url.pathname.slice('/api/hub'.length);
  ensurePanel(bot);
  const runtime = identity.scope === 'runtime';

  if (req.method === 'GET' && (rest === '' || rest === '/session'))
    return sendJson(res, 200, sessionOf(bot, runtime));

  if (req.method === 'GET' && rest === '/settings')
    return sendJson(res, 200, {
      settings: runtime ? effectiveSettings(bot) : publicPanel(bot).settings,
    });

  if (req.method === 'PUT' && rest === '/settings') {
    if (!runtime)
      throw httpError(
        403,
        'Nur der laufende Prozess darf Werte überschreiben.',
      );
    const body = await readBody(req);
    const result = saveSettings(bot, body.values ?? {});
    return sendJson(res, 200, { panel: publicPanel(bot), ...result });
  }

  if (req.method === 'GET' && rest === '/events') {
    if (!runtime)
      throw httpError(403, 'Der Ereignis-Stream ist dem Prozess vorbehalten.');
    return openBotStream(bot, req, res);
  }

  if (req.method === 'POST' && rest === '/panel') {
    if (!runtime)
      throw httpError(
        403,
        'Neue Seiten kann nur der Prozess selbst anmelden (BOT_HUB_TOKEN).',
      );
    const body = await readBody(req);
    const manifest = normalisePanel(body.panel ?? body);
    if (!manifest)
      throw httpError(
        400,
        'panel braucht mindestens entry, settings, commands oder pages.',
      );
    return sendJson(res, 200, { panel: registerPanel(bot, manifest) });
  }

  if (req.method === 'POST' && rest === '/callback') {
    if (!runtime)
      throw httpError(
        403,
        'Nur der laufende Prozess darf eine Callback-URL setzen.',
      );
    const body = await readBody(req);
    if (body.url === null || body.url === '') callbacks.delete(bot.id);
    else return sendJson(res, 200, registerCallback(bot, body.url, body.token));
    broadcastEvent('panel', { id: bot.id, panel: publicPanel(bot) });
    return sendJson(res, 200, { ok: true, url: null });
  }

  if (req.method === 'POST' && rest === '/state') {
    const body = await readBody(req);
    return sendJson(res, 200, { state: pushState(bot, body.state ?? body) });
  }

  if (req.method === 'POST' && rest === '/notify') {
    const body = await readBody(req);
    return sendJson(res, 200, notifyUser(bot, body.message, body.kind));
  }

  throw httpError(404, 'Unbekannter Hub-Endpunkt');
};
