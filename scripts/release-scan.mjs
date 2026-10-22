/**
 * Release-Scanner – zwei strikt getrennte Prüfungen (P0-B):
 *
 *   1. REPO-MODUS  `node scripts/release-scan.mjs`
 *      Prüft die Git-getrackten Dateien: Steht ein Geheimnis im Code? Ist
 *      etwas getrackt, das nicht ins Repository gehört? Das beantwortet die
 *      Frage nach dem COMMIT – nicht die nach dem Auslieferungspaket.
 *
 *   2. ARTEFAKT-MODUS  `node scripts/release-scan.mjs --artifact <pfad>`
 *      Prüft das finale Archiv (ZIP, tar.gz, tar) inhaltlich: Allowlist,
 *      Denylist, Pfad-Kanonik, Secret-Muster in den Dateiinhalten, Zip-Bomb-
 *      Limits. Siehe `artifact-scan.mjs`.
 *
 * Ein grüner Repo-Modus ersetzt den Artefakt-Modus NICHT und umgekehrt.
 * Die Meldung „bereit für eine Veröffentlichung“ fällt ausschließlich im
 * Artefakt-Modus für das konkret geprüfte Archiv.
 *
 * Exit-Codes:
 *   0 = geprüft und frei
 *   1 = Fundstelle(n)
 *   2 = nicht prüfbar (kein Git, unlesbares/kaputtes Archiv …)
 *      – „nicht prüfbar“ ist bewusst KEIN Erfolg.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';
import {
  BINARY_EXTENSIONS,
  repoUnwantedPatterns,
  artifactUnwantedPatterns,
  inhaltFindings,
  exampleWertePrüfen,
  istScannerQuelldatei,
} from './scan-rules.mjs';
import { scanArtifactFile, ladeManifest } from './artifact-scan.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Sammelt die Dateien, die Git kennt. Ohne Git bleibt nichts zu prüfen – der
 * Aufrufer merkt es am Exit-Code 2, statt dass eine leere Prüfung als Erfolg
 * durchgeht.
 */
const tracked = () => {
  try {
    const ausgabe = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return ausgabe.split('\0').filter(Boolean);
  } catch {
    console.error(
      'Hinweis: git ist nicht verfügbar – es wurde nichts geprüft.\n' +
        '        Der Repo-Scan prüft nur getrackte Dateien; für das finale\n' +
        '        Release-Artefakt gehört --artifact <pfad> verwendet.',
    );
    return null;
  }
};

/**
 * Release-Archive (*.tgz/*.tar.gz/*.tar/*.zip im Root) auf Geheimnis-Pfade
 * prüfen. Namen-Schnellprüfung – der Tiefgang kommt im --artifact-Modus.
 */
const scanArchiveNamen = () => {
  const funde = [];
  let eintraege = [];
  try {
    eintraege = readdirSync(ROOT);
  } catch {
    return funde;
  }
  for (const name of eintraege) {
    if (!/\.(tgz|tar\.gz|tar|zip)$/i.test(name)) continue;
    for (const { muster, grund } of artifactUnwantedPatterns()) {
      if (muster.test(name)) {
        funde.push({ art: 'Release-Archiv', pfad: name, grund });
        break;
      }
    }
    // Zusätzliche Pfadregeln wie im Repo-Modus:
    if (
      /(^|\/)\.env($|\.)/.test(name) ||
      /\.(sqlite(-wal|-shm)?|db|sql(\.gz)?|dump|pem|key|p12|pfx)$/i.test(name)
    )
      funde.push({
        art: 'Release-Archiv',
        pfad: name,
        grund: 'Geheimnis-Pfad im Release-Archiv',
      });
  }
  return funde;
};

/**
 * Dateien, die hier liegen, von Git aber ignoriert werden, und zu weit lesbar
 * sind. Kein Veröffentlichungsproblem – ein Rechnerproblem, deshalb Warnung.
 */
const lokaleWarnungen = () => {
  const warnungen = [];
  for (const ordner of ['data/secrets', 'data']) {
    const voll = join(ROOT, ordner);
    if (!existsSync(voll)) continue;
    try {
      const { mode } = statSync(voll);
      if (process.platform !== 'win32' && (mode & 0o077) !== 0)
        warnungen.push(
          `${ordner}/ ist für andere Benutzer lesbar (Modus ${(mode & 0o777).toString(8)})`,
        );
    } catch {
      /* nicht prüfbar */
    }
  }
  return warnungen;
};

const farbe = (text, code) =>
  process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;

/* ------------------------------ CLI --------------------------------- */

const argv = process.argv.slice(2);
const artifactIndex = argv.indexOf('--artifact');
const artifactPfad =
  artifactIndex >= 0 ? argv[artifactIndex + 1] : process.env.BOT_HUB_ARTIFACT;

if (artifactIndex >= 0 && !artifactPfad) {
  console.error('FEHLER: --artifact erwartet einen Dateipfad.');
  process.exit(2);
}

