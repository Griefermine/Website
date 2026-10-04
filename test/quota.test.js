/**
 * Quotas des Bot-Speichers.
 *
 * Zwei Fehler, die eine frühere Härtung selbst eingebaut hatte, sind hier die
 * eigentliche Prüfung:
 *
 *   - Die Zählung lief je Collection. Ein Bot mit vielen Collections kam damit
 *     weit über die Grenze hinaus, obwohl er nie eine einzelne überschritt.
 *   - Die Bytezahl stand als Konstante im Code und wurde nirgends gelesen.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.BOT_HUB_TEST_MODE = '1';

const {
  createTestStore,
  MAX_COLLECTIONS_PER_BOT,
  MAX_DATABASE_BYTES_PER_BOT,
  MAX_ENTRIES_PER_BOT,
  MAX_RESPONSE_BYTES,
  resetRateLimits,
  setRateLimits,
} = await import('../server/database.js');

let dir;
let store;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'quota-'));
  store = createTestStore({
    driver: 'sqlite',
    file: join(dir, 'store.sqlite'),
  });
});

after(async () => {
  resetRateLimits();
  await store?.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Schreibt bis zum Ende und lässt das Rate-Limit außer Betracht – sonst käme
 * es schneller zum 429 als zur Quota, und der Test prüfte die falsche Grenze.
 */
const fuellend = async (botId, schreiber) => {
  for (let i = 0; i < 40_000; i += 1) {
    if (i % 100 === 0) resetRateLimits();
    try {
      await schreiber(i);
    } catch (error) {
      if (error.status === 429) continue;
      return { error, geschrieben: i };
    }
  }
  return { error: null, geschrieben: 40_000 };
};

describe('Eintrags-Quota gilt je Bot, nicht je Collection', () => {
  it('hört über viele Collections hinweg auf', async () => {
    const bot = 'bot-viele-collections';
    const collections = 20;
    const proCollection = Math.ceil(MAX_ENTRIES_PER_BOT / collections) + 100;

    const { error, geschrieben } = await fuellend(bot, async (i) => {
      const c = Math.floor(i / proCollection);
      if (c >= collections)
        throw Object.assign(new Error('voll'), { status: 413 });
      await store.set(bot, `c${String(c).padStart(3, '0')}`, `k${i}`, { i });
    });

    // Mit einer Zählung je Collection wären hier 20 × 600 = 12.000 möglich.
    assert.equal(geschrieben, MAX_ENTRIES_PER_BOT);
    assert.equal(error.status, 413);
    assert.match(error.message, /Einträge-Quota/);

    const usage = await store.usage(bot);
    assert.equal(usage.entries, MAX_ENTRIES_PER_BOT);
    assert.ok(
      usage.entries < MAX_ENTRIES_PER_BOT * collections,
      'Zähler ist offenbar je Collection statt je Bot',
    );
  });

  it('lässt einen zweiten Bot unberührt', async () => {
    const usage = await store.usage('bot-zweiter');
    assert.deepEqual(usage, { entries: 0, collections: 0, bytes: 0 });
    await store.set('bot-zweiter', 'sonstiges', 'k', { a: 1 });
    const usage2 = await store.usage('bot-zweiter');
    assert.equal(usage2.entries, 1);
    assert.equal(
      (await store.usage('bot-viele-collections')).entries,
      MAX_ENTRIES_PER_BOT,
    );
  });
});

describe('Collection-Quota', () => {
  it('begrenzt die Anzahl der Collections je Bot', async () => {
    const bot = 'bot-collections';
    let anzahl = 0;
    let error = null;
    for (let i = 0; i < MAX_COLLECTIONS_PER_BOT + 10; i += 1) {
      try {
        await store.set(bot, `c${String(i).padStart(3, '0')}`, 'x', 1);
        anzahl += 1;
      } catch (e) {
        error = e;
        break;
      }
    }
    assert.equal(anzahl, MAX_COLLECTIONS_PER_BOT);
    assert.equal(error.status, 413);
    assert.match(error.message, /Collections-Quota/);
    assert.equal((await store.usage(bot)).collections, MAX_COLLECTIONS_PER_BOT);
  });

  it('gibt eine Collection frei, wenn ihr letzter Eintrag weg ist', async () => {
    const bot = 'bot-freigabe';
    for (let i = 0; i < MAX_COLLECTIONS_PER_BOT; i += 1) {
      await store.set(bot, `c${String(i).padStart(3, '0')}`, 'x', 1);
    }
    assert.equal((await store.usage(bot)).collections, MAX_COLLECTIONS_PER_BOT);

    await store.remove(bot, 'c000', 'x');
    // Die Collection ist jetzt leer und zählt nicht mehr – sonst wäre die
    // Grenze nach ein paar Löschungen unbrauchbar.
    assert.equal(
      (await store.usage(bot)).collections,
      MAX_COLLECTIONS_PER_BOT - 1,
    );

    await store.set(bot, 'c-neu', 'x', 1);
    assert.equal((await store.usage(bot)).collections, MAX_COLLECTIONS_PER_BOT);
  });
});

