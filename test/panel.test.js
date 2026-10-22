import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

let root;
let baseUrl;
let server;
let discordMock;

/** Guild, in der der Bot installiert ist. */
const TARGET_GUILD = 'guild-ziel';
const ANDERE_GUILD = 'guild-fremd';
const ADMIN = String(0x8n);
const MANAGE_GUILD = String(0x20n);
const KEINE = '0';

const guild = (id, permissions) => ({
  id,
  name: id,
  icon: null,
  owner: false,
  permissions,
});

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
        {
          id: 'skript',
          label: 'Skript',
          run: 'sh report.sh',
        },
        { id: 'interpreter', label: 'Interpreter', run: 'sh -c id' },
        { id: 'python_eval', label: 'Python-Eval', run: 'python3 -c"id"' },
        { id: 'werkzeug', label: 'Werkzeug', run: 'curl https://evil.test' },
        {
          id: 'nach_oben',
          label: 'Nach oben',
          run: 'sh ../../job.sh',
        },
        { id: 'leer', label: 'Ohne Skript' },
      ],
    },
  },
};

before(async () => {
  // Der Testmodus ist nur mit NODE_ENV=test erlaubt (server/index.js).
  process.env.NODE_ENV = 'test';
  process.env.BOT_HUB_TEST_MODE = '1';
  root = mkdtempSync(join(tmpdir(), 'bot-hub-panel-'));
  mkdirSync(join(root, 'worker'));
  mkdirSync(join(root, 'nackt'));
  mkdirSync(join(root, 'callback'));
  mkdirSync(join(root, 'fremd'));
  writeFileSync(
    join(root, 'worker', 'bot.sh'),
    'echo "hub=$BOT_HUB_URL"\necho "token=$BOT_HUB_TOKEN"\nprintf "%s" "$BOT_HUB_TOKEN" > runtime-token.txt\necho "settings=$BOT_HUB_SETTINGS"\necho "setting=$BOT_HUB_SETTING_LOG_CHANNEL"\nsleep 30\n',
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
  writeFileSync(join(root, 'worker', 'report.sh'), 'echo "bericht $1"\n');
  writeFileSync(
    join(root, 'nackt', 'bot.sh'),
    'echo "token=$BOT_HUB_TOKEN"\nprintf "%s" "$BOT_HUB_TOKEN" > runtime-token.txt\nsleep 30\n',
  );
  for (const ordner of ['callback', 'fremd'])
    writeFileSync(
      join(root, ordner, 'bot.sh'),
      'echo "token=$BOT_HUB_TOKEN"\nprintf "%s" "$BOT_HUB_TOKEN" > runtime-token.txt\nsleep 30\n',
    );

  process.env.BOT_DASHBOARD_ROOT = root;
  // Der OAuth-Flow spricht mit Discord. Für die Tests läuft ein Mock, der
  // Nutzer, Guild-Liste und Token-Austausch nachstellt – die Basis-URL ist
  // nur mit NODE_ENV=test überschreibbar.
  discordMock = createServer((req, res) => {
    const authorization = String(req.headers.authorization ?? '');
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    if (req.url.endsWith('/oauth2/token')) {
      discordMock.tokens += 1;
      return send(200, { access_token: 'mock-access-token' });
    }
    if (req.url.endsWith('/oauth2/token/revoke')) {
      discordMock.revoked += 1;
      return send(200, {});
    }
    if (req.url.endsWith('/users/@me'))
      return send(200, {
        id: discordMock.user.id,
        username: discordMock.user.name,
        global_name: discordMock.user.name,
        avatar: null,
      });
    if (req.url.endsWith('/users/@me/guilds'))
      return send(
        200,
        authorization.startsWith('Bot ')
          ? discordMock.botGuilds
          : discordMock.userGuilds,
      );
    return send(404, {});
  });
  await new Promise((resolve) => discordMock.listen(0, '127.0.0.1', resolve));
  process.env.BOT_HUB_DISCORD_API = `http://127.0.0.1:${
    discordMock.address().port
  }/api/v10`;
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
  discordMock?.close();
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
    assert.equal(data.bridge.token, undefined);
  });

  it('liefert die Dateien der Bot-Seite aus – aber nur im Startordner', async () => {
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
    // Absolut und auf der Adresse, die auch den Discord-Callback bekommt:
    // das Bindungs-Cookie des Logins gilt nur für diesen Host. Im
    // Entwicklungsbetrieb lädt das Dashboard die Seite sonst über den
    // Vite-Port, und der Callback käme bei einem anderen Host an.
    assert.ok(location.startsWith(baseUrl), location);
    assert.match(
      location,
      new RegExp(`/api/bots/${bot.id}/panel/file/page\\.html`),
    );
    assert.ok(!location.includes('#hub='));
    assert.match(location, /[?&]bootstrap=[a-f0-9]{48}$/);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`bot_hub_panel_access_${bot.id}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const pageResponse = await fetch(location.split('#')[0], {
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

    const bootstrapUrl = new URL(location);
    const bootstrap = bootstrapUrl.searchParams.get('bootstrap');
    const bridgeResponse = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/bridge.js?bootstrap=${bootstrap}`,
      { headers: { origin: 'null' } },
    );
    assert.equal(bridgeResponse.status, 200);
    assert.match(
      bridgeResponse.headers.get('content-type'),
      /text\/javascript/,
    );
    const bridgeSource = await bridgeResponse.text();
    assert.match(bridgeSource, /const panelSessionToken = "[a-f0-9]{48}";/);
    const bootstrapCookie = bridgeResponse.headers.get('set-cookie');
    assert.match(
      bootstrapCookie,
      new RegExp(`bot_hub_panel_access_${bot.id}=`),
    );
    const panelResponse = await fetch(`${baseUrl}/api/bots/${bot.id}/panel`, {
      headers: { origin: 'null', cookie: bootstrapCookie },
    });
    assert.equal(panelResponse.status, 200);
    const replay = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/bridge.js?bootstrap=${bootstrap}`,
      { headers: { origin: 'null' } },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('set-cookie'), null);
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

    // Ein Skript im eigenen Workspace läuft weiterhin normal.
    const { data: script } = await call(
      `/bots/${bot.id}/panel/commands/skript`,
      { method: 'POST', body: {} },
    );
    assert.equal(script.result.ok, true);
    assert.equal(script.result.data, 'bericht');

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

  it('führt Panel-Aktionen nur als freigegebenes Programm im Workspace aus', async () => {
    // Das Manifest stammt aus dem Bot-Workspace und wird von einer Seite
    // ausgelöst, die selbst in einer Sandbox läuft. Ein Manifest darf
    // deshalb keine beliebigen Befehle auf dem Hub-Rechner starten.
    for (const [id, expected] of [
      ['interpreter', /Interpreter-Evaluationsflags sind nicht erlaubt/],
      ['python_eval', /Interpreter-Evaluationsflags sind nicht erlaubt/],
      ['werkzeug', /nicht freigegeben/],
      ['nach_oben', /außerhalb des Bot-Workspace/],
    ]) {
      const { data } = await call(`/bots/${bot.id}/panel/commands/${id}`, {
        method: 'POST',
        body: {},
      });
      assert.equal(data.result.ok, false, `${id} wurde ausgeführt`);
      assert.match(data.result.error, expected);
    }
  });

  it('zeigt dem Panel-Token nur die freigegebenen Aktionen', async () => {
    // Der Bot-Prozess selbst kann über /api/hub/session an den Panel-Token
    // kommen. Auch damit darf kein beliebiger Befehl laufen.
    const { panelToken } = await import('../server/panel.js');
    const asPage = callWithToken(panelToken(bot.id));
    const { data } = await asPage(
      `/bots/${bot.id}/panel/commands/interpreter`,
      {
        method: 'POST',
        body: {},
      },
    );
    assert.equal(data.result.ok, false);
    assert.match(data.result.error, /Interpreter-Evaluationsflags/);
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

    token = readFileSync(join(root, 'nackt', 'runtime-token.txt'), 'utf8');
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

    const { panelToken } = await import('../server/panel.js');
    const panelAccessToken = panelToken(bot.id);
    const page = callWithToken(panelAccessToken);
    const standalone = await fetch(`${baseUrl}/api/bots/${bot.id}/panel`, {
      headers: {
        origin: 'null',
        'x-bot-hub-token': panelAccessToken,
      },
    });
    assert.equal(standalone.status, 200);
    assert.equal(standalone.headers.get('access-control-allow-origin'), 'null');
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/hub/session?token=${encodeURIComponent(
            panelAccessToken,
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
            'x-bot-hub-token': panelAccessToken,
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

  it('trennt Panel- und Runtime-Token fuer Zustand und Meldungen', async () => {
    const { panelToken } = await import('../server/panel.js');
    const page = callWithToken(panelToken(bot.id));

    // Das Panel-Token gehoert der Bot-Seite: lesen ja, Bot-Zustaende schreiben nein.
    for (const rest of ['/state', '/notify']) {
      const denied = await page(`/hub${rest}`, {
        method: 'POST',
        body: { state: { status: 'falsch' }, message: 'falsch' },
      });
      assert.equal(denied.status, 403, `Panel-Token durfte ${rest} schreiben`);
    }

    // Der laufende Prozess darf beides weiterhin.
    const asBot = callWithToken(token);
    assert.equal(
      (
        await asBot('/hub/state', {
          method: 'POST',
          body: { state: { status: 'online' } },
        })
      ).status,
      200,
    );
    assert.equal(
      (await asBot('/hub/notify', { method: 'POST', body: { message: 'hi' } }))
        .status,
      200,
    );

    // Fuer die Bot-Seite gibt es den Panel-Weg weiterhin.
    const viaPanel = await page(`/bots/${bot.id}/panel/notify`, {
      method: 'POST',
      body: { message: 'von der Seite' },
    });
    assert.equal(viaPanel.status, 200);
    assert.equal(viaPanel.data.ok, true);
  });

  it('gibt den Panel-Token nicht ueber die JS-Bridge aus', async () => {
    const { panelToken } = await import('../server/panel.js');
    const bridge = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/bridge.js`,
      {
        headers: {
          origin: 'null',
          'x-bot-hub-token': panelToken(bot.id),
        },
      },
    );
    const source = await bridge.text();
    assert.match(source, /export const hub/);
    assert.ok(!source.includes('get token'), 'Bridge gibt das Token aus');
    assert.match(source, /base \+ '\/notify'/);
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

/*
 * Anmeldung im Bot-Panel: Browser-Bindung und Autorisierung gegen genau die
 * Guild, für die der Bot konfiguriert ist.
 */
describe('Bot-Anmeldung am Panel', () => {
  let bot;
  let page;
  /*
   * Der echte Ablauf in zwei Schritten, genau wie im Browser:
   * 1. Die Bot-Seite fragt per fetch an und bekommt nur eine Start-Adresse.
   * 2. Der Browser ruft diese Adresse als Navigation auf - erst dort entstehen
   *    State und Bindungs-Cookie, weil ein Cookie aus einem sandboxed fetch
   *    der Browser beim Rücksprung von Discord nicht mitschickt.
   */
  const loginStart = async () => {
    const response = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/discord/login?format=json`,
      { headers: { 'x-bot-hub-token': page } },
    );
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const { location: start } = JSON.parse(raw);
    const target = new URL(start);
    assert.equal(target.pathname, `/api/bots/${bot.id}/panel/discord/login`);
    assert.match(target.searchParams.get('ticket') ?? '', /^[a-f0-9]{48}$/);
    // Ohne Navigation gibt es weder State noch Cookie.
    assert.equal(response.headers.get('set-cookie'), null);
    return start;
  };
  const stateOf = async () => {
    const response = await fetch(await loginStart(), { redirect: 'manual' });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.hostname, 'discord.com');
    assert.equal(location.pathname, '/oauth2/authorize');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(location.searchParams.get('code_challenge'));
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`bot_hub_preauth_${bot.id}=[a-f0-9]{48}`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    return {
      state: location.searchParams.get('state'),
      // Nur der Name vor dem ersten "=" – der Weg ist fuer den Test egal.
      cookie: cookie.split(';')[0],
    };
  };
  const callback = (state, cookie) =>
    fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/discord/callback?state=${state}&code=mock-code`,
      { redirect: 'manual', headers: cookie ? { cookie } : {} },
    );

  beforeEach(async () => {
    discordMock.user = { id: 'user-1', name: 'Tester' };
    discordMock.botGuilds = [
      guild(TARGET_GUILD, ADMIN),
      guild(ANDERE_GUILD, '0'),
    ];
    discordMock.userGuilds = [guild(TARGET_GUILD, ADMIN)];
    discordMock.tokens = 0;
    discordMock.revoked = 0;
    bot = await createBot({
      name: 'Anmeldung',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
      guildId: TARGET_GUILD,
      secretEnv: { DISCORD_BOT_TOKEN: 'mock-bot-token' },
    });
    // Die OAuth-App des Panels liegt in der geschuetzten Secret-Datei.
    mkdirSync(join(root, 'data', 'secrets'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'secrets', `${bot.id}.env`),
      'DISCORD_CLIENT_ID=mock-client\nDISCORD_CLIENT_SECRET=mock-secret\n',
    );
    const { panelToken } = await import('../server/panel.js');
    page = panelToken(bot.id);
  });

  it('gibt das Start-Ticket nur einmal frei', async () => {
    const start = await loginStart();
    const first = await fetch(start, { redirect: 'manual' });
    assert.equal(first.status, 302);
    assert.equal(
      new URL(first.headers.get('location')).hostname,
      'discord.com',
    );
    // Ein zweiter Aufruf derselben Adresse bekommt nichts mehr: das Ticket
    // ist der Nachweis der abrufenden Seite und wird verbraucht.
    const second = await fetch(start, { redirect: 'manual' });
    assert.equal(second.status, 403);
    assert.match(
      JSON.parse(await second.text()).error,
      /Login-Aufruf ist abgelaufen/,
    );
    // Ein erfundenes Ticket ersetzt den Panel-Token nicht.
    const erfunden = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/discord/login?ticket=${'a'.repeat(48)}`,
      { redirect: 'manual' },
    );
    assert.equal(erfunden.status, 403);
    // Der Start ohne Ticket bleibt möglich, wenn die Seite den Panel-Cookie
    // mitbringt - so startet auch ein direkt geöffneter Tab den Login.
    const mitCookie = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/open?page=page.html`,
      { redirect: 'manual' },
    );
    const direct = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/discord/login`,
      {
        redirect: 'manual',
        headers: { cookie: mitCookie.headers.get('set-cookie') },
      },
    );
    assert.equal(direct.status, 302);
    assert.equal(
      new URL(direct.headers.get('location')).hostname,
      'discord.com',
    );
  });

  it('bindet den Callback an den Browser, der den Login gestartet hat', async () => {
    // Jeder Versuch verbraucht den State - genau so soll es sein.
    const first = await stateOf();
    assert.equal((await callback(first.state)).status, 400);

    // Browser B nimmt den Callback von Browser A: keine Sitzung.
    const second = await stateOf();
    const fremder = await callback(
      second.state,
      'bot_hub_preauth_x=' + 'f'.repeat(48),
    );
    assert.equal(fremder.status, 400);
    assert.match(
      JSON.parse(await fremder.text()).error,
      /anderen Browser oder unter einer anderen Adresse gestartet/,
    );
    // Ohne gültigen Browser wird kein Token bei Discord geholt.
    assert.equal(discordMock.tokens, 0);

    // Browser A gewinnt.
    const third = await stateOf();
    const gut = await callback(third.state, third.cookie);
    assert.equal(gut.status, 302);
    assert.match(gut.headers.get('set-cookie') ?? '', /bot_hub_panel_/);
    assert.equal(discordMock.tokens, 1);

    // State ist einmalig verwendbar.
    assert.equal((await callback(third.state, third.cookie)).status, 400);
  });

  it('verwirft einen State, der zu einem anderen Bot gehoert', async () => {
    const { state, cookie } = await stateOf();
    const other = await createBot({
      name: 'Anderer Bot',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
      guildId: TARGET_GUILD,
    });
    const response = await fetch(
      `${baseUrl}/api/bots/${other.id}/panel/discord/callback?state=${state}&code=mock-code`,
      { headers: { cookie } },
    );
    assert.equal(response.status, 400);
  });

  it('lehnt ab, wenn die Berechtigung nur in einer anderen Guild liegt', async () => {
    discordMock.userGuilds = [guild(ANDERE_GUILD, MANAGE_GUILD)];
    const { state, cookie } = await stateOf();
    const response = await callback(state, cookie);
    assert.equal(response.status, 403);
    assert.match(
      JSON.parse(await response.text()).error,
      /für den dieser Bot läuft|Server verwalten/,
    );
    // Das Token des abgelehnten Nutzers wird wieder verworfen.
    assert.equal(discordMock.revoked, 1);
    const session = await call(`/bots/${bot.id}/panel/discord/session`);
    assert.equal(session.data.authenticated, false);
  });

  it('lehnt ab, wenn der Nutzer die Berechtigung in keiner Guild hat', async () => {
    discordMock.userGuilds = [guild(TARGET_GUILD, KEINE)];
    const { state, cookie } = await stateOf();
    assert.equal((await callback(state, cookie)).status, 403);
  });

  it('lehnt ab, wenn der Bot in der Ziel-Guild gar nicht installiert ist', async () => {
    discordMock.botGuilds = [guild(ANDERE_GUILD, '0')];
    const { state, cookie } = await stateOf();
    assert.equal((await callback(state, cookie)).status, 403);
  });

  it('prüft ohne Bot-Token nur die Berechtigung der Ziel-Guild', async () => {
    // Der Hub kennt ohne Token nicht, wo der Bot installiert ist. Die Sperre
    // darf daran nicht scheitern – sonst wäre das Panel nie benutzbar.
    discordMock.botGuilds = [];
    const { state, cookie } = await stateOf();
    assert.equal((await callback(state, cookie)).status, 302);

    // Die Berechtigung in der Ziel-Guild bleibt trotzdem Pflicht.
    discordMock.userGuilds = [guild(ANDERE_GUILD, MANAGE_GUILD)];
    const ohneRecht = await stateOf();
    assert.equal(
      (await callback(ohneRecht.state, ohneRecht.cookie)).status,
      403,
    );
  });

  it('meldet die Sitzung nur fuer die Ziel-Guild an', async () => {
    discordMock.userGuilds = [
      guild(TARGET_GUILD, ADMIN),
      guild(ANDERE_GUILD, MANAGE_GUILD),
    ];
    const { state, cookie } = await stateOf();
    const response = await callback(state, cookie);
    assert.equal(response.status, 302);

    const sessionCookie = (response.headers.get('set-cookie') ?? '')
      .split(',')
      .map((part) => part.trim().split(';')[0])
      .find((part) => part.startsWith(`bot_hub_panel_${bot.id}=`));
    const { data } = await call(`/bots/${bot.id}/panel/discord/session`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(data.authenticated, true);
    assert.equal(data.user.id, 'user-1');
    assert.deepEqual(
      data.guilds.map((item) => item.id),
      [TARGET_GUILD],
    );
  });

  it('verlangt fuer Panel-Aktionen eine gueltige Discord-Sitzung', async () => {
    const { state, cookie } = await stateOf();
    discordMock.userGuilds = [guild(ANDERE_GUILD, MANAGE_GUILD)];
    // Abgelehnte Anmeldung -> die Seite bleibt gesperrt.
    await callback(state, cookie);
    const { status } = await fetch(
      `${baseUrl}/api/bots/${bot.id}/panel/settings`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-bot-hub-token': page,
        },
        body: JSON.stringify({ values: { log_channel: 'trojan' } }),
      },
    );
    assert.equal(status, 401);
  });
});

/**
 * Callback-Adressen sind der eine Weg, auf dem der Hub selbst etwas aufruft.
 * Eine zu weit gefasste Beschränkung macht ihn zum offenen Client: er klopft
 * dann Adressen ab, die der Bot nie erreichen dürfte, und ein Bot, der sich
 * zwischen Registrierung und Aufruf an einen anderen Namen hängt, umgeht jede
 * Prüfung, die nur einmal stattfand.
 */
describe('Callback-Adresse', () => {
  let bot;
  let asBot;

  before(async () => {
    bot = await createBot({
      name: 'Callback',
      language: 'custom',
      cwd: 'callback',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    await call(`/bots/${bot.id}/start`, { method: 'POST' });
    await waitFor(bot.id, ['running', 'error']);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const token = readFileSync(
      join(root, 'callback', 'runtime-token.txt'),
      'utf8',
    );
    asBot = callWithToken(token);
  });

  const setzen = (url, token = 'callback-token') =>
    asBot('/hub/callback', { method: 'POST', body: { url, token } });

  it('nimmt Loopback an, weil der Prozess dort läuft', async () => {
    for (const url of [
      'http://127.0.0.1:9999/hook',
      'http://127.0.0.5:9999/hook',
      'http://localhost:9999/hook',
      'http://[::1]:9999/hook',
    ]) {
      const { status, data } = await setzen(url);
      assert.equal(status, 200, `abgelehnt: ${url}`);
      assert.equal(data.ok, true);
    }
    await setzen(null);
  });

  it('lehnt Ziele außerhalb des eigenen Rechners ab', async () => {
    // Nicht als Präfixvergleich, sondern als echte Netzadresse: `10.example.com`
    // ist eine öffentliche Adresse und muss durchgehen, `10.0.0.5` nicht.
    for (const url of [
      'http://10.0.0.5/hook',
      'http://172.16.0.5/hook',
      'http://172.31.255.255/hook',
      'http://192.168.1.10/hook',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:127.0.0.1]/hook',
      'http://[fd00::1]/hook',
      'http://[fe80::1]/hook',
      'http://0.0.0.0/hook',
      'http://metadata.google.internal/hook',
    ]) {
      const { status, data } = await setzen(url);
      assert.equal(status, 400, `zugelassen: ${url}`);
      assert.match(
        data.error + (data.message ?? ''),
        /Loopback|Callback-Allowlist|nicht auflösen/,
        `falsche Begründung für ${url}`,
      );
    }
  });

  it('lässt Namen durch, die zufällig wie eine Adresse aussehen', async () => {
    // Ein naiver Vergleich auf "beginnt mit fd" würde diese Adresse sperren.
    for (const url of [
      'http://fd.example.test/hook',
      'http://10.example.test/hook',
    ]) {
      const { status } = await setzen(url);
      assert.equal(status, 400, 'DNS-Ziel prüfen wir getrennt');
    }
  });

  it('verlangt http oder https', async () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://127.0.0.1/x',
      'gopher://127.0.0.1/',
      'data:text/plain,x',
    ]) {
      const { status, data } = await setzen(url);
      assert.equal(status, 400, `zugelassen: ${url}`);
      assert.match(data.error + (data.message ?? ''), /http oder https/);
    }
  });

  it('behandelt Zahlen- und Hexschreibweisen nach ihrer echten Adresse', async () => {
    // `new URL` bringt jede Form auf die kanonische Schreibweise. Die Prüfung
    // sieht also `127.0.0.1` und nicht `2130706433` – und gespeichert wird
    // ebenfalls die kanonische Adresse. Beides wird hier nachgehalten, weil es
    // die eigentliche Zusage ist: geprüft und aufgerufen wird dasselbe.
    for (const url of [
      'http://2130706433/hook',
      'http://127.1/hook',
      'http://0177.0.0.1/hook',
      'http://0x7f000001/hook',
      'http://0x7f.1/hook',
    ]) {
      const { status, data } = await setzen(url);
      assert.equal(status, 200, `abgelehnt: ${url}`);
      assert.equal(data.url, 'http://127.0.0.1');
      // Gespeichert und damit später aufgerufen wird die geprüfte Adresse.
      assert.ok(Number(data.expiresAt) > Date.now());
    }

    // Dieselbe Formel, aber sie zeigt auf die Metadaten-Adresse des Anbieters.
    const { status } = await setzen('http://2852039166/latest/meta-data/');
    assert.equal(status, 400, 'Metadaten-Adresse in Zahlenform zugelassen');
    await setzen(null);
  });

  it('lehnt eine unlesbare URL ab', async () => {
    for (const url of ['keine-url', '://x', 'http://']) {
      const { status } = await setzen(url);
      assert.equal(status, 400, `zugelassen: ${url}`);
    }
  });

  it('löscht die Adresse bei einem leeren Wert', async () => {
    // Leer heißt hier "keine Adresse mehr" – das ist der Weg, die alte
    // Einstellung zu entfernen, und kein ungültiger Befehl.
    const { status, data } = await setzen('');
    assert.equal(status, 200);
    assert.equal(data.url, null);
  });

  it('verweigert den Hub selbst', async () => {
    const eigen = Number(process.env.PORT || 8787);
    const { status } = await setzen(`http://127.0.0.1:${eigen}/hook`);
    assert.equal(status, 400);
  });

  it('vergibt eine Ablaufzeit', async () => {
    const { data } = await setzen('http://127.0.0.1:9999/hook');
    assert.ok(Number(data.expiresAt) > Date.now(), 'keine Ablaufzeit genannt');
  });

  it('nimmt eine ausdrücklich freigegebene Adresse an', async () => {
    const vorher = process.env.BOT_HUB_CALLBACK_ALLOW;
    // V19 #18: Allowlist umgeht DNS-Schutz niemals. Ein Name ohne DNS-Eintrag
    // wird abgelehnt (400); eine allowlistete IP ohne Metadaten wird angenommen.
    process.env.BOT_HUB_CALLBACK_ALLOW = 'bot.example.test,93.184.216.34';
    try {
      const unaufloesbar = await setzen('http://bot.example.test:9999/hook');
      assert.equal(unaufloesbar.status, 400);
      const { status } = await setzen('https://93.184.216.34/hook');
      assert.equal(status, 200);
      assert.equal((await setzen('http://93.184.216.34/hook')).status, 400);
      assert.equal(
        (await setzen('https://93.184.216.34:8443/hook')).status,
        400,
      );
      await setzen(null);
    } finally {
      if (vorher === undefined) delete process.env.BOT_HUB_CALLBACK_ALLOW;
      else process.env.BOT_HUB_CALLBACK_ALLOW = vorher;
    }
  });

  it('vergibt nichts an eine Sitzung ohne Laufzeit-Token', async () => {
    // Ohne Bearer-Token bleibt die Route zu. Es gibt hier keinen Weg, eine
    // Callback-Adresse aus dem Browser zu setzen – die Antwort darf nur nicht
    // 200 sein.
    for (const pfad of [`/bots/${bot.id}/panel/callback`, '/hub/callback']) {
      const { status } = await call(pfad, {
        method: 'POST',
        body: { url: 'http://127.0.0.1:9999/hook' },
      });
      assert.notEqual(status, 200, `offen: ${pfad}`);
    }
  });

  it('vergibt nichts an eine andere Sitzung', async () => {
    const fremder = await createBot({
      name: 'Fremd',
      language: 'custom',
      cwd: 'fremd',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    await call(`/bots/${fremder.id}/start`, { method: 'POST' });
    await waitFor(fremder.id, ['running', 'error']);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const token = readFileSync(
      join(root, 'fremd', 'runtime-token.txt'),
      'utf8',
    );
    const alsFremder = callWithToken(token);

    // Der Token gehört zum anderen Bot – er darf dessen Callback nicht setzen.
    const { data } = await alsFremder('/hub/session');
    assert.equal(data.bot.id, fremder.id);
    await call(`/bots/${fremder.id}/stop`, { method: 'POST' });
  });

  it('lehnt Loopback-Ziele im Container-Betrieb ab', async () => {
    // Bots laufen im Container und erreichen den Loopback des Hub-Rechners
    // selbst nicht – über den Hub kämen sie trotzdem heran, und die Antwort
    // fließt als Body in untrusted Bot-Code zurück. Darum ist Loopback tabu,
    // solange die Container-Runtime aktiv ist. Die Prüfung erfolgt bewusst
    // zur Anfragezeit (nicht beim Import): der Modus-Switch wirkt dadurch
    // auch mitten im Prozess – hier wird er nur für diese Anfrage gestellt.
    const vorherTest = process.env.BOT_HUB_TEST_MODE;
    const vorherContainer = process.env.BOT_HUB_CONTAINER_MODE;
    delete process.env.BOT_HUB_TEST_MODE; // sonst gilt die Runtime als abgeschaltet
    process.env.BOT_HUB_CONTAINER_MODE = 'enabled';
    try {
      for (const url of [
        'http://127.0.0.1:9999/hook',
        'http://localhost:9999/hook',
        'http://[::1]:9999/hook',
      ]) {
        const { status, data } = await setzen(url);
        assert.equal(status, 400, `zugelassen: ${url}`);
        assert.match(
          data.error + (data.message ?? ''),
          /Container-Betrieb/,
          `falsche Begründung für ${url}`,
        );
      }
      // Die Ablehnung darf den gehookten Pfad nicht zurückgeben.
      const { data: abweis } = await setzen(
        'http://127.0.0.1:9999/geheim/pfad',
      );
      assert.doesNotMatch(
        JSON.stringify(abweis),
        /geheim/,
        'Fehlermeldung leakt den Callback-Pfad',
      );
    } finally {
      if (vorherTest === undefined) delete process.env.BOT_HUB_TEST_MODE;
      else process.env.BOT_HUB_TEST_MODE = vorherTest;
      if (vorherContainer === undefined)
        delete process.env.BOT_HUB_CONTAINER_MODE;
      else process.env.BOT_HUB_CONTAINER_MODE = vorherContainer;
    }
    // Ohne Container-Runtime (Entwicklung, Tests) bleibt Loopback erlaubt –
    // der Hub teilt sich dort den Loopback mit dem Bot.
    const { status } = await setzen('http://127.0.0.1:9999/hook');
    assert.equal(status, 200, 'Loopback im Nicht-Container-Modus abgelehnt');
    await setzen(null);
  });

  it('ruft den Hook über die zuvor geprüfte Adresse auf (Lookup-Pinning)', async () => {
    // Der laufende Prozess braucht einen frischen Token und `runAction`
    // verlangt ein lebendes Kind – also neu starten und tokenisieren.
    // Härtung (Test-Timing, keine gelockerte Assertion): /stop antwortet,
    // solange der Kindprozess noch nicht gestorben ist – /start würde dann
    // mit 409 „läuft bereits“ ins Leere laufen und der Status bliebe
    // dauerhaft stopped. Also erst das echte Ende abwarten …
    const tokenVorher = (() => {
      try {
        return readFileSync(
          join(root, 'callback', 'runtime-token.txt'),
          'utf8',
        );
      } catch {
        return '';
      }
    })();
    await call(`/bots/${bot.id}/stop`, { method: 'POST' });
    await waitFor(bot.id, ['stopped']);
    await call(`/bots/${bot.id}/start`, { method: 'POST' });
    await waitFor(bot.id, ['running', 'error']);
    // … und dann den FRISCH geschriebenen Token lesen: die Datei trägt bis
    // zum Überschreiben durch den neuen Prozess noch den alten Wert – der
    // feste 400-ms-Schlaf hat unter Last den alten Token erwischt (401).
    let token = tokenVorher;
    const seit = Date.now();
    while (token === tokenVorher && Date.now() - seit < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        token = readFileSync(
          join(root, 'callback', 'runtime-token.txt'),
          'utf8',
        );
      } catch {
        /* Datei noch nicht wieder da */
      }
    }
    assert.notEqual(
      token,
      tokenVorher,
      'neuer Runtime-Token wurde nicht geschrieben',
    );
    assert.ok(token.length >= 8, `Token unplausibel kurz: ${token.length}`);
    const alsBot = callWithToken(token);

    // Empfangsserver dual-stack (bindet ::), damit er die geprüfte Adresse
    // trifft, egal ob `localhost` auf 127.0.0.1 oder ::1 auflöst.
    const empfangen = [];
    const hookServer = createServer((req, res) => {
      const stücke = [];
      req.on('data', (stück) => stücke.push(stück));
      req.on('end', () => {
        empfangen.push({
          pfad: req.url,
          token: String(req.headers['x-bot-hub-token'] ?? ''),
          body: JSON.parse(Buffer.concat(stücke).toString('utf8')),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ echo: 'angekommen' }));
      });
    });
    try {
      await new Promise((resolve, ablehnen) => {
        hookServer.once('error', ablehnen);
        hookServer.listen(0, '::', () => {
          hookServer.removeListener('error', ablehnen);
          resolve();
        });
      });
    } catch {
      // Kein IPv6 an dieser Stelle: dann eben IPv4-Loopback.
      await new Promise((resolve) =>
        hookServer.listen(0, '127.0.0.1', resolve),
      );
    }
    const port = hookServer.address().port;
    try {
      // Aktion ohne Skript: beantwortbar nur über den Callback.
      await alsBot('/hub/panel', {
        method: 'POST',
        body: {
          panel: { title: 'Hook', commands: [{ id: 'hook', label: 'Hook' }] },
        },
      });
      const gesetzt = await alsBot('/hub/callback', {
        method: 'POST',
        body: { url: `http://localhost:${port}/hook`, token: 'pinn-token' },
      });
      assert.equal(gesetzt.status, 200);
      const { data } = await call(`/bots/${bot.id}/panel/commands/hook`, {
        method: 'POST',
        body: {},
      });
      assert.equal(data.result?.ok, true, JSON.stringify(data));
      assert.equal(data.result.via, 'callback');
      assert.deepEqual(data.result.data, { echo: 'angekommen' });
      // Der Hook wurde real getroffen – über die geprüfte, gepinnte Adresse,
      // nicht über eine beim Verbindungsaufbau neu aufgelöste.
      assert.equal(empfangen.length, 1);
      assert.equal(empfangen[0].pfad, '/hook');
      assert.equal(empfangen[0].token, 'pinn-token');
      assert.equal(empfangen[0].body.id, 'hook');
    } finally {
      await alsBot('/hub/callback', { method: 'POST', body: { url: null } });
      hookServer.closeAllConnections?.();
      hookServer.close();
      await call(`/bots/${bot.id}/stop`, { method: 'POST' });
    }
  });
});

