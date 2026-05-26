import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    tanstackRouter({
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
    }),
    tailwindcss(),
    viteReact(),
    // The entry Worker is web's `src/worker.ts` (a tiny `/api/*` → service-
    // binding dispatcher). The `auxiliaryWorkers` array boots the API Worker
    // in the same miniflare instance during dev, so the `API` service binding
    // declared in wrangler.jsonc resolves to it. Result: one `pnpm dev`
    // command, true same-origin, no CORS, no proxy.
    cloudflare({
      auxiliaryWorkers: [{ configPath: '../api/wrangler.jsonc' }],
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
})
