/**
 * DB client factory.
 *
 * Returns typed Drizzle clients for the master DB and any pool DB.
 * In v1 both use the D1 driver.  Bundle 12 will add a Node / better-sqlite3
 * path that wraps bindings with the same shape — handlers never need to
 * branch on the driver.
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

/** Returns a Drizzle client wired to the master (identity) DB. */
export function masterClient(env: Env) {
  const binding = env.DB_MODE === 'split' ? env.MASTER_DB : env.DB;
  if (!binding) throw new Error('master DB binding not found');
  return drizzleD1(binding as D1Database, { schema: masterSchema });
}

/** Returns a Drizzle client wired to a specific pool DB binding. */
export function poolClient(binding: D1Database) {
  return drizzleD1(binding, { schema: poolSchema });
}

/** Type of the master Drizzle client — used in auth context + middleware. */
export type MasterClient = ReturnType<typeof masterClient>;

/**
 * Type of the pool Drizzle client.
 *
 * v1: always D1.  Bundle 12 adds a Node target that constructs the same shape
 * using better-sqlite3's drizzle driver.  Keeping it as a concrete
 * ReturnType means handler code can destructure `ctx.pool` without caring
 * about the underlying driver.
 */
export type PoolClient = ReturnType<typeof poolClient>;
