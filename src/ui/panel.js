import { api } from '../api.js';
import { el, clear } from './dom.js';
import { toast } from './toast.js';

const MASK = '••••••••';

const SNIPPETS = {
  python: `import hub_link  # siehe bots/python-echo/hub_link.py

hub_link.publish({"status": "online", "guilds": 3})
hub_link.notify("Rollen synchronisiert", "success")`,
  javascript: `const hub = async (path, payload) =>
  fetch(\`\${process.env.BOT_HUB_URL}/api/hub/\${path}\`, {
    method: payload ? 'POST' : 'GET',
    headers: {
      authorization: \`Bearer \${process.env.BOT_HUB_TOKEN}\`,
      'content-type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  }).then((r) => r.json());

await hub('panel', { panel: { title: 'Meine Seite', fields: [/* … */] } });
await hub('state', { state: { status: 'online', guilds: 3 } });
await hub('notify', { message: 'Alles klar', kind: 'success' });`,
  generic: `curl -H "Authorization: Bearer $BOT_HUB_TOKEN" \\
     "$BOT_HUB_URL/api/hub/session"

curl -H "Authorization: Bearer $BOT_HUB_TOKEN" \\
     -H 'content-type: application/json' \\
     -d '{"state":{"status":"online"}}' \\
     "$BOT_HUB_URL/api/hub/state"`,
};

const ENDPOINTS = [
  ['GET', '/api/hub/session', 'Bot, Einstellungen und URLs der eigenen Seite'],
  [
    'GET',
    '/api/hub/settings',
    'Einstellungen aus dem Dashboard (inkl. Secrets)',
  ],
  ['PUT', '/api/hub/settings', 'Werte aus dem Bot heraus überschreiben'],
  ['GET', '/api/hub/events', 'Ereignis-Stream – feuert bei jeder Änderung'],
  ['POST', '/api/hub/panel', 'Eigene Seite anmelden (nur ohne bot-hub.json)'],
  ['POST', '/api/hub/callback', 'Lokale URL für Aktionsklicks hinterlegen'],
  ['POST', '/api/hub/state', 'Live-Werte an die Seite schicken'],
  ['POST', '/api/hub/notify', 'Kurze Meldung als Toast im Dashboard'],
  [
    'POST',
    '/api/bots/<id>/panel/notify',
    'Wie oben, aber aus der HTML-Seite (bridge.js: hub.notify)',
  ],
];

let current = null;

/* ------------------------------------------------------------------ *
 * Einstellungs-Formular
 * ------------------------------------------------------------------ */
const control = (field) =>
  field.type === 'textarea'
    ? el('textarea', { class: 'input', rows: 4 })
    : field.type === 'select'
      ? el(
          'select',
          { class: 'input' },
          ...field.options.map((option) =>
            el('option', { value: option.value }, option.label || option.value),
          ),
        )
      : el('input', {
          class: 'input',
          type: field.type === 'number' ? 'number' : 'text',
          min: field.min,
          max: field.max,
          step: field.step,
          placeholder: field.placeholder,
          autocomplete: 'off',
          spellcheck: 'false',
        });

const row = (node, field) => {
  node._field = field;
  node._input = node.querySelector('input, textarea, select');
  return node;
};

const booleanRow = (field, value) =>
  row(
    el(
      'label',
      { class: 'switch' },
      el('input', { type: 'checkbox', checked: Boolean(value) }),
      el('span', {}, field.label),
    ),
    field,
  );

const secretRow = (field, isSet) => {
  const hint = el('span', { class: 'field__hint' }, field.description ?? '');
  const input = el('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    placeholder: isSet ? `${MASK} – unverändert lassen` : 'noch nicht gesetzt',
  });
  const remove = el(
    'button',
    {
      class: 'btn btn--sm btn--danger-ghost',
      type: 'button',
      onclick: () => {
        node._cleared = true;
        input.value = '';
        input.disabled = true;
        remove.remove();
        hint.textContent = 'wird beim Speichern entfernt';
      },
    },
    'Entfernen',
  );
  const node = el(
    'div',
    { class: 'field' },
    el('span', { class: 'field__label' }, field.label),
    input,
    isSet ? el('div', { class: 'field__row' }, remove) : null,
    hint,
  );
  node._cleared = false;
  return row(node, field);
};

const valueRow = (field, value) => {
  if (field.type === 'boolean') return booleanRow(field, value);
  if (field.secret) return secretRow(field, value);
  const input = control(field);
  input.value = value ?? field.default ?? '';
  return row(
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label' }, field.label),
      input,
      field.description
        ? el('span', { class: 'field__hint' }, field.description)
        : null,
    ),
    field,
  );
};

