/**
 * Cross-org isolation matrix.
 *
 * For every resource type and every HTTP method, verifies that Org B
 * cannot read, modify, or delete Org A's resources — and that Org B's
 * list endpoints never return Org A's data.
 *
 * Coverage:
 *   /api/v1/agents         — GET :id, PATCH :id, DELETE :id + list
 *   /api/v1/connectors     — GET :id, PATCH :id, DELETE :id + list
 *   /api/v1/projects       — GET :id, PATCH :id, DELETE :id + list
 *   /api/v1/tasks          — GET :id, PATCH :id, DELETE :id + list
 *   /api/v1/tasks/:id/comments — GET list, POST new comment
 *   /api/v1/external_refs  — GET list, DELETE :id
 *
 * Edge cases:
 *   - Agent in Org A using ?agent_id=<orgB_agent_id> → must not see Org B tasks
 *   - Forged cursor from Org A replayed in Org B request → rejected (400)
 *
 * Each describe block is self-contained: it bootstraps/fixtures its own orgs
 * so failures are independent and easy to diagnose.
 */

import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../src/index.ts';
import { createOrgFixture } from './helpers/orgs.ts';
import { encodeCursor } from '../src/pagination.ts';

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'isolation-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

// Org A — bootstrapped (owner principal).
let orgAPat = '';
let orgAId = '';

