/**
 * Der verwaltete MySQL-Container gegen einen echten MySQL.
 *
 * `mysql.test.js` prüft die Entscheidungen mit Attrappen. Diese Datei prüft die
 * eine Aussage, die sich mit Attrappen nicht prüfen lässt: dass MySQL nach dem
 * Bootstrap `root@'%'` wirklich nicht mehr kennt, dass der Port wirklich nur auf
 * Loopback lauscht und dass ein Bot-Container wirklich nicht herankommt. Eine
 * SQL-Anweisung im Quelltext sagt nichts darüber, ob der Server sie befolgt.
 *
 * Ohne Docker wird die Datei übersprungen. Ein Test, der ohne Docker fehlschlägt,
 * würde nur sagen, dass Docker fehlt.
 *
 *   npm run test:mysql-container
 *
 * Aufgeräumt wird am Ende alles: Container, Netz und Datenverzeichnis. Der Test
 * braucht daher einen freien Port und einen Präfix, der nicht mit einem laufenden
 * Betrieb kollidiert – beides sucht er sich selbst.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';

const dockerOk =
  process.platform !== 'win32' &&
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
  }).status === 0;

const skip = dockerOk
  ? false
  : 'docker ist nicht verfügbar – der echte Container wird nicht gestartet';

/** Freier Port auf Loopback. Zwischen Messung und Bindung kann es knapp werden. */
const freePort = async () =>
  new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const docker = (args, { capture = false } = {}) =>
  new Promise((done, fail) => {
    const child = spawn('docker', args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
    }
    child.once('error', fail);
    child.once('exit', (code) => done({ code: code ?? -1, stdout, stderr }));
  });

let dir;
let port;
let prefix;
let config;
let adminPassword;
let appPassword;
let mysql;
let secrets;
let dbEnvFile;

/** Fragt eine IP-Adresse über einen Wegwerf-Container ab. */
const probe = async (args, script) => {
  const result = await docker(
    ['run', '--rm', ...args, 'alpine:3.20', 'sh', '-c', script],
    { capture: true },
  );
  return { code: result.code, out: result.stdout.trim() };
};

before(async () => {
  if (!dockerOk) return;
  mysql = await import('../server/mysql.js');
  secrets = await import('../server/secrets.js');

  // Eigener Präfix und eigener Port: der Test darf weder einen laufenden
  // Betrieb stören noch von ihm gestört werden.
  prefix = `bot-hub-test${process.pid.toString(36)}`;
  port = await freePort();
  dir = mkdtempSync(join(tmpdir(), 'bot-hub-mysql-echt-'));

  // Das Admin-Passwort steckt nur für einen Augenblick in der env-file. Hier
  // wird es abgefangen, damit der Test danach beweisen kann, dass es draussen
  // nichts mehr wert ist. Das ist der ganze Kern der Sache.
  let body = null;
  await mysql.provisionManagedMySql({
    env: {
      BOT_HUB_CONTAINER_PREFIX: prefix,
      BOT_HUB_DB_PORT: String(port),
      BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS: '300000',
    },
    projectRoot: dir,
    run: async (args, opts) => {
      if (args[0] === 'create') {
        const file = args[args.indexOf('--env-file') + 1];
        const { readFileSync } = await import('node:fs');
        try {
          body = readFileSync(file, 'utf8');
        } catch {
          body = null;
        }
      }
      return docker(args, opts);
    },
  });

  adminPassword = /MYSQL_ROOT_PASSWORD=(.*)/.exec(body ?? '')?.[1] ?? null;
  appPassword = secrets.readSecretValues(dir, 'db').BOT_HUB_DB_PASSWORD;
  dbEnvFile = join(dir, 'data', 'secrets', 'db.env');
  config = mysql.managedConfig({
    env: { BOT_HUB_CONTAINER_PREFIX: prefix, BOT_HUB_DB_PORT: String(port) },
    projectRoot: dir,
  });
});

