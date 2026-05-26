// services/mission-control/src/schemas/connectors.ts
//
// Browser-safe schemas for /v1/connectors. ONLY imports allowed: zod + ./common.ts.
//
// Mirrors src/routes/connectors.ts. Connectors and agents share an almost-identical
// shape (different id prefix + different role gates); the wire format is symmetrical.
import { z } from 'zod'
import { IdSlug, IsoTimestamp, SoftDeleteFields } from './common.ts'

// ---------------------------------------------------------------------------
// Request bodies — mirror inline `createSchema` / `updateSchema` in
// src/routes/connectors.ts.
// ---------------------------------------------------------------------------

export const ConnectorCreateBody = z.object({
  name: z.string().min(1).max(100),
  kind: z.string().min(1).max(50),
  description: z.string().max(1000).optional(),
})
export type ConnectorCreateBody = z.infer<typeof ConnectorCreateBody>

export const ConnectorPatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
})
export type ConnectorPatchBody = z.infer<typeof ConnectorPatchBody>

// ---------------------------------------------------------------------------
// Query params for GET /v1/connectors.
// ---------------------------------------------------------------------------

export const ConnectorListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
export type ConnectorListQuery = z.infer<typeof ConnectorListQuery>

// ---------------------------------------------------------------------------
// Connector row — serializeTimestamps() output of src/db/pool.ts `connectors`.
// Same column set as `agents` modulo the id prefix.
// ---------------------------------------------------------------------------

export const Connector = z
  .object({
    id: IdSlug('cnn_'),
    org_id: z.string(),
    name: z.string(),
    kind: z.string(),
    description: z.string().nullable(),
    last_seen_at: IsoTimestamp.nullable(),
    created_by_user_id: z.string().nullable(),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .extend(SoftDeleteFields.shape)
export type Connector = z.infer<typeof Connector>

// ---------------------------------------------------------------------------
// Response wrappers.
// ---------------------------------------------------------------------------

/** GET /v1/connectors → `{ connectors, next_cursor }` (NOT the generic `data` wrapper). */
export const ConnectorListResponse = z.object({
  connectors: z.array(Connector),
  next_cursor: z.string().nullable(),
})
export type ConnectorListResponse = z.infer<typeof ConnectorListResponse>

/** POST /v1/connectors → `{ connector, key }` (201). Raw key shown exactly once. */
export const ConnectorCreateResponse = z.object({
  connector: Connector,
  /** Full bearer token — shown to the caller exactly once. */
  key: z.string(),
})
export type ConnectorCreateResponse = z.infer<typeof ConnectorCreateResponse>

/** GET /v1/connectors/:id and PATCH /v1/connectors/:id → `{ connector }`. */
export const ConnectorDetailResponse = z.object({
  connector: Connector,
})
export type ConnectorDetailResponse = z.infer<typeof ConnectorDetailResponse>

/**
 * POST /v1/connectors/:id/rotate-key → `{ key, expires_old_at }`.
 * `expires_old_at` is null when there was no prior active key.
 */
export const ConnectorRotateKeyResponse = z.object({
  key: z.string(),
  expires_old_at: IsoTimestamp.nullable(),
})
export type ConnectorRotateKeyResponse = z.infer<typeof ConnectorRotateKeyResponse>

/** DELETE /v1/connectors/:id → `{}` (200). */
export const ConnectorDeleteResponse = z.object({}).strict()
export type ConnectorDeleteResponse = z.infer<typeof ConnectorDeleteResponse>
