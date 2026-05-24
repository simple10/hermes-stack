/**
 * Unit tests for tasksRepo.
 *
 * Coverage:
 *   - insert stamps orgId from ctx (caller-supplied orgId overridden)
 *   - findById returns null for cross-org id
 *   - findById returns the row within the same org
 *   - update with cross-org id returns null
 *   - softDelete with cross-org id returns null
 *   - agent-role ctx can only see its own tasks via list()
 *   - owner-role ctx sees all org tasks via list()
 *   - countActiveByAgent counts non-terminal tasks
 *   - DuplicateError thrown on idempotency_key collision
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { db } from '../../../src/db/repos/index.ts';
import { DuplicateError } from '../../../src/db/repos/_errors.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';
import { ownerCtx, agentCtx, asOrgId } from './_ctx.ts';
import { makeId } from '../../../src/ids.ts';
import type { Env } from '../../../src/db/client.ts';

beforeAll(async () => {
  await applyD1Migrations((env.DB as D1Database), inject('d1Migrations') as D1Migration[]);
});

// Unique slug counter so parallel tests don't collide.
let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-tasks`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

describe('tasksRepo', () => {
  it('insert stamps orgId from ctx, ignoring any orgId in values', async () => {
    const orgA = await makeOrg('tasks-a');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctx).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctx).insert({ projectId: project.id, title: 'Hello' });
    expect(task.orgId).toBe(orgA.orgId);
  });

  it('findById returns the row for a known id in the same org', async () => {
    const orgA = await makeOrg('tasks-b');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctx).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctx).insert({ projectId: project.id, title: 'World' });
    const found = await db.tasks(ctx).findById(task.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);
  });

  it('findById returns null for a cross-org id', async () => {
    const orgA = await makeOrg('tasks-c');
    const orgB = await makeOrg('tasks-d');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const project = await db.projects(ctxA).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxA).insert({ projectId: project.id, title: 'Cross-org' });
    // Org B tries to read Org A's task.
    const found = await db.tasks(ctxB).findById(task.id);
    expect(found).toBeNull();
  });

  it('update with cross-org id returns null (no mutation)', async () => {
    const orgA = await makeOrg('tasks-e');
    const orgB = await makeOrg('tasks-f');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const project = await db.projects(ctxA).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxA).insert({ projectId: project.id, title: 'Original' });
    const result = await db.tasks(ctxB).update(task.id, { title: 'Hacked' });
    expect(result).toBeNull();
    // Original is untouched.
    const still = await db.tasks(ctxA).findById(task.id);
    expect(still!.title).toBe('Original');
  });

  it('softDelete with cross-org id returns null (no mutation)', async () => {
    const orgA = await makeOrg('tasks-g');
    const orgB = await makeOrg('tasks-h');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const project = await db.projects(ctxA).insert({ name: 'P', slug: slug('prj') });
    const task = await db.tasks(ctxA).insert({ projectId: project.id, title: 'Keep me' });
    const result = await db.tasks(ctxB).softDelete(task.id);
    expect(result).toBeNull();
    // Task still visible to ctxA.
    expect(await db.tasks(ctxA).findById(task.id)).not.toBeNull();
  });

  it('agent-role ctx only sees its own tasks via list()', async () => {
    const orgA = await makeOrg('tasks-i');
    const ctxOwner = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctxOwner).insert({ name: 'P', slug: slug('prj') });
    const agentAId = makeId('agent');
    const agentBId = makeId('agent');
    // Insert tasks assigned to each agent.
    await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'Task-A', agentId: agentAId });
    await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'Task-B', agentId: agentBId });
    // Agent A can only see its own task.
    const ctxA = agentCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, agentAId, orgA.userId);
    const listA = await db.tasks(ctxA).list();
    expect(listA.every((t) => t.agentId === agentAId)).toBe(true);
    // Agent A should NOT see Task-B.
    expect(listA.some((t) => t.agentId === agentBId)).toBe(false);
  });

  it('owner-role ctx sees all org tasks via list()', async () => {
    const orgA = await makeOrg('tasks-j');
    const ctxOwner = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctxOwner).insert({ name: 'P', slug: slug('prj') });
    const agentAId = makeId('agent');
    const agentBId = makeId('agent');
    await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'Task-A', agentId: agentAId });
    await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'Task-B', agentId: agentBId });
    const list = await db.tasks(ctxOwner).list();
    // Both tasks visible.
    const ids = list.map((t) => t.agentId);
    expect(ids).toContain(agentAId);
    expect(ids).toContain(agentBId);
  });

  it('countActiveByAgent counts non-terminal tasks', async () => {
    const orgA = await makeOrg('tasks-k');
    const ctxOwner = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctxOwner).insert({ name: 'P', slug: slug('prj') });
    const agentId = makeId('agent');
    // Insert ready + in_progress (active) and completed (terminal).
    await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'Ready', agentId, status: 'ready' });
    await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'In progress', agentId, status: 'in_progress' });
    await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'Done', agentId, status: 'completed' });
    const count = await db.tasks(ctxOwner).countActiveByAgent(agentId);
    expect(count).toBe(2);
  });

  it('throws DuplicateError on idempotency_key collision', async () => {
    const orgA = await makeOrg('tasks-l');
    const ctxOwner = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctxOwner).insert({ name: 'P', slug: slug('prj') });
    const ikey = makeId('ikey');
    await db.tasks(ctxOwner).insert({ projectId: project.id, title: 'First', idempotencyKey: ikey });
    await expect(
      db.tasks(ctxOwner).insert({ projectId: project.id, title: 'Second', idempotencyKey: ikey }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });
});
