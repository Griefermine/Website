/**
 * Der verwaltete MySQL-Container: `BOT_HUB_DB=mysql-container`.
 *
 * Zwei Ebenen, und beide sind nötig. Diese Datei prüft die Entscheidungen und
 * Reihenfolgen mit Attrappen für Docker und MySQL – schnell, ohne Container,
 * und deshalb bei jedem `npm test` dabei. `mysql-container.test.js` fährt
 * denselben Code gegen einen echten Container und ist die einzige Stelle, an
 * der sich wirklich prüfen lässt, dass MySQL `root@'%'` nach dem Bootstrap
 * auch tatsächlich nicht mehr kennt.
 *
 * Worum es hier geht, ist nicht "geht es", sondern wer nach dem Einrichten
 * noch hineinkommt. Der Admin-Zugang soll einmal gelten und dann weg sein – ein
 * Merkmal, das man nur prüfen kann, wenn man den Ablauf Schritt für Schritt
 * ansieht.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';

// Statisch und nicht per `before`-Hook: der Rumpf eines `describe` läuft beim
// Einsammeln der Tests, lange bevor irgendein Hook feuert. Ein `await import`
// im Hook hätte `mysql` dort also noch gar nicht gefüllt.
import * as database from '../server/database.js';
import * as mysql from '../server/mysql.js';

const MIN = 30;

/** Alle Argumente, die der Hub an Docker gegeben hat. */
const argsOf = (calls) => calls.map((args) => args.join(' ')).join('\n');

const ok = (stdout = '') => ({ code: 0, stdout: String(stdout), stderr: '' });
const fail = (stderr) => ({ code: 1, stdout: '', stderr });

/* ------------------------------------------------------------------ *
 * Attrappen
 * ------------------------------------------------------------------ */

/**
 * Ein Docker, das nur weiss, was ihm gesagt wird. `create` merkt sich, ob die
 * env-file zu diesem Zeitpunkt schon existierte – genau daran ist die
 * Reihenfolge im Provisionierer zu sehen.
 */
const fakeDocker = (initial = {}) => {
  const state = {
    network: initial.network ?? false,
    container: initial.container ?? false,
    running: initial.running ?? false,
    label: initial.label ?? '',
  };
  const calls = [];
  const seen = { envFileAtCreate: null };

  const run = async (args) => {
    calls.push(args);

    if (args[0] === 'network') {
      if (args[1] === 'inspect')
        return state.network ? ok('[]') : fail(`network not found`);
      if (args[1] === 'create') {
        state.network = true;
        return ok('netzwerkid');
      }
      if (args[1] === 'rm') {
        state.network = false;
        return ok();
      }
    }

    if (args[0] === 'container' && args[1] === 'inspect') {
      if (!state.container) return fail('No such container');
      const format = args.includes('--format')
        ? args[args.indexOf('--format') + 1]
        : null;
      if (format === '{{.State.Running}}') return ok(String(state.running));
      if (format) return ok(state.label);
      return ok('[]');
    }

    if (args[0] === 'create') {
      seen.envFileAtCreate = existsSync(args[args.indexOf('--env-file') + 1]);
      state.container = true;
      state.label = args[args.indexOf('--label') + 1].split('=')[1];
      return ok('containerid');
    }
    if (args[0] === 'start') {
      state.running = true;
      return ok();
    }
    if (args[0] === 'rm') {
      state.container = false;
      state.running = false;
      return ok();
    }
    return ok();
  };

  return { run, calls, state, seen };
};

/**
 * Ein MySQL, das Benutzer und Passwörter kennt und Anweisungen protokolliert.
 * `CREATE USER`/`ALTER USER` werden ausgeführt statt nur notiert – so merkt
 * sich das Attrappe, dass der Arbeitsbenutzer jetzt existiert, und der
 * anschliessende Verbindungsversuch kann erfolgreich sein.
 */
