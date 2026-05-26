/**
 * system — Unscoped admin / cron operations.
 *
 * Functions in this module operate across orgs and DO NOT take an AuthContext.
 * Callers must include a `// system: <reason>` comment justifying use.
 *
 * All functions take explicit DB binding(s) rather than deriving them from env.
 * This is forward-compatible with multi-pool sharding (cron iterates bindings
 * explicitly; no ambiguity about which pool to target).
 *
 * Namespaces:
 *   system.events            — pool DB (events table)
 *   system.idempotencyKeys   — pool DB (idempotency_keys table)
 *   system.verification      — master DB (better-auth verification table)
 */
import { lt } from 'drizzle-orm'
import { events, idempotencyKeys } from '../pool.ts'
import { verification } from '../master.ts'
import { masterClient, poolClient } from '../client.ts'

export const system = {
  events: {
    /**
     * Purge events older than the cutoff (ms since epoch).
     *
     * @param binding  D1 binding for the pool DB to purge.
     * @param cutoff   Millisecond epoch timestamp; rows with createdAt < cutoff are deleted.
     */
    async purgeOlderThan(binding: D1Database, cutoff: number): Promise<void> {
      const pool = poolClient(binding)
      await pool.delete(events).where(lt(events.createdAt, cutoff))
    },
  },

  idempotencyKeys: {
    /**
     * Purge idempotency_keys rows that have passed their expiresAt timestamp.
     *
     * @param binding  D1 binding for the pool DB to purge.
     * @param now      Current time as ms epoch; rows with expiresAt < now are deleted.
     */
    async purgeExpired(binding: D1Database, now: number): Promise<void> {
      const pool = poolClient(binding)
      await pool.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now))
    },
  },

  verification: {
    /**
     * Purge better-auth verification rows that have passed their expiresAt timestamp.
     *
     * @param masterBinding  D1 binding for the master DB.
     * @param now            Current time as ms epoch; rows with expiresAt < now are deleted.
     *
     * verification.expiresAt uses timestamp_ms mode (Date objects), so we compare
     * with `new Date(now)` rather than a raw integer.
     */
    async purgeExpired(masterBinding: D1Database, now: number): Promise<void> {
      // Wrap the binding in a synthetic env so masterClient can resolve it.
      // DB_MODE='single' means masterClient uses env.DB (no split).
      const master = masterClient({ DB: masterBinding } as Env)
      await master.delete(verification).where(lt(verification.expiresAt, new Date(now)))
    },
  },
}
