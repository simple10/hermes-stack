/**
 * projectsRepo — Drizzle facade over the `projects` table.
 *
 * Scope: AND(org_id = ctx.orgId, deleted_at IS NULL)
 * No per-principal filter — all authenticated roles see all org projects.
 *
 * Insert stamps: id, orgId, createdAt, updatedAt
 * Update stamps: updatedAt
 * softDelete writes: deletedAt, deletedByType, deletedById (from ctx.principal)
 *
 * UNIQUE violation on insert (slug per org) → throws DuplicateError('project', {existing_project_id}).
 * The repo does a follow-up select to populate existing_project_id in the error details.
 */
import { and, eq, desc, sql, type SQL } from 'drizzle-orm'
import { projects } from '../pool.ts'
import { active, isUniqueViolation } from '../helpers.ts'
import { makeId } from '../../ids.ts'
import { DuplicateError } from './_errors.ts'
import type { AuthContext } from '../../auth/types.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProjectRow = typeof projects.$inferSelect

type ProjectInsertInput = Omit<
  typeof projects.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedByType' | 'deletedById'
>

type ProjectUpdateInput = Partial<
  Omit<
    typeof projects.$inferInsert,
    'id' | 'orgId' | 'createdAt' | 'deletedAt' | 'deletedByType' | 'deletedById'
  >
>

export interface ProjectListFilter {
  limit?: number
  cursor?: { updatedAt: number; id: string }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function projectsRepo(ctx: AuthContext) {
  const scope = and(eq(projects.orgId, ctx.orgId), active(projects))

  return {
    async findById(id: string): Promise<ProjectRow | null> {
      const rows = await ctx.pool
        .select()
        .from(projects)
        .where(and(scope, eq(projects.id, id)))
        .limit(1)
      return rows[0] ?? null
    },

    async list(filter: ProjectListFilter = {}): Promise<ProjectRow[]> {
      const conditions: SQL[] = [scope!]
      if (filter.cursor) {
        conditions.push(
          sql`(${projects.updatedAt}, ${projects.id}) < (${filter.cursor.updatedAt}, ${filter.cursor.id})`,
        )
      }
      return ctx.pool
        .select()
        .from(projects)
        .where(and(...conditions))
        .orderBy(desc(projects.updatedAt), desc(projects.id))
        .limit(filter.limit ?? 50)
    },

    async insert(values: ProjectInsertInput): Promise<ProjectRow> {
      const id = makeId('project')
      const now = Date.now()
      const row = {
        ...values,
        id,
        orgId: ctx.orgId,
        createdAt: now,
        updatedAt: now,
      }
      try {
        const inserted = await ctx.pool.insert(projects).values(row).returning()
        return inserted[0]!
      } catch (e) {
        if (isUniqueViolation(e)) {
          // Look up the existing project by slug to populate details.
          const existing = await ctx.pool
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(eq(projects.orgId, ctx.orgId), eq(projects.slug, values.slug), active(projects)),
            )
            .limit(1)
          throw new DuplicateError(
            'project',
            { existing_project_id: existing[0]?.id ?? null },
            'project.duplicate_slug',
          )
        }
        throw e
      }
    },

    async update(id: string, patch: ProjectUpdateInput): Promise<ProjectRow | null> {
      try {
        const updated = await ctx.pool
          .update(projects)
          .set({ ...patch, updatedAt: Date.now() })
          .where(and(scope, eq(projects.id, id)))
          .returning()
        return updated[0] ?? null
      } catch (e) {
        if (isUniqueViolation(e)) {
          // Slug conflict on update — look up the conflicting project.
          const conflictSlug = patch.slug
          const existing = conflictSlug
            ? await ctx.pool
                .select({ id: projects.id })
                .from(projects)
                .where(
                  and(
                    eq(projects.orgId, ctx.orgId),
                    eq(projects.slug, conflictSlug),
                    active(projects),
                  ),
                )
                .limit(1)
            : []
          throw new DuplicateError(
            'project',
            { existing_project_id: existing[0]?.id ?? null },
            'project.duplicate_slug',
          )
        }
        throw e
      }
    },

    async softDelete(id: string): Promise<ProjectRow | null> {
      const now = Date.now()
      const updated = await ctx.pool
        .update(projects)
        .set({
          deletedAt: now,
          deletedByType: ctx.principal.type,
          deletedById: ctx.principal.id,
          updatedAt: now,
        })
        .where(and(scope, eq(projects.id, id)))
        .returning()
      return updated[0] ?? null
    },

    // Escape hatches
    scoped: () => ctx.pool.select().from(projects).where(scope),
    scope: scope!,
    table: projects,
  }
}
