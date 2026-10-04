/**
 * Eigener MySQL-Container für den Bot-Speicher – `BOT_HUB_DB=mysql-container`.
 *
 * Der Unterschied zu `BOT_HUB_DB=mysql`: dort richtet der Betreiber MySQL selbst
 * ein, hier legt der Hub seinen Container an, erzeugt das Passwort, erstellt
 * die Datenbank und den Arbeitsbenutzer und räumt danach auf. Bots kommen über
 * die Hub-API an ihre Daten, an den Container selbst niemand – sie sehen weder
 * den Container noch sein Dateisystem.
 *
 * Drei Entscheidungen bestimmen den Aufbau:
 *
 * 1. **Admin nur einmal.** Der MySQL-Container startet mit einem zufälligen
 *    `root`-Passwort. Der Hub legt damit Datenbank und Arbeitsbenutzer an und
 *    löscht danach `root@'%'`. Übrig bleibt `root@'localhost'`, erreichbar nur
 *    über `docker exec` im Container – also von niemandem, der nicht schon den
 *    Docker-Socket hat. Das Admin-Passwort wird danach aus `data/secrets/`
 *    gelöscht und ist nirgends sonst gespeichert. Der Arbeitsbenutzer darf an
 *    seiner eigenen Datenbank DDL machen, neue Tabellen brauchen also keinen
 *    Admin. Eine neue *Datenbank* oder ein neuer *Benutzer* dagegen schon –
 *    dafür gibt es `BOT_HUB_MYSQL_RESET=1`, das das Datenvolumen verwirft und
 *    neu aufsetzt.
 *
 * 2. **Nur Loopback.** Veröffentlicht wird `127.0.0.1:<Port>:3306`, nie
 *    `0.0.0.0`. Ein Bot, der `host.docker.internal` hat, erreicht damit höchstens
 *    die Portnummer – und dann ein 48-stelliges Zufallspasswort. Zusätzlich
 *    hängt der MySQL-Container an einem eigenen Netz, an dem kein Bot hängt:
 *    Bot-Container laufen auf der Default-Bridge und haben dorthin keine Route.
 *
 * 3. **Kein Geheimnis in der Argumentliste.** Das Admin-Passwort steht in
 *    `data/secrets/mysql-init.env` (0600 in einem 0700-Verzeichnis) und wird
 *    über `--env-file` gereicht, nicht über `--env NAME=WERT`. Damit steht es
 *    nicht in `ps`, nicht im Hub-Kommando und in keiner Fehlermeldung.
 *
 * Optional kommt phpMyAdmin dazu (`BOT_HUB_PHPMYADMIN=1`), siehe
 * {@link phpmyadminCreateArgs}. Das ist eine reine Verwaltungsoberfläche: sie
 * bekommt einen *eigenen* Datenbankbenutzer, damit das Passwort des Arbeits-
 * benutzers nie in ein Formular getippt werden muss und die Oberfläche ohne
 * Auswirkung auf den Hub-Betrieb abgeschaltet werden kann. Rechte bekommt
 * dieser Benutzer dieselben wie der Arbeitsbenutzer und auch nur auf
 * `bot_hub` – getrennt sind die Zugangsdaten, nicht die Befugnisse. Wer mehr
 * bräuchte, bekäme mehr MySQL als der Hub selbst.
 *
 * Die Passwörter kommen aus `crypto.randomBytes` mit Verwerfungsstichprobe und
 * bestehen nur aus `[A-Za-z0-9_-]`. Das ist Absicht, nicht Sparmaßigkeit: damit
 * kann ein Passwort nachweislich nichts enthalten, was in einem SQL-Literal
 * eine Rolle spielt – siehe `passwordLiteral`. Es sind 48 Zeichen aus einem
 * Alphabet von 64, also 288 Bit; die geforderten 30 Zeichen sind nichts gegen
 * diese Länge, die Untergrenze ist eine Form von Selbstschutz gegen einen
 * unabsichtlich zu kurzen Aufruf.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  managedNames,
  projectRootOf,
  realPathDeepest,
  staysInside,
} from './database.js';
import { readSecretValues, storeSecretValues } from './secrets.js';

/** Untergrenze für jedes erzeugte Passwort. */
export const MIN_PASSWORD_LENGTH = 30;
const PASSWORD_LENGTH = 48;
const PASSWORD_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Zeichen, die in einem einfachen SQL-Literal nichts zu escapen haben. */
const PASSWORD_SHAPE = /^[A-Za-z0-9_-]+$/;

const DEFAULT_IMAGE = 'mysql:8.4';
const CONTAINER_PORT = 3306;
const BOOTSTRAP_TIMEOUT_MS = 180_000;
const BOOTSTRAP_POLL_MS = 1000;

/**
 * Standardbild von phpMyAdmin, fester Versionsstand statt `latest`.
 *
 * Das Image wird mit `PMA_ARBITRARY=0`, ohne `PMA_USER` und ohne
 * `PMA_PASSWORD` betrieben; wer es einsetzt, gibt nichts ein außer den
 * Benutzernamen, die es ohnehin schon gibt.
 */
const DEFAULT_PHPMYADMIN_IMAGE = 'phpmyadmin/phpmyadmin:5.2.3';
const DEFAULT_PHPMYADMIN_PORT = 8081;
/** Port, auf dem Apache im Image wirklich lauscht – nicht `PMA_PORT`. */
const PHPMYADMIN_PORT = 80;
/**
 * `www-data` im Image.
 *
 * Fest, weil das Image fest ist: hier läuft uid 33. Wichtig ist, dass es
 * überhaupt ein uid ungleich 0 ist – das Image startet sonst als root. Dass
 * ein uid 33 trotzdem Port 80 belegen darf, liegt am Debian-Grundsystem, das
 * `net.ipv4.ip_unprivileged_port_start=0` setzt; das ist eine Eigenschaft
 * des Images, keine unserer Rechte, und ändert sich nur mit dem Image.
 */
const PHPMYADMIN_UID = 33;
const DEFAULT_ADMIN_USER = 'bot_hub_admin';

