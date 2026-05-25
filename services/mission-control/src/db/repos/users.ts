/**
 * usersRepo — Drizzle facade over the `user` table (master DB).
 *
 * Scope: user must be a member of ctx.orgId.
 *
 * findById joins through the `member` table to ensure the user belongs to the org.
 * listByOrg returns all users who are members of ctx.orgId.
 *
 * Writes (insert/update) are delegated to better-auth's own API — this repo
 * is read-only from the application perspective.
 */
import { and, eq } from 'drizzle-orm';
import { user, member } from '../master.ts';
import { masterClient } from '../client.ts';
import type { AuthContext } from '../../auth/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UserRow = typeof user.$inferSelect;

// ---------------------------------------------------------------------------
// Static lookup — for bootstrap (no ctx available)
// ---------------------------------------------------------------------------

/**
 * Check whether ANY user exists in the master DB.
 *
 * Used by the bootstrap endpoint BEFORE any AuthContext exists to gate the
 * one-time setup flow.  Returns true if at least one user row exists.
 */
export async function lookupAnyUserExists(env: Env): Promise<boolean> {
  const master = masterClient(env);
  const rows = await master.select({ id: user.id }).from(user).limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function usersRepo(ctx: AuthContext) {
  const master = masterClient(ctx.env);

  return {
    /**
     * Return a user only if they are a member of ctx.orgId.
     *
     * Query:
     *   SELECT user.* FROM user
     *   INNER JOIN member ON member.user_id = user.id
     *     AND member.organization_id = ctx.orgId
     *   WHERE user.id = userId
     *   LIMIT 1
     */
    async findById(userId: string): Promise<UserRow | null> {
      const rows = await master
        .select({ user: user })
        .from(user)
        .innerJoin(member, and(
          eq(member.userId, user.id),
          eq(member.organizationId, ctx.orgId),
        ))
        .where(eq(user.id, userId))
        .limit(1);
      return rows[0]?.user ?? null;
    },

    /**
     * List all users who are members of ctx.orgId.
     */
    async listByOrg(): Promise<UserRow[]> {
      const rows = await master
        .select({ user: user })
        .from(user)
        .innerJoin(member, and(
          eq(member.userId, user.id),
          eq(member.organizationId, ctx.orgId),
        ));
      return rows.map((r) => r.user);
    },

    table: user,
  };
}
