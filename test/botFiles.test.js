import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import * as dateien from '../server/botFiles.js';

const BOT_ID = 'b1';

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-hub-files-'));
  const bot = {
    id: BOT_ID,
    name: 'Mein Bot',
    workspaceRoot: `bots/${BOT_ID}/workspace`,
  };
  mkdirSync(join(root, 'bots', BOT_ID, 'workspace'), {
    recursive: true,
    mode: 0o700,
  });
  return { root, bot };
};

const quelle = (root, ...teile) =>
  join(root, 'bots', BOT_ID, 'startordner', ...teile);
const ziel = (root, ...teile) =>
  join(root, 'bots', BOT_ID, 'workspace', ...teile);

const schreiben = (root, pfad, inhalt) => {
  const voll = quelle(root, ...pfad.split('/'));
  mkdirSync(join(voll, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(voll, inhalt, 'utf8');
};

describe('Der Startordner eines Bots', () => {
  let root;
  let bot;

  before(() => {
    ({ root, bot } = setup());
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('legt sich selbst an und hält die Rechte des Betreibers', () => {
    const ordner = dateien.ensureStartFolder(bot, root);
    assert.ok(existsSync(ordner));
    assert.equal(statSync(ordner).mode & 0o777, 0o700);
    // Mehrfach aufrufbar – `hydrate` ruft das bei jedem Start.
    assert.equal(dateien.ensureStartFolder(bot, root), ordner);
  });

  it('nutzt einen Namen, der sich nicht mit dem Bot mischt', () => {
    // Der Pfad folgt der ID, nicht dem Anzeigenamen: zwei Bots dürfen gleich
    // heißen, und ein Umbenannter Bot soll seine Dateien nicht verlieren.
    assert.equal(dateien.startFolderOf(bot), `bots/${BOT_ID}/startordner`);
    assert.ok(!dateien.startFolderOf(bot).includes('Mein Bot'));
  });

  it('kommt ohne den Ordner aus, solange nichts drinliegt', () => {
    dateien.ensureStartFolder(bot, root);
    const ergebnis = dateien.sync(bot, root);
    assert.equal(ergebnis.kopiert, 0);
    assert.equal(ergebnis.entfernt, 0);
  });
});

describe('Spiegeln in den Workspace', () => {
  let root;
  let bot;

  before(() => {
    ({ root, bot } = setup());
    dateien.ensureStartFolder(bot, root);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('bringt Dateien und Unterordner in den Workspace', () => {
    schreiben(root, 'bot.py', 'print("hallo")');
    schreiben(root, 'src/hilfe.py', 'x = 1');
    schreiben(root, 'daten/config.json', '{}');

    const ergebnis = dateien.sync(bot, root);
    assert.equal(ergebnis.kopiert, 3);
    assert.equal(readFileSync(ziel(root, 'bot.py'), 'utf8'), 'print("hallo")');
    assert.equal(readFileSync(ziel(root, 'src', 'hilfe.py'), 'utf8'), 'x = 1');
    assert.equal(
      readFileSync(ziel(root, 'daten', 'config.json'), 'utf8'),
      '{}',
    );
  });

  it('lässt beim zweiten Mal die Finger von allem', () => {
    const ergebnis = dateien.sync(bot, root);
    assert.equal(ergebnis.kopiert, 0);
    assert.equal(ergebnis.entfernt, 0);
    assert.equal(ergebnis.unveraendert, 3);
  });

  it('schreibt zurück, was der Bot im Container verändert hat', () => {
    // Der Startordner ist die Quelle. Wer im Bot die Datei anfasst, bekommt
    // sie beim nächsten Spiegeln wieder – sonst gewönne der Bot mit der Zeit
    // das Recht, die eigene Quelle zu überschreiben.
    writeFileSync(ziel(root, 'bot.py'), 'print("manipuliert")', 'utf8');
    const ergebnis = dateien.sync(bot, root);
    assert.equal(ergebnis.kopiert, 1);
    assert.equal(readFileSync(ziel(root, 'bot.py'), 'utf8'), 'print("hallo")');
  });

  it('nimmt mit, was im Startordner gelöscht wurde', () => {
    rmSync(quelle(root, 'src', 'hilfe.py'));
    rmdirSync(quelle(root, 'src'));
    const ergebnis = dateien.sync(bot, root);
    assert.equal(ergebnis.entfernt, 1);
    assert.ok(!existsSync(ziel(root, 'src', 'hilfe.py')));
    assert.ok(!existsSync(ziel(root, 'src')), 'der leere Ordner blieb zurück');
  });

  it('lässt unangetastet, was der Bot selbst erzeugt hat', () => {
    // `node_modules` und Caches stehen nicht in der Merkliste: sie gehören dem
    // Bot, und ein Spiegel, der sie mitnehmen würde, würde bei jedem Start die
    // Installation des Bots wieder über den Haufen werfen.
    mkdirSync(ziel(root, 'node_modules', 'discord.js'), { recursive: true });
    writeFileSync(ziel(root, 'node_modules', 'discord.js', 'index.js'), 'bot');
    writeFileSync(ziel(root, 'cache.json'), '{}', 'utf8');

    schreiben(root, 'bot.py', 'print("neu")');
    const ergebnis = dateien.sync(bot, root);
    assert.equal(ergebnis.entfernt, 0);
    assert.ok(existsSync(ziel(root, 'node_modules', 'discord.js', 'index.js')));
    assert.ok(existsSync(ziel(root, 'cache.json')));
  });

  it('übernimmt weder Geheimnisse noch .git', () => {
    schreiben(root, '.env', 'DISCORD_BOT_TOKEN="echt"');
    schreiben(root, '.env.lokal', 'A=1');
    schreiben(root, '.git/config', '[core]');
    schreiben(root, 'secrets.py', 'TOKEN = "im Quelltext"');

    const ergebnis = dateien.sync(bot, root);
    assert.ok(!existsSync(ziel(root, '.env')), '.env kam im Workspace an');
    assert.ok(!existsSync(ziel(root, '.env.lokal')));
    assert.ok(!existsSync(ziel(root, '.git')));
    assert.ok(
      existsSync(ziel(root, 'secrets.py')),
      'eine Quelldatei namens secrets.py ist Quellcode, kein Geheimnis',
    );
    // Und es wird nicht still verschwiegen.
    assert.ok(
      ergebnis.uebersprungen.some((e) => e.includes('.env')),
      `nichts gemeldet: ${JSON.stringify(ergebnis.uebersprungen)}`,
    );
  });

  it('folgt keinem Verweis aus dem Startordner', () => {
    // Wer auf dem Host einen Symlink in den Startordner legt, würde sonst den
    // Inhalt beliebiger Dateien in den Container legen können.
    const fremd = join(root, 'fremd.txt');
    writeFileSync(fremd, 'geheim', 'utf8');
    symlinkSync(fremd, quelle(root, 'verweis.txt'));
    symlinkSync('/etc', quelle(root, 'etc-verweis'));

    const ergebnis = dateien.sync(bot, root);
    assert.ok(!existsSync(ziel(root, 'verweis.txt')));
    assert.ok(!existsSync(ziel(root, 'etc-verweis')), 'ein Verweis auf /etc');
    assert.ok(
      ergebnis.uebersprungen.some((e) => e.includes('Verweis')),
      `nichts gemeldet: ${JSON.stringify(ergebnis.uebersprungen)}`,
    );
  });

  it('nimmt den Zeitstempel mit', () => {
    // Er ist nicht nur Anzeige: beim nächsten Durchlauf entscheidet er, ob
    // die Datei im Workspace noch die des Betreibers ist.
    const vor = statSync(quelle(root, 'bot.py')).mtimeMs;
    dateien.sync(bot, root);
    assert.ok(
      Math.abs(statSync(ziel(root, 'bot.py')).mtimeMs - vor) < 2000,
      'der Zeitstempel wurde nicht übernommen',
    );
  });

  it('schreibt die Merkliste mit 0600 neben den Startordner', () => {
    dateien.sync(bot, root);
    const merkliste = join(root, 'bots', BOT_ID, 'start-sync.json');
    assert.equal(statSync(merkliste).mode & 0o777, 0o600);
    // Sie liegt ausserhalb des gemounteten Workspace – der Bot sieht sie nicht.
    assert.ok(!existsSync(ziel(root, 'start-sync.json')));
    assert.ok(JSON.parse(readFileSync(merkliste, 'utf8')).dateien['bot.py']);
  });

  it('räumt auf, wenn eine kaputte Merkliste da liegt', () => {
    // Lieber einmal zu viel kopieren als ein Dateiverzeichnis, an dem niemand
    // mehr erkennen kann, was dem Bot gehört.
    const merkliste = join(root, 'bots', BOT_ID, 'start-sync.json');
    writeFileSync(merkliste, 'kaputt', 'utf8');
    const ergebnis = dateien.sync(bot, root);
    assert.ok(ergebnis.kopiert >= 1);
    assert.equal(ergebnis.entfernt, 0);
    assert.ok(!existsSync(join(root, 'bots', BOT_ID, 'start-sync.json.1.tmp')));
  });
});

describe('Pfade im Startordner', () => {
  let root;
  let bot;

  before(() => {
    ({ root, bot } = setup());
    dateien.ensureStartFolder(bot, root);
    schreiben(root, 'bot.py', 'print(1)');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const erlaubt = (pfad) => dateien.safeStartPath(bot, root, pfad);

  it('nimmt relative Pfade mit Unterordnern', () => {
    assert.equal(
      erlaubt('bot.py'),
      join(root, 'bots', BOT_ID, 'startordner', 'bot.py'),
    );
    assert.equal(
      erlaubt('src/hilfe.py'),
      join(root, 'bots', BOT_ID, 'startordner', 'src', 'hilfe.py'),
    );
    assert.ok(erlaubt('gibt/es/noch/nicht.txt'), 'eine neue Datei ist erlaubt');
  });

  it('lässt nichts zu, was hinauswillt', () => {
    for (const pfad of [
      '../../../.env',
      'src/../../../.env',
      '/etc/shadow',
      '~',
      '',
      '   ',
      '.',
      'a/\0/b',
      'x'.repeat(300),
    ])
      assert.equal(erlaubt(pfad), null, `hätte durchgelassen: ${pfad}`);
  });

  it('lässt einen Verweis im Startordner unbenutzt', () => {
    // Der Startordner selbst kann auf dem Host ein Symlink sein; gemessen wird
    // deshalb am echten Ort, nicht am Namen. Folge: ein Verweis *innerhalb* des
    // Startordners ist auch kein Weg nach draußen – weder zum Lesen noch zum
    // Schreiben. Lieber zu wenig als ein Loch.
    const anderswo = join(root, 'anderswo');
    mkdirSync(anderswo, { recursive: true });
    writeFileSync(join(anderswo, 'x.txt'), 'x', 'utf8');
    symlinkSync(anderswo, join(quelle(root), 'verweis'));

    assert.equal(erlaubt('verweis/x.txt'), null);
    assert.equal(dateien.read(bot, root, 'verweis/x.txt'), null);
    assert.equal(dateien.write(bot, root, 'verweis/y.txt', 'x'), false);
    assert.ok(!existsSync(join(anderswo, 'y.txt')));
  });
});

describe('Dateien im Startordner verwalten', () => {
  let root;
  let bot;

  before(() => {
    ({ root, bot } = setup());
    dateien.ensureStartFolder(bot, root);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('legt Dateien an und liest sie wieder', () => {
    assert.equal(dateien.write(bot, root, 'neu.py', 'print(2)'), true);
    assert.equal(dateien.read(bot, root, 'neu.py').inhalt, 'print(2)');
  });

  it('überschreibt eine vorhandene Datei', () => {
    dateien.write(bot, root, 'neu.py', 'print(3)');
    assert.equal(dateien.read(bot, root, 'neu.py').inhalt, 'print(3)');
  });

  it('legt fehlende Elternordner an', () => {
    assert.equal(dateien.write(bot, root, 'a/b/c.py', 'x'), true);
    assert.ok(existsSync(quelle(root, 'a', 'b', 'c.py')));
  });

  it('weist Pfade ab, die nicht hineingehören', () => {
    for (const pfad of ['../raus.py', '/tmp/raus.py', '', null])
      assert.equal(dateien.write(bot, root, pfad, 'x'), false, pfad);
    assert.ok(!existsSync(join(root, 'raus.py')));
  });

  it('schreibt nicht auf einen Ordner', () => {
    dateien.makeDir(bot, root, 'ordner');
    assert.equal(dateien.write(bot, root, 'ordner', 'x'), false);
    assert.ok(statSync(quelle(root, 'ordner')).isDirectory());
  });

  it('lässt sich mit Verweisen nicht überschreiben', () => {
    const fremd = join(root, 'fremd.txt');
    writeFileSync(fremd, 'original', 'utf8');
    symlinkSync(fremd, quelle(root, 'verweis.txt'));
    assert.equal(
      dateien.write(bot, root, 'verweis.txt', 'ueberschrieben'),
      false,
    );
    assert.equal(readFileSync(fremd, 'utf8'), 'original');
  });

  it('weist zu grosse Dateien ab', () => {
    assert.equal(
      dateien.write(bot, root, 'gross.txt', 'x'.repeat(600 * 1024)),
      false,
    );
  });

  it('listet Dateien und lässt Geheimnisse weg', () => {
    // Die Liste zeigt, was beim Spiegeln ankommt. Ein `.env` gehört nicht dazu
    // – es wird gemeldet, nicht verschwiegen.
    dateien.write(bot, root, 'a.py', '1');
    dateien.write(bot, root, 'src/b.py', '2');
    dateien.write(bot, root, '.env', 'GEHEIM=1');
    const ergebnis = dateien.list(bot, root);
    const pfade = ergebnis.dateien.map((f) => f.pfad);
    assert.ok(pfade.includes('a.py'));
    assert.ok(pfade.includes('src/b.py'));
    assert.ok(!pfade.some((p) => p.endsWith('.env')), 'ein .env in der Liste');
    assert.equal(ergebnis.dateien.find((f) => f.pfad === 'a.py').groesse, 1);
    assert.ok(ergebnis.uebersprungen.some((e) => e.includes('.env')));
  });

  it('löscht Dateien und räumt leere Ordner mit auf', () => {
    dateien.write(bot, root, 'weg/tief/x.py', '1');
    assert.equal(dateien.remove(bot, root, 'weg/tief/x.py'), true);
    assert.ok(!existsSync(quelle(root, 'weg')), 'der leere Ordner blieb');
  });

  it('löscht keinen Ordner, in dem noch etwas liegt', () => {
    dateien.write(bot, root, 'voll/a.py', '1');
    assert.equal(dateien.remove(bot, root, 'voll'), false);
    assert.ok(existsSync(quelle(root, 'voll', 'a.py')));
  });

  it('legt Ordner an – nur einmal', () => {
    assert.equal(dateien.makeDir(bot, root, 'neu'), true);
    assert.equal(dateien.makeDir(bot, root, 'neu'), false);
    assert.equal(statSync(quelle(root, 'neu')).mode & 0o777, 0o700);
  });
});
