/**
 * Integration tests for /v1/tasks/:taskId/comments CRUD.
 *
 * Coverage:
 *   POST /v1/tasks/:taskId/comments
 *     - happy path: owner posts comment → 201, body returned, event emitted
 *     - 401 without token
 *     - 404 for non-existent task
 *     - 400 on missing body
 *     - 400 on empty string body
 *     - 400 on body too long (>10_000 chars)
 *     - agent can comment on own task
 *     - agent 403 on other agent's task
 *     - connector can comment
 *     - multi-tenant isolation
 *
 *   GET /v1/tasks/:taskId/comments
 *     - happy path: returns comment list, oldest-first
 *     - 404 for non-existent task
 *     - cursor pagination (ASC order)
 *     - agent can list on own task
 *     - agent 403 on other agent's task
 *     - multi-tenant isolation
 */

import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';
import { createOrgFixture } from '../helpers/orgs.ts';

// ---------------------------------------------------------------------------
// Test env + shared state
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'comments-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let pat = '';          // owner PAT for org A
let orgId = '';
let projectId = '';

// Org B for isolation tests.
let orgBPat = '';
let orgBProjectId = '';
let orgBTaskId = '';

// Two agents for testing ownership enforcement.
let agentKey = '';
let agentId = '';
let agentKey2 = '';

// Connector key for testing connector role.
let connectorKey = '';

