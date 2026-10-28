/**
 * Regressionstests für die Befehls- und Installationsprüfung.
 *
 * Betroffen sind zwei Fehler, die eine frühere Härtung selbst eingebaut hat:
 * der Gradle-Wrapper `./gradlew` wurde abgelehnt, wodurch Java und Kotlin gar
 * nicht mehr installieren konnten, und der Go-/Rust-Zweig führte die Befehle
 * hintereinander aus, obwohl der zweite den ersten ersetzen sollte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LANGUAGES, fillDeps } from '../server/languages.js';
import { __testing, openDirsForRemoval } from '../server/manager.js';

const { commandSpec, resolveInstallPlan } = __testing;

const roots = [];
/**
 * `files` beschreibt Dateien im Workspace. Ein Eintrag kann eine Zeichenkette
 * sein oder `{ value, mode }`, um das Ausführbit zu setzen.
 */
const workspace = (files = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cmd-'));
  roots.push(root);
  for (const [name, entry] of Object.entries(files)) {
    const value = typeof entry === 'string' ? entry : entry.value;
    const mode = typeof entry === 'string' ? undefined : entry.mode;
    writeFileSync(join(root, name), value);
    if (mode !== undefined) chmodSync(join(root, name), mode);
  }
  return root;
};

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const language = (id) => LANGUAGES.find((item) => item.id === id);

const plan = (id, deps, dir) =>
  resolveInstallPlan(language(id).install, dir, deps);

test('Installationsbefehle: Bedingung entscheidet, nicht die Reihenfolge', async (t) => {
  await t.test('Java ohne Wrapper baut mit Maven', () => {
    assert.deepEqual(plan('java', { package: 'jda' }, workspace()), [
      ['mvn', '-q', '-DskipTests', 'package'],
    ]);
  });

  await t.test('Java mit ausführbarem Wrapper nutzt ./gradlew', () => {
    const dir = workspace({ gradlew: { mode: 0o755, value: '#!/bin/sh\n' } });
    // Der Pfad wird erst beim Ausführen aufgelöst.
    assert.deepEqual(plan('java', { package: 'jda' }, dir), [
      ['./gradlew', 'build'],
    ]);
  });

  await t.test('Java: Wrapper ohne Ausführbit fällt auf Maven zurück', () => {
    const dir = workspace({ gradlew: { mode: 0o644, value: '#!/bin/sh\n' } });
    assert.deepEqual(plan('java', { package: 'jda' }, dir), [
      ['mvn', '-q', '-DskipTests', 'package'],
    ]);
  });

  await t.test('Java: Wrapper als SymLink nach draußen gilt nicht', () => {
    const dir = workspace();
    try {
      symlinkSync('/bin/sh', join(dir, 'gradlew'));
    } catch {
      return; // ohne Rechte nicht prüfbar
    }
    assert.deepEqual(plan('java', { package: 'jda' }, dir), [
      ['mvn', '-q', '-DskipTests', 'package'],
    ]);
  });

  await t.test('Go ohne go.mod initialisiert und holt danach das Modul', () => {
    // Als Ersatz gelesen wäre `go mod init` der letzte Schritt und das Modul
    // fehlte. Die Folge ist der ganze Sinn des else-Zweigs.
    assert.deepEqual(
      plan('go', { module: 'github.com/bwmarrin/discordgo' }, workspace()),
      [
        ['go', 'mod', 'init', 'bot'],
        ['go', 'get', 'github.com/bwmarrin/discordgo'],
      ],
    );
  });

  await t.test('Go mit go.mod holt nur das Modul', () => {
    const dir = workspace({ 'go.mod': 'module bot\n' });
    assert.deepEqual(plan('go', { module: 'github.com/x/y' }, dir), [
      ['go', 'get', 'github.com/x/y'],
    ]);
  });

  await t.test('Rust folgt demselben Muster', () => {
    assert.deepEqual(plan('rust', { package: 'serenity' }, workspace()), [
      ['cargo', 'init', '--name', 'bot'],
      ['cargo', 'add', 'serenity'],
    ]);
    const withManifest = workspace({ 'Cargo.toml': '[package]\n' });
    assert.deepEqual(plan('rust', { package: 'poise' }, withManifest), [
      ['cargo', 'add', 'poise'],
    ]);
  });

  await t.test('Sprachen ohne Bedingung bleiben ein Schritt', () => {
    // Der Befehl bleibt Text und geht durch dieselbe Prüfung wie ein
    // eingegebener Befehl – deshalb wird er hier nicht zerlegt.
    assert.deepEqual(
      plan('javascript', { package: 'discord.js' }, workspace()),
      [['npm install --no-fund --no-audit discord.js']],
    );
  });

  await t.test('eine Bedingung darf nicht aus dem Ordner hinaus zeigen', () => {
    const original = language('go').install;
    language('go').install = {
      ...original,
      if: { file: '../../../etc/passwd' },
    };
    try {
      assert.deepEqual(plan('go', { module: 'x' }, workspace()), [
        ['go', 'mod', 'init', 'bot'],
        ['go', 'get', 'x'],
      ]);
    } finally {
      language('go').install = original;
    }
  });

  await t.test('Platzhalter werden ersetzt', () => {
    assert.deepEqual(plan('python', { package: 'discord.py' }, workspace()), [
      ['python3 -m pip install --disable-pip-version-check discord.py'],
    ]);
  });
});

