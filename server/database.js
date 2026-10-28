/**
 * Bot-Speicher: ein persistenter Bereich pro Bot, erreichbar über die Hub-API.
 *
 * Zwei Treiber, ein Ansatz:
 *
 *   sqlite  Standard. Eine Datei unter `data/db/`, Modus 0600, Verzeichnis
 *           0700. Kommt mit Node 22 ohne weiteres Paket aus (`node:sqlite`).
 *   mysql   `BOT_HUB_DB=mysql`. Bewusst auf diesen Rechner beschränkt: nur
 *           Loopback oder Unix-Socket, eigener Benutzer, kein `root`. Wer eine
 *           Datenbank im Netz haben will, müsste diese Schranke aufweichen -
 *           genau das soll der Start verweigern.
 *
 * Beide Treiber benutzen dieselben SQL-Anweisungen mit Platzhaltern. Werte
 * werden nie in SQL zusammengesetzt, Bot-Ids kommen nie aus der Anfrage,
 * sondern vom Token. Damit ist die Trennung zwischen den Bots eine Eigenschaft
 * des Codes und keine Hoffnung auf ein Richtigstellen im Betrieb.
 *
 * Wer MySQL wählt, braucht das Paket `mysql2`:
 *
 *   npm install mysql2
 *
 * Es wird nur geladen, wenn der Modus wirklich `mysql` ist - ein
 * SQLite-Betrieb bleibt ohne diese Abhängigkeit.
 */

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { readSecretValues } from './secrets.js';
import { httpError } from './util.js';

/** Obergrenze für einen einzelnen Wert in Bytes (serialisiert als JSON). */
export const MAX_VALUE_BYTES = 64 * 1024;
const MAX_LIST = 200;
const DEFAULT_LIST = 100;
const MAX_OFFSET = 100_000;
const MAX_CONNECTIONS = 8;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
/**
 * `mysql-container` ist `mysql` mit einem Unterschied: den Container, das
 * Passwort, die Datenbank und den Benutzer legt der Hub selbst an (siehe
 * `server/mysql.js`). Der Treiberwert ist trotzdem `mysql`, damit die
 * Abfragepfade identisch bleiben – alles andere wäre ein zweiter Satz Code für
 * dieselben Anweisungen.
 */
const DRIVERS = new Set(['sqlite', 'mysql', 'mysql-container']);
const MANAGED = 'mysql-container';

/**
 * Quotas pro Bot gegen Ressourcenmissbrauch / DoS.
 *
 * Alle Grenzen gelten GLOBAL je Bot, also über alle Collections hinweg – nicht
 * je Collection. Eine Prüfung pro Collection ließe sich sonst umgehen, indem ein
 * Bot sich viele Collections anlegt (100 Collections × 9000 Einträge).
 */
export const MAX_ENTRIES_PER_BOT = 10_000;
export const MAX_COLLECTIONS_PER_BOT = 100;
export const MAX_DATABASE_BYTES_PER_BOT = 100 * 1024 * 1024; // 100 MiB
export const MAX_WRITES_PER_MINUTE = 120;
export const MAX_DELETES_PER_MINUTE = 60;
export const MAX_DB_READS_PER_MINUTE = 240;
export const MAX_QUERIES_PER_MINUTE = 120;
/** Obergrenze einer Listenantwort in Bytes, damit `list` nicht als DoS dient. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const BASE_RATE_LIMITS = {
  write: MAX_WRITES_PER_MINUTE,
  delete: MAX_DELETES_PER_MINUTE,
  read: MAX_DB_READS_PER_MINUTE,
  query: MAX_QUERIES_PER_MINUTE,
};

const rateBuckets = new Map();

/** Zähler je Bot und Art. Als Objekt statt als Liste, damit ein Test die Grenze
 *  anheben kann: der Zählerpfad soll prüfbar sein, ohne dass das Rate-Limit
 *  nebenbei 280 von 300 Schreibvorgängen verschluckt. */
export const rateLimits = {
  write: MAX_WRITES_PER_MINUTE,
  delete: MAX_DELETES_PER_MINUTE,
  read: MAX_DB_READS_PER_MINUTE,
  query: MAX_QUERIES_PER_MINUTE,
};

/** Nur für Tests: `resetRateLimits`, Grenzen anheben oder zurücksetzen. */
export const setRateLimits = (overrides = {}) =>
  Object.assign(rateLimits, BASE_RATE_LIMITS, overrides);

/** Ein Bucket je Bot und Art. `Retry-After` gehört in die Antwort, damit ein
 *  Bot sein Limit selbst zurücknehmen kann, statt es zu testen. */
