/**
 * Produktions-Preflight und Bind-Auflösung – als eigenes Modul, damit die
 * Regeln prüfbar sind, ohne `server/index.js` zu importieren (das lauscht
 * beim Import und startet die Welt). Der gleiche Code entscheidet im Test
 * genau wie im Betrieb.
 */

import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const LOOPBACK_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

/**
 * P1-D: Woran bindet der Hub?
 *
 * Sicherer Default in ALLEN Modi ist Loopback. Ein Hub, der ohne ausdrückliche
 * Ansage auf `0.0.0.0` lauscht, ist im Entwicklungsbetrieb dasselbe Risiko wie
 * in Produktion: jede Person im Netz sieht Anmeldung und Panel. Wer nach außen
 * binden will, setzt `HOST` ausdrücklich – außerhalb von Tests mit Warnung,
 * in Produktion ist eine nicht-lokale Adresse generell abgelehnt (davor
 * gehört ein TLS-Reverse-Proxy auf 127.0.0.1).
 */
export const resolveBindHost = (env = process.env) => {
  const explicit = String(env.HOST ?? '').trim();
  const host = explicit || '127.0.0.1';
  const production = env.NODE_ENV === 'production';
  const testMode = env.NODE_ENV === 'test' || env.BOT_HUB_TEST_MODE === '1';
  const errors = [];
  const warnings = [];
  if (production && !LOOPBACK_HOSTS.has(host)) {
    errors.push(
      `Produktionsbetrieb darf nicht auf ${host} lauschen. Der Hub verwendet ` +
        'HTTP und muss hinter einem TLS-Reverse-Proxy nur auf 127.0.0.1 ' +
        'erreichbar sein (HOST=127.0.0.1).',
    );
  }
  if (!production && !testMode && explicit && !LOOPBACK_HOSTS.has(host)) {
    warnings.push(
      `Hub lauscht auf ${host} – jede/r im Netzwerk kann diese Oberfläche ` +
        'erreichen. Nur in vertrauenswürdigen Netzen betreiben.',
    );
  }
  return { host, errors, warnings };
};

/**
 * Startup-Selbstprüfung: `errors` verhindern den Start, `warnings` nicht.
 *
 * Wichtig für die Pfadprüfungen: gemessen wird am Projekt-Root, nicht am
 * aktuellen Arbeitsverzeichnis – eine Prüfung, die das falsche Verzeichnis
 * ansieht, hält eine Fehlkonfiguration für eine richtige.
 */
