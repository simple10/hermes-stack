// services/mission-control/src/schemas/tasks.ts
//
// Browser-safe. ONLY imports allowed: zod + sibling schema files (also browser-safe).
import { z } from 'zod';
import { IdSlug, IsoTimestamp, SoftDeleteFields, TaskStatus } from './common.ts';
import { Comment } from './comments.ts';
import { Event } from './events.ts';

/**
 * Idempotency-key format: `<source>:<payload>` where `<source>` is 1-32 chars
 * starting with a lowercase letter. Matches IDEMPOTENCY_KEY_RE in routes/tasks.ts.
 */
const IDEMPOTENCY_KEY_RE = /^[a-z][a-z0-9_-]{0,31}:.{1,200}$/;

/** POST /v1/tasks body (per createBody in routes/tasks.ts). */
export const TaskCreateBody = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1).max(500),
  body: z.string().max(50_000).optional(),
  agent_id: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  idempotency_key: z.string().regex(IDEMPOTENCY_KEY_RE).optional(),
});
export type TaskCreateBody = z.infer<typeof TaskCreateBody>;

/** PATCH /v1/tasks/:id body (per patchBody in routes/tasks.ts). */
export const TaskPatchBody = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(50_000).optional(),
  /** null unassigns the agent. */
  agent_id: z.string().nullable().optional(),
  status: TaskStatus.optional(),
  priority: z.number().int().min(0).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type TaskPatchBody = z.infer<typeof TaskPatchBody>;

/** GET /v1/tasks query. */
export const TaskListQuery = z.object({
  project_id: z.string().optional(),
  agent_id: z.string().optional(),
  status: z.union([TaskStatus, z.array(TaskStatus)]).optional(),
  /** ISO 8601 string OR ms-epoch integer string. */
  updated_since: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;

/** Task row shape (per c.json({task: serializeTimestamps(row)}) at routes/tasks.ts). */
export const Task = z
  .object({
    id: IdSlug('t_'),
    org_id: z.string(),
    project_id: IdSlug('prj_'),
    agent_id: IdSlug('agt_').nullable(),
    title: z.string(),
    body: z.string().nullable(),
    status: TaskStatus,
    priority: z.number().int(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    idempotency_key: z.string().nullable(),
    created_by_user_id: z.string().nullable(),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
    started_at: IsoTimestamp.nullable(),
    completed_at: IsoTimestamp.nullable(),
  })
  .extend(SoftDeleteFields.shape);
export type Task = z.infer<typeof Task>;

/** GET /v1/tasks → `{ tasks: [...], next_cursor }`. */
export const TaskListResponse = z.object({
  tasks: z.array(Task),
  next_cursor: z.string().nullable(),
});
export type TaskListResponse = z.infer<typeof TaskListResponse>;

/**
 * GET /v1/tasks/:id → `{ task, comments, events }`.
 * Note: the handler embeds DESC-sorted latest-20 comments and latest-20 events.
 * external_refs are NOT embedded — fetch via GET /v1/external_refs separately.
 */
export const TaskDetailResponse = z.object({
  task: Task,
  comments: z.array(Comment),
  events: z.array(Event),
});
export type TaskDetailResponse = z.infer<typeof TaskDetailResponse>;

/** POST /v1/tasks → `{ task: row }` (201). */
export const TaskCreateResponse = z.object({ task: Task });
export type TaskCreateResponse = z.infer<typeof TaskCreateResponse>;

/** PATCH /v1/tasks/:id → `{ task: row }`. */
export const TaskPatchResponse = z.object({ task: Task });
export type TaskPatchResponse = z.infer<typeof TaskPatchResponse>;

/** DELETE /v1/tasks/:id → `{}` (200). */
export const TaskDeleteResponse = z.object({}).strict();
export type TaskDeleteResponse = z.infer<typeof TaskDeleteResponse>;
