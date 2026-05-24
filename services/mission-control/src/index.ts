import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { health } from './routes/health.ts';
import { bootstrap } from './routes/bootstrap.ts';
import { me } from './routes/me.ts';
import { agentsRouter } from './routes/agents.ts';
import { connectorsRouter } from './routes/connectors.ts';
import { projectsRouter } from './routes/projects.ts';
import { createAuth } from './auth/config.ts';

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

// CORS — applied to all /v1/* routes before any route handler runs.
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

export default app;