const takeRate = (kind, botId) => {
  const limit = rateLimits[kind];
  if (!limit) return;
  const key = `${botId}:${kind}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    const error = httpError(429, `Rate-Limit überschritten (${kind}).`);
    error.retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw error;
  }
};

const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, 60_000);
rateLimitCleanup.unref();

/** Nur für Tests: leert die Rate-Zähler. */
export const resetRateLimits = () => rateBuckets.clear();

/**
 * Namen und Werte werden vom Hub vergeben, nicht vom Bot. Die Muster halten
 * Bot-Ausgaben aus SQL- und Pfad-Kontexten heraus; `key` ist in MySQL ein
 * reserviertes Wort, deshalb heißt die Spalte `key_name`.
 */
const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const PREFIX_PATTERN = /^[A-Za-z0-9_.:@%~-]{0,127}$/;
const BOT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS bot_store (
    bot_id     VARCHAR(64)  NOT NULL,
    collection VARCHAR(32)  NOT NULL,
    key_name   VARCHAR(128) NOT NULL,
    value      MEDIUMTEXT   NOT NULL,
    created_at BIGINT       NOT NULL,
    updated_at BIGINT       NOT NULL,
    PRIMARY KEY (bot_id, collection, key_name)
  )`;

const SELECT_ONE = `
  SELECT key_name, value, created_at, updated_at
    FROM bot_store
   WHERE bot_id = ? AND collection = ? AND key_name = ?`;

// Escape-Zeichen für LIKE ist bewusst ein `!` und kein Backslash: MySQL liest
// einen Backslash in Zeichenketten als Escape-Sequenz (`'\\'` wäre dort ein
// Backslash, in SQLite zwei). `!` bedeutet in keiner der beiden Sprachen etwas.
const LIKE_ESCAPED = "LIKE ? ESCAPE '!'";

// Reihenfolge: Ohne diese Angabe sortiert MySQL nach seiner Kollation
// (`a_b` käme vor `a:1`), SQLite dagegen byteweise – und die Seiten aus
// Limit/Offset wären je nach Treiber anders. `HEX` gibt es in beiden; über den
// Hex-Wert ist die Reihenfolge der Byte-Wert, also in beiden dasselbe.
const ORDER_BY_KEY = 'ORDER BY HEX(key_name)';

const SELECT_PAGE = `
  SELECT key_name, value, created_at, updated_at
    FROM bot_store
   WHERE bot_id = ? AND collection = ? AND key_name ${LIKE_ESCAPED}
   ${ORDER_BY_KEY}
   LIMIT ? OFFSET ?`;

const SELECT_PAGE_ALL = `
  SELECT key_name, value, created_at, updated_at
    FROM bot_store
   WHERE bot_id = ? AND collection = ?
   ${ORDER_BY_KEY}
   LIMIT ? OFFSET ?`;

const COUNT_ALL = `
  SELECT COUNT(*) AS total FROM bot_store WHERE bot_id = ? AND collection = ?`;

const COUNT_PAGE = `
  SELECT COUNT(*) AS total FROM bot_store
   WHERE bot_id = ? AND collection = ? AND key_name ${LIKE_ESCAPED}`;

const UPDATE_ONE = `
  UPDATE bot_store
     SET value = ?, updated_at = ?
   WHERE bot_id = ? AND collection = ? AND key_name = ?`;

const INSERT_ONE = `
  INSERT INTO bot_store
    (bot_id, collection, key_name, value, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

const DELETE_ONE = `
  DELETE FROM bot_store
   WHERE bot_id = ? AND collection = ? AND key_name = ?`;
const DELETE_BOT_DATA = 'DELETE FROM bot_store WHERE bot_id = ?';
const DELETE_BOT_USAGE = 'DELETE FROM bot_store_usage WHERE bot_id = ?';

/* ------------------------------------------------------------------ *
 * Verbrauchszähler je Bot
 *
 * Die Zähler liegen in einer eigenen Tabelle, damit die Quota-Prüfung eine
 * Zeile sperren kann, statt über ein COUNT über die ganze Tabelle zu gehen.
 * Sie werden ausschließlich innerhalb derselben Transaktion verändert wie der
 * Eintrag selbst – sonst könnten parallele Schreibvorgänge aneinander vorbei
 * zählen. `rebuildUsage` rechnet sie aus den echten Zeilen neu, damit eine
 * veraltete oder teilweise Tabelle sich selbst heilt.
 * ------------------------------------------------------------------ */

const CREATE_USAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS bot_store_usage (
    bot_id          VARCHAR(64) NOT NULL,
    entry_count     BIGINT      NOT NULL DEFAULT 0,
    collection_count BIGINT     NOT NULL DEFAULT 0,
    byte_count      BIGINT      NOT NULL DEFAULT 0,
    updated_at      BIGINT      NOT NULL,
    PRIMARY KEY (bot_id)
  )`;

const SELECT_USAGE = `
  SELECT entry_count, collection_count, byte_count, updated_at
    FROM bot_store_usage
   WHERE bot_id = ?`;

// Absichtlich über alle Collections: das ist der Unterschied zwischen einer
// echten Bot-Quota und einer Quota pro Collection. Die Bytezahl braucht
// treiberspezifische Syntax, deshalb ist es eine Funktion statt eine Konstante.
const usageTotalsSql = (driver) => `
  SELECT COUNT(*) AS entry_count,
         COUNT(DISTINCT collection) AS collection_count,
         COALESCE(SUM(${driver === 'sqlite' ? VALUE_BYTES_SQLITE : VALUE_BYTES_MYSQL}), 0) AS byte_count
    FROM bot_store
   WHERE bot_id = ?`;

const USAGE_COLLECTION_EXISTS = `
  SELECT 1 AS present FROM bot_store
   WHERE bot_id = ? AND collection = ?
   LIMIT 1`;

const INSERT_USAGE = `
  INSERT INTO bot_store_usage
    (bot_id, entry_count, collection_count, byte_count, updated_at)
  VALUES (?, ?, ?, ?, ?)`;

const UPDATE_USAGE = `
  UPDATE bot_store_usage
     SET entry_count = ?, collection_count = ?, byte_count = ?, updated_at = ?
   WHERE bot_id = ?`;

const UPSERT_USAGE_IGNORE_SQLITE = `
  INSERT OR IGNORE INTO bot_store_usage
    (bot_id, entry_count, collection_count, byte_count, updated_at)
  VALUES (?, 0, 0, 0, ?)`;

const UPSERT_USAGE_IGNORE_MYSQL = `
  INSERT IGNORE INTO bot_store_usage
    (bot_id, entry_count, collection_count, byte_count, updated_at)
  VALUES (?, 0, 0, 0, ?)`;

/** Länge eines Werts in Bytes – SQLite kennt LENGTH, MySQL Octet_length. */
const VALUE_BYTES_SQLITE = 'LENGTH(CAST(value AS BLOB))';
const VALUE_BYTES_MYSQL = 'OCTET_LENGTH(value)';

/* ------------------------------------------------------------------ *
 * Eingaben
 * ------------------------------------------------------------------ */

const required = (value, message) => {
  const text = String(value ?? '').trim();
  if (!text) throw httpError(400, message);
  return text;
};

export const normaliseBotId = (value) => {
  const id = String(value ?? '');
  if (!BOT_ID_PATTERN.test(id)) throw httpError(400, 'Ungültige Bot-ID.');
  return id;
};

export const normaliseCollection = (value) => {
  const name = required(value, 'Bitte einen Namen für die Sammlung angeben.');
  if (!COLLECTION_PATTERN.test(name))
    throw httpError(
      400,
      'Sammlungsnamen: 1–32 Zeichen aus a–z, 0–9, _ und -, beginnend mit einem Buchstaben oder einer Ziffer.',
    );
  return name;
};

export const normaliseKey = (value) => {
  const key = required(value, 'Bitte einen Schlüssel angeben.');
  if (!KEY_PATTERN.test(key))
    throw httpError(
      400,
      'Schlüssel: 1–128 Zeichen aus Buchstaben, Ziffern und . _ : @ - , beginnend mit einem Buchstaben oder einer Ziffer.',
    );
  return key;
};

/** Leeres Feld heißt "alle Schlüssel"; `%` und `_` werden zu Werten escaped. */
export const normalisePrefix = (value) => {
  const prefix = String(value ?? '').trim();
  if (!prefix) return '';
  if (!PREFIX_PATTERN.test(prefix))
    throw httpError(
      400,
      'Präfix: höchstens 128 Zeichen aus Buchstaben, Ziffern und . _ : @ % ~ -',
    );
  return prefix;
};

export const escapeLike = (prefix) =>
  prefix.replace(/[!%_]/g, (char) => `!${char}`);

export const normalisePage = ({ limit, offset } = {}) => {
  // `null` liefert `searchParams.get()`, wenn der Parameter fehlt.
  const parsedLimit =
    limit === undefined || limit === null || limit === ''
      ? DEFAULT_LIST
      : Number(limit);
  const parsedOffset =
    offset === undefined || offset === null || offset === ''
      ? 0
      : Number(offset);
  if (
    !Number.isInteger(parsedLimit) ||
    parsedLimit < 1 ||
    parsedLimit > MAX_LIST
  )
    throw httpError(
      400,
      `limit muss eine ganze Zahl zwischen 1 und ${MAX_LIST} sein.`,
    );
  if (
    !Number.isInteger(parsedOffset) ||
    parsedOffset < 0 ||
    parsedOffset > MAX_OFFSET
  )
    throw httpError(
      400,
      `offset muss eine ganze Zahl zwischen 0 und ${MAX_OFFSET} sein.`,
    );
  return { limit: parsedLimit, offset: parsedOffset };
};

export const checkValue = (value) => {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES)
    throw httpError(
      413,
      `Wert zu groß. Erlaubt sind ${MAX_VALUE_BYTES / 1024} KiB je Eintrag.`,
    );
  return json;
};

