/**
 * Auth context types — the resolved identity attached to every authenticated request.
 *
 * AuthContext is set on the Hono context variable 'auth' by authMiddleware and
 * consumed by route handlers.  The shape is identical regardless of whether
 * the request came in via session cookie, PAT, agent key, or connector key —
 * so handlers never need to branch on auth path.
 */
import type { PoolClient } from '../db/client.ts'

// ---------------------------------------------------------------------------
// Branded OrgId
// ---------------------------------------------------------------------------

declare const orgIdBrand: unique symbol

/**
 * A string that has been verified to originate from a trusted auth boundary
 * (session or bearer token).  Use `asOrgId` ONLY at the two auth boundary
 * sites in `src/auth/middleware.ts` — nowhere else.
 */
export type OrgId = string & { readonly [orgIdBrand]: never }

/**
 * Cast a raw string to OrgId.  Use ONLY at the auth boundary after verifying
 * the value comes from a trusted source (verified bearer / session).
 */
export function asOrgId(s: string): OrgId {
  return s as OrgId
}

// ---------------------------------------------------------------------------

/** The acting entity for this request. */
export type Principal =
  | { type: 'user'; id: string }
  | { type: 'agent'; id: string }
  | { type: 'connector'; id: string }

/**
 * Resolved auth context.  Attached to `c.get('auth')` after authMiddleware runs.
 *
 * orgId       — the org this request is scoped to
 * role        — 'owner'|'admin'|'member' for human principals; 'agent'|'connector' for M2M
 * principal   — the acting entity (user/agent/connector)
 * pool        — Drizzle pool client for this org's pool DB (pre-resolved)
 * env         — Cloudflare env bindings (needed by master-DB repos to call masterClient)
 * viaUserId   — user that owns the credential (for audit; same as principal.id for PATs)
 * viaKeyId    — better-auth apiKey.id if request used a bearer token (for audit)
 */
export type AuthContext = {
  orgId: OrgId
  role: 'owner' | 'admin' | 'member' | 'agent' | 'connector'
  principal: Principal
  pool: PoolClient
  env: Env
  viaUserId?: string
  viaKeyId?: string
}