after(async () => {
  if (!dockerOk || !dir) return;
  try {
    await docker(['rm', '--force', '-v', config.containerName]);
  } catch {
    /* Gab es keinen Container. */
  }
  try {
    await docker(['network', 'rm', config.networkName]);
  } catch {
    /* Gab es kein Netz. */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('Der verwaltete MySQL-Container in echt', () => {
  it('richtet die Datenbank beim ersten Start ein', { skip }, async () => {
    assert.ok(adminPassword, 'kein Admin-Passwort abgefangen');
    assert.ok(appPassword?.length >= 30, 'kein Arbeitspasswort');
    const connect = async (user, password, database) => {
      const client = await import('mysql2/promise');
      return client.createConnection({
        host: '127.0.0.1',
        port,
        user,
        password,
        database,
        connectTimeout: 5000,
      });
    };
    const client = await connect(
      appPassword && config.user,
      appPassword,
      config.database,
    );
    const [rows] = await client.query('SELECT CURRENT_USER() AS u');
    assert.equal(rows[0].u, `${config.user}@%`);
    await client.end();
  });

  it(
    'lässt root von aussen nicht mehr hinein – auch nicht mit dem richtigen Passwort',
    { skip },
    async () => {
      // Das ist die Zusicherung, für die es diese Datei gibt. Ein `DROP USER`
      // im Quelltext beweist nichts; dieser Versuch beweist es.
      assert.ok(adminPassword, 'kein Admin-Passwort abgefangen');
      const client = await import('mysql2/promise');
      await assert.rejects(
        () =>
          client.createConnection({
            host: '127.0.0.1',
            port,
            user: 'root',
            password: adminPassword,
            connectTimeout: 5000,
          }),
        (error) => {
          assert.equal(error.code, 'ER_ACCESS_DENIED_ERROR');
          return true;
        },
        'root kam von aussen hinein – die einmalige Rechtevergabe gilt nicht',
      );
    },
  );

  it(
    'lässt auch ein falsches root-Passwort nicht hinein',
    { skip },
    async () => {
      const client = await import('mysql2/promise');
      await assert.rejects(
        () =>
          client.createConnection({
            host: '127.0.0.1',
            port,
            user: 'root',
            password: mysql.generatePassword(),
            connectTimeout: 5000,
          }),
        (error) => error.code === 'ER_ACCESS_DENIED_ERROR',
      );
    },
  );

  it('hat root nur noch für localhost', { skip }, async () => {
    // Der einzige verbliebene root-Zugang ist von innen nutzbar – das ist
    // gewollt, weil jemand mit Docker-Zugriff ohnehin nichts mehr braucht.
    const result = await docker(
      [
        'exec',
        config.containerName,
        'mysql',
        '-uroot',
        `-p${adminPassword}`,
        '-N',
        '-e',
        'SELECT host FROM mysql.user WHERE user = "root"',
      ],
      { capture: true },
    );
    assert.equal(result.code, 0, result.stderr.trim());
    assert.deepEqual(
      result.stdout.trim().split('\n'),
      ['localhost'],
      'es gibt einen root-Zugang von ausserhalb',
    );
  });

  it(
    'gibt dem Arbeitsbenutzer keine Rechte ausserhalb der Hub-Datenbank',
    { skip },
    async () => {
      const client = await import('mysql2/promise');
      const connection = await client.createConnection({
        host: '127.0.0.1',
        port,
        user: config.user,
        password: appPassword,
        database: config.database,
      });
      const [rows] = await connection.query('SHOW GRANTS FOR CURRENT_USER()');
      const grants = rows.map((row) => Object.values(row)[0]);
      const ausserhalb = grants.filter(
        (grant) =>
          !grant.includes(`\`${config.database}\`.*`) &&
          // USAGE ON *.* ist keine Berechtigung, sondern der Platzhalter dafür,
          // dass der Benutzer sonst nichts hat. Sonst wäre genau das ein Fehler.
          !grant.includes('USAGE ON *.*'),
      );
      assert.deepEqual(ausserhalb, [], 'der Arbeitsbenutzer darf zu viel');
      assert.ok(
        !grants.some((grant) => grant.includes('GRANT OPTION')),
        'der Arbeitsbenutzer darf Rechte weitergeben',
      );

      // Und er darf wirklich nichts ausserhalb seiner Datenbank: eine eigene
      // Datenbank anlegen, das Systemverzeichnis lesen – beides muss scheitern.
      for (const [was, sql] of [
        ['eine fremde Datenbank anlegen', 'CREATE DATABASE hub_fremd'],
        ['das Systemverzeichnis lesen', 'SELECT user, host FROM mysql.user'],
      ])
        await assert.rejects(
          () => connection.query(sql),
          (error) => {
            // Je nachdem, ob der Zugriff an der Datenbank oder an der Zeile
            // scheitert, meldet MySQL einen anderen Code. Beide heissen
            // "nein", und nur darauf kommt es hier an.
            assert.ok(
              [
                'ER_DBACCESS_DENIED_ERROR',
                'ER_ACCESS_DENIED_ERROR',
                'ER_TABLEACCESS_DENIED_ERROR',
              ].includes(error.code),
              `unerwarteter Fehler bei "${was}": ${error.code}`,
            );
            return true;
          },
          `der Arbeitsbenutzer durfte ${was}`,
        );

      // Von den Datenbanken, die MySQL zeigt, sind `information_schema` und
      // `performance_schema` jedem Benutzer fest zugewiesen – die kann hier
      // nichts ändern. Entscheidend sind die beiden anderen: `mysql` enthält
      // die Benutzer- und Rechteverwaltung, und davon darf dieser Benutzer
      // nichts sehen.
      const [sichtbar] = await connection.query('SHOW DATABASES');
      const namen = sichtbar.map((row) => Object.values(row)[0]);
      assert.ok(namen.includes(config.database), 'die Hub-Datenbank fehlt');
      for (const system of ['mysql', 'sys'])
        assert.ok(
          !namen.includes(system),
          `der Arbeitsbenutzer sieht ${system}`,
        );

      await connection.end();
    },
  );

  it('lauscht nur auf Loopback', { skip }, async () => {
    const listen = spawnSync('ss', ['-ltnH', `sport = :${port}`], {
      encoding: 'utf8',
    });
    if (listen.status !== 0) return; // ss fehlt: die Erreichbarkeit prüfen die Tests weiter unten
    // `ss -ltnH` liefert "LISTEN <recv> <send> <lokal> <peer>". Die Spalte
    // wird gelesen statt mit einem Muster verglichen – ein Regex-Literal
    // interpoliert kein ${port}, und das hätte hier still falsch ausgesehen.
    const zeilen = listen.stdout
      .trim()
      .split('\n')
      .filter((zeile) => zeile.includes(`:${port}`));
    assert.ok(zeilen.length > 0, `kein Listener auf ${port} gefunden`);
    for (const zeile of zeilen) {
      const lokal = zeile.trim().split(/\s+/)[3];
      assert.equal(
        lokal,
        `127.0.0.1:${port}`,
        `der Port lauscht nicht nur auf Loopback: ${zeile.trim()}`,
      );
    }
  });

  it(
    'ist für einen Bot-Container auf der Default-Bridge nicht erreichbar',
    { skip },
    async () => {
      const inspected = await docker(
        [
          'inspect',
          '--format',
          '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
          config.containerName,
        ],
        { capture: true },
      );
      const ip = inspected.stdout.trim();
      assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(ip), `keine IP: ${ip}`);

      // Ein Bot-Container bekommt genau das: die Default-Bridge. Gibt es dann
      // keine Verbindung, ist der Netzweg wirklich zu.
      const ergebnis = await probe(
        [],
        `nc -z -w 4 ${ip} 3306 && echo ERREICHBAR || echo blockiert`,
      );
      assert.match(ergebnis.out, /blockiert/, 'ein Bot kommt an die Datenbank');
    },
  );

  it(
    'ist für einen Bot mit host.docker.internal nicht erreichbar',
    { skip },
    async () => {
      // Der Host-Weg ist genau der, den ein Bot mit BOT_HUB_CONTAINER_URL
      // bekommt. Weil der Port nur an 127.0.0.1 gebunden ist, führt auch dieser
      // Weg ins Leere.
      const ergebnis = await probe(
        ['--add-host', 'host.docker.internal:host-gateway'],
        'nc -z -w 4 host.docker.internal:' +
          port +
          ' && echo ERREICHBAR || echo blockiert',
      );
      assert.match(
        ergebnis.out,
        /blockiert/,
        'ein Bot kommt über den Host ran',
      );
    },
  );

  it(
    'hat das Admin-Passwort nach dem Einrichten nirgends mehr auf der Platte',
    { skip },
    async () => {
      const { existsSync, readFileSync } = await import('node:fs');
      assert.equal(
        existsSync(join(dir, 'data', 'secrets', 'mysql-init.env')),
        false,
        'mysql-init.env liegt noch da',
      );
      assert.equal(existsSync(dbEnvFile), true);
      const inhalt = readFileSync(dbEnvFile, 'utf8');
      assert.ok(
        !inhalt.includes(adminPassword),
        'das Admin-Passwort steht noch in db.env',
      );
    },
  );

  it('trägt das Arbeitspasswort mit 0600', { skip }, async () => {
    const { statSync } = await import('node:fs');
    assert.equal(statSync(dbEnvFile).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'data', 'secrets')).mode & 0o777, 0o700);
  });

  it(
    'läuft mit den Rechten des Hub-Benutzers, nicht als root',
    { skip },
    async () => {
      const ergebnis = await docker(
        ['exec', config.containerName, 'id', '-u'],
        { capture: true },
      );
      assert.equal(ergebnis.code, 0, ergebnis.stderr.trim());
      const uid = ergebnis.stdout.trim();
      assert.notEqual(uid, '0', 'MySQL läuft im Container als root');
    },
  );

  it(
    'trägt den Bot-Speicher über den Hub-Speicher, nicht über den Container',
    { skip },
    async () => {
      // Was ein Bot über die API schreibt, muss auch wieder herauskommen – und
      // für einen anderen Bot unsichtbar bleiben. Das ist die Grenze, um die es
      // hier eigentlich geht.
      const { createTestStore } = await import('../server/database.js');
      const store = createTestStore({
        driver: 'mysql',
        database: config.database,
        user: config.user,
        password: appPassword,
        host: '127.0.0.1',
        port,
        socket: '',
        connectionLimit: 4,
        maxValueBytes: 64 * 1024,
      });
      const a = `echt-a-${Date.now().toString(36)}`;
      const b = `echt-b-${Date.now().toString(36)}`;
      try {
        await store.set(a, 'probe', 'k', { unicode: 'äöü', n: 42 });
        assert.deepEqual((await store.get(a, 'probe', 'k')).value, {
          unicode: 'äöü',
          n: 42,
        });
        assert.equal(await store.get(b, 'probe', 'k'), null);
        const usage = await store.usage(a);
        assert.ok(usage.entries >= 1, 'die Zählung ist nicht mitgegangen');
        await store.remove(a, 'probe', 'k');
        assert.equal(await store.get(a, 'probe', 'k'), null);
      } finally {
        await store.close();
      }
    },
  );

  it('meldet beim zweiten Start, dass alles bereit ist', { skip }, async () => {
    const ergebnis = await mysql.provisionManagedMySql({
      env: {
        BOT_HUB_CONTAINER_PREFIX: prefix,
        BOT_HUB_DB_PORT: String(port),
        BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS: '300000',
      },
      projectRoot: dir,
    });
    assert.equal(ergebnis.status, 'bereit');
    // Und das Passwort ist dasselbe geblieben.
    assert.equal(
      secrets.readSecretValues(dir, 'db').BOT_HUB_DB_PASSWORD,
      appPassword,
      'beim zweiten Start wurde ein neues Passwort vergeben',
    );
  });
});
