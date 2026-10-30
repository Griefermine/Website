import { spawn } from 'node:child_process';
import { isIPv4 } from 'node:net';

export const LOCAL_BOT_NETWORK = 'bot-hub-local';
export const LOCAL_BOT_HUB_PORT = 8788;
export const LOCAL_FIREWALL_CHECKER =
  '/usr/local/sbin/bot-hub-local-network-firewall';

let verifiedNetwork = null;

const runCommand = (command, args) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.once('error', (error) =>
      resolve({ code: -1, stdout, stderr: error.message }),
    );
    child.once('exit', (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
  });

const validIpv4Cidr = (value) => {
  if (typeof value !== 'string') return false;
  const [address, prefix, extra] = value.split('/');
  return (
    extra === undefined &&
    isIPv4(address) &&
    /^\d{1,2}$/.test(prefix ?? '') &&
    Number(prefix) >= 1 &&
    Number(prefix) <= 30
  );
};

const networkFailure = (detail) =>
  new Error(
    'Lokale Docker-Netzwerkisolation ist nicht aktiv. ' +
      'Starte zuerst „sudo bash scripts/setup-local-network.sh“ und prüfe ' +
      'documents/local-docker-network-isolation.md. ' +
      detail,
  );

/**
 * Prüft die vom Setup-Skript angelegte lokale Docker-Bridge und die dazu
 * gehörenden Host-Firewallregeln. Es wird nichts automatisch abgeschwächt
 * oder auf das Standardnetz „bridge“ zurückgestellt.
 *
 * Docker Desktop, Podman, Rootless Docker und Docker mit nativem nftables-
 * Backend werden in diesem ersten lokalen Profil bewusst nicht freigegeben.
 */
export const validateLocalBotNetwork = async ({
  env = process.env,
  platform = process.platform,
  uid = process.getuid?.(),
  run = runCommand,
} = {}) => {
  if (
    env.NODE_ENV === 'production' ||
    env.NODE_ENV === 'test' ||
    env.BOT_HUB_TEST_MODE === '1' ||
    env.BOT_HUB_CONTAINER_MODE === 'disabled'
  )
    return null;

  if (platform !== 'linux')
    throw networkFailure(
      'Unterstützt wird vorerst nur Docker Engine auf nativem Linux.',
    );

  const runtime = String(env.BOT_HUB_CONTAINER_RUNTIME || 'docker').trim();
  if (runtime !== 'docker')
    throw networkFailure(
      'Das lokale Isolationsprofil benötigt Docker Engine; andere Runtimes sind noch nicht freigegeben.',
    );

  const configuredNetwork = String(
    env.BOT_HUB_CONTAINER_NETWORK ?? '',
  ).trim();
  if (configuredNetwork && configuredNetwork !== LOCAL_BOT_NETWORK)
    throw networkFailure(
      `BOT_HUB_CONTAINER_NETWORK muss im lokalen Profil „${LOCAL_BOT_NETWORK}“ sein.`,
    );

  if (String(env.BOT_HUB_CONTAINER_URL ?? '').trim())
    throw networkFailure(
      'BOT_HUB_CONTAINER_URL ist nicht mehr zulässig, weil host.docker.internal den Zugriff auf beliebige Host-Dienste öffnen kann. Entferne die Variable.',
    );

  const inspected = await run(runtime, [
    'network',
    'inspect',
    '--format',
    '{{json .}}',
    LOCAL_BOT_NETWORK,
  ]);
  if (inspected.code !== 0)
    throw networkFailure(
      `Docker-Netz „${LOCAL_BOT_NETWORK}“ konnte nicht geprüft werden: ${inspected.stderr.trim() || 'Netzwerk fehlt'}.`,
    );

  let network;
  try {
    network = JSON.parse(inspected.stdout);
  } catch {
    throw networkFailure('Docker lieferte keine lesbare Netzwerk-Konfiguration.');
  }

  const options = network?.Options ?? {};
  const ipam = network?.IPAM?.Config ?? [];
  const addressing = ipam.length === 1 ? ipam[0] : null;
  const subnet = addressing?.Subnet;
  const gateway = addressing?.Gateway;
  const bridge =
    options['com.docker.network.bridge.name'] ||
    (typeof network?.Id === 'string'
      ? `br-${network.Id.slice(0, 12)}`
      : '');

  const valid =
    network?.Name === LOCAL_BOT_NETWORK &&
    network?.Driver === 'bridge' &&
    network?.Internal === false &&
    network?.EnableIPv6 === false &&
    network?.Labels?.['com.bothub.security-profile'] === 'local-v1' &&
    options['com.docker.network.bridge.enable_icc'] === 'false' &&
    options['com.docker.network.bridge.enable_ip_masquerade'] === 'true' &&
    validIpv4Cidr(subnet) &&
    isIPv4(gateway) &&
    /^[A-Za-z0-9_.-]{1,15}$/.test(bridge);

  if (!valid)
    throw networkFailure(
      `Das Docker-Netz „${LOCAL_BOT_NETWORK}“ hat nicht die erwarteten IPv4-, ICC-, Masquerading- und IPv6-Einstellungen. Es wird nicht automatisch verändert.`,
    );

  const checkerCommand =
    uid === 0 ? LOCAL_FIREWALL_CHECKER : '/usr/bin/sudo';
  const checkerArgs =
    uid === 0
      ? ['check']
      : ['-n', LOCAL_FIREWALL_CHECKER, 'check'];
  const firewall = await run(checkerCommand, checkerArgs);
  if (firewall.code !== 0)
    throw networkFailure(
      'Die Host-Firewall konnte ihre Regeln nicht bestätigen. ' +
        (firewall.stderr.trim() || firewall.stdout.trim() || 'Prüfer fehlt oder Regeln sind unvollständig.'),
    );

  verifiedNetwork = Object.freeze({
    name: LOCAL_BOT_NETWORK,
    bridge,
    subnet,
    gateway,
  });
  return verifiedNetwork;
};

export const getVerifiedLocalBotNetwork = () => verifiedNetwork;
export const getLocalBotApiUrl = () =>
  verifiedNetwork
    ? `http://${verifiedNetwork.gateway}:${LOCAL_BOT_HUB_PORT}`
    : null;

/** Nur für isolierte Unit-Tests: Cache zwischen Testfällen zurücksetzen. */
export const __resetLocalBotNetworkForTests = () => {
  verifiedNetwork = null;
};
