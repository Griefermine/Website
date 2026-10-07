import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const DISCORD_API = 'https://discord.com/api/v10';
// Nur bekannte Discord-Codes zurückgeben, niemals den Parameterwert spiegeln.
const KNOWN_DISCORD_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'server_error',
  'temporarily_unavailable',
]);
const SESSION_COOKIE = 'bot_hub_session';
const STATE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const PREAUTH_COOKIE = 'bot_hub_preauth';
const states = new Map();
const sessions = new Map();
const DEFAULT_PERMISSIONS = [
  'bots.read',
  'bots.manage',
  'bots.control',
  'bots.delete',
  'bots.restart',
  'logs.read',
  'panel.read',
  'panel.manage',
  'access.manage',
  'files.read',
  'files.write',
  'files.upload',
  'files.delete',
];
const ACCESS_ROLES = {
  owner: DEFAULT_PERMISSIONS,
  admin: DEFAULT_PERMISSIONS,
  operator: [
    'bots.read',
    'bots.manage',
    'bots.control',
    'bots.restart',
    'logs.read',
    'panel.read',
    'panel.manage',
    'files.read',
    'files.write',
    'files.upload',
    'files.delete',
  ],
  viewer: [],
};
const ROLE_LEVEL = {
  viewer: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};
let accessFile = null;
let access = { users: {} };

const loadDotenv = () => {
  try {
    const content = readFileSync(join(process.cwd(), '.env'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
      );
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2].trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      )
        value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT')
      console.error(
        '[hub] Zentrale Auth-Konfiguration konnte nicht gelesen werden:',
        error.message,
      );
  }
};

loadDotenv();

const cookieValue = (req, name) =>
  String(req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1] ?? '';

const config = () => ({
  clientId: String(process.env.DISCORD_CLIENT_ID ?? '').trim(),
  clientSecret: String(process.env.DISCORD_CLIENT_SECRET ?? '').trim(),
  redirectUri: String(process.env.DISCORD_REDIRECT_URI ?? '').trim(),
});

const origin = () => {
  const configured = String(process.env.BOT_HUB_URL ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `http://127.0.0.1:${process.env.PORT || 8787}`;
};

const redirectFor = (req) =>
  config().redirectUri || `${origin()}/api/auth/discord/callback`;

const configured = () => {
  const { clientId, clientSecret } = config();
  return Boolean(clientId && clientSecret);
};

const discordRequest = async (path, accessToken) => {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok)
    throw new Error('Discord-Daten konnten nicht geladen werden');
  return response.json();
};

const publicUser = (user) => ({
  id: user.id,
  name: user.global_name ?? user.username,
  username: user.username,
  avatar: user.avatar ?? null,
});

const session = (req) => {
  const value = cookieValue(req, SESSION_COOKIE);
  const current = sessions.get(value);
  if (!current) return null;
  if (current.expiresAt <= Date.now()) {
    sessions.delete(value);
    return null;
  }
  return current;
};

/* `Secure` ist Pflicht, sobald der Hub über HTTPS erreichbar ist. Im
 * Reverse-Proxy-Betrieb ist NODE_ENV nicht verlässlich gesetzt, deshalb gibt
 * es dafür einen eigenen Schalter. */
const secureCookies = () =>
  process.env.NODE_ENV === 'production' ||
  process.env.BOT_HUB_SECURE_COOKIES === '1';

const cookie = (value, maxAge) =>
  `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${
    secureCookies() ? '; Secure' : ''
  }`;

const preAuthCookie = (value, maxAge) =>
  `${PREAUTH_COOKIE}=${value}; Max-Age=${maxAge}; Path=/api/auth/discord; HttpOnly; SameSite=Lax${
    secureCookies() ? '; Secure' : ''
  }`;

const cleanup = () => {
  const now = Date.now();
  for (const [key, value] of states) {
    if (value.expiresAt <= now) states.delete(key);
  }
  for (const [key, value] of sessions) {
    if (value.expiresAt <= now) sessions.delete(key);
  }
};
const cleanupTimer = setInterval(cleanup, 60_000);
cleanupTimer.unref();

export const isAuthConfigured = configured;

export const currentUser = (req) => session(req)?.user ?? null;

// Nur der Hub selbst darf die serverseitige OAuth-Sitzung weiterverwenden.
// Discord-Access-Tokens bleiben dabei absichtlich außerhalb dieses Moduls.
export const currentAuthSession = (req) => session(req);

