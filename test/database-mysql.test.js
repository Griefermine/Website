/**
 * Dieselben Zusicherungen wie in `database.test.js`, aber gegen eine echte
 * MySQL/MariaDB. Ohne ausdrückliche Freigabe wird die Datei übersprungen –
 * MySQL bleibt eine Wahl, kein Zwang.
 *
 * Zwei Wege, sich eine Datenbank zu beschaffen:
 *
 * **Selbst mitbringen** (empfohlen). Der Hub startet seinen eigenen Container,
 * legt Datenbank und Benutzer an und räumt am Ende wieder auf:
 *
 *   BOT_HUB_TEST_MYSQL=1 BOT_HUB_TEST_MYSQL_CONTAINER=1 \
 *     node --test test/database-mysql.test.js
 *
 * **Eigene MySQL.** Dann bis heute nötig, ein MySQL vorher zu starten:
 *
 *   docker run -d --name bothub-db-test \
 *     -e MYSQL_ROOT_PASSWORD=probe-root -e MYSQL_DATABASE=bothub_probe \
 *     -e MYSQL_USER=bothub -e MYSQL_PASSWORD=probe-pass \
 *     -p 127.0.0.1:13306:3306 mariadb:11
 *
 *   BOT_HUB_TEST_MYSQL=1 node --test test/database-mysql.test.js
 *
 * Der erste Weg ist keine Bequemlichkeit: über den zweiten ist diese Datei
 * praktisch nie gelaufen, und prompt was nur SQLite prüfte, ist an ihm
 * vorbeigegangen – ein fehlendes `tx.usageTotals` blieb dadurch unentdeckt.
 *
 * Jeder Lauf bekommt eigene Bot-IDs und räumt seine Einträge am Ende wieder weg,
 * damit wiederholte Läufe sich nicht in die Quere kommen.
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.BOT_HUB_TEST_MODE = '1';

const enabled = process.env.BOT_HUB_TEST_MYSQL === '1';
const reason = 'BOT_HUB_TEST_MYSQL=1 fehlt';
/** Soll der Hub sich seine MySQL selbst stellen? */
const withContainer = process.env.BOT_HUB_TEST_MYSQL_CONTAINER === '1';

let env = {
  BOT_HUB_DB: 'mysql',
  BOT_HUB_DB_HOST: '127.0.0.1',
  BOT_HUB_DB_PORT: process.env.BOT_HUB_TEST_MYSQL_PORT || '13306',
  BOT_HUB_DB_NAME: process.env.BOT_HUB_TEST_MYSQL_DB || 'bothub_probe',
  BOT_HUB_DB_USER: process.env.BOT_HUB_TEST_MYSQL_USER || 'bothub',
  BOT_HUB_DB_PASSWORD: process.env.BOT_HUB_TEST_MYSQL_PASSWORD || 'probe-pass',
};

let store;
let reachable = false;
const runId = `${process.pid}x${Date.now().toString(36)}`;
const angelegt = [];
/** Nur für den selbstgestellten Container, damit am Ende aufzuräumen ist. */
let aufraeumen = null;
let aufraeumenDir = null;

const botId = (name) => {
  const id = `t${runId}-${name}`.slice(0, 64);
  angelegt.push(id);
  return id;
};

const put = async (bot, collection, key, value) => {
  await store.set(bot, collection, key, value);
  return { bot, collection, key };
};

/** Hub-MySQL für diesen Lauf aufsetzen und die Zugangsdaten zurückgeben. */
const eigenerContainer = async () => {
  const { provisionManagedMySql } = await import('../server/mysql.js');
  const dir = mkdtempSync(join(tmpdir(), 'bot-hub-mysql-suite-'));
  const projekt = {
    BOT_HUB_CONTAINER_PREFIX: `bothub-test${process.pid.toString(36)}`,
    BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS: '300000',
  };
  const ergebnis = await provisionManagedMySql({
    env: projekt,
    projectRoot: dir,
  });
  const config = ergebnis.config;
  // Maßnahme 43: der verwaltete Container veröffentlicht bewusst keinen
  // Host-Port (Docker leitet auf internen Netzen nichts durch) – erreichbar
  // ist er nur über seine feste Netzadresse, genau wie im Hub-Betrieb. Der
  // Test verband sich bisher mit 127.0.0.1 auf einen nie veröffentlichten
  // Port, deshalb meldete der CI-Gate seit je „MySQL nicht erreichbar“.
  // Die Verbindung leitet der Hub selbst aus dem verwalteten Modus ab
  // (BOT_HUB_DB=mysql-container): dasselbe Bild wie in der produktiven .env.
  return {
    dir,
    config,
    env: {
      BOT_HUB_DB: 'mysql-container',
      BOT_HUB_CONTAINER_PREFIX: projekt.BOT_HUB_CONTAINER_PREFIX,
      BOT_DASHBOARD_ROOT: dir,
    },
  };
};

