// services/mission-control/src/schemas/external-refs.ts
//
// Browser-safe. ONLY imports allowed: zod + sibling schema files (also browser-safe).
import { z } from 'zod';
import { IdSlug, IsoTimestamp, SoftDeleteFields } from './common.ts';
import { ResourceType } from './events.ts';

/** POST /v1/external_refs body. */
export const ExternalRefCreateBody = z.object({
  resource_type: ResourceType,
  resource_id: z.string(),
  source_kind: z.string().min(1).max(50),
  source_id: z.string().min(1).max(200),
  external_id: z.string().min(1).max(500),
  external_url: z.url().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ExternalRefCreateBody = z.infer<typeof ExternalRefCreateBody>;

export const ExternalRef = z
  .object({
    id: IdSlug('xrf_'),
    org_id: z.string(),
    resource_type: ResourceType,
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

export const ExternalRefListQuery = z.object({
  resource_type: ResourceType.optional(),
  resource_id: z.string().optional(),
  source_kind: z.string().optional(),
  source_id: z.string().optional(),
  external_id: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ExternalRefListQuery = z.infer<typeof ExternalRefListQuery>;

/** GET /v1/external_refs → `{ external_refs: [...], next_cursor }`. */
export const ExternalRefListResponse = z.object({
  external_refs: z.array(ExternalRef),
  next_cursor: z.string().nullable(),
});
export type ExternalRefListResponse = z.infer<typeof ExternalRefListResponse>;
