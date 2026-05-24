// Tell @cloudflare/vitest-pool-workers what bindings exist on env. Mirrors
// the wrangler.toml [vars] and [[d1_databases]] blocks for the dev/test env.
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    MASTER_DB?: D1Database;
    POOL_DEFAULT?: D1Database;
    DB_MODE: string;
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    CORS_ALLOWED_ORIGINS?: string;
    MC_ADMIN_TOKEN?: string;
  }
}
