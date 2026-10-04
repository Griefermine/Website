/**
 * Prüft, was vor einer Veröffentlichung **in den Commit** gelangen würde.
 *
 * Zwei Fragen, beide beantwortet ohne Netz und ohne Abhängigkeiten:
 *
 *   1. Steht ein Geheimnis im Code? Gesucht werden nur Muster, die in diesem
 *      Projekt etwas bedeuten – ein Discord-Token, ein Bot-Hub-Token, ein
 *      Session-Geheimnis, ein privater Schlüssel, eine `.env` mit Werten.
 *      Allgemeine Muster wie `password` erzeugen sonst nur Lärm.
 *
 *   2. Ist etwas getrackt, was nicht hineingehört? `data/` (Bot-Speicher,
 *      Geheimnisse), `.env`, Zertifikate, Schlüssel.
 *
 * Geprüft wird bewusst nur, was Git kennt. Eine `.env` im Arbeitsverzeichnis ist
 * kein Fund – sie ist über `.gitignore` ausgeschlossen und wird nie committet.
 * Sie zu melden hieße, immer dasselbe zu melden und damit nichts mehr.
 *
 * Getrennt davon gibt es eine Warnung für Dateien, die auf diesem Rechner liegen
 * und zu weit lesbar sind. Das ist kein Veröffentlichungsproblem, sondern ein
 * Rechnerproblem – und ein anderes.
 *
 * Aufruf: `node scripts/release-scan.mjs` – bricht mit Exit-Code 1 ab, wenn
 * etwas gefunden wird, damit er in eine Pipeline gehört.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');

/** Verzeichnisse, die nie durchsucht werden. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.vite',
  'target',
  'build',
  '__pycache__',
  '.venv',
  'venv',
]);

/** Dateiendungen ohne Textinhalt. */
const BINARY = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.avif',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.sqlite',
  '.sqlite3',
  '.db',
  // Ein SQL-Dump ist ein Export: er enthält die Daten *und* regelmäßig die
  // Anweisungen, mit denen sie wieder hereinkommen – inklusive
  // `IDENTIFIED BY`. Wer einen Dump committet, gibt damit die Datenbank preis.
  '.sql',
  '.sql.gz',
  '.dump',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.jar',
  '.mp3',
  '.mp4',
  '.webm',
  '.mov',
  '.wav',
  '.class',
]);

/**
 * Geheimnisse in Textdateien.
 *
 * Bewusst eng gefasst. Jedes Muster beschreibt etwas, das in diesem Projekt
 * tatsächlich ein Geheimnis wäre – ein Discord-Bot-Token beginnt mit einem
 * festen Präfix, ein Hub-Token ist ein 48-stelliger Hex-Wert, und so weiter.
 * Eine Suche nach `secret` im Allgemeinen findet Variablennamen statt Werte.
 */
