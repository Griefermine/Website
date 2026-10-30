/**
 * Der interne Docker-Listener darf ausschließlich die Runtime-Bot-API
 * erreichen. Der normale Hub-Handler enthält auch Login-, Dashboard-,
 * Benutzerverwaltungs- und Bot-Panel-Routen und wird deshalb nicht direkt
 * an die Docker-Bridge gebunden.
 */
export const createInternalBotApiHandler = (handler) => {
  if (typeof handler !== 'function')
    throw new TypeError('handler muss eine Funktion sein');

  return (req, res) => {
    let pathname;
    try {
      pathname = new URL(
        String(req.url ?? '/'),
        'http://bot-hub.internal',
      ).pathname;
    } catch {
      res.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(JSON.stringify({ error: 'Ungültiger Request-Pfad' }));
    }

    if (pathname !== '/api/hub' && !pathname.startsWith('/api/hub/')) {
      res.writeHead(404, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end(JSON.stringify({ error: 'Interner Endpunkt nicht gefunden' }));
    }

    return handler(req, res);
  };
};
