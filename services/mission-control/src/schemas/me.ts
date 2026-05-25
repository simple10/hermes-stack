// services/mission-control/src/schemas/me.ts
//
// Browser-safe. ONLY imports allowed: zod + sibling schema files.
import { z } from 'zod';
import { MemberRole, PrincipalType } from './common.ts';
import { Agent } from './agents.ts';
import { Connector } from './connectors.ts';

/**
 * GET /v1/me → flat object describing the resolved auth context (per routes/me.ts).
 * The `agent` block is present iff principal_type === 'agent'.
 * The `connector` block is present iff principal_type === 'connector'.
 */
export const MeResponse = z.object({
  org_id: z.string(),
  role: MemberRole.nullable(),
  principal_type: PrincipalType,
  principal_id: z.string(),
  agent: Agent.optional(),
  connector: Connector.optional(),
});
export type MeResponse = z.infer<typeof MeResponse>;
