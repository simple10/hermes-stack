/**
 * Unit tests for orgsRepo.
 *
 * Coverage:
 *   - findById returns the org for ctx.orgId
 *   - findById does not return another org
 *   - update patches the org for ctx.orgId
 *   - update does not affect another org (scope enforcement)
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { db } from '../../../src/db/repos/index.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';
import { ownerCtx, asOrgId } from './_ctx.ts';

let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-org`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

export function orgsRepoTests() {
describe('orgsRepo', () => {
  it('findById returns the org for ctx.orgId', async () => {
    const orgA = await makeOrg('org-a');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const org = await db.orgs(ctx).findById();
    expect(org).not.toBeNull();
    expect(org!.id).toBe(orgA.orgId);
  });

  it('findById with ctxB does not return orgA', async () => {
    const orgA = await makeOrg('org-b');
    const orgB = await makeOrg('org-c');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    const orgViaA = await db.orgs(ctxA).findById();
    const orgViaB = await db.orgs(ctxB).findById();
    // Each ctx only sees its own org.
    expect(orgViaA!.id).toBe(orgA.orgId);
    expect(orgViaB!.id).toBe(orgB.orgId);
    expect(orgViaA!.id).not.toBe(orgViaB!.id);
  });

  it('update patches the org for ctx.orgId', async () => {
    const orgA = await makeOrg('org-d');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const updated = await db.orgs(ctx).update({ name: 'Renamed Org' });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Renamed Org');
    // Verify via another findById call.
    const re = await db.orgs(ctx).findById();
    expect(re!.name).toBe('Renamed Org');
  });

  it('update does not affect another org', async () => {
    const orgA = await makeOrg('org-e');
    const orgB = await makeOrg('org-f');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId);
    await db.orgs(ctxA).update({ name: 'OrgA Renamed' });
    // OrgB should be unaffected.
    const orgB2 = await db.orgs(ctxB).findById();
    expect(orgB2!.name).not.toBe('OrgA Renamed');
  });
});
}
