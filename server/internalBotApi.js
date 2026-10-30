/**
 * Restrict the Docker bridge listener to the Bot runtime API only.
 *
 * Keep this guard outside the main router so future dashboard/auth/admin API
 * routes cannot accidentally become reachable through the container gateway.
 */
export const createInternalBotApiHandler = (handler) => (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    res.writeHead(400, {
      'content-type': 'application/json; charset=utf-8',
    });
    return res.end(JSON.stringify({ error: 'Ungültiger Request-Pfad' }));
  }

  if (pathname !== '/api/hub' && !pathname.startsWith('/api/hub/')) {
    res.writeHead(404, {
      'content-type': 'application/json; charset=utf-8',
    });
    return res.end(JSON.stringify({ error: 'Nicht verfügbar' }));
  }
  return handler(req, res);
};
