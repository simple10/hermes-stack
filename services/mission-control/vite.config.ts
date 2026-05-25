import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import tsconfigPaths from 'vite-tsconfig-paths';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';

// Vite root = ./web so the SPA's index.html and src/ live under web/.
// The Worker (src/index.ts) is discovered by @cloudflare/vite-plugin via
// wrangler.jsonc's `main` field (one directory up from `root`).
export default defineConfig({
  root: './web',
  plugins: [
    tanstackRouter({
      routesDirectory: 'web/src/routes',
      generatedRouteTree: 'web/src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
    cloudflare(),
    tsconfigPaths(),
  ],
});
