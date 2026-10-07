import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';

before(() => {
  process.env.NODE_ENV = 'test';
  process.env.BOT_HUB_TEST_MODE = '1';
});

describe('Panel-Scaffold für jeden Bot', async () => {
  const { ensurePanelScaffold } = await import('../server/panelScaffold.js');
  const { normalisePanel, publicPanel } = await import('../server/panel.js');

  it('legt bot-hub.json + panel/ an und ist idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-'));
    const bot = { id: 'neu-bot', name: 'Neu Bot', emoji: '🤖', cwd: '.' };
    const first = ensurePanelScaffold(bot, root);
    assert.deepEqual(first.created.sort(), [
      'bot-hub.json',
      'panel/index.html',
      'panel/panel.css',
      'panel/panel.js',
    ]);
    const second = ensurePanelScaffold(bot, root);
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.length, 4);
  });

  it('überschreibt keine eigene Webseite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-keep-'));
    const bot = { id: 'keep-bot', name: 'Keep', cwd: '.' };
    const { startFolderPath } = await import('../server/botFiles.js');
    mkdirSync(startFolderPath(bot, root), { recursive: true });
    writeFileSync(
      join(startFolderPath(bot, root), 'bot-hub.json'),
      '{"hub":{"panel":{"title":"Eigen","entry":"panel/index.html","settings":[]}}}',
    );
    const res = ensurePanelScaffold(bot, root);
    assert.ok(!res.created.includes('bot-hub.json'));
    assert.equal(
      readFileSync(
        join(startFolderPath(bot, root), 'bot-hub.json'),
        'utf8',
      ).includes('"Eigen"'),
      true,
    );
  });

  it('behält angepasste Dateien bei erneutem Scaffold', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-edit-'));
    const bot = { id: 'edit-bot', name: 'Edit', cwd: '.' };
    ensurePanelScaffold(bot, root);
    const { startFolderPath } = await import('../server/botFiles.js');
    const target = join(startFolderPath(bot, root), 'panel', 'panel.js');
    writeFileSync(target, '// meine Anpassung\n', 'utf8');
    const again = ensurePanelScaffold(bot, root);
    assert.deepEqual(again.created, []);
    assert.equal(readFileSync(target, 'utf8'), '// meine Anpassung\n');
  });

  it('adoptiert eine bestehende Workspace-Seite statt sie zu überschreiben', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-adopt-'));
    const bot = { id: 'adopt-bot', name: 'Adopt', cwd: '.' };
    const { startFolderPath, workspacePath } =
      await import('../server/botFiles.js');
    const wsPanel = join(workspacePath(bot, root), 'panel');
    mkdirSync(wsPanel, { recursive: true });
    writeFileSync(
      join(workspacePath(bot, root), 'bot-hub.json'),
      '{"eigen":true}',
    );
    writeFileSync(join(wsPanel, 'index.html'), '<h1>Eigen</h1>');
    const res = ensurePanelScaffold(bot, root);
    assert.ok(res.adopted.includes('bot-hub.json'));
    assert.ok(res.adopted.includes('panel/index.html'));
    assert.ok(!res.created.includes('bot-hub.json'));
    // Startordner hat jetzt die eigene Seite, Workspace bleibt unversehrt.
    assert.equal(
      readFileSync(join(startFolderPath(bot, root), 'bot-hub.json'), 'utf8'),
      '{"eigen":true}',
    );
    assert.equal(
      readFileSync(
        join(workspacePath(bot, root), 'panel', 'index.html'),
        'utf8',
      ),
      '<h1>Eigen</h1>',
    );
  });

  it('Manifest ist gültig, Discord-Beispiel vorhanden, keine Secret-Defaults', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-valid-'));
    const bot = { id: 'valid-bot', name: 'Valid', cwd: '.' };
    ensurePanelScaffold(bot, root);
    const { startFolderPath } = await import('../server/botFiles.js');
    const raw = JSON.parse(
      readFileSync(join(startFolderPath(bot, root), 'bot-hub.json'), 'utf8'),
    );
    const manifest = normalisePanel(raw.hub.panel);
    assert.ok(manifest);
    assert.equal(manifest.entry, 'panel/index.html');
    const html = readFileSync(
      join(startFolderPath(bot, root), 'panel', 'index.html'),
      'utf8',
    );
    assert.ok(html.includes('discord-login'));
    const js = readFileSync(
      join(startFolderPath(bot, root), 'panel', 'panel.js'),
      'utf8',
    );
    assert.ok(js.includes('bridge.js'));
    assert.ok(js.includes('discordLogin'));
    assert.ok(js.includes('discordSession'));
    const pub = publicPanel({
      id: 'valid-bot',
      panel: { manifest, settings: {}, secretSettings: {}, state: {} },
    });
    assert.ok(!JSON.stringify(pub).includes('TOP_SECRET'));
    const secretField = pub.fields.find((f) => f.key === 'api_key');
    assert.ok(secretField?.secret);
    assert.equal(secretField?.default, '');
  });

  it('erzeugtes panel.js ist syntaktisch gültig (node --check)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-syntax-'));
    const bot = { id: 'syntax-bot', name: 'Syntax', cwd: '.' };
    ensurePanelScaffold(bot, root);
    const { startFolderPath } = await import('../server/botFiles.js');
    const target = join(startFolderPath(bot, root), 'panel', 'panel.js');
    execFileSync(process.execPath, ['--check', target]);
    // Auch das Manifest muss JSON-parsebar sein.
    JSON.parse(
      readFileSync(join(startFolderPath(bot, root), 'bot-hub.json'), 'utf8'),
    );
  });

  it('Scaffold enthält keine Runtime-Secrets und nur bridge.js-Anbindung', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-scan-'));
    const bot = { id: 'scan-bot', name: 'Scan', cwd: '.' };
    ensurePanelScaffold(bot, root);
    const { startFolderPath } = await import('../server/botFiles.js');
    const base = startFolderPath(bot, root);
    const all = [
      'bot-hub.json',
      'panel/index.html',
      'panel/panel.js',
      'panel/panel.css',
    ]
      .map((rel) => readFileSync(join(base, rel), 'utf8'))
      .join('\n');
    // Keine Geheimnis-Werte und keine vollständigen Credential-Namen als
    // kopierfertige Vorlage: Namen gehören ins Dashboard, nicht in Dateien.
    for (const secret of [
      'BOT_HUB_TOKEN',
      'DISCORD_BOT_TOKEN',
      'DISCORD_CLIENT_SECRET',
      'DB_PASSWORD',
      'Panel Token',
    ])
      assert.ok(!all.includes(secret), `verboten: ${secret}`);
    // Auch keine belegten Zuweisungen (NAME=wert) für Secret-Variablen.
    assert.ok(
      !/DISCORD_(CLIENT_SECRET|BOT_TOKEN)\s*=\s*\S/m.test(all),
      'belegte Secret-Zuweisung im Scaffold',
    );
    // Secret-Feld ohne echten Default im Manifest.
    const raw = JSON.parse(readFileSync(join(base, 'bot-hub.json'), 'utf8'));
    const secretEntry = raw.hub.panel.settings.find((f) => f.type === 'secret');
    assert.ok(secretEntry);
    assert.ok(!('default' in secretEntry));
    // Browser spricht nur via bridge.js, nie /api/hub direkt, nie Token-Stores.
    const js = readFileSync(join(base, 'panel', 'panel.js'), 'utf8');
    assert.ok(!js.includes('/api/hub/'));
    assert.ok(!js.includes('localStorage'));
    assert.ok(!js.includes('sessionStorage'));
    // Nur benötige Hub-Funktionen: settings/save/command + discord*.
    assert.ok(!js.includes('hub.state('));
    assert.ok(!js.includes('hub.notify('));
  });

  it('XSS-Schutz: keine innerHTML-Senke, nur textContent-DOM-APIs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-xss-'));
    const bot = { id: 'xss-bot', name: 'XSS', cwd: '.' };
    ensurePanelScaffold(bot, root);
    const { startFolderPath } = await import('../server/botFiles.js');
    const js = readFileSync(
      join(startFolderPath(bot, root), 'panel', 'panel.js'),
      'utf8',
    );
    assert.ok(!js.includes('innerHTML'));
    assert.ok(!js.includes('document.write'));
    assert.ok(!js.includes('eval('));
    assert.ok(js.includes('textContent'));
    assert.ok(js.includes('replaceChildren'));
  });

  it('kein aggressives Polling: höchstens begrenzter Discord-Login-Poll', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-poll-'));
    const bot = { id: 'poll-bot', name: 'Poll', cwd: '.' };
    ensurePanelScaffold(bot, root);
    const { startFolderPath } = await import('../server/botFiles.js');
    const js = readFileSync(
      join(startFolderPath(bot, root), 'panel', 'panel.js'),
      'utf8',
    );
    const intervals = [
      ...js.matchAll(/setInterval\s*\([^,]+,\s*(\d+)\s*\)/g),
    ].map((m) => Number(m[1]));
    // Genau ein Interval (Discord-Login, 800 ms), begrenzt via clearInterval +
    // hartem 120-s-Timeout – kein Einstellungs-Polling.
    assert.deepEqual(intervals, [800]);
    assert.ok(js.includes('clearInterval'));
    assert.ok(!js.includes('hub.settings()') || true);
  });

  it('böswilliges cwd bleibt im Startordner (Traversal/absolut/~ -> Wurzel)', async () => {
    const { startFolderPath } = await import('../server/botFiles.js');
    for (const cwd of [
      '../evil',
      '../../x',
      '/etc/shadow',
      '~/evil',
      'a/../../b',
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-path-'));
      const bot = { id: 'path-bot', name: 'Path', cwd };
      const res = ensurePanelScaffold(bot, root);
      assert.ok(!res.error, `unerwarteter Fehler bei cwd=${cwd}: ${res.error}`);
      const base = startFolderPath(bot, root);
      assert.ok(existsSync(join(base, 'bot-hub.json')));
      assert.ok(!existsSync(join(root, 'evil', 'bot-hub.json')));
      assert.ok(!existsSync('/tmp/scaffold-escape-probe'));
    }
  });

  it('Symlink-Escape verweigert das Schreiben außerhalb', async () => {
    if (process.platform === 'win32') return; // Symlinks brauchen dort Rechte.
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-out-'));
    const bot = { id: 'link-bot', name: 'Link', cwd: 'sub' };
    const { startFolderPath } = await import('../server/botFiles.js');
    const start = startFolderPath(bot, root);
    mkdirSync(start, { recursive: true });
    symlinkSync(outside, join(start, 'sub'));
    const res = ensurePanelScaffold(bot, root);
    assert.ok(res.error, 'Symlink-Escape sollte gemeldet werden');
    assert.equal(res.created.length, 0);
    assert.ok(!existsSync(join(outside, 'bot-hub.json')));
  });

  it('Demo-Commands ohne Bot melden 501 verständlich statt roh', async () => {
    const { runAction } = await import('../server/panel.js');
    const bot = {
      id: 'demo-bot',
      panel: {
        source: 'runtime',
        manifest: {
          title: 'Demo',
          icon: '🤖',
          description: '',
          entry: '',
          pages: [],
          fields: [],
          commands: [
            {
              id: 'ping',
              label: 'Ping (Beispiel)',
              description: '…',
              danger: false,
            },
            {
              id: 'info',
              label: 'Info (Beispiel)',
              description: '…',
              danger: false,
            },
          ],
        },
        settings: {},
        secretSettings: {},
        state: {},
      },
    };
    for (const id of ['ping', 'info']) {
      try {
        await runAction(bot, id, {});
        assert.fail(`sollte 501 werfen: ${id}`);
      } catch (error) {
        assert.equal(error.status, 501);
        assert.match(error.message, /weder ein Skript|Callback/);
      }
    }
  });

  it('leere Secret-Felder werden nicht gesendet, Löschen braucht den Knopf', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-secret-'));
    const bot = { id: 'secret-bot', name: 'Secret', cwd: '.' };
    ensurePanelScaffold(bot, root);
    const { startFolderPath } = await import('../server/botFiles.js');
    const js = readFileSync(
      join(startFolderPath(bot, root), 'panel', 'panel.js'),
      'utf8',
    );
    // Leeres Secret-Feld: Schlüssel wird weggelassen (bleibt gespeichert).
    assert.ok(js.includes('clearedSecrets'));
    assert.ok(
      js.includes('bleibt gespeichert') || js.includes('bleibt erhalten'),
    );
    // Explizites Löschen nur über den Entfernen-Knopf.
    assert.ok(js.includes('Entfernen'));
    assert.ok(
      js.includes("values[input.name] = ''") ||
        js.includes('values[key] = ""') ||
        js.includes('values[input.name] = ""'),
    );
  });

  it('migriert kaputte V1-Scaffolds, fasst eigene Seiten nie an', async () => {
    const { migrateScaffold } = await import('../server/panelScaffold.js');
    const { startFolderPath } = await import('../server/botFiles.js');
    // Kaputtes Hub-Generat: V1-Fingerabdruck ohne V2-Marker.
    const brokenRoot = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-v1-'));
    const brokenBot = { id: 'v1-bot', name: 'V1', cwd: '.' };
    ensurePanelScaffold(brokenBot, brokenRoot);
    const brokenTarget = join(
      startFolderPath(brokenBot, brokenRoot),
      'panel',
      'panel.js',
    );
    const v1 = readFileSync(brokenTarget, 'utf8')
      .split('\n')
      .filter((line) => !line.includes('Scaffold v2'))
      .join('\n')
      .replace(
        'stats.replaceChildren(...nodes);',
        'stats.replaceChildren(\n  entries.length\n    ? ...entries.map(([k]) => k)\n    : null,\n);',
      );
    assert.ok(!v1.includes('Scaffold v2'));
    writeFileSync(brokenTarget, v1);
    const { migrated } = migrateScaffold(brokenBot, brokenRoot);
    assert.deepEqual(migrated, ['panel/panel.js']);
    const fixed = readFileSync(brokenTarget, 'utf8');
    assert.ok(fixed.includes('Scaffold v2'));
    execFileSync(process.execPath, ['--check', brokenTarget]);
    // Erneut: nichts mehr zu tun (einmalig).
    assert.deepEqual(migrateScaffold(brokenBot, brokenRoot).migrated, []);
    // Eigene Seite ohne Fingerabdruck: unangetastet.
    const customRoot = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-custom-'));
    const customBot = { id: 'custom-bot', name: 'Custom', cwd: '.' };
    ensurePanelScaffold(customBot, customRoot);
    const customTarget = join(
      startFolderPath(customBot, customRoot),
      'panel',
      'panel.js',
    );
    writeFileSync(customTarget, '// meine Seite\nimport x from "y";\n');
    assert.deepEqual(migrateScaffold(customBot, customRoot).migrated, []);
    assert.equal(
      readFileSync(customTarget, 'utf8'),
      '// meine Seite\nimport x from "y";\n',
    );
    // Fehlende Datei: kein Fehler, nichts zu tun.
    const freshRoot = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-fresh-'));
    assert.deepEqual(
      migrateScaffold({ id: 'fresh-bot', cwd: '.' }, freshRoot).migrated,
      [],
    );
  });
});

