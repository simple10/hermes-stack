/**
 * Unit tests for eventsRepo.
 *
 * Coverage:
 *   - emit inserts a row with orgId, actorType, actorId from ctx
 *   - emit inserts multiple rows (append-only, no dedup)
 *   - payload is JSON-serialized
 *   - emit with no payload stores null
 */
import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:workers'
import { db } from '../../../src/db/repos/index.ts'
import { createOrgFixture } from '../../helpers/orgs.ts'
import { ownerCtx, agentCtx, asOrgId } from './_ctx.ts'
import { makeId } from '../../../src/ids.ts'
import { poolClient } from '../../../src/db/client.ts'
import { events } from '../../../src/db/pool.ts'
import { eq } from 'drizzle-orm'

let slugN = 0
function slug(prefix: string) {
  return `${prefix}-${++slugN}-evt`
}

async function makeOrg(name: string) {
  const fix = await createOrgFixture(env.DB as D1Database, name, slug(name))
  return { ...fix, orgId: asOrgId(fix.orgId) }
}

export function eventsRepoTests() {
  describe('eventsRepo', () => {
    it('emit inserts a row with orgId + actor from ctx', async () => {
      const orgA = await makeOrg('evt-a')
      const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId)
      const resourceId = makeId('t')
      await db.events(ctx).emit({ resourceType: 'task', resourceId, kind: 'task.created' })

      // Verify via direct query.
      const pool = poolClient(env.DB as D1Database)
      const rows = await pool.select().from(events).where(eq(events.resourceId, resourceId))
      expect(rows.length).toBe(1)
      expect(rows[0]!.orgId).toBe(orgA.orgId)
      expect(rows[0]!.actorType).toBe('user')
      expect(rows[0]!.actorId).toBe(orgA.userId)
      expect(rows[0]!.kind).toBe('task.created')
    })

    it('emit from agent ctx stamps agent actorType+id', async () => {
      const orgA = await makeOrg('evt-b')
      const agentId = makeId('agent')
      const ctxAgent = agentCtx(
        env.DB as D1Database,
        env as unknown as Env,
        orgA.orgId,
        agentId,
        orgA.userId,
      )
      const resourceId = makeId('t')
      await db.events(ctxAgent).emit({ resourceType: 'task', resourceId, kind: 'task.updated' })

      const pool = poolClient(env.DB as D1Database)
      const rows = await pool.select().from(events).where(eq(events.resourceId, resourceId))
      expect(rows.length).toBe(1)
      expect(rows[0]!.actorType).toBe('agent')
      expect(rows[0]!.actorId).toBe(agentId)
    })

    it('emit serializes payload to JSON', async () => {
      const orgA = await makeOrg('evt-c')
      const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId)
      const resourceId = makeId('t')
      const payload = { status: 'completed', prevStatus: 'in_progress' }
      await db
        .events(ctx)
        .emit({ resourceType: 'task', resourceId, kind: 'task.status_changed', payload })

      const pool = poolClient(env.DB as D1Database)
      const rows = await pool.select().from(events).where(eq(events.resourceId, resourceId))
      expect(rows.length).toBe(1)
      expect(JSON.parse(rows[0]!.payload!)).toEqual(payload)
    })

    it('emit with no payload stores null', async () => {
      const orgA = await makeOrg('evt-d')
      const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId)
      const resourceId = makeId('t')
      await db.events(ctx).emit({ resourceType: 'task', resourceId, kind: 'task.deleted' })

      const pool = poolClient(env.DB as D1Database)
      const rows = await pool.select().from(events).where(eq(events.resourceId, resourceId))
      expect(rows.length).toBe(1)
      expect(rows[0]!.payload).toBeNull()
    })

    it('emit is append-only — multiple calls create multiple rows', async () => {
      const orgA = await makeOrg('evt-e')
      const ctx = ownerCtx(env.DB as D1Database, env as unknown as Env, orgA.orgId, orgA.userId)
      const resourceId = makeId('t')
      await db.events(ctx).emit({ resourceType: 'task', resourceId, kind: 'task.created' })
      await db.events(ctx).emit({ resourceType: 'task', resourceId, kind: 'task.updated' })

      const pool = poolClient(env.DB as D1Database)
      const rows = await pool.select().from(events).where(eq(events.resourceId, resourceId))
      expect(rows.length).toBe(2)
    })
  })
}