const fakeMySql = () => {
  const users = new Map();
  const statements = [];
  let refuseAll = false;

  const connect = async ({ user, password }) => {
    if (refuseAll || users.get(user) !== password) {
      const error = new Error(`Access denied for user '${user}'`);
      error.code = 'ER_ACCESS_DENIED_ERROR';
      throw error;
    }
    return {
      query: async (sql) => {
        statements.push({ user, sql });
        const leg =
          /^(?:CREATE|ALTER) USER '([^']+)'@'%' IDENTIFIED BY '([^']+)'/.exec(
            sql,
          );
        if (leg) users.set(leg[1], leg[2]);
        if (/^DROP USER IF EXISTS 'root'@'%'$/.test(sql)) users.delete('root');
        return [];
      },
      end: async () => {},
    };
  };

  return {
    connect,
    statements,
    users,
    /** Root kennt das Passwort, das der Hub in die env-file geschrieben hat. */
    learnRoot: (password) => users.set('root', password),
    refuse: (value = true) => {
      refuseAll = value;
    },
    has: (user) => users.has(user),
    sqlText: () => statements.map((item) => item.sql).join('\n'),
  };
};

/** Frisches Projektverzeichnis pro Test, damit nichts aus dem anderen lebt. */
const rootDirs = [];
const makeRoot = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-hub-mysql-'));
  rootDirs.push(dir);
  return dir;
};

const readDbSecret = (dir) => {
  const file = join(dir, 'data', 'secrets', 'db.env');
  if (!existsSync(file)) return {};
  const values = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
};

/** db.env so schreiben, wie `secrets.js` es tut. */
const writeDbSecret = (dir, values) => {
  mkdirSync(join(dir, 'data', 'secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'data', 'secrets', 'db.env'),
    `${Object.entries(values)
      .map(([key, value]) => `${key}="${value}"`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
};

/* ------------------------------------------------------------------ *
 * Passwörter
 * ------------------------------------------------------------------ */

describe('Erzeugte Passwörter', () => {
  it('hat mindestens 30 Zeichen und ist lang genug im Betrieb', () => {
    assert.equal(mysql.MIN_PASSWORD_LENGTH, 30);
    const generated = mysql.generatePassword();
    assert.ok(generated.length >= MIN, `nur ${generated.length} Zeichen`);
    // 48 statt genau 30: die Untergrenze ist eine Schranke gegen einen zu kurzen
    // Aufruf, nicht das Ziel. Wer 30 Zeichen verlangt hat, bekommt keine 30.
    assert.ok(generated.length >= 48, `nur ${generated.length} Zeichen`);
  });

  it('besteht nur aus Zeichen, die in SQL nichts zu escapen haben', () => {
    for (let i = 0; i < 200; i += 1)
      assert.match(mysql.generatePassword(), /^[A-Za-z0-9_-]+$/);
  });

  it('liefert bei 200 Ziehungen 200 verschiedene Passwörter', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(mysql.generatePassword());
    assert.equal(seen.size, 200);
  });

  it('nutzt das ganze Alphabet', () => {
    // Sonst wäre eine Verteilungsfrage im Code unentdeckt. Bei 200 Passwörtern
    // muss jedes der 64 Zeichen mindestens einmal vorkommen.
    const seen = new Set();
    for (let i = 0; i < 200; i += 1)
      for (const zeichen of mysql.generatePassword()) seen.add(zeichen);
    assert.equal(seen.size, 64);
  });

  it('lehnt kürzere Passwörter ab', () => {
    assert.throws(() => mysql.generatePassword(29), /mindestens 30/);
    assert.throws(() => mysql.generatePassword(0), /mindestens 30/);
    assert.throws(() => mysql.generatePassword('viel'), /mindestens 30/);
  });

  it('schreibt ein Passwort nur als solches in ein SQL-Literal', () => {
    const generated = mysql.generatePassword();
    assert.equal(mysql.passwordLiteral(generated), `'${generated}'`);
    // Genau das ist der Grund der Funktion: alles, was hier durchkäme, wäre in
    // einem CREATE USER keine Zeichenkette mehr, sondern eine Anweisung.
    for (const boese of [
      "abc'; DROP DATABASE bot_hub; --",
      "mit'Anfuehrungszeichen",
      'mit\\Backslash',
      'mit`Backtick',
      '',
    ])
      assert.throws(() => mysql.passwordLiteral(boese), /passwort/i);
  });

  it('lehnt auch ein korrekt escaped wirkendes Passwort kurz ab', () => {
    assert.throws(() => mysql.passwordLiteral('a'.repeat(29)), /mindestens 30/);
  });
});

/* ------------------------------------------------------------------ *
 * Container-Argumente
 * ------------------------------------------------------------------ */

