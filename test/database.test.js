import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

// Der Testmodus ist nur mit NODE_ENV=test erlaubt (server/index.js).
process.env.NODE_ENV = 'test';
process.env.BOT_HUB_TEST_MODE = '1';

let root;
let baseUrl;
let server;

const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : {},
    headers: response.headers,
  };
};

const callWithToken =
  (token) =>
  (path, options = {}) =>
    call(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
    });

const createBot = async (body) =>
  (await call('/bots', { method: 'POST', body })).data.bot;

/**
 * Startet einen Bot, der nur seinen Token meldet, und wartet, bis der Hub ihn
 * kennt. So bekommt der Test einen echten Laufzeit-Token – der einzige Weg, der
 * laut Hub zum Bot-Speicher führt.
 */
const startBot = async (name) => {
  const dir = name;
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(
    join(root, dir, 'bot.sh'),
    'echo "token=$BOT_HUB_TOKEN"\nprintf "%s" "$BOT_HUB_TOKEN" > runtime-token.txt\nsleep 30\n',
  );
  const bot = await createBot({
    name,
    language: 'custom',
    cwd: dir,
    entrypoint: 'bot.sh',
    command: 'sh {entrypoint}',
  });
  await call(`/bots/${bot.id}/start`, { method: 'POST', body: {} });
  for (let i = 0; i < 100; i += 1) {
    try {
      const token = readFileSync(join(root, dir, 'runtime-token.txt'), 'utf8');
      if (token) return { bot, token };
    } catch {
      // Der Bot hat sein Runtime-Token noch nicht geschrieben.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timeout: Bot hat sein Token nicht gemeldet');
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'bot-hub-db-'));
  process.env.BOT_DASHBOARD_ROOT = root;
  process.env.BOT_HUB_DB = 'sqlite';
  const { createServer: createApp } = await import('../server/manager.js');
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  const { closeDatabase } = await import('../server/database.js');
  await closeDatabase();
  await new Promise((resolve) => server.close(resolve));
});

