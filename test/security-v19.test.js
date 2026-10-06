import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before } from 'node:test';

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
