/**
 * node-entry.ts — Node.js self-host entrypoint for Mission Control.
 *
 * Runs the Hono app under @hono/node-server, wiring a better-sqlite3 database
 * through the D1-compatible adapter so all existing Worker code runs without
 * modification.
 *
 * Usage:
 *   node --experimental-strip-types src/node-entry.ts
 *   (or via `npm run start:node`)
 *
 * Required env vars:
 *   BETTER_AUTH_SECRET   — 32+ random bytes (hex / base64)
 *   BETTER_AUTH_URL      — public URL of this service (e.g. http://localhost:8787)
 *
 * Optional env vars:
 *   MC_DB_PATH           — SQLite file path (default: /data/mc.sqlite)
 *   PORT                 — port to listen on (default: 8787)
 *   MC_ADMIN_TOKEN       — admin token for /v1/bootstrap
 *   CORS_ALLOWED_ORIGINS — comma-separated allowed origins
 *   DB_MODE              — forced to 'single' in this entrypoint
 */

import Database from 'better-sqlite3';
import { serve } from '@hono/node-server';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapSqliteAsD1 } from './db/sqlite-adapter.ts';
import worker from './index.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.MC_DB_PATH ?? '/data/mc.sqlite';

if (!process.env.BETTER_AUTH_SECRET) {
  console.error('[mission-control] FATAL: BETTER_AUTH_SECRET env var is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

// Apply any pending migrations on boot. In the Workers target, wrangler handles
// migrations; in the Node target we run them ourselves from migrations/combined/.
applyMigrations(sqlite);

// Wrap better-sqlite3 to expose the D1Database interface expected by app code.
// wrapSqliteAsD1 attaches `__sqlite = sqlite` on the binding, which client.ts
// uses to detect Node mode and pick drizzle-orm/better-sqlite3 as the adapter.
const dbBinding = wrapSqliteAsD1(sqlite);

// ---------------------------------------------------------------------------
// Env object passed as the Workers "bindings" env
// ---------------------------------------------------------------------------

const env = {
  // Single-DB mode: DB serves as both master and pool binding.
  DB: dbBinding,
  DB_MODE: 'single',
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? `http://localhost:${PORT}`,
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  MC_ADMIN_TOKEN: process.env.MC_ADMIN_TOKEN,
  // Tuning overrides (mirrors .env.example defaults)
  KEY_ROTATION_GRACE_SECONDS: process.env.KEY_ROTATION_GRACE_SECONDS ?? '300',
  EVENTS_RETENTION_DAYS: process.env.EVENTS_RETENTION_DAYS ?? '365',
  IDEMPOTENCY_TTL_SECONDS: process.env.IDEMPOTENCY_TTL_SECONDS ?? '86400',
};

// ---------------------------------------------------------------------------
// Fake ExecutionContext (Workers API; not used in Node mode)
// ---------------------------------------------------------------------------

// Cast through unknown because ExecutionContext's exact shape (including the
// `props` internal field) is internal to the workers-types package and may
// vary between versions. In Node mode these methods are never called by the
// Hono app; the stub is only here to satisfy the worker.fetch() signature.
const fakeCtx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch((e) => console.error('[waitUntil]', e));
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

serve(
  {
    fetch: (req: Request) =>
      worker.fetch(req, env as unknown as Record<string, unknown>, fakeCtx),
    port: PORT,
  },
  (info) => {
    console.log(`[mission-control] listening on http://localhost:${info.port}`);
    console.log(`[mission-control] DB: ${DB_PATH}`);
  },
);

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Reads SQL files from migrations/combined/ in sort order and executes each
 * one that hasn't been recorded in the _mc_migrations tracking table.
 *
 * This is a lightweight alternative to wrangler's D1 migration runner for the
 * Node self-host path.
 */
function applyMigrations(db: Database.Database): void {
  // Create migration tracking table if it doesn't exist.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _mc_migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(__dirname, '..', 'migrations', 'combined');

  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.warn('[migration] migrations/combined/ not found — skipping');
    return;
  }

  const applied = new Set(
    (
      db.prepare('SELECT name FROM _mc_migrations').all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

  const insertMigration = db.prepare(
    'INSERT INTO _mc_migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    console.log(`[migration] applying ${file}`);
    try {
      db.exec(sql);
      insertMigration.run(file, Date.now());
    } catch (err) {
      console.error(`[migration] FAILED on ${file}:`, err);
      throw err;
    }
  }

  console.log(`[migration] up to date (${files.length} files)`);
}