describe('Konfiguration', () => {
  it('nimmt ohne Schalter SQLite und legt die Datei unter data/db ab', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    const config = resolveDatabaseConfig({ env: {} });
    assert.equal(config.driver, 'sqlite');
    assert.equal(
      config.file,
      join(process.cwd(), 'data', 'db', 'bot-hub.sqlite'),
    );
  });

  it('lehnt einen unbekannten Treiber ab', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    assert.throws(
      () => resolveDatabaseConfig({ env: { BOT_HUB_DB: 'postgres' } }),
      /BOT_HUB_DB="postgres" ist unbekannt/,
    );
  });

  it('lehnt eine MySQL-Adresse ab, die nicht auf diesem Rechner liegt', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    assert.throws(
      () =>
        resolveDatabaseConfig({
          env: {
            BOT_HUB_DB: 'mysql',
            BOT_HUB_DB_HOST: 'db.example.com',
            BOT_HUB_DB_NAME: 'bOTHub',
            BOT_HUB_DB_USER: 'bothub',
          },
        }),
      /ist nicht lokal/,
    );
  });

  it('nimmt Loopback, ::1 und Unix-Socket an', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    const base = {
      BOT_HUB_DB: 'mysql',
      BOT_HUB_DB_NAME: 'bothub',
      BOT_HUB_DB_USER: 'bothub',
      BOT_HUB_DB_PASSWORD: 'geheim',
    };
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const config = resolveDatabaseConfig({
        env: { ...base, BOT_HUB_DB_HOST: host },
      });
      assert.equal(config.driver, 'mysql');
      assert.equal(config.host, host);
      assert.equal(config.port, 3306);
    }
    const socket = resolveDatabaseConfig({
      env: { ...base, BOT_HUB_DB_SOCKET: '/run/mysqld/mysqld.sock' },
    });
    assert.equal(socket.socket, '/run/mysqld/mysqld.sock');
    assert.equal(socket.host, '');
  });

  it('verlangt für MySQL einen eigenen Benutzer mit Passwort', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    assert.throws(
      () => resolveDatabaseConfig({ env: { BOT_HUB_DB: 'mysql' } }),
      /BOT_HUB_DB_NAME fehlt/,
    );
    assert.throws(
      () =>
        resolveDatabaseConfig({
          env: { BOT_HUB_DB: 'mysql', BOT_HUB_DB_NAME: 'bothub' },
        }),
      /BOT_HUB_DB_USER fehlt/,
    );
    assert.throws(
      () =>
        resolveDatabaseConfig({
          env: {
            BOT_HUB_DB: 'mysql',
            BOT_HUB_DB_NAME: 'bothub',
            BOT_HUB_DB_USER: 'root',
          },
        }),
      /BOT_HUB_DB_USER=root ist nicht erlaubt/,
    );
  });

  it('holt das MySQL-Passwort aus data/secrets/db.env', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    const dir = mkdtempSync(join(tmpdir(), 'bot-hub-db-secret-'));
    mkdirSync(join(dir, 'data', 'secrets'), { recursive: true });
    writeFileSync(
      join(dir, 'data', 'secrets', 'db.env'),
      'BOT_HUB_DB_PASSWORD="aus-der-secret-datei"\n',
    );
    const config = resolveDatabaseConfig({
      env: {
        BOT_DASHBOARD_ROOT: dir,
        BOT_HUB_DB: 'mysql',
        BOT_HUB_DB_NAME: 'bothub',
        BOT_HUB_DB_USER: 'bothub',
      },
      projectRoot: dir,
    });
    assert.equal(config.password, 'aus-der-secret-datei');
  });

  it('verweigert im Testmodus eine echte Datenbank', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    assert.throws(
      () =>
        resolveDatabaseConfig({
          env: {
            BOT_HUB_DB: 'mysql',
            BOT_HUB_TEST_MODE: '1',
            BOT_HUB_DB_NAME: 'bothub',
            BOT_HUB_DB_USER: 'bothub',
          },
        }),
      /BOT_HUB_TEST_MODE=1 verlangt BOT_HUB_DB=sqlite/,
    );
  });

  it('meldet eine SQLite-Datei ausserhalb von data/', async () => {
    const { resolveDatabaseConfig, storeOutsideDataDir } =
      await import('../server/database.js');
    const env = { BOT_DASHBOARD_ROOT: root };
    assert.equal(
      storeOutsideDataDir(resolveDatabaseConfig({ env }), { env }),
      null,
    );
    const fremd = resolveDatabaseConfig({
      env: { ...env, BOT_HUB_DB_FILE: '/tmp/bot-hub-fremd.sqlite' },
    });
    assert.equal(
      storeOutsideDataDir(fremd, { env }),
      '/tmp/bot-hub-fremd.sqlite',
    );
  });

  it('legt die SQLite-Datei beim Start mit ihren Rechten an', async () => {
    const { resolveDatabaseConfig, prepareDatabase } =
      await import('../server/database.js');
    const ordner = join(root, 'start-check');
    const env = { BOT_DASHBOARD_ROOT: ordner };
    const datei = join(ordner, 'data', 'db', 'bot-hub.sqlite');
    assert.equal(existsSync(datei), false);

    await prepareDatabase(resolveDatabaseConfig({ env }));
    assert.equal(existsSync(datei), true);
    // 0700 fürs Verzeichnis, 0600 für die Datei: hier liegen die Werte aller
    // Bots, ein fremdes Konto auf diesem Rechner hat dort nichts verloren.
    assert.equal(statSync(join(ordner, 'data', 'db')).mode & 0o777, 0o700);
    assert.equal(statSync(datei).mode & 0o777, 0o600);
  });

  it('lässt MySQL beim Start unangetastet', async () => {
    const { resolveDatabaseConfig, prepareDatabase } =
      await import('../server/database.js');
    // Kein Server erreichbar: der Hub darf trotzdem hochlaufen, weil die
    // Verbindung erst beim ersten Zugriff entsteht.
    await prepareDatabase(
      resolveDatabaseConfig({
        env: {
          BOT_HUB_DB: 'mysql',
          BOT_HUB_DB_HOST: '127.0.0.1',
          BOT_HUB_DB_PORT: '1',
          BOT_HUB_DB_NAME: 'bot_hub',
          BOT_HUB_DB_USER: 'bot_hub',
        },
      }),
    );
  });

  it('meldet einen Ort, an dem nicht geschrieben werden darf', async () => {
    const { resolveDatabaseConfig, prepareDatabase } =
      await import('../server/database.js');
    const sperre = join(root, 'kein-ordner.sqlite');
    mkdirSync(sperre, { recursive: true });
    await assert.rejects(
      prepareDatabase(
        resolveDatabaseConfig({
          env: { BOT_HUB_DB_FILE: sperre },
        }),
      ),
      /lässt sich nicht öffnen/,
    );
  });
});

