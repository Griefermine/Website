/** Kleine Helfer, die manager.js und panel.js beide brauchen. */

export const MAX_BODY_BYTES = 256 * 1024;

export const MASK = '••••••••';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

/**
 * Liest eine .env-Datei. Bewusst tolerant: unbekannte Zeilen werden
 * übersprungen, quoted Werte werden aufgelöst. Wird an zwei Stellen
 * gebraucht – für die Bot-OAuth-Konfiguration und für den Secret-Speicher –
 * und darf deshalb nur einmal existieren, sonst laufen beide auseinander.
 */
export const parseDotenv = (content) => {
  const values = {};
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
      if (match[2].trim().startsWith('"'))
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
};

/**
 * Flags, mit denen ein Interpreter direkt Quelltext ausführt. Ohne diese
 * Sperre wäre jedes freigegebene Binary wieder ein Werkzeug für beliebigen
 * Code – deshalb prüft `isEvalFlag` alle drei Formen: das Flag allein
 * (`-c`), `--flag=wert` und die Kurzform mit angehängtem Wert (`-c"code"`,
 * `-mjson.tool`), die ein naives `args.includes('-c')` durchrutschen lässt.
 */
const EVAL_FLAGS = new Set([
  '-c',
  '-e',
  '-m',
  '-p',
  '--eval',
  '--execute',
  '--print',
]);

export const isEvalFlag = (arg) => {
  const value = String(arg ?? '');
  if (!value.startsWith('-')) return false;
  if (EVAL_FLAGS.has(value)) return true;
  const assign = value.indexOf('=');
  if (assign > 0 && EVAL_FLAGS.has(value.slice(0, assign))) return true;
  // Lange Form mit angehängtem Wert, z. B. `--eval=code`.
  if (value.startsWith('--'))
    return [...EVAL_FLAGS].some(
      (flag) => flag.startsWith('--') && value.startsWith(flag),
    );
  // Kurzflag mit direkt angehängtem Wert, z. B. `-cimport os`.
  return value.length > 2 && EVAL_FLAGS.has(`-${value[1]}`);
};

export const readBody = (req) =>
  new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectBody(httpError(413, 'Anfrage zu groß'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(httpError(400, 'Ungültiges JSON'));
      }
    });
    req.on('error', rejectBody);
  });

/** `headers` ergänzt einzelne Kopfzeilen, z. B. ein Cookie neben der Antwort. */
export const sendJson = (res, status, payload, headers = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
};
