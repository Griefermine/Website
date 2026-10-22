/**
 * V24-Sicherheitshärtung (Sicherheitsbericht 2026-10-22) – Regressionstests:
 *
 *   P1-G  Rate-Limit und Routing teilen sich eine kanonische Pfad-Auflösung.
 *         Ein Test zählt nicht nur 401: er verlangt ausdrücklich 429 auf
 *         Nicht-Kanon-Varianten desselben Buckets.
 *   P1-H  MAX_BOTS hält auch gegen parallele Erstellung (atomare
 *         Slot-Reservierung vor dem ersten await).
 *   P1-I  Delete-Recovery vor regulärer Initialisierung: ein Bot in
 *         `deleting`/`cleanup_failed` bekommt beim Start KEINEN neuen
 *         Startordner, KEIN Scaffold, KEINE Dateiübernahme.
 *   P1-J  DELETE/Stop warten nicht das Ende einer langen Installation ab:
 *         der Installationsprozess wird terminiert, sein Ende abgewartet,
 *         und nach abgeschlossenem Delete darf nichts Neues geschrieben werden.
 *
 * Alle Tests laufen in temporären Verzeichnissen mit synthetischen Daten.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { __testing } = await import('../server/manager.js');

/**
 * Startet einen Hub-Prozess mit eigener Datenwurzel und ruft den Callback mit
 * (base, call) im Kind auf. `envExtra` steuert Test-Modus und Grenzen.
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

/* ------------------------------ P1-G -------------------------------- */

