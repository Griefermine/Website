/**
 * P0-B/P0-C: Tests für den Artefakt-Scanner mit synthetischen Archiven.
 *
 * Die Fixtures bauen ZIP- und tar.gz-Dateien selbst (reine Node-APIs, keine
 * externen Tools) – damit jeder Fall exakt die Bösartigkeit mitbringt, die er
 * beweisen soll: `.env` im Unterordner, Secret-Inhalte in harmlos benannten
 * Dateien, Traversal-Pfade, Symlinks, Zip-Bombs und kaputte Archive.
 *
 * Getestet wird gegen das ECHTE Release-Manifest (`scripts/release-manifest.
 * json`), damit der Test dieselbe Allowlist verteidigt wie der Build.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const {
  scanArtifact,
  scanArtifactFile,
  ladeManifest,
  normalizeEntryPath,
  stripCommonRoot,
} = await import('../scripts/artifact-scan.mjs');

const ROOT = join(import.meta.dirname, '..');
const MANIFEST = ladeManifest(
  readFileSync(join(ROOT, 'scripts', 'release-manifest.json'), 'utf8'),
);

const tmpRoots = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------ ZIP-Writer ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = ~0;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};

/**
 * Eintrag: { name, data?, mode?, symlink?, dir?, method? (0 stored, 8
 * deflate), fakeUncompressedSize? }
 */
const buildZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // gemacht unter Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.fakeUncompressedSize ?? raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 30);
    const unixMode =
      entry.mode ?? (entry.symlink ? 0xa1ff : entry.dir ? 0x41ed : 0x81a4);
    central.writeUInt32LE((unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cd, eocd]);
};

/* ------------------------------ TAR-Writer ------------------------------ */

const buildTar = (entries) => {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const data = entry.data ?? Buffer.alloc(0);
    header.write(entry.name.slice(0, 99), 0, 'utf8');
    // Feldbreiten exakt einhalten: mode/uid/gid je 8, size/mtime je 12 Byte.
    header.write(
      ((entry.mode ?? 0o644) & 0o7777).toString(8).padStart(7, '0') + '\0',
      100,
    );
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('17700000000\0', 136);
    header.write('        ', 148); // Checksummenfeld: Räume
    header.write(entry.dir ? '5' : entry.symlink ? '2' : '0', 156);
    if (entry.symlink) header.write(String(entry.symlink), 157, 'utf8');
    header.write('ustar\0', 257);
    header.write('00', 263);
    // Standard-konforme Checksumme: Summe über alle 512 Bytes, wobei das
    // Checksummenfeld selbst (148..155) als 8 Leerzeichen zählt.
    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
      if (i >= 148 && i < 156) sum += 32;
      else sum += header[i];
    }
    header.write(sum.toString(8).padStart(6, '0') + '\0', 148);
    blocks.push(header);
    if (data.length) {
      blocks.push(data);
      const rest = data.length % 512;
      if (rest) blocks.push(Buffer.alloc(512 - rest));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};

const gz = (buffer) => gzipSync(buffer);

/* ------------------------------ Helpers ------------------------------- */

const findingGründe = (result) =>
  result.findings.map((f) => f.grund).join('\n');
const findingPfade = (result) => result.findings.map((f) => f.pfad).join('\n');

const legitimerRelease = (prefix = '') => {
  const p = (name) => (prefix ? `${prefix}/${name}` : name);
  const dateien = [
    { name: p('package.json'), data: Buffer.from('{"name":"bot-hub"}') },
    { name: p('index.html'), data: Buffer.from('<!doctype html>') },
    { name: p('server/index.js'), data: Buffer.from('export {};\n') },
    { name: p('src/main.js'), data: Buffer.from('console.log(1);\n') },
    {
      name: p('.env.example'),
      data: Buffer.from('DISCORD_BOT_TOKEN=<token>\nHOST=127.0.0.1\n'),
    },
  ];
  return dateien;
};

