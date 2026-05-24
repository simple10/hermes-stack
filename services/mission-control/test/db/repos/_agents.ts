/**
 * Unit tests for agentsRepo.
 *
 * Coverage:
 *   - insert stamps orgId from ctx
 *   - findById returns row in same org
 *   - findById returns null for cross-org id
 *   - update with cross-org id returns null
 *   - softDelete with cross-org id returns null
 *   - softDelete with actor override writes system deleter
 *   - list returns only this org's agents
 *   - DuplicateError thrown on name collision within the same org
 *   - same name in different org is allowed
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { db } from '../../../src/db/repos/index.ts';
import { DuplicateError } from '../../../src/db/repos/_errors.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';
import { ownerCtx, asOrgId } from './_ctx.ts';
import type { Env } from '../../../src/db/client.ts';


let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-agts`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

export function agentsRepoTests() {
describe('agentsRepo', () => {
  it('insert stamps orgId from ctx', async () => {
    const orgA = await makeOrg('agt-a');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const agent = await db.agents(ctx).insert({ name: 'Hermes', kind: 'hermes', createdByUserId: orgA.userId });
    expect(agent.orgId).toBe(orgA.orgId);
    expect(agent.id).toMatch(/^agt_/);
  });

  it('findById returns the row in the same org', async () => {
    const orgA = await makeOrg('agt-b');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const agent = await db.agents(ctx).insert({ name: 'Worker', kind: 'claude', createdByUserId: orgA.userId });
    const found = await db.agents(ctx).findById(agent.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(agent.id);
  });

  it('findById returns null for a cross-org id', async () => {
    const orgA = await makeOrg('agt-c');
    const orgB = await makeOrg('agt-d');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const agent = await db.agents(ctxA).insert({ name: 'SecretAgent', kind: 'hermes', createdByUserId: orgA.userId });
    expect(await db.agents(ctxB).findById(agent.id)).toBeNull();
  });

  it('update with cross-org id returns null', async () => {
    const orgA = await makeOrg('agt-e');
    const orgB = await makeOrg('agt-f');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const agent = await db.agents(ctxA).insert({ name: 'OrigName', kind: 'hermes', createdByUserId: orgA.userId });
    const result = await db.agents(ctxB).update(agent.id, { name: 'Stolen' });
    expect(result).toBeNull();
    const still = await db.agents(ctxA).findById(agent.id);
    expect(still!.name).toBe('OrigName');
  });

  it('softDelete with cross-org id returns null', async () => {
    const orgA = await makeOrg('agt-g');
    const orgB = await makeOrg('agt-h');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const agent = await db.agents(ctxA).insert({ name: 'Keepme', kind: 'hermes', createdByUserId: orgA.userId });
    const result = await db.agents(ctxB).softDelete(agent.id);
    expect(result).toBeNull();
    expect(await db.agents(ctxA).findById(agent.id)).not.toBeNull();
  });

  it('softDelete with system actor override writes deleted_by_type=system', async () => {
    const orgA = await makeOrg('agt-i');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const agent = await db.agents(ctx).insert({ name: 'Compensate', kind: 'hermes', createdByUserId: orgA.userId });
    const deleted = await db.agents(ctx).softDelete(agent.id, { type: 'system', id: null });
    expect(deleted).not.toBeNull();
    expect(deleted!.deletedByType).toBe('system');
    expect(deleted!.deletedById).toBeNull();
  });

  it('list returns only this org\'s agents', async () => {
    const orgA = await makeOrg('agt-j');
    const orgB = await makeOrg('agt-k');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    await db.agents(ctxA).insert({ name: 'AgentA', kind: 'hermes', createdByUserId: orgA.userId });
    await db.agents(ctxB).insert({ name: 'AgentB', kind: 'claude', createdByUserId: orgB.userId });
    const listA = await db.agents(ctxA).list();
    expect(listA.every((a) => a.orgId === orgA.orgId)).toBe(true);
    expect(listA.some((a) => a.orgId === orgB.orgId)).toBe(false);
  });

  it('throws DuplicateError on name collision within the same org', async () => {
    const orgA = await makeOrg('agt-l');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    await db.agents(ctx).insert({ name: 'DupAgent', kind: 'hermes', createdByUserId: orgA.userId });
    await expect(
      db.agents(ctx).insert({ name: 'DupAgent', kind: 'claude', createdByUserId: orgA.userId }),
    ).rejects.toBeInstanceOf(DuplicateError);
  });

  it('same name in different org is allowed', async () => {
    const orgA = await makeOrg('agt-m');
    const orgB = await makeOrg('agt-n');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const a = await db.agents(ctxA).insert({ name: 'SharedName', kind: 'hermes', createdByUserId: orgA.userId });
    const b = await db.agents(ctxB).insert({ name: 'SharedName', kind: 'hermes', createdByUserId: orgB.userId });
    expect(a.id).not.toBe(b.id);
  });
});
}
