import { defineConfig } from 'vitest/config';
import { cloudflarePool, cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Vitest config with TWO projects:
 *
 *  1. `unit` — Node pool. Pure-unit tests that don't touch D1 / miniflare /
 *     workerd. Boots in ~50ms instead of the ~11s cold-import cost of the
 *     workers pool.
 *
 *  2. `workers` — @cloudflare/vitest-pool-workers. Integration tests + the
 *     consolidated per-repo unit tests (one worker-boot for all 11 repos
 *     via test/db/repos.test.ts → ./repos/_*.ts modules).
 *
 * The split saves ~5 worker boots × ~11s = ~55s cumulative, plus the
 * 10 saved boots from the per-repo consolidation. Wall-time impact:
 * roughly 48s → 25–30s.
 */
const poolOptions = {
  wrangler: { configPath: './wrangler.jsonc' },
  miniflare: {
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      BETTER_AUTH_SECRET: 'test-secret-32-bytes-long-for-hmac-signing-x',
      MC_ADMIN_TOKEN: 'test-admin-token',
    },
  },
};

export default defineConfig({
  test: {
    projects: [
      {
        // Pure-unit tests: no D1, no miniflare, no cloudflare:* imports.
        // Run in Node — cold start ~50ms vs ~11s for workers.
        test: {
          name: 'unit',
          include: [
            'test/ids.test.ts',
            'test/pagination.test.ts',
            'test/serialize.test.ts',
            'test/state-machine/**/*.test.ts',
            'test/schemas/**/*.test.ts',
            'test/auth/email.test.ts',
            'test/middleware/**/*.test.ts',
          ],
          // Existing miniflare-dependent middleware tests stay in the
          // `workers` project; the broad include above is for future
          // unit-pure middleware tests.
          exclude: [
            'test/middleware/content-type-guard.test.ts',
          ],
        },
      },
      {
        // Everything else — needs miniflare + D1 binding.
        // Consolidated per-repo tests live at test/db/repos.test.ts.
        plugins: [cloudflareTest(poolOptions)],
        test: {
          name: 'workers',
          include: ['test/**/*.test.ts'],
          exclude: [
            'test/ids.test.ts',
            'test/pagination.test.ts',
            'test/serialize.test.ts',
            'test/state-machine/**/*.test.ts',
            'test/schemas/**/*.test.ts',
            'test/auth/email.test.ts',
            // Note: test/middleware/**/*.test.ts is NOT excluded wholesale
            // because content-type-guard.test.ts still needs the workers pool.
            // The unit project's `exclude` keeps it there; future unit-pure
            // middleware tests should be added to this list explicitly.
          ],
          pool: cloudflarePool(poolOptions),
          globalSetup: ['./test/global-setup.ts'],
        },
      },
    ],
  },
});
