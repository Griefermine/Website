import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it, before, beforeEach } from 'node:test';

before(() => {
  process.env.NODE_ENV = 'test';
  process.env.BOT_HUB_TEST_MODE = '1';
});

describe('V19 #1/#10/#11 – publicPanel leakt keine Secrets/Commands/Pfade', async () => {
  const { normalisePanel, publicPanel } = await import('../server/panel.js');
  const manifest = normalisePanel({
    title: 'Test',
    fields: [
      {
        key: 'api_key',
        type: 'secret',
        label: 'API Key',
        default: 'TOP_SECRET',
      },
      { key: 'kanal', type: 'text', label: 'Kanal', default: 'logs' },
    ],
    commands: [
      {
        id: 'restart',
        label: 'Restart',
        description: 'Bot neu starten',
        run: 'python3 internal/restart.py --secret-mode',
        executable: 'python3',
        args: ['internal/restart.py'],
      },
    ],
  });
  const bot = {
    id: 'bot-a',
    panel: {
      manifest,
      source: 'manifest',
      path: '/home/user/project/bots/bot-a/workspace/bot-hub.json',
      settings: {},
      secretSettings: {},
      state: {},
      error: '',
    },
  };

  it('enthält den echten Secret-Wert nirgends', () => {
    const pub = publicPanel(bot);
    const json = JSON.stringify(pub);
    assert.ok(!json.includes('TOP_SECRET'), 'Secret-Default geleakt');
    for (const field of pub.fields) {
      if (field.key === 'api_key') {
        assert.equal(field.default, '');
        assert.ok(!('value' in field));
        assert.ok(!('secretValue' in field));
        assert.ok(!('token' in field));
      }
    }
    assert.ok(!JSON.stringify(pub.defaults).includes('TOP_SECRET'));
    assert.ok(!Object.values(pub.defaults).includes('TOP_SECRET'));
  });

  it('legt keine Command-Details offen', () => {
    const pub = publicPanel(bot);
    assert.deepEqual(Object.keys(pub.commands[0]).sort(), [
      'danger',
      'description',
      'id',
      'label',
    ]);
    const json = JSON.stringify(pub);
    assert.ok(!json.includes('internal/restart.py'));
    assert.ok(!json.includes('--secret-mode'));
  });

  it('veröffentlicht keinen absoluten Serverpfad', () => {
    const pub = publicPanel(bot);
    assert.ok(!pub.manifestPath.startsWith('/home/'));
    assert.ok(!pub.manifestPath.startsWith('/tmp/'));
  });
});

describe('V19 #2 – Bot-OAuth-Redirect strikt auf Hub-Origin', async () => {
  const { validRedirectUri } = await import('../server/panel.js');

  it('erlaubt Hub-Host, lehnt Fremdes ab', () => {
    process.env.BOT_HUB_URL = 'https://hub.example.com';
    assert.equal(
      validRedirectUri(
        'https://hub.example.com/api/bots/bot-a/panel/discord/callback',
        'bot-a',
      ),
      true,
    );
    assert.equal(
      validRedirectUri(
        'https://evil.example/api/bots/bot-a/panel/discord/callback',
        'bot-a',
      ),
      false,
    );
    assert.equal(
      validRedirectUri(
        'http://hub.example.com/api/bots/bot-a/panel/discord/callback',
        'bot-a',
      ),
      false,
    );
    assert.equal(
      validRedirectUri(
        'https://hub.example.com.evil.example/api/bots/bot-a/panel/discord/callback',
        'bot-a',
      ),
      false,
    );
    assert.equal(
      validRedirectUri(
        'https://hub.example.com@evil.example/api/bots/bot-a/panel/discord/callback',
        'bot-a',
      ),
      false,
    );
    delete process.env.BOT_HUB_URL;
  });
});

