/**
 * DB client factory.
 *
 * Returns typed Drizzle clients for the master DB and any pool DB.
 * Supports two underlying drivers transparently:
 *
 *   • D1 (Workers / Cloudflare)       — binding is a real D1Database
 *   • better-sqlite3 (Node self-host)  — binding carries a `__sqlite`
 *     property attached by wrapSqliteAsD1() in sqlite-adapter.ts
 *
 * Workers-bundle safety: this file only top-level-imports drizzle-orm/d1.
 * The better-sqlite3 branch uses require() inside a runtime `if` guard so
 * esbuild / wrangler never statically bundles the Node-only module.
 */
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import * as masterSchema from './master.ts';
import * as poolSchema from './pool.ts';

/**
 * Minimal env shape accepted by the client helpers.
 * The index signature lets callers pass the full Hono Bindings env, which
 * includes dynamic POOL_* keys (e.g. POOL_DEFAULT, POOL_PREMIUM_ACME).
 */
export type Env = {
  DB?: D1Database;
  MASTER_DB?: D1Database;
  POOL_DEFAULT?: D1Database;
  DB_MODE?: string;
  [key: string]: unknown;
};

/**
 * Sentinel property attached to the D1-shaped wrapper by sqlite-adapter.ts.
 * This is a plain string so the Workers bundle stays clean (no symbol import).
 * Must stay in sync with the `__sqlite` assignment in node-entry.ts.
 */
const SQLITE_PROP = '__sqlite';

/**
 * Pick the right Drizzle adapter for a binding.
 *
 * In D1 mode (Workers / CF): binding.__sqlite is undefined → drizzleD1.
 * In Node mode (self-host):  binding.__sqlite is set by node-entry.ts →
 *   drizzle-orm/better-sqlite3, loaded via require() so bundlers can prune it.
 */
function pickDrizzle(
  binding: D1Database,
  schema: Record<string, unknown>,
): ReturnType<typeof drizzleD1> {
  const sqlite = (binding as unknown as Record<string, unknown>)[SQLITE_PROP];
  if (sqlite !== undefined) {
    // Node self-host: require() keeps drizzle-orm/better-sqlite3 out of the
    // Workers esbuild output (dynamic require is not statically analysed).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { drizzle: drizzleSqlite } = require('drizzle-orm/better-sqlite3') as {
      drizzle: (
        db: unknown,
        opts: { schema: Record<string, unknown> },
      ) => ReturnType<typeof drizzleD1>;
    };
    return drizzleSqlite(sqlite, { schema });
  }
  return drizzleD1(binding, { schema });
}

/** Returns a Drizzle client wired to the master (identity) DB. */
export function masterClient(env: Env) {
  const binding = env.DB_MODE === 'split' ? env.MASTER_DB : env.DB;
  if (!binding) throw new Error('master DB binding not found');
  return pickDrizzle(binding as D1Database, masterSchema as Record<string, unknown>);
}

/** Returns a Drizzle client wired to a specific pool DB binding. */
export function poolClient(binding: D1Database) {
  return pickDrizzle(binding, poolSchema as Record<string, unknown>);
}

/** Type of the master Drizzle client — used in auth context + middleware. */
export type MasterClient = ReturnType<typeof masterClient>;

/**
 * Type of the pool Drizzle client.
 *
 * Both D1 and better-sqlite3 modes produce the same Drizzle client shape;
 * handler code destructures `ctx.pool` without knowing the underlying driver.
 */
export type PoolClient = ReturnType<typeof poolClient>;
