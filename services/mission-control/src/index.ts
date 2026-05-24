import { Hono } from 'hono';
import { health } from './routes/health.ts';

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

app.route('/v1/health', health);

export default app;
