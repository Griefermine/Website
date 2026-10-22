/**
 * V25b-Sicherheitshärtung (Sicherheitsbericht 2026-10-22) – Regressionstests:
 *
 *   V25b-1  pushLine redaktioniert nicht nur muster-basiert (KEY=/Bearer):
 *           die KONKRETEN Secret-Werte des Bots (secretEnv + geheime
 *           Panel-Felder) werden aus jedem Log-Eintrag entfernt, solange sie
 *           mindestens 8 Zeichen messen. Ein roher Token-Druck darf weder in
 *           der REST-Antwort noch im SSE-Rahmen landen.
 *   V25b-2  takeRateBucket verdrängt bei voller Bucket-Tabelle erst
 *           abgelaufene und dann den am längsten unangetasteten Bucket, statt
 *           neue Key-Inhaber pauschal mit 429 abzuweisen. Bestehende Zähler
 *           bleiben beim Bereinigen unangetastet.
 *   V25b-3  /api/logs und /api/bots/:id/logs teilen die neue Rate-Limit-
 *           Klasse `logs` (300/min) – auf der kanonischen Pfadform, also
 *           auch für Slash-/Prozent-Varianten.
 *   V25b-4  (Gegenprüfung F-2) Das bei jedem Spawn zugeteilte Runtime-Token
 *           (BOT_HUB_TOKEN) liegt am Bot und wird als Wertquelle redigiert –
 *           auch nach Revoke+Reissue; publicBot/toFile leaken es nicht.
 *   V25b-5  (Gegenprüfung F-4) Wert-Redaktion ersetzt längere Werte vor
 *           kürzeren, damit kein Klartext-Rest stehen bleibt, wenn ein
 *           Secretwert einen anderen als Teilstring enthält.
 *
 * Alle Tests laufen in temporären Verzeichnissen mit synthetischen Daten.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const MANAGER = join(ROOT, 'server', 'manager.js');

const tmpRoots = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

const { __testing } = await import('../server/manager.js');

/**
 * Startet einen Hub-Prozess mit eigener Datenwurzel (runHub-Muster aus dem
 * Projekt; hier eigenständig, bestehende Tests werden nicht angefasst).
 */
const runHub = (root, script, envExtra = {}) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        const { createServer } = await import('node:http');
        const { createServer: createApp } = await import(${JSON.stringify(MANAGER)});
        const server = createServer(createApp());
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        const call = async (path, options = {}) => {
          const res = await fetch(base + '/api' + path, {
            headers: { 'content-type': 'application/json' },
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined,
          });
          let data = null;
          try { data = await res.json(); } catch {}
          return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
        };
        ${script}
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
          ...envExtra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.once('exit', (code) => resolve({ code, out, err }));
    setTimeout(() => child.kill('SIGKILL'), 45_000).unref();
  });

/* ----------------------------- V25b-1 ------------------------------- */

