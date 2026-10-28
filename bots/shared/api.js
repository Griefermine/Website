const DEFAULT_TIMEOUT = 8000;
const MAX_BODY_BYTES = 256 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

const normalizeBaseUrl = (value) => {
  const raw = String(value ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('BOT_HUB_URL ist keine gültige URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('BOT_HUB_URL muss HTTP oder HTTPS verwenden');
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(
      'BOT_HUB_URL darf keine Zugangsdaten oder Parameter enthalten',
    );
  if (
    process.env.NODE_ENV === 'production' &&
    parsed.protocol !== 'https:' &&
    !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)
  )
    throw new Error('BOT_HUB_URL muss in Produktion HTTPS verwenden');
  return parsed.href.replace(/\/+$/, '');
};

const tokenFromEnv = () => {
  const token = String(process.env.BOT_HUB_TOKEN ?? '').trim();
  if (!token) return '';
  if (!TOKEN_PATTERN.test(token))
    throw new Error('BOT_HUB_TOKEN hat ein ungültiges Format');
  return token;
};

const readJson = async (response) => {
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES)
    throw new Error('Bot-Hub-Antwort ist zu groß');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Bot-Hub lieferte ungültiges JSON');
  }
};

/**
 * Ein Pfadsegment für den Bot-Speicher. Der Hub prüft Namen gegen ein Muster
 * und setzt sie als Parameter in die SQL-Abfrage – hier werden sie nur
 * kodiert, damit ein Doppelpunkt oder ein Punkt im Schlüssel den Weg nicht
 * verändert.
 */
const segment = (value, label) => {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} darf nicht leer sein`);
  return encodeURIComponent(text);
};

const storePath = (collection, key) =>
  `db/${segment(collection, 'Sammlungsname')}/${segment(key, 'Schlüssel')}`;

export const createBotHubApi = ({
  url = process.env.BOT_HUB_URL,
  token = tokenFromEnv(),
  timeoutMs = DEFAULT_TIMEOUT,
} = {}) => {
  const baseUrl = normalizeBaseUrl(url);
  const accessToken = String(token ?? '').trim();
  if (accessToken && !TOKEN_PATTERN.test(accessToken))
    throw new Error('BOT_HUB_TOKEN hat ein ungültiges Format');

  const request = async (
    path,
    { method = 'GET', body, signal, query, missingAsEmpty = false } = {},
  ) => {
    if (!baseUrl || !accessToken) return null;
    const relative = String(path ?? '');
    // `:` und `%` gehören dazu, weil Sammlungsnamen und Schlüssel diese Zeichen
    // enthalten dürfen und der Pfad hier kodiert zusammengesetzt wird. `?` und
    // `#` bleiben verboten – damit kann ein Schlüssel die Anfrage nicht
    // umdeuten. Die eigentliche Prüfung der Namen macht der Hub.
    if (!/^\/?[A-Za-z0-9/_.:%@-]+$/.test(relative))
      throw new Error('Ungültiger Bot-Hub-Endpunkt');
    const parameter = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {}))
      if (value !== undefined && value !== null && value !== '')
        parameter.set(name, String(value));
    const query2 = parameter.toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal)
      signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    try {
      const response = await fetch(
        `${baseUrl}/api/hub/${relative.replace(/^\/+/, '')}${query2 ? `?${query2}` : ''}`,
        {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json',
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        },
      );
      const data = await readJson(response);
      // Für Abfragen, bei denen "nicht vorhanden" eine normale Antwort ist:
      // `db.get` liefert dann null statt einen Fehler zu werfen.
      if (!response.ok && !(missingAsEmpty && response.status === 404))
        throw new Error(
          data.error || `Bot-Hub antwortete mit HTTP ${response.status}`,
        );
      return data;
    } finally {
      clearTimeout(timer);
    }
  };

  const events = async function* () {
    if (!baseUrl || !accessToken) return;
    const controller = new AbortController();
    try {
      const response = await fetch(`${baseUrl}/api/hub/events`, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'text/event-stream',
          'cache-control': 'no-cache',
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(
          `Bot-Hub-Ereignisstream antwortete mit HTTP ${response.status}`,
        );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          let name = 'message';
          const data = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trim());
          }
          if (!data.length) continue;
          try {
            yield { name, data: JSON.parse(data.join('\n')) };
          } catch {
            throw new Error('Bot-Hub lieferte ein ungültiges SSE-Ereignis');
          }
        }
      }
    } finally {
      controller.abort();
    }
  };

  return {
    get connected() {
      return Boolean(baseUrl && accessToken);
    },
    settings: () => request('settings'),
    publish: (state) => request('state', { method: 'POST', body: { state } }),
    notify: (message, kind = 'info') =>
      request('notify', { method: 'POST', body: { message, kind } }),
    registerPanel: (panel) =>
      request('panel', { method: 'POST', body: { panel } }),
    callback: (url, callbackToken) =>
      request('callback', {
        method: 'POST',
        // Kein Default auf den Runtime-Token: BOT_HUB_TOKEN ist ein
        // Hub-Auth-Credential und darf nicht als Callback-Secret
        // weitergereicht werden. Wer keinen separaten Token übergibt,
        // registriert ohne Secret (Server speichert '').
        body:
          callbackToken === undefined ? { url } : { url, token: callbackToken },
      }),

    /**
     * Der Bot-Speicher: ein Bereich pro Bot, den nur der laufende Prozess
     * erreicht. Welcher Bot das ist, entscheidet das Token – eine andere
     * Bot-ID lässt sich auch hier nicht mitschicken.
     *
     *   await hub.db.set('notizen', 'user:1', { text: 'hallo' });
     *   await hub.db.get('notizen', 'user:1');   // { text: 'hallo' } oder null
     *   await hub.db.list('notizen', { limit: 20 });
     *   await hub.db.remove('notizen', 'user:1');
     */
    db: {
      get: async (collection, key) => {
        const data = await request(storePath(collection, key), {
          missingAsEmpty: true,
        });
        return data?.entry?.value ?? null;
      },
      set: (collection, key, value) =>
        request(storePath(collection, key), {
          method: 'PUT',
          body: { value },
        }),
      list: (collection, { prefix, limit, offset } = {}) =>
        request(`db/${segment(collection, 'Sammlungsname')}`, {
          query: { prefix, limit, offset },
        }),
      remove: (collection, key) =>
        request(storePath(collection, key), { method: 'DELETE' }),
    },

    events,
  };
};

export const botHubApi = createBotHubApi();