/**
 * Die Sperre auf `bots/` ist eine Zeichenkettenschranke. Sie hält `./bots/x` und
 * absolute Pfade fern, aber keinen SymLink – und über einen SymLink lädt der Hub
 * genau die Datei, die ein Bot ohne Umweg über die API lesen dürfte.
 */
describe('Die DB-Datei kann nicht in bots/ liegen', () => {
  it('lehnt einen relativen Pfad in bots/ ab', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    for (const pfad of [
      'bots/b/x.sqlite',
      './bots/b/x.sqlite',
      'data/../bots/b/x.sqlite',
    ]) {
      assert.throws(
        () =>
          resolveDatabaseConfig({
            env: { BOT_DASHBOARD_ROOT: root, BOT_HUB_DB_FILE: pfad },
          }),
        /nicht innerhalb von bots\//,
        `unverlangt zugelassen: ${pfad}`,
      );
    }
  });

  it('lehnt einen absoluten Pfad in bots/ ab', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    const ordner = mkdtempSync(join(root, 'abs-'));
    const botsRoot = join(ordner, 'bots');
    mkdirSync(botsRoot, { recursive: true });
    assert.throws(
      () =>
        resolveDatabaseConfig({
          env: {
            BOT_DASHBOARD_ROOT: ordner,
            BOT_HUB_DB_FILE: join(botsRoot, 'x.sqlite'),
          },
        }),
      /nicht innerhalb von bots\//,
    );
  });

  it('lehnt einen SymLink nach bots/ ab', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    const ordner = join(root, 'symlink-ziel');
    mkdirSync(join(ordner, 'bots', 'b'), { recursive: true });
    mkdirSync(join(ordner, 'data', 'db'), { recursive: true });
    symlinkSync(
      join(ordner, 'bots', 'b', 'x.sqlite'),
      join(ordner, 'data', 'db', 'x.sqlite'),
    );
    // Der Pfad zeigt nach data/db – und landet bei bots/b/x.sqlite.
    assert.throws(
      () =>
        resolveDatabaseConfig({
          env: {
            BOT_DASHBOARD_ROOT: ordner,
            BOT_HUB_DB_FILE: 'data/db/x.sqlite',
          },
        }),
      /nicht innerhalb von bots\//,
      'SymLink nach bots/ wurde zugelassen',
    );
  });

  it('folgt einem SymLink auch ohne vorhandenes Ziel', async () => {
    // Die DB-Datei existiert beim Start noch gar nicht. Ein Link, der auf sie
    // zeigt, muss trotzdem erkannt werden – sonst wartet die Prüfung auf eine
    // Datei, die sie selbst erst anlegen würde.
    const { resolveDatabaseConfig } = await import('../server/database.js');
    const ordner = mkdtempSync(join(root, 'tot-'));
    mkdirSync(join(ordner, 'bots', 'b'), { recursive: true });
    mkdirSync(join(ordner, 'data', 'db'), { recursive: true });
    symlinkSync(
      join(ordner, 'bots', 'b', 'x.sqlite'),
      join(ordner, 'data', 'db', 'x.sqlite'),
    );
    assert.equal(
      existsSync(join(ordner, 'data', 'db', 'x.sqlite')),
      false,
      'Ziel existiert bereits – der Fall wird nicht geprüft',
    );
    assert.throws(
      () =>
        resolveDatabaseConfig({
          env: {
            BOT_DASHBOARD_ROOT: ordner,
            BOT_HUB_DB_FILE: 'data/db/x.sqlite',
          },
        }),
      /nicht innerhalb von bots\//,
    );
  });

  it('lässt eine Datei daneben zu', async () => {
    const { resolveDatabaseConfig } = await import('../server/database.js');
    const config = resolveDatabaseConfig({
      env: {
        BOT_DASHBOARD_ROOT: root,
        BOT_HUB_DB_FILE: 'data/db/echt.sqlite',
      },
    });
    assert.equal(config.file, join(root, 'data', 'db', 'echt.sqlite'));
  });
});