describe('Byte-Quota', () => {
  it('wird durchgesetzt', async () => {
    const bot = 'bot-bytes';
    const blob = 'x'.repeat(60 * 1024);
    const { error } = await fuellend(bot, async (i) => {
      await store.set(bot, 'gross', `k${i}`, blob);
    });
    assert.equal(error.status, 413);
    assert.match(error.message, /Bytes-Quota/);
    const usage = await store.usage(bot);
    assert.ok(
      usage.bytes <= MAX_DATABASE_BYTES_PER_BOT,
      `Zähler ${usage.bytes} über der Grenze`,
    );
    assert.ok(
      usage.bytes > MAX_DATABASE_BYTES_PER_BOT * 0.9,
      'Test kam nicht an die Grenze',
    );
  });

  it('rechnet beim Überschreiben die alte Größe ab', async () => {
    const bot = 'bot-ersetzen';
    // Unter der Grenze für einen einzelnen Wert (64 KiB), aber groß genug, um
    // den Unterschied zwischen altem und neuem Wert zu zeigen.
    const gross = 'y'.repeat(40 * 1024);
    await store.set(bot, 'c', 'k', gross);
    const vorher = (await store.usage(bot)).bytes;
    assert.equal(vorher, Buffer.byteLength(JSON.stringify(gross), 'utf8'));

    await store.set(bot, 'c', 'k', 'klein');
    const nachher = (await store.usage(bot)).bytes;
    assert.equal(
      nachher,
      Buffer.byteLength(JSON.stringify('klein'), 'utf8'),
      'Zähler hat die alte Größe nicht abgezogen',
    );
  });

  it('gibt die Größe beim Löschen frei', async () => {
    const bot = 'bot-loeschen';
    await store.set(bot, 'c', 'a', { gross: 'z'.repeat(1000) });
    await store.set(bot, 'c', 'b', { klein: 1 });
    const vorher = (await store.usage(bot)).bytes;
    await store.remove(bot, 'c', 'a');
    const nachher = (await store.usage(bot)).bytes;
    assert.ok(nachher < vorher, 'Löschen hat die Bytes nicht freigegeben');
    assert.equal(
      nachher,
      Buffer.byteLength(JSON.stringify({ klein: 1 }), 'utf8'),
    );
  });
});

describe('Zähler bleibt mit den Zeilen übereinstimmen', () => {
  it('über parallele Schreibvorgänge hinweg', async () => {
    const bot = 'bot-parallel';
    const eigener = createTestStore({
      driver: 'sqlite',
      file: join(dir, 'parallel.sqlite'),
    });
    // Ohne Sperre ließen hier 300 gleichzeitige Prüfungen aneinander vorbei:
    // alle lasen denselben Zählerstand und schreiben alle 1. Das Rate-Limit wird
    // dafür angehoben, weil es sonst 180 der 300 Schreibvorgänge schluckt und
    // der Test nichts mehr über die Zählerprüfung sagen könnte.
    setRateLimits({ write: 100_000, query: 100_000, read: 100_000 });
    try {
      await Promise.all(
        Array.from({ length: 300 }, (_, i) =>
          eigener.set(bot, 'race', `k${i}`, { i }).catch((error) => error),
        ),
      );
      const usage = await eigener.usage(bot);
      const seite = await eigener.list(bot, { collection: 'race', limit: 200 });
      assert.equal(seite.total, 300);
      assert.equal(usage.entries, seite.total);
      assert.equal(usage.entries, 300);
      assert.equal(usage.collections, 1);
    } finally {
      setRateLimits();
      resetRateLimits();
      await eigener.close();
    }
  });

  it('nach dem Löschen', async () => {
    const bot = 'bot-abbau';
    for (let i = 0; i < 20; i += 1) await store.set(bot, 'c', `k${i}`, { i });
    assert.equal((await store.usage(bot)).entries, 20);
    for (let i = 0; i < 12; i += 1) await store.remove(bot, 'c', `k${i}`);
    const usage = await store.usage(bot);
    assert.equal(usage.entries, 8);
    const seite = await store.list(bot, { collection: 'c', limit: 100 });
    assert.equal(usage.entries, seite.total);
  });

  it('wird neu berechnet, wenn die Zählerzeile fehlt', async () => {
    const bot = 'bot-ohne-zeiler';
    for (let i = 0; i < 5; i += 1) await store.set(bot, 'c', `k${i}`, { i });
    const treiber = await store.raw();
    await treiber.run('DELETE FROM bot_store_usage WHERE bot_id = ?', [bot]);
    const usage = await store.usage(bot);
    assert.equal(
      usage.entries,
      5,
      'Zähler wurde nicht aus den Zeilen abgeleitet',
    );
    assert.equal(usage.collections, 1);

    // Und der nächste Schreibvorgang legt die Zeile wieder an.
    await store.set(bot, 'c', 'k5', { i: 5 });
    const danach = await store.usage(bot);
    assert.equal(danach.entries, 6);
  });
});

