/**
 * Unit-Tests für server/preflight.js: Bind-Host-Auflösung (P1-D) und
 * Produktions-Härtungsprüfung (P1-A) – ohne Network, Docker oder echte
 * data/secrets-Dateien.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LOOPBACK_HOSTS,
  collectSecurityFindings,
  resolveBindHost,
} from '../server/preflight.js';

const zustand = (pfad) => {
  try {
    return statSync(pfad);
  } catch {
    return { mode: 0 };
  }
};

/** Präfix im tmp-Verzeichnis: data/secrets exists nur, wenn wir sie anlegen. */
const funde = (projekt, zusätzlich = {}) =>
  collectSecurityFindings({
    env: { NODE_ENV: 'production' },
    projectRoot: projekt,
    facts: { hubRunsAsRoot: false, unpinnedImages: [], digestRequired: false },
    exists: (pfad) =>
      pfad === '/var/run/docker.sock' ? false : statSyncVorhanden(pfad),
    stat: (pfad) => zustand(pfad),
    ...zusätzlich,
  });

const statSyncVorhanden = (pfad) => {
  try {
    statSync(pfad);
    return true;
  } catch {
    return false;
  }
};

const mitTemp = async (aufgabe) => {
  const projekt = mkdtempSync(join(tmpdir(), 'bot-hub-preflight-'));
  try {
    return await aufgabe(projekt);
  } finally {
    rmSync(projekt, { recursive: true, force: true });
  }
};

/* -------------------------- P1-D: Bind-Host -------------------------- */

test('ohne HOST bindet der Hub an loopback', () => {
  const bind = resolveBindHost({ NODE_ENV: 'development' });
  assert.equal(bind.host, '127.0.0.1');
  assert.deepEqual(bind.errors, []);
  assert.deepEqual(bind.warnings, []);
});

test('Produktion lehnt jede nicht-lokale Adresse ab', () => {
  for (const wert of ['0.0.0.0', '::', '192.168.10.40', 'example.test']) {
    const bind = resolveBindHost({ NODE_ENV: 'production', HOST: wert });
    assert.ok(bind.errors.length > 0, `${wert} wurde ohne Fehler angenommen`);
    assert.match(bind.errors[0], /Reverse-Proxy/);
  }
});

test('Produktion akzeptiert alle Loopback-Varianten', () => {
  for (const wert of LOOPBACK_HOSTS) {
    const bind = resolveBindHost({ NODE_ENV: 'production', HOST: wert });
    assert.deepEqual(bind.errors, [], `${wert} abgelehnt`);
    assert.equal(bind.host, wert);
  }
});

test('externes Binden außerhalb von Tests warnt', () => {
  const bind = resolveBindHost({ NODE_ENV: 'development', HOST: '0.0.0.0' });
  assert.equal(bind.host, '0.0.0.0');
  assert.deepEqual(bind.errors, []);
  assert.equal(bind.warnings.length, 1);
  assert.match(bind.warnings[0], /Netzwerk/);
});

test('Testszenario schweigt bewusst (sonst wäre jeder Lauf voll Warnungen)', () => {
  assert.deepEqual(
    resolveBindHost({ NODE_ENV: 'test', HOST: '0.0.0.0' }).warnings,
    [],
  );
  assert.deepEqual(
    resolveBindHost({
      NODE_ENV: 'development',
      BOT_HUB_TEST_MODE: '1',
      HOST: '0.0.0.0',
    }).warnings,
    [],
  );
});

/* ---------------------- P1-A: Rechte an data/ ------------------------ */

test('offenes data/secrets bricht den Produktionsstart', () =>
  mitTemp((projekt) => {
    const geheimnisse = join(projekt, 'data', 'secrets');
    mkdirSync(geheimnisse, { recursive: true, mode: 0o755 });
    chmodSync(geheimnisse, 0o755);
    const ergebnis = funde(projekt);
    assert.equal(ergebnis.errors.length, 1, JSON.stringify(ergebnis));
    assert.match(
      ergebnis.errors[0],
      /data\/secrets\/ ist für andere Benutzer lesbar/,
    );
  }));

test('Gruppen-Schreibrecht auf data/secrets ist ebenfalls ein Abbruch', () =>
  mitTemp((projekt) => {
    const geheimnisse = join(projekt, 'data', 'secrets');
    mkdirSync(geheimnisse, { recursive: true, mode: 0o770 });
    chmodSync(geheimnisse, 0o770);
    const ergebnis = funde(projekt);
    assert.equal(ergebnis.errors.length, 1, JSON.stringify(ergebnis));
    assert.match(ergebnis.errors[0], /für die Gruppe schreibbar/);
    assert.match(ergebnis.errors[0], /700/);
  }));

test('dichte Rechte erzeugen keinen Fehler', () =>
  mitTemp((projekt) => {
    const geheimnisse = join(projekt, 'data', 'secrets');
    mkdirSync(geheimnisse, { recursive: true, mode: 0o700 });
    chmodSync(geheimnisse, 0o700);
    writeFileSync(join(geheimnisse, 'bot1.env'), 'x', { mode: 0o600 });
    const ergebnis = funde(projekt);
    assert.deepEqual(ergebnis.errors, [], JSON.stringify(ergebnis));
  }));

test('ein Symlink statt data/secrets ist ein Abbruch', () =>
  mitTemp((projekt) => {
    const wirklich = join(projekt, 'anderer-ort');
    mkdirSync(wirklich, { recursive: true, mode: 0o700 });
    mkdirSync(join(projekt, 'data'), { recursive: true, mode: 0o700 });
    symlinkSync(wirklich, join(projekt, 'data', 'secrets'));
    const ergebnis = funde(projekt);
    assert.equal(ergebnis.errors.length, 1, JSON.stringify(ergebnis));
    assert.match(ergebnis.errors[0], /ist ein Symlink/);
  }));

