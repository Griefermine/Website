import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  statSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { managedConfig, managedMySqlActive } from './mysql.js';
import {
  getLocalBotApiUrl,
  getVerifiedLocalBotNetwork,
  LOCAL_BOT_NETWORK,
} from './localNetwork.js';

const RUNTIME = process.env.BOT_HUB_CONTAINER_RUNTIME || 'docker';
const PREFIX = process.env.BOT_HUB_CONTAINER_PREFIX || 'bot-hub';
const PRODUCTION_BOT_NETWORK = 'bot-hub-discord';
const PRODUCTION_DEPENDENCY_NETWORK = 'bot-hub-dependencies';
export const PRODUCTION_BOT_GATEWAY = '172.30.250.1';
export const PRODUCTION_BOT_HUB_PORT = 8788;
const DISCORD_EGRESS_PROXY = 'http://172.30.250.1:3128';
const DEPENDENCY_EGRESS_PROXY = 'http://172.30.251.1:3128';

/* Maven 3.9s Native-Transport ignoriert JVM-Proxy-Properties UND
 * Umgebungsvariablen – eine Probe auf dem Paketnetz ließ nur eine
 * settings.xml über `-s` gelten (Maßnahme 31). Die Datei legt der
 * Paket-Runner in den Workspace; Maven 3.9.7+ liest zusätzliche
 * Kommandoargumente aus MAVEN_ARGS, wodurch kein Installations-Kommando
 * angefasst werden muss. */
const dependencyProxyUrl = new URL(DEPENDENCY_EGRESS_PROXY);
const MAVEN_SETTINGS_CONTENT =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  '<settings>\n  <proxies>\n' +
  ['https', 'http']
    .map(
      (protocol) =>
        `    <proxy><id>bot-hub-${protocol}</id><active>true</active>` +
        `<protocol>${protocol}</protocol>` +
        `<host>${dependencyProxyUrl.hostname}</host>` +
        `<port>${dependencyProxyUrl.port}</port></proxy>`,
    )
    .join('\n') +
  '\n  </proxies>\n</settings>\n';

/* Maßnahme 36 (Audit SEC-01/02): Der Bot läuft mit derselben UID wie der Hub
 * und darf im Workspace jederzeit Dateien und Ordner durch Symlinks ersetzen.
 * Jeder Hub-Schreibgriff in den Workspace darf solchen Verweisen NICHT
 * folgen – sonst schreibt der Hub bekannten Inhalt auf Host-Pfade außerhalb
 * des Workspace (bots.json, sessions.json, Master-Key …). Deshalb: Verweis
 * auf dem Pfad wird als Verweis selbst entfernt (sein Ziel bleibt
 * unangetastet), geschrieben wird atomar über Temporärdatei + rename. */

/** `basis/…teile` als echtes Verzeichnis sichern; Verweise werden ersetzt.
 *
 * Maßnahme 51 (Auftrag 5.3): die frühere Fassung warf nach `lstat` ->
 * `unlink` ->
 * `mkdir` ein `EEXIST` stillschweigend weg. Genau das ist der Fall, wenn ein
 * Angreifer mit Writer-Rechten im Workspace den gelöschten Eintrag zwischen
 * unserer Prüfung und dem Anlegen NEU als Symlink anlegt: der Aufrufer bekam
 * „alles gut“ zurück, und der .NET-Init-Lauf (der bewusst als root in diesen
 * Ordner schreibt) folgte dem Verweis. Ein EEXIST nach vorherigem Nichtvor-
 * handensein ist deshalb ein harter Abbruch, wenn die Stelle kein echtes
 * Verzeichnis trägt – auf einem zweifelhaften Zustand wird nicht weiter-
 * gemacht. */
export const ensureWorkspaceDirNoFollow = (basis, ...teile) => {
  let pfad = basis;
  for (const teil of teile) {
    pfad = join(pfad, teil);
    try {
      const stat = lstatSync(pfad);
      if (stat.isDirectory()) continue;
      unlinkSync(pfad);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      // bewusst ohne `recursive`: kein Pfadstück wird durchwandert.
      mkdirSync(pfad, { mode: 0o755 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      /* Jemand anderes hat in der Zwischenzeit hier etwas angelegt. Echtes
       * Verzeichnis -> in Ordnung (etwa ein zweiter Hub-Lauf). Alles andere,
       * insbesondere ein frisch gesetzter Symlink -> Abbruch. */
      let nachtrag;
      try {
        nachtrag = lstatSync(pfad);
      } catch {
        throw error;
      }
      if (!nachtrag.isDirectory())
        throw Object.assign(
          new Error(
            `Workspace-Eintrag "${teil}" wurde während der Prüfung ausgetauscht`,
          ),
          { code: 'ESWAPPED' },
        );
    }
  }
  return pfad;
};

/** Datei atomar und ohne Symlink-Folge an `pfad` ablegen. */
export const writeWorkspaceFileNoFollow = (pfad, inhalt) => {
  try {
    const stat = lstatSync(pfad);
    if (!stat.isFile()) unlinkSync(pfad);
  } catch {
    /* Ziel existiert (noch) nicht */
  }
  const tmp = `${pfad}.tmp-${randomUUID()}`;
  try {
    const fd = openSync(tmp, 'wx', 0o644);
    writeFileSync(fd, inhalt);
    closeSync(fd);
    renameSync(tmp, pfad);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* der ursprüngliche Fehler zählt */
    }
    throw error;
  }
};

const containerNetwork = () => {
  const configured = String(process.env.BOT_HUB_CONTAINER_NETWORK ?? '').trim();
  const production = process.env.NODE_ENV === 'production';
  if (production && configured && configured !== PRODUCTION_BOT_NETWORK)
    throw new Error(
      `In Produktion ist nur das isolierte Netzwerk ${PRODUCTION_BOT_NETWORK} erlaubt.`,
    );
  if (!production && configured && configured !== LOCAL_BOT_NETWORK)
    throw new Error(
      `Im lokalen Profil ist ausschließlich das geprüfte Netzwerk ${LOCAL_BOT_NETWORK} erlaubt.`,
    );
  const network =
    configured || (production ? PRODUCTION_BOT_NETWORK : LOCAL_BOT_NETWORK);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(network) ||
    network.toLowerCase() === 'host' ||
    (!production && network === 'bridge')
  )
    throw new Error(
      'BOT_HUB_CONTAINER_NETWORK muss ein gültiger, vom Host-Netz verschiedener und für das lokale Profil freigegebener Docker-Netzwerkname sein.',
    );
  return network;
};