before(async () => {
  if (!enabled) return;
  if (withContainer) {
    try {
      const gestellt = await eigenerContainer();
      env = gestellt.env;
      const { createProvisioner } = await import('../server/mysql.js');
      // Für das Aufräumen: derselbe Provisionierer kennt Container, Netz und
      // Datenverzeichnis. `reset()` nimmt genau das auseinander.
      aufraeumen = () =>
        createProvisioner({
          env: {
            BOT_HUB_CONTAINER_PREFIX: `bothub-test${process.pid.toString(36)}`,
          },
          projectRoot: gestellt.dir,
        }).reset();
      // Der Ordner bleibt bis zum Ende stehen, weil `reset` darin das
      // Datenverzeichnis löscht – beides zusammen erst danach.
      aufraeumenDir = gestellt.dir;
    } catch (error) {
      console.error(
        `[hub] Hub-MySQL konnte nicht gestartet werden: ${error.message}`,
      );
      return;
    }
  }
  const { createTestStore, resolveDatabaseConfig } =
    await import('../server/database.js');
  store = createTestStore(resolveDatabaseConfig({ env }));
  // Maßnahme 43 (CI-Befund): der Provisionierer meldet „bereit“, aber die
  // Härtung prüft von innen, während die Hafen-Weiterleitung nach außen
  // Sekunden später greift. Auf dem Runner war der erste Connect Versuch ein
  // ECONNREFUSED – und der Gate wurde rot, obwohl MySQL hochkam. Also:
  // nachhostbare Bereitschaft mit Frist, nur für den selbstgestellten
  // Container (eine extern gesetzte MySQL soll schnell fehlschlagen).
  const frist = Date.now() + (withContainer ? 90_000 : 0);
  for (;;) {
    try {
      await store.list('bereitheit', { collection: 'test' });
      reachable = true;
      break;
    } catch (error) {
      if (Date.now() >= frist) {
        console.error(
          `[hub] MySQL nicht erreichbar, die MySQL-Tests laufen nicht: ${error.message}`,
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
});

after(async () => {
  if (reachable) {
    for (const { bot, collection, key } of angelegt)
      await store.remove(bot, collection, key).catch(() => {});
    await store.close();
  }
  // Erst Container und Netz abräumen, dann das Verzeichnis: `reset` löscht
  // darin das Datenverzeichnis.
  if (aufraeumen) await aufraeumen().catch(() => {});
  if (aufraeumenDir) rmSync(aufraeumenDir, { recursive: true, force: true });
});

describe('Bot-Speicher auf MySQL', () => {
  it(
    'legt an, liest und überschreibt',
    { skip: !enabled && reason },
    async () => {
      if (!reachable) return;
      const bot = botId('crud');
      const created = await store.set(bot, 'notizen', 'k:1', { anzahl: 1 });
      assert.equal(created.created, true);

      const updated = await store.set(bot, 'notizen', 'k:1', { anzahl: 2 });
      assert.equal(updated.created, false);

      const entry = await store.get(bot, 'notizen', 'k:1');
      assert.deepEqual(entry.value, { anzahl: 2 });
      assert.equal(entry.createdAt, created.updatedAt);
      assert.ok(entry.updatedAt >= created.updatedAt);
    },
  );

  it('hält Bots getrennt', { skip: !enabled && reason }, async () => {
    if (!reachable) return;
    const eins = botId('trenn-eins');
    const zwei = botId('trenn-zwei');
    await store.set(eins, 'geheim', 'wert', { nur: 'eins' });
    assert.equal(await store.get(zwei, 'geheim', 'wert'), null);
    const liste = await store.list(zwei, { collection: 'geheim' });
    assert.deepEqual(liste.entries, []);
    assert.equal(liste.total, 0);
  });

  it('listet mit Präfix und Seiten', { skip: !enabled && reason }, async () => {
    if (!reachable) return;
    const bot = botId('liste');
    for (const key of ['a:1', 'a:2', 'a_b', 'b:1'])
      await put(bot, 'werte', key, { key });

    const alle = await store.list(bot, { collection: 'werte' });
    assert.deepEqual(
      alle.entries.map((entry) => entry.key),
      ['a:1', 'a:2', 'a_b', 'b:1'],
    );
    assert.equal(alle.total, 4);

    // `_` ist ein LIKE-Platzhalter und muss als Zeichen gelten. MySQL kollatiert
    // sonst anders als SQLite – die Reihenfolge muss trotzdem gleich sein.
    const unterstrich = await store.list(bot, {
      collection: 'werte',
      prefix: 'a_',
    });
    assert.deepEqual(
      unterstrich.entries.map((entry) => entry.key),
      ['a_b'],
    );
    assert.equal(unterstrich.total, 1);

    const seite = await store.list(bot, {
      collection: 'werte',
      limit: 2,
      offset: 1,
    });
    assert.deepEqual(
      seite.entries.map((entry) => entry.key),
      ['a:2', 'a_b'],
    );
  });

  it(
    'löscht und meldet fehlende Einträge',
    { skip: !enabled && reason },
    async () => {
      if (!reachable) return;
      const bot = botId('weg');
      await store.set(bot, 'x', 'k', { a: 1 });
      assert.equal(await store.remove(bot, 'x', 'k'), true);
      assert.equal(await store.remove(bot, 'x', 'k'), false);
      assert.equal(await store.get(bot, 'x', 'k'), null);
    },
  );

  it('weist Werte über 64 KiB ab', { skip: !enabled && reason }, async () => {
    if (!reachable) return;
    const { MAX_VALUE_BYTES } = await import('../server/database.js');
    await assert.rejects(
      () =>
        store.set(botId('gross'), 'x', 'k', {
          text: 'a'.repeat(MAX_VALUE_BYTES),
        }),
      /Wert zu groß/,
    );
  });

  it(
    'übersteht einen Schlüssel, der wie ein Angriff aussieht',
    { skip: !enabled && reason },
    async () => {
      if (!reachable) return;
      const bot = botId('boese');
      await assert.rejects(
        () => store.set(bot, 'x', "'; DROP TABLE bot_store; --", { a: 1 }),
        /Schlüssel/,
      );
      // Die Tabelle steht noch.
      const danach = await store.set(bot, 'x', 'normal', { a: 1 });
      assert.equal(danach.created, true);
    },
  );
});

/**
 * Der gleiche Weg wie in `database.test.js`, nur gegen MySQL: Hub starten,
 * Bot starten, über `/api/hub/db` schreiben und lesen. Damit ist nicht nur das
 * Modul geprüft, sondern die ganze Kette aus Token, Route und Treiber.
 */
describe('Bot-Speicher über die API auf MySQL', () => {
  let hub;
  let baseUrl;
  let hubRoot;
  const bots = [];
  const apiEintraege = [];

  before(async () => {
    if (!reachable) return;
    // Maßnahme 43: im Container-Lauf ist das Projekt desselben Bilds wie in
    // der produktiven .env (BOT_HUB_DB=mysql-container) – das Datenverzeichnis
    // des Provisionierers ist zugleich Hub-Wurzel, dort liegt das Secret.
    hubRoot = withContainer
      ? aufraeumenDir
      : mkdtempSync(join(tmpdir(), 'bot-hub-db-mysql-'));
    Object.assign(process.env, {
      BOT_DASHBOARD_ROOT: hubRoot,
      BOT_HUB_TEST_MYSQL: '1',
      ...(withContainer
        ? {
            BOT_HUB_DB: 'mysql-container',
            BOT_HUB_CONTAINER_PREFIX: env.BOT_HUB_CONTAINER_PREFIX,
          }
        : {
            BOT_HUB_DB: 'mysql',
            BOT_HUB_DB_HOST: env.BOT_HUB_DB_HOST,
            BOT_HUB_DB_PORT: env.BOT_HUB_DB_PORT,
            BOT_HUB_DB_NAME: env.BOT_HUB_DB_NAME,
            BOT_HUB_DB_USER: env.BOT_HUB_DB_USER,
            BOT_HUB_DB_PASSWORD: env.BOT_HUB_DB_PASSWORD,
          }),
    });
    const { createServer: createApp } = await import('../server/manager.js');
    hub = createServer(createApp());
    await new Promise((done) => hub.listen(0, '127.0.0.1', done));
    baseUrl = `http://127.0.0.1:${hub.address().port}`;
  });

  after(async () => {
    if (!hub) return;
    for (const { token, pfad } of apiEintraege)
      await callWith(token)(`/hub/db/${pfad}`, { method: 'DELETE' }).catch(
        () => {},
      );
    const { closeDatabase } = await import('../server/database.js');
    await closeDatabase();
    await new Promise((done) => hub.close(done));
  });

  const callWith =
    (token) =>
    (path, options = {}) =>
      fetch(`${baseUrl}/api${path}`, {
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(options.headers ?? {}),
        },
        method: options.method ?? 'GET',
        body: options.body ? JSON.stringify(options.body) : undefined,
      }).then(async (response) => ({
        status: response.status,
        data: await response.json().catch(() => ({})),
      }));

  const starteBot = async (name) => {
    mkdirSync(join(hubRoot, name), { recursive: true });
    writeFileSync(
      join(hubRoot, name, 'bot.sh'),
      'echo "token=$BOT_HUB_TOKEN"\nprintf "%s" "$BOT_HUB_TOKEN" > runtime-token.txt\nsleep 30\n',
    );
    const created = await callWith('')('/bots', {
      method: 'POST',
      body: {
        name,
        language: 'custom',
        cwd: name,
        entrypoint: 'bot.sh',
        command: 'sh {entrypoint}',
      },
    });
    await callWith('')(`/bots/${created.data.bot.id}/start`, {
      method: 'POST',
      body: {},
    });
    for (let i = 0; i < 100; i += 1) {
      try {
        const token = readFileSync(
          join(hubRoot, name, 'runtime-token.txt'),
          'utf8',
        );
        if (token) {
          bots.push({ name, token });
          return { token, id: created.data.bot.id };
        }
      } catch {
        // Der Bot hat sein Runtime-Token noch nicht geschrieben.
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error('Timeout: Bot hat sein Token nicht gemeldet');
  };

  it(
    'schreibt, liest und trennt Bots über die API',
    { skip: !enabled && reason },
    async () => {
      if (!reachable) return;
      const eins = await starteBot('mysql-eins');
      const zwei = await starteBot('mysql-zwei');

      const geschrieben = await callWith(eins.token)(
        '/hub/db/notizen/treffer',
        {
          method: 'PUT',
          body: { value: { text: 'gefunden' } },
        },
      );
      assert.equal(geschrieben.status, 200);
      assert.equal(geschrieben.data.entry.created, true);
      apiEintraege.push({ token: eins.token, pfad: 'notizen/treffer' });

      const gelesen = await callWith(eins.token)('/hub/db/notizen/treffer');
      assert.deepEqual(gelesen.data.entry.value, { text: 'gefunden' });

      // Der zweite Bot sieht davon nichts – die Trennung steckt im Token.
      const fremd = await callWith(zwei.token)('/hub/db/notizen/treffer');
      assert.equal(fremd.status, 404);
      const fremdeListe = await callWith(zwei.token)('/hub/db/notizen');
      assert.deepEqual(fremdeListe.data.entries, []);

      const { panelToken } = await import('../server/panel.js');

      const mitPanel = await callWith(panelToken(eins.id))('/hub/db/notizen');
      assert.equal(mitPanel.status, 403);
    },
  );
});
