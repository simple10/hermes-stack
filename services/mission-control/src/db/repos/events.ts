/**
 * eventsRepo — Drizzle facade over the `events` table.
 *
 * Append-only.  No list, no update, no softDelete.
 * (v1.1 will add list(filter) when the /v1/events route ships.)
 *
 * emit() takes only kind-specific args.  orgId and actor come from ctx.
 *
 * This replaces the standalone emitEvent() function that previously lived in
 * src/events/emit.ts (deleted in Task 4 of the DAL refactor).
 */
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

    // table exposed for system.purgeOlderThan and future analytics
    table: events,
  };
}
