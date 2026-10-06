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
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Was der Hub auf einmal spiegelt. Ein Bot-Projekt ist Handvoll Dateien. */
export const MAX_SYNC_BYTES = 64 * 1024 * 1024;
/** Wie viele Einträge ein aufgelisteter Ordner enthalten darf. */
export const MAX_LIST_ENTRIES = 2000;
/**
 * Wie viele Einträge ein Löschvorgang mitnehmen darf.
 *
 * Der Explorer zeigt einen Ordner als eine Zeile, und 400 einzelne Anfragen
 * dafür wären eine Zumutung – gelöscht wird deshalb in einem Zug. Die Grenze
 * gilt trotzdem: wer versehentlich den ganzen Startordner erwischt, soll eine
 * Meldung bekommen und nicht den Hub blockieren.
 */
export const MAX_REMOVE_ENTRIES = 5000;
/** Wie viele Zeichen ein Pfad im Startordner haben darf. */
const MAX_PATH_LENGTH = 200;
/** Wie gross eine einzelne Datei sein darf. Der Hub führt Text, keine Bilder. */
export const MAX_FILE_BYTES = 512 * 1024;
/** Gesamtquota pro Startordner (pre-write, serverseitig, pro Bot). */
export const MAX_START_FOLDER_BYTES = 64 * 1024 * 1024;
export const MAX_START_FOLDER_FILES = 2000;
export const MAX_UPLOAD_FILE_BYTES = 512 * 1024;

/**
 * Einträge, die nie in den Workspace wandern. Anders als bei der
 * Workspace-Migration (siehe `manager.js`) wird hier nichts an der Benennung
 * von *Geheimnissen* erraten: `secrets.py` ist Quellcode und gehört in den
 * Bot. Nur zwei Namen sind ausgeschlossen, beide aus einem konkreten Grund.
 */
const SKIPPED = new Set([
  '.git',
  '.env',
  '.svn',
  '.hg',
  '.ssh',
  '.pypirc',
  '.npmrc',
  '.aws',
  '.kube',
]);

/**
 * Mutierende Datei-Operationen pro Bot serialisieren (einfache Async-Mutex
 * via Promise-Kette). Verhindert TOCTOU-Quota-Bypass unter parallelen
 * PUTs/POSTs/DELETEs: COUNT → prüfen → write darf nicht interleaven.
 * Reads bleiben non-blocking. Single-Node ausreichend; Cluster nicht nötig.
 */
const botQueues = new Map();
export const withBotLock = (botId, task) => {
  const key = String(botId ?? '');
  const previous = botQueues.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  botQueues.set(key, tail);
  return previous.then(async () => {
    try {
      return await task();
    } finally {
      release();
      if (botQueues.get(key) === tail) botQueues.delete(key);
    }
  });
};

