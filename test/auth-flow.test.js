/**
 * Maßnahme 48 (Auftrag 5.6/6.3): die echte Anmeldekette – ohne
 * Authentifizierungsumgehung.
 *
 * Bislang lief die gesamte Suite mit `BOT_HUB_TEST_MODE=1`, und genau dieser
 * Modus schaltet `hasPermission` (immer true) und `requiresAuthentication`
 * (immer false) aus. State, PKCE-Verifizierer, Vorab-Cookie-Bindung,
 * Rollenvergabe und Widerruf waren damit nie durch einen echten HTTP-Pfad
 * gegangen – sie waren ungetestet, nicht bestehend.
 *
 * Dieser Block startet den Hub ohne Testmodus gegen eine Mock-Discord auf
 * 127.0.0.1 (siehe `discordApiBasis()` in server/auth.js: nur NODE_ENV=test,
 * nur Schleifenadresse, sonst hart discord.com). Die
 * Benutzer-Informationen sind frei erfundene Testwerte.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const CLIENT_ID = 'kuenstliche-client-id';
const CLIENT_SECRET = 'kunstliches-client-geheimnis';
const EIGE = 'kuenstliche-eigentuemer-id';
const ZUSCH = 'kuenstlicher-zuschauer-id';

/* ---------------------- Mock-Discord (nur Schleife) ---------------------- */

const protokolle = new Map(); // code -> { challenge, userId }
let mockPort = 0;
let mockAnfragen = 0;
let mock = null;