if (artifactPfad) {
  /* ----------------------- ARTEFAKT-MODUS ----------------------- */
  let manifest;
  try {
    manifest = ladeManifest(
      readFileSync(join(import.meta.dirname, 'release-manifest.json'), 'utf8'),
    );
  } catch (error) {
    console.error(`FEHLER: Release-Manifest unlesbar: ${error.message}`);
    process.exit(2);
  }
  const voll = resolve(ROOT, artifactPfad);
  if (!existsSync(voll)) {
    console.error(`FEHLER: Artefakt nicht gefunden: ${artifactPfad}`);
    process.exit(2);
  }
  const { status, findings, stats } = scanArtifactFile(voll, manifest);
  console.log(
    `Artefakt: ${voll}\nFormat: ${stats.format || '-'} · Einträge: ${stats.eintraege} · Dateien: ${stats.dateien}`,
  );
  if (status === 'ok') {
    console.log(
      farbe(
        `✓ ${stats.dateien} Artefakt-Dateien geprüft – ausschließlich freigegebene Inhalte, nichts Geheimnisverdächtiges.`,
        32,
      ),
    );
    console.log(
      farbe('  Bereit für eine Veröffentlichung DIESES Archivs.', 32),
    );
    process.exit(0);
  }
  if (status === 'unpruefbar') {
    console.error(
      farbe(
        '\n✗ Artefakt ist nicht vollständig prüfbar – keine Freigabe:\n',
        31,
      ),
    );
    for (const f of findings)
      console.error(`  ${farbe('UNPRÜFBAR', 31)}  ${f.pfad}\n      ${f.grund}`);
    process.exit(2);
  }
  console.error(
    farbe(`\n✗ ${findings.length} Fundstelle(n) im Release-Artefakt:\n`, 31),
  );
  for (const f of findings)
    console.error(`  ${farbe('FUND', 31)}  ${f.pfad}\n      ${f.grund}`);
  console.error(
    '\nDas Archiv ist nicht releasebereit. Erzeuge es aus einem sauberen\n' +
      'Staging-Verzeichnis (npm run release:build) und prüfen erneut.',
  );
  process.exit(1);
}

/* -------------------------- REPO-MODUS -------------------------- */

const fund = [];
for (const eintrag of scanArchiveNamen()) fund.push(eintrag);
const geprueft = tracked();

if (geprueft) {
  for (const rel of geprueft) {
    const pfad = join(ROOT, rel);
    let inhalt;
    try {
      inhalt = readFileSync(pfad, 'utf8');
    } catch {
      continue;
    }

    for (const regel of repoUnwantedPatterns()) {
      if (regel.muster.test(rel))
        fund.push({ art: 'unerwünschte Datei', pfad: rel, grund: regel.grund });
    }

    // Diese Dateien nennen die Muster selbst; sich selbst zu melden wäre
    // Unsinn – die zentrale Liste steht in scan-rules.mjs.
    if (istScannerQuelldatei(rel)) continue;

    // Verzeichnisse, die der Inhaltssuche nie gehören (binäre Endungen
    // wurden in BINARY_EXTENSIONS/TEXT_EXCLUDED gebündelt).
    const ext = extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    // Muster aus der geteilten Bibliothek (identisch zum Artefakt-Modus):
    for (const f of inhaltFindings(rel, inhalt))
      fund.push({ art: 'Geheimnis', pfad: rel, grund: f.grund });

    // `.env.example`: nur Platzhalter, niemals kopierte Testwerte.
    if (/(^|\/)\.env\.example$/.test(rel)) {
      for (const zeile of exampleWertePrüfen(inhalt))
        fund.push({
          art: 'unerwünschte Datei',
          pfad: rel,
          grund: `.env.example enthält Nicht-Platzhalter: ${zeile}`,
        });
    }
  }
}

for (const warnung of lokaleWarnungen())
  console.warn(farbe(`  ACHTUNG  ${warnung}`, 33));

if (geprueft === null) {
  console.error(
    farbe('✗ Repo-Scan nicht möglich (kein Git) – kein Erfolg, Exit 2.', 31),
  );
  process.exit(2);
}

if (fund.length === 0) {
  console.log(
    farbe(
      `✓ ${geprueft.length} getrackte Dateien geprüft, nichts gefunden.\n` +
        '  Hinweis: Das ist die Freigabe des REPOS, nicht eines Archivs.\n' +
        '  Für das Release-Artefakt immer zusätzlich: npm run release:build\n' +
        '  bzw. node scripts/release-scan.mjs --artifact <pfad>',
      32,
    ),
  );
  process.exit(0);
}

console.error(
  farbe(`\n✗ ${fund.length} Fundstelle(n) vor der Veröffentlichung:\n`, 31),
);
for (const eintrag of fund)
  console.error(
    `  ${farbe(eintrag.art, 31)}  ${eintrag.pfad}\n      ${eintrag.grund}`,
  );

console.error(
  '\nEin Geheimnis, das einmal committet wurde, bleibt in der Historie und ist\n' +
    'nicht durch Löschen der Datei weg. Es gehört rotiert: ein neuer Wert in\n' +
    'Discord, beim Datenbank-Benutzer, als Sitzungsschlüssel.\n' +
    'Siehe documents/sicherheit.md.',
);

process.exit(1);
