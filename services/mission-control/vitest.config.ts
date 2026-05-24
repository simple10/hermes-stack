import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers';

export default defineWorkersConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
});
