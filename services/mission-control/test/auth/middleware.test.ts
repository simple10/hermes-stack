/**
 * Auth middleware stub tests.
 *
 * Full coverage of the happy paths (session + bearer token) comes via route
 * integration tests in later bundles once agents/connectors/orgs can be
 * created end-to-end.  This file covers the fast-fail cases that need no DB
 * state.
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { Hono } from 'hono';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';
import { authMiddleware } from '../../src/auth/middleware.ts';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations(env.DB, migrations);
});

function makeApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.get('/x', (c) => c.text('ok'));
  return app;
}

describe('auth middleware', () => {
  it('401s when Authorization header is missing', async () => {
    const app = makeApp();
    const res = await app.fetch(new Request('http://x/x'), env);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.missing');
  });

  it('401s when bearer token is invalid', async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request('http://x/x', {
        headers: { Authorization: 'Bearer totally_invalid_token_xyz' },
      }),
      env,
    );
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.invalid_token');
  });
});
