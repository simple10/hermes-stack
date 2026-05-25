/**
 * Unit tests for projectsRepo.
 *
 * Coverage:
 *   - insert stamps orgId from ctx
 *   - findById returns row in same org
 *   - findById returns null for cross-org id
 *   - update with cross-org id returns null
 *   - softDelete with cross-org id returns null
 *   - list returns only this org's projects
 *   - DuplicateError thrown on slug collision within same org
 *   - same slug in different org is allowed
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { db } from '../../../src/db/repos/index.ts';
import { DuplicateError } from '../../../src/db/repos/_errors.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';
import { ownerCtx, asOrgId } from './_ctx.ts';

let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-proj`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

export function projectsRepoTests() {
describe('projectsRepo', () => {
  it('insert stamps orgId from ctx', async () => {
    const orgA = await makeOrg('proj-a');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctx).insert({ name: 'Test Project', slug: slug('tp') });
    expect(project.orgId).toBe(orgA.orgId);
    expect(project.id).toMatch(/^prj_/);
  });

  it('findById returns the row in the same org', async () => {
    const orgA = await makeOrg('proj-b');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const project = await db.projects(ctx).insert({ name: 'P2', slug: slug('p2') });
    const found = await db.projects(ctx).findById(project.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(project.id);
  });

  it('findById returns null for a cross-org id', async () => {
    const orgA = await makeOrg('proj-c');
    const orgB = await makeOrg('proj-d');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const project = await db.projects(ctxA).insert({ name: 'Secret', slug: slug('secret') });
    expect(await db.projects(ctxB).findById(project.id)).toBeNull();
  });

  it('update with cross-org id returns null', async () => {
    const orgA = await makeOrg('proj-e');
    const orgB = await makeOrg('proj-f');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const project = await db.projects(ctxA).insert({ name: 'OA Project', slug: slug('oa') });
    const result = await db.projects(ctxB).update(project.id, { name: 'Stolen' });
    expect(result).toBeNull();
    const still = await db.projects(ctxA).findById(project.id);
    expect(still!.name).toBe('OA Project');
  });

  it('softDelete with cross-org id returns null', async () => {
    const orgA = await makeOrg('proj-g');
    const orgB = await makeOrg('proj-h');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const project = await db.projects(ctxA).insert({ name: 'Keep', slug: slug('keep') });
    const result = await db.projects(ctxB).softDelete(project.id);
    expect(result).toBeNull();
    expect(await db.projects(ctxA).findById(project.id)).not.toBeNull();
  });

  it('list returns only this org\'s projects', async () => {
    const orgA = await makeOrg('proj-i');
    const orgB = await makeOrg('proj-j');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    await db.projects(ctxA).insert({ name: 'OA', slug: slug('oa2') });
    await db.projects(ctxB).insert({ name: 'OB', slug: slug('ob') });
    const listA = await db.projects(ctxA).list();
    expect(listA.every((p) => p.orgId === orgA.orgId)).toBe(true);
    expect(listA.some((p) => p.orgId === orgB.orgId)).toBe(false);
  });

  it('throws DuplicateError on slug collision within the same org', async () => {
    const orgA = await makeOrg('proj-k');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const s = slug('dup');
    await db.projects(ctx).insert({ name: 'First', slug: s });
    await expect(
      db.projects(ctx).insert({ name: 'Second', slug: s }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('same slug in different org is allowed', async () => {
    const orgA = await makeOrg('proj-l');
    const orgB = await makeOrg('proj-m');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const s = slug('shared');
    const pa = await db.projects(ctxA).insert({ name: 'OA', slug: s });
    const pb = await db.projects(ctxB).insert({ name: 'OB', slug: s });
    expect(pa.id).not.toBe(pb.id);
  });
});
}
