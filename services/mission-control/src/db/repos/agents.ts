/**
 * agentsRepo — Drizzle facade over the `agents` table.
 *
 * Scope: AND(org_id = ctx.orgId, deleted_at IS NULL)
 * No per-principal filter — all org members see all agents.
 *
 * Insert stamps: id, orgId, createdAt, updatedAt
 * Update stamps: updatedAt
 * softDelete writes: deletedAt, deletedByType, deletedById (from ctx.principal)
 *
 * softDelete accepts an optional actor override for compensating actions
 * (e.g., the post-create saga cleanup uses deleted_by_type='system').
 *
 * UNIQUE violation on insert (name per org) → throws DuplicateError('agent', {}).
 */
import { and, eq, desc, sql, type SQL } from 'drizzle-orm';
import { agents } from '../pool.ts';
import { active, isUniqueViolation } from '../helpers.ts';
import { makeId } from '../../ids.ts';
import { DuplicateError } from './_errors.ts';
import type { AuthContext } from '../../auth/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentRow = typeof agents.$inferSelect;

type AgentInsertInput = Omit<typeof agents.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>;

type AgentUpdateInput = Partial<Omit<typeof agents.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>>;

export interface AgentListFilter {
  limit?: number;
  cursor?: { updatedAt: number; id: string };
}

/** Optional actor override for softDelete (for compensating actions). */
export interface SoftDeleteActor {
  type: string;
  id: string | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function agentsRepo(ctx: AuthContext) {
  const scope = and(eq(agents.orgId, ctx.orgId), active(agents));

  return {
    async findById(id: string): Promise<AgentRow | null> {
      const rows = await ctx.pool.select().from(agents)
        .where(and(scope, eq(agents.id, id))).limit(1);
      return rows[0] ?? null;
    },

    async list(filter: AgentListFilter = {}): Promise<AgentRow[]> {
      const conditions: SQL[] = [scope!];
      if (filter.cursor) {
        conditions.push(
          sql`(${agents.updatedAt}, ${agents.id}) > (${filter.cursor.updatedAt}, ${filter.cursor.id})`,
        );
      }
      return ctx.pool.select().from(agents)
        .where(and(...conditions))
        .orderBy(agents.updatedAt, agents.id)
        .limit(filter.limit ?? 50);
    },

    async insert(values: AgentInsertInput): Promise<AgentRow> {
      const id = makeId('agent');
      const now = Date.now();
      const row = {
        ...values,
        id,
        orgId: ctx.orgId,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const inserted = await ctx.pool.insert(agents).values(row).returning();
        return inserted[0]!;
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new DuplicateError('agent', {}, 'agent.duplicate_name');
        }
        throw e;
      }
    },

    async update(id: string, patch: AgentUpdateInput): Promise<AgentRow | null> {
      const updated = await ctx.pool.update(agents)
        .set({ ...patch, updatedAt: Date.now() })
        .where(and(scope, eq(agents.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    /**
     * Soft-delete an agent.
     *
     * @param id    Agent ID to delete.
     * @param actor Optional actor override.  Defaults to ctx.principal.
     *              Pass `{ type: 'system', id: null }` for compensating actions
     *              (e.g., post-create saga rollback) so deleted_by_type='system'
     *              matches existing behavior.
     */
    async softDelete(id: string, actor?: SoftDeleteActor): Promise<AgentRow | null> {
      const now = Date.now();
      const deleter = actor ?? { type: ctx.principal.type, id: ctx.principal.id };
      const updated = await ctx.pool.update(agents)
        .set({
          deletedAt: now,
          deletedByType: deleter.type,
          deletedById: deleter.id,
          updatedAt: now,
        })
        // For compensating deletes (actor override) don't apply the principal scope.
        // For normal deletes, apply scope to prevent cross-org accidents.
        .where(actor
          ? and(eq(agents.id, id), eq(agents.orgId, ctx.orgId))
          : and(scope, eq(agents.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    // Escape hatches
    scoped: () => ctx.pool.select().from(agents).where(scope),
    scope: scope!,
    table: agents,
  };
}
