/**
 * Integration tests for /v1/external_refs CRUD.
 *
 * Coverage:
 *   POST /v1/external_refs
 *     - happy path: owner creates ref → 201, fields returned, event emitted
 *     - 401 without token
 *     - 400 on missing required fields
 *     - 400 on invalid external_url (not a URL)
 *     - 422 on non-existent resource_id (for each resource_type)
 *     - 409 duplicate: second POST with same (resource_type, resource_id, source_kind, source_id)
 *     - agent role: source_id == agent_id → 201
 *     - agent role: source_id != agent_id → 403
 *     - connector role: source_id == connector_id → 201
 *     - connector role: source_id != connector_id → 403
 *     - member can use any source_id
 *     - multi-tenant isolation: resource in different org → 422
 *
 *   GET /v1/external_refs
 *     - list all for org (owner)
 *     - filter by resource_type, resource_id, source_kind, source_id, external_id
 *     - cursor pagination
 *     - multi-tenant isolation
 *
 *   DELETE /v1/external_refs/:id
 *     - soft delete (owner) → 200
 *     - 404 on non-existent / already-deleted
 *     - agent: can delete own ref (source_id == principal.id) → 200
 *     - agent: cannot delete another agent's ref → 403
 *     - connector: can delete any ref in org
 *     - after delete: GET no longer returns the ref
 *     - after delete: 409 duplicate clears → new POST succeeds
 *     - multi-tenant isolation
 *
 *   Resource existence validation:
 *     - resource_type='task' → validates task exists
 *     - resource_type='project' → validates project exists
 *     - resource_type='agent' → validates agent exists
 *     - resource_type='connector' → validates connector exists
 *     - resource_type='comment' → validates comment exists
 */

import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';
import { createOrgFixture } from '../helpers/orgs.ts';

// ---------------------------------------------------------------------------
// Test env + shared state
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'xrefs-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let pat = '';
let orgId = '';
let projectId = '';
let taskId = '';
let agentId = '';
let agentKey = '';
let agentId2 = '';
let agentKey2 = '';
let connectorId = '';
let connectorKey = '';
let commentId = '';

