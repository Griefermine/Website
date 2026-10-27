/**
 * Geheimnisse eines Bots liegen ausschließlich hier: in
 * `data/secrets/<bot-id>.env`. `data/bots.json` ist nur die Übersicht der Bots
 * und führt deshalb lediglich die Namen der Schlüssel.
 *
 * Warum ein eigenes Modul: manager.js (Migration beim Start) und panel.js
 * (jede Änderung an Einstellungen) schreiben beide in diese Datei. Ein
 * gemeinsamer Ort verhindert, dass die beiden auseinanderlaufen.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from './util.js';
import {
  decryptValue,
  encryptValue,
  isLegacyVaultValue,
  isVaultValue,
  vaultEnabled,
} from './vault.js';

/** Verzeichnis 0700, Datei 0600 – mit Absicht, nicht mit Vorgabe. */
const directoryOf = (projectRoot) => join(projectRoot, 'data', 'secrets');
const fileOf = (projectRoot, id) =>
  join(
    directoryOf(projectRoot),
    `${String(id).replace(/[^A-Za-z0-9_.-]/g, '')}.env`,
  );

/**
 * Reste abgebrochener Schreibvorgänge entfernen. Wird ein Hub zwischen
 * Schreiben und Umbenennen beendet, bleibt sonst eine vollständige Kopie der
 * Geheimnisse unter `.env.bot-hub.tmp-*` liegen. Junge Dateien bleiben
 * unangetastet, damit kein laufender Hub-Vorgang etwas wegräumt.
 */
export const cleanupTempEnvFiles = (directory, olderThanMs = 60_000) => {
  const limit = Date.now() - olderThanMs;
  try {
    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith('.env.bot-hub.tmp-')) continue;
      const path = join(directory, entry);
      try {
        if (statSync(path).mtimeMs < limit) unlinkSync(path);
      } catch {
        /* Zwischen Prüfung und Löschen verschwunden – egal. */
      }
    }
  } catch {
    /* Kein Verzeichnis, kein Problem. */
  }
};

export const dotenvKey = (key) => {
  const normalized = String(key)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
  return /^[A-Z_]/.test(normalized) ? normalized : `_${normalized}`;
};

/**
 * Schlüssel, die allein dem Hub gehören: Der Hub liest diese Werte selbst
 * wieder ein (OAuth-Konfiguration, Token über `discordConfig` und
 * `BOT_HUB_*`) oder sie steuern, wie Prozesse Programme finden und laden
 * (`PATH`, `HOME`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`). Manifest-Felder und
 * Einstellungen aus Bot-Sicht dürfen niemals unter solchen Schlüsseln in
 * `data/secrets/<id>.env` landen – sonst schreibt ein Bot die
 * OAuth-App des Hubs um oder setzt die Binary-Allowlist außer Kraft.
 */
export const isReservedEnvKey = (key) => {
  const normalized = dotenvKey(key);
  return (
    normalized.startsWith('DISCORD_') ||
    normalized.startsWith('BOT_HUB_') ||
    normalized === 'PATH' ||
    normalized === 'HOME' ||
    normalized.startsWith('LD_') ||
    normalized === 'NODE_OPTIONS' ||
    normalized.startsWith('PYTHON')
  );
};

export const dotenvValue = (value) =>
  `"${String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`;

export const formatDotenv = (values) =>
  `${[...values]
    .map(([key, value]) => `${key}=${dotenvValue(value)}`)
    .join('\n')}\n`;

/**
 * Inhalt der Secret-Datei; fehlende oder unlesbare Datei ergibt `{}`.
 * Liegt ein Vault-Key an, werden umschlagene Werte transparent entschlüsselt –
 * alle Aufrufer sehen immer Klartext. Klartext-Altbestand (vor der Umstellung
 * geschrieben) bleibt lesbar. `decryptValue` wirft bei Manipulation oder
 * fehlendem Key zu einem Umschlag – das ist Absicht (lieber laut als ein
 * vermeintlich leerer Secret-Bestand).
 */
export const readSecretValues = (projectRoot, id) => {
  let parsed;
  try {
    parsed = parseDotenv(readFileSync(fileOf(projectRoot, id), 'utf8'));
  } catch {
    return {};
  }
  const values = {};
  for (const [key, value] of Object.entries(parsed))
    values[key] = decryptValue(id, key, value, projectRoot);
  return values;
};

/**
 * Schreibt die Datei atomar und mit 0600. Standard ist das Zusammenführen
 * mit dem vorhandenen Inhalt (Migration ergänzt einzelne Schlüssel); wer den
 * vollständigen Stand schreibt, setzt `merge: false`.
 */
