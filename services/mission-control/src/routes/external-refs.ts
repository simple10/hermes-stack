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
import { authMiddleware, requireAnyRole } from '../auth/middleware.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { serializeTimestamps } from '../db/helpers.ts';
import { db } from '../db/repos/index.ts';
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
    case 'task':
      found = (await db.tasks(ctx).findByIdForOrg(resource_id)) !== null;
      break;
    case 'project':
      found = (await db.projects(ctx).findById(resource_id)) !== null;
      break;
    case 'agent':
      found = (await db.agents(ctx).findById(resource_id)) !== null;
      break;
    case 'connector':
      found = (await db.connectors(ctx).findById(resource_id)) !== null;
      break;
    case 'comment':
      found = (await db.comments(ctx).findById(resource_id)) !== null;
      break;
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

      // Validate the target resource exists and belongs to this org.
      await validateResourceExists(ctx, resource_type, resource_id);

      // Insert the ref. The repo enforces source_id for agent/connector principals
      // (throws ForbiddenError → 403) and catches UNIQUE violation (DuplicateError → 409).
      // Both are mapped to HTTP by errorResponse automatically.
      const row = await db.externalRefs(ctx).insert({
        resourceType: resource_type,
        resourceId: resource_id,
        sourceKind: source_kind,
        sourceId: source_id,
        externalId: external_id,
        externalUrl: external_url ?? null,
        metadata: metadata ? JSON.stringify(metadata) : null,
      });

      await db.events(ctx).emit({
        resourceType: resource_type,
        resourceId: resource_id,
        kind: 'external_ref.added',
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

      let cursor: { createdAt: number; id: string } | undefined;

      if (q.cursor) {
        const decoded = await decodeCursor(q.cursor, secret);
        if (!decoded || decoded.orgId !== ctx.orgId) {
          throw new HttpError(400, 'external_ref.invalid_cursor', 'Invalid or expired pagination cursor');
        }
        cursor = { createdAt: decoded.updatedAt, id: decoded.id };
      }

      let rows = await db.externalRefs(ctx).list({
        resourceType: q.resource_type,
        resourceId: q.resource_id,
        sourceKind: q.source_kind,
        sourceId: q.source_id,
        externalId: q.external_id,
        limit: limit + 1,
        cursor,
      });

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

      const existing = await db.externalRefs(ctx).findById(id);
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

      await db.externalRefs(ctx).softDelete(id);

      await db.events(ctx).emit({
        resourceType: existing.resourceType,
        resourceId: existing.resourceId,
        kind: 'external_ref.removed',
        payload: { ref_id: id },
      });

      return c.json({}, 200);
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);