describe('V25b-1: pushLine redaktioniert bekannte Secret-Werte', () => {
  // Diskord-artiger Token ohne jeden Schlüssel-Kontext: kein Muster von
  // redactLogSecrets greift hier – nur die konkrete Wert-Redaktion.
  const ROHTOKEN =
    'MTAwMTIzNDU2Nzg5MDEyMzQ1NjcuYWJjZGU.Z6789ghijkl.mNOPQRSTUVWXYZabcdef1234567890';

  it('ersetzt rohe secretEnv-Werte im Log, ignoriert Kurzwerte und Leere', () => {
    const bot = {
      id: 'v25b-redact-kurz',
      logs: [],
      secretEnv: {
        DISCORD_BOT_TOKEN: ROHTOKEN,
        KURZ: 'abc12', // unter 8 Zeichen: bewusst kein Kandidat
        LEER: '',
        UNDEF: undefined,
      },
      panel: { secretSettings: {} },
    };
    __testing.botMap.set(bot.id, bot);
    try {
      __testing.pushLine(
        bot.id,
        'stdout',
        `Der Bot hat ${ROHTOKEN} erhalten (kurz: abc12)`,
      );
      assert.equal(bot.logs.length, 1);
      const text = bot.logs[0].text;
      assert.ok(!text.includes(ROHTOKEN), 'roher Token landete im Log');
      assert.ok(
        text.includes('[REDACTED]'),
        `keine Maskierung im Log: ${text}`,
      );
      // Der Kurzwert bleibt erhalten – ein 5-Zeichen-Wert würde sonst
      // jede normale Zeile zerhacken. Leere/undefined-Werte stören nicht.
      assert.equal(
        text,
        'Der Bot hat [REDACTED] erhalten (kurz: abc12)',
        `unerwartete Redaktion: ${text}`,
      );
      // Beweis, dass genau HIER die Lücke war: die reine Muster-Redaktion
      // (vor dem Fix der einzige Schutz) lässt den rohen Wert stehen.
      assert.ok(
        __testing.redactLogSecrets(`x ${ROHTOKEN} y`).includes(ROHTOKEN),
        'Muster-Redaktion leakt nicht mehr – Test greift ins Leere',
      );
    } finally {
      __testing.botMap.delete(bot.id);
    }
  });

  it('ersetzt auch geheime Panel-Felder (panel.secretSettings)', () => {
    const clientSecret = 'client-geheimnis-9988776655';
    const bot = {
      id: 'v25b-redact-panel',
      logs: [],
      secretEnv: {},
      panel: { secretSettings: { DISCORD_CLIENT_SECRET: clientSecret } },
    };
    __testing.botMap.set(bot.id, bot);
    try {
      __testing.pushLine(bot.id, 'stdout', `push ${clientSecret} done`);
      assert.equal(bot.logs.length, 1);
      assert.ok(
        !bot.logs[0].text.includes(clientSecret),
        'Panel-Secret landete im Log',
      );
      assert.equal(bot.logs[0].text, 'push [REDACTED] done');
    } finally {
      __testing.botMap.delete(bot.id);
    }
  });

  it('zeigt den rohen Wert weder über REST noch über SSE', async () => {
    const root = tmp('bot-hub-redact-');
    mkdirSync(join(root, 'data'), { recursive: true });
    const { code, out, err } = await runHub(
      root,
      `
      const { __testing } = await import(${JSON.stringify(MANAGER)});
      const ROH = ${JSON.stringify(ROHTOKEN)};
      const angelegt = await call('/bots', { method: 'POST', body: {
        name: 'Redaktionsfall', language: 'custom',
        secretEnv: { DISCORD_BOT_TOKEN: ROH },
      } });
      const botId = angelegt.data.bot.id;
      // Die Create-Antwort selbst maskiert bereits (publicBot) – zur Kontrolle.
      const createLeakt = JSON.stringify(angelegt.data).includes(ROH);
      // SSE-Rahmen abfangen: Test-Modus gewährt logs.read, der Fake-Socket
      // sieht exakt dieselben Frames wie ein Dashboard-Client.
      const rahmen = [];
      const lauscher = { __sseReq: {}, write: (f) => rahmen.push(String(f)) };
      __testing.sseListeners.add(lauscher);
      __testing.pushLine(botId, 'stdout', 'Verbindung aufgebaut mit ' + ROH);
      __testing.pushLine(botId, 'stderr', 'roher Dump: ' + ROH);
      __testing.sseListeners.delete(lauscher);
      const botLogs = await call('/bots/' + botId + '/logs');
      const globalLogs = await call('/logs');
      process.stdout.write(JSON.stringify({
        botId,
        createLeakt,
        sseAnzahl: rahmen.length,
        sseLeakt: rahmen.some((f) => f.includes(ROH)),
        sseMaskiert: rahmen.every((f) => f.includes('[REDACTED]')),
        botStatus: botLogs.status,
        botLeakt: JSON.stringify(botLogs.data).includes(ROH),
        botMaskiert: JSON.stringify(botLogs.data).includes('[REDACTED]'),
        botZeilen: botLogs.data.lines?.length ?? 0,
        globalStatus: globalLogs.status,
        globalLeakt: JSON.stringify(globalLogs.data).includes(ROH),
      }));
      server.closeAllConnections?.();
      server.close();
      process.exit(0);
      `,
    );
    assert.equal(code, 0, err.slice(-600));
    const r = JSON.parse(out.slice(out.lastIndexOf('{')));
    assert.equal(r.createLeakt, false, 'Create-Antwort leakt das Secret');
    // Der Weg, den der Bericht beschreibt: Bot druckt den Token roh.
    assert.equal(r.botStatus, 200);
    assert.ok(r.botZeilen >= 2, `zu wenige Logzeilen: ${r.botZeilen}`);
    assert.equal(r.botLeakt, false, 'REST /api/bots/:id/logs leakt den Token');
    assert.equal(r.botMaskiert, true, 'REST-Logs enthalten kein [REDACTED]');
    assert.equal(r.globalStatus, 200);
    assert.equal(r.globalLeakt, false, 'REST /api/logs leakt den Token');
    assert.equal(r.sseAnzahl, 2, 'SSE-Rahmen nicht abgefangen');
    assert.equal(r.sseLeakt, false, 'SSE-Rahmen leaken den Token');
    assert.equal(r.sseMaskiert, true, 'SSE-Rahmen ohne [REDACTED]');
  });
});

