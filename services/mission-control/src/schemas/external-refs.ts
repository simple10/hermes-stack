// services/mission-control/src/schemas/external-refs.ts
//
// Browser-safe. ONLY imports allowed: zod + sibling schema files (also browser-safe).
import { z } from 'zod';
import { IdSlug, IsoTimestamp, SoftDeleteFields } from './common.ts';

// external_refs.resource_type doesn't include 'external_ref' (you don't have
// an external_ref TO an external_ref). The Event schema has a broader
// ResourceType that includes 'external_ref' for kind references.
export const ExternalRefResourceType = z.enum(['task', 'project', 'agent', 'connector', 'comment']);
export type ExternalRefResourceType = z.infer<typeof ExternalRefResourceType>;

/** POST /v1/external_refs body (per createBody in routes/external-refs.ts). */
export const ExternalRefCreateBody = z.object({
  resource_type: ExternalRefResourceType,
  resource_id: z.string().min(1),
  source_kind: z.string().min(1).max(50),
  source_id: z.string().min(1).max(200),
  external_id: z.string().min(1).max(500),
  external_url: z.url().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ExternalRefCreateBody = z.infer<typeof ExternalRefCreateBody>;

export const ExternalRef = z
  .object({
    id: IdSlug('xrf_'),
    org_id: z.string(),
    resource_type: ExternalRefResourceType,
    resource_id: z.string(),
    source_kind: z.string(),
    source_id: z.string(),
    external_id: z.string(),
    external_url: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .extend(SoftDeleteFields.shape);
export type ExternalRef = z.infer<typeof ExternalRef>;

/** POST /v1/external_refs → `{ external_ref: row }`. */
export const ExternalRefCreateResponse = z.object({ external_ref: ExternalRef });
export type ExternalRefCreateResponse = z.infer<typeof ExternalRefCreateResponse>;

/** GET /v1/external_refs query (per listQuery in routes/external-refs.ts).  */
export const ExternalRefListQuery = z.object({
  resource_type: ExternalRefResourceType.optional(),
  resource_id: z.string().optional(),
  source_kind: z.string().optional(),
  source_id: z.string().optional(),
  external_id: z.string().optional(),
  cursor: z.string().optional(),
  // The handler uses z.string() here (not number) and coerces internally;
  // mirror that to keep the schema 1:1 with handler behavior.
  limit: z.string().optional(),
});
export type ExternalRefListQuery = z.infer<typeof ExternalRefListQuery>;

/** GET /v1/external_refs → `{ external_refs: [...], next_cursor }`. */
export const ExternalRefListResponse = z.object({
  external_refs: z.array(ExternalRef),
  next_cursor: z.string().nullable(),
});
export type ExternalRefListResponse = z.infer<typeof ExternalRefListResponse>;
