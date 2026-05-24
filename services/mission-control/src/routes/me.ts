/**
 * GET /v1/me — return the resolved auth context for the caller.
 *
 * For agent and connector principals the pool DB row is fetched and included
 * in the response (serialised timestamps).
 */
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { authMiddleware } from '../auth/middleware.ts';
import type { AuthContext } from '../auth/types.ts';
import { agents, connectors } from '../db/pool.ts';
import { active, serializeTimestamps } from '../db/helpers.ts';

type Variables = { auth: AuthContext };

export const me = new Hono<{ Variables: Variables }>();
me.use('*', authMiddleware);

me.get('/', async (c) => {
  const ctx = c.get('auth');

  const base: Record<string, unknown> = {
    org_id: ctx.orgId,
    role: ctx.role,
    principal_type: ctx.principal.type,
    principal_id: ctx.principal.id,
  };

  if (ctx.principal.type === 'agent') {
    const agentRows = await ctx.pool
      .select()
      .from(agents)
      .where(and(eq(agents.id, ctx.principal.id), eq(agents.orgId, ctx.orgId), active(agents)))
      .limit(1);
    const a = agentRows[0];
    if (a) base.agent = serializeTimestamps(a);
  }

  if (ctx.principal.type === 'connector') {
    const connectorRows = await ctx.pool
      .select()
      .from(connectors)
      .where(and(eq(connectors.id, ctx.principal.id), eq(connectors.orgId, ctx.orgId), active(connectors)))
      .limit(1);
    const cn = connectorRows[0];
    if (cn) base.connector = serializeTimestamps(cn);
  }

  return c.json(base);
});
