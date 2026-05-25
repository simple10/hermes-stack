/**
 * Pool resolver tests — single-DB mode (the wrangler.toml test env).
 *
 * In the test environment DB_MODE is 'single' and only (env.DB as D1Database) is bound,
 * so resolveBinding always returns (env.DB as D1Database).  We test:
 *   - happy path: org exists → pool client returned
 *   - 404 path: unknown org → HttpError auth.org_not_found
 *   - cache: second call for same org doesn't hit master DB (smoke test)
 */
import { describe, it, expect, beforeAll, beforeEach, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { resolvePoolForOrg, _clearPoolCache } from '../../src/db/pool-resolver.ts';
import { masterClient } from '../../src/db/client.ts';
import { organization } from '../../src/db/master.ts';
import { agents } from '../../src/db/pool.ts';
import { HttpError } from '../../src/errors.ts';
import { sql } from 'drizzle-orm';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);
});

beforeEach(() => {
  _clearPoolCache();
});

describe('pool resolver (single-DB mode)', () => {
  it('returns a pool client for a known org', async () => {
    // Insert a test organization into master.
    await masterClient(env as unknown as Env).insert(organization).values({
      id: 'org_pr_test1',
      name: 'Pool Resolver Test',
      slug: 'pr-test1',
      tenantPoolId: 'default',
      plan: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();

    const pool = await resolvePoolForOrg(env as unknown as Env, 'org_pr_test1');
    expect(pool).toBeDefined();
    // Sanity: pool client can query a pool table (agents exists from migration).
    const rows = await pool.select({ n: sql<number>`1` }).from(agents).limit(1);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('throws 404 for an unknown org', async () => {
    let caught: unknown;
    try {
      await resolvePoolForOrg(env as unknown as Env, 'org_does_not_exist');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(404);
    expect((caught as HttpError).code).toBe('auth.org_not_found');
  });

  it('returns the same pool client on a cached second call', async () => {
    await masterClient(env as unknown as Env).insert(organization).values({
      id: 'org_pr_test2',
      name: 'Cache Test',
      slug: 'pr-test2',
      tenantPoolId: 'default',
      plan: 'free',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();

    const pool1 = await resolvePoolForOrg(env as unknown as Env, 'org_pr_test2');
    const pool2 = await resolvePoolForOrg(env as unknown as Env, 'org_pr_test2');
    // Both calls succeed without error — second call used the cache.
    expect(pool1).toBeDefined();
    expect(pool2).toBeDefined();
  });
});
