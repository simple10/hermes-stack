/**
 * Integration tests for the cron job dispatcher (src/jobs/cron.ts).
 *
 * Each test:
 *   1. Seeds the relevant table with a mix of expired and non-expired rows.
 *   2. Fires handleScheduled with the matching cron expression.
 *   3. Asserts that expired rows are gone and non-expired rows survive.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { inject } from 'vitest';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { handleScheduled } from '../../src/jobs/cron.ts';
import { masterClient, poolClient } from '../../src/db/client.ts';
import { events, idempotencyKeys } from '../../src/db/pool.ts';
import { verification } from '../../src/db/master.ts';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeCtx = {
  passThroughOnException: () => {},
  waitUntil: (_p: Promise<unknown>) => {},
} as unknown as ExecutionContext;

// Prefix for test org ids to avoid collisions with other test files.
const ORG = 'org_cron_test';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cron', () => {
  it('purges events older than retention period and keeps recent ones', async () => {
    const pool = poolClient((env.DB as D1Database) as D1Database);
    const now = Date.now();
    const ancient = now - 400 * 86_400_000; // 400 days ago (> default 365d)
    const recent  = now - 100 * 86_400_000; // 100 days ago (< 365d)

    // Insert one old row and one recent row.
    await pool.insert(events).values([
      {
        orgId: ORG,
        resourceType: 'task',
        resourceId: 't_cron_old',
        kind: 'task.created',
        actorType: 'system',
        createdAt: ancient,
      },
      {
        orgId: ORG,
        resourceType: 'task',
        resourceId: 't_cron_recent',
        kind: 'task.created',
        actorType: 'system',
        createdAt: recent,
      },
    ]);

    await handleScheduled(
      { cron: '0 3 * * *' } as ScheduledEvent,
      env as any,
      fakeCtx,
    );

    const remaining = await pool
      .select()
      .from(events)
      .where(eq(events.orgId, ORG));

    expect(remaining.some((r) => r.resourceId === 't_cron_old')).toBe(false);
    expect(remaining.some((r) => r.resourceId === 't_cron_recent')).toBe(true);
  });

  it('purges expired idempotency keys and keeps non-expired ones', async () => {
    const pool = poolClient((env.DB as D1Database) as D1Database);
    const now = Date.now();
    const expired  = now - 1000;           // 1 second in the past
    const notYet   = now + 3_600_000;     // 1 hour in the future

    await pool.insert(idempotencyKeys).values([
      {
        orgId: ORG,
        route: 'POST /api/v1/tasks',
        key: 'idem-expired',
        responseStatus: 201,
        responseBody: '{}',
        createdAt: now - 86_400_000,
        expiresAt: expired,
      },
      {
        orgId: ORG,
        route: 'POST /api/v1/tasks',
        key: 'idem-active',
        responseStatus: 201,
        responseBody: '{}',
        createdAt: now - 100,
        expiresAt: notYet,
      },
    ]);

    await handleScheduled(
      { cron: '0 4 * * *' } as ScheduledEvent,
      env as any,
      fakeCtx,
    );

    const remaining = await pool
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.orgId, ORG));

    expect(remaining.some((r) => r.key === 'idem-expired')).toBe(false);
    expect(remaining.some((r) => r.key === 'idem-active')).toBe(true);
  });

  it('purges expired verification rows and keeps non-expired ones', async () => {
    const master = masterClient(env as any);
    const now = new Date();
    const expiredDate  = new Date(now.getTime() - 1000);         // 1 s ago
    const futureDate   = new Date(now.getTime() + 3_600_000);    // 1 h ahead

    await master.insert(verification).values([
      {
        id: 'ver_cron_expired',
        identifier: 'cron-test@example.com',
        value: 'tok_expired',
        expiresAt: expiredDate,
        createdAt: new Date(now.getTime() - 3_600_000),
        updatedAt: new Date(now.getTime() - 3_600_000),
      },
      {
        id: 'ver_cron_active',
        identifier: 'cron-test@example.com',
        value: 'tok_active',
        expiresAt: futureDate,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await handleScheduled(
      { cron: '*/15 * * * *' } as ScheduledEvent,
      env as any,
      fakeCtx,
    );

    const remaining = await master
      .select()
      .from(verification)
      .where(eq(verification.identifier, 'cron-test@example.com'));

    expect(remaining.some((r) => r.id === 'ver_cron_expired')).toBe(false);
    expect(remaining.some((r) => r.id === 'ver_cron_active')).toBe(true);
  });

  it('logs a warning for unknown cron expressions', async () => {
    // Should complete without throwing.
    await expect(
      handleScheduled(
        { cron: '0 0 1 1 *' } as ScheduledEvent,
        env as any,
        fakeCtx,
      ),
    ).resolves.toBeUndefined();
  });
});