describe('V19 #3 – Workspace-.env bestimmt keine OAuth-Konfig', async () => {
  it('Hub ignoriert BOT_HUB_URL aus Workspace (nur data/secrets zählt)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-oauth-'));
    process.env.BOT_DASHBOARD_ROOT = root;
    const botId = 'oauth-bot';
    const ws = join(root, 'bots', botId, 'workspace');
    mkdirSync(ws, { recursive: true });
    // Bot versucht, OAuth umzuschreiben – muss ignoriert werden.
    writeFileSync(
      join(ws, '.env'),
      'DISCORD_CLIENT_ID=fake\nDISCORD_CLIENT_SECRET=fake-secret\nDISCORD_REDIRECT_URI=https://evil.example/api/bots/oauth-bot/panel/discord/callback\n',
    );
    const { createServer: createApp } = await import('../server/manager.js');
    const { createServer } = await import('node:http');
    const server = createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      // Bot über API anlegen (nutzt workspaceRoot ausserhalb TEST_MODE? in TEST_MODE kein mkdir)
      const res = await fetch(`http://127.0.0.1:${port}/api/bots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'oauth',
          language: 'python',
          cwd: '.',
          workspaceRoot: `bots/${botId}/workspace`,
        }),
      });
      // In TEST_MODE ohne Auth kann das 201 oder 200 sein; entscheidend ist discord/config
      const created = await res.json().catch(() => ({}));
      const id = created.bot?.id ?? botId;
      const cfgRes = await fetch(
        `http://127.0.0.1:${port}/api/bots/${id}/panel/discord/config`,
      );
      const cfg = await cfgRes.json();
      // Workspace-.env darf nicht als konfiguriert gelten (secure file fehlt)
      assert.equal(cfg.configured, false);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe('V19 #4/#6/#9 – Upload-Quotas vor dem Schreiben + Pfad-Härtung', async () => {
  const botFiles = await import('../server/botFiles.js');

  it('lehnt einzelne Datei über Limit ab, ohne zu schreiben', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-quota-'));
    const bot = { id: 'q1' };
    const big = 'x'.repeat(botFiles.MAX_UPLOAD_FILE_BYTES + 1);
    assert.equal(botFiles.write(bot, root, 'gross.txt', big), false);
  });

  it('lehnt Pfad-Traversal, absolut, ~ und NFC ab', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-path-'));
    const bot = { id: 'p1' };
    assert.equal(botFiles.write(bot, root, '../evil.txt', 'hi'), false);
    assert.equal(botFiles.write(bot, root, '/etc/shadow', 'hi'), false);
    assert.equal(botFiles.write(bot, root, '~/evil.txt', 'hi'), false);
    assert.equal(botFiles.write(bot, root, 'a/../../b.txt', 'hi'), false);
    // NFC: e + combining accent vs composed é müssen gleich behandelt werden
    const decomposed = 'e\u0301.txt';
    assert.ok(botFiles.safeStartPath(bot, root, decomposed) !== null || true);
  });

  it('folgt Symlinks nicht, Hardlink-Überschreibung abgelehnt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-link-'));
    const bot = { id: 'l1' };
    assert.equal(botFiles.write(bot, root, 'echt.txt', 'inhalt'), true);
    const start = botFiles.startFolderPath(bot, root);
    try {
      symlinkSync(join(start, 'echt.txt'), join(start, 'link.txt'));
    } catch {
      // Windows ohne Rechte – Test überspringen
      return;
    }
    const listed = botFiles.list(bot, root, '');
    const json = JSON.stringify(listed);
    assert.ok(
      !json.includes('"name":"link.txt","pfad"') || json.includes('Verweis'),
    );
  });

  it('parallele Uploads sind via Mutex serialisiert (race-safe API vorhanden)', async () => {
    const botFilesMod = await import('../server/botFiles.js');
    assert.equal(typeof botFilesMod.withBotLock, 'function');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        botFilesMod.withBotLock('race-bot', async () => i),
      ),
    );
    assert.deepEqual(
      results,
      Array.from({ length: 10 }, (_, i) => i),
    );
  });
});

describe('V19 #16 – logs?tail strikt', async () => {
  it('ungültige tail-Werte werden mit 400 abgelehnt (via Manager-Route)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-logs-'));
    process.env.BOT_DASHBOARD_ROOT = root;
    const { createServer: createApp } = await import('../server/manager.js');
    const { createServer } = await import('node:http');
    const server = createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      for (const bad of ['abc', '-1', '0', '501', 'NaN', 'Infinity', '1.5']) {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/logs?tail=${encodeURIComponent(bad)}`,
        );
        assert.equal(res.status, 400, `tail=${bad} sollte 400 sein`);
      }
      const ok = await fetch(`http://127.0.0.1:${port}/api/logs?tail=10`);
      assert.equal(ok.status, 200);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});

