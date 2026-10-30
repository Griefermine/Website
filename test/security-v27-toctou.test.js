/**
 * Maßnahme 50 (V27-E, Auftrag 5.2): Panel-Auslieferung prüft und öffnet in
 * einem Schritt.
 *
 * Vorher: `servePanelFile` prüfte den Realpfad, `sendFile` maß die Größe mit
 * `statSync(path)` und las dann mit `createReadStream(path)` NOCH EINMAL den
 * Pfad. Dazwischen konnte der Bot – dem dieser Workspace gehört und der darin
 * schreiben darf – die Datei gegen einen Symlink auf beliebige vom
 * Hub-Benutzer lesbare Dateien tauschen: geprüft wurde die eine, gelesen die
 * andere. Das Zeitfenster ist mikrosekundengroß (praktisch schwer trafbar);
 * die Abwehr ist hier beweisbar: O_NOFOLLOW beim Öffnen und danach nur noch
 * Arbeit am Deskriptor.
 *
 * Die Tests arbeiten ohne Wettlauf: Sie tauschen die Datei NACH dem Öffnen –
 * bei der alten Implementierung hätte der Stream den neuen Pfad aufgelöst,
 * hier bleibt er an den geöffneten Deskriptor gebunden.
 */

import assert from 'node:assert/strict';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';

const { __testing } = await import('../server/panel.js');
const { openPanelFile, sendFile, readManifest } = __testing;