const truthy = (value) =>
  ['1', 'true', 'ja', 'yes'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

/**
 * Zufälliges Passwort, mindestens {@link MIN_PASSWORD_LENGTH} Zeichen.
 *
 * `randomBytes` wird als Parameter übergeben, damit der Test eine bestimmte
 * Folge erzwingen kann. Ohne Parameter kommt `crypto.randomBytes`.
 */
export const generatePassword = (
  length = PASSWORD_LENGTH,
  randomBytes = nodeRandomBytes,
) => {
  const wanted = Number(length);
  if (!Number.isInteger(wanted) || wanted < MIN_PASSWORD_LENGTH)
    throw new Error(
      `Ein Datenbankpasswort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen (angefordert: ${length}).`,
    );
  const out = [];
  // Das Alphabet hat 64 Zeichen, und 256 % 64 ist 0 – `byte % 64` streut also
  // bereits exakt gleich. Die Verwerfung hier ist kein Fix für einen
  // vorhandenen Bias, sondern eine Schranke: ändert jemand das Alphabet auf
  // z.B. 62 oder 66 Zeichen, stimmt die Verteilung ohne diese Zeile nicht
  // mehr, und ein unauffällig zu schwaches Passwort ist genau die Sorte Fehler,
  // die niemand bemerkt.
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  while (out.length < wanted) {
    // Etwas Überhang, weil einige Bytes verworfen werden.
    const batch = randomBytes(Math.ceil((wanted - out.length) * 1.5) + 8);
    for (const byte of batch) {
      if (byte >= limit) continue;
      out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
      if (out.length === wanted) break;
    }
  }
  return out.join('');
};

/**
 * Ein Passwort als SQL-Literal – oder ein Fehler.
 *
 * Diese Funktion ist der Grund, warum die Bootstrap-Anweisungen unten
 * überhaupt Platzhalter weglassen dürfen: MySQL erlaubt in `CREATE USER` und
 * `ALTER USER` keine Prepared-Statement-Platzhalter, also bleibt nur
 * Zusammensetzen. Geprüft wird deshalb, dass das Passwort aus genau den
 * Zeichen besteht, die in `'…'` nichts zu escapen haben. Ein Wert, der hier
 * durchkäme, aber die Prüfung umginge, wäre kein Passwort mehr, sondern eine
 * Anweisung – deshalb wirft die Funktion statt zu reparieren.
 */
export const passwordLiteral = (password) => {
  const text = String(password ?? '');
  if (text.length < MIN_PASSWORD_LENGTH)
    throw new Error(
      `Ein Datenbankpasswort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`,
    );
  if (!PASSWORD_SHAPE.test(text))
    throw new Error(
      'Ein Datenbankpasswort darf nur aus Buchstaben, Ziffern, `-` und `_` bestehen.',
    );
  return `'${text}'`;
};

const number = (value, fallback, { min, max, name }) => {
  if (value === undefined || value === null || String(value).trim() === '')
    return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(
      `${name} muss eine ganze Zahl zwischen ${min} und ${max} sein.`,
    );
  return parsed;
};

/**
 * Wo der verwaltete MySQL-Container liegt und wie er heisst.
 *
 * Kein `BOT_HUB_DB_HOST` und kein `BOT_HUB_DB_SOCKET`: beides würde die
 * Loopback-Zusage aufheben. Der Host ist hier fest 127.0.0.1, und wer eine
 * andere Adresse braucht, hat `BOT_HUB_DB=mysql` vor sich.
 */
export const managedConfig = ({ env = process.env, projectRoot } = {}) => {
  const root = projectRoot ?? projectRootOf(env);
  const prefix =
    String(env.BOT_HUB_CONTAINER_PREFIX ?? 'bot-hub')
      .replace(/[^A-Za-z0-9_.-]/g, '')
      .slice(0, 32) || 'bot-hub';
  const dataDir = resolve(
    root,
    String(env.BOT_HUB_MYSQL_DATA ?? 'data/mysql').trim() || 'data/mysql',
  );

  // Dieselbe Schranke wie bei der SQLite-Datei: das Datenverzeichnis darf
  // nicht im Startordner eines Bots liegen. Bei Containern ist das ohnehin
  // unmöglich, mit `BOT_HUB_CONTAINER_MODE=disabled` aber nicht – dann liefe
  // ein Bot als derselbe Benutzer und könnte die Dateien direkt lesen.
  const botsRoot = resolve(root, 'bots');
  if (
    staysInside(botsRoot, dataDir) ||
    staysInside(realPathDeepest(botsRoot), realPathDeepest(dataDir))
  )
    throw new Error(
      'BOT_HUB_MYSQL_DATA darf nicht innerhalb von bots/ liegen – ein Bot könnte die Datenbankdateien direkt lesen.',
    );

  const names = managedNames(env);
  const image = String(env.BOT_HUB_MYSQL_IMAGE ?? '').trim() || DEFAULT_IMAGE;

  // Der Verwaltungsbenutzer für phpMyAdmin. Dieselbe Schranke wie bei
  // `managedNames`, und `root` ist auch hier verboten – die Oberfläche soll
  // nicht die Möglichkeit bekommen, sich als der Benutzer anzumelden, den der
  // Bootstrap-Durchlauf benutzt hat.
  const adminUser =
    String(env.BOT_HUB_MYSQL_ADMIN_USER ?? '').trim() || DEFAULT_ADMIN_USER;
  if (!/^[A-Za-z0-9_]{1,32}$/.test(adminUser))
    throw new Error(
      'BOT_HUB_MYSQL_ADMIN_USER darf nur aus Buchstaben, Ziffern und _ bestehen und höchstens 32 Zeichen lang sein.',
    );
  if (adminUser.toLowerCase() === 'root')
    throw new Error(
      'BOT_HUB_MYSQL_ADMIN_USER=root ist nicht erlaubt. phpMyAdmin arbeitet mit einem eigenen Benutzer.',
    );

  // phpMyAdmin ist Zusatz, nicht Bestandteil. Ohne `BOT_HUB_PHPMYADMIN=1`
  // entsteht kein Container, kein Verwaltungsbenutzer und damit auch kein
  // zweites Datenbankpasswort – eine An installation, die die Oberfläche
  // nicht braucht, trägt kein zusätzliches Geheimnis mit sich herum.
  const phpmyadmin = {
    enabled: truthy(env.BOT_HUB_PHPMYADMIN),
    containerName: `${prefix}-phpmyadmin`,
    image:
      String(env.BOT_HUB_PHPMYADMIN_IMAGE ?? '').trim() ||
      DEFAULT_PHPMYADMIN_IMAGE,
    port: number(env.BOT_HUB_PHPMYADMIN_PORT, DEFAULT_PHPMYADMIN_PORT, {
      min: 1024,
      max: 65535,
      name: 'BOT_HUB_PHPMYADMIN_PORT',
    }),
  };

  return {
    projectRoot: root,
    containerName: `${prefix}-mysql`,
    networkName: `${prefix}-mysql-net`,
    image,
    dataDir,
    database: names.database,
    user: names.user,
    adminUser,
    port: names.port,
    host: '127.0.0.1',
    phpmyadmin,
  };
};

/**
 * Läuft der verwaltete Container in diesem Hub überhaupt?
 *
 * Ohne diesen Wert wird kein MySQL gezogen, kein Netz angelegt und kein
 * Verwaltungsbenutzer erzeugt. Wer nur SQLite oder ein eigenes MySQL fährt,
 * darf deshalb nicht an einem MySQL- oder phpMyAdmin-Image hängen – weder an
 * einem Digest noch an einem Versionsfehler in einer Konfiguration, die gar
 * nicht benutzt wird.
 */
export const managedMySqlActive = ({ env = process.env } = {}) =>
  String(env.BOT_HUB_DB ?? '')
    .trim()
    .toLowerCase() === 'mysql-container';

/** Verzeichnis der Geheimnisse – identisch zu dem von `secrets.js`. */
const secretsDirectory = (projectRoot) => join(projectRoot, 'data', 'secrets');
const initEnvFile = (projectRoot) =>
  join(secretsDirectory(projectRoot), 'mysql-init.env');

const containerUser = () => {
  const uid = Number.isInteger(process.getuid?.()) ? process.getuid() : 1000;
  const gid = Number.isInteger(process.getgid?.()) ? process.getgid() : 1000;
  return `${uid}:${gid}`;
};

/**
 * Alles, was sich am Container nicht nachträglich ändern lässt, landet im
 * Label. Weicht es vom vorhandenen Container ab, wird dieser ersetzt – das
 * Datenvolumen bleibt, nur die Konfiguration ist neu.
 *
 * Bewusst *nicht* darin: Memory- und CPU-Grenze. Beide lassen sich mit
 * `docker update` am laufenden Container ändern, und der Hub tut das nicht nur
 * beim nächsten Start. Liegen sie im Label, würde jedes Umstellen einer Grenze
 * den Container ersetzen und MySQL damit kurz aus dem Dienst nehmen – für eine
 * Einstellung, die keinen Neustart bräuchte.
 */
const containerSignature = (config, envFile) =>
  createHash('sha256')
    .update(
      [
        containerUser(),
        config.image,
        config.dataDir,
        config.networkName,
        config.port,
        envFile,
      ].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 16);

export const containerCreateArgs = (
  config,
  envFile,
  { env = process.env } = {},
) => [
  'create',
  '--name',
  config.containerName,
  '--user',
  containerUser(),
  '--init',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--pids-limit',
  '512',
  '--memory',
  String(env.BOT_HUB_MYSQL_MEMORY ?? '1g').trim() || '1g',
  '--cpus',
  String(env.BOT_HUB_MYSQL_CPUS ?? '2').trim() || '2',
  '--restart',
  'unless-stopped',
  // Eigenes Netz. Bot-Container hängen an der Default-Bridge und haben dorthin
  // keine Route – sie erreichen MySQL auch dann nicht, wenn sie
  // `host.docker.internal` haben. Bewusst kein `--add-host`: MySQL braucht den
  // Hub nicht, und jeder Weg in den Container hinein ist einer zu viel.
  '--network',
  config.networkName,
  // Nur Loopback. `0.0.0.0` würde die Datenbank ins Netz stellen.
  '--publish',
  `127.0.0.1:${config.port}:${CONTAINER_PORT}`,
  // mysqld legt Socket und Pidfile unter /var/run/mysqld ab. Als beliebige
  // uid kann der Prozess in der Container-Ebene dort nichts anlegen, deshalb
  // ein tmpfs statt eines weiteren Host-Verzeichnisses.
  '--tmpfs',
  '/var/run/mysqld:rw,mode=1777',
  '--volume',
  `${config.dataDir}:/var/lib/mysql`,
  '--env-file',
  envFile,
  // Bereitschaft, nicht nur "gestartet". Der Befehl nennt bewusst keinen
  // Benutzer und kein Passwort: `mysqladmin ping` antwortet mit "mysqld is
  // alive", sobald der Server Verbindungen annimmt, und das auch dann noch,
  // wenn der Zugang abgewiesen wird – also bleibt der Healthcheck gerade
  // *nach* dem `DROP USER root@'%'` aussagekräftig, wo es gar kein
  // Passwort mehr gibt, mit dem man sich anmelden könnte.
  '--health-cmd',
  'mysqladmin ping -h 127.0.0.1 --silent',
  '--health-interval',
  '10s',
  '--health-timeout',
  '5s',
  '--health-retries',
  '12',
  // Der allererste Start initialisiert erst den Datenspeicher und dauert
  // dadurch länger; ohne diesen Zeitraum ginge der Container währenddessen
  // auf "unhealthy".
  '--health-start-period',
  '60s',
  '--label',
  `bot-hub.config=${containerSignature(config, envFile)}`,
  config.image,
];

/**
 * Alles, was sich am phpMyAdmin-Container nicht nachträglich ändern lässt.
 * Wie beim MySQL-Container kein Gedächtnis für Grenzen von Memory und CPU –
 * `docker update` kann die ändern, und ein Ersetzen des Containers wäre für
 * eine Einstellung unnötiger Ausfall.
 */
const phpmyadminSignature = (config) =>
  createHash('sha256')
    .update(
      [
        PHPMYADMIN_UID,
        config.containerName,
        config.phpmyadmin.image,
        config.networkName,
        config.phpmyadmin.port,
      ].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 16);

/**
 * Der phpMyAdmin-Container.
 *
 * Vier Dinge sind hier die eigentliche Sicherheit, der Rest ist Kosmetik:
 *
 * - **Kein Volume, kein Bind-Mount.** Die Oberfläche bekommt nichts vom Host
 *   und nichts von den Bots. Es gibt hier keinen Pfad, über den sie Daten
 *   herausholen könnte – nicht einmal den, den ein Bot von außen benutzt.
 * - **Nur Loopback.** `127.0.0.1:<Port>:80`, nie `0.0.0.0`. phpMyAdmin ohne
 *   vorgeschaltete Authentifizierung und ohne Rate-Limit gehört nicht ins
 *   Internet; für alles andere gibt es einen SSH-Tunnel.
 * - **`PMA_ARBITRARY=0`.** Ohne das darf phpMyAdmin über die Adresse im
 *   Formular jeden beliebigen Datenbankserver ansteuern, den der Hub-Container
 *   sieht – nicht nur MySQL.
 * - **Kein `PMA_USER`/`PMA_PASSWORD`.** Wer die Werte fest einträgt, legt das
 *   Passwort in die Container-Umgebung, und die steht für jeden mit
 *   Docker-Zugriff in `docker inspect`. Ohne sie meldet sich jeder selbst an.
 *
 * `PMA_PORT=3306` beschreibt den *Datenbank*port, nicht den Port, auf dem
 * Apache lauscht – das ist der häufigste Irrtum bei diesem Image: die Variable
 * ändert nichts an `ports.conf`. Gepublished wird deshalb auf Port 80.
 */
export const phpmyadminCreateArgs = (config, { env = process.env } = {}) => [
  'create',
  '--name',
  config.phpmyadmin.containerName,
  '--user',
  `${PHPMYADMIN_UID}:${PHPMYADMIN_UID}`,
  '--init',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--pids-limit',
  '100',
  '--memory',
  String(env.BOT_HUB_PHPMYADMIN_MEMORY ?? '512m').trim() || '512m',
  '--cpus',
  String(env.BOT_HUB_PHPMYADMIN_CPUS ?? '1').trim() || '1',
  '--restart',
  'unless-stopped',
  // Dasselbe Netz wie MySQL, damit die Oberfläche den Datenbankserver unter
  // seinem Namen erreicht. Bot-Container hängen an der Default-Bridge und
  // haben dorthin keine Route – für sie ist phpMyAdmin genauso unerreichbar
  // wie die Datenbank selbst.
  '--network',
  config.networkName,
  '--publish',
  `127.0.0.1:${config.phpmyadmin.port}:${PHPMYADMIN_PORT}`,
  '--env',
  `PMA_HOST=${config.containerName}`,
  '--env',
  `PMA_PORT=${CONTAINER_PORT}`,
  '--env',
  'PMA_ARBITRARY=0',
  '--label',
  `bot-hub.config=${phpmyadminSignature(config)}`,
  config.phpmyadmin.image,
];

/**
 * Die Anweisungen des einmaligen Admin-Durchlaufs.
 *
 * Sichtbar als Liste und nicht als fester SQL-Text, damit ein Test jeden
 * Schritt einzeln prüfen kann: es muss genau eine Anweisung geben, die
 * `root` wegräumt, und kein Benutzer darf danach etwas besitzen, was über
 * seine eigene Datenbank hinausgeht.
 *
 * Der Verwaltungsbenutzer für phpMyAdmin entsteht nur, wenn `adminPassword`
 * mitkommt. Ohne die Oberfläche soll es kein zweites Datenbankpasswort
 * geben, und für den Fall, dass `adminUser` dem Arbeitsbenutzer entspricht,
 * wird er ausgelassen – zwei Benutzer mit demselben Namen und
 * unterschiedlichen Passwörtern wären eine Endlosschleife aus ALTER USER.
 */
export const bootstrapStatements = (
  config,
  { appPassword, adminPassword } = {},
) => {
  const name = passwordLiteral(appPassword);
  const user = `'${config.user}'@'%'`;
  const wantsAdmin =
    typeof adminPassword === 'string' &&
    adminPassword.length > 0 &&
    config.adminUser !== config.user;
  const admin = wantsAdmin
    ? {
        user: `'${config.adminUser}'@'%'`,
        name: passwordLiteral(adminPassword),
      }
    : null;
  // Derselbe Katalog für beide: SELECT für Ansehen, die übrigen für die
  // Reparatur. Kein GRANT OPTION, kein Zugriff auf andere Datenbanken, kein
  // FILE, kein SUPER – beide verwalten nur ihren eigenen Bereich.
  const rights =
    'SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES';
  return [
    // Die Datenbank legt der Admin an – deshalb steht hier kein MYSQL_DATABASE
    // im env-file. Sichtbarer Code ist hier besser als ein Nebeneffekt des
    // Image-Entrypoints.
    `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    // Beide: CREATE legt den Benutzer an, ALTER setzt ein Passwort, das
    // eventuell schon existiert. Ein bloßes CREATE USER IF NOT EXISTS ließe
    // ein altes Passwort stehen und der Hub käme nicht mehr hinein.
    `CREATE USER IF NOT EXISTS ${user} IDENTIFIED BY ${name}`,
    `ALTER USER ${user} IDENTIFIED BY ${name}`,
    // DDL ist nötig, weil der Treiber beim ersten Verbinden seine Tabellen
    // anlegt; ALTER/INDEX/DROP decken spätere Schemaänderungen ab.
    `GRANT ${rights} ON \`${config.database}\`.* TO ${user}`,
    ...(admin
      ? [
          `CREATE USER IF NOT EXISTS ${admin.user} IDENTIFIED BY ${admin.name}`,
          `ALTER USER ${admin.user} IDENTIFIED BY ${admin.name}`,
          `GRANT ${rights} ON \`${config.database}\`.* TO ${admin.user}`,
        ]
      : []),
    // Das ist der Punkt des Ganzen: danach kann sich von außen niemand mehr als
    // root anmelden. `root@'localhost'` bleibt, weil nur jemand mit Zugriff auf
    // den Container (docker exec) sie benutzen kann – und wer den hat, braucht
    // kein Passwort.
    `DROP USER IF EXISTS 'root'@'%'`,
    'FLUSH PRIVILEGES',
  ];
};

// `done` statt `resolve`: in dieser Datei ist `resolve` `node:path.resolve`.
// Ein Promise-Auflöser, der denselben Namen trägt, ruft stillschweigend den
// Pfad-Resolver auf – mit einem Objekt als erstem Argument sieht das nach
// einem kaputten Pfad aus, nicht nach einem benannten Fehler.
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const dockerRun = (args, { capture = false } = {}) =>
  new Promise((done, fail) => {
    const child = spawn(
      process.env.BOT_HUB_CONTAINER_RUNTIME || 'docker',
      args,
      { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' },
    );
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
    }
    child.once('error', fail);
    child.once('exit', (code) => done({ code: code ?? -1, stdout, stderr }));
  });

const loadMysql = async () => {
  try {
    return await import('mysql2/promise');
  } catch {
    throw new Error(
      'BOT_HUB_DB=mysql-container braucht das Paket mysql2 - installiere es mit "npm install mysql2".',
    );
  }
};

/**
 * Eine einzelne Verbindung statt eines Pools: der Bootstrap läuft einmal und
 * braucht weder Wiederherstellung noch Nebenläufigkeit.
 */
const connectMysql = async ({ host, port, user, password, database }) => {
  const mysql = await loadMysql();
  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    connectTimeout: 5000,
    multipleStatements: false,
    charset: 'utf8mb4',
  });
  return {
    query: (sql) => connection.query(sql),
    end: () => connection.end(),
  };
};

