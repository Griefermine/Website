/**
 * Bot-Erweiterung ("Panel"): eigene Seite, Einstellungen und Aktionen im Hub.
 *
 * Zwei Wege, wie ein Bot anknüpft:
 *
 *   1. Manifest – der Startordner enthält `bot-hub.json`. Kein Code nötig,
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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  httpError,
  isEvalFlag,
  MIME,
  parseDotenv,
  readBody,
  sendJson,
  MASK,
} from './util.js';
import { getLanguage } from './languages.js';
import { secureCookies } from './auth.js';
import { database } from './database.js';
import {
  dotenvKey,
  formatDotenv,
  readSecretValues,
  storeSecretValues,
} from './secrets.js';
import {
  containerRuntimeEnabled,
  containerRuntimeName,
  ensureContainer,
  execArgs,
  stopContainer,
} from './containers.js';

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
const panelBootstrapTokens = new Map();
const panelSessionTokens = new Map();
const callbacks = new Map();
const manifestCache = new Map();
const botStreams = new Map();
const discordAuthStates = new Map();
/** Einmalige Start-Erlaubnis für den Discord-Login (60 s, siehe discord/login). */
const discordLoginTickets = new Map();
const discordSessions = new Map();
const discordPanelSessions = new Map();
/**
 * Basis-URL der Discord-API. Ueberschreibbar nur im Testbetrieb, damit sich
 * der komplette OAuth-Flow ohne echtes Discord prüfen lässt - in Produktion
 * ist die Umleitung nicht erreichbar.
 */
const DISCORD_API =
  process.env.NODE_ENV === 'test' &&
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(
    String(process.env.BOT_HUB_DISCORD_API ?? ''),
  )
    ? String(process.env.BOT_HUB_DISCORD_API).replace(/\/+$/, '')
    : 'https://discord.com/api/v10';
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
  for (const [key, value] of panelBootstrapTokens) {
    if (value.expiresAt <= now) panelBootstrapTokens.delete(key);
  }
  for (const [key, value] of panelSessionTokens) {
    if (value.expiresAt <= now) panelSessionTokens.delete(key);
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

export const issuePanelBootstrapToken = (botId) => {
  const token = newToken();
  panelBootstrapTokens.set(token, {
    botId,
    expiresAt: Date.now() + 60_000,
  });
  return token;
};

const consumePanelBootstrapToken = (botId, token) => {
  const entry = panelBootstrapTokens.get(String(token ?? ''));
  panelBootstrapTokens.delete(String(token ?? ''));
  if (!entry || entry.botId !== botId || entry.expiresAt <= Date.now())
    return false;
  const sessionToken = newToken();
  panelSessionTokens.set(sessionToken, {
    botId,
    expiresAt: Date.now() + 60 * 60 * 1000,
  });
  return sessionToken;
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
  const bootstrap = req.headers['x-bot-hub-bootstrap'];
  if (bootstrap) {
    const sessionToken = consumePanelBootstrapToken(
      url.pathname.split('/')[3] ?? '',
      bootstrap,
    );
    if (sessionToken) return sessionToken;
  }
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
  const session = panelSessionTokens.get(token);
  if (session?.expiresAt > Date.now())
    return { id: session.botId, scope: 'panel' };
  return null;
};

export const hubBaseUrl = () =>
  String(
    process.env.BOT_HUB_CONTAINER_URL ||
      process.env.BOT_HUB_URL ||
      `http://127.0.0.1:${process.env.PORT || 8787}`,
  ).replace(/\/+$/, '');

const discordConfig = (bot) => {
  // OAuth credentials belong to the hub, not to the bot workspace.
  // Trust boundary: bots/<id>/workspace/.env ist Bot-writable (untrusted)
  // und darf die OAuth-App des Panels nicht bestimmen. Nur
  // data/secrets/<bot-id>.env (0600, Hub-kontrolliert) zählt.
  try {
    const securePath = join(projectRoot(), 'data', 'secrets', `${bot.id}.env`);
    const values = existsSync(securePath)
      ? parseDotenv(readFileSync(securePath, 'utf8'))
      : {};
    const oauthUrl = String(values.DISCORD_OAUTH_URL ?? '').trim();
    let oauthClientId = '';
    try {
      oauthClientId = new URL(oauthUrl).searchParams.get('client_id') ?? '';
    } catch {
      // Die URL wird beim eigentlichen Login separat validiert.
    }
    return {
      clientId:
        String(values.DISCORD_CLIENT_ID ?? '').trim() || oauthClientId.trim(),
      clientSecret: String(
        values.DISCORD_CLIENT_SECRET ?? values.DISCORD_CLIENT_TOKEN ?? '',
      ).trim(),
      oauthUrl,
      redirectUri: String(values.DISCORD_REDIRECT_URI ?? '').trim(),
    };
  } catch (error) {
    if (error.code !== 'ENOENT')
      console.error(
        '[hub] Discord-Konfiguration konnte nicht gelesen werden:',
        error.message,
      );
    return { clientId: '', clientSecret: '', redirectUri: '' };
  }
};

const requiresPanelDiscordLogin = (bot) => {
  const { clientId, clientSecret } = discordConfig(bot);
  return Boolean(clientId || clientSecret);
};

const requirePanelDiscordLogin = (bot, req) => {
  if (!requiresPanelDiscordLogin(bot)) return;
  const { clientId, clientSecret } = discordConfig(bot);
  if (!clientId || !clientSecret)
    throw httpError(
      503,
      'Bot-Anmeldung ist in der lokalen Bot-.env nicht vollständig konfiguriert',
    );
  if (!discordSession(req, bot.id))
    throw httpError(401, 'Bitte zuerst in diesem Bot-Panel anmelden');
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
  if (token && sameToken(candidate, token)) return `${botId}:${token}`;
  const session = panelSessionTokens.get(candidate);
  return session?.botId === botId && session.expiresAt > Date.now()
    ? `${botId}:${candidate}`
    : '';
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
  )}/panel; HttpOnly; SameSite=Lax${secureCookies() ? '; Secure' : ''}`;

/**
 * Voranmeldung-Kennung: bindet den Callback an den Browser, der den Login
 * gestartet hat. Ohne diese Bindung kann ein Angreifer seinen eigenen
 * Callback-Url an ein Opfer weiterreichen; dessen Browser übernimmt dann die
 * Discord-Sitzung des Angreifers (Login-CSRF / Account-Switching). PKCE allein
 * genügt nicht dafür - es beweist nur, dass der Code zum selben Flow gehört.
 */
const PRE_AUTH_TTL_MS = 10 * 60 * 1000;

const preAuthCookie = (botId, value, maxAge = PRE_AUTH_TTL_MS / 1000) =>
  `bot_hub_preauth_${botId}=${value}; Max-Age=${maxAge}; Path=/api/bots/${encodeURIComponent(
    botId,
  )}/panel; HttpOnly; SameSite=Lax${secureCookies() ? '; Secure' : ''}`;

const preAuthId = (req, botId) =>
  String(req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === `bot_hub_preauth_${botId}`)?.[1] ?? '';

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

/**
 * Verwirft ein Access-Token, dessen Nutzer abgelehnt wurde. Best effort: der
 * Aufruf darf den Abbruch nicht verhindern, wenn Discord nicht erreichbar ist.
 */
const revokeDiscordToken = async (clientId, clientSecret, accessToken) => {
  try {
    await fetch(`${DISCORD_API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: String(accessToken),
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* Das Token verfällt ohnehin von selbst. */
  }
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