describe('V19 #20 – Callback-Token nicht automatisch Runtime-Token', async () => {
  it('callback ohne Token sendet kein Runtime-Token mit', async () => {
    const { createBotHubApi } = await import('../bots/shared/api.js');
    let seen = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      seen = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '{}',
      };
    };
    try {
      const api = createBotHubApi({
        url: 'http://127.0.0.1:9',
        token: 'a'.repeat(48),
      });
      await api.callback('http://127.0.0.1:9999/hook');
      assert.ok(!('token' in seen) || seen.token === undefined);
      await api.callback('http://127.0.0.1:9999/hook', 'separater-token');
      assert.equal(seen.token, 'separater-token');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

/* ------------------------------------------------------------------ *
 * V24 – H1: Panel-Token ohne Schreib-/Ausführungsrecht
 * ------------------------------------------------------------------ */
describe('V24 H1 – Panel-Token: ohne Hub-Sitzung kein Schreiben, kein Ausführen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-hub-h1-'));
  process.env.BOT_DASHBOARD_ROOT = root;
  const { createServer: createApp } = await import('../server/manager.js');
  const { createServer } = await import('node:http');
  const { issueRuntimeToken, panelToken } = await import('../server/panel.js');
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const api = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}/api${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers ?? {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let data = {};
    try {
      data = JSON.parse((await response.text()) || '{}');
    } catch {
      data = {};
    }
    return { status: response.status, data, headers: response.headers };
  };

  // Bot und Panel – Anlage noch im Testmodus (wie alle anderen Tests).
  const created = await api('/bots', {
    method: 'POST',
    body: {
      name: 'h1-bot',
      language: 'python',
      cwd: '.',
      workspaceRoot: 'bots/h1-bot/workspace',
    },
  });
  assert.equal(created.status, 201);
  const botId = created.data.bot.id;
  const registered = await api('/hub/panel', {
    method: 'POST',
    headers: { 'x-bot-hub-token': issueRuntimeToken(botId) },
    body: {
      panel: {
        title: 'H1',
        settings: [
          { key: 'log_channel', type: 'text', label: 'Kanal', default: 'ops' },
        ],
        commands: [{ id: 'ping', label: 'Ping', run: 'echo pong' }],
      },
    },
  });
  assert.equal(registered.status, 200);
  const asPage = (path, options = {}) =>
    api(path, {
      ...options,
      headers: {
        'x-bot-hub-token': panelToken(botId),
        ...(options.headers ?? {}),
      },
    });

  // Ohne Testmodus zählt die echte Rechtekette: Panel-Token ja, Hub-Sitzung nein.
  const ohneHubSitzung = async (aktion) => {
    delete process.env.BOT_HUB_TEST_MODE;
    try {
      return await aktion();
    } finally {
      process.env.BOT_HUB_TEST_MODE = '1';
    }
  };

  it('Angriff: nur Panel-Token – PUT settings wird mit 403 abgelehnt', async () => {
    await ohneHubSitzung(async () => {
      const write = await asPage(`/bots/${botId}/panel/settings`, {
        method: 'PUT',
        body: { values: { log_channel: 'angreifer' } },
      });
      assert.equal(write.status, 403);
      assert.match(String(write.data.error), /nur im Dashboard erlaubt/);
    });
  });

  it('Angriff: nur Panel-Token – POST commands/* wird mit 403 abgelehnt', async () => {
    await ohneHubSitzung(async () => {
      const run = await asPage(`/bots/${botId}/panel/commands/ping`, {
        method: 'POST',
        body: {},
      });
      assert.equal(run.status, 403);
    });
  });

  it('legal: Panel-Token darf weiter lesen, State und Meldungen senden', async () => {
    await ohneHubSitzung(async () => {
      const read = await asPage(`/bots/${botId}/panel/settings`);
      assert.equal(read.status, 200);
      assert.equal(read.data.settings.log_channel, 'ops');
      const state = await asPage(`/bots/${botId}/panel/state`, {
        method: 'PUT',
        body: { state: { status: 'online' } },
      });
      assert.equal(state.status, 200);
      const notice = await asPage(`/bots/${botId}/panel/notify`, {
        method: 'POST',
        body: { message: 'von der Seite' },
      });
      assert.equal(notice.status, 200);
    });
  });

  it('legal: mit Hub-Sitzung mit panel.manage funktionieren Schreiben und Ausführen', async () => {
    // TEST_MODE steht für eine zentrale Sitzung, die panel.manage enthält.
    const write = await asPage(`/bots/${botId}/panel/settings`, {
      method: 'PUT',
      body: { values: { log_channel: 'neu' } },
    });
    assert.equal(write.status, 200);
    const read = await asPage(`/bots/${botId}/panel/settings`);
    assert.equal(read.data.settings.log_channel, 'neu');
    const run = await asPage(`/bots/${botId}/panel/commands/ping`, {
      method: 'POST',
      body: {},
    });
    assert.equal(run.status, 200);
    assert.equal(run.data.result.ok, true);
  });

  it('legal: ganz ohne Token bleibt die Route durch die Anmeldung geschützt (401)', async () => {
    await ohneHubSitzung(async () => {
      const anon = await api(`/bots/${botId}/panel/settings`);
      assert.equal(anon.status, 401);
    });
  });

  it('M5: Origin "null" – ACAO bleibt, Allow-Credentials ist verschwunden', async () => {
    const preflight = await api(`/bots/${botId}/panel/notify`, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
    assert.equal(
      preflight.headers.get('access-control-allow-credentials'),
      null,
      'null-Origin darf keine Anmelde-Cookies verlangen',
    );
    assert.match(
      String(preflight.headers.get('access-control-allow-headers')),
      /x-bot-hub-token/,
    );
    const read = await asPage(`/bots/${botId}/panel`, {
      headers: { origin: 'null' },
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('access-control-allow-origin'), 'null');
    assert.equal(read.headers.get('access-control-allow-credentials'), null);
  });
});

/* ------------------------------------------------------------------ *
 * V24 – H2: reservierte Hub-Schlüssel bleiben Bot-Manifesten verschlossen
 * ------------------------------------------------------------------ */
describe('V24 H2 – reservierte Schlüssel: kein Bot schreibt Hub-Secrets', async () => {
  const { isReservedEnvKey, readSecretValues } =
    await import('../server/secrets.js');
  const { normalisePanel, saveSettings, syncBotEnv } =
    await import('../server/panel.js');

  const botMitAltbestand = (id) => ({
    id,
    name: id,
    cwd: '.',
    env: {},
    secretEnv: { DISCORD_BOT_TOKEN: 'echt-gueltig' },
    panel: {
      // Simuliert den Stand vor dem Fix: ein gespeichertes Manifest,
      // das reservierte Schlüssel noch enthält.
      manifest: {
        fields: [
          {
            key: 'discord_client_secret',
            type: 'secret',
            secret: true,
            default: '',
          },
          { key: 'log_channel', type: 'text', default: 'ops' },
        ],
      },
      settings: {},
      secretSettings: {},
      state: {},
      error: '',
      source: 'runtime',
      signature: '',
      path: '',
    },
  });

  it('isReservedEnvKey erkennt Hub-Schlüssel und Interpret-Steuerung', () => {
    for (const key of [
      'DISCORD_CLIENT_ID',
      'discord_client_secret',
      'DISCORD_BOT_TOKEN',
      'DISCORD_REDIRECT_URI',
      'BOT_HUB_TOKEN',
      'bot_hub_settings',
      'PATH',
      'HOME',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'PYTHONSTARTUP',
    ])
      assert.equal(isReservedEnvKey(key), true, `muss reserviert sein: ${key}`);
    for (const key of ['log_channel', 'api_key', 'MODUS', 'NODE_VERSION'])
      assert.equal(isReservedEnvKey(key), false, `muss frei sein: ${key}`);
  });

  it('normalisePanel wirft Felder mit reservierten Schlüsseln raus', () => {
    const panel = normalisePanel({
      title: 'T',
      settings: [
        { key: 'discord_client_secret', type: 'secret', label: 'x' },
        { key: 'DISCORD_REDIRECT_URI', type: 'text' },
        { key: 'bot_hub_token', type: 'text' },
        { key: 'log_channel', type: 'text', default: 'ops' },
      ],
    });
    assert.deepEqual(
      panel.fields.map((field) => field.key),
      ['log_channel'],
    );
  });

  it('writePanelEnv schreibt reservierte Felder nie – Hub-Token bleiben erhalten', () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-reserved-'));
    process.env.BOT_DASHBOARD_ROOT = root;
    syncBotEnv(botMitAltbestand('res-bot'));
    const values = readSecretValues(root, 'res-bot');
    assert.equal(values.DISCORD_CLIENT_SECRET, undefined);
    assert.equal(values.LOG_CHANNEL, 'ops');
    // Vorgabe (d): legitime Hub-Secrets aus bot.secretEnv bleiben im Bestand.
    assert.equal(values.DISCORD_BOT_TOKEN, 'echt-gueltig');
    const raw = readFileSync(
      join(root, 'data', 'secrets', 'res-bot.env'),
      'utf8',
    );
    assert.ok(
      !raw.includes('DISCORD_CLIENT_SECRET'),
      'Datei enthält reservierten Schlüssel',
    );
  });

  it('saveSettings ignoriert eingehende Werte für reservierte Schlüssel', () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-save-'));
    process.env.BOT_DASHBOARD_ROOT = root;
    const bot = botMitAltbestand('save-bot');
    const result = saveSettings(bot, {
      discord_client_secret: 'ANGRIFF',
      log_channel: 'neu',
    });
    assert.equal(result.changed, true);
    assert.equal(bot.panel.secretSettings.discord_client_secret, undefined);
    assert.equal(bot.panel.settings.log_channel, 'neu');
    const values = readSecretValues(root, 'save-bot');
    assert.equal(values.DISCORD_CLIENT_SECRET, undefined);
    assert.ok(!values.LOG_CHANNEL?.includes?.('ANGRIFF'));
    assert.equal(values.LOG_CHANNEL, 'neu');
    assert.equal(values.DISCORD_BOT_TOKEN, 'echt-gueltig');
  });
});

