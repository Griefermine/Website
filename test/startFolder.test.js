/**
 * Der Weg von einem abgelegten Ordner zu Dateien, die der Hub annehmen kann.
 *
 * Genau hier gehen Dateien verloren, und zwar lautlos: `readEntries` gibt die
 * Hälfte eines Ordners erst beim zweiten Aufruf heraus, und ein Browser, der
 * keine Ordner kennt, übergibt statt dessen eine flache Liste. Beides sieht im
 * Ergebnis nach „erfolgreich hochgeladen" aus, nur fehlen Dateien.
 *
 * Geprüft wird mit nachgebauten Knoten statt mit einem echten Drag & Drop – der
 * lässt sich in einem Test nicht erzeugen, die Regeln aber schon.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  knotenAusDrop,
  paareAusAuswahl,
  sammleKnoten,
} from '../src/ui/startFolder.js';

/** Eine Datei, wie der Browser sie übergibt: Name, Inhalt, kein Pfad. */
const dateiKnoten = (name, inhalt = `inhalt von ${name}`) => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (fertig) => fertig({ name, inhalt }),
});

/**
 * Ein Ordner, der seine Einträge in `stuecke` verteilt – so, wie es der Browser
 * tut. `stuecke: [[a, b], [c]]` heißt: der erste Aufruf liefert `a` und `b`,
 * der zweite `c`, der dritte nichts.
 */
const ordnerKnoten = (name, stuecke) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader() {
    let aufruf = 0;
    return {
      readEntries: (fertig) => {
        const stueck = aufruf < stuecke.length ? stuecke[aufruf] : [];
        aufruf += 1;
        setTimeout(() => fertig(stueck), 0);
      },
    };
  },
});

const pfade = (dateien) => dateien.map((d) => d.pfad).sort();

describe('Einen abgelegten Ordner zerlegen', () => {
  it('behält Ordner- und Dateinamen bei', async () => {
    // Der Name eines hineingezogenen Ordners bleibt stehen, sonst läge die
    // Struktur zwar richtig, aber an einer anderen Stelle als erwartet.
    const knoten = [ordnerKnoten('meinbot', [[dateiKnoten('bot.py')]])];
    const { dateien, zuViel } = await sammleKnoten(knoten, 50);
    assert.equal(zuViel, false);
    assert.deepEqual(pfade(dateien), ['meinbot/bot.py']);
    assert.equal(dateien[0].datei.inhalt, 'inhalt von bot.py');
  });

  it('geht in beliebig tiefe Ordner', async () => {
    const knoten = [
      ordnerKnoten('projekt', [
        [
          dateiKnoten('bot.py'),
          ordnerKnoten('src', [
            [
              dateiKnoten('hilfe.py'),
              ordnerKnoten('util', [[dateiKnoten('tief.py')]]),
            ],
          ]),
        ],
      ]),
    ];
    const { dateien } = await sammleKnoten(knoten, 50);
    assert.deepEqual(pfade(dateien), [
      'projekt/bot.py',
      'projekt/src/hilfe.py',
      'projekt/src/util/tief.py',
    ]);
  });

  it('fragt einen Ordner ab, bis er leer kommt', async () => {
    // Das ist die Regel, an der die Hälfte eines Ordners verschwindet: der
    // erste Aufruf liefert nur die ersten 100, der zweite den Rest. Wer einmal
    // fragt, hat eine Liste, die zu kurz ist, und merkt es nicht.
    const knoten = [
      ordnerKnoten('viel', [
        [dateiKnoten('a.py'), dateiKnoten('b.py')],
        [dateiKnoten('c.py')],
      ]),
    ];
    const { dateien } = await sammleKnoten(knoten, 50);
    assert.deepEqual(pfade(dateien), ['viel/a.py', 'viel/b.py', 'viel/c.py']);
  });

  it('nimmt mehrere Ordner nebeneinander', async () => {
    const knoten = [
      ordnerKnoten('erster', [[dateiKnoten('a.py')]]),
      dateiKnoten('lose.py'),
      ordnerKnoten('zweiter', [[dateiKnoten('b.py')]]),
    ];
    const { dateien } = await sammleKnoten(knoten, 50);
    assert.deepEqual(pfade(dateien), [
      'erster/a.py',
      'lose.py',
      'zweiter/b.py',
    ]);
  });

  it('bricht ab, statt einen Baum ohne Ende abzuklopfen', async () => {
    // Ein verschentlich gezogener `node_modules` soll eine Meldung bringen und
    // nicht zehn Minuten laufen. Der Stapel ist dabei noch flach genug, dass der
    // Abbruch vor dem Walken greift – getestet wird die Grenze, nicht der Baum.
    const knoten = [ordnerKnoten('riesig', [[dateiKnoten('x.py')]])];
    const { dateien, zuViel } = await sammleKnoten(knoten, 0);
    assert.equal(zuViel, true);
    assert.deepEqual(dateien, []);
  });

  it('verträgt einen leeren Ordner', async () => {
    const { dateien, zuViel } = await sammleKnoten(
      [ordnerKnoten('leer', [])],
      50,
    );
    assert.deepEqual(dateien, []);
    assert.equal(zuViel, false);
  });

  it('schluckt einen Browser, der beim Ordernamen kaputtgeht', async () => {
    // `createReader` fehlt in sehr alten Ansichten. Dann ist der Ordner eben
    // leer – aber der Rest des Drops wird noch hochgeladen, statt dass alles
    // zusammen mit einer Ausnahme im Bildschirm verschwindet.
    const kaputt = {
      isFile: false,
      isDirectory: true,
      name: 'kaputt',
      createReader: () => {
        throw new Error('kein Reader');
      },
    };
    const { dateien, zuViel } = await sammleKnoten(
      [kaputt, dateiKnoten('a.py')],
      50,
    );
    assert.equal(zuViel, false);
    assert.deepEqual(pfade(dateien), ['a.py']);
  });
});

