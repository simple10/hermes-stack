/**
 * DB client factory — Workers / Cloudflare D1 only.
 *
 * Returns typed Drizzle clients for the master DB and any pool DB.
 * All deployments use the D1 driver; there is no Node/SQLite path.
 *
 * Self-hosting runs via `wrangler dev` which provides a local SQLite-backed
 * D1 binding — no Node-native bindings are needed.
 */
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
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

/** Returns a Drizzle client wired to the master (identity) DB. */
export function masterClient(env: Env): DrizzleD1Database<typeof masterSchema> {
  const binding = env.DB_MODE === 'split' ? env.MASTER_DB : env.DB;
  if (!binding) throw new Error('master DB binding not found');
  return drizzle(binding as D1Database, { schema: masterSchema });
}

/** Returns a Drizzle client wired to a specific pool DB binding. */
export function poolClient(binding: D1Database): DrizzleD1Database<typeof poolSchema> {
  return drizzle(binding, { schema: poolSchema });
}

/** Type of the master Drizzle client — used in auth context + middleware. */
export type MasterClient = DrizzleD1Database<typeof masterSchema>;

/** Type of the pool Drizzle client. */
export type PoolClient = DrizzleD1Database<typeof poolSchema>;
