/**
 * Regressionstests für scripts/history-scan.mjs (P2-B/P2-C).
 *
 * Der Historien-Scan muss drei Dinge beweisen:
 *   1. Ein Geheimnis, das nur noch in der Historie steht, wird gefunden.
 *   2. Ein Fund wird OHNE Wert gemeldet.
 *   3. „nicht prüfbar“ ist kein Erfolg (Exit 2), sondern ein Abbruch.
 *
 * Jeder Fall baut ein eigenes, temporäres Git-Repository. Der echte
 * Projektbestand wird für diese Tests nicht angefasst.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const SKRIPT = resolve(import.meta.dirname, '../scripts/history-scan.mjs');
const tmpRoots = [];
const SCHNITT = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00 +0000',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00 +0000',
};

// Zusammengebaut, damit diese Testdatei selbst kein Muster auslöst.
const ECHTES_TOKEN = [
  'mt',
  'A9xK',
  'Q7zLm4WpR2tYvB8nHdJf5GcS1kNeT3uP',
  'Xy6bVc6HgJ8MnQw',
].join('');

const tempOrdner = (name) => {
  const ordner = mkdtempSync(join(tmpdir(), `bot-hub-history-${name}-`));
  tmpRoots.push(ordner);
  return ordner;
};

const imRepo = (ordner, ...args) =>
  execFileSync('git', args, {
    cwd: ordner,
    encoding: 'utf8',
    env: { ...process.env, ...SCHNITT },
  });

/**
 * Repository mit festen Zeitstempeln bauen. Jeder Schritt ist ein Commit;
 * `--allow-empty` erlaubt es, dass eine Datei verschwindet und der Schritt
 * trotzdem ein eigener Stand bleibt.
 */
const repoBauen = (name, schritte) => {
  const ordner = tempOrdner(name);
  imRepo(ordner, 'init', '-q', '--initial-branch=main', '.');
  for (const [nachricht, dateien, loeschen = []] of schritte) {
    for (const [pfad, inhalt] of Object.entries(dateien)) {
      const voll = join(ordner, pfad);
      mkdirSync(dirname(voll), { recursive: true });
      writeFileSync(voll, inhalt);
    }
    for (const pfad of loeschen) rmSync(join(ordner, pfad), { force: true });
    imRepo(ordner, 'add', '-A', '.');
    imRepo(ordner, 'commit', '-q', '--allow-empty', '-m', nachricht);
  }
  return ordner;
};

const laufen = (ordner, ...optionen) => {
  const ergebnis = spawnSync(
    process.execPath,
    [SKRIPT, '--repo', ordner, ...optionen],
    { encoding: 'utf8' },
  );
  return {
    code: ergebnis.status,
    aus: `${ergebnis.stdout ?? ''}${ergebnis.stderr ?? ''}`,
  };
};

let sauber;
let geloescht;
let prosaBeispiel;
let geheimnisPfad;
let verschoben;

before(() => {
  execFileSync('git', ['--version'], { stdio: 'ignore' });

  sauber = repoBauen('clean', [
    [
      'Grundlage',
      {
        'README.md': '# Hub\n',
        'src/index.js': 'export const a = 1;\n',
        '.env.example': 'DISCORD_CLIENT_SECRET=<hier eintragen>\n',
      },
    ],
  ]);

  geloescht = repoBauen('deleted', [
    ['Grundlage', { 'README.md': '# Hub\n' }],
    [
      'Konfiguration comittet',
      { 'konfiguration.env': `DISCORD_BOT_TOKEN=${ECHTES_TOKEN}\n` },
    ],
    ['Datei wieder entfernt', {}, ['konfiguration.env']],
  ]);
  appendFileSync(join(geloescht, 'README.md'), '\nweiter\n');
  imRepo(geloescht, 'add', '-A', '.');
  imRepo(geloescht, 'commit', '-q', '-m', 'README ergänzt');

  prosaBeispiel = repoBauen('prosa', [
    [
      'Beispielkonfiguration',
      {
        '.env.example':
          'DISCORD_CLIENT_SECRET=hier-client-secret-einsetzen\nLEER=\n',
      },
    ],
  ]);

  geheimnisPfad = repoBauen('pfad', [
    [
      'Laufzeitdatei versehentlich getrackt',
      { 'data/secrets/bot1.env': 'WURDE_GEÄNDERT\n' },
    ],
  ]);

  verschoben = repoBauen('umbenannt', [
    ['alt', { 'alt/config.env': `BOT_HUB_TOKEN=${ECHTES_TOKEN}\n` }],
  ]);
  mkdirSync(join(verschoben, 'neu'), { recursive: true });
  imRepo(verschoben, 'mv', 'alt/config.env', 'neu/einstellungen.env');
  imRepo(verschoben, 'add', '-A', '.');
  imRepo(verschoben, 'commit', '-q', '-m', 'verschoben');
});

