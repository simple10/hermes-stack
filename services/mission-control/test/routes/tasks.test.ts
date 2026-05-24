/**
 * Integration tests for /v1/tasks CRUD + state machine + idempotency.
 *
 * Coverage:
 *   POST   /v1/tasks — happy path, 401/403, validation, initial status rules,
 *                      agent_id on create (status=ready + events), Layer-1 &
 *                      Layer-2 idempotency, event emission, multi-tenant isolation
 *   GET    /v1/tasks — list, filters (project_id, agent_id, status, updated_since),
 *                      cursor pagination, agent-role forced filter, isolation
 *   GET    /v1/tasks/:id — detail (task + comments + events), 404, isolation,
 *                          agent-role own-task restriction
 *   PATCH  /v1/tasks/:id — happy path, state machine transitions, invalid
 *                          transitions (409), side-effects (startedAt, completedAt),
 *                          agent-role restrictions, agent_id change (task.assigned),
 *                          event emission, isolation
 *   DELETE /v1/tasks/:id — soft delete, cascade trigger, event emission, 404,
 *                          isolation, member/agent forbidden
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';
import { createOrgFixture, createMemberFixture } from '../helpers/orgs.ts';

// ---------------------------------------------------------------------------
// Test env + shared state
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'tasks-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let pat = '';          // owner PAT for org A
let orgId = '';
let projectId = '';    // a project in org A

// Org B for isolation tests.
let orgBPat = '';
let orgBProjectId = '';

// Agent key for testing agent-role restrictions.
let agentKey = '';
let agentId = '';

// Member key (no delete permissions).
let memberPat = '';

// Second agent for reassignment tests.
let agentKey2 = '';
let agentId2 = '';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);

  // Bootstrap org A.
  const res = await app.fetch(
    new Request('http://x/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        email: 'tasks-owner@example.com',
        password: 'supersecret',
        name: 'Tasks Owner',
        orgName: 'Tasks Org',
        orgSlug: 'tasks-org',
      }),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
  if (res.status !== 201) throw new Error(`Bootstrap failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { organization: { id: string }; pat: string };
  pat = data.pat;
  orgId = data.organization.id;

  // Create a project in org A.
  const projRes = await req('POST', '/v1/projects', pat, { name: 'Tasks Project', slug: 'tasks-project' });
  if (projRes.status !== 201) throw new Error(`Project create failed (${projRes.status}): ${await projRes.text()}`);
  const projData = await projRes.json() as { project: { id: string } };
  projectId = projData.project.id;

  // Org B via fixture.
  const orgB = await createOrgFixture((env.DB as D1Database), 'Org B Tasks', 'org-b-tasks');
  orgBPat = orgB.pat;

  // Create a project in org B.
  const orgBProjRes = await req('POST', '/v1/projects', orgBPat, { name: 'Org B Project', slug: 'org-b-project' });
  const orgBProjData = await orgBProjRes.json() as { project: { id: string } };
  orgBProjectId = orgBProjData.project.id;

  // Create agent in org A.
  const agentRes = await req('POST', '/v1/agents', pat, { name: 'task-agent', kind: 'hermes' });
  if (agentRes.status !== 201) throw new Error(`Agent create failed (${agentRes.status}): ${await agentRes.text()}`);
  const agentData = await agentRes.json() as { agent: { id: string }; key: string };
  agentKey = agentData.key;
  agentId = agentData.agent.id;

  // Create second agent in org A.
  const agentRes2 = await req('POST', '/v1/agents', pat, { name: 'task-agent-2', kind: 'hermes' });
  if (agentRes2.status !== 201) throw new Error(`Agent2 create failed: ${await agentRes2.text()}`);
  const agentData2 = await agentRes2.json() as { agent: { id: string }; key: string };
  agentKey2 = agentData2.key;
  agentId2 = agentData2.agent.id;

  // Create a member PAT.
  const mf = await createMemberFixture((env.DB as D1Database), orgId, 'task-member', 'member');
  memberPat = mf.pat;
});

// ---------------------------------------------------------------------------
// Request helper
// ---------------------------------------------------------------------------

function req(method: string, path: string, token: string, body?: unknown, extraHeaders?: Record<string, string>) {
  return app.fetch(
    new Request(`http://x${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
}

// ---------------------------------------------------------------------------
// POST /v1/tasks
// ---------------------------------------------------------------------------

describe('POST /v1/tasks', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/tasks', {
        method: 'POST',
        body: JSON.stringify({ project_id: 'x', title: 'x' }),
        headers: { 'content-type': 'application/json' },
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for agent role (agents cannot create tasks)', async () => {
    const res = await req('POST', '/v1/tasks', agentKey, { project_id: projectId, title: 'x' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.role_insufficient');
  });

  it('returns 400 on missing title', async () => {
    const res = await req('POST', '/v1/tasks', pat, { project_id: projectId });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.validation_error');
  });

  it('returns 400 on missing project_id', async () => {
    const res = await req('POST', '/v1/tasks', pat, { title: 'No Project' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.validation_error');
  });

  it('returns 400 on title too long (>500)', async () => {
    const res = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'x'.repeat(501),
    });
    expect(res.status).toBe(400);
  });

  it('returns 422 on non-existent project_id', async () => {
    const res = await req('POST', '/v1/tasks', pat, { project_id: 'prj_doesnotexist', title: 'bad proj' });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.invalid_project');
  });

  it('returns 422 on project_id from different org', async () => {
    // orgBProjectId belongs to org B — should fail for org A user.
    const res = await req('POST', '/v1/tasks', pat, { project_id: orgBProjectId, title: 'wrong org' });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.invalid_project');
  });

  it('returns 422 on non-existent agent_id', async () => {
    const res = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'bad agent',
      agent_id: 'agt_doesnotexist',
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.invalid_agent');
  });

  it('creates task with status=pending when no agent_id provided', async () => {
    const res = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Pending Task',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { task: { id: string; status: string } };
    expect(body.task.status).toBe('pending');
    expect(body.task.id.startsWith('t_')).toBe(true);
  });

  it('creates task with status=ready when agent_id provided', async () => {
    const res = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Ready Task',
      agent_id: agentId,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { task: { status: string; agent_id: string } };
    expect(body.task.status).toBe('ready');
    expect(body.task.agent_id).toBe(agentId);
  });

  it('emits task.created event on create', async () => {
    const res = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Event Task' });
    expect(res.status).toBe(201);
    const { task } = await res.json() as { task: { id: string } };

    const row = await (env.DB as D1Database).prepare(
      `SELECT kind FROM events WHERE org_id = ? AND resource_type = 'task' AND resource_id = ? AND kind = 'task.created' ORDER BY id DESC LIMIT 1`
    ).bind(orgId, task.id).first() as { kind: string } | null;
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('task.created');
  });

  it('emits task.assigned event when agent_id provided at creation', async () => {
    const res = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Assigned Task',
      agent_id: agentId,
    });
    expect(res.status).toBe(201);
    const { task } = await res.json() as { task: { id: string } };

    const row = await (env.DB as D1Database).prepare(
      `SELECT kind FROM events WHERE org_id = ? AND resource_type = 'task' AND resource_id = ? AND kind = 'task.assigned' ORDER BY id DESC LIMIT 1`
    ).bind(orgId, task.id).first() as { kind: string } | null;
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('task.assigned');
  });

  it('persists priority, metadata, body fields', async () => {
    const res = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Full Task',
      body: 'Task description body',
      priority: 75,
      metadata: { foo: 'bar', count: 3 },
    });
    expect(res.status).toBe(201);
    const { task } = await res.json() as { task: Record<string, unknown> };
    expect(task['priority']).toBe(75);
    expect(task['body']).toBe('Task description body');
    expect((task['metadata'] as any).foo).toBe('bar');
  });

  it('createdByUserId is set when using PAT (owner)', async () => {
    const res = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Created By Test' });
    expect(res.status).toBe(201);
    const { task } = await res.json() as { task: { created_by_user_id?: string } };
    expect(typeof task.created_by_user_id).toBe('string');
    expect(task.created_by_user_id!.length).toBeGreaterThan(0);
  });

  it('member role can create tasks', async () => {
    const res = await req('POST', '/v1/tasks', memberPat, { project_id: projectId, title: 'Member Task' });
    expect(res.status).toBe(201);
  });

  // ---------------------------------------------------------------------------
  // Layer-1 idempotency (Idempotency-Key header)
  // ---------------------------------------------------------------------------

  it('Layer-1: returns same 201 response on duplicate request (same key + same body)', async () => {
    const idempotencyKey = `tasks-test-idem-${Date.now()}`;
    const body = { project_id: projectId, title: 'Idempotent Task Layer1' };

    const res1 = await app.fetch(
      new Request('http://x/v1/tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${pat}`,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res1.status).toBe(201);
    const data1 = await res1.json() as { task: { id: string } };

    const res2 = await app.fetch(
      new Request('http://x/v1/tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${pat}`,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res2.status).toBe(201);
    const data2 = await res2.json() as { task: { id: string } };

    // Same task ID — idempotent.
    expect(data2.task.id).toBe(data1.task.id);

    // Only one task row with this title.
    const rows = await (env.DB as D1Database).prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE org_id = ? AND title = 'Idempotent Task Layer1' AND deleted_at IS NULL`
    ).bind(orgId).first() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('Layer-1: returns 409 when same key used with different body', async () => {
    const idempotencyKey = `tasks-test-idem-conflict-${Date.now()}`;

    const res1 = await app.fetch(
      new Request('http://x/v1/tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${pat}`,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ project_id: projectId, title: 'Original title' }),
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res1.status).toBe(201);

    const res2 = await app.fetch(
      new Request('http://x/v1/tasks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${pat}`,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ project_id: projectId, title: 'Different title' }),
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res2.status).toBe(409);
    const body = await res2.json() as { error: { code: string } };
    expect(body.error.code).toBe('idempotency.conflict');
  });

  // ---------------------------------------------------------------------------
  // Layer-2 idempotency (body idempotency_key field)
  // ---------------------------------------------------------------------------

  it('Layer-2: returns 409 when creating second task with same idempotency_key in same org', async () => {
    const ikey = `notion:ws-abc:page-${Date.now()}:v1`;

    const res1 = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'First Semantic Task',
      idempotency_key: ikey,
    });
    expect(res1.status).toBe(201);
    const data1 = await res1.json() as { task: { id: string } };

    const res2 = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Second Semantic Task (conflict)',
      idempotency_key: ikey,
    });
    expect(res2.status).toBe(409);
    const body = await res2.json() as { error: { code: string; details: { existing_task_id: string } } };
    expect(body.error.code).toBe('idempotency.conflict');
    expect(body.error.details.existing_task_id).toBe(data1.task.id);
  });

  it('Layer-2: allows same idempotency_key in different orgs (org isolation)', async () => {
    const ikey = `shared-key-different-orgs-${Date.now()}`;

    const resA = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Org A Task',
      idempotency_key: ikey,
    });
    expect(resA.status).toBe(201);

    const resB = await req('POST', '/v1/tasks', orgBPat, {
      project_id: orgBProjectId,
      title: 'Org B Task',
      idempotency_key: ikey,
    });
    expect(resB.status).toBe(201);
  });

  it('Layer-2: allows reuse of idempotency_key after task is soft-deleted', async () => {
    const ikey = `reusable-after-delete-${Date.now()}`;

    const res1 = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Deletable Task',
      idempotency_key: ikey,
    });
    expect(res1.status).toBe(201);
    const { task } = await res1.json() as { task: { id: string } };

    // Soft-delete.
    await req('DELETE', `/v1/tasks/${task.id}`, pat);

    // Same key should now work again.
    const res2 = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Recycled Task',
      idempotency_key: ikey,
    });
    expect(res2.status).toBe(201);
  });

  it('multi-tenant isolation: org B cannot see org A tasks', async () => {
    const resA = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Org A Only' });
    expect(resA.status).toBe(201);
    const { task } = await resA.json() as { task: { id: string } };

    // Org B GET :id should return 404.
    const resB = await req('GET', `/v1/tasks/${task.id}`, orgBPat);
    expect(resB.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/tasks
// ---------------------------------------------------------------------------

describe('GET /v1/tasks', () => {
  let taskId1 = '';
  let taskId2 = '';

  beforeAll(async () => {
    const r1 = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'List Task 1', priority: 10 });
    taskId1 = ((await r1.json()) as { task: { id: string } }).task.id;

    const r2 = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'List Task 2',
      agent_id: agentId,
      priority: 20,
    });
    taskId2 = ((await r2.json()) as { task: { id: string } }).task.id;
  });

  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/tasks'),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns paginated task list scoped to caller org', async () => {
    const res = await req('GET', '/v1/tasks', pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: { org_id: string }[]; next_cursor: string | null };
    expect(Array.isArray(body.tasks)).toBe(true);
    for (const t of body.tasks) {
      expect(t.org_id).toBe(orgId);
    }
  });

  it('filters by project_id', async () => {
    const res = await req('GET', `/v1/tasks?project_id=${projectId}`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: { project_id: string }[] };
    for (const t of body.tasks) {
      expect(t.project_id).toBe(projectId);
    }
  });

  it('filters by agent_id', async () => {
    const res = await req('GET', `/v1/tasks?agent_id=${agentId}`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: { agent_id: string; id: string }[] };
    const ids = body.tasks.map((t) => t.id);
    expect(ids).toContain(taskId2);
    for (const t of body.tasks) {
      expect(t.agent_id).toBe(agentId);
    }
  });

  it('filters by single status', async () => {
    const res = await req('GET', '/v1/tasks?status=ready', pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: { status: string }[] };
    for (const t of body.tasks) {
      expect(t.status).toBe('ready');
    }
  });

  it('filters by comma-separated status list', async () => {
    const res = await req('GET', '/v1/tasks?status=pending,ready', pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: { status: string }[] };
    for (const t of body.tasks) {
      expect(['pending', 'ready']).toContain(t.status);
    }
  });

  it('filters by updated_since (ISO string)', async () => {
    const since = new Date(Date.now() - 5000).toISOString();
    const res = await req('GET', `/v1/tasks?updated_since=${encodeURIComponent(since)}`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: unknown[] };
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it('filters by updated_since (ms epoch)', async () => {
    const since = Date.now() - 5000;
    const res = await req('GET', `/v1/tasks?updated_since=${since}`, pat);
    expect(res.status).toBe(200);
  });

  it('agent role: forced filter — agent sees only own tasks', async () => {
    // agentKey belongs to agentId; taskId2 is assigned to agentId.
    // Create a task NOT assigned to this agent.
    await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Unassigned Task' });

    const res = await req('GET', '/v1/tasks', agentKey);
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: { agent_id: string }[] };
    // All returned tasks must be assigned to agentId.
    for (const t of body.tasks) {
      expect(t.agent_id).toBe(agentId);
    }
  });

  it('agent_id=me is rejected for non-agent principals (400)', async () => {
    const res = await req('GET', '/v1/tasks?agent_id=me', pat);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.invalid_filter');
  });

  it('org B cannot see org A tasks in list', async () => {
    const resA = await req('GET', '/v1/tasks', pat);
    const bodyA = await resA.json() as { tasks: { id: string }[] };
    const idsA = bodyA.tasks.map((t) => t.id);

    const resB = await req('GET', '/v1/tasks', orgBPat);
    const bodyB = await resB.json() as { tasks: { id: string }[] };
    for (const t of bodyB.tasks) {
      expect(idsA).not.toContain(t.id);
    }
  });

  it('cursor pagination returns all tasks exactly once', async () => {
    // Create isolated org for count-stable pagination test.
    const { pat: freshPat, orgId: freshOrgId } = await createOrgFixture(
      (env.DB as D1Database),
      'Pagination Tasks Org',
      'pagination-tasks-org',
    );
    const projRes = await req('POST', '/v1/projects', freshPat, { name: 'Pag Project', slug: 'pag-proj' });
    const { project: pagProj } = await projRes.json() as { project: { id: string } };

    // Insert 75 tasks directly for speed.
    const now = Date.now();
    const stmts = [];
    for (let i = 0; i < 75; i++) {
      const id = `t_pagtest${i.toString().padStart(4, '0')}`;
      const ts = now + i;
      stmts.push(
        (env.DB as D1Database).prepare(
          `INSERT INTO tasks (id, org_id, project_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`
        ).bind(id, freshOrgId, pagProj.id, `Pag Task ${i}`, ts, ts),
      );
    }
    await (env.DB as D1Database).batch(stmts as any);

    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = cursor
        ? `/v1/tasks?limit=25&cursor=${encodeURIComponent(cursor)}`
        : '/v1/tasks?limit=25';
      const res = await req('GET', url, freshPat);
      expect(res.status).toBe(200);
      const body = await res.json() as { tasks: { id: string }[]; next_cursor: string | null };
      for (const t of body.tasks) {
        expect(seenIds.has(t.id)).toBe(false);
        seenIds.add(t.id);
      }
      cursor = body.next_cursor;
      pages++;
    } while (cursor !== null);

    expect(seenIds.size).toBe(75);
    expect(pages).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/tasks/:id
// ---------------------------------------------------------------------------

describe('GET /v1/tasks/:id', () => {
  let taskId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Detail Task',
      agent_id: agentId,
    });
    taskId = ((await res.json()) as { task: { id: string } }).task.id;
  });

  it('returns 404 for non-existent task', async () => {
    const res = await req('GET', '/v1/tasks/t_doesnotexist', pat);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.not_found');
  });

  it('returns task detail with comments and events arrays', async () => {
    const res = await req('GET', `/v1/tasks/${taskId}`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { id: string }; comments: unknown[]; events: unknown[] };
    expect(body.task.id).toBe(taskId);
    expect(Array.isArray(body.comments)).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('returns 404 when org B tries to access org A task', async () => {
    const res = await req('GET', `/v1/tasks/${taskId}`, orgBPat);
    expect(res.status).toBe(404);
  });

  it('agent can access their own task', async () => {
    const res = await req('GET', `/v1/tasks/${taskId}`, agentKey);
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { id: string } };
    expect(body.task.id).toBe(taskId);
  });

  it('agent returns 403 for task assigned to another agent', async () => {
    // Create task assigned to agentId2.
    const createRes = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Other Agent Task',
      agent_id: agentId2,
    });
    const { task } = await createRes.json() as { task: { id: string } };

    // agentKey (agentId) tries to access it.
    const res = await req('GET', `/v1/tasks/${task.id}`, agentKey);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.forbidden');
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/tasks/:id — state machine + fields
// ---------------------------------------------------------------------------

describe('PATCH /v1/tasks/:id', () => {
  let taskId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Patchable Task',
    });
    taskId = ((await res.json()) as { task: { id: string } }).task.id;
  });

  it('returns 404 for non-existent task', async () => {
    const res = await req('PATCH', '/v1/tasks/t_doesnotexist', pat, { title: 'x' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.not_found');
  });

  it('returns 404 when org B tries to patch org A task', async () => {
    const res = await req('PATCH', `/v1/tasks/${taskId}`, orgBPat, { title: 'hacked' });
    expect(res.status).toBe(404);
  });

  it('returns 400 on invalid status value', async () => {
    const res = await req('PATCH', `/v1/tasks/${taskId}`, pat, { status: 'flying' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.validation_error');
  });

  it('updates title and returns updated task', async () => {
    const res = await req('PATCH', `/v1/tasks/${taskId}`, pat, { title: 'Updated Title' });
    expect(res.status).toBe(200);
    const body = await res.json() as { task: { title: string } };
    expect(body.task.title).toBe('Updated Title');
  });

  it('emits task.updated event for non-status changes', async () => {
    const res = await req('PATCH', `/v1/tasks/${taskId}`, pat, { title: 'Event Update' });
    expect(res.status).toBe(200);

    const row = await (env.DB as D1Database).prepare(
      `SELECT kind FROM events WHERE org_id = ? AND resource_type = 'task' AND resource_id = ? AND kind = 'task.updated' ORDER BY id DESC LIMIT 1`
    ).bind(orgId, taskId).first() as { kind: string } | null;
    expect(row).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // State machine transitions
  // ---------------------------------------------------------------------------

  describe('state machine transitions', () => {
    it('pending → ready: allowed', async () => {
      // Create fresh task for state machine tests (isolated).
      const cr = await req('POST', '/v1/tasks', pat, {
        project_id: projectId,
        title: 'SM Task pending-ready',
        agent_id: agentId,
      });
      const { task: t } = await cr.json() as { task: { id: string; status: string } };
      // Task was created with agent_id so starts as 'ready'. Reassign without agent to reset.
      // Actually the plan spec says pending→ready. Let's create without agent first.
      const cr2 = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'SM pending task' });
      const { task: t2 } = await cr2.json() as { task: { id: string; status: string } };
      expect(t2.status).toBe('pending');

      const res = await req('PATCH', `/v1/tasks/${t2.id}`, pat, { status: 'ready' });
      expect(res.status).toBe(200);
      const body = await res.json() as { task: { status: string } };
      expect(body.task.status).toBe('ready');
    });

    it('pending → in_progress: rejected (409)', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'SM pending-ip' });
      const { task: t } = await cr.json() as { task: { id: string } };

      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'in_progress' });
      expect(res.status).toBe(409);
      const body = await res.json() as { error: { code: string; details: { from: string; to: string } } };
      expect(body.error.code).toBe('task.invalid_transition');
      expect(body.error.details.from).toBe('pending');
      expect(body.error.details.to).toBe('in_progress');
    });

    it('ready → in_progress: allowed; sets startedAt', async () => {
      // Create task with agent (status=ready).
      const cr = await req('POST', '/v1/tasks', pat, {
        project_id: projectId,
        title: 'SM ready-ip',
        agent_id: agentId,
      });
      const { task: t } = await cr.json() as { task: { id: string; started_at?: string | null } };
      expect(t.started_at).toBeNull();

      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'in_progress' });
      expect(res.status).toBe(200);
      const body = await res.json() as { task: { status: string; started_at?: string | null } };
      expect(body.task.status).toBe('in_progress');
      // started_at should now be set to an ISO string.
      expect(typeof body.task.started_at).toBe('string');
    });

    it('in_progress → blocked → in_progress: allowed', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'SM blocked', agent_id: agentId });
      const { task: t } = await cr.json() as { task: { id: string } };

      await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'in_progress' });
      await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'blocked' });
      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'in_progress' });
      expect(res.status).toBe(200);
      const body = await res.json() as { task: { status: string } };
      expect(body.task.status).toBe('in_progress');
    });

    it('in_progress → completed: allowed; sets completedAt', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'SM completed', agent_id: agentId });
      const { task: t } = await cr.json() as { task: { id: string } };

      await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'in_progress' });
      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'completed' });
      expect(res.status).toBe(200);
      const body = await res.json() as { task: { status: string; completed_at?: string | null } };
      expect(body.task.status).toBe('completed');
      expect(typeof body.task.completed_at).toBe('string');
    });

    it('completed → pending: rejected (terminal state)', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'SM terminal', agent_id: agentId });
      const { task: t } = await cr.json() as { task: { id: string } };

      await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'in_progress' });
      await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'completed' });

      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'pending' });
      expect(res.status).toBe(409);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('task.invalid_transition');
    });

    it('cancelled → in_progress: rejected (terminal)', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'SM cancelled' });
      const { task: t } = await cr.json() as { task: { id: string } };

      await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'cancelled' });
      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'in_progress' });
      expect(res.status).toBe(409);
    });

    it('pending → cancelled: sets completedAt', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'SM cancel pending' });
      const { task: t } = await cr.json() as { task: { id: string } };

      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'cancelled' });
      expect(res.status).toBe(200);
      const body = await res.json() as { task: { completed_at?: string | null } };
      expect(typeof body.task.completed_at).toBe('string');
    });

    it('emits task.status_changed event on transition', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'SM event', agent_id: agentId });
      const { task: t } = await cr.json() as { task: { id: string } };

      await req('PATCH', `/v1/tasks/${t.id}`, pat, { status: 'in_progress' });

      const row = await (env.DB as D1Database).prepare(
        `SELECT kind, payload FROM events WHERE org_id = ? AND resource_id = ? AND kind = 'task.status_changed' ORDER BY id DESC LIMIT 1`
      ).bind(orgId, t.id).first() as { kind: string; payload: string } | null;
      expect(row).not.toBeNull();
      const payload = JSON.parse(row!.payload) as { from: string; to: string };
      expect(payload.from).toBe('ready');
      expect(payload.to).toBe('in_progress');
    });
  });

  // ---------------------------------------------------------------------------
  // agent_id changes
  // ---------------------------------------------------------------------------

  describe('agent_id updates', () => {
    it('emits task.assigned event when agent_id changes', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Reassign Test' });
      const { task: t } = await cr.json() as { task: { id: string } };

      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { agent_id: agentId });
      expect(res.status).toBe(200);

      const row = await (env.DB as D1Database).prepare(
        `SELECT kind, payload FROM events WHERE org_id = ? AND resource_id = ? AND kind = 'task.assigned' ORDER BY id DESC LIMIT 1`
      ).bind(orgId, t.id).first() as { kind: string; payload: string } | null;
      expect(row).not.toBeNull();
      const payload = JSON.parse(row!.payload) as { from: string | null; to: string | null };
      expect(payload.to).toBe(agentId);
    });

    it('can unassign agent (set agent_id = null)', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Unassign Test', agent_id: agentId });
      const { task: t } = await cr.json() as { task: { id: string } };

      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { agent_id: null });
      expect(res.status).toBe(200);
      const body = await res.json() as { task: { agent_id?: string | null } };
      expect(body.task.agent_id).toBeNull();
    });

    it('returns 422 when agent_id references non-existent agent', async () => {
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Bad Agent PATCH' });
      const { task: t } = await cr.json() as { task: { id: string } };

      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { agent_id: 'agt_doesnotexist' });
      expect(res.status).toBe(422);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('task.invalid_agent');
    });

    it('auto-promotes pending → ready when agent_id set and no explicit status', async () => {
      // Create a pending task (no agent).
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Auto Promote Task' });
      const { task: t } = await cr.json() as { task: { id: string; status: string } };
      expect(t.status).toBe('pending');

      // PATCH with agent_id only (no status field).
      const res = await req('PATCH', `/v1/tasks/${t.id}`, pat, { agent_id: agentId });
      expect(res.status).toBe(200);
      const body = await res.json() as { task: { status: string; agent_id: string } };
      // Status must be auto-promoted to 'ready'.
      expect(body.task.status).toBe('ready');
      expect(body.task.agent_id).toBe(agentId);

      // Both task.assigned AND task.status_changed events must be emitted.
      const assigned = await (env.DB as D1Database).prepare(
        `SELECT kind FROM events WHERE org_id = ? AND resource_id = ? AND kind = 'task.assigned' ORDER BY id DESC LIMIT 1`
      ).bind(orgId, t.id).first() as { kind: string } | null;
      expect(assigned).not.toBeNull();

      const statusChanged = await (env.DB as D1Database).prepare(
        `SELECT kind, payload FROM events WHERE org_id = ? AND resource_id = ? AND kind = 'task.status_changed' ORDER BY id DESC LIMIT 1`
      ).bind(orgId, t.id).first() as { kind: string; payload: string } | null;
      expect(statusChanged).not.toBeNull();
      const payload = JSON.parse(statusChanged!.payload) as { from: string; to: string };
      expect(payload.from).toBe('pending');
      expect(payload.to).toBe('ready');
    });
  });

  // ---------------------------------------------------------------------------
  // Agent-role restrictions on PATCH
  // ---------------------------------------------------------------------------

  describe('agent role restrictions', () => {
    let agentTaskId = '';

    beforeAll(async () => {
      const cr = await req('POST', '/v1/tasks', pat, {
        project_id: projectId,
        title: 'Agent Owned Task',
        agent_id: agentId,
      });
      agentTaskId = ((await cr.json()) as { task: { id: string } }).task.id;
    });

    it('agent can update status on own task', async () => {
      const res = await req('PATCH', `/v1/tasks/${agentTaskId}`, agentKey, { status: 'in_progress' });
      expect(res.status).toBe(200);
    });

    it('agent can update metadata on own task', async () => {
      const res = await req('PATCH', `/v1/tasks/${agentTaskId}`, agentKey, {
        metadata: { progress: 50 },
      });
      expect(res.status).toBe(200);
    });

    it('agent returns 403 when trying to update title (not allowed)', async () => {
      const res = await req('PATCH', `/v1/tasks/${agentTaskId}`, agentKey, { title: 'Hacked Title' });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('task.forbidden');
    });

    it('agent returns 403 when trying to patch another agent\'s task', async () => {
      // Create task assigned to agentId2.
      const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Other Agent Task PATCH', agent_id: agentId2 });
      const { task: t } = await cr.json() as { task: { id: string } };

      const res = await req('PATCH', `/v1/tasks/${t.id}`, agentKey, { status: 'in_progress' });
      expect(res.status).toBe(403);
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/tasks/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/tasks/:id', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/tasks/t_fake', { method: 'DELETE' }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for member role (members cannot delete tasks)', async () => {
    const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Member Del Task' });
    const { task: t } = await cr.json() as { task: { id: string } };

    const res = await req('DELETE', `/v1/tasks/${t.id}`, memberPat);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.role_insufficient');
  });

  it('returns 403 for agent role', async () => {
    const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Agent Del Task', agent_id: agentId });
    const { task: t } = await cr.json() as { task: { id: string } };

    const res = await req('DELETE', `/v1/tasks/${t.id}`, agentKey);
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent task', async () => {
    const res = await req('DELETE', '/v1/tasks/t_doesnotexist', pat);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('task.not_found');
  });

  it('returns 404 when org B tries to delete org A task', async () => {
    const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Isolation Del Task' });
    const { task: t } = await cr.json() as { task: { id: string } };

    const res = await req('DELETE', `/v1/tasks/${t.id}`, orgBPat);
    expect(res.status).toBe(404);
  });

  it('soft-deletes task; subsequent GET returns 404', async () => {
    const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'To Delete' });
    const { task: t } = await cr.json() as { task: { id: string } };

    const delRes = await req('DELETE', `/v1/tasks/${t.id}`, pat);
    expect(delRes.status).toBe(200);

    const getRes = await req('GET', `/v1/tasks/${t.id}`, pat);
    expect(getRes.status).toBe(404);

    // Second delete should also 404.
    const del2 = await req('DELETE', `/v1/tasks/${t.id}`, pat);
    expect(del2.status).toBe(404);
  });

  it('emits task.deleted event', async () => {
    const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Event Delete Task' });
    const { task: t } = await cr.json() as { task: { id: string } };

    await req('DELETE', `/v1/tasks/${t.id}`, pat);

    const row = await (env.DB as D1Database).prepare(
      `SELECT kind FROM events WHERE org_id = ? AND resource_type = 'task' AND resource_id = ? AND kind = 'task.deleted' ORDER BY id DESC LIMIT 1`
    ).bind(orgId, t.id).first() as { kind: string } | null;
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('task.deleted');
  });

  it('cascade trigger soft-deletes task_comments on task delete', async () => {
    const cr = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Cascade Comments Task' });
    const { task: t } = await cr.json() as { task: { id: string } };

    // Insert a comment directly.
    const cmtId = `cmt_casctest${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    await (env.DB as D1Database).prepare(
      `INSERT INTO task_comments (id, org_id, task_id, author_type, author_id, body, created_at, updated_at)
       VALUES (?, ?, ?, 'user', ?, 'test comment', ?, ?)`
    ).bind(cmtId, orgId, t.id, 'usr_test', now, now).run();

    // Verify comment exists.
    const before = await (env.DB as D1Database).prepare(`SELECT deleted_at FROM task_comments WHERE id = ?`).bind(cmtId).first() as { deleted_at: number | null } | null;
    expect(before?.deleted_at).toBeNull();

    // Delete task.
    await req('DELETE', `/v1/tasks/${t.id}`, pat);

    // Comment should be soft-deleted by the trigger.
    const after = await (env.DB as D1Database).prepare(`SELECT deleted_at FROM task_comments WHERE id = ?`).bind(cmtId).first() as { deleted_at: number | null } | null;
    expect(after?.deleted_at).not.toBeNull();
  });
});
