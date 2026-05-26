import { defineConfig, type PluginOption } from 'vite'
import viteReact from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Vite root = ./web so the SPA's index.html and src/ live under web/.
// The Worker (src/index.ts) is discovered by @cloudflare/vite-plugin via
// wrangler.jsonc's `main` field (one directory up from `root`).
const SERVICE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.resolve(SERVICE_ROOT, 'web')

// SPA fallback for `vite dev`. @cloudflare/vite-plugin forces appType: 'custom'
// (disabling Vite's built-in SPA fallback) and only implements SPA routing in
// production via Workers Assets `not_found_handling`. In dev, requests like
// /sign-in or /tasks/abc return 404 on hard-refresh unless we serve index.html
// for unmatched non-API, non-file paths ourselves.
//
// IMPORTANT: register synchronously in configureServer (no returned function)
// so this middleware sits BEFORE the cloudflare plugin's deferred catch-all
// that otherwise dispatches everything to Miniflare and never calls next().
const spaFallback = (): PluginOption => ({
  name: 'mc-spa-dev-fallback',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next()
      const url = req.url ?? '/'
      // Skip API routes, vite internals, and anything that looks like a file.
      if (
        url.startsWith('/api/') ||
        url.startsWith('/@') ||
        url.startsWith('/__') ||
        url.startsWith('/src/') ||
        url.startsWith('/node_modules/') ||
        /\.[a-zA-Z0-9]+(\?|$)/.test(url)
      ) {
        return next()
      }
      try {
        const raw = await fs.readFile(path.join(WEB_ROOT, 'index.html'), 'utf-8')
        const html = await server.transformIndexHtml(url, raw)
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(html)
      } catch (err) {
        next(err)
      }
    })
  },
})

export default defineConfig({
  root: './web',
  plugins: [
    // Paths relative to Vite root (./web), NOT the service root.
    tanstackRouter({
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
    }),
    tailwindcss(),
    viteReact(),
    cloudflare(),
    // spaFallback(),
  ],
  // Mirror the path aliases in web/tsconfig.json so dev/build resolve them.
  // (Vitest has its own config with the same aliases — keep them in sync.)
  resolve: {
    tsconfigPaths: true,
    // alias: {
    //   '@': path.resolve(WEB_ROOT, 'src'),
    //   '@mc/schemas': path.resolve(SERVICE_ROOT, 'src/schemas'),
    // },
  },
})