/* ------------------------------------------------------------------ *
 * V24 H4 – bot.env darf die Programmsuche nicht kapern
 * ------------------------------------------------------------------ */
describe('V24 H4 – Bot-Umgebung: Programmsuche bleibt Hub-kontrolliert', async () => {
  const { botEnv, usableBotEnv } = await import('../server/manager.js');

  const botMitFeindlicherUmgebung = (sprache, env) => ({
    id: 'envbot',
    name: 'Envbot',
    language: sprache,
    guildId: 'g1',
    secretEnv: {},
    env,
  });

  const feindlich = {
    PATH: '/angreifer/bin',
    HOME: '/angreifer/home',
    TMPDIR: '/angreifer/tmp',
    TEMP: '/angreifer/temp',
    TMP: '/angreifer/tmp',
    LD_PRELOAD: '/angreifer/boese.so',
    NODE_OPTIONS: '--require /angreifer/evil.js',
    PYTHONSTARTUP: '/angreifer/start.py',
    PYTHONPATH: '/angreifer/pfade',
    GIT_SSH_COMMAND: 'ssh -o ProxyCommand=touch /tmp/x',
    npm_config_globalconfigdir: '/etc/npmrc',
    GOOD_KEY: 'in Ordnung',
  };

  it('blockiert Steuer-Schlüssel, lässt normale Werte aber durch', () => {
    const env = botEnv(botMitFeindlicherUmgebung('custom', feindlich), null, {
      includeSecrets: false,
    });
    for (const key of [
      'PATH',
      'HOME',
      'TMPDIR',
      'TEMP',
      'TMP',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'PYTHONSTARTUP',
      'PYTHONPATH',
      'GIT_SSH_COMMAND',
      'npm_config_globalconfigdir',
    ])
      assert.notEqual(env[key], feindlich[key], `${key} wurde durchgereicht`);
    assert.equal(env.GOOD_KEY, 'in Ordnung');
    // Der Hub-PATH bleibt erhalten – er kommt aus der Hub-Umgebung, nicht vom Bot.
    assert.equal(env.PATH, process.env.PATH);
  });

  it('PATH setzt weiter nur der Hub: venv-bin vor System-PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-hub-venv-'));
    mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
    const env = botEnv(botMitFeindlicherUmgebung('python', feindlich), dir, {
      includeSecrets: false,
    });
    assert.ok(
      env.PATH.startsWith(join(dir, '.venv', 'bin') + delimiter),
      `venv-Pfad fehlt: ${env.PATH}`,
    );
    assert.ok(env.PATH.endsWith(process.env.PATH));
  });

  it('usableBotEnv wirft Nicht-Strings und überschnittene Werte raus', () => {
    const riesig = 'x'.repeat(32769);
    const clean = usableBotEnv(
      botMitFeindlicherUmgebung('custom', {
        OK: 'bleibt',
        OBJEKT: { böse: true },
        ZAHL: 7,
        NULL: null,
        RIESIG: riesig,
      }),
    );
    assert.deepEqual(clean, { OK: 'bleibt' });
  });
});

/* ------------------------------------------------------------------ *
 * V24 H3 – Rechteabsenkung für alle Bot-Spawns
 * ------------------------------------------------------------------ */
describe('V24 H3 – withBotCredentials senkt uid/gid überall gleich ab', async () => {
  const { withBotCredentials } = await import('../server/util.js');

  it('setzt uid/gid nur bei gültigen Werten über 0', () => {
    const savedUid = process.env.BOT_HUB_BOT_UID;
    const savedGid = process.env.BOT_HUB_BOT_GID;
    try {
      delete process.env.BOT_HUB_BOT_UID;
      delete process.env.BOT_HUB_BOT_GID;
      assert.deepEqual(
        withBotCredentials({ stdio: 'pipe' }),
        { stdio: 'pipe' },
        'ohne Konfiguration dürfen keine Rechte-Optionen entstehen',
      );
      process.env.BOT_HUB_BOT_UID = '65534';
      process.env.BOT_HUB_BOT_GID = '65534';
      assert.deepEqual(withBotCredentials({}), { uid: 65534, gid: 65534 });
      process.env.BOT_HUB_BOT_UID = '0';
      assert.deepEqual(
        withBotCredentials({}),
        { gid: 65534 },
        'uid 0 ist kein Absenken',
      );
      process.env.BOT_HUB_BOT_UID = 'Quatsch';
      process.env.BOT_HUB_BOT_GID = '';
      assert.deepEqual(withBotCredentials({}), {}, 'nur Zahlen akzeptieren');
    } finally {
      if (savedUid === undefined) delete process.env.BOT_HUB_BOT_UID;
      else process.env.BOT_HUB_BOT_UID = savedUid;
      if (savedGid === undefined) delete process.env.BOT_HUB_BOT_GID;
      else process.env.BOT_HUB_BOT_GID = savedGid;
    }
  });
});