export const DEFAULT_CONTAINER_IMAGES = Object.freeze({
  python: 'python:3.12-bookworm',
  javascript: 'node:22-bookworm',
  typescript: 'node:22-bookworm',
  java: 'maven:3.9-eclipse-temurin-17',
  kotlin: 'maven:3.9-eclipse-temurin-17',
  go: 'golang:1.24-bookworm',
  csharp: 'mcr.microsoft.com/dotnet/sdk:8.0',
  rust: 'rust:1-bookworm',
  custom: 'ubuntu:24.04',
});

const BASE_IMAGES = DEFAULT_CONTAINER_IMAGES;

/**
 * Production-Defaults: Images auf Digest pinnen für Reproduzierbarkeit.
 * Können über BOT_HUB_CONTAINER_IMAGES überschrieben werden.
 * Format: {"python":"python:3.12-bookworm@sha256:…"}
 *
 * Bewusst leer. Eine ausgedachte Digest-Liste wäre schlimmer als keine: ein
 * falscher Digest lässt jeden Pull scheitern, und niemand könnte unterscheiden,
 * ob das Image veraltet oder der Digest falsch ist. Stattdessen meldet der
 * Start über `unpinnedImages`, welche Bilder nur über ein Tag festgelegt sind, und
 * verweigert den Betrieb, wenn das verlangt wird.
 */
const PINNED_IMAGES = {};

/**
 * Operatoren können die Bilder auf eine Digest-Version festnageln, ohne dass
 * hier etwas zu ändern wäre:
 * `BOT_HUB_CONTAINER_IMAGES={"python":"python:3.12-bookworm@sha256:…"}`.
 * Erlaubt sind nur Namen mit Tag und/oder Digest – nichts, was beim Start
 * als Kommando durchs Schlupfloch gehen könnte.
 */
const IMAGE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}(:[A-Za-z0-9._-]{1,60})?(@sha256:[a-f0-9]{64})?$/;

const imageOverrides = () => {
  const raw = String(process.env.BOT_HUB_CONTAINER_IMAGES ?? '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) =>
          key in BASE_IMAGES &&
          typeof value === 'string' &&
          IMAGE_PATTERN.test(value.trim()),
      ),
    );
  } catch {
    console.warn(
      '[hub] BOT_HUB_CONTAINER_IMAGES ist kein gültiges JSON – Standardbilder werden verwendet.',
    );
    return {};
  }
};

const IMAGES = { ...BASE_IMAGES, ...PINNED_IMAGES, ...imageOverrides() };

/**
 * Bilder, die nur über ein Tag statt über einen Digest festgelegt sind.
 *
 * Ein Tag ist eine Liste von Namen, die jemand anderes umschreiben kann. Wer
 * `python:3.12-bookworm` zieht, bekommt möglicherweise ein anderes Image als
 * gestern – und der Code darin läuft mit den Rechten des Containers. Für einen
 * Betrieb mit festem Anspruch ist das der Unterschied zwischen "ungeprüft" und
 * "unveränderlich".
 *
 * Die Bilder der Datenbankverwaltung gehören in dieselbe Liste: MySQL und
 * phpMyAdmin laufen mit denselben Rechten wie ein Bot-Container, und `latest`
 * bedeutet dort dasselbe wie hier. Sie zählen aber nur, wenn sie auch wirklich
 * gezogen werden – wer SQLite oder ein eigenes MySQL fährt, hat diese Bilder
 * nicht und darf von ihnen nicht abhängig sein.
 */
const unpinnedImages = () => {
  const sprache = Object.entries(IMAGES).map(([language, reference]) => ({
    language,
    reference,
  }));
  // Ohne den verwalteten Container wird `managedConfig` gar nicht erst
  // gelesen: es gibt dann keine MySQL-Bilder, und eine kaputte
  // MySQL-Einstellung darf die Prüfung der Bot-Bilder nicht stumm abschalten.
  const verwaltet = managedMySqlActive()
    ? (() => {
        const managed = managedConfig();
        return [
          { language: 'mysql', reference: managed.image },
          ...(managed.phpmyadmin.enabled
            ? [{ language: 'phpmyadmin', reference: managed.phpmyadmin.image }]
            : []),
        ];
      })()
    : [];
  return [...sprache, ...verwaltet].filter(
    ({ reference }) => !reference.includes('@sha256:'),
  );
};

/** Soll ein Image ohne Digest abgelehnt werden? */
const digestRequired = () =>
  ['1', 'true', 'ja', 'yes'].includes(
    String(process.env.BOT_HUB_REQUIRE_IMAGE_DIGEST ?? '')
      .trim()
      .toLowerCase(),
  );

const nameOf = (bot) => {
  const id = String(bot.id)
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .slice(0, 48);
  return `${PREFIX}-${id}`;
};