const saveAccess = (strict = false) => {
  if (!accessFile) {
    if (strict) throw new Error('Zugriffsdatei ist nicht konfiguriert');
    return;
  }
  try {
    mkdirSync(dirname(accessFile), { recursive: true });
    writeFileSync(accessFile, `${JSON.stringify(access, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(accessFile, 0o600);
  } catch (error) {
    console.error(
      '[hub] Zugriffsrechte konnten nicht gespeichert werden:',
      error.message,
    );
    // Irreversible Schritte (Bot-Delete) dürfen Schreibfehler nicht
    // verschlucken, sondern melden sie als Teilfehler.
    if (strict) throw error;
  }
};

const loadAccess = () => {
  if (!accessFile || !existsSync(accessFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(accessFile, 'utf8'));
    if (parsed && typeof parsed.users === 'object') {
      access = { users: parsed.users };
      normalizeOwners();
    }
  } catch (error) {
    console.error(
      '[hub] Zugriffsrechte konnten nicht geladen werden:',
      error.message,
    );
  }
};

const normalizeOwners = () => {
  let ownerFound = false;
  let changed = false;
  for (const entry of Object.values(access.users)) {
    if (entry.role !== 'owner') continue;
    if (!ownerFound) {
      ownerFound = true;
      continue;
    }
    entry.role = 'admin';
    entry.permissions = [...ACCESS_ROLES.admin];
    entry.updatedAt = Date.now();
    changed = true;
  }
  if (changed) saveAccess();
};

const configuredOwnerIds = () =>
  new Set(
    String(process.env.BOT_HUB_OWNER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );

export const configureAccess = (file) => {
  accessFile = file;
  access = { users: {} };
  loadAccess();
};

export const ensureAccessUser = (user) => {
  if (!user) return null;
  if (!access.users[user.id]) {
    const ownerIds = configuredOwnerIds();
    const ownerExists = Object.values(access.users).some(
      (entry) => entry.role === 'owner',
    );
    const bootstrapOwner = !ownerExists && ownerIds.has(user.id);
    access.users[user.id] = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: bootstrapOwner ? 'owner' : 'viewer',
      permissions: [
        ...(bootstrapOwner ? ACCESS_ROLES.owner : ACCESS_ROLES.viewer),
      ],
      bots: {},
      updatedAt: Date.now(),
    };
    saveAccess();
  } else {
    Object.assign(access.users[user.id], {
      name: user.name,
      username: user.username,
    });
  }
  return access.users[user.id];
};

export const hasPermission = (req, permission, options = {}) => {
  if (process.env.BOT_HUB_TEST_MODE === '1') return true;
  const user = currentUser(req);
  if (!user) return false;
  const entry = ensureAccessUser(user);
  return effectivePermissions(entry, options.botId).includes(permission);
};

const effectivePermissions = (entry, botId) => {
  if (!entry || !Object.hasOwn(ACCESS_ROLES, entry.role)) return [];
  const allowed = new Set(ACCESS_ROLES[entry.role]);
  const global = [...new Set(entry.permissions ?? [])].filter((permission) =>
    allowed.has(permission),
  );
  if (!botId) return global;
  const perBot = entry.bots?.[botId]?.permissions ?? [];
  const merged = [...new Set([...global, ...perBot])];
  return merged.filter((permission) => allowed.has(permission));
};

export const publicAccess = (userId, botId) => {
  const entry = access.users[userId];
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    username: entry.username,
    role: entry.role,
    permissions: effectivePermissions(entry, botId),
    bots: entry.bots ?? {},
    updatedAt: entry.updatedAt,
  };
};

export const accessState = (req) => ({
  permissions: effectivePermissions(ensureAccessUser(currentUser(req))),
  role: ensureAccessUser(currentUser(req))?.role ?? null,
  users: Object.values(access.users).map((entry) => publicAccess(entry.id)),
  roles: Object.fromEntries(
    Object.entries(ACCESS_ROLES).map(([role, permissions]) => [
      role,
      [...permissions],
    ]),
  ),
  bots: [],
});

export const updateAccess = (id, input, actorId) => {
  const existing = access.users[id];
  if (!existing) throw new Error('Benutzer nicht gefunden');
  const actor = access.users[actorId];
  if (!actor || ROLE_LEVEL[actor.role] <= ROLE_LEVEL[existing.role])
    throw new Error('Nur eine höhere Rolle darf diesen Benutzer ändern');
  if (existing.role === 'owner')
    throw new Error(
      'Die Rechte eines Eigentümers können nicht geändert werden',
    );
  const role = String(input.role ?? existing.role);
  if (!Object.hasOwn(ACCESS_ROLES, role)) throw new Error('Unbekannte Rolle');
  if (
    role === 'owner' &&
    Object.values(access.users).some(
      (entry) => entry.id !== id && entry.role === 'owner',
    )
  )
    throw new Error('Es kann nur einen Eigentümer geben');
  if (ROLE_LEVEL[role] >= ROLE_LEVEL[actor.role])
    throw new Error(
      'Eine Rolle darf nur unterhalb der eigenen Rolle vergeben werden',
    );
  if (existing.role === 'owner' && role !== 'owner') {
    const otherOwner = Object.values(access.users).some(
      (entry) => entry.id !== id && entry.role === 'owner',
    );
    if (!otherOwner)
      throw new Error('Der letzte Eigentümer kann nicht herabgestuft werden');
  }
  const requestedPermissions = Array.isArray(input.permissions)
    ? [
        ...new Set(
          input.permissions.filter((item) =>
            DEFAULT_PERMISSIONS.includes(item),
          ),
        ),
      ]
    : ACCESS_ROLES[role];
  const allowed = new Set(ACCESS_ROLES[role]);
  const permissions = [...new Set(requestedPermissions)].filter((permission) =>
    allowed.has(permission),
  );
  const requestedBots =
    input.bots && typeof input.bots === 'object'
      ? input.bots
      : (existing.bots ?? {});
  const botsClean = {};
  for (const [bid, cfg] of Object.entries(requestedBots)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(bid)) continue;
    const perms = Array.isArray(cfg?.permissions)
      ? [
          ...new Set(
            cfg.permissions.filter((p) => DEFAULT_PERMISSIONS.includes(p)),
          ),
        ]
      : [];
    botsClean[bid] = { permissions: perms.filter((p) => allowed.has(p)) };
  }
  existing.role = role;
  existing.permissions = permissions;
  existing.bots = botsClean;
  existing.updatedAt = Date.now();
  saveAccess();
  return publicAccess(id);
};

export const removeAccess = (id, actorId) => {
  if (!access.users[id]) throw new Error('Benutzer nicht gefunden');
  const actor = access.users[actorId];
  const target = access.users[id];
  if (!actor || ROLE_LEVEL[actor.role] <= ROLE_LEVEL[target.role])
    throw new Error('Nur eine höhere Rolle darf diesen Benutzer entfernen');
  if (target.role === 'owner')
    throw new Error('Ein Eigentümer kann nicht entfernt werden');
  const owners = Object.values(access.users).filter(
    (entry) => entry.role === 'owner',
  );
  if (owners.length === 1 && owners[0].id === id)
    throw new Error('Der letzte Eigentümer kann nicht entfernt werden');
  delete access.users[id];
  saveAccess();
};

/**
 * Entfernt beim Bot-Löschen alle Berechtigungseinträge dieser Bot-ID aus
 * sämtlichen Benutzern. Nur die gelöschte ID wird angefasst, andere
 * Bot-Rechte bleiben unverändert. Gibt die Zahl bereinigter Benutzer zurück.
 */
export const purgeBotAccess = (botId) => {
  const id = String(botId ?? '');
  if (!id) return 0;
  let purged = 0;
  for (const entry of Object.values(access.users)) {
    if (entry?.bots && Object.hasOwn(entry.bots, id)) {
      delete entry.bots[id];
      entry.updatedAt = Date.now();
      purged += 1;
    }
  }
  // Immer persistieren (strict), sobald konfiguriert: War ein früherer
  // Versuch an einem Schreibfehler gescheitert, ist der Speicher bereits
  // bereinigt, aber die Datei noch nicht – erst das erneute Schreiben stellt
  // Konvergenz her.
  if (purged || accessFile) saveAccess(true);
  return purged;
};

export const authSession = (req) => {
  const current = session(req);
  const permissions = current ? ensureAccessUser(current.user) : null;
  return {
    configured: configured(),
    authenticated: Boolean(current),
    user: current?.user ?? null,
    guilds: current?.guilds ?? [],
    bots: permissions?.bots ?? {},
    permissions: effectivePermissions(permissions, null),
    role: permissions?.role ?? null,
  };
};

export const handleAuthRoutes = async (req, res, url, sendJson, httpError) => {
  const { clientId, clientSecret } = config();
  const redirectUri = redirectFor(req);

  if (url.pathname === '/api/auth/session' && req.method === 'GET')
    return sendJson(res, 200, authSession(req));

  if (url.pathname === '/api/auth/discord/login' && req.method === 'GET') {
    if (!clientId || !clientSecret)
      throw httpError(503, 'Discord-Login ist nicht konfiguriert');
    const preAuthSessionId = randomBytes(24).toString('hex');
    const state = randomBytes(24).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    states.set(state, {
      preAuthSessionId,
      codeVerifier,
      expiresAt: Date.now() + STATE_TTL,
      used: false,
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
      'set-cookie': preAuthCookie(preAuthSessionId, STATE_TTL / 1000),
      'cache-control': 'no-store',
    });
    return res.end();
  }

  if (url.pathname === '/api/auth/discord/callback' && req.method === 'GET') {
    const stateKey = url.searchParams.get('state') ?? '';
    const state = states.get(stateKey);
    states.delete(stateKey);
    const code = url.searchParams.get('code');
    const browserSession = cookieValue(req, PREAUTH_COOKIE);
    const discordError = String(url.searchParams.get('error') ?? '');
    // Der pending state liegt nur im Arbeitsspeicher. Wird der Hub zwischen
    // dem Klick und der Rückkehr neu gestartet – im Entwicklungsbetrieb passiert
    // das bei jeder gespeicherten Datei –, ist er nicht mehr auffindbar. Die
    // verschiedenen Gründe bekommen eigene Meldungen, sonst ist ein
    // fehlgeschlagener Login nicht nachvollziehbar.
    let reason;
    if (discordError && KNOWN_DISCORD_ERRORS.has(discordError))
      reason = ['abgebrochen', `von Discord abgelehnt (${discordError})`];
    else if (!state || state.used)
      reason = [
        'abgelaufen',
        'der Hub wurde zwischen Anmeldung und Rückkehr neu gestartet oder der Link ist zu alt – bitte erneut anmelden',
      ];
    else if (state.expiresAt <= Date.now())
      reason = [
        'abgelaufen',
        'die Anmeldung war älter als 10 Minuten – bitte erneut anmelden',
      ];
    else if (!browserSession || state.preAuthSessionId !== browserSession)
      reason = [
        'kein Cookie',
        'der Browser hat das Anmelde-Cookie nicht mitgeschickt – bitte Cookies für diese Adresse erlauben',
      ];
    else if (!code)
      reason = [
        'kein Code',
        'Discord hat keinen Autorisierungscode geliefert – bitte erneut anmelden',
      ];
    if (reason) {
      console.warn(`[hub] Discord-Anmeldung abgewiesen (${reason[0]})`);
      throw httpError(400, `Ungültige Discord-Anmeldung: ${reason[1]}.`);
    }
    state.used = true;

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
    const [user, guilds] = await Promise.all([
      discordRequest('/users/@me', token.access_token),
      discordRequest('/users/@me/guilds', token.access_token),
    ]);
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      user: publicUser(user),
      guilds: guilds.map(({ id, name, icon, owner, permissions }) => ({
        id,
        name,
        icon: icon ?? null,
        owner: Boolean(owner),
        permissions: String(permissions ?? '0'),
      })),
      expiresAt: Date.now() + SESSION_TTL,
    });
    res.writeHead(302, {
      location: '/',
      'set-cookie': [
        cookie(sessionId, SESSION_TTL / 1000),
        preAuthCookie('', 0),
      ],
      'cache-control': 'no-store',
    });
    return res.end();
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    sessions.delete(cookieValue(req, SESSION_COOKIE));
    res.setHeader('set-cookie', cookie('', 0));
    return sendJson(res, 200, { ok: true });
  }

  return false;
};

export const requiresAuthentication = (req, url) => {
  if (process.env.BOT_HUB_TEST_MODE === '1') return false;
  if (!url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/api/auth/')) return false;
  if (url.pathname === '/api/health') return false;
  if (url.pathname.startsWith('/api/hub')) return false;
  // Statische Bot-Panel-Dateien enthalten keine Sitzungsdaten. Ihre Pfade
  // werden separat realpath- und sensitive-file-geprüft.
  if (
    req.method === 'GET' &&
    /^\/api\/bots\/[^/]+\/panel\/(?:bridge\.js|file\/.+)$/.test(url.pathname)
  )
    return false;
  // Nur der separate OAuth-Handshake des Bot-Panels ist öffentlich.
  if (
    req.method === 'GET' &&
    /^\/api\/bots\/[^/]+\/panel\/discord\/(?:config|login|callback)$/.test(
      url.pathname,
    )
  )
    return false;
  return !session(req);
};

export { SESSION_COOKIE, secureCookies };