describe('Der MySQL-Container', () => {
  const config = mysql.managedConfig({
    env: {},
    projectRoot: '/opt/bot-hub',
  });
  const args = mysql.containerCreateArgs(config, '/opt/bot-hub/secrets.env', {
    env: {},
  });
  const valueOf = (name) => args[args.indexOf(name) + 1];

  it('veröffentlicht nur auf Loopback', () => {
    assert.equal(valueOf('--publish'), '127.0.0.1:3307:3306');
    assert.ok(
      !argsOf([args]).includes('0.0.0.0'),
      'der Port darf nicht auf allen Interfaces liegen',
    );
  });

  it('hängt an einem eigenen Netz, nicht an der Default-Bridge', () => {
    assert.equal(valueOf('--network'), 'bot-hub-mysql-net');
    assert.notEqual(valueOf('--network'), 'bridge');
  });

  it('gibt dem Container keine erhöhten Rechte', () => {
    assert.ok(args.includes('--cap-drop'));
    assert.equal(valueOf('--cap-drop'), 'ALL');
    assert.ok(args.includes('--security-opt'));
    assert.equal(valueOf('--security-opt'), 'no-new-privileges:true');
    assert.ok(!args.includes('--privileged'));
    // `host` als Netzwerk würde den Container mit dem Host-Netz verbinden und
    // ihm damit jeden dort laufenden Dienst erreichbar machen.
    assert.notEqual(valueOf('--network'), 'host');
  });

  it('gibt dem Container keinen Weg zum Host', () => {
    // host.docker.internal erlaubt jedem Bot jeden Dienst auf diesem Rechner.
    // MySQL braucht den Hub nicht – der Weg dorthin wäre einer zu viel.
    assert.ok(!args.includes('--add-host'));
    assert.ok(!argsOf([args]).includes('host-gateway'));
    assert.ok(!argsOf([args]).includes('docker.sock'));
  });

  it('reicht das Admin-Passwort über eine Datei statt über die Argumentliste', () => {
    assert.equal(valueOf('--env-file'), '/opt/bot-hub/secrets.env');
    assert.ok(
      !args.includes('--env'),
      '--env NAME=WERT landet in `ps` und in `docker inspect`',
    );
  });

  it('legt das Datenvolumen ausserhalb jedes Bot-Workspaces ab', () => {
    assert.equal(valueOf('--volume'), '/opt/bot-hub/data/mysql:/var/lib/mysql');
    assert.ok(args.includes('--tmpfs'));
    assert.ok(args.includes('--init'));
  });
});

