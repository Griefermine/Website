/**
 * P0-B: Prüfung des FINALEN Release-Artefakts – unabhängig davon, was Git
 * kennt.
 *
 * Der Repo-Scan (`release-scan.mjs`) beantwortet die Frage „Was würde in
 * einen Commit gelangen?“ Diese Antwort hier ist die andere Frage: „Was
 * enthält das Archiv, das ich wirklich auslievere?“ Ein ZIP mit lokaler
 * `.env`, `data/secrets/` oder einer SQLite-Datei war bisher unbemerkt
 * grün – weil nur Dateinamen Git-getrackter Dateien geprüft wurden.
 * Genau das schließt dieses Modul.
 *
 * Grundsätze:
 *  - Allowlist statt Denylist: was nicht ausdrücklich freigegeben ist,
 *    scheitert. Die Denylist bleibt als zweite harte Schicht bestehen.
 *  - Pfad-Kanonisierung VOR jeder Regel: `\` → `/`, `..`, absolute Pfade,
 *    Laufwerksbuchstaben werden abgelehnt; eine optionale gemeinsame
 *    Top-Level-Ordner-Ebene wird für die Bewertung entfernt (ein
 *    `untitled/.env` ist dasselbe Vergehen wie `.env`).
 *  - Archive werden INHALTLICH gelesen (eigener ZIP-/TAR-Leser, keine
 *    externen Tools, keine Temp-Extraktion auf dem Host).
 *  - Zip-Bombs: harte Limits für Gesamt- und Einzelgröße sowie für das
 *    Kompressionsverhältnis; Dekompression bricht kontrolliert ab.
 *  - Symlinks, Hardlinks und Gerätedateien sind im Release tabu.
 *  - Fundmeldungen nennen NIE den konkreten Secret-Wert.
 *
 * Exit-Status: 0 = freigegeben, 1 = Funde, 2 = Artefakt nicht prüfbar.
 * „Nicht prüfbar“ ist bewusst kein Erfolg.
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import {
  UNWANTED_PATTERNS,
  TEXT_EXCLUDED_EXTENSIONS,
  DOKUMENTATION_EXTENSIONS,
  inhaltFindings,
  exampleWertePrüfen,
  istScannerQuelldatei,
} from './scan-rules.mjs';

/* ------------------------------ Limits ------------------------------ */
export const LIMITS = {
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxRatio: 300,
  maxEntries: 20_000,
};

/* -------------------------- Pfad-Kanonik ---------------------------- */

/**
 * Einen Archiv-Pfad in eine bewertbare Form bringen. Fehler sind hier
 * Beweismittel, keine Ausnahmen: `..`, absolute Pfade und Laufwerks-
 * präfixe gehören in kein Release-Archiv.
 */
export const normalizeEntryPath = (raw) => {
  const original = String(raw ?? '');
  if (!original) return { ok: false, grund: 'leerer Pfad' };
  const unified = original.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(unified) || /^[A-Za-z]:$/.test(unified))
    return { ok: false, grund: `Laufwerkspfad (${unified.slice(0, 3)}…)` };
  if (unified.startsWith('/')) return { ok: false, grund: 'absoluter Pfad' };
  const segments = unified.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..'))
    return { ok: false, grund: 'Pfad enthält ..' };
  if (unified.includes('\0')) return { ok: false, grund: 'NUL im Pfad' };
  const path = segments.join('/');
  if (!path) return { ok: false, grund: 'leerer Pfad' };
  return { ok: true, path };
};

/**
 * Gemeinsame Top-Level-Ebene entfernen, falls ALLE Einträge sie teilen.
 * Wurzelverzeichnisse appear im tar als eigener Eintrag OHNE Slash
 * (`bot-hub-0.1.0`), während Dateien ihn haben (`bot-hub-0.1.0/package.json`).
 * Beide Formen müssen als dieselbe Wurzel erkannt werden, sonst bleibt das
 * Präfix stehen und ein `bot-hub-0.1.0/.env` wäre plötzlich „erlaubt“.
 */