/** Aktuelle Nutzung (bytes + files) ohne Symlinks/Non-Files/Skipped. */
const usageOf = (wurzel) => {
  let bytes = 0;
  let files = 0;
  const stapel = [wurzel];
  while (stapel.length) {
    const ordner = stapel.pop();
    let eintraege;
    try {
      eintraege = readdirSync(ordner, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const eintrag of eintraege) {
      const voll = join(ordner, eintrag.name);
      if (eintrag.isSymbolicLink()) continue;
      if (eintrag.isDirectory()) {
        if (SKIPPED.has(eintrag.name)) continue;
        stapel.push(voll);
        continue;
      }
      if (!eintrag.isFile()) continue;
      if (eintrag.name === '.env' || eintrag.name.startsWith('.env.')) continue;
      try {
        const stat = lstatSync(voll);
        // Hardlinks (nlink>1) zählen als Risiko: sie teilen Inodes und können
        // Quotas umgehen. Für die Quota zählen sie mit, geschrieben wird aber
        // nie über einen bestehenden Hardlink hinweg ohne Prüfung in write().
        bytes += stat.size;
        files += 1;
      } catch {
        continue;
      }
    }
  }
  return { bytes, files };
};

/** Pre-write Quota-Prüfung: KEINE Datei schreiben bei Ablehnung. */
const quotaAllows = (bot, projectRoot, incomingBytes, incomingFiles = 1) => {
  if (incomingBytes > MAX_UPLOAD_FILE_BYTES) return false;
  const quelle = startFolderPath(bot, projectRoot);
  let current = { bytes: 0, files: 0 };
  try {
    if (existsSync(quelle)) current = usageOf(quelle);
  } catch {
    current = { bytes: 0, files: 0 };
  }
  if (current.bytes + incomingBytes > MAX_START_FOLDER_BYTES) return false;
  if (current.files + incomingFiles > MAX_START_FOLDER_FILES) return false;
  return true;
};

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
    .normalize('NFC')
    .replace(/\\/g, '/')
    .trim();
  if (!relat) return null;
  if (
    isAbsolute(relat) ||
    relat === '~' ||
    relat.startsWith('~/') ||
    relat.startsWith('~\\') ||
    relat.length > MAX_PATH_LENGTH ||
    relat.includes('\0')
  )
    return null;
  const teile = relat.split('/').filter((teil) => teil && teil !== '.');
  if (!teile.length) return null;
  if (teile.some((teil) => teil === '..')) return null;
  // Windows-ADs/Trailing-Dots: "name.", "name ", "COM1", "LPT1" u.ä. abweisen,
  // sonst entstehen auf manchen Dateisystemen aliase zum selben Eintrag.
  // Auch leere NFC-Artefakte (z.B. nur Combining Marks) abweisen.
  for (const teil of teile) {
    if (!teil.normalize('NFC')) return null;
    if (teil.endsWith('.') || teil.endsWith(' ')) return null;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(teil)) return null;
    if (teil.includes(':') || teil.includes('*') || teil.includes('?'))
      return null;
  }

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
 * Ein Pfad aus der Oberfläche, auf Form gebracht: Schrägstriche vereinheitlicht,
 * überflüssige Reste entfernt.
 *
 * Bewusst *nicht* normalisiert im Sinne von „mache aus einem bösen Pfad einen
 * guten“. Ein absoluter Pfad bleibt absolut, damit `safeStartPath` ihn danach
 * ablehnt – ein `/etc/shadow`, das zu `etc/shadow` verkürzt und damit plötzlich
 * erlaubt wäre, ist schlimmer als ein abgelehnter Versuch.
 */
const normalisiere = (pfad) =>
  String(pfad ?? '')
    .normalize('NFC')
    .replace(/\\/g, '/')
    .trim()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');

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

/**
 * Ordner vor Dateien, dann der Name. Die Reihenfolge ist nicht Kosmetik,
 * sondern die Liste, in der jemand eine Datei sucht: mit umgekehrter Reihenfolge
 * wäre jeder Klick auf einen Ordner erst einmal eine Suchaktion.
 */
const sortiere = (a, b) =>
  a.art === b.art
    ? a.name.localeCompare(b.name, 'de')
    : a.art === 'ordner'
      ? -1
      : 1;

