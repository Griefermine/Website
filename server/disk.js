/**
 * Maßnahme 49 (V27-D, Auftrag 5.4): freier Platz auf dem Datenträger.
 *
 * Die harte Kontingentgrenze je Workspace bleibt bewusst Sache des Betriebs –
 * sie ist ohne Dateisystem-Quota (`xfs`-Projekte, `btrfs`, Loop-Device) nicht
 * tragfähig und in `documents/sicherheit.md` als Entscheidung dokumentiert.
 * Was der Hub OHNE diese Einrichtung tun kann, ist der fehlende Teil: vor
 * speicherintensiven Schritten messen, statt blind zuzulassen. Vorher stand
 * nirgends ein `statfs` – eine volle Platte hat jede Installation
 * mittendrin getroffen und im schlechtesten Fall ALLE Bots mit sich gerissen
 * (eine volle Platte legt den Hub, die Datenbank und jeden Workspace lahm).
 *
 * Geprüft wird gegen den Datenträger des Projekt-Ordners (dort liegen
 * `bots/`, `data/db/`, alles Wachsende):
 *  - `bavail` – für den Hub-Benutzer beschreibbare Blöcke (NOT `bfree`: die
 *    Reserve des root darf nicht als eigener Spielraum zählen),
 *  - `ffree`  – freie Inodes; ein Workspace mit millionen winziger Dateien
 *    ist trotz leerer Bytes-Statistik voll.
 *
 * Messfehler führen NICHT zur Ablehnung: ein nicht prüfbarer Datenträger darf
 * keinen Betrieb blockieren, sonst macht ein kaputter Messpfad die Anlage
 * unbenutzbar. Abbruch ist nur bei tatsächlich gemessenem Mangel.
 */

import { statfsSync } from 'node:fs';

const DEFAULT_MIN_FREE_MB = 256;
const DEFAULT_MIN_FREE_INODES = 10_000;
const invalidWarned = new Set();

/**
 * Schwellenwert aus der Umgebung. Ungültige Werte (kein numerischer Wert,
 * <= 0) melden einmalig und bleiben beim Default – wie bei den
 * Sitzungs-Laufzeiten (Maßnahme 45) darf ein Tippfehler die Prüfung weder
 * ausschalten noch auf „immer ablehnen“ stellen. Ein echtes Abschalten ist
 * gewollt nicht vorgesehen; ein sehr kleiner Wert erfüllt denselben Zweck.
 */
const threshold = (name, raw, fallback) => {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    if (!invalidWarned.has(name)) {
      invalidWarned.add(name);
      console.error(
        `[hub] ${name}="${text}" ist keine gültige Zahl – es gilt der Default ${fallback}.`,
      );
    }
    return fallback;
  }
  return Math.floor(value);
};

/**
 * Freier Platz auf dem Datenträger hinter `pfad`, oder `null` wenn er nicht
 * messbar ist (Datenträger fehlt, Berechtigung, exotisches Dateisystem).
 * `statfs` ist injectierbar, damit Tests nicht echte Platten füllen müssen.
 */
export const spaceStatus = (pfad, statfs = statfsSync) => {
  try {
    const { bsize, bavail, ffree } = statfs(pfad);
    if (!Number.isFinite(bsize) || !Number.isFinite(bavail)) return null;
    return {
      bytes: bsize * bavail,
      inodes: Number.isFinite(ffree) ? ffree : null,
    };
  } catch {
    return null;
  }
};

const mib = (bytes) => Math.floor(bytes / (1024 * 1024));

/**
 * Hat der Datenträger unter `pfad` genug Raum für einen weiteren Schritt?
 * Ergebnis: `{ ok, grund }`; `grund` ist eine vollständige, deutschsprachige
 * Meldung ohne Pfade über Benutzer-Dateien und ohne irgendwelche Werte.
 */
export const capacityGuard = (
  pfad,
  { env = process.env, statfs = statfsSync } = {},
) => {
  const minBytes =
    threshold(
      'BOT_HUB_MIN_FREE_MB',
      env.BOT_HUB_MIN_FREE_MB,
      DEFAULT_MIN_FREE_MB,
    ) *
    1024 *
    1024;
  const minInodes = threshold(
    'BOT_HUB_MIN_FREE_INODES',
    env.BOT_HUB_MIN_FREE_INODES,
    DEFAULT_MIN_FREE_INODES,
  );
  const status = spaceStatus(pfad, statfs);
  if (!status) return { ok: true, gemessen: false, grund: '', status: null };
  if (status.bytes < minBytes)
    return {
      ok: false,
      gemessen: true,
      status,
      grund:
        `Auf dem Datenträger dieses Hub sind nur noch ${mib(status.bytes)} MiB ` +
        `frei; erforderlich sind ${mib(minBytes)} MiB ` +
        '(BOT_HUB_MIN_FREE_MB). Bitte Platz freigeben oder die Schwelle ' +
        'prüfen – eine Installation mitten auf dem Weg abzubrechen ist ' +
        'besser, als den Datenträger für alle Bots zu füllen.',
    };
  if (status.inodes !== null && status.inodes < minInodes)
    return {
      ok: false,
      gemessen: true,
      status,
      grund:
        `Auf dem Datenträger dieses Hub sind nur noch ${status.inodes} ` +
        `Dateisplätze (Inodes) frei; erforderlich sind ${minInodes} ` +
        '(BOT_HUB_MIN_FREE_INODES). Eine Million winziger Dateien füllt ' +
        'einen Datenträger, bevor die Bytes-Anzeige etwas hergibt.',
    };
  return { ok: true, gemessen: true, grund: '', status };
};