/* ------------------------------- Tests -------------------------------- */

describe('Artefakt-Scan: verbotene Laufzeit- und Geheimnispfade', () => {
  it('lehnt ZIP mit root/.env ab (gemeinsames Wurzelverzeichnis)', () => {
    const zip = buildZip([
      ...legitimerRelease('untitled'),
      { name: 'untitled/.env', data: Buffer.from('X=1\n') },
    ]);
    const result = scanArtifact(zip, MANIFEST);
    assert.equal(result.status, 'funde');
    assert.match(findingGründe(result), /verbotener Pfad/);
    assert.match(findingPfade(result), /\.env/);
  });

  it('lehnt ZIP mit data/secrets/<id>.env ab', () => {
    const zip = buildZip([
      ...legitimerRelease('untitled'),
      {
        name: 'untitled/data/secrets/test.env',
        data: Buffer.from('API_KEY="geheim"\n'),
      },
    ]);
    const result = scanArtifact(zip, MANIFEST);
    assert.equal(result.status, 'funde');
    assert.match(findingPfade(result), /data\/secrets\/test\.env/);
  });

  it('lehnt ZIP mit SQLite-Datei ab', () => {
    const zip = buildZip([
      ...legitimerRelease(),
      { name: 'data/db/bot-hub.sqlite', data: Buffer.from('SQLite format 3') },
    ]);
    const result = scanArtifact(zip, MANIFEST);
    assert.equal(result.status, 'funde');
    assert.match(findingGründe(result), /Datenbank|Bot-Speicher/);
  });

  it('lehnt ZIP mit .git/ und node_modules/ ab', () => {
    const zip = buildZip([
      ...legitimerRelease(),
      { name: '.git/config', data: Buffer.from('[core]\n') },
      { name: 'node_modules/links/paket/index.js', data: Buffer.from('x') },
    ]);
    const result = scanArtifact(zip, MANIFEST);
    assert.equal(result.status, 'funde');
    assert.match(findingGründe(result), /Versionshistorie/);
    assert.match(findingGründe(result), /Dependencies/);
  });

  it('findet Secret-Inhalt in harmlos benannter Datei OHNE den Wert auszugeben', () => {
    // Der Token wird erst zur Laufzeit zusammengesetzt, damit DIESE Testdatei
    // selbst nicht vom Scanner als Fund markiert wird (der vollständige
    // String stünde sonst literal im Quelltext).
    const token = [
      'MTk4NjIyMjEyMTI3MTQ0OTYw',
      'AbCdEf',
      'xYz123abcDEF456ghiJKL789mno',
    ].join('.');
    const zip = buildZip([
      ...legitimerRelease(),
      { name: 'server/helfer.js', data: Buffer.from(`const t="${token}";\n`) },
    ]);
    const result = scanArtifact(zip, MANIFEST);
    assert.equal(result.status, 'funde');
    assert.match(findingGründe(result), /Discord-Bot-Token/);
    // Der Fundwert selbst darf in keiner Meldung auftauchen.
    assert.ok(
      !JSON.stringify(result.findings).includes('xYz123abcDEF456ghiJKL789mno'),
      'Scanner gibt den Secret-Wert aus',
    );
  });

  it('lehnt .env.example mit echtem Wert ab, Platzhalter sind ok', () => {
    const schlecht = buildZip([
      ...legitimerRelease(),
      {
        name: '.env.example',
        data: Buffer.from(
          'BOT_HUB_SESSION_SECRET=aRealsEcr3tValue9876543210\n',
        ),
      },
    ]);
    assert.equal(scanArtifact(schlecht, MANIFEST).status, 'funde');
    assert.equal(
      scanArtifact(buildZip(legitimerRelease()), MANIFEST).status,
      'ok',
    );
  });
});

