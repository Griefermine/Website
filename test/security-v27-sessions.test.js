/**
 * Maßnahme 45 (V27-A): Sitzungs-Speicherung, Idle-Frist, Widerruf und
 * botbezogene Rechte.
 *
 * Jeder Block hält ein Verhalten fest, das vor der Maßnahme nachweislich
 * anders war (im Code verifiziert, Auftrag 5.7):
 *  1. `data/sessions.json` enthielt die gültigen Session-IDs im Klartext –
 *     die Datei war ohne weiteren Zugriff ein Anmeldesatz.
 *  2. Es gab nur eine absolute Laufzeit von sieben Tagen, keine Idle-Frist.
 *  3. `removeAccess` löschte nur den Rechtseintrag; die bereits ausgestellte
 *     Sitzung blieb gültig und legte den Benutzer über `ensureAccessUser`
 *     als Viewer wieder in `access.json` ab.
 *  4. Botbezogene Rechte waren im Schreibpfad auf die Rechte-Menge der
 *     Zielrolle gefiltert – für `viewer` (= []) also gar nicht setzbar,
 *     obwohl die Laufzeit sie seit Maßnahme 37 ausdrücklich unterstützt.
 *
 * `BOT_HUB_TEST_MODE` würde `hasPermission` pauschal auf true ziehen und ist
 * hier ausdrücklich AUSgeschaltet; ohne Vault-Key wird geprüft, weil genau
 * der Klartext-Fall ohne Schlüssel die Lücke war.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

delete process.env.BOT_HUB_TEST_MODE;
delete process.env.BOT_HUB_KEY_FILE;

const HOUR = 60 * 60 * 1000;
/** derselbe Abdruck, den server/auth.js als Speicher-Schlüssel verwendet */
const digest = (value) =>
  `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;

const auth = await import('../server/auth.js');

/**
 * Baut eine isolierte Instanz aus Zugriffs- und Sitzungsdatei. Die
 * Sitzungsdatei wird bewusst im ALTEN Format geschrieben (rohe Session-ID als
 * Schlüssel, ohne `createdAt`/`lastSeenAt`): das ist gleichzeitig der
 * Migrationsnachweis für jeden Block.
 */
const instanz = ({ users = {}, sessions = {} }) => {
  const root = mkdtempSync(join(tmpdir(), 'v27-sessions-'));
  const accessPath = join(root, 'access.json');
  const sessionPath = join(root, 'sessions.json');
  writeFileSync(accessPath, JSON.stringify({ users }, null, 2));
  writeFileSync(sessionPath, JSON.stringify(sessions, null, 2));
  auth.configureAccess(accessPath);
  auth.configureSessionStore(sessionPath);
  return {
    root,
    sessionPath,
    accessPath,
    stored: () => readFileSync(sessionPath, 'utf8'),
    reqFor: (sessionId) => ({
      headers: { cookie: `bot_hub_session=${sessionId}` },
    }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

/* Spiegelung von `ACCESS_ROLES` aus server/auth.js. Die Tests brauchen
 * Einträge, so wie das Produkt sie schreibt: `ensureAccessUser` und
 * `updateAccess` speichern immer die Rechte-Menge der Rolle als Liste –
 * `effectivePermissions` schneidet die Liste mit der Rolle, ein leeres Feld
 * bedeutet also „nichts“, nicht „Rollenstandard“. Rutscht diese Spiegelung
 * weg, fallen die Zugriffs-Assertions der Blöcke auf. */
const ALLE = [
  'bots.read',
  'bots.manage',
  'bots.control',
  'bots.delete',
  'bots.restart',
  'logs.read',
  'panel.read',
  'panel.manage',
  'access.manage',
  'files.read',
  'files.write',
  'files.upload',
  'files.delete',
];
const ROLLEN = {
  owner: ALLE,
  admin: ALLE,
  operator: ALLE.filter((p) => p !== 'bots.delete' && p !== 'access.manage'),
  viewer: [],
};

const userEntry = (id, role, permissions = ROLLEN[role], bots = {}) => ({
  id,
  name: id,
  username: id,
  role,
  permissions: [...permissions],
  bots,
  updatedAt: Date.now(),
});

const sitter = (userId, extra = {}) => ({
  user: { id: userId, name: userId, username: userId },
  guilds: [],
  expiresAt: Date.now() + 24 * HOUR,
  ...extra,
});

/** Umgebungswerte nur für einen Block setzen und danach zurückgeben. */
const withEnv = async (values, run) => {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const OWNER = 'owner-1';
const OWNER_COOKIE = 'rohe-sitzungskennung-eigentuemer';

/* ------------------------------------------------------------------ *
 * 1. Abdruck statt Klartext – mit lückenloser Migration
 * ------------------------------------------------------------------ */
test('sessions.json enthält keine auslieferbare Session-ID mehr', async () => {
  const roh = 'rohe-sitzungskennung-migration';
  const app = instanz({
    users: { [OWNER]: userEntry(OWNER, 'owner') },
    sessions: { [roh]: sitter(OWNER) },
  });
  try {
    // Alte Anmeldung funktioniert nach dem Umstieg weiter …
    assert.equal(auth.hasPermission(app.reqFor(roh), 'bots.read'), true);
    // … aber die Datei enthält nur noch den Abdruck, nie die ID selbst.
    const saved = app.stored();
    assert.ok(
      !saved.includes(roh),
      'Klartext-ID darf nicht mehr auf der Platte stehen',
    );
    assert.ok(
      saved.includes(digest(roh)),
      'Speicher-Schlüssel muss der Abdruck sein',
    );
    // Neustart nach simuliertem Hub-Neustart: Anmeldung hält weiterhin.
    auth.configureSessionStore(app.sessionPath);
    assert.equal(auth.hasPermission(app.reqFor(roh), 'bots.read'), true);
    assert.equal(auth.currentUser(app.reqFor(roh))?.id, OWNER);
  } finally {
    app.cleanup();
  }
});

test('eine bekannte ID ist nach einmaliger Migration kein Zweittreffer', async () => {
  const roh = 'rohe-sitzungskennung-doppelt';
  const app = instanz({
    users: { [OWNER]: userEntry(OWNER, 'owner') },
    sessions: { [roh]: sitter(OWNER) },
  });
  try {
    auth.configureSessionStore(app.sessionPath);
    // Wer die Datei kopiert HAT, bekommt durch den Abdruck nichts mehr: die
    // ID selbst steht nirgends, und ein Rate-Raten von außen wäre 2^256.
    assert.ok(!app.stored().includes('rohe-sitzungskennung'));
    assert.equal(auth.currentUser(app.reqFor('geraten-cookie')), null);
  } finally {
    app.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 2. Idle-Frist und absolute Obergrenze
 * ------------------------------------------------------------------ */
test('ungenutzte Sitzung meldet sich nach der Idle-Frist ab', async () => {
  const alt = 'rohe-sitzungskennung-alt';
  const frisch = 'rohe-sitzungskennung-frisch';
  const app = instanz({
    users: { [OWNER]: userEntry(OWNER, 'owner') },
    sessions: {
      [alt]: sitter(OWNER, {
        createdAt: Date.now() - 5 * HOUR,
        lastSeenAt: Date.now() - 5 * HOUR,
      }),
      [frisch]: sitter(OWNER, {
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      }),
    },
  });
  try {
    await withEnv({ BOT_HUB_SESSION_IDLE_HOURS: 1 }, () => {
      assert.equal(
        auth.currentUser(app.reqFor(alt)),
        null,
        '5 h ohne Nutzung bei 1 h Frist',
      );
      assert.notEqual(auth.currentUser(app.reqFor(frisch)), null);
    });
    // Die abgelaufene Sitzung ist nicht nur abgewiesen, sondern weg.
    assert.ok(
      !app.stored().includes(digest(alt)),
      'widerrufene Sitzung muss aus der Datei',
    );
    assert.ok(app.stored().includes(digest(frisch)));
  } finally {
    app.cleanup();
  }
});

test('eine unzulässige Idle-Angabe kippt nicht auf „läuft nie ab“', async () => {
  const roh = 'rohe-sitzungskennung-quoten';
  const app = instanz({
    users: { [OWNER]: userEntry(OWNER, 'owner') },
    sessions: {
      [roh]: sitter(OWNER, {
        createdAt: Date.now() - 10 * 24 * HOUR,
        lastSeenAt: Date.now() - 10 * 24 * HOUR,
        expiresAt: Date.now() + 100 * 24 * HOUR,
      }),
    },
  });
  try {
    await withEnv({ BOT_HUB_SESSION_IDLE_HOURS: 'vierundzwanzig' }, () => {
      // Ungültiger Wert -> Default (72 h), nicht „nie“ und nicht „sofort“.
      assert.equal(auth.currentUser(app.reqFor(roh)), null);
    });
    await withEnv({ BOT_HUB_SESSION_IDLE_HOURS: 0 }, () => {
      // 0 wäre „dauerhaft gültig“ – ebenfalls kein Freifahrtschein.
      assert.equal(auth.currentUser(app.reqFor(roh)), null);
    });
  } finally {
    app.cleanup();
  }
});

test('Altbestand ohne Zeitstempel wird nicht nachträglich abgemeldet', async () => {
  const roh = 'rohe-sitzungskennung-neustart';
  const app = instanz({
    users: { [OWNER]: userEntry(OWNER, 'owner') },
    sessions: { [roh]: sitter(OWNER) },
  });
  try {
    await withEnv({ BOT_HUB_SESSION_IDLE_HOURS: 72 }, () => {
      assert.notEqual(auth.currentUser(app.reqFor(roh)), null);
      const eintrag = () => JSON.parse(app.stored())[digest(roh)];
      // Der gesiehene Fortschritt wird festgehalten …
      assert.equal(typeof eintrag().lastSeenAt, 'number');
      // … `createdAt` gibt es bei einer Übernahme nicht, und das ist korrekt:
      // der Wert wird nicht erfunden, die Idle-Frist läuft ab dem ersten
      // Zugriff. Ein erfundenes „gerade erst angelegt“ wäre eine still-
      // schweigende Verlängerung alter Anmeldungen.
      assert.equal(eintrag().createdAt, undefined);
      // Hub-Neustart: die Idle-Frist gilt anhand der Datei weiter, nicht
      // von vorn.
      auth.configureSessionStore(app.sessionPath);
      assert.notEqual(auth.currentUser(app.reqFor(roh)), null);
      assert.equal(typeof eintrag().lastSeenAt, 'number');
    });
  } finally {
    app.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 3. Widerruf: Zugang entfernen meldet ab und bleibt entfernt
 * ------------------------------------------------------------------ */
test('Zugang entfernen widerruft die Sitzung des Entfernten', async () => {
  const suX = 'rohe-sitzungskennung-x';
  const app = instanz({
    users: {
      [OWNER]: userEntry(OWNER, 'owner'),
      'user-x': userEntry('user-x', 'operator', ['bots.read']),
    },
    sessions: { [OWNER_COOKIE]: sitter(OWNER), [suX]: sitter('user-x') },
  });
  try {
    const reqX = app.reqFor(suX);
    assert.equal(auth.hasPermission(reqX, 'bots.read'), true);

    auth.removeAccess('user-x', OWNER);

    assert.equal(auth.currentUser(reqX), null, 'Sitzung muss widerrufen sein');
    assert.equal(auth.hasPermission(reqX, 'bots.read'), false);
    assert.equal(
      auth.publicAccess('user-x'),
      null,
      'Benutzer darf nicht neu angelegt werden',
    );
    // Zweiter, dritter Request: der Rechtseintrag bleibt weg (kein
    // viewer-Nachwuchs durch ensureAccessUser).
    auth.hasPermission(reqX, 'bots.read');
    auth.hasPermission(reqX, 'bots.read');
    assert.equal(auth.publicAccess('user-x'), null);
    assert.equal(
      Object.keys(JSON.parse(readFileSync(app.accessPath, 'utf8')).users)
        .length,
      1,
    );
    // Nur die betroffene Sitzung ist weg, die des Eigentümers bleibt gültig.
    assert.ok(!app.stored().includes(digest(suX)));
    assert.ok(app.stored().includes(digest(OWNER_COOKIE)));
    assert.equal(
      auth.hasPermission(app.reqFor(OWNER_COOKIE), 'access.manage'),
      true,
    );
  } finally {
    app.cleanup();
  }
});

test('Rollenwechsel wirkt sofort, ohne die Sitzung abzumelden', async () => {
  const roh = 'rohe-sitzungskennung-rollenwechsel';
  const app = instanz({
    users: {
      [OWNER]: userEntry(OWNER, 'owner'),
      'user-y': userEntry('user-y', 'operator', ['bots.read']),
    },
    sessions: { [OWNER_COOKIE]: sitter(OWNER), [roh]: sitter('user-y') },
  });
  try {
    const reqY = app.reqFor(roh);
    assert.equal(auth.hasPermission(reqY, 'bots.read'), true);

    auth.updateAccess('user-y', { role: 'viewer', permissions: [] }, OWNER);

    assert.equal(auth.hasPermission(reqY, 'bots.read'), false);
    // Die Sitzung selbst besteht weiter – es sind nur die Rechte weg.
    assert.equal(auth.currentUser(reqY)?.id, 'user-y');
    assert.ok(app.stored().includes(digest(roh)));
  } finally {
    app.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * 4. Botbezogene Rechte: auch für `viewer`, aber nie über die eigene
 *    Grenze des Handelnden hinaus
 * ------------------------------------------------------------------ */
test('viewer kann botbezogene Rechte erhalten – exakt die des Handelnden', async () => {
  const rohZ = 'rohe-sitzungskennung-z';
  const rohActor = 'rohe-sitzungskennung-aktor';
  const app = instanz({
    users: {
      [OWNER]: userEntry(OWNER, 'owner'),
      // Admin, der selbst nur Lesen und Steuern darf.
      aktor: userEntry('aktor', 'admin', ['bots.read', 'bots.control']),
      'user-z': userEntry('user-z', 'viewer'),
    },
    sessions: {
      [OWNER_COOKIE]: sitter(OWNER),
      [rohActor]: sitter('aktor'),
      [rohZ]: sitter('user-z'),
    },
  });
  try {
    const result = auth.updateAccess(
      'user-z',
      {
        role: 'viewer',
        permissions: [],
        bots: {
          'bot-a': {
            permissions: ['bots.read', 'bots.control', 'bots.delete'],
          },
        },
      },
      'aktor',
    );
    // bots.delete kann der Handelnde nicht vergeben – er hat es nicht.
    assert.deepEqual(result.bots['bot-a'].permissions.sort(), [
      'bots.control',
      'bots.read',
    ]);
    assert.equal(
      JSON.parse(readFileSync(app.accessPath, 'utf8')).users['user-z'].bots[
        'bot-a'
      ].permissions.includes('bots.delete'),
      false,
      'nicht persistente Elevation',
    );

    // Und die Laufzeit setzt es um: auf bot-a ja, auf bot-b und global nein.
    const reqZ = app.reqFor(rohZ);
    assert.equal(
      auth.hasPermission(reqZ, 'bots.control', { botId: 'bot-a' }),
      true,
    );
    assert.equal(
      auth.hasPermission(reqZ, 'bots.read', { botId: 'bot-a' }),
      true,
    );
    assert.equal(
      auth.hasPermission(reqZ, 'bots.control', { botId: 'bot-b' }),
      false,
    );
    assert.equal(auth.hasPermission(reqZ, 'bots.read'), false);
    assert.equal(auth.hasPermission(reqZ, 'access.manage'), false);

    // Der Eigentümer darf dagegen alles, was er selbst hat.
    const all = auth.updateAccess(
      'user-z',
      {
        role: 'viewer',
        permissions: [],
        bots: { 'bot-a': { permissions: ['bots.read', 'bots.delete'] } },
      },
      OWNER,
    );
    assert.deepEqual(all.bots['bot-a'].permissions.sort(), [
      'bots.delete',
      'bots.read',
    ]);
  } finally {
    app.cleanup();
  }
});

test('globale Rechte bleiben trotzdem auf die Zielrolle begrenzt', async () => {
  const app = instanz({
    users: {
      [OWNER]: userEntry(OWNER, 'owner'),
      'user-w': userEntry('user-w', 'viewer'),
    },
    sessions: { [OWNER_COOKIE]: sitter(OWNER) },
  });
  try {
    const result = auth.updateAccess(
      'user-w',
      { role: 'viewer', permissions: ['access.manage', 'bots.delete'] },
      OWNER,
    );
    // viewer hat keine globalen Rechte – auch nicht, wenn welche gewünscht werden.
    assert.deepEqual(result.permissions, []);
    assert.equal(
      auth.hasPermission(app.reqFor(OWNER_COOKIE), 'access.manage'),
      true,
    );
  } finally {
    app.cleanup();
  }
});

test('ein nicht vorhandener Zugang kann nicht geändert werden', async () => {
  const app = instanz({
    users: { [OWNER]: userEntry(OWNER, 'owner') },
    sessions: { [OWNER_COOKIE]: sitter(OWNER) },
  });
  try {
    assert.throws(() => auth.updateAccess('niemand', { role: 'admin' }, OWNER));
    assert.throws(() => auth.removeAccess('niemand', OWNER));
  } finally {
    app.cleanup();
  }
});
