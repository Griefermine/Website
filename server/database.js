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

import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readSecretValues } from './secrets.js';
import { httpError } from './util.js';

/** Obergrenze für einen einzelnen Wert in Bytes (serialisiert als JSON). */
export const MAX_VALUE_BYTES = 64 * 1024;
const MAX_LIST = 200;
const DEFAULT_LIST = 100;
const MAX_OFFSET = 100_000;
const MAX_CONNECTIONS = 8;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
const DRIVERS = new Set(['sqlite', 'mysql']);

/** Quotas pro Bot gegen Ressourcenmissbrauch / DoS. */
export const MAX_ENTRIES_PER_BOT = 10_000;
export const MAX_DATABASE_BYTES_PER_BOT = 100 * 1024 * 1024; // 100 MiB
export const MAX_WRITES_PER_MINUTE = 120;
export const MAX_DELETES_PER_MINUTE = 60;

/** Rate-Limit-Zähler pro Bot (in-memory). */
const writeRateBuckets = new Map();
const deleteRateBuckets = new Map();
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of writeRateBuckets) {
    if (bucket.resetAt <= now) writeRateBuckets.delete(key);
  }
  for (const [key, bucket] of deleteRateBuckets) {
    if (bucket.resetAt <= now) deleteRateBuckets.delete(key);
  }
}, 60_000);
rateLimitCleanup.unref();

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
    const relativeToBots = relative(botsRoot, resolved);
    // Sicherheitsregel: DB-Dateien dürfen niemals im Bot-Workspace liegen.
    if (
      relativeToBots &&
      !relativeToBots.startsWith('..') &&
      !isAbsolute(relativeToBots)
    ) {
      throw new Error(
        'BOT_HUB_DB_FILE darf nicht innerhalb von bots/ liegen – ein Bot könnte die DB direkt lesen.',
      );
    }
    return { driver, file, maxValueBytes: MAX_VALUE_BYTES };
  }

  const socket = String(env.BOT_HUB_DB_SOCKET ?? '').trim();
  const host = String(env.BOT_HUB_DB_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  // Der Punkt der ganzen Sache: der Bot-Speicher bleibt auf diesem Rechner.
  if (!socket && !LOOPBACK.has(host))
    throw new Error(
      `BOT_HUB_DB_HOST="${host}" ist nicht lokal. Der Bot-Speicher darf nur auf Loopback (127.0.0.1, ::1, localhost) oder über BOT_HUB_DB_SOCKET laufen – von außen dürfte sonst ein fremder Rechner auf die Bot-Daten zugreifen.`,
    );

  const database = required(
    env.BOT_HUB_DB_NAME,
    'BOT_HUB_DB_NAME fehlt – welche Datenbank soll der Hub nehmen?',
  ).replace(/[^\w$]/g, '');
  const user = required(
    env.BOT_HUB_DB_USER,
    'BOT_HUB_DB_USER fehlt – der Hub braucht einen eigenen MySQL-Benutzer für diese Datenbank.',
  );
  if (user.toLowerCase() === 'root')
    throw new Error(
      'BOT_HUB_DB_USER=root ist nicht erlaubt. Nimm einen eigenen Benutzer, der nur auf diese Datenbank zugreift.',
    );

  const port = Number(env.BOT_HUB_DB_PORT ?? 3306);
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
    driver,
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
 * verdient einen Hinweis: Liegt sie im Arbeitsordner eines Bots, kann dieser die
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

  const cache = new Map();
  const prepare = (sql) => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  };
  return {
    run: (sql, params) => prepare(sql).run(...params),
    get: (sql, params) => prepare(sql).get(...params) ?? null,
    all: (sql, params) => prepare(sql).all(...params),
    close: () => db.close(),
  };
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

  const run = async (sql, params) => {
    const [result] = await pool.execute(sql, params);
    return result;
  };
  const isDuplicate = (error) => error?.code === 'ER_DUP_ENTRY';
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

const createStore = (config) => {
  let driver = null;
  let starting = null;
  let lastError = null;

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

    status: () => ({
      driver: config.driver,
      // Kein Pfad, kein Host, kein Benutzer: die Antwort geht an einen Bot.
      ready: Boolean(driver),
      maxValueBytes: config.maxValueBytes,
    }),

    get: async (botId, collection, key) => {
      const open = await connect();
      const row = await open.get(SELECT_ONE, [
        normaliseBotId(botId),
        normaliseCollection(collection),
        normaliseKey(key),
      ]);
      return row ? entryOf(row) : null;
    },

    set: async (botId, collection, key, value) => {
      const open = await connect();
      const id = normaliseBotId(botId);
      const name = normaliseCollection(collection);
      const entryKey = normaliseKey(key);
      const json = checkValue(value);
      const now = Date.now();

      // Rate-Limit für Writes pro Bot
      const rateKey = `${id}:write`;
      const writeBucket = writeRateBuckets.get(rateKey);
      if (!writeBucket || writeBucket.resetAt <= now) {
        writeRateBuckets.set(rateKey, { count: 1, resetAt: now + 60_000 });
      } else {
        writeBucket.count += 1;
        if (writeBucket.count > MAX_WRITES_PER_MINUTE) {
          throw httpError(429, 'Write-Rate-Limit überschritten');
        }
      }

      const existing = await open.get(SELECT_ONE, [id, name, entryKey]);
      if (existing) {
        await open.run(UPDATE_ONE, [json, now, id, name, entryKey]);
        return { created: false, updatedAt: now };
      }

      // Quota-Prüfung nur bei neuen Einträgen
      const countRow = await open.get(COUNT_ALL, [id, name]);
      const currentCount = Number(countRow?.total ?? 0);
      if (currentCount >= MAX_ENTRIES_PER_BOT) {
        throw httpError(413, `Maximale Eintragsanzahl pro Bot überschritten (${MAX_ENTRIES_PER_BOT})`);
      }

      try {
        await open.run(INSERT_ONE, [id, name, entryKey, json, now, now]);
        return { created: true, updatedAt: now };
      } catch (error) {
        // Ein zweiter Hub auf derselben Datei war schneller. Der Eintrag
        // existiert dann schon - das ist kein Fehler, sondern ein Update.
        if (error?.duplicate) throw duplicateEntry();
        throw error;
      }
    },

    remove: async (botId, collection, key) => {
      const open = await connect();
      const id = normaliseBotId(botId);

      // Rate-Limit für Deletes pro Bot
      const rateKey = `${id}:delete`;
      const deleteBucket = deleteRateBuckets.get(rateKey);
      const now = Date.now();
      if (!deleteBucket || deleteBucket.resetAt <= now) {
        deleteRateBuckets.set(rateKey, { count: 1, resetAt: now + 60_000 });
      } else {
        deleteBucket.count += 1;
        if (deleteBucket.count > MAX_DELETES_PER_MINUTE) {
          throw httpError(429, 'Delete-Rate-Limit überschritten');
        }
      }

      const result = await open.run(DELETE_ONE, [
        id,
        normaliseCollection(collection),
        normaliseKey(key),
      ]);
      const changes = Number(result?.changes ?? result?.affectedRows ?? 0);
      return changes > 0;
    },

    list: async (botId, options = {}) => {
      const open = await connect();
      const id = normaliseBotId(botId);
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

      return {
        collection: name,
        prefix,
        limit,
        offset,
        total: Number(counter?.total ?? 0),
        entries: rows.map(entryOf),
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
