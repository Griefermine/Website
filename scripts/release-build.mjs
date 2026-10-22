/**
 * P0-C: Reproduzierbares Release aus einem sauberen Staging-Verzeichnis.
 *
 * Nie das Entwicklerarbeitsverzeichnis zippen – sonst landen `.env`,
 * `data/`-Laufzeitzustand, Bot-Workspaces, `.git` und `node_modules` im
 * Paket, wie im Audit geschehen. Dieser Ablauf:
 *
 *   1. Frisches temporäres Staging-Verzeichnis anlegen.
 *   2. Ausschließlich Dateien gemäß Allowlist (`release-manifest.json`)
 *      kopieren – Unbekanntes kommt gar nicht erst hinein.
 *   3. `.env.example` vor dem Packen auf Platzhalterfreiheit prüfen.
 *   4. Archiv NUR aus dem Staging-Verzeichnis erzeugen (tar.gz).
 *   5. Das tatsächlich erzeugte Archiv unabhängig gegen den Artefakt-Scanner
 *      prüfen – die Freigabe bezieht sich auf das fertige Paket.
 *
 * Ausgabe: Pfad, SHA-256, Dateianzahl und Scan-Ergebnis. Exit 1 bei Funden,
 * Exit 2 wenn irgendetwas nicht geprüft werden konnte.
 *
 * Aufruf: `npm run release:build` – optional `--out <pfad>`.
 */

import { execFileSync, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  globToRegExp,
  ladeManifest,
  scanArtifactFile,
} from './artifact-scan.mjs';
import { exampleWertePrüfen, UNWANTED_PATTERNS } from './scan-rules.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const MANIFEST = ladeManifest(
  readFileSync(join(import.meta.dirname, 'release-manifest.json'), 'utf8'),
);

/** Alle Dateien des Arbeitsverzeichnisses, ohne Ausschlussverzeichnisse. */
const DATEIEN = [
  'node_modules',
  '.git',
  'dist',
  'data',
  'bots',
  '.vite',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'release',
];

const alleDateien = (basis, relativ = '') => {
  const out = [];
  const ordner = join(basis, relativ);
  let eintraege = [];
  try {
    eintraege = readdirSync(ordner, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const eintrag of eintraege) {
    const rel = relativ ? `${relativ}/${eintrag.name}` : eintrag.name;
    if (!relativ && DATEIEN.includes(eintrag.name)) continue;
    if (eintrag.isSymbolicLink()) continue; // Symlinks wandern nie ins Release
    if (eintrag.isDirectory()) out.push(...alleDateien(basis, rel));
    else if (eintrag.isFile()) out.push(rel);
  }
  return out;
};

const triftAllowlist = (rel) =>
  MANIFEST.allow.some((glob) => globToRegExp(glob).test(rel));

// Lokale Laufzeit-Zustände (z. B. test/.startup/) sind keine Release-Kandidaten,
// auch wenn ihr Pfad musternd unter `test/**` fiele. exclude vor allow.
const triftExclude = (rel) =>
  (MANIFEST.exclude ?? []).some((glob) => globToRegExp(glob).test(rel));

const main = async () => {
  const outIndex = process.argv.indexOf('--out');
  const zielPfad = resolve(
    ROOT,
    outIndex >= 0 && process.argv[outIndex + 1]
      ? process.argv[outIndex + 1]
      : 'release/bot-hub-release.tar.gz',
  );
  const version = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ).version;

  const dateien = alleDateien(ROOT).filter(
    (rel) => triftAllowlist(rel) && !triftExclude(rel),
  );
  if (!dateien.length) {
    console.error('FEHLER: Allowlist hat keine einzige Datei getroffen.');
    return 2;
  }

  // Harte Denylist gegen den finale Datei-Liste – doppelte Sicherheit.
  const blockiert = [];
  for (const rel of dateien)
    for (const { muster, grund } of UNWANTED_PATTERNS)
      if (muster.test(rel)) blockiert.push({ rel, grund });
  if (blockiert.length) {
    for (const { rel, grund } of blockiert)
      console.error(`FEHLER: Allowlist-Lücke – ${rel}: ${grund}`);
    return 1;
  }

  // `.env.example` nur mit Platzhaltern.
  const beispiel = join(ROOT, '.env.example');
  if (existsSync(beispiel)) {
    const fehlend = exampleWertePrüfen(readFileSync(beispiel, 'utf8'));
    if (fehlend.length) {
      for (const zeile of fehlend)
        console.error(
          `FEHLER: .env.example enthält einen echten Wert (${zeile}) – vor dem Release durch Platzhalter ersetzen.`,
        );
      return 1;
    }
  }

  const staging = mkdtempSync(join(tmpdir(), 'bot-hub-release-'));
  const wurzel = join(staging, `bot-hub-${version}`);
  try {
    for (const rel of dateien) {
      const quelle = join(ROOT, rel);
      // Symlink-Check pro Datei (lstat): eine verkettete Datei ins eigene
      // data/ würde sonst als harmlose Datei durchgehen.
      if (lstatSync(quelle).isSymbolicLink()) {
        console.error(`FEHLER: Symlink im Release nicht erlaubt: ${rel}`);
        return 1;
      }
      const ziel = join(wurzel, rel);
      mkdirSync(dirname(ziel), { recursive: true, mode: 0o700 });
      copyFileSync(quelle, ziel);
    }
    mkdirSync(dirname(zielPfad), { recursive: true, mode: 0o700 });
    // `tar` aus dem Staging-Verzeichnis: absolute Pfade und Arbeits-
    // verzeichnis-Specs des Hosts tauchen so nicht im Archiv auf.
    // --sort/--mtime/--owner: reproduzierbares Archiv ohne Host-Metadaten.
    execFileSync(
      'tar',
      [
        '--sort=name',
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '--format',
        'gnu',
        '-czf',
        zielPfad,
        `bot-hub-${version}`,
      ],
      { cwd: staging, stdio: ['ignore', 'ignore', 'inherit'] },
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const puffer = readFileSync(zielPfad);
  const sha256 = createHash('sha256').update(puffer).digest('hex');

  // Unabhängige Prüfung DES ERZEUGTEN Archivs.
  const { status, findings, stats } = scanArtifactFile(zielPfad, MANIFEST);

  console.log(`Release-Artefakt: ${zielPfad}`);
  console.log(`Version:          ${version}`);
  console.log(`SHA-256:          ${sha256}`);
  console.log(
    `Größe:            ${puffer.length} Byte · Dateien im Archiv: ${stats.dateien}`,
  );

  if (status === 'ok') {
    console.log('Scan:             FREIGEGEBEN (Artefakt-Modus)');
    return 0;
  }
  console.error('Scan:             FEHLERHAFT – keine Freigabe:');
  for (const f of findings) console.error(`  ${f.pfad}: ${f.grund}`);
  return status === 'unpruefbar' ? 2 : 1;
};

process.exitCode = await main();
