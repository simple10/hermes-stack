/**
 * tasksRepo — Drizzle facade over the `tasks` table.
 *
 * Scope enforced automatically:
 *   AND(org_id = ctx.orgId, deleted_at IS NULL, [agent principal filter])
 *
 * Per-principal filter:
 *   agent role → AND(agent_id = ctx.principal.id)   (agents see only their own tasks)
 *   all other roles → no extra filter
 *
 * Insert stamps: id, orgId, createdAt, updatedAt  (cannot be supplied by caller)
 * Update stamps: updatedAt  (cannot be changed by caller)
 * softDelete writes: deletedAt, deletedByType, deletedById  (from ctx.principal)
 */
import { and, eq, gt, desc, sql, type SQL } from 'drizzle-orm';
import { tasks } from '../pool.ts';
import { active, isUniqueViolation } from '../helpers.ts';
import { makeId } from '../../ids.ts';
import { DuplicateError } from './_errors.ts';
import type { AuthContext } from '../../auth/types.ts';
import type { TaskStatus } from '../../state-machine/tasks.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskRow = typeof tasks.$inferSelect;

type TaskInsertInput = Omit<typeof tasks.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>;

type TaskUpdateInput = Partial<Omit<typeof tasks.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>>;

export interface TaskListFilter {
  projectId?: string;
  agentId?: string;
  statuses?: TaskStatus[];
  updatedSince?: number;
  limit?: number;
  cursor?: { updatedAt: number; id: string }; // already decoded by caller
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function tasksRepo(ctx: AuthContext) {
  // Per-principal filter — agent role only sees its own tasks
  const principalFilter: SQL | undefined = ctx.principal.type === 'agent'
    ? eq(tasks.agentId, ctx.principal.id)
    : undefined;

  const scope = and(eq(tasks.orgId, ctx.orgId), active(tasks), principalFilter);

  return {
    async findById(id: string): Promise<TaskRow | null> {
      const rows = await ctx.pool.select().from(tasks)
        .where(and(scope, eq(tasks.id, id))).limit(1);
      return rows[0] ?? null;
    },

    async list(filter: TaskListFilter = {}): Promise<TaskRow[]> {
      const conditions: SQL[] = [scope!];
      if (filter.projectId)  conditions.push(eq(tasks.projectId, filter.projectId));
      if (filter.agentId)    conditions.push(eq(tasks.agentId, filter.agentId));
      if (filter.statuses?.length) {
        conditions.push(sql`${tasks.status} IN (${sql.join(filter.statuses.map(s => sql`${s}`), sql`, `)})`);
      }
      if (filter.updatedSince !== undefined)
        conditions.push(gt(tasks.updatedAt, filter.updatedSince));
      if (filter.cursor) {
        conditions.push(
          sql`(${tasks.updatedAt}, ${tasks.id}) < (${filter.cursor.updatedAt}, ${filter.cursor.id})`,
        );
      }
      return ctx.pool.select().from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(filter.limit ?? 50);
    },

    async insert(values: TaskInsertInput): Promise<TaskRow> {
      const id = makeId('task');
      const now = Date.now();
      const row = {
        ...values,
        id,
        orgId: ctx.orgId,
        createdAt: now,
        updatedAt: now,
      };
      try {
        const inserted = await ctx.pool.insert(tasks).values(row).returning();
        return inserted[0]!;
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new DuplicateError('task', {});
        }
        throw e;
      }
    },

    async update(id: string, patch: TaskUpdateInput): Promise<TaskRow | null> {
      const updated = await ctx.pool.update(tasks)
        .set({ ...patch, updatedAt: Date.now() })
        .where(and(scope, eq(tasks.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    async softDelete(id: string): Promise<TaskRow | null> {
      const now = Date.now();
      const updated = await ctx.pool.update(tasks)
        .set({
          deletedAt: now,
          deletedByType: ctx.principal.type,
          deletedById: ctx.principal.id,
          updatedAt: now,
        })
        .where(and(scope, eq(tasks.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    /**
     * Count active (non-terminal) tasks for a given agent within this org.
     * Used by the agent-delete route to enforce the active-tasks gate.
     * Does NOT apply the per-principal scope filter — it's an admin-level count.
     */
    async countActiveByAgent(agentId: string): Promise<number> {
      const result = await ctx.pool.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(
          eq(tasks.orgId, ctx.orgId),
          eq(tasks.agentId, agentId),
          active(tasks),
          sql`${tasks.status} IN ('ready', 'in_progress', 'blocked')`,
        ));
      return result[0]?.count ?? 0;
    },

    // Escape hatches
    scoped: () => ctx.pool.select().from(tasks).where(scope),
    scope: scope!,
    table: tasks,
  };
}