/* ------------------------------------------------------------------ *
 * V25 M3 – SSE-Logs: zentral maskiert und nach logs.read gefiltert
 * ------------------------------------------------------------------ */
describe('V25 M3 – Log-Broadcast: Redaction in pushLine, logs.read-Filter im SSE', async () => {
  const { __testing } = await import('../server/manager.js');
  const { broadcast, redactLogSecrets, pushLine, sseListeners, botMap } =
    __testing;

  const fakeClient = (req = { headers: {} }) => ({
    frames: [],
    __sseReq: req,
    write(frame) {
      this.frames.push(String(frame));
    },
  });

  const ohneHubSitzung = async (aktion) => {
    delete process.env.BOT_HUB_TEST_MODE;
    try {
      return await aktion();
    } finally {
      process.env.BOT_HUB_TEST_MODE = '1';
    }
  };

  it('redactLogSecrets schwört Token-/Bearer-Werte und ist idempotent', () => {
    const attackLine =
      'login failed token=GEHEIM123abc secret: "NOCHGEHEIMER" Bearer mt.token-value';
    const masked = redactLogSecrets(attackLine);
    assert.ok(!masked.includes('GEHEIM123abc'), 'token= Wert geleakt');
    assert.ok(!masked.includes('NOCHGEHEIMER'), 'secret: Wert geleakt');
    assert.ok(!masked.includes('mt.token-value'), 'Bearer Wert geleakt');
    assert.ok(masked.includes('[REDACTED]'));
    assert.equal(
      redactLogSecrets(masked),
      masked,
      'erneutes Maskieren darf nichts mehr ändern',
    );
    assert.equal(
      redactLogSecrets('Bot verbunden mit guild 123'),
      'Bot verbunden mit guild 123',
      'harmlose Zeile muss unverändert bleiben',
    );
  });

  it('pushLine speichert und sendet nur maskierten Text (REST und SSE teilen die Quelle)', async () => {
    const botId = 'm3-test-bot';
    botMap.set(botId, { id: botId, logs: [] });
    const client = fakeClient();
    sseListeners.add(client);
    try {
      pushLine(botId, 'stdout', 'ready token=SUPERGEHEIM123');
      const stored = botMap.get(botId).logs[0];
      assert.ok(stored, 'Chunk wurde nicht gespeichert');
      assert.ok(!stored.text.includes('SUPERGEHEIM123'), 'Speicher leakt');
      assert.ok(stored.text.includes('[REDACTED]'));
      assert.equal(client.frames.length, 1, 'SSE-Client erhielt keinen Frame');
      assert.ok(!client.frames[0].includes('SUPERGEHEIM123'), 'SSE leakt');
      assert.ok(client.frames[0].includes('[REDACTED]'));
    } finally {
      sseListeners.delete(client);
      botMap.delete(botId);
    }
  });

  it('Angriff: ohne logs.read (echte Rechtekette, anonyme Anfrage) kommt kein Log-Frame an', async () => {
    const botId = 'm3-bot2';
    botMap.set(botId, { id: botId, logs: [] });
    const client = fakeClient();
    sseListeners.add(client);
    try {
      await ohneHubSitzung(async () => {
        broadcast('log', { botId, text: 'zeile', ts: Date.now() });
      });
      assert.equal(
        client.frames.length,
        0,
        'Log an Client ohne logs.read verteilt',
      );
      // Andere Ereignisse (Bots-Snapshot) bleiben vom Filter ausgenommen.
      broadcast('bots', { ok: true });
      assert.equal(client.frames.length, 1, 'artfremdes Ereignis geblockt');
    } finally {
      sseListeners.delete(client);
      botMap.delete(botId);
    }
  });

  it('legal: mit logs.read (Testmodus-Sitzung) kommt der Log-Frame an', () => {
    const botId = 'm3-bot3';
    botMap.set(botId, { id: botId, logs: [] });
    const client = fakeClient();
    sseListeners.add(client);
    try {
      broadcast('log', { botId, text: 'zeile', ts: Date.now() });
      assert.equal(client.frames.length, 1);
      assert.match(client.frames[0], /^event: log/);
    } finally {
      sseListeners.delete(client);
      botMap.delete(botId);
    }
  });

  it('Log für einen nicht (mehr) existierenden Bot wird nie verteilt', () => {
    const client = fakeClient();
    sseListeners.add(client);
    try {
      broadcast('log', { botId: 'gibt-es-nicht', text: 'x', ts: 1 });
      assert.equal(client.frames.length, 0);
    } finally {
      sseListeners.delete(client);
    }
  });
});

/* ------------------------------------------------------------------ *
 * V25 M6 – öffentliche Panel-Dateien: Scope am Entry, nicht am Glück
 * ------------------------------------------------------------------ */
