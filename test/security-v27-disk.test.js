/**
 * Maßnahme 49 (V27-D, Auftrag 5.4): freier Datenträgerplatz vor Anlage und
 * Installation.
 *
 * Vorher stand in server/ nirgends ein `statfs`: der Hub prüfte beim Anlegen
 * nur die ANZAHL der Bots (`BOT_HUB_MAX_BOTS`), nie den PLATZ. Eine
 * Installation, die den Datenträger füllt, traf damit nicht nur diesen Bot –
 * Datenbank, Sitzungsdatei und jeder andere Workspace brechen auf einer
 * vollen Platte ebenfalls weg. Die harte Kontingentgrenze je Workspace bleibt
 * Sache des Betriebs (documents/sicherheit.md); gemessen wird der freie Platz
 * samt Inodes ab jetzt vom Hub selbst.
 *
 * Die Schwellen kommen bewusst aus `process.env`-Lesart bei JEDEM Aufruf –
 * so prüfen diese Tests über Umgebungsvariablen, ohne Sonden austauschen zu
 * müssen, und ein Betreiber kann die Werte zur Laufzeit korrigieren.
 */

import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const { capacityGuard, spaceStatus } = await import('../server/disk.js');

const MB = 1024 * 1024;

/** statfs-Ergebnis mit großzügigem Platz – als Standard für die Einheitstests. */
const gross =
  (bytes = 50 * 1024 * MB, inodes = 5_000_000) =>
  () => ({
    bsize: 4096,
    blocks: Math.ceil(bytes / 4096),
    bfree: Math.ceil(bytes / 4096),
    bavail: Math.ceil(bytes / 4096),
    files: inodes,
    ffree: inodes,
  });

const mitEnv = async (werte, aufgabe) => {
  const vorher = new Map(
    Object.keys(werte).map((name) => [name, process.env[name]]),
  );
  for (const [name, wert] of Object.entries(werte)) {
    if (wert === undefined) delete process.env[name];
    else process.env[name] = String(wert);
  }
  try {
    return await aufgabe();
  } finally {
    for (const [name, wert] of vorher) {
      if (wert === undefined) delete process.env[name];
      else process.env[name] = wert;
    }
  }
};

/* --------------------------- Einheit: Messung ---------------------------- */

describe('spaceStatus', () => {
  it('nutzt bavail, nicht bfree', () => {
    // bfree enthält die root-Reserve (typisch 5 %). Die darf nicht als
    // eigener Spielraum zählen – gemessen werden muss, was der Hub-Benutzer
    // tatsächlich schreiben kann.
    const status = spaceStatus('/egal', () => ({
      bsize: 4096,
      bavail: 100,
      bfree: 10_000,
      ffree: 42,
    }));
    assert.equal(status.bytes, 100 * 4096);
    assert.equal(status.inodes, 42);
  });

  it('ein nicht messbarer Datenträger ergibt null', () => {
    assert.equal(
      spaceStatus('/gibt-es-nicht', () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      null,
    );
    assert.equal(
      spaceStatus('/egal', () => ({ bsize: NaN })),
      null,
    );
  });

  it('fehlende Inode-Angabe ist kein Messfehler', () => {
    const status = spaceStatus('/egal', () => ({
      bsize: 1,
      bavail: 5_000 * MB,
      ffree: undefined,
    }));
    assert.equal(status.inodes, null);
    assert.equal(status.bytes, 5_000 * MB);
  });
});

describe('capacityGuard', () => {
  it('lässt einen Datenträger mit Platz', async () => {
    await mitEnv({ BOT_HUB_MIN_FREE_MB: undefined }, () => {
      const ergebnis = capacityGuard('/egal', { statfs: gross() });
      assert.equal(ergebnis.ok, true);
      assert.equal(ergebnis.gemessen, true);
    });
  });

  it('lehnt bei zu wenig Bytes ab – und benennt beides, ohne Pfade', async () => {
    await mitEnv({ BOT_HUB_MIN_FREE_MB: undefined }, () => {
      // Default ist 256 MiB; 10 MiB sind klar darunter.
      const ergebnis = capacityGuard('/egal', { statfs: gross(10 * MB) });
      assert.equal(ergebnis.ok, false);
      assert.match(ergebnis.grund, /nur noch 10 MiB frei/);
      assert.match(ergebnis.grund, /erforderlich sind 256 MiB/);
      assert.match(ergebnis.grund, /BOT_HUB_MIN_FREE_MB/);
      assert.ok(!ergebnis.grund.includes('/egal'), 'Meldung nennt einen Pfad');
    });
  });

  it('die Schwelle selbst ist erreicht, nicht unterschritten', async () => {
    await mitEnv({ BOT_HUB_MIN_FREE_MB: 10 }, () => {
      // Auf Blockgrenzen gerechnet: 1 MiB = exakt 256 Blöcke à 4096.
      // Ein Minus-Eins-Byte wäre durch die Blockrundung unsichtbar.
      assert.equal(capacityGuard('/egal', { statfs: gross(10 * MB) }).ok, true);
      assert.equal(
        capacityGuard('/egal', { statfs: gross(10 * MB - 4096) }).ok,
        false,
      );
    });
  });

  it('freie Inodes grenzen die Million winziger Dateien', async () => {
    await mitEnv({ BOT_HUB_MIN_FREE_INODES: undefined }, () => {
      // Bytes üppig, Inodes knapp: genau der Fall, den die Bytes-Anzeige nicht sieht.
      const statfs = () => ({ bsize: 4096, bavail: 50 * 1_000_000, ffree: 50 });
      const ergebnis = capacityGuard('/egal', { statfs });
      assert.equal(ergebnis.ok, false);
      assert.match(ergebnis.grund, /50 Dateisplätze \(Inodes\) frei/);
      assert.match(ergebnis.grund, /BOT_HUB_MIN_FREE_INODES/);
    });
  });

  it('ein unbrauchbarer Messpfad sperrt den Betrieb nicht aus', async () => {
    await mitEnv({ BOT_HUB_MIN_FREE_MB: 999_999 }, () => {
      // Extrem hohe Schwelle, aber der Datenträger ist nicht messbar:
      // ohne Messung darf NICHT abgelehnt werden – sonst macht ein exotisches
      // Dateisystem oder eine fehlende Berechtigung die Anlage unbenutzbar.
      const ergebnis = capacityGuard('/egal', {
        statfs: () => {
          throw new Error('EPERM');
        },
      });
      assert.equal(ergebnis.ok, true);
      assert.equal(ergebnis.gemessen, false);
    });
  });

  it('eine unzulässige Schwelle kippt nicht auf „prüfe nie“', async () => {
    // Default 256 MiB bleibt, auch wenn „neunhundert“ oder 0 danebenstehen.
    for (const wert of ['neunhundert', '0', '-5', ' ']) {
      await mitEnv({ BOT_HUB_MIN_FREE_MB: wert }, () => {
        const ergebnis = capacityGuard('/egal', { statfs: gross(10 * MB) });
        assert.equal(ergebnis.ok, false, `Wert "${wert}" durfte nicht prüfen`);
        assert.match(ergebnis.grund, /256 MiB/);
      });
    }
  });
});

/* --------------------- Verhalten über die echte Route --------------------- */

/* Wie in test/auth-flow.test.js: PROJECT_ROOT entsteht beim Import des
 * Managers – die Umgebung muss VORHER stehen. */
process.env.NODE_ENV = 'test';
process.env.BOT_HUB_TEST_MODE = '1';
const root = mkdtempSync(join(tmpdir(), 'bot-hub-disk-'));
process.env.BOT_DASHBOARD_ROOT = root;
process.env.BOT_HUB_DB = 'sqlite';
mkdirSync(join(root, 'worker'), { recursive: true });
writeFileSync(join(root, 'worker', 'bot.sh'), 'sleep 30\n');

const { createServer } = await import('../server/manager.js');
let hub = null;
let basis = '';

before(async () => {
  hub = httpServer(createServer());
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve));
  basis = `http://127.0.0.1:${hub.address().port}`;
});

