import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { health } from './routes/health.ts'
import { bootstrap } from './routes/bootstrap.ts'
import { me } from './routes/me.ts'
import { agentsRouter } from './routes/agents.ts'
import { connectorsRouter } from './routes/connectors.ts'
import { projectsRouter } from './routes/projects.ts'
import { tasksRouter } from './routes/tasks.ts'
import { commentsRouter } from './routes/comments.ts'
import { externalRefsRouter } from './routes/external-refs.ts'
import { eventsRouter } from './routes/events.ts'
import { createAuth } from './auth/config.ts'
import { authMiddleware } from './auth/middleware.ts'
import { loggingMiddleware } from './logging.ts'
import { rateLimitMiddleware } from './rate-limit.ts'
import { handleScheduled } from './jobs/cron.ts'
import { requireJsonOnWrites } from './middleware/content-type-guard.ts'
import { validateResponses } from './middleware/validate-responses.ts'

const app = new Hono<{ Bindings: Env }>()

// All /api/v1/* routes are mounted on a single parent router so middleware
// is configured exactly once. Order within `api` is significant:
//
//   1. Cross-cutting middleware (secureHeaders, cors, …) registered first →
//      runs for every nested route, including the public ones.
//   2. Public routes (health, bootstrap, better-auth handler) mounted BEFORE
//      authMiddleware — they intentionally opt out by being registered earlier.
//      (Hono applies a `use()`d middleware only to routes registered AFTER it.)
//   3. `api.use('*', authMiddleware)` → every route mounted below this line is
//      authenticated; individual routers no longer need to remember to add it.
//      This avoids a class of bug where a new router silently ships without auth.
const api = new Hono<{ Bindings: Env }>()

api.use('*', secureHeaders())

api.use(
  '*',
  cors({
    origin: (origin, c) => {
      // Hono's `cors()` helper erases the parent router's `Bindings` generic in
      // its callback signature, so c.env is `any` here. Re-narrow to the
      // wrangler-generated Env (NOT a hand-rolled shape).
      const env = c.env as Env
      const allowed =
        env.CORS_ALLOWED_ORIGINS?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []
      // Dev exception: allow any localhost origin in single-DB mode.
      if (env.DB_MODE === 'single' && origin?.startsWith('http://localhost:')) return origin
      return allowed.includes(origin ?? '') ? origin : null
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-mc-admin-token'],
  }),
)

api.use('*', requireJsonOnWrites)
api.use('*', rateLimitMiddleware)
api.use('*', loggingMiddleware)
// Dev-mode response-shape validator — self-gates inside (no-op in prod).
// Logs (does not throw) when a handler response drifts from src/schemas/.
api.use('*', validateResponses)

// --- Public routes (registered before authMiddleware to opt out of auth) ---
api.route('/health', health)
api.route('/bootstrap', bootstrap)

// better-auth handler — handles all auth flows (signup, signin, orgs, api-keys, …).
// It runs its own session/credential validation, so it must sit OUTSIDE authMiddleware.
api.on(['POST', 'GET'], '/auth/*', async (c) => {
  const auth = createAuth(c.env)
  return auth.handler(c.req.raw)
})

// --- Authenticated routes (everything below this line gets authMiddleware) ---
api.use('*', authMiddleware)

api.route('/me', me)
api.route('/agents', agentsRouter)
api.route('/connectors', connectorsRouter)
api.route('/projects', projectsRouter)
api.route('/tasks', tasksRouter)
api.route('/tasks', commentsRouter)
api.route('/external_refs', externalRefsRouter)
api.route('/events', eventsRouter)

app.route('/api/v1', api)

// Workers Module Worker shape: fetch handler + scheduled (cron) handler.
export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
}
