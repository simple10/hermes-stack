/**
 * Integration tests for POST /v1/bootstrap.
 *
 * Each test runs against the same in-worker D1 instance (per-file isolation
 * from vitest-pool-workers).  Migrations are applied once in beforeAll.
 * Tests that require a clean state truncate the user table before running.
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);
});

/** Helper: clear all auth tables so bootstrap can run again. */
async function clearUsers() {
  // Delete in FK order (session → user).
  await (env.DB as D1Database).prepare('DELETE FROM apiKey').run();
  await (env.DB as D1Database).prepare('DELETE FROM member').run();
  await (env.DB as D1Database).prepare('DELETE FROM organization').run();
  await (env.DB as D1Database).prepare('DELETE FROM session').run();
  await (env.DB as D1Database).prepare('DELETE FROM account').run();
  await (env.DB as D1Database).prepare('DELETE FROM verification').run();
  await (env.DB as D1Database).prepare('DELETE FROM user').run();
}

/** Build a fetch call against the Hono app. */
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { ...env } as any,
    { passThroughOnException: () => {} } as any,
  );
}

const VALID_BODY = {
  email: 'admin@example.com',
  password: 'supersecret',
  name: 'Admin User',
  orgName: 'Acme Corp',
  orgSlug: 'acme',
};

describe('POST /v1/bootstrap', () => {
  it('returns 403 when MC_ADMIN_TOKEN is not configured', async () => {
    await clearUsers();
    const res = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'anything' },
        body: JSON.stringify(VALID_BODY),
      }),
      // Omit MC_ADMIN_TOKEN from env to simulate it being unset.
      { ...env, MC_ADMIN_TOKEN: undefined } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('bootstrap.disabled');
  });

  it('returns 403 when x-mc-admin-token header is wrong', async () => {
    await clearUsers();
    const res = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'wrong-token' },
        body: JSON.stringify(VALID_BODY),
      }),
      { ...env, MC_ADMIN_TOKEN: 'correct-token' } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('bootstrap.unauthorized');
  });

  it('returns 400 when body fields are missing', async () => {
    await clearUsers();
    const res = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'test-tok' },
        body: JSON.stringify({ email: 'missing@other.com' }),
      }),
      { ...env, MC_ADMIN_TOKEN: 'test-tok' } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('bootstrap.validation_error');
  });

  it('returns 400 when password is too short', async () => {
    await clearUsers();
    const res = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'test-tok' },
        body: JSON.stringify({ ...VALID_BODY, password: 'short' }),
      }),
      { ...env, MC_ADMIN_TOKEN: 'test-tok' } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('bootstrap.validation_error');
  });

  it('returns 400 when orgSlug contains invalid characters', async () => {
    await clearUsers();
    const res = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'test-tok' },
        body: JSON.stringify({ ...VALID_BODY, orgSlug: 'Invalid Slug!' }),
      }),
      { ...env, MC_ADMIN_TOKEN: 'test-tok' } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('bootstrap.validation_error');
  });

  it('returns 201 with user, organization, and PAT on valid bootstrap', async () => {
    await clearUsers();
    const res = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'test-tok' },
        body: JSON.stringify(VALID_BODY),
      }),
      { ...env, MC_ADMIN_TOKEN: 'test-tok' } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as {
      user: { id: string; email: string };
      organization: { id: string; name: string; slug: string };
      pat: string;
    };
    expect(body.user.email).toBe(VALID_BODY.email);
    expect(body.organization.slug).toBe(VALID_BODY.orgSlug);
    expect(typeof body.pat).toBe('string');
    expect(body.pat.startsWith('mcpat_')).toBe(true);
  });

  it('marks the bootstrap user as emailVerified=true so sign-in works', async () => {
    // requireEmailVerification: true in better-auth would block sign-in for
    // the bootstrap user unless we pre-verify them. The bootstrap handler
    // does an UPDATE user SET emailVerified=true after creating the user.
    await clearUsers();
    const res = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'test-tok' },
        body: JSON.stringify(VALID_BODY),
      }),
      { ...env, MC_ADMIN_TOKEN: 'test-tok' } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(201);
    // Read the user row directly. DB column is snake_case (`email_verified`)
    // per the Drizzle schema; SQLite stores booleans as 0/1.
    const row = await (env.DB as D1Database)
      .prepare('SELECT email_verified FROM user WHERE email = ?')
      .bind(VALID_BODY.email)
      .first<{ email_verified: number | boolean }>();
    expect(row).not.toBeNull();
    expect(row?.email_verified === 1 || row?.email_verified === true).toBe(true);
  });

  it('returns 409 when a user already exists (second bootstrap attempt)', async () => {
    // Ensure there is a user in the DB by running a successful bootstrap first.
    await clearUsers();
    const firstRes = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'test-tok' },
        body: JSON.stringify(VALID_BODY),
      }),
      { ...env, MC_ADMIN_TOKEN: 'test-tok' } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(firstRes.status).toBe(201);

    // Now try a second bootstrap — must be rejected.
    const res = await app.fetch(
      new Request('http://x/v1/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mc-admin-token': 'test-tok' },
        body: JSON.stringify({ ...VALID_BODY, email: 'second@example.com', orgSlug: 'second' }),
      }),
      { ...env, MC_ADMIN_TOKEN: 'test-tok' } as any,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('bootstrap.already_done');
  });
});