/* ------------------------------------------------------------------ *
 * Konfiguration
 * ------------------------------------------------------------------ */

/** Wie manager.js: ohne gesetzte Wurzel das Arbeitsverzeichnis des Prozesses. */
export const projectRootOf = (env = process.env) =>
  resolve(env.BOT_DASHBOARD_ROOT || process.cwd());

/**
 * Liest die Konfiguration und bricht bei allem ab, was unsicher oder unvollständig
 * ist. Bewusst ohne Seiteneffekte: der Start prüft damit, ob die Konfiguration
 * überhaupt tragfähig ist, und die Verbindung entsteht erst beim ersten
 * Gebrauch. Deshalb beendet ein gestarteter Hub nicht, weil MySQL gerade
 * nicht läuft - erst ein Bot, der Daten braucht, läuft dann auf einen Fehler.
 */
/**
 * Löst einen Pfad auf seinen echten Namen – auch über SymLinks hinweg.
 *
 * Ein reiner Vergleich aufgelöster Zeichenketten genügt nicht: ein SymLink
 * `data/db/x.sqlite -> bots/b/x.sqlite` liegt scheinbar außerhalb von `bots/`
 * und lädt trotzdem die DB eines Bots.
 *
 * `realpathSync` allein reicht dafür nicht, weil er auch dann scheitert, wenn
 * nur die letzte Komponente fehlt – und genau das ist hier der Normalfall: die
 * DB-Datei wird erst nach dieser Prüfung angelegt, ein vorhandener Link auf sie
 * aber schon. Deshalb wird ein Link von Hand aufgelöst, auch wenn sein Ziel
 * noch gar nicht existiert.
 */
export const realPathDeepest = (target) => {
  let current = resolve(target);
  // Teile, die es noch nicht gab – in Pfadrichtung, damit `join` sie richtig
  // anhängt.
  let pending = [];
  for (let step = 0; step < 64; step += 1) {
    let link = null;
    try {
      if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current);
    } catch {
      link = null;
    }
    if (link !== null) {
      // Auf das Ziel zeigen. Ist es selbst ein Link, greift derselbe Durchgang.
      current = isAbsolute(link)
        ? resolve(link)
        : resolve(dirname(current), link);
      continue;
    }
    try {
      const real = realpathSync(current);
      return pending.length ? join(real, ...pending) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      pending = [basename(current), ...pending];
      current = parent;
    }
  }
  return pending.length ? join(current, ...pending) : current;
};

