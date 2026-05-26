/**
 * externalRefsRepo — Drizzle facade over the `external_refs` table.
 *
 * Scope: AND(org_id = ctx.orgId, deleted_at IS NULL)
 *
 * Per-principal source_id enforcement on INSERT:
 *   agent or connector role → sourceId MUST equal ctx.principal.id
 *   Otherwise throws ForbiddenError('external_ref.source_id_forbidden', ...)
 *
 * UNIQUE violation on insert → throws DuplicateError('external_ref', {}).
 *
 * Insert stamps: id, orgId, createdAt, updatedAt
 * softDelete writes: deletedAt, deletedByType, deletedById (from ctx.principal)
 */
import { and, eq, lt, or, desc, sql, type SQL } from 'drizzle-orm'
import { externalRefs } from '../pool.ts'
import { active, isUniqueViolation } from '../helpers.ts'
import { makeId } from '../../ids.ts'
import { DuplicateError, ForbiddenError } from './_errors.ts'
import type { AuthContext } from '../../auth/types.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExternalRefRow = typeof externalRefs.$inferSelect

type ExternalRefInsertInput = Omit<
  typeof externalRefs.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedByType' | 'deletedById'
>

export interface ExternalRefListFilter {
  resourceType?: string
  resourceId?: string
  sourceKind?: string
  sourceId?: string
  externalId?: string
  limit?: number
  cursor?: { createdAt: number; id: string }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function externalRefsRepo(ctx: AuthContext) {
  const scope = and(eq(externalRefs.orgId, ctx.orgId), active(externalRefs))

  return {
    async findById(id: string): Promise<ExternalRefRow | null> {
      const rows = await ctx.pool
        .select()
        .from(externalRefs)
        .where(and(scope, eq(externalRefs.id, id)))
        .limit(1)
      return rows[0] ?? null
    },

    async list(filter: ExternalRefListFilter = {}): Promise<ExternalRefRow[]> {
      const conditions: SQL[] = [scope!]
      if (filter.resourceType) conditions.push(eq(externalRefs.resourceType, filter.resourceType))
      if (filter.resourceId) conditions.push(eq(externalRefs.resourceId, filter.resourceId))
      if (filter.sourceKind) conditions.push(eq(externalRefs.sourceKind, filter.sourceKind))
      if (filter.sourceId) conditions.push(eq(externalRefs.sourceId, filter.sourceId))
      if (filter.externalId) conditions.push(eq(externalRefs.externalId, filter.externalId))

      if (filter.cursor) {
        conditions.push(
          or(
            lt(externalRefs.createdAt, filter.cursor.createdAt),
            and(
              eq(externalRefs.createdAt, filter.cursor.createdAt),
              lt(externalRefs.id, filter.cursor.id),
            ),
          )!,
        )
      }

      return ctx.pool
        .select()
        .from(externalRefs)
        .where(and(...conditions))
        .orderBy(desc(externalRefs.createdAt), desc(externalRefs.id))
        .limit(filter.limit ?? 50)
    },

    async insert(values: ExternalRefInsertInput): Promise<ExternalRefRow> {
      // Per-principal enforcement: agents and connectors can only post refs for themselves.
      if (
        (ctx.principal.type === 'agent' || ctx.principal.type === 'connector') &&
        values.sourceId !== ctx.principal.id
      ) {
        throw new ForbiddenError(
          'external_ref.source_id_mismatch',
          `${ctx.principal.type === 'agent' ? 'Agents' : 'Connectors'} may only create refs where source_id equals their own id ('${ctx.principal.id}')`,
          { principal_id: ctx.principal.id, provided_source_id: values.sourceId },
        )
      }

      const id = makeId('externalRef')
      const now = Date.now()
      const row = {
        ...values,
        id,
        orgId: ctx.orgId,
        createdAt: now,
        updatedAt: now,
      }
      try {
        const inserted = await ctx.pool.insert(externalRefs).values(row).returning()
        return inserted[0]!
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new DuplicateError('external_ref', {})
        }
        throw e
      }
    },

    async softDelete(id: string): Promise<ExternalRefRow | null> {
      const now = Date.now()
      const updated = await ctx.pool
        .update(externalRefs)
        .set({
          deletedAt: now,
          deletedByType: ctx.principal.type,
          deletedById: ctx.principal.id,
          updatedAt: now,
        })
        .where(and(scope, eq(externalRefs.id, id)))
        .returning()
      return updated[0] ?? null
    },

    /**
     * Count active external refs by source ID (regardless of sourceKind).
     * Used by the connector-delete route to enforce the active-refs gate.
     */
    async countBySource(sourceId: string): Promise<number> {
      const result = await ctx.pool
        .select({ count: sql<number>`count(*)` })
        .from(externalRefs)
        .where(
          and(
            eq(externalRefs.orgId, ctx.orgId),
            eq(externalRefs.sourceId, sourceId),
            active(externalRefs),
          ),
        )
      return result[0]?.count ?? 0
    },

    // Escape hatches
    scoped: () => ctx.pool.select().from(externalRefs).where(scope),
    scope: scope!,
    table: externalRefs,
  }
}