test('fremder Besitzer an data/secrets lehnt die Produktion ab', () => {
  const grund = {
    projectRoot: '/projekt',
    facts: { hubRunsAsRoot: false, unpinnedImages: [], digestRequired: false },
    exists: (pfad) => pfad === '/projekt/data/secrets',
    stat: () => ({ mode: 0o700, uid: 999997 }),
    lstat: () => ({ isSymbolicLink: () => false }),
    aktuelleBenutzerkennung: 1000,
  };
  const produktion = collectSecurityFindings({
    ...grund,
    env: { NODE_ENV: 'production' },
  });
  assert.equal(produktion.errors.length, 1, JSON.stringify(produktion));
  assert.match(
    produktion.errors[0],
    /gehört nicht dem Benutzer des Hub-Prozesses/,
  );

  // Derselbe Fall außerhalb der Produktion: Warnung, kein Abbruch.
  const developer = collectSecurityFindings({
    ...grund,
    env: { NODE_ENV: 'development' },
  });
  assert.deepEqual(developer.errors, []);
  assert.equal(developer.warnings.length, 1, JSON.stringify(developer));
});

test('ein offenes data/ „nur“ eine Warnung, ein offenes data/secrets nicht', () =>
  mitTemp((projekt) => {
    const daten = join(projekt, 'data');
    mkdirSync(daten, { recursive: true, mode: 0o755 });
    chmodSync(daten, 0o755);
    const ergebnis = funde(projekt);
    assert.deepEqual(ergebnis.errors, [], JSON.stringify(ergebnis));
    assert.ok(
      ergebnis.warnings.some((text) => text.includes('data/')),
      JSON.stringify(ergebnis.warnings),
    );
  }));

/* ------------------- Images, root, .env, Docker-Sock ----------------- */

test('Images ohne Digest sind in Produktion Fehler, sonst Warnung', () => {
  const bilder = [{ language: 'python', reference: 'python:3.12-bookworm' }];
  const scharf = collectSecurityFindings({
    env: { NODE_ENV: 'production' },
    projectRoot: '/nicht/vorhanden',
    facts: { unpinnedImages: bilder, digestRequired: false },
    exists: () => false,
    stat: () => ({ mode: 0o700 }),
  });
  assert.equal(scharf.errors.length, 1, JSON.stringify(scharf));
  assert.match(scharf.errors[0], /Digest/);

  const developer = collectSecurityFindings({
    env: { NODE_ENV: 'development' },
    projectRoot: '/nicht/vorhanden',
    facts: { unpinnedImages: bilder, digestRequired: false },
    exists: () => false,
    stat: () => ({ mode: 0o700 }),
  });
  assert.deepEqual(developer.errors, []);
  assert.deepEqual(developer.warnings, []);

  const verlangt = collectSecurityFindings({
    env: { NODE_ENV: 'development' },
    projectRoot: '/nicht/vorhanden',
    facts: { unpinnedImages: bilder, digestRequired: true },
    exists: () => false,
    stat: () => ({ mode: 0o700 }),
  });
  assert.equal(verlangt.errors.length, 1);
  assert.match(verlangt.errors[0], /BOT_HUB_REQUIRE_IMAGE_DIGEST/);
});

test('root-Hub und Docker-Sockel werden gemeldet', () => {
  const ergebnis = collectSecurityFindings({
    env: { NODE_ENV: 'production' },
    projectRoot: '/nicht/vorhanden',
    facts: { hubRunsAsRoot: true, unpinnedImages: [] },
    exists: (pfad) => pfad === '/var/run/docker.sock',
    stat: () => ({ mode: 0o700 }),
  });
  assert.equal(ergebnis.errors.length, 1, JSON.stringify(ergebnis));
  assert.match(ergebnis.errors[0], /läuft als root/);
  assert.ok(
    ergebnis.warnings.some((text) => text.includes('Docker Socket')),
    JSON.stringify(ergebnis.warnings),
  );
});

test('belegte .env im Projekt-Root ist eine Warnung, nie ein Geheimnis-Fehler', () =>
  mitTemp((projekt) => {
    writeFileSync(
      join(projekt, '.env'),
      'DISCORD_BOT_TOKEN=abc.def.ghi\nLEERE_ZEILE=\n',
    );
    const ergebnis = funde(projekt);
    assert.deepEqual(ergebnis.errors, [], JSON.stringify(ergebnis));
    assert.ok(
      ergebnis.warnings.some((text) => text.includes('.env')),
      JSON.stringify(ergebnis.warnings),
    );
    // Die Warnung nennt niemals den Wert selbst.
    assert.ok(
      !ergebnis.warnings.join(' ').includes('abc.def.ghi'),
      'Warnung gibt ein Secret aus',
    );
    // Ohne .env (exists => false) fällt die .env-Warnung weg, die Meldung über
    // ein noch fehlendes data/secrets/ bleibt als Hinweis bestehen.
    const leer = collectSecurityFindings({
      env: { NODE_ENV: 'production' },
      projectRoot: projekt,
      facts: {
        hubRunsAsRoot: false,
        unpinnedImages: [],
        digestRequired: false,
      },
      exists: () => false,
      stat: () => ({ mode: 0o700 }),
    });
    assert.deepEqual(leer.errors, []);
    assert.ok(!leer.warnings.some((text) => text.includes('.env')));
    assert.ok(
      leer.warnings.some((text) => text.includes('data/secrets/ fehlt')),
      JSON.stringify(leer.warnings),
    );
  }));
