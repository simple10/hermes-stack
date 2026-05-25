// services/mission-control/src/schemas/common.ts
//
// Browser-safe schemas. ONLY imports allowed: zod.
// Enforced by ESLint rule in services/mission-control/eslint.config.js (Task 1.5).
import { z } from 'zod';

/** IdSlug: prefixed entity id matcher. `IdSlug('t_').parse('t_abc123')`. */
export const IdSlug = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-zA-Z0-9_-]+$`));

/** RFC 3339 timestamp (the API serializes integers to RFC 3339 per master spec). */
export const IsoTimestamp = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Invalid RFC 3339 timestamp' });

/** Task status values per master API spec §"Task lifecycle". */
export const TaskStatus = z.enum([
  'pending', 'ready', 'in_progress', 'blocked', 'completed', 'failed', 'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Member role values per master API spec §"Role model". */
export const MemberRole = z.enum(['owner', 'admin', 'member']);
export type MemberRole = z.infer<typeof MemberRole>;

/** Principal type values. */
export const PrincipalType = z.enum(['pat', 'agent', 'connector']);
export type PrincipalType = z.infer<typeof PrincipalType>;

/** Standard cursor-paginated response wrapper. */
export const Paginated = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });

/** API error envelope per master spec §"Error model". */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** Soft-delete columns present on most user-mutable rows. */
export const SoftDeleteFields = z.object({
  deleted_at: IsoTimestamp.nullable(),
  deleted_by_type: z.enum(['user', 'agent', 'connector', 'system']).nullable(),
  deleted_by_id: z.string().nullable(),
});
