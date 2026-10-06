import { api } from '../api.js';
import { clear, el } from './dom.js';

/**
 * Wie viele Dateien ein Zug an den Hub darf. Ein Bot-Projekt ist Handvoll
 * Dateien; wer mehr hochlädt, hat `node_modules` oder ein Verzeichnis voller
 * Schnipsel im Griff – und der Hub würde es zur Hälfte annehmen und dann
 * scheitern.
 */
const MAX_UPLOAD_FILES = 200;
/** Wie viele Zeilen die kompakte Vorschau im Formular zeigen darf. */
const MAX_VORSCHAU = 4;

/** Wie viele Bytes sind das, in einer Form, die ein Mensch lesen kann. */
const groesse = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const zeit = (ts) =>
  new Date(ts).toLocaleString('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

/** Zwei Pfadteile verbinden; ein leerer linker Teil ergibt den rechten allein. */
const verbinde = (ordner, name) => (ordner ? `${ordner}/${name}` : name);

/**
 * Was der Hub gespiegelt hat – Zahlen, keine Dateinamen.
 *
 * Steht nach jedem schreibenden Zugang dort, weil die Zusage an den Betreiber
 * genau das ist: was er hier hochlädt, landet ohne weiteren Klick im Container.
 * Wer diese Zahlen nicht sieht, muss raten, ob es überhaupt angekommen ist.
 */
const sagErgebnis = (melde, files) => {
  if (!files) return;
  const teile = [];
  if (files.kopiert) teile.push(`${files.kopiert} übernommen`);
  if (files.entfernt) teile.push(`${files.entfernt} entfernt`);
  if (!teile.length && files.unveraendert) teile.push('alles aktuell');
  const warnung = files.uebersprungen?.length
    ? `nicht übernommen: ${files.uebersprungen.slice(0, 3).join(', ')}${
        files.uebersprungen.length > 3 ? ' …' : ''
      }`
    : '';
  melde(
    [teile.join(', ') || 'keine Änderung', warnung].filter(Boolean).join(' · '),
    warnung ? 'warn' : '',
  );
};

/**
 * Den Inhalt einer Datei aus einem `FileSystemFileEntry` holen.
 *
 * Das alte Rückgaberecht von `entry.file(cb)` funktioniert überall, wo
 * `webkitGetAsEntry` überhaupt etwas zurückgibt – der Versuch mit einem Promise
 * wäre nur eine weitere Art, in die sich die Oberfläche nicht bewegen lässt.
 */
const liesDatei = (knoten) =>
  new Promise((fertig) => {
    try {
      knoten.file(fertig);
    } catch {
      fertig(null);
    }
  });

/**
 * Alle Einträge eines Ordners.
 *
 * `readEntries` liefert höchstens 100 auf einmal und den Rest erst beim
 * zweiten Aufruf – wer nur einmal fragt, verliert Dateien, ohne es zu merken.
 * Der Stapel ist genau dafür da: weiterfragen, bis nichts mehr kommt. Die Zählung
 * ist die Bremse gegen einen Browser, der endlos leere Stücke liefert.
 */
const liesOrdner = (ordner) =>
  new Promise((fertig) => {
    let leser;
    try {
      leser = ordner.createReader();
    } catch {
      return fertig([]);
    }
    const alle = [];
    let fragen = 0;
    const lies = () =>
      leser.readEntries(
        (stueck) => {
          if (!stueck.length || ++fragen > 5000) return fertig(alle);
          alle.push(...stueck);
          lies();
        },
        () => fertig(alle),
      );
    lies();
  });

/**
 * Einen abgelegten Ordner in eine flache Liste von `{ pfad, datei }` zerlegen.
 *
 * `pfad` ist der Pfad des Eintrags, gemessen von der Stelle, an der losgelassen
 * wurde: ein hineingezogener Ordner behält seinen Namen, seine Unterordner
 * behalten ihre. So entsteht genau die Struktur, die auf der Platte liegt, und
 * nichts wird umbenannt – ein stilles Umsortieren hochgeladener Dateien wäre
 * der eine Fehler, der hier wirklich wehtut.
 *
 * `grenze` bricht ab, sobald sie überschritten wird. Ein verschentlich
 * gezogener `node_modules`-Ordner soll eine Meldung bringen und nicht zehn
 * Minuten laufen; die Obergrenze für die Tiefe ist derselbe Gedanke.
 *
 * Exportiert, weil genau hier die Regeln stehen, an denen ein Ordner zu
 *verlieren geht: `test/startFolder.test.js` prüft sie mit nachgebauten Knoten.
 */
export const sammleKnoten = async (knoten, grenze) => {
  const raus = [];
  const stapel = knoten.map((knoten) => ({ knoten, pfad: knoten.name }));
  let besucht = 0;
  while (stapel.length) {
    if (++besucht > grenze * 20) return { dateien: raus, zuViel: true };
    const { knoten: einer, pfad } = stapel.pop();
    if (einer.isFile) {
      const datei = await liesDatei(einer);
      // Eine Datei, die der Browser nicht mehr herausrücken will, ist kein Grund
      // für den Abbruch: der Rest des Ordners ist noch gut und wird geschickt.
      if (datei) raus.push({ pfad, datei });
    } else if (einer.isDirectory) {
      for (const kind of await liesOrdner(einer))
        stapel.push({ knoten: kind, pfad: verbinde(pfad, kind.name) });
    }
  }
  return { dateien: raus, zuViel: false };
};

/**
 * Die Ordner und Dateien aus einem `DataTransfer` lesen.
 *
 * `webkitGetAsEntry` wird hier aufgerufen und **nicht** weiter – der Eintrag
 * gilt nur während des Ereignisses, das ihn erzeugt hat. Wer erst nach dem
 * ersten `await` fragt, bekommt `null` zurück und wundert sich, warum auf
 * einmal niemand hochlädt.
 *
 * Ohne Entry-Schnittstelle bleibt nur `files`: dann sind es einzelne Dateien
 * ohne Ordner drumherum, und das ist immer noch ein brauchbarer Weg.
 */
export const knotenAusDrop = (daten) => {
  const knoten = [];
  for (const eintrag of daten?.items ?? []) {
    if (eintrag.kind !== 'file') continue;
    const knotenEins = eintrag.webkitGetAsEntry?.();
    if (knotenEins) knoten.push(knotenEins);
  }
  return knoten;
};

/**
 * Eine ganze Dateiauswahl hochladen – die beiden Knöpfe mit dem Dateidialog und
 * jeder Drop, für den es keine Ordnerstruktur gibt.
 *
 * `webkitRelativePath` füllt sich, wenn ein ganzer Ordner ausgewählt wurde. Das
 * ist der eine Fall, in dem der Browser die Struktur von sich aus mitbringt;
 * beim Ziehen muss man sie selbst erfragen.
 */
export const paareAusAuswahl = (auswahl) =>
  auswahl.map((datei) => ({
    pfad: datei.webkitRelativePath || datei.name,
    datei,
  }));

/** Ein Dialog mit einem Textfeld – kein Editor, aber ein brauchbarer. */
const bearbeiten = async (bot, pfad, { speichern, melde }) => {
  let datei;
  try {
    datei = await api.fileRead(bot.id, pfad);
  } catch (error) {
    melde(error.message, 'error');
    return;
  }
  const feld = el('textarea', {
    class: 'input start-folder__editor',
    rows: 20,
    spellcheck: 'false',
  });
  feld.value = datei.inhalt;
  const fussnote = el(
    'span',
    { class: 'start-folder__fussnote' },
    `${groesse(datei.groesse)} · ${zeit(datei.mtimeMs)}`,
  );
  const dialog = el(
    'dialog',
    { class: 'modal' },
    el(
      'header',
      { class: 'modal__head' },
      el('h2', {}, pfad),
      el(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Schliessen',
          onclick: () => dialog.close(),
        },
        '✕',
      ),
    ),
    el('div', { class: 'modal__body' }, feld),
    el(
      'footer',
      { class: 'modal__foot' },
      fussnote,
      el(
        'button',
        {
          class: 'btn btn--ghost',
          type: 'button',
          onclick: () => dialog.close(),
        },
        'Abbrechen',
      ),
      el(
        'button',
        {
          class: 'btn btn--primary',
          type: 'button',
          onclick: async (ereignis) => {
            const knopf = ereignis.currentTarget;
            knopf.disabled = true;
            try {
              await speichern(feld.value);
              dialog.close();
            } catch (error) {
              // Die Meldung steht an der Fussnote, nicht irgendwo im Explorer
              // dahinter: hier ist der Text, den man gerade verändert hat.
              fussnote.textContent = error.message;
              fussnote.classList.add('start-folder__hint--error');
            } finally {
              knopf.disabled = false;
            }
          },
        },
        'Speichern',
      ),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
};

/**
 * Der Hochlader – eine Sache, zwei Flächen.
 *
 * Sowohl der Abschnitt im Formular als auch der Explorer nehmen Dateien an, und
 * beide brauchen dieselben sechs Regeln: der Zielordner, die Grenze, das
 * Hochladen Datei für Datei, das Spiegeln nach jedem Schreibvorgang, das
 * Neuzeichnen und die Meldung. Zwei Kopien davon wären zwei Stellen, an denen
 * eine Regel nur in einer gilt – und die merkt man erst, wenn ein Ordner in der
 * einen Ansicht aufkreuzt und in der anderen nicht.
 *
 * `ordner()` liefert den Ordner, in den geladen wird, jedes Mal neu: der Explorer
 * kann zwischen zwei Klicks navigieren, und wer seinen Zielordner beim Öffnen
 * einmal festgehalten hätte, lädt danach an der falschen Stelle.
 */
const openLader = (bot, { melde, ordner, neu, nachAenderung }) => {
  const ladeHoch = async (paare) => {
    if (!paare.length) return melde('Da war keine Datei dabei.');
    if (paare.length > MAX_UPLOAD_FILES)
      return melde(
        `Das wären ${paare.length} Dateien, und der Hub nimmt höchstens ` +
          `${MAX_UPLOAD_FILES} auf einmal. node_modules und Caches gehören ` +
          'nicht in den Startordner.',
        'error',
      );
    const wohin = ordner();
    let geladen = 0;
    let kopiert = 0;
    for (const eintrag of paare) {
      const ziel = verbinde(wohin, eintrag.pfad);
      melde(`Lade hoch: ${ziel} (${geladen + 1}/${paare.length}) …`);
      try {
        const { files } = await api.fileWrite(
          bot.id,
          ziel,
          await eintrag.datei.text(),
        );
        // Jede Datei wird sofort gespiegelt. Die Zahlen kommen aus den Antworten
        // der einzelnen Schreibvorgänge – der Hub zählt nicht mit, was davon neu
        // war und was schon stand.
        kopiert += files?.kopiert ?? 0;
        geladen += 1;
      } catch (error) {
        melde(`${ziel}: ${error.message}`, 'error');
        await neu();
        return;
      }
    }
    await neu();
    nachAenderung();
    melde(
      `${geladen} Datei(en) hochgeladen${
        wohin ? ` nach ${wohin}/` : ''
      }, ${kopiert} in den Container übernommen.`,
    );
  };

  /**
   * Ein abgelegtes Stück Dateisystem entgegennehmen.
   *
   * Der Eintrag muss im Ereignis gelesen werden, nicht später – deshalb wird
   * `DataTransfer` hier sofort ausgewertet und weitergegeben, und nicht nach
   * einem `await` noch einmal angefasst.
   */
  const nimmDrop = async (daten) => {
    const knoten = knotenAusDrop(daten);
    if (knoten.length) {
      const { dateien, zuViel } = await sammleKnoten(knoten, MAX_UPLOAD_FILES);
      if (zuViel)
        return melde(
          `Darin sind mehr als ${MAX_UPLOAD_FILES} Dateien. node_modules und ` +
            'Caches gehören nicht hinein.',
          'error',
        );
      return ladeHoch(dateien);
    }
    // Kein Ordner im Griff – dann wenigstens die einzelnen Dateien. Und gar
    // nichts Dateiartiges heisst: es wurde Text gezogen, kein Dateibestand.
    const auswahl = [...(daten?.files ?? [])];
    if (!auswahl.length)
      return melde(
        'Da war nichts zum Hochladen dabei – es werden Dateien gezogen, ' +
          'kein Text.',
        'error',
      );
    return ladeHoch(paareAusAuswahl(auswahl));
  };

  return { ladeHoch, nimmDrop };
};

/**
 * Ziehen und Ablegen an ein Element hängen.
 *
 * Der Zähler ist nicht Kosmetik: `dragleave` feuert auch, wenn die Maus über ein
 * Kind des Containers läuft, und ohne ihn flackert die Markierung bei jedem
 * Schwanken der Maus auf und ab.
 *
 * `dragover` mit `preventDefault()` ist keine Kosmetik, sondern die Bedingung
 * dafür, dass der Browser die Datei überhaupt abgibt – und `dropEffect = 'copy'`,
 * damit er sie nicht verschieben will, wohin der Startordner gar nicht gehört.
 */
const haengeDrop = (knoten, { melde, nimmDrop, zone }) => {
  let tiefe = 0;
  const markiere = (an) => knoten.classList.toggle(zone, an);
  knoten.addEventListener('dragenter', (ereignis) => {
    ereignis.preventDefault();
    tiefe += 1;
    markiere(true);
  });
  knoten.addEventListener('dragover', (ereignis) => {
    ereignis.preventDefault();
    if (ereignis.dataTransfer) ereignis.dataTransfer.dropEffect = 'copy';
  });
  knoten.addEventListener('dragleave', () => {
    tiefe = Math.max(0, tiefe - 1);
    if (!tiefe) markiere(false);
  });
  knoten.addEventListener('drop', (ereignis) => {
    ereignis.preventDefault();
    tiefe = 0;
    markiere(false);
    const { dataTransfer } = ereignis;
    if (!dataTransfer)
      return melde('Der Browser hat die Dateien nicht gegeben.');
    nimmDrop(dataTransfer);
  });
};

/**
 * Der Datei-Explorer für den Startordner.
 *
 * Kein fertiges Bauteil, sondern eine eigene Ansicht: sie muss Ordner
 * auflisten, in sie hineingehen, sie anlegen und löschen – und Dateien
 * hochladen, bearbeiten und löschen. Das sind genau die sechs Dinge, die der Hub
 * anbietet; alles andere wäre Dekoration.
 *
 * Der Zustand ist absichtlich winzig: ein `ordner` und das, was der Hub dazu
 * sagt. Jede Änderung geht über den Hub und holt den Bestand neu – ein
 * Explorer, der ihn nebenherführt, zeigt einem irgendwann zwei Dinge, von denen
 * nur eines stimmt.
 */
const openExplorer = (bot, nachAenderung = () => {}) => {
  let ordner = '';

  const pfadBox = el('code', { class: 'start-folder__path' }, '');
  const weg = el('nav', { class: 'explorer__weg', 'aria-label': 'Weg' });
  const liste = el('ul', { class: 'explorer__liste' });
  const hinweis = el('p', { class: 'start-folder__hint' }, '');
  const koerper = el('div', { class: 'modal__body explorer__koerper' });
  /**
   * Wohin ein Drop hier landet. Steht im Klartext dabei, weil der Name eines
   * hineingezogenen Ordners erhalten bleibt – wer `meinbot/` sieht und dann
   * `bot.py` in der Wurzel sucht, hat beide nicht gelesen.
   */
  const zielText = el('strong', {}, 'der Wurzel');

  const melde = (text, zustand = '') => {
    hinweis.textContent = text;
    hinweis.className = `start-folder__hint${
      zustand ? ` start-folder__hint--${zustand}` : ''
    }`;
  };

  /** Ein veränderter Ordner: neu laden, und dem Formular Bescheid sagen. */
  const geaendert = async (vielleicht) => {
    if (vielleicht) sagErgebnis(melde, vielleicht);
    await neu();
    nachAenderung();
  };

  const zeichneWeg = () => {
    clear(weg);
    weg.append(
      el(
        'button',
        {
          class: `explorer__krume${ordner ? '' : ' explorer__krume--hier'}`,
          type: 'button',
          onclick: () => gehe(''),
        },
        'Startordner',
      ),
    );
    // Jeder Abschnitt führt dorthin, wo man schon war – nicht nur zur Wurzel.
    let bisher = '';
    for (const teil of ordner.split('/').filter(Boolean)) {
      bisher = verbinde(bisher, teil);
      const ziel = bisher;
      weg.append(
        el('span', { class: 'explorer__trenner' }, '/'),
        el(
          'button',
          {
            class: 'explorer__krume',
            type: 'button',
            onclick: () => gehe(ziel),
          },
          teil,
        ),
      );
    }
    pfadBox.textContent = bot.startFolder
      ? verbinde(bot.startFolder, ordner)
      : '';
    zielText.textContent = ordner ? `${ordner}/` : 'der Wurzel';
  };

  const zeile = (eintrag) =>
    el(
      'li',
      { class: 'explorer__zeile' },
      el(
        'button',
        {
          class: 'explorer__name',
          type: 'button',
          title:
            eintrag.art === 'ordner'
              ? 'Ordner öffnen'
              : 'Im Browser bearbeiten',
          onclick: () =>
            eintrag.art === 'ordner'
              ? gehe(eintrag.pfad)
              : bearbeiten(bot, eintrag.pfad, {
                  speichern: async (inhalt) => {
                    const { files } = await api.fileWrite(
                      bot.id,
                      eintrag.pfad,
                      inhalt,
                    );
                    await geaendert(files);
                  },
                  melde,
                }),
        },
        el(
          'span',
          { class: 'explorer__icon' },
          eintrag.art === 'ordner' ? '📁' : '📄',
        ),
        el('span', { class: 'explorer__beschriftung' }, eintrag.name),
      ),
      el(
        'span',
        { class: 'explorer__meta' },
        eintrag.art === 'ordner'
          ? zeit(eintrag.mtimeMs)
          : `${groesse(eintrag.groesse)} · ${zeit(eintrag.mtimeMs)}`,
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: eintrag.art === 'ordner' ? 'Ordner löschen' : 'Datei löschen',
          onclick: () => loeschen(eintrag.pfad, eintrag.art === 'ordner'),
        },
        '✕',
      ),
    );

  /**
   * Löschen. Bei einem Ordner sagt die Rückfrage, dass es der ganze Ordner ist –
   * „löschen?“ allein liest sich, als ginge es um eine Zeile, und das ist genau
   * die Verwechslung, die hier teuer wird.
   */
  const loeschen = async (pfad, istOrdner) => {
    const frage = istOrdner
      ? `Ordner "${pfad}" mit allem Inhalt löschen?` +
        '\n\nIm Container verschwinden dabei nur die Dateien, die von hier ' +
        'kamen. Was der Bot selbst geschrieben hat, bleibt stehen.'
      : `"${pfad}" löschen?`;
    if (!confirm(frage)) return;
    try {
      const antwort = await api.fileDelete(bot.id, pfad);
      await geaendert(antwort.files);
      melde(
        `${antwort.entfernt} Eintrag/Einträge gelöscht` +
          (antwort.ordnerGeloescht ? ' – der Ordner mitsamt Inhalt.' : '.'),
      );
    } catch (error) {
      melde(error.message, 'error');
    }
  };

  const zeichne = (antwort) => {
    clear(liste);
    if (!antwort.eintraege.length)
      liste.append(
        el(
          'li',
          { class: 'start-folder__empty' },
          ordner
            ? 'Dieser Ordner ist leer. Zieh etwas hinein oder lege unten einen an.'
            : 'Hier ist noch nichts. Zieh deinen Projektordner in dieses ' +
                'Fenster, oder wähle ihn oben aus – Unterordner bleiben dabei, ' +
                'wie sie sind.',
        ),
      );
    else for (const eintrag of antwort.eintraege) liste.append(zeile(eintrag));

    if (antwort.mehr)
      liste.append(
        el(
          'li',
          { class: 'start-folder__empty' },
          `Hier stehen nicht alle Einträge (${antwort.eintraege.length}+).`,
        ),
      );
    zeichneWeg();
  };

  const neu = async () => {
    let antwort;
    try {
      antwort = await api.files(bot.id, ordner);
    } catch (error) {
      // Ein Ordner, den es nicht mehr gibt, ist ein Fehlklick und kein Fehler:
      // zurück zur Wurzel statt einer Meldung, die man nicht wegklicken kann.
      if (ordner) {
        ordner = '';
        return neu();
      }
      melde(error.message, 'error');
      return;
    }
    zeichne(antwort);
    if (antwort.uebersprungen?.length && !hinweis.textContent)
      melde(
        `Nicht übernommen: ${antwort.uebersprungen.join(', ')} – Geheimnisse ` +
          'kommen aus den Umgebungsvariablen.',
        'warn',
      );
  };

  const gehe = (ziel) => {
    ordner = ziel || '';
    melde('');
    return neu();
  };

  /* Hochladen */

  const { ladeHoch, nimmDrop } = openLader(bot, {
    melde,
    // Jedes Mal neu, nicht beim Öffnen festgehalten: zwischen zwei Klicks kann
    // der Explorer in einen anderen Ordner gegangen sein.
    ordner: () => ordner,
    neu,
    nachAenderung,
  });

  const auswahlHochladen = (auswahl) => ladeHoch(paareAusAuswahl(auswahl));

  const dateiWahl = el('input', {
    type: 'file',
    class: 'start-folder__input',
    multiple: true,
    onchange: async (ereignis) => {
      const auswahl = [...(ereignis.target.files ?? [])];
      ereignis.target.value = '';
      await auswahlHochladen(auswahl);
    },
  });
  const ordnerWahl = el('input', {
    type: 'file',
    class: 'start-folder__input',
    multiple: true,
    webkitdirectory: true,
    onchange: async (ereignis) => {
      const auswahl = [...(ereignis.target.files ?? [])];
      ereignis.target.value = '';
      await auswahlHochladen(auswahl);
    },
  });

  /* Ordner anlegen */

  const neuFeld = el('input', {
    class: 'input',
    placeholder: 'name oder ordner/unterordner',
    maxlength: '200',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const neuForm = el(
    'form',
    { class: 'explorer__neu', hidden: true },
    neuFeld,
    el(
      'button',
      { class: 'btn btn--primary btn--sm', type: 'submit' },
      'Anlegen',
    ),
    el(
      'button',
      {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        onclick: () => (neuForm.hidden = true),
      },
      'Abbrechen',
    ),
  );
  neuForm.addEventListener('submit', async (ereignis) => {
    ereignis.preventDefault();
    const name = neuFeld.value.trim();
    if (!name) return;
    const ziel = verbinde(ordner, name);
    try {
      await api.fileMkdir(bot.id, ziel);
      neuFeld.value = '';
      neuForm.hidden = true;
      await neu();
      nachAenderung();
      melde(`Ordner ${ziel} angelegt.`);
    } catch (error) {
      melde(error.message, 'error');
    }
  });

  /* Der Dialog */

  const dialog = el(
    'dialog',
    { class: 'modal explorer' },
    el(
      'header',
      { class: 'modal__head' },
      el('h2', {}, 'Startordner'),
      el(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Schliessen',
          onclick: () => dialog.close(),
        },
        '✕',
      ),
    ),
    el(
      'div',
      { class: 'modal__head modal__head--werkzeug' },
      pfadBox,
      el(
        'div',
        { class: 'explorer__werkzeug' },
        el(
          'label',
          { class: 'btn btn--ghost btn--sm' },
          '⬆ Dateien wählen',
          dateiWahl,
        ),
        el(
          'label',
          { class: 'btn btn--ghost btn--sm' },
          '⬆ Ordner wählen',
          ordnerWahl,
        ),
        el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            onclick: () => {
              neuForm.hidden = !neuForm.hidden;
              if (!neuForm.hidden) neuFeld.focus();
            },
          },
          '＋ Ordner',
        ),
        el(
          'button',
          {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            title: 'Den Startordner in den Workspace des Containers spiegeln',
            onclick: async (ereignis) => {
              ereignis.currentTarget.disabled = true;
              melde('Übernehme …');
              try {
                sagErgebnis(melde, (await api.filesSync(bot.id)).files);
                await neu();
                nachAenderung();
              } catch (error) {
                melde(error.message, 'error');
              } finally {
                ereignis.currentTarget.disabled = false;
              }
            },
          },
          '↻ Übernehmen',
        ),
      ),
    ),
    koerper,
    el('div', { class: 'modal__foot modal__foot--werkzeug' }, neuForm, hinweis),
  );

  koerper.append(
    weg,
    el(
      'p',
      { class: 'explorer__weg-hinweis' },
      'Dateien und Ordner hierher ziehen – sie landen in ',
      zielText,
      '. Der Name eines hineingezogenen Ordners bleibt erhalten.',
    ),
    liste,
  );

  // Am ganzen Fenster, nicht nur an der Liste: wer zielt auf den Kopf, meint es
  // genauso, und ein Dialog, der sich nur auf seinem Klumpen annimmt, sieht
  // kaputt aus, wenn daneben nichts passiert.
  haengeDrop(dialog, { melde, nimmDrop, zone: 'explorer--zieht' });

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  neu();
  return dialog;
};