describe('Eingaben', () => {
  const cases = [
    ['normaliseCollection', 'settings', 'settings'],
    ['normaliseCollection', '', /Sammlung angeben/],
    ['normaliseCollection', 'Mit leer', /Sammlungsnamen/],
    ['normaliseCollection', 'a'.repeat(33), /Sammlungsnamen/],
    ['normaliseKey', 'user:1', 'user:1'],
    ['normaliseKey', 'user 1', /Schlüssel/],
    ['normaliseKey', 'user/1', /Schlüssel/],
    ['normaliseKey', 'a'.repeat(129), /Schlüssel/],
    ['normalisePrefix', '', ''],
    ['normalisePrefix', 'user:', 'user:'],
    ['normalisePrefix', '%', '%'],
    ['normalisePrefix', 'a b', /Präfix/],
    [
      'normaliseBotId',
      '41b90464-81c7-40f3-8517-42cc6971f716',
      '41b90464-81c7-40f3-8517-42cc6971f716',
    ],
    ['normaliseBotId', '../fremd', /Bot-ID/],
  ];

  for (const [name, input, expected] of cases) {
    it(`${name}("${input}")`, async () => {
      const module = await import('../server/database.js');
      if (expected instanceof RegExp) {
        assert.throws(() => module[name](input), expected);
        return;
      }
      assert.equal(module[name](input), expected);
    });
  }

  it('behandelt % und _ im Präfix als Zeichen', async () => {
    const { escapeLike } = await import('../server/database.js');
    assert.equal(escapeLike('a_b'), 'a!_b');
    assert.equal(escapeLike('100%'), '100!%');
  });

  it('weist Werte über 64 KiB ab', async () => {
    const { checkValue, MAX_VALUE_BYTES } =
      await import('../server/database.js');
    assert.equal(checkValue({ text: 'a'.repeat(1024) }).includes('a'), true);
    assert.throws(
      () => checkValue({ text: 'a'.repeat(MAX_VALUE_BYTES) }),
      /Wert zu groß/,
    );
  });

  it('begrenzt Seitengrößen', async () => {
    const { normalisePage } = await import('../server/database.js');
    assert.deepEqual(normalisePage({}), { limit: 100, offset: 0 });
    assert.deepEqual(normalisePage({ limit: '5', offset: '10' }), {
      limit: 5,
      offset: 10,
    });
    for (const bad of [
      { limit: '0' },
      { limit: '201' },
      { offset: '-1' },
      { limit: 'x' },
    ])
      assert.throws(() => normalisePage(bad), /limit|offset/);
  });
});

