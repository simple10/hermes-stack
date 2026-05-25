/**
 * Integration tests for GET /api/v1/me.
 *
 * Flow: bootstrap a user → retrieve PAT → call GET /api/v1/me with the PAT →
 * assert response shape.
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';

const ADMIN_TOKEN = 'me-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;
const BOOTSTRAP_BODY = {
  email: 'me-user@example.com',
  password: 'supersecret',
  name: 'Me User',
  orgName: 'Me Org',
  orgSlug: 'me-org',
};

let pat = '';
let orgId = '';
let userId = '';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);

  // Bootstrap to get a PAT.
  const res = await app.fetch(
    new Request('http://x/api/v1/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mc-admin-token': ADMIN_TOKEN,
      },
      body: JSON.stringify(BOOTSTRAP_BODY),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );

  if (res.status !== 201) {
    const body = await res.text();
    throw new Error(`Bootstrap failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    user: { id: string; email: string };
    organization: { id: string; name: string; slug: string };
    pat: string;
  };
  pat = data.pat;
  orgId = data.organization.id;
  userId = data.user.id;
});

describe('GET /api/v1/me', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const res = await app.fetch(
      new Request('http://x/api/v1/me'),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.missing');
  });

  it('returns 401 when bearer token is invalid', async () => {
    const res = await app.fetch(
      new Request('http://x/api/v1/me', {
        headers: { Authorization: 'Bearer mcpat_invalid_token_xyz' },
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.invalid_token');
  });

  it('returns 200 with the correct identity for a PAT-authenticated user', async () => {
    const res = await app.fetch(
      new Request('http://x/api/v1/me', {
        headers: { Authorization: `Bearer ${pat}` },
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      org_id: string;
      role: string;
      principal_type: string;
      principal_id: string;
    };
    expect(body.org_id).toBe(orgId);
    expect(body.principal_type).toBe('user');
    expect(body.principal_id).toBe(userId);
    // PAT holders get their org membership role (owner for bootstrap user).
    expect(['owner', 'admin', 'member']).toContain(body.role);
  });
});