export const stripCommonRoot = (paths) => {
  if (paths.length < 2) return (p) => p;
  const root = paths[0]?.split('/')[0];
  if (!root) return (p) => p;
  const shares = paths.every((p) => p === root || p.startsWith(`${root}/`));
  if (!shares) return (p) => p;
  return (p) =>
    p === root ? '' : p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p;
};

/* --------------------------- Manifest/Glob -------------------------- */

const escapeRe = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');

export const globToRegExp = (glob) => {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += escapeRe(c);
  }
  return new RegExp(`^${out}$`);
};

export const istErlaubt = (path, istVerzeichnis, muster) => {
  for (const glob of muster) {
    const re = globToRegExp(glob);
    if (re.test(path)) return true;
    // Verzeichnisse: `server/**` soll auch den Ordner `server` selbst
    // freigeben (Archive führen Ordner als eigene Einträge).
    if (istVerzeichnis && re.test(`${path}/`)) return true;
  }
  return false;
};

/* ------------------------------ ZIP --------------------------------- */

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);

const findEocd = (buffer) => {
  const min = Math.max(0, buffer.length - 22 - 65_536);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
};

const S_IFLNK = 0xa000;
const S_IFDIR = 0x4000;

/**
 * ZIP im Speicher lesen: zentrallesverzeichnis → Einträge. Lokale Header
 * werden nur so weit gelesen, wie es zum Finden der Nutzdaten nötig ist.
 * Unbekannte Kompressionsverfahren und Verschlüsselung brechen ab – ein
 * Scanner, der beides „übersieht“, wäre ein Blindflug.
 */
export const readZipEntries = (buffer) => {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('kein ZIP: End of Central Directory fehlt');
  let count = u16(buffer, eocd + 10);
  let cdOffset = u32(buffer, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // ZIP64: Locator sitzt direkt vor dem EOCD.
    const loc = eocd - 20;
    if (loc < 0 || buffer.readUInt32LE(loc) !== 0x07064b50)
      throw new Error('ZIP64 erwartet, aber Locator fehlt');
    const z64 = Number(buffer.readBigUInt64LE(loc + 8));
    if (buffer.readUInt32LE(z64) !== 0x06064b50)
      throw new Error('ZIP64 End of Central Directory ungültig');
    count = Number(buffer.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buffer.readBigUInt64LE(z64 + 48));
  }
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50)
      throw new Error('zentrales Verzeichnis (central directory) beschädigt');
    const flags = u16(buffer, p + 8);
    const method = u16(buffer, p + 10);
    let compSize = u32(buffer, p + 20);
    let uncompSize = u32(buffer, p + 24);
    const nameLen = u16(buffer, p + 28);
    const extraLen = u16(buffer, p + 30);
    const commentLen = u16(buffer, p + 32);
    let localOffset = u32(buffer, p + 42);
    const external = u32(buffer, p + 38);
    const name = buffer.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // ZIP64-Extra-Feld (0x0001) kann die 32-Bit-Werte ersetzen.
    if (
      compSize === 0xffffffff ||
      uncompSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = u16(buffer, e);
        const size = u16(buffer, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) {
            uncompSize = Number(buffer.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = Number(buffer.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(buffer.readBigUInt64LE(q));
            q += 8;
          }
        }
        e += 4 + size;
      }
    }
    entries.push({
      name,
      method,
      flags,
      compSize,
      uncompSize,
      localOffset,
      mode: (external >>> 16) & 0xffff,
      isDir: name.endsWith('/') || ((external >>> 16) & 0xf000) === S_IFDIR,
      isSymlink: ((external >>> 16) & 0xf000) === S_IFLNK,
      dataAt: null, // wird beim Lesen lokal berechnet
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, format: 'zip' };
};