/* ----------------------------- V25b-4 ------------------------------- */

describe('V25b-4 (F-2): Runtime-Token wird als Wertquelle redigiert', () => {
  it('hubEnv legt den Token am Bot ab; roher Druck trifft auch nach Revoke+Reissue', async () => {
    // Echte Verkabelung statt Attrickse: hubEnv ist die einzige Stelle, die
    // BOT_HUB_TOKEN zuteilt (issueRuntimeToken ersetzt pro Bot den Vorgänger –
    // es gilt immer genau ein Token, daher Skalar statt Liste).
    const panelApi = await import('../server/panel.js');
    const bot = {
      id: 'v25b-runtime-redact',
      name: 'Laufzeitfall',
      logs: [],
      env: {},
      secretEnv: {},
      panel: {},
    };
    __testing.botMap.set(bot.id, bot);
    try {
      const token1 = panelApi.hubEnv(bot, ROOT).BOT_HUB_TOKEN;
      assert.ok(
        typeof token1 === 'string' && token1.length >= 8,
        `hubEnv liefert keinen brauchbaren Token: ${typeof token1}`,
      );
      assert.equal(
        bot.runtimeToken,
        token1,
        'hubEnv hat den Wert nicht am Bot abgelegt',
      );
      // Der Bot druckt seine Umgebung roh – ohne KEY=-Kontext, also ohne
      // jeden Muster-Treffer: nur die Wert-Redaktion kann hier greifen.
      __testing.pushLine(bot.id, 'stdout', `hub: ${token1}`);
      assert.ok(
        !bot.logs[0].text.includes(token1),
        'rohes Runtime-Token landete im Log',
      );
      assert.equal(bot.logs[0].text, 'hub: [REDACTED]');
      // Revoke + Reissue: die Quelle muss den AKTUELLEN Wert treffen.
      panelApi.revokeRuntimeToken(bot.id);
      const token2 = panelApi.hubEnv(bot, ROOT).BOT_HUB_TOKEN;
      assert.notEqual(token2, token1, 'Reissue teilte denselben Token aus');
      assert.equal(
        bot.runtimeToken,
        token2,
        'Quelle zeigt nicht auf den neuen Wert',
      );
      __testing.pushLine(bot.id, 'stderr', `dump ${token2} ende`);
      assert.ok(
        !bot.logs[1].text.includes(token2),
        'neues Runtime-Token landete unredigiert im Log',
      );
      assert.equal(bot.logs[1].text, 'dump [REDACTED] ende');
    } finally {
      panelApi.revokeRuntimeToken(bot.id);
      __testing.botMap.delete(bot.id);
    }
  });

  it('publicBot und toFile leaken runtimeToken nicht', () => {
    const token = 'rt-' + 'f'.repeat(20) + '-wert';
    const bot = {
      id: 'v25b-runtime-serial',
      name: 'Serialisierungsfall',
      logs: [],
      env: {},
      secretEnv: {},
      panel: {},
      runtimeToken: token,
    };
    __testing.botMap.set(bot.id, bot);
    try {
      const pub = __testing.publicBot(bot);
      assert.ok(!('runtimeToken' in pub), 'publicBot enthält runtimeToken');
      assert.ok(
        !JSON.stringify(pub).includes(token),
        'publicBot serialisiert den Token-Wert',
      );
      const datei = __testing.toFile();
      const eintrag = datei.find((b) => b.id === bot.id);
      assert.ok(eintrag, 'toFile-Eintrag fehlt');
      assert.ok(
        !('runtimeToken' in eintrag),
        'toFile enthält runtimeToken – bots.json würde leakeln',
      );
      assert.ok(
        !JSON.stringify(datei).includes(token),
        'toFile serialisiert den Token-Wert',
      );
    } finally {
      __testing.botMap.delete(bot.id);
    }
  });
});

