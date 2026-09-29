import { createServer as createServerFactory } from 'node:http';
import { createServer, stopAllBots } from './manager.js';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

const server = createServerFactory(createServer());

server.listen(port, host, () => {
  console.log(
    `\n  \x1b[95m◆ Bot-Hub\x1b[0m läuft auf \x1b[96mhttp://${host}:${port}\x1b[0m\n`,
  );
});

let closing = false;
const shutdown = () => {
  if (closing) process.exit(0);
  closing = true;
  stopAllBots();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
