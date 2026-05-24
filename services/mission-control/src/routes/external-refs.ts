/**
 * /v1/external_refs — External refs CRUD.
 *
 * Endpoints:
 *   POST   /v1/external_refs        — create a ref (any authenticated role)
 *   GET    /v1/external_refs        — list with filters (any authenticated role)
 *   DELETE /v1/external_refs/:id    — soft delete
 *
 * Role enforcement:
 *   POST:
 *     - agent role: source_id MUST equal principal.id → 403 otherwise
 *     - connector role: source_id MUST equal principal.id → 403 otherwise
 *     - owner|admin|member: any source_id allowed
 *   DELETE:
 *     - owner|admin|member|connector: can delete any ref in the org
 *     - agent: can only delete refs where source_id == principal.id → 403 otherwise
 *
 * Resource existence validation on POST:
 *   resource_type='task'      → check tasks
 *   resource_type='project'   → check projects
 *   resource_type='agent'     → check agents
 *   resource_type='connector' → check connectors
 *   resource_type='comment'   → check task_comments
 *
 * 409 external_ref.duplicate if (resource_type, resource_id, source_kind, source_id)
 *   collides with an active row (unique index enforces this).
 *
 * Emits:
 *   external_ref.added on POST
 *   external_ref.removed (with {ref_id}) on DELETE
 *
 * Pagination: DESC by (createdAt, id) — newest first, matching most other lists.
 * Cursor payload: { createdAt, id, orgId }
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, or, lt, desc, asc } from 'drizzle-orm';
import { authMiddleware, requireAnyRole } from '../auth/middleware.ts';
import { externalRefs, tasks, projects, agents, connectors, taskComments } from '../db/pool.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { makeId } from '../ids.ts';
import { active, serializeTimestamps } from '../db/helpers.ts';
import { emitEvent } from '../events/emit.ts';
import { encodeCursor, decodeCursor, clampLimit } from '../pagination.ts';
import type { AuthContext } from '../auth/types.ts';

type Variables = { auth: AuthContext };

export const externalRefsRouter = new Hono<{ Variables: Variables }>();
externalRefsRouter.use('*', authMiddleware);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RESOURCE_TYPES = ['task', 'project', 'agent', 'connector', 'comment'] as const;

const createBody = z.object({
  resource_type: z.enum(RESOURCE_TYPES),
  resource_id: z.string().min(1),
  source_kind: z.string().min(1).max(50),
  source_id: z.string().min(1).max(200),
  external_id: z.string().min(1).max(500),
  external_url: z.string().url().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listQuery = z.object({
  resource_type: z.enum(RESOURCE_TYPES).optional(),
  resource_id: z.string().optional(),
  source_kind: z.string().optional(),
  source_id: z.string().optional(),
  external_id: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Resource existence validation helper
// ---------------------------------------------------------------------------

async function validateResourceExists(
  ctx: AuthContext,
  resource_type: typeof RESOURCE_TYPES[number],
  resource_id: string,
): Promise<void> {
  let found = false;

  switch (resource_type) {
    case 'task': {
      const taskRows = await ctx.pool
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, resource_id), eq(tasks.orgId, ctx.orgId), active(tasks)))
        .limit(1);
      found = taskRows.length > 0;
      break;
    }
    case 'project': {
      const projectRows = await ctx.pool
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, resource_id), eq(projects.orgId, ctx.orgId), active(projects)))
        .limit(1);
      found = projectRows.length > 0;
      break;
    }
    case 'agent': {
      const agentRows = await ctx.pool
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, resource_id), eq(agents.orgId, ctx.orgId), active(agents)))
        .limit(1);
      found = agentRows.length > 0;
      break;
    }
    case 'connector': {
      const connectorRows = await ctx.pool
        .select({ id: connectors.id })
        .from(connectors)
        .where(and(eq(connectors.id, resource_id), eq(connectors.orgId, ctx.orgId), active(connectors)))
        .limit(1);
      found = connectorRows.length > 0;
      break;
    }
    case 'comment': {
      const commentRows = await ctx.pool
        .select({ id: taskComments.id })
        .from(taskComments)
        .where(and(eq(taskComments.id, resource_id), eq(taskComments.orgId, ctx.orgId), active(taskComments)))
        .limit(1);
      found = commentRows.length > 0;
      break;
    }
  }

  if (!found) {
    throw new HttpError(
      422,
      'external_ref.invalid_resource',
      `${resource_type} '${resource_id}' not found or inactive in this org`,
    );
  }
}

// ---------------------------------------------------------------------------
// POST /v1/external_refs
// ---------------------------------------------------------------------------

externalRefsRouter.post(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;

      const raw = await c.req.json().catch(() => {
        throw new HttpError(400, 'external_ref.bad_request', 'Request body must be valid JSON');
      });

      const input = createBody.safeParse(raw);
      if (!input.success) {
        throw new HttpError(
          400,
          'external_ref.validation_error',
          input.error.issues[0]?.message ?? 'Validation failed',
          input.error.issues,
        );
      }

      const { resource_type, resource_id, source_kind, source_id, external_id, external_url, metadata } = input.data;

      // ---------------------------------------------------------------------------
      // source_id enforcement for agent and connector roles.
      // ---------------------------------------------------------------------------
      if (ctx.role === 'agent' && source_id !== ctx.principal.id) {
        throw new HttpError(
          403,
          'external_ref.source_id_mismatch',
          `Agents may only create refs where source_id equals their own id ('${ctx.principal.id}')`,
        );
      }
      if (ctx.role === 'connector' && source_id !== ctx.principal.id) {
        throw new HttpError(
          403,
          'external_ref.source_id_mismatch',
          `Connectors may only create refs where source_id equals their own id ('${ctx.principal.id}')`,
        );
      }

      // ---------------------------------------------------------------------------
      // Validate the target resource exists and belongs to this org.
      // ---------------------------------------------------------------------------
      await validateResourceExists(ctx, resource_type, resource_id);

      // ---------------------------------------------------------------------------
      // Insert the ref (catch UNIQUE violation → 409 duplicate).
      // ---------------------------------------------------------------------------
      const refId = makeId('externalRef');
      const now = Date.now();

      try {
        await ctx.pool.insert(externalRefs).values({
          id: refId,
          orgId: ctx.orgId,
          resourceType: resource_type,
          resourceId: resource_id,
          sourceKind: source_kind,
          sourceId: source_id,
          externalId: external_id,
          externalUrl: external_url ?? null,
          metadata: metadata ? JSON.stringify(metadata) : null,
          createdAt: now,
          updatedAt: now,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('UNIQUE') || msg.includes('unique')) {
          throw new HttpError(
            409,
            'external_ref.duplicate',
            `An active external ref already exists for (${resource_type}, ${resource_id}, ${source_kind}, ${source_id})`,
          );
        }
        throw e;
      }

      const rows = await ctx.pool
        .select()
        .from(externalRefs)
        .where(and(eq(externalRefs.id, refId), eq(externalRefs.orgId, ctx.orgId)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new HttpError(500, 'internal', 'External ref row disappeared after insert');
      }

      await emitEvent(ctx.pool, {
        orgId: ctx.orgId,
        resourceType: resource_type,
        resourceId: resource_id,
        kind: 'external_ref.added',
        actor: ctx.principal,
        payload: { ref: serializeTimestamps(row) },
      });

      return c.json({ external_ref: serializeTimestamps(row) }, 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/external_refs
// ---------------------------------------------------------------------------

externalRefsRouter.get(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const env = c.env as { BETTER_AUTH_SECRET?: string };

      const queryRaw = {
        resource_type: c.req.query('resource_type'),
        resource_id: c.req.query('resource_id'),
        source_kind: c.req.query('source_kind'),
        source_id: c.req.query('source_id'),
        external_id: c.req.query('external_id'),
        cursor: c.req.query('cursor'),
        limit: c.req.query('limit'),
      };

      const queryParsed = listQuery.safeParse(queryRaw);
      if (!queryParsed.success) {
        throw new HttpError(400, 'external_ref.validation_error', 'Invalid query parameters');
      }

      const q = queryParsed.data;
      const limit = clampLimit(q.limit, 50, 100);
      const secret = env.BETTER_AUTH_SECRET ?? '';

      // Cursor decode (uses the same updatedAt-based cursor format as other lists,
      // but stored in createdAt/id since externalRefs is ordered DESC by createdAt,id).
      let afterUpdatedAt: number | undefined;
      let afterId: string | undefined;

      if (q.cursor) {
        const decoded = await decodeCursor(q.cursor, secret);
        if (!decoded || decoded.orgId !== ctx.orgId) {
          throw new HttpError(400, 'external_ref.invalid_cursor', 'Invalid or expired pagination cursor');
        }
        afterUpdatedAt = decoded.updatedAt;
        afterId = decoded.id;
      }

      // Build WHERE conditions.
      const conditions = [
        eq(externalRefs.orgId, ctx.orgId),
        active(externalRefs),
      ];

      if (q.resource_type) conditions.push(eq(externalRefs.resourceType, q.resource_type));
      if (q.resource_id) conditions.push(eq(externalRefs.resourceId, q.resource_id));
      if (q.source_kind) conditions.push(eq(externalRefs.sourceKind, q.source_kind));
      if (q.source_id) conditions.push(eq(externalRefs.sourceId, q.source_id));
      if (q.external_id) conditions.push(eq(externalRefs.externalId, q.external_id));

      let rows: typeof externalRefs.$inferSelect[];

      if (afterUpdatedAt !== undefined && afterId !== undefined) {
        const cursorCondition = or(
          lt(externalRefs.createdAt, afterUpdatedAt),
          and(eq(externalRefs.createdAt, afterUpdatedAt), lt(externalRefs.id, afterId)),
        );
        rows = await ctx.pool
          .select()
          .from(externalRefs)
          .where(and(...conditions, cursorCondition))
          .orderBy(desc(externalRefs.createdAt), desc(externalRefs.id))
          .limit(limit + 1);
      } else {
        rows = await ctx.pool
          .select()
          .from(externalRefs)
          .where(and(...conditions))
          .orderBy(desc(externalRefs.createdAt), desc(externalRefs.id))
          .limit(limit + 1);
      }

      const hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);

      let nextCursor: string | null = null;
      if (hasMore) {
        const last = rows[rows.length - 1]!;
        nextCursor = await encodeCursor(
          { updatedAt: last.createdAt, id: last.id, orgId: ctx.orgId },
          secret,
        );
      }

      return c.json({
        external_refs: rows.map(serializeTimestamps),
        next_cursor: nextCursor,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/external_refs/:id
// ---------------------------------------------------------------------------

externalRefsRouter.delete(
  '/:id',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const id = c.req.param('id');

      const existingRows = await ctx.pool
        .select()
        .from(externalRefs)
        .where(and(eq(externalRefs.id, id), eq(externalRefs.orgId, ctx.orgId), active(externalRefs)))
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        throw new HttpError(404, 'external_ref.not_found', `External ref ${id} not found`);
      }

      // Agent role: can only delete refs where source_id == principal.id.
      if (ctx.role === 'agent' && existing.sourceId !== ctx.principal.id) {
        throw new HttpError(
          403,
          'external_ref.forbidden',
          'Agents can only delete external refs they created (source_id must equal their own id)',
        );
      }

      const now = Date.now();
      await ctx.pool
        .update(externalRefs)
        .set({
          deletedAt: now,
          deletedByType: ctx.principal.type,
          deletedById: ctx.principal.id,
          updatedAt: now,
        })
        .where(and(eq(externalRefs.id, id), eq(externalRefs.orgId, ctx.orgId)));

      await emitEvent(ctx.pool, {
        orgId: ctx.orgId,
        resourceType: existing.resourceType as 'task' | 'project' | 'agent' | 'connector' | 'comment',
        resourceId: existing.resourceId,
        kind: 'external_ref.removed',
        actor: ctx.principal,
        payload: { ref_id: id },
      });

      return c.json({}, 200);
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);
