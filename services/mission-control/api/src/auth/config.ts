import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization, magicLink } from 'better-auth/plugins'
import { apiKey } from '@better-auth/api-key'
import * as schema from '../db/master.ts'
import { masterClient } from '../db/client.ts'
import {
  deliverVerificationEmail,
  deliverResetPasswordEmail,
  deliverMagicLinkEmail,
} from './email.ts'

export function createAuth(env: Env) {
  const db = masterClient(env)

  // better-auth's Drizzle adapter looks up tables by their better-auth model
  // name.  The apiKey plugin uses the lowercase key "apikey" to resolve the
  // table in the Drizzle ORM schema, but our master.ts exports the table as
  // `apiKey` (camelCase).  Provide an explicit mapping so both resolve.
  const drizzleSchema = { ...schema, apikey: schema.apiKey }

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema: drizzleSchema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: '/api/v1/auth',
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: (args) => deliverResetPasswordEmail(env, args),
    },
    emailVerification: {
      sendVerificationEmail: (args) => deliverVerificationEmail(env, args),
      sendOnSignUp: true,
    },
    plugins: [
      organization(),
      // The apiKey plugin uses the table name "apikey" internally. Our extra
      // columns (org_id, principal_type) are in the Drizzle schema and will be
      // written/read by application code; better-auth doesn't need to know about
      // them for its own flows.
      apiKey(),
      magicLink({
        sendMagicLink: (args) => deliverMagicLinkEmail(env, args),
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>
