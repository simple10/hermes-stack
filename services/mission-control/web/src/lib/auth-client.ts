import { createAuthClient } from 'better-auth/react'
import { organizationClient, magicLinkClient } from 'better-auth/client/plugins'
import { apiKeyClient } from '@better-auth/api-key/client'

/**
 * Better-auth React client for the MC UI. Same-origin with the API so
 * session cookies set by /api/v1/auth/sign-in/email automatically flow on
 * every /api/v1/... fetch — no `credentials: 'include'` plumbing needed.
 */
export const authClient = createAuthClient({
  baseURL: '/api/v1/auth',
  plugins: [organizationClient(), apiKeyClient(), magicLinkClient()],
})

export const { useSession, useListOrganizations, signIn, signUp, signOut } = authClient