describe('P1-G: Rate-Limit kennt nur den kanonischen Pfad', () => {
  it('canonicalPathname fasst alle Schreibweisen auf eine Form', () => {
    const c = __testing.canonicalPathname;
    assert.equal(c('/api/bots'), '/api/bots');
    assert.equal(c('/api/bots/'), '/api/bots');
    assert.equal(c('/api//bots'), '/api/bots');
    assert.equal(c('/api///bots//'), '/api/bots');
    assert.equal(c('/'), '/');
    assert.equal(c('/api/bots/abc-1//'), '/api/bots/abc-1');
    // Prozent-Kodierung bleibt hier roh: das Lösen ist Aufgabe des Routers.
    assert.equal(c('/api/%62ots'), '/api/%62ots');
    assert.equal(c('/a/%2e%2e/b'), '/a/%2e%2e/b');
  });

  it('rateLimitPath deckt kodierte Varianten exakt einmal auf', () => {
    const p = (pfad) => __testing.rateLimitPath({ pathname: pfad });
    // Der Router löst Segmente; der Limiter muss dieselbe Form sehen.
    assert.equal(p('/api/%62ots'), '/api/bots');
    assert.equal(p('/api//%62ots/'), '/api/bots');
    assert.equal(p('/api/bots/b%6f1/'), '/api/bots/bo1');
    // Doppel-Kodierung wird NICHT ein zweites Mal gelöst: sie bleibt ein
    // eigener Pfad, der später im Router scheitert, nie ein Bucket-Upgrade.
    assert.equal(p('/api/%2562ots'), '/api/%62ots');
    assert.equal(p('/api/%2e%2e/api/bots'), '/api/../api/bots');
    // Ungültige Sequenzen bleiben roh (der Router lehnt sie ab, kein Crash).
    assert.equal(p('/api/%zz'), '/api/%zz');
    assert.equal(p('/api/%'), '/api/%');
    // Trailing Slash und Doppel-Slash ändern den Bucket nicht.
    assert.equal(p('/api/bots'), p('/api/bots//'));
  });

  it('/api/bots, /api/bots/ und /api//bots teilen denselben 429-Bucket', async () => {
    // Echter Hub OHNE BOT_HUB_TEST_MODE – sonst sind Rate-Limits aus.
    const root = tmp('bot-hub-rl-');
    mkdirSync(join(root, 'data'), { recursive: true });
    const { code, out, err } = await runHub(
      root,
      `
      const antw = [];
      // 12 POSTs auf die kanonische Form: Limit 'bot-create' ist 10.
      for (let i = 0; i < 12; i += 1) {
        antw.push((await call('/bots', { method: 'POST', body: { name: 'x' } })).status);
      }
      // Danach MUSS auch die Variante mit Abschluss-Slash und die mit
      // doppeltem Slash im selben, verbrauchten Bucket landen → 429.
      const slash = await call('/bots/', { method: 'POST', body: { name: 'x' } });
      const doppel = await call('//bots', { method: 'POST', body: { name: 'x' } });
      // Prozent-kodiert: der Router sieht darin 'bots' – also MUSS der
      // Limiter dasselbe tun (429 im selben Bucket). Doppel-kodiert bleibt
      // ein anderer Pfad und wird vor dem Handler abgelehnt (404).
      const kodiert = await call('/%62ots', { method: 'POST', body: { name: 'x' } });
      const doppeltKodiert = await call('/%2562ots', { method: 'POST', body: { name: 'x' } });
      process.stdout.write(JSON.stringify({
        antw,
        slash: slash.status, slashRetry: slash.retryAfter,
        doppel: doppel.status, doppelRetry: doppel.retryAfter,
        kodiert: kodiert.status,
        doppeltKodiert: doppeltKodiert.status,
      }));
      server.closeAllConnections?.();
      server.close();
      process.exit(0);
      `,
      { BOT_HUB_TEST_MODE: '' }, // Rate-Limits aktiv, Test-Modi-Check ohne Wert
    );
    assert.equal(code, 0, err.slice(-400));
    const r = JSON.parse(out.slice(out.lastIndexOf('{')));
    // Ohne Fix: alle Varianten laufen in eigene Buckets (nur 401, nie 429).
    assert.ok(
      r.antw.filter((s) => s === 429).length >= 2,
      `kanonischer Pfad erschöpft sein Limit nicht: ${JSON.stringify(r.antw)}`,
    );
    assert.equal(
      r.slash,
      429,
      'Abschluss-Slash bekam kein 429 (zweiter Bucket!)',
    );
    assert.ok(r.slashRetry, 'Retry-After fehlt auf der Slash-Variante');
    assert.equal(
      r.doppel,
      429,
      'doppelter Slash bekam kein 429 (zweiter Bucket!)',
    );
    assert.ok(r.doppelRetry, 'Retry-After fehlt auf der Doppel-Slash-Variante');
    assert.equal(
      r.kodiert,
      429,
      `prozentkodierter Pfad umging das Rate-Limit (Status ${r.kodiert}) – ` +
        'Limiter und Router sahen verschiedene Pfade',
    );
    // Doppel-kodiert löst beim Limiter nur einmal auf (`%62ots`) und bleibt
    // damit ein ANDERER Pfad: er darf den verbrauchten Bot-Create-Bucket nicht
    // treffen, sondern läuft bis zur Authentifizierung und endet dort mit 401.
    // Wichtig ist die Abwesenheit von 2xx/429 – ein Erreichen des Handlers
    // oder ein eigener 429-freier Create-Bucket wäre der eigentliche Missbrauch.
    assert.equal(
      r.doppeltKodiert,
      401,
      `doppel-kodierter Pfad lief im Bot-Create-Bucket (Status ${r.doppeltKodiert})`,
    );
  });
});

/* ------------------------------ P1-H -------------------------------- */