const imageOf = (bot) => IMAGES[bot.language] || IMAGES.custom;
const runtimeSystemPath = (bot) => {
  const languagePath =
    {
      java: '/opt/java/openjdk/bin:/usr/share/maven/bin',
      kotlin: '/opt/java/openjdk/bin:/usr/share/maven/bin',
      go: '/usr/local/go/bin',
      rust: '/usr/local/cargo/bin',
      csharp: '/usr/share/dotnet',
    }[bot.language] || '';
  return [
    languagePath,
    '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  ]
    .filter(Boolean)
    .join(':');
};
const workspacePath = (bot, projectRoot) =>
  join(projectRoot, bot.workspaceRoot || `bots/${bot.id}/workspace`);
const hostUid = () =>
  Number.isInteger(process.getuid?.()) ? process.getuid() : 1000;
const hostGid = () =>
  Number.isInteger(process.getgid?.()) ? process.getgid() : 1000;
const containerUser = () => `${hostUid()}:${hostGid()}`;

/**
 * Läuft der Hub als root?
 *
 * Dann bekommen auch die Container root. Ein Bot darf keinen Weg aus seinem
 * Workspace in den Host haben – mit uid 0 im Container ist die zweite Hälfte
 * davon hinfällig. Statt still `1000` anzunehmen und damit eine falsche
 * Sicherheit vorzutäuschen, sagt die Funktion es dem Start.
 */
const hubRunsAsRoot = () => process.platform !== 'win32' && hostUid() === 0;

/**
 * `bots/shared` enthält die gemeinsame Hub-Bibliothek der Beispiel-Bots. Ein
 * Workspace importiert daraus per relativem Pfad (`../../shared/api.js`), was
 * auf dem Host `bots/shared/api.js` ergibt – im Container, wo nur der
 * Workspace als `/workspace` hängt, aber `/shared/api.js`. Ohne diesen Mount
 * bricht der Start mit ERR_MODULE_NOT_FOUND ab.
 *
 * Der Mount ist schreibgeschützt und enthält ausschließlich Client-Code: die
 * Workspaces anderer Bots bleiben außerhalb des Containers.
 */
const SHARED_TARGET = '/shared';
const sharedVolume = (projectRoot) => {
  const source = join(projectRoot, 'bots', 'shared');
  return existsSync(source)
    ? ['--volume', `${source}:${SHARED_TARGET}:ro`]
    : [];
};

/**
 * Kein Bot-Container erhält eine allgemeine Host-Gateway-Zuordnung. Die
 * begrenzte Hub-Kommunikation läuft über den separaten Listener am Gateway
 * des geprüften Docker-Netzes.
 */
const hostMapping = () => {
  if (String(process.env.BOT_HUB_CONTAINER_URL ?? '').trim())
    throw new Error(
      'BOT_HUB_CONTAINER_URL ist nicht mehr zulässig. Der direkte Host-Gateway-Zugriff wurde durch die isolierte interne Bot-API ersetzt.',
    );
  return [];
};

/**
 * Alles, was sich beim Erstellen nicht nachträglich ändern lässt, kommt hier
 * hinein: Benutzer, Bild, Mounts, Host-Eintrag. Steht das Ergebnis nicht im
 * Label des vorhandenen Containers, ist er aus einer älteren Hub-Version und
 * wird ersetzt – statt fünf Stellen einzeln zu prüfen.
 */
const containerSignature = (bot, projectRoot) =>
  createHash('sha256')
    .update(
      [
        containerUser(),
        imageOf(bot),
        workspacePath(bot, projectRoot),
        sharedVolume(projectRoot).join(' '),
        hostMapping().join(' '),
        containerNetwork(),
        'filesystem:read-only,tmpfs:/tmp:rw,nosuid,size=128m',
        'entrypoint:tail -f /dev/null',
      ].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 16);

export const containerCreateArgs = (bot, projectRoot) => [
  'create',
  '--name',
  nameOf(bot),
  '--user',
  containerUser(),
  '--init',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,nosuid,size=128m',
  '--pids-limit',
  '256',
  '--memory',
  process.env.BOT_HUB_CONTAINER_MEMORY || '512m',
  '--cpus',
  process.env.BOT_HUB_CONTAINER_CPUS || '2',
  '--network',
  containerNetwork(),
  '--workdir',
  '/workspace',
  '--label',
  `bot-hub.config=${containerSignature(bot, projectRoot)}`,
  ...hostMapping(),
  '--volume',
  // Hinweis: nosuid/nodev hier abgelehnt – dieser Docker-Daemon kennt die
  // Modi für --volume nicht („invalid mode“); setuid-Bits sind ohnehin
  // wirkungslos, weil der Container mit no-new-privileges + cap-drop ALL
  // läuft (Maßnahme-29-Sicherheitsprüfung).
  `${workspacePath(bot, projectRoot)}:/workspace`,
  ...sharedVolume(projectRoot),
  // Wichtiger Fix: vorher lief hier `tail tail -f /dev/null` (ein 'tail' zu
  // viel als Argument) -> "tail: cannot open 'tail'" im Bot-Container-Log.
  '--entrypoint',
  'tail',
  imageOf(bot),
  '-f',
  '/dev/null',
];

const run = (args, { capture = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(RUNTIME, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
    }
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve({ code: code ?? -1, signal, stdout, stderr }),
    );
  });

const exists = async (name) => {
  const result = await run(['container', 'inspect', name]);
  return result.code === 0;
};

export const containerName = nameOf;
export const containerImage = imageOf;
export const containerWorkspace = (bot, projectRoot) =>
  workspacePath(bot, projectRoot);

const containerLabel = async (name) => {
  const result = await run(
    [
      'container',
      'inspect',
      '--format',
      '{{index .Config.Labels "bot-hub.config"}}',
      name,
    ],
    { capture: true },
  );
  return result.code === 0 ? result.stdout.trim() : '';
};

