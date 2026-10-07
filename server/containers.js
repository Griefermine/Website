import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { managedConfig, managedMySqlActive } from './mysql.js';

const RUNTIME = process.env.BOT_HUB_CONTAINER_RUNTIME || 'docker';
const PREFIX = process.env.BOT_HUB_CONTAINER_PREFIX || 'bot-hub';

const BASE_IMAGES = {
  python: 'python:3.12-bookworm',
  javascript: 'node:22-bookworm',
  typescript: 'node:22-bookworm',
  java: 'eclipse-temurin:17-jdk',
  kotlin: 'eclipse-temurin:17-jdk',
  go: 'golang:1.24-bookworm',
  csharp: 'mcr.microsoft.com/dotnet/sdk:8.0',
  rust: 'rust:1-bookworm',
  custom: 'ubuntu:24.04',
};

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
 * Nur wenn `BOT_HUB_CONTAINER_URL` gesetzt ist, bekommt der Container einen
 * Weg zum Host. Der Eintrag `host.docker.internal` erlaubt einem Bot nämlich
 * jeden Dienst auf dem Host – auch SSH und andere lokal laufende Programme.
 * Wer ihn nicht braucht, bekommt ihn nicht; wer ihn braucht, konfiguriert
 * ausdrücklich eine Container-URL. Eine Firewall je Container gibt es mit
 * Bordmitteln nicht, das bleibt eine Randnotiz in documents/container-bots.md.
 */
const hostMapping = () =>
  String(process.env.BOT_HUB_CONTAINER_URL ?? '').trim()
    ? ['--add-host', 'host.docker.internal:host-gateway']
    : [];

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
  '--pids-limit',
  '256',
  '--memory',
  process.env.BOT_HUB_CONTAINER_MEMORY || '512m',
  '--cpus',
  process.env.BOT_HUB_CONTAINER_CPUS || '2',
  '--workdir',
  '/workspace',
  '--label',
  `bot-hub.config=${containerSignature(bot, projectRoot)}`,
  ...hostMapping(),
  '--volume',
  `${workspacePath(bot, projectRoot)}:/workspace`,
  ...sharedVolume(projectRoot),
  imageOf(bot),
  'tail',
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
  const systemPath =
    '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
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
  for (const [key, value] of Object.entries(containerEnv)) {
    if (value !== undefined) args.push('--env', `${key}=${value}`);
  }
  args.push(nameOf(bot), command.executable, ...command.args);
  return args;
};

export const containerRuntimeName = () => RUNTIME;
export const containerRuntimeEnabled = () =>
  process.env.BOT_HUB_TEST_MODE !== '1' &&
  process.env.BOT_HUB_CONTAINER_MODE !== 'disabled';

/** Nur für den Start-Check und die Tests. */
export const containerSecurityFacts = () => ({
  hubRunsAsRoot: hubRunsAsRoot(),
  containerUser: containerUser(),
  unpinnedImages: unpinnedImages(),
  digestRequired: digestRequired(),
});
