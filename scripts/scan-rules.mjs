/**
 * Gemeinsuche Muster für den Repo-Scanner (`release-scan.mjs`) und den
 * Artefakt-Scanner (`artifact-scan.mjs`). Ein Muster, das nur an EINER Stelle
 * steht, kann nicht zwischen den beiden Pfaden auseinanderlaufen.
 *
 * Die Muster sind bewusst eng gefasst. Jedes beschreibt etwas, das in diesem
 * Projekt tatsächlich ein Geheimnis wäre. Eine Suche nach `secret` im
 * Allgemeinen findet Variablennamen statt Werte.
 *
 * Wichtig für beide Scanner: eine Meldung nennt NIE den gefundenen Wert,
 * sondern nur Datei und Fundart.
 */

/** Dateiendungen ohne Textinhalt (werden nicht inhaltsgeprüft). */
export const BINARY_EXTENSIONS = new Set([
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
 * Ein SQL-Dump ist ein Export: er enthält die Daten *und* regelmäßig die
 * Anweisungen, mit denen sie wieder hereinkommen – inklusive `IDENTIFIED BY`.
 * `.sql` ist deshalb binär im Sinne von „nicht als Text prüfen“, aber als
 * Pfad streng verboten (UNWANTED).
 */
export const TEXT_EXCLUDED_EXTENSIONS = new Set([
  '.sql',
  '.dump',
  ...BINARY_EXTENSIONS,
]);

export const SECRET_PATTERNS = [
  {
    name: 'Discord-Bot-Token',
    muster: /[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/,
  },
  {
    // `?code=` oder `#code=` im Fragment – eine Autorisierungsantwort.
    name: 'OAuth-Code',
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
 * `<...>`, `example`, `changeme`, `${...}`, leer und reine X-Ketten zählen als
 * Platzhalter – die stehen in `.env.example` und in Beispielen. Anführungs-
 * zeichen sind nur Hülle und werden vorher abgenommen: sonst hielte ein
 * `'geheim'` für einen leeren Platzhalter und die Suche fände nichts.
 */
export const istPlatzhalter = (wert) => {
  const text = String(wert ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!text) return true;
  if (/^<.*>$/.test(text)) return true;
  if (/^\$\{.*\}$/.test(text)) return true;
  if (/^(…|\.\.\.)($|[^\d])/.test(text)) return true;
  // Prosa-Platzhalter: ein Wert, der AUSSchließlich aus einem bekannten
  // Hinweiswort und daran geketteten Teilen mit Bindestrich oder Unterstrich
  // besteht (`hier-client-secret`, `dein_bot_token`). Die Kette muss mit einem
  // Trenner beginnen – ein echtes Token, das zufällig mit „hier" anfängt, hat
  // keinen Trenner an dieser Stelle und fällt deshalb nicht durch dieses Raster.
  if (
    /^(hier|diese[sr]?|beispiel|platzhalter|dein[e]?|your|example|sample|placeholder|changeme|change-me|replace-me|todo|fixme)([_\-][a-z0-9]+)*$/i.test(
      text,
    )
  )
    return true;
  return /^(x{4,}|changeme|example|placeholder|dein|your|CHANGE_ME|TODO|FIXME)/i.test(
    text,
  );
};

export const ASSIGNMENT_PATTERNS = [
  {
    name: 'belegte Umgebungsvariable',
    // `[^\S\r\n]` statt `\s`: sonst greift das Muster über den
    // Zeilenumbruch und nimmt die nächste Zeile als Wert.
    muster:
      /^[^\S\r\n]*(?:export[^\S\r\n]+)?(DISCORD_CLIENT_SECRET|DISCORD_CLIENT_TOKEN|DISCORD_BOT_TOKEN|BOT_HUB_TOKEN|BOT_HUB_SESSION_SECRET|BOT_HUB_DB_PASSWORD|BOT_HUB_ADMIN_DB_PASSWORD|MYSQL_PASSWORD|MYSQL_ROOT_PASSWORD)[^\S\r\n]*=[^\S\r\n]*(.+)$/gm,
    istPlatzhalter,
  },
  {
    name: 'Datenbank-Passwort in SQL',
    // Gruppe 1 ist die Meldung, Gruppe 2 geht an `istPlatzhalter`. Die
    // Meldung nennt nie den Wert hinter `IDENTIFIED BY`.
    muster:
      /\b(IDENTIFIED\s+BY|SET\s+PASSWORD(?:\s+FOR\s+[^\s]+)?)\s*[:=]?\s*['"]([^'"]{8,})['"]/gi,
    istPlatzhalter: () => false,
  },
];

/** Zuweisungen, die in Dokumentation eine Konfiguration BESCHREIBEN (.md/.txt …). */
export const DOKUMENTATION_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
]);

/** Pfade, die nie in ein Release gehören. */
export const UNWANTED_PATTERNS = [
  { muster: /(^|\/)\.env$/, grund: 'enthält Geheimnisse' },
  { muster: /(^|\/)\.env\.(?!example($|\.))/, grund: 'enthält Geheimnisse' },
  {
    muster: /(^|\/)data(\/|$)/,
    grund: 'Bot-Speicher, Datenbank und Geheimnisse',
  },
  { muster: /(^|\/)data\/secrets(\/|$)/, grund: 'Bot-Geheimnisse' },
  { muster: /\.pem$/, grund: 'Schlüssel' },
  { muster: /\.key$/, grund: 'Schlüssel' },
  { muster: /\.p12$/, grund: 'Zertifikat mit Schlüssel' },
  { muster: /\.pfx$/, grund: 'Zertifikat mit Schlüssel' },
  { muster: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, grund: 'privater Schlüssel' },
  { muster: /\.sqlite(-wal|-shm)?$/, grund: 'Bot-Speicher' },
  { muster: /\.db$/, grund: 'Datenbank-Datei' },
  { muster: /\.sql(\.gz)?$/, grund: 'Datenbank-Export' },
  { muster: /\.dump$/, grund: 'Datenbank-Export' },
  { muster: /(^|\/)npm-debug\.log/, grund: 'Logdatei' },
  { muster: /(^|\/)\.DS_Store$/, grund: 'Artefakt des Dateimanagers' },
  {
    muster: /(^|\/)\.env\.bot-hub\.tmp/,
    grund: 'Rest eines abgebrochenen Secret-Schreibens',
  },
  // Rein strukturelle Ausschlüsse: für das ARTefakt hart (P0-C), im Repo-Modus
  // aber bewusst NICHT gemeldet – die Frage „was ist in Git getrackt?“ ist eine
  // andere als „was darf ins Auslieferungspaket?“. Der Artefakt-Scan erzwingt
  // beides über Allowlist UND diese Denylist.
  {
    muster: /(^|\/)bots(\/|$)/,
    grund: 'Bot-Workspaces und Laufzeitcode',
    nurArtefakt: true,
  },
  {
    muster: /(^|\/)\.git(\/|$)/,
    grund: 'Versionshistorie gehört nicht ins Release',
    nurArtefakt: true,
  },
  {
    muster: /(^|\/)node_modules(\/|$)/,
    grund: 'Dependencies werden vor Ort installiert',
    nurArtefakt: true,
  },
  {
    muster: /(^|\/)(?:\.venv|venv)(\/|$)/,
    grund: 'Python-Umgebung wird vor Ort angelegt',
    nurArtefakt: true,
  },
  {
    muster: /(^|\/)dist(\/|$)/,
    grund: 'Build-Ausgaben werden vor Ort erzeugt',
    nurArtefakt: true,
  },
  {
    muster: /(^|\/)\.idea(\/|$)/,
    grund: 'IDE-Konfiguration',
    nurArtefakt: true,
  },
  {
    muster: /(^|\/)\.vscode(\/|$)/,
    grund: 'IDE-Konfiguration',
    nurArtefakt: true,
  },
  { muster: /(^|\/)logs?(\/|$)/, grund: 'Logdateien', nurArtefakt: true },
  {
    muster: /(^|\/)\.startup(\/|$)/,
    grund: 'interner Testzustand',
    nurArtefakt: true,
  },
];

/** Nur die Geheimnis-/Laufzeit-Pfade – die der Repo-Modus prüft. */
export const repoUnwantedPatterns = () =>
  UNWANTED_PATTERNS.filter((r) => !r.nurArtefakt);

/** Alle Regeln – für den finalen Artefakt-Scan. */
export const artifactUnwantedPatterns = () => UNWANTED_PATTERNS;

/**
 * Meldet `NAME=WERT`-Zeilen einer `.env.example`, die nach echten Werten
 * aussehen. Prüft nur geheimnisartige Schlüsselnamen: `BOT_HUB_URL` oder
 * `DISCORD_OAUTH_URL` sind Konfiguration, kein Geheimnis – und ein Scanner,
 * der URLs meldet, wird bald überlesen.
 */
export const exampleWertePrüfen = (inhalt) => {
  const fehlend = [];
  for (const [index, zeile] of String(inhalt).split('\n').entries()) {
    const treffer =
      /^[^\S\r\n]*(?:export[^\S\r\n]+)?([A-Z][A-Z0-9_]*)[^\S\r\n]*=[^\S\r\n]*(.*)$/.exec(
        zeile,
      );
    if (!treffer) continue;
    if (!/SECRET|TOKEN|PASSW|KEY|CREDENTIAL|SALT/i.test(treffer[1])) continue;
    if (istPlatzhalter(treffer[2])) continue;
    // Wie ein echter Wert aussehen (lang, Zeichenmix) muss er schon.
    if (!/^[A-Za-z0-9+/_=.-]{16,}$/.test(treffer[2].trim())) continue;
    fehlend.push(`Zeile ${index + 1}: ${treffer[1]}`);
  }
  return fehlend;
};

/**
 * Dateien, die die Suchmuster selbst enthalten: Scanner-Quellen und die
 * Regex-Datei. Sie wegen ihrer eigenen Muster zu melden, wäre Unsinn – ein
 * Scanner, der sich selbst anzeigt, macht jede Prüfung stumpf. Die Pfade
 * werden trotzdem auf Pfad-/Allowlist-Regeln geprüft, nur der INHALT wird von
 * der Secret-Suche ausgenommen. Der Ausschluss ist exakt und whitelistet
 * keine beliebigen Pfade.
 */
const SCANNER_QUELLEN = new Set([
  'scripts/release-scan.mjs',
  'scripts/scan-rules.mjs',
  'scripts/artifact-scan.mjs',
]);
export const istScannerQuelldatei = (rel) =>
  SCANNER_QUELLEN.has(String(rel).replace(/\\/g, '/'));

/**
 * Prüft einen Textinhalt gegen alle Geheimnis-Muster. Rückgabe ist eine
 * Liste `{ grund }` – NIE der Fundwert selbst.
 */
export const inhaltFindings = (relPath, text) => {
  const funde = [];
  for (const { name, muster } of SECRET_PATTERNS) {
    muster.lastIndex = 0;
    const treffer = muster.exec(text);
    if (treffer)
      funde.push({
        grund: `${name} (Zeile ${text.slice(0, treffer.index).split('\n').length})`,
      });
  }
  const ext = /\.([A-Za-z0-9]+)$/.exec(relPath)?.[1]?.toLowerCase() ?? '';
  if (!DOKUMENTATION_EXTENSIONS.has(`.${ext}`)) {
    for (const {
      name,
      muster,
      istPlatzhalter: platzhalter,
    } of ASSIGNMENT_PATTERNS) {
      muster.lastIndex = 0;
      let treffer;
      while ((treffer = muster.exec(text))) {
        if (platzhalter(treffer[2])) continue;
        funde.push({
          grund: `${name}: ${treffer[1]} (Zeile ${text.slice(0, treffer.index).split('\n').length})`,
        });
      }
    }
  }
  return funde;
};