export const storeSecretValues = (
  projectRoot,
  id,
  values,
  { merge = true } = {},
) => {
  const merged = merge
    ? { ...readSecretValues(projectRoot, id), ...values }
    : Object.fromEntries(Object.entries(values));
  if (!Object.keys(merged).length) return fileOf(projectRoot, id);
  // Liegt ein Vault-Key an, wandert jeder Wert umgeschlagen in die Datei;
  // ohne Key bleibt das alte Klartext-Verhalten (Tests, Entwickler).
  const sealed = Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [
      key,
      encryptValue(id, key, value, projectRoot),
    ]),
  );
  const directory = directoryOf(projectRoot);
  // Zufällig benannt + `wx`: ein erratbarer Temp-Pfad (pid/Zeit/Math.random)
  // wäre ein Symlink-Ziel; `wx` öffnet garantiert eine frische Datei.
  const temp = join(
    directory,
    `.env.bot-hub.tmp-${randomBytes(8).toString('hex')}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // `mode` wirkt nur bei einer Neuanlage. Bei einem bereits vorhandenen,
  // zu offenen Verzeichnis muss der Secret-Speicher ebenfalls geschlossen
  // werden, bevor dort ein neuer Wert geschrieben wird.
  chmodSync(directory, 0o700);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, formatDotenv(Object.entries(sealed)), {
      encoding: 'utf8',
    });
    // fsync VOR dem Rename: erst wenn der Inhalt auf der Platte steht, darf
    // der Eintrag unter dem endgültigen Namen sichtbar sein. Ohne diesen
    // Schritt überlebt ein Systemabsturz möglicherweise eine leere Datei
    // unter dem Zielnamen – scheinbar erfolgreich gespeichert.
    fsyncSync(fd);
    renameSync(temp, fileOf(projectRoot, id));
    // Auch den Verzeichniseintrag dauerhaft machen: fsync der Datei allein
    // garantiert nach einem Stromausfall nicht, dass das Rename erhalten ist.
    const dirFd = openSync(directory, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* Der ursprüngliche Fehler ist die relevante Diagnose. */
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return fileOf(projectRoot, id);
};

/** Entfernt die Secret-Datei eines Bots, falls sie existiert. */
export const removeSecretValues = (projectRoot, id) => {
  const path = fileOf(projectRoot, id);
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

/**
 * Eigene Secret-Datei des Hubs: `data/secrets/hub.env`. Sie enthält die
 * OAuth-Werte, die bisher offen in `.env` standen – genau die Datei, vor der
 * die Warnung des Hubs beim Start zu Recht warnt ("landet leicht im Git").
 */
export const HUB_SECRET_ID = 'hub';
const HUB_ENV_KEYS = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
];

/**
 * Läuft einmal beim Hub-Start und macht zwei Dinge:
 *
 * 1. Nachverschlüsselung: Hat ein älterer Hub Secret-Dateien im Klartext
 *    geschrieben, wandern sie jetzt in Vault-Umschläge. Das ist rein
 *    konservativ – gelesen werden beide Formen immer.
 * 2. OAuth-Umzug: Werte aus der Prozessumgebung (`.env`) ziehen in
 *    `data/secrets/hub.env` um und der Vault-Wert gewinnt ab sofort gegen
 *    die Umgebung. `auth.js` liest die Umgebung erst pro Anfrage, daher
 *    wirkt die Überschreibung sofort. Danach kann der Betreiber die
 *    `.env`-Zeilen löschen.
 *
 * Ohne Vault-Key passiert nichts (Klartext-Modus wie bisher), es sei denn,
 * es liegt Klartext herum – dann gibt es genau einen Hinweis. Für `_FILE`-
 * Schlüssel wird nicht umgezogen: die Datei-Indirektion gewinnt in `auth.js`
 * und ein Vault-Duplikat wäre nur ein zweiter Ort, den man pflegen muss.
 */
export const bootstrapSecretVault = (projectRoot, env = process.env) => {
  const enabled = vaultEnabled(projectRoot, env);
  const directory = directoryOf(projectRoot);
  const sealed = [];
  let entries = [];
  try {
    entries = readdirSync(directory).filter((name) => name.endsWith('.env'));
  } catch {
    /* Noch gar kein Secret-Verzeichnis – gibt nichts zu versiegeln. */
  }
  for (const name of entries) {
    const id = name.slice(0, -'.env'.length);
    let parsed;
    try {
      parsed = parseDotenv(readFileSync(join(directory, name), 'utf8'));
    } catch {
      continue;
    }
    const openValues = Object.values(parsed).filter(
      (value) => String(value ?? '').trim() !== '' && !isVaultValue(value),
    );
    // v1-Umschläge sind lesbar, aber ohne Datei-Bindung – hochziehen auf v2.
    const legacy = Object.values(parsed).filter(isLegacyVaultValue);
    if (!openValues.length && !legacy.length) continue;
    if (!enabled) {
      if (openValues.length && env.BOT_HUB_TEST_MODE !== '1')
        console.warn(
          '[hub] Hinweis: Secret-Dateien liegen im Klartext und es ist kein ' +
            'Vault-Key vorhanden. Für AES-256-GCM-Verschlüsselung ' +
            'BOT_HUB_KEY_FILE setzen (siehe server/vault.js).',
        );
      break;
    }
    storeSecretValues(projectRoot, id, readSecretValues(projectRoot, id), {
      merge: false,
    });
    sealed.push(id);
  }
  if (sealed.length)
    console.warn(
      `[hub] ${sealed.length} Secret-Datei(en) in den Vault verschlüsselt.`,
    );

  const stored = enabled ? readSecretValues(projectRoot, HUB_SECRET_ID) : {};
  const migrated = {};
  for (const key of HUB_ENV_KEYS) {
    if (enabled && stored[key]) env[key] = stored[key];
    const fromEnv = String(env[key] ?? '').trim();
    const viaFile = String(env[`${key}_FILE`] ?? '').trim();
    if (!enabled || !fromEnv || stored[key] || viaFile) continue;
    migrated[key] = fromEnv;
  }
  if (Object.keys(migrated).length) {
    storeSecretValues(projectRoot, HUB_SECRET_ID, migrated);
    for (const key of Object.keys(migrated)) env[key] = migrated[key];
    console.warn(
      `[hub] Auth-Werte (${Object.keys(migrated).join(', ')}) in den ` +
        `verschlüsselten data/secrets/${HUB_SECRET_ID}.env umgezogen – ` +
        'die Zeilen können aus .env gelöscht werden.',
    );
  }
  return { enabled, sealed, migrated: Object.keys(migrated) };
};
