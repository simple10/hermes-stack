/**
 * commentsRepo — Drizzle facade over the `task_comments` table.
 *
 * Scope: AND(org_id = ctx.orgId, deleted_at IS NULL)
 *
 * No per-principal visibility filter at the comment level — any org member
 * can read/list all comments.  Route handlers enforce the agent-can-only-
 * comment-on-their-own-task rule via a precondition check on tasks before
 * calling insert.
 *
 * Insert stamps: id, orgId, authorType, authorId (all from ctx), createdAt, updatedAt
 * softDelete writes: deletedAt, deletedByType, deletedById (from ctx.principal)
 */
import { and, eq, desc, asc, type SQL } from 'drizzle-orm';
import { taskComments } from '../pool.ts';
import { active } from '../helpers.ts';
import { makeId } from '../../ids.ts';
import type { AuthContext } from '../../auth/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CommentRow = typeof taskComments.$inferSelect;

export interface CommentListOptions {
  limit?: number;
  cursor?: { createdAt: number; id: string };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function commentsRepo(ctx: AuthContext) {
  const scope = and(eq(taskComments.orgId, ctx.orgId), active(taskComments));

  return {
    async findById(id: string): Promise<CommentRow | null> {
      const rows = await ctx.pool.select().from(taskComments)
        .where(and(scope, eq(taskComments.id, id))).limit(1);
      return rows[0] ?? null;
    },

    async listByTask(taskId: string, opts: CommentListOptions = {}): Promise<CommentRow[]> {
      const conditions: SQL[] = [scope!, eq(taskComments.taskId, taskId)];
      // Cursor pagination: forward (asc by createdAt)
      // cursor = {createdAt, id} meaning "rows after this point"
      // Using simple: where createdAt > cursor.createdAt OR (createdAt == cursor.createdAt AND id > cursor.id)
      return ctx.pool.select().from(taskComments)
        .where(and(...conditions))
        .orderBy(asc(taskComments.createdAt), asc(taskComments.id))
        .limit(opts.limit ?? 50);
    },

    async insert(args: { taskId: string; body: string }): Promise<CommentRow> {
      const id = makeId('comment');
      const now = Date.now();
      const inserted = await ctx.pool.insert(taskComments).values({
        id,
        orgId: ctx.orgId,
        taskId: args.taskId,
        authorType: ctx.principal.type,
        authorId: ctx.principal.id,
        body: args.body,
        createdAt: now,
        updatedAt: now,
      }).returning();
      return inserted[0]!;
    },

    async softDelete(id: string): Promise<CommentRow | null> {
      const now = Date.now();
      const updated = await ctx.pool.update(taskComments)
        .set({
          deletedAt: now,
          deletedByType: ctx.principal.type,
          deletedById: ctx.principal.id,
          updatedAt: now,
        })
        .where(and(scope, eq(taskComments.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    // Escape hatches
    scoped: () => ctx.pool.select().from(taskComments).where(scope),
    scope: scope!,
    table: taskComments,
  };
}