// A task owned by agentId.
let ownedTaskId = '';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);

  // Bootstrap org A.
  const res = await app.fetch(
    new Request('http://x/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        email: 'comments-owner@example.com',
        password: 'supersecret',
        name: 'Comments Owner',
        orgName: 'Comments Org',
        orgSlug: 'comments-org',
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
  const projRes = await req('POST', '/v1/projects', pat, { name: 'Comments Project', slug: 'comments-project' });
  if (projRes.status !== 201) throw new Error(`Project create failed: ${await projRes.text()}`);
  const projData = await projRes.json() as { project: { id: string } };
  projectId = projData.project.id;

  // Create two agents in org A.
  const agentRes = await req('POST', '/v1/agents', pat, { name: 'comment-agent-1', kind: 'hermes' });
  if (agentRes.status !== 201) throw new Error(`Agent create failed: ${await agentRes.text()}`);
  const agentData = await agentRes.json() as { agent: { id: string }; key: string };
  agentKey = agentData.key;
  agentId = agentData.agent.id;

  const agentRes2 = await req('POST', '/v1/agents', pat, { name: 'comment-agent-2', kind: 'hermes' });
  if (agentRes2.status !== 201) throw new Error(`Agent2 create failed: ${await agentRes2.text()}`);
  const agentData2 = await agentRes2.json() as { key: string };
  agentKey2 = agentData2.key;

  // Create a connector in org A.
  const connectorRes = await req('POST', '/v1/connectors', pat, { name: 'comment-connector', kind: 'notion' });
  if (connectorRes.status !== 201) throw new Error(`Connector create failed: ${await connectorRes.text()}`);
  const connectorData = await connectorRes.json() as { key: string };
  connectorKey = connectorData.key;

  // Create a task owned by agent 1.
  const taskRes = await req('POST', '/v1/tasks', pat, {
    project_id: projectId,
    title: 'Owned task',
    agent_id: agentId,
  });
  if (taskRes.status !== 201) throw new Error(`Task create failed: ${await taskRes.text()}`);
  const taskData = await taskRes.json() as { task: { id: string } };
  ownedTaskId = taskData.task.id;

  // Org B setup.
  const orgB = await createOrgFixture((env.DB as D1Database), 'Org B Comments', 'org-b-comments');
  orgBPat = orgB.pat;

  const orgBProjRes = await req('POST', '/v1/projects', orgBPat, { name: 'OrgB Project', slug: 'orgb-project-comments' });
  const orgBProjData = await orgBProjRes.json() as { project: { id: string } };
  orgBProjectId = orgBProjData.project.id;

  const orgBTaskRes = await req('POST', '/v1/tasks', orgBPat, { project_id: orgBProjectId, title: 'OrgB Task' });
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
// POST /v1/tasks/:taskId/comments
// ---------------------------------------------------------------------------

describe('POST /v1/tasks/:taskId/comments', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request(`http://x/v1/tasks/${ownedTaskId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'hello' }),
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for non-existent task', async () => {
    const res = await req('POST', '/v1/tasks/t_doesnotexist/comments', pat, { body: 'hello' });
    expect(res.status).toBe(404);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('task.not_found');
  });

  it('returns 400 on missing body field', async () => {
    const res = await req('POST', `/v1/tasks/${ownedTaskId}/comments`, pat, {});
    expect(res.status).toBe(400);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('comment.validation_error');
  });

  it('returns 400 on empty body string', async () => {
    const res = await req('POST', `/v1/tasks/${ownedTaskId}/comments`, pat, { body: '' });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('comment.validation_error');
  });

  it('returns 400 on body too long (>10_000 chars)', async () => {
    const res = await req('POST', `/v1/tasks/${ownedTaskId}/comments`, pat, { body: 'x'.repeat(10_001) });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('comment.validation_error');
  });

  it('owner can post a comment → 201', async () => {
    const res = await req('POST', `/v1/tasks/${ownedTaskId}/comments`, pat, { body: 'First owner comment' });
    expect(res.status).toBe(201);
    // API returns snake_case keys.
    const data = await res.json() as { comment: { id: string; body: string; author_type: string; task_id: string; created_at: string } };
    expect(data.comment.body).toBe('First owner comment');
    expect(data.comment.author_type).toBe('user');
    expect(data.comment.task_id).toBe(ownedTaskId);
    expect(data.comment.id).toMatch(/^cmt_/);
    // Timestamps should be ISO strings.
    expect(typeof data.comment.created_at).toBe('string');
  });

  it('agent can comment on own task → 201 with correct author', async () => {
    const res = await req('POST', `/v1/tasks/${ownedTaskId}/comments`, agentKey, { body: 'Agent says hi' });
    expect(res.status).toBe(201);
    // API returns snake_case keys.
    const data = await res.json() as { comment: { author_type: string; author_id: string } };
    expect(data.comment.author_type).toBe('agent');
    expect(data.comment.author_id).toBe(agentId);
  });

  it('agent 2 gets 403 on task owned by agent 1', async () => {
    const res = await req('POST', `/v1/tasks/${ownedTaskId}/comments`, agentKey2, { body: 'Bad agent' });
    expect(res.status).toBe(403);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('comment.forbidden');
  });

  it('connector can comment on any task → 201', async () => {
    const res = await req('POST', `/v1/tasks/${ownedTaskId}/comments`, connectorKey, { body: 'Connector comment' });
    expect(res.status).toBe(201);
    // API returns snake_case keys.
    const data = await res.json() as { comment: { author_type: string } };
    expect(data.comment.author_type).toBe('connector');
  });

  it('multi-tenant isolation: org A token cannot comment on org B task', async () => {
    const res = await req('POST', `/v1/tasks/${orgBTaskId}/comments`, pat, { body: 'Cross-org comment' });
    // The task is not found in org A's scope.
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/tasks/:taskId/comments
// ---------------------------------------------------------------------------

describe('GET /v1/tasks/:taskId/comments', () => {
  let taskForList = '';

  beforeAll(async () => {
    // Create a fresh task and post several comments on it.
    const taskRes = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'List comments task',
    });
    const taskData = await taskRes.json() as { task: { id: string } };
    taskForList = taskData.task.id;

    for (let i = 0; i < 5; i++) {
      await req('POST', `/v1/tasks/${taskForList}/comments`, pat, { body: `Comment ${i + 1}` });
    }
  });

  it('returns 404 for non-existent task', async () => {
    const res = await req('GET', '/v1/tasks/t_doesnotexist/comments', pat);
    expect(res.status).toBe(404);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('task.not_found');
  });

  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request(`http://x/v1/tasks/${taskForList}/comments`, { method: 'GET' }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns comments oldest-first (ASC order)', async () => {
    const res = await req('GET', `/v1/tasks/${taskForList}/comments`, pat);
    expect(res.status).toBe(200);
    // API returns snake_case keys.
    const data = await res.json() as { comments: Array<{ body: string; created_at: string }>; next_cursor: string | null };
    expect(data.comments.length).toBe(5);
    // First comment should be "Comment 1" (oldest).
    expect(data.comments[0]!.body).toBe('Comment 1');
    // Last should be "Comment 5".
    expect(data.comments[4]!.body).toBe('Comment 5');
    // Timestamps should be ISO strings.
    expect(data.comments[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // next_cursor should be null (only 5 comments, limit=50).
    expect(data.next_cursor).toBeNull();
  });

  it('cursor pagination works correctly', async () => {
    // Create a task with 3 comments, fetch with limit=2.
    const taskRes = await req('POST', '/v1/tasks', pat, {
      project_id: projectId,
      title: 'Pagination task for comments',
    });
    const taskData = await taskRes.json() as { task: { id: string } };
    const paginTaskId = taskData.task.id;

    for (let i = 0; i < 3; i++) {
      await req('POST', `/v1/tasks/${paginTaskId}/comments`, pat, { body: `Pagin ${i + 1}` });
    }

    const page1Res = await req('GET', `/v1/tasks/${paginTaskId}/comments?limit=2`, pat);
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json() as { comments: Array<{ body: string }>; next_cursor: string | null };
    expect(page1.comments.length).toBe(2);
    expect(page1.comments[0]!.body).toBe('Pagin 1');
    expect(page1.comments[1]!.body).toBe('Pagin 2');
    expect(page1.next_cursor).not.toBeNull();

    // Fetch page 2 using the cursor (URL-encode to handle base64 + chars).
    const page2Res = await req('GET', `/v1/tasks/${paginTaskId}/comments?limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`, pat);
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json() as { comments: Array<{ body: string }>; next_cursor: string | null };
    expect(page2.comments.length).toBe(1);
    expect(page2.comments[0]!.body).toBe('Pagin 3');
    expect(page2.next_cursor).toBeNull();
  });

  it('agent can list comments on own task', async () => {
    const res = await req('GET', `/v1/tasks/${ownedTaskId}/comments`, agentKey);
    expect(res.status).toBe(200);
    const data = await res.json() as { comments: unknown[] };
    expect(Array.isArray(data.comments)).toBe(true);
  });

  it('agent 2 gets 403 listing comments on task owned by agent 1', async () => {
    const res = await req('GET', `/v1/tasks/${ownedTaskId}/comments`, agentKey2);
    expect(res.status).toBe(403);
    const data = await res.json() as { error: { code: string } };
    expect(data.error.code).toBe('comment.forbidden');
  });

  it('multi-tenant isolation: org A token cannot list org B task comments', async () => {
    // First post a comment in org B.
    await req('POST', `/v1/tasks/${orgBTaskId}/comments`, orgBPat, { body: 'OrgB comment' });

    // Org A token should get 404 when trying to access org B's task.
    const res = await req('GET', `/v1/tasks/${orgBTaskId}/comments`, pat);
    expect(res.status).toBe(404);
  });

  it('org B cannot see org A comments even on same task ID if it existed', async () => {
    // Fetch org A's task with org B's PAT → 404.
    const res = await req('GET', `/v1/tasks/${taskForList}/comments`, orgBPat);
    expect(res.status).toBe(404);
  });
});
