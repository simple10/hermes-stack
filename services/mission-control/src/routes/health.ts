import { Hono } from 'hono';

export const health = new Hono<{ Bindings: Env }>();

// Liveness — always returns 200 if the Worker is up.
health.get('/', (c) => c.json({ status: 'ok' }));

// Readiness — pings DB(s); returns 503 if any are unreachable.
health.get('/ready', async (c) => {
  const env = c.env;
  const dbs = env.DB_MODE === 'split' ? [env.MASTER_DB, env.POOL_DEFAULT] : [env.DB];
  for (const db of dbs) {
    if (!db) return c.json({ status: 'db_binding_missing' }, 503);
    try {
      await db.prepare('SELECT 1').first();
    } catch (e) {
      return c.json({ status: 'db_unreachable', error: String(e) }, 503);
    }
  }
  return c.json({ status: 'ok' });
});