const SECRET_PATTERNS = [
  {
    name: 'Discord-Bot-Token',
    muster: /[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/,
  },
  {
    name: 'OAuth-Code',
    ///code# oder /code@ im Fragmente – eine Autorisierungsantwort im Protokoll.
    muster: /[?&](?:code)=[A-Za-z0-9_-]{20,}/,
  },
  {
    name: 'privater Schlüssel',
    muster: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: 'AWS-Zugriffsschlüssel',
    muster: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'GitHub-Token',
    muster: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  },
  {
    name: 'Slack-Token',
    muster: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    name: 'Google-API-Schlüssel',
    muster: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    name: 'Zertifikat mit Schlüssel',
    muster: /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/,
  },
];

/**
 * Zuweisungen, bei denen der Wert nicht als Platzhalter aussieht.
 *
 * `<...>`, `example`, `changeme`, `${...}`, leer und Zeichenketten aus Nullen
 * zählen als Platzhalter – die stehen in `.env.example` und in Beispielen.
 */
/**
 * Zuweisungen, bei denen der Wert nicht als Platzhalter aussieht.
 *
 * `<...>`, `example`, `changeme`, `${...}` und ein leerer Wert zählen als
 * Platzhalter – die stehen in `.env.example` und in Beispielen. Anführungszeichen
 * um einen Wert sind nur Hülle und werden vorher abgenommen: sonst hielte ein
 * `'geheim'` für einen leeren Platzhalter und die Suche fände nichts.
 */
const istPlatzhalter = (wert) => {
  const text = String(wert ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!text) return true;
  if (/^<.*>$/.test(text)) return true;
  if (/^\$\{.*\}$/.test(text)) return true;
  // Auslassungspunkte und das typografische Zeichen stehen für "hier steht dein
  // eigener Wert". Sie können allein stehen (`TOKEN=…`) oder einen Befehl
  // einleiten (`TOKEN=… python3 bot.py`) – beides ist eine Anleitung, kein Wert.
  if (/^(…|\.\.\.)($|[^\d])/.test(text)) return true;
  return /^(x{4,}|changeme|example|placeholder|dein|your|CHANGE_ME|TODO|FIXME)/i.test(
    text,
  );
};

const ASSIGNMENT_PATTERNS = [
  {
    name: 'belegte Umgebungsvariable',
    // `\s` wäre falsch: es greift über den Zeilenumbruch hinweg und nähme dann
    // die nächste Zeile als Wert. `[^\S\r\n]` ist nur horizontaler Whitespace.
    muster:
      /^[^\S\r\n]*(?:export[^\S\r\n]+)?(DISCORD_CLIENT_SECRET|DISCORD_BOT_TOKEN|BOT_HUB_TOKEN|BOT_HUB_SESSION_SECRET|BOT_HUB_DB_PASSWORD|BOT_HUB_ADMIN_DB_PASSWORD|MYSQL_PASSWORD|MYSQL_ROOT_PASSWORD)[^\S\r\n]*=[^\S\r\n]*(.+)$/gm,
    istPlatzhalter,
  },
  {
    name: 'Datenbank-Passwort in SQL',
    // `CREATE USER … IDENTIFIED BY` und `SET PASSWORD` stehen in jedem Dump,
    // den mysqldump mit `--all-databases` oder `--users` erzeugt. Der Wert ist
    // wörtlich derselbe, mit dem sich jemand anmelden kann.
    //
    // Zwei Gruppen, weil die Auswertung an einer Stelle für alle Muster gilt:
    // Gruppe 1 landet in der Meldung, Gruppe 2 geht an `istPlatzhalter`.
    // Wichtig ist die Reihenfolge – die Meldung nennt nur `IDENTIFIED BY`,
    // nie den Wert dahinter. Ein Scanner, der beim Treffer das Passwort
    // ausgibt, kopiert es in die Konsole und damit in jedes Log, in dem die
    // Ausgabe landet.
    muster:
      /\b(IDENTIFIED\s+BY|SET\s+PASSWORD(?:\s+FOR\s+[^\s]+)?)\s*[:=]?\s*['"]([^'"]{8,})['"]/gi,
    // Ein Wert in Anführungszeichen hinter diesen Stichwörtern ist immer
    // wörtlich gemeint – es gibt dort nichts zu erraten.
    istPlatzhalter: () => false,
  },
];

/**
 * Dateiendungen, in denen eine Zuweisung kein Geheimnis belegt.
 *
 * `NAME="…"` in einer Anleitung beschreibt eine Konfiguration, es ist kein
 * Wert. Die Formen ohne Raten – Discord-Token, Schlüssel, Cloud-Schlüssel –
 * gelten trotzdem überall, auch in Dokumentation.
 */
const DOKUMENTATION = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc']);

/**
 * Pfade, die nicht im Repository gehören.
 *
 * Abgeglichen wird gegen das Git-Verzeichnis, nicht gegen den Namen: `logs`
 * wird in `.gitignore` genannt, taucht aber als Ordner im Arbeitsverzeichnis
 * auf, ohne dass jemand ihn je committet hat.
 */
const UNWANTED_PATTERNS = [
  { muster: /^\.env$/, grund: 'enthält Geheimnisse' },
  { muster: /^\.env\.(?!example)/, grund: 'enthält Geheimnisse' },
  { muster: /^data\//, grund: 'Bot-Speicher und Geheimnisse' },
  { muster: /^data\/secrets\//, grund: 'Bot-Geheimnisse' },
  { muster: /(^|\/)\.env\.local$/, grund: 'lokale Konfiguration' },
  { muster: /\.pem$/, grund: 'Schlüssel' },
  { muster: /\.key$/, grund: 'Schlüssel' },
  { muster: /\.p12$/, grund: 'Zertifikat mit Schlüssel' },
  { muster: /\.pfx$/, grund: 'Zertifikat mit Schlüssel' },
  { muster: /(^|\/)\.env\..*\.local$/, grund: 'lokale Konfiguration' },
  { muster: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, grund: 'privater Schlüssel' },
  { muster: /\.sqlite(-wal|-shm)?$/, grund: 'Bot-Speicher' },
  { muster: /\.sql(\.gz)?$/, grund: 'Datenbank-Export' },
  { muster: /\.dump$/, grund: 'Datenbank-Export' },
  { muster: /(^|\/)npm-debug\.log/, grund: 'Logdatei' },
];

/** Sammelt die Dateien, die Git kennt – also die zur Veröffentlichung kämen. */
const tracked = () => {
  try {
    const ausgabe = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return ausgabe.split('\0').filter(Boolean);
  } catch {
    // Ohne Git (kein Repository, kein Binary) bleibt nichts zu prüfen. Der
    // Aufrufer merkt es an, statt dass hier eine leere Prüfung als Erfolg
    // durchgeht.
    console.error(
      'Hinweis: git ist nicht verfügbar – es wurde nichts geprüft.\n' +
        '        Der Scan prüft nur getrackte Dateien.',
    );
    return null;
  }
};

/**
 * Dateien, die hier liegen, von Git aber ignoriert werden, und zu weit lesbar
 * sind. Kein Veröffentlichungsproblem – ein Rechnerproblem, deshalb nur eine
 * Warnung.
 */
const lokaleWarnungen = () => {
  const warnungen = [];
  for (const ordner of ['data/secrets']) {
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

const fund = [];
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

    for (const regel of UNWANTED_PATTERNS) {
      if (regel.muster.test(rel))
        fund.push({
          art: 'unerwünschte Datei',
          pfad: rel,
          grund: regel.grund,
        });
    }

    // Diese Datei nennt die Muster selbst; sich selbst zu melden wäre Unsinn.
    if (rel === 'scripts/release-scan.mjs') continue;

    for (const { name, muster } of SECRET_PATTERNS) {
      muster.lastIndex = 0;
      const treffer = muster.exec(inhalt);
      if (treffer)
        fund.push({
          art: 'Geheimnis',
          pfad: rel,
          grund: `${name} (Zeile ${inhalt.slice(0, treffer.index).split('\n').length})`,
          // Der Wert selbst wird nie ausgegeben – nur, wo er steht.
        });
    }

    for (const { name, muster, istPlatzhalter } of ASSIGNMENT_PATTERNS) {
      // In Dokumentation beschreibt eine Zuweisung eine Konfiguration.
      if (DOKUMENTATION.has(extname(rel).toLowerCase())) continue;
      muster.lastIndex = 0;
      let treffer;
      while ((treffer = muster.exec(inhalt))) {
        if (istPlatzhalter(treffer[2])) continue;
        fund.push({
          art: 'Geheimnis',
          pfad: rel,
          grund: `${name}: ${treffer[1]} (Zeile ${inhalt.slice(0, treffer.index).split('\n').length})`,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ */

const farbe = (text, code) =>
  process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;

for (const warnung of lokaleWarnungen())
  console.warn(farbe(`  ACHTUNG  ${warnung}`, 33));

if (geprueft === null) process.exit(2);

if (fund.length === 0) {
  console.log(
    farbe(
      `✓ ${geprueft.length} getrackte Dateien geprüft, nichts gefunden – bereit für eine Veröffentlichung`,
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