const readZipEntryData = (buffer, entry) => {
  const off = entry.localOffset;
  if (off + 30 > buffer.length || buffer.readUInt32LE(off) !== 0x04034b50)
    throw new Error(`lokaler Header fehlt: ${entry.name}`);
  const nameLen = u16(buffer, off + 26);
  const extraLen = u16(buffer, off + 28);
  const start = off + 30 + nameLen + extraLen;
  if (start + entry.compSize > buffer.length)
    throw new Error(`Daten abgeschnitten: ${entry.name}`);
  const raw = buffer.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8)
    return inflateRawSync(raw, { maxOutputLength: LIMITS.maxEntryBytes });
  throw new Error(`Kompressionsverfahren ${entry.method} nicht unterstützt`);
};

/* ------------------------------ TAR --------------------------------- */

const octal = (buf) => {
  const text = buf
    .toString('ascii')
    .replace(/[^0-7]/g, '')
    .trim();
  return text ? parseInt(text, 8) : 0;
};

/** tar-Blöcke lesen (POSIX + GNU-Langnamen; PAX-Header werden übersprungen). */
const readTarBlocks = (data) => {
  const entries = [];
  let p = 0;
  let pendingLongName = null;
  while (p + 512 <= data.length) {
    const header = data.subarray(p, p + 512);
    if (header.every((byte) => byte === 0)) break; // Fill-Block
    const magic = header.subarray(257, 263).toString('ascii');
    if (!magic.startsWith('ustar'))
      throw new Error('tar-Header beschädigt (magic fehlt)');
    // Checksumme: Summe über alle 512 Header-Bytes, wobei das
    // Checksummenfeld selbst (148..155) als 8 Leerzeichen zählt – die
    // Konvention jedes tar-Readers. Nur [0,154) zu summieren wäre falsch.
    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
      if (i >= 148 && i < 156) sum += 32;
      else sum += header[i];
    }
    const expected = octal(header.subarray(148, 156));
    if (sum !== expected)
      throw new Error(`tar-Header-Checksumme falsch bei Offset ${p}`);
    let name = header.subarray(0, 100).toString('utf8').split('\0')[0];
    const prefix = header.subarray(345, 155).toString('utf8').split('\0')[0];
    if (prefix) name = `${prefix}/${name}`;
    if (pendingLongName) {
      name = pendingLongName;
      pendingLongName = null;
    }
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const mode = octal(header.subarray(100, 108));
    if (p + 512 + size > data.length)
      throw new Error(`tar-Daten abgeschnitten: ${name}`);
    const payload = data.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      pendingLongName = payload.toString('utf8').split('\0')[0];
      continue;
    }
    if (type === 'x' || type === 'g') continue; // PAX-Kommentarblöcke
    entries.push({
      name,
      size,
      mode,
      isDir: type === '5',
      isSymlink: type === '2',
      isHardlink: type === '1',
      isDevice: type === '3' || type === '4' || type === '6',
      read: () => payload,
      method: 'tar',
      flags: 0,
    });
  }
  return entries;
};

/** gzip-komprimiertes tar. */
export const readTarGzEntries = (buffer) => ({
  entries: readTarBlocks(
    gunzipSync(buffer, { maxOutputLength: LIMITS.maxTotalBytes }),
  ),
  format: 'tar.gz',
});

/** unkomprimiertes tar. */
export const readTarEntries = (buffer) => ({
  entries: readTarBlocks(buffer),
  format: 'tar',
});

const readZipAsEntries = (buffer) => {
  const { entries, format } = readZipEntries(buffer);
  return {
    format,
    entries: entries.map((entry) => ({
      ...entry,
      read: () => readZipEntryData(buffer, entry),
    })),
  };
};

/* --------------------------- Artefakt-Scan -------------------------- */

const istText = (path) => {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (!ext) return true;
  const dotted = `.${ext}`;
  if (TEXT_EXCLUDED_EXTENSIONS.has(dotted)) return false;
  return true;
};