after(async () => {
  hub?.closeAllConnections?.();
  hub?.close();
  rmSync(root, { recursive: true, force: true });
});

const anlegen = async () =>
  fetch(`${basis}/api/bots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Plattest',
      language: 'custom',
      cwd: 'worker',
      entrypoint: 'bot.sh',
      command: 'sh {entrypoint}',
    }),
  });

describe('Bot-Anlage bei knappem Datenträger', () => {
  it('ein unerreichbares Platzversprechen wird mit 507 abgelehnt', async () => {
    // Schwelle weiter weg als jede Test-Platte frei hat: die echte Messung
    // muss ablehnen. Der Test füllt keine Platte, er verschiebt nur die Latte.
    await mitEnv({ BOT_HUB_MIN_FREE_MB: 100_000_000 }, async () => {
      const antwort = await anlegen();
      assert.equal(antwort.status, 422);
      const koerper = await antwort.json();
      assert.match(koerper.error, /frei; erforderlich sind/);
      // Kein Pfad, kein Bot: die Antwort verrät nichts über die Anlage und
      // es ist nichts angelegt worden.
      assert.ok(
        !koerper.error.includes(root),
        'Meldung nennt den Projekt-Pfad',
      );
      const liste = await (await fetch(`${basis}/api/bots`)).json();
      assert.deepEqual(liste.bots, [], 'trotz Ablehnung ein Bot angelegt');
    });
  });

  it('mit erreichbarer Schwelle wird weiter angelegt', async () => {
    await mitEnv(
      { BOT_HUB_MIN_FREE_MB: 1, BOT_HUB_MIN_FREE_INODES: 1 },
      async () => {
        const antwort = await anlegen();
        assert.equal(antwort.status, 201, await antwort.text());
        const liste = await (await fetch(`${basis}/api/bots`)).json();
        assert.equal(liste.bots.length, 1);
        // Aufräumen: der angelegte Bot würde sonst als Prozess weiterlaufen.
        const entfernt = await fetch(`${basis}/api/bots/${liste.bots[0].id}`, {
          method: 'DELETE',
        });
        assert.equal(entfernt.status, 200, await entfernt.text());
      },
    );
  });

  it('die Prüfung gilt auch im Testmodus (kein Freifahrtschein)', async () => {
    // BOT_HUB_TEST_MODE=1 schaltet Autorisation und Rate-Limits aus – die
    // Platzprüfung ist davon ausdrücklich ausgenommen, sonst wäre der
    // Produktpfad ungetestet.
    assert.equal(process.env.BOT_HUB_TEST_MODE, '1');
    await mitEnv({ BOT_HUB_MIN_FREE_MB: 100_000_000 }, async () => {
      const antwort = await anlegen();
      assert.equal(antwort.status, 422);
    });
  });
});
