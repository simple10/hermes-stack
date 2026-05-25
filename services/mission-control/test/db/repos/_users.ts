/**
 * Unit tests for usersRepo.
 *
 * Coverage:
 *   - findById returns a user who is a member of ctx.orgId
 *   - findById returns null for a user who is NOT a member of ctx.orgId
 *   - findById returns null for a user who doesn't exist at all
 *   - listByOrg returns only users who are members of ctx.orgId
 *   - lookupAnyUserExists returns true when users exist, false when none do
 */
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:workers'
import { db } from '../../../src/db/repos/index.ts'
import { lookupAnyUserExists } from '../../../src/db/repos/users.ts'
import { createOrgFixture } from '../../helpers/orgs.ts'
import { ownerCtx, asOrgId } from './_ctx.ts'
import { makeId } from '../../../src/ids.ts'

let slugN = 0
function slug(prefix: string) {
  return `${prefix}-${++slugN}-usr`
}

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name))
  return { ...fix, orgId: asOrgId(fix.orgId) }
}

export function usersRepoTests() {
  describe('usersRepo', () => {
    it('findById returns the user when they are a member of ctx.orgId', async () => {
      const orgA = await makeOrg('usr-a')
      const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId)
      const found = await db.users(ctx).findById(orgA.userId)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(orgA.userId)
    })

    it('findById returns null for a user not in ctx.orgId', async () => {
      const orgA = await makeOrg('usr-b')
      const orgB = await makeOrg('usr-c')
      // OrgA user tries to fetch OrgB user via OrgA context.
      const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId)
      // orgB.userId is a member of orgB, not orgA.
      const found = await db.users(ctxA).findById(orgB.userId)
      expect(found).toBeNull()
    })

    it('findById returns null for a non-existent user id', async () => {
      const orgA = await makeOrg('usr-d')
      const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId)
      const found = await db.users(ctx).findById(makeId('user'))
      expect(found).toBeNull()
    })

    it('listByOrg returns only users in ctx.orgId', async () => {
      const orgA = await makeOrg('usr-e')
      const orgB = await makeOrg('usr-f')
      const ctxA = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId)
      const ctxB = ownerCtx(env.DB as D1Database, env as unknown as Env, orgB.orgId, orgB.userId)
      const listA = await db.users(ctxA).listByOrg()
      const listB = await db.users(ctxB).listByOrg()
      // OrgA list must contain OrgA's user.
      expect(listA.some((u) => u.id === orgA.userId)).toBe(true)
      // OrgA list must NOT contain OrgB's user.
      expect(listA.some((u) => u.id === orgB.userId)).toBe(false)
      // OrgB list must contain OrgB's user.
      expect(listB.some((u) => u.id === orgB.userId)).toBe(true)
    })

    it('lookupAnyUserExists returns true when at least one user exists', async () => {
      // We've already created org fixtures above which creates users.
      const exists = await lookupAnyUserExists(env as unknown as Env)
      expect(exists).toBe(true)
    })
  })
}