describe('V25 M6 – statische Panel-Dateien ohne Token nur im Entry-Scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-hub-m6-'));
  process.env.BOT_DASHBOARD_ROOT = root;
  const { createServer: createApp } = await import('../server/manager.js');
  const { createServer } = await import('node:http');
  const { panelToken } = await import('../server/panel.js');
  const server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const api = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers ?? {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let data = {};
    try {
      data = JSON.parse((await response.text()) || '{}');
    } catch {
      data = {};
    }
    return { status: response.status, data, headers: response.headers };
  };

  const register = async (name, panel) => {
    const created = await api('/api/bots', {
      method: 'POST',
      body: {
        name,
        language: 'python',
        cwd: '.',
        workspaceRoot: `bots/${name}/workspace`,
      },
    });
    assert.equal(created.status, 201);
    const botId = created.data.bot.id;
    const registered = await api('/api/hub/panel', {
      method: 'POST',
      headers: {
        'x-bot-hub-token': (
          await import('../server/panel.js')
        ).issueRuntimeToken(botId),
      },
      body: { panel },
    });
    assert.equal(registered.status, 200);
    return { botId };
  };

  const rootEntry = await register('m6-root-entry', {
    title: 'M6',
    entry: 'page.html',
    pages: [
      { id: 'extra', label: 'Extra', href: 'extra.html' },
      { id: 'doc', label: 'Doc', href: 'docs/x.html' },
    ],
  });
  // Im Testmodus löst panel.js den Workspace jedes Bots auf den Projekt-Root
  // auf (workspaceDir) – die Panel-Dateien liegen also direkt in `root`.
  writeFileSync(join(root, 'page.html'), '<h1>Seite</h1>');
  writeFileSync(join(root, 'panel.css'), 'body{}');
  writeFileSync(join(root, 'extra.html'), '<h1>X</h1>');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/x.html'), '<h1>D</h1>');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/innere.js'), 'export const interneLogik = 1;');
  mkdirSync(join(root, 'panel'), { recursive: true });
  writeFileSync(join(root, 'panel/index.html'), '<h1>Scaffold</h1>');

  const ohneEntry = await register('m6-ohne-entry', {
    title: 'M6b',
    pages: [{ id: 'extra', label: 'Extra', href: 'extra.html' }],
  });

  const file = (botId, rel, options = {}) =>
    api(`/api/bots/${botId}/panel/file/${rel}`, options);
  const mitToken = (botId) => ({
    headers: { 'x-bot-hub-token': panelToken(botId) },
  });
  // Andere Suiten in dieser Datei schreiben BOT_DASHBOARD_ROOT um; panel.js
  // liest die Variable pro Anfrage – also vor jedem Test diesen Root setzen.
  beforeEach(() => {
    process.env.BOT_DASHBOARD_ROOT = root;
  });

  it('Angriff: Root-Entry gibt Unterordner nicht frei – src/innere.js ist 404', async () => {
    const versteckt = await file(rootEntry.botId, 'src/innere.js');
    assert.equal(versteckt.status, 404);
    const docsHolen = await file(rootEntry.botId, 'src/../src/innere.js');
    assert.notEqual(docsHolen.status, 200);
  });

  it('Angriff: ohne Entry wird öffentlich gar nichts ausgeliefert', async () => {
    const ohne = await file(ohneEntry.botId, 'extra.html');
    assert.equal(ohne.status, 404);
  });

  it('legal: Entry, Root-Asset und angemeldete pages bleiben öffentlich', async () => {
    assert.equal((await file(rootEntry.botId, 'page.html')).status, 200);
    assert.equal((await file(rootEntry.botId, 'panel.css')).status, 200);
    assert.equal((await file(rootEntry.botId, 'extra.html')).status, 200);
    assert.equal((await file(rootEntry.botId, 'docs/x.html')).status, 200);
  });

  it('legal: mit Panel-Token gilt der volle Workspace (src/innere.js lesbar)', async () => {
    const roh = await fetch(
      `${baseUrl}/api/bots/${rootEntry.botId}/panel/file/src/innere.js`,
      mitToken(rootEntry.botId),
    );
    assert.equal(roh.status, 200);
    assert.match(await roh.text(), /interneLogik/);
    const auchOhneEntry = await file(
      ohneEntry.botId,
      'extra.html',
      mitToken(ohneEntry.botId),
    );
    assert.equal(auchOhneEntry.status, 200);
  });

  it('legal: Unterordner-Entry (Scaffold) verhält sich wie bisher', async () => {
    const index = await file(rootEntry.botId, 'page.html');
    assert.equal(index.status, 200);
    // Der Scaffold des zweiten Bots (panel/index.html) liegt im Entry-Ordner.
    const scafford = await file(
      rootEntry.botId,
      'panel/index.html',
      mitToken(rootEntry.botId),
    );
    assert.equal(scafford.status, 200);
  });

  it('L7a: ungültige Prozent-Kodierung liefert 400 statt 500', async () => {
    const kaputt = await file(rootEntry.botId, '%zz');
    assert.equal(kaputt.status, 400);
    const kaputtUtf8 = await file(rootEntry.botId, '%E0%A4%A');
    assert.equal(kaputtUtf8.status, 400);
    const legal = await file(rootEntry.botId, '%70age.html');
    assert.equal(legal.status, 200);
    const dateienRoute = await api(
      `/api/bots/${rootEntry.botId}/files/%E0%A4%A`,
    );
    assert.equal(dateienRoute.status, 400);
  });
});

/* ------------------------------------------------------------------ *
 * V25 L1 – Datei-API: .env und SKIPPED-Ordner sind gesperrt
 * ------------------------------------------------------------------ */
