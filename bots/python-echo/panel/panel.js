// Diese Seite läuft in einer Sandbox (Origin "null"). Sie spricht per
// bridge.js mit dem Dashboard – nicht per fetch mit der Hub-API.
// Pfad: /api/bots/<id>/panel/file/panel/index.html
const parts = location.pathname.split('/').filter(Boolean);
const botId = parts[0] === 'api' && parts[1] === 'bots' ? parts[2] : '';
const bridgeUrl = `/api/bots/${botId}/panel/bridge.js`;
const panelBase = `/api/bots/${botId}/panel`;
const oauthComplete =
  new URLSearchParams(location.search).get('discord') === 'connected';

if (oauthComplete && window.opener) {
  window.opener.postMessage(
    { source: 'python-panel-discord', type: 'connected' },
    '*',
  );
  window.close();
}

const MASK = '••••••••';
const $ = (id) => document.getElementById(id);

/** Erzeugt ein Element – dynamische Werte landen immer über textContent. */
const h = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const icon = (path, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"
              width="13" height="13" aria-hidden="true">${path}${extra}</svg>`;

const ICONS = {
  status:
    '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  users:
    '<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1"/><circle cx="9.5" cy="7.5" r="3.2"/><path d="M17 4.6a3.2 3.2 0 0 1 0 6"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4l-1.5 16M16 4l-1.5 16"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z"/>',
};

let hub = null;
let payload = null;
let dirty = false;
let incoming = null;
const controls = new Map();
const cleared = new Set();
const busy = new Set();
let roles = [];

const discordRequest = async (path, options = {}) => {
  const response = await fetch(`${panelBase}/discord/${path}`, {
    credentials: 'include',
    ...options,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? 'Discord-Anfrage fehlgeschlagen');
  return data;
};

const renderDiscord = (session) => {
  const status = $('discord-status');
  const loginRow = $('discord-login-row');
  const userRow = $('discord-user-row');
  const list = $('guild-list');
  const empty = $('guilds-empty');
  if (!status || !loginRow || !userRow || !list || !empty) return;
  if (!session.authenticated) {
    status.textContent = 'nicht angemeldet';
    status.className = 'pill';
    loginRow.hidden = false;
    userRow.hidden = true;
    list.hidden = true;
    empty.hidden = true;
    return;
  }
  status.textContent = 'verbunden';
  status.className = 'pill pill--ok';
  loginRow.hidden = true;
  userRow.hidden = false;
  userRow.replaceChildren(
    h('strong', { text: `Angemeldet als ${session.user.name}` }),
    h(
      'button',
      { class: 'btn--sm btn--ghost', type: 'button', text: 'Abmelden' },
      null,
    ),
  );
  userRow.lastElementChild.addEventListener('click', async () => {
    await discordRequest('logout', { method: 'POST' });
    renderDiscord({ authenticated: false, guilds: [] });
  });
  list.replaceChildren(
    ...(session.guilds ?? []).map((guild) => {
      const button = h('button', {
        class: 'guild-card',
        type: 'button',
      });
      const icon = h('span', { class: 'guild-card__icon' });
      if (guild.icon) {
        const image = h('img', {
          src: `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(guild.icon)}.png?size=64`,
          alt: '',
        });
        icon.append(image);
      } else icon.textContent = '◈';
      const details = h(
        'span',
        {},
        h('strong', { text: guild.name }),
        h('small', { text: guild.owner ? 'Besitzer' : 'Server verwalten' }),
      );
      const arrow = h('span', { class: 'guild-card__arrow', text: '→' });
      button.append(icon, details, arrow);
      if (localStorage.getItem('pythonPanelGuild') === guild.id)
        button.classList.add('is-selected');
      button.addEventListener('click', () => {
        document
          .querySelectorAll('#guild-list .guild-card')
          .forEach((item) => item.classList.remove('is-selected'));
        button.classList.add('is-selected');
        localStorage.setItem('pythonPanelGuild', guild.id);
        log(`Server "${guild.name}" ausgewählt.`, 'ok');
      });
      return button;
    }),
  );
  list.hidden = false;
  empty.hidden = session.guilds?.length > 0;
};

const loadDiscord = async () => {
  try {
    renderDiscord(await discordRequest('session'));
  } catch (error) {
    log(error.message, 'bad');
  }
};

/* ---------------------------------------------------------------- *
 * Aktivitätsprotokoll
 * ---------------------------------------------------------------- */
const stamp = () => new Date().toLocaleTimeString('de-DE', { hour12: false });

const log = (message, kind = 'info', detail) => {
  const list = $('log');
  const node = h(
    'li',
    {},
    h('time', { text: stamp() }),
    h('span', { class: `is-${kind}`, text: message }),
  );
  if (detail !== undefined) {
    node.append(
      h(
        'details',
        {},
        h('summary', { text: 'Antwort' }),
        h('pre', { text: JSON.stringify(detail, null, 2) }),
      ),
    );
  }
  list.prepend(node);
  while (list.children.length > 40) list.lastElementChild.remove();
};

/* ---------------------------------------------------------------- *
 * Live-Werte
 * ---------------------------------------------------------------- */
const LABELS = {
  status: ['Status', 'status'],
  guilds: ['Server', 'users'],
  latency: ['Latenz', 'gauge'],
  mode: ['Modus', 'bolt'],
  user: ['Angemeldet als', 'user'],
  cooldown: ['Cooldown', 'clock'],
  startedAt: ['Gestartet', 'clock'],
};

const isEpoch = (value) =>
  typeof value === 'number' && value > 1_000_000_000 && value < 4e9;

const readValue = (value) => {
  if (value === null || value === undefined || value === '') return '–';
  if (isEpoch(value))
    return new Date(value * 1000).toLocaleTimeString('de-DE', {
      hour12: false,
    });
  if (typeof value === 'boolean') return value ? 'ja' : 'nein';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const toneOf = (key, value) => {
  const text = String(value ?? '').toLowerCase();
  if (['error', 'crashed', 'rot'].some((t) => text.includes(t)))
    return 'stat--bad';
  if (['warn', 'demo', 'dry'].some((t) => text.includes(t)))
    return 'stat--warn';
  if (
    ['online', 'ready', 'running', 'live', 'safe'].some((t) => text.includes(t))
  )
    return 'stat--ok';
  return key === 'latency' ? 'stat--ok' : '';
};

const paintStats = (state) => {
  const box = $('stats');
  const entries = Object.entries(state ?? {});
  if (!entries.length) {
    box.replaceChildren(
      h('p', {
        class: 'empty',
        text: payload?.online
          ? 'Der Bot hat noch keine Werte gemeldet.'
          : 'Bot läuft nicht – starte ihn, um Live-Werte zu sehen.',
      }),
    );
    return;
  }
  const known = entries.filter(([key]) => key in LABELS);
  const rest = entries.filter(([key]) => !(key in LABELS));
  box.replaceChildren(
    ...[...known, ...rest].map(([key, value]) => {
      const [label, ic] = LABELS[key] ?? [key, 'hash'];
      const text = readValue(value);
      return h(
        'div',
        { class: `stat ${toneOf(key, value)}` },
        h(
          'div',
          { class: 'stat__label' },
          h('span', { html: icon(ICONS[ic] ?? ICONS.hash) }),
          label,
        ),
        h('div', {
          class: `stat__value${text === '–' ? ' is-empty' : ''}`,
          text,
        }),
      );
    }),
  );
};

/* ---------------------------------------------------------------- *
 * Formular
 * ---------------------------------------------------------------- */
const markDirty = (on) => {
  dirty = on;
  $('dirty-pill').hidden = !on;
};

const paintSettings = (values, secrets, force) => {
  for (const [key, item] of controls) {
    if (!force && dirty && !cleared.has(key)) continue;
    const { field, input } = item;
    if (field.secret) {
      input.value = '';
      cleared.delete(key);
      input.placeholder = secrets?.[key]
        ? `${MASK} · gespeichert, leer lassen zum Beibehalten`
        : 'noch nicht gesetzt';
      item.badge.textContent = secrets?.[key] ? MASK : '';
      item.badge.hidden = !secrets?.[key];
      continue;
    }
    if (field.type === 'boolean') {
      input.checked = Boolean(values?.[key]);
      item.track.setAttribute('aria-checked', String(input.checked));
      continue;
    }
    const next = values?.[key] ?? '';
    if (input) input.value = next;
    if (field.type === 'select' && item.segments) {
      for (const button of item.segments)
        button.setAttribute(
          'aria-pressed',
          String(button.dataset.value === String(next)),
        );
    }
    if (field.type === 'number') syncRange(item);
  }
};

const syncRange = (item) => {
  if (!item.range) return;
  const min = Number(item.field.min ?? 0);
  const max = Number(item.field.max ?? 100);
  const value = Number(item.input.value || min);
  item.range.value = String(Math.min(max, Math.max(min, value)));
  const pct = max === min ? 0 : ((item.range.value - min) / (max - min)) * 100;
  item.range.style.setProperty('--fill', `${pct}%`);
};

const numberField = (field) => {
  const input = h('input', {
    type: 'number',
    class: '',
    min: field.min,
    max: field.max,
    step: field.step ?? 1,
    autocomplete: 'off',
  });
  const item = { field, input, range: null };
  if (field.min !== undefined && field.max !== undefined) {
    item.range = h('input', {
      type: 'range',
      min: field.min,
      max: field.max,
      step: field.step ?? 1,
      'aria-label': `${field.label} (Schieberegler)`,
    });
    item.range.addEventListener('input', () => {
      input.value = item.range.value;
      syncRange(item);
      markDirty(true);
    });
  }
  input.addEventListener('input', () => {
    syncRange(item);
    markDirty(true);
  });
  return item;
};

const textField = (field) => {
  const input =
    field.type === 'textarea'
      ? h('textarea', {
          rows: 4,
          placeholder: field.placeholder ?? '',
          spellcheck: 'false',
        })
      : h('input', {
          type: field.type === 'number' ? 'number' : 'text',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: field.placeholder ?? '',
        });
  input.addEventListener('input', () => markDirty(true));
  return { field, input, range: null, node: input };
};

const selectField = (field) => {
  const item = { field, input: null, segments: null, value: '' };
  if ((field.options ?? []).length <= 4) {
    item.segments = (field.options ?? []).map((option) =>
      h('button', {
        type: 'button',
        'data-value': option.value,
        'aria-pressed': 'false',
        text: option.label || option.value,
        onclick: () => {
          item.value = String(option.value);
          for (const button of item.segments)
            button.setAttribute(
              'aria-pressed',
              String(button.dataset.value === item.value),
            );
          markDirty(true);
        },
      }),
    );
    item.node = h('div', { class: 'segments', role: 'group' }, item.segments);
    return item;
  }
  item.input = h(
    'select',
    {},
    ...(field.options ?? []).map((option) =>
      h('option', { value: option.value }, option.label || option.value),
    ),
  );
  item.input.addEventListener('change', () => markDirty(true));
  item.node = item.input;
  return item;
};

const booleanField = (field) => {
  const input = h('input', { type: 'checkbox' });
  input.addEventListener('change', () => {
    item.track.setAttribute('aria-checked', String(input.checked));
    markDirty(true);
  });
  const track = h('span', { class: 'switch__track' });
  const item = {
    field,
    input,
    range: null,
    track,
    node: h(
      'label',
      { class: 'switch' },
      input,
      track,
      h('span', { text: field.label || field.key }),
    ),
  };
  return item;
};

const secretField = (field) => {
  const input = h('input', {
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const badge = h('span', { class: 'pill', hidden: true });
  const drop = h('button', {
    type: 'button',
    class: 'btn--sm btn--ghost',
    text: 'Entfernen',
    title: 'Gespeicherten Wert beim Speichern löschen',
    onclick: () => {
      cleared.add(field.key);
      input.value = '';
      input.disabled = true;
      drop.disabled = true;
      input.placeholder = 'wird beim Speichern entfernt';
      badge.hidden = true;
      markDirty(true);
    },
  });
  const reveal = h('button', {
    type: 'button',
    class: 'btn--sm btn--ghost',
    text: 'anzeigen',
    'aria-label': 'Wert sichtbar machen',
    onclick: () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      reveal.textContent = hidden ? 'verbergen' : 'anzeigen';
    },
  });
  input.addEventListener('input', () => {
    if (input.value) cleared.delete(field.key);
    markDirty(true);
  });
  const item = {
    field,
    input,
    range: null,
    badge,
    node: h('div', { class: 'secret-row' }, input, badge, reveal, drop),
  };
  return item;
};

const buildField = (field) => {
  if (field.type === 'boolean') return booleanField(field);
  if (field.secret) return secretField(field);
  if (field.type === 'select') return selectField(field);
  if (field.type === 'number') return numberField(field);
  return textField(field);
};

const buildForm = (data) => {
  const box = $('fields');
  controls.clear();
  cleared.clear();
  $('no-fields').hidden = (data.fields ?? []).length > 0;
  $('save').disabled = !(data.fields ?? []).length;
  if (!(data.fields ?? []).length) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    ...data.fields.map((field) => {
      const item = buildField(field);
      item.badge = item.badge ?? null;
      controls.set(field.key, item);
      if (field.type === 'boolean') {
        return h(
          'div',
          { class: 'field' },
          item.node,
          field.description
            ? h('p', { class: 'field__hint', text: field.description })
            : null,
        );
      }
      const head =
        field.type === 'number' && item.range
          ? h('div', { class: 'number-row' }, item.range, item.input)
          : item.node;
      return h(
        'div',
        { class: 'field' },
        h(
          'div',
          { class: 'field__label' },
          field.label || field.key,
          field.secret ? h('span', { class: 'pill', text: 'geheim' }) : null,
        ),
        head,
        field.description
          ? h('p', { class: 'field__hint', text: field.description })
          : null,
      );
    }),
  );
};

const collect = () => {
  const values = {};
  for (const [key, item] of controls) {
    const { field, input } = item;
    if (field.secret) {
      if (cleared.has(key)) values[key] = '';
      else if (input.value.trim()) values[key] = input.value.trim();
      else if (payload?.secrets?.[key]) values[key] = MASK;
      continue;
    }
    if (field.type === 'boolean') {
      values[key] = input.checked;
      continue;
    }
    if (field.type === 'select' && item.segments) {
      values[key] =
        item.value ||
        item.segments.find((b) => b.getAttribute('aria-pressed') === 'true')
          ?.dataset.value ||
        (field.default ?? '');
      continue;
    }
    let value = input.value;
    // Der Hub prüft min/max nicht – hier schon, damit keine Ausreißer
    // in data/bots.json landen.
    if (field.type === 'number') {
      let num = Number(value);
      if (value !== '' && Number.isFinite(num)) {
        if (field.min !== undefined) num = Math.max(field.min, num);
        if (field.max !== undefined) num = Math.min(field.max, num);
        value = num;
        input.value = String(num);
      }
    }
    values[key] = value;
  }
  return values;
};

/* ---------------------------------------------------------------- *
 * Aktionen
 * ---------------------------------------------------------------- */
const panelCommand = async (id, args = {}) => {
  const answer = await hub.command(id, args);
  if (!answer?.ok) {
    const message =
      answer?.result?.error ??
      answer?.result?.message ??
      answer?.error ??
      'Aktion fehlgeschlagen';
    throw new Error(message);
  }
  return answer.result ?? answer;
};

const renderRoles = () => {
  const box = $('roles');
  $('roles-empty').hidden = roles.length > 0;
  box.replaceChildren(
    ...roles.map((role) => {
      const edit = h('button', {
        type: 'button',
        class: 'btn--sm btn--ghost',
        text: 'Bearbeiten',
        onclick: () => editRole(role),
      });
      const remove = h('button', {
        type: 'button',
        class: 'btn--sm btn--ghost',
        text: 'Löschen',
        onclick: () => deleteRole(role),
      });
      return h(
        'div',
        { class: 'role' },
        h('span', {
          class: 'role__swatch',
          style: `background:${/^#[0-9a-f]{6}$/i.test(role.color) ? role.color : '#5865f2'}`,
        }),
        h(
          'div',
          {},
          h('div', { class: 'role__name', text: role.name }),
          h('div', {
            class: 'role__meta',
            text: `${role.color} · Position ${role.position}${role.managed ? ' · verwaltet' : ''}`,
          }),
        ),
        h('div', { class: 'role__actions' }, edit, remove),
      );
    }),
  );
};

