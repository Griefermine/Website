import { defineConfig } from 'vite';

// Nur fuer die Probe: eine Seite, die den Startordner mit erfundenem Hub zeigt.
export default defineConfig({
  root: 'harness',
  build: { outDir: '/tmp/opencode/harness-dist', emptyOutDir: true },
});
