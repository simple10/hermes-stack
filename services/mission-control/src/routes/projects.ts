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
import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { authMiddleware, requireAnyRole } from '../auth/middleware.ts';
import { projects } from '../db/pool.ts';
import { HttpError, errorResponse } from '../errors.ts';
import { makeId } from '../ids.ts';
import { active, serializeTimestamps } from '../db/helpers.ts';
import { emitEvent } from '../events/emit.ts';
import { encodeCursor, decodeCursor, clampLimit } from '../pagination.ts';
import type { AuthContext } from '../auth/types.ts';

type Variables = { auth: AuthContext };

export const projectsRouter = new Hono<{ Variables: Variables }>();
projectsRouter.use('*', authMiddleware);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const createSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(64),
  description: z.string().max(2000).optional(),
});

const patchSchema = createSchema.partial();

// ---------------------------------------------------------------------------
// POST /v1/projects
// ---------------------------------------------------------------------------

projectsRouter.post(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector'),
  async (c) => {
    try {
      const ctx = c.var.auth;

      const raw = await c.req.json().catch(() => {
        throw new HttpError(400, 'project.bad_request', 'Request body must be valid JSON');
      });
      const input = createSchema.safeParse(raw);
      if (!input.success) {
        throw new HttpError(
          400,
          'project.validation_error',
          input.error.issues[0]?.message ?? 'Validation failed',
          input.error.issues,
        );
      }
      const { name, slug, description } = input.data;

      const projectId = makeId('project');
      const now = Date.now();

      try {
        await ctx.pool.insert(projects).values({
          id: projectId,
          orgId: ctx.orgId,
          name,
          slug,
          description: description ?? null,
          createdByUserId: ctx.viaUserId ?? null,
          createdAt: now,
          updatedAt: now,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('UNIQUE') || msg.includes('unique')) {
          // Find the conflicting project to return its id.
          const existing = await ctx.pool.query.projects.findFirst({
            where: and(eq(projects.orgId, ctx.orgId), eq(projects.slug, slug), active(projects)),
          });
          throw new HttpError(
            409,
            'project.duplicate_slug',
            `A project with slug '${slug}' already exists in this org`,
            { existing_project_id: existing?.id ?? null },
          );
        }
        throw e;
      }

      const row = await ctx.pool.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.orgId, ctx.orgId)),
      });
      if (!row) {
        throw new HttpError(500, 'internal', 'Project row disappeared after insert');
      }

      await emitEvent(ctx.pool, {
        orgId: ctx.orgId,
        resourceType: 'project',
        resourceId: projectId,
        kind: 'project.created',
        actor: ctx.principal,
      });

      return c.json({ project: serializeTimestamps(row) }, 201);
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/projects
// ---------------------------------------------------------------------------

