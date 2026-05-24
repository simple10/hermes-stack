/**
 * orgsRepo — Drizzle facade over the `organization` table (master DB).
 *
 * Scope: always ctx.orgId — you can only operate on your own org via this repo.
 *
 * findById() always returns the org for ctx.orgId (or null if not found).
 * update(patch) applies a patch to ctx.orgId's org row.
 * The route handler is responsible for checking the caller has owner/admin role
 * before calling update.
 */
import { eq } from 'drizzle-orm';
import { organization } from '../master.ts';
import { masterClient } from '../client.ts';
import type { AuthContext } from '../../auth/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OrgRow = typeof organization.$inferSelect;

type OrgUpdateInput = Partial<Omit<typeof organization.$inferInsert,
  'id' | 'createdAt'>>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function orgsRepo(ctx: AuthContext) {
  const master = masterClient(ctx.env);

  return {
    /**
     * Return the organization for ctx.orgId, or null if not found.
     */
    async findById(): Promise<OrgRow | null> {
      const rows = await master
        .select()
        .from(organization)
        .where(eq(organization.id, ctx.orgId))
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * Update the organization for ctx.orgId.
     * Route handler must verify the caller has owner/admin role.
     */
    async update(patch: OrgUpdateInput): Promise<OrgRow | null> {
      const updated = await master
        .update(organization)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(organization.id, ctx.orgId))
        .returning();
      return updated[0] ?? null;
    },

    table: organization,
  };
}
