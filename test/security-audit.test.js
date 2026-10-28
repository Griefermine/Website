/**
 * Regressionstests zum Drei-Agenten-Sicherheitsaudit (Maßnahmen 36–41).
 *
 * Jeder Block hält einen Angriff fest, den der Audit protokolliert hat –
 * damit die Korrektur nicht später als „war doch immer so“ zurückkehrt.
 * Der Modus `BOT_HUB_TEST_MODE` würde `hasPermission` pauschal auf true
 * ziehen und ist hier deshalb ausdrücklich AUSgeschaltet.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.NODE_ENV = 'test';
delete process.env.BOT_HUB_TEST_MODE;

const bot = { id: 'audit-bot' };

/* ------------------------------------------------------------------ *
 * Maßnahme 36 / Audit SEC-01: sync() darf keinem Bot-Symlink folgen
 * ------------------------------------------------------------------ */
test('botFiles.sync: ausgetauschter Symlink überschreibt keine Host-Datei', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botfiles-symlink-'));
  try {
    const start = join(root, 'bots', bot.id, 'startordner');
    const work = join(root, 'bots', bot.id, 'workspace');
    mkdirSync(start, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(start, 'bot.py'), 'print("v1")\n');

    const dateien = await import('../server/botFiles.js');
    dateien.sync(bot, root);
    assert.equal(readFileSync(join(work, 'bot.py'), 'utf8'), 'print("v1")\n');

    // Der Bot ersetzt seine Workspace-Datei durch einen Verweis nach draußen.
    unlinkSync(join(work, 'bot.py'));
    const aussen = join(root, 'bots.json'); // Ziel: die Hub-eigene Bot-Liste
    writeFileSync(aussen, 'GANZ WICHTIGE LISTE');
    symlinkSync(aussen, join(work, 'bot.py'));

    // Neue Version im Startordner – das alte sync() hätte durch den Verweis
    // hindurch auf bots.json geschrieben.
    writeFileSync(join(start, 'bot.py'), 'print("v2")\n');
    dateien.sync(bot, root);

    assert.equal(readFileSync(aussen, 'utf8'), 'GANZ WICHTIGE LISTE');
    const ist = lstatSync(join(work, 'bot.py'));
    assert.ok(ist.isFile(), 'Workspace-Eintrag muss eine echte Datei sein');
    assert.equal(readFileSync(join(work, 'bot.py'), 'utf8'), 'print("v2")\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('botFiles.sync: verbogener Zwischenpfad wird übersprungen, nie gelöscht', async () => {
  const root = mkdtempSync(join(tmpdir(), 'botfiles-chain-'));
  try {
    const start = join(root, 'bots', bot.id, 'startordner');
    const work = join(root, 'bots', bot.id, 'workspace');
    mkdirSync(join(start, 'sub'), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(start, 'sub', 'bot.py'), 'x = 1\n');

    const dateien = await import('../server/botFiles.js');
    dateien.sync(bot, root);

    // Der Bot biegt das Zwischenverzeichnis um: sub -> externem Ordner,
    // in dem eine gleichnamige Datei liegt. Löschung/Durchgriff wären ein
    // Angriff auf Dateien außerhalb des Workspace.
    const aussen = join(root, 'aussen');
    mkdirSync(aussen);
    writeFileSync(join(aussen, 'bot.py'), 'FREMDERECHT');
    rmSync(join(work, 'sub'), { recursive: true, force: true });
    symlinkSync(aussen, join(work, 'sub'));
    writeFileSync(join(start, 'sub', 'bot.py'), 'x = 2\n');

    dateien.sync(bot, root);
    assert.equal(readFileSync(join(aussen, 'bot.py'), 'utf8'), 'FREMDERECHT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Maßnahme 36 / Audit SEC-02: die No-Follow-Helfer in containers.js
 * ------------------------------------------------------------------ */
test('ensureWorkspaceDirNoFollow/writeWorkspaceFileNoFollow ersetzen Verweise', async () => {
  const { ensureWorkspaceDirNoFollow, writeWorkspaceFileNoFollow } =
    await import('../server/containers.js');
  const root = mkdtempSync(join(tmpdir(), 'containers-nofollow-'));
  try {
    const aussen = join(root, 'sessions.json');
    writeFileSync(aussen, 'SITZUNGEN');

    // Verzeichnis-Verweis: .bot-hub zeigt nach draußen.
    symlinkSync(aussen, join(root, '.bot-hub'));
    ensureWorkspaceDirNoFollow(root, '.bot-hub');
    assert.ok(lstatSync(join(root, '.bot-hub')).isDirectory());
    assert.equal(readFileSync(aussen, 'utf8'), 'SITZUNGEN');

    // Datei-Verweis: settings.xml zeigt nach draußen.
    symlinkSync(aussen, join(root, '.bot-hub', 'settings.xml'));
    writeWorkspaceFileNoFollow(
      join(root, '.bot-hub', 'settings.xml'),
      'RUMPEL',
    );
    assert.equal(readFileSync(aussen, 'utf8'), 'SITZUNGEN');
    assert.equal(
      readFileSync(join(root, '.bot-hub', 'settings.xml'), 'utf8'),
      'RUMPEL',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Maßnahme 38 / Audit SEC-07: aufräumen verwaister Exec-env-Dateien
 * ------------------------------------------------------------------ */
test('sweepStaleExecEnvFiles räumt nur das eigene Muster', async () => {
  const { sweepStaleExecEnvFiles } = await import('../server/containers.js');
  const spur = join(
    tmpdir(),
    'bot-hub-exec-env-00000000-0000-4000-8000-000000000001',
  );
  const fremd = join(tmpdir(), 'bot-hub-andere-datei');
  writeFileSync(spur, 'DISCORD_BOT_TOKEN=alt\n', { mode: 0o600 });
  writeFileSync(fremd, 'fremd');
  try {
    const entfernt = sweepStaleExecEnvFiles();
    assert.ok(entfernt >= 1);
    assert.ok(!existsSync(spur));
    assert.ok(existsSync(fremd));
  } finally {
    unlinkSync(fremd);
  }
});

/* ------------------------------------------------------------------ *
 * Maßnahme 37 / Audit SEC-03: Panel-OAuth-Schlüssel sind Handpflege
 * ------------------------------------------------------------------ */
test('isPanelOAuthKey trifft die Login-Konfiguration, nicht das Bot-Token', async () => {
  const { isPanelOAuthKey } = await import('../server/secrets.js');
  for (const key of [
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'DISCORD_CLIENT_TOKEN',
    'DISCORD_OAUTH_URL',
    'DISCORD_REDIRECT_URI',
    'discord_client_id', // dotenvKey normalisiert Großschreibung
  ])
    assert.ok(isPanelOAuthKey(key), `${key} muss gesperrt sein`);
  assert.ok(!isPanelOAuthKey('DISCORD_BOT_TOKEN'), 'Bot-Token bleibt erlaubt');
  assert.ok(!isPanelOAuthKey('PATH'), 'PATH ist andere Baustelle');
});

/* ------------------------------------------------------------------ *
 * Maßnahme 37 / Audit WEB-01: Per-Bot-Rechte sind eine Erweiterung
 * ------------------------------------------------------------------ */
test('viewer mit Per-Bot-Recht darf genau diesen Bot steuern – sonst nichts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auth-perbot-'));
  try {
    const { configureSessionStore, configureAccess, hasPermission } =
      await import('../server/auth.js');
    const sid = 'session-xyz';
    writeFileSync(
      join(root, 'sessions.json'),
      JSON.stringify({
        [sid]: {
          user: { id: 'user-1', name: 'Nur Bot A', username: 'nur-a' },
          expiresAt: Date.now() + 60_000,
        },
      }),
    );
    writeFileSync(
      join(root, 'access.json'),
      JSON.stringify({
        users: {
          'user-1': {
            id: 'user-1',
            name: 'Nur Bot A',
            username: 'nur-a',
            role: 'viewer',
            permissions: [],
            bots: { 'bot-a': { permissions: ['bots.control', 'bots.read'] } },
          },
        },
      }),
    );
    configureSessionStore(join(root, 'sessions.json'));
    configureAccess(join(root, 'access.json'));
    const req = { headers: { cookie: `bot_hub_session=${sid}` } };

    assert.ok(hasPermission(req, 'bots.control', { botId: 'bot-a' }));
    assert.ok(!hasPermission(req, 'bots.control', { botId: 'bot-b' }));
    assert.ok(!hasPermission(req, 'bots.control', {}));
    assert.ok(!hasPermission(req, 'bots.delete', { botId: 'bot-a' }));
    assert.ok(!hasPermission(req, 'access.manage', { botId: 'bot-a' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