const loadRoles = async () => {
  $('roles-refresh').disabled = true;
  try {
    const result = await panelCommand('roles_list');
    roles = result.roles ?? [];
    renderRoles();
    log(`${roles.length} Discord-Rollen geladen.`, 'ok');
  } catch (error) {
    log(`Rollen konnten nicht geladen werden: ${error.message}`, 'bad');
  } finally {
    $('roles-refresh').disabled = false;
  }
};

const editRole = async (role) => {
  if (role.managed) {
    log('Verwaltete Discord-Rollen können nicht bearbeitet werden.', 'bad');
    return;
  }
  const name = prompt('Neuer Rollenname:', role.name);
  if (name === null) return;
  const color = prompt('Neue Farbe (#RRGGBB):', role.color);
  if (color === null) return;
  try {
    await panelCommand('role_update', {
      id: role.id,
      name,
      color,
      hoist: role.hoist,
      mentionable: role.mentionable,
    });
    await loadRoles();
    log(`Rolle "${name}" aktualisiert.`, 'ok');
  } catch (error) {
    log(`Rolle konnte nicht geändert werden: ${error.message}`, 'bad');
  }
};

const deleteRole = async (role) => {
  if (role.managed) {
    log('Verwaltete Discord-Rollen können nicht gelöscht werden.', 'bad');
    return;
  }
  if (!confirm(`Rolle "${role.name}" wirklich löschen?`)) return;
  try {
    await panelCommand('role_delete', { id: role.id });
    await loadRoles();
    log(`Rolle "${role.name}" gelöscht.`, 'ok');
  } catch (error) {
    log(`Rolle konnte nicht gelöscht werden: ${error.message}`, 'bad');
  }
};

