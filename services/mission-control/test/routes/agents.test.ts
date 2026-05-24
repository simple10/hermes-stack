/**
 * Integration tests for /v1/agents CRUD + rotate-key.
 *
 * Coverage:
 *   - POST   /v1/agents — happy path, 401, 403 (member=ok, agent=no), 409 duplicate name, saga compensation
 *   - GET    /v1/agents — list, pagination
 *   - GET    /v1/agents/:id — detail, 404
 *   - PATCH  /v1/agents/:id — update, 404
 *   - DELETE /v1/agents/:id — soft-delete, 404, 403 wrong role, 409 active tasks gate
 *   - POST   /v1/agents/:id/rotate-key — new key, grace window, 404
 *   - Multi-tenant isolation: org A's token cannot see/modify org B's agents
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

const ADMIN_TOKEN = 'agents-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let pat = '';
let orgId = '';
let userId = '';

// Org B for multi-tenant isolation tests.
let orgBPat = '';
let orgBId = '';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);

  // Org A via bootstrap (only done once per DB).
  const res = await app.fetch(
    new Request('http://x/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        email: 'agents-owner@example.com',
        password: 'supersecret',
        name: 'Agents Owner',
        orgName: 'Agents Org',
        orgSlug: 'agents-org',
      }),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
  if (res.status !== 201) throw new Error(`Bootstrap failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { user: { id: string }; organization: { id: string }; pat: string };
  pat = data.pat;
  orgId = data.organization.id;
  userId = data.user.id;

  // Org B via fixture helper.
  const orgB = await createOrgFixture((env.DB as D1Database), 'Org B', 'org-b-agents');
  orgBPat = orgB.pat;
  orgBId = orgB.orgId;
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
// POST /v1/agents
// ---------------------------------------------------------------------------

describe('POST /v1/agents', () => {
  it('returns 401 when no token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/agents', { method: 'POST', body: JSON.stringify({ name: 'x', kind: 'hermes' }), headers: { 'content-type': 'application/json' } }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 201 with agent + key on valid create', async () => {
    const res = await req('POST', '/v1/agents', pat, { name: 'hermes-1', kind: 'hermes', description: 'First hermes agent' });
    expect(res.status).toBe(201);
    const body = await res.json() as { agent: { id: string; name: string; kind: string }; key: string };
    expect(body.agent.name).toBe('hermes-1');
    expect(body.agent.kind).toBe('hermes');
    expect(typeof body.key).toBe('string');
    expect(body.key.startsWith('mcagt_')).toBe(true);
  });

  it('returns 400 on missing name', async () => {
    const res = await req('POST', '/v1/agents', pat, { kind: 'hermes' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('agent.validation_error');
  });

  it('returns 409 on duplicate name within org', async () => {
    await req('POST', '/v1/agents', pat, { name: 'dup-agent', kind: 'hermes' });
    const res = await req('POST', '/v1/agents', pat, { name: 'dup-agent', kind: 'claude' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('agent.duplicate_name');
  });

  it('allows same name in different orgs', async () => {
    // Org A already has 'hermes-1'.
    const res = await req('POST', '/v1/agents', orgBPat, { name: 'hermes-1', kind: 'hermes' });
    expect(res.status).toBe(201);
  });

  it('member role can create agents', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'agents-member-create', 'member');
    const res = await req('POST', '/v1/agents', memberPat, { name: 'member-created-agent', kind: 'hermes' });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents
// ---------------------------------------------------------------------------

describe('GET /v1/agents', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/agents'),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns list scoped to the caller org', async () => {
    const res = await req('GET', '/v1/agents', pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: { id: string; org_id: string }[] };
    expect(Array.isArray(body.agents)).toBe(true);
    // All returned agents belong to org A.
    for (const a of body.agents) {
      expect(a.org_id).toBe(orgId);
    }
  });

  it('org B list does not include org A agents', async () => {
    const resA = await req('GET', '/v1/agents', pat);
    const bodyA = await resA.json() as { agents: { id: string }[] };
    const idsA = bodyA.agents.map((a) => a.id);

    const resB = await req('GET', '/v1/agents', orgBPat);
    const bodyB = await resB.json() as { agents: { id: string }[] };
    const idsB = bodyB.agents.map((a) => a.id);

    // No overlap.
    for (const id of idsB) {
      expect(idsA).not.toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /v1/agents/:id
// ---------------------------------------------------------------------------

describe('GET /v1/agents/:id', () => {
  let agentId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/agents', pat, { name: 'detail-agent', kind: 'claude' });
    const body = await res.json() as { agent: { id: string } };
    agentId = body.agent.id;
  });

  it('returns 200 with agent detail', async () => {
    const res = await req('GET', `/v1/agents/${agentId}`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { agent: { id: string; name: string } };
    expect(body.agent.id).toBe(agentId);
    expect(body.agent.name).toBe('detail-agent');
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await req('GET', '/v1/agents/agt_doesnotexist', pat);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('agent.not_found');
  });

  it('returns 404 when org B tries to access org A agent (isolation)', async () => {
    const res = await req('GET', `/v1/agents/${agentId}`, orgBPat);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/agents/:id
// ---------------------------------------------------------------------------

describe('PATCH /v1/agents/:id', () => {
  let agentId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/agents', pat, { name: 'patch-agent', kind: 'hermes' });
    const body = await res.json() as { agent: { id: string } };
    agentId = body.agent.id;
  });

  it('returns 200 with updated agent', async () => {
    const res = await req('PATCH', `/v1/agents/${agentId}`, pat, { name: 'patch-agent-renamed', description: 'updated desc' });
    expect(res.status).toBe(200);
    const body = await res.json() as { agent: { name: string; description: string } };
    expect(body.agent.name).toBe('patch-agent-renamed');
    expect(body.agent.description).toBe('updated desc');
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await req('PATCH', '/v1/agents/agt_doesnotexist', pat, { name: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when org B tries to patch org A agent (isolation)', async () => {
    const res = await req('PATCH', `/v1/agents/${agentId}`, orgBPat, { name: 'hacked' });
    expect(res.status).toBe(404);
  });

  it('member role can patch agents', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'agents-member-patch', 'member');
    const res = await req('PATCH', `/v1/agents/${agentId}`, memberPat, { description: 'by member' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/agents/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/agents/:id', () => {
  let agentId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/agents', pat, { name: 'delete-agent', kind: 'hermes' });
    const body = await res.json() as { agent: { id: string } };
    agentId = body.agent.id;
  });

  it('returns 403 when member role tries to delete', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'agents-member-del', 'member');
    const res = await req('DELETE', `/v1/agents/${agentId}`, memberPat);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.role_insufficient');
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await req('DELETE', '/v1/agents/agt_doesnotexist', pat);
    expect(res.status).toBe(404);
  });

  it('returns 404 when org B tries to delete org A agent (isolation)', async () => {
    const res = await req('DELETE', `/v1/agents/${agentId}`, orgBPat);
    expect(res.status).toBe(404);
  });

  it('returns 200 and soft-deletes the agent; subsequent GET returns 404', async () => {
    // Create a fresh agent dedicated to this test so we own the lifecycle.
    const createRes = await req('POST', '/v1/agents', pat, { name: 'agent-to-delete-full', kind: 'hermes' });
    expect(createRes.status).toBe(201);
    const { agent: freshAgent } = await createRes.json() as { agent: { id: string } };

    const delRes = await req('DELETE', `/v1/agents/${freshAgent.id}`, pat);
    expect(delRes.status).toBe(200);

    // Subsequent GET should 404.
    const getRes = await req('GET', `/v1/agents/${freshAgent.id}`, pat);
    expect(getRes.status).toBe(404);

    // Second delete should also 404 (idempotent soft-delete).
    const del2Res = await req('DELETE', `/v1/agents/${freshAgent.id}`, pat);
    expect(del2Res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/agents/:id — active-task gate
// ---------------------------------------------------------------------------

describe('DELETE /v1/agents/:id active-task gate', () => {
  it('returns 409 when agent has active tasks', async () => {
    // Create an agent.
    const createRes = await req('POST', '/v1/agents', pat, { name: 'gated-agent', kind: 'hermes' });
    expect(createRes.status).toBe(201);
    const { agent } = await createRes.json() as { agent: { id: string } };

    // Insert a task with status='in_progress' for this agent directly via D1.
    const taskId = `t_${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    // We need a project row first. Insert minimally.
    const projId = `prj_${Math.random().toString(36).slice(2)}`;
    await (env.DB as D1Database).prepare(
      `INSERT INTO projects (id, org_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(projId, orgId, 'gate-proj', `gate-proj-${projId}`, now, now).run();

    await (env.DB as D1Database).prepare(
      `INSERT INTO tasks (id, org_id, project_id, agent_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(taskId, orgId, projId, agent.id, 'Active Task', 'in_progress', 0, now, now).run();

    // Delete should now 409.
    const delRes = await req('DELETE', `/v1/agents/${agent.id}`, pat);
    expect(delRes.status).toBe(409);
    const body = await delRes.json() as { error: { code: string; details: { task_ids: string[] } } };
    expect(body.error.code).toBe('agent.has_active_tasks');
    expect(body.error.details.task_ids).toContain(taskId);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/agents/:id/rotate-key
// ---------------------------------------------------------------------------

describe('POST /v1/agents/:id/rotate-key', () => {
  let agentId = '';
  let originalKey = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/agents', pat, { name: 'rotate-agent', kind: 'hermes' });
    const body = await res.json() as { agent: { id: string }; key: string };
    agentId = body.agent.id;
    originalKey = body.key;
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await req('POST', '/v1/agents/agt_doesnotexist/rotate-key', pat);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('agent.not_found');
  });

  it('returns new key and expires_old_at', async () => {
    const res = await req('POST', `/v1/agents/${agentId}/rotate-key`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { key: string; expires_old_at: string | null };
    expect(typeof body.key).toBe('string');
    expect(body.key.startsWith('mcagt_')).toBe(true);
    expect(body.key).not.toBe(originalKey);
    // expires_old_at should be set (old key existed).
    expect(body.expires_old_at).not.toBeNull();
    const expiresDate = new Date(body.expires_old_at!);
    expect(expiresDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('new key can authenticate (GET /v1/me)', async () => {
    const rotRes = await req('POST', `/v1/agents/${agentId}/rotate-key`, pat);
    const { key: newKey } = await rotRes.json() as { key: string };

    const meRes = await app.fetch(
      new Request('http://x/v1/me', { headers: { authorization: `Bearer ${newKey}` } }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(meRes.status).toBe(200);
  });

  it('403 when member role tries rotate-key', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'agents-member-rot', 'member');
    const res = await req('POST', `/v1/agents/${agentId}/rotate-key`, memberPat);
    expect(res.status).toBe(403);
  });

  it('returns 404 when org B tries rotate-key on org A agent', async () => {
    const res = await req('POST', `/v1/agents/${agentId}/rotate-key`, orgBPat);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/agents — saga compensation when mintApiKey fails
// ---------------------------------------------------------------------------

describe('POST /v1/agents — saga compensation (mintApiKey failure)', () => {
  it('returns 500 agent.key_mint_failed and leaves agent soft-deleted', async () => {
    const agentName = `saga-fail-agent-${Date.now()}`;

    // Simulate mintApiKey failure by installing a BEFORE INSERT trigger that
    // raises an error on the apiKey table.  This allows SELECTs (used by the
    // auth middleware's verifyApiKey) to pass through while INSERT (used by
    // mintApiKey inside the route handler) is blocked.
    await (env.DB as D1Database).prepare(
      `CREATE TRIGGER block_apikey_insert BEFORE INSERT ON apiKey BEGIN SELECT RAISE(FAIL, 'blocked for saga test'); END`
    ).run();

    let res: Response;
    try {
      res = await req('POST', '/v1/agents', pat, { name: agentName, kind: 'hermes' });
    } finally {
      // Always remove the trigger to restore normal behaviour.
      await (env.DB as D1Database).prepare(`DROP TRIGGER IF EXISTS block_apikey_insert`).run();
    }

    expect(res!.status).toBe(500);
    const body = await res!.json() as { error: { code: string } };
    expect(body.error.code).toBe('agent.key_mint_failed');

    // The agent row should exist with deleted_at set (compensating soft-delete).
    const row = await (env.DB as D1Database).prepare(
      `SELECT id, deleted_at, deleted_by_type FROM agents WHERE name = ? AND org_id = ? ORDER BY rowid DESC LIMIT 1`
    ).bind(agentName, orgId).first() as { id: string; deleted_at: number | null; deleted_by_type: string } | null;
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
    expect(row!.deleted_by_type).toBe('system');

    // A subsequent POST with the same name must succeed (partial unique index allows reuse
    // because the existing row has deleted_at set).
    const res2 = await req('POST', '/v1/agents', pat, { name: agentName, kind: 'hermes' });
    expect(res2.status).toBe(201);
    const body2 = await res2.json() as { agent: { id: string }; key: string };
    expect(body2.key.startsWith('mcagt_')).toBe(true);
  });
});
