import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

let root;
let bot;
let containers;
let createArgs;

const label = (args) =>
  args[args.findIndex((item) => item.startsWith('bot-hub.config='))] ?? '';
const mounts = (args) =>
  args.filter((item, index) => args[index - 1] === '--volume');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'bot-hub-container-'));
  mkdirSync(join(root, 'bots', 'shared'), { recursive: true });
  mkdirSync(join(root, 'bots', 'bot1', 'workspace'), { recursive: true });
  bot = {
    id: 'bot1',
    language: 'python',
    workspaceRoot: 'bots/bot1/workspace',
  };
  containers = await import('../server/containers.js');
  createArgs = containers.containerCreateArgs(bot, root);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Container-Isolation', () => {
  it('gibt dem Container keine erhöhten Rechte', () => {
    const joined = createArgs.join(' ');
    assert.ok(!createArgs.includes('--privileged'));
    assert.ok(!joined.includes('docker.sock'));
    assert.ok(!joined.includes('--network'));
    assert.ok(!joined.includes('--pid=host'));
    assert.ok(createArgs.includes('ALL'), 'cap-drop ALL fehlt');
    assert.ok(joined.includes('no-new-privileges:true'));
    assert.ok(createArgs.includes('--init'));
    assert.ok(createArgs.includes(process.getuid() + ':' + process.getgid()));
    assert.ok(createArgs.includes('256'), 'pids-limit fehlt');
    assert.ok(createArgs.includes('512m'), 'Speichergrenze fehlt');
    assert.ok(createArgs.includes('2'), 'CPU-Grenze fehlt');
  });

  it('hängt nur den eigenen Workspace und die geteilte Bibliothek ein', () => {
    assert.deepEqual(
      mounts(createArgs),
      [
        `${join(root, 'bots', 'bot1', 'workspace')}:/workspace`,
        `${join(root, 'bots', 'shared')}:/shared:ro`,
      ],
      'unerwartete Mounts',
    );
  });

  it('gibt dem Bot keinen Weg zum Host, solange keiner konfiguriert ist', () => {
    assert.ok(!createArgs.includes('--add-host'));
  });

  it('kennzeichnet seine Konfiguration, damit alte Container ersetzt werden', () => {
    assert.match(label(createArgs), /^bot-hub\.config=[a-f0-9]{16}$/);
    // Gleiche Eingabe -> gleiche Kennung.
    assert.equal(
      label(containers.containerCreateArgs(bot, root)),
      label(createArgs),
    );
    // Anderes Bild -> andere Kennung.
    const other = containers.containerCreateArgs(
      { ...bot, language: 'go' },
      root,
    );
    assert.notEqual(label(other), label(createArgs));
  });
});

describe('Container-URL aktiviert den Weg zum Host', () => {
  let withHost;
  before(async () => {
    process.env.BOT_HUB_CONTAINER_URL = 'http://host.docker.internal:8787';
    // Frisches Modul, weil die Konfiguration einmalig gelesen wird.
    const module = await import(`../server/containers.js?v=${Date.now()}`);
    withHost = module.containerCreateArgs(bot, root);
    delete process.env.BOT_HUB_CONTAINER_URL;
  });

  it('mappt host.docker.internal nur auf Wunsch', () => {
    assert.ok(withHost.includes('--add-host'));
    assert.ok(withHost.includes('host.docker.internal:host-gateway'));
  });
});

describe('Bilder auf eine Digest-Version festnageln', () => {
  const withImages = async (value) => {
    process.env.BOT_HUB_CONTAINER_IMAGES = value;
    const module = await import(`../server/containers.js?v=${Math.random()}`);
    delete process.env.BOT_HUB_CONTAINER_IMAGES;
    return module.containerImage({ language: 'python' });
  };

  it('übernimmt eine gültige Referenz', async () => {
    const digest = 'a'.repeat(64);
    assert.equal(
      await withImages(
        JSON.stringify({ python: `python:3.12-bookworm@sha256:${digest}` }),
      ),
      `python:3.12-bookworm@sha256:${digest}`,
    );
  });

  it('ignoriert ungültige Werte', async () => {
    for (const value of [
      '{kein json',
      JSON.stringify({ python: 'python:3.12; rm -rf /' }),
      JSON.stringify({ python: '--entrypoint=sh' }),
      JSON.stringify({ python: '../../evil' }),
      JSON.stringify({ java: 'eclipse-temurin:17-jdk' }),
      JSON.stringify(['nope']),
    ])
      assert.equal(await withImages(value), 'python:3.12-bookworm', value);
  });
});
