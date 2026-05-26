/**
 * Entry Worker for mission-control-ui.
 *
 * The SPA itself is served by Workers Assets; this Worker only runs for
 * requests matching `assets.run_worker_first` in wrangler.jsonc (i.e. `/api/*`).
 * Those requests are dispatched to the API Worker via the `API` service binding.
 *
 * In dev, the API Worker is booted alongside this one by the
 * @cloudflare/vite-plugin's `auxiliaryWorkers` option (see vite.config.ts),
 * so the binding resolves to the local API instance with no CORS or proxy.
 *
 * In prod, the binding resolves to the deployed mission-control-api Worker
 * (deployed independently from the same git repo).
 */
export default {
  fetch(request, env) {
    return env.API.fetch(request)
  },
} satisfies ExportedHandler<Env>
