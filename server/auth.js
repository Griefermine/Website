import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { decryptValue, encryptValue, vaultEnabled } from './vault.js';

/**
 * Maßnahme 48 (Auftrag 5.6): dieselbe, bereits in server/panel.js geprüfte
 * Test-Öse für die Hub-Anmeldung. Ohne sie konnte die Anmeldekette – State,
 * PKCE-Verifizierer, Ticket-Vergleich, Rollenvergabe – nie gegen eine echte
 * HTTP-Gegenstelle getestet werden, weil `https://discord.com` fest einkompiliert
 * war und die Suite deshalb vollständig an der Authentifizierung vorbeilief.
 *
 * Bewusst kein neuer Produktions-Schalter:
 *  - nur mit NODE_ENV=test,
 *  - nur auf eine Schleifenadresse (http/https, 127.0.0.1/localhost/::1),
 *  - sonst hart `https://discord.com/api/v10` – jede andere Angabe, auch eine
 *    mitgesetzte, wird ignoriert.
 * Ein beliebig konfigurierbarer OAuth-Endpunkt wäre ein eigener
 * Angriffsvektor; das ist er hier nicht.
 */
const DISCORD_API_LOOPBACK =
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const discordApiBasis = () =>
  process.env.NODE_ENV === 'test' &&
  DISCORD_API_LOOPBACK.test(
    String(process.env.BOT_HUB_DISCORD_API ?? '').trim(),
  )
    ? String(process.env.BOT_HUB_DISCORD_API).trim().replace(/\/+$/, '')
    : 'https://discord.com/api/v10';
// Nur bekannte Discord-Codes zurückgeben, niemals den Parameterwert spiegeln.
const KNOWN_DISCORD_ERRORS = new Set([
  'access_denied',
  'invalid_request',
  'server_error',
  'temporarily_unavailable',
]);
const SESSION_COOKIE = 'bot_hub_session';
const STATE_TTL = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Maßnahme 45 (V27-A): Sitzungs-Lebensdauer und Speicherung.
 *
 * Vorher: jede Sitzung lief starr sieben Tage durch – ohne Idle-Frist, also
 * auch dann noch, wenn der Rechner seit Wochen in der Tasche lag, und die
 * Datei `data/sessions.json` enthielt die Session-IDs im Klartext (wer den
 * `data/`-Ordner kopierte, war angemeldet; nur mit Vault-Key wurde die ganze
 * Datei versiegelt).
 *
 * Jetzt:
 *  - Auf der Platte steht nur der SHA-256-Abdruck der ID (`sha256:<hex>`).
 *    Der Wert im Cookie bleibt die ID selbst – die Datei ist damit ohne
 *    zugehörigen laufenden Browser nichts wert, auch ohne Vault-Key. Der
 *    Abdruck ist keine eigene Konstruktion, sondern `node:crypto`.
 *  - Absolute Obergrenze (`BOT_HUB_SESSION_TTL_HOURS`, Default 168 = wie
 *    bisher) und Idle-Frist (`BOT_HUB_SESSION_IDLE_HOURS`, Default 72).
 *  - Zugangsentfernung widerruft die Sitzungen dieses Benutzers
 *    (`revokeUserSessions` in `removeAccess`).
 * Rollen-/Rechteänderungen waren schon vorher sofort wirksam, weil
 * `hasPermission` die Rechte bei jeder Anfrage neu aus `access.json` löst.
 * ------------------------------------------------------------------ */
const SESSION_TTL_HOURS_DEFAULT = 168;
const SESSION_IDLE_HOURS_DEFAULT = 72;
const SESSION_HASH_PREFIX = 'sha256:';
/* Die letzte Schreibdiskretion für Idle-Fortschreibung: `session()` läuft bei
 * jeder API-Anfrage – ohne Schwelle würde jede Anfrage die Sitzungsdatei
 * neu schreiben. */
const SESSION_TOUCH_PERSIST_MS = 15_000;
const invalidHoursWarned = new Set();