describe('Bot-Speicher über die API', () => {
  let store;
  let fremd;
  let panelScope;

  before(async () => {
    store = await startBot('speicher-eins');
    fremd = await startBot('speicher-zwei');
    const { panelToken } = await import('../server/panel.js');
    panelScope = panelToken(store.bot.id);
  });

  it('legt einen Wert an und liest ihn wieder', async () => {
    const write = await callWithToken(store.token)('/hub/db/notizen/zaehler', {
      method: 'PUT',
      body: { value: { anzahl: 3, tags: ['a'] } },
    });
    assert.equal(write.status, 200);
    assert.equal(write.data.entry.created, true);
    assert.equal(write.data.entry.key, 'zaehler');

    const read = await callWithToken(store.token)('/hub/db/notizen/zaehler');
    assert.equal(read.status, 200);
    assert.deepEqual(read.data.entry.value, { anzahl: 3, tags: ['a'] });
    assert.equal(read.data.entry.createdAt, write.data.entry.updatedAt);
  });

  it('überschreibt einen Wert, ohne ihn neu anzulegen', async () => {
    const first = await callWithToken(store.token)('/hub/db/notizen/zaehler', {
      method: 'PUT',
      body: { value: { anzahl: 4 } },
    });
    const second = await callWithToken(store.token)('/hub/db/notizen/zaehler', {
      method: 'PUT',
      body: { value: { anzahl: 5 } },
    });
    assert.equal(second.data.entry.created, false);
    assert.ok(second.data.entry.updatedAt >= first.data.entry.updatedAt);
    const read = await callWithToken(store.token)('/hub/db/notizen/zaehler');
    assert.deepEqual(read.data.entry.value, { anzahl: 5 });
  });

  it('hält einen Bot ausserhalb des Bereichs des anderen', async () => {
    await callWithToken(store.token)('/hub/db/notizen/geheim', {
      method: 'PUT',
      body: { value: { nur: 'fuer-eins' } },
    });
    const fremderLeser = await callWithToken(fremd.token)(
      '/hub/db/notizen/geheim',
    );
    assert.equal(fremderLeser.status, 404);

    // Auch mit dem Namen der Sammlung des anderen Bots: die Bot-ID kommt vom
    // Token, nicht aus dem Pfad.
    const fremdListe = await callWithToken(fremd.token)('/hub/db/notizen');
    assert.deepEqual(fremdListe.data.entries, []);
    assert.equal(fremdListe.data.total, 0);
  });

  it('listet mit Präfix, Grenze und Zähler', async () => {
    const bot = await startBot('speicher-liste');
    for (const key of ['a:1', 'a:2', 'a:10', 'b:1'])
      await callWithToken(bot.token)(`/hub/db/werte/${key}`, {
        method: 'PUT',
        body: { value: { key } },
      });

    const alle = await callWithToken(bot.token)('/hub/db/werte');
    assert.deepEqual(
      alle.data.entries.map((entry) => entry.key),
      ['a:1', 'a:10', 'a:2', 'b:1'],
    );
    assert.equal(alle.data.total, 4);
    assert.equal(alle.data.limit, 100);
    assert.equal(alle.data.offset, 0);

    const praefix = await callWithToken(bot.token)('/hub/db/werte?prefix=a%3A');
    assert.deepEqual(
      praefix.data.entries.map((entry) => entry.key),
      ['a:1', 'a:10', 'a:2'],
    );
    assert.equal(praefix.data.total, 3);

    const seite = await callWithToken(bot.token)(
      '/hub/db/werte?limit=2&offset=1',
    );
    assert.deepEqual(
      seite.data.entries.map((entry) => entry.key),
      ['a:10', 'a:2'],
    );
    assert.equal(seite.data.total, 4);
  });

  it('behandelt % und _ im Präfix als Zeichen', async () => {
    const bot = await startBot('speicher-prozent');
    for (const key of ['a_1', 'ab1'])
      await callWithToken(bot.token)(`/hub/db/sonder/${key}`, {
        method: 'PUT',
        body: { value: { key } },
      });
    // `_` ist in SQL ein Platzhalter für ein Zeichen: ohne Escaping liefe
    // `a_` auch für `ab1`.
    const unterstrich = await callWithToken(bot.token)(
      '/hub/db/sonder?prefix=a_',
    );
    assert.deepEqual(
      unterstrich.data.entries.map((entry) => entry.key),
      ['a_1'],
    );
    const beide = await callWithToken(bot.token)('/hub/db/sonder?prefix=a');
    assert.deepEqual(
      beide.data.entries.map((entry) => entry.key),
      ['a_1', 'ab1'],
    );
    // Ein Prozentzeichen ist ein gewöhnliches Zeichen, kein Platzhalter.
    const prozent = await callWithToken(bot.token)(
      `/hub/db/sonder?prefix=${encodeURIComponent('%')}`,
    );
    assert.deepEqual(prozent.data.entries, []);
  });

  it('löscht einen Wert und meldet fehlende', async () => {
    await callWithToken(store.token)('/hub/db/notizen/weg', {
      method: 'PUT',
      body: { value: { x: 1 } },
    });
    const entfernt = await callWithToken(store.token)('/hub/db/notizen/weg', {
      method: 'DELETE',
    });
    assert.equal(entfernt.data.removed, true);
    const nochmal = await callWithToken(store.token)('/hub/db/notizen/weg', {
      method: 'DELETE',
    });
    assert.equal(nochmal.data.removed, false);
    assert.equal(
      (await callWithToken(store.token)('/hub/db/notizen/weg')).status,
      404,
    );
  });

  it('verlangt ein Token', async () => {
    const ohne = await call('/hub/db');
    assert.equal(ohne.status, 401);
    const falsch = await callWithToken('nicht-im-hub')('/hub/db');
    assert.equal(falsch.status, 401);
  });

  it('lässt die Bot-Seite mit dem Panel-Token nicht heran', async () => {
    const page = await callWithToken(panelScope)('/hub/db');
    assert.equal(page.status, 403);
    const schreiben = await callWithToken(panelScope)(
      '/hub/db/notizen/zaehler',
      {
        method: 'PUT',
        body: { value: { anzahl: 99 } },
      },
    );
    assert.equal(schreiben.status, 403);
  });

  it('meldet dem Bot nur Treiber und Grenzen, keine Pfade', async () => {
    const antwort = await callWithToken(store.token)('/hub/db');
    assert.deepEqual(antwort.data.database, {
      driver: 'sqlite',
      ready: true,
      maxValueBytes: 65536,
      quotas: {
        entries: 10000,
        collections: 100,
        bytes: 104857600,
      },
    });
    const rohtext = JSON.stringify(antwort.data);
    assert.ok(!rohtext.includes(root));
    assert.ok(!rohtext.includes('.sqlite'));
  });

  it('lehnt ungültige Namen, Schlüssel und Werte ab', async () => {
    const bot = store;
    assert.equal(
      (await callWithToken(bot.token)('/hub/db/Mit%20Leer')).status,
      400,
    );
    assert.equal(
      (
        await callWithToken(bot.token)('/hub/db/werte/mit%20leer', {
          method: 'PUT',
          body: { value: 1 },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await callWithToken(bot.token)('/hub/db/werte/ok', {
          method: 'PUT',
          body: {},
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await callWithToken(bot.token)('/hub/db/werte/ok', {
          method: 'PUT',
          body: { value: 'a'.repeat(70 * 1024) },
        })
      ).status,
      413,
    );
    assert.equal(
      (await callWithToken(bot.token)('/hub/db/werte?limit=9999')).status,
      400,
    );
  });

  it('verbietet schreibende Methoden, die es nicht gibt', async () => {
    assert.equal(
      (
        await callWithToken(store.token)('/hub/db/werte', {
          method: 'POST',
          body: {},
        })
      ).status,
      405,
    );
    assert.equal(
      (
        await callWithToken(store.token)('/hub/db/werte/1', {
          method: 'POST',
          body: {},
        })
      ).status,
      405,
    );
    assert.equal(
      (await callWithToken(store.token)('/hub/db/a/b/c')).status,
      404,
    );
  });

  it('übersteht einen Wert, der wie ein Angriff aussieht', async () => {
    const boese = "'; DROP TABLE bot_store; --";
    const { status } = await callWithToken(store.token)(
      `/hub/db/tabellen/${encodeURIComponent(boese)}`,
      { method: 'PUT', body: { value: { boese } } },
    );
    assert.equal(status, 400);
    // Die Tabelle steht noch: derselbe Pfad funktioniert weiterhin.
    const danach = await callWithToken(store.token)('/hub/db/notizen/zaehler');
    assert.equal(danach.status, 200);
  });
});