describe('Artefakt-Scan: Pfad-Kanonik und Strukturangriffe', () => {
  it('lehnt ../-Traversal, absolute und Windows-Laufwerkspfade ab', () => {
    assert.equal(normalizeEntryPath('../etc/passwd').ok, false);
    assert.equal(normalizeEntryPath('/etc/passwd').ok, false);
    assert.equal(normalizeEntryPath('C:/Windows/x').ok, false);
    assert.equal(normalizeEntryPath('a\\..\\b').ok, false);
    assert.deepEqual(normalizeEntryPath('a//b/./c'), {
      ok: true,
      path: 'a/b/c',
    });
    const zip = buildZip([
      ...legitimerRelease(),
      { name: '../entkommen.txt', data: Buffer.from('x') },
    ]);
    assert.equal(scanArtifact(zip, MANIFEST).status, 'funde');
  });

  it('lehnt Symlink-Einträge (ZIP und TAR) ab', () => {
    const zip = buildZip([
      ...legitimerRelease(),
      {
        name: 'server/link.js',
        symlink: true,
        data: Buffer.from('/etc/shadow'),
      },
    ]);
    assert.match(findingGründe(scanArtifact(zip, MANIFEST)), /Symlink/);
    const tgz = gz(
      buildTar([
        ...legitimerRelease().map((e) => ({ name: e.name, data: e.data })),
        { name: 'bots/link', symlink: '/etc/shadow' },
      ]),
    );
    assert.match(findingGründe(scanArtifact(tgz, MANIFEST)), /Symlink/);
  });

  it('entfernt eine unauffällige gemeinsame Top-Ebene korrekt', () => {
    assert.equal(
      stripCommonRoot(['a/x', 'a/y'])('a/package.json'),
      'package.json',
    );
    assert.equal(stripCommonRoot(['a/x', 'b/y'])('a/x'), 'a/x');
    // Legitimer Release unter `bot-hub-0.1.0/` wird akzeptiert …
    assert.equal(
      scanArtifact(buildZip(legitimerRelease('bot-hub-0.1.0')), MANIFEST)
        .status,
      'ok',
    );
    // … `.env` darunter wird trotzdem als `.env` verurteilt.
    const zip = buildZip([
      ...legitimerRelease('bot-hub-0.1.0'),
      { name: 'bot-hub-0.1.0/.env', data: Buffer.from('A=B\n') },
    ]);
    assert.equal(scanArtifact(zip, MANIFEST).status, 'funde');
  });

  it('blockiert Zip-Bombs: Kompressionsverhältnis und überdimensionierte Einträge', () => {
    const bombenRohtext = Buffer.alloc(4 * 1024 * 1024, 0x41);
    const zip = buildZip([
      ...legitimerRelease(),
      {
        name: 'server/bombe.js',
        data: bombenRohtext,
        method: 8,
      },
    ]);
    assert.match(
      findingGründe(scanArtifact(zip, MANIFEST)),
      /Kompressionsverhältnis/,
    );
    const gross = buildZip([
      ...legitimerRelease(),
      {
        name: 'server/gross.js',
        data: Buffer.from('x'),
        fakeUncompressedSize: 128 * 1024 * 1024,
      },
    ]);
    assert.match(findingGründe(scanArtifact(gross, MANIFEST)), /zu groß/);
  });

  it('meldet Dubletten desselben Pfades', () => {
    const zip = buildZip([
      ...legitimerRelease(),
      { name: 'package.json', data: Buffer.from('{"evil":true}') },
    ]);
    assert.match(findingGründe(scanArtifact(zip, MANIFEST)), /Dublette/);
  });

  it('lehnt unbekannte Dateien dank Allowlist ab', () => {
    const zip = buildZip([
      ...legitimerRelease(),
      { name: 'waslol.sh', data: Buffer.from('#!/bin/sh\n') },
    ]);
    const result = scanArtifact(zip, MANIFEST);
    assert.equal(result.status, 'funde');
    assert.match(findingGründe(result), /Allowlist/);
  });
});

