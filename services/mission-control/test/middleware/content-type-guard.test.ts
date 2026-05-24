/**
 * Tests for the requireJsonOnWrites middleware.
 *
 * Verifies that state-changing routes reject application/x-www-form-urlencoded
 * and multipart/form-data content-types with 415, while:
 *   - application/json passes through (may return 401/400/etc.)
 *   - GET requests are never rejected regardless of content-type
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';

const TEST_ENV = { ...env, MC_ADMIN_TOKEN: 'ct-guard-test-token' } as any;

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);
});

describe('requireJsonOnWrites middleware', () => {
  it('POST /v1/projects with application/x-www-form-urlencoded → 415', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/projects', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'authorization': 'Bearer fake-token',
        },
        body: 'name=test&slug=test',
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(415);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_media_type');
  });

  it('POST /v1/projects with multipart/form-data → 415', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/projects', {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
          'authorization': 'Bearer fake-token',
        },
        body: '------WebKitFormBoundary\r\nContent-Disposition: form-data; name="name"\r\n\r\ntest\r\n------WebKitFormBoundary--',
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(415);
  });

  it('POST /v1/projects with application/json → not 415 (may be 401/400)', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/projects', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer fake-token',
        },
        body: JSON.stringify({ name: 'test', slug: 'test' }),
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    // Must not be 415; will be 401 (invalid token) or similar.
    expect(res.status).not.toBe(415);
  });

  it('GET /v1/projects with any content-type → not 415', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/projects', {
        method: 'GET',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'authorization': 'Bearer fake-token',
        },
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    // GET is not state-changing; content-type should not trigger 415.
    expect(res.status).not.toBe(415);
  });

  it('PATCH /v1/agents/:id with form-urlencoded → 415', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/agents/agt_fake', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'authorization': 'Bearer fake-token',
        },
        body: 'name=hacked',
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(415);
  });

  it('DELETE /v1/projects/:id with no content-type → not 415', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/projects/prj_fake', {
        method: 'DELETE',
        headers: {
          'authorization': 'Bearer fake-token',
        },
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    // DELETE with no body should not be rejected by the guard.
    expect(res.status).not.toBe(415);
  });
});
