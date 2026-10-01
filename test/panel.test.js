import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root;
let baseUrl;
let server;

const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, data: await response.json() };
};

const callWithToken =
  (token) =>
  (path, options = {}) =>
    call(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
    });

const createBot = async (body) =>
  (await call('/bots', { method: 'POST', body })).data.bot;

const waitFor = async (id, wanted, timeout = 20000) => {
  const started = Date.now();
  for (;;) {
    const { data } = await call(`/bots/${id}`);
    if (wanted.includes(data.bot.status)) return data.bot;
    if (Date.now() - started > timeout)
      throw new Error(`Timeout: Status ${data.bot.status}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
};

const logText = async (id) => {
  const { data } = await call(`/bots/${id}/logs?tail=100`);
  return data.lines.map((line) => line.text);
};

/** Liest den SSE-Strom des Bots bis `count` Settings-Ereignisse da sind. */
const readBotEvents = async (token, count, timeout = 6000) => {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/hub/events`, {
    headers: { 'x-bot-hub-token': token },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  const stop = setTimeout(() => controller.abort(), timeout);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      frames.push(decoder.decode(value));
      if ((frames.join('').match(/event: settings/g) ?? []).length >= count)
        break;
    }
  } catch {
    /* Abbruch nach Timeout */
  } finally {
    clearTimeout(stop);
    controller.abort();
  }
  return frames.join('');
};

const MANIFEST = {
  hub: {
    panel: {
      title: 'Demo-Seite',
      icon: '🧪',
      description: 'Testmanifest',
      entry: 'page.html',
      pages: [{ id: 'extra', label: 'Extra', href: 'extra.html' }],
      settings: [
        { key: 'log_channel', type: 'text', label: 'Kanal', default: 'ops' },
        { key: 'cooldown', type: 'number', label: 'Cooldown', default: 5 },
        { key: 'auto', type: 'boolean', label: 'Auto', default: true },
        {
          key: 'mode',
          type: 'select',
          label: 'Modus',
          default: 'safe',
          options: ['safe', 'fast'],
        },
        { key: 'api_key', type: 'secret', label: 'API-Key' },
      ],
      commands: [
        { id: 'ping', label: 'Ping', run: 'echo pong' },
        { id: 'leer', label: 'Ohne Skript' },
      ],
    },
  },
};

before(async () => {
  process.env.BOT_HUB_TEST_MODE = '1';
  root = mkdtempSync(join(tmpdir(), 'bot-hub-panel-'));
  mkdirSync(join(root, 'worker'));
  mkdirSync(join(root, 'nackt'));
  writeFileSync(
    join(root, 'worker', 'bot.sh'),
    'echo "hub=$BOT_HUB_URL"\necho "token=$BOT_HUB_TOKEN"\necho "settings=$BOT_HUB_SETTINGS"\necho "setting=$BOT_HUB_SETTING_LOG_CHANNEL"\nsleep 30\n',
  );
  writeFileSync(join(root, 'worker', 'bot-hub.json'), JSON.stringify(MANIFEST));
  writeFileSync(
    join(root, 'worker', 'page.html'),
    '<!doctype html><h1>Seite</h1>',
  );
  writeFileSync(
    join(root, 'worker', 'panel.css'),
    'body { background: rgb(1, 2, 3); }',
  );
  mkdirSync(join(root, 'worker', 'panel'));
  writeFileSync(
    join(root, 'worker', 'panel', 'index.html'),
    '<!doctype html><link rel="stylesheet" href="panel.css">',
  );
  writeFileSync(
    join(root, 'worker', 'panel', 'panel.css'),
    'body { color: rgb(4, 5, 6); }',
  );
  writeFileSync(
    join(root, 'worker', 'extra.html'),
    '<!doctype html><h1>Extra</h1>',
  );
  writeFileSync(
    join(root, 'nackt', 'bot.sh'),
    'echo "token=$BOT_HUB_TOKEN"\nsleep 30\n',
  );

  process.env.BOT_DASHBOARD_ROOT = root;
  const { createServer: createApp } = await import('../server/manager.js');
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Erst nach dem Listen setzen – der Prozess braucht eine erreichbare URL.
  process.env.BOT_HUB_URL = baseUrl;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

describe('Bot-Seite aus einem Manifest', () => {
  let bot;

  it('liest bot-hub.json und liefert Seite, Felder und Standardwerte', async () => {
    bot = await createBot({
      name: 'Mit Manifest',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });

    const { status, data } = await call(`/bots/${bot.id}/panel`);
    assert.equal(status, 200);
    assert.equal(data.panel.available, true);
    assert.equal(data.panel.source, 'manifest');
    assert.equal(data.panel.title, 'Demo-Seite');
    assert.equal(data.panel.entry, 'page.html');
    assert.equal(data.panel.pages[0].href, 'extra.html');
    assert.equal(data.panel.fields.length, 5);
    assert.deepEqual(data.panel.settings, {
      log_channel: 'ops',
      cooldown: 5,
      auto: true,
      mode: 'safe',
    });
    assert.equal(data.panel.online, false);
    assert.ok(data.bridge.token.length > 20);
  });

  it('liefert die Dateien der Bot-Seite aus – aber nur im Arbeitsordner', async () => {
    const page = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/file/page.html`,
    );
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<h1>Seite<\/h1>/);
    const stylesheet = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/file/panel.css`,
    );
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /^text\/css/);
    const publicPage = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/file/page.html`,
      { headers: { origin: 'null' } },
    );
    assert.equal(publicPage.status, 200);
    const publicSensitiveType = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/file/worker/package.json`,
      { headers: { origin: 'null' } },
    );
    assert.equal(publicSensitiveType.status, 404);

    const bridge = await fetch(`${baseUrl}/api/bots/${bot.id}/panel/bridge.js`);
    assert.equal(bridge.status, 200);
    assert.match(await bridge.text(), /export const hub/);

    for (const evil of [
      '..%2f..%2f..%2fserver%2fmanager.js',
      '%2e%2e%2fdata',
      'server%2futil.js',
    ]) {
      const blocked = await fetch(
        `${baseUrl}/api/bots/${bot.id}/panel/file/${evil}`,
      );
      assert.ok(
        [400, 404].includes(blocked.status),
        `${evil} wurde nicht blockiert (${blocked.status})`,
      );
    }
  });

  it('öffnet die Bot-Seite über eine geschützte Weiterleitung', async () => {
    const response = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/open?page=page.html`,
      { redirect: 'manual' },
    );
    assert.equal(response.status, 302);
    const location = response.headers.get('location');
    assert.match(
      location,
      new RegExp(`/api/bots/${bot.id}/panel/file/page\\.html`),
    );
    assert.match(location, /#hub=[a-f0-9]{48}$/);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`bot_hub_panel_access_${bot.id}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const pageResponse = await fetch(`${baseUrl}${location.split('#')[0]}`, {
      headers: { cookie },
    });
    assert.equal(pageResponse.status, 200);
    const nestedStylesheet = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/file/panel/panel.css`,
      { headers: { cookie } },
    );
    assert.equal(nestedStylesheet.status, 200);
    assert.equal(
      nestedStylesheet.headers.get('content-type'),
      'text/css; charset=utf-8',
    );
  });

  it('speichert Einstellungen, maskiert Geheimnisse und wirft sie um', async () => {
    const { data } = await call(`/bots/${bot.id}/panel/settings`, {
      method: 'PUT',
      body: {
        values: {
          log_channel: 'neuer-kanal',
          cooldown: '42',
          auto: false,
          mode: 'fast',
          api_key: 'super-geheim-1234',
          unbekannt: 'wird verworfen',
        },
      },
    });
    assert.equal(data.changed, true);
    assert.deepEqual(data.panel.settings, {
      log_channel: 'neuer-kanal',
      cooldown: 42,
      auto: false,
      mode: 'fast',
    });
    assert.equal(data.panel.secrets.api_key, '••••••••');
    assert.ok(!JSON.stringify(data).includes('super-geheim-1234'));

    const { data: fresh } = await call(`/bots/${bot.id}/panel`);
    assert.equal(fresh.panel.settings.cooldown, 42);
    assert.equal(fresh.panel.settings.auto, false);
    assert.equal(fresh.panel.defaults.cooldown, 5);

    // Maske lassen = Wert bleibt, leer = Wert fliegt raus
    await call(`/bots/${bot.id}/panel/settings`, {
      method: 'PUT',
      body: { values: { api_key: '••••••••' } },
    });
    const { data: kept } = await call(`/bots/${bot.id}/panel`);
    assert.equal(kept.panel.secrets.api_key, '••••••••');

    await call(`/bots/${bot.id}/panel/settings`, {
      method: 'PUT',
      body: { values: { api_key: '' } },
    });
    const { data: cleared } = await call(`/bots/${bot.id}/panel`);
    assert.equal(cleared.panel.secrets.api_key, '');
  });

  it('führt eine Aktion als Skript aus und meldet fehlende Skripte', async () => {
    const { data: ping } = await call(`/bots/${bot.id}/panel/commands/ping`, {
      method: 'POST',
      body: {},
    });
    assert.equal(ping.result.ok, true);
    assert.equal(ping.result.data, 'pong');

    const missing = await call(`/bots/${bot.id}/panel/commands/leer`, {
      method: 'POST',
      body: {},
    });
    assert.equal(missing.status, 501);
    assert.match(missing.data.error, /Callback-URL/);

    const unknown = await call(`/bots/${bot.id}/panel/commands/nope`, {
      method: 'POST',
      body: {},
    });
    assert.equal(unknown.status, 404);
  });

  it('reicht die Werte beim Start als Umgebung weiter', async () => {
    await call(`/bots/${bot.id}/panel/settings`, {
      method: 'PUT',
      body: { values: { log_channel: 'start-kanal' } },
    });
    await call(`/bots/${bot.id}/start`, { method: 'POST' });
    await waitFor(bot.id, ['running', 'error']);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const lines = await logText(bot.id);
    assert.ok(
      lines.some((line) => line === `setting=start-kanal`),
      `BOT_HUB_SETTING_* fehlt: ${lines.join(' | ')}`,
    );
    assert.ok(
      lines.some(
        (line) => line.startsWith('hub=') && line.includes('127.0.0.1'),
      ),
    );
    assert.ok(
      lines.some((line) => line.includes('"log_channel":"start-kanal"')),
    );
    await call(`/bots/${bot.id}/stop`, { method: 'POST' });
  });
});

describe('Bot-Seite aus dem laufenden Prozess', () => {
  let bot;
  let token;

  it('meldet sich mit BOT_HUB_TOKEN an und streamt Einstellungen', async () => {
    bot = await createBot({
      name: 'Laufzeit',
      language: 'custom',
      cwd: 'nackt',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    assert.equal(bot.panel.available, false);

    await call(`/bots/${bot.id}/start`, { method: 'POST' });
    await waitFor(bot.id, ['running', 'error']);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const line = (await logText(bot.id)).find((item) =>
      item.startsWith('token='),
    );
    token = line.slice('token='.length);
    assert.equal(token.length, 48);

    const asBot = callWithToken(token);
    const { status, data } = await asBot('/hub/session');
    assert.equal(status, 200);
    assert.equal(data.bot.id, bot.id);
    assert.equal(data.baseUrl, baseUrl);
    assert.ok(data.panelUrl.includes(bot.id));

    // Werte aus dem Dashboard landen in der Sitzung des Bots
    await call(`/bots/${bot.id}/panel`, {
      method: 'DELETE',
    });
    await asBot('/hub/panel', {
      method: 'POST',
      body: {
        panel: {
          title: 'Laufzeit-Seite',
          settings: [{ key: 'modus', type: 'text', default: 'ruhig' }],
        },
      },
    });
    const { data: after } = await asBot('/hub/settings');
    assert.deepEqual(after.settings, { modus: 'ruhig' });

    const { data: panel } = await call(`/bots/${bot.id}/panel`);
    assert.equal(panel.panel.source, 'runtime');
    assert.equal(panel.panel.title, 'Laufzeit-Seite');
    assert.equal(panel.panel.online, true);

    // Änderung aus dem Dashboard kommt über SSE beim Prozess an
    const frames = await readBotEvents(token, 1);
    assert.match(frames, /event: settings/);
  });

  it('schickt Live-Werte an die Seite', async () => {
    const asBot = callWithToken(token);
    const { status } = await asBot('/hub/state', {
      method: 'POST',
      body: { state: { status: 'online', guilds: 3 } },
    });
    assert.equal(status, 200);

    const { data } = await call(`/bots/${bot.id}/panel`);
    assert.deepEqual(data.panel.state, { status: 'online', guilds: 3 });

    const tooBig = await asBot('/hub/state', {
      method: 'POST',
      body: { state: { blob: 'x'.repeat(70 * 1024) } },
    });
    assert.equal(tooBig.status, 413);
  });

  it('lehnt fehlende, falsche und zu schwache Tokens ab', async () => {
    assert.equal((await call('/hub/session')).status, 401);
    assert.equal(
      (
        await call('/hub/session', {
          headers: { authorization: 'Bearer falsch' },
        })
      ).status,
      401,
    );

    const { data: panel } = await call(`/bots/${bot.id}/panel`);
    const page = callWithToken(panel.bridge.token);
    const standalone = await fetch(`${baseUrl}/api/bots/${bot.id}/panel`, {
      headers: {
        origin: 'null',
        'x-bot-hub-token': panel.bridge.token,
      },
    });
    assert.equal(standalone.status, 200);
    assert.equal(standalone.headers.get('access-control-allow-origin'), 'null');
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/hub/session?token=${encodeURIComponent(
            panel.bridge.token,
          )}`,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/bots/${bot.id}/panel/reload`, {
          method: 'POST',
          headers: {
            origin: 'null',
            'x-bot-hub-token': panel.bridge.token,
          },
        })
      ).status,
      403,
    );
    assert.equal((await page('/hub/session')).status, 200);
    const denied = await page('/hub/panel', {
      method: 'POST',
      body: { panel: { title: 'fremd' } },
    });
    assert.equal(denied.status, 403);
    const write = await page('/hub/settings', {
      method: 'PUT',
      body: { values: { modus: 'übernommen' } },
    });
    assert.equal(write.status, 403);
    // Lesen darf die Seite aber
    const { data: read } = await page('/hub/settings');
    assert.deepEqual(read.settings, { modus: 'ruhig' });
  });

  it('vergibt das Manifest Vorrang vor der Laufzeit-Anmeldung', async () => {
    writeFileSync(
      join(root, 'nackt', 'bot-hub.json'),
      JSON.stringify(MANIFEST),
    );
    await call(`/bots/${bot.id}/panel/reload`, { method: 'POST' });
    const { data: panel } = await call(`/bots/${bot.id}/panel`);
    assert.equal(panel.panel.source, 'manifest');

    const clash = await callWithToken(token)('/hub/panel', {
      method: 'POST',
      body: {
        panel: {
          title: 'Laufzeit gewinnt',
          settings: [{ key: 'modus', type: 'text' }],
        },
      },
    });
    assert.equal(clash.status, 409);
  });

  it('entzieht das Token, sobald der Prozess endet', async () => {
    await call(`/bots/${bot.id}/stop`, { method: 'POST' });
    await waitFor(bot.id, ['stopped']);
    const { status } = await callWithToken(token)('/hub/session');
    assert.equal(status, 401);

    const { data: panel } = await call(`/bots/${bot.id}/panel`);
    assert.equal(panel.panel.available, true);
    assert.equal(panel.panel.online, false);
  });
});

describe('Herkunft und Mandant', () => {
  it('lehnt Aufrufe fremder Seiten ab – außerhalb der Bot-Seiten', async () => {
    const fremd = await fetch(`${baseUrl}/api/bots`, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(fremd.status, 403);

    const eigen = await fetch(`${baseUrl}/api/bots`, {
      headers: { origin: baseUrl },
    });
    assert.equal(eigen.status, 200);

    const { data: bots } = await call('/bots');
    const bot = bots.bots.find((item) => item.cwd === 'worker');
    const sandbox = await fetch(`${baseUrl}/api/bots/${bot.id}/panel`, {
      headers: { origin: 'null' },
    });
    assert.equal(sandbox.status, 403);
  });
});
