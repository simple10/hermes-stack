import { defineConfig } from 'vitest/config';
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers';

// @cloudflare/vitest-pool-workers@0.16.6 API:
//  - `cloudflarePool(opts)` returns the vitest PoolRunner (replaces what
//    `defineWorkersConfig` used to wire up).
//  - `cloudflareTest(opts)` returns the Vite plugin that registers the
//    `cloudflare:test` virtual module + worker shims. Both must be passed
//    the same `poolOptions` so the plugin and runner agree on bindings.
// Docs: https://developers.cloudflare.com/workers/testing/vitest-integration/
const poolOptions = {
  wrangler: { configPath: './wrangler.jsonc' },
  miniflare: {
    compatibilityFlags: ['nodejs_compat'],
    // Test-time secrets: wrangler.jsonc doesn't have these (they're
    // .dev.vars secrets at dev-time, `wrangler secret put` at deploy-time).
    // Miniflare doesn't read .dev.vars in test mode, so inject them here.
    bindings: {
      BETTER_AUTH_SECRET: 'test-secret-32-bytes-long-for-hmac-signing-x',
      MC_ADMIN_TOKEN: 'test-admin-token',
    },
  },
};

export default defineConfig({
  plugins: [cloudflareTest(poolOptions)],
  test: {
    pool: cloudflarePool(poolOptions),
    globalSetup: ['./test/global-setup.ts'],
  },
});
