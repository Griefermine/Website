/**
 * Produktions-Preflight und Bind-Auflösung – als eigenes Modul, damit die
 * Regeln prüfbar sind, ohne `server/index.js` zu importieren (das lauscht
 * beim Import und startet die Welt). Der gleiche Code entscheidet im Test
 * genau wie im Betrieb.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDotenv } from './util.js';
import { isVaultValue, vaultStatus } from './vault.js';

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
  list = readdirSync,
  secretSchutz = undefined,
  aktuelleBenutzerkennung = typeof process.getuid === 'function'
    ? process.getuid()
    : undefined,
} = {}) => {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === 'production';
  /* Schutz-Status wird hier einmal erhoben und sowohl für die Vorprüfung als
   * auch für die Laufzeit-Meldung verwendet; `vaultStatus()` wirft nicht. */
  const schutz =
    typeof secretSchutz === 'function'
      ? secretSchutz(projectRoot, env)
      : (secretSchutz ?? vaultStatus(projectRoot, env));

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

  // 6) Maßnahme 46 (Auftrag 5.1): Verschlüsselung im Ruhezustand darf in
  //    Produktion nicht unbemerkt ausbleiben.
  //
  //    Der gefährliche Fall ist nicht „Betreiber hat an den Schlüssel nicht
  //    gedacht“, sondern „Schlüssel ist gesetzt, aber unbrauchbar“: Die
  //    root-eigene Datei, die der Hub-Benutzer nicht lesen darf, ließ
  //    `vaultEnabled()` bisher still auf Klartext zurückschreiben – mitten im
  //    Betrieb, ohne jede Meldung. Deshalb:
  //      - gesetzter, aber unbrauchbarer Schlüssel  -> Abbruch ( egal wieviele
  //        Secrets schon offen sind: die Absicht war Verschlüsselung),
  //      - kein Schlüssel, aber offene Geheimnisse  -> Abbruch,
  //      - kein Schlüssel, noch nichts offen        -> Warnung (frische
  //        Installation, gleich beim ersten Bot würde es aber offen).
  if (production && !schutz.aktiv) {
    let offen = 0;
    const verzeichnis = join(projectRoot, 'data', 'secrets');
    try {
      if (exists(verzeichnis)) {
        for (const name of list(verzeichnis)) {
          if (!String(name).endsWith('.env')) continue;
          try {
            const werte = parseDotenv(read(join(verzeichnis, name), 'utf8'));
            for (const [schluessel, wert] of Object.entries(werte)) {
              if (String(wert ?? '').trim() === '' || isVaultValue(wert))
                continue;
              // Der leere Platzhalter eines gelöschten Werts ist keins.
              if (String(schluessel).trim() === '') continue;
              offen += 1;
            }
          } catch {
            // Nicht lesbar: lieber wie „offen“ behandeln, als zu schweigen.
            offen += 1;
          }
        }
      }
    } catch {
      warnings.push(
        'data/secrets/ ist nicht aufzählbar – Vault-Zustand nicht prüfbar.',
      );
    }
    const text = schutz.konfiguriert
      ? `Vault-Key ist konfiguriert, aber nicht verwertbar: ${schutz.grund} ` +
        'In Produktion werden Geheimnisse sonst unverschlüsselt gespeichert – ' +
        'Bitte Leserecht (z. B. 0640 root:<Hub-Benutzer>) und Inhalt ' +
        '(64-stelliges Hex) prüfen.'
      : offen > 0
        ? `data/secrets/ enthält ${offen} unverschlüsselte Geheimnis-Werte und ` +
          'es ist kein Vault-Key vorhanden. Bitte BOT_HUB_KEY_FILE setzen ' +
          '(deploy-full.sh legt /etc/bot-hub/master.key an); beim nächsten ' +
          'Start werden die Werte in den Vault umgeschlagen.'
        : '';
    if (text) errors.push(text);
    else
      warnings.push(
        'Kein Vault-Key: Secret-Dateien in data/secrets/ würden ' +
          'unverschlüsselt geschrieben. Bitte BOT_HUB_KEY_FILE setzen ' +
          '(siehe server/vault.js).',
      );
  }

  // 7) Maßnahme 47 (Auftrag 5.5): Rate-Limits brauchen die echte Besucher-
  //    adresse. Der Hub vertraut `X-Forwarded-For` ausschließlich dann, wenn
  //    die direkt verbundene Adresse in BOT_HUB_TRUSTED_PROXIES steht –
  //    richtig so, sonst könnte jeder Besucher seine Quell-Adress frei
  //    erfinden. In Produktion MUSS der Hub an Loopback binden (Regel 1/1D),
  //    vor ihm steht also der TLS-Proxy der Deployment-Anleitung. Ist die
  //    Liste leer, landen alle Besucher im selben Eimer: das Login-Limit
  //    (30/Min) gilt dann für die ganze Installation, und ein einzelner
  //    Angreifer meldet die übrigen ab. Kein Abbruch – die Anlage funktioniert
  //    weiter, nur die Schutzwirkung der Limits ist nicht die vorgesehene.
  if (production) {
    const konfigurierteProxys = String(
      env.BOT_HUB_TRUSTED_PROXIES ?? '',
    ).trim();
    const offentlichErreichbar = (() => {
      const basis = String(env.BOT_HUB_URL ?? '').trim();
      if (!basis) return false;
      try {
        const { hostname } = new URL(basis);
        const ohneKlammer = hostname.replace(/^\[|\]$/g, '');
        return !LOOPBACK_HOSTS.has(ohneKlammer);
      } catch {
        // Unparsbare URL: lieber melden als schweigen – die Anlage ist
        // sowieso fehlerhaft, die Frage ist nur, ob der Hinweis passt.
        return true;
      }
    })();
    if (offentlichErreichbar && !konfigurierteProxys) {
      warnings.push(
        'BOT_HUB_URL zeigt auf einen öffentlich erreichbaren Namen, aber ' +
          'BOT_HUB_TRUSTED_PROXIES ist leer: alle Besucher hinter dem Proxy ' +
          'teilen sich einen Rate-Limit-Eimer auf die Proxy-Adresse. Bitte die ' +
          'Adresse des Proxies eintragen (gleicher Rechner: ' +
          'BOT_HUB_TRUSTED_PROXIES=127.0.0.1).',
      );
    }
  }

  return { errors, warnings };
};