const fillForm = (form, panel) => {
  clear(form);
  for (const field of panel.fields) {
    form.append(valueRow(field, panel.settings[field.key]));
  }
  return form;
};

const collectForm = (form, panel) => {
  const values = {};
  for (const node of form.children) {
    const field = node._field;
    if (!field) continue;
    if (field.secret) {
      if (node._cleared) values[field.key] = '';
      else if (node._input.value.trim())
        values[field.key] = node._input.value.trim();
      else if (panel.secrets[field.key]) values[field.key] = MASK;
      continue;
    }
    values[field.key] =
      field.type === 'boolean' ? node._input.checked : node._input.value;
  }
  return values;
};

/* ------------------------------------------------------------------ *
 * Bausteine
 * ------------------------------------------------------------------ */
const standalonePageUrl = (botId, href) =>
  `/api/bots/${encodeURIComponent(botId)}/panel/open?page=${encodeURIComponent(
    href,
  )}`;

const code = (text) => el('pre', { class: 'code' }, el('code', {}, text));

const copyButton = (text) =>
  el(
    'button',
    {
      class: 'btn btn--sm btn--ghost',
      type: 'button',
      onclick: async (event) => {
        const button = event.target;
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = 'Kopiert ✓';
        } catch {
          toast('Kopieren nicht möglich – bitte manuell markieren', 'error');
        }
        setTimeout(() => {
          button.textContent = 'Kopieren';
        }, 1800);
      },
    },
    'Kopieren',
  );

const section = (title, ...children) =>
  el('section', { class: 'panel__section' }, el('h3', {}, title), ...children);

const openStandalonePage = (bot, panel) => {
  const href = panel.entry || panel.pages[0]?.href;
  if (!href) return false;
  const page = window.open(
    standalonePageUrl(bot.id, href),
    '_blank',
    'noopener,noreferrer',
  );
  if (!page) {
    toast(
      'Die Bot-Seite konnte nicht geöffnet werden. Bitte Pop-ups erlauben.',
      'error',
    );
    return false;
  }
  return true;
};

/* ------------------------------------------------------------------ *
 * Reiter
 * ------------------------------------------------------------------ */
const linkTab = (bot, panel) => {
  const snippet =
    SNIPPETS[bot.language] ??
    SNIPPETS[bot.language === 'typescript' ? 'javascript' : 'generic'];
  const manifest = JSON.stringify(
    {
      hub: {
        panel: {
          title: 'Meine Bot-Seite',
          entry: 'panel/index.html',
          settings: [
            { key: 'channel', type: 'text', label: 'Kanal', default: 'logs' },
            {
              key: 'auto',
              type: 'boolean',
              label: 'Automatisch',
              default: true,
            },
          ],
          commands: [
            { id: 'sync', label: 'Synchronisieren', run: 'panel/sync.py' },
          ],
        },
      },
    },
    null,
    2,
  );

  return el(
    'div',
    { class: 'panel__stack' },
    el(
      'div',
      { class: 'note' },
      el(
        'strong',
        {},
        panel.available
          ? 'So ist dieser Bot angebunden'
          : 'So bindest du den Bot an',
      ),
      panel.manifestPath
        ? el('p', {}, 'Manifest: ', el('code', {}, panel.manifestPath))
        : panel.source === 'runtime'
          ? el(
              'p',
              {},
              'Der laufende Prozess hat seine Seite selbst angemeldet.',
            )
          : el(
              'p',
              {},
              'Lege eine ',
              el('code', {}, 'bot-hub.json'),
              ' in ',
              el('code', {}, bot.cwd || '.'),
              ' – oder melde dich aus dem Bot heraus an.',
            ),
      panel.error ? el('p', { class: 'note__error' }, panel.error) : null,
    ),
    section(
      '1 · Manifest – ohne Code im Bot',
      el(
        'p',
        { class: 'panel__text' },
        'Datei ',
        el('code', {}, 'bot-hub.json'),
        ' im Startordner:',
      ),
      el('div', { class: 'code-row' }, code(manifest), copyButton(manifest)),
      el(
        'p',
        { class: 'panel__text' },
        'Felder: ',
        el('code', {}, 'entry'),
        ' (HTML-Datei), ',
        el('code', {}, 'pages'),
        ', ',
        el('code', {}, 'settings'),
        ' (Typen: text, textarea, number, boolean, select, secret), ',
        el('code', {}, 'commands'),
        ' (Skript über ',
        el('code', {}, 'run'),
        ').',
      ),
    ),
    section(
      '2 · Zur Laufzeit – aus dem Bot heraus',
      el(
        'p',
        { class: 'panel__text' },
        'Beim Start setzt der Hub ',
        el('code', {}, 'BOT_HUB_URL'),
        ' und ',
        el('code', {}, 'BOT_HUB_TOKEN'),
        '. Damit schickt der Bot Live-Werte und reagiert auf Änderungen:',
      ),
      el('div', { class: 'code-row' }, code(snippet), copyButton(snippet)),
      el(
        'p',
        { class: 'panel__text' },
        'Die eigene HTML-Seite kann stattdessen ',
        el('code', {}, 'bridge.js'),
        ' importieren und mit ',
        el('code', {}, 'hub.settings()'),
        ', ',
        el('code', {}, 'hub.save()'),
        ', ',
        el('code', {}, 'hub.command()'),
        ' und ',
        el('code', {}, 'hub.state()'),
        ' arbeiten.',
      ),
    ),
    section(
      'Endpunkte für den Bot',
      el(
        'ul',
        { class: 'endpoints' },
        ...ENDPOINTS.map(([verb, path, what]) =>
          el('li', {}, el('code', {}, `${verb} ${path}`), el('span', {}, what)),
        ),
      ),
    ),
    Object.keys(panel.state ?? {}).length
      ? section(
          'Live-Werte des Bots',
          el(
            'dl',
            { class: 'kv' },
            ...Object.entries(panel.state).flatMap(([key, value]) => [
              el('dt', {}, key),
              el(
                'dd',
                {},
                typeof value === 'object' && value !== null
                  ? JSON.stringify(value)
                  : String(value),
              ),
            ]),
          ),
        )
      : null,
  );
};

