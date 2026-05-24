/**
 * /v1/tasks/:taskId/comments — Comments CRUD.
 *
 * Endpoints:
 *   POST  /v1/tasks/:taskId/comments  — append a comment (any authenticated role)
 *                                       agent role: only on tasks where agent_id == principal.id
 *   GET   /v1/tasks/:taskId/comments  — list comments, oldest-first cursor pagination
 *                                       agent role: only on tasks where agent_id == principal.id
 *
 * Author is recorded from ctx.principal (actor_type = principal.type, actor_id = principal.id).
 * Emits comment.created event on POST.
 *
 * Pagination: ASC by (createdAt, id) — chronological order, oldest first.
 * Cursor payload: { createdAt, id, orgId }
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, or, gt, asc } from 'drizzle-orm';
import { authMiddleware, requireAnyRole } from '../auth/middleware.ts';
import { tasks, taskComments } from '../db/pool.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { makeId } from '../ids.ts';
import { active, serializeTimestamps } from '../db/helpers.ts';
import { emitEvent } from '../events/emit.ts';
import { clampLimit } from '../pagination.ts';
import type { AuthContext } from '../auth/types.ts';

type Variables = { auth: AuthContext };

export const commentsRouter = new Hono<{ Variables: Variables }>();
commentsRouter.use('*', authMiddleware);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createBody = z.object({
  body: z.string().min(1).max(10_000),
});

// ---------------------------------------------------------------------------
// Cursor helpers — chronological ASC (createdAt, id)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

async function encodeCommentCursor(
  payload: { createdAt: number; id: string; orgId: string },
  secret: string,
): Promise<string> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(body) + '.' + sigB64;
}

async function decodeCommentCursor(
  cursor: string,
  secret: string,
): Promise<{ createdAt: number; id: string; orgId: string } | null> {
  const dot = cursor.indexOf('.');
  if (dot === -1) return null;
  const bodyB64 = cursor.slice(0, dot);
  const sigB64 = cursor.slice(dot + 1);
  if (!bodyB64 || !sigB64) return null;

  let body: string;
  try {
    body = atob(bodyB64);
  } catch {
    return null;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(body));
  if (!valid) return null;

  try {
    return JSON.parse(body) as { createdAt: number; id: string; orgId: string };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared: resolve task + enforce agent ownership
// ---------------------------------------------------------------------------

async function resolveTask(
  ctx: AuthContext,
  taskId: string,
): Promise<typeof tasks.$inferSelect> {
  const row = await ctx.pool.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.orgId, ctx.orgId), active(tasks)),
  });
  if (!row) {
    throw new HttpError(404, 'task.not_found', `Task ${taskId} not found`);
  }
  // Agent role: can only comment on / view comments for their own tasks.
  if (ctx.role === 'agent' && row.agentId !== ctx.principal.id) {
    throw new HttpError(403, 'comment.forbidden', 'Agents can only comment on their own tasks');
  }
  return row;
}

// ---------------------------------------------------------------------------
// POST /v1/tasks/:taskId/comments
// ---------------------------------------------------------------------------

commentsRouter.post(
  '/:taskId/comments',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const taskId = c.req.param('taskId');

      const raw = await c.req.json().catch(() => {
        throw new HttpError(400, 'comment.bad_request', 'Request body must be valid JSON');
      });

      const input = createBody.safeParse(raw);
      if (!input.success) {
        throw new HttpError(
          400,
          'comment.validation_error',
          input.error.issues[0]?.message ?? 'Validation failed',
          input.error.issues,
        );
      }

      // Resolve the task (validates org scope + agent ownership).
      await resolveTask(ctx, taskId);

      const commentId = makeId('comment');
      const now = Date.now();

      await ctx.pool.insert(taskComments).values({
        id: commentId,
        orgId: ctx.orgId,
        taskId,
        authorType: ctx.principal.type,
        authorId: ctx.principal.id,
        body: input.data.body,
        createdAt: now,
        updatedAt: now,
      });

      const rows = await ctx.pool
        .select()
        .from(taskComments)
        .where(and(eq(taskComments.id, commentId), eq(taskComments.orgId, ctx.orgId)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new HttpError(500, 'internal', 'Comment row disappeared after insert');
      }

      await emitEvent(ctx.pool, {
        orgId: ctx.orgId,
        resourceType: 'comment',
        resourceId: commentId,
        kind: 'comment.created',
        actor: ctx.principal,
        payload: { comment: serializeTimestamps(row) },
      });

      return c.json({ comment: serializeTimestamps(row) }, 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/tasks/:taskId/comments
// ---------------------------------------------------------------------------

commentsRouter.get(
  '/:taskId/comments',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const env = c.env as { BETTER_AUTH_SECRET?: string };
      const taskId = c.req.param('taskId');

      // Resolve the task (validates org scope + agent ownership).
      await resolveTask(ctx, taskId);

      const limitRaw = c.req.query('limit');
      const cursorRaw = c.req.query('cursor');
      const limit = clampLimit(limitRaw, 50, 100);

      const secret = env.BETTER_AUTH_SECRET ?? '';

      // Cursor decode — chronological ASC cursor.
      let afterCreatedAt: number | undefined;
      let afterId: string | undefined;

      if (cursorRaw) {
        const decoded = await decodeCommentCursor(cursorRaw, secret);
        if (!decoded || decoded.orgId !== ctx.orgId) {
          throw new HttpError(400, 'comment.invalid_cursor', 'Invalid or expired pagination cursor');
        }
        afterCreatedAt = decoded.createdAt;
        afterId = decoded.id;
      }

      // Build base conditions.
      const conditions = [
        eq(taskComments.taskId, taskId),
        eq(taskComments.orgId, ctx.orgId),
        active(taskComments),
      ];

      let rows: typeof taskComments.$inferSelect[];

      if (afterCreatedAt !== undefined && afterId !== undefined) {
        // Keyset: rows that come after (createdAt, id) in ASC order.
        const cursorCondition = or(
          gt(taskComments.createdAt, afterCreatedAt),
          and(
            eq(taskComments.createdAt, afterCreatedAt),
            gt(taskComments.id, afterId),
          ),
        );
        rows = await ctx.pool
          .select()
          .from(taskComments)
          .where(and(...conditions, cursorCondition))
          .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
          .limit(limit + 1);
      } else {
        rows = await ctx.pool
          .select()
          .from(taskComments)
          .where(and(...conditions))
          .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
          .limit(limit + 1);
      }

      const hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);

      let nextCursor: string | null = null;
      if (hasMore) {
        const last = rows[rows.length - 1]!;
        nextCursor = await encodeCommentCursor(
          { createdAt: last.createdAt, id: last.id, orgId: ctx.orgId },
          secret,
        );
      }

      return c.json({
        comments: rows.map(serializeTimestamps),
        next_cursor: nextCursor,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);
