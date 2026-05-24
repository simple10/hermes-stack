/**
 * Cron job dispatcher for Mission Control.
 *
 * Registered as the `scheduled` export of the Workers Module Worker.
 * Each cron expression maps to one maintenance task.
 *
 * v1 single-pool: runs against the one pool binding (POOL_DEFAULT in split mode,
 * DB in single mode).  Multi-pool iteration deferred to v1.1.
 */
import { masterClient, poolClient } from '../db/client.ts';
import { events, idempotencyKeys } from '../db/pool.ts';
import { verification } from '../db/master.ts';
import { lt } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Env shape (mirrors src/index.ts Env + DB client Env)
// ---------------------------------------------------------------------------

type CronEnv = {
  DB?: D1Database;
  MASTER_DB?: D1Database;
  POOL_DEFAULT?: D1Database;
  DB_MODE?: string;
  EVENTS_RETENTION_DAYS?: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * handleScheduled — Workers Module `scheduled` export.
 *
 * Cron schedule (wrangler.toml):
 *   0 3 * * *     — purge events older than EVENTS_RETENTION_DAYS (default 365)
 *   0 4 * * *     — purge expired idempotency_keys rows
 *   every 15 min  — purge expired better-auth verification rows
 */
export async function handleScheduled(
  event: ScheduledEvent,
  env: CronEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const now = Date.now();

  // v1 single-pool: resolve pool binding.
  // In split mode we use POOL_DEFAULT; in single mode we use DB.
  // Multi-pool iteration (iterating POOL_* env keys per tenant) deferred to v1.1.
  const poolBinding =
    env.DB_MODE === 'split' ? env.POOL_DEFAULT : env.DB;

  if (event.cron === '0 3 * * *') {
    // ------------------------------------------------------------
    // Events purge: delete rows older than EVENTS_RETENTION_DAYS.
    // ------------------------------------------------------------
    if (!poolBinding) {
      console.error('[cron] events purge: pool DB binding not found');
      return;
    }
    const retentionDays = Number(env.EVENTS_RETENTION_DAYS ?? 365);
    const cutoff = now - retentionDays * 86_400_000;
    const pool = poolClient(poolBinding as D1Database);
    await pool.delete(events).where(lt(events.createdAt, cutoff));
    console.log(`[cron] events purged older than ${retentionDays}d`);

  } else if (event.cron === '0 4 * * *') {
    // ------------------------------------------------------------
    // Idempotency keys purge: delete rows past expiresAt.
    // ------------------------------------------------------------
    if (!poolBinding) {
      console.error('[cron] idempotency purge: pool DB binding not found');
      return;
    }
    const pool = poolClient(poolBinding as D1Database);
    await pool.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now));
    console.log('[cron] idempotency keys purged');

  } else if (event.cron === '*/15 * * * *') {
    // ------------------------------------------------------------
    // Verification rows purge: delete better-auth rows past expiresAt.
    // expiresAt is a timestamp_ms Date column in the master schema.
    // ------------------------------------------------------------
    const master = masterClient(env as Parameters<typeof masterClient>[0]);
    await master.delete(verification).where(lt(verification.expiresAt, new Date(now)));
    console.log('[cron] verification rows purged');

  } else {
    console.warn(`[cron] unknown cron pattern: ${event.cron}`);
  }
}
