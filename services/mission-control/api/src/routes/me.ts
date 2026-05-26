/**
 * GET /v1/me — return the resolved auth context for the caller.
 *
 * For agent and connector principals the pool DB row is fetched and included
 * in the response (serialised timestamps).
 */
import { Hono } from 'hono'
import type { AuthContext } from '../auth/types.ts'
import { serializeTimestamps } from '../db/helpers.ts'
import { db } from '../db/repos/index.ts'

type Variables = { auth: AuthContext }

// authMiddleware is applied at the /api/v1 parent in src/index.ts.
export const me = new Hono<{ Bindings: Env; Variables: Variables }>()

me.get('/', async (c) => {
  const ctx = c.get('auth')

  const base: Record<string, unknown> = {
    org_id: ctx.orgId,
    role: ctx.role,
    principal_type: ctx.principal.type,
    principal_id: ctx.principal.id,
  }

  if (ctx.principal.type === 'agent') {
    const agent = await db.agents(ctx).findById(ctx.principal.id)
    if (agent) base.agent = serializeTimestamps(agent)
  }

  if (ctx.principal.type === 'connector') {
    const connector = await db.connectors(ctx).findById(ctx.principal.id)
    if (connector) base.connector = serializeTimestamps(connector)
  }

  return c.json(base)
})