/**
 * Der Startordner im Bot-Formular.
 *
 * Der Hub legt den Ordner selbst an; es gibt kein Feld, in dem man einen Pfad
 * einträgt. Ein getippter Pfad wäre hier die falsche Bequemlichkeit: der Fehler
 * fällt erst beim Start auf, wenn der Bot seinen Einstiegspunkt nicht findet.
 *
 * Was hier steht, ist deshalb nur der Weg dorthin und eine Vorschau. Die
 * eigentliche Arbeit – Ordner auflisten, hochladen, anlegen, bearbeiten,
 * löschen – macht der Explorer, den der Knopf hier öffnet. Sonst müsste das
 * Formular, das einen Bot anlegt, auch die ganze Dateiverwaltung tragen.
 *
 * Bei einem neuen Bot gibt es noch keine Kennung und damit nichts zu zeigen.
 * Der Bereich sagt das und weist auf den zweiten Schritt hin, statt eine leere
 * Liste zu zeigen, die nach einem Fehler aussieht.
 */
export const mountStartFolder = (host, bot) => {
  clear(host);
  if (!bot?.id) {
    host.append(
      el(
        'p',
        { class: 'start-folder__hint' },
        'Wird beim Anlegen angelegt. Danach kannst du deinen ganzen ' +
          'Projektordner hier herunterziehen – er landet von selbst im ' +
          'Container des Bots.',
      ),
    );
    return;
  }

  const vorschau = el('ul', { class: 'start-folder__list' });
  const hinweis = el('p', { class: 'start-folder__hint' }, '');

  /** Eine Meldung an dieselbe Stelle, in drei Zuständen. */
  const melde = (text, zustand = '') => {
    hinweis.textContent = text;
    hinweis.className = `start-folder__hint${
      zustand ? ` start-folder__hint--${zustand}` : ''
    }`;
  };

  const uebernehmenButton = el(
    'button',
    {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      onclick: async (ereignis) => {
        const knopf = ereignis.currentTarget;
        knopf.disabled = true;
        melde('Übernehme …');
        try {
          sagErgebnis(melde, (await api.filesSync(bot.id)).files);
          await neu();
        } catch (error) {
          melde(error.message, 'error');
        } finally {
          knopf.disabled = false;
        }
      },
    },
    'In den Container übernehmen',
  );

  /** Die Vorschau frisch holen – auch nachdem der Explorer etwas getan hat. */
  const neu = async () => {
    let antwort;
    try {
      antwort = await api.files(bot.id, '');
    } catch (error) {
      melde(error.message, 'error');
      return;
    }
    clear(vorschau);
    const gezeigt = antwort.eintraege.slice(0, MAX_VORSCHAU);
    if (!gezeigt.length)
      vorschau.append(
        el(
          'li',
          { class: 'start-folder__empty' },
          bot.fileCount
            ? `${bot.fileCount} Dateien, alle in Unterordnern. Zum Ansehen den Ordner öffnen.`
            : 'Noch keine Dateien. Zieh deinen Projektordner hier herunter, ' +
                'oder öffne den Ordner für mehr.',
        ),
      );
    for (const eintrag of gezeigt)
      vorschau.append(
        el(
          'li',
          { class: 'start-folder__row' },
          el(
            'code',
            { class: 'start-folder__name' },
            eintrag.art === 'ordner' ? `📁 ${eintrag.name}/` : eintrag.name,
          ),
          el(
            'span',
            { class: 'start-folder__meta' },
            eintrag.art === 'ordner' ? 'Ordner' : groesse(eintrag.groesse),
          ),
        ),
      );
    if (antwort.eintraege.length > gezeigt.length)
      vorschau.append(
        el(
          'li',
          { class: 'start-folder__row' },
          el(
            'code',
            { class: 'start-folder__name' },
            `… und ${antwort.eintraege.length - gezeigt.length} weitere`,
          ),
        ),
      );
    if (antwort.uebersprungen?.length && !hinweis.textContent)
      melde(
        `Nicht übernommen: ${antwort.uebersprungen.join(', ')} – Geheimnisse ` +
          'kommen aus den Umgebungsvariablen.',
        'warn',
      );
  };

  // Der Abschnitt selbst nimmt Dateien an, nicht nur der Explorer dahinter. Wer
  // den Ordner vor sich hat und seinen Projektordner daneben, zieht ihn hier
  // hin – und ein Bereich, der das ablehnt, muss man erst verstehen, bevor man
  // es glaubt.
  const { ladeHoch, nimmDrop } = openLader(bot, {
    melde,
    ordner: () => '',
    neu,
    nachAenderung: () => {},
  });
  haengeDrop(host, { melde, nimmDrop, zone: 'start-folder--zieht' });

  const dateiWahl = el('input', {
    type: 'file',
    class: 'start-folder__input',
    multiple: true,
    onchange: async (ereignis) => {
      const auswahl = [...(ereignis.target.files ?? [])];
      ereignis.target.value = '';
      await ladeHoch(paareAusAuswahl(auswahl));
    },
  });
  const ordnerWahl = el('input', {
    type: 'file',
    class: 'start-folder__input',
    multiple: true,
    webkitdirectory: true,
    onchange: async (ereignis) => {
      const auswahl = [...(ereignis.target.files ?? [])];
      ereignis.target.value = '';
      await ladeHoch(paareAusAuswahl(auswahl));
    },
  });

  host.append(
    el(
      'div',
      { class: 'start-folder__head' },
      el('span', { class: 'start-folder__label' }, 'Startordner'),
      el('code', { class: 'start-folder__path' }, bot.startFolder ?? ''),
    ),
    el(
      'div',
      { class: 'start-folder__tools' },
      el(
        'button',
        {
          class: 'btn btn--primary btn--sm',
          type: 'button',
          onclick: () => openExplorer(bot, neu),
        },
        'Ordner öffnen',
      ),
      el('label', { class: 'btn btn--ghost btn--sm' }, '⬆ Dateien', dateiWahl),
      el('label', { class: 'btn btn--ghost btn--sm' }, '⬆ Ordner', ordnerWahl),
      uebernehmenButton,
    ),
    vorschau,
    el(
      'p',
      { class: 'start-folder__ablegen' },
      'Den Projektordner hierher ziehen – er wird hochgeladen und landet von ' +
        'selbst im Container. Der Name des Ordners bleibt erhalten.',
    ),
    hinweis,
  );

  neu();
};