/** Liegt `target` wirklich – auch über SymLinks – in `root`? */
export const staysInside = (root, target) => {
  const rel = relative(root, target);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Name und Port des verwalteten MySQL (`BOT_HUB_DB=mysql-container`).
 *
 * Hier und nicht im Provisionierer: die Auflösung der Konfiguration ist die
 * Aufgabe dieses Moduls, und `server/mysql.js` braucht dieselbe Antwort, um
 * seinen Container zu bauen. Ein Import in die andere Richtung würde einen
 * Zyklus erzeugen – und zwar genau dann, wenn er am unauffälligsten ist,
 * nämlich beim ersten Start.
 */
/**
 * Die feste Zieladresse des verwalteten MySQL-Containers. Muss zu
 * `server/mysql.js` (DEFAULT_MYSQL_CIDR, `containerAddress`) passen – hier
 * absichtlich dupliziert statt importiert: `mysql.js` importiert
 * `managedNames` aus dieser Datei, ein Rückimport wäre ein Zyklus.
 */
const MANAGED_MYSQL_CIDR = '172.30.252.0/24';
const MANAGED_MYSQL_PORT = 3306;

export const managedConnectTarget = (env = process.env) => {
  const cidr =
    String(env.BOT_HUB_MYSQL_NETWORK_CIDR ?? '').trim() || MANAGED_MYSQL_CIDR;
  const match = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match)
    throw new Error(
      `BOT_HUB_MYSQL_NETWORK_CIDR "${cidr}" ist keine IPv4-CIDR wie 172.30.252.0/24.`,
    );
  const base = match[1]
    .split('.')
    .reduce((acc, part) => acc * 256 + Number(part), 0);
  const host = [24, 16, 8, 0]
    .map((shift) => Math.floor((base + 2) / 2 ** shift) % 256)
    .join('.');
  return { host, port: MANAGED_MYSQL_PORT };
};

export const managedNames = (env = process.env) => {
  const name = (value, key, fallback) => {
    const text = String(value ?? '').trim() || fallback;
    // Keine Backticks, keine Anführungszeichen, kein `%`: der Name landet in
    // SQL und im Namen des Containers.
    if (!/^[A-Za-z0-9_]{1,32}$/.test(text))
      throw new Error(
        `${key} darf nur aus Buchstaben, Ziffern und _ bestehen und höchstens 32 Zeichen lang sein.`,
      );
    return text;
  };
  const user = name(env.BOT_HUB_DB_USER, 'BOT_HUB_DB_USER', 'bot_hub');
  if (user.toLowerCase() === 'root')
    throw new Error(
      'BOT_HUB_DB_USER=root ist nicht erlaubt. Der Hub arbeitet mit einem eigenen Benutzer, der nur auf seine Datenbank zugreift.',
    );
  const port = Number(String(env.BOT_HUB_DB_PORT ?? '').trim() || 3307);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(
      'BOT_HUB_DB_PORT muss eine ganze Zahl zwischen 1024 und 65535 sein – darunter läge ein Port, der üblicherweise einem Systemdienst gehört.',
    );
  return {
    database: name(env.BOT_HUB_DB_NAME, 'BOT_HUB_DB_NAME', 'bot_hub'),
    user,
    port,
  };
};

