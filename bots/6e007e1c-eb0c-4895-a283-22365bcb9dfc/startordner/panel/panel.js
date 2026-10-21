// Beispiel-Webseite: läuft in Sandbox (Origin "null"), spricht per
// bridge.js mit dem Hub – nicht per fetch. Discord-OAuth als Beispiel.
void (async () => {
  const parts = location.pathname.split('/').filter(Boolean);
  const botId = parts[0] === 'api' && parts[1] === 'bots' ? parts[2] : '';
  const bridgeUrl = new URL(
    `/api/bots/${encodeURIComponent(botId)}/panel/bridge.js`,
    location.href,
  );
  const bootstrap = new URLSearchParams(location.search).get('bootstrap');
  if (bootstrap) bridgeUrl.searchParams.set('bootstrap', bootstrap);

  const $ = (id) => document.getElementById(id);
  const h = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  };
  const log = (msg, kind = 'info') => {
    const list = $('log');
    if (!list) return;
    list.prepend(h('li', {}, h('span', { class: `is-${kind}`, text: msg })));
    while (list.children.length > 40) list.lastElementChild.remove();
  };

  let hub = null;
  let payload = null;
  try {
    ({ hub } = await import(bridgeUrl.href));
  } catch (e) {
    $('sub').textContent = 'bridge.js nicht erreichbar: ' + e.message;
    return;
  }

  const renderDiscord = (session) => {
    const status = $('discord-status');
    if (!session?.authenticated) {
      status.textContent = 'nicht angemeldet';
      $('discord-login-row').hidden = false;
      $('discord-user-row').hidden = true;
      $('guild-list').hidden = true;
      return;
    }
    status.textContent = 'verbunden';
    $('discord-login-row').hidden = true;
    const user = $('discord-user-row');
    user.hidden = false;
    user.replaceChildren(
      h('strong', { text: `Angemeldet als ${session.user?.name ?? '?'}` }),
      h('button', {
        type: 'button',
        text: 'Abmelden',
        onclick: async () => {
          await hub.discordLogout();
          renderDiscord({ authenticated: false });
        },
      }),
    );
    const list = $('guild-list');
    list.hidden = false;
    list.replaceChildren(
      ...(session.guilds ?? []).map((g) =>
        h('div', { class: 'guild' }, h('strong', { text: g.name })),
      ),
    );
    $('guilds-empty').hidden = (session.guilds ?? []).length > 0;
  };

  const paint = (data) => {
    payload = data;
    if (data?.bot?.name) $('title').textContent = data.bot.name;
    $('conn').textContent = data?.online ? 'Bot läuft' : 'Bot gestoppt';
    $('sub').textContent = data?.online
      ? 'Live – Werte kommen vom Bot.'
      : 'Offline – Änderungen greifen beim nächsten Start.';
    const stats = $('stats');
    const entries = Object.entries(data?.state ?? {});
    const nodes = entries.length
      ? entries.map(([k, v]) => h('div', { class: 'stat' }, h('strong', { text: k }), h('span', { text: String(v) })))
      : [h('p', { class: 'empty', text: 'Noch keine Werte.' })];
    stats.replaceChildren(...nodes);
    const fields = $('fields');
    fields.replaceChildren(
      ...(data?.fields ?? []).map((f) => {
        if (f.secret) {
          return h('label', { class: 'field' }, h('span', { text: f.label + ' (geheim)' }),
            h('input', { type: 'password', name: f.key, placeholder: data?.secrets?.[f.key] ? '•••••••• – leer lassen' : 'noch nicht gesetzt' }));
        }
        return h('label', { class: 'field' }, h('span', { text: f.label || f.key }),
          h('input', { name: f.key, value: data?.settings?.[f.key] ?? f.default ?? '' }));
      }),
    );
    const actions = $('actions');
    actions.replaceChildren(
      ...(data?.commands ?? []).map((c) =>
        h('button', {
          type: 'button', text: c.label,
          onclick: async () => {
            try {
              const r = await hub.command(c.id, {});
              log(`${c.label}: ${JSON.stringify(r?.result ?? r)}`, 'ok');
            } catch (e) { log(c.label + ': ' + e.message, 'bad'); }
          },
        }),
      ),
    );
  };

  $('discord-login').addEventListener('click', async () => {
    try {
      const cfg = await hub.discordConfig();
      if (!cfg?.configured) {
        log('Discord-OAuth nicht konfiguriert – CLIENT_ID/SECRET in data/secrets/<bot-id>.env einrichten.', 'bad');
        return;
      }
      const login = await hub.discordLogin();
      // Als Navigation öffnen (kein fetch): so legt der Hub State + Cookie
      // im richtigen Browser an.
      const popup = window.open(login.location, 'discord-login', 'popup,width=520,height=720');
      if (!popup) location.href = login.location;
      const poll = setInterval(async () => {
        try {
          const s = await hub.discordSession();
          if (s?.authenticated) { clearInterval(poll); renderDiscord(s); if (!popup.closed) popup.close(); }
        } catch {}
      }, 800);
      setTimeout(() => clearInterval(poll), 120000);
    } catch (e) { log(e.message, 'bad'); }
  });

  $('settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const input of e.target.querySelectorAll('[name]')) values[input.name] = input.value;
    try {
      const data = await hub.save(values);
      paint(data);
      $('save-status').textContent = 'gespeichert';
      log('Einstellungen gespeichert.', 'ok');
    } catch (err) { $('save-status').textContent = err.message; }
  });

  try {
    paint(await hub.settings());
    renderDiscord(await hub.discordSession());
    log('Verbunden.', 'ok');
  } catch (e) { log(e.message, 'bad'); }
})();