/* ----------------------------- V25b-5 ------------------------------- */

describe('V25b-5 (F-4): Längere Secret-Werte werden vor kürzeren ersetzt', () => {
  it('kein Klartext-Rest, wenn ein Wert den anderen als Teilstring enthält', () => {
    const kurz = 'geheimnis-kurz-4711';
    const lang = `paket-${kurz}-anteil`; // enthält den kurzen Wert echt
    const bot = {
      id: 'v25b-redact-laenge',
      logs: [],
      // Objektreihenfolge: KURZ zuerst – ohne Längensortierung zerreißt das
      // kurze Secret den langen und `-anteil` bliebe als Rest stehen.
      secretEnv: { KURZ: kurz, LANG: lang },
      panel: { secretSettings: {} },
    };
    assert.ok(
      Object.keys(bot.secretEnv)[0] === 'KURZ',
      'Testobjekt liefert nicht die erwartete Objektreihenfolge',
    );
    __testing.botMap.set(bot.id, bot);
    try {
      __testing.pushLine(bot.id, 'stdout', `export ${lang}`);
      const text = bot.logs[0].text;
      assert.ok(!text.includes(lang), 'langer Wert landete im Log');
      assert.ok(!text.includes(kurz), `Kurzwert-Rest sichtbar: ${text}`);
      assert.ok(!text.includes('-anteil'), `Restschwanz sichtbar: ${text}`);
      assert.equal(text, 'export [REDACTED]');
      // Der kurze Wert zählt weiterhin eigenständig, auch allein in einer Zeile.
      __testing.pushLine(bot.id, 'stdout', `kurz solo ${kurz} ende`);
      assert.equal(bot.logs[1].text, 'kurz solo [REDACTED] ende');
    } finally {
      __testing.botMap.delete(bot.id);
    }
  });
});

/* ----------------------------- V25b-2 ------------------------------- */

