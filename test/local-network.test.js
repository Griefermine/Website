import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_BOT_NETWORK,
  __resetLocalBotNetworkForTests,
  getLocalBotApiUrl,
  validateLocalBotNetwork,
} from '../server/localNetwork.js';

const validNetwork = () => ({
  Name: LOCAL_BOT_NETWORK,
  Id: '1234567890ab'.padEnd(64, '0'),
  Driver: 'bridge',
  Internal: false,
  EnableIPv6: false,
  Labels: { 'com.bothub.security-profile': 'local-v1' },
  Options: {
    'com.docker.network.bridge.enable_icc': 'false',
    'com.docker.network.bridge.enable_ip_masquerade': 'true',
  },
  IPAM: {
    Config: [{ Subnet: '172.28.0.0/16', Gateway: '172.28.0.1' }],
  },
});

const validEnv = {
  NODE_ENV: 'development',
  BOT_HUB_CONTAINER_RUNTIME: 'docker',
};

test('lokales Profil verlangt das eigene Bridge-Netz und den Firewall-Prüfer', async () => {
  __resetLocalBotNetworkForTests();
  const calls = [];
  const verified = await validateLocalBotNetwork({
    env: validEnv,
    platform: 'linux',
    uid: 1000,
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'network')
        return { code: 0, stdout: JSON.stringify(validNetwork()), stderr: '' };
      return { code: 0, stdout: 'OK', stderr: '' };
    },
  });

  assert.equal(verified.name, LOCAL_BOT_NETWORK);
  assert.equal(verified.gateway, '172.28.0.1');
  assert.equal(getLocalBotApiUrl(), 'http://172.28.0.1:8788');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [
    '/usr/bin/sudo',
    ['-n', '/usr/local/sbin/bot-hub-local-network-firewall', 'check'],
  ]);
  __resetLocalBotNetworkForTests();
});

test('fehlende ICC-Isolation wird fail-closed abgelehnt', async () => {
  const bad = validNetwork();
  bad.Options['com.docker.network.bridge.enable_icc'] = 'true';
  await assert.rejects(
    validateLocalBotNetwork({
      env: validEnv,
      platform: 'linux',
      uid: 0,
      run: async () => ({
        code: 0,
        stdout: JSON.stringify(bad),
        stderr: '',
      }),
    }),
    /nicht die erwarteten IPv4-, ICC-/,
  );
});

test('interne Bridge ohne Internet-Masquerading wird abgelehnt', async () => {
  const bad = validNetwork();
  bad.Internal = true;
  await assert.rejects(
    validateLocalBotNetwork({
      env: validEnv,
      platform: 'linux',
      uid: 0,
      run: async () => ({
        code: 0,
        stdout: JSON.stringify(bad),
        stderr: '',
      }),
    }),
    /nicht die erwarteten IPv4-, ICC-/,
  );
});

test('Firewall-Ausfall verhindert die Freigabe des lokalen Netzes', async () => {
  await assert.rejects(
    validateLocalBotNetwork({
      env: validEnv,
      platform: 'linux',
      uid: 0,
      run: async (_command, args) =>
        args[0] === 'network'
          ? { code: 0, stdout: JSON.stringify(validNetwork()), stderr: '' }
          : { code: 1, stdout: '', stderr: 'missing rule' },
    }),
    /Host-Firewall konnte ihre Regeln nicht bestätigen/,
  );
});

test('nicht freigegebene Plattformen und Runtimes fallen nicht auf bridge zurück', async () => {
  await assert.rejects(
    validateLocalBotNetwork({
      env: validEnv,
      platform: 'win32',
      uid: 0,
      run: async () => {
        throw new Error('darf nicht aufgerufen werden');
      },
    }),
    /nur Docker Engine auf nativem Linux/,
  );
  await assert.rejects(
    validateLocalBotNetwork({
      env: { ...validEnv, BOT_HUB_CONTAINER_RUNTIME: 'podman' },
      platform: 'linux',
      uid: 0,
      run: async () => {
        throw new Error('darf nicht aufgerufen werden');
      },
    }),
    /benötigt Docker Engine/,
  );
});

test('test- und deaktivierter Container-Modus verlangen keine Host-Firewall', async () => {
  assert.equal(
    await validateLocalBotNetwork({
      env: { NODE_ENV: 'test' },
      platform: 'win32',
    }),
    null,
  );
  assert.equal(
    await validateLocalBotNetwork({
      env: { ...validEnv, BOT_HUB_CONTAINER_MODE: 'disabled' },
      platform: 'win32',
    }),
    null,
  );
});

test('alte Host-Gateway-Freigabe und fremde lokale Netzwerknamen werden abgelehnt', async () => {
  await assert.rejects(
    validateLocalBotNetwork({
      env: { ...validEnv, BOT_HUB_CONTAINER_URL: 'http://host.docker.internal:8787' },
      platform: 'linux',
      uid: 0,
    }),
    /BOT_HUB_CONTAINER_URL ist nicht mehr zulässig/,
  );
  await assert.rejects(
    validateLocalBotNetwork({
      env: { ...validEnv, BOT_HUB_CONTAINER_NETWORK: 'bridge' },
      platform: 'linux',
      uid: 0,
    }),
    /BOT_HUB_CONTAINER_NETWORK muss/,
  );
});
