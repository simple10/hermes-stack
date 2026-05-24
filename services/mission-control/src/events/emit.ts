/**
 * Typed event emitter — writes a row to the `events` table.
 *
 * Every mutating route handler calls `emitEvent` before returning so the
 * append-only audit log stays current.  The emitter is intentionally thin:
 * it validates types at the call-site via TypeScript, serialises the
 * payload to JSON, and does a single INSERT.
 *
 * `events.id` is AUTOINCREMENT — the DB assigns the monotonic integer, not us.
 * `events` has no `updated_at` or `deleted_at` (append-only by spec).
 */

import { events } from '../db/pool.ts';
import type { PoolClient } from '../db/client.ts';
import type { Principal } from '../auth/types.ts';

// ---------------------------------------------------------------------------
// Event kind catalogue
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

// ---------------------------------------------------------------------------
// Resource type catalogue (polymorphic resource_type column)
// ---------------------------------------------------------------------------

export type ResourceType =
  | 'task'
  | 'project'
  | 'agent'
  | 'connector'
  | 'comment';

// ---------------------------------------------------------------------------
// Actor type (stored in actor_type column)
// ---------------------------------------------------------------------------

type ActorType = 'user' | 'agent' | 'connector' | 'system';

/** Derive the actor_type string from a Principal union. */
function actorTypeFromPrincipal(p: Principal): ActorType {
  return p.type; // Principal.type is already 'user'|'agent'|'connector'
}

// ---------------------------------------------------------------------------
// emitEvent
// ---------------------------------------------------------------------------

/**
 * Insert a single event row into the pool DB.
 *
 * @param pool        - Drizzle pool client (already resolved for the org).
 * @param args.orgId       - Org that owns the event.
 * @param args.resourceType - The resource kind (task, project, …).
 * @param args.resourceId   - The resource's ID.
 * @param args.kind         - Event kind string (see EventKind union).
 * @param args.actor        - The acting Principal; defaults to `system` when omitted.
 * @param args.payload      - Optional kind-specific payload (serialised to JSON).
 */
export async function emitEvent(
  pool: PoolClient,
  args: {
    orgId: string;
    resourceType: ResourceType;
    resourceId: string;
    kind: EventKind;
    actor?: Principal;
    payload?: unknown;
  },
): Promise<void> {
  const actorType: ActorType = args.actor
    ? actorTypeFromPrincipal(args.actor)
    : 'system';

  await pool.insert(events).values({
    orgId:        args.orgId,
    resourceType: args.resourceType,
    resourceId:   args.resourceId,
    kind:         args.kind,
    actorType:    actorType,
    actorId:      args.actor?.id ?? null,
    payload:      args.payload !== undefined ? JSON.stringify(args.payload) : null,
    createdAt:    Date.now(),
  });
}
