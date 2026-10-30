/**
 * Maßnahme 51 (V27-F, Auftrag 5.3): der .NET-Init-Lauf und sein Symlink-
 * Schutz.
 *
 * Der Init-Lauf schreibt BEWUSST als root in den Bot-Workspace (das Erststart-
 * Sentinel liegt im Bild unter /root, ein Nicht-Root-Lauf käme nie dran).
 * Damit das gefahrlos ist, sichert `ensureWorkspaceDirNoFollow` die Pfade vor
 * ab – und genau dort waren zwei Löcher:
 *
 *  1. `ensureDotnetCliHome` schluckte Fehler der Prüfung und ließ den
 *     root-Lauf TROTZDEM laufen. Der Fall „Prüfung konnte nicht durchgreifen“
 *     (z. B. ein Verweis, dessen Entfernen scheitert) ist aber der einzige,
 *     in dem root einem Bot-Symlink folgen kann – er durfte dann erst recht
 *     nicht starten.
 *  2. `ensureWorkspaceDirNoFollow` akzeptierte ein `EEXIST` nach gelöschtem
 *     Eintrag still. Ein Writer im Workspace konnte die Stelle zwischen
 *     `unlink` und `mkdir` neu als Symlink setzen: Prüfung „ok“, root-Lauf
 *     folgt dem frischen Verweis. Jetzt harter Abbruch, wenn die Stelle kein
 *     echtes Verzeichnis trägt.
 *  Zusätzlich doppelte Boden im Container-Skript selbst: jeder Pfadteil wird
 *  vor und nach `mkdir -p` auf Symlinks geprüft, `chown -Rh` folgt keinen
 *  Verweisen mehr, und `--user 0:0` macht den Root-Lauf deterministisch
 *  (statt vom Bild-Default abzuhängen, der die Init still scheitern ließ).
 *
 * Docker wird nicht gebraucht: `BOT_HUB_CONTAINER_RUNTIME` (Modul-Top-Level,
 * muss VOR dem Import stehen) zeigt auf ein Stub-Skript, das seine Argumente
 * mitschreibt.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const arbeit = mkdtempSync(join(tmpdir(), 'v27-dotnet-init-'));
const protokolldatei = join(arbeit, 'docker-argumente.txt');
const stub = join(arbeit, 'docker-stub.sh');
writeFileSync(
  stub,
  '#!/bin/sh\nprintf \'run:%s\\n\' "$*" >> "$BOT_HUB_TEST_DOCKER_CAPTURE"\nexit 0\n',
  { mode: 0o755 },
);
process.env.BOT_HUB_CONTAINER_RUNTIME = stub;
process.env.BOT_HUB_TEST_DOCKER_CAPTURE = protokolldatei;

const { ensureWorkspaceDirNoFollow, ensureDotnetCliHome } =
  await import('../server/containers.js');

/** Frische Workspace-Instanz; `cleanup` macht auch read-only-Stellen weg. */
const neueWorkspace = (name) => {
  const root = mkdtempSync(join(arbeit, name));
  const workspace = join(root, 'bots', 'bot-1', 'workspace');
  mkdirSync(workspace, { recursive: true });
  return {
    root,
    workspace,
    bot: {
      id: 'bot-1',
      language: 'csharp',
      workspaceRoot: 'bots/bot-1/workspace',
    },
    protokoll: () => {
      try {
        return readFileSync(protokolldatei, 'utf8');
      } catch {
        return '';
      }
    },
    cleanup: () => {
      try {
        chmodSync(join(workspace, '.cache'), 0o755);
      } catch {
        /* .cache existiert vielleicht nie – das ist kein Fehler */
      }
      rmSync(root, { recursive: true, force: true });
      rmSync(protokolldatei, { force: true });
    },
  };
};

/* --------------------- Der Wächter der Workspace-Pfade -------------------- */