/**
 * Adresse, unter der die Bot-Seite laufen muss.
 *
 * Der Discord-Login bindet den Callback an den Browser über ein Cookie, und
 * Cookies gelten nur für den Host, bei dem sie gesetzt wurden. Das Cookie
 * entsteht auf der Bot-Seite, der Callback kommt über die bei Discord
 * registrierte Redirect-Adresse zurück. Landen beide auf verschiedenen Hosts
 * (typisch im Entwicklungsbetrieb: Dashboard auf localhost:5173, Redirect auf
 * 127.0.0.1:8787), findet der Callback das Cookie nicht und die Anmeldung
 * scheitert. Deshalb hängt der Hub die Bot-Seite an genau die Adresse, die
 * später auch den Callback bekommt.
 */
export const panelPageOrigin = (bot) => {
  const { redirectUri } = discordConfig(bot);
  if (redirectUri && validRedirectUri(redirectUri, bot.id)) {
    try {
      return new URL(redirectUri).origin;
    } catch {
      /* unten liegt der Fallback */
    }
  }
  return discordOrigin();
};

export const hubOrigin = () => {
  const configured = String(process.env.BOT_HUB_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const validRedirectUri = (value, botId) => {
  let redirect;
  try {
    redirect = new URL(value);
  } catch {
    return false;
  }
  if (
    !['https:', 'http:'].includes(redirect.protocol) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.pathname !==
      `/api/bots/${encodeURIComponent(botId)}/panel/discord/callback`
  )
    return false;
  // Userinfo-Angriffe (https://hub@evil/) sind oben bereits ausgeschlossen,
  // Host-Lookalikes (hub.example.evil.example) werden unten durch den
  // exakten Origin-Vergleich ausgeschlossen.
  if (redirect.protocol === 'http:' && !LOOPBACK.has(redirect.hostname))
    return false;
  const hub = hubOrigin();
  if (hub) {
    // Autoritative Origin aus BOT_HUB_URL: scheme + hostname + kanonischer
    // Port müssen übereinstimmen. http in Produktion ist verboten, außer
    // explizit Loopback/Development.
    const canonicalPort = (url) =>
      url.port || (url.protocol === 'https:' ? '443' : '80');
    if (
      redirect.protocol !== hub.protocol ||
      redirect.hostname.toLowerCase() !== hub.hostname.toLowerCase() ||
      canonicalPort(redirect) !== canonicalPort(hub)
    )
      return false;
    if (
      process.env.NODE_ENV === 'production' &&
      redirect.protocol === 'http:' &&
      !LOOPBACK.has(redirect.hostname)
    )
      return false;
  } else if (
    process.env.NODE_ENV === 'production' &&
    redirect.protocol === 'http:'
  ) {
    return false;
  }
  return true;
};

const panelDiscordAuth = async (bot, req, res, url, rest) => {
  const {
    clientId,
    clientSecret,
    oauthUrl,
    redirectUri: configuredRedirectUri,
  } = discordConfig(bot);
  let authorizationUrl;
  try {
    authorizationUrl = new URL(
      oauthUrl || 'https://discord.com/oauth2/authorize',
    );
  } catch {
    throw httpError(503, 'Discord-OAuth-URL ist ungültig');
  }
  if (
    authorizationUrl.protocol !== 'https:' ||
    authorizationUrl.hostname !== 'discord.com' ||
    authorizationUrl.pathname !== '/oauth2/authorize'
  )
    throw httpError(503, 'Discord-OAuth-URL ist ungültig');
  const redirectUri =
    configuredRedirectUri ||
    authorizationUrl.searchParams.get('redirect_uri') ||
    `${discordOrigin(req)}/api/bots/${bot.id}/panel/discord/callback`;
  if (!validRedirectUri(redirectUri, bot.id))
    throw httpError(503, 'Discord-Redirect-URL ist ungültig');
  if (rest === 'discord/config' && req.method === 'GET')
    return sendJson(res, 200, {
      configured: Boolean(clientId && clientSecret),
      redirectUri,
    });
  if (rest === 'discord/login' && req.method === 'GET') {
    const ticketKey = url.searchParams.get('ticket') ?? '';
    const ticket = ticketKey ? discordLoginTickets.get(ticketKey) : null;
    if (ticketKey) discordLoginTickets.delete(ticketKey);
    // Das Ticket ist der Nachweis der abrufenden Seite: ein fetch aus der
    // Sandbox der Bot-Seite darf den Login anstoßen, aber der Browser muss
    // die Start-Adresse selbst aufrufen (Cookie!), sonst legt der Hub den
    // State in einer Umgebung an, in der das Cookie nicht ankommt.
    const panelKey = ticket ? ticket.panelKey : panelSessionKey(req, bot.id);
    if (
      !panelKey ||
      (ticket && (ticket.botId !== bot.id || ticket.expiresAt <= Date.now()))
    )
      throw httpError(
        403,
        ticketKey
          ? 'Dieser Login-Aufruf ist abgelaufen. Bitte erneut anmelden.'
          : 'Panel-Token erforderlich',
      );
    if (!clientId || !clientSecret)
      throw httpError(
        503,
        clientId
          ? 'DISCORD_CLIENT_SECRET oder DISCORD_CLIENT_TOKEN fehlt in der Bot-.env'
          : 'DISCORD_CLIENT_ID oder DISCORD_OAUTH_URL mit client_id fehlt in der Bot-.env',
      );
    // Abruf per fetch liefert nur ein Ticket für die Start-Adresse. Ohne das
    // Ticket entsteht hier nichts: der State gehört in den Browser, der sich
    // anmeldet, sonst könnte ihn jemand im fremden Browser anlegen und einem
    // Opfer weiterreichen (Login-CSRF).
    if (url.searchParams.get('format') === 'json') {
      const now = Date.now();
      for (const [key, value] of discordLoginTickets)
        if (value.expiresAt <= now) discordLoginTickets.delete(key);
      const ticketValue = randomBytes(24).toString('hex');
      discordLoginTickets.set(ticketValue, {
        botId: bot.id,
        panelKey,
        expiresAt: now + 60_000,
      });
      return sendJson(res, 200, {
        location: `${panelPageOrigin(bot)}/api/bots/${encodeURIComponent(
          bot.id,
        )}/panel/discord/login?ticket=${ticketValue}`,
        redirectUri,
      });
    }
    const state = randomBytes(24).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const preAuth = randomBytes(24).toString('hex');
    discordAuthStates.set(state, {
      botId: bot.id,
      panelKey,
      panelToken: panelKey.slice(`${bot.id}:`.length),
      codeVerifier,
      preAuth,
      expiresAt: Date.now() + PRE_AUTH_TTL_MS,
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
    for (const [key, value] of params)
      authorizationUrl.searchParams.set(key, value);
    res.writeHead(302, {
      location: authorizationUrl.href,
      'set-cookie': preAuthCookie(bot.id, preAuth),
      'cache-control': 'no-store',
    });
    return res.end();
  }
  if (rest === 'discord/callback' && req.method === 'GET') {
    const stateKey = url.searchParams.get('state') ?? '';
    const state = discordAuthStates.get(stateKey);
    discordAuthStates.delete(stateKey);
    if (url.searchParams.has('error'))
      throw httpError(400, 'Discord-Anmeldung wurde abgebrochen');
    const code = url.searchParams.get('code');
    // Drei Bedingungen müssen zusammenpassen: der State gehört zu diesem Bot,
    // er ist noch nicht abgelaufen, und der Browser, der den Callback öffnet,
    // ist derselbe, der den Login gestartet hat.
    const browser = preAuthId(req, bot.id);
    if (
      !state ||
      state.botId !== bot.id ||
      state.expiresAt <= Date.now() ||
      !code
    )
      throw httpError(400, 'Ungültige Discord-Anmeldung');
    if (!browser || browser !== state.preAuth) {
      // Nur die Namen, nie die Werte – im Log stehen keine Geheimnisse.
      const names = String(req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim().split('=')[0])
        .filter(Boolean)
        .join(', ');
      console.error(
        `[hub] Panel-Login "${bot.name}": keine passende Voranmeldung-Kennung. ` +
          `Callback-Host ${String(req.headers.host ?? '?')}, ` +
          `Cookies: ${names || 'keine'}.`,
      );
      throw httpError(
        400,
        browser
          ? 'Diese Discord-Anmeldung gehört zu einem anderen Login-Versuch. Bitte im selben Fenster erneut anmelden.'
          : 'Diese Discord-Anmeldung wurde in einem anderen Browser oder unter einer anderen Adresse gestartet. Bitte die Bot-Seite über die Hub-Adresse öffnen und dort erneut anmelden.',
      );
    }
    if (!clientId || !clientSecret)
      throw httpError(503, 'Bot-Anmeldung ist nicht konfiguriert');
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
    if (typeof token.access_token !== 'string' || !token.access_token)
      throw httpError(502, 'Discord-Login lieferte kein gültiges Token');
    const [user, guilds, installedGuildIds] = await Promise.all([
      discordRequest('/users/@me', token.access_token),
      discordRequest('/users/@me/guilds', token.access_token),
      botGuilds(bot),
    ]);
    // Autorisiert wird nur gegen die Guild, für die der Bot hier konfiguriert
    // ist. Eine andere Guild, in der derselbe Benutzer zufällig
    // „Server verwalten" hat, ist kein Ersatz - sonst könnte ein fremder
    // Server-Admin das Panel eines Bots bedienen, der gar nicht für ihn läuft.
    //
    // Ohne Bot-Token lässt sich nicht feststellen, wo der Bot installiert ist;
    // dann bleibt die Prüfung der Berechtigung in der Ziel-Guild.
    const targetGuild = String(bot.guildId ?? '').trim();
    const installed = installedGuildIds.size ? installedGuildIds : null;
    const allowed = guilds
      .filter(discordGuildAllowed)
      .filter((guild) => !installed || installed.has(String(guild.id)))
      .filter((guild) => !targetGuild || String(guild.id) === targetGuild);
    if (!allowed.length) {
      // Das Token wird nicht weitergegeben; die Sitzung entsteht gar nicht.
      await revokeDiscordToken(clientId, clientSecret, token.access_token);
      console.warn(
        `[hub] Discord-Anmeldung für ${bot.name} abgewiesen: ${
          targetGuild
            ? `keine Berechtigung in der Ziel-Guild ${targetGuild}`
            : 'kein Server mit passender Berechtigung'
        }${installed ? '' : ' (Bot hat kein DISCORD_BOT_TOKEN – Ziel-Guild nicht prüfbar)'}.`,
      );
      throw httpError(
        403,
        targetGuild
          ? `In dem Server, für den dieser Bot läuft, fehlt dir die Berechtigung (Administrator oder Server verwalten)${
              installed ? '' : ' oder der Bot ist dort nicht installiert'
            }.`
          : 'Du hast in keinem Server, in dem dieser Bot installiert ist, die Berechtigung (Administrator oder Server verwalten).',
      );
    }
    const sessionId = randomUUID();
    discordSessions.set(sessionId, {
      user: {
        id: user.id,
        name: user.global_name ?? user.username,
        avatar: user.avatar,
      },
      guilds: allowed.map(({ id, name, icon, owner, permissions }) => ({
        id,
        name,
        icon,
        owner: Boolean(owner),
        permissions: String(permissions ?? '0'),
      })),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    // Der OAuth-Callback kommt aus dem Discord-Popup und enthält den
    // ursprünglichen Panel-Token nicht zuverlässig. Der signierte State
    // bindet die neue Discord-Session bereits eindeutig an dieses Panel.
    if (state.panelKey) discordPanelSessions.set(state.panelKey, sessionId);
    res.writeHead(302, {
      location: `/api/bots/${bot.id}/panel/file/panel/index.html?discord=connected`,
      'set-cookie': [
        panelCookie(bot.id, sessionId),
        preAuthCookie(bot.id, '', 0),
      ],
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
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

/*
 * The dashboard session is intentionally not forwarded to bot panels.
 */
const linkHubDiscordSession = async (
  bot,
  req,
  res,
  authSession,
  panelAccessToken = '',
) => {
  return;
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
    ? raw.args
        .filter((arg) => typeof arg === 'string')
        .map((arg) => text(arg, 240))
    : [];
  const legacy = text(raw?.run, 400);
  const commandText = structured ? [executable, ...args].join(' ') : legacy;
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
  // Gespeicherte Manifeste liegen bereits normalisiert vor (dann heißen die
  // Felder `fields` statt `settings`). Ohne diese Zweigstelle verlöre ein Bot
  // nach jedem Neustart seine Formularfelder – Befehle und Seiten blieben,
  // weil sie unter demselben Namen gespeichert werden.
  const rawFields = Array.isArray(input.settings)
    ? input.settings
    : Array.isArray(input.fields)
      ? input.fields
      : [];
  const panel = {
    title: text(input.title, 60) || 'Bot-Seite',
    icon: text(input.icon, 4) || '🧩',
    description: text(input.description, 200),
    entry: safeRelPath(input.entry),
    pages: (Array.isArray(input.pages) ? input.pages : [])
      .map(normalisePage)
      .filter(Boolean)
      .slice(0, MAX_PAGES),
    fields: rawFields.map(normaliseField).filter(Boolean).slice(0, MAX_FIELDS),
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

const workspaceDir = (bot) => {
  const root = realpathSync(projectRoot());
  if (process.env.BOT_HUB_TEST_MODE === '1') return root;
  const workspaceInput = bot.workspaceRoot || `bots/${bot.id}/workspace`;
  if (isAbsolute(workspaceInput))
    throw httpError(400, 'Ungültiger Bot-Workspace');
  const botsRoot = realpathSync(resolve(root, 'bots'));
  const workspace = realpathSync(resolve(root, workspaceInput));
  const rel = relative(botsRoot, workspace);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw httpError(400, 'Bot-Workspace liegt außerhalb des Projekts');
  return workspace;
};

const botDir = (bot) => {
  const workspace = workspaceDir(bot);
  const dir = realpathSync(resolve(workspace, bot.cwd || '.'));
  const rel = relative(workspace, dir);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw httpError(
      400,
      'Der Startordner liegt ausserhalb des Workspace dieses Bots',
    );
  return dir;
};

/**
 * Spiegelt die im Panel definierten Werte in die Secret-Datei des Hubs und –
 * im Testbetrieb – zusätzlich in den Workspace des Bots.
 *
 * `data/secrets/<id>.env` wird in jedem Betriebsmodus geschrieben: dort
 * liegen die Werte, aus denen der Hub sie beim Start wieder einliest. Im
 * Testbetrieb schreibt der Hub zusätzlich nach `<workspace>/.env`, damit der
 * Bot seine .env im eigenen Ordner findet.
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

  try {
    storeSecretValues(projectRoot(), bot.id, Object.fromEntries(values), {
      merge: false,
    });
  } catch (error) {
    throw httpError(
      500,
      `.env konnte nicht gespeichert werden: ${error.message}`,
    );
  }

  if (process.env.BOT_HUB_TEST_MODE !== '1') return;
  const targetDir = botDir(bot);
  const tempPath = join(
    targetDir,
    `.env.bot-hub.tmp-${bot.id}-${process.pid}-${Date.now()}`,
  );
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    writeFileSync(tempPath, formatDotenv(values), {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, join(targetDir, '.env'));
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
  // Die Datei auf der Platte ist die Wahrheit. Ist der Hub-Stand unvollständig
  // – etwa weil eine ältere Hub-Version die Felder beim Speichern verloren hat
  // –, wird das Manifest erneut angewendet, statt die Lücke zu übernehmen.
  const unvollstaendig =
    manifest.fields.length > (previous.manifest?.fields?.length ?? 0) ||
    manifest.commands.length > (previous.manifest?.commands?.length ?? 0);
  if (
    previous.source === source &&
    previous.signature === signature &&
    !unvollstaendig
  )
    return;

  // Geheime Felder älterer Stände stehen ausschließlich in der .env des Bots,
  // weil bots.json sie nie enthalten hat. Fehlt ein Wert im Hub-Stand, wird er
  // von dort übernommen – sonst wäre er nach einem Neustart verloren.
  let fromFile;
  const fileValue = (key) => {
    fromFile ??= readSecretValues(projectRoot(), bot.id);
    const value = fromFile[dotenvKey(key)];
    return value === undefined || value === '' ? undefined : value;
  };

  const settings = {};
  const secretSettings = {};
  for (const field of manifest.fields) {
    const stored = field.secret
      ? (previous.secretSettings[field.key] ?? fileValue(field.key))
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
  takeRuntimeRate(bot.id, 'state', MAX_STATE_UPDATES_PER_MINUTE);
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
  takeRuntimeRate(bot.id, 'notify', MAX_NOTIFICATIONS_PER_MINUTE);
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

const MAX_RUNTIME_SSE_PER_BOT = 4;
const MAX_STATE_UPDATES_PER_MINUTE = 60;
const MAX_NOTIFICATIONS_PER_MINUTE = 30;
const runtimeBuckets = new Map();

const takeRuntimeRate = (botId, kind, limit) => {
  if (process.env.BOT_HUB_TEST_MODE === '1') return;
  const key = `${botId}:${kind}`;
  const now = Date.now();
  const bucket = runtimeBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    runtimeBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    const error = httpError(429, 'Zu viele Anfragen – bitte kurz warten.');
    error.retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    throw error;
  }
};

const openBotStream = (bot, req, res) => {
  if (process.env.BOT_HUB_TEST_MODE !== '1') {
    const current = botStreams.get(bot.id)?.size ?? 0;
    if (current >= MAX_RUNTIME_SSE_PER_BOT) {
      const error = httpError(429, 'Zu viele Ereignis-Streams für diesen Bot.');
      error.retryAfter = 10;
      throw error;
    }
  }
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
/**
 * Callback-Ziele prüfen.
 *
 * Standardmäßig ist ausschließlich Loopback erlaubt: der Hub ruft damit nur den
 * Prozess an, der sich selbst gemeldet hat. Das ist bewusst die enge Variante –
 * der Hub wäre sonst für jeden Bot ein offener Client, der beliebige Adressen
 * im Netz abklopft (SSRF) und über Umgehungstechniken wie DNS-Rebinding auch
 * interne Dienste erreicht.
 *
 * Für Container, deren Loopback der Hub nicht teilt, kann ein Betreiber Ziele
 * ausdrücklich freigeben: `BOT_HUB_CALLBACK_ALLOW=host:port,host`.
 */
const callbackAllowlist = () =>
  new Set(
    String(process.env.BOT_HUB_CALLBACK_ALLOW ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

/** Loopback über den echten Adresstyp, nicht über einen Zeichenketten-Vergleich. */
const isLoopbackAddress = (address) => {
  const text = String(address ?? '').toLowerCase();
  // IPv4-Schreibweisen, die ein Parser als Adresse erkennt.
  if (isIP(text) === 4) return /^127\./.test(text);
  if (isIP(text) === 6) {
    if (text === '::1' || text === '0:0:0:0:0:0:0:1') return true;
    // IPv4-mapped: ::ffff:127.0.0.1 ist ebenfalls Loopback.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (mapped) return /^127\./.test(mapped[1]);
  }
  return false;
};

/** Alle Adressen eines Namens – eine einzige reicht nicht, sonst gewinnt der letzte Eintrag. */
const resolveAll = async (hostname) => {
  try {
    const found = await lookup(hostname, { all: true, verbatim: true });
    return found.map((item) => item.address);
  } catch {
    return [];
  }
};

/**
 * `new URL` bringt jede Schreibweise einer IPv4-Adresse auf die kanonische Form,
 * bevor hier etwas geprüft wird: `2130706433`, `127.1`, `0177.0.0.1` und
 * `0x7f.1` stehen danach alle als `127.0.0.1` da, `2852039166` als
 * `169.254.169.254`. Deshalb genügt der Vergleich mit der normalisierten
 * Adresse – und deshalb wird unten auch genau die Adresse gespeichert und
 * aufgerufen, die geprüft wurde.
 */
const isMetadataAddress = (address) => {
  const text = String(address ?? '').toLowerCase();
  // Cloud-Metadaten + Link-Local dürfen auch via Allowlist nie erreicht werden:
  // allowlist = welcher öffentliche Host erlaubt ist, nicht "darf überall hin".
  if (text === '169.254.169.254' || text === '169.254.169.253') return true;
  if (text.startsWith('169.254.')) return true;
  if (text === '::ffff:169.254.169.254' || text === '::ffff:169.254.169.253')
    return true;
  return false;
};

const assertCallbackTarget = async (parsed) => {
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const allow = callbackAllowlist();
  const allowlisted = allow.has(hostname) || allow.has(`${hostname}:${port}`);
  if (allowlisted) {
    // Auch allowlistete Hosts müssen auflösbar sein und dürfen nie auf
    // Cloud-Metadaten zeigen. Private Netze bleiben explizites Operator-
    // Opt-in, Metadaten nie.
    if (isIP(hostname)) {
      if (isMetadataAddress(hostname))
        throw httpError(
          400,
          'callback.url: Metadaten-Adresse ist nie erlaubt.',
        );
      return hostname;
    }
    const addresses = await resolveAll(hostname);
    if (addresses.length === 0)
      throw httpError(400, 'callback.url: Hostname lässt sich nicht auflösen');
    if (addresses.some((address) => isMetadataAddress(address)))
      throw httpError(400, 'callback.url: Metadaten-Adresse ist nie erlaubt.');
    return addresses[0];
  }

  if (isIP(hostname)) {
    if (!isLoopbackAddress(hostname))
      throw httpError(
        400,
        'callback.url darf nur auf den eigenen Rechner zeigen (Loopback). Für andere Ziele braucht es BOT_HUB_CALLBACK_ALLOW.',
      );
    return hostname;
  }

  const addresses = await resolveAll(hostname);
  if (addresses.length === 0)
    throw httpError(400, 'callback.url: Hostname lässt sich nicht auflösen');
  // Jede aufgelöste Adresse muss Loopback sein. Sonst genügt ein DNS-Eintrag
  // mit einer privaten Adresse, um die Beschränkung zu umgehen.
  if (addresses.some((address) => !isLoopbackAddress(address)))
    throw httpError(
      400,
      'callback.url löst auf eine Adresse außerhalb des Loopback auf (SSRF-Schutz). Für andere Ziele braucht es BOT_HUB_CALLBACK_ALLOW.',
    );
  return addresses[0];
};

// Connect to the address that passed policy checks while retaining the URL
// hostname for Host and TLS certificate validation. This closes the DNS
// check/connect gap that otherwise permits DNS rebinding.
const requestCallback = (parsed, address, token, payload) =>
  new Promise((resolve, reject) => {
    let request;
    const timeout = setTimeout(
      () => request.destroy(new Error('Callback-Zeitüberschreitung.')),
      CALLBACK_TIMEOUT,
    );
    timeout.unref();
    request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        method: 'POST',
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          'content-type': 'application/json',
          'x-bot-hub-token': token,
          'content-length': Buffer.byteLength(payload),
        },
        ...(isIP(parsed.hostname.replace(/^\[|\]$/g, ''))
          ? {}
          : {
              lookup: (_hostname, _options, callback) =>
                callback(null, address, isIP(address)),
            }),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_OUTPUT) {
            request.destroy(
              new Error('Callback-Antwort überschreitet das Größenlimit.'),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          clearTimeout(timeout);
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end(payload);
  });

/** Wie lange eine registrierte Callback-Adresse gilt. */
const CALLBACK_TTL = 60 * 60 * 1000;

const registerCallback = async (bot, url, token) => {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw httpError(400, 'callback.url ist keine gültige URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw httpError(400, 'callback.url muss http oder https verwenden');
  await assertCallbackTarget(parsed);
  // Nicht auf den Hub selbst: sonst lässt sich der Hub als Vermittler für
  // eigene Aufrufe benutzen.
  if (
    (parsed.port || (parsed.protocol === 'https:' ? '443' : '80')) ===
    String(process.env.PORT || 8787)
  )
    throw httpError(400, 'callback.url darf nicht auf den Hub selbst zeigen');
  callbacks.set(bot.id, {
    // Die Bot-Id steht mit im Eintrag und wird vor jedem Aufruf geprüft: ein
    // Eintrag kann so nicht für einen anderen Bot verwendet werden.
    botId: bot.id,
    url: parsed.toString(),
    token: text(token, 200),
    registeredAt: Date.now(),
    expiresAt: Date.now() + CALLBACK_TTL,
  });
  broadcastEvent('panel', { id: bot.id, panel: publicPanel(bot) });
  return { ok: true, url: parsed.origin, expiresAt: Date.now() + CALLBACK_TTL };
};

/** Veraltete Einträge und Speicher von Bots, die es nicht mehr gibt, räumen auf. */
const sweepCallbacks = () => {
  const now = Date.now();
  for (const [id, hook] of callbacks)
    if (hook.expiresAt <= now) callbacks.delete(id);
};
const callbackSweep = setInterval(sweepCallbacks, 60_000);
callbackSweep.unref?.();

/** Liest höchstens `max` Bytes – ein Callback soll keine unbegrenzte Flut
 *  in den Hub hängen können. */
const readLimited = async (response, max) => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`Antwort größer als ${max} Byte`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * Wie viele Callback-Aufrufe ein Bot pro Minute auslösen darf. Ohne diese
 * Schranke kann eine Aktion im Panel den Prozess in eine Aufrufschleife treiben.
 */
const CALLBACK_CALLS_PER_MINUTE = 30;
const callbackCalls = new Map();

const takeCallbackCall = (botId) => {
  const key = `${botId}:callback`;
  const now = Date.now();
  const bucket = callbackCalls.get(key);
  if (!bucket || bucket.resetAt <= now) {
    callbackCalls.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > CALLBACK_CALLS_PER_MINUTE)
    throw httpError(429, 'Zu viele Callback-Aufrufe – bitte kurz warten.');
};

const callCallback = async (bot, hook, command, args) => {
  // TTL und Bot-Bindung vor jedem Aufruf prüfen: ein alter Eintrag und ein
  // Eintrag, der für einen anderen Bot abgelegt wurde, werden nicht benutzt.
  if (hook.expiresAt <= Date.now()) {
    callbacks.delete(bot.id);
    return {
      ok: false,
      via: 'callback',
      error: 'Callback abgelaufen – bitte neu registrieren.',
    };
  }
  if (hook.botId !== bot.id)
    return {
      ok: false,
      via: 'callback',
      error: 'Callback gehört zu einem anderen Bot.',
    };
  takeCallbackCall(bot.id);

  const payload = JSON.stringify({
    id: command.id,
    label: command.label,
    args: args ?? {},
    settings: effectiveSettings(bot),
    bot: { id: bot.id, name: bot.name, guildId: bot.guildId },
  });
  try {
    // Das Ziel wird erneut geprüft, nicht nur bei der Registrierung: zwischen
    // beiden Zeitpunkten kann sich ein DNS-Eintrag geändert haben.
    const parsed = new URL(hook.url);
    const address = await assertCallbackTarget(parsed);
    const response = await requestCallback(parsed, address, hook.token, payload);
    const raw = response.body;
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

/**
 * Werkzeuge, die eine Panel-Aktion neben dem Interpreter der Bot-Sprache
 * benutzen darf. Alles, was Dateien übertragen, Netze öffnen oder Prozesse
 * starten kann (curl, wget, nc, ssh …), bleibt außen vor.
 */
const PANEL_RUNTIME_TOOLS = [
  'node',
  'python3',
  'python',
  'sh',
  'bash',
  'echo',
  'printf',
  'cat',
  'ls',
  'test',
  'touch',
  'grep',
  'head',
  'tail',
  'wc',
  'date',
  'true',
  'false',
];

/**
 * Panel-Aktionen unterliegen denselben Regeln wie Start- und
 * Installationsbefehle: nur ein freigegebenes Programm, keine
 * Interpreter-Evaluationsflags und Pfade ausschließlich im Bot-Workspace.
 * Ohne diese Prüfung wäre die HTML-Seite des Bots ein Weg aus seinem
 * Container heraus in den Hub-Rechner.
 */
const scriptSpec = (bot, command, dir) => {
  const executable = String(command.executable ?? '');
  if (!executable || isAbsolute(executable) || /[/\\]/.test(executable))
    throw httpError(
      400,
      'Panel-Befehl braucht ein Programm aus der freigegebenen Runtime',
    );
  const language = getLanguage(bot.language);
  const allowed = new Set(
    [language.runtime, ...PANEL_RUNTIME_TOOLS].filter(Boolean),
  );
  if (!allowed.has(executable))
    throw httpError(
      400,
      'Programm ist für diese Bot-Sprache nicht freigegeben',
    );
  const args = [];
  for (const arg of command.args ?? []) {
    const value = String(arg);
    if (isEvalFlag(value))
      throw httpError(400, 'Interpreter-Evaluationsflags sind nicht erlaubt');
    if (!value.includes('/') && !value.startsWith('.')) {
      args.push(value);
      continue;
    }
    const candidate = resolve(dir, value);
    let trusted = candidate;
    try {
      if (existsSync(candidate)) trusted = realpathSync(candidate);
    } catch {
      trusted = candidate;
    }
    const rel = relative(dir, trusted);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw httpError(400, 'Befehl verweist außerhalb des Bot-Workspace');
    args.push(rel);
  }
  return { executable, args };
};

const runScript = async (bot, command, args) => {
  const dir = botDir(bot);
  let spec;
  try {
    spec = scriptSpec(bot, command, dir);
  } catch (error) {
    return { ok: false, via: 'script', error: error.message };
  }
  const settings = effectiveSettings(bot);
  const scriptEnv = {
    ...envFor(bot, dir),
    ...settingEnv(settings),
    BOT_HUB_ID: bot.id,
    BOT_HUB_NAME: bot.name,
    BOT_HUB_COMMAND: command.id,
    BOT_HUB_COMMAND_LABEL: command.label,
    BOT_HUB_ARGS: JSON.stringify(args ?? {}),
    BOT_HUB_SETTINGS: JSON.stringify(settings),
  };
  // Wie der Bot selbst läuft eine Panel-Aktion im Container des Bots –
  // nicht direkt auf dem Hub-Rechner.
  const inContainer = containerRuntimeEnabled();
  if (inContainer) {
    try {
      await ensureContainer(bot, projectRoot());
    } catch (error) {
      return {
        ok: false,
        via: 'script',
        error: `Container nicht verfügbar: ${error.message}`,
      };
    }
  }
  return new Promise((resolveRun) => {
    const child = spawn(
      inContainer ? containerRuntimeName() : spec.executable,
      inContainer
        ? execArgs(bot, projectRoot(), dir, spec, scriptEnv)
        : spec.args,
      {
        cwd: inContainer ? projectRoot() : dir,
        env: inContainer ? process.env : scriptEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );

    let out = '';
    let err = '';
    let outputExceeded = false;
    const stopForOutputLimit = () => {
      if (outputExceeded) return;
      outputExceeded = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const appendOutput = (current, data) => {
      const chunk = data.toString();
      const remaining = MAX_OUTPUT - current.length;
      if (chunk.length > remaining) stopForOutputLimit();
      return current + chunk.slice(0, Math.max(0, remaining));
    };
    child.stdout.on('data', (data) => {
      out = appendOutput(out, data);
    });
    child.stderr.on('data', (data) => {
      err = appendOutput(err, data);
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
      if (inContainer && !bot.child) stopContainer(bot).catch(() => {});
      resolveRun({ ok: false, via: 'script', error: error.message });
    });

    child.on('exit', (code) => {
      clearTimeout(killer);
      // Nur den Container mitnehmen, den diese Aktion gestartet hat.
      if (inContainer && !bot.child) stopContainer(bot).catch(() => {});
      const output = out.trim().slice(0, MAX_OUTPUT);
      const errors = err.trim().slice(0, MAX_OUTPUT);
      let data = output;
      try {
        data = JSON.parse(output);
      } catch {
        /* Rohtext reicht */
      }
      resolveRun({
        ok: code === 0 && !outputExceeded,
        via: 'script',
        code: code ?? -1,
        output: output || errors,
        data,
        error: outputExceeded
          ? 'Skriptausgabe überschreitet das Größenlimit.'
          : code === 0
            ? null
            : errors || `Exit-Code ${code}`,
      });
    });
  });
};

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
    let result;
    try {
      result = await callCallback(bot, hook, command, args);
    } catch (error) {
      // Rate-Limit und Zielprüfung werfen; im Panel ist das eine Meldung an den
      // Bediener, kein Absturz der Aktion.
      result = { ok: false, via: 'callback', error: error.message };
    }
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
const relativeManifestPath = (absolutePath) => {
  if (!absolutePath) return '';
  try {
    const root = projectRoot();
    const rel = relative(root, absolutePath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return '';
    return rel;
  } catch {
    return '';
  }
};

const publicFields = (manifest) => {
  const out = [];
  for (const field of manifest?.fields ?? []) {
    if (!field || typeof field !== 'object') continue;
    const base = {
      key: field.key,
      type: field.type,
      label: field.label,
      description: field.description,
      placeholder: field.placeholder,
    };
    if (field.type === 'select') base.options = field.options ?? [];
    if (field.type === 'number') {
      if (field.min !== undefined) base.min = field.min;
      if (field.max !== undefined) base.max = field.max;
      if (field.step !== undefined) base.step = field.step;
    }
    if (field.secret) {
      // Secret-Felder verraten nie ihren Wert: kein default, kein value,
      // keine alternativen Property-Namen. Das Frontend weiß nur, dass es
      // ein Secret ist und ob es gesetzt ist (via `secrets` maskiert).
      base.secret = true;
      base.default = '';
    } else {
      base.default = field.default ?? '';
    }
    out.push(base);
  }
  return out;
};

const publicCommands = (manifest) =>
  (manifest?.commands ?? []).map((command) => ({
    id: command.id,
    label: command.label,
    description: command.description,
    danger: Boolean(command.danger),
  }));

const publicDefaults = (bot) => {
  const secretKeys = new Set(
    (bot.panel?.manifest?.fields ?? [])
      .filter((field) => field.secret)
      .map((field) => field.key),
  );
  return Object.fromEntries(
    Object.entries(defaultsOf(bot)).filter(([key]) => !secretKeys.has(key)),
  );
};

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
    manifestPath: relativeManifestPath(panel.path ?? ''),
    title: manifest?.title ?? '',
    icon: manifest?.icon ?? '🧩',
    description: manifest?.description ?? '',
    entry: manifest?.entry ?? '',
    pages: manifest?.pages ?? [],
    fields: publicFields(manifest),
    commands: publicCommands(manifest),
    settings,
    secrets,
    secretKeys: Object.keys(panel.secretSettings ?? {}),
    defaults: publicDefaults(bot),
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
const panelAssetOrigin = (req) => {
  // Autoritativ ist BOT_HUB_URL (V19 #17): Forwarded-Headers werden nicht blind
  // übernommen, sonst bestimmt ein Header die CSP-Origin. Wenn BOT_HUB_URL
  // gesetzt ist, gilt dessen Origin; sonst Same-Host aus Host-Header.
  const configured = String(process.env.BOT_HUB_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (['http:', 'https:'].includes(parsed.protocol)) return parsed.origin;
    } catch {}
  }
  const host = String(req.headers.host ?? '').trim();
  if (!/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d{1,5})?$/i.test(host)) return '';
  // Ohne BOT_HUB_URL kein Forwarded-Proto-Vertrauen: http als sicherer Default.
  return `http://${host}`;
};

const sendFile = (res, path, assetOrigin = '') => {
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
    'content-security-policy': [
      'sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock',
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self'${assetOrigin ? ` ${assetOrigin}` : ''}`,
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
  });
  res.end(readFileSync(path));
};

const servePanelFile = (bot, req, res, rest, publicStatic = false) => {
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
  sendFile(res, target, panelAssetOrigin(req));
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
const panelSessionToken = "";
let token = panelSessionToken;
const bootstrapToken = new URLSearchParams(location.search).get('bootstrap') ?? '';

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
    if (data.type === 'hello') token = '';
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
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-bot-hub-token': token } : {}),
      ...(!token && bootstrapToken
        ? { 'x-bot-hub-bootstrap': bootstrapToken }
        : {}),
    },
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
    // Ueber die Panel-API und nicht ueber /api/hub/notify: dort akzeptiert
    // der Hub nur den Runtime-Token des laufenden Prozesses.
    await request(base + '/notify', 'POST', { message, kind });
    return { ok: true };
  },
  async 'discord:config'() {
    return request(base + '/discord/config', 'GET');
  },
  async 'discord:session'() {
    return request(base + '/discord/session', 'GET');
  },
  async 'discord:login'() {
    // Liefert die Adresse, die der Browser als Navigation aufrufen muss - nicht
    // die Discord-URL. Nur so legt der Hub den State in dem Browser an, der
    // sich anmeldet, und das Bindungs-Cookie bleibt ein eigenes Cookie.
    return request(base + '/discord/login?format=json', 'GET');
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
  // Bewusst ohne Getter fuer das Token: die Seite bekommt Befehle, keine
  // Sitzung. Wer den Token auslesen kann, kann alles, was die Seite kann.
  settings: () => call('settings:get'),
  save: (values) => call('settings:set', { values }),
  command: (id, args = {}) => call('command', { id, args }),
  state: (state) => call('state:set', { state }),
  notify: (message, kind = 'info') => call('notify', { message, kind }),
  discordConfig: () => call('discord:config'),
  discordSession: () => call('discord:session'),
  discordLogin: () => call('discord:login'),
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
  panelTokenAuth = false,
  publicStatic = false,
) => {
  const parts = url.pathname.split('/').filter(Boolean).slice(3); // ohne api/bots/:id
  if (parts[0] === 'panel') parts.shift();
  const rest = parts.join('/');
  ensurePanel(bot);

  if (req.method === 'GET' && rest === 'bridge.js') {
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const bootstrap = url.searchParams.get('bootstrap');
    const sessionToken =
      bootstrap && consumePanelBootstrapToken(bot.id, bootstrap);
    if (sessionToken) {
      res.setHeader(
        'set-cookie',
        `bot_hub_panel_access_${bot.id}=${panelToken(
          bot.id,
        )}; Max-Age=3600; Path=/api/bots/${encodeURIComponent(
          bot.id,
        )}/panel; HttpOnly; SameSite=Lax${secureCookies() ? '; Secure' : ''}`,
      );
      return res.end(
        BRIDGE_SOURCE.replace(
          'const panelSessionToken = "";',
          `const panelSessionToken = ${JSON.stringify(sessionToken)};`,
        ),
      );
    }
  }

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
        (rest === 'notify' ||
          rest === 'discord/logout' ||
          rest.startsWith('commands/')))
    )
  )
    throw httpError(403, 'Diese Panel-Aktion ist nur im Dashboard erlaubt');

  if (req.method === 'GET' && !rest) {
    return sendJson(res, 200, {
      panel: publicPanel(bot),
      // Für die Bot-Seite im neuen Tab: sie hat kein Elternfenster und braucht
      // den Namen für ihren Kopf, sonst bleibt er leer.
      bot: { id: bot.id, name: bot.name, emoji: bot.emoji },
      bridge: {
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
    requirePanelDiscordLogin(bot, req);
    const body = await readBody(req);
    const result = saveSettings(bot, body.values ?? {});
    return sendJson(res, 200, { panel: publicPanel(bot), ...result });
  }

  if (req.method === 'GET' && rest === 'settings')
    return sendJson(res, 200, { settings: publicSettings(bot) });

  if (req.method === 'PUT' && rest === 'state') {
    requirePanelDiscordLogin(bot, req);
    const body = await readBody(req);
    return sendJson(res, 200, { state: pushState(bot, body.state ?? {}) });
  }

  // Meldung aus der Bot-Seite. Sie laeuft ueber die Panel-API und nicht ueber
  // /api/hub/notify: dort ist der laufende Prozess (Runtime-Token) der
  // einzige Schreiber, die Seite darf aber weiterhin Toasts ausloesen.
  if (req.method === 'POST' && rest === 'notify') {
    requirePanelDiscordLogin(bot, req);
    const body = await readBody(req);
    return sendJson(res, 200, notifyUser(bot, body.message, body.kind));
  }

  if (req.method === 'POST' && rest.startsWith('commands/')) {
    requirePanelDiscordLogin(bot, req);
    const commandId = decodeURIComponent(rest.slice('commands/'.length));
    const body = await readBody(req);
    const result = await runAction(bot, commandId, body.args ?? {});
    return sendJson(res, 200, { result });
  }

  if (req.method === 'GET' && rest === 'bridge.js') {
    res.writeHead(200);
    return res.end(BRIDGE_SOURCE);
  }

  if (req.method === 'GET' && rest.startsWith('file/'))
    return servePanelFile(
      bot,
      req,
      res,
      rest.slice('file/'.length),
      publicStatic,
    );

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
  manifestPath: relativeManifestPath(bot.panel?.path ?? ''),
  source: bot.panel?.source ?? null,
  settings: runtime ? effectiveSettings(bot) : publicSettings(bot),
  // Panel-Token nur für Panel-Scope, nie für Runtime-Bots
  panelToken: runtime ? undefined : panelToken(bot.id),
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
    else
      return sendJson(
        res,
        200,
        await registerCallback(bot, body.url, body.token),
      );
    broadcastEvent('panel', { id: bot.id, panel: publicPanel(bot) });
    return sendJson(res, 200, { ok: true, url: null });
  }

  if (req.method === 'POST' && rest === '/state') {
    // Nur der laufende Prozess darf Live-Werte schreiben. Das Panel-Token
    // gehoert der Bot-Seite; es darf lesen, aber keine Bot-Zustaende veraendern.
    if (!runtime)
      throw httpError(
        403,
        'Nur der laufende Prozess darf den Zustand des Bots aendern.',
      );
    const body = await readBody(req);
    return sendJson(res, 200, { state: pushState(bot, body.state ?? body) });
  }

  if (req.method === 'POST' && rest === '/notify') {
    // Wie /state: der Hub-Endpunkt gehoert dem Prozess. Die Bot-Seite nutzt
    // /api/bots/<id>/panel/notify.
    if (!runtime)
      throw httpError(
        403,
        'Nur der laufende Prozess darf Benachrichtigungen ausloesen.',
      );
    const body = await readBody(req);
    return sendJson(res, 200, notifyUser(bot, body.message, body.kind));
  }

  if (rest === '/db' || rest.startsWith('/db/'))
    return handleStoreRoutes(req, res, url, bot, identity);

  throw httpError(404, 'Unbekannter Hub-Endpunkt');
};

/* ------------------------------------------------------------------ *
 * Bot-Speicher: /api/hub/db/...
 * ------------------------------------------------------------------ */

/**
 * Jeder Bot bekommt seinen eigenen Bereich in derselben Tabelle. Welcher Bot
 * das ist, entscheidet allein das Token - ein Bot-Id aus der Anfrage gibt es
 * hier nicht, damit niemand durch Raten oder Mitsenden fremde Werte erreicht.
 */
const segment = (value, name) => {
  let text;
  try {
    text = decodeURIComponent(String(value ?? ''));
  } catch {
    throw httpError(400, `${name} ist ungültig kodiert.`);
  }
  return text;
};

const handleStoreRoutes = async (req, res, url, bot, identity) => {
  // Wie /state und /notify: die Bot-Seite arbeitet mit dem Panel-Token und
  // bekommt den Speicher nicht zu sehen. Nur der laufende Prozess darf.
  if (identity.scope !== 'runtime')
    throw httpError(
      403,
      'Den Bot-Speicher darf nur der laufende Prozess nutzen (BOT_HUB_TOKEN).',
    );

  const parts = url.pathname
    .slice('/api/hub/db'.length)
    .split('/')
    .filter(Boolean);
  const store = database();
  const botId = bot.id;

  if (req.method === 'GET' && parts.length === 0)
    return sendJson(res, 200, { database: store.status() });

  if (parts.length === 1) {
    const collection = segment(parts[0], 'Der Sammlungsname');
    if (req.method === 'GET')
      return sendJson(
        res,
        200,
        await store.list(botId, {
          collection,
          prefix: url.searchParams.get('prefix'),
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset'),
        }),
      );
    throw httpError(405, 'Methode nicht erlaubt');
  }

  if (parts.length === 2) {
    const collection = segment(parts[0], 'Der Sammlungsname');
    const key = segment(parts[1], 'Der Schlüssel');
    if (req.method === 'GET') {
      const entry = await store.get(botId, collection, key);
      if (!entry)
        throw httpError(
          404,
          'Eintrag nicht gefunden – der Hub hat dazu nichts.',
        );
      return sendJson(res, 200, { entry });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (!Object.prototype.hasOwnProperty.call(body, 'value'))
        throw httpError(400, 'PUT erwartet ein Feld "value".');
      const result = await store.set(botId, collection, key, body.value);
      return sendJson(res, 200, {
        entry: { collection, key, ...result },
      });
    }
    if (req.method === 'DELETE')
      return sendJson(res, 200, {
        removed: await store.remove(botId, collection, key),
      });
    throw httpError(405, 'Methode nicht erlaubt');
  }

  throw httpError(404, 'Unbekannter Bot-Speicher-Endpunkt');
};
