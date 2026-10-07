import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

const hubCall = async (token, path, options = {}) => {
  const response = await fetch(`${baseUrl}/api/hub${path}`, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, data: await response.json() };
};

const createBot = async (body) =>
  (await call('/bots', { method: 'POST', body })).data.bot;

const MANIFEST = {
  hub: {
    panel: {
      title: 'Delete-Test',
      entry: 'panel/index.html',
      settings: [
        {
          key: 'prefix',
          type: 'text',
          label: 'Prefix',
          default: '!',
        },
        { key: 'api_key', type: 'secret', label: 'API-Key' },
      ],
      commands: [],
    },
  },
};

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.BOT_HUB_TEST_MODE = '1';
  process.env.BOT_HUB_OWNER_IDS = 'owner-1';
  root = mkdtempSync(join(tmpdir(), 'bot-hub-delete-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'dist', 'index.html'),
    '<!doctype html><title>Hub</title>',
  );
  mkdirSync(join(root, 'worker'), { recursive: true });
  writeFileSync(join(root, 'worker', 'bot-hub.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(root, 'worker', 'bot.sh'), 'sleep 30\n');
  process.env.BOT_DASHBOARD_ROOT = root;
  process.env.PORT = '0';
  const { createServer: createApp } = await import('../server/manager.js');
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.BOT_HUB_URL = baseUrl;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Bot-Delete entfernt wirklich alles', async () => {
  const panel = await import('../server/panel.js');
  const { database } = await import('../server/database.js');
  let bot;

  it('legt Bot mit Datei, Secret, DB-Wert, Sessions und Rechten an', async () => {
    bot = await createBot({
      name: 'Zum Löschen',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    // Datei in Startordner + Workspace.
    const up = await call(`/bots/${bot.id}/files/bot.sh`, {
      method: 'PUT',
      body: { inhalt: 'sleep 30\n' },
    });
    assert.equal(up.status, 200);
    // Secret setzen (Backend-Semantik: Wert → gespeichert).
    const saved = await call(`/bots/${bot.id}/panel/settings`, {
      method: 'PUT',
      body: { values: { api_key: 's3cr3t-wert' } },
    });
    assert.equal(saved.data.panel.secrets.api_key, '••••••••');
    assert.ok(existsSync(join(root, 'data', 'secrets', `${bot.id}.env`)));
    // DB-Wert als laufender Prozess (Runtime-Token direkt ausgestellt).
    const runtimeToken = panel.issueRuntimeToken(bot.id);
    bot.runtimeToken = runtimeToken;
    const put = await hubCall(runtimeToken, '/db/notizen/erster', {
      method: 'PUT',
      body: { value: { text: 'hallo' } },
    });
    assert.equal(put.status, 200);
    // Callback registrieren.
    const cb = await hubCall(runtimeToken, '/callback', {
      method: 'POST',
      body: { url: 'http://127.0.0.1:9/hook', token: 'cb-secret' },
    });
    assert.equal(cb.status, 200);
    // Panel-Bootstrap-Token ausstellen (Widerruf separat im Unit-Teil geprüft).
    panel.issuePanelBootstrapToken(bot.id);
    // Access-Rechte für zwei Benutzer auf zwei Bots vorbereiten.
    const auth = await import('../server/auth.js');
    auth.ensureAccessUser({ id: 'owner-1', name: 'O', username: 'o' });
    auth.ensureAccessUser({ id: 'user-a', name: 'A', username: 'a' });
    auth.ensureAccessUser({ id: 'user-b', name: 'B', username: 'b' });
    const other = await createBot({
      name: 'Bleibt bestehen',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    bot.otherId = other.id;
    auth.updateAccess(
      'user-a',
      {
        role: 'admin',
        permissions: ['bots.read'],
        bots: {
          [bot.id]: { permissions: ['bots.read', 'files.read'] },
          [other.id]: { permissions: ['bots.read'] },
        },
      },
      'owner-1',
    );
    auth.updateAccess(
      'user-b',
      {
        role: 'admin',
        permissions: ['bots.read'],
        bots: { [bot.id]: { permissions: ['bots.read'] } },
      },
      'owner-1',
    );
    // Sitzungen sind gültig: Runtime-Token identifiziert, Callback gesetzt.
    const session = await hubCall(runtimeToken, '/session');
    assert.equal(session.status, 200);
    const panelState = await call(`/bots/${bot.id}/panel`);
    assert.equal(panelState.data.panel.callback, true);
  });

  it('DELETE liefert 200 und entfernt Dateien, Secrets, DB, Rechte', async () => {
    const { status, data } = await call(`/bots/${bot.id}`, {
      method: 'DELETE',
    });
    assert.equal(status, 200);
    assert.equal(data.deleted, true);
    assert.equal(data.botId, bot.id);
    assert.equal(data.status, 'deleted');
    // Bot-Datensatz weg, sofort persistiert (ohne Timer zu warten).
    assert.equal((await call(`/bots/${bot.id}`)).status, 404);
    const persisted = JSON.parse(
      readFileSync(join(root, 'data', 'bots.json'), 'utf8'),
    );
    assert.ok(!persisted.some((entry) => entry.id === bot.id));
    // Dateisystem vollständig weg.
    assert.ok(!existsSync(join(root, 'bots', bot.id)));
    // Secret-Datei weg.
    assert.ok(!existsSync(join(root, 'data', 'secrets', `${bot.id}.env`)));
    // DB-Daten und Quota weg.
    const store = database();
    assert.deepEqual(
      (await store.list(bot.id, { collection: 'notizen' })).entries ?? [],
      [],
    );
    const usage = await store.usage(bot.id);
    assert.equal(usage.entries, 0);
    assert.equal(usage.bytes, 0);
    // Access-Einträge bereinigt, fremde Rechte unversehrt.
    const access = JSON.parse(
      readFileSync(join(root, 'data', 'access.json'), 'utf8'),
    );
    assert.ok(!JSON.stringify(access.users['user-a']).includes(bot.id));
    assert.ok(!JSON.stringify(access.users['user-b']).includes(bot.id));
    assert.ok(JSON.stringify(access.users['user-a']).includes(bot.otherId));
    // Alter Runtime-Token ist tot (401 statt 404: Token ungültig, nicht nur Bot weg).
    const dead = await hubCall(bot.runtimeToken, '/session');
    assert.equal(dead.status, 401);
    // Erneutes Löschen: 404, kein 500, keine neuen Fehler.
    assert.equal(
      (await call(`/bots/${bot.id}`, { method: 'DELETE' })).status,
      404,
    );
    // Der andere Bot lebt weiter.
    assert.equal((await call(`/bots/${bot.otherId}`)).status, 200);
  });

  it('paralleles DELETE und START endet gelöscht, ohne 500', async () => {
    const fresh = await createBot({
      name: 'Race-Bot',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    const results = await Promise.allSettled([
      call(`/bots/${fresh.id}`, { method: 'DELETE' }),
      call(`/bots/${fresh.id}/start`, { method: 'POST' }),
      call(`/bots/${fresh.id}`, { method: 'DELETE' }),
    ]);
    for (const result of results) {
      if (result.status === 'fulfilled')
        assert.ok(
          // 400: Start verlor das Rennen und der Ordner war schon weg –
          // ebenfalls ein sauberer Ausgang, kein 500.
          [200, 202, 400, 404, 409].includes(result.value.status),
          `unerwartet: ${result.value.status}`,
        );
    }
    assert.equal((await call(`/bots/${fresh.id}`)).status, 404);
    await call(`/bots/${fresh.id}/stop`, { method: 'POST' }).catch(() => {});
  });

  it('Teilfehler meldet 500 mit cleanupErrors und bleibt wiederholbar', async () => {
    const victim = await createBot({
      name: 'Teilfehler-Bot',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    const botsPath = join(root, 'bots');
    const savedBotsPath = join(root, 'bots-saved');
    const externalRoot = mkdtempSync(join(tmpdir(), 'bot-hub-external-'));
    const externalBotPath = join(externalRoot, victim.id);
    mkdirSync(externalBotPath);
    writeFileSync(join(externalBotPath, 'keep.txt'), 'outside');
    renameSync(botsPath, savedBotsPath);
    symlinkSync(externalRoot, botsPath, 'dir');
    try {
      const { status, data } = await call(`/bots/${victim.id}`, {
        method: 'DELETE',
      });
      assert.equal(status, 500);
      assert.equal(data.deleted, false);
      assert.equal(data.botId, victim.id);
      assert.equal(data.status, 'cleanup_failed');
      assert.ok(
        Array.isArray(data.cleanupErrors) && data.cleanupErrors.length > 0,
      );
      // Außenstehende Datei unversehrt, Bot weiter im Bestand.
      assert.equal(
        readFileSync(join(externalBotPath, 'keep.txt'), 'utf8'),
        'outside',
      );
      assert.equal((await call(`/bots/${victim.id}`)).status, 200);
      // cleanup_failed sperrt: Start/Patch/Schreiben → 409, Lesen bleibt offen.
      assert.equal(
        (await call(`/bots/${victim.id}/start`, { method: 'POST' })).status,
        409,
      );
      assert.equal(
        (
          await call(`/bots/${victim.id}`, {
            method: 'PATCH',
            body: { name: 'X', language: 'custom' },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call(`/bots/${victim.id}/files/x.txt`, {
            method: 'PUT',
            body: { inhalt: 'x' },
          })
        ).status,
        409,
      );
      assert.equal((await call(`/bots/${victim.id}/panel`)).status, 200);
    } finally {
      unlinkSync(botsPath);
      renameSync(savedBotsPath, botsPath);
      rmSync(externalRoot, { recursive: true, force: true });
    }
    // Nach Wiederherstellung: Retry löscht vollständig.
    const retry = await call(`/bots/${victim.id}`, { method: 'DELETE' });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.deleted, true);
    assert.equal((await call(`/bots/${victim.id}`)).status, 404);
  });

  it('Secret bleibt bei Weglassen erhalten, explizites Löschen entfernt', async () => {
    const keeper = await createBot({
      name: 'Secret-Keeper',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    await call(`/bots/${keeper.id}/panel/settings`, {
      method: 'PUT',
      body: { values: { api_key: 'bleibt-bestehen' } },
    });
    // Nur normale Einstellung ändern, Secret-Schlüssel weglassen.
    await call(`/bots/${keeper.id}/panel/settings`, {
      method: 'PUT',
      body: { values: { prefix: '?' } },
    });
    let state = await call(`/bots/${keeper.id}/panel`);
    assert.equal(state.data.panel.secrets.api_key, '••••••••');
    // Explizites Löschen mit leerem Wert.
    await call(`/bots/${keeper.id}/panel/settings`, {
      method: 'PUT',
      body: { values: { api_key: '' } },
    });
    state = await call(`/bots/${keeper.id}/panel`);
    assert.equal(state.data.panel.secrets.api_key, '');
    await call(`/bots/${keeper.id}`, { method: 'DELETE' });
  });

  it('Races mit Restart, Patch und Datei-Write enden gelöscht, ohne 500', async () => {
    for (const [label, attempt] of [
      ['restart', (id) => call(`/bots/${id}/restart`, { method: 'POST' })],
      [
        'patch',
        (id) =>
          call(`/bots/${id}`, {
            method: 'PATCH',
            body: { name: 'Race', language: 'custom' },
          }),
      ],
      [
        'file-write',
        (id) =>
          call(`/bots/${id}/files/race.txt`, {
            method: 'PUT',
            body: { inhalt: 'race' },
          }),
      ],
    ]) {
      const target = await createBot({
        name: `Race-${label}`,
        language: 'custom',
        cwd: 'worker',
        entrypoint: 'bot.sh',
        command: 'sh {entrypoint}',
      });
      const results = await Promise.allSettled([
        call(`/bots/${target.id}`, { method: 'DELETE' }),
        attempt(target.id),
      ]);
      for (const result of results) {
        if (result.status === 'fulfilled')
          assert.ok(
            [200, 202, 400, 404, 409].includes(result.value.status),
            `${label}: unerwartet ${result.value.status}`,
          );
        else assert.fail(`${label}: Request warf ${result.reason}`);
      }
      assert.equal((await call(`/bots/${target.id}`)).status, 404, label);
    }
  });

  it('Delete während aktiver Auto-Restart-Schleife hinterlässt keinen Prozess', async () => {
    writeFileSync(join(root, 'worker', 'crash.sh'), 'exit 1\n');
    const crasher = await createBot({
      name: 'Absturz-Bot',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'crash.sh',
      command: 'sh {entrypoint}',
      autoRestart: true,
      maxRestarts: 50,
    });
    assert.equal(
      (await call(`/bots/${crasher.id}/start`, { method: 'POST' })).status,
      202,
    );
    // Auf die Crash-Schleife warten: Status wird restarting.
    let restarting = false;
    for (let i = 0; i < 100; i += 1) {
      const { data } = await call(`/bots/${crasher.id}`);
      if (data.bot?.status === 'restarting') {
        restarting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(restarting, 'Bot sollte in der Restart-Schleife sein');
    const del = await call(`/bots/${crasher.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    // Kein Orphan: Bot bleibt weg, auch nach der Restart-Verzögerung.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal((await call(`/bots/${crasher.id}`)).status, 404);
  });

  it('DB-Fehler führt zu cleanup_failed und ist wiederholbar', async () => {
    const { database } = await import('../server/database.js');
    const store = database();
    const failing = await createBot({
      name: 'DB-Fehler-Bot',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    const original = store.removeBot;
    store.removeBot = async () => {
      throw new Error('simulierter DB-Ausfall');
    };
    try {
      const { status, data } = await call(`/bots/${failing.id}`, {
        method: 'DELETE',
      });
      assert.equal(status, 500);
      assert.equal(data.deleted, false);
      assert.equal(data.status, 'cleanup_failed');
      assert.ok(data.cleanupErrors.some((entry) => entry.step === 'database'));
      assert.equal(
        (await call(`/bots/${failing.id}/start`, { method: 'POST' })).status,
        409,
      );
    } finally {
      store.removeBot = original;
    }
    const retry = await call(`/bots/${failing.id}`, { method: 'DELETE' });
    assert.equal(retry.status, 200);
    assert.equal((await call(`/bots/${failing.id}`)).status, 404);
  });

  it('Secret-Fehler führt zu cleanup_failed und ist wiederholbar', async () => {
    const failing = await createBot({
      name: 'Secret-Fehler-Bot',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    const secretsPath = join(root, 'data', 'secrets');
    const savedSecretsPath = join(root, 'data', 'secrets-saved');
    renameSync(secretsPath, savedSecretsPath);
    writeFileSync(secretsPath, 'kein-verzeichnis');
    try {
      const { status, data } = await call(`/bots/${failing.id}`, {
        method: 'DELETE',
      });
      assert.equal(status, 500);
      assert.equal(data.status, 'cleanup_failed');
      assert.ok(data.cleanupErrors.some((entry) => entry.step === 'secrets'));
    } finally {
      unlinkSync(secretsPath);
      renameSync(savedSecretsPath, secretsPath);
    }
    const retry = await call(`/bots/${failing.id}`, { method: 'DELETE' });
    assert.equal(retry.status, 200);
    assert.equal((await call(`/bots/${failing.id}`)).status, 404);
  });

  it('Access-Fehler führt zu cleanup_failed und ist wiederholbar', async () => {
    const failing = await createBot({
      name: 'Access-Fehler-Bot',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    const auth = await import('../server/auth.js');
    auth.ensureAccessUser({ id: 'user-c', name: 'C', username: 'c' });
    auth.updateAccess(
      'user-c',
      {
        role: 'admin',
        permissions: ['bots.read'],
        bots: { [failing.id]: { permissions: ['bots.read'] } },
      },
      'owner-1',
    );
    const accessPath = join(root, 'data', 'access.json');
    const savedAccessPath = join(root, 'data', 'access.json.saved');
    renameSync(accessPath, savedAccessPath);
    mkdirSync(accessPath);
    try {
      const { status, data } = await call(`/bots/${failing.id}`, {
        method: 'DELETE',
      });
      assert.equal(status, 500);
      assert.equal(data.status, 'cleanup_failed');
      assert.ok(data.cleanupErrors.some((entry) => entry.step === 'access'));
    } finally {
      rmSync(accessPath, { recursive: true, force: true });
      renameSync(savedAccessPath, accessPath);
    }
    const retry = await call(`/bots/${failing.id}`, { method: 'DELETE' });
    assert.equal(retry.status, 200);
    const access = JSON.parse(readFileSync(accessPath, 'utf8'));
    assert.ok(!JSON.stringify(access.users['user-c']).includes(failing.id));
  });

  it('bots.json-Fehler meldet cleanup_failed, Retry nach Wiederherstellung klappt', async () => {
    const failing = await createBot({
      name: 'Persist-Fehler-Bot',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    });
    const botsFile = join(root, 'data', 'bots.json');
    const savedBotsFile = join(root, 'data', 'bots.json.saved');
    renameSync(botsFile, savedBotsFile);
    mkdirSync(botsFile);
    let first;
    try {
      first = await call(`/bots/${failing.id}`, { method: 'DELETE' });
      assert.equal(first.status, 500);
      assert.equal(first.data.status, 'cleanup_failed');
      assert.equal(first.data.cleanupErrors[0].step, 'persist-state');
      // Noch nichts Destruktives passiert: Bot bleibt normal nutzbar.
      assert.equal((await call(`/bots/${failing.id}`)).status, 200);
      assert.equal(
        (await call(`/bots/${failing.id}/start`, { method: 'POST' })).status,
        202,
      );
      await call(`/bots/${failing.id}/stop`, { method: 'POST' });
    } finally {
      rmSync(botsFile, { recursive: true, force: true });
      renameSync(savedBotsFile, botsFile);
    }
    const retry = await call(`/bots/${failing.id}`, { method: 'DELETE' });
    assert.equal(retry.status, 200);
    assert.equal((await call(`/bots/${failing.id}`)).status, 404);
  });
});

describe('Delete-Recovery nach Hub-Neustart', () => {
  it('cleanup_failed wird beim Start vollendet, Bot startet nie', async () => {
    const { spawn } = await import('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-recovery-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    const botId = 'deadbeef-dead-beef-dead-beefdeadbeef';
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>');
    // Abgebrochener Delete-Zustand: Eintrag + Reste auf der Platte.
    writeFileSync(
      join(root, 'data', 'bots.json'),
      JSON.stringify([
        {
          id: botId,
          name: 'Recovery-Bot',
          language: 'custom',
          entrypoint: 'bot.sh',
          command: 'sh {entrypoint}',
          deleteState: 'cleanup_failed',
        },
      ]),
    );
    mkdirSync(join(root, 'bots', botId, 'workspace'), { recursive: true });
    writeFileSync(join(root, 'bots', botId, 'workspace', 'rest.txt'), 'rest');
    mkdirSync(join(root, 'data', 'secrets'), { recursive: true });
    writeFileSync(join(root, 'data', 'secrets', `${botId}.env`), 'X=y\n');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        process.env.NODE_ENV = 'test';
        process.env.BOT_HUB_TEST_MODE = '1';
        process.env.BOT_DASHBOARD_ROOT = ${JSON.stringify(root)};
        const { createServer } = await import('node:http');
        const { createServer: createApp } = await import(${JSON.stringify(join(process.cwd(), 'server', 'manager.js'))});
        const server = createServer(createApp());
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        let gone = false;
        for (let i = 0; i < 100; i += 1) {
          const res = await fetch(base + '/api/bots/${botId}');
          if (res.status === 404) { gone = true; break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        const list = await (await fetch(base + '/api/bots')).json();
        process.stdout.write(JSON.stringify({ gone, count: list.bots?.length ?? -1 }));
        server.closeAllConnections?.();
        server.close();
        process.exit(0);
        `,
      ],
      {
        cwd: join(process.cwd()),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    child.stdout.on('data', (data) => (out += data));
    let err = '';
    child.stderr.on('data', (data) => (err += data));
    const code = await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
    });
    assert.equal(code, 0, `Kindprozess starb: ${err.slice(-500)}`);
    const jsonLine = out.split('\n').find((line) => line.startsWith('{'));
    const result = JSON.parse(jsonLine);
    assert.equal(result.gone, true);
    assert.equal(result.count, 0);
    assert.ok(!existsSync(join(root, 'bots', botId)));
    assert.ok(!existsSync(join(root, 'data', 'secrets', `${botId}.env`)));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('Session-Widerruf ohne Server', async () => {
  const panel = await import('../server/panel.js');
  const { removeContainer } = await import('../server/containers.js');

  it('removeContainer ohne Runtime wirft nicht (P0-Gating)', async () => {
    await removeContainer({ id: 'gibt-es-nicht' });
  });

  it('revokeBotSessions macht Runtime- und Panel-Tokens ungültig', async () => {
    const runtime = panel.issueRuntimeToken('ghost-1');
    const panelTok = panel.panelToken('ghost-2');
    const at = (token, path, header) =>
      panel.identify(
        { headers: { [header]: token } },
        new URL(`http://localhost${path}`),
      );
    assert.deepEqual(
      at(`Bearer ${runtime}`, '/api/hub/session', 'authorization'),
      { id: 'ghost-1', scope: 'runtime' },
    );
    assert.deepEqual(
      at(panelTok, '/api/bots/ghost-2/panel', 'x-bot-hub-token'),
      { id: 'ghost-2', scope: 'panel' },
    );
    panel.revokeBotSessions('ghost-1');
    panel.revokeBotSessions('ghost-2');
    assert.equal(
      at(`Bearer ${runtime}`, '/api/hub/session', 'authorization'),
      null,
    );
    assert.equal(
      at(panelTok, '/api/bots/ghost-2/panel', 'x-bot-hub-token'),
      null,
    );
  });

  it('revokeBotSessions entwertet Bootstrap-Tokens', async () => {
    const first = panel.issuePanelBootstrapToken('ghost-3');
    // Gültigkeit vor dem Widerruf: Verbrauch über identify liefert Panel-Scope.
    assert.deepEqual(
      panel.identify(
        { headers: { 'x-bot-hub-bootstrap': first } },
        new URL('http://localhost/api/bots/ghost-3/panel/bridge.js'),
      ),
      { id: 'ghost-3', scope: 'panel' },
    );
    const second = panel.issuePanelBootstrapToken('ghost-3');
    panel.revokeBotSessions('ghost-3');
    assert.equal(
      panel.identify(
        { headers: { 'x-bot-hub-bootstrap': second } },
        new URL('http://localhost/api/bots/ghost-3/panel/bridge.js'),
      ),
      null,
    );
  });
});
