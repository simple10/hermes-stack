// services/mission-control/src/schemas/events.ts
//
// Browser-safe. ONLY imports allowed: zod + sibling schema files (also browser-safe).
import { z } from 'zod';
import { IsoTimestamp } from './common.ts';

// Per VALID_KINDS in src/routes/events.ts — includes 'external_ref' even
// though the master spec table lists only the 5 main resource types.
export const ResourceType = z.enum(['task', 'project', 'agent', 'connector', 'comment', 'external_ref']);
export type ResourceType = z.infer<typeof ResourceType>;

/**
 * GET /v1/events query.
 *
 * Defaults match the server handler (`since=0`, `limit=100`, `order='asc'`)
 * so the schema can be used for server-side validation directly. The UI
 * always sends explicit values, so defaults are inert from the client's
 * perspective.
 */
export const EventListQuery = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  /** Comma-separated resource_type values. */
  kinds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
  /** 'desc' for head-lookup (registrar bootstrap); 'asc' is the pagination default. */
  order: z.enum(['asc', 'desc']).default('asc'),
});
export type EventListQuery = z.infer<typeof EventListQuery>;

/**
 * Event row shape. The handler JSON.parses `payload` on the way out, so
 * `payload` is `unknown` (kind-specific) rather than `string`.
 */
export const Event = z.object({
  id: z.number().int(),
  org_id: z.string(),
  resource_type: ResourceType,
  resource_id: z.string(),
  kind: z.string(),
  actor_type: z.enum(['user', 'agent', 'connector', 'system']).nullable(),
  actor_id: z.string().nullable(),
  payload: z.unknown().nullable(),
  created_at: IsoTimestamp,
});
export type Event = z.infer<typeof Event>;

/** GET /v1/events → `{ events: [...], next_cursor }`. */
export const EventListResponse = z.object({
  events: z.array(Event),
  next_cursor: z.string().nullable(),
});
export type EventListResponse = z.infer<typeof EventListResponse>;
