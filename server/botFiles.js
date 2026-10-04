/**
 * Der Startordner eines Bots – die Quelle, aus der der Workspace entsteht.
 *
 * Zwei Ordner, und der Unterschied ist der ganze Punkt:
 *
 *   bots/<id>/startordner/   der Startordner: vom Betreiber gepflegt, über das
 *                             Panel gefüllt, **nie** in einen Container gemountet
 *   bots/<id>/workspace/     die Kopie: genau das hängt als `/workspace` ein
 *
 * Solange Workspace und Startordner derselbe Ordner wären, hätte der Bot genau
 * den Ordner des Betreibers als Arbeitsverzeichnis: er schriebe seine
 * `node_modules`, seine Caches und seine Experimentierreste dorthin, und jede
 * seiner Dateien läge ungefragt zwischen den Quelldateien. Mit der Trennung ist
 * der Startordner das, was der Betreiber schreibt, und der Workspace das, was
 * der Bot bekommt.
 *
 * Gespiegelt wird mit einer Merkliste (`start-sync.json`, neben dem
 * Startordner, also ausserhalb des gemounteten Workspace). Sie merkt sich
 * Grösse und Inhaltsprüfsumme jeder Datei, die der Hub zuletzt geschrieben
 * hat, und beantwortet damit zwei Fragen: „gehört diese Datei dem Betreiber
 * oder dem Bot?“ und „hat sich seit dem letzten Mal etwas geändert?“. Alles,
 * was nicht in der Liste steht, gehört dem Bot – die `node_modules`, die er
 * selbst installiert hat, bleiben deshalb, wo sie sind. Das Kopieren entscheidet
 * der Inhalt, nicht der Zeitstempel: Dateisysteme, die auf Sekunden runden,
 * liefern für dieselbe Datei andere Zahlen, und in der Sekunde, in der der Bot
 * eine Datei anfasst, wäre eine Änderung über `mtime` gar nicht zu sehen.
 *
 * Bewusst nicht gespiegelt werden `.env`, `.env.*` und `.git`. Geheimnisse
 * kommen aus `data/secrets/<id>.env` und werden als Umgebung gesetzt; ein
 * `.env` im Startordner zu kopieren hieße, sie in den Container zu legen, wo
 * jeder Prozess des Bots sie lesen kann. Übersprungene Einträge werden
 * gemeldet statt verschwiegen – ein still fehlendes `config.py` ist schlimmer
 * als ein Hinweis im Protokoll.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Was der Hub auf einmal spiegelt. Ein Bot-Projekt ist Handvoll Dateien. */
export const MAX_SYNC_BYTES = 64 * 1024 * 1024;
/** Wie viele Dateien die Oberfläche anzeigt. */
export const MAX_LIST_ENTRIES = 2000;
/** Wie viele Zeichen ein Pfad im Startordner haben darf. */
const MAX_PATH_LENGTH = 200;
/** Wie gross eine einzelne Datei sein darf. Der Hub führt Text, keine Bilder. */
export const MAX_FILE_BYTES = 512 * 1024;

/**
 * Einträge, die nie in den Workspace wandern. Anders als bei der
 * Workspace-Migration (siehe `manager.js`) wird hier nichts an der Benennung
 * von *Geheimnissen* erraten: `secrets.py` ist Quellcode und gehört in den
 * Bot. Nur zwei Namen sind ausgeschlossen, beide aus einem konkreten Grund.
 */
const SKIPPED = new Set(['.git', '.env', '.svn', '.hg']);

/** Relativer Pfad des Startordners – die Form, die auch in `bots.json` steht. */
export const startFolderOf = (bot) => `bots/${bot.id}/startordner`;

/** Wo der Workspace eines Bots liegt; identisch zu `containers.js`. */
export const workspaceOf = (bot) =>
  bot.workspaceRoot || `bots/${bot.id}/workspace`;

export const startFolderPath = (bot, projectRoot) =>
  resolve(projectRoot, startFolderOf(bot));
export const workspacePath = (bot, projectRoot) =>
  resolve(projectRoot, workspaceOf(bot));

const manifestPath = (bot, projectRoot) =>
  join(projectRoot, 'bots', bot.id, 'start-sync.json');

/** Anlegen mit 0700. Mehrfach aufrufbar – der Hub ruft das bei jedem `hydrate`. */
export const ensureStartFolder = (bot, projectRoot) => {
  const ordner = startFolderPath(bot, projectRoot);
  mkdirSync(ordner, { recursive: true, mode: 0o700 });
  return ordner;
};

