import { el, clear } from './dom.js';

const TOKEN_KEY = 'DISCORD_BOT_TOKEN';
const MASK = '••••••••';

const field = (label, control, hint) =>
  el(
    'label',
    { class: 'field' },
    el('span', { class: 'field__label' }, label),
    control,
    hint ? el('span', { class: 'field__hint' }, hint) : null,
  );

const input = (name, value = '', props = {}) =>
  el('input', { class: 'input', name, value: value ?? '', ...props });

const envRow = (key = '', value = '', secret = false) => {
  const keyInput = input('envKey', key, {
    placeholder: 'KEY',
    spellcheck: 'false',
  });
  const valueInput = input('envValue', value, {
    placeholder: secret ? 'bleibt lokal gespeichert' : 'WERT',
    spellcheck: 'false',
  });
  valueInput.type = secret ? 'password' : 'text';
  const row = el(
    'div',
    { class: `env-row${secret ? ' env-row--secret' : ''}` },
    keyInput,
    valueInput,
    el(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        title: 'Zeile entfernen',
        onclick: () => row.remove(),
      },
      '✕',
    ),
  );
  row._secret = secret;
  return row;
};

const fillDeps = (template, deps) =>
  template
    ? template
        .replace(/\{package\}/gi, () => deps?.package ?? '')
        .replace(/\{module\}/gi, () => deps?.module ?? '')
        .replace(/\{venv\}/gi, () => deps?.venv ?? '')
    : '';

