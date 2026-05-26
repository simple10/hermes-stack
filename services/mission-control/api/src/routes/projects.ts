/**
 * /v1/projects — CRUD for project records.
 *
 * Endpoints:
 *   POST   /v1/projects     create (owner|admin|member|connector)
 *   GET    /v1/projects     list active, cursor pagination (any authenticated role)
 *   GET    /v1/projects/:id detail (any authenticated role)
 *   PATCH  /v1/projects/:id update name/description/slug (owner|admin|member|connector)
 *   DELETE /v1/projects/:id soft delete (owner|admin|connector)
 *
 * Slug uniqueness: partial unique index `projects_slug_per_org_active` enforces
 * uniqueness per org for active (non-deleted) projects. On conflict → 409
 * project.duplicate_slug with details.existing_project_id.
 *
 * Events: project.created, project.updated, project.deleted.
 *
 * Cascade: the DB trigger handles cascading soft-deletes on external_refs when
 * a project is deleted — no app-level logic required.
 */
import { Hono } from 'hono'
import { requireAnyRole } from '../auth/middleware.ts'
import { ProjectCreateBody as createSchema } from '../schemas/projects.ts'
import { HttpError, errorResponse } from '../errors.ts'
import { serializeTimestamps } from '../db/helpers.ts'
import { db } from '../db/repos/index.ts'
import { encodeCursor, decodeCursor, clampLimit } from '../pagination.ts'
import type { AuthContext } from '../auth/types.ts'

type Variables = { auth: AuthContext }

// authMiddleware is applied at the /api/v1 parent in src/index.ts.
export const projectsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// createSchema imported from ../schemas/projects.ts (AgentCreateBody alias).
// patchSchema is derived locally — same shape, all fields optional.
const patchSchema = createSchema.partial()

// ---------------------------------------------------------------------------
// POST /v1/projects
// ---------------------------------------------------------------------------

projectsRouter.post('/', requireAnyRole('owner', 'admin', 'member', 'connector'), async (c) => {
  try {
    const ctx = c.var.auth

    const raw = await c.req.json().catch(() => {
      throw new HttpError(400, 'project.bad_request', 'Request body must be valid JSON')
    })
    const input = createSchema.safeParse(raw)
    if (!input.success) {
      throw new HttpError(
        400,
        'project.validation_error',
        input.error.issues[0]?.message ?? 'Validation failed',
        input.error.issues,
      )
    }
    const { name, slug, description } = input.data

    // DuplicateError from the repo is caught by errorResponse → 409 project.duplicate
    // The repo populates existing_project_id in the error details.
    const row = await db.projects(ctx).insert({
      name,
      slug,
      description: description ?? null,
      createdByUserId: ctx.viaUserId ?? null,
    })

    await db.events(ctx).emit({
      resourceType: 'project',
      resourceId: row.id,
      kind: 'project.created',
    })

    return c.json({ project: serializeTimestamps(row) }, 201)
  } catch (e) {
    return errorResponse(c, e)
  }
})

// ---------------------------------------------------------------------------
// GET /v1/projects
// ---------------------------------------------------------------------------

projectsRouter.get(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth

      const limitRaw = c.req.query('limit')
      const cursorRaw = c.req.query('cursor')
      const limit = clampLimit(limitRaw, 50, 100)

      const secret = c.env.BETTER_AUTH_SECRET ?? ''

      let cursor: { updatedAt: number; id: string } | undefined

      if (cursorRaw) {
        const decoded = await decodeCursor(cursorRaw, secret)
        if (!decoded || decoded.orgId !== ctx.orgId) {
          throw new HttpError(400, 'project.invalid_cursor', 'Invalid or expired pagination cursor')
        }
        cursor = { updatedAt: decoded.updatedAt, id: decoded.id }
      }

      let rows = await db.projects(ctx).list({ limit: limit + 1, cursor })

      const hasMore = rows.length > limit
      if (hasMore) rows = rows.slice(0, limit)

      let nextCursor: string | null = null
      if (hasMore) {
        const last = rows[rows.length - 1]!
        nextCursor = await encodeCursor(
          { updatedAt: last.updatedAt, id: last.id, orgId: ctx.orgId },
          secret,
        )
      }

      return c.json({
        projects: rows.map(serializeTimestamps),
        next_cursor: nextCursor,
      })
    } catch (e) {
      return errorResponse(c, e)
    }
  },
)

// ---------------------------------------------------------------------------
// GET /v1/projects/:id
// ---------------------------------------------------------------------------

projectsRouter.get(
  '/:id',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth
      const id = c.req.param('id')

      const row = await db.projects(ctx).findById(id)
      if (!row) {
        throw new HttpError(404, 'project.not_found', `Project ${id} not found`)
      }

      return c.json({ project: serializeTimestamps(row) })
    } catch (e) {
      return errorResponse(c, e)
    }
  },
)

// ---------------------------------------------------------------------------
// PATCH /v1/projects/:id
// ---------------------------------------------------------------------------

projectsRouter.patch('/:id', requireAnyRole('owner', 'admin', 'member', 'connector'), async (c) => {
  try {
    const ctx = c.var.auth
    const id = c.req.param('id')

    const raw = await c.req.json().catch(() => {
      throw new HttpError(400, 'project.bad_request', 'Request body must be valid JSON')
    })
    const input = patchSchema.safeParse(raw)
    if (!input.success) {
      throw new HttpError(
        400,
        'project.validation_error',
        input.error.issues[0]?.message ?? 'Validation failed',
        input.error.issues,
      )
    }

    const existing = await db.projects(ctx).findById(id)
    if (!existing) {
      throw new HttpError(404, 'project.not_found', `Project ${id} not found`)
    }

    const patch: { name?: string; slug?: string; description?: string | null } = {}
    if (input.data.name !== undefined) patch.name = input.data.name
    if (input.data.slug !== undefined) patch.slug = input.data.slug
    if ('description' in input.data) patch.description = input.data.description ?? null

    // DuplicateError from the repo (slug conflict) → errorResponse → 409 project.duplicate
    const updated = await db.projects(ctx).update(id, patch)

    await db.events(ctx).emit({
      resourceType: 'project',
      resourceId: id,
      kind: 'project.updated',
    })

    return c.json({ project: serializeTimestamps(updated!) })
  } catch (e) {
    return errorResponse(c, e)
  }
})

// ---------------------------------------------------------------------------
// DELETE /v1/projects/:id
// ---------------------------------------------------------------------------

projectsRouter.delete('/:id', requireAnyRole('owner', 'admin', 'connector'), async (c) => {
  try {
    const ctx = c.var.auth
    const id = c.req.param('id')

    const existing = await db.projects(ctx).findById(id)
    if (!existing) {
      throw new HttpError(404, 'project.not_found', `Project ${id} not found`)
    }

    await db.projects(ctx).softDelete(id)

    await db.events(ctx).emit({
      resourceType: 'project',
      resourceId: id,
      kind: 'project.deleted',
    })

    return c.json({}, 200)
  } catch (e) {
    return errorResponse(c, e)
  }
})