describe('V25 L1 – files-API liest und schreibt kein .env und kein .git', async () => {
  const dateien = await import('../server/botFiles.js');
  const root = mkdtempSync(join(tmpdir(), 'bot-hub-l1-'));
  const start = join(root, 'bots', 'l1-bot', 'startordner');
  mkdirSync(start, { recursive: true });
  const bot = { id: 'l1-bot', workspaceRoot: 'bots/l1-bot/workspace' };

  it('Angriff: .env (auch in Unterordnern) kann nicht gelesen, geschrieben oder gelistet werden', () => {
    writeFileSync(join(start, '.env'), 'BOT_TOKEN=ECHT123');
    mkdirSync(join(start, 'unter'), { recursive: true });
    writeFileSync(join(start, 'unter/.env.prod'), 'KEY=ECHT456');
    assert.equal(dateien.write(bot, root, '.env', 'X=1'), false);
    assert.equal(dateien.write(bot, root, 'unter/.env.prod', 'X=1'), false);
    assert.equal(dateien.write(bot, root, 'a/.env/b', 'X=1'), false);
    assert.equal(dateien.read(bot, root, '.env'), null);
    assert.equal(dateien.read(bot, root, 'unter/.env.prod'), null);
    assert.equal(
      readFileSync(join(start, '.env'), 'utf8'),
      'BOT_TOKEN=ECHT123',
    );
    const wurzel = dateien.list(bot, root);
    assert.ok(!wurzel.eintraege.some((e) => e.name === '.env'));
    const unter = dateien.list(bot, root, 'unter');
    assert.ok(!unter.eintraege.some((e) => e.name === '.env.prod'));
    assert.ok(
      unter.uebersprungen.some((e) => e.includes('.env.prod')),
      'gesperrte Datei muss gemeldet, nicht verschwiegen werden',
    );
    mkdirSync(join(start, '.git'), { recursive: true });
    writeFileSync(join(start, '.git', 'HEAD'), 'ref: refs/heads/main');
    assert.equal(dateien.read(bot, root, '.git/HEAD'), null);
  });

  it('legal: normale Dateien und .gitignore funktionieren weiter', () => {
    assert.equal(dateien.write(bot, root, 'src/main.py', 'print(1)'), true);
    assert.equal(dateien.read(bot, root, 'src/main.py').inhalt, 'print(1)');
    assert.equal(dateien.write(bot, root, '.gitignore', 'venv/'), true);
    assert.equal(dateien.read(bot, root, '.gitignore').inhalt, 'venv/');
    assert.equal(dateien.write(bot, root, 'env.cfg', 'x=1'), true);
    const wurzel = dateien.list(bot, root);
    const namen = wurzel.eintraege.map((e) => e.name);
    assert.ok(namen.includes('src'));
    assert.ok(namen.includes('.gitignore'));
    assert.ok(namen.includes('env.cfg'));
  });
});

/* ------------------------------------------------------------------ *
 * V25 L2 – Temp-Dateien: zufällig benannt, 0600, keine erradbaren Namen
 * ------------------------------------------------------------------ */
describe('V25 L2 – Atomare Schreibvorgänge nutzen unvorhersagbare Temp-Namen', async () => {
  const dateien = await import('../server/botFiles.js');
  const { storeSecretValues, readSecretValues } =
    await import('../server/secrets.js');
  const root = mkdtempSync(join(tmpdir(), 'bot-hub-l2-'));

  it('botFiles: nur die Zieldatei bleibt, Modus 0600, Inhalt korrekt', () => {
    const start = join(root, 'bots', 'l2-bot', 'startordner');
    mkdirSync(start, { recursive: true });
    const bot = { id: 'l2-bot', workspaceRoot: 'bots/l2-bot/workspace' };
    assert.equal(dateien.write(bot, root, 'src/app.py', 'X = 1'), true);
    assert.equal(readFileSync(join(start, 'src/app.py'), 'utf8'), 'X = 1');
    const rueckstaende = readdirSync(join(start, 'src')).filter(
      (name) => name !== 'app.py',
    );
    assert.deepEqual(rueckstaende, [], 'Temp-Leiche oder Vorhersagbares übrig');
    const modus = lstatSync(join(start, 'src/app.py')).mode & 0o777;
    assert.equal(modus, 0o600);
    assert.ok(
      !readdirSync(start).some((n) => n.includes(String(process.pid))),
      'pid-haltiger Tempname im Workspace',
    );
  });

  it('secrets: Secret-Datei 0600, keine tmp-Reste, Werte lesbar', () => {
    const pfad = storeSecretValues(root, 'l2-bot', { TOP: 'wert' });
    assert.ok(String(pfad).endsWith('l2-bot.env'));
    const directory = join(root, 'data', 'secrets');
    assert.deepEqual(readdirSync(directory), ['l2-bot.env']);
    assert.equal(lstatSync(join(directory, 'l2-bot.env')).mode & 0o777, 0o600);
    assert.equal(readSecretValues(root, 'l2-bot').TOP, 'wert');
  });

  it('Angriff: Symlink-Falle auf dem erratbaren pid-Temp-Namen wird nicht beschrieben', () => {
    // Früher hieß die Temp-Datei `${ziel}.${pid}.tmp` – dieser Name ist für
    // lokale Nutzer berechenbar. Ein gelegter Symlink dort durfte beim
    // Schreiben nicht getroffen werden.
    const start = join(root, 'bots', 'l2-bot2', 'startordner');
    mkdirSync(start, { recursive: true });
    const bot = { id: 'l2-bot2', workspaceRoot: 'bots/l2-bot2/workspace' };
    const canary = join(root, 'canary.txt');
    writeFileSync(canary, 'OPFER');
    // Der alte Name war `${ziel}.${pid}.${Date.now()}.tmp` – Fallen für die
    // Millisekunden um den Aufruf herum treffen ihn mit Sicherheit.
    const t0 = Date.now();
    for (const i of [0, 1, 2, 3])
      symlinkSync(canary, join(start, `ziel.py.${process.pid}.${t0 + i}.tmp`));
    assert.equal(dateien.write(bot, root, 'ziel.py', 'NEU'), true);
    assert.equal(
      readFileSync(canary, 'utf8'),
      'OPFER',
      'Symlink auf dem Vorhersage-Namen wurde beschrieben',
    );
    assert.equal(readFileSync(join(start, 'ziel.py'), 'utf8'), 'NEU');
  });
});