after(() => {
  for (const ordner of tmpRoots)
    rmSync(ordner, { recursive: true, force: true });
});

describe('Historien-Scan', () => {
  it('gibt eine saubere Historie frei', () => {
    const { code, aus } = laufen(sauber);
    assert.equal(code, 0, aus);
    assert.match(aus, /nichts gefunden/);
  });

  it('findet ein Geheimnis, das längst gelöscht ist', () => {
    const { code, aus } = laufen(geloescht);
    assert.equal(code, 1, aus);
    assert.match(aus, /konfiguration\.env/);
    assert.match(aus, /belegte Umgebungsvariable: DISCORD_BOT_TOKEN/);
  });

  it('gibt den gefundenen Wert nicht aus', () => {
    const { aus } = laufen(geloescht);
    assert.ok(
      !aus.includes(ECHTES_TOKEN),
      'Die Meldung enthält das Token im Klartext',
    );
    // Auch kein langes Teilstück, das man direkt weiterverwenden könnte.
    assert.ok(!aus.includes(ECHTES_TOKEN.slice(0, 20)));
  });

  it('meldet einen Geheimnis-Pfad auch ohne Inhalt', () => {
    const { code, aus } = laufen(geheimnisPfad);
    assert.equal(code, 1, aus);
    assert.match(aus, /data\/secrets\/bot1\.env/);
    assert.match(aus, /Pfad:/);
  });

  it('hält Prosa-Platzhalter für keine Geheimnisse', () => {
    const { code, aus } = laufen(prosaBeispiel);
    assert.equal(code, 0, aus);
    assert.ok(!aus.includes('DISCORD_CLIENT_SECRET'), aus);
  });

  it('findet denselben Inhalt unter jedem Pfad, unter dem er stand', () => {
    const { code, aus } = laufen(verschoben);
    assert.equal(code, 1, aus);
    assert.match(aus, /alt\/config\.env/);
    assert.match(aus, /neu\/einstellungen\.env/);
  });

  it('bricht ohne Git ab statt „frei“ zu melden', () => {
    const ordner = tempOrdner('nogit');
    writeFileSync(join(ordner, 'README.md'), 'ohne Repo\n');
    assert.ok(!existsSync(join(ordner, '.git')));
    const { code, aus } = laufen(ordner);
    assert.equal(code, 2, aus);
    assert.match(aus, /kein Git-Repository/);
  });

  it('bricht über einer Blob-Grenze ab statt halbvoll zu prüfen', () => {
    const { code, aus } = laufen(geloescht, '--max-blobs', '1');
    assert.equal(code, 2, aus);
    assert.match(aus, /Grenze/);
  });

  it('ein leeres Repository ist keine bestandene Prüfung', () => {
    const ordner = tempOrdner('empty');
    imRepo(ordner, 'init', '-q', '--initial-branch=main', '.');
    const { code, aus } = laufen(ordner);
    assert.equal(code, 2, aus);
    assert.match(aus, /keine Blobs/);
  });
});