describe('Pfad und Namen des verwalteten MySQL', () => {
  it('lehnt ein Datenverzeichnis in bots/ ab', () => {
    const dir = makeRoot();
    mkdirSync(join(dir, 'bots'), { recursive: true });
    assert.throws(
      () =>
        mysql.managedConfig({
          env: { BOT_HUB_MYSQL_DATA: 'bots/bot1/mysql' },
          projectRoot: dir,
        }),
      /innerhalb von bots\//,
    );
  });

  it('folgt einem Symlink aus bots/ heraus – und erkennt ihn trotzdem', () => {
    const dir = makeRoot();
    mkdirSync(join(dir, 'bots'), { recursive: true });
    mkdirSync(join(dir, 'ausserhalb'), { recursive: true });
    symlinkSync(join(dir, 'ausserhalb'), join(dir, 'bots', 'link'), 'dir');
    // Ein Symlink, der aus bots/ hinauszeigt, ist unkritisch – die Prüfung
    // darf ihn nicht verbieten.
    assert.doesNotThrow(() =>
      mysql.managedConfig({ env: {}, projectRoot: dir }),
    );
    // Ein SymLink von aussen nach bots/ hinein ist es nicht.
    assert.throws(
      () =>
        mysql.managedConfig({
          env: { BOT_HUB_MYSQL_DATA: 'bots/link' },
          projectRoot: dir,
        }),
      /innerhalb von bots\//,
    );
  });

  it('lehnt Namen ab, die in SQL etwas anderes wären', () => {
    for (const boese of [
      'bot hub',
      "hub'; DROP DATABASE x; --",
      'hub`x',
      'hub%evil',
      'a'.repeat(33),
      'hub\nname',
    ]) {
      assert.throws(
        () =>
          mysql.managedConfig({
            env: { BOT_HUB_DB_NAME: boese, BOT_HUB_DB_USER: boese },
            projectRoot: makeRoot(),
          }),
        /Buchstaben, Ziffern und _/,
        `"${boese}" hätte durchgehen können`,
      );
    }
    // Eine führende Ziffer ist in Ordnung: der Datenbankname wird mit Backticks
    // umschlossen, der Benutzer steht als Zeichenkette in Anführungszeichen.
    // Beides macht MySQL zum richtigen Lesen verzeihlich.
    assert.doesNotThrow(() =>
      mysql.managedConfig({
        env: { BOT_HUB_DB_NAME: '1bot_hub', BOT_HUB_DB_USER: '1bot_hub' },
        projectRoot: makeRoot(),
      }),
    );
  });

  it('lehnt root als Arbeitsbenutzer ab', () => {
    for (const boese of ['root', 'ROOT', 'Root'])
      assert.throws(
        () =>
          mysql.managedConfig({
            env: { BOT_HUB_DB_USER: boese },
            projectRoot: makeRoot(),
          }),
        /root ist nicht erlaubt/,
      );
  });

  it('nimmt keinen Port unter 1024 – dort wohnt üblicherweise ein Dienst', () => {
    assert.throws(
      () =>
        mysql.managedConfig({
          env: { BOT_HUB_DB_PORT: '330' },
          projectRoot: makeRoot(),
        }),
      /zwischen 1024 und 65535/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Bootstrap-Anweisungen
 * ------------------------------------------------------------------ */

describe('Der einmalige Admin-Durchlauf', () => {
  const config = mysql.managedConfig({ env: {}, projectRoot: '/opt/hub' });
  const password = mysql.generatePassword();
  const statements = mysql.bootstrapStatements(config, password);
  const text = statements.join('\n');

  it('legt zuerst die Datenbank an, dann den Benutzer, dann die Rechte', () => {
    const reihenfolge = [
      'CREATE DATABASE',
      'CREATE USER',
      'GRANT',
      'DROP USER',
    ];
    let position = -1;
    for (const anfang of reihenfolge) {
      const at = text.indexOf(anfang);
      assert.ok(at > position, `${anfang} steht an der falschen Stelle`);
      position = at;
    }
  });

  it('nimmt dem Admin von aussen die Rechte – genau einmal', () => {
    const drops = statements.filter((sql) => /^DROP USER/.test(sql));
    assert.equal(drops.length, 1, 'es darf nur eine Anweisung root entfernen');
    assert.equal(drops[0], "DROP USER IF EXISTS 'root'@'%'");
    // `root@'localhost'` bleibt bewusst: nur jemand mit Zugriff auf den
    // Container kann sie benutzen, und wer den hat, braucht kein Passwort.
    assert.ok(!text.includes("root'@'localhost'"));
  });

  it('gibt dem Arbeitsbenutzer Rechte nur auf die Hub-Datenbank', () => {
    const grants = statements.filter((sql) => sql.startsWith('GRANT'));
    assert.equal(grants.length, 1);
    const grant = grants[0];
    assert.match(grant, /ON `bot_hub`\.\*/);
    // Kein GRANT OPTION, kein `*.*`, kein FILE, kein SUPER: der Arbeitsbenutzer
    // verwaltet seinen eigenen Bereich und sonst nichts.
    assert.ok(!grant.includes('GRANT OPTION'));
    assert.ok(!grant.includes('*.*'));
    for (const gefahr of ['SUPER', 'FILE', 'PROCESS', 'RELOAD', 'SHUTDOWN'])
      assert.ok(
        !grant.includes(gefahr),
        `${gefahr} gehört nicht in die Rechte`,
      );
  });

  it('gewährt genau die Rechte, die der Treiber zum Arbeiten braucht', () => {
    const grant = statements.find((sql) => sql.startsWith('GRANT'));
    for (const recht of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      // Der Treiber legt seine Tabellen beim ersten Verbinden selbst an.
      'CREATE',
      'ALTER',
      'INDEX',
      'DROP',
    ])
      assert.ok(grant.includes(recht), `${recht} fehlt in den Rechten`);
  });

  it('setzt das Passwort per CREATE und per ALTER', () => {
    // Nur CREATE USER IF NOT EXISTS ließe ein altes Passwort stehen – dann
    // käme der Hub nach einem halben Bootstrap nie wieder hinein.
    assert.ok(
      statements.some((sql) =>
        sql.startsWith(`CREATE USER IF NOT EXISTS 'bot_hub'@'%'`),
      ),
    );
    assert.ok(
      statements.some((sql) => sql.startsWith(`ALTER USER 'bot_hub'@'%'`)),
    );
  });

  it('trägt das Passwort in CREATE und ALTER dasselbe ein', () => {
    const create = statements.find((sql) => sql.startsWith('CREATE USER'));
    const alter = statements.find((sql) => sql.startsWith('ALTER USER'));
    assert.ok(create.includes(`'${password}'`));
    assert.ok(alter.includes(`'${password}'`));
  });

  it('rührt keine Tabelle der Hub-Datenbank direkt an', () => {
    // Der Treiber legt die Tabellen an. Ein Bootstrap, der sie auch schon
    // anlegen würde, wäre eine zweite Wahrheit über das Schema.
    for (const sql of statements)
      assert.ok(
        !/^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(sql),
        `unerwartete Anweisung: ${sql}`,
      );
  });
});

/* ------------------------------------------------------------------ *
 * Zustandsautomat
 * ------------------------------------------------------------------ */

describe('Das Einrichten', () => {
  /**
   * Provisionierer mit Attrappen. `onCreateEnvFile` bekommt den Inhalt der
   * env-file im Moment von `docker create` – also genau dann, wenn die Datei
   * da sein muss. Alles, was der Hub daraus lernt, lernt er hier so, wie es im
   * Betrieb auch geschehen würde: nicht durch einen eingebauten Testhaken,
   * sondern weil die Datei an der Stelle eben existiert.
   */
  const setup = ({
    dir = makeRoot(),
    env = {},
    docker = fakeDocker(),
  } = {}) => {
    const my = fakeMySql();
    const seen = {
      envFileAtCreate: null,
      bodyAtCreate: null,
      mode: null,
      dirMode: null,
    };
    const provisioner = mysql.createProvisioner({
      env,
      projectRoot: dir,
      run: async (args, opts) => {
        if (args[0] === 'create') {
          const file = args[args.indexOf('--env-file') + 1];
          seen.envFileAtCreate = existsSync(file);
          if (seen.envFileAtCreate) {
            seen.bodyAtCreate = readFileSync(file, 'utf8');
            seen.mode = statSync(file).mode & 0o777;
            seen.dirMode = statSync(join(dir, 'data', 'secrets')).mode & 0o777;
            my.learnRoot(/MYSQL_ROOT_PASSWORD=(.*)/.exec(seen.bodyAtCreate)[1]);
          }
        }
        return docker.run(args, opts);
      },
      connect: my.connect,
      wait: async () => {},
    });
    return {
      dir,
      docker,
      my,
      env,
      provisioner,
      seen,
      envFileAtCreate: () => seen.envFileAtCreate,
      envFileBodyAtCreate: () => seen.bodyAtCreate,
      /** Das Admin-Passwort, so wie der Betrieb es nur während des Create kennt. */
      adminPassword: () =>
        /MYSQL_ROOT_PASSWORD=(.*)/.exec(seen.bodyAtCreate ?? '')[1],
    };
  };

  const adminFile = (dir) => join(dir, 'data', 'secrets', 'mysql-init.env');

  it('legt beim ersten Start Netz, Container und Zugangsdaten an', async () => {
    const { dir, docker, my, provisioner, envFileAtCreate } = await setup();
    const ergebnis = await provisioner.provision();

    assert.equal(ergebnis.status, 'eingerichtet');
    assert.ok(docker.state.network, 'das Netz fehlt');
    assert.ok(docker.state.container, 'der Container fehlt');
    assert.ok(docker.calls.some((a) => a[0] === 'create'));
    assert.ok(docker.calls.some((a) => a[0] === 'start'));

    // `docker create --env-file` scheitert an einer fehlenden Datei. Die Datei
    // muss also vor dem Create geschrieben sein – nicht danach.
    assert.equal(
      envFileAtCreate(),
      true,
      'die env-file fehlte beim docker create',
    );

    // Admin von aussen weg, Arbeitsbenutzer da.
    assert.equal(my.has('root'), false, 'root@% hätte weiterleben dürfen');
    assert.equal(my.has('bot_hub'), true);
    assert.equal(readDbSecret(dir).BOT_HUB_DB_BOOTSTRAPPED, '1');
    assert.ok(readDbSecret(dir).BOT_HUB_DB_PASSWORD.length >= MIN);
  });

  it('löscht das Admin-Passwort von der Platte, sobald der Durchlauf fertig ist', async () => {
    const { dir, provisioner } = await setup();
    await provisioner.provision();
    assert.equal(
      existsSync(adminFile(dir)),
      false,
      'das Admin-Passwort liegt noch auf der Platte',
    );
  });

  it('schreibt die env-file mit 0600 in ein Verzeichnis mit 0700', async () => {
    const { dir, provisioner, seen } = await setup();
    await provisioner.provision();
    // Wer den Docker-Socket bedienen darf, liest ohnehin alles. Wer schon im
    // Projektverzeichnis steht, darf aber nicht auch noch das Passwort lesen –
    // dafür die Rechte, und zwar an beiden Stellen.
    assert.equal(seen.mode, 0o600, 'mysql-init.env war nicht 0600');
    assert.equal(seen.dirMode, 0o700, 'data/secrets/ war nicht 0700');
    assert.ok(existsSync(dir));
  });

  it('gibt Admin- und Arbeitspasswort nie an Docker weiter', async () => {
    const { dir, docker, provisioner, adminPassword } = await setup();
    await provisioner.provision();

    const alles = argsOf(docker.calls);
    const secrets = readDbSecret(dir);
    assert.ok(secrets.BOT_HUB_DB_PASSWORD);
    assert.ok(
      !alles.includes(secrets.BOT_HUB_DB_PASSWORD),
      'das Arbeitspasswort steht in einem Docker-Argument',
    );
    assert.ok(
      !/MYSQL_ROOT_PASSWORD=\S/.test(alles),
      'ein Passwort steht als --env in der Argumentliste',
    );
    // Und das Admin-Passwort selbst steht nirgends in den Argumenten.
    assert.ok(
      !alles.includes(adminPassword()),
      'das Admin-Passwort steht in einem Docker-Argument',
    );
  });

  it('setzt Admin- und Arbeitspasswort ungleich', async () => {
    const { my, provisioner, adminPassword } = await setup();
    await provisioner.provision();
    const arbeits = my.users.get('bot_hub');
    assert.ok(arbeits);
    assert.ok(arbeits.length >= MIN);
    assert.notEqual(
      adminPassword(),
      arbeits,
      'beide Zugänge teilen sich ein Passwort',
    );
  });

  it('beim zweiten Start nichts mehr einrichten und nichts mehr anlegen', async () => {
    const { dir } = await setup();
    const erster = setup({ dir });
    await erster.provisioner.provision();

    const secrets = readDbSecret(dir);
    // Zustand des ersten Laufs in ein frisches Verzeichnis übernehmen.
    const zweiter = setup();
    writeDbSecret(zweiter.dir, secrets);
    zweiter.my.learnRoot('gibt-es-nicht-mehr');
    zweiter.my.users.set('bot_hub', secrets.BOT_HUB_DB_PASSWORD);
    // Container und Netz existieren schon.
    zweiter.docker.state.network = true;
    zweiter.docker.state.container = true;
    zweiter.docker.state.running = true;

    const ergebnis = await zweiter.provisioner.provision();
    assert.equal(ergebnis.status, 'bereit');
    assert.ok(
      !zweiter.docker.calls.some((a) => a[0] === 'create'),
      'der Container wurde ein zweites Mal erstellt',
    );
    assert.equal(
      zweiter.my.statements.length,
      0,
      'es gab Anweisungen an MySQL, obwohl alles bereit war',
    );
    assert.equal(
      existsSync(adminFile(zweiter.dir)),
      false,
      'im Normalfall wird nicht einmal eine env-file geschrieben',
    );
  });

  it('sagt deutlich, dass ein zweiter Admin-Durchlauf nicht möglich ist', async () => {
    const { dir } = await setup();
    const erster = setup({ dir });
    await erster.provisioner.provision();
    writeDbSecret(dir, readDbSecret(dir));

    // Container läuft, aber das Passwort passt nicht mehr – von aussen geändert
    // oder die Datei beschädigt. Genau hier wäre ein stiller zweiter Bootstrap
    // die schlechte Antwort.
    const zweiter = mysql.createProvisioner({
      env: {},
      projectRoot: dir,
      run: fakeDocker({ network: true, container: true, running: true }).run,
      connect: async () => {
        const error = new Error('Access denied');
        error.code = 'ER_ACCESS_DENIED_ERROR';
        throw error;
      },
      wait: async () => {},
    });

    await assert.rejects(
      () => zweiter.provision(),
      (error) => {
        assert.match(error.message, /BOT_HUB_MYSQL_RESET=1/);
        assert.match(error.message, /nicht wiederholen/i);
        assert.match(error.message, /Daten verloren/);
        // Und ganz wichtig: kein Passwort im Text.
        assert.ok(
          !error.message.includes(readDbSecret(dir).BOT_HUB_DB_PASSWORD),
          'die Fehlermeldung enthält das Passwort',
        );
        return true;
      },
    );
  });

  it('verwirft mit BOT_HUB_MYSQL_RESET=1 Container, Netz und Daten', async () => {
    const { dir } = await setup();
    const erster = setup({ dir });
    await erster.provisioner.provision();
    const vorher = readDbSecret(dir).BOT_HUB_DB_PASSWORD;

    const zweiter = setup({ dir, env: { BOT_HUB_MYSQL_RESET: '1' } });
    zweiter.docker.state.network = true;
    zweiter.docker.state.container = true;
    zweiter.docker.state.running = true;

    const ergebnis = await zweiter.provisioner.provision();
    assert.equal(ergebnis.status, 'eingerichtet');
    assert.ok(
      zweiter.docker.calls.some((a) => a[0] === 'rm'),
      'der alte Container wurde nicht entfernt',
    );
    assert.ok(
      zweiter.docker.calls.some((a) => a[0] === 'network' && a[1] === 'rm'),
      'das alte Netz blieb',
    );
    assert.notEqual(
      readDbSecret(dir).BOT_HUB_DB_PASSWORD,
      vorher,
      'nach einem Reset muss ein neues Passwort gelten',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Konfiguration
 * ------------------------------------------------------------------ */

describe('BOT_HUB_DB=mysql-container in der Konfiguration', () => {
  const env = (extra = {}) => ({ BOT_HUB_DB: 'mysql-container', ...extra });

  it('nutzt denselben MySQL-Treiber mit Standardwerten', () => {
    const config = database.resolveDatabaseConfig({
      env: env(),
      projectRoot: makeRoot(),
    });
    assert.equal(config.driver, 'mysql');
    assert.equal(config.database, 'bot_hub');
    assert.equal(config.user, 'bot_hub');
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3307);
  });

  it('lässt weder Adresse noch Socket noch Passwort zu', () => {
    // Wer eine dieser drei setzt, rechnet mit einer Adresse oder einem
    // Passwort, das es hier nicht gibt. Schweigen wäre schlimmer als die
    // Ablehnung.
    for (const key of [
      'BOT_HUB_DB_HOST',
      'BOT_HUB_DB_SOCKET',
      'BOT_HUB_DB_PASSWORD',
    ])
      assert.throws(
        () =>
          database.resolveDatabaseConfig({
            env: env({ [key]: 'irgendwas' }),
            projectRoot: makeRoot(),
          }),
        new RegExp(`${key} ist bei BOT_HUB_DB=mysql-container nicht erlaubt`),
        `${key} hätte durchgehen können`,
      );
  });

  it('liest das erzeugte Passwort aus data/secrets/db.env', () => {
    const dir = makeRoot();
    mkdirSync(join(dir, 'data', 'secrets'), { recursive: true });
    writeFileSync(
      join(dir, 'data', 'secrets', 'db.env'),
      'BOT_HUB_DB_PASSWORD="ausDerSecretDatei"\n',
      { mode: 0o600 },
    );
    const config = database.resolveDatabaseConfig({
      env: env(),
      projectRoot: dir,
    });
    assert.equal(config.password, 'ausDerSecretDatei');
  });

  it('lässt ein eigenes MySQL unangetastet', () => {
    const config = database.resolveDatabaseConfig({
      env: {
        BOT_HUB_DB: 'mysql',
        BOT_HUB_DB_HOST: '127.0.0.1',
        BOT_HUB_DB_PORT: '13306',
        BOT_HUB_DB_NAME: 'fremd',
        BOT_HUB_DB_USER: 'fremd',
        BOT_HUB_DB_PASSWORD: 'gegeben',
        BOT_HUB_DB_SOCKET: '',
      },
      projectRoot: makeRoot(),
    });
    assert.equal(config.driver, 'mysql');
    assert.equal(config.port, 13306);
    assert.equal(config.password, 'gegeben');
  });
});

after(() => {
  for (const dir of rootDirs) rmSync(dir, { recursive: true, force: true });
});
