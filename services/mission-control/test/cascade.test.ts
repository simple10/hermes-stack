/**
 * Soft-delete cascade verification tests.
 *
 * For each parent resource (task, project, agent, connector):
 *   - Soft-deleting via Drizzle sets deleted_at on child external_refs
 *     and (for tasks) task_comments with deleted_by_type = 'system'.
 *   - Cascade triggers fire even on raw SQL UPDATEs (bypassing the ORM).
 *   - Unrelated rows in other orgs / other resources are not touched.
 *   - The partial unique index allows re-using a name after soft-delete.
 *
 * These tests work directly on (env.DB as D1Database) (the pool DB binding in single-DB mode)
 * using raw SQL to insert and inspect rows, bypassing app-level helpers so we
 * verify the DB-level triggers rather than the application cascade logic.
 */

import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../src/index.ts';
import { createOrgFixture } from './helpers/orgs.ts';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'cascade-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let orgId = '';
let pat = '';

/** Insert a minimal agent row directly into pool DB. Returns agentId. */
async function insertAgent(name: string): Promise<string> {
  const id = `agt_csc${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await (env.DB as D1Database).prepare(
    `INSERT INTO agents (id, org_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, 'hermes', ?, ?)`
  ).bind(id, orgId, name, now, now).run();
  return id;
}

/** Insert a minimal connector row directly into pool DB. Returns connectorId. */
async function insertConnector(name: string): Promise<string> {
  const id = `cnn_csc${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await (env.DB as D1Database).prepare(
    `INSERT INTO connectors (id, org_id, name, kind, created_at, updated_at) VALUES (?, ?, ?, 'notion', ?, ?)`
  ).bind(id, orgId, name, now, now).run();
  return id;
}

/** Insert a minimal project row directly into pool DB. Returns projectId. */
async function insertProject(slug: string): Promise<string> {
  const id = `prj_csc${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await (env.DB as D1Database).prepare(
    `INSERT INTO projects (id, org_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, orgId, `Project ${slug}`, slug, now, now).run();
  return id;
}

/** Insert a minimal task row directly into pool DB. Returns taskId. */
async function insertTask(projectId: string): Promise<string> {
  const id = `t_csc${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await (env.DB as D1Database).prepare(
    `INSERT INTO tasks (id, org_id, project_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, 'Cascade Test Task', 'pending', 0, ?, ?)`
  ).bind(id, orgId, projectId, now, now).run();
  return id;
}

/** Insert a task_comment row directly. Returns commentId. */
async function insertComment(taskId: string, index: number = 0): Promise<string> {
  const id = `cmt_csc${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now() + index;
  await (env.DB as D1Database).prepare(
    `INSERT INTO task_comments (id, org_id, task_id, author_type, author_id, body, created_at, updated_at)
     VALUES (?, ?, ?, 'user', 'usr_test', ?, ?, ?)`
  ).bind(id, orgId, taskId, `Comment body ${index}`, now, now).run();
  return id;
}

/** Insert an external_ref row directly. Returns refId. */
async function insertExternalRef(
  resourceType: string,
  resourceId: string,
  suffix: string,
): Promise<string> {
  const id = `xrf_csc${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  await (env.DB as D1Database).prepare(
    `INSERT INTO external_refs (id, org_id, resource_type, resource_id, source_kind, source_id, external_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'cascade-test', ?, ?, ?, ?)`
  ).bind(id, orgId, resourceType, resourceId, `src-${suffix}`, `ext-${suffix}`, now, now).run();
  return id;
}

/** Soft-delete a row in the given table via raw SQL UPDATE. */
async function rawSoftDelete(
  table: string,
  id: string,
  deletedAt: number = Date.now(),
  deletedByType: string = 'user',
  deletedById: string = 'usr_test',
): Promise<void> {
  await (env.DB as D1Database).prepare(
    `UPDATE ${table} SET deleted_at = ?, deleted_by_type = ?, deleted_by_id = ? WHERE id = ?`
  ).bind(deletedAt, deletedByType, deletedById, id).run();
}

/** Fetch deleted_at and deleted_by_type from a task_comments row. */
async function getCommentDelete(commentId: string): Promise<{ deleted_at: number | null; deleted_by_type: string | null } | null> {
  return (env.DB as D1Database).prepare(
    `SELECT deleted_at, deleted_by_type FROM task_comments WHERE id = ?`
  ).bind(commentId).first() as Promise<{ deleted_at: number | null; deleted_by_type: string | null } | null>;
}

/** Fetch deleted_at and deleted_by_type from an external_refs row. */
async function getRefDelete(refId: string): Promise<{ deleted_at: number | null; deleted_by_type: string | null } | null> {
  return (env.DB as D1Database).prepare(
    `SELECT deleted_at, deleted_by_type FROM external_refs WHERE id = ?`
  ).bind(refId).first() as Promise<{ deleted_at: number | null; deleted_by_type: string | null } | null>;
}

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

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);

  // Bootstrap the org.
  const res = await app.fetch(
    new Request('http://x/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        email: 'cascade-owner@example.com',
        password: 'supersecret',
        name: 'Cascade Owner',
        orgName: 'Cascade Org',
        orgSlug: 'cascade-org',
      }),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
  if (res.status !== 201) throw new Error(`Bootstrap failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { organization: { id: string }; pat: string };
  pat = data.pat;
  orgId = data.organization.id;
});

// ---------------------------------------------------------------------------
// Scenario 1: Task → comments + external_refs
// ---------------------------------------------------------------------------

describe('cascade: task soft-delete → comments + external_refs', () => {
  it('cascades to 3 comments and 2 external_refs via Drizzle (app route)', async () => {
    // Create a project and task via the API to get valid IDs.
    const projRes = await req('POST', '/v1/projects', pat, { name: 'Task Cascade Project', slug: 'task-cascade-proj' });
    const { project } = await projRes.json() as { project: { id: string } };

    const taskRes = await req('POST', '/v1/tasks', pat, { project_id: project.id, title: 'Cascade Task 1' });
    const { task } = await taskRes.json() as { task: { id: string } };

    // Insert 3 comments and 2 external_refs directly.
    const c1 = await insertComment(task.id, 0);
    const c2 = await insertComment(task.id, 1);
    const c3 = await insertComment(task.id, 2);
    const r1 = await insertExternalRef('task', task.id, 'task-ref-1');
    const r2 = await insertExternalRef('task', task.id, 'task-ref-2');

    // Verify all are active before delete.
    for (const id of [c1, c2, c3]) {
      const row = await getCommentDelete(id);
      expect(row?.deleted_at).toBeNull();
    }
    for (const id of [r1, r2]) {
      const row = await getRefDelete(id);
      expect(row?.deleted_at).toBeNull();
    }

    // Soft-delete the task via API (uses Drizzle under the hood).
    const delRes = await req('DELETE', `/v1/tasks/${task.id}`, pat);
    expect(delRes.status).toBe(200);

    // All 3 comments must be cascaded.
    for (const id of [c1, c2, c3]) {
      const row = await getCommentDelete(id);
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.deleted_by_type).toBe('system');
    }

    // Both external_refs must be cascaded.
    for (const id of [r1, r2]) {
      const row = await getRefDelete(id);
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.deleted_by_type).toBe('system');
    }
  });

  it('does not cascade to unrelated tasks in the same org', async () => {
    const projRes = await req('POST', '/v1/projects', pat, { name: 'Task No-Touch Project', slug: 'task-notouch-proj' });
    const { project } = await projRes.json() as { project: { id: string } };

    const taskRes1 = await req('POST', '/v1/tasks', pat, { project_id: project.id, title: 'Delete Me' });
    const { task: t1 } = await taskRes1.json() as { task: { id: string } };

    const taskRes2 = await req('POST', '/v1/tasks', pat, { project_id: project.id, title: 'Keep Me Alive' });
    const { task: t2 } = await taskRes2.json() as { task: { id: string } };

    const c1 = await insertComment(t1.id, 0);
    const c2 = await insertComment(t2.id, 0);

    // Delete only t1.
    await req('DELETE', `/v1/tasks/${t1.id}`, pat);

    // t1's comment is deleted.
    const row1 = await getCommentDelete(c1);
    expect(row1?.deleted_at).not.toBeNull();

    // t2's comment is untouched.
    const row2 = await getCommentDelete(c2);
    expect(row2?.deleted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Project → external_refs (NOT tasks)
// ---------------------------------------------------------------------------

describe('cascade: project soft-delete → external_refs only (tasks untouched)', () => {
  it('cascades external_refs but leaves project tasks alive', async () => {
    const projId = await insertProject(`proj-cascade-${Date.now()}`);
    const r1 = await insertExternalRef('project', projId, `proj-xrf-${Date.now()}`);

    // Also add a task under the project.
    const taskId = await insertTask(projId);
    const taskComment = await insertComment(taskId, 0);

    // Verify everything is active.
    const refBefore = await getRefDelete(r1);
    expect(refBefore?.deleted_at).toBeNull();
    const commentBefore = await getCommentDelete(taskComment);
    expect(commentBefore?.deleted_at).toBeNull();

    // Soft-delete the project via raw SQL.
    await rawSoftDelete('projects', projId);

    // Project's external_ref is cascaded.
    const refAfter = await getRefDelete(r1);
    expect(refAfter?.deleted_at).not.toBeNull();
    expect(refAfter?.deleted_by_type).toBe('system');

    // Tasks (and their comments) under the project are NOT cascaded.
    const taskRow = await (env.DB as D1Database).prepare(`SELECT deleted_at FROM tasks WHERE id = ?`).bind(taskId).first() as { deleted_at: number | null } | null;
    expect(taskRow?.deleted_at).toBeNull();

    const commentAfter = await getCommentDelete(taskComment);
    expect(commentAfter?.deleted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Agent → external_refs pointing at the agent
// ---------------------------------------------------------------------------

describe('cascade: agent soft-delete → external_refs on the agent', () => {
  it('cascades external_refs for the agent; task assignment is not touched', async () => {
    const agentId = await insertAgent(`cascade-agent-${Date.now()}`);

    // Attach two external_refs to this agent.
    const r1 = await insertExternalRef('agent', agentId, `agt-xrf-1-${Date.now()}`);
    const r2 = await insertExternalRef('agent', agentId, `agt-xrf-2-${Date.now()}`);

    // Verify active.
    for (const id of [r1, r2]) {
      const row = await getRefDelete(id);
      expect(row?.deleted_at).toBeNull();
    }

    // Soft-delete agent via raw SQL.
    await rawSoftDelete('agents', agentId);

    // Both refs on this agent are cascaded.
    for (const id of [r1, r2]) {
      const row = await getRefDelete(id);
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.deleted_by_type).toBe('system');
    }
  });

  it('does not cascade external_refs belonging to a different agent', async () => {
    const agentA = await insertAgent(`cascade-agt-a-${Date.now()}`);
    const agentB = await insertAgent(`cascade-agt-b-${Date.now()}`);

    const rA = await insertExternalRef('agent', agentA, `agt-a-xrf-${Date.now()}`);
    const rB = await insertExternalRef('agent', agentB, `agt-b-xrf-${Date.now()}`);

    // Delete only agentA.
    await rawSoftDelete('agents', agentA);

    // agentA's ref is cascaded.
    const rowA = await getRefDelete(rA);
    expect(rowA?.deleted_at).not.toBeNull();

    // agentB's ref is untouched.
    const rowB = await getRefDelete(rB);
    expect(rowB?.deleted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Connector → external_refs
// ---------------------------------------------------------------------------

describe('cascade: connector soft-delete → external_refs on the connector', () => {
  it('cascades external_refs for the connector', async () => {
    const connId = await insertConnector(`cascade-conn-${Date.now()}`);
    const r1 = await insertExternalRef('connector', connId, `conn-xrf-1-${Date.now()}`);
    const r2 = await insertExternalRef('connector', connId, `conn-xrf-2-${Date.now()}`);

    // Soft-delete via raw SQL.
    await rawSoftDelete('connectors', connId);

    for (const id of [r1, r2]) {
      const row = await getRefDelete(id);
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.deleted_by_type).toBe('system');
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Trigger fires on raw SQL UPDATE (bypassing the ORM entirely)
// ---------------------------------------------------------------------------

describe('cascade: trigger fires even on raw SQL UPDATE (bypasses ORM)', () => {
  it('cascades task comments and external_refs when deleted via raw D1 prepare', async () => {
    // Insert task + children entirely via raw SQL — no app code involved.
    const projId = await insertProject(`raw-sql-proj-${Date.now()}`);
    const taskId = await insertTask(projId);
    const c1 = await insertComment(taskId, 0);
    const c2 = await insertComment(taskId, 1);
    const r1 = await insertExternalRef('task', taskId, `raw-task-xrf-${Date.now()}`);

    // Bypass Drizzle entirely: raw D1 prepare().bind().run()
    const deletedAt = Date.now();
    await (env.DB as D1Database).prepare(
      `UPDATE tasks SET deleted_at = ?, deleted_by_type = ?, deleted_by_id = ? WHERE id = ?`
    ).bind(deletedAt, 'user', 'usr_raw_test', taskId).run();

    // Verify task itself is deleted.
    const taskRow = await (env.DB as D1Database).prepare(`SELECT deleted_at FROM tasks WHERE id = ?`).bind(taskId).first() as { deleted_at: number | null } | null;
    expect(taskRow?.deleted_at).not.toBeNull();

    // Verify the trigger cascaded to comments.
    for (const id of [c1, c2]) {
      const row = await getCommentDelete(id);
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.deleted_by_type).toBe('system');
    }

    // Verify the trigger cascaded to external_refs.
    const refRow = await getRefDelete(r1);
    expect(refRow?.deleted_at).not.toBeNull();
    expect(refRow?.deleted_by_type).toBe('system');
  });

  it('raw project delete cascades external_refs but not tasks', async () => {
    const projId = await insertProject(`raw-proj-${Date.now()}`);
    const taskId = await insertTask(projId);
    const r1 = await insertExternalRef('project', projId, `raw-proj-xrf-${Date.now()}`);

    // Raw SQL on projects table.
    await (env.DB as D1Database).prepare(
      `UPDATE projects SET deleted_at = ?, deleted_by_type = ?, deleted_by_id = ? WHERE id = ?`
    ).bind(Date.now(), 'user', 'usr_raw_test', projId).run();

    // Project external_ref cascaded.
    const refRow = await getRefDelete(r1);
    expect(refRow?.deleted_at).not.toBeNull();
    expect(refRow?.deleted_by_type).toBe('system');

    // Task under that project is NOT cascaded.
    const taskRow = await (env.DB as D1Database).prepare(`SELECT deleted_at FROM tasks WHERE id = ?`).bind(taskId).first() as { deleted_at: number | null } | null;
    expect(taskRow?.deleted_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Partial unique index allows re-use of name after soft-delete
// ---------------------------------------------------------------------------

describe('cascade: partial unique index allows name re-use after soft-delete', () => {
  it('agent name can be reused after soft-delete (partial unique index)', async () => {
    // Create an agent via the API.
    const name = `unique-agent-${Date.now()}`;
    const res1 = await req('POST', '/v1/agents', pat, { name, kind: 'hermes' });
    expect(res1.status).toBe(201);
    const { agent } = await res1.json() as { agent: { id: string } };

    // Soft-delete it via API.
    const del = await req('DELETE', `/v1/agents/${agent.id}`, pat);
    expect(del.status).toBe(200);

    // Creating another agent with the same name should succeed.
    const res2 = await req('POST', '/v1/agents', pat, { name, kind: 'hermes' });
    expect(res2.status).toBe(201);
    const { agent: agent2 } = await res2.json() as { agent: { id: string } };
    expect(agent2.id).not.toBe(agent.id);
  });

  it('connector name can be reused after soft-delete', async () => {
    const name = `unique-connector-${Date.now()}`;
    const res1 = await req('POST', '/v1/connectors', pat, { name, kind: 'notion' });
    expect(res1.status).toBe(201);
    const { connector } = await res1.json() as { connector: { id: string } };

    await req('DELETE', `/v1/connectors/${connector.id}`, pat);

    const res2 = await req('POST', '/v1/connectors', pat, { name, kind: 'notion' });
    expect(res2.status).toBe(201);
    const { connector: connector2 } = await res2.json() as { connector: { id: string } };
    expect(connector2.id).not.toBe(connector.id);
  });

  it('project slug can be reused after soft-delete', async () => {
    const slug = `unique-project-${Date.now()}`;
    const res1 = await req('POST', '/v1/projects', pat, { name: 'Unique P', slug });
    expect(res1.status).toBe(201);
    const { project } = await res1.json() as { project: { id: string } };

    await req('DELETE', `/v1/projects/${project.id}`, pat);

    const res2 = await req('POST', '/v1/projects', pat, { name: 'Unique P v2', slug });
    expect(res2.status).toBe(201);
    const { project: project2 } = await res2.json() as { project: { id: string } };
    expect(project2.id).not.toBe(project.id);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Already-deleted children are not double-cascaded
// ---------------------------------------------------------------------------

describe('cascade: already-deleted children are not re-cascaded', () => {
  it('pre-deleted comment retains its original deleted_at after task delete', async () => {
    const projRes = await req('POST', '/v1/projects', pat, { name: 'Pre-del Project', slug: `pre-del-proj-${Date.now()}` });
    const { project } = await projRes.json() as { project: { id: string } };

    const taskRes = await req('POST', '/v1/tasks', pat, { project_id: project.id, title: 'Pre-delete Task' });
    const { task } = await taskRes.json() as { task: { id: string } };

    // Post a comment via API (simulates normal flow).
    const cRes = await req('POST', `/v1/tasks/${task.id}/comments`, pat, { body: 'Pre-deleted comment' });
    const { comment } = await cRes.json() as { comment: { id: string } };

    // Manually soft-delete the comment first (simulate prior deletion).
    const earlyTs = Date.now() - 10000;
    await (env.DB as D1Database).prepare(
      `UPDATE task_comments SET deleted_at = ?, deleted_by_type = ?, deleted_by_id = ? WHERE id = ?`
    ).bind(earlyTs, 'user', 'usr_early', comment.id).run();

    // Now delete the task — trigger's WHERE clause is `AND deleted_at IS NULL`.
    await req('DELETE', `/v1/tasks/${task.id}`, pat);

    // The comment's deleted_at should remain earlyTs (trigger skipped it).
    const row = await getCommentDelete(comment.id);
    expect(row?.deleted_at).toBe(earlyTs);
    expect(row?.deleted_by_type).toBe('user');
  });
});
