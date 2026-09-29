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
const pageUrl = (botId, href, token) =>
  `/api/bots/${botId}/panel/file/${href
    .split('/')
    .map(encodeURIComponent)
    .join('/')}#hub=${token}`;

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
        ' im Arbeitsordner:',
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
export const openPanel = (bot) => {
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
      el(
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
      ),
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
  let token = '';
  let active = 'link';
  let frame = null;
  let frameHost = null;
  let frameBar = null;

  const options = () => {
    if (!data) return [];
    const items = [];
    if (data.entry || data.pages.length)
      items.push({ id: 'page', label: 'Seite' });
    if (data.fields.length)
      items.push({ id: 'settings', label: 'Einstellungen' });
    if (data.commands.length) items.push({ id: 'actions', label: 'Aktionen' });
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

  const bridgePayload = () => ({
    fields: data.fields,
    settings: data.settings,
    secrets: data.secrets,
    state: data.state,
    online: data.online,
    // Nur die sichtbaren Angaben – der Pfad des Skripts bleibt im Hub.
    commands: data.commands.map(({ id, label, description, danger }) => ({
      id,
      label,
      description,
      danger,
    })),
    bot: { id: bot.id, name: bot.name, emoji: bot.emoji },
  });

  /** Aktualisiert die eingebettete Seite, ohne sie neu zu laden. */
  const pushToFrame = () => {
    if (!frame?.isConnected || !data) return;
    frame.contentWindow.postMessage(
      { source: 'bot-hub', type: 'settings', payload: bridgePayload() },
      '*',
    );
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
      const src = pageUrl(bot.id, data.entry || data.pages[0].href, token);
      // Der Rahmen bleibt stehen, sonst lädt die Bot-Seite bei jedem Ereignis
      // neu und verliert ihren Zustand.
      if (!frameHost) {
        frameBar = el('div', { class: 'panel__bar' });
        frame = el('iframe', {
          class: 'panel__frame',
          title: `${bot.name} · eigene Seite`,
          sandbox:
            'allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock',
          referrerpolicy: 'no-referrer',
        });
        frameHost = el('div', { class: 'panel__stack' }, frameBar, frame);
      }
      frameBar.replaceChildren(
        el(
          'div',
          { class: 'panel__tools' },
          ...data.pages.map((page) =>
            el(
              'button',
              {
                class: 'chip',
                type: 'button',
                onclick: () => {
                  const next = pageUrl(bot.id, page.href, token);
                  frame.dataset.src = next;
                  frame.src = next;
                },
              },
              page.label,
            ),
          ),
          el(
            'button',
            {
              class: 'btn btn--sm btn--ghost',
              type: 'button',
              onclick: () => {
                frame.src = frame.src;
              },
            },
            'Neu laden',
          ),
          el(
            'a',
            {
              class: 'btn btn--sm btn--ghost',
              href: src,
              target: '_blank',
              rel: 'noopener',
            },
            'Neuer Tab',
          ),
        ),
      );
      if (frame.dataset.src !== src) {
        frame.dataset.src = src;
        frame.src = src;
      }
      if (frameHost.parentNode !== body) body.replaceChildren(frameHost);
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
      token = response.bridge.token;
      pill.textContent = data.online ? 'Bot läuft' : 'Bot gestoppt';
      pill.className = `pill pill--${data.online ? 'ok' : 'idle'}`;
      render();
    } catch (error) {
      body.replaceChildren(el('p', { class: 'panel__text' }, error.message));
    }
  };

  /* Brücke zur eingebetteten Seite – siehe bridge.js im Hub. */
  const onMessage = async (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const message = event.data ?? {};
    if (message.source !== 'bot-hub-panel') return;
    const send = (payload) =>
      frame.contentWindow.postMessage(
        { source: 'bot-hub', seq: message.seq, type: message.type, payload },
        '*',
      );

    if (message.type === 'ready') {
      frame.contentWindow.postMessage(
        { source: 'bot-hub', type: 'hello', token, bot: { id: bot.id } },
        '*',
      );
      send(bridgePayload());
      return;
    }

    try {
      if (message.type === 'settings:get') return send(bridgePayload());
      if (message.type === 'settings:set') {
        await api.panelSave(bot.id, message.values ?? {});
        toast('Einstellungen gespeichert', 'success');
        await refresh();
        return send(bridgePayload());
      }
      if (message.type === 'command') {
        const { result } = await api.panelCommand(
          bot.id,
          message.id,
          message.args ?? {},
        );
        // Die Aktion kann Werte verändert haben – frisch laden und der Seite
        // gleich den neuen Stand mitgeben, damit sie sich von selbst zieht.
        await refresh();
        return send({
          ok: result.ok,
          result: result.data ?? result,
          payload: bridgePayload(),
        });
      }
      if (message.type === 'state:set') {
        await api.panelState(bot.id, message.state ?? {});
        return send({ ok: true });
      }
      if (message.type === 'notify') {
        toast(`${bot.emoji} ${message.message}`, message.kind ?? 'info');
        return send({ ok: true });
      }
    } catch (error) {
      send({ error: error.message });
    }
    return undefined;
  };

  const unsubscribe = api.events((type, payload) => {
    if (!payload?.id || payload.id !== bot.id) return;
    if (type === 'panel') refresh().then(pushToFrame);
    if (type === 'bot') {
      const running = payload.status === 'running';
      pill.textContent = running ? 'Bot läuft' : 'Bot gestoppt';
      pill.className = `pill pill--${running ? 'ok' : 'idle'}`;
    }
  });
  window.addEventListener('message', onMessage);

  dialog.addEventListener('close', () => {
    window.removeEventListener('message', onMessage);
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