export const openBotForm = ({ bot, languages, onSubmit }) => {
  const isEdit = Boolean(bot);
  const model = bot ?? {
    name: '',
    emoji: '🤖',
    description: '',
    language: languages[0]?.id ?? 'python',
    framework: '',
    entrypoint: '',
    command: '',
    cwd: '.',
    guildId: '',
    autoRestart: false,
    autoInstall: true,
    depsCheck: '',
    depsInstall: '',
    maxRestarts: 5,
    env: {},
    secretEnv: {},
  };

  const languageSelect = el(
    'select',
    { class: 'input', name: 'language' },
    ...languages.map((language) =>
      el(
        'option',
        { value: language.id, selected: language.id === model.language },
        language.label,
      ),
    ),
  );

  const frameworkSelect = el('select', { class: 'input', name: 'framework' });
  const entrypointInput = input('entrypoint', model.entrypoint, {
    placeholder: 'bot.py',
  });
  const commandInput = input('command', model.command, {
    placeholder: 'python3 {entrypoint}',
  });
  const autoInstallInput = el('input', {
    type: 'checkbox',
    name: 'autoInstall',
    checked: model.autoInstall !== false,
  });

  const depsPreview = el('div', { class: 'deps' });
  const customCheck = input('depsCheck', model.depsCheck, {
    placeholder: 'z. B. test -d .venv',
  });
  const customInstall = input('depsInstall', model.depsInstall, {
    placeholder: 'z. B. {venv}/bin/pip install {package}',
  });

  const renderDeps = () => {
    const language =
      languages.find((l) => l.id === languageSelect.value) ?? languages[0];
    const framework =
      language.frameworks.find((f) => f.name === frameworkSelect.value) ??
      language.frameworks[0];
    const deps = { ...framework, venv: language.venv ?? '' };
    const check = fillDeps(language.check, deps);
    const install = fillDeps(language.install, deps);
    clear(depsPreview);
    depsPreview.append(
      el('span', { class: 'deps__title' }, `📦 ${framework.name}`),
      check
        ? el(
            'div',
            { class: 'deps__row' },
            el('span', { class: 'deps__label' }, 'Prüfung'),
            el('code', {}, check),
          )
        : null,
      install
        ? el(
            'div',
            { class: 'deps__row' },
            el('span', { class: 'deps__label' }, 'Installation'),
            el('code', {}, install),
          )
        : el(
            'span',
            { class: 'deps__hint' },
            'Keine automatische Installation möglich',
          ),
      language.prepare
        ? el(
            'div',
            { class: 'deps__row' },
            el('span', { class: 'deps__label' }, 'Umgebung'),
            el('code', {}, fillDeps(language.prepare, deps)),
          )
        : null,
      el(
        'span',
        { class: 'deps__hint' },
        language.venv
          ? `Fehlt die Library, legt der Hub zuerst ${language.venv} an und installiert dort – dein System-Python bleibt unangetastet (PEP 668).`
          : 'Fehlt die Library, installiert der Hub sie beim Start automatisch in deinem Projektordner.',
      ),
    );
  };

  const syncLanguage = () => {
    const language =
      languages.find((l) => l.id === languageSelect.value) ?? languages[0];
    clear(frameworkSelect);
    for (const framework of language.frameworks) {
      frameworkSelect.append(
        el(
          'option',
          {
            value: framework.name,
            selected: framework.name === model.framework,
          },
          framework.name,
        ),
      );
    }
    if (!isEdit) {
      entrypointInput.value = language.entrypoint;
      entrypointInput.placeholder = language.entrypoint;
      commandInput.value = language.command;
      commandInput.placeholder = language.command;
    }
    renderDeps();
  };
  languageSelect.addEventListener('change', syncLanguage);
  frameworkSelect.addEventListener('change', renderDeps);
  syncLanguage();

  const envList = el('div', { class: 'env-list' });
  for (const [key, value] of Object.entries(model.env ?? {})) {
    if (key === TOKEN_KEY) continue;
    envList.append(envRow(key, value));
  }
  const tokenInput = input('token', '', {
    type: 'password',
    placeholder: model.secretEnv?.[TOKEN_KEY]
      ? `${MASK} – unverändert lassen`
      : 'Bot-Token einfügen',
    spellcheck: 'false',
  });

  const form = el(
    'form',
    { class: 'form', method: 'dialog' },
    el(
      'div',
      { class: 'form__grid' },
      field(
        'Emoji',
        input('emoji', model.emoji, {
          maxlength: 4,
          class: 'input input--emoji',
        }),
      ),
      field(
        'Name',
        input('name', model.name, {
          placeholder: 'Mein Bot',
          required: true,
          maxlength: 40,
        }),
      ),
    ),
    field(
      'Beschreibung',
      input('description', model.description, {
        placeholder: 'Was macht der Bot?',
        maxlength: 160,
      }),
    ),
    el(
      'div',
      { class: 'form__grid' },
      field('Sprache', languageSelect),
      field('Library / Framework', frameworkSelect),
    ),
    field(
      'Einstiegspunkt',
      entrypointInput,
      'Datei, die gestartet wird (z. B. bot.py, index.js)',
    ),
    field(
      'Startbefehl',
      commandInput,
      '{entrypoint} wird ersetzt · {jar} findet automatisch die gebaute .jar-Datei',
    ),
    el(
      'div',
      { class: 'form__grid' },
      field(
        'Arbeitsordner',
        input('cwd', model.cwd, { placeholder: '.' }),
        'Relativ zum Projektordner',
      ),
      field(
        'Guild-ID (optional)',
        input('guildId', model.guildId, { placeholder: '1234567890' }),
      ),
    ),
    el(
      'fieldset',
      { class: 'field' },
      el('legend', { class: 'field__label' }, 'Umgebungsvariablen'),
      tokenInput,
      el(
        'span',
        { class: 'field__hint' },
        'Wird nur lokal gespeichert und nie an den Browser zurückgesendet',
      ),
      envList,
      el(
        'button',
        {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          onclick: () => envList.append(envRow()),
        },
        '+ Variable',
      ),
    ),
    el(
      'fieldset',
      { class: 'field' },
      el('legend', { class: 'field__label' }, 'Abhängigkeiten'),
      el(
        'label',
        { class: 'switch switch--flat' },
        autoInstallInput,
        el('span', {}, 'Fehlende Library beim Start automatisch installieren'),
      ),
      depsPreview,
      field(
        'Eigener Prüfbefehl',
        customCheck,
        'optional – überschreibt die Vorlage',
      ),
      field('Eigener Installationsbefehl', customInstall, 'optional'),
    ),
    el(
      'div',
      { class: 'form__grid' },
      el(
        'label',
        { class: 'switch' },
        el('input', {
          type: 'checkbox',
          name: 'autoRestart',
          checked: model.autoRestart,
        }),
        el('span', {}, 'Automatisch neu starten bei Absturz'),
      ),
      field(
        'Max. Neustarts',
        input('maxRestarts', model.maxRestarts, {
          type: 'number',
          min: 0,
          max: 20,
        }),
      ),
    ),
  );

  const dialog = el(
    'dialog',
    { class: 'modal' },
    el(
      'header',
      { class: 'modal__head' },
      el('h2', {}, isEdit ? 'Bot bearbeiten' : 'Neuen Bot anlegen'),
      el(
        'button',
        { class: 'icon-btn', type: 'button', onclick: () => dialog.close() },
        '✕',
      ),
    ),
    el('div', { class: 'modal__body' }, form),
    el(
      'footer',
      { class: 'modal__foot' },
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
          type: 'submit',
          value: 'submit',
          form: 'bot-form',
        },
        isEdit ? 'Speichern' : 'Anlegen',
      ),
    ),
  );
  form.id = 'bot-form';

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'submit') {
      dialog.remove();
      return;
    }
    const data = new FormData(form);
    const env = {};
    for (const row of envList.children) {
      const key = row.querySelector('[name="envKey"]').value.trim();
      if (key) env[key] = row.querySelector('[name="envValue"]').value;
    }
    const secretEnv = {};
    if (tokenInput.value.trim()) secretEnv[TOKEN_KEY] = tokenInput.value.trim();
    onSubmit({
      name: data.get('name').toString().trim(),
      emoji: data.get('emoji').toString().trim() || '🤖',
      description: data.get('description').toString().trim(),
      language: data.get('language').toString(),
      framework: data.get('framework').toString(),
      entrypoint: data.get('entrypoint').toString().trim(),
      command: data.get('command').toString().trim(),
      cwd: data.get('cwd').toString().trim() || '.',
      guildId: data.get('guildId').toString().trim(),
      autoRestart: data.get('autoRestart') !== null,
      autoInstall: data.get('autoInstall') !== null,
      depsCheck: data.get('depsCheck').toString().trim(),
      depsInstall: data.get('depsInstall').toString().trim(),
      maxRestarts: Number(data.get('maxRestarts') || 5),
      env,
      secretEnv,
    });
    dialog.remove();
  });

  document.body.append(dialog);
  dialog.showModal();
  form.querySelector('[name="name"]').focus();
};
