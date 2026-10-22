/**
 * Historien-Scan (P2-B/P2-C): das Verzeichnis, aber alle Stände.
 *
 * Der Repo-Scan in `release-scan.mjs` beantwortet die Frage nach dem aktuellen
 * Commit. Geheimnisse in der Historie sind damit nicht erledigt: eine Datei, die
 * einmal committet und später gelöscht wurde, ist für jeden mit Clone im Bestand.
 * Dieser Modus prüft deshalb jeden Blob, den die Historie kennt.
 *
 * Er ersetzt kein gepflegtes Tool (Gitleaks/TruffleHog) und er beweist keine
 * Secret-Freiheit – er findet, was die Muster kennen. Zwei Dinge leistet er
 * dafür verlässlich: er läuft ohne Netz und ohne Zusatzen, und er meldet
 * Funde OHNE Wert (Regel, Schlüssel, Zeile).
 *
 * Ein Fund in der Historie bedeutet: widerrufen bzw. rotieren, dann Historie
 * bereinigen, wenn sie verbreitet wurde. Nicht: Datei löschen und weiter.
 *
 * Aufruf:  node scripts/history-scan.mjs [--repo <pfad>]
 *          [--max-blobs <n>] [--max-size <bytes>]
 *
 * Exit-Codes: 0 geprüft und frei · 1 Fundstelle(n) · 2 nicht prüfbar
 */

import { execFileSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import process from 'node:process';
import {
  BINARY_EXTENSIONS,
  TEXT_EXCLUDED_EXTENSIONS,
  inhaltFindings,
  istScannerQuelldatei,
  repoUnwantedPatterns,
} from './scan-rules.mjs';

const MAX_GIT_PUFFER = 64 * 1024 * 1024;

const git = (args, cwd, input) =>
  execFileSync('git', args, {
    cwd,
    encoding: input === undefined ? 'utf8' : undefined,
    maxBuffer: MAX_GIT_PUFFER,
    input,
    stdio:
      input === undefined
        ? ['ignore', 'pipe', 'pipe']
        : ['pipe', 'pipe', 'pipe'],
  });

/**
 * Pfade zu Blob-OIDs – aus `ls-tree` je Commit, nicht aus `rev-list --objects`.
 * Das liefert für jeden Blob die Pfade, in denen er wirklich stand: eine
 * Näherung über die Objektliste würde Inhalte dem falschen Dateinamen zuordnen
 * und damit Funde erfinden oder verschwinden lassen.
 */
const objsDerHistorie = (repo) => {
  let commits = '';
  try {
    commits = git(['rev-list', '--all'], repo);
  } catch (error) {
    throw new Error(`git rev-list schlug fehl: ${error.message}`);
  }
  const commitListe = commits.split('\n').filter(Boolean);
  if (!commitListe.length) return [];
  const pfade = new Map();
  const pfadMerken = (oid, pfad) => {
    if (!oid || !pfad) return;
    let liste = pfade.get(oid);
    if (!liste) pfade.set(oid, (liste = []));
    if (liste.length < 4 && !liste.includes(pfad)) liste.push(pfad);
  };
  for (const commit of commitListe) {
    let baum = '';
    try {
      // -z: Einträge sind NUL-getrennt, Pfade mit Leerzeichen bleiben intakt.
      baum = git(
        [
          'ls-tree',
          '-r',
          '-z',
          '--format=%(objectname) %(objecttype) %(path)',
          commit,
        ],
        repo,
      );
    } catch {
      throw new Error(`git ls-tree schlug fehl (${commit.slice(0, 10)})`);
    }
    for (const eintrag of String(baum).split('\0')) {
      if (!eintrag) continue;
      const erste = eintrag.indexOf(' ');
      const zweite = eintrag.indexOf(' ', erste + 1);
      if (erste < 0 || zweite < 0) continue;
      const oid = eintrag.slice(0, erste);
      const typ = eintrag.slice(erste + 1, zweite);
      const pfad = eintrag.slice(zweite + 1);
      // Nur Blobs enthalten etwas, das man lesen kann.
      if (typ !== 'blob') continue;
      pfadMerken(oid, pfad);
    }
  }
  const oids = [...pfade.keys()];
  // `--batch-check` liest die OID-Liste über stdin. Ausgegeben wird pro
  // gelesener OID genau eine Zeile, und zwar mit der OID selbst – verifiziert
  // wird also über die Antwort, nicht über die Stellung in zwei Listen.
  const typAusgabe = git(
    [
      'cat-file',
      '--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)',
    ],
    repo,
    oids.map((oid) => `${oid}\n`).join(''),
  );
  const groessen = new Map();
  for (const zeile of String(typAusgabe).split('\n')) {
    const teile = zeile.split(' ');
    if (teile.length < 3) continue;
    const [oid, typ, groesse] = teile;
    if (typ === 'blob') groessen.set(oid, Number(groesse) || 0);
  }
  return [...pfade.entries()]
    .filter(([oid]) => groessen.has(oid))
    .map(([oid, pfadListe]) => ({
      oid,
      pfade: pfadListe,
      groesse: groessen.get(oid) ?? 0,
    }));
};

/** Ein Blob als Puffer; `null`, wenn er nicht lesbar ist. */
const blobPuffer = (repo, oid) => {
  try {
    return execFileSync('git', ['cat-file', 'blob', oid], {
      cwd: repo,
      maxBuffer: MAX_GIT_PUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
};

const istText = (pfad) => {
  const endung = `.${(
    /\.([A-Za-z0-9]+)$/.exec(pfad)?.[1] ?? ''
  ).toLowerCase()}`;
  return (
    !BINARY_EXTENSIONS.has(endung) && !TEXT_EXCLUDED_EXTENSIONS.has(endung)
  );
};

const main = () => {
  const argv = process.argv.slice(2);
  const option = (name, standard) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : standard;
  };
  const repo = resolve(option('--repo', process.cwd()));
  const maxBlobs = Number(option('--max-blobs', 200000)) || 200000;
  const maxSize = Number(option('--max-size', 1024 * 1024)) || 1024 * 1024;

  try {
    git(['rev-parse', '--git-dir'], repo);
  } catch {
    console.error(
      `FEHLER: ${repo} ist kein Git-Repository – es wurde nichts geprüft.\n` +
        '        „nicht prüfbar“ ist kein Erfolg.',
    );
    process.exit(2);
  }

  let blobs;
  try {
    blobs = objsDerHistorie(repo);
  } catch (error) {
    console.error(`FEHLER: Historie nicht lesbar: ${error.message}`);
    process.exit(2);
  }
  if (!blobs.length) {
    console.error(
      'FEHLER: die Historie enthält keine Blobs – nichts zu prüfen.\n' +
        '        Ein leeres Repository ist keine bestandene Prüfung.',
    );
    process.exit(2);
  }
  if (blobs.length > maxBlobs) {
    console.error(
      `FEHLER: ${blobs.length} Blobs in der Historie, Grenze ${maxBlobs}.\n` +
        '        Abbruch statt Teilkopie: eine halbe Prüfung sieht aus wie eine ganze.',
    );
    process.exit(2);
  }

  const muster = repoUnwantedPatterns();
  const funde = [];
  let uebersprungen = 0;
  let geprueft = 0;

  for (const blob of blobs) {
    // Ein Blob kann in mehreren Pfaden gestanden haben. Bewertet wird jeder
    // davon: derselbe Inhalt ist unter `docs/beispiel.md` harmlos und unter
    // `data/secrets/bot1.env` ein Fund.
    const pfade = blob.pfade.map((p) => String(p).replace(/\\/g, '/'));
    let inhalt = null;
    let inhaltGelesen = false;

    for (const rel of pfade) {
      for (const { muster: pfadMuster, grund } of muster) {
        if (pfadMuster.test(rel)) {
          funde.push({ pfad: rel, oid: blob.oid, grund: `Pfad: ${grund}` });
          break;
        }
      }
      if (
        /\.(sqlite(-wal|-shm)?|db|sql(\.gz)?|dump|pem|key|p12|pfx|kdbx)$/i.test(
          rel,
        )
      )
        funde.push({
          pfad: rel,
          oid: blob.oid,
          grund: 'Pfad: Datenbank oder Schlüsselmaterial in der Historie',
        });

      if (
        !istText(rel) ||
        blob.groesse > maxSize ||
        istScannerQuelldatei(rel)
      ) {
        uebersprungen += 1;
        continue;
      }
      if (!inhaltGelesen) {
        const puffer = blobPuffer(repo, blob.oid);
        inhaltGelesen = true;
        if (puffer === null) {
          // Ein unlesbarer Blob bleibt ein Loch in der Prüfung, kein „frei“.
          funde.push({
            pfad: rel,
            oid: blob.oid,
            grund: 'Blob nicht lesbar – die Prüfung ist hier nicht vollständig',
          });
          inhalt = undefined;
        } else if (puffer.includes(0)) {
          // \0 ist kein Text; ein Binary durch die Hintertür bringt nichts.
          inhalt = undefined;
        } else {
          inhalt = puffer.toString('utf8');
        }
      }
      if (inhalt === undefined || inhalt === null) {
        uebersprungen += 1;
        continue;
      }
      geprueft += 1;
      for (const finding of inhaltFindings(rel, inhalt))
        funde.push({ pfad: rel, oid: blob.oid, grund: finding.grund });
    }
  }

  console.log(
    `Historie: ${repo}\nBlobs: ${blobs.length} · Inhalt geprüft: ${geprueft} · übersprungen (Binär/Größe/Scanner): ${uebersprungen}`,
  );

  if (!funde.length) {
    console.log(
      `✓ ${geprueft} Blob-Inhalte aus der Historie geprüft, nichts gefunden.`,
    );
    console.log(
      '  Hinweis: Mustererkennung beweist keine Secret-Freiheit. Für die\n' +
        '  Historie gehört zusätzlich ein gepflegtes Scanner-Tool in die Kette.',
    );
    process.exit(0);
  }

  console.error(`\n✗ ${funde.length} Fundstelle(n) in der Historie:\n`);
  const bisher = new Set();
  for (const f of funde) {
    const schluessel = `${f.pfad}::${f.grund}`;
    if (bisher.has(schluessel)) continue;
    bisher.add(schluessel);
    console.error(`  ${f.pfad}  [${f.oid.slice(0, 10)}]`);
    console.error(`      ${f.grund}`);
  }
  console.error(
    '\nEin Fund in der Historie ist nicht durch Löschen erledigt: Werte gehören\n' +
      'widerrufen oder rotiert, bevor die Historie aufgeräumt wird.\n' +
      'Werte werden hier bewusst nicht ausgegeben.',
  );
  process.exit(1);
};

main();