/**
 * Ein Pfad im Startordner – oder `null`, wenn er nicht hineingehört.
 *
 * Drei Schranken, in dieser Reihenfolge, weil jede die vorige voraussetzt:
 *
 *  1. Der Pfad ist relativ, kurz und kommt nicht nach oben. Ein `../../.env`
 *     oder ein `/etc/shadow` fällt hier schon weg.
 *  2. Der Startordner selbst ist es wert, was er nach `realpath` ist – er
 *     könnte auf dem Host ein Symlink sein.
 *  3. Auch der tiefste bereits vorhandene Teil des Ziels muss im echten
 *     Startordner liegen. Ein Operator, der im Startordner einen Symlink
 *     anlegt, würde sonst darüber den ganzen Host beschreiben können.
 */
export const safeStartPath = (bot, projectRoot, input) => {
  const relat = String(input ?? '')
    .replace(/\\/g, '/')
    .trim();
  if (!relat) return null;
  if (
    isAbsolute(relat) ||
    relat === '~' ||
    relat.length > MAX_PATH_LENGTH ||
    relat.includes('\0')
  )
    return null;
  const teile = relat.split('/').filter((teil) => teil && teil !== '.');
  if (!teile.length) return null;
  if (teile.some((teil) => teil === '..')) return null;

  const ordner = startFolderPath(bot, projectRoot);
  try {
    const echterStart = realpathOrSelf(ordner);
    // Solange der Zielordner nicht existiert, ist sein tiefster vorhandener
    // Elternteil das Maß – sonst fände `realpath` gar nichts.
    let probe = join(echterStart, ...teile);
    while (!existsSync(probe)) {
      const eltern = dirname(probe);
      const drin = relative(echterStart, eltern);
      if (!drin || drin.startsWith('..') || isAbsolute(drin)) break;
      probe = eltern;
    }
    const echterProbe = realpathOrSelf(probe);
    const innen = relative(echterStart, echterProbe);
    if (!innen || innen.startsWith('..') || isAbsolute(innen)) return null;
    return join(ordner, ...teile);
  } catch {
    return null;
  }
};

/** `realpathSync` mit `lstatSync` als Rückfall: existiert der Pfad noch nicht? */
const realpathOrSelf = (pfad) => {
  try {
    return realpathSync(pfad);
  } catch {
    return resolve(pfad);
  }
};

/**
 * Alles unterhalb von `wurzel`, als Map von relativem Pfad auf
 * `{ groesse, mtimeMs }`. Symlinks, `.git` und `.env*` bleiben außen vor, und
 * alles, was keine normale Datei ist, wird ebenfalls übersprungen.
 */
