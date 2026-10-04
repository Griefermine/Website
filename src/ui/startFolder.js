import { api } from '../api.js';
import { clear, el } from './dom.js';

const MAX_UPLOAD_FILES = 50;

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

/**
 * Der Startordner im Bot-Formular.
 *
 * Der Hub legt den Ordner selbst an; es gibt kein Feld, in dem man einen Pfad
 * einträgt. Ein getippter Pfad wäre hier die falsche Bequemlichkeit: der Fehler
 * fällt erst beim Start auf, wenn der Bot seinen Einstiegspunkt nicht findet.
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
        'Wird beim Anlegen angelegt. Danach kannst du hier die Dateien ' +
          'hochladen – sie landen von selbst im Container des Bots.',
      ),
    );
    return;
  }

  const liste = el('ul', { class: 'start-folder__list' });
  const hinweis = el('p', { class: 'start-folder__hint' }, '');

  /**
   * Eine Meldung an dieselbe Stelle, in drei Zuständen. Es gibt absichtlich
   * keinen zweiten Ort: eine Fehlermeldung neben einer Erfolgsmeldung liest man
   * nicht mehr.
   */
  const melde = (text, zustand = '') => {
    hinweis.textContent = text;
    hinweis.className = `start-folder__hint${zustand ? ` start-folder__hint--${zustand}` : ''}`;
  };

  /** Was der Hub gespiegelt hat – Zahlen, keine Dateinamen. */
  const sagErgebnis = (files) => {
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
      [teile.join(', ') || 'keine Änderung', warnung]
        .filter(Boolean)
        .join(' · '),
      warnung ? 'warn' : '',
    );
  };

  const fehler = (error) => melde(error.message, 'error');

  const neu = async () => {
    let antwort;
    try {
      antwort = await api.files(bot.id);
    } catch (error) {
      fehler(error);
      return;
    }
    clear(liste);
    if (!antwort.dateien.length)
      liste.append(
        el(
          'li',
          { class: 'start-folder__empty' },
          'Noch keine Dateien. Lade hier die Dateien deines Bots hoch – ' +
            'etwa die Python-Datei, die der Startbefehl aufruft.',
        ),
      );
    else for (const eintrag of antwort.dateien) liste.append(zeile(eintrag));

    if (antwort.mehr)
      liste.append(
        el(
          'li',
          { class: 'start-folder__empty' },
          `Es sind mehr Dateien vorhanden, als hier stehen (${antwort.dateien.length}+).`,
        ),
      );
    // Eine Meldung, die das Laden erklärt, und eine, die ein Ergebnis meldet,
    // schliessen sich aus. Nur wenn noch keine da ist, wird gemeldet.
    if (!hinweis.textContent)
      melde(
        antwort.uebersprungen?.length
          ? `Nicht übernommen: ${antwort.uebersprungen.join(', ')} – ` +
              'Geheimnisse kommen aus den Umgebungsvariablen.'
          : '',
        antwort.uebersprungen?.length ? 'warn' : '',
      );
  };

  const uebernehmenButton = el(
    'button',
    {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      onclick: async () => {
        uebernehmenButton.disabled = true;
        melde('Übernehme …');
        try {
          sagErgebnis((await api.filesSync(bot.id)).files);
          await neu();
        } catch (error) {
          fehler(error);
        } finally {
          uebernehmenButton.disabled = false;
        }
      },
    },
    'In den Container übernehmen',
  );

  /** Hochladen ohne Bildlauf durch die Oberfläche – Datei für Datei. */
  const hochladen = async (auswahl) => {
    if (auswahl.length > MAX_UPLOAD_FILES) {
      melde(`Höchstens ${MAX_UPLOAD_FILES} Dateien auf einmal.`, 'error');
      return;
    }
    let geladen = 0;
    let kopiert = 0;
    for (const datei of auswahl) {
      melde(`Lade hoch: ${datei.name} (${geladen + 1}/${auswahl.length}) …`);
      try {
        // `webkitRelativePath` füllt sich, wenn ein ganzer Ordner
        // ausgewählt wurde – dann bleiben die Unterordner erhalten.
        const { files } = await api.fileWrite(
          bot.id,
          datei.webkitRelativePath || datei.name,
          await datei.text(),
        );
        // Jede Datei wird sofort gespiegelt. Die Zahlen kommen aus den
        // Antworten der einzelnen Schreibvorgänge – die Liste am Ende weiss
        // nichts mehr darüber, was davon neu war und was schon stand.
        kopiert += files?.kopiert ?? 0;
        geladen += 1;
      } catch (error) {
        melde(`${datei.name}: ${error.message}`, 'error');
        return;
      }
    }
    melde(
      `${geladen} Datei(en) hochgeladen, ${kopiert} in den Container übernommen.`,
    );
    await neu();
  };

  const dateiWahl = el('input', {
    type: 'file',
    class: 'start-folder__input',
    multiple: true,
    onchange: async (event) => {
      const auswahl = [...(event.target.files ?? [])];
      event.target.value = '';
      if (auswahl.length) await hochladen(auswahl);
    },
  });

  const zeile = (eintrag) =>
    el(
      'li',
      { class: 'start-folder__row' },
      el('code', { class: 'start-folder__name' }, eintrag.pfad),
      el(
        'span',
        { class: 'start-folder__meta' },
        `${groesse(eintrag.groesse)} · ${zeit(eintrag.mtimeMs)}`,
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Im Browser bearbeiten',
          onclick: () => bearbeiten(eintrag.pfad),
        },
        '✎',
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Löschen',
          onclick: async () => {
            if (!confirm(`"${eintrag.pfad}" löschen?`)) return;
            try {
              sagErgebnis((await api.fileDelete(bot.id, eintrag.pfad)).files);
              await neu();
            } catch (error) {
              fehler(error);
            }
          },
        },
        '✕',
      ),
    );

  /** Ein Dialog mit einem Textfeld – kein Editor, aber ein brauchbarer. */
  const bearbeiten = async (pfad) => {
    let datei;
    try {
      datei = await api.fileRead(bot.id, pfad);
    } catch (error) {
      fehler(error);
      return;
    }
    const feld = el('textarea', {
      class: 'input start-folder__editor',
      rows: 18,
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
          { class: 'icon-btn', type: 'button', onclick: () => dialog.close() },
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
            onclick: async (event) => {
              const knopf = event.currentTarget;
              knopf.disabled = true;
              try {
                sagErgebnis(
                  (await api.fileWrite(bot.id, pfad, feld.value)).files,
                );
                dialog.close();
                await neu();
              } catch (error) {
                fussnote.textContent = error.message;
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

  host.append(
    el(
      'div',
      { class: 'start-folder__head' },
      el('span', { class: 'start-folder__label' }, 'Ordner'),
      el('code', { class: 'start-folder__path' }, bot.startFolder ?? ''),
    ),
    el(
      'div',
      { class: 'start-folder__tools' },
      el(
        'label',
        { class: 'btn btn--primary btn--sm' },
        'Dateien hochladen',
        dateiWahl,
      ),
      uebernehmenButton,
    ),
    liste,
    hinweis,
  );

  neu();
};