test('ein vorgelegter Symlink wird durch ein echtes Verzeichnis ersetzt', () => {
  const { workspace, cleanup } = neueWorkspace('symlink-');
  try {
    const cache = join(workspace, '.cache');
    mkdirSync(cache);
    symlinkSync('/etc', join(cache, 'dotnet-cli-home'));
    ensureWorkspaceDirNoFollow(
      workspace,
      '.cache',
      'dotnet-cli-home',
      '.dotnet',
    );
    assert.ok(lstatSync(join(cache, 'dotnet-cli-home')).isDirectory());
    assert.ok(
      lstatSync(join(cache, 'dotnet-cli-home', '.dotnet')).isDirectory(),
    );
  } finally {
    cleanup();
  }
});

test('eine vorgelegte Datei wird ebenfalls ersetzt', () => {
  const { workspace, cleanup } = neueWorkspace('datei-');
  try {
    const cache = join(workspace, '.cache');
    mkdirSync(cache);
    writeFileSync(join(cache, 'tmp'), 'bot-muell');
    ensureWorkspaceDirNoFollow(workspace, '.cache', 'tmp');
    assert.ok(lstatSync(join(cache, 'tmp')).isDirectory());
  } finally {
    cleanup();
  }
});

test('ein nicht entfernbarer Verweis wirft, statt still zu „gelingen“', () => {
  /* Der eigentliche Tausch-Wettlauf ist deterministisch nicht stellbar –
   * wohl aber sein Gefahrfall: eine Stelle, die als Symlink vorliegt und
   * deren Entfernung scheitert. Vor Maßnahme 51 konnte die Funktion hier
   * durchrutschen, jetzt wirft sie (EACCES beim unlink, ESWAPPED bei einem
   * Zwischenzustand) und hinterlässt den Verweis unangetastet. */
  const { workspace, cleanup } = neueWorkspace('renne-');
  try {
    const cache = join(workspace, '.cache');
    mkdirSync(cache);
    symlinkSync('/etc', join(cache, 'dotnet-cli-home'));
    chmodSync(cache, 0o555); // Verweis nicht entfernbar
    assert.throws(
      () => ensureWorkspaceDirNoFollow(workspace, '.cache', 'dotnet-cli-home'),
      (error) => error.code === 'EACCES' || error.code === 'ESWAPPED',
    );
    chmodSync(cache, 0o755);
    assert.ok(lstatSync(join(cache, 'dotnet-cli-home')).isSymbolicLink());
  } finally {
    cleanup();
  }
});

/* ------------------------ Der root-Init-Lauf ------------------------------ */