describe('Aus einem DataTransfer lesen', () => {
  it('nimmt die Einträge heraus, die der Browser kennt', () => {
    // `webkitGetAsEntry` muss im Ereignis aufgerufen werden – danach liefert es
    // `null`. Deshalb wird hier nur herausgefunden, welche Knoten es gibt.
    const ordner = ordnerKnoten('meinbot', []);
    const knoten = knotenAusDrop({
      items: [
        { kind: 'string', webkitGetAsEntry: () => ordner },
        { kind: 'file', webkitGetAsEntry: () => ordner },
        { kind: 'file', webkitGetAsEntry: () => null },
        { kind: 'file' },
      ],
    });
    assert.deepEqual(
      knoten.map((k) => k.name),
      ['meinbot'],
    );
  });

  it('kommt ohne die Schnittstelle aus, statt zu raten', () => {
    // Ohne `webkitGetAsEntry` gibt es keine Ordner. Das ist kein Fehler, sondern
    // eine Auskunft: der Aufrufer nimmt dann die einzelnen Dateien.
    assert.deepEqual(knotenAusDrop({ items: [{ kind: 'file' }] }), []);
    assert.deepEqual(knotenAusDrop({}), []);
    assert.deepEqual(knotenAusDrop(null), []);
  });
});

describe('Aus einer Dateiauswahl lesen', () => {
  it('übernimmt den Pfad, den der Browser mitbringt', () => {
    // Bei einer Ordnerauswahl füllt sich `webkitRelativePath` von allein – das
    // ist der einzige Weg, auf dem der Browser die Struktur von sich aus gibt.
    const paare = paareAusAuswahl([
      { name: 'bot.py', webkitRelativePath: 'meinbot/bot.py' },
      { name: 'src/hilfe.py', webkitRelativePath: 'meinbot/src/hilfe.py' },
    ]);
    assert.deepEqual(
      paare.map((p) => p.pfad),
      ['meinbot/bot.py', 'meinbot/src/hilfe.py'],
    );
  });

  it('nimmt den Dateinamen, wenn es keinen Pfad gibt', () => {
    // Einzelne Dateien aus der Auswahl: kein Pfad, also der Name. Sonst stünde
    // eine Datei mit einem Schrägstrich darin im Verzeichnis.
    assert.deepEqual(
      paareAusAuswahl([{ name: 'bot.py' }]).map((p) => p.pfad),
      ['bot.py'],
    );
  });
});