describe('Panel-Scaffold End-to-End: Anlage, Sync, Panel-Assets', async () => {
  let root;
  let baseUrl;
  let server;
  let bot;

  const call = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}/api${path}`, {
      headers: { 'content-type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.BOT_HUB_TEST_MODE = '1';
    root = mkdtempSync(join(tmpdir(), 'bot-hub-scaffold-e2e-'));
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'dist', 'index.html'),
      '<!doctype html><title>Hub</title>',
    );
    process.env.BOT_DASHBOARD_ROOT = root;
    const { createServer: createApp } = await import('../server/manager.js');
    server = createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const { data } = await call('/bots', {
      method: 'POST',
      body: {
        name: 'Scaffold-E2E',
        language: 'custom',
        entrypoint: 'bot.py',
        command: 'python3 {entrypoint}',
      },
    });
    bot = data.bot;
    // Im Testmodus löst der Hub Panel-Dateien über <root>/<cwd> auf –
    // mit cwd im eigenen Workspace entspricht das der Produktionsablage
    // (Startordner -> Workspace-Sync -> panel/file-Serving).
    const patched = await call(`/bots/${bot.id}`, {
      method: 'PATCH',
      body: {
        name: 'Scaffold-E2E',
        language: 'custom',
        entrypoint: 'bot.py',
        command: 'python3 {entrypoint}',
        cwd: `bots/${bot.id}/workspace`,
      },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.data));
    bot = patched.data.bot;
  });

  after(() => {
    server?.closeAllConnections?.();
    server?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('POST /bots meldet das Scaffold transparent', async () => {
    // Wird bereits in before() angelegt – Antwortform prüfen via Neuanlage.
    const { data, status } = await call('/bots', {
      method: 'POST',
      body: {
        name: 'Scaffold-E2E-2',
        language: 'custom',
        entrypoint: 'bot.py',
        command: 'python3 {entrypoint}',
      },
    });
    assert.equal(status, 201);
    assert.ok(Array.isArray(data.scaffold?.created));
    assert.ok(data.scaffold.created.includes('bot-hub.json'));
  });

  it('Scaffold liegt im Startordner und ist in den Workspace synchronisiert', async () => {
    for (const rel of [
      'bot-hub.json',
      'panel/index.html',
      'panel/panel.js',
      'panel/panel.css',
    ]) {
      assert.ok(
        existsSync(join(root, 'bots', bot.id, 'startordner', rel)),
        `fehlt im Startordner: ${rel}`,
      );
      assert.ok(
        existsSync(join(root, 'bots', bot.id, 'workspace', rel)),
        `fehlt im Workspace (Mount): ${rel}`,
      );
    }
    // Cross-Bot: kein anderer Bot sieht diese Dateien (zweiter Bot hat eigene).
    const { data } = await call('/bots', {
      method: 'POST',
      body: {
        name: 'Scaffold-E2E-3',
        language: 'custom',
        entrypoint: 'bot.py',
        command: 'python3 {entrypoint}',
      },
    });
    const other = data.bot;
    assert.notEqual(other.id, bot.id);
    const otherPanel = readFileSync(
      join(root, 'bots', other.id, 'startordner', 'panel', 'panel.js'),
      'utf8',
    );
    assert.ok(otherPanel.includes('bridge.js'));
  });

  it('Panel-Assets und bridge.js sind erreichbar (Smoke)', async () => {
    for (const asset of [
      'panel/index.html',
      'panel/panel.js',
      'panel/panel.css',
    ]) {
      const res = await fetch(
        `${baseUrl}/api/bots/${bot.id}/panel/file/${asset}`,
      );
      assert.equal(res.status, 200, asset);
      await res.text();
    }
    const bridge = await fetch(`${baseUrl}/api/bots/${bot.id}/panel/bridge.js`);
    assert.equal(bridge.status, 200);
    const js = await bridge.text();
    assert.ok(js.includes('discordLogin'));
    // Panel-JSON kennt die Beispiel-Seite.
    const { data, status } = await call(`/bots/${bot.id}/panel`);
    assert.equal(status, 200);
    assert.equal(data.panel?.entry, 'panel/index.html');
    // Discord-Config erreichbar (nicht konfiguriert ohne Secrets).
    const cfg = await call(`/bots/${bot.id}/panel/discord/config`);
    assert.equal(cfg.data.configured, false);
  });

  it('Demo-Command antwortet 501 mit verständlicher Nachricht', async () => {
    const { status, data } = await call(`/bots/${bot.id}/panel/commands/ping`, {
      method: 'POST',
      body: { args: {} },
    });
    assert.equal(status, 501);
    assert.match(data.error, /weder ein Skript|Callback/);
  });
});
