/**
 * Integration tests for /v1/connectors CRUD + rotate-key.
 *
 * Mirrors agents.test.ts with connector-specific differences:
 *   - POST/PATCH/DELETE require owner|admin (no member)
 *   - Active gate on DELETE: external_refs (not tasks)
 *   - Token prefix: 'mccnn_'
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';
import { createOrgFixture, createMemberFixture } from '../helpers/orgs.ts';

// ---------------------------------------------------------------------------
// Test env + shared state
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'connectors-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let pat = '';
let orgId = '';

// Org B for isolation tests.
let orgBPat = '';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);

  // Org A via bootstrap.
  const res = await app.fetch(
    new Request('http://x/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        email: 'connectors-owner@example.com',
        password: 'supersecret',
        name: 'Connectors Owner',
        orgName: 'Connectors Org',
        orgSlug: 'connectors-org',
      }),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
  if (res.status !== 201) throw new Error(`Bootstrap failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { user: { id: string }; organization: { id: string }; pat: string };
  pat = data.pat;
  orgId = data.organization.id;

  const orgB = await createOrgFixture((env.DB as D1Database), 'Org B Connectors', 'org-b-connectors');
  orgBPat = orgB.pat;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function req(method: string, path: string, token: string, body?: unknown) {
  return app.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
}

// ---------------------------------------------------------------------------
// POST /v1/connectors
// ---------------------------------------------------------------------------

describe('POST /v1/connectors', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/connectors', { method: 'POST', body: JSON.stringify({ name: 'x', kind: 'notion' }), headers: { 'content-type': 'application/json' } }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for member role (connectors require owner|admin)', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'cnn-member-create', 'member');
    const res = await req('POST', '/v1/connectors', memberPat, { name: 'notion-1', kind: 'notion' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.role_insufficient');
  });

  it('returns 201 with connector + key on valid create (owner)', async () => {
    const res = await req('POST', '/v1/connectors', pat, { name: 'notion-1', kind: 'notion', description: 'Notion connector' });
    expect(res.status).toBe(201);
    const body = await res.json() as { connector: { id: string; name: string; kind: string }; key: string };
    expect(body.connector.name).toBe('notion-1');
    expect(body.connector.kind).toBe('notion');
    expect(typeof body.key).toBe('string');
    expect(body.key.startsWith('mccnn_')).toBe(true);
  });

  it('returns 201 with admin role', async () => {
    const { pat: adminPat } = await createMemberFixture((env.DB as D1Database), orgId, 'cnn-admin-create', 'admin');
    const res = await req('POST', '/v1/connectors', adminPat, { name: 'linear-admin', kind: 'linear' });
    expect(res.status).toBe(201);
  });

  it('returns 400 on missing name', async () => {
    const res = await req('POST', '/v1/connectors', pat, { kind: 'notion' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('connector.validation_error');
  });

  it('returns 409 on duplicate name within org', async () => {
    await req('POST', '/v1/connectors', pat, { name: 'dup-connector', kind: 'notion' });
    const res = await req('POST', '/v1/connectors', pat, { name: 'dup-connector', kind: 'linear' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('connector.duplicate_name');
  });

  it('allows same name in different orgs', async () => {
    const res = await req('POST', '/v1/connectors', orgBPat, { name: 'notion-1', kind: 'notion' });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/connectors
// ---------------------------------------------------------------------------

describe('GET /v1/connectors', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/connectors'),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns list scoped to caller org', async () => {
    const res = await req('GET', '/v1/connectors', pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { connectors: { id: string; org_id: string }[] };
    expect(Array.isArray(body.connectors)).toBe(true);
    for (const cn of body.connectors) {
      expect(cn.org_id).toBe(orgId);
    }
  });

  it('member can list connectors (GET is open to all roles)', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'cnn-member-list', 'member');
    const res = await req('GET', '/v1/connectors', memberPat);
    expect(res.status).toBe(200);
  });

  it('org B list does not include org A connectors (isolation)', async () => {
    const resA = await req('GET', '/v1/connectors', pat);
    const bodyA = await resA.json() as { connectors: { id: string }[] };
    const idsA = bodyA.connectors.map((c) => c.id);

    const resB = await req('GET', '/v1/connectors', orgBPat);
    const bodyB = await resB.json() as { connectors: { id: string }[] };
    const idsB = bodyB.connectors.map((c) => c.id);

    for (const id of idsB) {
      expect(idsA).not.toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /v1/connectors/:id
// ---------------------------------------------------------------------------

describe('GET /v1/connectors/:id', () => {
  let connectorId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/connectors', pat, { name: 'detail-connector', kind: 'github' });
    const body = await res.json() as { connector: { id: string } };
    connectorId = body.connector.id;
  });

  it('returns 200 with connector detail', async () => {
    const res = await req('GET', `/v1/connectors/${connectorId}`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { connector: { id: string; name: string } };
    expect(body.connector.id).toBe(connectorId);
    expect(body.connector.name).toBe('detail-connector');
  });

  it('returns 404 for non-existent connector', async () => {
    const res = await req('GET', '/v1/connectors/cnn_doesnotexist', pat);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('connector.not_found');
  });

  it('returns 404 when org B tries to access org A connector (isolation)', async () => {
    const res = await req('GET', `/v1/connectors/${connectorId}`, orgBPat);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/connectors/:id
// ---------------------------------------------------------------------------

describe('PATCH /v1/connectors/:id', () => {
  let connectorId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/connectors', pat, { name: 'patch-connector', kind: 'notion' });
    const body = await res.json() as { connector: { id: string } };
    connectorId = body.connector.id;
  });

  it('returns 200 with updated connector (owner)', async () => {
    const res = await req('PATCH', `/v1/connectors/${connectorId}`, pat, { name: 'patch-connector-renamed', description: 'updated' });
    expect(res.status).toBe(200);
    const body = await res.json() as { connector: { name: string; description: string } };
    expect(body.connector.name).toBe('patch-connector-renamed');
    expect(body.connector.description).toBe('updated');
  });

  it('returns 403 when member role tries to patch (connectors require owner|admin)', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'cnn-member-patch', 'member');
    const res = await req('PATCH', `/v1/connectors/${connectorId}`, memberPat, { name: 'hacked' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent connector', async () => {
    const res = await req('PATCH', '/v1/connectors/cnn_doesnotexist', pat, { name: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when org B tries to patch org A connector (isolation)', async () => {
    const res = await req('PATCH', `/v1/connectors/${connectorId}`, orgBPat, { name: 'hacked' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/connectors/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/connectors/:id', () => {
  let connectorId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/connectors', pat, { name: 'delete-connector', kind: 'notion' });
    const body = await res.json() as { connector: { id: string } };
    connectorId = body.connector.id;
  });

  it('returns 403 when member role tries to delete', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'cnn-member-del', 'member');
    const res = await req('DELETE', `/v1/connectors/${connectorId}`, memberPat);
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent connector', async () => {
    const res = await req('DELETE', '/v1/connectors/cnn_doesnotexist', pat);
    expect(res.status).toBe(404);
  });

  it('returns 404 when org B tries to delete org A connector (isolation)', async () => {
    const res = await req('DELETE', `/v1/connectors/${connectorId}`, orgBPat);
    expect(res.status).toBe(404);
  });

  it('returns 200 and soft-deletes the connector; subsequent GET returns 404', async () => {
    // Create a fresh connector dedicated to this test.
    const createRes = await req('POST', '/v1/connectors', pat, { name: 'connector-to-delete-full', kind: 'notion' });
    expect(createRes.status).toBe(201);
    const { connector: freshCn } = await createRes.json() as { connector: { id: string } };

    const delRes = await req('DELETE', `/v1/connectors/${freshCn.id}`, pat);
    expect(delRes.status).toBe(200);

    const getRes = await req('GET', `/v1/connectors/${freshCn.id}`, pat);
    expect(getRes.status).toBe(404);

    // Second delete should also 404.
    const del2Res = await req('DELETE', `/v1/connectors/${freshCn.id}`, pat);
    expect(del2Res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/connectors/:id — active external_refs gate
// ---------------------------------------------------------------------------

describe('DELETE /v1/connectors/:id active external_refs gate', () => {
  it('returns 409 when connector has active external_refs', async () => {
    const createRes = await req('POST', '/v1/connectors', pat, { name: 'gated-connector', kind: 'notion' });
    expect(createRes.status).toBe(201);
    const { connector } = await createRes.json() as { connector: { id: string } };

    // Insert an external_ref that points source_id → connector.id.
    const refId = `xrf_${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    await (env.DB as D1Database).prepare(
      `INSERT INTO external_refs (id, org_id, resource_type, resource_id, source_kind, source_id, external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(refId, orgId, 'connector', connector.id, 'notion', connector.id, 'ext-abc', now, now).run();

    const delRes = await req('DELETE', `/v1/connectors/${connector.id}`, pat);
    expect(delRes.status).toBe(409);
    const body = await delRes.json() as { error: { code: string; details: { ref_ids: string[] } } };
    expect(body.error.code).toBe('connector.has_active_refs');
    expect(body.error.details.ref_ids).toContain(refId);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/connectors/:id/rotate-key
// ---------------------------------------------------------------------------

describe('POST /v1/connectors/:id/rotate-key', () => {
  let connectorId = '';
  let originalKey = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/connectors', pat, { name: 'rotate-connector', kind: 'linear' });
    const body = await res.json() as { connector: { id: string }; key: string };
    connectorId = body.connector.id;
    originalKey = body.key;
  });

  it('returns 404 for non-existent connector', async () => {
    const res = await req('POST', '/v1/connectors/cnn_doesnotexist/rotate-key', pat);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('connector.not_found');
  });

  it('returns new key and expires_old_at', async () => {
    const res = await req('POST', `/v1/connectors/${connectorId}/rotate-key`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { key: string; expires_old_at: string | null };
    expect(typeof body.key).toBe('string');
    expect(body.key.startsWith('mccnn_')).toBe(true);
    expect(body.key).not.toBe(originalKey);
    expect(body.expires_old_at).not.toBeNull();
    const expiresDate = new Date(body.expires_old_at!);
    expect(expiresDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('new key can authenticate (GET /v1/me)', async () => {
    const rotRes = await req('POST', `/v1/connectors/${connectorId}/rotate-key`, pat);
    const { key: newKey } = await rotRes.json() as { key: string };

    const meRes = await app.fetch(
      new Request('http://x/v1/me', { headers: { authorization: `Bearer ${newKey}` } }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json() as { principal_type: string };
    expect(meBody.principal_type).toBe('connector');
  });

  it('403 when member role tries rotate-key', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'cnn-member-rot', 'member');
    const res = await req('POST', `/v1/connectors/${connectorId}/rotate-key`, memberPat);
    expect(res.status).toBe(403);
  });

  it('returns 404 when org B tries rotate-key on org A connector (isolation)', async () => {
    const res = await req('POST', `/v1/connectors/${connectorId}/rotate-key`, orgBPat);
    expect(res.status).toBe(404);
  });
});