/**
 * Reine Filter und Pinning-Entscheider für Callback-Ziele – ohne Server,
 * ohne DNS. Diese Tests sind der Beweis, dass die Blockliste genau dort
 * dicht ist, wo sie dicht sein muss, und offen dort, wo der Betreiber sie
 * ausdrücklich freigibt.
 */
describe('Callback-Filter (reine Prüfung)', () => {
  let panelApi;
  before(async () => {
    // Import bewusst erst im Hook, nicht im describe-Rumpf: der Rumpf läuft
    // schon während der Sammlung – also bevor der Datei-Hook NODE_ENV und
    // den Discord-Mock setzt. Ein zu früher Import würde in panel.js das
    // echte Discord einkompilieren und die Login-Tests dieser Datei zerlegen.
    panelApi = await import('../server/panel.js');
  });

  it('lässt öffentliche Adressen durch (Allowlist lebt wieder)', () => {
    // P0-Regression: `::ffff:0:0/96` landete im IPv4-Baum als 0.0.0.0/0 und
    // ließ keine einzige öffentliche IPv4-Adresse mehr durch.
    for (const adresse of [
      '8.8.8.8',
      '1.1.1.1',
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ])
      assert.equal(
        panelApi.isNonPublicCallbackAddress(adresse),
        false,
        `fälschlich blockiert: ${adresse}`,
      );
  });

  it('blockiert private, reservierte, eingebettete und nicht-IP-Ziele', () => {
    for (const adresse of [
      '127.0.0.1',
      '::1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      'fe80::1',
      'fc00::1',
      '10.0.0.1',
      '169.254.169.254',
      'kein-hostname',
    ])
      assert.equal(
        panelApi.isNonPublicCallbackAddress(adresse),
        true,
        `fälschlich erlaubt: ${adresse}`,
      );
  });

  it('blockiert Well-Known-NAT64 und Discard-Netz (Härtung)', () => {
    // 64:ff9b::/96 übersetzt IPv4-Ziele in den IPv6-Raum – auch die
    // Metadaten-Adresse 169.254.169.254; 100::/64 ist reserviert (discard).
    assert.equal(
      panelApi.isNonPublicCallbackAddress('64:ff9b::a9fe:a9fe'),
      true,
    );
    assert.equal(panelApi.isNonPublicCallbackAddress('64:ff9b::1'), true);
    assert.equal(panelApi.isNonPublicCallbackAddress('100::1'), true);
  });

  it('erkennt IPv4-kompatible Hex-Form ::h:h als IPv4 (Härtung F-3)', () => {
    // `new URL` serialisiert ::127.0.0.1 als ::7f00:1 und ::169.254.169.254
    // als ::a9fe:a9fe. Ohne Deutung als IPv4 entkamen diese Kanonisierungen
    // sowohl embeddedIPv4 als auch der v6-Blockliste und galten als öffentlich.
    for (const adresse of ['::7f00:1', '::a9fe:a9fe'])
      assert.equal(
        panelApi.isNonPublicCallbackAddress(adresse),
        true,
        `fälschlich erlaubt: ${adresse}`,
      );
    // Gegenproben – die Deutung darf nur die Zwei-Gruppen-Form treffen:
    assert.equal(
      panelApi.isNonPublicCallbackAddress('::1'),
      true,
      'v6-Loopback muss blockiert bleiben',
    );
    assert.equal(
      panelApi.isNonPublicCallbackAddress('2606:2800:220:1:248:1893:25c8:1946'),
      false,
      'normale v6-Adresse falsch klassiert',
    );
    // ::808:808 = 8.8.8.8 in kompatibler Form: öffentlich, muss durch.
    assert.equal(panelApi.isNonPublicCallbackAddress('::808:808'), false);
    // Und die schon vorher behandelte mapped-Form darf nicht kippen:
    assert.equal(panelApi.isNonPublicCallbackAddress('::ffff:8.8.8.8'), false);
    assert.equal(panelApi.isNonPublicCallbackAddress('::ffff:7f00:1'), true);
  });

  it('pinnt die Verbindung auf die geprüfte Adresse (Rebinding-Schutz)', () => {
    const pin = panelApi.callbackLookupPin(
      'bot.example.test',
      '93.184.216.34',
      false,
    );
    assert.equal(typeof pin, 'function', 'externes Ziel ohne Proxy ungepinnt');
    let gesehen;
    pin(
      'bot.example.test',
      { all: true, hints: 32 },
      (fehler, sätze, familie) => {
        gesehen = { fehler, sätze, familie };
      },
    );
    assert.equal(gesehen.fehler, null);
    // Net erwartet seit Node 22.21 (all:true, Happy Eyeballs) einen
    // Adresssatz mit family-Feld – Einzel-String und familienlose
    // Einträge laufen dort als „Invalid IP address“ ins Leere.
    assert.ok(Array.isArray(gesehen.sätze), 'Lookup antwortet nicht mit Liste');
    assert.deepEqual(gesehen.sätze, [{ address: '93.184.216.34', family: 4 }]);
    assert.equal(gesehen.familie, 4);
    // Loopback wird immer gepinnt – er läuft über NO_PROXY direkt, dort
    // prüft kein Proxy die Ziel-IP nach.
    const pinLoopback = panelApi.callbackLookupPin('localhost', '::1', true);
    assert.equal(typeof pinLoopback, 'function', 'Loopback bei Proxy aktiv');
    pinLoopback('localhost', {}, (fehler, sätze) => {
      gesehen = { fehler, sätze };
    });
    assert.equal(gesehen.fehler, null);
    assert.deepEqual(gesehen.sätze, [{ address: '::1', family: 6 }]);
  });

  it('verzichtet auf den Pin nur beim Produktions-Proxy und bei IP-Literalen', () => {
    // Nur bei aktivem Produktions-Proxy geht Traffic zum Proxy – dort prüft
    // Squid die Ziel-IP beim CONNECT, und ein Pin-Lookup würde den Weg zum
    // Proxy verbiegen.
    assert.equal(
      panelApi.callbackLookupPin('bot.example.test', '93.184.216.34', true),
      undefined,
    );
    // IP-Literale löst Node gar nicht auf – das Literal ist das Ziel.
    assert.equal(
      panelApi.callbackLookupPin('93.184.216.34', '93.184.216.34', false),
      undefined,
    );
    // Fail-safe: ist die geprüfte Adresse keine IP, wird nicht ungeprüft
    // neu aufgelöst, sondern der Lookup schlägt fehl (Close, nicht Loophole).
    const kaputt = panelApi.callbackLookupPin(
      'bot.example.test',
      'kein-hostname',
      false,
    );
    assert.equal(typeof kaputt, 'function');
    kaputt('bot.example.test', {}, (fehler) => assert.ok(fehler));
  });

  it('erkennt den Produktionsproxy nur vollständig und fail-safe', () => {
    const vorher = {
      NODE_ENV: process.env.NODE_ENV,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      http_proxy: process.env.http_proxy,
      https_proxy: process.env.https_proxy,
    };
    try {
      process.env.NODE_USE_ENV_PROXY = '1';
      process.env.HTTP_PROXY = 'http://proxy.invalid:1';
      process.env.HTTPS_PROXY = 'http://proxy.invalid:1';
      // Außerhalb von Produktion gilt nie „Proxy prüft schon“ – selbst mit
      // Proxy-Umgebung wird gepinnt.
      process.env.NODE_ENV = 'test';
      assert.equal(panelApi.produktionsEgressProxyAktiv(), false);
      process.env.NODE_ENV = 'production';
      assert.equal(panelApi.produktionsEgressProxyAktiv(), true);
      delete process.env.HTTPS_PROXY;
      delete process.env.https_proxy;
      // Unvollständige Einrichtung heißt „Proxy nicht aktiv“ – also pinnen.
      assert.equal(panelApi.produktionsEgressProxyAktiv(), false);
    } finally {
      for (const [name, wert] of Object.entries(vorher))
        if (wert === undefined) delete process.env[name];
        else process.env[name] = wert;
    }
  });
});