const root = mkdtempSync(join(tmpdir(), 'v27-toctou-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

/* Manifest-Grundlage für die Maße-53-Fälle: `leseManifest` sucht im
 * Workspace-Root (hier das Temp-Verzeichnis selbst). */
writeFileSync(
  join(root, 'bot-hub.json'),
  JSON.stringify({ title: 'Testseite', entry: 'index.html' }),
);

/** Datei mit gewünschter Größe anlegen (für die 8-MiB-Grenze). */
const dateiMitGroesse = (pfad, bytes) =>
  writeFileSync(pfad, Buffer.alloc(bytes, 0x61));

/** Gefälschte Response: sammelt Status, Kopfzeilen und Körper. */
const falscheResponse = () => {
  const brocken = [];
  let fertig = null;
  const done = new Promise((resolve) => (fertig = resolve));
  const res = new Writable({
    write(chunk, _kodierung, callback) {
      brocken.push(chunk);
      callback();
    },
  });
  res.statusCode = 0;
  res.headers = {};
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers ?? {};
    return res;
  };
  res.on('finish', fertig);
  res.result = () => ({
    status: res.statusCode,
    headers: res.headers,
    text: Buffer.concat(brocken).toString('utf8'),
  });
  res.abgeschlossen = done;
  return res;
};

/* ------------------------- Öffnen statt Raten --------------------------- */

test('die geöffnete Datei bleibt auch nach einem Tausch dieselbe', () => {
  const pfad = join(root, 'panel.html');
  const geheim = join(root, 'beute.txt');
  writeFileSync(pfad, '<p>ORIGINAL</p>');
  writeFileSync(geheim, 'GEHEIMER-BESTAND');

  const { fd, stat } = openPanelFile(pfad);
  try {
    assert.equal(stat.size, '<p>ORIGINAL</p>'.length);
    // Der Angriff, jetzt ohne Wettlauf: Pfad löschen und durch einen Symlink
    // auf die fremde Datei ersetzen. Ein Pfad-Stream (alte Fassung) hätte beim
    // Lesen neu aufgelöst und die Beute geliefert.
    unlinkSync(pfad);
    symlinkSync(geheim, pfad);
    assert.equal(readFileSync(fd, 'utf8'), '<p>ORIGINAL</p>');
  } finally {
    closeSync(fd);
    unlinkSync(pfad);
  }
});

test('ein Symlink wird beim Öffnen abgelehnt, nicht gefolgt', () => {
  const ziel = join(root, 'fremd.txt');
  const link = join(root, 'link.html');
  writeFileSync(ziel, 'FREMD');
  symlinkSync(ziel, link);
  assert.throws(
    () => openPanelFile(link),
    (error) => error.status === 404 && error.message === 'Datei nicht gefunden',
  );
  // Die Meldung darf nicht verraten, WARUM sie ablehnt (fehlend vs. Symlink):
  // beides ist dasselbe 404, ein Angreifer bekommt keinen Rückkanal.
});

test('ein Verzeichnis ist keine Panel-Datei', () => {
  const ordner = join(root, 'unterseite');
  mkdirSync(ordner, { recursive: true });
  assert.throws(
    () => openPanelFile(ordner),
    (e) => e.status === 404,
  );
});

test('die Größenprüfung sitzt am geöffneten Objekt', () => {
  const pfad = join(root, 'riesig.bin');
  dateiMitGroesse(pfad, 8 * 1024 * 1024 + 1);
  assert.throws(
    () => openPanelFile(pfad),
    (e) => e.status === 413,
  );
});

/* ----------------------- nichts bleibt offen ---------------------------- */

const deskriptorenAnzahl = () => {
  try {
    // /proc gibt es nur auf Linux – dort laufen Betrieb und CI.
    return readdirSync('/proc/self/fd').length;
  } catch {
    return -1;
  }
};

test('abgelehnte Auslieferung leakt keinen Dateideskriptor', async () => {
  const vorher = deskriptorenAnzahl();
  if (vorher < 0) return; // ohne /proc nichts zu prüfen
  const zuGross = join(root, 'leak.bin');
  dateiMitGroesse(zuGross, 8 * 1024 * 1024 + 1);
  const link = join(root, 'leak-link.html');
  if (!fremdVorhanden()) writeFileSync(join(root, 'fremd.txt'), 'x');
  symlinkSync(join(root, 'fremd.txt'), link);
  for (const pfad of [zuGross, link, join(root, 'fehlt.html'), root]) {
    try {
      openPanelFile(pfad);
      assert.fail(`${pfad} hätte abgelehnt werden müssen`);
    } catch (error) {
      assert.ok([404, 413].includes(error.status), String(error.status));
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    deskriptorenAnzahl() <= vorher,
    `vorher ${vorher}, nachher ${deskriptorenAnzahl()} Deskriptoren`,
  );
});

/* ------------------- Auslieferung funktioniert weiterhin ------------------ */

test('sendFile liefert Kopfzeilen und Körper aus dem Deskriptor', async () => {
  const pfad = join(root, 'seite.html');
  writeFileSync(pfad, '<h1>Hallo</h1>');
  const res = falscheResponse();
  sendFile(res, pfad, 'https://assets.example');
  await res.abgeschlossen;
  const { status, headers, text } = res.result();
  assert.equal(status, 200);
  assert.match(headers['content-type'], /^text\/html/);
  assert.equal(headers['content-length'], '<h1>Hallo</h1>'.length);
  assert.match(headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.match(headers['content-security-policy'], /assets\.example/);
  assert.equal(text, '<h1>Hallo</h1>');
});

test('sendFile lehnt zu große Dateien ab, bevor Kopfzeilen stehen', () => {
  const pfad = join(root, 'gross.html');
  dateiMitGroesse(pfad, 8 * 1024 * 1024 + 1);
  const res = falscheResponse();
  assert.throws(
    () => sendFile(res, pfad),
    (e) => e.status === 413,
  );
  // writeHead darf bei Ablehnung nie erreicht worden sein, sonst stünde eine
  // halbe Antwort auf dem Draht.
  assert.equal(res.statusCode, 0);
});

function fremdVorhanden() {
  try {
    return readFileSync(join(root, 'fremd.txt'), 'utf8').length >= 0;
  } catch {
    return false;
  }
}

/* ---------------- Maßnahme 53 (Gegenprüfung NF-1): das Manifest ----------- *
 * readManifest prüfte früher existsSync/statSync und las dann readFileSync
 * NACH PFAD – dasselbe Prüfe-dann-öffne-Muster, das Maßnahme 50 für die
 * Datei-Auslieferung geschlossen hat. Ein Bot, der im Fenster den Pfad gegen
 * einen Symlink tauscht, ließ den Hub eine beliebige vom Hub-Benutzer lesbare
 * Datei parsen (Fehlerfragmente landen als `error` im Panel-Zustand).
 *
 * workspaceDir liefert ohne Testmodus den bots/<id>/workspace-Pfad (kompliziert
 * aufzubauen); mit BOT_HUB_TEST_MODE=1 ist es der Projekt-Root. Als bot.cwd
 * wird ein ABSOLUTER Temp-Pfad übergeben — join() lässt ihn gewinnen, die
 * Bot-Ordner liegen also exakt im Temp-Verzeichnis dieses Tests. */

const { readdirSync: readdirSyncFd } = await import('node:fs');

const manifestBot = (id) => ({ id, workspaceRoot: '', cwd: root });

const leseManifest = (id, ordner = root) => {
  const vorher = {
    mode: process.env.BOT_HUB_TEST_MODE,
    root: process.env.BOT_DASHBOARD_ROOT,
  };
  process.env.BOT_HUB_TEST_MODE = '1';
  // projectRoot() wird bei jedem Aufruf gelesen – der Temp-Root dieses Tests
  // wird so zum Workspace-Root, ohne dass etwas ins Repo schreibt.
  process.env.BOT_DASHBOARD_ROOT = root;
  try {
    return readManifest({ id, workspaceRoot: '', cwd: ordner });
  } finally {
    if (vorher.mode === undefined) delete process.env.BOT_HUB_TEST_MODE;
    else process.env.BOT_HUB_TEST_MODE = vorher.mode;
    if (vorher.root === undefined) delete process.env.BOT_DASHBOARD_ROOT;
    else process.env.BOT_DASHBOARD_ROOT = vorher.root;
  }
};

test('ein echtes Manifest wird gelesen', () => {
  const ergebnis = leseManifest('m-echt');
  assert.ok(ergebnis, 'Manifest nicht gefunden');
  assert.equal(ergebnis.error, '');
  assert.equal(ergebnis.manifest.title, 'Testseite');
  assert.match(ergebnis.manifest.entry, /index\.html/);
});

test('ein Symlink als Manifest wird ignoriert, die fremde Datei nicht gelesen', () => {
  const beute = join(root, 'beute-manifest.json');
  writeFileSync(beute, '{"geheimnis":"NICHT-LESEN"}');
  const botOrdner = join(root, 'symlinkbot');
  mkdirSync(botOrdner, { recursive: true });
  symlinkSync(beute, join(botOrdner, 'bot-hub.json'));
  const ergebnis = leseManifest('m-link', botOrdner);
  assert.equal(ergebnis, null, 'Symlink-Manifest wurde gelesen');
  // Kein Fragment der Beute wäre im Ergebnis sichtbar – gar kein Ergebnis.
});

test('ein übergroßes Manifest wird am Deskriptor abgelehnt', () => {
  const botOrdner = join(root, 'riesig-bot');
  mkdirSync(botOrdner, { recursive: true });
  // Fülle den Wert so, dass normalisePanel den Inhalt noch sehen würde.
  writeFileSync(
    join(botOrdner, 'bot-hub.json'),
    JSON.stringify({ title: 'x'.repeat(200_000), entry: 'a.html' }),
  );
  const ergebnis = leseManifest('m-gross', botOrdner);
  assert.ok(ergebnis, 'übergroßes Manifest lieferte null statt Fehler');
  assert.equal(ergebnis.manifest, null);
  assert.match(ergebnis.error, /zu groß \(max\. 128 KB\)/);
});

test('Manifest-Leser leakt keinen Dateideskriptor', async () => {
  let anzahl = 0;
  try {
    anzahl = readdirSyncFd('/proc/self/fd').length;
  } catch {
    return; // ohne /proc nichts zu prüfen
  }
  leseManifest('m-fd-1');
  leseManifest('m-fd-2'); // Cache-Treffer
  const gross = join(root, 'riesig-bot');
  leseManifest('m-fd-3', gross); // 413-Pfad
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    readdirSyncFd('/proc/self/fd').length <= anzahl,
    'Deskriptoren laufen davon',
  );
});
