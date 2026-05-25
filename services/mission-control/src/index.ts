import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { health } from './routes/health.ts';
import { bootstrap } from './routes/bootstrap.ts';
import { me } from './routes/me.ts';
import { agentsRouter } from './routes/agents.ts';
import { connectorsRouter } from './routes/connectors.ts';
import { projectsRouter } from './routes/projects.ts';
import { tasksRouter } from './routes/tasks.ts';
import { commentsRouter } from './routes/comments.ts';
import { externalRefsRouter } from './routes/external-refs.ts';
import { eventsRouter } from './routes/events.ts';
import { createAuth } from './auth/config.ts';
import { loggingMiddleware } from './logging.ts';
import { rateLimitMiddleware } from './rate-limit.ts';
import { handleScheduled } from './jobs/cron.ts';
import { requireJsonOnWrites } from './middleware/content-type-guard.ts';
import { validateResponses } from './middleware/validate-responses.ts';

type Env = {
  DB?: D1Database;
  MASTER_DB?: D1Database;
  POOL_DEFAULT?: D1Database;
  DB_MODE: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  CORS_ALLOWED_ORIGINS?: string;
  MC_ADMIN_TOKEN?: string;
};

const app = new Hono<{ Bindings: Env }>();

// Middleware order for /v1/*:
//   1. secureHeaders       — sets security response headers (HSTS, X-Content-Type-Options, …)
//   2. cors                — handles preflight OPTIONS and CORS response headers
//   3. requireJsonOnWrites — 415 if state-changing request uses form-urlencoded/multipart
//   4. rateLimitMiddleware — short-circuits on rate limit exceeded (v1: no-op stub)
//   5. loggingMiddleware   — runs after next(); captures final status + auth context
app.use('/v1/*', secureHeaders());

app.use('/v1/*', cors({
  origin: (origin, c) => {
    const env = c.env as Env;
    const allowed =
      env.CORS_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    // Dev exception: allow any localhost origin in single-DB mode.
    if (env.DB_MODE === 'single' && origin?.startsWith('http://localhost:')) return origin;
    return allowed.includes(origin ?? '') ? origin : null;
  },
  credentials: true,
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-mc-admin-token'],
}));

app.use('/v1/*', requireJsonOnWrites);
app.use('/v1/*', rateLimitMiddleware);
app.use('/v1/*', loggingMiddleware);
// Dev-mode response-shape validator — self-gates inside (no-op in prod).
// Logs (does not throw) when a handler response drifts from src/schemas/.
app.use('/v1/*', validateResponses);

app.route('/v1/health', health);

// Mount better-auth handler — handles all auth flows (signup, signin, orgs, api-keys, …)
app.on(['POST', 'GET'], '/v1/auth/*', async (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

app.route('/v1/bootstrap', bootstrap);
app.route('/v1/me', me);
app.route('/v1/agents', agentsRouter);
app.route('/v1/connectors', connectorsRouter);
app.route('/v1/projects', projectsRouter);
app.route('/v1/tasks', tasksRouter);
app.route('/v1/tasks', commentsRouter);
app.route('/v1/external_refs', externalRefsRouter);
app.route('/v1/events', eventsRouter);

// Workers Module Worker shape: fetch handler + scheduled (cron) handler.
export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