const settingsTab = (bot, panel, refresh) => {
  const status = el('span', { class: 'field__hint' });
  const form = fillForm(el('form', { class: 'form form--panel' }), panel);

  const save = async () => {
    try {
      const result = await api.panelSave(bot.id, collectForm(form, panel));
      status.textContent = result.changed
        ? panel.online
          ? 'gespeichert – der laufende Bot bekommt es sofort'
          : 'gespeichert – wirkt beim nächsten Start'
        : 'unverändert';
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save();
  });
  form.append(
    el(
      'div',
      { class: 'form__foot' },
      el('button', { class: 'btn btn--primary', type: 'submit' }, 'Speichern'),
      status,
    ),
  );

  return el(
    'div',
    { class: 'panel__stack' },
    el(
      'p',
      { class: 'panel__text' },
      'Beim Speichern werden die Panel-Variablen zusätzlich als ',
      el('code', {}, '.env'),
      ' im Bot-Ordner abgelegt. Geheimnisse werden dort mit restriktiven ',
      'Dateirechten gespeichert.',
    ),
    form,
  );
};

const actionsTab = (bot, panel) => {
  const output = el(
    'pre',
    { class: 'code code--out' },
    'Noch nichts ausgeführt.',
  );

  const buttons = panel.commands.map((command) =>
    el(
      'div',
      { class: 'action' },
      el(
        'div',
        {},
        el('strong', {}, command.label),
        command.description
          ? el('p', { class: 'panel__text' }, command.description)
          : null,
        el(
          'p',
          { class: 'panel__text panel__text--dim' },
          command.run
            ? `Skript: ${command.run}`
            : panel.callback
              ? 'Callback des laufenden Prozesses'
              : 'Braucht ein laufender Bot mit hinterlegter Callback-URL',
        ),
      ),
      el(
        'button',
        {
          class: 'btn btn--sm btn--primary',
          type: 'button',
          onclick: async (event) => {
            const button = event.target;
            button.disabled = true;
            button.textContent = 'läuft …';
            output.textContent = 'Warte auf den Bot …';
            try {
              const { result } = await api.panelCommand(bot.id, command.id);
              output.textContent = JSON.stringify(
                result.data ?? result,
                null,
                2,
              );
              toast(
                result.ok
                  ? `${command.label} ausgeführt`
                  : `${command.label}: Fehler`,
                result.ok ? 'success' : 'error',
              );
            } catch (error) {
              output.textContent = error.message;
              toast(error.message, 'error');
            } finally {
              button.disabled = false;
              button.textContent = command.label;
            }
          },
        },
        command.label,
      ),
    ),
  );

  return el('div', { class: 'panel__stack' }, ...buttons, output);
};

/* ------------------------------------------------------------------ *
 * Fenster
 * ------------------------------------------------------------------ */