const jsonAnswer = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const mockStart = async () => {
  mock = httpServer(async (req, res) => {
    mockAnfragen += 1;
    const url = new URL(req.url, 'http://mock');
    if (url.pathname === '/api/v10/oauth2/token' && req.method === 'POST') {
      const brocken = [];
      for await (const brockenTeil of req) brocken.push(brockenTeil);
      const feld = new URLSearchParams(Buffer.concat(brocken).toString('utf8'));
      const eintrag = protokolle.get(feld.get('code') ?? '');
      if (!eintrag) return jsonAnswer(res, 400, { error: 'invalid_grant' });
      // Der Code ist einmalig – ein zweiter Tausch muss scheitern.
      protokolle.delete(feld.get('code'));
      if (
        feld.get('client_id') !== CLIENT_ID ||
        feld.get('client_secret') !== CLIENT_SECRET
      )
        return jsonAnswer(res, 401, { error: 'invalid_client' });
      if (feld.get('redirect_uri') !== process.env.DISCORD_REDIRECT_URI)
        return jsonAnswer(res, 400, { error: 'invalid_grant' });
      const probe = createHash('sha256')
        .update(feld.get('code_verifier') ?? '', 'utf8')
        .digest('base64url');
      if (probe !== eintrag.challenge)
        return jsonAnswer(res, 400, {
          error: 'invalid_request',
          fehler: 'PKCE-Pruefung fehlgeschlagen',
        });
      return jsonAnswer(res, 200, {
        access_token: `zugriffs-token-${eintrag.userId}`,
        token_type: 'Bearer',
        expires_in: 604_800,
        scope: 'identify guilds',
      });
    }
    const bearer = String(req.headers.authorization ?? '');
    const userId = bearer.replace('Bearer zugriffs-token-', '');
    if (
      bearer !== `Bearer zugriffs-token-${userId}` ||
      !['eige', 'zusch'].includes(userId)
    )
      return jsonAnswer(res, 401, { message: '401: Unauthorized' });
    if (url.pathname === '/api/v10/users/@me')
      return jsonAnswer(res, 200, {
        id: userId === 'eige' ? EIGE : ZUSCH,
        username: userId,
        global_name: userId === 'eige' ? 'Eigentümer' : 'Zuschauer',
        avatar: null,
      });
    if (url.pathname === '/api/v10/users/@me/guilds')
      return jsonAnswer(res, 200, [
        { id: 'gilde-1', name: 'Testgilde', icon: null, owner: false },
      ]);
    return jsonAnswer(res, 404, { message: 'unerwarteter Pfad' });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockPort = mock.address().port;
};

/* ------------------------------- Hub-Instanz ------------------------------ */

let hub = null;
let basis = '';
const sitzung = {}; // benutzer -> Cookie-Wert

/* Die Umgebung muss VOR dem Import des Managers stehen: `PROJECT_ROOT` (und
 * damit data/, bots/) wird beim Modul-Load aus BOT_DASHBOARD_ROOT gemacht. Ein
 * Setzen im `before()`-Hook käme zu spät und würde die Laufzeitdaten des
 * Arbeitsverzeichnisses beschreiben. */
process.env.NODE_ENV = 'test';
delete process.env.BOT_HUB_TEST_MODE; // der entscheidende Unterschied zu anderen Suiten
const root = mkdtempSync(join(tmpdir(), 'bot-hub-auth-flow-'));
process.env.BOT_DASHBOARD_ROOT = root;
process.env.BOT_HUB_DB = 'sqlite';
process.env.BOT_HUB_OWNER_IDS = EIGE;
process.env.DISCORD_CLIENT_ID = CLIENT_ID;
process.env.DISCORD_CLIENT_SECRET = CLIENT_SECRET;
delete process.env.DISCORD_REDIRECT_URI; // gleich, wenn der Port feststeht

const { __testing, createServer } = await import('../server/manager.js');
const { rateBuckets } = __testing;

before(async () => {
  // Isolierte Instanz, wie sie sein muss: eigener Root, keine Produktivdaten.
  assert.ok(
    String(process.env.BOT_DASHBOARD_ROOT).startsWith(root),
    'Der Hub darf nicht im Arbeitsverzeichnis schreiben',
  );
  await mockStart();
  hub = httpServer(createServer());
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  basis = `http://127.0.0.1:${hub.address().port}`;
  process.env.DISCORD_REDIRECT_URI = `${basis}/api/auth/discord/callback`;
  process.env.BOT_HUB_URL = basis;
  process.env.BOT_HUB_DISCORD_API = `http://127.0.0.1:${mockPort}/api/v10`;
});

after(async () => {
  hub?.closeAllConnections?.();
  hub?.close();
  mock?.close();
  rmSync(root, { recursive: true, force: true });
});

/** Rate-Eimer pro Block zurücksetzen: hier geht es um Identität, nicht ums Zählen. */
const frisch = () => rateBuckets.clear();

const hole = async (pfad, { cookie, methode = 'GET' } = {}) => {
  const antwort = await fetch(`${basis}${pfad}`, {
    method: methode,
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });
  const text = await antwort.text();
  let koerper = null;
  try {
    koerper = JSON.parse(text);
  } catch {
    /* HTML oder leer */
  }
  return {
    status: antwort.status,
    headers: antwort.headers,
    location: antwort.headers.get('location'),
    cookies: antwort.headers.getSetCookie(),
    text,
    koerper,
  };
};

/**
 * Echte Anmeldung über zwei Anfragen: Handshake (State + Challenge) und
 * Rückkehr mit Code. `verifizierer` darf bewusst falsch gestellt werden.
 */
const anmelden = async ({
  wer,
  verifizierer = null,
  vorabCookie = true,
  state = null,
  zustand,
  code = null,
} = {}) => {
  const start = await hole('/api/auth/discord/login');
  if (start.status !== 302) return { start, ziel: null };
  const parameter = new URL(start.location).searchParams;
  const benutzterState = state ?? parameter.get('state');
  const benutzterCode = code ?? `code-${Math.random().toString(36).slice(2)}`;
  // Für den Negativfall wird die Erwartung der Gegenstelle auf einen anderen
  // Verifizierer gestellt – der Hub schickt dann den seinen und scheitert.
  protokolle.set(benutzterCode, {
    challenge: verifizierer
      ? createHash('sha256').update(verifizierer, 'utf8').digest('base64url')
      : parameter.get('code_challenge'),
    userId: wer,
  });
  const rueckkehr = new URL(`${basis}/api/auth/discord/callback`);
  rueckkehr.searchParams.set('code', benutzterCode);
  rueckkehr.searchParams.set('state', benutzterState);
  if (zustand) rueckkehr.searchParams.set('error', zustand);
  const vorab = (start.cookies ?? []).find((wert) =>
    wert.startsWith('bot_hub_preauth='),
  );
  const ziel = await hole(`${rueckkehr.pathname}${rueckkehr.search}`, {
    cookie: vorabCookie && vorab ? vorab.split(';')[0] : undefined,
  });
  return { start, ziel, state: benutzterState, code: benutzterCode };
};

const mitSitzung = async (wer) => {
  const { ziel } = await anmelden({ wer });
  assert.equal(ziel.status, 302, `Anmeldung für ${wer} misslang: ${ziel.text}`);
  const wert = ziel.cookies.find((cookie) =>
    cookie.startsWith('bot_hub_session='),
  );
  assert.ok(wert, 'kein Sitzungs-Cookie gesetzt');
  sitzung[wer] = wert.split(';')[0];
  return sitzung[wer];
};

/* ------------------------------ Die Prüfungen ---------------------------- */

describe('Hub ohne Authentifizierungsumgehung', () => {
  it('die Test-Öse für Discord liegt nur im Testbetrieb und nur an der Schleife', async () => {
    // Bewusst kein Produktiv-Schalter: ein fremder OAuth-Endpunkt wäre ein
    // eigener Angriffsvektor. Nachweis über das Verhalten, nicht über Lesart.
    const { __testing: authTesting } = await import('../server/auth.js');
    const basisPruefen = authTesting.discordApiBasis;
    const vorher = process.env.BOT_HUB_DISCORD_API;
    const vorherEnv = process.env.NODE_ENV;
    try {
      for (const wert of [
        'https://discord.com/api/v10',
        'http://example.org:8080/api/v10',
        'http://198.51.100.7/api/v10',
        'http://eige.example/api/v10',
        '',
      ]) {
        process.env.NODE_ENV = 'test';
        process.env.BOT_HUB_DISCORD_API = wert;
        assert.equal(
          basisPruefen(),
          'https://discord.com/api/v10',
          `${wert} darf nicht durchkommen`,
        );
      }
      process.env.NODE_ENV = 'test';
      process.env.BOT_HUB_DISCORD_API = 'http://127.0.0.1:9999/api/v10';
      assert.equal(basisPruefen(), 'http://127.0.0.1:9999/api/v10');
      // Und selbst die Schleifenadresse hilft nicht außerhalb des Testbetriebs.
      process.env.NODE_ENV = 'production';
      assert.equal(
        basisPruefen(),
        'https://discord.com/api/v10',
        'Produktion darf nie umgebogen werden',
      );
    } finally {
      process.env.NODE_ENV = vorherEnv;
      if (vorher === undefined) delete process.env.BOT_HUB_DISCORD_API;
      else process.env.BOT_HUB_DISCORD_API = vorher;
    }
  });

  it('ohne Anmeldung ist jede geschützte Route dicht', async () => {
    frisch();
    for (const pfad of ['/api/bots', '/api/access', '/api/languages']) {
      const antwort = await hole(pfad);
      assert.equal(antwort.status, 401, `${pfad} ohne Sitzung`);
    }
    // Öffentliche Endpunkte bleiben ausdrücklich öffentlich – und geben nichts
    // über andere Benutzer her.
    const gesundheit = await hole('/api/health');
    assert.equal(gesundheit.status, 200);
    const sitzungInfo = await hole('/api/auth/session');
    assert.equal(sitzungInfo.status, 200);
    assert.equal(sitzungInfo.koerper.authenticated, false);
    assert.deepEqual(sitzungInfo.koerper.permissions, []);
    assert.deepEqual(sitzungInfo.koerper.users, undefined);
    // Ein geratenes Cookie hilft nicht.
    const geraten = await hole('/api/bots', {
      cookie: 'bot_hub_session=00000000-0000-4000-8000-000000000000',
    });
    assert.equal(geraten.status, 401);
  });

  it('der Handshake liefert State, PKCE und ein fest gebundenes Vorab-Cookie', async () => {
    frisch();
    const { start } = await anmelden({ wer: 'zusch' });
    assert.equal(start.status, 302);
    assert.match(
      start.location,
      /^https:\/\/discord\.com\/oauth2\/authorize\?/,
    );
    const parameter = new URL(start.location).searchParams;
    assert.equal(parameter.get('client_id'), CLIENT_ID);
    assert.equal(
      parameter.get('redirect_uri'),
      process.env.DISCORD_REDIRECT_URI,
    );
    assert.equal(parameter.get('code_challenge_method'), 'S256');
    assert.equal(parameter.get('scope'), 'identify guilds');
    assert.match(parameter.get('state'), /^[0-9a-f]{48}$/);
    assert.match(parameter.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
    // Zwei Handshakes erzeugen verschiedene Zustände.
    const zweiter = await hole('/api/auth/discord/login');
    assert.notEqual(
      new URL(zweiter.location).searchParams.get('state'),
      parameter.get('state'),
    );
    const vorab = start.cookies.find((wert) =>
      wert.startsWith('bot_hub_preauth='),
    );
    assert.match(vorab, /Path=\/api\/auth\/discord/);
    assert.match(vorab, /HttpOnly/);
    assert.match(vorab, /SameSite=Lax/);
    // Kein Secure auf reinem Loopback-http, aber mit BOT_HUB_SECURE_COOKIES=1
    // kommt es – der Schalter ist ja für den Proxy-Betrieb gedacht.
    assert.ok(!/Secure/.test(vorab));
    process.env.BOT_HUB_SECURE_COOKIES = '1';
    try {
      const mitSchalter = await hole('/api/auth/discord/login');
      assert.match(
        mitSchalter.cookies.find((wert) => wert.startsWith('bot_hub_preauth=')),
        /Secure/,
      );
    } finally {
      delete process.env.BOT_HUB_SECURE_COOKIES;
    }
  });

  it('der Zuschauer kommt an und darf nichts', async () => {
    frisch();
    const cookie = await mitSitzung('zusch');
    const info = await hole('/api/auth/session', { cookie });
    assert.equal(info.koerper.authenticated, true);
    assert.equal(info.koerper.user.id, ZUSCH);
    assert.equal(info.koerper.role, 'viewer');
    assert.deepEqual(info.koerper.permissions, []);
    assert.equal((await hole('/api/bots', { cookie })).status, 403);
    assert.equal((await hole('/api/access', { cookie })).status, 403);
    assert.equal(
      (await hole('/api/bots', { cookie, methode: 'POST' })).status,
      403,
    );
    // Und die Benutzerliste ist nicht einsehbar.
    const benutzerliste = await hole('/api/access', { cookie });
    assert.ok(!benutzerliste.text.includes(EIGE), 'fremde Kennung gespiegelt');
  });

  it('der Erste mit Eigentümer-Kennung wird Eigentümer, die Rolle wirkt sofort', async () => {
    frisch();
    const cookie = await mitSitzung('eige');
    const info = await hole('/api/auth/session', { cookie });
    assert.equal(info.koerper.role, 'owner');
    assert.ok(info.koerper.permissions.includes('access.manage'));
    assert.equal((await hole('/api/bots', { cookie })).status, 200);
    const liste = await hole('/api/access', { cookie });
    assert.equal(liste.status, 200);
    const kennungen = liste.koerper.users.map((eintrag) => eintrag.id);
    assert.deepEqual(kennungen.sort(), [EIGE, ZUSCH].sort());
    // Der zweite Login wird NICHT Eigentümer, obwohl BOT_HUB_OWNER_IDS nur
    // eine Person nennt und es schon einen Eigentümer gibt.
    assert.equal(
      liste.koerper.users.find((u) => u.id === ZUSCH).role,
      'viewer',
    );
  });

  it('die Sitzungskennung liegt nicht im Klartext auf der Platte', async () => {
    frisch();
    const cookie = sitzung.zusch ?? (await mitSitzung('zusch'));
    const wert = cookie.split('=')[1];
    const datei = readFileSync(join(root, 'data', 'sessions.json'), 'utf8');
    assert.ok(!datei.includes(wert), 'die Cookie-Kennung steht in der Datei');
    assert.match(datei, /sha256:[0-9a-f]{64}/);
    // Zwei verschiedene Anmeldungen, zwei Abdrücke.
    assert.equal(
      (datei.match(/sha256:[0-9a-f]{64}/g) ?? []).length,
      (datei.match(/"user"/g) ?? []).length,
    );
  });

  it('PKCE wird von der Gegenstelle geprüft – ein falscher Verifizierer scheitert', async () => {
    frisch();
    // Der Mock bekommt eine Challenge, zu der der Hub den falschen
    // Verifizierer mitschicken muss: der Tausch bricht ab, es entsteht keine
    // Sitzung.
    const { ziel } = await anmelden({ wer: 'zusch', verifizierer: 'falsch' });
    assert.equal(ziel.status, 502, ziel.text);
    assert.ok(
      !ziel.cookies.some((wert) => wert.startsWith('bot_hub_session=')),
      'trotz fehlgeschlagenen Tausches angemeldet',
    );
  });

  it('ein Zustand ist einmalig, ein Vorab-Cookie nicht ersetzbar', async () => {
    frisch();
    const erster = await anmelden({ wer: 'zusch' });
    assert.equal(erster.ziel.status, 302);
    // Dieselbe Rückkehr ein zweites Mal (der Code ist verbraucht, der Zustand
    // gelöscht): nur ein 400, nie eine zweite Sitzung.
    const wiederholt = await hole(
      `/api/auth/discord/callback?code=${erster.code}&state=${erster.state}`,
    );
    assert.equal(wiederholt.status, 400);
    assert.match(wiederholt.text, /abgelaufen|erneut anmelden/);

    frisch();
    const ohneVorab = await anmelden({ wer: 'zusch', vorabCookie: false });
    assert.equal(ohneVorab.ziel.status, 400);
    assert.match(ohneVorab.ziel.text, /Cookie/);

    frisch();
    const fremderZustand = await anmelden({
      wer: 'zusch',
      state: 'f'.repeat(48),
    });
    assert.equal(fremderZustand.ziel.status, 400);
    // Die Antwort nennt den Grund ("neu gestartet … zu alt"), aber nie den
    // Wert des Parameters selbst.
    assert.match(fremderZustand.ziel.text, /erneut anmelden/);
    assert.ok(!fremderZustand.ziel.text.includes('f'.repeat(48)));
  });

  it('Discord-Fehler werden bekannt gemeldet, nie ungefiltert gespiegelt', async () => {
    frisch();
    const abgebrochen = await anmelden({
      wer: 'zusch',
      zustand: 'access_denied',
    });
    assert.equal(abgebrochen.ziel.status, 400);
    assert.match(abgebrochen.ziel.text, /access_denied/);

    frisch();
    const eingeschleust = await anmelden({
      wer: 'zusch',
      zustand: '<script>alert(1)</script>',
    });
    assert.equal(eingeschleust.ziel.status, 400);
    assert.ok(
      !eingeschleust.ziel.text.includes('<script>'),
      `Fehlermeldung spiegelt die Eingabe: ${eingeschleust.ziel.text}`,
    );
    // Vor der Maßnahme lief ein unbekannter Fehlerwert ungenutzt durch und
    // die Anmeldung gelang trotzdem – genau das darf nicht mehr passieren.
    assert.ok(
      !eingeschleust.ziel.cookies.some((wert) =>
        wert.startsWith('bot_hub_session='),
      ),
      'trotz Fehler-Parameter eine Sitzung ausgestellt',
    );
    assert.equal(
      eingeschleust.ziel.headers.get('content-type'),
      'application/json; charset=utf-8',
    );
  });

  it('Zugang entfernen meldet den Besucher über HTTP sofort ab', async () => {
    frisch();
    const zuschauer = await mitSitzung('zusch');
    const eigentuemer = sitzung.eige ?? (await mitSitzung('eige'));
    assert.equal(
      (await hole('/api/auth/session', { cookie: zuschauer })).koerper
        .authenticated,
      true,
    );

    const entfernung = await fetch(`${basis}/api/access/${ZUSCH}`, {
      method: 'DELETE',
      headers: { cookie: `bot_hub_session=${eigentuemer.split('=')[1]}` },
    });
    assert.equal(entfernung.status, 200, await entfernung.text());

    // Die alte Sitzung ist tot – nicht „nur“ rechtlos.
    assert.equal(
      (await hole('/api/auth/session', { cookie: zuschauer })).koerper
        .authenticated,
      false,
    );
    assert.equal((await hole('/api/bots', { cookie: zuschauer })).status, 401);
    // Und sie legt den Benutzer nicht mehr als viewer neu an.
    const liste = await (
      await fetch(`${basis}/api/access`, {
        headers: { cookie: `bot_hub_session=${eigentuemer.split('=')[1]}` },
      })
    ).json();
    assert.deepEqual(
      liste.users.map((eintrag) => eintrag.id),
      [EIGE],
      'entfernter Benutzer ist zurückgekehrt',
    );
    const datei = readFileSync(join(root, 'data', 'sessions.json'), 'utf8');
    assert.ok(!datei.includes(zuschauer.split('=')[1]));
  });

  it('ein Rollenwechsel wirkt auf derselben Sitzung ohne Neuanmeldung', async () => {
    frisch();
    const zuschauer = await mitSitzung('zusch');
    const eigentuemer = sitzung.eige;
    assert.equal((await hole('/api/bots', { cookie: zuschauer })).status, 403);

    const aenderung = await fetch(`${basis}/api/access/${ZUSCH}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: `bot_hub_session=${eigentuemer.split('=')[1]}`,
      },
      body: JSON.stringify({ role: 'operator' }),
    });
    assert.equal(aenderung.status, 200, await aenderung.text());
    // Ohne einen einzigen neuen Login: dieselbe Cookie, jetzt mehr Rechte.
    assert.equal((await hole('/api/bots', { cookie: zuschauer })).status, 200);

    // Und wieder zurück – ebenso sofort.
    await fetch(`${basis}/api/access/${ZUSCH}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: `bot_hub_session=${eigentuemer.split('=')[1]}`,
      },
      body: JSON.stringify({ role: 'viewer' }),
    });
    assert.equal((await hole('/api/bots', { cookie: zuschauer })).status, 403);
  });

  it('botbezogene Rechte gelten genau für diesen Bot', async () => {
    frisch();
    const eigentuemer = sitzung.eige;
    const zuschauer = await mitSitzung('zusch');
    const bot = { id: '00000000-0000-4000-8000-000000000001' };
    await fetch(`${basis}/api/access/${ZUSCH}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        cookie: `bot_hub_session=${eigentuemer.split('=')[1]}`,
      },
      body: JSON.stringify({
        role: 'viewer',
        permissions: [],
        bots: { [bot.id]: { permissions: ['bots.read'] } },
      }),
    });
    // Auf diesem Bot darf er die Protokolle sehen, global aber nichts.
    const protokoll = await hole(`/api/bots/${bot.id}/logs?tail=5`, {
      cookie: zuschauer,
    });
    assert.notEqual(
      protokoll.status,
      403,
      'botbezogenes Recht wurde ignoriert',
    );
    // Der Bot ist nicht angelegt: 404 (Zugriff geprüft, dann nicht gefunden),
    // nicht 403 – ein ignoriertes botbezogenes Recht würde hier 403 liefern.
    assert.equal(
      (await hole(`/api/bots/${bot.id}`, { cookie: zuschauer })).status,
      404,
    );
    assert.equal(
      (await hole('/api/bots', { cookie: zuschauer })).status,
      403,
      'ohne globales Recht darf die Übersicht nicht kommen',
    );
  });

  it('die Idle-Frist meldet eine lebende Sitzung über HTTP ab', async () => {
    frisch();
    const cookie = await mitSitzung('zusch');
    assert.equal(
      (await hole('/api/auth/session', { cookie })).koerper.authenticated,
      true,
    );
    process.env.BOT_HUB_SESSION_IDLE_HOURS = '0.0002'; // ~0,7 s
    try {
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(
        (await hole('/api/auth/session', { cookie })).koerper.authenticated,
        false,
      );
      assert.equal((await hole('/api/bots', { cookie })).status, 401);
    } finally {
      delete process.env.BOT_HUB_SESSION_IDLE_HOURS;
    }
  });

  it('Abmeldung widerruft die Sitzung', async () => {
    frisch();
    const cookie = await mitSitzung('zusch');
    const abmeldung = await hole('/api/auth/logout', {
      cookie,
      methode: 'POST',
    });
    assert.equal(abmeldung.status, 200);
    assert.match(
      abmeldung.cookies.find((wert) => wert.startsWith('bot_hub_session=')),
      /Max-Age=0/,
    );
    assert.equal((await hole('/api/bots', { cookie })).status, 401);
  });

  it('die Mock-Discord wurde tatsächlich benutzt (kein Test an ihr vorbei)', async () => {
    assert.ok(
      mockAnfragen >= 9,
      `nur ${mockAnfragen} Anfragen bei der Gegenstelle – Kette nicht durchlaufen`,
    );
  });
});
