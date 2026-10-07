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
      assert.ok(
        Array.isArray(data.cleanupErrors) && data.cleanupErrors.length > 0,
      );
      // Außenstehende Datei unversehrt, Bot weiter im Bestand.
      assert.equal(
        readFileSync(join(externalBotPath, 'keep.txt'), 'utf8'),
        'outside',
      );
      assert.equal((await call(`/bots/${victim.id}`)).status, 200);
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