describe('V25b-2: takeRateBucket verdrängt statt pauschal zu drosseln', () => {
  const { takeRateBucket, rateBuckets, MAX_RATE_BUCKETS } = __testing;
  const T = 1_700_000_000_000; // fiktiver Startzeitpunkt, Fenster ist 60 000 ms
  const cleanup = () => rateBuckets.clear();
  after(cleanup);

  it('sweep abgelaufene Buckets, bevor ein neuer Key ein 429 bekäme', () => {
    cleanup();
    for (let i = 0; i < MAX_RATE_BUCKETS; i += 1)
      assert.equal(takeRateBucket(`alt-${i}:logs:ip`, 300, T), null);
    assert.equal(rateBuckets.size, MAX_RATE_BUCKETS);
    // Volle Tabelle, aber alles ist abgelaufen: der neue Key MUSS einen
    // Bucket bekommen – ohne Fix war hier pauschal Schluss mit 429.
    assert.equal(takeRateBucket('neu:logs:ip', 300, T + 61_000), null);
    assert.ok(rateBuckets.has('neu:logs:ip'));
    assert.equal(rateBuckets.size, 1, 'abgelaufene Buckets nicht ausgesondert');
  });

  it('verdrängt den am längsten unangetasteten Bucket, nicht den legitimen', () => {
    cleanup();
    // Legitimer Inhaber: zweimal angefasst, zuletzt deutlich nach den Füllern.
    assert.equal(takeRateBucket('legitim:logs:ip', 300, T), null);
    for (let i = 0; i < MAX_RATE_BUCKETS - 1; i += 1)
      assert.equal(takeRateBucket(`fueller-${i}:logs:ip`, 300, T), null);
    assert.equal(takeRateBucket('legitim:logs:ip', 300, T + 5_000), null);
    assert.equal(rateBuckets.size, MAX_RATE_BUCKETS);
    // Volle Tabelle, NICHTS abgelaufen: ein frischer Angreifer-Key bekommt
    // trotzdem Platz, indem der älteste unangetastete Füller weicht.
    assert.equal(takeRateBucket('neu:logs:ip', 300, T + 6_000), null);
    assert.equal(rateBuckets.size, MAX_RATE_BUCKETS);
    assert.ok(rateBuckets.has('neu:logs:ip'), 'neuer Key bekam keinen Bucket');
    assert.ok(
      rateBuckets.has('legitim:logs:ip'),
      'legitimer Bucket wurde verdrängt',
    );
    // Semantik für bestehende Keys: kein Zähler-Reset durch das Sweeping –
    // der legitime Bucket zählt bei 3 weiter, nicht bei 1.
    assert.equal(takeRateBucket('legitim:logs:ip', 300, T + 7_000), null);
    assert.equal(rateBuckets.get('legitim:logs:ip').count, 3);
    // Und sein Limit gilt unverändert weiter: bei 300 ist Schluss.
    for (let i = 3; i < 300; i += 1)
      assert.equal(takeRateBucket('legitim:logs:ip', 300, T + 8_000), null);
    assert.equal(rateBuckets.get('legitim:logs:ip').count, 300);
    assert.equal(
      takeRateBucket('legitim:logs:ip', 300, T + 8_000)?.status,
      429,
      'Limit-Semantik bestehender Keys verändert',
    );
  });

  it('bestehende Schlüssel: 429 mit Retry-After und Frischstart nach Ablauf', () => {
    cleanup();
    for (let i = 0; i < 5; i += 1)
      assert.equal(takeRateBucket('x:logs:ip', 5, T), null);
    const fehler = takeRateBucket('x:logs:ip', 5, T + 1_000);
    assert.equal(fehler?.status, 429);
    assert.ok(
      Number.isInteger(fehler.retryAfter) && fehler.retryAfter >= 1,
      `Retry-After fehlt: ${JSON.stringify(fehler)}`,
    );
    // Nach Fensterablauf zählt derselbe Key wieder von vorn (alt wie neu).
    assert.equal(takeRateBucket('x:logs:ip', 5, T + 61_000), null);
    assert.equal(rateBuckets.get('x:logs:ip').count, 1);
    cleanup();
  });
});

/* ----------------------------- V25b-3 ------------------------------- */

