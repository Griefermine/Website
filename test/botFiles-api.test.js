import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root;
let baseUrl;
let server;
let bot;

const call = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, data: await response.json() };
};

const startordner = (...teile) =>
  join(root, 'bots', bot.id, 'startordner', ...teile);
const workspace = (...teile) =>
  join(root, 'bots', bot.id, 'workspace', ...teile);

before(async () => {
  process.env.NODE_ENV = 'test';
  process.env.BOT_HUB_TEST_MODE = '1';
  root = mkdtempSync(join(tmpdir(), 'bot-hub-start-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'dist', 'index.html'),
    '<!doctype html><title>Hub</title>',
  );
  process.env.BOT_DASHBOARD_ROOT = root;
  process.env.PORT = '0';
  const { createServer: createApp } = await import('../server/manager.js');
  server = createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { data } = await call('/bots', {
    method: 'POST',
    body: {
      name: 'Dateibot',
      language: 'custom',
      entrypoint: 'bot.py',
      command: 'python3 {entrypoint}',
    },
  });
  bot = data.bot;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Der Startordner über HTTP', () => {
  it('legt sich beim Anlegen an – ohne dass jemand einen Pfad einträgt', () => {
    assert.equal(bot.startFolder, `bots/${bot.id}/startordner`);
    assert.ok(existsSync(startordner()));
    assert.equal(statSync(startordner()).mode & 0o777, 0o700);
    // Jeder neue Bot bekommt die Beispiel-Webseite (bot-hub.json + panel/).
    assert.equal(bot.fileCount, 4);
    assert.ok(existsSync(startordner('bot-hub.json')));
    assert.ok(existsSync(startordner('panel', 'index.html')));
  });

  it('nennt in der Botliste den Pfad und die Zahl der Dateien', async () => {
    const { data } = await call('/bots');
    const gelistet = data.bots.find((b) => b.id === bot.id);
    assert.equal(gelistet.startFolder, `bots/${bot.id}/startordner`);
    assert.equal(gelistet.fileCount, 4);
  });

  it('nimmt eine hochgeladene Datei sofort in den Workspace', async () => {
    const { status, data } = await call(`/bots/${bot.id}/files/bot.py`, {
      method: 'PUT',
      body: { inhalt: 'print("hallo")' },
    });
    assert.equal(status, 200);
    assert.equal(data.files.kopiert, 1);
    // In der Quelle …
    assert.equal(readFileSync(startordner('bot.py'), 'utf8'), 'print("hallo")');
    // … und im Workspace, der im Container als `/workspace` hängt.
    assert.equal(readFileSync(workspace('bot.py'), 'utf8'), 'print("hallo")');
  });

  it('legt Unterordner an und behält sie beim Spiegeln', async () => {
    await call(`/bots/${bot.id}/files/src/hilfe.py`, {
      method: 'PUT',
      body: { inhalt: 'x = 1' },
    });
    assert.ok(existsSync(workspace('src', 'hilfe.py')));
    const { data } = await call(`/bots/${bot.id}/files`);
    assert.deepEqual(
      data.eintraege.map((f) => f.pfad),
      ['panel', 'src', 'bot-hub.json', 'bot.py'],
    );
    assert.equal(data.eintraege[0].art, 'ordner');
    assert.equal(data.eintraege.find((f) => f.pfad === 'bot.py').groesse, 14);
  });

  it('listet einen Unterordner für sich', async () => {
    // Der Explorer navigiert mit `?pfad=`; die Wurzel antwortet mit allem, was
    // oben liegt, ein Unterordner nur mit seinem eigenen Inhalt.
    const { status, data } = await call(
      `/bots/${bot.id}/files?pfad=${encodeURIComponent('src')}`,
    );
    assert.equal(status, 200);
    assert.equal(data.ordner, 'src');
    assert.deepEqual(
      data.eintraege.map((f) => f.pfad),
      ['src/hilfe.py'],
    );
  });

  it('meldet einen Ordner, den es nicht gibt, als solchen', async () => {
    const { status, data } = await call(
      `/bots/${bot.id}/files?pfad=gibt%2Fes%2Fnicht`,
    );
    assert.equal(status, 404);
    assert.match(data.error, /gibt es nicht/);
  });

  it('liest eine Datei wieder', async () => {
    const { status, data } = await call(`/bots/${bot.id}/files/src/hilfe.py`);
    assert.equal(status, 200);
    assert.equal(data.pfad, 'src/hilfe.py');
    assert.equal(data.inhalt, 'x = 1');
  });

  it('schreibt beim zweiten Mal nicht unnötig um', async () => {
    const { data } = await call(`/bots/${bot.id}/files`, {
      method: 'POST',
      body: { uebernehmen: true },
    });
    assert.equal(data.files.kopiert, 0);
    assert.equal(data.files.unveraendert, 6);
  });

  it('übernimmt beim Speichern, was der Betreiber von Hand geändert hat', async () => {
    // Der Fall, für den es den Auslöser beim Speichern überhaupt gibt: eine
    // Datei, die ausserhalb des Panels im Startordner landet – mit dem Editor
    // daneben, auf dem Server, per Skript. Ohne den Auslöser liefe der Bot den
    // alten Code, ohne dass irgendwo eine Fehlermeldung stünde.
    writeFileSync(startordner('bot.py'), 'print("von Hand")', 'utf8');
    const { status, data } = await call(`/bots/${bot.id}`, {
      method: 'PATCH',
      body: {
        name: 'Dateibot',
        language: 'custom',
        entrypoint: 'bot.py',
        command: 'python3 {entrypoint}',
        // Im Testmodus muss `cwd` innerhalb von `bots/` liegen – dieselbe
        // Schranke wie sonst, nur mit dem Testwurzelverzeichnis als Bezug.
        cwd: `bots/${bot.id}/workspace`,
      },
    });
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.files.kopiert, 1);
    assert.equal(
      readFileSync(workspace('bot.py'), 'utf8'),
      'print("von Hand")',
    );
  });

  it('nimmt mit, was im Startordner gelöscht wurde', async () => {
    const { status, data } = await call(`/bots/${bot.id}/files/src/hilfe.py`, {
      method: 'DELETE',
    });
    assert.equal(status, 200);
    assert.equal(data.files.entfernt, 1);
    assert.ok(!existsSync(workspace('src', 'hilfe.py')));
  });

  it('lässt unangetastet, was der Bot im Container erzeugt hat', async () => {
    // `node_modules` steht nicht in der Merkliste: der Bot behält seine
    // Installation, und die nächste Übernahme wirft sie nicht weg.
    mkdirSync(workspace('node_modules', 'discord.js'), { recursive: true });
    writeFileSync(workspace('node_modules', 'discord.js', 'index.js'), 'bot');
    const { data } = await call(`/bots/${bot.id}/files/bot.py`, {
      method: 'PUT',
      body: { inhalt: 'print("noch neu")' },
    });
    assert.equal(data.files.entfernt, 0);
    assert.ok(existsSync(workspace('node_modules', 'discord.js', 'index.js')));
  });

  it('legt einen Ordner auf Zuruf an – auch in mehreren Ebenen', async () => {
    const { status } = await call(`/bots/${bot.id}/files`, {
      method: 'POST',
      body: { ordner: 'daten' },
    });
    assert.equal(status, 201);
    assert.ok(existsSync(startordner('daten')));
    assert.equal(statSync(startordner('daten')).mode & 0o777, 0o700);

    const tief = await call(`/bots/${bot.id}/files`, {
      method: 'POST',
      body: { ordner: 'daten/roh/2026' },
    });
    assert.equal(tief.status, 201);
    assert.ok(statSync(startordner('daten', 'roh', '2026')).isDirectory());

    // Und noch einmal: ein Ordner, der schon da ist, ist kein Fehler.
    const nochmal = await call(`/bots/${bot.id}/files`, {
      method: 'POST',
      body: { ordner: 'daten' },
    });
    assert.equal(nochmal.status, 201);
  });
});