test('Befehlsprüfung: Programme aus dem freigegebenen Runtime', async (t) => {
  const bot = {
    language: 'java',
    framework: 'JDA',
    command: '',
    depsCheck: '',
    depsInstall: '',
  };
  const dir = workspace({ gradlew: { mode: 0o755, value: '#!/bin/sh\n' } });

  await t.test('./gradlew ist im eigenen Ordner erlaubt', () => {
    const spec = commandSpec(bot, './gradlew build', dir, 'dependency');
    assert.equal(spec.executable, join(dir, 'gradlew'));
    assert.deepEqual(spec.args, ['build']);
  });

  await t.test('./gradlew ohne Ausführbit wird abgelehnt', () => {
    const plain = workspace({ gradlew: { mode: 0o644, value: 'x' } });
    assert.throws(
      () => commandSpec(bot, './gradlew build', plain, 'dependency'),
      /freigegebenen Runtime/,
    );
  });

  await t.test('ein Wrapper als SymLink nach draußen wird abgelehnt', () => {
    const linked = workspace();
    try {
      symlinkSync('/bin/sh', join(linked, 'gradlew'));
    } catch {
      return;
    }
    assert.throws(
      () => commandSpec(bot, './gradlew build', linked, 'dependency'),
      /freigegebenen Runtime/,
    );
  });

  await t.test('ein beliebiges ./programm ist nicht erlaubt', () => {
    const other = workspace({ evil: { mode: 0o755, value: '#!/bin/sh\n' } });
    assert.throws(
      () => commandSpec(bot, './evil', other, 'dependency'),
      /freigegebenen Runtime/,
    );
  });

  await t.test('./Programme des eigenen Baus sind beim Start erlaubt', () => {
    // Das Rust-Preset startet `./target/release/bot` – der Hub muss seine
    // eigenen Sprach-Presets ausführen können (Bug 29).
    const rust = {
      language: 'rust',
      framework: 'Serenity',
      command: '',
      depsCheck: '',
      depsInstall: '',
    };
    const built = workspace();
    mkdirSync(join(built, 'target', 'release'), { recursive: true });
    writeFileSync(join(built, 'target', 'release', 'bot'), '#!/bin/sh\n', {
      mode: 0o755,
    });
    const spec = commandSpec(rust, './target/release/bot', built, 'start');
    assert.equal(spec.executable, join(built, 'target', 'release', 'bot'));
  });

  await t.test('ein fehlendes ./Programm bleibt beim Start abgelehnt', () => {
    const rust = {
      language: 'rust',
      framework: 'Serenity',
      command: '',
      depsCheck: '',
      depsInstall: '',
    };
    assert.throws(
      () => commandSpec(rust, './target/release/bot', workspace(), 'start'),
      /freigegebenen Runtime/,
    );
  });

  await t.test('./SymLink nach draußen wird beim Start abgelehnt', () => {
    const linked = workspace();
    try {
      symlinkSync('/bin/sh', join(linked, 'bot'));
    } catch {
      return;
    }
    const custom = {
      language: 'custom',
      framework: 'Shell',
      command: '',
      depsCheck: '',
      depsInstall: '',
    };
    assert.throws(
      () => commandSpec(custom, './bot', linked, 'start'),
      /freigegebenen Runtime/,
    );
  });

  await t.test('absolute Pfade bleiben abgelehnt', () => {
    assert.throws(
      () => commandSpec(bot, '/bin/sh -c ls', dir, 'dependency'),
      /freigegebenen Runtime/,
    );
  });

  await t.test('Ausbruch über ../ bei einem Argument wird abgelehnt', () => {
    assert.throws(
      () => commandSpec(bot, 'mvn ../../../../etc/passwd', dir, 'dependency'),
      /außerhalb des Bot-Workspace/,
    );
  });

  await t.test('die Freigabeliste hängt am Zweck, nicht an der Sprache', () => {
    const shell = { language: 'custom', framework: 'Shell', command: '' };
    assert.doesNotThrow(() =>
      commandSpec(shell, 'bash install.sh', dir, 'dependency'),
    );
    // Beim Start ist die Liste eng: nur die Runtime der Sprache.
    assert.throws(
      () => commandSpec(bot, 'cargo build', dir, 'start'),
      /nicht freigegeben/,
    );
    // Beim Installieren gehören die Werkzeuge aller unterstützten Sprachen
    // dazu. Das ist vertretbar, weil ohnehin alles im eigenen Workspace läuft –
    // entscheidend ist die Workspace-Schranke, nicht die Sprache.
    assert.doesNotThrow(() =>
      commandSpec(bot, 'cargo build', dir, 'dependency'),
    );
  });

  await t.test(
    'Werkzeuge des Installationsschritts erreichen nichts außerhalb',
    () => {
      assert.throws(
        () => commandSpec(bot, 'go get ../../outside/mod', dir, 'dependency'),
        /außerhalb des Bot-Workspace/,
      );
    },
  );
});