// Org B — created via fixture (owner principal).
let orgBPat = '';
let orgBId = '';

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

  // Bootstrap Org A.
  const res = await app.fetch(
    new Request('http://x/api/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        email: 'isolation-owner@example.com',
        password: 'supersecret',
        name: 'Isolation Owner',
        orgName: 'Isolation Org A',
        orgSlug: 'isolation-org-a',
      }),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
  if (res.status !== 201) throw new Error(`Bootstrap failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { organization: { id: string }; pat: string };
  orgAPat = data.pat;
  orgAId = data.organization.id;

  // Org B via fixture.
  const orgB = await createOrgFixture((env.DB as D1Database), 'Isolation Org B', 'isolation-org-b');
  orgBPat = orgB.pat;
  orgBId = orgB.orgId;
});

// ---------------------------------------------------------------------------
// Helpers — create resources in Org A
// ---------------------------------------------------------------------------

async function createAgentInOrgA(suffix: string): Promise<string> {
  const r = await req('POST', '/api/v1/agents', orgAPat, { name: `iso-agent-${suffix}`, kind: 'hermes' });
  if (r.status !== 201) throw new Error(`Agent create failed: ${await r.text()}`);
  return ((await r.json()) as { agent: { id: string } }).agent.id;
}

async function createConnectorInOrgA(suffix: string): Promise<string> {
  const r = await req('POST', '/api/v1/connectors', orgAPat, { name: `iso-connector-${suffix}`, kind: 'notion' });
  if (r.status !== 201) throw new Error(`Connector create failed: ${await r.text()}`);
  return ((await r.json()) as { connector: { id: string } }).connector.id;
}

async function createProjectInOrg(pat: string, suffix: string): Promise<string> {
  const r = await req('POST', '/api/v1/projects', pat, { name: `Iso Project ${suffix}`, slug: `iso-proj-${suffix}` });
  if (r.status !== 201) throw new Error(`Project create failed: ${await r.text()}`);
  return ((await r.json()) as { project: { id: string } }).project.id;
}

async function createTaskInOrg(pat: string, projectId: string, suffix: string): Promise<string> {
  const r = await req('POST', '/api/v1/tasks', pat, { project_id: projectId, title: `Iso Task ${suffix}` });
  if (r.status !== 201) throw new Error(`Task create failed: ${await r.text()}`);
  return ((await r.json()) as { task: { id: string } }).task.id;
}

// ---------------------------------------------------------------------------
// /api/v1/agents — isolation
// ---------------------------------------------------------------------------

describe('isolation: /api/v1/agents', () => {
  let agentId = '';

  beforeAll(async () => {
    agentId = await createAgentInOrgA(`agents-${Date.now()}`);
  });

  it('GET :id — org B gets 404', async () => {
    const r = await req('GET', `/api/v1/agents/${agentId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
  });

  it('PATCH :id — org B gets 404', async () => {
    const r = await req('PATCH', `/api/v1/agents/${agentId}`, orgBPat, { description: 'hacked' });
    expect([403, 404]).toContain(r.status);
  });

  it('DELETE :id — org B gets 404', async () => {
    const r = await req('DELETE', `/api/v1/agents/${agentId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
    // Verify org A's agent still exists.
    const check = await req('GET', `/api/v1/agents/${agentId}`, orgAPat);
    expect(check.status).toBe(200);
  });

  it('list — org B list does not include org A agents', async () => {
    const r = await req('GET', '/api/v1/agents', orgBPat);
    expect(r.status).toBe(200);
    const body = await r.json() as { agents: { id: string }[] };
    const ids = body.agents.map((a) => a.id);
    expect(ids).not.toContain(agentId);
  });
});

// ---------------------------------------------------------------------------
// /api/v1/connectors — isolation
// ---------------------------------------------------------------------------

describe('isolation: /api/v1/connectors', () => {
  let connectorId = '';

  beforeAll(async () => {
    connectorId = await createConnectorInOrgA(`connectors-${Date.now()}`);
  });

  it('GET :id — org B gets 404', async () => {
    const r = await req('GET', `/api/v1/connectors/${connectorId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
  });

  it('PATCH :id — org B gets 404', async () => {
    const r = await req('PATCH', `/api/v1/connectors/${connectorId}`, orgBPat, { description: 'hacked' });
    expect([403, 404]).toContain(r.status);
  });

  it('DELETE :id — org B gets 404', async () => {
    const r = await req('DELETE', `/api/v1/connectors/${connectorId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
    // Verify org A's connector still exists.
    const check = await req('GET', `/api/v1/connectors/${connectorId}`, orgAPat);
    expect(check.status).toBe(200);
  });

  it('list — org B list does not include org A connectors', async () => {
    const r = await req('GET', '/api/v1/connectors', orgBPat);
    expect(r.status).toBe(200);
    const body = await r.json() as { connectors: { id: string }[] };
    const ids = body.connectors.map((c) => c.id);
    expect(ids).not.toContain(connectorId);
  });
});

// ---------------------------------------------------------------------------
// /api/v1/projects — isolation
// ---------------------------------------------------------------------------

describe('isolation: /api/v1/projects', () => {
  let projectId = '';

  beforeAll(async () => {
    projectId = await createProjectInOrg(orgAPat, `projects-${Date.now()}`);
  });

  it('GET :id — org B gets 404', async () => {
    const r = await req('GET', `/api/v1/projects/${projectId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
  });

  it('PATCH :id — org B gets 404', async () => {
    const r = await req('PATCH', `/api/v1/projects/${projectId}`, orgBPat, { description: 'hacked' });
    expect([403, 404]).toContain(r.status);
  });

  it('DELETE :id — org B gets 404', async () => {
    // Use a dedicated project so we don't disrupt other tests.
    const tempProjId = await createProjectInOrg(orgAPat, `del-test-${Date.now()}`);
    const r = await req('DELETE', `/api/v1/projects/${tempProjId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
    // Org A's project must still exist.
    const check = await req('GET', `/api/v1/projects/${tempProjId}`, orgAPat);
    expect(check.status).toBe(200);
  });

  it('list — org B list does not include org A projects', async () => {
    const r = await req('GET', '/api/v1/projects', orgBPat);
    expect(r.status).toBe(200);
    const body = await r.json() as { projects: { id: string }[] };
    const ids = body.projects.map((p) => p.id);
    expect(ids).not.toContain(projectId);
  });
});

// ---------------------------------------------------------------------------
// /api/v1/tasks — isolation
// ---------------------------------------------------------------------------

describe('isolation: /api/v1/tasks', () => {
  let taskId = '';
  let taskProjectId = '';

  beforeAll(async () => {
    taskProjectId = await createProjectInOrg(orgAPat, `tasks-iso-${Date.now()}`);
    taskId = await createTaskInOrg(orgAPat, taskProjectId, `tasks-iso-${Date.now()}`);
  });

  it('GET :id — org B gets 404', async () => {
    const r = await req('GET', `/api/v1/tasks/${taskId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
  });

  it('PATCH :id — org B gets 404', async () => {
    const r = await req('PATCH', `/api/v1/tasks/${taskId}`, orgBPat, { title: 'hacked' });
    expect([403, 404]).toContain(r.status);
  });

  it('DELETE :id — org B gets 404', async () => {
    const tempProjId = await createProjectInOrg(orgAPat, `tasks-del-${Date.now()}`);
    const tempTaskId = await createTaskInOrg(orgAPat, tempProjId, `del-task-${Date.now()}`);
    const r = await req('DELETE', `/api/v1/tasks/${tempTaskId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
    // Org A's task must still exist.
    const check = await req('GET', `/api/v1/tasks/${tempTaskId}`, orgAPat);
    expect(check.status).toBe(200);
  });

  it('list — org B list does not include org A tasks', async () => {
    const r = await req('GET', '/api/v1/tasks', orgBPat);
    expect(r.status).toBe(200);
    const body = await r.json() as { tasks: { id: string }[] };
    const ids = body.tasks.map((t) => t.id);
    expect(ids).not.toContain(taskId);
  });

  it('org B cannot create a task in org A project', async () => {
    // taskProjectId is in org A; org B's PAT should fail
    const r = await req('POST', '/api/v1/tasks', orgBPat, { project_id: taskProjectId, title: 'Stolen task' });
    // Expect 422 (invalid project for that org) or 403/404.
    expect([403, 404, 422]).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------
// /api/v1/tasks/:id/comments — isolation
// ---------------------------------------------------------------------------

describe('isolation: /api/v1/tasks/:taskId/comments', () => {
  let taskId = '';

  beforeAll(async () => {
    const projId = await createProjectInOrg(orgAPat, `comments-iso-${Date.now()}`);
    taskId = await createTaskInOrg(orgAPat, projId, `comments-iso-task-${Date.now()}`);

    // Add a comment in org A.
    const cRes = await req('POST', `/api/v1/tasks/${taskId}/comments`, orgAPat, { body: 'Org A comment' });
    if (cRes.status !== 201) throw new Error(`Comment create failed: ${await cRes.text()}`);
  });

  it('GET comments on org A task — org B gets 404', async () => {
    const r = await req('GET', `/api/v1/tasks/${taskId}/comments`, orgBPat);
    expect([403, 404]).toContain(r.status);
  });

  it('POST comment to org A task — org B gets 404', async () => {
    const r = await req('POST', `/api/v1/tasks/${taskId}/comments`, orgBPat, { body: 'Hacked comment' });
    expect([403, 404]).toContain(r.status);
    // Verify there is still only 1 comment (org A's).
    const check = await req('GET', `/api/v1/tasks/${taskId}/comments`, orgAPat);
    expect(check.status).toBe(200);
    const body = await check.json() as { comments: unknown[] };
    // Should still have exactly 1 comment.
    expect(body.comments.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// /api/v1/external_refs — isolation
// ---------------------------------------------------------------------------

describe('isolation: /api/v1/external_refs', () => {
  let refId = '';
  let xrefProjectId = '';
  let xrefTaskId = '';

  beforeAll(async () => {
    xrefProjectId = await createProjectInOrg(orgAPat, `xref-iso-${Date.now()}`);
    xrefTaskId = await createTaskInOrg(orgAPat, xrefProjectId, `xref-iso-task-${Date.now()}`);

    // Create an external_ref in org A.
    const r = await req('POST', '/api/v1/external_refs', orgAPat, {
      resource_type: 'task',
      resource_id: xrefTaskId,
      source_kind: 'iso-test',
      source_id: `iso-ws-${Date.now()}`,
      external_id: `iso-ext-${Date.now()}`,
    });
    if (r.status !== 201) throw new Error(`External ref create failed: ${await r.text()}`);
    refId = ((await r.json()) as { external_ref: { id: string } }).external_ref.id;
  });

  it('GET list — org B list does not include org A external_refs', async () => {
    const r = await req('GET', '/api/v1/external_refs', orgBPat);
    expect(r.status).toBe(200);
    const body = await r.json() as { external_refs: { id: string }[] };
    const ids = body.external_refs.map((x) => x.id);
    expect(ids).not.toContain(refId);
  });

  it('DELETE :id — org B gets 404', async () => {
    const r = await req('DELETE', `/api/v1/external_refs/${refId}`, orgBPat);
    expect([403, 404]).toContain(r.status);
    // Org A's ref must still be active.
    const checkList = await req('GET', `/api/v1/external_refs?resource_id=${xrefTaskId}`, orgAPat);
    const checkBody = await checkList.json() as { external_refs: { id: string }[] };
    expect(checkBody.external_refs.find((x) => x.id === refId)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Edge case: org A agent querying ?agent_id=<orgB_agent_id>
// ---------------------------------------------------------------------------

describe('isolation: agent_id filter cross-org', () => {
  it('org A PAT querying ?agent_id=<orgB agent id> returns empty (not org B tasks)', async () => {
    // Create agent in org B.
    const orgBAgentRes = await req('POST', '/api/v1/agents', orgBPat, { name: `orgb-filter-agent-${Date.now()}`, kind: 'hermes' });
    if (orgBAgentRes.status !== 201) throw new Error(`OrgB agent failed: ${await orgBAgentRes.text()}`);
    const orgBAgentId = ((await orgBAgentRes.json()) as { agent: { id: string } }).agent.id;

    // Create a project and task in org B assigned to the org B agent.
    const orgBProjId = await createProjectInOrg(orgBPat, `filter-test-proj-${Date.now()}`);
    const orgBTaskRes = await req('POST', '/api/v1/tasks', orgBPat, {
      project_id: orgBProjId,
      title: 'Org B secret task',
      agent_id: orgBAgentId,
    });
    if (orgBTaskRes.status !== 201) throw new Error(`OrgB task failed: ${await orgBTaskRes.text()}`);

    // Org A uses their PAT to query with org B's agent ID as filter.
    const r = await req('GET', `/api/v1/tasks?agent_id=${orgBAgentId}`, orgAPat);
    expect(r.status).toBe(200);
    const body = await r.json() as { tasks: unknown[] };
    // Org A gets an empty list (or only their own tasks — none assigned to orgBAgentId).
    expect(body.tasks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge case: forged cursor from org A replayed against org B
// ---------------------------------------------------------------------------

describe('isolation: cursor forgery rejected', () => {
  it('cursor signed for org A is rejected when used with org B token', async () => {
    const env2 = TEST_ENV as { BETTER_AUTH_SECRET?: string };
    const secret = env2.BETTER_AUTH_SECRET ?? '';

    // Encode a cursor that contains orgAId — signed with the same secret.
    const cursor = await encodeCursor(
      { updatedAt: Date.now(), id: 't_fake', orgId: orgAId },
      secret,
    );

    // Org B uses it on the tasks list endpoint.
    const r = await req('GET', `/api/v1/tasks?cursor=${encodeURIComponent(cursor)}`, orgBPat);
    // Must be rejected: 400 (invalid cursor) or 403/404.
    expect([400, 403, 404]).toContain(r.status);
  });

  it('cursor signed for org B is rejected when used with org A token', async () => {
    const env2 = TEST_ENV as { BETTER_AUTH_SECRET?: string };
    const secret = env2.BETTER_AUTH_SECRET ?? '';

    const cursor = await encodeCursor(
      { updatedAt: Date.now(), id: 't_fake', orgId: orgBId },
      secret,
    );

    const r = await req('GET', `/api/v1/tasks?cursor=${encodeURIComponent(cursor)}`, orgAPat);
    expect([400, 403, 404]).toContain(r.status);
  });
});

// ---------------------------------------------------------------------------
// Comprehensive: org B cannot modify any org A resource even when IDs leak
// ---------------------------------------------------------------------------

describe('isolation: complete round-trip — org B cannot disrupt org A', () => {
  it('after failed delete attempt by org B, org A resource is fully intact', async () => {
    const projId = await createProjectInOrg(orgAPat, `roundtrip-${Date.now()}`);
    const taskId = await createTaskInOrg(orgAPat, projId, `roundtrip-task-${Date.now()}`);

    // Org B attempts to delete.
    await req('DELETE', `/api/v1/tasks/${taskId}`, orgBPat);

    // Org A's task must still be accessible and unmodified.
    const r = await req('GET', `/api/v1/tasks/${taskId}`, orgAPat);
    expect(r.status).toBe(200);
    const body = await r.json() as { task: { id: string; status: string } };
    expect(body.task.id).toBe(taskId);
    expect(body.task.status).toBe('pending');
  });

  it('after failed patch attempt by org B, org A resource is fully intact', async () => {
    const projId = await createProjectInOrg(orgAPat, `roundtrip-patch-${Date.now()}`);
    const taskId = await createTaskInOrg(orgAPat, projId, `roundtrip-patch-task-${Date.now()}`);
    const originalTitle = `roundtrip-patch-task-${Date.now()}`;

    // Create with a specific title.
    const createRes = await req('POST', '/api/v1/tasks', orgAPat, {
      project_id: projId,
      title: originalTitle,
    });
    const { task } = await createRes.json() as { task: { id: string } };

    // Org B attempts to patch the title.
    await req('PATCH', `/api/v1/tasks/${task.id}`, orgBPat, { title: 'Org B Hacked Title' });

    // Org A's task title must be unchanged.
    const r = await req('GET', `/api/v1/tasks/${task.id}`, orgAPat);
    expect(r.status).toBe(200);
    const body = await r.json() as { task: { title: string } };
    expect(body.task.title).toBe(originalTitle);
  });
});
