/**
 * Auth middleware — resolves session cookie OR bearer token into AuthContext.
 *
 * Flow:
 *   1. Try better-auth session (cookie).  If found → use session.activeOrganizationId.
 *   2. Try bearer token via better-auth verifyApiKey.  If found:
 *      a. better-auth returns the standard ApiKey fields (id, userId, metadata, …).
 *      b. Do a follow-up Drizzle query on the apiKey table to fetch orgId +
 *         principalType — better-auth's verifyApiKey does not return custom
 *         additionalFields directly (confirmed against v1.2 types).
 *   3. Resolve the org's pool DB via pool-resolver.
 *   4. Set ctx on `c.var.auth` and call next().
 *   5. Any HttpError from steps 1–4 is serialised to JSON and returned early.
 *
 * Role gates (requireMember, requireMachine, requireAnyRole) are separate
 * middleware factories applied per-route after authMiddleware.
 */
import type { MiddlewareHandler } from 'hono'
import { createAuth } from './config.ts'
import { resolvePoolForOrg } from '../db/pool-resolver.ts'
import { lookupMemberRole } from '../db/repos/members.ts'
import { lookupApiKeyById } from '../db/repos/api-keys.ts'
import { HttpError, errorResponse } from '../errors.ts'
import type { AuthContext, OrgId } from './types.ts'
import { asOrgId } from './types.ts'

// Hono env-shape for every authed middleware in this file. `Bindings: Env`
// makes `c.env` use the wrangler-generated Env type (no per-call-site casts);
// `Variables: { auth }` lets `c.set('auth', …)` / `c.get('auth')` type-check
// without `as any` shims.
type AuthEnv = { Bindings: Env; Variables: { auth: AuthContext } }

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

export const authMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
  try {
    const env = c.env
    const auth = createAuth(env)
    const request = c.req.raw

    let orgId: OrgId | undefined
    let principal: AuthContext['principal'] | undefined
    let role: AuthContext['role'] | undefined
    let viaUserId: string | undefined
    let viaKeyId: string | undefined

    // ------------------------------------------------------------------
    // Path 1: session cookie
    // ------------------------------------------------------------------
    const session = await auth.api.getSession({ headers: request.headers })

    if (session) {
      // session.session is the session row; activeOrganizationId comes from
      // the organization plugin's session extension.
      const activeOrgId = (session.session as { activeOrganizationId?: string | null })
        .activeOrganizationId
      if (!activeOrgId) {
        throw new HttpError(
          403,
          'auth.no_active_org',
          'Session has no active organization. Call setActiveOrganization first.',
        )
      }
      orgId = asOrgId(activeOrgId)
      principal = { type: 'user', id: session.user.id }
      viaUserId = session.user.id

      // Look up the user's role in this org.
      const m = await lookupMemberRole(env, session.user.id, orgId)
      if (!m) {
        throw new HttpError(403, 'auth.not_member', 'Not a member of the active organization')
      }
      role = m.role as AuthContext['role']
    } else {
      // ------------------------------------------------------------------
      // Path 2: bearer token
      // ------------------------------------------------------------------
      const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      if (!bearer) {
        throw new HttpError(401, 'auth.missing', 'Missing Authorization header')
      }

      const verified = await auth.api.verifyApiKey({ body: { key: bearer } })

      if (!verified.valid || !verified.key) {
        // verified.error.message may be a RawError object or a plain string in
        // different union branches — normalise to string for the HttpError.
        const errMsg: unknown = (verified as { error?: { message?: unknown } }).error?.message
        const errorMessage = typeof errMsg === 'string' ? errMsg : 'Invalid or expired token'
        throw new HttpError(401, 'auth.invalid_token', errorMessage)
      }

      const keyId = verified.key.id
      viaKeyId = keyId

      // Workaround: better-auth verifyApiKey returns Omit<ApiKey, "key">
      // which does NOT include our additionalFields (orgId, principalType).
      // We do a follow-up lookup against the apiKey table to fetch them.
      const keyRow = await lookupApiKeyById(env, keyId)
      if (!keyRow) {
        // Race: key was deleted between verify and fetch. Treat as invalid.
        throw new HttpError(401, 'auth.invalid_token', 'API key not found after verification')
      }

      orgId = asOrgId(keyRow.orgId)
      viaUserId = keyRow.userId ?? undefined
      const ptype = keyRow.principalType as 'pat' | 'agent' | 'connector'

      if (ptype === 'pat') {
        principal = { type: 'user', id: keyRow.userId }
        // Look up the user's org role.
        if (!orgId) throw new HttpError(401, 'auth.invalid_token', 'No org_id on key')
        const m = await lookupMemberRole(env, keyRow.userId, orgId)
        if (!m) {
          throw new HttpError(403, 'auth.not_member', 'API key user is not a member of this org')
        }
        role = m.role as AuthContext['role']
      } else if (ptype === 'agent') {
        // metadata is stored as a JSON string in SQLite; Drizzle returns it
        // as a string — parse if needed.
        const meta =
          typeof verified.key.metadata === 'string'
            ? (JSON.parse(verified.key.metadata) as { agent_id?: string })
            : (verified.key.metadata as { agent_id?: string } | null)
        const agentId = meta?.agent_id ?? ''
        principal = { type: 'agent', id: agentId }
        role = 'agent'
      } else if (ptype === 'connector') {
        const meta =
          typeof verified.key.metadata === 'string'
            ? (JSON.parse(verified.key.metadata) as { connector_id?: string })
            : (verified.key.metadata as { connector_id?: string } | null)
        const connectorId = meta?.connector_id ?? ''
        principal = { type: 'connector', id: connectorId }
        role = 'connector'
      } else {
        throw new HttpError(401, 'auth.unknown_principal_type', `Unknown principalType: ${ptype}`)
      }
    }

    // ------------------------------------------------------------------
    // Resolve the pool DB for this org.
    // ------------------------------------------------------------------
    const pool = await resolvePoolForOrg(env, orgId!)

    const ctx: AuthContext = {
      orgId: orgId!,
      role: role!,
      principal: principal!,
      pool,
      env,
      viaUserId,
      viaKeyId,
    }

    // Store on Hono context variable.  Handlers access via c.get('auth').
    c.set('auth', ctx)
    await next()
  } catch (e) {
    return errorResponse(c, e)
  }
}

