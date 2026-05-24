/**
 * Test helper — build an AuthContext directly for repo unit tests.
 *
 * These contexts bypass the HTTP layer and auth middleware entirely.
 * Use only in test/db/repos/* — production code must never import this.
 */
import { poolClient, type Env } from '../../../src/db/client.ts';
import { asOrgId, type OrgId } from '../../../src/auth/types.ts';
import type { AuthContext } from '../../../src/auth/types.ts';
import { makeId } from '../../../src/ids.ts';

export { asOrgId };
export type { OrgId };

/** Build an owner-role AuthContext for a given org/user. */
export function ownerCtx(
  db: D1Database,
  env: Env,
  orgId: OrgId,
  userId: string,
): AuthContext {
  return {
    orgId,
    role: 'owner',
    principal: { type: 'user', id: userId },
    pool: poolClient(db),
    env,
    viaUserId: userId,
    viaKeyId: makeId('apk'),
  };
}

/** Build an agent-role AuthContext. */
export function agentCtx(
  db: D1Database,
  env: Env,
  orgId: OrgId,
  agentId: string,
  userId?: string,
): AuthContext {
  return {
    orgId,
    role: 'agent',
    principal: { type: 'agent', id: agentId },
    pool: poolClient(db),
    env,
    viaUserId: userId,
    viaKeyId: makeId('apk'),
  };
}

/** Build a connector-role AuthContext. */
export function connectorCtx(
  db: D1Database,
  env: Env,
  orgId: OrgId,
  connectorId: string,
  userId?: string,
): AuthContext {
  return {
    orgId,
    role: 'connector',
    principal: { type: 'connector', id: connectorId },
    pool: poolClient(db),
    env,
    viaUserId: userId,
    viaKeyId: makeId('apk'),
  };
}
