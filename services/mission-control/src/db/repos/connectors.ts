/**
 * connectorsRepo — Drizzle facade over the `connectors` table.
 *
 * Mirrors agentsRepo exactly — same scope, same insert/update/softDelete pattern.
 *
 * Scope: AND(org_id = ctx.orgId, deleted_at IS NULL)
 * No per-principal filter — all org members see all connectors.
 *
 * softDelete accepts an optional actor override for compensating actions
 * (e.g., post-create saga cleanup uses deleted_by_type='system').
 *
 * UNIQUE violation on insert (name per org) → throws DuplicateError('connector', {}).
 */
import { and, eq, desc, sql, type SQL } from 'drizzle-orm';
import { connectors } from '../pool.ts';
import { active, isUniqueViolation } from '../helpers.ts';
import { makeId } from '../../ids.ts';
import { DuplicateError } from './_errors.ts';
import type { AuthContext } from '../../auth/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConnectorRow = typeof connectors.$inferSelect;

type ConnectorInsertInput = Omit<typeof connectors.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>;

type ConnectorUpdateInput = Partial<Omit<typeof connectors.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>>;

export interface ConnectorListFilter {
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

export function connectorsRepo(ctx: AuthContext) {
  const scope = and(eq(connectors.orgId, ctx.orgId), active(connectors));

  return {
    async findById(id: string): Promise<ConnectorRow | null> {
      const rows = await ctx.pool.select().from(connectors)
        .where(and(scope, eq(connectors.id, id))).limit(1);
      return rows[0] ?? null;
    },

    async list(filter: ConnectorListFilter = {}): Promise<ConnectorRow[]> {
      const conditions: SQL[] = [scope!];
      if (filter.cursor) {
        conditions.push(
          sql`(${connectors.updatedAt}, ${connectors.id}) > (${filter.cursor.updatedAt}, ${filter.cursor.id})`,
        );
      }
      return ctx.pool.select().from(connectors)
        .where(and(...conditions))
        .orderBy(connectors.updatedAt, connectors.id)
        .limit(filter.limit ?? 50);
    },

    async insert(values: ConnectorInsertInput): Promise<ConnectorRow> {
      const id = makeId('connector');
      const now = Date.now();
      const row = {
        ...values,
        id,
        orgId: ctx.orgId,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const inserted = await ctx.pool.insert(connectors).values(row).returning();
        return inserted[0]!;
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new DuplicateError('connector', {}, 'connector.duplicate_name');
        }
        throw e;
      }
    },

    async update(id: string, patch: ConnectorUpdateInput): Promise<ConnectorRow | null> {
      const updated = await ctx.pool.update(connectors)
        .set({ ...patch, updatedAt: Date.now() })
        .where(and(scope, eq(connectors.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    /**
     * Soft-delete a connector.
     *
     * @param id    Connector ID to delete.
     * @param actor Optional actor override.  Defaults to ctx.principal.
     *              Pass `{ type: 'system', id: null }` for compensating actions
     *              (e.g., post-create saga rollback) so deleted_by_type='system'
     *              matches existing behavior.
     */
    async softDelete(id: string, actor?: SoftDeleteActor): Promise<ConnectorRow | null> {
      const now = Date.now();
      const deleter = actor ?? { type: ctx.principal.type, id: ctx.principal.id };
      const updated = await ctx.pool.update(connectors)
        .set({
          deletedAt: now,
          deletedByType: deleter.type,
          deletedById: deleter.id,
          updatedAt: now,
        })
        .where(actor
          ? and(eq(connectors.id, id), eq(connectors.orgId, ctx.orgId))
          : and(scope, eq(connectors.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    // Escape hatches
    scoped: () => ctx.pool.select().from(connectors).where(scope),
    scope: scope!,
    table: connectors,
  };
}