/**
 * Stunden-Angabe aus der Umgebung in Millisekunden. Ungültige Werte werden
 * einmalig gemeldet und auf den Default gesetzt – ein Tippfehler darf nicht
 * stillschweigend in „läuft nie ab“ oder „läuft sofort ab“ kippen.
 */
const hoursToMs = (name, fallbackHours) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallbackHours * 60 * 60_000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    if (!invalidHoursWarned.has(name)) {
      invalidHoursWarned.add(name);
      console.error(
        `[hub] ${name}="${raw}" ist keine gültige Stundenzahl – es gilt der Default ${fallbackHours}.`,
      );
    }
    return fallbackHours * 60 * 60_000;
  }
  return hours * 60 * 60_000;
};

/* Bewusst als Funktion (nicht beim Modul-Load): `loadDotenv()` läuft erst nach
 * diesen Deklarationen, sonst sähe die Konfiguration die `.env`-Werte nicht. */
const sessionTtlMs = () =>
  hoursToMs('BOT_HUB_SESSION_TTL_HOURS', SESSION_TTL_HOURS_DEFAULT);
/** Die Idle-Frist kann die absolute Laufzeit nie verlängern. */
const sessionIdleMs = () =>
  Math.min(
    hoursToMs('BOT_HUB_SESSION_IDLE_HOURS', SESSION_IDLE_HOURS_DEFAULT),
    sessionTtlMs(),
  );

/** Speicher-Schlüssel einer Sitzung: immer der Abdruck, niemals die ID. */
const sessionKey = (value) =>
  String(value).startsWith(SESSION_HASH_PREFIX)
    ? String(value)
    : `${SESSION_HASH_PREFIX}${createHash('sha256')
        .update(String(value), 'utf8')
        .digest('hex')}`;

/** Frische Session-ID: 256 Bit aus dem CSPRNG, URL-sicher kodiert. */
const newSessionToken = () => randomBytes(32).toString('base64url');
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
  // Maßnahme 42: Der Test-Modus erbt keine Produktiv-Konfiguration über den
  // Arbeitsordner. Wer die Suite im Projektordner startet, holte sich sonst
  // die `.env` des Dienstes in den Prozess – inkl. BOT_HUB_KEY_FILE: Tests,
  // die Klartext in data/secrets erwarten, fanden plötzlich mit dem
  // Master-Key verschlüsselte Umschläge vor (auf der VM reproduziert).
  // Tests setzen ihre Konfiguration selbst; das systemd EnvironmentFile
  // versorgt den echten Dienst.
  if (process.env.BOT_HUB_TEST_MODE === '1') return;
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

/**
 * Wert einer Auth-Konfiguration. `_FILE` gewinnt: Zeigt
 * `DISCORD_CLIENT_SECRET_FILE` auf eine Datei, wird deren Inhalt benutzt.
 * So kann das Client-Secret in einer root-eigenen, 0440-geschützten Datei
 * AUSSERHALB von Projekt-Root und `data/` liegen (systemd-Credential,
 * Docker-Secret) und muss nicht mehr in der `.env` stehen, die leicht im Git
 * landet – genau die Warnung, die der Hub beim Start ausgibt.
 * Lese-/Parsing-Fehler führen zum Env-Wert, nicht zum Abbruch.
 */
const configValue = (name) => {
  const filePath = String(process.env[`${name}_FILE`] ?? '').trim();
  if (filePath) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const value = content.trim();
      if (value) return value;
    } catch (error) {
      console.error(
        `[hub] ${name}_FILE konnte nicht gelesen werden (${error.code ?? error.message}) – falle auf ${name} zurück.`,
      );
    }
  }
  return String(process.env[name] ?? '').trim();
};

