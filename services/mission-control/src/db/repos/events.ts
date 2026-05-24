/**
 * eventsRepo — Drizzle facade over the `events` table.
 *
 * Append-only.  No update, no softDelete.
 *
 * emit() takes only kind-specific args.  orgId and actor come from ctx.
 * list() backs the GET /v1/events route — single-pool integer cursor since
 * events.id is monotonic per pool DB.
 *
 * This replaces the standalone emitEvent() function that previously lived in
 * src/events/emit.ts (deleted in Task 4 of the DAL refactor).
 */
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { events } from '../pool.ts';
import type { AuthContext } from '../../auth/types.ts';

// ---------------------------------------------------------------------------
// Event type catalogue (moved here from the deleted src/events/emit.ts)
// ---------------------------------------------------------------------------

export type EventKind =
  | 'task.created'
  | 'task.updated'
  | 'task.status_changed'
  | 'task.assigned'
  | 'task.deleted'
  | 'project.created'
  | 'project.updated'
  | 'project.deleted'
  | 'agent.created'
  | 'agent.updated'
  | 'agent.deleted'
  | 'agent.key_rotated'
  | 'connector.created'
  | 'connector.updated'
  | 'connector.deleted'
  | 'connector.key_rotated'
  | 'comment.created'
  | 'comment.deleted'
  | 'external_ref.added'
  | 'external_ref.removed';

export type ResourceType =
  | 'task'
  | 'project'
  | 'agent'
  | 'connector'
  | 'comment';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function eventsRepo(ctx: AuthContext) {
  return {
    /**
     * Append a single event row.
     *
     * orgId and actor are derived from ctx; callers only supply kind-specific args.
     */
    async emit(args: {
      resourceType: string;
      resourceId: string;
      kind: string;
      payload?: unknown;
    }): Promise<void> {
      await ctx.pool.insert(events).values({
        orgId: ctx.orgId,
        resourceType: args.resourceType,
        resourceId: args.resourceId,
        kind: args.kind,
        actorType: ctx.principal.type,
        actorId: ctx.principal.id,
        payload: args.payload !== undefined ? JSON.stringify(args.payload) : null,
        createdAt: Date.now(),
      });
    },

    /**
     * List events for this org, optionally filtered by resource_type.
     *
     * Two read modes via ``order``:
     *   - ``'asc'`` (default): standard forward pagination. Filters id > since;
     *     orders ASC; advance ``since`` to the highest id seen for the next
     *     page. ``cursor`` (Number-as-string) overrides ``since`` for
     *     within-window paging.
     *   - ``'desc'``: tail-of-stream lookup. Filters id > since; orders DESC.
     *     A single ``limit=1`` call returns the current head id — used by
     *     consumers (e.g. the Hermes plugin's registrar) to initialize a
     *     cursor at "now" without replaying history.
     *
     * events.id is monotonic per pool DB; v1 has one pool so a single integer
     * since cursor suffices.
     */
    async list(args: {
      since: number;
      kinds?: string[]; // resource_type values
      limit: number;
      cursor?: string | null;
      order?: 'asc' | 'desc';
    }): Promise<{ rows: typeof events.$inferSelect[]; nextCursorId: number | null }> {
      const lower = args.cursor ? Number(args.cursor) : args.since;
      const conditions = [
        eq(events.orgId, ctx.orgId),
        gt(events.id, lower),
      ];
      if (args.kinds && args.kinds.length > 0) {
        conditions.push(inArray(events.resourceType, args.kinds));
      }
      const orderBy = args.order === 'desc' ? desc(events.id) : asc(events.id);
      const rows = await ctx.pool
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(orderBy)
        .limit(args.limit + 1);

      const hasMore = rows.length > args.limit;
      const trimmed = hasMore ? rows.slice(0, args.limit) : rows;
      // nextCursorId only meaningful for ASC order — DESC is a tail-lookup
      // mode, not a paging mode. Callers should re-issue with a refreshed
      // since if they need to scan further back.
      const nextCursorId =
        args.order === 'desc'
          ? null
          : hasMore
            ? trimmed[trimmed.length - 1]!.id
            : null;
      return { rows: trimmed, nextCursorId };
    },

    // table exposed for system.purgeOlderThan and future analytics
    table: events,
  };
}
