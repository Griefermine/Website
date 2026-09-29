import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const createBot = async (body) => {
  const { data } = await call('/bots', { method: 'POST', body });
  return data.bot;
};

const waitForStatus = async (id, wanted, timeout = 30000) => {
  const started = Date.now();
  for (;;) {
    const { data } = await call(`/bots/${id}`);
    if (wanted.includes(data.bot.status)) return data.bot;
    if (Date.now() - started > timeout) {
      const { data: tail } = await call(`/bots/${id}/logs?tail=20`);
      const lines = tail.lines.map((line) => line.text).join(' | ');
      throw new Error(
        `Timeout: Status ${data.bot.status} (erwartet ${wanted}) – ${lines}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'bot-hub-'));
  mkdirSync(join(root, 'worker'));
  writeFileSync(
    join(root, 'worker', 'job.sh'),
    'echo "zeile 1"\necho "warnung: test" >&2\nsleep 30\n',
  );
  writeFileSync(join(root, 'worker', 'echo.py'), 'print("ok")\n');
  writeFileSync(
    join(root, 'worker', 'loop.py'),
    'import time\nprint("loop laeuft", flush=True)\nwhile True:\n    time.sleep(1)\n',
  );
  process.env.BOT_DASHBOARD_ROOT = root;
  process.env.PORT = '0';
  const { createServer: createApp } = await import('../server/manager.js');
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

describe('Bot-Hub API', () => {
  it('liefert Sprach-Presets', async () => {
    const { status, data } = await call('/languages');
    assert.equal(status, 200);
    const ids = data.languages.map((language) => language.id);
    for (const expected of [
      'python',
      'javascript',
      'java',
      'go',
      'csharp',
      'rust',
    ]) {
      assert.ok(ids.includes(expected), `fehlt: ${expected}`);
    }
  });

  it('legt einen Bot mit Token an und maskiert das Token', async () => {
    const bot = await createBot({
      name: 'Echo',
      language: 'python',
      entrypoint: 'bot.py',
      command: 'python3 {entrypoint}',
      cwd: '.',
      secretEnv: {
        DISCORD_BOT_TOKEN:
          'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.verySecretTokenValue',
      },
      env: { LOG_LEVEL: 'info' },
    });
    assert.equal(bot.status, 'stopped');
    const masked = bot.secretEnv.DISCORD_BOT_TOKEN;
    assert.ok(masked.startsWith('MTIz') && masked.endsWith('alue'), masked);
    assert.ok(!masked.includes('verySecretTokenValue'));
    assert.equal(bot.env.LOG_LEVEL, 'info');
    const envFile = readFileSync(join(root, '.env'), 'utf8');
    assert.match(
      envFile,
      /DISCORD_BOT_TOKEN="MTIzNDU2Nzg5MDEyMzQ1Njc4\.GaBcDe\.verySecretTokenValue"/,
    );
    assert.match(envFile, /LOG_LEVEL="info"/);
  });

  it('startet einen Bot, streamt Logs und stoppt ihn wieder', async () => {
    const bot = await createBot({
      name: 'Worker',
      language: 'custom',
      entrypoint: 'job.sh',
      command: 'bash {entrypoint}',
      cwd: 'worker',
    });

    const started = await call(`/bots/${bot.id}/start`, { method: 'POST' });
    assert.equal(started.status, 202);
    const running = await waitForStatus(bot.id, ['running', 'error']);
    assert.equal(running.status, 'running');
    assert.ok(running.pid > 0);
    assert.equal(running.commandResolved, 'bash job.sh');

    await new Promise((resolve) => setTimeout(resolve, 700));
    const { data: logs } = await call(`/bots/${bot.id}/logs?tail=50`);
    const texts = logs.lines.map((line) => line.text);
    assert.ok(texts.some((text) => text.includes('zeile 1')));
    assert.ok(
      logs.lines.some(
        (line) => line.stream === 'stderr' && line.level === 'warn',
      ),
    );

    const stopped = await call(`/bots/${bot.id}/stop`, { method: 'POST' });
    assert.equal(stopped.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { data: after2 } = await call(`/bots/${bot.id}`);
    assert.equal(after2.bot.status, 'stopped');
    assert.equal(after2.bot.pid, null);
  });

  it('erkennt eine bereits vorhandene Library und startet ohne Installation', async () => {
    writeFileSync(join(root, 'worker', 'discord.py'), '# Stub\n');
    const bot = await createBot({
      name: 'Mit Lib',
      language: 'python',
      framework: 'discord.py',
      entrypoint: 'loop.py',
      command: 'python3 {entrypoint}',
      cwd: 'worker',
    });

    await call(`/bots/${bot.id}/start`, { method: 'POST' });
    const running = await waitForStatus(bot.id, ['running', 'error']);
    assert.equal(running.status, 'running');
    assert.equal(running.depsStatus, 'ready');

    const { data: logs } = await call(`/bots/${bot.id}/logs?tail=50`);
    const texts = logs.lines.map((line) => line.text);
    assert.ok(
      texts.some((text) => text.includes('discord.py ist bereits vorhanden')),
    );
    assert.ok(!texts.some((text) => text.includes('pip install')));
    await call(`/bots/${bot.id}/stop`, { method: 'POST' });
  });

  it('installiert eine fehlende Library automatisch und startet danach', async () => {
    const bot = await createBot({
      name: 'Ohne Lib',
      language: 'python',
      framework: 'discord.py',
      entrypoint: 'loop.py',
      command: 'python3 {entrypoint}',
      cwd: 'worker',
      depsCheck: 'python3 -c "import pyc_dummy"',
      depsInstall: 'echo "pip install discord.py" && touch pyc_dummy.py',
    });
    rmSync(join(root, 'worker', 'pyc_dummy.py'), { force: true });

    const accepted = await call(`/bots/${bot.id}/start`, { method: 'POST' });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.data.bot.status, 'checking');

    const running = await waitForStatus(bot.id, ['running', 'error']);
    assert.equal(running.status, 'running');
    assert.equal(running.depsStatus, 'ready');
    assert.ok(existsSync(join(root, 'worker', 'pyc_dummy.py')));

    const { data: logs } = await call(`/bots/${bot.id}/logs?tail=80`);
    const texts = logs.lines.map((line) => line.text);
    assert.ok(
      texts.some((text) => text.includes('Installiere discord.py')),
      'Installationsmeldung fehlt',
    );
    assert.ok(
      texts.includes('pip install discord.py'),
      'Installationsausgabe fehlt',
    );
    await call(`/bots/${bot.id}/stop`, { method: 'POST' });
  });

  it('startet nicht, wenn die Library fehlt und Auto-Install aus ist', async () => {
    const bot = await createBot({
      name: 'Manuell',
      language: 'python',
      framework: 'discord.py',
      entrypoint: 'loop.py',
      command: 'python3 {entrypoint}',
      cwd: 'worker',
      autoInstall: false,
      depsCheck: 'test -f missing_library.flag',
      depsInstall: 'touch missing_library.flag',
    });

    await call(`/bots/${bot.id}/start`, { method: 'POST' });
    const stopped = await waitForStatus(bot.id, ['stopped', 'error']);
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.depsStatus, 'missing');

    const { data: logs } = await call(`/bots/${bot.id}/logs?tail=50`);
    assert.ok(
      logs.lines.some((line) =>
        line.text.includes('automatische Installation ist abgeschaltet'),
      ),
    );
  });

  it('installiert Abhängigkeiten auf Zuruf', async () => {
    rmSync(join(root, 'worker', 'on_demand.flag'), { force: true });
    const bot = await createBot({
      name: 'Auf Zuruf',
      language: 'python',
      framework: 'discord.py',
      entrypoint: 'loop.py',
      command: 'python3 {entrypoint}',
      cwd: 'worker',
      depsCheck: 'test -f on_demand.flag',
      depsInstall: 'echo "installiere …" && touch on_demand.flag',
    });

    const { status } = await call(`/bots/${bot.id}/install`, {
      method: 'POST',
    });
    assert.equal(status, 202);
    const ready = await waitForStatus(bot.id, ['stopped', 'error']);
    assert.equal(ready.depsStatus, 'ready');
    assert.ok(existsSync(join(root, 'worker', 'on_demand.flag')));
  });

  it('legt für Python eine venv an und setzt sie im PATH', async () => {
    const cwd = 'venv-bot';
    mkdirSync(join(root, cwd));
    writeFileSync(
      join(root, cwd, 'report.py'),
      'import os, sys\nprint("executable=" + sys.executable, flush=True)\n' +
        'print("venv=" + os.environ.get("VIRTUAL_ENV", "keine"), flush=True)\n' +
        'print("path=" + os.environ["PATH"].split(":")[0], flush=True)\n' +
        'while True:\n    __import__("time").sleep(1)\n',
    );
    const bot = await createBot({
      name: 'Venv',
      language: 'python',
      framework: 'discord.py',
      entrypoint: 'report.py',
      command: 'python3 {entrypoint}',
      cwd,
    });

    await call(`/bots/${bot.id}/start`, { method: 'POST' });
    const running = await waitForStatus(bot.id, ['running', 'error']);
    assert.equal(running.status, 'running');
    assert.ok(existsSync(join(root, cwd, '.venv', 'bin', 'python3')));

    const { data: logs } = await call(`/bots/${bot.id}/logs?tail=60`);
    const texts = logs.lines.map((line) => line.text);
    assert.ok(
      texts.some((text) => text.includes('.venv bereit')),
      'venv wurde nicht angelegt',
    );
    const exec = texts.find((text) => text.startsWith('executable='));
    assert.ok(exec, 'Bot hat kein Python-Skript gestartet');
    assert.match(
      exec,
      new RegExp(`${cwd.replace('/', '\\/')}\\/\\.venv\\/bin`),
    );
    assert.ok(
      texts.some(
        (text) => text.startsWith('path=') && text.includes('.venv/bin'),
      ),
      'venv/bin fehlt im PATH',
    );
    await call(`/bots/${bot.id}/stop`, { method: 'POST' });
  });

  it('lehnt Pfade außerhalb des Projekts ab', async () => {
    const bot = await createBot({
      name: 'Escape',
      language: 'custom',
      command: 'echo hi',
      cwd: '../../etc',
    });
    const { status, data } = await call(`/bots/${bot.id}/start`, {
      method: 'POST',
    });
    assert.equal(status, 400);
    assert.match(data.error, /außerhalb des Projekts/);
  });

  it('löscht einen Bot', async () => {
    const bot = await createBot({
      name: 'Weg',
      language: 'custom',
      command: 'echo x',
    });
    const { status } = await call(`/bots/${bot.id}`, { method: 'DELETE' });
    assert.equal(status, 200);
    const { data } = await call(`/bots/${bot.id}`);
    assert.equal(data.error, 'Bot nicht gefunden');
  });
});