const config = () => ({
  clientId: configValue('DISCORD_CLIENT_ID'),
  clientSecret: configValue('DISCORD_CLIENT_SECRET'),
  redirectUri: configValue('DISCORD_REDIRECT_URI'),
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
  const response = await fetch(`${discordApiBasis()}${path}`, {
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

/* Dünnes Nachschreiben vermeiden: `session()` läuft bei jeder API-Anfrage,
 * ohne Schwelle würde jede einzelne Anfrage die Sitzungsdatei neu schreiben
 * (inkl. fsync). Pro Sitzung wird der Fortschritt höchstens alle 15 Sekunden
 * festgehalten; der Buchungsstand hängt am Objekt, nicht in der Datei, eine
 * neu geladene Sitzung wird beim ersten Zugriff sofort fortgeschrieben. */
const touchPersistedAt = new WeakMap();
const session = (req) => {
  const value = cookieValue(req, SESSION_COOKIE);
  if (!value) return null;
  const key = sessionKey(value);
  const current = sessions.get(key);
  if (!current) return null;
  const now = Date.now();
  if (current.expiresAt <= now) {
    sessions.delete(key);
    saveSessions();
    return null;
  }
  /* Idle-Frist. Altbestand aus einer Datei vor Maßnahme 45 hat weder
   * `lastSeenAt` noch `createdAt`; ihn nachträglich abzumelden würde alle
   * bestehenden Anmeldungen beim ersten Start nach dem Update kappen, also
   * gilt er als „gerade gesehen“ und läuft ganz normal aus. */
  const idleSince =
    typeof current.lastSeenAt === 'number'
      ? current.lastSeenAt
      : typeof current.createdAt === 'number'
        ? current.createdAt
        : now;
  if (now - idleSince > sessionIdleMs()) {
    sessions.delete(key);
    saveSessions();
    return null;
  }
  current.lastSeenAt = now;
  if (now - (touchPersistedAt.get(current) ?? 0) > SESSION_TOUCH_PERSIST_MS) {
    touchPersistedAt.set(current, now);
    saveSessions();
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
  let expired = false;
  for (const [key, value] of sessions) {
    if (value.expiresAt <= now) {
      sessions.delete(key);
      expired = true;
    }
  }
  if (expired) saveSessions();
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
  const temporary = `${accessFile}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(accessFile), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(access, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, accessFile);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* A leftover temp file is harmless; report the original write error. */
    }
    console.error(
      '[hub] Zugriffsrechte konnten nicht gespeichert werden:',
      error.message,
    );
    // Irreversible Schritte (Bot-Delete) dürfen Schreibfehler nicht
    // verschlucken, sondern melden sie als Teilfehler.
    if (strict) throw error;
  }
};

/* Sessions leben im Speicher, überleben aber einen Neustart: Sie werden in
 * `data/sessions.json` ausgelagert (Mode 0600). Seit Maßnahme 45 sind die
 * Schlüssel die SHA-256-Abdrücke der Session-ID, nicht die IDs selbst – die
 * Datei enthält also keine auslieferbaren Anmeldemerkmale mehr. Zusätzlich
 * liegt sie mit Vault-Key als ein einziger AES-256-GCM-Umschlag (v2, fest an
 * Dateiname+Schlüsselname gebunden) auf der Platte; ohne Key schützt der
 * Abdruck. */
let sessionFile = null;
const projectRootOfSessionFile = () => dirname(dirname(sessionFile));
const saveSessions = () => {
  if (!sessionFile) return;
  const temporary = `${sessionFile}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(sessionFile), { recursive: true });
    const now = Date.now();
    const persistent = {};
    for (const [key, value] of sessions) {
      if (value.expiresAt > now) persistent[key] = value;
    }
    let content = `${JSON.stringify(persistent, null, 2)}\n`;
    if (vaultEnabled(projectRootOfSessionFile()))
      content = `${encryptValue('sessions', 'file', content, projectRootOfSessionFile())}\n`;
    writeFileSync(temporary, content, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, sessionFile);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* Ein TempFile-Rest ist harmlos; der Schreibfehler wird gemeldet. */
    }
    console.error(
      '[hub] Sessions konnten nicht gespeichert werden:',
      error.message,
    );
  }
};
const loadSessions = () => {
  if (!sessionFile || !existsSync(sessionFile)) return;
  try {
    const raw = readFileSync(sessionFile, 'utf8');
    let content = raw;
    if (raw.trim().startsWith('vault:')) {
      content = decryptValue(
        'sessions',
        'file',
        raw.trim(),
        projectRootOfSessionFile(),
      );
    }
    const parsed = JSON.parse(content);
    const now = Date.now();
    let rawKeyFound = false;
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (
        value &&
        typeof value.expiresAt === 'number' &&
        value.expiresAt > now &&
        value.user?.id
      ) {
        /* Altbestand (vor Maßnahme 45) speicherte die rohe ID als Schlüssel.
         * Beim Laden wird der Schlüssel auf seinen Abdruck umgestellt; der
         * Cookie-Wert bleibt identisch, bestehende Anmeldungen laufen also
         * weiter – nur die Datei enthält beim nächsten Schreiben keine
         * auslieferbaren IDs mehr. */
        if (!String(key).startsWith(SESSION_HASH_PREFIX)) rawKeyFound = true;
        sessions.set(sessionKey(key), value);
      }
    }
    // Klartext-Altbestand einmalig hochziehen: rohe Schlüssel -> Abdrücke,
    // und unversiegelte Datei -> Umschlag, falls ein Vault-Key existiert.
    if (
      (rawKeyFound ||
        (!raw.trim().startsWith('vault:') &&
          vaultEnabled(projectRootOfSessionFile()))) &&
      sessions.size
    )
      saveSessions();
  } catch (error) {
    console.error(
      '[hub] Sessions konnten nicht geladen werden:',
      error.message,
    );
  }
};
export const configureSessionStore = (file) => {
  sessionFile = file;
  sessions.clear();
  loadSessions();
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

/* Legt bei einer erfolgreichen Anmeldung einen Basis-Zugang an, falls noch
 * keiner existiert – das ist die bewusste Selbstregistrierung des Projekts,
 * keine Lücke (Maßnahme 45 / Auftrag 5.7: geprüft, absichtlich). Wichtig für
 * den Widerruf: `removeAccess` widerruft zusätzlich die Sitzungen, ein
 * entfernter Benutzer kann diesen Pfad also nicht mehr mit einer alten
 * Sitzung betreten. Eine *neue* Anmeldung erzeugt ihn mit der Basisrolle
 * `viewer` und leeren Rechten neu – eine frische Registrierung, keine
 * Auferstehung ehemaliger Rechte. */
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
  // Per-Bot-Rechte sind eine ERWEITERUNG, keine Untermenge der Rolle:
  // Wer als viewer: [] nur auf Bot A berechtigt werden soll, kann ohne
  // Bot-Bezug nichts, mit Bot A genau das Eingetragene. Ein Rollen-Deckel
  // hier machte die Bot-Rechte-UI zu Dekor (Audit WEB-01, Maßnahme 37).
  const perBot = entry.bots?.[botId]?.permissions ?? [];
  return [...new Set([...global, ...perBot])];
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
  /* Maßnahme 45 (Auftrag 5.7): botbezogene Rechte richteten sich bisher nach
   * der Rechte-Menge der *Zielrolle* – für `viewer` (= []) heißt das, dass
   * gar kein botbezogenes Recht setzbar war, obwohl die Laufzeit es seit
   * Maßnahme 37 (Audit WEB-01) ausdrücklich unterstützt und der einzige Weg,
   * jemanden auf genau einem Bot zu berechtigen, darin bestand, ihm global
   * die weitergehende Rolle `operator` zu geben. Grenze ist jetzt, was der
   * Handelnde auf genau diesem Bot selbst darf: "niemand vergibt mehr, als er
   * selbst hat" bleibt erhalten, eine Elevation über die eigene Rolle hinaus
   * ist weiterhin ausgeschlossen. Globale Rechte bleiben auf die Zielrolle
   * begrenzt. */
  const grantableFor = (botId) => new Set(effectivePermissions(actor, botId));
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
    const grantable = grantableFor(bid);
    botsClean[bid] = {
      permissions: perms.filter((p) => grantable.has(p)),
    };
  }
  existing.role = role;
  existing.permissions = permissions;
  existing.bots = botsClean;
  existing.updatedAt = Date.now();
  // strict (Maßnahme 45): Eine nicht geschriebene Rechteänderung wäre nach
  // einem Neustart weg – bei entzogenen Rechten wäre das ein stillschweigend
  // wieder auflebender Zugang, also als Fehler melden statt verschlucken.
  saveAccess(true);
  return publicAccess(id);
};

