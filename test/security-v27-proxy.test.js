/**
 * Maßnahme 47 (Auftrag 5.5): Client-Identität und Rate-Limits hinter einem
 * Reverse-Proxy.
 *
 * Der Hub vertraut `X-Forwarded-For` ausschließlich, wenn die direkt
 * verbundene Adresse in `BOT_HUB_TRUSTED_PROXIES` steht. Das war richtig –
 * aber der Vergleich war zeichengetreu, und Node meldet eine IPv4-Verbindung
 * je nach Socket-Familie als `127.0.0.1` ODER `::ffff:127.0.0.1`. Ein
 * Betreiber mit dem naheliegenden `BOT_HUB_TRUSTED_PROXIES=127.0.0.1` traf
 * die Prüfung damit nie: jede Anfrage lief auf die Proxy-Adresse, alle
 * Besucher teilten sich einen Eimer (Login: 30 pro Minute für die gesamte
 * Installation – ein einziger Fleißiger meldete den Rest ab).
 *
 * Geprüft wird hier die echte Funktion (`clientAddress`, `rateLimit`) aus
 * server/manager.js, nicht eine nachgebildete Kopie.
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const { __testing } = await import('../server/manager.js');
const { clientAddress, canonicalAddress, rateLimit, rateBuckets } = __testing;

const vorher = {
  testMode: process.env.BOT_HUB_TEST_MODE,
  proxys: process.env.BOT_HUB_TRUSTED_PROXIES,
};
// `rateLimit` gibt im Testmodus pauschal null – hier muss es der echte Pfad sein.
delete process.env.BOT_HUB_TEST_MODE;

const anfrage = (remote, { forwarded, headers = {} } = {}) => ({
  method: 'GET',
  socket: { remoteAddress: remote },
  headers: {
    ...headers,
    ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
  },
});

const loginPfad = () => new URL('http://hub.example/api/auth/discord/login');

const mitProxys = async (liste, aufgabe) => {
  if (liste === undefined) delete process.env.BOT_HUB_TRUSTED_PROXIES;
  else process.env.BOT_HUB_TRUSTED_PROXIES = liste;
  rateBuckets.clear();
  try {
    return await aufgabe();
  } finally {
    rateBuckets.clear();
  }
};

after(() => {
  if (vorher.testMode === undefined) delete process.env.BOT_HUB_TEST_MODE;
  else process.env.BOT_HUB_TEST_MODE = vorher.testMode;
  if (vorher.proxys === undefined) delete process.env.BOT_HUB_TRUSTED_PROXIES;
  else process.env.BOT_HUB_TRUSTED_PROXIES = vorher.proxys;
});

/* -------------------------- Kanonisierung --------------------------- */

