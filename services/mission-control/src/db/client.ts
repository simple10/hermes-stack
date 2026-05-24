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
 * Env shape accepted by the client helpers.
 *
 * Intentionally permissive `Record<string, unknown>` so callers can pass
 * the Cloudflare-generated `Cloudflare.Env`, Hono's `c.env`, a test fixture,
 * or anything else with the expected keys present. Internal code narrows
 * via runtime checks; type-safety happens at the access site, not the param.
 *
 * This shape accommodates:
 *  - Cloudflare.Env (DB / MASTER_DB / POOL_DEFAULT / DB_MODE all optional)
 *  - Dynamic POOL_<NAME> bindings looked up in pool-resolver
 *  - Auth/middleware enrichment (BETTER_AUTH_SECRET, MC_ADMIN_TOKEN, etc.)
 */
export type Env = Record<string, unknown>;

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