describe('V25b-3: Log-Pfade kennen die Rate-Limit-Klasse logs', () => {
  const { rateLimit, rateBuckets } = __testing;
  const vorherTestModus = process.env.BOT_HUB_TEST_MODE;

  const anfrage = (ip) => ({
    method: 'GET',
    headers: {},
    socket: { remoteAddress: ip },
  });
  const url = (pfad) => new URL('http://hub' + pfad);

  it('/api/logs und /api/bots/:id/logs drosseln bei 300/min pro Identität', () => {
    delete process.env.BOT_HUB_TEST_MODE; // RateLimits aktiv
    try {
      rateBuckets.clear();
      let erlaubt = 0;
      for (let i = 0; i < 300; i += 1)
        if (rateLimit(anfrage('203.0.113.7'), url('/api/logs')) === null)
          erlaubt += 1;
      assert.equal(erlaubt, 300);
      const fehler = rateLimit(anfrage('203.0.113.7'), url('/api/logs'));
      assert.equal(fehler?.status, 429, '/api/logs blieb ungedrosselt');
      assert.ok(fehler.retryAfter >= 1, 'Retry-After fehlt');
      // Beide Log-Pfade teilen die Klasse: verbrauchtes Budget wirkt auch
      // auf die Pro-Bot-Variante.
      assert.equal(
        rateLimit(anfrage('203.0.113.7'), url('/api/bots/abc/logs'))?.status,
        429,
        '/api/bots/:id/logs umgeht die logs-Klasse',
      );
      // Frische IP: eigenes Budget auf dem Pro-Bot-Pfad, dann ebenfalls 429.
      let erlaubt2 = 0;
      for (let i = 0; i < 300; i += 1)
        if (
          rateLimit(anfrage('203.0.113.8'), url('/api/bots/abc/logs')) === null
        )
          erlaubt2 += 1;
      assert.equal(erlaubt2, 300);
      assert.equal(
        rateLimit(anfrage('203.0.113.8'), url('/api/bots/abc/logs'))?.status,
        429,
        '/api/bots/:id/logs blieb ungedrosselt',
      );
      // Andere Klassen bleiben unberührt: health ist undrosselt, und die
      // verbrauchte logs-IP darf woanders weiterarbeiten.
      assert.equal(rateLimit(anfrage('203.0.113.7'), url('/api/health')), null);
    } finally {
      rateBuckets.clear();
      if (vorherTestModus === undefined) delete process.env.BOT_HUB_TEST_MODE;
      else process.env.BOT_HUB_TEST_MODE = vorherTestModus;
    }
  });

  it('nicht-kanonische Log-Pfadformen treffen denselben Bucket', () => {
    delete process.env.BOT_HUB_TEST_MODE;
    try {
      rateBuckets.clear();
      for (let i = 0; i < 300; i += 1)
        assert.equal(
          rateLimit(anfrage('203.0.113.9'), url('/api/logs')),
          null,
          `vorzeitige Drossel bei ${i}`,
        );
      // Abschluss-Slash, Doppel-Slash und Prozentkodierung: dieselben
      // Bucket wie die kanonische Form (P1-G-Prinzip, jetzt auch für logs).
      assert.equal(
        rateLimit(anfrage('203.0.113.9'), url('/api/logs/'))?.status,
        429,
        'Abschluss-Slash umgeht die logs-Klasse',
      );
      assert.equal(
        rateLimit(anfrage('203.0.113.9'), url('/api//logs'))?.status,
        429,
        'Doppel-Slash umgeht die logs-Klasse',
      );
      assert.equal(
        rateLimit(anfrage('203.0.113.9'), url('/api/%6cogs'))?.status,
        429,
        'Prozentkodierung umgeht die logs-Klasse',
      );
      // Und beim Bot-Pfad ebenso:
      assert.equal(
        rateLimit(anfrage('203.0.113.9'), url('/api/bots/abc//logs/'))?.status,
        429,
        'Bot-Log-Variante umgeht die logs-Klasse',
      );
    } finally {
      rateBuckets.clear();
      if (vorherTestModus === undefined) delete process.env.BOT_HUB_TEST_MODE;
      else process.env.BOT_HUB_TEST_MODE = vorherTestModus;
    }
  });
});
