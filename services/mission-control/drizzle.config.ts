import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/master.ts',
  out: './migrations/master',
  dialect: 'sqlite',
  // No driver: 'd1-http' — that requires Cloudflare creds and doesn't work
  // offline.  We use wrangler d1 migrations apply to apply the SQL locally.
});