describe('Artefakt-Scan: Unprüfbares ist kein Erfolg', () => {
  it('kaputtes ZIP liefert Status unpruefbar', () => {
    const kaputt = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('nonsense-nonsense-nonsense'),
    ]);
    const result = scanArtifact(kaputt, MANIFEST);
    assert.equal(result.status, 'unpruefbar');
  });

  it('nicht lesbare Artefaktdatei liefert Status unpruefbar', () => {
    const result = scanArtifactFile(
      join(tmpdir(), 'gibt-es-hier-nicht-42.tgz'),
      MANIFEST,
    );
    assert.equal(result.status, 'unpruefbar');
  });

  it('fremdes Dateiformat liefert Status unpruefbar', () => {
    const result = scanArtifact(Buffer.from('REVERSE-DATA-V1'), MANIFEST);
    assert.equal(result.status, 'unpruefbar');
  });

  it('leeres Archiv wird abgelehnt', () => {
    const result = scanArtifact(gz(buildTar([])), MANIFEST);
    assert.equal(result.status, 'funde');
    assert.match(findingGründe(result), /keine Einträge/);
  });
});

describe('Artefakt-Scan: tar.gz als primäres Build-Format', () => {
  it('akzeptiert einen legitimen tar.gz-Release', () => {
    const tgz = gz(
      buildTar(legitimerRelease('bot-hub-0.1.0').map((e) => ({ ...e }))),
    );
    const result = scanArtifact(tgz, MANIFEST);
    assert.equal(result.status, 'ok', findingGründe(result));
    assert.equal(result.stats.format, 'tar.gz');
  });

  it('findet .env in tar.gz unter Wurzelordner', () => {
    const tgz = gz(
      buildTar([
        ...legitimerRelease('bot-hub-0.1.0'),
        { name: 'bot-hub-0.1.0/.env', data: Buffer.from('X=1\n') },
      ]),
    );
    assert.equal(scanArtifact(tgz, MANIFEST).status, 'funde');
  });
});

describe('CLI: Exit-Codes und Unabhängigkeit der Modi', () => {
  it('--artifact mit fehlerhaftem Archiv endet auf Exit 1', async () => {
    const dir = tmp('release-cli-');
    const pfad = join(dir, 'kaputt.tar.gz');
    writeFileSync(
      pfad,
      gz(
        buildTar([
          ...legitimerRelease(),
          { name: 'data/secrets/dampf.env', data: Buffer.from('A=B\n') },
        ]),
      ),
    );
    await assert.rejects(
      execFileAsync(process.execPath, [
        join(ROOT, 'scripts', 'release-scan.mjs'),
        '--artifact',
        pfad,
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /nicht releasebereit/);
        return true;
      },
    );
  });

  it('--artifact mit sauberem Archiv endet auf Exit 0', async () => {
    const dir = tmp('release-cli-ok-');
    const pfad = join(dir, 'gut.tar.gz');
    writeFileSync(pfad, gz(buildTar(legitimerRelease('bot-hub-0.1.0'))));
    const { stdout } = await execFileAsync(process.execPath, [
      join(ROOT, 'scripts', 'release-scan.mjs'),
      '--artifact',
      pfad,
    ]);
    assert.match(stdout, /Bereit für eine Veröffentlichung DIESES Archivs/);
  });

  it('fehlt das Artefakt, endet der Lauf auf Exit 2 (nicht auf Erfolg)', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        join(ROOT, 'scripts', 'release-scan.mjs'),
        '--artifact',
        join(tmpdir(), 'unbekannt-artifact-9182736.tgz'),
      ]),
      (error) => {
        assert.equal(error.code, 2);
        return true;
      },
    );
  });

  it('der Repo-Scan weist auf den Artefakt-Modus hin (kein Ersatz)', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      join(ROOT, 'scripts', 'release-scan.mjs'),
    ]);
    assert.match(stdout, /--artifact/);
  });
});
