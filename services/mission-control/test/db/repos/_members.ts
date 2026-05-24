/**
 * Unit tests for membersRepo + lookupMemberRole.
 *
 * Coverage:
 *   - lookupMemberRole returns {role} when user is a member of the org
 *   - lookupMemberRole returns null when user is NOT a member of the org
 *   - membersRepo(ctx).roleForCurrentUser() returns the calling user's role
 *   - membersRepo(ctx).roleForCurrentUser() returns null when no viaUserId
 *   - membersRepo(ctx).list() returns all members of ctx.orgId only
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { db } from '../../../src/db/repos/index.ts';
import { lookupMemberRole } from '../../../src/db/repos/members.ts';
import { createOrgFixture, createMemberFixture } from '../../helpers/orgs.ts';
import { ownerCtx, asOrgId } from './_ctx.ts';
import type { Env } from '../../../src/db/client.ts';


let slugN = 0;
function slug(prefix: string) { return `${prefix}-${++slugN}-mbr`; }

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name));
  return { ...fix, orgId: asOrgId(fix.orgId) };
}

export function membersRepoTests() {
describe('membersRepo + lookupMemberRole', () => {
  it('lookupMemberRole returns {role} when the user is a member', async () => {
    const orgA = await makeOrg('mbr-a');
    const result = await lookupMemberRole(env as unknown as Env, orgA.userId, orgA.orgId);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('owner');
  });

  it('lookupMemberRole returns null when the user is not a member of that org', async () => {
    const orgA = await makeOrg('mbr-b');
    const orgB = await makeOrg('mbr-c');
    // orgA.userId is only a member of orgA, not orgB.
    const result = await lookupMemberRole(env as unknown as Env, orgA.userId, orgB.orgId);
    expect(result).toBeNull();
  });

  it('membersRepo(ctx).roleForCurrentUser() returns the calling user\'s role', async () => {
    const orgA = await makeOrg('mbr-d');
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const result = await db.members(ctx).roleForCurrentUser();
    expect(result).not.toBeNull();
    expect(result!.role).toBe('owner');
  });

  it('membersRepo(ctx).roleForCurrentUser() returns null when no viaUserId', async () => {
    const orgA = await makeOrg('mbr-e');
    // Build a ctx without viaUserId (e.g. an agent key with no user behind it).
    const ctx = {
      orgId: orgA.orgId,
      role: 'agent' as const,
      principal: { type: 'agent' as const, id: 'agt_x' },
      pool: (await import('../../../src/db/client.ts')).poolClient(env.DB as D1Database),
      env: env as unknown as Env,
      // viaUserId deliberately absent
    };
    const result = await db.members(ctx).roleForCurrentUser();
    expect(result).toBeNull();
  });

  it('membersRepo(ctx).list() returns all members of ctx.orgId', async () => {
    const orgA = await makeOrg('mbr-f');
    // Add an extra member to orgA.
    await createMemberFixture(env.DB as D1Database, orgA.orgId, slug('extra'));
    const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const list = await db.members(ctx).list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.every((m) => m.organizationId === orgA.orgId)).toBe(true);
  });

  it('membersRepo(ctx).list() does not include members of another org', async () => {
    const orgA = await makeOrg('mbr-g');
    const orgB = await makeOrg('mbr-h');
    const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId);
    const listA = await db.members(ctxA).list();
    expect(listA.some((m) => m.organizationId === orgB.orgId)).toBe(false);
  });
});
}