export const collectSecurityFindings = ({
  env = process.env,
  projectRoot = resolve(env.BOT_DASHBOARD_ROOT || process.cwd()),
  facts = { hubRunsAsRoot: false, unpinnedImages: [], digestRequired: false },
  exists = existsSync,
  read = readFileSync,
  stat = statSync,
  lstat = lstatSync,
  aktuelleBenutzerkennung = typeof process.getuid === 'function'
    ? process.getuid()
    : undefined,
} = {}) => {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';

  // 1) Der Hub darf in Produktion nicht als root laufen. Sonst bekommen auch
  //    die Container root, und die Trennung zwischen fremdem Bot-Code und dem
  //    Host trägt nicht mehr.
  if (production && facts.hubRunsAsRoot) {
    errors.push(
      'Der Hub läuft als root. Container würden dann ebenfalls als root laufen; bitte einen eigenen Benutzer anlegen und den Hub unter diesem starten.',
    );
  }

  // 2) Images ohne Digest sind jederzeit jemand anderes umschreibbar.
  if (facts.unpinnedImages.length > 0) {
    const liste = facts.unpinnedImages
      .map((item) => `${item.language}=${item.reference}`)
      .join(', ');
    const text =
      `Container-Images sind nicht per Digest festgelegt: ${liste}. ` +
      'Ein Tag kann auf ein anderes Image zeigen, ohne dass es hier etwas ändert.';
    if (facts.digestRequired) {
      errors.push(
        `${text} BOT_HUB_REQUIRE_IMAGE_DIGEST verlangt Digests – bitte ` +
          'BOT_HUB_CONTAINER_IMAGES mit Digest-Referenzen setzen.',
      );
    } else if (production) {
      errors.push(
        `${text} In Produktion sind Digest-gepinnte Images Pflicht – bitte ` +
          'BOT_HUB_CONTAINER_IMAGES mit Digest-Referenzen setzen.',
      );
    }
  }

  // 3) Der Docker-Socket ist der Weg aus dem Host heraus. Er muss da sein,
  //    damit Container laufen – gemountet wird er dennoch nicht.
  if (exists('/var/run/docker.sock')) {
    warnings.push(
      'Docker Socket vorhanden: er darf nicht in einen Bot-Container gemountet werden, sonst steuert der Bot den Host. Der Zugang zum Daemon entspricht faktisch Host-Root – siehe documents/sicherheit.md.',
    );
  }

  // 4) `.env` im Projekt-Root: hier stehen im Betrieb keine Geheimnisse, die
  //    liegen in `data/secrets/`. Eine belegte Datei ist ein Fund, kein Vorwurf.
  const envPath = join(projectRoot, '.env');
  if (exists(envPath)) {
    try {
      const content = read(envPath, 'utf8');
      const filled = [
        /^\s*DISCORD_CLIENT_SECRET\s*=\s*\S+/m,
        /^\s*DISCORD_BOT_TOKEN\s*=\s*\S+/m,
        /^\s*BOT_HUB_TOKEN\s*=\s*\S+/m,
        /^\s*BOT_HUB_SESSION_SECRET\s*=\s*\S+/m,
      ].some((muster) => muster.test(content));
      if (filled)
        warnings.push(
          '.env enthält belegte Geheimnisse. Bitte nach data/secrets/ umziehen und die Werte hier leeren – eine Datei im Projekt-Root landet leicht im Git.',
        );
    } catch {
      warnings.push(
        '.env ist vorhanden, aber nicht lesbar – bitte Rechte prüfen.',
      );
    }
  }

  // 5) P1-A: Private Laufzeitdaten müssen für andere Benutzer gesperrt sein.
  //    In Produktion ist ein offenes `data/secrets/` oder `data/` ein
  //    Start-Abbruch, kein Hinweis: Secret-Dateien (0600) nützen nichts, wenn
  //    das Verzeichnis weltweit lesbar ist. Geprüft wird auch der Elternpfad
  //    `data/`, denn `data/db` und `data/bots.json` liegen direkt dort.
  const runtimeDirs = [
    { rel: 'data/secrets', hard: true, label: 'data/secrets/' },
    { rel: 'data/db', hard: false, label: 'data/db/' },
    { rel: 'data', hard: false, label: 'data/' },
  ];
  for (const { rel, hard, label } of runtimeDirs) {
    const voll = join(projectRoot, rel);
    if (!exists(voll)) {
      if (production && rel === 'data/secrets')
        warnings.push('data/secrets/ fehlt und wird erst bei Bedarf angelegt.');
      continue;
    }
    try {
      // Ein Symlink anstelle des Verzeichnisses verschiebt die Prüfung: gemessen
      // würde das Ziel, geschützt werden sollte der Pfad.
      const verknuepfung = lstat(voll);
      if (verknuepfung.isSymbolicLink?.()) {
        const text =
          `${label} ist ein Symlink – Secrets gehören in ein echtes ` +
          'Verzeichnis im Projekt-Root, nicht in ein Verweisziel.';
        if (production && hard) errors.push(text);
        else warnings.push(text);
        continue;
      }
      const { mode, uid } = stat(voll);
      if (process.platform === 'win32') continue;
      // Besitzer: eine Datei, die jemand anderer gehört, ist es auch, die sie
      // ändern kann – unabhängig davon, welche Bits gesetzt sind.
      if (
        aktuelleBenutzerkennung !== undefined &&
        typeof uid === 'number' &&
        uid !== aktuelleBenutzerkennung
      ) {
        const text =
          `${label} gehört nicht dem Benutzer des Hub-Prozesses ` +
          `(uid ${uid}). Bitte Besitz auf den Hub-Benutzer übertragen.`;
        if (production && hard) errors.push(text);
        else warnings.push(text);
      }
      const otherReadable = (mode & 0o077) !== 0;
      // Gruppen-Schreibrecht auf data/secrets wäre der Einstieg für jeden
      // Benutzer in der Hub-Gruppe – in Produktion ebenfalls hart.
      const groupWritable = hard && (mode & 0o020) !== 0;
      if (otherReadable || groupWritable) {
        const gründe = [];
        if (otherReadable) gründe.push('für andere Benutzer lesbar');
        if (groupWritable) gründe.push('für die Gruppe schreibbar');
        const text =
          `${label} ist ${gründe.join(' und ')} (Modus ` +
          `${(mode & 0o777).toString(8)}). Bitte auf 700 setzen.`;
        if (production && hard) errors.push(text);
        else warnings.push(text);
      }
    } catch {
      warnings.push(`${label} ist nicht prüfbar – bitte Rechte kontrollieren.`);
    }
  }

  return { errors, warnings };
};