describe('P1-H: MAX_BOTS hält gegen parallele Erstellung', () => {
  it('lässt bei MAX_BOTS-1 parallelen Requests genau einen weiteren Bot durch', async () => {
    const root = tmp('bot-hub-max-');
    const { code, out, err } = await runHub(
      root,
      `
      const first = await call('/bots', { method: 'POST', body: { name: 'Erster', language: 'custom' } });
      // Acht parallele Creates gegen die verbleibende Kapazität von 1.
      const paralell = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        call('/bots', { method: 'POST', body: { name: 'Parallel-' + i, language: 'custom' } })
      ));
      const status = paralell.map((r) => r.status);
      const list = await call('/bots');
      process.stdout.write(JSON.stringify({
        first: first.status,
        created: status.filter((s) => s === 201).length,
        rejected: status.filter((s) => s === 429).length,
        gesamt: list.data.bots.length,
      }));
      server.closeAllConnections?.();
      server.close();
      process.exit(0);
      `,
      { BOT_HUB_MAX_BOTS: '2' },
    );
    assert.equal(code, 0, err.slice(-400));
    const r = JSON.parse(out.slice(out.lastIndexOf('{')));
    assert.equal(r.first, 201);
    assert.equal(
      r.created,
      1,
      `parallele Erstellung hat die Grenze überschritten: ${JSON.stringify(r)}`,
    );
    assert.equal(r.rejected, 7);
    assert.equal(r.gesamt, 2);
  });

  it('gibt den reservierten Slot bei fehlerhafter Erstellung frei', async () => {
    const root = tmp('bot-hub-slot-');
    const { code, out, err } = await runHub(
      root,
      `
      // Acht ungültige Creates (Name fehlt) – sie müssen alle 400 sein und
      // ihre Slots wieder freigeben.
      const fehl = await Promise.all(Array.from({ length: 8 }, () =>
        call('/bots', { method: 'POST', body: { language: 'custom' } })
      ));
      const danach = await Promise.all([
        call('/bots', { method: 'POST', body: { name: 'A', language: 'custom' } }),
        call('/bots', { method: 'POST', body: { name: 'B', language: 'custom' } }),
        call('/bots', { method: 'POST', body: { name: 'C', language: 'custom' } }),
      ]);
      process.stdout.write(JSON.stringify({
        fehl: fehl.map((r) => r.status),
        danach: danach.map((r) => r.status),
      }));
      server.closeAllConnections?.();
      server.close();
      process.exit(0);
      `,
      { BOT_HUB_MAX_BOTS: '2' },
    );
    assert.equal(code, 0, err.slice(-400));
    const r = JSON.parse(out.slice(out.lastIndexOf('{')));
    assert.deepEqual(r.fehl, Array(8).fill(400));
    // Slots durften nicht leak en: genau 2 von 3 gültigen Creates gewinnen.
    assert.deepEqual(r.danach, [201, 201, 429]);
  });
});

/* ------------------------------ P1-I -------------------------------- */

describe('P1-I: Delete-Recovery vor regulärer Initialisierung', () => {
  const deletingId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const aktiverId = 'aaaaaaaa-0000-4000-8000-000000000002';

  const setup = () => {
    const root = tmp('bot-hub-recover-');
    // Bot im Löschzustand: sein Workspace `worker` enthält NUR bot.sh.
    mkdirSync(join(root, 'worker'), { recursive: true });
    writeFileSync(join(root, 'worker', 'bot.sh'), 'sleep 30\n');
    // Kontroll-Bot (active): muss weiterhin normal initialisiert werden.
    mkdirSync(join(root, 'worker2'), { recursive: true });
    writeFileSync(join(root, 'worker2', 'bot.sh'), 'sleep 30\n');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'bots.json'),
      JSON.stringify([
        {
          id: deletingId,
          name: 'Löschkandidat',
          language: 'custom',
          entrypoint: 'bot.sh',
          command: 'sh {entrypoint}',
          cwd: 'worker',
          workspaceRoot: 'worker',
          deleteState: 'deleting',
        },
        {
          id: aktiverId,
          name: 'Aktiv',
          language: 'custom',
          entrypoint: 'bot.sh',
          command: 'sh {entrypoint}',
          cwd: 'worker2',
          workspaceRoot: 'worker2',
        },
      ]),
    );
    return root;
  };

  it('legt für deleting-Bots keinen Startordner/Scaffold an und holt sie trotzdem weg', async () => {
    const root = setup();
    const { code, out, err } = await runHub(
      root,
      `
      // Warten bis Recovery den deleting-Bot entfernt hat.
      let weg = false;
      for (let i = 0; i < 120; i += 1) {
        const list = await call('/bots');
        if (!list.data.bots.some((b) => b.id === '${deletingId}')) { weg = true; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Kurze Nachlaufzeit: hätte der deleting-Bot nachträglich Scaffold-Dateien
      // bekommen (Timer, Recovery-Nebenläufigkeit), wären sie jetzt sichtbar.
      await new Promise((r) => setTimeout(r, 1000));
      process.stdout.write(JSON.stringify({ weg }));
      server.closeAllConnections?.();
      server.close();
      process.exit(0);
      `,
    );
    assert.equal(code, 0, err.slice(-600));
    const r = JSON.parse(out.slice(out.lastIndexOf('{')));
    assert.equal(r.weg, true, 'Recovery hat den deleting-Bot nicht entfernt');
    // Recovery protokolliert auf stdout (Audit-Zeile), nicht auf stderr.
    assert.match(out, /RECOVERY-STARTED/);

    // KERNBEWEIS (P1-I): Für den löschenden Bots wurde NICHTS initialisiert –
    // weder im Workspace noch in seinem Hub-Ordner. Ohne Fix legten
    // ensureStartFolder, Scaffold und die Dateiübernahme hier Ressourcen an,
    // bevor Recovery überhaupt lief, und hinterließen sie als Leichen.
    assert.ok(
      !existsSync(join(root, 'bots', deletingId)),
      'Hub-Ordner des deleting-Bots wurde angelegt',
    );
    const workerDateien = new Set(readdirNames(join(root, 'worker')));
    assert.deepEqual(
      [...workerDateien],
      ['bot.sh'],
      'fremde Dateien im deleting-Workspace',
    );

    // bots.json ist bereinigt.
    const botsFile = readFileSync(join(root, 'data', 'bots.json'), 'utf8');
    assert.ok(!botsFile.includes(deletingId));

    // Kontroll-Bot: ein Bot ohne Delete-Zustand wird unverändert vollständig
    // initialisiert – Startordner und übertragene Dateien sind sein Beweis.
    assert.ok(
      existsSync(join(root, 'bots', aktiverId, 'startordner')),
      'aktiver Bot ohne Startordner',
    );
    assert.ok(
      existsSync(join(root, 'bots', aktiverId, 'workspace')),
      'aktiver Bot ohne Workspace',
    );
  });
});

