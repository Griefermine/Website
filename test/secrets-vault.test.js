import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  HUB_SECRET_ID,
  bootstrapSecretVault,
  formatDotenv,
  readSecretValues,
  storeSecretValues,
} from '../server/secrets.js';
import { __forgetKeys, encryptValue, isVaultValue } from '../server/vault.js';

/*
 * Der Vault ist abschaltbar: ohne erreichbare Key-Datei schreibt der Hub
 * Klartext wie vor der Umstellung. Die Tests setzen BOT_HUB_KEY_FILE darum
 * selbst und ziehen die Umgebung nach jedem Fall sauber.
 */

const TOKEN = 'MTk4NjU0MzIxOTg2NTQzMjE5.GaBcDe.SuperGeheim';
const BOT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const keyPath = (root) => join(root, 'master.key');
const writeKey = (root) =>
  writeFileSync(keyPath(root), `${randomBytes(32).toString('hex')}\n`, {
    mode: 0o600,
  });
const rawFile = (root, id) =>
  readFileSync(join(root, 'data', 'secrets', `${id}.env`), 'utf8');

let root;
let savedEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bot-hub-vault-'));
  savedEnv = { ...process.env };
  delete process.env.BOT_HUB_KEY_FILE;
  process.env.BOT_HUB_TEST_MODE = '1';
  __forgetKeys();
});
afterEach(() => {
  process.env = { ...savedEnv };
  __forgetKeys();
  rmSync(root, { recursive: true, force: true });
});