// Org B for isolation tests.
let orgBPat = '';
let orgBProjectId = '';
let orgBTaskId = '';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);

  // Bootstrap org A.
  const res = await app.fetch(
    new Request('http://x/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        email: 'xrefs-owner@example.com',
        password: 'supersecret',
        name: 'XRefs Owner',
        orgName: 'XRefs Org',
        orgSlug: 'xrefs-org',
      }),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
  if (res.status !== 201) throw new Error(`Bootstrap failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { organization: { id: string }; pat: string };
  pat = data.pat;
  orgId = data.organization.id;

  // Create a project.
  const projRes = await req('POST', '/v1/projects', pat, { name: 'XRefs Project', slug: 'xrefs-project' });
  if (projRes.status !== 201) throw new Error(`Project create failed: ${await projRes.text()}`);
  const projData = await projRes.json() as { project: { id: string } };
  projectId = projData.project.id;

  // Create two agents.
  const agentRes = await req('POST', '/v1/agents', pat, { name: 'xref-agent-1', kind: 'hermes' });
  if (agentRes.status !== 201) throw new Error(`Agent create failed: ${await agentRes.text()}`);
  const agentData = await agentRes.json() as { agent: { id: string }; key: string };
  agentId = agentData.agent.id;
  agentKey = agentData.key;

  const agentRes2 = await req('POST', '/v1/agents', pat, { name: 'xref-agent-2', kind: 'hermes' });
  if (agentRes2.status !== 201) throw new Error(`Agent2 create failed: ${await agentRes2.text()}`);
  const agentData2 = await agentRes2.json() as { agent: { id: string }; key: string };
  agentId2 = agentData2.agent.id;
  agentKey2 = agentData2.key;

  // Create a connector.
  const connectorRes = await req('POST', '/v1/connectors', pat, { name: 'xref-connector', kind: 'notion' });
  if (connectorRes.status !== 201) throw new Error(`Connector create failed: ${await connectorRes.text()}`);
  const connectorData = await connectorRes.json() as { connector: { id: string }; key: string };
  connectorId = connectorData.connector.id;
  connectorKey = connectorData.key;

  // Create a task.
  const taskRes = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'XRef task', agent_id: agentId });
  if (taskRes.status !== 201) throw new Error(`Task create failed: ${await taskRes.text()}`);
  const taskData = await taskRes.json() as { task: { id: string } };
  taskId = taskData.task.id;

  // Post a comment to get a comment ID.
  const commentRes = await req('POST', `/v1/tasks/${taskId}/comments`, pat, { body: 'hello for xref' });
  if (commentRes.status !== 201) throw new Error(`Comment create failed: ${await commentRes.text()}`);
  const commentData = await commentRes.json() as { comment: { id: string } };
  commentId = commentData.comment.id;

  // Org B setup.
  const orgB = await createOrgFixture((env.DB as D1Database), 'Org B XRefs', 'org-b-xrefs');
  orgBPat = orgB.pat;

  const orgBProjRes = await req('POST', '/v1/projects', orgBPat, { name: 'OrgB Project', slug: 'orgb-project-xrefs' });
  const orgBProjData = await orgBProjRes.json() as { project: { id: string } };
  orgBProjectId = orgBProjData.project.id;

  const orgBTaskRes = await req('POST', '/v1/tasks', orgBPat, { project_id: orgBProjectId, title: 'OrgB XRef Task' });
  const orgBTaskData = await orgBTaskRes.json() as { task: { id: string } };
  orgBTaskId = orgBTaskData.task.id;
});

// ---------------------------------------------------------------------------
// Request helper
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
// POST /v1/external_refs
// ---------------------------------------------------------------------------

describe('POST /v1/external_refs', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/external_refs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resource_type: 'task',
          resource_id: taskId,
          source_kind: 'notion',
          source_id: 'ws-1',
          external_id: 'page-1',
        }),
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 on missing required fields', async () => {
    const res = await req('POST', '/v1/external_refs', pat, { resource_type: 'task' });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.validation_error');
  });

  it('returns 400 on invalid external_url', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'notion',
      source_id: 'ws-1',
      external_id: 'page-1',
      external_url: 'not-a-url',
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.validation_error');
  });

  it('returns 422 on non-existent task resource_id', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: 't_doesnotexist',
      source_kind: 'notion',
      source_id: 'ws-1',
      external_id: 'page-1',
    });
    expect(res.status).toBe(422);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.invalid_resource');
  });

  it('returns 422 on non-existent project resource_id', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'project',
      resource_id: 'prj_doesnotexist',
      source_kind: 'notion',
      source_id: 'ws-1',
      external_id: 'db-1',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 on non-existent agent resource_id', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'agent',
      resource_id: 'agt_doesnotexist',
      source_kind: 'hermes',
      source_id: 'vm-1',
      external_id: 'local-1',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 on non-existent connector resource_id', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'connector',
      resource_id: 'cnn_doesnotexist',
      source_kind: 'hermes',
      source_id: 'vm-1',
      external_id: 'local-1',
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 on non-existent comment resource_id', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'comment',
      resource_id: 'cmt_doesnotexist',
      source_kind: 'notion',
      source_id: 'ws-1',
      external_id: 'block-1',
    });
    expect(res.status).toBe(422);
  });

  it('owner creates ref for task → 201, fields correct', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'notion',
      source_id: 'ws-owner-test',
      external_id: 'page-owner-test',
      external_url: 'https://notion.so/page-owner-test',
      metadata: { foo: 'bar' },
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { external_ref: Record<string, unknown> };
    expect(data.external_ref['id']).toMatch(/^xrf_/);
    expect(data.external_ref['resource_type']).toBe('task');
    expect(data.external_ref['resource_id']).toBe(taskId);
    expect(data.external_ref['source_kind']).toBe('notion');
    expect(data.external_ref['source_id']).toBe('ws-owner-test');
    expect(data.external_ref['external_id']).toBe('page-owner-test');
    expect(data.external_ref['external_url']).toBe('https://notion.so/page-owner-test');
    expect(typeof data.external_ref['created_at']).toBe('string');
    expect((data.external_ref['created_at'] as string)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('409 duplicate: same (resource_type, resource_id, source_kind, source_id)', async () => {
    // Create one.
    await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'duplicate-test',
      source_id: 'dup-source',
      external_id: 'dup-ext-1',
    });
    // Attempt a second with a different external_id but same unique key tuple.
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'duplicate-test',
      source_id: 'dup-source',
      external_id: 'dup-ext-2',
    });
    expect(res.status).toBe(409);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.duplicate');
  });

  it('agent creates ref with source_id == own id → 201', async () => {
    const res = await req('POST', '/v1/external_refs', agentKey, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'hermes',
      source_id: agentId,
      external_id: 'local-task-id-1',
    });
    expect(res.status).toBe(201);
  });

  it('agent 403 when source_id != own id', async () => {
    const res = await req('POST', '/v1/external_refs', agentKey, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'hermes',
      source_id: 'some-other-id',
      external_id: 'local-task-id-9',
    });
    expect(res.status).toBe(403);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.source_id_mismatch');
  });

  it('connector creates ref with source_id == own id → 201', async () => {
    const res = await req('POST', '/v1/external_refs', connectorKey, {
      resource_type: 'project',
      resource_id: projectId,
      source_kind: 'notion',
      source_id: connectorId,
      external_id: 'notion-db-abc',
    });
    expect(res.status).toBe(201);
  });

  it('connector 403 when source_id != own id', async () => {
    const res = await req('POST', '/v1/external_refs', connectorKey, {
      resource_type: 'project',
      resource_id: projectId,
      source_kind: 'notion',
      source_id: 'someone-else',
      external_id: 'notion-db-xyz',
    });
    expect(res.status).toBe(403);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.source_id_mismatch');
  });

  it('can create ref for comment resource_type', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'comment',
      resource_id: commentId,
      source_kind: 'notion',
      source_id: 'ws-comment-test',
      external_id: 'notion-block-comment-1',
    });
    expect(res.status).toBe(201);
    const data = await res.json() as { external_ref: Record<string, unknown> };
    expect(data.external_ref['resource_type']).toBe('comment');
  });

  it('can create ref for agent resource_type', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'agent',
      resource_id: agentId,
      source_kind: 'registry',
      source_id: 'ws-agent-test',
      external_id: 'agent-external-1',
    });
    expect(res.status).toBe(201);
  });

  it('can create ref for connector resource_type', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'connector',
      resource_id: connectorId,
      source_kind: 'registry',
      source_id: 'ws-connector-test',
      external_id: 'connector-external-1',
    });
    expect(res.status).toBe(201);
  });

  it('multi-tenant isolation: org B resource not accessible from org A', async () => {
    const res = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: orgBTaskId,
      source_kind: 'notion',
      source_id: 'ws-1',
      external_id: 'cross-org-ext',
    });
    expect(res.status).toBe(422);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.invalid_resource');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/external_refs
// ---------------------------------------------------------------------------

describe('GET /v1/external_refs', () => {
  let listTaskId = '';

  beforeAll(async () => {
    // Create a dedicated task for list tests.
    const taskRes = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'List XRefs Task' });
    const taskData = await taskRes.json() as { task: { id: string } };
    listTaskId = taskData.task.id;

    // Create several refs for various filter tests.
    await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: listTaskId,
      source_kind: 'notion',
      source_id: 'list-ws-1',
      external_id: 'list-page-1',
    });
    await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: listTaskId,
      source_kind: 'linear',
      source_id: 'list-team-1',
      external_id: 'list-issue-1',
    });
    await req('POST', '/v1/external_refs', pat, {
      resource_type: 'project',
      resource_id: projectId,
      source_kind: 'notion',
      source_id: 'list-ws-2',
      external_id: 'list-db-1',
    });
  });

  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/external_refs', { method: 'GET' }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('lists all external_refs for org (no filter)', async () => {
    const res = await req('GET', '/v1/external_refs', pat);
    expect(res.status).toBe(200);
    const data = await res.json() as { external_refs: unknown[]; next_cursor: string | null };
    expect(Array.isArray(data.external_refs)).toBe(true);
    expect(data.external_refs.length).toBeGreaterThanOrEqual(3);
  });

  it('filters by resource_type=task', async () => {
    const res = await req('GET', `/v1/external_refs?resource_type=task&resource_id=${listTaskId}`, pat);
    expect(res.status).toBe(200);
    const data = await res.json() as { external_refs: Array<Record<string, unknown>> };
    expect(data.external_refs.length).toBeGreaterThanOrEqual(1);
    for (const ref of data.external_refs) {
      expect(ref['resource_type']).toBe('task');
      expect(ref['resource_id']).toBe(listTaskId);
    }
  });

  it('filters by source_kind=notion', async () => {
    const res = await req('GET', `/v1/external_refs?source_kind=notion&resource_id=${listTaskId}`, pat);
    expect(res.status).toBe(200);
    const data = await res.json() as { external_refs: Array<Record<string, unknown>> };
    expect(data.external_refs.length).toBeGreaterThanOrEqual(1);
    for (const ref of data.external_refs) {
      expect(ref['source_kind']).toBe('notion');
    }
  });

  it('filters by source_id', async () => {
    const res = await req('GET', `/v1/external_refs?source_id=list-ws-1`, pat);
    expect(res.status).toBe(200);
    const data = await res.json() as { external_refs: Array<Record<string, unknown>> };
    expect(data.external_refs.length).toBeGreaterThanOrEqual(1);
    for (const ref of data.external_refs) {
      expect(ref['source_id']).toBe('list-ws-1');
    }
  });

  it('filters by external_id', async () => {
    const res = await req('GET', `/v1/external_refs?external_id=list-page-1`, pat);
    expect(res.status).toBe(200);
    const data = await res.json() as { external_refs: Array<Record<string, unknown>> };
    expect(data.external_refs.length).toBeGreaterThanOrEqual(1);
    for (const ref of data.external_refs) {
      expect(ref['external_id']).toBe('list-page-1');
    }
  });

  it('cursor pagination works', async () => {
    // Create a task with many refs.
    const taskRes = await req('POST', '/v1/tasks', pat, { project_id: projectId, title: 'Pagination XRefs Task' });
    const paginTaskId = (await taskRes.json() as { task: { id: string } }).task.id;

    for (let i = 0; i < 3; i++) {
      await req('POST', '/v1/external_refs', pat, {
        resource_type: 'task',
        resource_id: paginTaskId,
        source_kind: 'pagin-source',
        source_id: `pagin-ws-${i}`,
        external_id: `pagin-ext-${i}`,
      });
    }

    const page1Res = await req('GET', `/v1/external_refs?resource_id=${paginTaskId}&limit=2`, pat);
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json() as { external_refs: unknown[]; next_cursor: string | null };
    expect(page1.external_refs.length).toBe(2);
    expect(page1.next_cursor).not.toBeNull();

    const page2Res = await req('GET', `/v1/external_refs?resource_id=${paginTaskId}&limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`, pat);
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json() as { external_refs: unknown[]; next_cursor: string | null };
    expect(page2.external_refs.length).toBe(1);
    expect(page2.next_cursor).toBeNull();
  });

  it('multi-tenant isolation: org A cannot see org B external_refs', async () => {
    // Create a ref in org B.
    await req('POST', '/v1/external_refs', orgBPat, {
      resource_type: 'task',
      resource_id: orgBTaskId,
      source_kind: 'orgb-source',
      source_id: 'orgb-ws-1',
      external_id: 'orgb-ext-1',
    });

    // Org A cannot filter by source_id used in org B.
    const res = await req('GET', `/v1/external_refs?source_id=orgb-ws-1`, pat);
    expect(res.status).toBe(200);
    const data = await res.json() as { external_refs: unknown[] };
    expect(data.external_refs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/external_refs/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/external_refs/:id', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/external_refs/xrf_fake', { method: 'DELETE' }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for non-existent ref', async () => {
    const res = await req('DELETE', '/v1/external_refs/xrf_doesnotexist', pat);
    expect(res.status).toBe(404);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.not_found');
  });

  it('owner soft-deletes a ref → 200, ref no longer in GET', async () => {
    // Create a ref to delete.
    const createRes = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'delete-test',
      source_id: 'to-delete-ws',
      external_id: 'to-delete-ext',
    });
    expect(createRes.status).toBe(201);
    const createData = await createRes.json() as { external_ref: { id: string } };
    const refId = createData.external_ref.id;

    // Delete it.
    const deleteRes = await req('DELETE', `/v1/external_refs/${refId}`, pat);
    expect(deleteRes.status).toBe(200);

    // Verify it no longer appears in GET.
    const getRes = await req('GET', `/v1/external_refs?source_kind=delete-test&source_id=to-delete-ws`, pat);
    const getData = await getRes.json() as { external_refs: unknown[] };
    expect(getData.external_refs.length).toBe(0);
  });

  it('returns 404 on second delete of same ref', async () => {
    // Create and delete.
    const createRes = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'double-delete',
      source_id: 'dd-ws',
      external_id: 'dd-ext',
    });
    const refId = (await createRes.json() as { external_ref: { id: string } }).external_ref.id;
    await req('DELETE', `/v1/external_refs/${refId}`, pat);

    const res2 = await req('DELETE', `/v1/external_refs/${refId}`, pat);
    expect(res2.status).toBe(404);
  });

  it('after delete, 409 clears — new POST with same unique key succeeds', async () => {
    // Create ref.
    const createRes = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'recreate-test',
      source_id: 'recreate-ws',
      external_id: 'recreate-ext',
    });
    const refId = (await createRes.json() as { external_ref: { id: string } }).external_ref.id;

    // Delete it.
    await req('DELETE', `/v1/external_refs/${refId}`, pat);

    // Now re-create with same unique tuple — should succeed.
    const reCreateRes = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'recreate-test',
      source_id: 'recreate-ws',
      external_id: 'recreate-ext-v2',
    });
    expect(reCreateRes.status).toBe(201);
  });

  it('agent can delete own ref (source_id == principal.id)', async () => {
    // Create a ref as agent.
    const createRes = await req('POST', '/v1/external_refs', agentKey, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'hermes',
      source_id: agentId,
      external_id: `agent-local-del-${Date.now()}`,
    });
    expect(createRes.status).toBe(201);
    const refId = (await createRes.json() as { external_ref: { id: string } }).external_ref.id;

    // Agent deletes it.
    const deleteRes = await req('DELETE', `/v1/external_refs/${refId}`, agentKey);
    expect(deleteRes.status).toBe(200);
  });

  it('agent 403 trying to delete a ref with different source_id', async () => {
    // Create a ref as owner (with a different source_id).
    const createRes = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'foreign-to-agent',
      source_id: 'not-agent-id',
      external_id: 'foreign-ext',
    });
    expect(createRes.status).toBe(201);
    const refId = (await createRes.json() as { external_ref: { id: string } }).external_ref.id;

    // Agent 1 tries to delete it.
    const deleteRes = await req('DELETE', `/v1/external_refs/${refId}`, agentKey);
    expect(deleteRes.status).toBe(403);
    const data = await deleteRes.json() as { error: { code: string } };
    expect(data.error.code).toBe('external_ref.forbidden');
  });

  it('connector can delete any ref in the org', async () => {
    // Create a ref as owner.
    const createRes = await req('POST', '/v1/external_refs', pat, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'connector-del-test',
      source_id: 'any-source',
      external_id: 'connector-del-ext',
    });
    const refId = (await createRes.json() as { external_ref: { id: string } }).external_ref.id;

    // Connector deletes it.
    const deleteRes = await req('DELETE', `/v1/external_refs/${refId}`, connectorKey);
    expect(deleteRes.status).toBe(200);
  });

  it('agent 2 cannot delete a ref created by agent 1', async () => {
    // Agent 1 creates a ref.
    const createRes = await req('POST', '/v1/external_refs', agentKey, {
      resource_type: 'task',
      resource_id: taskId,
      source_kind: 'hermes',
      source_id: agentId,
      external_id: `agent1-for-agent2-del-${Date.now()}`,
    });
    expect(createRes.status).toBe(201);
    const refId = (await createRes.json() as { external_ref: { id: string } }).external_ref.id;

    // Agent 2 tries to delete it.
    const deleteRes = await req('DELETE', `/v1/external_refs/${refId}`, agentKey2);
    expect(deleteRes.status).toBe(403);
  });

  it('multi-tenant isolation: org A cannot delete org B refs', async () => {
    // Create a ref in org B.
    const createRes = await req('POST', '/v1/external_refs', orgBPat, {
      resource_type: 'task',
      resource_id: orgBTaskId,
      source_kind: 'orgb-del',
      source_id: 'orgb-ws-del',
      external_id: 'orgb-del-ext',
    });
    const refId = (await createRes.json() as { external_ref: { id: string } }).external_ref.id;

    // Org A tries to delete it.
    const deleteRes = await req('DELETE', `/v1/external_refs/${refId}`, pat);
    expect(deleteRes.status).toBe(404);
  });
});