const runCommand = async (command, dryBox) => {
  if (busy.has(command.id)) return;
  busy.add(command.id);
  const button = $(`cmd-${command.id}`);
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'läuft …';
  const args = dryBox?.checked ? { dry: true } : {};
  log(`${command.label} gestartet …`, 'info', args);
  try {
    const answer = await hub.command(command.id, args);
    const ok = answer?.ok ?? answer?.result?.ok ?? false;
    const data = answer?.result ?? answer;
    log(
      ok ? `${command.label} erfolgreich` : `${command.label} fehlgeschlagen`,
      ok ? 'ok' : 'bad',
      data,
    );
    if (answer?.payload) {
      applyPayload(answer.payload, { rebuild: false });
      log('Seite aktualisiert.', 'ok');
    }
  } catch (error) {
    log(`${command.label}: ${error.message}`, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = label;
    busy.delete(command.id);
  }
};

const buildActions = (list) => {
  const box = $('actions');
  $('no-actions').hidden = (list ?? []).length > 0;
  busy.clear();
  box.replaceChildren(
    ...(list ?? []).map((command) => {
      // `announce` versteht einen Probelauf – so gesetzt, ohne den
      // generischen Fall zu verbiegen.
      const dryBox =
        command.id === 'announce'
          ? h('input', { type: 'checkbox', id: `dry-${command.id}` })
          : null;
      const button = h('button', {
        type: 'button',
        class: 'btn--sm btn--primary',
        id: `cmd-${command.id}`,
        text: command.label,
        onclick: () => runCommand(command, dryBox),
      });
      return h(
        'div',
        { class: 'action' },
        h(
          'div',
          { class: 'action__text' },
          h('strong', { text: command.label }),
          command.description ? h('p', { text: command.description }) : null,
          h('code', { text: command.id }),
          dryBox
            ? h(
                'label',
                { class: 'action__opts' },
                dryBox,
                'nur prüfen, nichts senden (dry)',
              )
            : null,
        ),
        button,
      );
    }),
  );
};

/* ---------------------------------------------------------------- *
 * Daten vom Dashboard
 * ---------------------------------------------------------------- */
const applyPayload = (next, { rebuild = false } = {}) => {
  const first = !payload;
  payload = next;

  $('conn').replaceChildren(
    h('span', { class: `dot ${next.online ? 'is-live' : 'is-off'}` }),
    next.online ? 'Bot läuft' : 'Bot gestoppt',
  );
  $('conn').className = `pill ${next.online ? 'pill--ok' : ''}`;
  $('beat').hidden = Boolean(next.state && Object.keys(next.state).length);
  $('updated-chip').textContent = `⟳ aktualisiert ${stamp()}`;
  $('live-note').replaceChildren(
    h('strong', {
      text: next.online ? 'Live-Verbindung aktiv.' : 'Bot ist offline.',
    }),
    next.online
      ? next.state?.user
        ? ` Angemeldet als ${next.state.user}.`
        : ' Der Bot meldet seinen aktuellen Zustand.'
      : ' Einstellungen werden beim nächsten Start übernommen.',
  );
  if (next.bot?.name) {
    $('title').textContent = next.bot.name;
    $('avatar').textContent = next.bot.emoji || '🤖';
    $('sub').textContent = `Eigene Seite · ${
      next.online
        ? 'Werte werden live vom Bot gemeldet'
        : 'Bot läuft nicht – Änderungen greifen beim nächsten Start'
    }`;
  }
  const mode = next.settings?.mode;
  const pill = $('mode-pill');
  pill.hidden = !mode;
  pill.textContent = `Modus: ${mode}`;

  paintStats(next.state);

  if (first || rebuild) {
    buildForm(next);
    buildActions(next.commands);
    paintSettings(next.settings, next.secrets, true);
  } else {
    if (dirty) {
      incoming = next;
      $('incoming').hidden = false;
      $('incoming-text').textContent =
        'Der Bot hat neue Werte gemeldet – deine Eingaben sind erhalten geblieben.';
    } else {
      paintSettings(next.settings, next.secrets, false);
    }
  }
};

const load = async () => {
  $('conn').replaceChildren(h('span', { class: 'dot' }), 'verbinde …');
  try {
    const data = await hub.settings();
    applyPayload(data, { rebuild: true });
    $('banner').hidden = true;
    log('Verbunden mit dem Dashboard.', 'ok');
    return data;
  } catch (error) {
    $('conn').replaceChildren(h('span', { class: 'dot' }), 'keine Verbindung');
    $('banner').hidden = false;
    $('banner-text').textContent = error.message.includes('Dashboard')
      ? 'Diese Seite gehört in das Bot-Fenster des Dashboards – dort bekommt sie ihre Antworten über die Brücke.'
      : `Brücke nicht erreichbar: ${error.message}`;
    log(error.message, 'bad');
    throw error;
  }
};

/* ---------------------------------------------------------------- *
 * Ereignisse
 * ---------------------------------------------------------------- */
const say = (message, kind = 'info') => {
  const node = $('save-status');
  node.textContent = message;
  node.className = `status ${kind === 'ok' ? 'is-ok' : kind === 'bad' ? 'is-bad' : ''}`;
};

const save = async () => {
  if (!hub || !(payload?.fields ?? []).length) return;
  $('save').disabled = true;
  say('speichere …');
  try {
    const answer = await hub.save(collect());
    markDirty(false);
    incoming = null;
    $('incoming').hidden = true;
    const data = answer ?? (await hub.settings());
    applyPayload(data, { rebuild: false });
    say(
      payload.online
        ? 'gespeichert · der laufende Bot bekommt es sofort'
        : 'gespeichert · wirkt beim nächsten Start',
      'ok',
    );
    log('Einstellungen gespeichert.', 'ok', data?.settings);
  } catch (error) {
    say(error.message, 'bad');
    log(`Speichern fehlgeschlagen: ${error.message}`, 'bad');
  } finally {
    $('save').disabled = false;
  }
};

$('settings').addEventListener('submit', (event) => {
  event.preventDefault();
  save();
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    save();
  }
});