const readdirNames = (dir) => readdirSync(dir);

/* ------------------------------ P1-J -------------------------------- */

/**
 * Fixture für eine lange „Installation“: eine Sprache mit hinterlegtem
 * Prüfbefehl (sonst lehnt die Installations-Route ab), ein Workspace-Wrapper
 * `./gradlew` als einziger erlaubter Eigenpfad und ein Prüfbefehl, der
 * bewusst fehlschlägt, damit die Installation wirklich losläuft.
 */
const INSTALL_FIXTUR = `
  const fs = await import('node:fs');
  const pfad = await import('node:path');
  const wurzel = process.env.BOT_DASHBOARD_ROOT;
  const bot = (await call('/bots', { method: 'POST', body: {
    name: 'Zäh', language: 'javascript', entrypoint: 'index.js',
    command: 'node index.js',
    depsCheck: 'test -f fertig.flag',
    depsInstall: './gradlew install',
  } })).data.bot;
  // Im Testmodus löst safeBotPath relativ zur Projektwurzel auf (dokumentierte
  // Erleichterung), nicht gegen den Workspace. Also cwd explizit auf den
  // Workspace setzen, damit die Installation wie im Betrieb DORT läuft.
  await call('/bots/' + bot.id, {
    method: 'PATCH',
    body: { cwd: bot.workspaceRoot },
  });
  const arbeits = pfad.join(wurzel, bot.workspaceRoot);
  // Der Wrapper schreibt im Zehntelsekundentakt neue Dateien – solange die
  // Installation läuft, wächst der Workspace.
  fs.writeFileSync(pfad.join(arbeits, 'gradlew'),
    '#!/bin/sh\\ni=0\\nwhile [ $i -lt 400 ]; do i=$((i+1)); printf x >> "takt-$i.log"; sleep 0.1; done\\n',
    { mode: 0o755 });
  fs.chmodSync(pfad.join(arbeits, 'gradlew'), 0o755);
`;