describe('Vault-Verschlüsselung (AES-256-GCM)', () => {
  it('ohne Key bleibt das alte Klartext-Verhalten (abwärtskompatibel)', () => {
    storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN });
    assert.match(rawFile(root, BOT_ID), /SuperGeheim/);
    assert.equal(readSecretValues(root, BOT_ID).DISCORD_BOT_TOKEN, TOKEN);
  });

  it('mit Key liegt nur der Umschlag auf der Platte, Lesen liefert Klartext', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN, EMPTY: '' });
    const raw = rawFile(root, BOT_ID);
    assert.ok(raw.includes('vault:v2:'), 'Umschlag erwartet');
    assert.ok(!raw.includes('SuperGeheim'), 'Klartext darf nicht in der Datei stehen');
    const values = readSecretValues(root, BOT_ID);
    assert.equal(values.DISCORD_BOT_TOKEN, TOKEN);
    assert.equal(values.EMPTY, '', 'leere Werte bleiben leer');
  });

  it('bereits umschlagene Werte werden nicht doppelt verpackt', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    const once = encryptValue('t', 'K', 'wert', root);
    assert.ok(isVaultValue(once));
    assert.equal(encryptValue('t', 'K', once, root), once);
  });

  it('Klartext-Altbestand bleibt lesbar und wird beim Start versiegelt', () => {
    storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN }); // ohne Key
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    assert.equal(readSecretValues(root, BOT_ID).DISCORD_BOT_TOKEN, TOKEN);
    const result = bootstrapSecretVault(root);
    assert.ok(result.enabled);
    assert.deepEqual(result.sealed, [BOT_ID]);
    const raw = rawFile(root, BOT_ID);
    assert.ok(!raw.includes('SuperGeheim'));
    assert.equal(readSecretValues(root, BOT_ID).DISCORD_BOT_TOKEN, TOKEN);
  });

  it('manipulierter Umschlag wirft statt Müll zu liefern', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN });
    const raw = rawFile(root, BOT_ID);
    const envelope = raw.match(/"(vault:v2:[^"]+)"/)[1];
    // Der erste Charakter NACH dem Präfix wird geändert (IV): gleiche Länge,
    // anderer Wert -> die GCM-Prüfung muss fehlschlagen.
    const body = envelope.slice('vault:v2:'.length);
    const tampered = `vault:v2:${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
    assert.notEqual(tampered, envelope);
    writeFileSync(
      join(root, 'data', 'secrets', `${BOT_ID}.env`),
      raw.replace(envelope, tampered),
      { mode: 0o600 },
    );
    assert.throws(() => readSecretValues(root, BOT_ID), /./);
  });

  it('falscher Key wirft laut (kein stillschweigend leerer Bestand)', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN });
    writeKey(root); // neuer Zufallsschlüssel überschreibt
    __forgetKeys();
    assert.throws(() => readSecretValues(root, BOT_ID), /./);
  });

  it('Umschläge sind an ihren Schlüsselnamen gebunden (AAD)', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    storeSecretValues(root, BOT_ID, { ALPHA: 'wert-für-alpha' });
    const raw = rawFile(root, BOT_ID);
    const envelope = raw.match(/ALPHA="([^"]+)"/)[1];
    writeFileSync(
      join(root, 'data', 'secrets', `${BOT_ID}.env`),
      formatDotenv([['BETA', envelope]]),
      { mode: 0o600 },
    );
    assert.throws(() => readSecretValues(root, BOT_ID), /./);
  });

  it('gesetzter, fehlender Key ist ein harter Fehler im Umschlag-Lesepfad', () => {
    // Erst mit Key schreiben, dann Key-Datei entfernen: Lesen muss werfen,
    // damit ein vermeintlich leerer Secret-Bestand nicht mit intakten
    // Dateien verwechselt wird.
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    storeSecretValues(root, BOT_ID, { DISCORD_BOT_TOKEN: TOKEN });
    rmSync(keyPath(root));
    __forgetKeys();
    assert.throws(() => readSecretValues(root, BOT_ID), /Vault-Key fehlt/);
  });

  it('v2-Umschlag ist an seine Datei gebunden (Cross-File-Tausch wirft)', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    storeSecretValues(root, 'botA', { DISCORD_BOT_TOKEN: TOKEN }, { merge: false });
    const envelope = rawFile(root, 'botA').match(
      /DISCORD_BOT_TOKEN="([^"]+)"/,
    )[1];
    writeFileSync(
      join(root, 'data', 'secrets', 'botB.env'),
      formatDotenv([['DISCORD_BOT_TOKEN', envelope]]),
      { mode: 0o600 },
    );
    assert.throws(() => readSecretValues(root, 'botB'), /./);
  });

  it('v1-Umschläge bleiben lesbar und werden beim Start auf v2 gehoben', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    mkdirSync(join(root, 'data', 'secrets'), { recursive: true, mode: 0o700 });
    // Echtes v1-Format nachbauen: AAD war nur der Schlüsselname.
    const mkV1 = (keyName, text) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(readFileSync(keyPath(root), 'utf8').trim(), 'hex'),
        iv,
      );
      cipher.setAAD(Buffer.from(keyName, 'utf8'));
      const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return `vault:v1:${iv.toString('base64')}:${cipher
        .getAuthTag()
        .toString('base64')}:${ct.toString('base64')}`;
    };
    writeFileSync(
      join(root, 'data', 'secrets', 'alt.env'),
      formatDotenv([
        ['DISCORD_BOT_TOKEN', mkV1('DISCORD_BOT_TOKEN', 'v1-geheim')],
      ]),
      { mode: 0o600 },
    );
    assert.equal(readSecretValues(root, 'alt').DISCORD_BOT_TOKEN, 'v1-geheim');
    const result = bootstrapSecretVault(root);
    assert.ok(
      result.sealed.includes('alt'),
      'Bootstrap muss v1-Datei hochziehen',
    );
    assert.ok(rawFile(root, 'alt').includes('vault:v2:'));
    assert.equal(readSecretValues(root, 'alt').DISCORD_BOT_TOKEN, 'v1-geheim');
    // Ein zurückgespielter v1-Umschlag bleibt lesbar (Abwärtskompatibilität)
    // wird aber beim nächsten Start wieder auf v2 gehoben – das Zeitfenster
    // für Verschiebungen ist damit der Migrationsstart.
    writeFileSync(
      join(root, 'data', 'secrets', 'alt.env'),
      formatDotenv([['DISCORD_BOT_TOKEN', mkV1('DISCORD_BOT_TOKEN', 'fremd')]]),
      { mode: 0o600 },
    );
    assert.equal(readSecretValues(root, 'alt').DISCORD_BOT_TOKEN, 'fremd');
    bootstrapSecretVault(root);
    assert.ok(rawFile(root, 'alt').includes('vault:v2:'));
  });
});

describe('bootstrapSecretVault – OAuth-Werte aus .env in den Vault', () => {
  it('ziehen DISCORD_CLIENT_SECRET & Co. um und der Vault gewinnt', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    process.env.DISCORD_CLIENT_ID = '123456789';
    process.env.DISCORD_CLIENT_SECRET = 'client-geheimnis';
    delete process.env.DISCORD_REDIRECT_URI;
    const first = bootstrapSecretVault(root);
    assert.deepEqual(first.migrated.sort(), [
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
    ]);
    const raw = rawFile(root, HUB_SECRET_ID);
    assert.ok(raw.includes('vault:v2:'));
    assert.ok(!raw.includes('client-geheimnis'));
    // Umzug ist einmalig, Vault-Werte überschreiben die Umgebung danach immer:
    delete process.env.DISCORD_CLIENT_SECRET;
    const second = bootstrapSecretVault(root);
    assert.deepEqual(second.migrated, []);
    assert.equal(process.env.DISCORD_CLIENT_SECRET, 'client-geheimnis');
  });

  it('ohne Vault-Key wird nicht umgezogen (kein Klartext-Duplikat)', () => {
    process.env.DISCORD_CLIENT_SECRET = 'client-geheimnis';
    const result = bootstrapSecretVault(root);
    assert.equal(result.enabled, false);
    assert.deepEqual(result.migrated, []);
  });

  it('_FILE-Indirektion verhindert das Duplikat im Vault', () => {
    writeKey(root);
    process.env.BOT_HUB_KEY_FILE = keyPath(root);
    process.env.DISCORD_CLIENT_SECRET = 'alt-aus-env';
    process.env.DISCORD_CLIENT_SECRET_FILE = join(root, 'secret-file');
    const result = bootstrapSecretVault(root);
    assert.ok(!result.migrated.includes('DISCORD_CLIENT_SECRET'));
  });
});