/**
 * Ein Release-Artefakt prüfen. `manifest` = `{ allow: string[] }`.
 * Rückgabe: `{ status: 'ok'|'funde'|'unpruefbar', findings, stats }`.
 */
export const scanArtifact = (buffer, manifest) => {
  const findings = [];
  const stats = {
    format: '',
    eintraege: 0,
    dateien: 0,
    unkomprimiertBytes: 0,
  };
  let parsed;
  try {
    if (buffer.length > LIMITS.maxArchiveBytes)
      return {
        status: 'funde',
        findings: [
          {
            pfad: '(archiv)',
            grund: `Archiv größer als ${LIMITS.maxArchiveBytes} Byte`,
          },
        ],
        stats,
      };
    const magic = buffer.subarray(0, 4);
    if (magic[0] === 0x1f && magic[1] === 0x8b)
      parsed = readTarGzEntries(buffer);
    else if (
      magic.readUInt32LE(0) === 0x04034b50 ||
      buffer.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    )
      parsed = readZipAsEntries(buffer);
    else if (buffer.subarray(257, 263).toString('ascii').startsWith('ustar'))
      // unkomprimiertes tar: ebenfalls prüfbar – ein unübliches Format ist
      // kein Freifahrtschein, alle Regeln laufen normal durch.
      parsed = readTarEntries(buffer);
    else
      return {
        status: 'unpruefbar',
        findings: [{ pfad: '(archiv)', grund: 'unbekanntes Archivformat' }],
        stats,
      };
  } catch (error) {
    return {
      status: 'unpruefbar',
      findings: [
        { pfad: '(archiv)', grund: `Archiv nicht lesbar: ${error.message}` },
      ],
      stats,
    };
  }

  stats.format = parsed.format;
  stats.eintraege = parsed.entries.length;
  if (!parsed.entries.length)
    findings.push({ pfad: '(archiv)', grund: 'Archiv enthält keine Einträge' });
  if (parsed.entries.length > LIMITS.maxEntries)
    findings.push({
      pfad: '(archiv)',
      grund: `zu viele Einträge (> ${LIMITS.maxEntries})`,
    });

  const normalized = [];
  for (const entry of parsed.entries) {
    const norm = normalizeEntryPath(entry.name);
    if (!norm.ok) {
      findings.push({
        pfad: String(entry.name).slice(0, 200),
        grund: norm.grund,
      });
      continue;
    }
    normalized.push({ entry, path: norm.path });
  }
  const strip = stripCommonRoot(normalized.map((n) => n.path));

  const seen = new Set();
  let totalBytes = 0;
  for (const { entry, path } of normalized) {
    const bare = strip(path);
    const label = bare;
    // Der Top-Level-Container selbst (nach Strip leer) ist kein Inhalt, der
    // einer Allowlist bedarf – er wird nur als gemeinsames Wurzelverzeichnis
    // getragen.
    if (bare === '') continue;
    if (seen.has(bare)) {
      findings.push({ pfad: label, grund: 'Dublette im Archiv' });
      continue;
    }
    seen.add(bare);

    // 1) Harte Denylist – vor und nach der Top-Level-Ebene.
    for (const { muster, grund } of UNWANTED_PATTERNS) {
      if (muster.test(path) || (bare !== path && muster.test(bare))) {
        findings.push({ pfad: label, grund: `verbotener Pfad: ${grund}` });
        break;
      }
    }

    // 2) Allowlist: unbekannt = abgelehnt.
    if (!istErlaubt(bare, entry.isDir, manifest.allow))
      findings.push({
        pfad: label,
        grund: 'unerwartete Datei – nicht in der Release-Allowlist',
      });

    // 3) Sonderdateitypen.
    if (entry.isSymlink)
      findings.push({ pfad: label, grund: 'Symlink im Release verboten' });
    if (entry.isHardlink)
      findings.push({ pfad: label, grund: 'Hardlink im Release verboten' });
    if (entry.isDevice)
      findings.push({ pfad: label, grund: 'Gerätedatei im Release verboten' });
    if (entry.isDir) continue;

    // 4) Größen-/Bomben-Limits (ZIP: uncompSize, TAR: size).
    const entpackteGroesse = entry.uncompSize ?? entry.size ?? 0;
    if (entpackteGroesse > LIMITS.maxEntryBytes)
      findings.push({ pfad: label, grund: 'Eintrag zu groß' });

    stats.dateien += 1;

    // 5) Inhalt nur prüfen, wenn die Datei überhaupt in die Nähe der
    //    Allowlist kam (sonst ist sie ohnehin raus) und Text sein kann.
    //    Scanner-Quelldateien enthalten die Suchmuster selbst und werden von
    //    der INHALTSprüfung ausgenommen (Pfad-/Allowlist-Regeln gelten weiter).
    const textPruefen =
      istText(bare) &&
      !istScannerQuelldatei(bare) &&
      !istVerbotenNurWegenAllow(entry, bare, findings, label);
    if (!textPruefen) continue;
    let content;
    try {
      const compSize = entry.compSize ?? 0;
      if (
        compSize > 0 &&
        entpackteGroesse > 0 &&
        entpackteGroesse / compSize > LIMITS.maxRatio
      )
        throw new Error(`Kompressionsverhältnis > ${LIMITS.maxRatio}:1`);
      content = entry.read();
    } catch (error) {
      findings.push({
        pfad: label,
        grund: `Inhalt nicht lesbar: ${error.message}`,
      });
      continue;
    }
    totalBytes += content.length;
    if (content.length > LIMITS.maxEntryBytes) {
      findings.push({ pfad: label, grund: 'entpackte Datei zu groß' });
      continue;
    }
    const text = content.toString('latin1');
    for (const { grund } of inhaltFindings(bare, text))
      findings.push({ pfad: label, grund });
    if (/^\.env\.example$/i.test(bare)) {
      for (const zeile of exampleWertePrüfen(text))
        findings.push({
          pfad: label,
          grund: `.env.example enthält Nicht-Platzhalter: ${zeile}`,
        });
    }
  }
  stats.unkomprimiertBytes = totalBytes;
  if (totalBytes > LIMITS.maxTotalBytes)
    findings.push({
      pfad: '(archiv)',
      grund: 'entpackte Gesamtgröße über Limit',
    });

  const bereinigt = dedupe(findings);
  return {
    status: bereinigt.length ? 'funde' : 'ok',
    findings: bereinigt,
    stats,
  };
};

