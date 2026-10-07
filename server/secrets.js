/**
 * Geheimnisse eines Bots liegen ausschließlich hier: in
 * `data/secrets/<bot-id>.env`. `data/bots.json` ist nur die Übersicht der Bots
 * und führt deshalb lediglich die Namen der Schlüssel.
 *
 * Warum ein eigenes Modul: manager.js (Migration beim Start) und panel.js
 * (jede Änderung an Einstellungen) schreiben beide in diese Datei. Ein
 * gemeinsamer Ort verhindert, dass die beiden auseinanderlaufen.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from './util.js';

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

/** Inhalt der Secret-Datei; fehlende oder unlesbare Datei ergibt `{}`. */
export const readSecretValues = (projectRoot, id) => {
  try {
    return parseDotenv(readFileSync(fileOf(projectRoot, id), 'utf8'));
  } catch {
    return {};
  }
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
  const directory = directoryOf(projectRoot);
  const temp = join(
    directory,
    `.env.bot-hub.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temp, formatDotenv(Object.entries(merged)), {
      encoding: 'utf8',
      mode: 0o600,
    });
    chmodSync(temp, 0o600);
    renameSync(temp, fileOf(projectRoot, id));
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* Der ursprüngliche Fehler ist die relevante Diagnose. */
    }
    throw error;
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