export const openPanel = (bot, permissions = []) => {
  if (bot.panel?.entry || bot.panel?.pages?.length) {
    const page = window.open(
      standalonePageUrl(bot.id, bot.panel.entry || bot.panel.pages[0]?.href),
      '_blank',
      'noopener,noreferrer',
    );
    if (!page) {
      toast(
        'Die Bot-Seite konnte nicht geöffnet werden. Bitte Pop-ups erlauben.',
        'error',
      );
      return;
    }
    return;
  }

  const canManage = permissions.includes('panel.manage');
  closePanel();

  const tabs = el('div', { class: 'chips chips--tabs' });
  const body = el('div', { class: 'panel__body' });
  const pill = el('span', { class: 'pill pill--idle' }, '…');
  const title = el('h2', {}, `${bot.emoji} ${bot.name}`);

  const dialog = el(
    'dialog',
    { class: 'modal modal--panel' },
    el(
      'header',
      { class: 'modal__head' },
      title,
      pill,
      canManage
        ? el(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: 'Manifest neu einlesen',
              onclick: async () => {
                try {
                  await api.panelReload(bot.id);
                  await refresh();
                  toast('Manifest neu eingelesen', 'success');
                } catch (error) {
                  toast(error.message, 'error');
                }
              },
            },
            '↻',
          )
        : null,
      el(
        'button',
        { class: 'icon-btn', type: 'button', onclick: () => closePanel() },
        '✕',
      ),
    ),
    tabs,
    body,
  );

  let data = null;
  let active = 'link';

  const options = () => {
    if (!data) return [];
    const items = [];
    if (data.entry || data.pages.length)
      items.push({ id: 'page', label: 'Seite' });
    if (data.fields.length && canManage)
      items.push({ id: 'settings', label: 'Einstellungen' });
    if (data.commands.length && canManage)
      items.push({ id: 'actions', label: 'Aktionen' });
    items.push({ id: 'link', label: 'Anbindung' });
    return items;
  };

  const renderTabs = () => {
    clear(tabs);
    for (const item of options()) {
      tabs.append(
        el(
          'button',
          {
            class: `chip${item.id === active ? ' is-active' : ''}`,
            type: 'button',
            onclick: () => {
              active = item.id;
              render();
            },
          },
          item.label,
        ),
      );
    }
  };

  const render = () => {
    if (!data) {
      body.replaceChildren(
        el('p', { class: 'panel__text' }, 'Lade Bot-Seite …'),
      );
      return;
    }
    if (!options().some((item) => item.id === active)) active = 'link';
    if (active === 'page' && !(data.entry || data.pages.length))
      active = 'link';
    renderTabs();

    if (active === 'page') {
      const buttons = [
        el(
          'button',
          {
            class: 'btn btn--primary',
            type: 'button',
            onclick: () => openStandalonePage(bot, data),
          },
          'Bot-Seite in eigener Seite öffnen',
        ),
      ];
      if (data.pages.length > 1)
        buttons.push(
          ...data.pages.map((page) =>
            el(
              'button',
              {
                class: 'btn btn--ghost',
                type: 'button',
                onclick: () => {
                  const next = { ...data, entry: page.href };
                  openStandalonePage(bot, next);
                },
              },
              page.label,
            ),
          ),
        );
      body.replaceChildren(
        el(
          'div',
          { class: 'panel__stack' },
          el(
            'p',
            { class: 'panel__text' },
            'Die Bot-Seite wird aus Sicherheitsgründen als eigene, isolierte Webseite geöffnet.',
          ),
          el('div', { class: 'panel__tools' }, ...buttons),
        ),
      );
      return;
    }

    if (active === 'settings') {
      body.replaceChildren(settingsTab(bot, data, refresh));
      return;
    }
    if (active === 'actions') {
      body.replaceChildren(actionsTab(bot, data));
      return;
    }
    body.replaceChildren(linkTab(bot, data));
  };

  const refresh = async () => {
    try {
      const response = await api.panel(bot.id);
      data = response.panel;
      pill.textContent = data.online ? 'Bot läuft' : 'Bot gestoppt';
      pill.className = `pill pill--${data.online ? 'ok' : 'idle'}`;
      render();
    } catch (error) {
      body.replaceChildren(el('p', { class: 'panel__text' }, error.message));
    }
  };

  const unsubscribe = api.events((type, payload) => {
    if (!payload?.id || payload.id !== bot.id) return;
    if (type === 'panel') refresh();
    if (type === 'bot') {
      const running = payload.status === 'running';
      pill.textContent = running ? 'Bot läuft' : 'Bot gestoppt';
      pill.className = `pill pill--${running ? 'ok' : 'idle'}`;
    }
  });
  dialog.addEventListener('close', () => {
    unsubscribe();
    dialog.remove();
    if (current?.dialog === dialog) current = null;
  });

  current = { dialog };
  document.body.append(dialog);
  dialog.showModal();
  refresh();
};

export const closePanel = () => {
  if (!current) return;
  const { dialog } = current;
  current = null;
  if (dialog.open) dialog.close();
};