/** Grösse und Zeitpunkt eines Eintrags; `lstat`, damit ein Verweis kein Ziel öffnet. */
const ueber = (voll) => {
  try {
    const stat = lstatSync(voll);
    return { groesse: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { groesse: 0, mtimeMs: 0 };
  }
};

/**
 * Einen Ordner des Startordners auflisten – Ordner *und* Dateien.
 *
 * `pfad` ist der aufzulistende Ordner, `''` für die Wurzel. Damit navigiert der
 * Explorer von Ordner zu Ordner; eine flache Liste aller Dateien wäre für ihn
 * nicht zu gebrauchen – die Merkliste zum Spiegeln läuft ohnehin über `sammle`.
 *
 * `null`, wenn es den Ordner nicht gibt oder er nicht in den Startordner
 * gehört. Symlinks, `.git` und `.env*` stehen nicht in der Liste, werden aber in
 * `uebersprungen` genannt: ein still fehlender `config.py` sieht sonst aus wie
 * ein Fehler beim Spiegeln.
 */
export const list = (bot, projectRoot, pfad = '') => {
  const rel = normalisiere(pfad);
  const quelle = rel
    ? safeStartPath(bot, projectRoot, rel)
    : startFolderPath(bot, projectRoot);
  if (!quelle) return null;
  const uebersprungen = new Set();
  let eintraege;
  try {
    eintraege = readdirSync(quelle, { withFileTypes: true });
  } catch {
    return null;
  }
  const raus = [];
  for (const eintrag of eintraege) {
    const { name } = eintrag;
    const voll = rel ? `${rel}/${name}` : name;
    if (eintrag.isSymbolicLink()) {
      uebersprungen.add(`${voll} (Verweis)`);
      continue;
    }
    if (eintrag.isDirectory()) {
      if (SKIPPED.has(name)) {
        uebersprungen.add(`${voll}/`);
        continue;
      }
      raus.push({
        name,
        pfad: voll,
        art: 'ordner',
        groesse: 0,
        ...ueber(join(quelle, name)),
      });
      continue;
    }
    if (!eintrag.isFile()) {
      uebersprungen.add(`${voll} (keine Datei)`);
      continue;
    }
    if (name === '.env' || name.startsWith('.env.')) {
      uebersprungen.add(`${voll} (Geheimnis)`);
      continue;
    }
    raus.push({ name, pfad: voll, art: 'datei', ...ueber(join(quelle, name)) });
  }
  raus.sort(sortiere);
  return {
    ordner: rel,
    uebergeordnete: rel ? rel.split('/').slice(0, -1) : [],
    eintraege: raus.slice(0, MAX_LIST_ENTRIES),
    uebersprungen: [...uebersprungen].slice(0, 20),
    mehr: raus.length > MAX_LIST_ENTRIES,
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
  const incoming = Buffer.byteLength(inhalt, 'utf8');
  if (incoming > MAX_FILE_BYTES || incoming > MAX_UPLOAD_FILE_BYTES)
    return false;
  // Ein Ordner an dieser Stelle wäre ein Dateiname auf einem Verzeichnis.
  // Symlinks/FIFOs/Sockets/Devices sind keine Files → ablehnen.
  // Hardlinks (nlink>1) nicht überschreiben: sie teilen Inodes.
  try {
    if (existsSync(ziel)) {
      const st = lstatSync(ziel);
      if (!st.isFile()) return false;
      if (st.nlink > 1) return false;
      // Replacement: kein Count-Anstieg, nur Bytes-Delta prüfen.
      const quelle = startFolderPath(bot, projectRoot);
      let current = { bytes: 0, files: 0 };
      try {
        if (existsSync(quelle)) {
          // usageOf ist oben definiert; Fallback auf sammle-Größe bei Fehler.
          current = usageOf(quelle);
        }
      } catch {
        current = { bytes: 0, files: 0 };
      }
      const delta = incoming - st.size;
      if (delta > 0) {
        if (incoming > MAX_UPLOAD_FILE_BYTES) return false;
        if (current.bytes + delta > MAX_START_FOLDER_BYTES) return false;
        if (current.files > MAX_START_FOLDER_FILES) return false;
      }
      // Atomar schreiben: tmp + rename, kein halb geschriebenes File.
      mkdirSync(join(ziel, '..'), { recursive: true, mode: 0o700 });
      const tmp = `${ziel}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(tmp, inhalt, { mode: 0o600 });
        renameSync(tmp, ziel);
      } catch {
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {}
        return false;
      }
      return true;
    }
  } catch {
    return false;
  }
  // Neue Datei: pre-write Quota (bytes + count). KEIN Schreiben bei Ablehnung.
  if (!quotaAllows(bot, projectRoot, incoming, 1)) return false;
  mkdirSync(join(ziel, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${ziel}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, inhalt, { mode: 0o600 });
    renameSync(tmp, ziel);
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
    return false;
  }
  return true;
};

/**
 * Wie viele Einträge unter einem Pfad liegen, ohne ihm zu folgen – oder `-1`,
 * wenn es mehr als `MAX_REMOVE_ENTRIES` sind.
 */
const zaehle = (wurzel) => {
  let anzahl = 0;
  const stapel = [wurzel];
  while (stapel.length) {
    const ordner = stapel.pop();
    let eintraege;
    try {
      eintraege = readdirSync(ordner, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const eintrag of eintraege) {
      anzahl += 1;
      if (anzahl > MAX_REMOVE_ENTRIES) return -1;
      // `Dirent` folgt einem Verweis nicht: ein `Dirent` aus `readdirSync` ist
      // ein `lstat`-Ergebnis, `isDirectory()` ist für einen Symlink also falsch.
      // Ein Verweis zählt als ein Eintrag und wird nicht betreten – sonst
      // wanderte das Löschen über ihn in ein Verzeichnis ganz woanders.
      if (eintrag.isDirectory()) stapel.push(join(ordner, eintrag.name));
    }
  }
  return anzahl;
};

/**
 * Einen Pfad im Startordner löschen – eine Datei oder einen ganzen Ordner.
 *
 * Der Explorer zeigt einen Ordner als *eine* Zeile; „löschen“ heisst dort
 * „dieser Ordner samt Inhalt“. Deshalb wird rekursiv gelöscht statt in
 * Einzelanfragen, die der Betreiber weder erwartet noch sieht.
 *
 * Was im Workspace danach noch liegt, entscheidet die Merkliste beim nächsten
 * Spiegeln: Dateien des Betreibers verschwinden dort, die des Bots bleiben. Es
 * wird also nichts gelöscht, was der Hub nicht selbst geschrieben hat.
 *
 * Rückgabe: `null`, wenn der Pfad nicht in den Startordner gehört oder es ihn
 * nicht gibt; `{ ueberlimit: true }`, wenn der Ordner zu gross ist; sonst
 * `{ ordner, eintraege }` – `eintraege` zählt, was mitgegangen ist, damit die
 * Oberfläche sagen kann, was passiert ist.
 */
export const remove = (bot, projectRoot, pfad) => {
  const ziel = safeStartPath(bot, projectRoot, pfad);
  if (!ziel) return null;
  const start = startFolderPath(bot, projectRoot);
  let stat;
  try {
    stat = lstatSync(ziel);
  } catch {
    return null;
  }
  if (stat.isFile()) {
    rmSync(ziel, { force: true });
    aufraeumen(start, ziel);
    return { ordner: false, eintraege: 1 };
  }
  if (!stat.isDirectory()) return null;
  const anzahl = zaehle(ziel);
  // Erst zählen, dann löschen. Eine Grenze, die man erst beim Löschen merkt,
  // ist keine Grenze.
  if (anzahl < 0) return { ueberlimit: true };
  // `rmSync` löst einen Verweis im Baum auf, statt ihm zu folgen: der Verweis
  // verschwindet, das Ziel bleibt unangetastet. `.env` und `.git` werden
  // mitgenommen – die Ausnahme beim Spiegeln gilt dem Inhalt, den der Bot
  // bekommen soll, nicht dem Recht des Betreibers, seine eigenen Ordner zu
  // leeren.
  rmSync(ziel, { recursive: true, force: true });
  aufraeumen(start, ziel);
  return { ordner: true, eintraege: anzahl };
};

/**
 * Einen Ordner anlegen – auch mehrere Ebenen auf einmal.
 *
 * Mehrfach aufrufbar: ein Ordner, der schon da ist, ist kein Fehler. Der
 * Explorer könnte denselben Namen zweimal vergeben, oder der Betreiber legt den
 * Ordner parallel auf dem Server an; in beiden Fällen gibt es nichts zu
 * beheben, und eine Fehlermeldung wäre eine Lüge.
 */
export const makeDir = (bot, projectRoot, pfad) => {
  const ziel = safeStartPath(bot, projectRoot, pfad);
  if (!ziel) return false;
  try {
    // `lstat`: ein Verweis, der auf einen Ordner zeigt, ist kein Ordner.
    if (lstatSync(ziel).isDirectory()) return true;
    return false;
  } catch {
    // Gibt es noch nicht – dann anlegen.
  }
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
