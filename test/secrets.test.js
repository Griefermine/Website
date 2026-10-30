import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.altesGeheimnis';
const BOT_ID = '11111111-2222-3333-4444-555555555555';

/*
 * Vorherige Hub-Versionen haben die Geheimnisse im Klartext in
 * data/bots.json abgelegt. Beim Start holt der Hub sie in
 * data/secrets/<id>.env (0600) und schreibt die Übersicht ohne Werte neu.
 * Der Test startet dafür einen echten Hub-Prozess, weil die Migration im
 * Laden der Datei passiert.
 */
const startHub = (root, phase) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        const { createServer } = await import('node:http');
        const { createServer: createApp } = await import(${JSON.stringify(
          join(ROOT, 'server', 'manager.js'),
        )});
        const server = createServer(createApp());
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        process.env.BOT_HUB_URL = base;
        const phase = ${JSON.stringify(phase)};
        const call = async (path, options = {}) =>
          (await fetch(base + '/api' + path, {
            headers: { 'content-type': 'application/json' },
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined,
          })).json();
        const id = ${JSON.stringify(BOT_ID)};
        const result = {};
        if (phase === 'update') {
          // Neues geheimes Feld setzen – genau der Fall, an dem ein späterer
          // Start ohne Migration das Geheimnis verlieren würde.
          result.saved = await call('/bots/' + id + '/panel/settings', {
            method: 'PUT',
            body: { values: { api_key: 'neues-geheimnis' } },
          });
        }
        if (phase === 'start') {
          await call('/bots/' + id + '/start', { method: 'POST' });
          for (let i = 0; i < 60; i += 1) {
            const body = await fetch(base + '/api/bots/' + id).then((r) =>
              r.json(),
            );
            if (['running', 'error', 'stopped'].includes(body.bot.status)) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
          result.logs = await call('/bots/' + id + '/logs?tail=50');
          result.bot = await call('/bots/' + id);
        }
        if (phase === 'panel') {
          result.panel = await call('/bots/' + id + '/panel');
          // Zeit für das Umschreiben der Datei lassen.
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
        if (!phase || phase === 'read') {
          // Zeit für das Umschreiben der Datei lassen.
          await new Promise((resolve) => setTimeout(resolve, 1200));
          result.list = await call('/bots');
        }
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      `,
      ],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'test',
          BOT_HUB_TEST_MODE: '1',
          BOT_DASHBOARD_ROOT: root,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (data) => (out += data));
    child.stderr.on('data', (data) => (err += data));
    child.once('exit', (code) => resolve({ code, out, err }));
    setTimeout(() => child.kill('SIGKILL'), 30_000).unref();
  });

describe('Migration der Geheimnisse aus bots.json', () => {
  let root;
  const botId = BOT_ID;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bot-hub-secrets-'));
    mkdirSync(join(root, 'worker'), { recursive: true });
    // Gibt einen Fingerabdruck (sha256, gekürzt) des geheimen Feldes aus:
    // so lässt sich prüfen, ob der Wert wirklich bis in den Prozess
    // ankommt, ohne ihn im Klartext in die Log-Pipeline zu schreiben. Seit
    // V25b redigiert der Hub jeden bekannten Secret-Wert im Log (manager.js,
    // „pushLine“; dokumentiert in documents/sicherheit.md) – der rohe Wert
    // wäre dort nicht mehr auffindbar, und genau das soll hier auch nicht
    // versucht werden.
    writeFileSync(
      join(root, 'worker', 'bot.sh'),
      'printf "geheim-hash %s\\n" "$(printf "%s" "$BOT_HUB_SETTING_API_KEY" | sha256sum | cut -c1-16)"\nsleep 30\n',
    );
    // Manifest mit einem geheimen Feld – sonst kennt das Panel keinen Wert.
    writeFileSync(
      join(root, 'worker', 'bot-hub.json'),
      JSON.stringify({
        hub: {
          panel: {
            title: 'Altbestand',
            entry: 'panel.html',
            settings: [{ key: 'api_key', type: 'secret', label: 'API-Key' }],
          },
        },
      }),
    );
    mkdirSync(join(root, 'data'), { recursive: true });
    // Auch ein bereits vorhandener, zu offener Ordner muss beim Schreiben
    // auf die vorgesehene Berechtigung 0700 zurückgesetzt werden.
    mkdirSync(join(root, 'data', 'secrets'), { recursive: true, mode: 0o755 });
    writeFileSync(
      join(root, 'data', 'bots.json'),
      `${JSON.stringify(
        [
          {
            id: botId,
            name: 'Altbestand',
            language: 'custom',
            entrypoint: 'bot.sh',
            command: 'sh {entrypoint}',
            cwd: 'worker',
            workspaceRoot: '',
            guildId: '',
            secretEnv: { DISCORD_BOT_TOKEN: TOKEN },
            panel: {
              manifest: {
                fields: [{ key: 'api_key', type: 'text', secret: true }],
              },
              settings: {},
              secretSettings: { api_key: 'panel-geheimnis' },
              path: 'worker/bot-hub.json',
            },
          },
        ],
        null,
        2,
      )}\n`,
    );
  });

  afterEach(() => {
    // Der temporäre Ordner enthält Geheimnisse; er wird nach dem Test entfernt.
    rmSync(root, { recursive: true, force: true });
  });

  it('holt Werte in data/secrets und schreibt bots.json ohne Werte neu', async () => {
    const { code, out, err } = await startHub(root);
    assert.equal(code, 0, err);

    // Der Hub kennt das Geheimnis weiterhin – nur maskiert nach außen.
    const { bots } = JSON.parse(out).list;
    const bot = bots.find((item) => item.id === botId);
    assert.ok(bot, 'Bot wurde nicht geladen');
    assert.deepEqual(bot.secretKeys, ['DISCORD_BOT_TOKEN']);
    assert.equal(bot.secretEnv.DISCORD_BOT_TOKEN, '••••••••');
    assert.equal(bot.panel.secrets.api_key, '••••••••');

    // Die Datei mit 0600 führt beide Werte.
    const secretPath = join(root, 'data', 'secrets', `${botId}.env`);
    assert.equal(statSync(join(root, 'data', 'secrets')).mode & 0o777, 0o700);
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);
    const stored = readFileSync(secretPath, 'utf8');
    assert.match(stored, /DISCORD_BOT_TOKEN="MTIzNDU2/);
    assert.match(stored, /API_KEY="panel-geheimnis"/);

    // Die Übersicht enthält nur noch die Namen der Schlüssel.
    const botsFile = readFileSync(join(root, 'data', 'bots.json'), 'utf8');
    assert.ok(
      !botsFile.includes('altesGeheimnis'),
      'Token weiterhin in Klartext',
    );
    assert.ok(
      !botsFile.includes('panel-geheimnis'),
      'Panel-Wert weiterhin in Klartext',
    );
    assert.match(botsFile, /"secretKeys": \[\s*"DISCORD_BOT_TOKEN"\s*\]/);
    assert.match(botsFile, /"secretKeys": \[\s*"api_key"\s*\]/);
  });

  it('überlebt einen Neustart und erreicht den Prozess mit dem Wert', async () => {
    // 1. Start: Migration des Altbestands.
    assert.equal((await startHub(root, 'read')).code, 0);

    // 2. Geheimes Feld über die Panel-API ändern.
    const save = await startHub(root, 'update');
    assert.equal(save.code, 0, save.err);
    assert.match(
      readFileSync(join(root, 'data', 'secrets', `${botId}.env`), 'utf8'),
      /API_KEY="neues-geheimnis"/,
    );
    assert.ok(
      !readFileSync(join(root, 'data', 'bots.json'), 'utf8').includes(
        'neues-geheimnis',
      ),
      'neues Geheimnis in bots.json',
    );

    // 3. Neustart: der Prozess muss den Wert wieder vorfinden. Nachgewiesen
    //    wird das über den Fingerabdruck – der Klartextwert darf im Log gar
    //    nicht erst auftauchen (V25b-Redaktion, siehe documents/sicherheit.md).
    const start = await startHub(root, 'start');
    assert.equal(start.code, 0, start.err);
    const lines = JSON.parse(start.out)
      .logs.lines.map((line) => line.text)
      .join('\n');
    const fingerabdruck = createHash('sha256')
      .update('neues-geheimnis')
      .digest('hex')
      .slice(0, 16);
    assert.ok(
      lines.includes(`geheim-hash ${fingerabdruck}`),
      'geheimes Panel-Feld kam beim Prozess nicht an',
    );
    // Die Sicherheitsaussage bleibt ausdrücklich erhalten: Kein Klartext
    // im Log – weder der rotierte Wert noch der alte aus der Migration.
    assert.ok(
      !lines.includes('neues-geheimnis'),
      'roter Wert des neuen Geheimnisses im Log',
    );
    assert.ok(
      !lines.includes('panel-geheimnis'),
      'roter Wert des alten Geheimnisses im Log',
    );

    // 4. Zweiter vollständiger Neustart (P0-A): die Rotation bleibt kanonisch –
    //    auch gegenüber etwaigen Legacy-Resten in bots.json.
    assert.equal((await startHub(root, 'read')).code, 0);
    const stored = readFileSync(
      join(root, 'data', 'secrets', `${botId}.env`),
      'utf8',
    );
    assert.match(stored, /API_KEY="neues-geheimnis"/);
    assert.ok(
      !stored.includes('panel-geheimnis'),
      'alter Wert hat die Rotation zurückgesetzt',
    );
    const botsFile = readFileSync(join(root, 'data', 'bots.json'), 'utf8');
    assert.ok(!botsFile.includes('neues-geheimnis'));
    assert.ok(!botsFile.includes('panel-geheimnis'));
    assert.ok(!botsFile.includes('altesGeheimnis'));
  });

  it('ein älterer Legacy-Wert überschreibt keinen neueren Datei-Wert', async () => {
    // Szenario aus P0-A: Migration war schon einmal erfolgreich und das
    // Panel-Geheimnis wurde rotiert, aber bots.json enthält noch den alten
    // Legacy-Wert (z. B. weil die Bereinigung damals fehlschlug). Beim
    // nächsten Start darf der ALTE Wert den NEUEN aus der Secret-Datei nie
    // zurücksetzen.
    mkdirSync(join(root, 'data', 'secrets'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, 'data', 'secrets', `${botId}.env`),
      'DISCORD_BOT_TOKEN="neu-rotiert"\nAPI_KEY="panel-neu"\n',
      { mode: 0o600 },
    );
    const { code, out, err } = await startHub(root);
    assert.equal(code, 0, err);

    const stored = readFileSync(
      join(root, 'data', 'secrets', `${botId}.env`),
      'utf8',
    );
    assert.match(stored, /DISCORD_BOT_TOKEN="neu-rotiert"/);
    assert.match(stored, /API_KEY="panel-neu"/);
    assert.ok(
      !stored.includes('altesGeheimnis'),
      'Legacy-Token hat die Rotation überschrieben',
    );
    assert.ok(
      !stored.includes('panel-geheimnis'),
      'Legacy-Panel-Wert hat die Rotation überschrieben',
    );

    // Die kanonischen Werte erreichen auch den Bot-Prozess, nicht die alten:
    const { bots } = JSON.parse(out).list;
    const bot = bots.find((item) => item.id === botId);
    assert.ok(bot);
    // Nach außen bleibt alles maskiert.
    assert.equal(bot.secretEnv.DISCORD_BOT_TOKEN, '••••••••');
    // und bots.json wird endgültig bereinigt.
    const botsFile = readFileSync(join(root, 'data', 'bots.json'), 'utf8');
    assert.ok(!botsFile.includes('altesGeheimnis'));
    assert.ok(!botsFile.includes('panel-geheimnis'));
  });

  it('Schreibfehler in data/secrets lässt Werte erhalten und meldet keinen Erfolg', async () => {
    // Das Secret-Verzeichnis ist durch eine reguläre Datei blockiert –
    // storeSecretValues muss scheitern. Die Legacy-Werte dürfen dann weder
    // aus bots.json verschwinden (Datenverlust!) noch darf eine erfolgreiche
    // Migration behauptet werden.
    rmSync(join(root, 'data', 'secrets'), { recursive: true, force: true });
    writeFileSync(join(root, 'data', 'secrets'), 'blockiert\n');
    const { code, out, err } = await startHub(root);
    assert.equal(code, 0, err); // Der Hub startet trotz Fehler weiter
    assert.match(err, /konnten nicht in data\/secrets gesichert werden/);
    // Keine Erfolgsmeldung, kein Leak der Werte in Log oder API-Ausgabe.
    assert.ok(
      !out.includes('verschoben') &&
        !err.includes('nach data/secrets verschoben'),
      'Scanner meldet Erfolg, obwohl nichts gesichert wurde',
    );
    assert.ok(!out.includes('altesGeheimnis'), 'Token in API-Ausgabe');
    assert.ok(!err.includes('altesGeheimnis'), 'Token im Log');
    assert.ok(!err.includes('panel-geheimnis'), 'Panel-Wert im Log');

    // Werteübernahme: bots.json behält die Legacy-Werte, bis die Migration
    // gelingt – 400 ms warten, ob der Persistenz-Timer etwas kaputtschreibt.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const botsFile = readFileSync(join(root, 'data', 'bots.json'), 'utf8');
    assert.ok(
      botsFile.includes('altesGeheimnis'),
      'Werte durch fehlgeschlagene Migration verloren',
    );
    assert.ok(
      botsFile.includes('panel-geheimnis'),
      'Panel-Wert durch fehlgeschlagene Migration verloren',
    );

    // Der Bot ist trotzdem nutzbar: Werte im Speicher, nach außen maskiert.
    const { bots } = JSON.parse(out).list;
    const bot = bots.find((item) => item.id === botId);
    assert.equal(bot.secretEnv.DISCORD_BOT_TOKEN, '••••••••');
    assert.equal(bot.panel.secrets.api_key, '••••••••');
    assert.ok(!out.includes('pendingLegacySecrets'), 'interner Marker leakt');
  });
});

describe('Panel-Felder überstehen einen Neustart', () => {
  let root;
  const botId = BOT_ID;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bot-hub-panel-'));
    mkdirSync(join(root, 'worker'), { recursive: true });
    writeFileSync(join(root, 'worker', 'bot.sh'), 'sleep 30\n');
    writeFileSync(
      join(root, 'worker', 'bot-hub.json'),
      JSON.stringify({
        hub: {
          panel: {
            title: 'Feldtest',
            entry: 'panel.html',
            settings: [
              { key: 'log_channel', type: 'text', label: 'Kanal' },
              { key: 'api_key', type: 'secret', label: 'API-Key' },
            ],
            commands: [{ id: 'ping', label: 'Ping', run: 'echo pong' }],
          },
        },
      }),
    );
    mkdirSync(join(root, 'data', 'secrets'), { recursive: true });
    // Der Stand, den eine ältere Hub-Version hinterlässt: das Manifest ohne
    // Felder, der Wert des geheimen Feldes nur in der .env des Bots.
    writeFileSync(
      join(root, 'data', 'bots.json'),
      `${JSON.stringify(
        [
          {
            id: botId,
            name: 'Feldtest',
            language: 'custom',
            entrypoint: 'bot.sh',
            command: 'sh {entrypoint}',
            cwd: 'worker',
            workspaceRoot: '',
            guildId: '',
            panel: {
              source: 'manifest',
              signature: '',
              path: 'worker/bot-hub.json',
              manifest: {
                title: 'Feldtest',
                entry: 'panel.html',
                fields: [],
                commands: [{ id: 'ping', label: 'Ping', run: 'echo pong' }],
              },
              settings: { log_channel: 'ops' },
              secretSettings: {},
            },
          },
        ],
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, 'data', 'secrets', `${botId}.env`),
      'LOG_CHANNEL="ops"\nAPI_KEY="nur-in-der-datei"\n',
      { mode: 0o600 },
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const panelOf = async () => {
    const run = await startHub(root, 'panel');
    assert.equal(run.code, 0, run.err);
    return JSON.parse(run.out).panel.panel;
  };

  it('holt die Felder aus dem Manifest auf der Platte nach', async () => {
    const panel = await panelOf();
    assert.equal(panel.available, true);
    assert.deepEqual(
      panel.fields.map((field) => field.key),
      ['log_channel', 'api_key'],
    );
    assert.equal(panel.settings.log_channel, 'ops');
  });

  it('behält Felder und Werte auch beim zweiten Start', async () => {
    await panelOf();
    const zweiteRunde = await panelOf();
    assert.deepEqual(
      zweiteRunde.fields.map((field) => field.key),
      ['log_channel', 'api_key'],
    );
    assert.equal(zweiteRunde.settings.log_channel, 'ops');
    // Der geheime Wert stammt aus data/secrets und wird nur maskiert gezeigt.
    assert.equal(zweiteRunde.secrets.api_key, '••••••••');
    const botsFile = readFileSync(join(root, 'data', 'bots.json'), 'utf8');
    assert.ok(
      !botsFile.includes('nur-in-der-datei'),
      'Geheimnis steht wieder im Klartext in bots.json',
    );
    assert.match(botsFile, /"secretKeys": \[\s*"api_key"\s*\]/);
  });
});

describe('Reste abgebrochener Schreibvorgänge', () => {
  it('entfernt alte Temp-Dateien und lässt junge und echte Dateien stehen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-temp-'));
    const dir = join(root, 'data', 'secrets');
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, '.env.bot-hub.tmp-bot-1-4711-1');
    const fresh = join(dir, '.env.bot-hub.tmp-bot-1-4711-2');
    const real = join(dir, 'bot.env');
    const other = join(dir, 'fremde-datei.txt');
    for (const path of [stale, fresh, real, other]) writeFileSync(path, 'x');
    // Alt machen: zwei Stunden älter als die Grenze von 60 Sekunden.
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(stale, old, old);

    const { cleanupTempEnvFiles } = await import('../server/secrets.js');
    cleanupTempEnvFiles(dir);

    assert.ok(!existsSync(stale), 'alte Temp-Datei wurde nicht entfernt');
    assert.ok(existsSync(fresh), 'junge Temp-Datei wurde entfernt');
    assert.ok(existsSync(real), 'echte Secret-Datei wurde entfernt');
    assert.ok(existsSync(other), 'fremde Datei wurde entfernt');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('Produktion ohne Vault-Key (Maßnahme 46, Auftrag 5.1)', () => {
  /** NODE_ENV/Key-Umgebung für einen Block setzen und danach zurückgeben. */
  const imModus = async (werte, aufgabe) => {
    const vorher = new Map(
      Object.keys(werte).map((name) => [name, process.env[name]]),
    );
    for (const [name, wert] of Object.entries(werte)) {
      if (wert === undefined) delete process.env[name];
      else process.env[name] = String(wert);
    }
    try {
      await aufgabe();
    } finally {
      for (const [name, wert] of vorher) {
        if (wert === undefined) delete process.env[name];
        else process.env[name] = wert;
      }
    }
  };

  it('verweigert das Schreiben von Klartext-Geheimnissen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-secrets-prod-'));
    try {
      await imModus(
        { NODE_ENV: 'production', BOT_HUB_KEY_FILE: undefined },
        async () => {
          const { storeSecretValues } = await import('../server/secrets.js');
          assert.throws(
            () => storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN }),
            /Vault-Key/,
          );
          // Nicht nur gemeldet: es darf NOTHING auf der Platte landen.
          assert.ok(
            !existsSync(join(root, 'data', 'secrets', `${BOT_ID}.env`)),
            'Verweigerter Schreibvorgang hat eine Datei hinterlassen',
          );
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('löschen bleibt auch ohne Schlüssel möglich', async () => {
    // Der Löschpfad eines Bots darf nicht an einer fehlenden Verschlüsselung
    // scheitern – sonst bleibt ein Secret gerade dann stehen, wenn es weg soll.
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-secrets-loeschen-'));
    try {
      await imModus(
        { NODE_ENV: 'production', BOT_HUB_KEY_FILE: undefined },
        async () => {
          const { storeSecretValues } = await import('../server/secrets.js');
          assert.equal(
            typeof storeSecretValues(root, BOT_ID, {}, { merge: false }),
            'string',
          );
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('schreibt mit eingerichtem Schlüssel verschrieben und liest wieder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-secrets-mit-key-'));
    try {
      await imModus(
        { NODE_ENV: 'production', BOT_HUB_KEY_FILE: undefined },
        async () => {
          const { ensureVaultKey } = await import('../server/vault.js');
          const { readSecretValues, storeSecretValues } =
            await import('../server/secrets.js');
          ensureVaultKey(root, {});
          storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN });
          const roh = readFileSync(
            join(root, 'data', 'secrets', `${BOT_ID}.env`),
            'utf8',
          );
          assert.match(roh, /vault:v2:/, 'Erwartet einen Umschlag.');
          assert.ok(
            !roh.includes(TOKEN),
            'Der Klartext-Wert steht in der Secret-Datei.',
          );
          assert.equal(readSecretValues(root, BOT_ID).DISCORD_BOT_TOKEN, TOKEN);
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Development und Test bleiben vom Klartext-Verbot ausgenommen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bot-hub-secrets-dev-'));
    try {
      for (const modus of ['development', 'test']) {
        await imModus(
          { NODE_ENV: modus, BOT_HUB_KEY_FILE: undefined },
          async () => {
            const { storeSecretValues } = await import('../server/secrets.js');
            // Ohne Schlüssel darf hier geschrieben werden – sonst wäre jede
            // Suite und jeder Entwickler-Start blockiert.
            storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN });
          },
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