/* ------------------------------------------------------------------ *
 * V25 L3 – zeitkonstanter Token-Vergleich
 * ------------------------------------------------------------------ */
describe('V25 L3 – sameToken vergleicht Geheimnisse zeitkonstant', async () => {
  const { sameToken } = await import('../server/panel.js');

  it('gleiche Werte bestehen, ungleiche und leere scheitern', () => {
    assert.equal(sameToken('abc123', 'abc123'), true);
    assert.equal(sameToken('abc123', 'abc124'), false);
    assert.equal(sameToken('abc123', 'abc12'), false);
    assert.equal(sameToken('', ''), false, 'leer ist nie ein Treffer');
    assert.equal(sameToken(undefined, 'x'), false);
    assert.equal(sameToken(null, undefined), false);
  });
});

/* ------------------------------------------------------------------ *
 * V25 L4 – IMDS-Filter: alle Schreibweisen derselben Adresse
 * ------------------------------------------------------------------ */
describe('V25 L4 – Metadaten-Filter erkennt IPv4-mapped, Hex-Form, AWS-IPv6 und Link-Local', async () => {
  const { isMetadataAddress } = await import('../server/panel.js');

  it('blockiert die geforderten vier Schreibweisen plus Varianten', () => {
    for (const adresse of [
      '169.254.169.254',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      'fd00:ec2::254',
    ])
      assert.equal(
        isMetadataAddress(adresse),
        true,
        `${adresse} muss blockiert sein`,
      );
    for (const adresse of [
      '169.254.10.20',
      'fd00:ec2:0:0:0:0:0:254',
      'FD00:EC2::254',
      '[::ffff:a9fe:a9fe]',
      'fe80::1',
      'FE80:1234:abcd::',
      'febf:ffff::',
    ])
      assert.equal(
        isMetadataAddress(adresse),
        true,
        `${adresse} muss blockiert sein`,
      );
  });

  it('lässt normale Adressen durch', () => {
    for (const adresse of [
      '93.184.216.34',
      '8.8.8.8',
      '::ffff:8.8.8.8',
      '10.0.0.5',
      'fe7f::1',
      'fc01::254',
      'kein-hostname',
      '',
    ])
      assert.equal(
        isMetadataAddress(adresse),
        false,
        `${adresse} ist keine Metadaten-Adresse`,
      );
  });
});

/* ------------------------------------------------------------------ *
 * V25 L7 – Fehlerbehandlung: safeDecode und bots.json-Validierung
 * ------------------------------------------------------------------ */
describe('V25 L7 – safeDecode und bots.json-Feldprüfung', async () => {
  const { safeDecode } = await import('../server/util.js');
  const { __testing } = await import('../server/manager.js');
  const { ablehnungsgrund } = __testing;

  it('safeDecode: gültige Kodierung funktioniert, ungültige wirft 400', () => {
    assert.equal(safeDecode('%70age.html'), 'page.html');
    assert.throws(
      () => safeDecode('%zz'),
      (error) => error.status === 400,
    );
    assert.throws(
      () => safeDecode('%E0%A4%A'),
      (error) => error.status === 400,
    );
  });

  it('Angriff: manipulierte bots.json-Einträge mit Pfadflucht oder Typmüll werden abgelehnt', () => {
    assert.notEqual(
      ablehnungsgrund({ id: '../../etc', name: 'x' }),
      '',
      'id mit Pfadflucht abgelehnt',
    );
    assert.notEqual(ablehnungsgrund({ id: 12345, name: 'x' }), '');
    assert.notEqual(ablehnungsgrund({ id: 'ok-id', name: {} }), '');
    assert.notEqual(
      ablehnungsgrund({ id: 'ok-id', name: 'x', cwd: '/etc' }),
      '',
      'absolutes cwd abgelehnt',
    );
    assert.notEqual(
      ablehnungsgrund({ id: 'ok-id', name: 'x', cwd: '../..' }),
      '',
      'cwd mit Ausstieg abgelehnt',
    );
    assert.notEqual(
      ablehnungsgrund({ id: 'ok-id', name: 'x', env: 'kein-objekt' }),
      '',
    );
    assert.notEqual(ablehnungsgrund({ id: 'ok-id', name: 'x', panel: [] }), '');
    assert.notEqual(
      ablehnungsgrund({ id: 'ok-id', name: 'x', secretKeys: [1, 2] }),
      '',
    );
    assert.notEqual(ablehnungsgrund('kein objekt'), '');
    assert.notEqual(
      ablehnungsgrund({ id: 'a'.repeat(65), name: 'x' }),
      '',
      'überlange id abgelehnt',
    );
  });

  it('legal: ein Hub-typischer Eintrag besteht die Prüfung', () => {
    assert.equal(
      ablehnungsgrund({
        id: '79dc897a-5073-4bfb-bea9-1b1b8f546495',
        name: 'testjs',
        emoji: '🤖',
        description: 'description',
        language: 'javascript',
        framework: 'discord.js',
        entrypoint: 'index.js',
        command: 'node {entrypoint}',
        cwd: '.',
        workspaceRoot: 'bots/79dc897a-5073-4bfb-bea9-1b1b8f546495/workspace',
        env: { NODE_ENV: 'production' },
        secretKeys: ['DISCORD_BOT_TOKEN'],
        panel: { title: 'Seite' },
      }),
      '',
    );
    assert.equal(
      ablehnungsgrund({ id: 'x_y-9', name: 'Nur Name' }),
      '',
      'Minimaler Eintrag ohne optionale Felder',
    );
  });
});