test('fillDeps lässt leere Platzhalter nicht als Text stehen', () => {
  assert.equal(fillDeps('x {package}', { package: '' }), 'x ');
  assert.equal(fillDeps('x {missing}', {}), 'x {missing}');
});

test('read-only Cache-Verzeichnisse blockieren die Löschung nicht (Maßnahme 32)', () => {
  // Go-Modul-Cache legt Verzeichnisse im Modus 0555 an – ohne Öffnung
  // scheitert rmSync mit EACCES (als root-Prozess hingegen nicht, deshalb
  // läuft der Erwartungsteil nur unter unprivilegierten Usern).
  const root = mkdtempSync(join(tmpdir(), 'bot-hub-open-'));
  const cache = join(root, 'workspace', '.cache');
  const kalt = join(cache, 'go-mod', 'x@v1', '.github');
  mkdirSync(kalt, { recursive: true });
  writeFileSync(join(kalt, 'workflows.yml'), 'x');
  writeFileSync(join(cache, 'readme'), 'x');
  chmodSync(join(cache, 'go-mod', 'x@v1'), 0o555);
  chmodSync(kalt, 0o555);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    assert.throws(
      () => rmSync(join(root, 'workspace'), { recursive: true }),
      /EACCES/,
      '0555-Verzeichnis muss rmSync ohne Öffnung blockieren',
    );
  }
  openDirsForRemoval(join(root, 'workspace'));
  rmSync(join(root, 'workspace'), { recursive: true, force: true });
  assert.ok(!existsSync(join(root, 'workspace')));
  rmSync(root, { recursive: true, force: true });
});

test('openDirsForRemoval folgt keinen Symlinks (Maßnahme 32)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bot-hub-link-'));
  const innen = join(root, 'workspace');
  const gezielt = join(root, 'fremd');
  mkdirSync(join(innen, 'd'), { recursive: true });
  mkdirSync(gezielt);
  symlinkSync(gezielt, join(innen, 'd', 'zeiger'));
  chmodSync(gezielt, 0o555);
  openDirsForRemoval(innen);
  // Der Zielordner des Symlinks bleibt unverändert 0555 – es wurde nur
  // der Symlink-Eintrag selbst (nicht sein Ziel) begangen.
  assert.equal(statSync(gezielt).mode & 0o777, 0o555);
  rmSync(root, { recursive: true, force: true });
});
