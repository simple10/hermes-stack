/**
 * Unit tests for commentsRepo.
 *
 * Coverage:
 *   - insert stamps orgId, authorType, authorId from ctx
 *   - findById returns row in same org
 *   - findById returns null for cross-org id
 *   - softDelete with cross-org id returns null
 *   - listByTask returns only comments for that task, ordered asc by createdAt
 *   - list does not surface another org's comments on the same taskId
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { db } from '../../../src/db/repos/index.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';
import { ownerCtx, agentCtx, asOrgId } from './_ctx.ts';
import { makeId } from '../../../src/ids.ts';
import type { Env } from '../../../src/db/client.ts';

beforeAll(async () => {
  await applyD1Migrations((env.DB as D1Database), inject('d1Migrations') as D1Migration[]);
});

let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-cmt`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

describe('commentsRepo', () => {
  it('insert stamps orgId, authorType, authorId from ctx', async () => {
    const orgA = await makeOrg('cmt-a');
    const ctxOwner = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctxOwner).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'T' });
    const comment = await db.comments(ctxOwner).insert({ taskId: task.id, body: 'Hello' });
    expect(comment.orgId).toBe(orgA.orgId);
    expect(comment.authorType).toBe('user');
    expect(comment.authorId).toBe(orgA.userId);
    expect(comment.id).toMatch(/^cmt_/);
  });

  it('insert from agent ctx stamps agent authorType+id', async () => {
    const orgA = await makeOrg('cmt-b');
    const ctxOwner = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctxOwner).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'T2' });
    const agentId = makeId('agent');
    const ctxAgent = agentCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, agentId, orgA.userId);
    const comment = await db.comments(ctxAgent).insert({ taskId: task.id, body: 'Agent says hi' });
    expect(comment.authorType).toBe('agent');
    expect(comment.authorId).toBe(agentId);
  });

  it('findById returns the row in the same org', async () => {
    const orgA = await makeOrg('cmt-c');
    const ctxOwner = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctxOwner).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'T' });
    const comment = await db.comments(ctxOwner).insert({ taskId: task.id, body: 'Find me' });
    const found = await db.comments(ctxOwner).findById(comment.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(comment.id);
  });

  it('findById returns null for a cross-org id', async () => {
    const orgA = await makeOrg('cmt-d');
    const orgB = await makeOrg('cmt-e');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const project = await db.projects(ctxA).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxA).insert({ projectId: project.id, title: 'T' });
    const comment = await db.comments(ctxA).insert({ taskId: task.id, body: 'Secret' });
    expect(await db.comments(ctxB).findById(comment.id)).toBeNull();
  });

  it('softDelete with cross-org id returns null', async () => {
    const orgA = await makeOrg('cmt-f');
    const orgB = await makeOrg('cmt-g');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const project = await db.projects(ctxA).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxA).insert({ projectId: project.id, title: 'T' });
    const comment = await db.comments(ctxA).insert({ taskId: task.id, body: 'Keep' });
    const result = await db.comments(ctxB).softDelete(comment.id);
    expect(result).toBeNull();
    expect(await db.comments(ctxA).findById(comment.id)).not.toBeNull();
  });

  it('listByTask returns all comments for the task', async () => {
    const orgA = await makeOrg('cmt-h');
    const ctxOwner = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctxOwner).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'T' });
    const c1 = await db.comments(ctxOwner).insert({ taskId: task.id, body: 'First' });
    const c2 = await db.comments(ctxOwner).insert({ taskId: task.id, body: 'Second' });
    const list = await db.comments(ctxOwner).listByTask(task.id);
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Both comments appear in the results.
    const ids = list.map((c) => c.id);
    expect(ids).toContain(c1.id);
    expect(ids).toContain(c2.id);
    // All returned comments belong to this task.
    expect(list.every((c) => c.taskId === task.id)).toBe(true);
  });
});