projectsRouter.get(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const env = c.env as any;

      const limitRaw = c.req.query('limit');
      const cursorRaw = c.req.query('cursor');
      const limit = clampLimit(limitRaw, 50, 100);

      const secret = (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET ?? '';

      let afterUpdatedAt: number | undefined;
      let afterId: string | undefined;

      if (cursorRaw) {
        const decoded = await decodeCursor(cursorRaw, secret);
        if (!decoded || decoded.orgId !== ctx.orgId) {
          throw new HttpError(400, 'project.invalid_cursor', 'Invalid or expired pagination cursor');
        }
        afterUpdatedAt = decoded.updatedAt;
        afterId = decoded.id;
      }

      let rows: typeof projects.$inferSelect[];

      if (afterUpdatedAt !== undefined && afterId !== undefined) {
        rows = await ctx.pool
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.orgId, ctx.orgId),
              active(projects),
              or(
                lt(projects.updatedAt, afterUpdatedAt),
                and(eq(projects.updatedAt, afterUpdatedAt), lt(projects.id, afterId)),
              ),
            ),
          )
          .orderBy(desc(projects.updatedAt), desc(projects.id))
          .limit(limit + 1);
      } else {
        rows = await ctx.pool
          .select()
          .from(projects)
          .where(and(eq(projects.orgId, ctx.orgId), active(projects)))
          .orderBy(desc(projects.updatedAt), desc(projects.id))
          .limit(limit + 1);
      }

      const hasMore = rows.length > limit;
      if (hasMore) rows = rows.slice(0, limit);

      let nextCursor: string | null = null;
      if (hasMore) {
        const last = rows[rows.length - 1]!;
        nextCursor = await encodeCursor(
          { updatedAt: last.updatedAt, id: last.id, orgId: ctx.orgId },
          secret,
        );
      }

      return c.json({
        projects: rows.map(serializeTimestamps),
        next_cursor: nextCursor,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /v1/projects/:id
// ---------------------------------------------------------------------------

projectsRouter.get(
  '/:id',
  requireAnyRole('owner', 'admin', 'member', 'connector', 'agent'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const id = c.req.param('id');

      const row = await ctx.pool.query.projects.findFirst({
        where: and(eq(projects.id, id), eq(projects.orgId, ctx.orgId), active(projects)),
      });
      if (!row) {
        throw new HttpError(404, 'project.not_found', `Project ${id} not found`);
      }

      return c.json({ project: serializeTimestamps(row) });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /v1/projects/:id
// ---------------------------------------------------------------------------

projectsRouter.patch(
  '/:id',
  requireAnyRole('owner', 'admin', 'member', 'connector'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const id = c.req.param('id');

      const raw = await c.req.json().catch(() => {
        throw new HttpError(400, 'project.bad_request', 'Request body must be valid JSON');
      });
      const input = patchSchema.safeParse(raw);
      if (!input.success) {
        throw new HttpError(
          400,
          'project.validation_error',
          input.error.issues[0]?.message ?? 'Validation failed',
          input.error.issues,
        );
      }

      const existing = await ctx.pool.query.projects.findFirst({
        where: and(eq(projects.id, id), eq(projects.orgId, ctx.orgId), active(projects)),
      });
      if (!existing) {
        throw new HttpError(404, 'project.not_found', `Project ${id} not found`);
      }

      const now = Date.now();
      const patch: Partial<typeof projects.$inferInsert> = { updatedAt: now };
      if (input.data.name !== undefined) patch.name = input.data.name;
      if (input.data.slug !== undefined) patch.slug = input.data.slug;
      if ('description' in input.data) patch.description = input.data.description ?? null;

      try {
        await ctx.pool
          .update(projects)
          .set(patch)
          .where(and(eq(projects.id, id), eq(projects.orgId, ctx.orgId)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('UNIQUE') || msg.includes('unique')) {
          const conflictSlug = input.data.slug ?? existing.slug;
          const conflicting = await ctx.pool.query.projects.findFirst({
            where: and(
              eq(projects.orgId, ctx.orgId),
              eq(projects.slug, conflictSlug),
              active(projects),
            ),
          });
          throw new HttpError(
            409,
            'project.duplicate_slug',
            `A project with slug '${conflictSlug}' already exists in this org`,
            { existing_project_id: conflicting?.id ?? null },
          );
        }
        throw e;
      }

      const updated = await ctx.pool.query.projects.findFirst({
        where: and(eq(projects.id, id), eq(projects.orgId, ctx.orgId)),
      });

      await emitEvent(ctx.pool, {
        orgId: ctx.orgId,
        resourceType: 'project',
        resourceId: id,
        kind: 'project.updated',
        actor: ctx.principal,
      });

      return c.json({ project: serializeTimestamps(updated!) });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/projects/:id
// ---------------------------------------------------------------------------

projectsRouter.delete(
  '/:id',
  requireAnyRole('owner', 'admin', 'connector'),
  async (c) => {
    try {
      const ctx = c.var.auth;
      const id = c.req.param('id');

      const existing = await ctx.pool.query.projects.findFirst({
        where: and(eq(projects.id, id), eq(projects.orgId, ctx.orgId), active(projects)),
      });
      if (!existing) {
        throw new HttpError(404, 'project.not_found', `Project ${id} not found`);
      }

      const now = Date.now();
      await ctx.pool
        .update(projects)
        .set({
          deletedAt: now,
          deletedByType: ctx.principal.type,
          deletedById: ctx.principal.id,
          updatedAt: now,
        })
        .where(and(eq(projects.id, id), eq(projects.orgId, ctx.orgId)));

      await emitEvent(ctx.pool, {
        orgId: ctx.orgId,
        resourceType: 'project',
        resourceId: id,
        kind: 'project.deleted',
        actor: ctx.principal,
      });

      return c.json({}, 200);
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);