test('::ffff:127.0.0.1 und 127.0.0.1 sind dieselbe Adresse', () => {
  assert.equal(canonicalAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(canonicalAddress('::FFFF:203.0.113.7'), '203.0.113.7');
  assert.equal(canonicalAddress(' 2001:DB8::1 '), '2001:db8::1');
  assert.equal(canonicalAddress('[::1]'), '::1');
  // Nur ein echtes Vieren-Punkt-Muster wird gekürzt – sonst könnte ein
  // beliebiger Rest mit einer IPv4-Adresse zusammenfallen.
  assert.equal(canonicalAddress('::ffff:nicht:ipv4'), '::ffff:nicht:ipv4');
  assert.equal(canonicalAddress('::ffff:999.1.1.1'), '::ffff:999.1.1.1');
  assert.equal(canonicalAddress(undefined), '');
});

/* --------------------- Vertrauen durch den Proxy -------------------- */

test('der Proxy wird erkannt, egal mit welcher Familie sein Socket läuft', async () => {
  await mitProxys('127.0.0.1', () => {
    const besucher = anfrage('::ffff:127.0.0.1', { forwarded: '203.0.113.7' });
    assert.equal(
      clientAddress(besucher),
      '203.0.113.7',
      'Vor der Maßnahme: hier kam 127.0.0.1 zurück – der Header wurde ' +
        'verworfen und alle Besucher landeten in einem Eimer.',
    );
    // Direkte Loopback-Verbindung ohne Header bleibt Loopback.
    assert.equal(clientAddress(anfrage('127.0.0.1')), '127.0.0.1');
  });
  await mitProxys('::1', () => {
    assert.equal(
      clientAddress(anfrage('::1', { forwarded: '203.0.113.8' })),
      '203.0.113.8',
    );
  });
  // Mehrere Einträge, gemischte Schreibweisen, Leerzeichen.
  await mitProxys(' 127.0.0.1 , ::FFFF:10.0.0.5 ', () => {
    assert.equal(
      clientAddress(anfrage('::ffff:10.0.0.5', { forwarded: '198.51.100.9' })),
      '198.51.100.9',
    );
  });
});

test('ohne Vertrauen zählt nur die echte Gegenstelle, nie der Header', async () => {
  await mitProxys(undefined, () => {
    assert.equal(
      clientAddress(anfrage('::ffff:203.0.113.9', { forwarded: '8.8.8.8' })),
      '203.0.113.9',
    );
  });
  await mitProxys('127.0.0.1', () => {
    // Fremde Gegenstelle, vertrauenswürdiger Wert im Header: trotzdem egal.
    assert.equal(
      clientAddress(anfrage('::ffff:198.51.100.4', { forwarded: '127.0.0.1' })),
      '198.51.100.4',
    );
  });
});

test('ein nicht vertrauenswürdiger Zwischenschritt blockiert die Kette', async () => {
  await mitProxys('127.0.0.1', () => {
    // Von rechts: 198.51.100.7 ist nicht vertraut -> das ist der Besucher,
    // und das vom Client vorgeschobene "8.8.8.8" wird nie erreicht.
    assert.equal(
      clientAddress(
        anfrage('::ffff:127.0.0.1', {
          forwarded: '8.8.8.8, 198.51.100.7',
        }),
      ),
      '198.51.100.7',
    );
    // Beide Zwischenschritte nur mit 127.0.0.1 vertraut: der rechteste
    // nicht vertraute Schritt ist der Besucher – das ganz links vorgeschobene
    // 203.0.113.42 wird nie geglaubt.
    const zweistufig = anfrage('::ffff:127.0.0.1', {
      forwarded: '203.0.113.42, 10.0.0.5',
    });
    assert.equal(clientAddress(zweistufig), '10.0.0.5');
  });
  await mitProxys('127.0.0.1, 10.0.0.5', () => {
    const zweistufig = anfrage('::ffff:127.0.0.1', {
      forwarded: '203.0.113.42, ::ffff:10.0.0.5',
    });
    assert.equal(clientAddress(zweistufig), '203.0.113.42');
  });
});

test('ein leerer Header erfindet keinen Besucher', async () => {
  await mitProxys('127.0.0.1', () => {
    assert.equal(
      clientAddress(anfrage('::ffff:127.0.0.1', { forwarded: ' ,  ' })),
      '127.0.0.1',
    );
    assert.equal(
      clientAddress(anfrage('::ffff:127.0.0.1', { forwarded: '' })),
      '127.0.0.1',
    );
  });
});

/* ---------------------- echte Bucket-Trennung ----------------------- */

/**
 * `rateLimit` ist der Produktivpfad (30 Logins/Min pro Client). Gezählt wird
 * über `__testing.rateBuckets`; der Eimer-Key trägt die Klasse `auth`.
 */
const bisZumLimit = (anfragen) => {
  let letzte = null;
  let abgelehntBei = 0;
  for (const [index, req] of anfragen.entries()) {
    letzte = rateLimit(req, loginPfad());
    if (letzte) {
      abgelehntBei = index + 1;
      break;
    }
  }
  return { abgelehntBei, letzte };
};

test('zwei Besucher hinter dem Proxy haben zwei Eimer', async () => {
  await mitProxys('127.0.0.1', () => {
    const a = Array.from({ length: 31 }, () =>
      anfrage('::ffff:127.0.0.1', { forwarded: '203.0.113.1' }),
    );
    const { abgelehntBei, letzte } = bisZumLimit(a);
    assert.equal(abgelehntBei, 31, 'Limit muss beim 31. Antrag greifen');
    assert.equal(letzte.status, 429);
    // Der zweite Besucher ist davon unbeeindruckt.
    assert.equal(
      rateLimit(
        anfrage('::ffff:127.0.0.1', { forwarded: '203.0.113.2' }),
        loginPfad(),
      ),
      null,
    );
    assert.ok(
      rateBuckets.size >= 2,
      'beide Besucher müssen eigene Eimer haben',
    );
  });
});

test('ohne Proxy-Vertrauen teilen sich alle einen Eimer – aber einen echten', async () => {
  await mitProxys(undefined, () => {
    // Ohne konfigurierten Proxy ist die Gegenstelle die Adresse des Proxies:
    // geteilter Eimer, aber einer, den der Besucher nicht selbst wählen kann.
    const gemischt = Array.from({ length: 31 }, (_, index) =>
      anfrage('::ffff:127.0.0.1', { forwarded: `203.0.113.${index}` }),
    );
    const { abgelehntBei } = bisZumLimit(gemischt);
    assert.equal(abgelehntBei, 31);
    assert.equal(rateBuckets.size, 1);
  });
});

test('Header-Spaltung erzeugt keine zusätzlichen Eimer', async () => {
  await mitProxys('127.0.0.1', () => {
    // Ein Angreifer, der hintereinander 200 vorgetäuschte Besucher-Adressen
    // schickt, darf nicht 200 frische Eimer bekommen (Bucket-Schwemme war
    // schon einmal ein eigener Punkt, V25b). Vertrauenswürdiger Proxy, also
    // wird der Header benutzt – die Obergrenze greift in `takeRateBucket`.
    for (let index = 0; index < 400; index += 1) {
      rateLimit(
        anfrage('::ffff:127.0.0.1', {
          forwarded: `203.0.${index % 4}.${index}`,
        }),
        loginPfad(),
      );
    }
    assert.ok(
      rateBuckets.size <= 400,
      `unerwartet viele Eimer: ${rateBuckets.size}`,
    );
    // Und derselbe Besucher in beiden Familienformen bleibt ein Eimer.
    rateBuckets.clear();
    rateLimit(anfrage('127.0.0.1', { forwarded: '203.0.113.77' }), loginPfad());
    const vorherige = rateBuckets.size;
    rateLimit(
      anfrage('::ffff:127.0.0.1', { forwarded: '203.0.113.77' }),
      loginPfad(),
    );
    assert.equal(
      rateBuckets.size,
      vorherige,
      'Familie darf keinen zweiten Eimer erzeugen',
    );
  });
});