test('der Init-Lauf läuft mit festem root, doppeltem Symlinkschutz und -h-chown', async () => {
  const { root, workspace, bot, protokoll, cleanup } = neueWorkspace('lauf-');
  try {
    await ensureDotnetCliHome(bot, root);
    const protokolltext = protokoll();
    assert.match(protokolltext, /--user 0:0/, 'fester root statt Bild-Default');
    assert.match(
      protokolltext,
      /\[ ! -L /,
      'Symlinkprüfung im Container-Skript',
    );
    assert.match(protokolltext, /chown -Rh/, 'chown folgt keinen Verweisen');
    assert.match(protokolltext, /--network none/);
    // Die Host-Vorprüfung hat die Pfade als echte Verzeichnisse angelegt.
    assert.ok(
      lstatSync(
        join(workspace, '.cache', 'dotnet-cli-home', '.dotnet'),
      ).isDirectory(),
    );
    assert.ok(
      lstatSync(
        join(workspace, '.cache', 'xdg-data', 'NuGet', 'Migrations'),
      ).isDirectory(),
    );
  } finally {
    cleanup();
  }
});

test('das mitgegebene Container-Skript ist gültige Shell und verteidigt sich', async () => {
  /* Der Stub hat das echte -c-Skript mitgeschrieben: Es wird hier wirklich
   * mit /bin/sh geprüft (Syntax) und funktional nachgestellt (Pfadteile
   * umgebogen). Vor Maßnahme 51 wäre ein `set -e && for …`-Fügefehler nur
   * gegen einen antwortenden Stub unsichtbar geblieben. */
  const { root, workspace, bot, protokoll, cleanup } = neueWorkspace('skript-');
  try {
    await ensureDotnetCliHome(bot, root);
    const protokolltext = protokoll();
    assert.match(protokolltext, / -c /, 'kein Skript im Protokoll');
    const skript = protokolltext.slice(protokolltext.indexOf(' -c ') + 4);
    // 1) Syntax: echte Shell, nur Parse.
    execFileSync('/bin/sh', ['-c', 'sh -n'], { input: skript });
    // 2) Funktion: Pfade umbiegen, Saatkorn für find anlegen, laufen lassen.
    const nachbauer = join(root, 'container');
    const pseudoWorkspace = join(nachbauer, 'workspace');
    const pseudoRoot = join(nachbauer, 'root', '.dotnet');
    mkdirSync(pseudoWorkspace, { recursive: true });
    mkdirSync(pseudoRoot, { recursive: true });
    writeFileSync(join(pseudoRoot, '1234.dotnetFirstUseSentinel'), 'sentinel');
    const umgebogen = skript
      .replaceAll('/workspace', pseudoWorkspace)
      .replaceAll('/root/.dotnet', pseudoRoot);
    execFileSync('/bin/sh', ['-c', umgebogen]);
    assert.equal(
      existsSync(
        join(
          pseudoWorkspace,
          '.cache',
          'dotnet-cli-home',
          '.dotnet',
          '1234.dotnetFirstUseSentinel',
        ),
      ),
      true,
      'Sentinel wurde nicht kopiert',
    );
    assert.ok(
      existsSync(
        join(pseudoWorkspace, '.cache', 'xdg-data', 'NuGet', 'Migrations', '1'),
      ),
      'Migrations-Marker fehlt',
    );
    // 3) Derselbe Lauf gegen einen vorgelegten Symlink: Abbruch, keine Folge.
    rmSync(join(pseudoWorkspace, '.cache', 'dotnet-cli-home'), {
      recursive: true,
      force: true,
    });
    const falle = join(root, 'falle');
    mkdirSync(falle);
    symlinkSync(falle, join(pseudoWorkspace, '.cache', 'dotnet-cli-home'));
    assert.throws(() => execFileSync('/bin/sh', ['-c', umgebogen]));
    assert.deepEqual(
      readdirSync(falle),
      [],
      'das Skript hat ins Symlink-Ziel geschrieben',
    );
  } finally {
    cleanup();
  }
});

test('scheitert die Vorprüfung, darf der root-Lauf NICHT starten', async () => {
  const { root, workspace, bot, protokoll, cleanup } =
    neueWorkspace('uebersprung-');
  try {
    const cache = join(workspace, '.cache');
    mkdirSync(cache);
    symlinkSync('/home', join(cache, 'dotnet-cli-home'));
    // Eltern schreibgeschützt: der Wächter kann den Verweis nicht entfernen.
    chmodSync(cache, 0o555);
    const warnungen = [];
    const vorherWarnung = console.warn;
    console.warn = (...arg) => warnungen.push(arg.join(' '));
    try {
      await ensureDotnetCliHome(bot, root);
    } finally {
      console.warn = vorherWarnung;
    }
    assert.equal(
      protokoll(),
      '',
      'root-Lauf trotz gescheiterter Prüfung gestartet',
    );
    assert.ok(
      warnungen.some((text) => text.includes('.NET-Init')),
      `keine Warnung über den Übersprung: ${JSON.stringify(warnungen)}`,
    );
    // Der Symlink ist unangetastet – root ist ihm nicht gefolgt.
    assert.ok(lstatSync(join(cache, 'dotnet-cli-home')).isSymbolicLink());
  } finally {
    cleanup();
  }
});