describe('Listenantwort hat eine Obergrenze', () => {
  it('kürzt statt zu antworten, wenn die Seite die Grenze reißt', async () => {
    const bot = 'bot-liste';
    // 60 KiB je Wert: die Antwortgrenze von 4 MiB ist nach rund 70 Werten
    // erreicht, eine Seite bis 200 wäre also darüber.
    const blob = 'q'.repeat(60 * 1024);
    const anzahl = 120;
    for (let i = 0; i < anzahl; i += 1) {
      if (i % 100 === 0) resetRateLimits();
      await store.set(bot, 'gross', `k${String(i).padStart(3, '0')}`, blob);
    }
    const seite = await store.list(bot, { collection: 'gross', limit: 200 });
    assert.equal(seite.total, anzahl);
    assert.ok(seite.truncated, 'gekürzt wurde nicht gemeldet');
    assert.ok(
      seite.entries.length < anzahl,
      'die Antwort hätte die Grenze überritten',
    );
    // Der Zähler behauptet mehr, als geliefert wurde – das ist der Unterschied
    // zwischen einer Kürzung und einem stillen Datenverlust.
    assert.ok(seite.total > seite.entries.length);
    const bytes = seite.entries.reduce(
      (summe, eintrag) =>
        summe + Buffer.byteLength(JSON.stringify(eintrag.value), 'utf8'),
      0,
    );
    assert.ok(bytes <= MAX_RESPONSE_BYTES, `Antwort ${bytes} über der Grenze`);
  });

  it('meldet keine Kürzung bei kleinen Seiten', async () => {
    const seite = await store.list('bot-liste', {
      collection: 'klein',
      limit: 10,
    });
    assert.equal(seite.truncated, false);
  });
});

describe('Rate-Limits', () => {
  it('weisen 429 mit einer Wartezeit aus', async () => {
    const bot = 'bot-rate';
    let fehler = null;
    for (let i = 0; i < 500; i += 1) {
      try {
        await store.set(bot, 'c', `k${i}`, i);
      } catch (error) {
        if (error.status === 429) {
          fehler = error;
          break;
        }
      }
    }
    assert.ok(fehler, 'kein 429 erreicht');
    assert.match(fehler.message, /Rate-Limit/);
    assert.ok(Number(fehler.retryAfter) > 0, 'keine Wartezeit genannt');
    assert.ok(Number(fehler.retryAfter) <= 60);
  });

  it('gelten je Bot getrennt', async () => {
    resetRateLimits();
    const eigener = createTestStore({
      driver: 'sqlite',
      file: join(dir, 'rate.sqlite'),
    });
    try {
      let fehler = null;
      for (let i = 0; i < 500; i += 1) {
        try {
          await eigener.set('a', 'c', `k${i}`, i);
        } catch (error) {
          if (error.status === 429) {
            fehler = error;
            break;
          }
        }
      }
      assert.ok(fehler);
      // Bot b hat von Bots Limit nichts abbekommen.
      await eigener.set('b', 'c', 'k', 1);
    } finally {
      resetRateLimits();
      await eigener.close();
    }
  });

  it('gilt auch fürs Lesen und Abfragen', async () => {
    resetRateLimits();
    const eigener = createTestStore({
      driver: 'sqlite',
      file: join(dir, 'lesen.sqlite'),
    });
    try {
      await eigener.set('a', 'c', 'k', 1);
      let fehler = null;
      for (let i = 0; i < 2000; i += 1) {
        try {
          await eigener.get('a', 'c', 'k');
        } catch (error) {
          if (error.status === 429) {
            fehler = error;
            break;
          }
        }
      }
      assert.ok(fehler, 'kein 429 beim Lesen');
    } finally {
      resetRateLimits();
      await eigener.close();
    }
  });
});

describe('Antwort nennt die Grenzen', () => {
  it('damit ein Bot sie nicht erraten muss', () => {
    const status = store.status();
    assert.deepEqual(status.quotas, {
      entries: MAX_ENTRIES_PER_BOT,
      collections: MAX_COLLECTIONS_PER_BOT,
      bytes: MAX_DATABASE_BYTES_PER_BOT,
    });
  });

  it('enthält keinen Pfad', () => {
    const text = JSON.stringify(store.status());
    assert.ok(!text.includes(dir), `Pfad in der Antwort: ${text}`);
    assert.ok(!text.includes('.sqlite'));
  });
});