export const ensureContainer = async (bot, projectRoot) => {
  const name = nameOf(bot);
  if (await exists(name)) {
    // Container aus älteren Hub-Versionen kennen weder den /shared-Mount noch
    // das Konfigurations-Label. Sie werden ersetzt, damit die Volume-Liste
    // beim Create feststeht. Läuft gerade ein Bot darin, wird nicht ersetzt –
    // ein laufender Prozess soll nicht unter den Füßen weggezogen werden.
    if (
      (await containerLabel(name)) !== containerSignature(bot, projectRoot) &&
      !bot.child
    )
      await run(['rm', '--force', name]);
  }
  if (!(await exists(name))) {
    const result = await run(containerCreateArgs(bot, projectRoot), {
      capture: true,
    });
    if (result.code !== 0)
      throw new Error(
        `Container ${name} konnte nicht erstellt werden: ${result.stderr.trim() || `Exit-Code ${result.code}`}`,
      );
  }
  const started = await run(['start', name], { capture: true });
  if (started.code !== 0 && !(await isRunning(name)))
    throw new Error(
      `Container ${name} konnte nicht gestartet werden: ${started.stderr.trim() || `Exit-Code ${started.code}`}`,
    );
  return name;
};

/**
 * Produktions-Bots dürfen nur in das vorbereitete interne Discord-Netz.
 * Fehlendes Netz oder Proxy beendet den Hub-Start, statt Container später mit
 * einem ungefilterten Netz zu starten.
 */
