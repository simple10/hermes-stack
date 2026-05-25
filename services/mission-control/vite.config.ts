import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Vite root = ./web so the SPA's index.html and src/ live under web/.
// The Worker (src/index.ts) is discovered by @cloudflare/vite-plugin via
// wrangler.jsonc's `main` field (one directory up from `root`).
const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(SERVICE_ROOT, 'web')

export default defineConfig({
  root: './web',
  plugins: [
    // Paths relative to Vite root (./web), NOT the service root.
    tanstackRouter({
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
    cloudflare(),
  ],
  // Mirror the path aliases in web/tsconfig.json so dev/build resolve them.
  // (Vitest has its own config with the same aliases — keep them in sync.)
  resolve: {
    alias: {
      '@': path.resolve(WEB_ROOT, 'src'),
      '@mc/schemas': path.resolve(SERVICE_ROOT, 'src/schemas'),
    },
  },
})