describe('Der Startordner weist zu', () => {
  const pfad = (p) => `/files/${p}`;

  it('lässt keinen Pfad hinaus', async () => {
    for (const ziel of [
      '..%2F..%2F.env',
      '%2Fetc%2Fshadow',
      '%2E%2E%2F.env',
      '%20',
    ]) {
      const { status } = await call(`/bots/${bot.id}${pfad(ziel)}`, {
        method: 'PUT',
        body: { inhalt: 'x' },
      });
      assert.equal(status, 400, `hätte durchgelassen: ${ziel}`);
    }
    assert.ok(!existsSync(join(root, 'raus.txt')));
  });

  it('meldet eine fehlende Datei als solche', async () => {
    const { status, data } = await call(
      `/bots/${bot.id}${pfad('gibt/es/nicht.txt')}`,
    );
    assert.equal(status, 404);
    assert.match(data.error, /nicht gefunden/);
  });

  it('nimmt keine Binärdaten und keine zu grossen Dateien', async () => {
    const ohneInhalt = await call(`/bots/${bot.id}${pfad('leer.txt')}`, {
      method: 'PUT',
      body: { pfad: 'leer.txt' },
    });
    assert.equal(ohneInhalt.status, 400);

    // Unterhalb des Body-Limits, oberhalb der Dateigrösse: 400 mit klarer
    // Meldung, statt die Datei anzulegen und sie dann abzuschneiden.
    const zuGross = await call(`/bots/${bot.id}${pfad('gross.txt')}`, {
      method: 'PUT',
      body: { inhalt: 'x'.repeat(600 * 1024) },
    });
    assert.equal(zuGross.status, 400);
    assert.ok(!existsSync(startordner('gross.txt')));
    // Oberhalb des Body-Limits kappt `readBody` die Verbindung, statt zu
    // antworten – so verhält sich der Hub bei jeder Route. Die Datei ist
    // danach erst recht nicht entstanden.
  });

  it('schreibt nicht auf einen Ordner', async () => {
    await call(`/bots/${bot.id}/files`, {
      method: 'POST',
      body: { ordner: 'ordner' },
    });
    const { status } = await call(`/bots/${bot.id}${pfad('ordner')}`, {
      method: 'PUT',
      body: { inhalt: 'x' },
    });
    assert.equal(status, 400);
    assert.ok(statSync(startordner('ordner')).isDirectory());
  });

  it('legt keinen Ordner über eine Datei an', async () => {
    await call(`/bots/${bot.id}${pfad('bot.py')}`, {
      method: 'PUT',
      body: { inhalt: 'print("x")' },
    });
    const { status } = await call(`/bots/${bot.id}/files`, {
      method: 'POST',
      body: { ordner: 'bot.py' },
    });
    assert.equal(status, 400);
    assert.ok(statSync(startordner('bot.py')).isFile());
  });

  it('verweigert ein Löschen, das den Ordner leeren würde', async () => {
    await call(`/bots/${bot.id}${pfad('voll/a.txt')}`, {
      method: 'PUT',
      body: { inhalt: 'a' },
    });
    await call(`/bots/${bot.id}${pfad('voll/tief/b.txt')}`, {
      method: 'PUT',
      body: { inhalt: 'b' },
    });
    const { status, data } = await call(`/bots/${bot.id}${pfad('voll')}`, {
      method: 'DELETE',
    });
    // Ein Ordner ist im Explorer *eine* Zeile, und löschen heisst dort
    // „dieser Ordner samt Inhalt“. 404 wäre die Antwort auf die alte Frage
    // „darf dieser Ordner leer werden?“ – die stellt niemand mehr.
    assert.equal(status, 200);
    assert.equal(data.ordnerGeloescht, true);
    assert.equal(data.entfernt, 3, '2 Dateien und 1 Ordner');
    assert.ok(!existsSync(startordner('voll')));
    // Und beides ist auch aus dem Workspace verschwunden: die Merkliste
    // entscheidet das beim Spiegeln, nicht die Anfrage.
    assert.equal(data.files.entfernt, 2);
    assert.ok(!existsSync(workspace('voll')));
  });

  it('übernimmt die Dateien, bevor der Bot startet', async () => {
    // Der Start ist der dritte Auslöser. Ohne ihn würde ein Bot, den jemand
    // über die Schaltfläche startet, den Stand von eben fahren – und niemand
    // sähe einen Fehler.
    writeFileSync(startordner('bot.py'), 'print("frisch")', 'utf8');
    const { status } = await call(`/bots/${bot.id}/start`, { method: 'POST' });
    assert.equal(status, 202);
    for (
      let i = 0;
      i < 60 && readFileSync(workspace('bot.py'), 'utf8') !== 'print("frisch")';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(readFileSync(workspace('bot.py'), 'utf8'), 'print("frisch")');
    await call(`/bots/${bot.id}/stop`, { method: 'POST' });
  });

  it('lässt niemand ohne Berechtigung an die Dateien', async () => {
    // Der Testmodus schaltet die Anmeldung ab. `bots.manage` bleibt die
    // einzige Berechtigung, die hier zählt – sie zu prüfen wäre sonst eine
    // Sache für einen Test mit echter Anmeldung, den es hier nicht gibt.
    const { data } = await call(`/bots/${bot.id}/files`);
    assert.equal(data.startordner, `bots/${bot.id}/startordner`);
    // Es wird nichts zurückgegeben, was nicht im Startordner liegt.
    // (src/hilfe.py wurde weiter oben gelöscht, leere Ordner räumt der Hub weg.)
    assert.deepEqual(data.eintraege.map((f) => f.pfad).sort(), [
      'bot-hub.json',
      'bot.py',
      'daten',
      'ordner',
      'panel',
    ]);
  });
});