export const validateProductionBotNetwork = async () => {
  if (process.env.NODE_ENV !== 'production') return;
  if (String(process.env.BOT_HUB_CONTAINER_URL ?? '').trim())
    throw new Error(
      'BOT_HUB_CONTAINER_URL ist gesperrt. Produktions-Bots erhalten automatisch die private Hub-API-Adresse.',
    );
  const network = await run(
    [
      'network',
      'inspect',
      containerNetwork(),
      '--format',
      '{{.Internal}}|{{json .Options}}|{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}',
    ],
    { capture: true },
  );
  const [internal, rawOptions, addressing] = network.stdout.trim().split('|');
  let options = {};
  try {
    options = JSON.parse(rawOptions);
  } catch {
    /* handled by the fail-closed condition below */
  }
  if (
    network.code !== 0 ||
    internal !== 'true' ||
    options['com.docker.network.bridge.name'] !== 'br-bothubdisc' ||
    options['com.docker.network.bridge.enable_icc'] !== 'false' ||
    !String(addressing ?? '').includes('172.30.250.0/24 172.30.250.1')
  )
    throw new Error(
      `Docker-Netz ${PRODUCTION_BOT_NETWORK} fehlt oder entspricht nicht der isolierten Netzkonfiguration. Starte deploy/discord-egress/compose.yaml.`,
    );

  const dependencies = await run(
    [
      'network',
      'inspect',
      PRODUCTION_DEPENDENCY_NETWORK,
      '--format',
      '{{.Internal}}|{{json .Options}}|{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}',
    ],
    { capture: true },
  );
  const [dependenciesInternal, rawDependenciesOptions, dependenciesAddressing] =
    dependencies.stdout.trim().split('|');
  let dependenciesOptions = {};
  try {
    dependenciesOptions = JSON.parse(rawDependenciesOptions);
  } catch {
    /* handled by the fail-closed condition below */
  }
  if (
    dependencies.code !== 0 ||
    dependenciesInternal !== 'true' ||
    dependenciesOptions['com.docker.network.bridge.name'] !== 'br-bothubdeps' ||
    dependenciesOptions['com.docker.network.bridge.enable_icc'] !== 'false' ||
    !String(dependenciesAddressing ?? '').includes(
      '172.30.251.0/24 172.30.251.1',
    )
  )
    throw new Error(
      `Docker-Paketnetz ${PRODUCTION_DEPENDENCY_NETWORK} fehlt oder ist nicht isoliert. Starte deploy/discord-egress/compose.yaml.`,
    );

  const proxy = await run(
    [
      'container',
      'inspect',
      '--format',
      '{{.HostConfig.NetworkMode}} {{index .Config.Labels "bot-hub.discord-egress"}} {{.State.Running}} {{.Config.User}}',
      'bot-hub-discord-egress',
    ],
    { capture: true },
  );
  if (
    proxy.code !== 0 ||
    proxy.stdout.trim() !== 'host filtered-egress-v5 true 13:13'
  )
    throw new Error(
      'Der Discord-Ausgangsproxy läuft nicht im Host-Netz mit den privaten Gateway-Listenern. Starte deploy/discord-egress/compose.yaml.',
    );

  const firewallChecker = '/usr/local/sbin/bot-hub-host-firewall-check';
  const firewallCheck = await new Promise((resolve) => {
    // Vorher verglich `command === 'sudo'` mit dem absoluten Pfad
    // '/usr/bin/sudo' – das matchte nie, Argumente blieben leer und das
    // nackte `sudo` gab nur seine Usage aus (Prüfung scheiterte immer).
    const asRoot = process.getuid?.() === 0;
    const command = asRoot ? firewallChecker : '/usr/bin/sudo';
    const args = asRoot ? [] : ['-n', firewallChecker];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', (error) =>
      resolve({ code: -1, stderr: error.message }),
    );
    child.once('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  if (firewallCheck.code !== 0)
    throw new Error(
      'Die aktive Host-Firewall sperrt die Docker-Bridges nicht nachweislich. ' +
        'Führe das Host-Firewall-Setup aus und richte den Prüfer für den Hub-Benutzer ein. ' +
        (firewallCheck.stderr?.trim() || firewallCheck.stdout?.trim() || ''),
    );
};

const isRunning = async (name) => {
  const result = await run(
    ['inspect', '--format', '{{.State.Running}}', name],
    {
      capture: true,
    },
  );
  return result.code === 0 && result.stdout.trim() === 'true';
};

export const stopContainer = async (bot) => {
  const name = nameOf(bot);
  if (await exists(name)) await run(['stop', '--time', '5', name]);
};

export const removeContainer = async (bot) => {
  // Idempotent und laufzeitbewusst: ohne Container-Runtime gibt es nichts zu
  // entfernen (kein docker-Aufruf, kein ENOENT im Test-/Dev-Modus). Ein
  // bereits verschwundener Container ist ebenfalls OK – nur echte
  // Docker-Fehler werden gemeldet. Der Name stammt immer aus nameOf(bot),
  // niemals aus Request-Parametern.
  if (!containerRuntimeEnabled()) return;
  const name = nameOf(bot);
  try {
    if (await exists(name)) await run(['rm', '--force', name]);
  } catch (error) {
    if (/no such container|not found/i.test(String(error?.message ?? '')))
      return;
    throw error;
  }
};

/**
 * Übergibt die Container-Umgebung nicht als `--env KEY=WERT` in der
 * Argumentliste – die wäre für jeden lokalen Benutzer in `ps` und in
 * `/proc/<pid>/cmdline` lesbar, inklusive Bot-Token und Runtime-Token.
 * Stattdessen eine Datei in `tmpdir()`: 0600, zufälliger Name, mit `wx`
 * angelegt (existiert sie bereits, scheitert der Aufruf statt sie zu
 * überschreiben). Der Aufrufer löscht sie, sobald der docker-CLI-Prozess
 * fertig ist (`cleanupExecEnvFile`). Gibt den Pfad zurück oder null,
 * wenn nichts zu übergeben ist.
 */
/* Maßnahme 38 (Audit SEC-07): Die env-Dateien enthalten Bot- und Laufzeit-
 * Tokens und werden normalerweise beim Prozess-Exit gelöscht. Stirbt der Hub
 * hart (OOM, SIGKILL), bleiben sie im /tmp liegen – beim Start wird das
 * Muster deshalb abgeräumt, bevor irgendetwas spawned.
 * Maßnahme 44 (V27): ohne Altersschwelle räumte der Start auch die Dateien
 * parallel laufender Geschwister-Prozesse weg (zwei Test-Suiten im selben
 * /tmp; produkttheoretisch: ein Hub-Restart während ein laufender Install-
 * Spawn seine Datei noch braucht). Legitime Dateien leben nur Sekunden bis
 * Minuten – geräumt wird deshalb nur, was älter als diese Schwelle ist.
 * Token-Reste aus Abstürzen erwischt jeder spätere Start mit. */
const STALE_EXEC_ENV_MIN_AGE_MS = 10 * 60_000;

export const sweepStaleExecEnvFiles = () => {
  let removed = 0;
  try {
    const now = Date.now();
    for (const entry of readdirSync(tmpdir())) {
      if (!/^bot-hub-exec-env-[0-9a-f-]{36}$/.test(entry)) continue;
      const full = join(tmpdir(), entry);
      try {
        if (now - statSync(full).mtimeMs < STALE_EXEC_ENV_MIN_AGE_MS) continue;
        unlinkSync(full);
        removed += 1;
      } catch {
        /* fremde Datei oder schon weg */
      }
    }
  } catch {
    /* kein /tmp – nichts zu räumen */
  }
  if (removed)
    console.warn(`[hub] ${removed} verwaiste Exec-Umgebungsdateien geräumt.`);
  return removed;
};

const writeExecEnvFile = (env) => {
  const lines = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const text = String(value);
    // Das env-file-Format ist zeilenbasiert: Schlüssel ohne `=`, Werte
    // mit Zeilenumbruch würden Zeilen verschieben oder Variablen
    // einschleusen. Solche Einträge bleiben weg, statt die Datei zu
    // beschädigen.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(text)) {
      console.warn(
        `[hub] Container-Umgebungsvariable "${key}" ist für die env-Datei unbrauchbar – weggelassen.`,
      );
      continue;
    }
    lines.push(`${key}=${text}`);
  }
  if (!lines.length) return null;
  const path = join(tmpdir(), `bot-hub-exec-env-${randomUUID()}`);
  const fd = openSync(path, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${lines.join('\n')}\n`);
  } catch (error) {
    try {
      unlinkSync(path);
    } catch {
      /* Die ursprüngliche Meldung ist die relevante Diagnose. */
    }
    throw error;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* writeFileSync hat das Descriptor-Ende selbst behandelt. */
    }
  }
  return path;
};

/** Best-Effort-Löschen der env-Datei nach Abschluss des docker-CLI. */
export const cleanupExecEnvFile = (path) => {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT')
      console.warn(`[hub] exec-env-Datei blieb zurück: ${error.message}`);
  }
};

/**
 * `docker exec` für einen Befehl im Bot-Container. Die Umgebung läuft
 * über eine 0600-Datei (`--env-file`), niemals über die Argumentliste –
 * siehe `writeExecEnvFile`. Gibt `{ args, envFile }` zurück; `envFile`
 * ist nach Abschluss des spawns per `cleanupExecEnvFile` zu löschen.
 */
export const execArgs = (bot, projectRoot, dir, command, env = {}) => {
  const workspace = workspacePath(bot, projectRoot);
  const workdir = relative(workspace, dir);
  const dockerWorkdir =
    !workdir || workdir === '.' ? '/workspace' : `/workspace/${workdir}`;
  const args = ['exec', '--workdir', dockerWorkdir];
  const containerEnv = { ...env };
  const virtualEnv = containerEnv.VIRTUAL_ENV;
  let dockerVirtualEnv = '';
  if (virtualEnv) {
    const virtualEnvRelative = relative(workspace, virtualEnv);
    if (
      !virtualEnvRelative.startsWith('..') &&
      !virtualEnvRelative.includes('\0') &&
      !virtualEnvRelative.startsWith('/')
    ) {
      dockerVirtualEnv = `/workspace/${virtualEnvRelative}`;
      containerEnv.VIRTUAL_ENV = dockerVirtualEnv;
    } else {
      delete containerEnv.VIRTUAL_ENV;
    }
  }
  const systemPath = runtimeSystemPath(bot);
  if (containerEnv.PATH) {
    const venvPath = dockerVirtualEnv
      ? `${dockerVirtualEnv}/bin:${dockerVirtualEnv}/Scripts:`
      : '';
    containerEnv.PATH = `${venvPath}${systemPath}`;
  }
  // Do not pass the hub user's host home into a container running as a
  // numeric UID; npm otherwise tries to create /home/<host-user>.
  containerEnv.HOME = '/tmp/bot-home';
  containerEnv.XDG_CACHE_HOME = '/tmp/bot-home/.cache';
  containerEnv.npm_config_cache = '/tmp/bot-home/.npm';
  containerEnv.PIP_CACHE_DIR = '/tmp/bot-home/.cache/pip';
  containerEnv.CARGO_HOME = '/workspace/.cache/cargo';
  containerEnv.CARGO_TARGET_DIR = '/workspace/target';
  containerEnv.GOMODCACHE = '/workspace/.cache/go-mod';
  containerEnv.GOCACHE = '/workspace/.cache/go-build';
  containerEnv.GOPATH = '/workspace/.cache/go';
  // Docker erzwingt auf JEDEM --tmpfs zusätzlich noexec (daemon-verifiziert)
  // – 'go run' baut seine Binary nach /tmp und kann sie dort nicht starten
  // („fork/exec …: permission denied“). TMPDIR/GOTMPDIR verlegen Baurüste
  // in den Workspace, der ausführbar eingebunden ist (Maßnahme 34).
  containerEnv.TMPDIR = '/workspace/.cache/tmp';
  containerEnv.GOTMPDIR = '/workspace/.cache/tmp';
  containerEnv.DOTNET_CLI_HOME = '/workspace/.cache/dotnet-cli-home';
  try {
    // go akzeptiert kein fehlendes GOTMPDIR – Ordner vorab anlegen, ohne
    // einem Bot-Symlink zu folgen (Maßnahme 36).
    ensureWorkspaceDirNoFollow(workspace, '.cache', 'tmp');
  } catch {
    /* bleibt read-only, meldet go den Fehler selbst */
  }
  containerEnv.GRADLE_USER_HOME = '/workspace/.cache/gradle';
  containerEnv.MAVEN_OPTS = '-Dmaven.repo.local=/workspace/.cache/maven';
  containerEnv.NUGET_PACKAGES = '/workspace/.cache/nuget';
  if (
    process.env.NODE_ENV === 'production' &&
    containerNetwork() === PRODUCTION_BOT_NETWORK
  ) {
    // Nur Bibliotheken, die explizit Proxy-Umgebungsvariablen unterstützen,
    // nutzen diese automatisch. Das interne Netz verhindert den Direktweg.
    containerEnv.BOT_HUB_DISCORD_PROXY = DISCORD_EGRESS_PROXY;
    containerEnv.HTTPS_PROXY = DISCORD_EGRESS_PROXY;
    containerEnv.https_proxy = DISCORD_EGRESS_PROXY;
    containerEnv.HTTP_PROXY = DISCORD_EGRESS_PROXY;
    containerEnv.http_proxy = DISCORD_EGRESS_PROXY;
    // Das einzige direkte Ziel neben Discord ist die lokale, token-geschützte
    // Hub-API am Docker-Bridge-Gateway. nftables erlaubt dort nur TCP 8788.
    containerEnv.NO_PROXY = PRODUCTION_BOT_GATEWAY;
    containerEnv.no_proxy = PRODUCTION_BOT_GATEWAY;
    // Node 22.21+ routes its default HTTP(S) agents through HTTPS_PROXY.
    // Older runtimes ignore this and will fail closed on the internal network.
    containerEnv.NODE_USE_ENV_PROXY = '1';
  }
  // Ein im Workspace gefundenes Programm (Wrapper oder Preset-Binary wie
  // `./target/release/bot`) liegt im Container unter /workspace – der
  // Host-Pfad, den die Prüfung ergibt, gilt dort nicht. Die Prüfung muss
  // vor der Secret-Datei laufen: wirft sie, kennt der Aufrufer den
  // envFile-Pfad nie und die Datei bliebe in /tmp zurück.
  let executable = command.executable;
  if (isAbsolute(executable)) {
    const executableRelative = relative(workspace, executable);
    if (executableRelative.startsWith('..') || isAbsolute(executableRelative))
      throw new Error('Startprogramm liegt außerhalb des Bot-Workspace.');
    executable = `/workspace/${executableRelative}`;
  }
  const envFile = writeExecEnvFile(containerEnv);
  if (envFile) args.push('--env-file', envFile);
  args.push(nameOf(bot), executable, ...command.args);
  return { args, envFile };
};

/* dotnet SDK: Zwei Fallen in der Sandbox. (1) Das Bild trägt sein
 * Erststart-Sentinel unter /root – ein Runner mit anderer UID würde den
 * CLI-Konfigurator starten. (2) NuGet prüft vor jeder Aktion einen globalen
 * Mutex „NuGet-Migrations“; dem Namen fehlt der führende Slash, .NET mappt
 * ihn auf /dev/Null→NuGet-Migrations → ENXIO („cannot open the device or
 * file specified“) – in dieser Laufzeit kann der Aufruf NIEMALS gelingen,
 * weder mit Capabilities noch ohne Seccomp. Einziger Ausweg: existiert der
 * Migrations-Marker $XDG_DATA_HOME/NuGet/Migrations/1, ist der Läufer
 * komplett no-op (NuGet-Quellcode belegt). Beide Dateien legt ein
 * interner root-Lauf vor dem ersten Build an: versionstreue Sentinel aus
 * dem Bild, Marker als leere Datei; cp -n idempotent und chown gibt alles
 * an den Workspace-Eigentümer – root-eigene Reste würden sonst den
 * Lösch-Cleanup blockieren (Maßnahme 32/35). */
export const ensureDotnetCliHome = async (bot, projectRoot) => {
  const workspace = workspacePath(bot, projectRoot);
  /* Maßnahme 51: Vorher wurde ein Fehler der Symlink-Prüfung hier
   * geschluckt und der ROOT-Lauf trotzdem gestartet – dabei ist genau der
   * Schutzloseste Fall ("Prüfung konnte nicht durchgreifen") der Grund, ihn
   * bleiben zu lassen. Der root-Einlauf ohne geprüfte Pfade ist genau der
   * Angriffsvektor, den die Prüfung abschneidet. Jetzt: Prüfung schlägt
   * fehl -> kein root-Lauf; das nächste dotnet-Kommando meldet den echten
   * Grund. */
  try {
    ensureWorkspaceDirNoFollow(
      workspace,
      '.cache',
      'dotnet-cli-home',
      '.dotnet',
    );
    ensureWorkspaceDirNoFollow(
      workspace,
      '.cache',
      'xdg-data',
      'NuGet',
      'Migrations',
    );
  } catch (error) {
    console.warn(
      `[hub] .NET-Init-Lauf übersprungen – Workspace-Pfade nicht sicher anlegbar (${error.message}).`,
    );
    return;
  }
  const args = [
    'run',
    '--rm',
    '--name',
    `bot-hub-dotnet-init-${randomUUID()}`,
    '--entrypoint',
    'sh',
    // Maßnahme 51: root ist hier Absicht (Sentinel aus /root des Bildes),
    // also wird es fest gesetzt statt der Bild-Vorgabe zu vertrauen – ein
    // Bild mit Nicht-Root-Default konnte die Init bisher still scheitern
    // lassen. Das Skript selbst prüft JEDEN Pfadteil erneut auf Symlinks
    // (doppelte Boden: die Host-Prüfung oben ist nur die eine Hälfte) und
    // chown folgt keinen Verweisen (-h: der Link selbst, nie sein Ziel).
    '--user',
    '0:0',
    '--network',
    'none',
    '-v',
    `${workspace}:/workspace`,
    imageOf(bot),
    '-c',
    [
      'set -e',
      'for d in /workspace/.cache /workspace/.cache/dotnet-cli-home ' +
        '/workspace/.cache/dotnet-cli-home/.dotnet /workspace/.cache/xdg-data ' +
        '/workspace/.cache/xdg-data/NuGet ' +
        '/workspace/.cache/xdg-data/NuGet/Migrations; do',
      '  [ ! -L "$d" ] || exit 1',
      '  mkdir -p "$d"',
      '  [ ! -L "$d" ] || exit 1',
      'done',
      'm=/workspace/.cache/xdg-data/NuGet/Migrations/1',
      '[ ! -L "$m" ] || exit 1',
      'find /root/.dotnet -maxdepth 1 \\( -name "*.dotnetFirstUseSentinel" -o -name "*.toolpath.sentinel" \\) -exec cp -n {} /workspace/.cache/dotnet-cli-home/.dotnet/ \\;',
      'touch "$m"',
      'chown -Rh "$(stat -c %u /workspace)":$(stat -c %g /workspace) ' +
        '/workspace/.cache/dotnet-cli-home /workspace/.cache/xdg-data',
    ].join('\n'),
  ];
  try {
    await run(args);
  } catch {
    /* Kein Sentinel oder Docker-Fehler: weiterlaufen lassen, das nächste
     * dotnet-Kommando meldet den echten Grund ins Bot-Protokoll. */
  }
};

/**
 * Kurzlebiger Paket-Runner: nur Workspace, keine Bot-Secrets, nur das interne
 * Paketnetz. Der normale Bot-Container erhält dieses Netz niemals.
 */
export const dependencyRunArgs = (bot, projectRoot, dir, command, env = {}) => {
  if (process.env.NODE_ENV !== 'production')
    throw new Error(
      'Der isolierte Paket-Runner ist nur für Produktion gedacht.',
    );
  const workspace = workspacePath(bot, projectRoot);
  const workdir = relative(workspace, dir);
  const dockerWorkdir =
    !workdir || workdir === '.' ? '/workspace' : `/workspace/${workdir}`;
  const containerEnv = { ...env };
  const virtualEnv = containerEnv.VIRTUAL_ENV;
  let dockerVirtualEnv = '';
  if (virtualEnv) {
    const virtualEnvRelative = relative(workspace, virtualEnv);
    if (
      !virtualEnvRelative.startsWith('..') &&
      !virtualEnvRelative.includes('\0') &&
      !virtualEnvRelative.startsWith('/')
    ) {
      dockerVirtualEnv = `/workspace/${virtualEnvRelative}`;
      containerEnv.VIRTUAL_ENV = dockerVirtualEnv;
    } else {
      delete containerEnv.VIRTUAL_ENV;
    }
  }
  if (containerEnv.PATH) {
    const venvPath = dockerVirtualEnv
      ? `${dockerVirtualEnv}/bin:${dockerVirtualEnv}/Scripts:`
      : '';
    containerEnv.PATH = `${venvPath}${runtimeSystemPath(bot)}`;
  }
  let executable = command.executable;
  if (isAbsolute(executable)) {
    const executableRelative = relative(workspace, executable);
    if (executableRelative.startsWith('..') || isAbsolute(executableRelative))
      throw new Error('Installer-Programm liegt außerhalb des Bot-Workspace.');
    executable = `/workspace/${executableRelative}`;
  }
  Object.assign(containerEnv, {
    HOME: '/tmp/bot-home',
    XDG_CACHE_HOME: '/workspace/.cache',
    npm_config_cache: '/workspace/.cache/npm',
    PIP_CACHE_DIR: '/workspace/.cache/pip',
    HTTPS_PROXY: DEPENDENCY_EGRESS_PROXY,
    https_proxy: DEPENDENCY_EGRESS_PROXY,
    HTTP_PROXY: DEPENDENCY_EGRESS_PROXY,
    http_proxy: DEPENDENCY_EGRESS_PROXY,
    NO_PROXY: '',
    no_proxy: '',
    NODE_USE_ENV_PROXY: '1',
    CARGO_HTTP_PROXY: DEPENDENCY_EGRESS_PROXY,
    CARGO_HOME: '/workspace/.cache/cargo',
    CARGO_TARGET_DIR: '/workspace/target',
    GOMODCACHE: '/workspace/.cache/go-mod',
    GOCACHE: '/workspace/.cache/go-build',
    TMPDIR: '/workspace/.cache/tmp',
    GOTMPDIR: '/workspace/.cache/tmp',
    DOTNET_CLI_HOME: '/workspace/.cache/dotnet-cli-home',
    // NuGet schreibt Migrations-Marker nach $XDG_DATA_HOME (siehe
    // ensureDotnetCliHome); ohne Marker crasht jede Restore-Aktion am
    // namenslosen Unix-Mutex.
    XDG_DATA_HOME: '/workspace/.cache/xdg-data',
    // Das golang-Bild setzt GOPATH=/go (read-only Rootfs) – die Sumdb-Ablage
    // (/go/pkg/sumdb) braucht ein schreibbares Ziel, sonst scheitert jede
    // Modulverifikation (Bug 30).
    GOPATH: '/workspace/.cache/go',
    GOPROXY: 'https://proxy.golang.org',
    GOSUMDB: 'sum.golang.org',
    GRADLE_USER_HOME: '/workspace/.cache/gradle',
    MAVEN_OPTS: '-Dmaven.repo.local=/workspace/.cache/maven',
    NUGET_PACKAGES: '/workspace/.cache/nuget',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    JAVA_TOOL_OPTIONS:
      '-Dhttp.proxyHost=172.30.251.1 -Dhttp.proxyPort=3128 -Dhttps.proxyHost=172.30.251.1 -Dhttps.proxyPort=3128',
  });
  for (const key of [
    'DISCORD_BOT_TOKEN',
    'BOT_HUB_API_TOKEN',
    'BOT_HUB_RUNTIME_TOKEN',
  ])
    delete containerEnv[key];
  // Maßnahme 31: einziger Proxy-Kanal, den Maven 3.9s Native-Transport
  // akzeptiert, ist eine settings.xml. Sie enthält keine Geheimnisse (nur
  // die interne Paket-Proxy-Adresse) und liegt im Workspace, das Verzeichnis
  // ist dem Container ohnehin als /workspace bekannt.
  try {
    ensureWorkspaceDirNoFollow(workspace, '.bot-hub');
    ensureWorkspaceDirNoFollow(workspace, '.cache', 'tmp');
    writeWorkspaceFileNoFollow(
      join(workspace, '.bot-hub', 'maven-settings.xml'),
      MAVEN_SETTINGS_CONTENT,
    );
  } catch {
    /* read-only Workspace: Maven meldet den Fehler selbst ins Bot-Protokoll */
  }
  containerEnv.MAVEN_ARGS = '-s /workspace/.bot-hub/maven-settings.xml';
  const envFile = writeExecEnvFile(containerEnv);
  const containerName = `bot-hub-deps-${randomUUID()}`;
  const args = [
    'run',
    '--rm',
    '--name',
    containerName,
    '--init',
    '--network',
    PRODUCTION_DEPENDENCY_NETWORK,
    '--user',
    containerUser(),
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '256',
    '--memory',
    process.env.BOT_HUB_CONTAINER_MEMORY || '512m',
    '--cpus',
    process.env.BOT_HUB_CONTAINER_CPUS || '2',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=256m',
    '--workdir',
    dockerWorkdir,
  ];
  if (envFile) args.push('--env-file', envFile);
  args.push(
    '--volume',
    `${workspace}:/workspace`,
    '--label',
    'bot-hub.dependency-install=true',
    '--entrypoint',
    executable,
    imageOf(bot),
    ...command.args,
  );
  return { args, envFile, containerName };
};

export const containerRuntimeName = () => RUNTIME;
export const containerHubUrl = () => {
  if (process.env.NODE_ENV === 'production')
    return `http://${PRODUCTION_BOT_GATEWAY}:${PRODUCTION_BOT_HUB_PORT}`;
  const localUrl = getLocalBotApiUrl();
  if (!localUrl)
    throw new Error(
      'Die lokale Bot-API-Adresse ist erst nach erfolgreicher Prüfung der Docker-Netzwerkisolation verfügbar.',
    );
  return localUrl;
};
export const containerRuntimeEnabled = () =>
  process.env.BOT_HUB_TEST_MODE !== '1' &&
  process.env.BOT_HUB_CONTAINER_MODE !== 'disabled';

/** Nur für den Start-Check und die Tests. */
export const containerSecurityFacts = () => ({
  hubRunsAsRoot: hubRunsAsRoot(),
  containerUser: containerUser(),
  containerNetwork: containerNetwork(),
  discordProxyUrl: DISCORD_EGRESS_PROXY,
  unpinnedImages: unpinnedImages(),
  digestRequired: digestRequired(),
  containerRuntimeEnabled: containerRuntimeEnabled(),
  localNetworkVerified:
    process.env.NODE_ENV === 'production' ||
    process.env.NODE_ENV === 'test' ||
    !containerRuntimeEnabled() ||
    getVerifiedLocalBotNetwork() !== null,
});
