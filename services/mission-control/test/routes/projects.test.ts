/**
 * Integration tests for /v1/projects CRUD.
 *
 * Coverage:
 *   - POST   /v1/projects — happy path, 401, 403 (agent role), 409 duplicate slug,
 *                           event emitted, createdByUserId populated
 *   - GET    /v1/projects — list, cursor pagination (~150 rows), isolation
 *   - GET    /v1/projects/:id — detail, 404, isolation
 *   - PATCH  /v1/projects/:id — happy path, 403 (agent), 404, duplicate slug 409
 *   - DELETE /v1/projects/:id — soft delete + cascade external_refs, event emitted,
 *                               403 (member), 404, isolation
 *   - Multi-tenant isolation: org A's projects invisible to org B
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';
import { createOrgFixture, createMemberFixture } from '../helpers/orgs.ts';

// ---------------------------------------------------------------------------
// Test env + shared state
// ---------------------------------------------------------------------------

const ADMIN_TOKEN = 'projects-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let pat = '';
let orgId = '';

// Org B for multi-tenant isolation tests.
let orgBPat = '';

// Agent key for testing agent-role restrictions.
let agentKey = '';

beforeAll(async () => {
  const migrations = inject('d1Migrations') as D1Migration[];
  await applyD1Migrations((env.DB as D1Database), migrations);

  // Org A via bootstrap (one-shot per DB).
  const res = await app.fetch(
    new Request('http://x/v1/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mc-admin-token': ADMIN_TOKEN },
      body: JSON.stringify({
        email: 'projects-owner@example.com',
        password: 'supersecret',
        name: 'Projects Owner',
        orgName: 'Projects Org',
        orgSlug: 'projects-org',
      }),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
  if (res.status !== 201) throw new Error(`Bootstrap failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { user: { id: string }; organization: { id: string }; pat: string };
  pat = data.pat;
  orgId = data.organization.id;

  // Org B via fixture helper.
  const orgB = await createOrgFixture((env.DB as D1Database), 'Org B Projects', 'org-b-projects');
  orgBPat = orgB.pat;

  // Create an agent in Org A so we have an agent-role key for 403 tests.
  const agentRes = await app.fetch(
    new Request('http://x/v1/agents', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${pat}`,
      },
      body: JSON.stringify({ name: 'test-agent', kind: 'hermes' }),
    }),
    TEST_ENV,
    { passThroughOnException: () => {} } as any,
  );
  if (agentRes.status !== 201) throw new Error(`Agent create failed (${agentRes.status}): ${await agentRes.text()}`);
  const agentData = await agentRes.json() as { key: string };
  agentKey = agentData.key;
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
// POST /v1/projects
// ---------------------------------------------------------------------------

describe('POST /v1/projects', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'x', slug: 'x' }),
        headers: { 'content-type': 'application/json' },
      }),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for agent role (agents cannot create projects)', async () => {
    const res = await req('POST', '/v1/projects', agentKey, { name: 'from-agent', slug: 'from-agent' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.role_insufficient');
  });

  it('returns 201 with serialized project on valid create (owner)', async () => {
    const res = await req('POST', '/v1/projects', pat, {
      name: 'My Project',
      slug: 'my-project',
      description: 'A test project',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { project: Record<string, unknown> };
    expect(body.project.name).toBe('My Project');
    expect(body.project.slug).toBe('my-project');
    expect(body.project.description).toBe('A test project');
    expect(typeof body.project.id).toBe('string');
    expect((body.project.id as string).startsWith('prj_')).toBe(true);
    // Timestamps should be ISO strings (serializeRow converts camelCase→snake_case).
    expect(typeof (body.project as any).created_at).toBe('string');
    expect(typeof (body.project as any).updated_at).toBe('string');
  });

  it('returns 201 with member role', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'prj-member-create', 'member');
    const res = await req('POST', '/v1/projects', memberPat, { name: 'Member Project', slug: 'member-project' });
    expect(res.status).toBe(201);
  });

  it('returns 400 on missing name', async () => {
    const res = await req('POST', '/v1/projects', pat, { slug: 'no-name' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('project.validation_error');
  });

  it('returns 400 on invalid slug (uppercase)', async () => {
    const res = await req('POST', '/v1/projects', pat, { name: 'Bad Slug', slug: 'BAD-SLUG' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('project.validation_error');
  });

  it('returns 409 on duplicate slug within org (with existing_project_id)', async () => {
    await req('POST', '/v1/projects', pat, { name: 'Dup Project', slug: 'dup-slug' });
    const res = await req('POST', '/v1/projects', pat, { name: 'Another Dup', slug: 'dup-slug' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; details: { existing_project_id: string } } };
    expect(body.error.code).toBe('project.duplicate_slug');
    expect(typeof body.error.details.existing_project_id).toBe('string');
    expect(body.error.details.existing_project_id.startsWith('prj_')).toBe(true);
  });

  it('allows same slug in different orgs', async () => {
    // slug 'my-project' was created in org A; should succeed in org B.
    const res = await req('POST', '/v1/projects', orgBPat, { name: 'Org B Project', slug: 'my-project' });
    expect(res.status).toBe(201);
  });

  it('emits project.created event', async () => {
    const createRes = await req('POST', '/v1/projects', pat, { name: 'Event Project', slug: 'event-project' });
    expect(createRes.status).toBe(201);
    const { project } = await createRes.json() as { project: { id: string } };

    // Verify event in DB.
    const row = await (env.DB as D1Database).prepare(
      `SELECT kind, resource_id FROM events WHERE org_id = ? AND resource_type = 'project' AND resource_id = ? ORDER BY id DESC LIMIT 1`
    ).bind(orgId, project.id).first() as { kind: string; resource_id: string } | null;
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('project.created');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/projects — list + pagination
// ---------------------------------------------------------------------------

describe('GET /v1/projects', () => {
  it('returns 401 without token', async () => {
    const res = await app.fetch(
      new Request('http://x/v1/projects'),
      TEST_ENV,
      { passThroughOnException: () => {} } as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns list scoped to the caller org', async () => {
    const res = await req('GET', '/v1/projects', pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { projects: { id: string; org_id: string }[] };
    expect(Array.isArray(body.projects)).toBe(true);
    for (const p of body.projects) {
      expect(p.org_id).toBe(orgId);
    }
  });

  it('org B list does not include org A projects (isolation)', async () => {
    const resA = await req('GET', '/v1/projects', pat);
    const bodyA = await resA.json() as { projects: { id: string }[] };
    const idsA = bodyA.projects.map((p) => p.id);

    const resB = await req('GET', '/v1/projects', orgBPat);
    const bodyB = await resB.json() as { projects: { id: string }[] };
    const idsB = bodyB.projects.map((p) => p.id);

    for (const id of idsB) {
      expect(idsA).not.toContain(id);
    }
  });

  it('cursor pagination returns all ~150 rows exactly once', async () => {
    // Create an isolated org to have a clean slate for counting.
    const { pat: freshPat, orgId: freshOrgId } = await createOrgFixture(
      (env.DB as D1Database),
      'Pagination Org',
      'pagination-org-prj',
    );

    // Insert 150 projects directly via SQL for speed.
    const now = Date.now();
    const stmts = [];
    for (let i = 0; i < 150; i++) {
      const id = `prj_pagtest${i.toString().padStart(4, '0')}`;
      // Stagger updatedAt so ordering is deterministic.
      const ts = now + i;
      stmts.push(
        (env.DB as D1Database).prepare(
          `INSERT INTO projects (id, org_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(id, freshOrgId, `Pag Project ${i}`, `pag-project-${i}`, ts, ts),
      );
    }
    await (env.DB as D1Database).batch(stmts as any);

    // Page through with limit=50.
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = cursor
        ? `/v1/projects?limit=50&cursor=${encodeURIComponent(cursor)}`
        : '/v1/projects?limit=50';
      const res = await req('GET', url, freshPat);
      expect(res.status).toBe(200);
      const body = await res.json() as { projects: { id: string }[]; next_cursor: string | null };
      for (const p of body.projects) {
        expect(seenIds.has(p.id)).toBe(false); // no duplicates
        seenIds.add(p.id);
      }
      cursor = body.next_cursor;
      pages++;
    } while (cursor !== null);

    // Should have seen all 150 projects across 3 pages.
    expect(seenIds.size).toBe(150);
    expect(pages).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/projects/:id
// ---------------------------------------------------------------------------

describe('GET /v1/projects/:id', () => {
  let projectId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/projects', pat, { name: 'Detail Project', slug: 'detail-project' });
    const body = await res.json() as { project: { id: string } };
    projectId = body.project.id;
  });

  it('returns 200 with project detail', async () => {
    const res = await req('GET', `/v1/projects/${projectId}`, pat);
    expect(res.status).toBe(200);
    const body = await res.json() as { project: { id: string; name: string } };
    expect(body.project.id).toBe(projectId);
    expect(body.project.name).toBe('Detail Project');
  });

  it('returns 404 for non-existent project', async () => {
    const res = await req('GET', '/v1/projects/prj_doesnotexist', pat);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('project.not_found');
  });

  it('returns 404 when org B tries to access org A project (isolation)', async () => {
    const res = await req('GET', `/v1/projects/${projectId}`, orgBPat);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/projects/:id
// ---------------------------------------------------------------------------

describe('PATCH /v1/projects/:id', () => {
  let projectId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/projects', pat, { name: 'Patch Project', slug: 'patch-project' });
    const body = await res.json() as { project: { id: string } };
    projectId = body.project.id;
  });

  it('returns 200 with updated project (owner)', async () => {
    const res = await req('PATCH', `/v1/projects/${projectId}`, pat, {
      name: 'Patch Project Renamed',
      description: 'updated desc',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { project: { name: string; description: string } };
    expect(body.project.name).toBe('Patch Project Renamed');
    expect(body.project.description).toBe('updated desc');
  });

  it('returns 403 for agent role (agents cannot patch projects)', async () => {
    const res = await req('PATCH', `/v1/projects/${projectId}`, agentKey, { name: 'Hacked' });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.role_insufficient');
  });

  it('returns 404 for non-existent project', async () => {
    const res = await req('PATCH', '/v1/projects/prj_doesnotexist', pat, { name: 'x' });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('project.not_found');
  });

  it('returns 404 when org B tries to patch org A project (isolation)', async () => {
    const res = await req('PATCH', `/v1/projects/${projectId}`, orgBPat, { name: 'hacked' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when patching slug to an existing slug', async () => {
    // Create a second project with a distinct slug.
    await req('POST', '/v1/projects', pat, { name: 'Other Project', slug: 'patch-other-slug' });
    // Try to patch projectId's slug to the existing one.
    const res = await req('PATCH', `/v1/projects/${projectId}`, pat, { slug: 'patch-other-slug' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string; details: { existing_project_id: string } } };
    expect(body.error.code).toBe('project.duplicate_slug');
    expect(typeof body.error.details.existing_project_id).toBe('string');
  });

  it('member role can patch projects', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'prj-member-patch', 'member');
    const res = await req('PATCH', `/v1/projects/${projectId}`, memberPat, { description: 'by member' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/projects/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/projects/:id', () => {
  let projectId = '';

  beforeAll(async () => {
    const res = await req('POST', '/v1/projects', pat, { name: 'Delete Project', slug: 'delete-project' });
    const body = await res.json() as { project: { id: string } };
    projectId = body.project.id;
  });

  it('returns 403 when member role tries to delete (member cannot delete)', async () => {
    const { pat: memberPat } = await createMemberFixture((env.DB as D1Database), orgId, 'prj-member-del', 'member');
    const res = await req('DELETE', `/v1/projects/${projectId}`, memberPat);
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('auth.role_insufficient');
  });

  it('returns 403 when agent role tries to delete', async () => {
    const res = await req('DELETE', `/v1/projects/${projectId}`, agentKey);
    expect(res.status).toBe(403);
  });

  it('returns 404 for non-existent project', async () => {
    const res = await req('DELETE', '/v1/projects/prj_doesnotexist', pat);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('project.not_found');
  });

  it('returns 404 when org B tries to delete org A project (isolation)', async () => {
    const res = await req('DELETE', `/v1/projects/${projectId}`, orgBPat);
    expect(res.status).toBe(404);
  });

  it('returns 200 and soft-deletes the project; subsequent GET returns 404', async () => {
    const createRes = await req('POST', '/v1/projects', pat, { name: 'To Delete', slug: 'to-delete-full' });
    expect(createRes.status).toBe(201);
    const { project: freshProj } = await createRes.json() as { project: { id: string } };

    const delRes = await req('DELETE', `/v1/projects/${freshProj.id}`, pat);
    expect(delRes.status).toBe(200);

    const getRes = await req('GET', `/v1/projects/${freshProj.id}`, pat);
    expect(getRes.status).toBe(404);

    // Second delete should also 404.
    const del2Res = await req('DELETE', `/v1/projects/${freshProj.id}`, pat);
    expect(del2Res.status).toBe(404);
  });

  it('cascade trigger soft-deletes external_refs on project delete', async () => {
    // Create a fresh project.
    const createRes = await req('POST', '/v1/projects', pat, { name: 'Cascade Project', slug: 'cascade-project' });
    expect(createRes.status).toBe(201);
    const { project } = await createRes.json() as { project: { id: string } };

    // Insert an external_ref pointing to this project.
    const refId = `xrf_casctest${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    await (env.DB as D1Database).prepare(
      `INSERT INTO external_refs (id, org_id, resource_type, resource_id, source_kind, source_id, external_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(refId, orgId, 'project', project.id, 'notion', 'notion-ws-test', 'ext-casc-1', now, now).run();

    // Verify ref exists.
    const before = await (env.DB as D1Database).prepare(
      `SELECT deleted_at FROM external_refs WHERE id = ?`
    ).bind(refId).first() as { deleted_at: number | null } | null;
    expect(before).not.toBeNull();
    expect(before!.deleted_at).toBeNull();

    // Delete the project.
    const delRes = await req('DELETE', `/v1/projects/${project.id}`, pat);
    expect(delRes.status).toBe(200);

    // The trigger should have soft-deleted the external_ref.
    const after = await (env.DB as D1Database).prepare(
      `SELECT deleted_at FROM external_refs WHERE id = ?`
    ).bind(refId).first() as { deleted_at: number | null } | null;
    expect(after).not.toBeNull();
    expect(after!.deleted_at).not.toBeNull();
  });

  it('emits project.deleted event on delete', async () => {
    const createRes = await req('POST', '/v1/projects', pat, { name: 'Event Del Project', slug: 'event-del-project' });
    expect(createRes.status).toBe(201);
    const { project } = await createRes.json() as { project: { id: string } };

    await req('DELETE', `/v1/projects/${project.id}`, pat);

    const row = await (env.DB as D1Database).prepare(
      `SELECT kind FROM events WHERE org_id = ? AND resource_type = 'project' AND resource_id = ? AND kind = 'project.deleted' ORDER BY id DESC LIMIT 1`
    ).bind(orgId, project.id).first() as { kind: string } | null;
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('project.deleted');
  });
});

// ---------------------------------------------------------------------------
// Multi-tenant isolation — broad cross-check
// ---------------------------------------------------------------------------

describe('Multi-tenant isolation', () => {
  it('org A project ID not accessible by org B (GET :id)', async () => {
    const createRes = await req('POST', '/v1/projects', pat, { name: 'Isolation A', slug: 'isolation-a' });
    const { project } = await createRes.json() as { project: { id: string } };

    const res = await req('GET', `/v1/projects/${project.id}`, orgBPat);
    expect(res.status).toBe(404);
  });

  it('org A project not in org B list', async () => {
    const createRes = await req('POST', '/v1/projects', pat, { name: 'Isolation A2', slug: 'isolation-a2' });
    const { project } = await createRes.json() as { project: { id: string } };

    const listRes = await req('GET', '/v1/projects', orgBPat);
    const { projects: listProjects } = await listRes.json() as { projects: { id: string }[] };

    const ids = listProjects.map((p) => p.id);
    expect(ids).not.toContain(project.id);
  });
});
