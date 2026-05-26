import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    // Paths relative to Vite root (./web), NOT the service root.
    tanstackRouter({
      routesDirectory: 'src/routes',
      generatedRouteTree: 'src/routeTree.gen.ts',
    }),
    tailwindcss(),
    viteReact(),
    cloudflare(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
})