/**
 * Widerruft alle Sitzungen eines Benutzers (Maßnahme 45). Wird beim Entfernen
 * eines Zugangs gebraucht: ohne das bliebe die bereits ausgestellte Sitzung
 * bis zur absoluten Laufzeit gültig.
 * Gibt die Zahl widerrufener Sitzungen zurück.
 */
export const revokeUserSessions = (userId) => {
  const id = String(userId ?? '');
  if (!id) return 0;
  let revoked = 0;
  for (const [key, value] of sessions) {
    if (value?.user?.id === id) {
      sessions.delete(key);
      revoked += 1;
    }
  }
  if (revoked) saveSessions();
  return revoked;
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
  /* Maßnahme 45: zuerst die Sitzungen weg – das ist die unmittelbare Wirkung,
   * die auch dann bleibt, wenn das Schreiben der Rechte später scheitert.
   * Ohne diesen Schritt wäre die Datei zwar bereinigt, die lebende Sitzung
   * des Entfernten aber gültig geblieben und hätte ihn beim nächsten Request
   * als Viewer neu angelegt. */
  revokeUserSessions(id);
  // strict: ein Schreibfehler wäre ein stillschweigend unwiderrufener Zugang
  // (nach einem Neustart wäre der Benutzer wieder da) – also melden.
  saveAccess(true);
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
    if (discordError) {
      /* Ein Fehlerparameter bedeutet: von Discord kommt kein Code. Auch ein
       * unbekannter Wert bricht ab – würde er nur in der bekannten Liste
       * abgreifen, machte ein frei erfundener Parameter (z. B. `<script>…`)
       * aus einer abgelehnten Anmeldung eine ganz normale Rückkehr, und die
       * Kette lief weiter, als wäre nichts gewesen. Unbekannte Werte werden
       * außerdem nicht zurückgegeben, sonst spiegelte die Antwort Eingaben. */
      reason = KNOWN_DISCORD_ERRORS.has(discordError)
        ? ['abgebrochen', `von Discord abgelehnt (${discordError})`]
        : ['abgebrochen', 'von Discord abgelehnt (Grund unbekannt)'];
    } else if (!state || state.used)
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

    const tokenResponse = await fetch(`${discordApiBasis()}/oauth2/token`, {
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
    /* Maßnahme 45: 256-Bit-ID, gespeichert wird nur ihr Abdruck. */
    const sessionId = newSessionToken();
    const issuedAt = Date.now();
    const ttlMs = sessionTtlMs();
    sessions.set(sessionKey(sessionId), {
      user: publicUser(user),
      guilds: guilds.map(({ id, name, icon, owner, permissions }) => ({
        id,
        name,
        icon: icon ?? null,
        owner: Boolean(owner),
        permissions: String(permissions ?? '0'),
      })),
      createdAt: issuedAt,
      lastSeenAt: issuedAt,
      expiresAt: issuedAt + ttlMs,
    });
    saveSessions();
    res.writeHead(302, {
      location: '/',
      'set-cookie': [
        cookie(sessionId, Math.floor(ttlMs / 1000)),
        preAuthCookie('', 0),
      ],
      'cache-control': 'no-store',
    });
    return res.end();
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    sessions.delete(sessionKey(cookieValue(req, SESSION_COOKIE)));
    saveSessions();
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

/**
 * Test-Zugang (Maßnahme 48): die Endpunkt-Wahl selbst ist sicherheitsrelevant –
 * sie darf nur im Testbetrieb und nur auf die Schleife zeigen. Gepürt wird
 * das Verhalten, nicht eine nachgebildete Kopie der Regel.
 */
export const __testing = { discordApiBasis };
