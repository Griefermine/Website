import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

/**
 * Startet den Hub wie im Betrieb und liefert Exit-Code + Ausgabe. Die
 * Abbruchprüfungen laufen vor dem Listen, deshalb wird hier nichts gebunden.
 */
const startHub = (env) =>
  new Promise((resolve) => {
    const { child, out } = spawnHub(env);
    child.once('exit', (code) => resolve({ code, out: out() }));
    // Sicherheitsnetz: ein Hub, der startet, wird nach kurzer Zeit beendet.
    setTimeout(() => child.kill('SIGKILL'), 6000).unref();
  });

const spawnHub = (env) => {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BOT_DASHBOARD_ROOT: join(ROOT, 'test', '.startup'),
      PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout.on('data', (data) => (text += data));
  child.stderr.on('data', (data) => (text += data));
  return { child, out: () => text };
};

/**
 * Für Hub-Varianten, die selbst starten: auf die erste Ausgabe warten und den
 * Prozess danach beenden. Schneller als auf das (nicht eintretende) Ende.
 */
const startAndRead = async (env) => {
  const { child, out } = spawnHub(env);
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Hub startete nicht')), 6000),
      ),
    ]);
    return out();
  } finally {
    child.kill('SIGKILL');
  }
};

describe('Startschutz für unsichere Konfiguration', () => {
  it('verweigert den Testmodus, wenn NODE_ENV nicht gesetzt ist', async () => {
    const { code, out } = await startHub({ BOT_HUB_TEST_MODE: '1' });
    assert.equal(code, 1);
    assert.match(out, /ABBRUCH: BOT_HUB_TEST_MODE/);
    assert.match(out, /NODE_ENV ist nicht gesetzt/);
  });

  it('verweigert den Testmodus in Produktion', async () => {
    const { code, out } = await startHub({
      BOT_HUB_TEST_MODE: '1',
      NODE_ENV: 'production',
    });
    assert.equal(code, 1);
    assert.match(out, /ABBRUCH: BOT_HUB_TEST_MODE/);
    assert.match(out, /NODE_ENV=test/);
  });

  it('verweigert Container-Betrieb in Produktion nicht – aber ohne Container auch nicht', async () => {
    const { code, out } = await startHub({
      NODE_ENV: 'production',
      BOT_HUB_CONTAINER_MODE: 'disabled',
    });
    assert.equal(code, 1);
    assert.match(out, /ABBRUCH: BOT_HUB_CONTAINER_MODE=disabled/);
  });

  it('startet mit Testmodus, wenn NODE_ENV=test gesetzt ist', async () => {
    const out = await startAndRead({
      NODE_ENV: 'test',
      BOT_HUB_TEST_MODE: '1',
    });
    assert.match(out, /Bot-Hub/);
    assert.ok(!out.includes('ABBRUCH'));
  });

  it('warnt, wenn Bot-Prozesse den Hub nicht erreichen können', async () => {
    const ohneUrl = await startAndRead({
      BOT_HUB_URL: 'http://127.0.0.1:8787',
    });
    assert.match(ohneUrl, /BOT_HUB_CONTAINER_URL ist nicht gesetzt/);
    assert.match(ohneUrl, /127\.0\.0\.1 im Container/);

    const mitUrl = await startAndRead({
      BOT_HUB_URL: 'http://127.0.0.1:8787',
      BOT_HUB_CONTAINER_URL: 'http://host.docker.internal:8787',
    });
    assert.ok(
      !mitUrl.includes('BOT_HUB_CONTAINER_URL ist nicht gesetzt'),
      'Hinweis erscheint trotz gesetzter Container-URL',
    );
  });
});
