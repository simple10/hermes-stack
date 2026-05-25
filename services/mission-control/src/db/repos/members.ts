/**
 * membersRepo — Drizzle facade over the `member` table (master DB).
 *
 * Two usage patterns:
 *
 *   1. membersRepo(ctx)  — handler-side; ctx is already resolved.
 *      Methods: roleForCurrentUser(), list()
 *
 *   2. lookupMemberRole(env, userId, orgId)  — middleware-side static lookup.
 *      Called BEFORE ctx exists (the middleware is BUILDING ctx), so it cannot
 *      take AuthContext.  Returns null if the user is not a member of the org.
 *
 * The distinction is important: the middleware call happens during auth
 * resolution, when there is no AuthContext yet.  Any code that has a ctx
 * should use membersRepo(ctx).roleForCurrentUser() instead.
 */
import { and, eq } from 'drizzle-orm';
import { member } from '../master.ts';
import { masterClient } from '../client.ts';
import type { AuthContext } from '../../auth/types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MemberRow = typeof member.$inferSelect;

// ---------------------------------------------------------------------------
// Static lookup — for middleware (no ctx available)
// ---------------------------------------------------------------------------

/**
 * Look up a member's role without an AuthContext.
 *
 * Used by auth middleware BEFORE ctx is constructed.
 * Returns { role } if the user is a member of orgId, or null otherwise.
 */
export async function lookupMemberRole(
  env: Env,
  userId: string,
  orgId: string,
): Promise<{ role: string } | null> {
  const master = masterClient(env);
  const rows = await master
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Factory — for handlers (ctx available)
// ---------------------------------------------------------------------------

export function membersRepo(ctx: AuthContext) {
  const master = masterClient(ctx.env);

  return {
    /**
     * Return the calling user's role in ctx.orgId.
     * Returns null if the current user (ctx.viaUserId) is not a member.
     */
    async roleForCurrentUser(): Promise<{ role: string } | null> {
      if (!ctx.viaUserId) return null;
      return lookupMemberRole(ctx.env, ctx.viaUserId, ctx.orgId);
    },

    /**
     * List all members of ctx.orgId.
     */
    async list(): Promise<MemberRow[]> {
      return master
        .select()
        .from(member)
        .where(eq(member.organizationId, ctx.orgId));
    },

    table: member,
  };
}
