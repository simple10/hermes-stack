// services/mission-control/src/schemas/agents.ts
//
// Browser-safe schemas for /v1/agents. ONLY imports allowed: zod + ./common.ts.
// Enforced by ESLint rule in services/mission-control/eslint.config.js (Task 1.5).
//
// The response shapes here mirror EXACTLY what src/routes/agents.ts returns at
// each `c.json(...)` call site. Keep them in sync — Task 1.6.5 wires up a
// dev-mode validateResponses middleware that will trip on any drift.
import { z } from 'zod';
import { IdSlug, IsoTimestamp, SoftDeleteFields } from './common.ts';

// ---------------------------------------------------------------------------
// Request bodies — mirror the inline `createSchema` / `updateSchema` in
// src/routes/agents.ts.
// ---------------------------------------------------------------------------

export const AgentCreateBody = z.object({
  name: z.string().min(1).max(100),
  kind: z.string().min(1).max(50),
  description: z.string().max(1000).optional(),
});
export type AgentCreateBody = z.infer<typeof AgentCreateBody>;

export const AgentPatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
});
export type AgentPatchBody = z.infer<typeof AgentPatchBody>;

// ---------------------------------------------------------------------------
// Query params for GET /v1/agents. The route uses clampLimit() (max 100) and
// decodeCursor() for cursor handling.
// ---------------------------------------------------------------------------

export const AgentListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type AgentListQuery = z.infer<typeof AgentListQuery>;

// ---------------------------------------------------------------------------
// Agent row — the shape returned by serializeTimestamps(agentRow) per
// src/db/helpers.ts (camelCase→snake_case + ms→ISO).
//
// Source table: src/db/pool.ts `agents`. Columns shipped verbatim — no field
// is stripped or computed by the handler.
// ---------------------------------------------------------------------------

export const Agent = z
  .object({
    id: IdSlug('agt_'),
    org_id: z.string(),
    name: z.string(),
    kind: z.string(),
    description: z.string().nullable(),
    last_seen_at: IsoTimestamp.nullable(),
    created_by_user_id: z.string().nullable(),
    created_at: IsoTimestamp,
    updated_at: IsoTimestamp,
  })
  .extend(SoftDeleteFields.shape);
export type Agent = z.infer<typeof Agent>;

// ---------------------------------------------------------------------------
// Response wrappers — every shape matches a specific `c.json(...)` call site.
// ---------------------------------------------------------------------------

/** GET /v1/agents → `{ agents, next_cursor }` (NOT the generic `data` wrapper). */
export const AgentListResponse = z.object({
  agents: z.array(Agent),
  next_cursor: z.string().nullable(),
});
export type AgentListResponse = z.infer<typeof AgentListResponse>;

/** POST /v1/agents → `{ agent, key }` (201). The raw key is shown exactly once. */
export const AgentCreateResponse = z.object({
  agent: Agent,
  /** Full bearer token — shown to the caller exactly once. */
  key: z.string(),
});
export type AgentCreateResponse = z.infer<typeof AgentCreateResponse>;

/** GET /v1/agents/:id and PATCH /v1/agents/:id → `{ agent }`. */
export const AgentDetailResponse = z.object({
  agent: Agent,
});
export type AgentDetailResponse = z.infer<typeof AgentDetailResponse>;

/**
 * POST /v1/agents/:id/rotate-key → `{ key, expires_old_at }`.
 *
 * Note: the handler does NOT echo back the agent row, and uses
 * `expires_old_at` (ISO 8601 string or null when there was no prior key)
 * instead of a `grace_seconds` integer. Match the wire format exactly.
 */
export const AgentRotateKeyResponse = z.object({
  key: z.string(),
  expires_old_at: IsoTimestamp.nullable(),
});
export type AgentRotateKeyResponse = z.infer<typeof AgentRotateKeyResponse>;

/** DELETE /v1/agents/:id → `{}` (200). */
export const AgentDeleteResponse = z.object({}).strict();
export type AgentDeleteResponse = z.infer<typeof AgentDeleteResponse>;
