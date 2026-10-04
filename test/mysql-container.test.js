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

  it(
    'hat einen Healthcheck, der ohne Passwort auskommt',
    { skip },
    async () => {
      // Nach dem Bootstrap gibt es `root` von aussen nicht mehr. Ein Healthcheck
      // mit Zugangsdaten wäre also nur noch mit dem entsorgten Admin-Passwort zu
      // erfüllen. `mysqladmin ping` antwortet dagegen auch dann, wenn der Zugang
      // abgewiesen wird, und misst damit genau das Richtige: nimmt mysqld
      // Verbindungen an?
      const cmd = await docker(
        [
          'inspect',
          '--format',
          '{{index .Config.Healthcheck.Test}}',
          config.containerName,
        ],
        { capture: true },
      );
      assert.equal(cmd.code, 0, cmd.stderr.trim());
      assert.match(cmd.stdout, /mysqladmin ping/);
      assert.ok(
        !/MYSQL_ROOT_PASSWORD|-p\S/.test(cmd.stdout),
        'der Healthcheck trägt ein Passwort in den Container',
      );
    },
  );

  it(
    'meldet MySQL als bereit, obwohl der Adminzugang weg ist',
    { skip },
    async () => {
      const ping = await docker(
        [
          'exec',
          config.containerName,
          'sh',
          '-c',
          'mysqladmin ping -h 127.0.0.1 --silent',
        ],
        { capture: true },
      );
      assert.equal(ping.code, 0, 'mysqladmin ping schlägt fehl');
      const health = await docker(
        [
          'inspect',
          '--format',
          '{{.State.Health.Status}}',
          config.containerName,
        ],
        { capture: true },
      );
      assert.equal(health.stdout.trim(), 'healthy');
    },
  );

  it(
    'überlebt einen Neustart mit seinen Daten und seinem Passwort',
    { skip },
    async () => {
      // Die Anleitung nennt den Neustart ausdrücklich: Daten, Benutzer und Schema
      // bleiben erhalten, und es entsteht kein neues Passwort.
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
      const bot = `neustart-${Date.now().toString(36)}`;
      await store.set(bot, 'probe', 'vorher', 'wert');
      await store.close();

      await docker(['restart', config.containerName]);
      const gesund = async () => {
        const h = await docker(
          [
            'inspect',
            '--format',
            '{{.State.Health.Status}}',
            config.containerName,
          ],
          { capture: true },
        );
        return h.stdout.trim() === 'healthy';
      };
      const ende = Date.now() + 180_000;
      while (Date.now() < ende && !(await gesund()))
        await new Promise((done) => setTimeout(done, 1000));
      assert.ok(await gesund(), 'MySQL wurde nach dem Neustart nicht gesund');

      const wieder = createTestStore({
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
      try {
        assert.equal(
          (await wieder.get(bot, 'probe', 'vorher')).value,
          'wert',
          'die Daten sind nach dem Neustart nicht mehr da',
        );
      } finally {
        await wieder.close();
      }
      assert.equal(
        secrets.readSecretValues(dir, 'db').BOT_HUB_DB_PASSWORD,
        appPassword,
        'der Neustart hat das Passwort ersetzt',
      );
    },
  );
});

/* ------------------------------------------------------------------ *
 * phpMyAdmin gegen den echten Container
 * ------------------------------------------------------------------ */

/**
 * Eine eigene, frische Installation.
 *
 * Bewusst nicht die des ersten Blocks: dort ist MySQL bereits eingerichtet,
 * und phpMyAdmin lässt sich danach nicht mehr zuschalten – der
 * Verwaltungsbenutzer entsteht nur im ersten Durchlauf. Genau das ist eine
 * Zusicherung wert, aber es darf den eigentlichen Test nicht verhindern. Also
 * bekommt phpMyAdmin hier seinen eigenen Präfix, seinen eigenen Port und sein
 * eigenes Verzeichnis: das ist zugleich der erste Start aus der Anleitung, in
 * dem MySQL und die Oberfläche zusammen hochkommen.
 */
