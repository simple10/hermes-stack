// services/mission-control/src/schemas/comments.ts
//
// Browser-safe. ONLY imports allowed: zod + sibling schema files (also browser-safe).
import { z } from 'zod'
import { IdSlug, IsoTimestamp, SoftDeleteFields } from './common.ts'

/** POST /v1/tasks/:id/comments body. */
export const CommentCreateBody = z.object({
  body: z.string().min(1).max(10_000),
})
export type CommentCreateBody = z.infer<typeof CommentCreateBody>

/** Comment row shape (per c.json(serializeTimestamps(row)) at routes/comments.ts). */
export const Comment = z
  .object({
    id: IdSlug('cmt_'),
    org_id: z.string(),
    task_id: IdSlug('t_'),
    author_type: z.enum(['user', 'agent', 'connector', 'system']),
    author_id: z.string(),
    body: z.string(),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .extend(SoftDeleteFields.shape)
export type Comment = z.infer<typeof Comment>

/** POST /v1/tasks/:id/comments → `{ comment: row }`. */
export const CommentCreateResponse = z.object({ comment: Comment })
export type CommentCreateResponse = z.infer<typeof CommentCreateResponse>

export const CommentListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type CommentListQuery = z.infer<typeof CommentListQuery>

/** GET /v1/tasks/:id/comments → `{ comments: [...], next_cursor }`. */
export const CommentListResponse = z.object({
  comments: z.array(Comment),
  next_cursor: z.string().nullable(),
})
export type CommentListResponse = z.infer<typeof CommentListResponse>