export const resolveDatabaseConfig = ({
  env = process.env,
  projectRoot,
} = {}) => {
  const driver = String(env.BOT_HUB_DB ?? 'sqlite')
    .trim()
    .toLowerCase();
  if (!DRIVERS.has(driver))
    throw new Error(
      `BOT_HUB_DB="${driver}" ist unbekannt. Erlaubt sind ${[...DRIVERS].join(' und ')}.`,
    );

  // Ein Testlauf darf ausdrücklich gegen MySQL prüfen; ohne diese Freigabe
  // bleibt SQLite Pflicht, damit kein Testlauf ungefragt eine echte Datenbank
  // anfasst. Die Freigabe trägt wenig, weil `server/index.js` den Testmodus an
  // NODE_ENV=test bindet.
  if (
    env.BOT_HUB_TEST_MODE === '1' &&
    env.BOT_HUB_TEST_MYSQL !== '1' &&
    driver !== 'sqlite'
  )
    throw new Error(
      'BOT_HUB_TEST_MODE=1 verlangt BOT_HUB_DB=sqlite – Tests dürfen keine echte Datenbank anrühren. Für einen MySQL-Test ausdrücklich BOT_HUB_TEST_MYSQL=1 setzen.',
    );

  if (driver === 'sqlite') {
    const configured = String(env.BOT_HUB_DB_FILE ?? '').trim();
    const file = configured
      ? isAbsolute(configured)
        ? configured
        : join(projectRootOf(env), configured)
      : join(projectRootOf(env), 'data', 'db', 'bot-hub.sqlite');
    const resolved = resolve(file);
    const botsRoot = resolve(projectRootOf(env), 'bots');
    // Zwei Vergleiche, weil jeder für sich etwas anderes sieht: der erste
    // fängt `./bots/x` und absolute Pfade, der zweite SymLinks, die aus
    // bots/ hinauszeigen.
    const lexical = staysInside(botsRoot, resolved);
    const throughLinks = staysInside(
      realPathDeepest(botsRoot),
      realPathDeepest(resolved),
    );
    if (lexical || throughLinks) {
      throw new Error(
        'BOT_HUB_DB_FILE darf nicht innerhalb von bots/ liegen – ein Bot könnte die DB direkt lesen.',
      );
    }
    return { driver, file, maxValueBytes: MAX_VALUE_BYTES };
  }

  // `mysql-container`: Adresse, Socket und Passwort stehen nicht mehr zur Wahl.
  // Der Container veröffentlicht nur auf Loopback, und sein Passwort erzeugt der
  // Hub selbst – ein hier gesetztes wäre entweder wirkungslos (der Wert im
  // env hat Vorrang und stünde im Klartext in .env) oder verwirrend. Beides
  // wird deshalb abgelehnt, statt stillschweigend eines zu ignorieren.
  const managed = driver === MANAGED;
  if (managed) {
    for (const [key, message] of [
      [
        'BOT_HUB_DB_HOST',
        'Der verwaltete MySQL-Container veröffentlicht nur auf 127.0.0.1. BOT_HUB_DB_HOST hier zu setzen würde diese Zusage aufheben.',
      ],
      [
        'BOT_HUB_DB_SOCKET',
        'Der verwaltete MySQL-Container gibt keinen Unix-Socket nach aussen. Für ein Socket BOT_HUB_DB=mysql mit eigenem MySQL nehmen.',
      ],
      [
        'BOT_HUB_DB_PASSWORD',
        'Das Passwort erzeugt der Hub selbst und legt es in data/secrets/db.env ab. In .env gehört es nicht – wer es dort findet, hat es im Klartext im Projekt.',
      ],
    ])
      if (String(env[key] ?? '').trim())
        throw new Error(
          `${key} ist bei BOT_HUB_DB=${MANAGED} nicht erlaubt. ${message}`,
        );
  }

  const socket = managed ? '' : String(env.BOT_HUB_DB_SOCKET ?? '').trim();
  const managedTarget = managed ? managedConnectTarget(env) : null;
  const host = managed
    ? managedTarget.host
    : String(env.BOT_HUB_DB_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  // Der Punkt der ganzen Sache: der Bot-Speicher bleibt auf diesem Rechner.
  // Beim verwalteten Container ist „lokal" die feste Adresse im internen
  // Docker-Netz – dahin führt von außen und aus Bot-Netzen keine Route.
  if (
    !socket &&
    !(managedTarget && host === managedTarget.host) &&
    !LOOPBACK.has(host)
  )
    throw new Error(
      `BOT_HUB_DB_HOST="${host}" ist nicht lokal. Der Bot-Speicher darf nur auf Loopback (127.0.0.1, ::1, localhost), über BOT_HUB_DB_SOCKET oder beim verwalteten Container über dessen internes Netz laufen – von außen dürfte sonst ein fremder Rechner auf die Bot-Daten zugreifen.`,
    );

  const database = required(
    managed ? managedNames(env).database : env.BOT_HUB_DB_NAME,
    'BOT_HUB_DB_NAME fehlt – welche Datenbank soll der Hub nehmen?',
  ).replace(/[^\w$]/g, '');
  const user = required(
    managed ? managedNames(env).user : env.BOT_HUB_DB_USER,
    'BOT_HUB_DB_USER fehlt – der Hub braucht einen eigenen MySQL-Benutzer für diese Datenbank.',
  );
  if (user.toLowerCase() === 'root')
    throw new Error(
      'BOT_HUB_DB_USER=root ist nicht erlaubt. Nimm einen eigenen Benutzer, der nur auf diese Datenbank zugreift.',
    );

  const port = managed
    ? managedTarget.port
    : Number(env.BOT_HUB_DB_PORT ?? 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      'BOT_HUB_DB_PORT muss eine Zahl zwischen 1 und 65535 sein.',
    );

  // Das Passwort darf auch in data/secrets/db.env (0600) stehen. Diese Datei
  // hat Vorrang, damit es nicht in .env und damit in der Prozessliste landet.
  const root = projectRoot ?? projectRootOf(env);
  const secrets = readSecretValues(root, 'db');
  const password = String(
    env.BOT_HUB_DB_PASSWORD ?? secrets.BOT_HUB_DB_PASSWORD ?? '',
  );

  return {
    // Beide MySQL-Varianten benutzen denselben Anfragepfad.
    driver: managed ? 'mysql' : driver,
    database,
    user,
    password,
    host: socket ? '' : host,
    port,
    socket,
    connectionLimit: MAX_CONNECTIONS,
    maxValueBytes: MAX_VALUE_BYTES,
  };
};

/** Kurzform für Logzeilen. Enthält nie Zugangsdaten. */
export const describeDatabase = (config) =>
  config.driver === 'sqlite'
    ? 'sqlite'
    : `mysql ${config.socket ? 'unix-socket' : `${config.host}:${config.port}`}/${config.database} als ${config.user}`;

/**
 * SQLite vor dem Start einmal öffnen und wieder schliessen: so existiert die
 * Datei mit ihren Rechten, sobald der Hub läuft, und ein Ort, an dem nicht
 * geschrieben werden darf, fällt beim Start auf statt beim ersten Bot, der
 * speichern will. MySQL bleibt unangetastet – dort darf der Hub auch dann
 * hochlaufen, wenn die Datenbank noch nicht bereit ist.
 */
export const prepareDatabase = async (config) => {
  if (config?.driver !== 'sqlite') return;
  const driver = await sqliteDriver(config);
  driver.close();
};

/**
 * Liegt die SQLite-Datei ausserhalb von `data/`? Dann ist es zwar kein Fehler –
 * ein Systemdienst darf die Datei gern unter `/var/lib` halten –, aber der Ort
 * verdient einen Hinweis: Liegt sie im Startordner eines Bots, kann dieser die
 * Datei direkt lesen und damit die API umgehen. Genau das soll hier nicht
 * passieren, deshalb steht der Hinweis beim Start und nicht im Forum.
 */
export const storeOutsideDataDir = (config, { env = process.env } = {}) => {
  if (config?.driver !== 'sqlite') return null;
  const dataDir = resolve(projectRootOf(env), 'data');
  const file = resolve(config.file);
  return file.startsWith(`${dataDir}${sep}`) ? null : file;
};

/* ------------------------------------------------------------------ *
 * Treiber
 * ------------------------------------------------------------------ */

/**
 * `node:sqlite` gilt in Node 22 noch als experimentell und schreibt beim Laden
 * eine Warnung. Die würde beim Start wie ein Fehler aussehen, deshalb wird nur
 * diese eine Warnung für den Dauer des Ladevorgangs ausgefiltert.
 */
const loadSqlite = async () => {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message ?? '')) return;
    return original.call(process, warning, ...rest);
  };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
};