const sammle = (wurzel, { melden } = {}) => {
  const gefunden = new Map();
  const uebersprungen = new Set();
  const stapel = [{ ordner: wurzel, praefix: '' }];
  let bytes = 0;

  while (stapel.length) {
    const { ordner, praefix } = stapel.pop();
    let eintraege;
    try {
      eintraege = readdirSync(ordner, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const eintrag of eintraege) {
      const name = eintrag.name;
      const rel = praefix ? `${praefix}/${name}` : name;
      const voll = join(ordner, name);
      if (eintrag.isSymbolicLink()) {
        // Ein Symlink im Startordner zeigte auf irgendwohin – möglicherweise
        // nach `/etc`. Ihn zu kopieren hieße, dem Bot zu geben, was dort steht.
        uebersprungen.add(`${rel} (Verweis)`);
        continue;
      }
      if (eintrag.isDirectory()) {
        if (SKIPPED.has(name)) {
          uebersprungen.add(`${rel}/`);
          continue;
        }
        stapel.push({ ordner: voll, praefix: rel });
        continue;
      }
      if (!eintrag.isFile()) {
        uebersprungen.add(`${rel} (keine Datei)`);
        continue;
      }
      if (name === '.env' || name.startsWith('.env.')) {
        uebersprungen.add(`${rel} (Geheimnis)`);
        continue;
      }
      let stat;
      try {
        stat = lstatSync(voll);
      } catch {
        continue;
      }
      bytes += stat.size;
      if (bytes > MAX_SYNC_BYTES) {
        throw Object.assign(
          new Error(
            `Der Startordner ist grösser als ${Math.round(MAX_SYNC_BYTES / 1024 / 1024)} MB. Bitte die Befüllung verringern – node_modules und Caches gehören nicht hinein.`,
          ),
          { status: 413 },
        );
      }
      gefunden.set(rel, { groesse: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  if (melden) melden(uebersprungen);
  return gefunden;
};

const merklisteLesen = (bot, projectRoot) => {
  const datei = manifestPath(bot, projectRoot);
  try {
    const wert = JSON.parse(readFileSync(datei, 'utf8'));
    const dateien = wert?.dateien;
    return dateien && typeof dateien === 'object' ? dateien : {};
  } catch {
    // Keine Merkliste: dann ist alles im Workspace unbekannt, und der erste
    // Durchgang schreibt nur. Nichts wird gelöscht, was man nicht belegen kann.
    return {};
  }
};

const merklisteSchreiben = (bot, projectRoot, dateien) => {
  const datei = manifestPath(bot, projectRoot);
  const temp = `${datei}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ stand: Date.now(), dateien }), {
    mode: 0o600,
  });
  renameSync(temp, datei);
};

const hashOf = (datei) =>
  createHash('sha256').update(readFileSync(datei)).digest('hex');

/**
 * Steht die Datei im Workspace noch so, wie der Hub sie zuletzt abgelegt hat?
 *
 * Geprüft wird **beides**: der Inhalt im Startordner gegen die Merkliste (hat
 * der Betreiber etwas geändert?) und der Inhalt im Workspace gegen dieselbe
 * Merkliste (hat der Bot im Container etwas geändert?). Nur die zweite Hälfte
 * zu prüfen wäre genug fürs Funktionieren, aber nicht für die Frage, die am
 * Anfang stand: wem gehört die Datei? Wer sie im Container verändert hat,
 * verliert sie beim nächsten Durchgang – sonst gewönne der Bot mit der Zeit
 * das Recht, die eigene Quelle zu überschreiben.
 */
const istUnveraendert = (nach, bekannt, quellHash) => {
  if (!Array.isArray(bekannt)) return false;
  const [groesse, hash] = bekannt;
  if (quellHash !== hash) return false;
  try {
    const ist = lstatSync(nach);
    // Kein `stat`: ein Verweis im Workspace würde auf ein Ziel außerhalb
    // zeigen, und dessen Inhalt hätte mit dem Bot nichts zu tun.
    if (!ist.isFile() || ist.size !== groesse) return false;
    return hashOf(nach) === hash;
  } catch {
    return false;
  }
};

/** Leere Elternordner aufräumen, aber nie den Workspace selbst. */
const aufraeumen = (wurzel, datei) => {
  let ordner = dirname(datei);
  while (true) {
    const drin = relative(wurzel, ordner);
    if (!drin || drin.startsWith('..') || isAbsolute(drin)) return;
    try {
      if (readdirSync(ordner).length) return;
      // `rmSync` ohne `recursive` weigert sich, leere Ordner zu löschen – und
      // `recursive: true` auf einem Ordner, in dem doch noch etwas liegt, wäre
      // genau das falsche Werkzeug.
      rmdirSync(ordner);
    } catch {
      return;
    }
    ordner = dirname(ordner);
  }
};

/**
 * Den Startordner in den Workspace spiegeln.
 *
 * Rückgabe: `{ kopiert, entfernt, unveraendert, uebersprungen }` – Zahlen, die
 * die Oberfläche zeigen kann, und keine Dateinamen, die ein Log aufblähen.
 * Wirft, statt halb zu spiegeln: ein Workspace, in dem die Hälfte fehlt, ist
 * schlimmer als ein Start, der mit einer klaren Meldung abbricht.
 */
export const sync = (bot, projectRoot) => {
  const quelle = startFolderPath(bot, projectRoot);
  const ziel = workspacePath(bot, projectRoot);
  if (!existsSync(quelle))
    return {
      kopiert: 0,
      entfernt: 0,
      unveraendert: 0,
      uebersprungen: [],
    };

  const uebersprungen = new Set();
  const jetzt = sammle(quelle, {
    melden: (liste) => liste.forEach((e) => uebersprungen.add(e)),
  });
  const alt = merklisteLesen(bot, projectRoot);

  mkdirSync(ziel, { recursive: true, mode: 0o700 });

  let kopiert = 0;
  let unveraendert = 0;
  const merkliste = {};
  for (const [rel, info] of jetzt) {
    const von = join(quelle, rel);
    const nach = join(ziel, rel);
    const inhalt = hashOf(von);
    // Verglichen wird der Inhalt, nicht der Zeitstempel. Ein Dateisystem, das
    // auf Sekunden rundet, und eines mit Nanosekunden liefern verschiedene
    // Zahlen für dieselbe Datei – ein Vergleich über `mtime` kopierte also je
    // nach Platte alles neu, und in der Sekunde, in der der Bot seine Datei
    // anfasst, wäre die Änderung nicht zu sehen.
    //
    // Die Merkliste entsteht im selben Durchgang: die Prüfsumme steht hier
    // schon in der Hand, und ein zweites Lesen derselben Datei wäre
    // Verschwendung.
    merkliste[rel] = [info.groesse, inhalt];
    if (istUnveraendert(nach, alt[rel], inhalt)) {
      unveraendert += 1;
      continue;
    }
    mkdirSync(join(nach, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(von, nach);
    // Der Zeitstempel wandert mit. Er ist Anzeige, keine Entscheidung – aber
    // ein Workspace, in dem alles „gerade eben“ trägt, lädt zum Grübeln ein.
    utimesSync(nach, new Date(info.mtimeMs), new Date(info.mtimeMs));
    kopiert += 1;
  }

  // Nur, was die alte Merkliste kennt, wird entfernt. Der Rest gehört dem Bot.
  let entfernt = 0;
  for (const rel of Object.keys(alt)) {
    if (jetzt.has(rel)) continue;
    const nach = join(ziel, rel);
    // Der Pfad kam aus einer Datei, die der Hub selbst geschrieben hat – aber
    // geprüft wird er trotzdem noch einmal, denn die Merkliste ist ein Text auf
    // der Platte.
    const innen = relative(ziel, nach);
    if (!innen || innen.startsWith('..') || isAbsolute(innen)) continue;
    try {
      const stat = lstatSync(nach);
      if (stat.isDirectory()) continue;
      rmSync(nach, { force: true });
      aufraeumen(ziel, nach);
      entfernt += 1;
    } catch {
      // Schon weg – etwa weil der Betreiber ihn selbst gelöscht hat.
    }
  }

  merklisteSchreiben(bot, projectRoot, merkliste);
  return {
    kopiert,
    entfernt,
    unveraendert,
    uebersprungen: [...uebersprungen],
  };
};

/** Alle Dateien im Startordner, für die Oberfläche. */
export const list = (bot, projectRoot) => {
  const quelle = startFolderPath(bot, projectRoot);
  if (!existsSync(quelle))
    return { dateien: [], uebersprungen: [], mehr: false };
  const uebersprungen = new Set();
  const gefunden = sammle(quelle, {
    melden: (liste) => liste.forEach((e) => uebersprungen.add(e)),
  });
  const alle = [...gefunden.keys()].sort();
  return {
    dateien: alle.slice(0, MAX_LIST_ENTRIES).map((pfad) => ({
      pfad,
      groesse: gefunden.get(pfad).groesse,
      mtimeMs: gefunden.get(pfad).mtimeMs,
    })),
    uebersprungen: [...uebersprungen].slice(0, 20),
    mehr: alle.length > MAX_LIST_ENTRIES,
  };
};

export const read = (bot, projectRoot, pfad) => {
  const ziel = safeStartPath(bot, projectRoot, pfad);
  if (!ziel) return null;
  try {
    const stat = lstatSync(ziel);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_BYTES) return null;
    return {
      inhalt: readFileSync(ziel, 'utf8'),
      groesse: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
};

/**
 * Eine Datei schreiben. Gibt `false` zurück, wenn der Pfad nicht in den
 * Startordner gehört – die Route macht daraus eine 400 mit lesbarer Meldung.
 */
export const write = (bot, projectRoot, pfad, inhalt) => {
  const ziel = safeStartPath(bot, projectRoot, pfad);
  if (!ziel) return false;
  if (Buffer.byteLength(inhalt, 'utf8') > MAX_FILE_BYTES) return false;
  // Ein Ordner an dieser Stelle wäre ein Dateiname auf einem Verzeichnis.
  if (existsSync(ziel) && !lstatSync(ziel).isFile()) return false;
  mkdirSync(join(ziel, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(ziel, inhalt, { mode: 0o600 });
  return true;
};

export const remove = (bot, projectRoot, pfad) => {
  const ziel = safeStartPath(bot, projectRoot, pfad);
  if (!ziel) return false;
  try {
    const stat = lstatSync(ziel);
    if (stat.isDirectory()) {
      if (readdirSync(ziel).length) return false;
      rmdirSync(ziel);
      aufraeumen(startFolderPath(bot, projectRoot), ziel);
      return true;
    }
    if (!stat.isFile()) return false;
    rmSync(ziel, { force: true });
    aufraeumen(startFolderPath(bot, projectRoot), ziel);
    return true;
  } catch {
    return false;
  }
};

export const makeDir = (bot, projectRoot, pfad) => {
  const ziel = safeStartPath(bot, projectRoot, pfad);
  if (!ziel) return false;
  if (existsSync(ziel)) return false;
  mkdirSync(ziel, { recursive: true, mode: 0o700 });
  return true;
};

/** Wie viele Dateien der Startordner hält – eine Zahl für die Bot-Karte. */
export const count = (bot, projectRoot) => {
  const quelle = startFolderPath(bot, projectRoot);
  if (!existsSync(quelle)) return 0;
  try {
    return sammle(quelle).size;
  } catch {
    return 0;
  }
};
