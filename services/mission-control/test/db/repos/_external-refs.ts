/**
 * Unit tests for externalRefsRepo.
 *
 * Coverage:
 *   - insert stamps orgId from ctx
 *   - findById returns row in same org
 *   - findById returns null for cross-org id
 *   - softDelete with cross-org id returns null
 *   - list returns only this org's refs
 *   - DuplicateError thrown on unique tuple collision
 *   - ForbiddenError thrown when agent inserts ref with mismatched source_id
 *   - ForbiddenError thrown when connector inserts ref with mismatched source_id
 *   - owner ctx can insert ref with any source_id (no restriction)
 *   - countBySource counts active refs for a given sourceId
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { db } from '../../../src/db/repos/index.ts';
import { DuplicateError, ForbiddenError } from '../../../src/db/repos/_errors.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';
import { ownerCtx, agentCtx, connectorCtx, asOrgId } from './_ctx.ts';
import { makeId } from '../../../src/ids.ts';

let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-xrf`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

function exampleRef(overrides: Partial<{
  resourceType: string; resourceId: string; sourceKind: string; sourceId: string; externalId: string;
}> = {}) {
  return {
    resourceType: 'task',
    resourceId: makeId('t'),
    sourceKind: 'notion',
    sourceId: makeId('notion'),
    externalId: makeId('ext'),
    ...overrides,
  };
}

export function externalRefsRepoTests() {
describe('externalRefsRepo', () => {
  it('insert stamps orgId from ctx', async () => {
    const orgA = await makeOrg('xrf-a');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ref = await db.externalRefs(ctx).insert(exampleRef());
    expect(ref.orgId).toBe(orgA.orgId);
    expect(ref.id).toMatch(/^xrf_/);
  });

  it('findById returns row in same org', async () => {
    const orgA = await makeOrg('xrf-b');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ref = await db.externalRefs(ctx).insert(exampleRef());
    const found = await db.externalRefs(ctx).findById(ref.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(ref.id);
  });

  it('findById returns null for cross-org id', async () => {
    const orgA = await makeOrg('xrf-c');
    const orgB = await makeOrg('xrf-d');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const ref = await db.externalRefs(ctxA).insert(exampleRef());
    expect(await db.externalRefs(ctxB).findById(ref.id)).toBeNull();
  });

  it('softDelete with cross-org id returns null', async () => {
    const orgA = await makeOrg('xrf-e');
    const orgB = await makeOrg('xrf-f');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const ref = await db.externalRefs(ctxA).insert(exampleRef());
    const result = await db.externalRefs(ctxB).softDelete(ref.id);
    expect(result).toBeNull();
    expect(await db.externalRefs(ctxA).findById(ref.id)).not.toBeNull();
  });

  it('list returns only this org\'s refs', async () => {
    const orgA = await makeOrg('xrf-g');
    const orgB = await makeOrg('xrf-h');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    await db.externalRefs(ctxA).insert(exampleRef());
    await db.externalRefs(ctxB).insert(exampleRef());
    const listA = await db.externalRefs(ctxA).list();
    expect(listA.every((r) => r.orgId === orgA.orgId)).toBe(true);
    expect(listA.some((r) => r.orgId === orgB.orgId)).toBe(false);
  });

  it('throws DuplicateError on unique tuple collision', async () => {
    const orgA = await makeOrg('xrf-i');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const base = exampleRef();
    await db.externalRefs(ctx).insert(base);
    // Same (resourceType, resourceId, sourceKind, sourceId) → duplicate.
    await expect(
      db.externalRefs(ctx).insert({ ...base, externalId: makeId('ext2') }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('throws ForbiddenError when agent inserts ref with mismatched source_id', async () => {
    const orgA = await makeOrg('xrf-j');
    const agentId = makeId('agent');
    const ctxAgent = agentCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, agentId, orgA.userId);
    await expect(
      db.externalRefs(ctxAgent).insert({
        resourceType: 'task',
        resourceId: makeId('t'),
        sourceKind: 'notion',
        sourceId: makeId('other-agent'), // mismatched
        externalId: makeId('ext'),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('throws ForbiddenError when connector inserts ref with mismatched source_id', async () => {
    const orgA = await makeOrg('xrf-k');
    const connectorId = makeId('cnn');
    const ctxCnn = connectorCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, connectorId, orgA.userId);
    await expect(
      db.externalRefs(ctxCnn).insert({
        resourceType: 'task',
        resourceId: makeId('t'),
        sourceKind: 'linear',
        sourceId: makeId('other-cnn'), // mismatched
        externalId: makeId('ext'),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('agent ctx can insert ref when source_id matches its own id', async () => {
    const orgA = await makeOrg('xrf-l');
    const agentId = makeId('agent');
    const ctxAgent = agentCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, agentId, orgA.userId);
    const ref = await db.externalRefs(ctxAgent).insert({
      resourceType: 'task',
      resourceId: makeId('t'),
      sourceKind: 'hermes',
      sourceId: agentId, // matches
      externalId: makeId('ext'),
    });
    expect(ref.sourceId).toBe(agentId);
  });

  it('countBySource counts active refs for a given sourceId', async () => {
    const orgA = await makeOrg('xrf-m');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const sourceId = makeId('notion');
    const resourceId1 = makeId('t');
    const resourceId2 = makeId('t');
    await db.externalRefs(ctx).insert({ resourceType: 'task', resourceId: resourceId1, sourceKind: 'notion', sourceId, externalId: makeId('e') });
    await db.externalRefs(ctx).insert({ resourceType: 'task', resourceId: resourceId2, sourceKind: 'notion', sourceId, externalId: makeId('e') });
    const count = await db.externalRefs(ctx).countBySource(sourceId);
    expect(count).toBe(2);
  });
});
}