const sqliteDriver = async (config) => {
  const DatabaseSync = await loadSqlite();
  mkdirSync(dirname(config.file), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(config.file), 0o700);
  } catch {
    /* Fremdes Verzeichnis (z. B. gemountet) - dann entscheidet dessen Rechte. */
  }
  let db;
  try {
    db = new DatabaseSync(config.file);
  } catch (error) {
    // Meldung des Treibers plus Hinweis, aber ohne den Pfad: der kann in einer
    // Antwort an einen Bot landen.
    throw new Error(
      `die Datei lässt sich nicht öffnen (${error.message}). Pfad und Rechte prüfen – das Verzeichnis muss für den Hub beschreibbar sein.`,
    );
  }
  try {
    chmodSync(config.file, 0o600);
  } catch {
    /* Datei gab es gerade noch nicht. */
  }
  // WAL erlaubt Lesen während eines Schreibvorgangs; busy_timeout fängt die
  // kurzen Sperren ab, wenn ein zweiter Hub auf dieselbe Datei zeigt.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(CREATE_TABLE);
  db.exec(CREATE_USAGE_TABLE);

  const cache = new Map();
  const prepare = (sql) => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  };

  /**
   * Transaktionen für SQLite.
   *
   * `BEGIN IMMEDIATE` nimmt die Schreibsperre sofort, nicht erst beim ersten
   * Schreibzugriff. Zusammen mit der Mutex im Store (siehe `withWrite`)
   * serialisiert das alle Schreibvorgänge des Prozesses: Zählerstand prüfen,
   * Eintrag schreiben und Zähler fortschreiben können nicht auseinanderlaufen.
   */
  let depth = 0;
  const runTx = async (work) => {
    if (depth > 0) return work(api);
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const result = await work(api);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Bereits zurückgerollt – der ursprüngliche Fehler zählt. */
      }
      throw error;
    } finally {
      depth = 0;
    }
  };

  const api = {
    run: (sql, params) => prepare(sql).run(...params),
    get: (sql, params) => prepare(sql).get(...params) ?? null,
    all: (sql, params) => prepare(sql).all(...params),
    ensureUsageRow: async (botId, now) => {
      prepare(UPSERT_USAGE_IGNORE_SQLITE).run(botId, now);
    },
    lockUsage: async (botId) => {
      // SQLite kennt kein FOR UPDATE. Die Sperre hält BEGIN IMMEDIATE.
      return prepare(SELECT_USAGE).get(botId) ?? null;
    },
    usageTotals: async (botId) =>
      prepare(usageTotalsSql('sqlite')).get(botId) ?? null,
    transaction: runTx,
    close: () => db.close(),
  };
  return api;
};