describe('Die Verwaltungsoberfläche in echt', () => {
  let wurzel;
  let praefix;
  /** Host-Port von MySQL – der Hub, ein Hostprozess, spricht darüber an. */
  let dbPort;
  /** Host-Port von phpMyAdmin. Ein eigener: Docker lässt an einen Port nur
   *  eine Bindung zu, beide zusammen gäbe es einenstillen Konflikt. */
  let port;
  let anlage;
  let adminPasswort;
  let hubPasswort;
  let verwaltungsPasswort;

  const umgebung = () => ({
    BOT_HUB_CONTAINER_PREFIX: praefix,
    BOT_HUB_DB_PORT: String(dbPort),
    BOT_HUB_PHPMYADMIN: '1',
    BOT_HUB_PHPMYADMIN_PORT: String(port),
    BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS: '300000',
  });

  const box = () => anlage.phpmyadmin.containerName;

  before(async () => {
    if (!dockerOk) return;
    praefix = `bot-hub-testpma${process.pid.toString(36)}`;
    dbPort = await freePort();
    port = await freePort();
    wurzel = mkdtempSync(join(tmpdir(), 'bot-hub-pma-echt-'));

    // Das Admin-Passwort steckt nur für einen Augenblick in der env-file. Hier
    // wird es abgefangen, damit der Test danach beweisen kann, dass es als
    // Passwort nicht mehr gilt – auch nicht bei phpMyAdmin.
    let body = null;
    const ergebnis = await mysql.provisionManagedMySql({
      env: umgebung(),
      projectRoot: wurzel,
      run: async (args, opts) => {
        if (args[0] === 'create' && args.includes('--env-file')) {
          const { readFileSync } = await import('node:fs');
          try {
            body = readFileSync(args[args.indexOf('--env-file') + 1], 'utf8');
          } catch {
            body = null;
          }
        }
        return docker(args, opts);
      },
    });
    assert.equal(
      ergebnis.status,
      'eingerichtet',
      `phpMyAdmin liess sich nicht einrichten: ${ergebnis.beschreibung}`,
    );
    anlage = mysql.managedConfig({ env: umgebung(), projectRoot: wurzel });
    adminPasswort = /MYSQL_ROOT_PASSWORD=(.*)/.exec(body ?? '')?.[1] ?? null;
    verwaltungsPasswort = secrets.readSecretValues(
      wurzel,
      'phpmyadmin',
    ).BOT_HUB_ADMIN_DB_PASSWORD;
    hubPasswort = secrets.readSecretValues(wurzel, 'db').BOT_HUB_DB_PASSWORD;
  });

  after(async () => {
    if (!dockerOk || !anlage) return;
    // Die Container zuerst, das Netz danach: Docker weigert sich sonst, ein
    // Netz mit hängenden Containern zu löschen, und die Aufräumreste blieben.
    await docker(['rm', '--force', '-v', box()]);
    await docker(['rm', '--force', '-v', anlage.containerName]);
    await docker(['network', 'rm', anlage.networkName]);
    rmSync(wurzel, { recursive: true, force: true });
  });

  /** Eine Seite holen – nach einem Login mit den Cookies der vorigen Antwort. */
  const seite = async (pfad = '/', { post, jar } = {}) => {
    const { request } = await import('node:http');
    // `set-cookie` sieht aus wie `phpMyAdmin=…; path=/; HttpOnly`. In den
    // Cookie-Header gehört davon nur das Paar vor dem ersten Semikolon; der Rest
    // sind Antwort-Daten und keine Cookies. phpMyAdmin sendet denselben Namen
    // zudem mehrfach, und am Ende gilt der letzte Wert – wie im Browser. Ohne
    // diese beiden Regeln wird aus jeder Antwort ein falscher Schlüssel, die
    // Sitzung wird abgewiesen, und der Test sucht den Fehler in der Datenbank.
    const paare = new Map();
    if (jar)
      for (const zeile of jar) {
        const paar = zeile.split(';', 1)[0].trim();
        const gleich = paar.indexOf('=');
        if (gleich > 0)
          paare.set(paar.slice(0, gleich), paar.slice(gleich + 1));
      }
    const cookies = [...paare].map(([name, wert]) => `${name}=${wert}`);
    const body = post ? new URLSearchParams(post).toString() : null;
    return new Promise((done, fail) => {
      const anfrage = request(
        {
          host: '127.0.0.1',
          port,
          path: pfad,
          method: post ? 'POST' : 'GET',
          headers: {
            ...(body
              ? {
                  'content-type': 'application/x-www-form-urlencoded',
                  'content-length': Buffer.byteLength(body),
                }
              : {}),
            ...(cookies.length ? { cookie: cookies.join('; ') } : {}),
          },
          timeout: 10_000,
        },
        (res) => {
          let inhalt = '';
          res.on('data', (d) => (inhalt += d));
          res.on('end', () =>
            done({
              status: res.statusCode,
              body: inhalt,
              setCookie: res.headers['set-cookie'] ?? [],
            }),
          );
        },
      );
      anfrage.on('timeout', () =>
        anfrage.destroy(new Error('Zeitüberschreitung')),
      );
      anfrage.on('error', fail);
      if (body) anfrage.write(body);
      anfrage.end();
    });
  };

  /** Anmelden wie ein Mensch: Token holen, Formular abschicken, Cookie behalten. */
  const anmelden = async (benutzer, passwort) => {
    const formular = await seite('/');
    const token = /name="token" value="([^"]+)"/.exec(formular.body)?.[1];
    assert.ok(token, 'das Anmeldeformular hat kein Token');
    const login = await seite('/index.php', {
      post: {
        pma_username: benutzer,
        pma_password: passwort,
        server: '1',
        token,
      },
      jar: formular.setCookie,
    });
    return seite('/index.php', {
      jar: [...formular.setCookie, ...login.setCookie],
    });
  };

  const inspect = async (was, format) =>
    docker(['inspect', '--format', format, was], { capture: true });

  it('kommt beim ersten Start zusammen mit MySQL hoch', { skip }, async () => {
    for (const name of [box(), anlage.containerName]) {
      const laeuft = await inspect(name, '{{.State.Running}}');
      assert.equal(laeuft.stdout.trim(), 'true', `${name} läuft nicht`);
    }
    assert.ok(verwaltungsPasswort?.length >= 30, 'kein Verwaltungspasswort');
  });

  it('läuft als nicht-root und bekommt nichts vom Host', { skip }, async () => {
    const id = await docker(['exec', box(), 'id', '-u'], { capture: true });
    assert.equal(id.code, 0, id.stderr.trim());
    assert.notEqual(
      id.stdout.trim(),
      '0',
      'phpMyAdmin läuft als root – das Image startet sonst so',
    );

    // Kein Volume, kein Bind-Mount, kein docker.sock: die Oberfläche hat
    // keinen Pfad, über den sie Daten herausholen könnte.
    const mounts = await inspect(
      box(),
      '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}',
    );
    assert.equal(mounts.stdout.trim(), '', `es gibt Mounts: ${mounts.stdout}`);
  });

  it('ist nur über Loopback erreichbar', { skip }, async () => {
    const bind = await docker(['port', box()], { capture: true });
    assert.equal(
      bind.stdout.trim(),
      `80/tcp -> 127.0.0.1:${port}`,
      'die Bindung ist nicht die erwartete',
    );
    assert.ok(
      !/0\.0\.0\.0/.test(bind.stdout),
      '0.0.0.0 würde sie ins Netz stellen',
    );
  });

  it('kommt von einem Bot-Container nicht heran', { skip }, async () => {
    // Ein Bot auf der Default-Bridge erreicht weder die Datenbank noch die
    // Oberfläche: für beide gibt es von dort keine Route.
    for (const ziel of [`${box()} 80`, `${anlage.containerName} 3306`]) {
      const ergebnis = await probe(
        ['--network', 'bridge'],
        `nc -z -w 3 ${ziel} && echo OFFEN || echo ZU`,
      );
      assert.equal(ergebnis.out, 'ZU', `ein Bot kam bei ${ziel} herein`);
    }
  });

  it(
    'lässt einen Bot auch nicht über host.docker.internal hinein',
    { skip },
    async () => {
      const mitHost = await probe(
        [
          '--network',
          'bridge',
          '--add-host',
          'host.docker.internal:host-gateway',
        ],
        `nc -z -w 3 host.docker.internal ${port} && echo OFFEN || echo ZU`,
      );
      assert.equal(mitHost.out, 'ZU');
    },
  );

  it('bietet im Formular keine Serverauswahl an', { skip }, async () => {
    // Ohne PMA_ARBITRARY=0 dürfte die Oberfläche über die Adresse im Formular
    // jeden Server ansteuern, den ihr Container sieht – nicht nur MySQL.
    const formular = await seite('/');
    assert.equal(formular.status, 200);
    assert.ok(
      !formular.body.includes('name="pma_servername"'),
      'das Formular bietet eine Serverauswahl an',
    );
  });

  it('lässt sich mit dem Verwaltungsbenutzer anmelden', { skip }, async () => {
    const antwort = await anmelden(anlage.adminUser, verwaltungsPasswort);
    assert.equal(antwort.status, 200);
    assert.ok(
      antwort.body.includes('route=/logout'),
      'die Anmeldung hat nicht geklappt',
    );
    assert.ok(
      antwort.body.includes(anlage.database),
      `${anlage.database} ist nach der Anmeldung nicht zu sehen`,
    );
  });

  it(
    'lässt root nicht hinein – auch nicht mit dem richtigen Passwort',
    { skip },
    async () => {
      // Das Admin-Passwort aus dem einmaligen Durchlauf gilt noch – als
      // Passwort. Der Weg in die Oberfläche darf daraus keinen Weg in die
      // Datenbank machen.
      assert.ok(adminPasswort, 'kein Admin-Passwort abgefangen');
      const antwort = await anmelden('root', adminPasswort);
      assert.ok(
        !antwort.body.includes('route=/logout'),
        'root kam über phpMyAdmin hinein – der Adminzugang gilt noch',
      );
    },
  );

  it('gibt kein Passwort im HTML aus', { skip }, async () => {
    // Das HTML wird im Browser zwischengespeichert, in Lesezeichen
    // mitgenommen und in Support-Screenshots weitergereicht. Ein Passwort
    // darin ist ein Passwort in fremden Händen.
    const angemeldet = await anmelden(anlage.adminUser, verwaltungsPasswort);
    const formular = await seite('/');
    for (const blatt of [angemeldet, formular]) {
      for (const geheimnis of [
        verwaltungsPasswort,
        hubPasswort,
        adminPasswort,
      ]) {
        if (!geheimnis) continue;
        assert.ok(
          !blatt.body.includes(geheimnis),
          'ein Passwort steht im ausgelieferten HTML',
        );
      }
    }
  });

  it('trägt kein PMA_USER und kein PMA_PASSWORD', { skip }, async () => {
    // Fest eingetragen läge das Passwort in der Container-Umgebung – und die
    // steht für jeden mit Docker-Zugriff in `docker inspect`.
    const umgeb = await inspect(
      box(),
      '{{range .Config.Env}}{{println .}}{{end}}',
    );
    assert.ok(!/PMA_USER/.test(umgeb.stdout), 'PMA_USER ist gesetzt');
    assert.ok(!/PMA_PASSWORD/.test(umgeb.stdout), 'PMA_PASSWORD ist gesetzt');
    assert.match(umgeb.stdout, /PMA_ARBITRARY=0/);
    assert.match(umgeb.stdout, new RegExp(`PMA_HOST=${anlage.containerName}`));
  });

  it('sieht weder andere Datenbanken noch mysql.user', { skip }, async () => {
    const client = await import('mysql2/promise');
    const verbindung = await client.createConnection({
      host: '127.0.0.1',
      port: dbPort,
      user: anlage.adminUser,
      password: verwaltungsPasswort,
      connectTimeout: 5000,
    });
    try {
      await assert.rejects(
        () => verbindung.query('CREATE DATABASE hub_test'),
        (error) =>
          error.code === 'ER_DBACCESS_DENIED_ERROR' ||
          error.code === 'ER_ACCESS_DENIED_ERROR',
        'der Verwaltungsbenutzer darf eine Datenbank anlegen',
      );
      await assert.rejects(
        () => verbindung.query('SELECT user, host FROM mysql.user'),
        (error) =>
          error.code === 'ER_TABLEACCESS_DENIED_ERROR' ||
          error.code === 'ER_DBACCESS_DENIED_ERROR',
        'der Verwaltungsbenutzer darf in mysql.user nachsehen',
      );
      const [rechte] = await verbindung.query('SHOW GRANTS FOR CURRENT_USER()');
      const text = rechte.map((r) => Object.values(r).join(' ')).join('\n');
      assert.ok(!text.includes('GRANT OPTION'), 'er darf Rechte weitergeben');
      assert.match(text, new RegExp(`ON \`${anlage.database}\`\\.\\*`));
      // MySQL gibt jedem Benutzer `GRANT USAGE ON *.*` – das ist keine
      // Berechtigung, sondern nur der Hinweis, dass es keine globalen gibt.
      // Erst eine Zeile mit echten Rechten auf `*.*` wäre ein Fund.
      for (const zeile of text.split('\n')) {
        const globale =
          /^(GRANT|USAGE)\b/.test(zeile) && / ON \*\.\*/.test(zeile);
        assert.ok(
          !globale || /^GRANT USAGE ON \*\.\* /.test(zeile),
          `er hat Rechte über seine Datenbank hinaus: ${zeile}`,
        );
      }
    } finally {
      await verbindung.end();
    }
  });

  it(
    'hat ein eigenes Passwort, getrennt vom Passwort des Hubs',
    { skip },
    async () => {
      const secret = secrets.readSecretValues(wurzel, 'phpmyadmin');
      assert.equal(secret.BOT_HUB_ADMIN_DB_USER, anlage.adminUser);
      assert.notEqual(
        secret.BOT_HUB_ADMIN_DB_PASSWORD,
        hubPasswort,
        'die Oberfläche benutzt dasselbe Passwort wie der Hub',
      );
      // Getrennte Datei, gleiche Rechte: 0600 in einem 0700-Verzeichnis.
      const { statSync } = await import('node:fs');
      assert.equal(
        statSync(join(wurzel, 'data', 'secrets', 'phpmyadmin.env')).mode &
          0o777,
        0o600,
      );
      assert.equal(
        statSync(join(wurzel, 'data', 'secrets')).mode & 0o777,
        0o700,
      );
    },
  );

  it('meldet beim zweiten Start, dass alles bereit ist', { skip }, async () => {
    const ergebnis = await mysql.provisionManagedMySql({
      env: umgebung(),
      projectRoot: wurzel,
    });
    assert.equal(ergebnis.status, 'bereit');
    assert.ok(ergebnis.phpmyadmin, 'der Hinweis auf die Oberfläche fehlt');
    assert.ok(
      !ergebnis.phpmyadmin.includes(verwaltungsPasswort),
      'der Hinweis nennt das Passwort',
    );
    assert.equal(
      secrets.readSecretValues(wurzel, 'phpmyadmin').BOT_HUB_ADMIN_DB_PASSWORD,
      verwaltungsPasswort,
      'beim zweiten Start wurde ein neues Verwaltungspasswort vergeben',
    );
  });
});