describe('P1-J: DELETE bricht lange Installationen sicher ab', () => {
  it('Delete wartet nicht auf die Installation, beendet sie und löscht final', async () => {
    const root = tmp('bot-hub-abort-');
    mkdirSync(join(root, 'data'), { recursive: true });

    const { code, out, err } = await runHub(
      root,
      `${INSTALL_FIXTUR}
      const acc = await call('/bots/' + bot.id + '/install', { method: 'POST' });
      // Der Hub antwortet mit 202; die Installation läuft im Hintergrund.
      // 'busy' ist bewusst nicht im API-Payload, also wird die Installation
      // über ihren Status UND über tatsächlich geschriebene Dateien belegt.
      let laufend = false;
      for (let i = 0; i < 80; i += 1) {
        const einzel = await call('/bots/' + bot.id);
        const geschrieben =
          fs.readdirSync(arbeits).filter((n) => n.startsWith('takt-')).length;
        if (geschrieben >= 3 && ['checking', 'installing'].includes(einzel.data.bot?.status)) {
          laufend = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const t0 = Date.now();
      const del = await call('/bots/' + bot.id, { method: 'DELETE' });
      const dauerMs = Date.now() - t0;
      process.stdout.write(
        'ERGEBNIS:' +
          JSON.stringify({
            workspace: bot.workspaceRoot,
            acc: acc.status,
            accText: JSON.stringify(acc.data).slice(0, 200),
            laufend,
            del: del.status,
            delText: JSON.stringify(del.data).slice(0, 200),
            dauerMs,
          }),
      );
      server.closeAllConnections?.();
      server.close();
      process.exit(0);
      `,
    );
    assert.equal(code, 0, err.slice(-600));
    const r = JSON.parse(out.slice(out.indexOf('ERGEBNIS:') + 9));
    assert.equal(
      r.acc,
      202,
      `Installation wurde nicht angenommen: ${JSON.stringify(r)}`,
    );
    assert.equal(
      r.laufend,
      true,
      `Installation lief nie – Test sagt nichts aus: ${JSON.stringify(r).slice(0, 600)}`,
    );
    assert.equal(r.del, 200, `Delete scheiterte: ${r.delText}`);
    // Harte Grenze: Delete fertig in Sekunden, nicht nach Minuten Installation.
    assert.ok(
      r.dauerMs < 10_000,
      `Delete wartete ${r.dauerMs} ms auf die Installation (P1-J nicht erfüllt)`,
    );

    // Nach abgeschlossenem Delete darf KEIN Installationsprozess mehr schreiben.
    const ziel = join(root, ...r.workspace.split('/'));
    const nachher = new Set(readdirNamesSync(ziel));
    await sleep(1500);
    const spaeter = new Set(readdirNamesSync(ziel));
    const neue = [...spaeter].filter((n) => !nachher.has(n));
    assert.deepEqual(
      neue,
      [],
      `Installation schreibt nach dem Delete weiter: ${neue}`,
    );
    assert.ok(
      !existsSync(join(ziel, 'gradlew')),
      'Workspace existiert nach dem Delete noch',
    );
  });

  it('Stop blockiert nicht hinter einer laufenden Installation', async () => {
    const root = tmp('bot-hub-abort-stop-');
    mkdirSync(join(root, 'data'), { recursive: true });
    const { code, out, err } = await runHub(
      root,
      `${INSTALL_FIXTUR}
      await call('/bots/' + bot.id + '/install', { method: 'POST' });
      let laufend = false;
      for (let i = 0; i < 80; i += 1) {
        const einzel = await call('/bots/' + bot.id);
        const geschrieben =
          fs.readdirSync(arbeits).filter((n) => n.startsWith('takt-')).length;
        if (geschrieben >= 3 && ['checking', 'installing'].includes(einzel.data.bot?.status)) {
          laufend = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const t0 = Date.now();
      const stop = await call('/bots/' + bot.id + '/stop', { method: 'POST' });
      process.stdout.write(
        'ERGEBNIS:' +
          JSON.stringify({
            laufend,
            status: stop.status,
            dauerMs: Date.now() - t0,
          }),
      );
      server.closeAllConnections?.();
      server.close();
      process.exit(0);
      `,
    );
    assert.equal(code, 0, err.slice(-600));
    const r = JSON.parse(out.slice(out.indexOf('ERGEBNIS:') + 9));
    assert.equal(
      r.laufend,
      true,
      'Installation lief nie – Test sagt nichts aus',
    );
    assert.equal(r.status, 200, `Stop fehlgeschlagen: ${JSON.stringify(r)}`);
    assert.ok(r.dauerMs < 10_000, `Stop wartete ${r.dauerMs} ms (Lock-Hänger)`);
  });
});

const readdirNamesSync = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
