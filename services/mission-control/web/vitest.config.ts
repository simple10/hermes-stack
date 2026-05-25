import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Web test config — runs SPA component + unit tests in happy-dom via Vitest.
 * Separate from the Worker test config at services/mission-control/vitest.config.ts
 * (which uses @cloudflare/vitest-pool-workers / miniflare).
 *
 * Paths are pinned to this file's directory so the config works when invoked
 * from anywhere (e.g. `vitest run --config web/vitest.config.ts` from the
 * service root).
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tsconfigPaths({ projects: [path.resolve(ROOT, 'tsconfig.json')] })],
  resolve: {
    alias: {
      '@': path.resolve(ROOT, 'src'),
    },
  },
  test: {
    root: ROOT,
    environment: 'happy-dom',
    globals: true,
    setupFiles: [path.resolve(ROOT, 'test/setup.ts')],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
