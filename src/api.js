const request = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
};

/**
 * Ein einziger SSE-Stream für die ganze Oberfläche. Wer sich über `events`
 * anmeldet, bekommt dieselben Ereignisse – nötig, weil z. B. das Bot-Fenster
 * den Stream mitbenutzt, ohne einen zweiten aufzubauen.
 */
const STREAM_TYPES = [
  'snapshot',
  'created',
  'bot',
  'deleted',
  'log',
  'panel',
  'toast',
];
const listeners = new Set();
let source = null;

const openStream = () => {
  if (source) return;
  source = new EventSource('/api/events');
  for (const type of STREAM_TYPES) {
    source.addEventListener(type, (event) => {
      const payload = JSON.parse(event.data);
      for (const listener of listeners) listener(type, payload);
    });
  }
  source.addEventListener('open', () => {
    for (const listener of listeners) listener('open', null);
  });
  source.addEventListener('error', () => {
    for (const listener of listeners) listener('error', null);
  });
};

export const api = {
  authSession: () => request('/auth/session'),
  authLogout: () => request('/auth/logout', { method: 'POST' }),
  access: () => request('/access'),
  updateAccess: (id, body) =>
    request(`/access/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  removeAccess: (id) =>
    request(`/access/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  health: () => request('/health'),
  languages: () => request('/languages'),
  list: () => request('/bots'),
  create: (config) => request('/bots', { method: 'POST', body: config }),
  update: (id, config) =>
    request(`/bots/${id}`, { method: 'PATCH', body: config }),
  remove: (id) => request(`/bots/${id}`, { method: 'DELETE' }),
  start: (id) => request(`/bots/${id}/start`, { method: 'POST' }),
  install: (id, force = false) =>
    request(`/bots/${id}/install`, { method: 'POST', body: { force } }),
  stop: (id) => request(`/bots/${id}/stop`, { method: 'POST' }),
  kill: (id) => request(`/bots/${id}/kill`, { method: 'POST' }),
  restart: (id) => request(`/bots/${id}/restart`, { method: 'POST' }),
  logs: (id, tail = 200) =>
    request(`${id ? `/bots/${id}` : ''}/logs?tail=${tail}`),

  panel: (id) => request(`/bots/${id}/panel`),
  panelDiscordConfig: (id) => request(`/bots/${id}/panel/discord/config`),
  panelDiscordSession: (id) => request(`/bots/${id}/panel/discord/session`),
  panelDiscordLogout: (id) =>
    request(`/bots/${id}/panel/discord/logout`, { method: 'POST' }),
  panelReload: (id) => request(`/bots/${id}/panel/reload`, { method: 'POST' }),
  panelReset: (id) => request(`/bots/${id}/panel`, { method: 'DELETE' }),
  panelState: (id, state) =>
    request(`/bots/${id}/panel/state`, { method: 'PUT', body: { state } }),
  panelSave: (id, values) =>
    request(`/bots/${id}/panel/settings`, { method: 'PUT', body: { values } }),
  panelCommand: (id, command, args = {}) =>
    request(`/bots/${id}/panel/commands/${encodeURIComponent(command)}`, {
      method: 'POST',
      body: { args },
    }),

  events: (onEvent) => {
    listeners.add(onEvent);
    openStream();
    return () => listeners.delete(onEvent);
  },
};