// Ein Eintrag, der nur wegen „nicht in Allowlist“ fiel, muss nicht zusätzlich
// inhaltsgeprüft werden – der Fund steht schon.
const istVerbotenNurWegenAllow = (_entry, _bare, findings, label) =>
  findings.some(
    (f) =>
      f.pfad === label &&
      f.grund === 'unerwartete Datei – nicht in der Release-Allowlist',
  );

const dedupe = (findings) => {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.pfad}\u0000${f.grund}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
};

/** Datei-Wrapper: liest das Artefakt und ruft `scanArtifact`. */
export const scanArtifactFile = (pfad, manifest) => {
  let buffer;
  try {
    buffer = readFileSync(pfad);
  } catch (error) {
    return {
      status: 'unpruefbar',
      findings: [
        {
          pfad,
          grund: `Artefakt nicht lesbar: ${error?.code ?? error?.message ?? error}`,
        },
      ],
      stats: { format: '', eintraege: 0, dateien: 0, unkomprimiertBytes: 0 },
    };
  }
  return scanArtifact(buffer, manifest);
};

export const ladeManifest = (text) => {
  const manifest = JSON.parse(text);
  if (!manifest || !Array.isArray(manifest.allow) || !manifest.allow.length)
    throw new Error('Manifest ohne allow-Liste');
  return manifest;
};