/**
 * Verwaltet Container und Zugangsdaten. Alles, was mit Docker und MySQL zu tun
 * hat, ist ein Parameter – `run`, `connect`, `sleep` und `randomBytes`. Der Test
 * übergibt Attrappen und sieht damit jeden Schritt, ohne dass ein Container
 * starten muss.
 */
export const createProvisioner = (deps = {}) => {
  const {
    env = process.env,
    projectRoot,
    run = dockerRun,
    connect = connectMysql,
    wait = sleep,
    randomBytes = nodeRandomBytes,
  } = deps;

  const config = managedConfig({ env, projectRoot });
  const envFile = initEnvFile(config.projectRoot);

  const inspect = async (what, name, format) => {
    const args = [
      what,
      'inspect',
      ...(format ? ['--format', format] : []),
      name,
    ];
    const result = await run(args, { capture: true });
    return {
      present: result.code === 0,
      value: result.code === 0 ? result.stdout.trim() : '',
      error: result.stderr.trim(),
    };
  };

  /**
   * Beide Hilfen geben einen echten Boolean zurück. Das ist hier keine
   * Geschmacksfrage: ein Objekt `{ present: false }` ist truthy, und mit einem
   * Object als Rückgabewert wäre jedes `if (await containerExists())` wahr –
   * der Hub hätte das Netz nie angelegt, den Container nie erstellt und statt
   *dessen ein `rm` ins Leere laufen lassen, ohne dass irgendwo ein Fehler
   * aufgefallen wäre.
   */
  const containerExists = async () =>
    (await inspect('container', config.containerName)).present;

  const pmaExists = async () =>
    (await inspect('container', config.phpmyadmin.containerName)).present;

  const networkExists = async () =>
    (await inspect('network', config.networkName)).present;

  const isRunning = async () =>
    (await inspect('container', config.containerName, '{{.State.Running}}'))
      .value === 'true';

  const pmaIsRunning = async () =>
    (
      await inspect(
        'container',
        config.phpmyadmin.containerName,
        '{{.State.Running}}',
      )
    ).value === 'true';

  const running = async () => {
    // Verbindung wegwerfen statt offen lassen: hier wird nur geprüft, ob
    // Zugangsdaten stimmen.
    let connection = null;
    try {
      connection = await connect({
        host: config.host,
        port: config.port,
        user: config.user,
        password: readSecretValues(config.projectRoot, 'db')
          .BOT_HUB_DB_PASSWORD,
        database: config.database,
      });
      return true;
    } catch {
      return false;
    } finally {
      try {
        await connection?.end();
      } catch {
        /* Die Verbindung war nie da – egal. */
      }
    }
  };

  /** Admin-Passwort in eine Datei mit 0600, in einem Verzeichnis mit 0700. */
  const writeInitEnvFile = (password) => {
    mkdirSync(secretsDirectory(config.projectRoot), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      envFile,
      `MYSQL_ROOT_PASSWORD=${password}\nMYSQL_ROOT_HOST=%\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(envFile, 0o600);
  };

  const dropInitEnvFile = () => {
    try {
      unlinkSync(envFile);
    } catch {
      /* Gab es keine Datei, ist nichts zu tun. */
    }
  };

  const ensureNetwork = async () => {
    if (await networkExists()) return;
    const created = await run(
      ['network', 'create', '--driver', 'bridge', config.networkName],
      { capture: true },
    );
    if (created.code !== 0 && !(await networkExists()))
      throw new Error(
        `Netzwerk ${config.networkName} konnte nicht angelegt werden: ${created.stderr.trim() || `Exit-Code ${created.code}`}`,
      );
  };

  const ensureContainer = async () => {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const present = await containerExists();
    if (present) {
      const label = await inspect(
        'container',
        config.containerName,
        '{{index .Config.Labels "bot-hub.config"}}',
      );
      // Läuft der Container gerade, wird er nicht ersetzt – MySQL beim
      // Ersetzen zu killen, weil sich eine Einstellung geändert hat, wäre
      // ein Ausfall ohne Grund. Der neue Container kommt beim nächsten Start.
      if (
        label.value !== containerSignature(config, envFile) &&
        !(await isRunning())
      )
        await run(['rm', '--force', config.containerName]);
    }
    if (await containerExists()) return;
    const created = await run(containerCreateArgs(config, envFile, { env }), {
      capture: true,
    });
    if (created.code !== 0)
      throw new Error(
        `Container ${config.containerName} konnte nicht erstellt werden: ${created.stderr.trim() || `Exit-Code ${created.code}`}`,
      );
  };

  const ensureStarted = async () => {
    if (await isRunning()) return;
    const started = await run(['start', config.containerName], {
      capture: true,
    });
    if (started.code !== 0 && !(await isRunning()))
      throw new Error(
        `Container ${config.containerName} konnte nicht gestartet werden: ${started.stderr.trim() || `Exit-Code ${started.code}`}`,
      );
  };

  /**
   * phpMyAdmin erzeugen und starten, falls es gewünscht ist.
   *
   * Bewusst nach `ensureStarted` und erst nach erfolgreichem Bootstrap: die
   * Oberfläche braucht den Verwaltungsbenutzer, und der entsteht nur in
   * diesem einen Durchlauf. Ein Container, der ohne Anmeldedaten startet,
   * wäre eine Oberfläche, an der niemand sich anmelden kann – besser, sie
   * entsteht gar nicht erst.
   */
  const ensurePhpmyadmin = async () => {
    if (!config.phpmyadmin.enabled) return;
    if (await pmaExists()) {
      const label = await inspect(
        'container',
        config.phpmyadmin.containerName,
        '{{index .Config.Labels "bot-hub.config"}}',
      );
      if (
        label.value !== phpmyadminSignature(config) &&
        !(await pmaIsRunning())
      )
        await run(['rm', '--force', config.phpmyadmin.containerName]);
    }
    if (!(await pmaExists())) {
      const created = await run(phpmyadminCreateArgs(config, { env }), {
        capture: true,
      });
      if (created.code !== 0)
        throw new Error(
          `Container ${config.phpmyadmin.containerName} konnte nicht erstellt werden: ${created.stderr.trim() || `Exit-Code ${created.code}`}`,
        );
    }
    if (await pmaIsRunning()) return;
    const started = await run(['start', config.phpmyadmin.containerName], {
      capture: true,
    });
    if (started.code !== 0 && !(await pmaIsRunning()))
      throw new Error(
        `Container ${config.phpmyadmin.containerName} konnte nicht gestartet werden: ${started.stderr.trim() || `Exit-Code ${started.code}`}`,
      );
  };

  /**
   * `BOT_HUB_PHPMYADMIN` wegnehmen soll die Oberfläche wirklich verschwinden
   * lassen – nicht nur die Variable aus `.env` streichen und einen Container
   * weiterlaufen lassen, dessen Port man selbst nicht mehr kennt.
   *
   * Gestoppt, nicht entfernt: `--restart unless-stopped` lässt einen von Hand
   * gestoppten Container auch nach einem Neustart des Daemons gestoppt, und der
   * Container behält sein Label und damit seine Identität. Wird die Variable
   * später wieder gesetzt, prüft `ensurePhpmyadmin` die Anmeldung, findet den
   * gespeicherten Zugang und startet denselben Container mit denselben Daten.
   *
   * Das Passwort in `data/secrets/phpmyadmin.env` bleibt dabei liegen. Es
   * wegzulefen wäre die falsche Reihenfolge: der Benutzer existiert in MySQL
   * weiter, und ohne die Datei wüsste der Hub nicht mehr, womit er sich anmelden
   * soll – er würde beim nächsten Start mit `BOT_HUB_PHPMYADMIN=1` behaupten,
   * der Benutzer sei nie angelegt worden.
   */
  const stopPhpmyadmin = async () => {
    if (!(await pmaExists()) || !(await pmaIsRunning())) return false;
    const stopped = await run(['stop', config.phpmyadmin.containerName], {
      capture: true,
    });
    if (stopped.code !== 0 && (await pmaIsRunning()))
      throw new Error(
        `Container ${config.phpmyadmin.containerName} liess sich nicht stoppen: ${stopped.stderr.trim() || `Exit-Code ${stopped.code}`}. BOT_HUB_PHPMYADMIN ist nicht gesetzt, die Oberfläche laeuft aber weiter auf 127.0.0.1:${config.phpmyadmin.port}.`,
      );
    return true;
  };

  /** Läuft der Verwaltungsbenutzer noch, oder ist sein Passwort veraltet? */
  const adminUsable = async () => {
    const password = readSecretValues(
      config.projectRoot,
      'phpmyadmin',
    ).BOT_HUB_ADMIN_DB_PASSWORD;
    if (!password) return false;
    return canLogIn(config.adminUser, password);
  };

  /**
   * Warten, bis mysqld antwortet. Der erste Start initialisiert erst den
   * Datenspeicher und das kann eine Weile dauern; danach geht es schnell.
   */
  const waitForAdmin = async (password) => {
    const limit = number(
      env.BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS,
      BOOTSTRAP_TIMEOUT_MS,
      {
        min: 1000,
        max: 900_000,
        name: 'BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS',
      },
    );
    const until = Date.now() + limit;
    let last = null;
    while (Date.now() < until) {
      let connection = null;
      try {
        connection = await connect({
          host: config.host,
          port: config.port,
          user: 'root',
          password,
        });
        await connection.end();
        return;
      } catch (error) {
        last = error;
        try {
          await connection?.end();
        } catch {
          /* egal */
        }
        await wait(BOOTSTRAP_POLL_MS);
      }
    }
    throw new Error(
      `MySQL in ${config.containerName} war nach ${Math.round(limit / 1000)} s nicht als Admin erreichbar` +
        ` (${last?.code || last?.message || 'unbekannter Fehler'}).` +
        ` Ursache siehe: docker logs ${config.containerName}\n` +
        '         Läuft der Container zum ersten Mal, dauert das nur länger und lässt sich mit BOT_HUB_MYSQL_STARTUP_TIMEOUT_MS verlängern.\n' +
        `         Bekommt er "Access denied", ist der Datenspeicher schon mit einem anderen Admin-Passwort initialisiert. Dann kann nur ein neuer Passwort-Setup helfen: BOT_HUB_MYSQL_RESET=1 verwirft ${config.dataDir}.`,
    );
  };

  /**
   * Der Durchlauf als ein Objekt.
   *
   * Drei Passwörter sind im Spiel, und zwei davon heissen fast gleich:
   * `rootPassword` ist der einmalige Zugang zum Container, `adminDbPassword`
   * das neue Konto für phpMyAdmin. Als lose Parameter heißen sie sich
   * `adminPassword` und `adminPassword` – und beim Umstellen des einen kommt
   * stillschweigend `undefined` beim anderen an, der Benutzer wird nicht
   * angelegt und niemand merkt es, weil der Rest des Ablaufs gelingt.
   */
  const runBootstrap = async ({
    rootPassword,
    appPassword,
    adminDbPassword,
  }) => {
    let connection = null;
    try {
      connection = await connect({
        host: config.host,
        port: config.port,
        user: 'root',
        password: rootPassword,
      });
      for (const statement of bootstrapStatements(config, {
        appPassword,
        adminPassword: adminDbPassword,
      }))
        await connection.query(statement);
    } finally {
      try {
        await connection?.end();
      } catch {
        /* egal */
      }
    }
  };

  /**
   * Das Passwort eines vorhandenen Benutzers ersetzen.
   *
   * Zwei Eigenschaften machen das ohne Adminrechte möglich und ohne Neustart
   * brauchbar:
   *
   * - **Ein Benutzer darf sein eigenes Passwort ändern.** `ALTER USER USER()`
   *   braucht keine besondere Berechtigung – wer sich anmelden kann, darf sich
   *   damit auch ein neues Passwort geben. Das ist der Grund, warum hier kein
   *   `root` gebraucht wird, den es von außen gar nicht mehr gibt.
   * - **Die Datei wird vor dem SQL geschrieben.** Wird die Datei danach
   *   geschrieben und der Vorgang bricht dazwischen ab, hat niemand mehr eine
   *   Ahnung, welches von beiden der gültige Wert ist. So herum können die
   *   beiden nur auseinanderlaufen, wenn das `ALTER` scheitert – und dann steht
   *   MySQL noch auf dem alten Wert, der zurückgeschriebene Wert stimmt wieder,
   *   und der Hub kommt beim nächsten Versuch wieder herein.
   */
  const rotatePassword = async ({
    user,
    currentSecret,
    store,
    newPassword,
  }) => {
    if (!currentSecret)
      throw new Error(
        `Für ${user} liegt kein Passwort vor – es gibt nichts zu rotieren.`,
      );
    if (!(await canLogIn(user, currentSecret)))
      throw new Error(
        `Der Benutzer ${user} kommt mit dem gespeicherten Passwort nicht mehr herein. ` +
          'Ein Rotieren setzt einen vorhandenen Zugang voraus – bei einem MySQL-Container des Hubs heißt die Alternative BOT_HUB_MYSQL_RESET=1, wobei alle Bot-Daten verloren gehen.',
      );

    store(newPassword);
    let connection = null;
    try {
      connection = await connect({
        host: config.host,
        port: config.port,
        user,
        password: currentSecret,
      });
      await connection.query(
        `ALTER USER USER() IDENTIFIED BY ${passwordLiteral(newPassword)}`,
      );
    } catch (error) {
      // Das ALTER hat nicht stattgefunden: MySQL kennt weiter das alte
      // Passwort, also gehört auch die Datei wieder auf den alten Wert.
      store(currentSecret);
      throw new Error(
        `Das Passwort für ${user} konnte nicht geändert werden: ${error.message}`,
      );
    } finally {
      try {
        await connection?.end();
      } catch {
        /* egal */
      }
    }
    if (!(await canLogIn(user, newPassword)))
      throw new Error(
        `Das Passwort für ${user} wurde geändert, der neue Wert funktioniert aber nicht. ` +
          `MySQL und ${join('data', 'secrets')} stimmen nicht mehr überein; bitte die Meldung von MySQL prüfen und notfalls BOT_HUB_MYSQL_RESET=1 verwenden.`,
      );
  };

  const canLogIn = async (user, password) => {
    let connection = null;
    try {
      connection = await connect({
        host: config.host,
        port: config.port,
        user,
        password,
      });
      return true;
    } catch {
      return false;
    } finally {
      try {
        await connection?.end();
      } catch {
        /* Die Verbindung war nie da – egal. */
      }
    }
  };

  /** Alles verwerfen: Container, Netz und Datenvolumen. */
  const reset = async () => {
    if (await pmaExists())
      await run(['rm', '--force', '-v', config.phpmyadmin.containerName]);
    if (await containerExists())
      await run(['rm', '--force', '-v', config.containerName]);
    if (await networkExists()) await run(['network', 'rm', config.networkName]);
    // `maxRetries` hilft, wenn ein Prozess die Dateien noch offen hält; die
    // Option gibt es erst ab node 22.10, ältere Laufzeiten kämen sonst ohne
    // Meldung nicht weiter.
    try {
      rmSync(config.dataDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      rmSync(config.dataDir, { recursive: true, force: true });
    }
    dropInitEnvFile();
    storeSecretValues(config.projectRoot, 'db', {
      BOT_HUB_DB_PASSWORD: '',
      BOT_HUB_DB_BOOTSTRAPPED: '',
    });
    // Das Verwaltungspasswort gehört zum selben Datenbestand. Steht es nach
    // einem Reset noch in der Datei, findet der nächste Start zwar keinen
    // Container und legt einen neuen an – der alte Benutzer mit dem alten
    // Passwort existiert im neuen Container aber gar nicht, und die Anzeige
    // würde auf ein Passwort zeigen, das niemand benutzen kann.
    storeSecretValues(config.projectRoot, 'phpmyadmin', {
      BOT_HUB_ADMIN_DB_USER: '',
      BOT_HUB_ADMIN_DB_PASSWORD: '',
    });
  };

  // Nicht `describe`: das Wort ist in diesem Repo durch die Tests besetzt, und
  // ein gleichnamiges Feld in einem Rückgabewert lädt zu Verwechslungen ein.
  const beschreibung = () =>
    `mysql 127.0.0.1:${config.port}/${config.database} als ${config.user}` +
    ` (Container ${config.containerName})`;

  /**
   * Einmaliger Durchlauf. Der Zustand steckt in `data/secrets/db.env`:
   *
   *   kein Marker           → nie eingerichtet, Bootstrap steht aus
   *   Marker + Passwort     → eingerichtet, nur noch der Arbeitsbenutzer zählt
   *
   * Der Marker entscheidet, ob ein zweiter Bootstrap überhaupt möglich ist:
   * Nach dem ersten Durchlauf existiert das Admin-Passwort nicht mehr und
   * `root` von außen auch nicht. Fehlt danach der Arbeitsbenutzer, hilft nur
   * `BOT_HUB_MYSQL_RESET=1` – und genau das wird auch gesagt, statt still zu
   * scheitern.
   *
   * Die Reihenfolge ist nicht beliebig: `writeInitEnvFile` passiert vor
   * `ensureContainer`, weil `docker create --env-file` an einer fehlenden Datei
   * scheitert. Das heisst auch, dass die Datei zu einem Zeitpunkt existiert, an
   * dem noch gar nicht sicher ist, ob es einen Bootstrap gibt – sie wird deshalb
   * im `finally` wieder entfernt, auch wenn gar nichts damit gemacht wurde.
   *
   * Für phpMyAdmin gilt dieselbe Einmaligkeit, nur mit einer Einschränkung, die
   * dem Betreiber auffallen muss: der Verwaltungsbenutzer entsteht im selben
   * Durchlauf wie der Arbeitsbenutzer. Wird `BOT_HUB_PHPMYADMIN=1` also erst
   * gesetzt, wenn der Container schon läuft, lässt sich der Benutzer nicht mehr
   * nachholen – es gibt keinen Adminzugang, der ihn anlegen könnte. Statt
   * eines Containers ohne Anmeldung zu starten, sagt der Hub dann, was zu tun
   * ist.
   */
  const provision = async () => {
    if (truthy(env.BOT_HUB_MYSQL_RESET)) {
      console.warn(
        `[hub] BOT_HUB_MYSQL_RESET=1: Container ${config.containerName}, Netz ${config.networkName} und ${config.dataDir} werden verworfen.`,
      );
      await reset();
    }

    const secrets = readSecretValues(config.projectRoot, 'db');
    const established = secrets.BOT_HUB_DB_BOOTSTRAPPED === '1';
    const usable = established && Boolean(secrets.BOT_HUB_DB_PASSWORD);
    const wantsPhpmyadmin = config.phpmyadmin.enabled;
    const adminReady = wantsPhpmyadmin && (await adminUsable());

    if (wantsPhpmyadmin && established && usable && !adminReady)
      throw new Error(
        `BOT_HUB_PHPMYADMIN=1 ist gesetzt, aber der Benutzer ${config.adminUser} existiert nicht: ` +
          'er entsteht nur beim ersten Einrichten, und danach gibt es keinen Adminzugang mehr, der ihn nachholen könnte. ' +
          `Bitte BOT_HUB_PHPMYADMIN=1 vor dem ersten Start setzen. Oder ${config.dataDir} wird mit BOT_HUB_MYSQL_RESET=1 verworfen und alles neu angelegt; dabei gehen alle Bot-Daten verloren.`,
      );

    let adminPassword = null;
    let appPassword = null;
    let adminDbPassword = null;
    if (!usable) {
      adminPassword = generatePassword(PASSWORD_LENGTH, randomBytes);
      appPassword = generatePassword(PASSWORD_LENGTH, randomBytes);
      if (wantsPhpmyadmin)
        adminDbPassword = generatePassword(PASSWORD_LENGTH, randomBytes);
      writeInitEnvFile(adminPassword);
    }

    let status = 'eingerichtet';
    try {
      await ensureNetwork();
      await ensureContainer();
      await ensureStarted();

      if (secrets.BOT_HUB_DB_PASSWORD && (await running())) {
        status = 'bereit';
      } else if (established) {
        throw new Error(
          `Der MySQL-Container ${config.containerName} ist eingerichtet, aber der Benutzer ${config.user} kommt nicht hinein. ` +
            'Das Admin-Passwort ist absichtlich nicht mehr vorhanden – wer die Rechte einmal vergibt, kann sie nicht wiederholen. ' +
            `Mit BOT_HUB_MYSQL_RESET=1 wird ${config.dataDir} verworfen und alles neu angelegt; dabei gehen alle Bot-Daten verloren.`,
        );
      } else {
        await waitForAdmin(adminPassword);
        await runBootstrap({
          rootPassword: adminPassword,
          appPassword,
          adminDbPassword,
        });
      }

      if (wantsPhpmyadmin) {
        if (adminDbPassword)
          storeSecretValues(config.projectRoot, 'phpmyadmin', {
            BOT_HUB_ADMIN_DB_USER: config.adminUser,
            BOT_HUB_ADMIN_DB_PASSWORD: adminDbPassword,
          });
        await ensurePhpmyadmin();
      } else if (await stopPhpmyadmin()) {
        console.log(
          `[hub] BOT_HUB_PHPMYADMIN ist nicht gesetzt: Container ${config.phpmyadmin.containerName} ist gestoppt.`,
        );
      }
    } finally {
      // Auch im Fehlerfall: ein Passwort, das auf der Platte bleibt, obwohl der
      // Admin-Zugang von aussen schon weg ist, ist nur Ballast. Beim nächsten
      // Start entsteht ohnehin ein neues.
      if (!usable) dropInitEnvFile();
    }

    if (!usable) {
      storeSecretValues(config.projectRoot, 'db', {
        BOT_HUB_DB_PASSWORD: appPassword,
        BOT_HUB_DB_BOOTSTRAPPED: '1',
      });

      if (!(await running()))
        throw new Error(
          `Der Benutzer ${config.user} wurde angelegt, kommt aber nicht in ${config.database} hinein. Bitte ${config.dataDir} prüfen.`,
        );
    }

    await rotateRequested();

    return {
      status,
      config,
      beschreibung: beschreibung(),
      ...(wantsPhpmyadmin ? { phpmyadmin: phpmyadminHinweis() } : {}),
    };
  };

  /**
   * Wo die Oberfläche liegt und wo das Passwort steht – als Text, der in die
   * Konsole darf. Der Pfad ja, der Wert nie: ein Log, in dem ein gültiges
   * Passwort steht, ist ein Log, den irgendwer kopiert.
   */
  const phpmyadminHinweis = () =>
    `http://127.0.0.1:${config.phpmyadmin.port}` +
    ` (Anmeldung als ${config.adminUser}, Passwort in data/secrets/phpmyadmin.env)`;

  /**
   * Passwortwechsel, wenn angefordert.
   *
   * Beide Benutzer rotieren ohne den anderen zu berühren: kein Bot-Token, kein
   * Panel-Token und kein Bot-Speicher wird dabei angerührt. Für den
   * Arbeitsbenutzer ist das ohne Neustart wirksam, weil dieser Durchlauf
   * vor dem Verbindungsaufbau des Hubs liegt – der Pool baut sich erst danach
   * mit dem neuen Passwort auf.
   */
  const rotateRequested = async () => {
    const was = String(env.BOT_HUB_MYSQL_ROTATE ?? '')
      .trim()
      .toLowerCase();
    if (!was || ['0', 'false', 'nein', 'no'].includes(was)) return;
    if (was !== 'app' && was !== 'admin')
      throw new Error(
        "BOT_HUB_MYSQL_ROTATE muss 'app' oder 'admin' sein – so benennt werden die Passwörter, die rotiert werden können.",
      );

    if (was === 'admin') {
      const current = readSecretValues(
        config.projectRoot,
        'phpmyadmin',
      ).BOT_HUB_ADMIN_DB_PASSWORD;
      await rotatePassword({
        user: config.adminUser,
        currentSecret: current,
        store: (value) =>
          storeSecretValues(config.projectRoot, 'phpmyadmin', {
            BOT_HUB_ADMIN_DB_PASSWORD: value,
          }),
        newPassword: generatePassword(PASSWORD_LENGTH, randomBytes),
      });
      console.log(
        `[hub] Passwort für ${config.adminUser} erneuert (data/secrets/phpmyadmin.env). Das alte Passwort gilt ab jetzt nicht mehr.`,
      );
      return;
    }

    await rotatePassword({
      user: config.user,
      currentSecret: readSecretValues(config.projectRoot, 'db')
        .BOT_HUB_DB_PASSWORD,
      store: (value) =>
        storeSecretValues(config.projectRoot, 'db', {
          BOT_HUB_DB_PASSWORD: value,
        }),
      newPassword: generatePassword(PASSWORD_LENGTH, randomBytes),
    });
    console.log(
      `[hub] Passwort für ${config.user} erneuert (data/secrets/db.env). Das alte Passwort gilt ab jetzt nicht mehr.`,
    );
  };

  return {
    provision,
    reset,
    rotateRequested,
    beschreibung,
    config,
    envFile,
  };
};

/** Bequemlichkeit für `index.js`. */
export const provisionManagedMySql = async (deps = {}) =>
  createProvisioner(deps).provision();