// ---------------------------------------------------------------------------
// Role gate middleware factories
// ---------------------------------------------------------------------------

/**
 * Restricts a route to human callers (session or PAT) with at least the
 * given role level.  Role hierarchy: owner > admin > member.
 *
 * Usage: app.use('/v1/agents', authMiddleware, requireMember('owner', 'admin'))
 */
export function requireMember(
  ...allowed: Array<'owner' | 'admin' | 'member'>
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const ctx = c.get('auth')
    if (!ctx) {
      return errorResponse(c, new HttpError(401, 'auth.missing', 'Not authenticated'))
    }
    const humanRoles = ['owner', 'admin', 'member'] as const
    if (!(humanRoles as readonly string[]).includes(ctx.role)) {
      return errorResponse(
        c,
        new HttpError(
          403,
          'auth.role_insufficient',
          `This endpoint requires a human role; caller has '${ctx.role}'`,
        ),
      )
    }
    if (!(allowed as string[]).includes(ctx.role)) {
      return errorResponse(
        c,
        new HttpError(
          403,
          'auth.role_insufficient',
          `This endpoint requires one of: ${allowed.join(', ')}; caller has '${ctx.role}'`,
        ),
      )
    }
    await next()
  }
}

/**
 * Restricts a route to machine callers (agent or connector keys).
 *
 * Usage: app.use('/v1/tasks', authMiddleware, requireMachine('agent', 'connector'))
 */
export function requireMachine(
  ...allowed: Array<'agent' | 'connector'>
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const ctx = c.get('auth')
    if (!ctx) {
      return errorResponse(c, new HttpError(401, 'auth.missing', 'Not authenticated'))
    }
    if (!(allowed as string[]).includes(ctx.role)) {
      return errorResponse(
        c,
        new HttpError(
          403,
          'auth.role_insufficient',
          `This endpoint requires one of: ${allowed.join(', ')}; caller has '${ctx.role}'`,
        ),
      )
    }
    await next()
  }
}

/**
 * Restricts a route to any combination of human + machine roles.
 *
 * Usage: app.use('/v1/tasks', authMiddleware, requireAnyRole('owner', 'admin', 'connector'))
 */
export function requireAnyRole(...allowed: Array<AuthContext['role']>): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const ctx = c.get('auth')
    if (!ctx) {
      return errorResponse(c, new HttpError(401, 'auth.missing', 'Not authenticated'))
    }
    if (!(allowed as string[]).includes(ctx.role)) {
      return errorResponse(
        c,
        new HttpError(
          403,
          'auth.role_insufficient',
          `This endpoint requires one of: ${allowed.join(', ')}; caller has '${ctx.role}'`,
        ),
      )
    }
    await next()
  }
}
