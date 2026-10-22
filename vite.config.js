import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = env.VITE_HOST || '127.0.0.1';
  return {
    server: {
      // Auch der Entwicklungsserver bleibt lokal. Für bewussten LAN-Zugriff
      // VITE_HOST=0.0.0.0 setzen; im Internetbetrieb nur den TLS-Proxy öffnen.
      host,
      port: 5173,
      proxy: {
        '/api': {
          target: process.env.HUB_URL || 'http://127.0.0.1:8787',
          changeOrigin: true,
          ws: false,
        },
      },
    },
    preview: {
      // Vorschau ebenfalls nur lokal; kein versehentlich offener Webserver.
      host,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
