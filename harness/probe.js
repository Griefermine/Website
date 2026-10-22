import '../src/styles.css';
import { mountStartFolder } from '../src/ui/startFolder.js';

// Ein erfundener Hub: der echte Server laeuft waehrend der Probe daneben, aber
// fuer die Oberflaeche reichen hier vier Antworten, die fest stehen.
const bot = {
  id: 'b1',
  name: 'Probe',
  startFolder: 'bots/b1/startordner',
  fileCount: 3,
};

let inhaltSecr = {
  '': [
    { name: 'meinbot', pfad: 'meinbot', art: 'ordner', groesse: 0, mtimeMs: 1 },
    { name: 'bot.py', pfad: 'bot.py', art: 'datei', groesse: 14, mtimeMs: 2 },
    { name: '.env', pfad: '.env', art: 'datei', groesse: 10, mtimeMs: 3 },
  ],
  meinbot: [
    { name: 'src', pfad: 'meinbot/src', art: 'ordner', groesse: 0, mtimeMs: 4 },
    {
      name: 'bot.py',
      pfad: 'meinbot/bot.py',
      art: 'datei',
      groesse: 14,
      mtimeMs: 5,
    },
  ],
  'meinbot/src': [
    {
      name: 'hilfe.py',
      pfad: 'meinbot/src/hilfe.py',
      art: 'datei',
      groesse: 4,
      mtimeMs: 6,
    },
  ],
};

window.__aufrufe = [];
window.__startordner = bot;

const fakeFetch = async (url, options = {}) => {
  const pfad = String(url).replace('/api', '');
  window.__aufrufe.push({
    url: pfad,
    method: options.method ?? 'GET',
    body: options.body,
  });
  const antwort = (daten, status = 200) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(daten),
  });
  const neuerPfad = /\/bots\/[^/]+\/files\/(.+)$/.exec(pfad);
  if (options.method === 'PUT') {
    const inhalt2 = JSON.parse(options.body).inhalt;
    return antwort({
      pfad: neuerPfad?.[1],
      files: { kopiert: 1, entfernt: 0, unveraendert: 2 },
    });
  }
  if (options.method === 'DELETE')
    return antwort({
      entfernt: 3,
      ordnerGeloescht: true,
      files: { kopiert: 0, entfernt: 2, unveraendert: 0 },
    });
  if (options.method === 'POST')
    return antwort({
      files: { kopiert: 1, entfernt: 0, unveraendert: 0 },
      ...liste(''),
    });
  if (options.method === 'GET' && neuerPfad)
    return antwort({
      pfad: neuerPfad[1],
      inhalt: 'print("hallo")\nx = 1\n',
      groesse: 22,
      mtimeMs: 5,
    });
  const ordner = decodeURIComponent(
    new URL(pfad, 'http://x').searchParams.get('pfad') ?? '',
  );
  return antwort({ startordner: bot.startFolder, ...liste(ordner) });
};

const liste = (ordner) => ({
  ordner,
  uebergeordnete: ordner ? ordner.split('/').slice(0, -1) : [],
  eintraege: inhalt[ordner] ?? [],
  uebersprungen: ordner ? [] : ['.env (Geheimnis)'],
  mehr: false,
});

globalThis.fetch = fakeFetch;
window.confirm = () => true;

mountStartFolder(document.getElementById('wurzel'), bot);
window.__bereit = true;