$('revert').addEventListener('click', () => {
  markDirty(false);
  cleared.clear();
  for (const [key, item] of controls)
    if (item.input) item.input.disabled = false;
  paintSettings(payload?.settings, payload?.secrets, true);
  $('incoming').hidden = true;
  say('auf die gespeicherten Werte zurückgesetzt');
});

$('incoming-apply').addEventListener('click', () => {
  markDirty(false);
  incoming = null;
  $('incoming').hidden = true;
  paintSettings(payload?.settings, payload?.secrets, true);
  say('Werte des Bots übernommen', 'ok');
});

$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  try {
    applyPayload(await hub.settings(), { rebuild: false });
    say('aktualisiert', 'ok');
  } catch (error) {
    say(error.message, 'bad');
  } finally {
    $('refresh').disabled = false;
  }
});

$('notify').addEventListener('click', async () => {
  try {
    await hub.notify('Testmeldung von der Bot-Seite', 'info');
    log('Toast im Dashboard ausgelöst.', 'ok');
  } catch (error) {
    log(error.message, 'bad');
  }
});

$('discord-login').addEventListener('click', async () => {
  $('discord-modal').hidden = false;
});

const startDiscordLogin = async () => {
  const popup = window.open(
    'about:blank',
    'discord-login',
    'popup,width=520,height=720,resizable=yes,scrollbars=yes',
  );
  try {
    const config = await discordRequest('config');
    if (!config.configured) {
      popup?.close();
      log('Discord-Login ist nicht konfiguriert.', 'bad');
      return;
    }
    if (popup) {
      popup.location.href = `${panelBase}/discord/login`;
      popup.focus();
    } else {
      location.href = `${panelBase}/discord/login`;
    }
  } catch (error) {
    popup?.close();
    log(error.message, 'bad');
  }
};