const mysqlDriver = async (config) => {
  let mysql;
  try {
    mysql = await import('mysql2/promise');
  } catch {
    throw new Error(
      'BOT_HUB_DB=mysql braucht das Paket mysql2 - installiere es mit "npm install mysql2" oder wechsle auf BOT_HUB_DB=sqlite.',
    );
  }
  // `multipleStatements: false` ist in mysql2 der Default und bleibt hier
  // ausdrücklich stehen: mit gekapselten Anweisungen könnte sonst ein Bot-Wert
  // eine zweite Anweisung an die Datenbank hängen.
  const pool = mysql.createPool({
    socketPath: config.socket || undefined,
    host: config.socket ? undefined : config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit,
    connectTimeout: 5000,
    multipleStatements: false,
    charset: 'utf8mb4',
    // BIGINT kommt als Zahl statt als String - die Zeitstempel liegen weit
    // unter der Grenze, an der eine Zahl ungenau würde.
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  await pool.query(CREATE_TABLE);
  await pool.query(CREATE_USAGE_TABLE);

  const isDuplicate = (error) => error?.code === 'ER_DUP_ENTRY';

  /**
   * Eine Transaktion braucht in MySQL eine eigene Verbindung aus dem Pool – und
   * dort eine Zeilensperre auf dem Zähler. Erst dadurch können zwei parallele
   * Schreibvorgänge nicht beide denselben Zählerstand lesen und sich zusammen
   * über die Quota hinaus schreiben.
   */
  const transaction = async (work) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const scoped = {
        run: async (sql, params) => {
          const [result] = await connection.execute(sql, params);
          return result;
        },
        get: async (sql, params) => {
          const [rows] = await connection.execute(sql, params);
          return rows[0] ?? null;
        },
        all: async (sql, params) => {
          const [rows] = await connection.execute(sql, params);
          return rows;
        },
        ensureUsageRow: async (botId, now) => {
          await connection.execute(UPSERT_USAGE_IGNORE_MYSQL, [botId, now]);
        },
        lockUsage: async (botId) => {
          const [rows] = await connection.execute(
            `${SELECT_USAGE} FOR UPDATE`,
            [botId],
          );
          return rows[0] ?? null;
        },
        // Muss auf derselben Verbindung laufen wie der Schreibvorgang: die
        // Quota wird aus den echten Zeilen neu berechnet, und zwar innerhalb
        // derselben Transaktion. Über den Pool bezogen sähe eine parallele
        // Änderung nicht, die der Zähler selbst aber schon – der Zähler wäre
        // dann genau der Wert, den man nicht mehr trauen darf.
        usageTotals: async (botId) => {
          const [rows] = await connection.execute(usageTotalsSql('mysql'), [
            botId,
          ]);
          return rows[0] ?? null;
        },
      };
      const result = await work(scoped);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  };

  const run = async (sql, params) => {
    const [result] = await pool.execute(sql, params);
    return result;
  };

  return {
    run: async (sql, params) => {
      try {
        return await run(sql, params);
      } catch (error) {
        if (isDuplicate(error)) return { duplicate: true };
        throw error;
      }
    },
    get: async (sql, params) => {
      const [rows] = await pool.execute(sql, params);
      return rows[0] ?? null;
    },
    all: async (sql, params) => {
      const [rows] = await pool.execute(sql, params);
      return rows;
    },
    ensureUsageRow: async (botId, now) => {
      await pool.execute(UPSERT_USAGE_IGNORE_MYSQL, [botId, now]);
    },
    lockUsage: async (botId) => {
      const [rows] = await pool.execute(`${SELECT_USAGE} FOR UPDATE`, [botId]);
      return rows[0] ?? null;
    },
    usageTotals: async (botId) => {
      const [rows] = await pool.execute(usageTotalsSql('mysql'), [botId]);
      return rows[0] ?? null;
    },
    transaction,
    close: () => pool.end(),
  };
};

/* ------------------------------------------------------------------ *
 * Speicher
 * ------------------------------------------------------------------ */

const entryOf = (row) => ({
  key: String(row.key_name),
  value: JSON.parse(String(row.value)),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

const duplicateEntry = () =>
  httpError(
    409,
    'Dieser Eintrag wurde gerade angelegt – bitte erneut schreiben.',
  );

/** SQLite und MySQL melden eine doppelte Zeile unterschiedlich. */
const isDuplicateError = (error) =>
  error?.duplicate === true ||
  error?.code === 'ER_DUP_ENTRY' ||
  /UNIQUE constraint failed/i.test(String(error?.message ?? ''));

const quotaExceeded = (what, limit, unit = 'Einträge') =>
  httpError(
    413,
    `Bot-Speicher voll: ${what}-Quota überschritten (max. ${limit} ${unit} je Bot).`,
  );

const usageOf = (row) => ({
  entries: Number(row?.entry_count ?? 0),
  collections: Number(row?.collection_count ?? 0),
  bytes: Number(row?.byte_count ?? 0),
});

/**
 * Zähler zurückschreiben. `UPDATE` zuerst, `INSERT` als Auffangnet – so bleibt
 * der Ablauf auch dann korrekt, wenn zwei Prozesse gleichzeitig dieselbe Zeile
 * erstmals anlegen wollen.
 */
const writeUsage = async (tx, botId, usage, now) => {
  const result = await tx.run(UPDATE_USAGE, [
    usage.entries,
    usage.collections,
    usage.bytes,
    now,
    botId,
  ]);
  const changes = Number(result?.changes ?? result?.affectedRows ?? 0);
  if (changes > 0) return;
  try {
    await tx.run(INSERT_USAGE, [
      botId,
      usage.entries,
      usage.collections,
      usage.bytes,
      now,
    ]);
  } catch (error) {
    // Ein anderer Prozess hat die Zeile zwischen UPDATE und INSERT angelegt.
    if (!isDuplicateError(error)) throw error;
    await tx.run(UPDATE_USAGE, [
      usage.entries,
      usage.collections,
      usage.bytes,
      now,
      botId,
    ]);
  }
};

const createStore = (config) => {
  let driver = null;
  let starting = null;
  let lastError = null;
  // Alle Schreibvorgänge eines Prozesses laufen hintereinander. Für SQLite ist
  // das die Bedingung dafür, dass Zählerstand und Eintrag nie auseinanderlaufen;
  // für MySQL kommt die Zeilensperre in der Transaktion dazu.
  let writeChain = Promise.resolve();

  const withWrite = (work) => {
    const result = writeChain.then(work, work);
    writeChain = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  /**
   * Verbindung erst beim ersten Bedarf. Der Start prüft die Konfiguration, aber
   * nicht die Erreichbarkeit - ein Hub darf starten, während MySQL noch nicht
   * bereit ist.
   */
  const connect = async () => {
    if (driver) return driver;
    if (!starting) {
      starting = (config.driver === 'sqlite' ? sqliteDriver : mysqlDriver)(
        config,
      )
        .then((opened) => {
          driver = opened;
          lastError = null;
          return opened;
        })
        .catch((error) => {
          lastError = error;
          starting = null;
          throw error;
        });
    }
    return starting;
  };

  return {
    driver: config.driver,

    /** Nur für Tests: der Treiber selbst, um Zählerzeilen zu untersuchen. */
    raw: async () => connect(),

    status: () => ({
      driver: config.driver,
      // Kein Pfad, kein Host, kein Benutzer: die Antwort geht an einen Bot.
      ready: Boolean(driver),
      maxValueBytes: config.maxValueBytes,
      // Die Quota-Grenzen sind keine Geheimnisse: ein Bot soll wissen, wann er
      // an eine Grenze stößt, statt es durch Raten herauszufinden.
      quotas: {
        entries: MAX_ENTRIES_PER_BOT,
        collections: MAX_COLLECTIONS_PER_BOT,
        bytes: MAX_DATABASE_BYTES_PER_BOT,
      },
    }),

    /**
     * Zählerstand eines Bots. Fehlt die Zeile, wird er aus den echten Zeilen
     * abgeleitet – dadurch heilt eine unvollständige Tabelle sich selbst.
     */
    usage: async (botId) => {
      const open = await connect();
      const id = normaliseBotId(botId);
      const row = await open.get(SELECT_USAGE, [id]);
      if (row) return usageOf(row);
      return usageOf(await open.usageTotals(id));
    },

    get: async (botId, collection, key) => {
      const id = normaliseBotId(botId);
      takeRate('read', id);
      const open = await connect();
      const row = await open.get(SELECT_ONE, [
        id,
        normaliseCollection(collection),
        normaliseKey(key),
      ]);
      return row ? entryOf(row) : null;
    },

    /** Löscht alle persistenten Werte und Quota-Zähler eines Bots. */
    removeBot: async (botId) => {
      const id = normaliseBotId(botId);
      const open = await connect();
      await withWrite(() =>
        open.transaction(async (tx) => {
          await tx.run(DELETE_BOT_DATA, [id]);
          await tx.run(DELETE_BOT_USAGE, [id]);
        }),
      );
      for (const key of rateBuckets.keys())
        if (key.startsWith(`${id}:`)) rateBuckets.delete(key);
      return true;
    },

    set: async (botId, collection, key, value) => {
      const id = normaliseBotId(botId);
      const name = normaliseCollection(collection);
      const entryKey = normaliseKey(key);
      const json = checkValue(value);
      const valueBytes = Buffer.byteLength(json, 'utf8');
      takeRate('write', id);

      const open = await connect();
      return withWrite(() =>
        open.transaction(async (tx) => {
          const now = Date.now();
          const existing = await tx.get(SELECT_ONE, [id, name, entryKey]);
          // Zähler innerhalb derselben Transaktion lesen: so kann kein zweiter
          // Schreibvorgang zwischen Lesen und Schreiben dazwischenfunken.
          const usage = usageOf(
            (await tx.lockUsage(id)) ?? (await tx.usageTotals(id)),
          );

          if (existing) {
            const previousBytes = Buffer.byteLength(
              String(existing.value),
              'utf8',
            );
            const nextBytes = usage.bytes - previousBytes + valueBytes;
            if (nextBytes > MAX_DATABASE_BYTES_PER_BOT)
              throw quotaExceeded(
                'Bytes',
                MAX_DATABASE_BYTES_PER_BOT / (1024 * 1024),
                'MiB',
              );
            await tx.run(UPDATE_ONE, [json, now, id, name, entryKey]);
            await writeUsage(tx, id, { ...usage, bytes: nextBytes }, now);
            return { created: false, updatedAt: now };
          }

          // Globale Quotas – über alle Collections hinweg, nicht je Collection.
          if (usage.entries + 1 > MAX_ENTRIES_PER_BOT)
            throw quotaExceeded('Einträge', MAX_ENTRIES_PER_BOT);
          if (usage.bytes + valueBytes > MAX_DATABASE_BYTES_PER_BOT)
            throw quotaExceeded(
              'Bytes',
              MAX_DATABASE_BYTES_PER_BOT / (1024 * 1024),
              'MiB',
            );

          let collections = usage.collections;
          const known = await tx.get(USAGE_COLLECTION_EXISTS, [id, name]);
          if (!known) {
            if (collections + 1 > MAX_COLLECTIONS_PER_BOT)
              throw quotaExceeded('Collections', MAX_COLLECTIONS_PER_BOT);
            collections += 1;
          }

          try {
            await tx.run(INSERT_ONE, [id, name, entryKey, json, now, now]);
          } catch (error) {
            // Ein zweiter Hub auf derselben Datei war schneller. Der Eintrag
            // existiert dann schon – das ist kein Fehler, sondern ein Update.
            if (isDuplicateError(error)) throw duplicateEntry();
            throw error;
          }
          await writeUsage(
            tx,
            id,
            {
              entries: usage.entries + 1,
              collections,
              bytes: usage.bytes + valueBytes,
            },
            now,
          );
          return { created: true, updatedAt: now };
        }),
      );
    },

    remove: async (botId, collection, key) => {
      const id = normaliseBotId(botId);
      const name = normaliseCollection(collection);
      const entryKey = normaliseKey(key);
      takeRate('delete', id);

      const open = await connect();
      return withWrite(() =>
        open.transaction(async (tx) => {
          const now = Date.now();
          const existing = await tx.get(SELECT_ONE, [id, name, entryKey]);
          if (!existing) return false;
          await tx.run(DELETE_ONE, [id, name, entryKey]);
          const usage = usageOf(
            (await tx.lockUsage(id)) ?? (await tx.usageTotals(id)),
          );
          const freed = Buffer.byteLength(String(existing.value), 'utf8');
          // Eine Collection zählt nur, solange sie noch einen Eintrag hat.
          const stillUsed = await tx.get(USAGE_COLLECTION_EXISTS, [id, name]);
          await writeUsage(
            tx,
            id,
            {
              entries: Math.max(0, usage.entries - 1),
              collections:
                stillUsed || usage.collections === 0
                  ? usage.collections
                  : usage.collections - 1,
              bytes: Math.max(0, usage.bytes - freed),
            },
            now,
          );
          return true;
        }),
      );
    },

    list: async (botId, options = {}) => {
      const id = normaliseBotId(botId);
      takeRate('query', id);
      const open = await connect();
      const name = normaliseCollection(options.collection);
      const prefix = normalisePrefix(options.prefix);
      const { limit, offset } = normalisePage(options);
      const pattern = `${escapeLike(prefix)}%`;

      const rows = prefix
        ? await open.all(SELECT_PAGE, [id, name, pattern, limit, offset])
        : await open.all(SELECT_PAGE_ALL, [id, name, limit, offset]);
      const counter = prefix
        ? await open.get(COUNT_PAGE, [id, name, pattern])
        : await open.get(COUNT_ALL, [id, name]);

      // Eine volle Seite aus 200 Werten zu je 64 KiB wäre über 12 MiB. Statt
      // die Antwort abzuschneiden und damit ein stiller Datenverlust zu sein,
      // wird sie hier am Byte-Budget entlang gefüllt und die Kürzung gemeldet.
      const entries = [];
      let bytes = 0;
      let truncated = false;
      for (const row of rows) {
        const size = Buffer.byteLength(String(row.value), 'utf8');
        if (bytes + size > MAX_RESPONSE_BYTES) {
          truncated = true;
          break;
        }
        bytes += size;
        entries.push(entryOf(row));
      }

      return {
        collection: name,
        prefix,
        limit,
        offset,
        total: Number(counter?.total ?? 0),
        truncated,
        entries,
      };
    },

    close: async () => {
      const open = driver;
      driver = null;
      starting = null;
      if (open) await open.close();
    },

    /** Nur für Startmeldungen und Tests. */
    lastError: () => lastError?.message ?? null,
  };
};

/* ------------------------------------------------------------------ *
 * Singleton
 * ------------------------------------------------------------------ */

let shared = null;
let sharedConfig = null;

/**
 * Der Hub arbeitet mit genau einem Speicher. Er wird beim ersten Zugriff
 * aufgebaut, damit Tests und Diagnosen ihre Konfiguration vorher setzen können.
 */
export const database = () => {
  if (!shared) {
    sharedConfig = resolveDatabaseConfig();
    shared = createStore(sharedConfig);
  }
  return shared;
};

export const databaseConfig = () => sharedConfig ?? resolveDatabaseConfig();

export const closeDatabase = async () => {
  const open = shared;
  shared = null;
  if (open) await open.close();
};

/** Nur für Tests: setzt den geteilten Speicher zurück. */
export const resetDatabase = () => {
  shared = null;
  sharedConfig = null;
};

/** Nur für Tests: ein Speicher mit eigener Konfiguration. */
export const createTestStore = (config) =>
  createStore({ ...resolveDatabaseConfig({ env: {} }), ...config });
