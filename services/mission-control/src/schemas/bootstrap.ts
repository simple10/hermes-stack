// services/mission-control/src/schemas/bootstrap.ts
//
// Browser-safe. ONLY imports allowed: zod + sibling schema files.
import { z } from 'zod'
import { IdSlug } from './common.ts'

/** POST /v1/bootstrap body (per bodySchema in routes/bootstrap.ts). */
export const BootstrapBody = z.object({
  email: z.email(),
  password: z.string().min(8),
  name: z.string().min(1),
  orgName: z.string().min(1),
  orgSlug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(1),
})
export type BootstrapBody = z.infer<typeof BootstrapBody>

/** POST /v1/bootstrap → { user, organization, pat } (201). */
export const BootstrapResponse = z.object({
  user: z.object({
    id: z.string(),
    email: z.email(),
  }),
  organization: z.object({
    id: IdSlug('org_'),
    name: z.string(),
    slug: z.string(),
  }),
  /** Raw PAT shown to caller exactly once. */
  pat: z.string(),
})
export type BootstrapResponse = z.infer<typeof BootstrapResponse>