$('discord-authorize').addEventListener('click', startDiscordLogin);
$('discord-modal-close').addEventListener('click', () => {
  $('discord-modal').hidden = true;
});
$('discord-modal-x').addEventListener('click', () => {
  $('discord-modal').hidden = true;
});
window.addEventListener('message', (event) => {
  if (
    event.data?.source !== 'python-panel-discord' ||
    event.data?.type !== 'connected'
  )
    return;
  $('discord-modal').hidden = true;
  loadDiscord();
});

$('clear-log').addEventListener('click', () => $('log').replaceChildren());
$('banner-retry').addEventListener('click', () => load().catch(() => {}));
$('roles-refresh').addEventListener('click', loadRoles);
$('role-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('role-name').value.trim();
  if (!name) return;
  try {
    await panelCommand('role_create_web', {
      name,
      color: $('role-color').value,
      hoist: $('role-hoist').checked,
      mentionable: $('role-mentionable').checked,
    });
    event.target.reset();
    $('role-color').value = '#5865f2';
    await loadRoles();
    log(`Rolle "${name}" erstellt.`, 'ok');
  } catch (error) {
    log(`Rolle konnte nicht erstellt werden: ${error.message}`, 'bad');
  }
});

window.addEventListener('message', (event) => {
  const data = event.data ?? {};
  if (data.source !== 'bot-hub' || data.type !== 'settings') return;
  if (data.payload) applyPayload(data.payload, { rebuild: false });
});

/* ---------------------------------------------------------------- *
 * Start
 * ---------------------------------------------------------------- */
try {
  ({ hub } = await import(bridgeUrl));
  log('bridge.js geladen.', 'ok');
  await load();
  await loadDiscord();
} catch (error) {
  $('conn').replaceChildren(h('span', { class: 'dot' }), 'Brücke fehlt');
  $('banner').hidden = false;
  $('banner-text').textContent =
    `bridge.js nicht erreichbar (${error.message}).`;
  log(error.message, 'bad');
}
