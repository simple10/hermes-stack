# MissionControl v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MissionControl master API service per `services/mission-control/docs/specs/2026-05-22-master-api-design.md` — a multi-tenant kanban API on Cloudflare Workers + D1 + Hono + Drizzle + better-auth, runnable both as a deployed Worker (SaaS) and a self-host Node + SQLite Docker image (OSS).

**Architecture:** Two-tier sharded D1 (master + pool DBs) with single-DB mode for self-host. Better-auth handles all identity (sessions + PATs + agent/connector keys via metadata discrimination). Custom middleware resolves org → pool binding. Polymorphic external_refs + events log. Soft-delete with cascade triggers throughout.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, better-auth (organization + apiKey plugins), D1 / better-sqlite3, Vitest + @cloudflare/vitest-pool-workers, Zod, pnpm.

**Workspace:** All work inside `services/mission-control/`. The hermes-stack glue (`service.env`, `compose.yaml`, `build.sh`) lives at the top of that dir; the standalone-ready content (everything else) is what gets extracted to its own repo later.

**Conventions (post-implementation amendments — see `chore(mission-control)` commits):**
- Package manager is **pnpm** (Corepack-managed via `packageManager` in package.json).
- `wrangler` is **globally installed**, never a dev-dep. Scripts call bare `wrangler`.
- Cloudflare runtime types come from `pnpm cf:types` (which runs `wrangler types`) — NOT `@cloudflare/workers-types` (deprecated).
- Config is `wrangler.jsonc` (not `wrangler.toml`).
- The task descriptions below still reference the old shapes; later commits standardized them.

---

## Conventions

- All file paths below are relative to `services/mission-control/` unless stated otherwise.
- After every task: `git add services/mission-control/ && git commit -m "<scope>: <one-line>"`. No Claude attribution per repo policy.
- Run tests after each task; tests must pass before commit.
- Use pnpm; if not installed, fall back to npm.
- Pin every dependency to a known-good version (no `^` prefixes for major libraries: better-auth, drizzle-orm, hono, wrangler).
- Every route handler ≥ 80% line coverage with a multi-tenant isolation test.

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.toml`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `src/index.ts`
- Create: `src/routes/health.ts`
- Create: `README.md` (skeleton)
- Create: `LICENSE` (MIT)

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "mission-control",
  "version": "0.0.1",
  "private": true,
  "description": "Multi-tenant master kanban API for multi-agent task coordination",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "build": "tsc --noEmit && wrangler deploy --dry-run",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 migrations apply DB --local",
    "db:migrate:remote": "wrangler d1 migrations apply DB --remote",
    "auth:generate": "better-auth generate"
  },
  "dependencies": {
    "better-auth": "1.2.0",
    "drizzle-orm": "0.36.0",
    "hono": "4.6.0",
    "zod": "3.23.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.5.0",
    "@cloudflare/workers-types": "4.20250101.0",
    "@types/node": "22.0.0",
    "better-sqlite3": "11.0.0",
    "drizzle-kit": "0.27.0",
    "typescript": "5.6.0",
    "vitest": "2.1.0",
    "wrangler": "3.90.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

(Version numbers above are starting points; the implementer should verify each against the current registry and bump to latest stable, then pin.)

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types/2023-07-01", "node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src/**/*", "test/**/*", "drizzle.config.ts"]
}
```

- [ ] **Step 3: Create wrangler.toml**

```toml
name = "mission-control"
main = "src/index.ts"
compatibility_date = "2026-05-22"
compatibility_flags = ["nodejs_compat"]

# Single DB in dev (single-DB mode); SaaS prod overrides via env-specific blocks.
[[d1_databases]]
binding = "DB"
database_name = "mission-control-dev"
database_id = "REPLACE_WITH_LOCAL_ID"
migrations_dir = "migrations/combined"

[vars]
DB_MODE = "single"
BETTER_AUTH_URL = "http://localhost:8787"

# Production SaaS environment (deployed via `wrangler deploy --env production`).
# Uses split-DB mode with separate master + pool bindings.
[env.production]
[env.production.vars]
DB_MODE = "split"

[[env.production.d1_databases]]
binding = "MASTER_DB"
database_name = "mc-master-prod"
database_id = "REPLACE_WITH_PROD_MASTER_ID"
migrations_dir = "migrations/master"

[[env.production.d1_databases]]
binding = "POOL_DEFAULT"
database_name = "mc-pool-default-prod"
database_id = "REPLACE_WITH_PROD_POOL_DEFAULT_ID"
migrations_dir = "migrations/pool"

# Cron triggers (events purge, idempotency purge, verification purge).
[[env.production.triggers.crons]]
cron = "0 3 * * *"
# events purge — see src/jobs/cron.ts
[[env.production.triggers.crons]]
cron = "0 4 * * *"
# idempotency purge
[[env.production.triggers.crons]]
cron = "*/15 * * * *"
# verification purge
```

- [ ] **Step 4: Create vitest.config.ts**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
  },
});
```

- [ ] **Step 5: Create .env.example**

```
# Required at startup
BETTER_AUTH_SECRET=replace_with_32_random_bytes_base64
BETTER_AUTH_URL=http://localhost:8787

# DB mode
DB_MODE=single                              # 'single' (self-host) or 'split' (SaaS)

# CORS — comma-separated origins. Empty = no browser clients allowed.
CORS_ALLOWED_ORIGINS=

# Bootstrap — required on first deploy; can be unset after first user exists.
MC_ADMIN_TOKEN=

# Tuning
KEY_ROTATION_GRACE_SECONDS=300
EVENTS_RETENTION_DAYS=365
IDEMPOTENCY_TTL_SECONDS=86400

# OAuth providers (omit to disable that provider in sign-in surface)
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
```

- [ ] **Step 6: Create .gitignore**

```
node_modules/
.wrangler/
.dev.vars
.env
.env.local
*.log
dist/
.DS_Store
```

- [ ] **Step 7: Create src/index.ts — minimal Hono app**

```ts
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
```

- [ ] **Step 8: Create src/routes/health.ts**

```ts
import { Hono } from 'hono';

export const health = new Hono();

// Liveness — always returns 200 if the Worker is up.
health.get('/', (c) => c.json({ status: 'ok' }));

// Readiness — pings DB(s); returns 503 if any are unreachable.
health.get('/ready', async (c) => {
  const env = c.env as { DB?: D1Database; MASTER_DB?: D1Database; POOL_DEFAULT?: D1Database; DB_MODE: string };
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
```

- [ ] **Step 9: Create README.md skeleton**

```markdown
# MissionControl

Multi-tenant master kanban API for coordinating tasks across agent instances.

See `docs/specs/2026-05-22-master-api-design.md` for the design.

## Quick start (contributor dev)

\`\`\`
pnpm install
cp .env.example .dev.vars   # then edit
pnpm db:generate            # generate Drizzle schema from better-auth
pnpm db:migrate:local       # apply migrations to local D1
pnpm dev                    # wrangler dev
\`\`\`
```

- [ ] **Step 10: Create LICENSE (MIT)**

Standard MIT license, copyright "Joe Johnston and contributors" (or match repo's existing attribution convention).

- [ ] **Step 11: Install deps and verify build**

Run: `cd services/mission-control && pnpm install` (or `npm install` if pnpm missing)
Run: `pnpm typecheck`
Expected: clean exit
Run: `pnpm dev` in background; curl `http://localhost:8787/v1/health` → `{"status":"ok"}`. Kill the dev server.

- [ ] **Step 12: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add services/mission-control/
git commit -m "feat(mission-control): project scaffolding (Hono + Wrangler + Vitest)"
```

---

## Task 2: Better-auth + master DB schema

**Files:**
- Create: `src/auth/config.ts`
- Create: `src/db/master.ts`
- Create: `drizzle.config.ts`
- Create: `migrations/master/0001_better_auth_base.sql`
- Create: `migrations/master/0002_better_auth_additional.sql`
- Create: `migrations/master/0003_tenant_pools.sql`
- Create: `migrations/combined/0001_combined_init.sql` (concat of master + pool for single-DB mode — pool added in next task)

- [ ] **Step 1: Create src/auth/config.ts with better-auth instance**

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization, apiKey } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '../db/master.ts';

export function createAuth(env: { DB?: D1Database; MASTER_DB?: D1Database; DB_MODE: string; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string }) {
  const binding = env.DB_MODE === 'split' ? env.MASTER_DB : env.DB;
  if (!binding) throw new Error('master DB binding not found');
  const db = drizzle(binding, { schema });
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true },
    plugins: [
      organization({
        schema: {
          organization: {
            additionalFields: {
              tenantPoolId: { type: 'string', required: true, defaultValue: 'default' },
              plan: { type: 'string', required: true, defaultValue: 'free' },
              deletedAt: { type: 'date', required: false },
            },
          },
        },
      }),
      apiKey({
        schema: {
          apiKey: {
            additionalFields: {
              orgId: { type: 'string', required: true },
              principalType: { type: 'string', required: true },
            },
          },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
```

- [ ] **Step 2: Generate Drizzle schema via better-auth CLI**

Run: `cd services/mission-control && pnpm auth:generate -- --output src/db/master.ts`
Expected: produces `src/db/master.ts` with `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `apiKey` table definitions (with our additionalFields).

If the CLI errors, hand-write `src/db/master.ts` based on better-auth's schema docs + our additionalFields. The shape must include:
- All standard better-auth fields per https://www.better-auth.com/docs/concepts/database (`user`, `session`, `account`, `verification`)
- Organization plugin tables (`organization`, `member`, `invitation`) per https://www.better-auth.com/docs/plugins/organization
- ApiKey plugin table (`apiKey`) per https://www.better-auth.com/docs/plugins/api-key
- Custom fields on organization: `tenantPoolId TEXT NOT NULL DEFAULT 'default'`, `plan TEXT NOT NULL DEFAULT 'free'`, `deletedAt INTEGER`
- Custom fields on apiKey: `orgId TEXT NOT NULL`, `principalType TEXT NOT NULL`

- [ ] **Step 3: Append our tenant_pools table to src/db/master.ts**

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const tenantPools = sqliteTable('tenant_pools', {
  id: text('id').primaryKey(),
  bindingName: text('binding_name').notNull(),
  createdAt: integer('created_at').notNull(),
});
```

- [ ] **Step 4: Create drizzle.config.ts**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/master.ts',
  out: './migrations/master',
  dialect: 'sqlite',
  driver: 'd1-http',
});
```

- [ ] **Step 5: Generate SQL migration from schema**

Run: `pnpm db:generate`
Expected: produces `migrations/master/0001_*.sql` (timestamped) with all the better-auth tables + tenant_pools.

Rename the generated file to `0001_better_auth_base.sql` for clarity. If multiple files generated, fold them into `0001_better_auth_base.sql` + `0002_better_auth_additional.sql` per the spec's repo layout.

- [ ] **Step 6: Add 0003_tenant_pools.sql seeded with default pool**

```sql
-- migrations/master/0003_tenant_pools.sql
-- Seed the default tenant pool. In single-DB mode 'default' resolves to the
-- same binding as master (env.DB). In split mode it resolves to env.POOL_DEFAULT.
INSERT INTO tenant_pools (id, binding_name, created_at)
VALUES ('default', 'POOL_DEFAULT', unixepoch() * 1000)
ON CONFLICT (id) DO NOTHING;
```

(If `tenant_pools` already created by drizzle-kit in step 5, this file is only the INSERT.)

- [ ] **Step 7: Create the wrangler local D1 database**

Run: `pnpm wrangler d1 create mission-control-dev` (only needed once per dev machine)
Expected: prints a `database_id`. Update `wrangler.toml`'s `REPLACE_WITH_LOCAL_ID` placeholder with the printed value.

- [ ] **Step 8: Set up combined migrations dir for single-DB mode**

```bash
mkdir -p migrations/combined
```

Create a script `scripts/build-combined-migrations.ts` that concatenates `migrations/master/*.sql` and `migrations/pool/*.sql` into `migrations/combined/*.sql` in interleaved numeric order. For now (no pool yet), it just copies master/.

```ts
// scripts/build-combined-migrations.ts
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const masterDir = 'migrations/master';
const poolDir = 'migrations/pool';
const outDir = 'migrations/combined';

mkdirSync(outDir, { recursive: true });

const masterFiles = readdirSync(masterDir).filter(f => f.endsWith('.sql')).sort();
let poolFiles: string[] = [];
try { poolFiles = readdirSync(poolDir).filter(f => f.endsWith('.sql')).sort(); } catch { /* no pool dir yet */ }

let seq = 1;
for (const f of masterFiles) {
  const out = String(seq).padStart(4, '0') + '_master_' + f.replace(/^\d+_/, '');
  writeFileSync(join(outDir, out), readFileSync(join(masterDir, f), 'utf-8'));
  seq++;
}
for (const f of poolFiles) {
  const out = String(seq).padStart(4, '0') + '_pool_' + f.replace(/^\d+_/, '');
  writeFileSync(join(outDir, out), readFileSync(join(poolDir, f), 'utf-8'));
  seq++;
}
console.log(`Wrote ${seq - 1} combined migrations to ${outDir}/`);
```

Add to package.json scripts: `"db:combine": "tsx scripts/build-combined-migrations.ts"`. Run `pnpm db:combine`.

- [ ] **Step 9: Apply migrations locally**

Run: `pnpm db:migrate:local`
Expected: all combined migrations apply cleanly. `wrangler d1 execute DB --local --command "SELECT name FROM sqlite_master WHERE type='table';"` lists `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`, `apiKey`, `tenant_pools`.

- [ ] **Step 10: Verify auth signup works end-to-end**

Add to `src/index.ts`:

```ts
import { createAuth } from './auth/config.ts';
// …
app.on(['POST', 'GET'], '/v1/auth/*', async (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});
```

Start `pnpm dev`. Curl:

```sh
curl -X POST http://localhost:8787/v1/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"email":"test@example.com","password":"testpass123","name":"Test"}'
```

Expected: 200 response with user info + a session cookie.

- [ ] **Step 11: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): better-auth + master DB schema + migrations"
```

---

## Task 3: Pool DB schema + migrations

**Files:**
- Create: `src/db/pool.ts`
- Create: `migrations/pool/0001_init.sql`

- [ ] **Step 1: Create src/db/pool.ts with Drizzle definitions for all pool tables**

Tables per spec: `agents`, `connectors`, `projects`, `tasks`, `task_comments`, `events`, `external_refs`, `idempotency_keys`. Match the column names and types exactly from `docs/specs/2026-05-22-master-api-design.md` "Pool DB" section.

Include all indexes and partial unique indexes mentioned in the spec. Use Drizzle's `sqliteTable`, `text`, `integer`, `index`, `uniqueIndex`.

Example shape:

```ts
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  description: text('description'),
  lastSeenAt: integer('last_seen_at'),
  createdByUserId: text('created_by_user_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
  deletedByType: text('deleted_by_type'),
  deletedById: text('deleted_by_id'),
}, (t) => ({
  nameUniqueActive: uniqueIndex('agents_name_per_org_active').on(t.orgId, t.name).where(sql`${t.deletedAt} IS NULL`),
  kindIdx: index('agents_org_kind_active').on(t.orgId, t.kind).where(sql`${t.deletedAt} IS NULL`),
}));

// … connectors, projects, tasks, task_comments, events, external_refs, idempotency_keys
```

- [ ] **Step 2: Hand-write migrations/pool/0001_init.sql**

Copy the DDL directly from the spec's "Pool DB" section. Includes all CREATE TABLE + CREATE INDEX statements + the cascade triggers (defined in step 3 below — co-locate in same migration).

- [ ] **Step 3: Add cascade triggers to 0001_init.sql**

For each parent table (`tasks`, `projects`, `agents`, `connectors`):

```sql
CREATE TRIGGER tasks_soft_delete_cascade
  AFTER UPDATE OF deleted_at ON tasks
  WHEN NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE external_refs SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
    WHERE resource_type = 'task' AND resource_id = NEW.id AND deleted_at IS NULL;
  UPDATE task_comments SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
    WHERE task_id = NEW.id AND deleted_at IS NULL;
END;

CREATE TRIGGER projects_soft_delete_cascade
  AFTER UPDATE OF deleted_at ON projects
  WHEN NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE external_refs SET deleted_at = NEW.deleted_at, deleted_by_type = 'system'
    WHERE resource_type = 'project' AND resource_id = NEW.id AND deleted_at IS NULL;
END;

-- Similar for agents, connectors.
```

- [ ] **Step 4: Add updated_at trigger for every mutable table**

```sql
CREATE TRIGGER tasks_set_updated_at
  AFTER UPDATE ON tasks
  WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tasks SET updated_at = unixepoch() * 1000 WHERE id = NEW.id;
END;
-- Repeat for projects, agents, connectors, task_comments, external_refs, tenant_pools.
```

This makes `updated_at` bump even if a raw SQL UPDATE forgets it.

- [ ] **Step 5: Regenerate combined migrations**

Run: `pnpm db:combine`
Expected: now includes both master and pool SQL files in numeric order.

- [ ] **Step 6: Re-apply local migrations**

Run: `wrangler d1 execute DB --local --command "DROP TABLE IF EXISTS d1_migrations;"` (only needed to re-test from scratch)
Run: `pnpm db:migrate:local`
Verify all tables and indexes exist:

```sh
wrangler d1 execute DB --local --command "SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index') ORDER BY type, name;"
```

- [ ] **Step 7: Add a migrations integration test**

Create `test/migrations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('migrations', () => {
  it('creates all expected tables in single-DB mode', async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' ORDER BY name"
    ).all();
    const names = tables.results.map((r: any) => r.name);
    for (const expected of ['user','session','account','verification','organization','member','invitation','apiKey','tenant_pools','agents','connectors','projects','tasks','task_comments','events','external_refs','idempotency_keys']) {
      expect(names).toContain(expected);
    }
  });
});
```

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): pool DB schema + cascade triggers + migration test"
```

---

## Task 4: DB client + pool resolver

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/pool-resolver.ts`
- Create: `test/db/pool-resolver.test.ts`

- [ ] **Step 1: Create src/db/client.ts**

```ts
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import * as masterSchema from './master.ts';
import * as poolSchema from './pool.ts';

export type Env = {
  DB?: D1Database;
  MASTER_DB?: D1Database;
  POOL_DEFAULT?: D1Database;
  [key: string]: unknown;
};

export function masterClient(env: Env) {
  const binding = env.DB_MODE === 'split' ? env.MASTER_DB : env.DB;
  if (!binding) throw new Error('master DB binding not found');
  return drizzleD1(binding as D1Database, { schema: masterSchema });
}

export function poolClient(binding: D1Database) {
  return drizzleD1(binding, { schema: poolSchema });
}

export type MasterClient = ReturnType<typeof masterClient>;
export type PoolClient = ReturnType<typeof poolClient>;
```

- [ ] **Step 2: Create src/db/pool-resolver.ts**

```ts
import { eq } from 'drizzle-orm';
import { organization } from './master.ts';
import { masterClient, poolClient, type Env } from './client.ts';
import { HttpError } from '../errors.ts';

// Per-isolate cache: orgId → tenantPoolId, 60s TTL.
const cache = new Map<string, { tenantPoolId: string; expiresAt: number }>();
const TTL_MS = 60_000;

export async function resolvePoolForOrg(env: Env, orgId: string) {
  const now = Date.now();
  let entry = cache.get(orgId);
  if (!entry || entry.expiresAt < now) {
    const org = await masterClient(env).query.organization.findFirst({
      where: eq(organization.id, orgId),
      columns: { tenantPoolId: true },
    });
    if (!org) throw new HttpError(404, 'auth.org_not_found', `Organization ${orgId} not found`);
    entry = { tenantPoolId: org.tenantPoolId, expiresAt: now + TTL_MS };
    cache.set(orgId, entry);
  }

  const binding = resolveBinding(env, entry.tenantPoolId);
  if (!binding) throw new HttpError(503, 'pool.binding_missing', `Pool binding for ${entry.tenantPoolId} not configured`);
  return poolClient(binding);
}

function resolveBinding(env: Env, tenantPoolId: string): D1Database | null {
  if (env.DB_MODE === 'single') return (env.DB ?? null) as D1Database | null;
  // Map: 'default' → POOL_DEFAULT, 'premium-acme' → POOL_PREMIUM_ACME
  const key = 'POOL_' + tenantPoolId.toUpperCase().replace(/-/g, '_');
  return (env[key] ?? null) as D1Database | null;
}

// Test helper — wipe cache between tests.
export function _clearPoolCache() { cache.clear(); }
```

- [ ] **Step 3: Create src/errors.ts**

```ts
export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
  }
}

export function errorResponse(c: { json: (b: unknown, s?: number) => Response }, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  console.error('unhandled error:', err);
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
}
```

- [ ] **Step 4: Write test/db/pool-resolver.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resolvePoolForOrg, _clearPoolCache } from '../../src/db/pool-resolver.ts';
import { masterClient } from '../../src/db/client.ts';
import { organization, tenantPools } from '../../src/db/master.ts';

beforeEach(() => _clearPoolCache());

describe('pool resolver (single-DB mode)', () => {
  it('returns the same binding for default pool', async () => {
    const db = masterClient(env);
    // Seed: insert tenant_pools row + a test organization
    await db.insert(tenantPools).values({ id: 'default', bindingName: 'DB', createdAt: Date.now() }).onConflictDoNothing();
    await db.insert(organization).values({
      id: 'org_test1', name: 'Test', slug: 'test1', tenantPoolId: 'default',
      plan: 'free', createdAt: new Date(),
    } as any);
    const pool = await resolvePoolForOrg(env, 'org_test1');
    expect(pool).toBeDefined();
    // Sanity: pool client can query a pool table
    await pool.run({ sql: 'SELECT 1', params: [] } as any);
  });

  it('404s for unknown org', async () => {
    await expect(resolvePoolForOrg(env, 'org_unknown')).rejects.toThrow(/org_not_found/);
  });
});
```

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): db client + pool resolver + 503-on-missing-binding"
```

---

## Task 5: Auth middleware + ctx

**Files:**
- Create: `src/auth/middleware.ts`
- Create: `src/auth/types.ts`
- Create: `test/auth/middleware.test.ts`

- [ ] **Step 1: Create src/auth/types.ts**

```ts
import type { PoolClient } from '../db/client.ts';

export type Principal =
  | { type: 'user'; id: string }
  | { type: 'agent'; id: string }
  | { type: 'connector'; id: string };

export type AuthContext = {
  orgId: string;
  role: 'owner' | 'admin' | 'member' | 'agent' | 'connector';
  principal: Principal;
  pool: PoolClient;
  // For audit attribution on actions taken via API keys.
  viaUserId?: string;
  viaKeyId?: string;
};
```

- [ ] **Step 2: Create src/auth/middleware.ts**

```ts
import type { MiddlewareHandler } from 'hono';
import { createAuth } from './config.ts';
import { resolvePoolForOrg } from '../db/pool-resolver.ts';
import { masterClient } from '../db/client.ts';
import { member } from '../db/master.ts';
import { and, eq } from 'drizzle-orm';
import type { AuthContext } from './types.ts';
import { HttpError, errorResponse } from '../errors.ts';

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  try {
    const auth = createAuth(c.env as any);
    const request = c.req.raw;

    // Try session first (cookie)
    const session = await auth.api.getSession({ headers: request.headers });
    let orgId: string | undefined;
    let principal: AuthContext['principal'] | undefined;
    let role: AuthContext['role'] | undefined;
    let viaUserId: string | undefined;
    let viaKeyId: string | undefined;

    if (session) {
      orgId = (session.session as any).activeOrganizationId;
      if (!orgId) throw new HttpError(403, 'auth.no_active_org', 'Session has no active organization');
      principal = { type: 'user', id: session.user.id };
      // Look up role from member table
      const m = await masterClient(c.env as any).query.member.findFirst({
        where: and(eq(member.userId, session.user.id), eq(member.organizationId, orgId)),
      });
      if (!m) throw new HttpError(403, 'auth.not_member', 'Not a member of active organization');
      role = m.role as AuthContext['role'];
      viaUserId = session.user.id;
    } else {
      // Try bearer token
      const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (!bearer) throw new HttpError(401, 'auth.missing', 'Missing Authorization header');
      const verified = await auth.api.verifyApiKey({ body: { key: bearer } });
      if (!verified.valid || !verified.key) throw new HttpError(401, 'auth.invalid_token', verified.error?.message ?? 'Invalid token');
      const key = verified.key as any;
      orgId = key.orgId;
      viaUserId = key.userId;
      viaKeyId = key.id;
      const ptype = key.principalType as 'pat' | 'agent' | 'connector';
      if (ptype === 'pat') {
        principal = { type: 'user', id: key.userId };
        const m = await masterClient(c.env as any).query.member.findFirst({
          where: and(eq(member.userId, key.userId), eq(member.organizationId, orgId!)),
        });
        if (!m) throw new HttpError(403, 'auth.not_member', 'Key user is not a member of this organization');
        role = m.role as AuthContext['role'];
      } else if (ptype === 'agent') {
        principal = { type: 'agent', id: key.metadata?.agent_id };
        role = 'agent';
      } else if (ptype === 'connector') {
        principal = { type: 'connector', id: key.metadata?.connector_id };
        role = 'connector';
      } else {
        throw new HttpError(401, 'auth.unknown_principal_type', `Unknown principalType: ${ptype}`);
      }
    }

    const pool = await resolvePoolForOrg(c.env as any, orgId!);
    const ctx: AuthContext = { orgId: orgId!, role: role!, principal: principal!, pool, viaUserId, viaKeyId };
    c.set('auth' as any, ctx);
    await next();
  } catch (e) {
    return errorResponse(c, e);
  }
};

// Role gates.
export function requireMember(...allowed: Array<'owner' | 'admin' | 'member'>): MiddlewareHandler {
  return async (c, next) => {
    const ctx = c.get('auth' as any) as AuthContext;
    if (!['owner', 'admin', 'member'].includes(ctx.role)) {
      return errorResponse(c, new HttpError(403, 'auth.role_insufficient', `Endpoint requires human role; have ${ctx.role}`));
    }
    if (!allowed.includes(ctx.role as any)) {
      return errorResponse(c, new HttpError(403, 'auth.role_insufficient', `Endpoint requires one of: ${allowed.join(', ')}`));
    }
    await next();
  };
}

export function requireMachine(...allowed: Array<'agent' | 'connector'>): MiddlewareHandler {
  return async (c, next) => {
    const ctx = c.get('auth' as any) as AuthContext;
    if (!allowed.includes(ctx.role as any)) {
      return errorResponse(c, new HttpError(403, 'auth.role_insufficient', `Endpoint requires one of: ${allowed.join(', ')}`));
    }
    await next();
  };
}

export function requireAnyRole(...allowed: Array<AuthContext['role']>): MiddlewareHandler {
  return async (c, next) => {
    const ctx = c.get('auth' as any) as AuthContext;
    if (!allowed.includes(ctx.role)) {
      return errorResponse(c, new HttpError(403, 'auth.role_insufficient'));
    }
    await next();
  };
}
```

- [ ] **Step 3: Create test/auth/middleware.test.ts — happy path + 401 + 403**

(Test stub — real coverage in later route tests.)

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { env } from 'cloudflare:test';
import { authMiddleware, requireMember } from '../../src/auth/middleware.ts';

describe('auth middleware', () => {
  it('401s missing token', async () => {
    const app = new Hono();
    app.use('*', authMiddleware);
    app.get('/x', (c) => c.text('ok'));
    const res = await app.fetch(new Request('http://x/x'), env);
    expect(res.status).toBe(401);
  });
});
```

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): auth middleware (session + bearer) + role gates"
```

---

## Task 6: Shared utilities (errors, pagination, events emitter, helpers, id generator)

**Files:**
- Create: `src/ids.ts`
- Create: `src/pagination.ts`
- Create: `src/events/emit.ts`
- Create: `src/db/helpers.ts`
- Create: `test/pagination.test.ts`
- Create: `test/ids.test.ts`

- [ ] **Step 1: src/ids.ts — slug-prefixed ID generator**

```ts
const PREFIX_BY_KIND: Record<string, string> = {
  agent: 'agt', connector: 'cnn', project: 'prj', task: 't',
  comment: 'cmt', event: 'evt', externalRef: 'xrf',
  org: 'org', user: 'usr', apiKey: 'apk',
};

export function makeId(kind: keyof typeof PREFIX_BY_KIND | string): string {
  const prefix = PREFIX_BY_KIND[kind] ?? kind;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${id}`;
}
```

- [ ] **Step 2: src/pagination.ts — HMAC-signed cursors**

```ts
const enc = new TextEncoder();
const dec = new TextDecoder();

export async function encodeCursor(payload: { updatedAt: number; id: string; orgId: string }, secret: string): Promise<string> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(body) + '.' + sigB64;
}

export async function decodeCursor(cursor: string, secret: string): Promise<{ updatedAt: number; id: string; orgId: string } | null> {
  const [bodyB64, sigB64] = cursor.split('.');
  if (!bodyB64 || !sigB64) return null;
  let body: string;
  try { body = atob(bodyB64); } catch { return null; }
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(body));
  if (!valid) return null;
  try { return JSON.parse(body); } catch { return null; }
}

export function clampLimit(raw: unknown, dflt = 50, max = 100): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(Math.floor(n), max);
}
```

- [ ] **Step 3: src/events/emit.ts**

```ts
import { events } from '../db/pool.ts';
import type { PoolClient } from '../db/client.ts';
import type { Principal } from '../auth/types.ts';
import { makeId } from '../ids.ts';

export type EventKind =
  | 'task.created' | 'task.updated' | 'task.status_changed' | 'task.assigned' | 'task.deleted'
  | 'project.created' | 'project.updated' | 'project.deleted'
  | 'agent.created' | 'agent.updated' | 'agent.deleted' | 'agent.key_rotated'
  | 'connector.created' | 'connector.updated' | 'connector.deleted' | 'connector.key_rotated'
  | 'comment.created' | 'comment.deleted'
  | 'external_ref.added' | 'external_ref.removed';

export type ResourceType = 'task' | 'project' | 'agent' | 'connector' | 'comment';

export async function emitEvent(pool: PoolClient, args: {
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  kind: EventKind;
  actor?: Principal;
  payload?: unknown;
}) {
  await pool.insert(events).values({
    orgId: args.orgId,
    resourceType: args.resourceType,
    resourceId: args.resourceId,
    kind: args.kind,
    actorType: args.actor?.type ?? 'system',
    actorId: args.actor?.id,
    payload: args.payload ? JSON.stringify(args.payload) : null,
    createdAt: Date.now(),
  });
}
```

- [ ] **Step 4: src/db/helpers.ts — `active()` + time format**

```ts
import { isNull } from 'drizzle-orm';

export const active = (t: { deletedAt: any }) => isNull(t.deletedAt);

export function isoOrNull(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

// Serialize a DB row's timestamps to ISO strings for API responses.
export function serializeTimestamps<T extends Record<string, any>>(row: T): T {
  const out: any = { ...row };
  for (const k of ['createdAt', 'updatedAt', 'deletedAt', 'startedAt', 'completedAt', 'lastSeenAt']) {
    if (k in out && typeof out[k] === 'number') out[k] = isoOrNull(out[k]);
  }
  return out;
}
```

- [ ] **Step 5: Write tests for pagination + ids**

```ts
// test/pagination.test.ts
import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../src/pagination.ts';

describe('cursor', () => {
  const secret = 'a'.repeat(32);
  it('round-trips', async () => {
    const c = await encodeCursor({ updatedAt: 1000, id: 't_x', orgId: 'org_a' }, secret);
    const d = await decodeCursor(c, secret);
    expect(d).toEqual({ updatedAt: 1000, id: 't_x', orgId: 'org_a' });
  });
  it('rejects tampered cursor', async () => {
    const c = await encodeCursor({ updatedAt: 1000, id: 't_x', orgId: 'org_a' }, secret);
    const tampered = c.slice(0, -2) + 'XX';
    expect(await decodeCursor(tampered, secret)).toBe(null);
  });
  it('rejects wrong secret', async () => {
    const c = await encodeCursor({ updatedAt: 1000, id: 't_x', orgId: 'org_a' }, secret);
    expect(await decodeCursor(c, 'b'.repeat(32))).toBe(null);
  });
});

// test/ids.test.ts
import { describe, it, expect } from 'vitest';
import { makeId } from '../src/ids.ts';
describe('makeId', () => {
  it('uses correct prefix', () => {
    expect(makeId('task')).toMatch(/^t_[0-9a-f]{24}$/);
    expect(makeId('agent')).toMatch(/^agt_[0-9a-f]{24}$/);
  });
});
```

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): shared utilities (ids, signed cursors, events emitter, helpers)"
```

---

## Task 7: Bootstrap flow (/v1/bootstrap)

**Files:**
- Create: `src/routes/bootstrap.ts`
- Create: `test/routes/bootstrap.test.ts`

- [ ] **Step 1: src/routes/bootstrap.ts — gated first-run endpoint**

```ts
import { Hono } from 'hono';
import { masterClient } from '../db/client.ts';
import { user } from '../db/master.ts';
import { createAuth } from '../auth/config.ts';
import { errorResponse, HttpError } from '../errors.ts';
import { z } from 'zod';

export const bootstrap = new Hono();

const body = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  orgName: z.string().min(1),
  orgSlug: z.string().regex(/^[a-z0-9-]+$/).min(1),
});

bootstrap.post('/', async (c) => {
  try {
    const env = c.env as any;
    const adminToken = c.req.header('x-mc-admin-token');
    if (!env.MC_ADMIN_TOKEN) {
      return errorResponse(c, new HttpError(403, 'bootstrap.disabled', 'MC_ADMIN_TOKEN not configured'));
    }
    if (adminToken !== env.MC_ADMIN_TOKEN) {
      return errorResponse(c, new HttpError(403, 'bootstrap.unauthorized', 'Invalid admin token'));
    }
    // Gate: only allowed if no users exist yet
    const existing = await masterClient(env).select({ id: user.id }).from(user).limit(1);
    if (existing.length > 0) {
      return errorResponse(c, new HttpError(409, 'bootstrap.already_done', 'A user already exists; bootstrap endpoint is closed'));
    }
    const input = body.parse(await c.req.json());
    const auth = createAuth(env);

    // Sign up the user
    const signUp = await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
    });
    if (!signUp || !signUp.user) throw new HttpError(500, 'bootstrap.signup_failed', 'sign-up failed');

    // Create org with this user as owner
    const org = await auth.api.createOrganization({
      body: { name: input.orgName, slug: input.orgSlug, userId: signUp.user.id },
      headers: signUp.response?.headers ?? new Headers(),
    });

    // Mint a PAT
    const pat = await auth.api.createApiKey({
      body: {
        name: `bootstrap PAT for ${input.email}`,
        prefix: 'mcpat_',
        userId: signUp.user.id,
        orgId: (org as any).id,
        principalType: 'pat',
        metadata: {},
      } as any,
    });

    return c.json({
      user: { id: signUp.user.id, email: input.email },
      organization: { id: (org as any).id, name: input.orgName, slug: input.orgSlug },
      pat: (pat as any).key,
    }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});
```

- [ ] **Step 2: Mount bootstrap in src/index.ts**

```ts
import { bootstrap } from './routes/bootstrap.ts';
app.route('/v1/bootstrap', bootstrap);
```

- [ ] **Step 3: test/routes/bootstrap.test.ts**

Test scenarios:
- No admin token configured → 403
- Wrong admin token → 403
- Valid bootstrap → 201, returns PAT
- Second bootstrap attempt → 409
- Missing/invalid body fields → 400

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): /v1/bootstrap one-time first-user endpoint"
```

---

## Task 8: /v1/me route + auth integration

**Files:**
- Create: `src/routes/me.ts`
- Modify: `src/index.ts`
- Create: `test/routes/me.test.ts`

- [ ] **Step 1: src/routes/me.ts**

```ts
import { Hono } from 'hono';
import { authMiddleware } from '../auth/middleware.ts';
import type { AuthContext } from '../auth/types.ts';
import { agents, connectors } from '../db/pool.ts';
import { and, eq } from 'drizzle-orm';
import { active, serializeTimestamps } from '../db/helpers.ts';

export const me = new Hono();
me.use('*', authMiddleware);

me.get('/', async (c) => {
  const ctx = c.get('auth' as any) as AuthContext;
  const base: any = {
    org_id: ctx.orgId,
    role: ctx.role,
    principal_type: ctx.principal.type,
    principal_id: ctx.principal.id,
  };
  if (ctx.principal.type === 'agent') {
    const a = await ctx.pool.query.agents.findFirst({
      where: and(eq(agents.id, ctx.principal.id), eq(agents.orgId, ctx.orgId), active(agents)),
    });
    if (a) base.agent = serializeTimestamps(a);
  }
  if (ctx.principal.type === 'connector') {
    const cn = await ctx.pool.query.connectors.findFirst({
      where: and(eq(connectors.id, ctx.principal.id), eq(connectors.orgId, ctx.orgId), active(connectors)),
    });
    if (cn) base.connector = serializeTimestamps(cn);
  }
  return c.json(base);
});
```

- [ ] **Step 2: Mount in src/index.ts; add CORS middleware**

```ts
import { cors } from 'hono/cors';
import { me } from './routes/me.ts';

app.use('/v1/*', cors({
  origin: (origin) => {
    const allowed = (c.env as any).CORS_ALLOWED_ORIGINS?.split(',').map((s: string) => s.trim()).filter(Boolean) ?? [];
    if ((c.env as any).DB_MODE === 'single' && origin?.startsWith('http://localhost:')) return origin;
    return allowed.includes(origin ?? '') ? origin : null;
  },
  credentials: true,
}));
app.route('/v1/me', me);
```

(Adjust the closure signature to match Hono's cors API — `cors` accepts an origin function with the request; verify against current Hono docs.)

- [ ] **Step 3: test/routes/me.test.ts**

Test: bootstrap a user → use PAT → GET /v1/me → returns correct shape.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): /v1/me + CORS middleware"
```

---

## Task 9: Agents CRUD + saga + rotate-key

**Files:**
- Create: `src/routes/agents.ts`
- Create: `test/routes/agents.test.ts`

- [ ] **Step 1: src/routes/agents.ts — full CRUD with saga and active-task gate**

Endpoints:
- `POST /` — create agent (member+) → returns `{agent, key}`. Saga: insert agent → mint apiKey with `prefix='mcagt_'`, `principalType='agent'`, `metadata.agent_id=<new id>`, `orgId=<ctx.orgId>`. On apiKey failure: soft-delete the agent and return error.
- `GET /` — list active agents (any role; cursor pagination)
- `GET /:id` — fetch
- `PATCH /:id` — update name/description (owner|admin)
- `DELETE /:id` — soft delete; 409 if active tasks exist (owner|admin)
- `POST /:id/rotate-key` — mint new key, schedule old key disable after grace window (owner|admin)

For each mutator: emit the matching event via `emitEvent(...)`.

- [ ] **Step 2: test/routes/agents.test.ts — full coverage**

Tests:
- Create returns key once
- Saga compensating action: simulate apiKey creation failure → agent soft-deleted
- List returns only active
- Patch by member fails 403; by admin succeeds
- Delete with active tasks → 409
- Delete with no active tasks → soft-deletes + emits event
- Rotate-key → both old and new keys work for grace period
- Multi-tenant isolation: agent in org A invisible to org B

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): /v1/agents CRUD + saga + rotate-key"
```

---

## Task 10: Connectors CRUD + saga + rotate-key

**Files:**
- Create: `src/routes/connectors.ts`
- Create: `test/routes/connectors.test.ts`

- [ ] **Step 1: Mirror Task 9 structure for connectors**

Same saga shape, same active-task gate (any task with `agent_id` references the connector — wait, connectors don't directly own tasks via agent_id; reconsider: connectors create tasks but don't own them. Active-task gate for connector delete checks `external_refs` instead: refuse delete if any active `external_refs` row exists with `source_kind=<connector.kind>` and `source_id=<connector.id>`.)

Endpoints: POST, GET (list), GET (:id), PATCH, DELETE, POST :id/rotate-key. Same auth shape. `prefix='mccnn_'`, `principalType='connector'`, `metadata.connector_id=<id>`.

- [ ] **Step 2: test/routes/connectors.test.ts**

Mirror agents tests; replace active-tasks gate with active-external-refs gate.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): /v1/connectors CRUD + saga + rotate-key"
```

---

## Task 11: Projects CRUD

**Files:**
- Create: `src/routes/projects.ts`
- Create: `test/routes/projects.test.ts`

- [ ] **Step 1: src/routes/projects.ts**

Endpoints:
- `POST /` — create (owner|admin|member|connector). Body: `{name, slug, description?}`. Unique slug per org (409 on conflict). Returns project with timestamps as ISO.
- `GET /` — list active, cursor pagination, any role
- `GET /:id`
- `PATCH /:id` — owner|admin|member|connector; fields name/description/slug
- `DELETE /:id` — soft delete; owner|admin|connector. Cascade trigger handles external_refs.

Emit events: `project.created`, `project.updated`, `project.deleted`.

- [ ] **Step 2: test/routes/projects.test.ts**

Tests: create, list, update, delete, slug-uniqueness 409, multi-tenant isolation.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): /v1/projects CRUD"
```

---

## Task 12: Tasks CRUD + state machine + idempotency

**Files:**
- Create: `src/routes/tasks.ts`
- Create: `src/state-machine/tasks.ts`
- Create: `src/idempotency.ts`
- Create: `test/routes/tasks.test.ts`
- Create: `test/state-machine/tasks.test.ts`

- [ ] **Step 1: src/state-machine/tasks.ts — transition validator**

```ts
const ALLOWED: Record<string, string[]> = {
  pending:     ['ready', 'cancelled', 'failed'],
  ready:       ['in_progress', 'cancelled', 'failed'],
  in_progress: ['blocked', 'completed', 'failed', 'cancelled'],
  blocked:     ['in_progress', 'failed', 'cancelled'],
  completed:   [],   // terminal
  failed:      [],
  cancelled:   [],
};

export function validateTransition(from: string, to: string): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
```

- [ ] **Step 2: src/idempotency.ts — Layer-1 header-based cache**

Looks up `(org_id, route, key)` in `idempotency_keys` table. If hit + body matches: return cached. If hit + body differs: 409. If miss: proceed and cache result with 24h TTL.

- [ ] **Step 3: src/routes/tasks.ts**

Endpoints:
- `POST /` — owner|admin|member|connector. Accepts optional `Idempotency-Key` header (Layer 1) + body `idempotency_key` field (Layer 2). Validates `agent_id` exists and is active. Initial status is `pending` (no agent) or `ready` (agent set). Emits `task.created` + `task.assigned` if agent_id present.
- `GET /` — filters: `project_id`, `agent_id`, `status`, `updated_since`, `cursor`, `limit`. Agent role: forced `agent_id=principal_id`.
- `GET /:id` — full detail incl. latest 20 comments + 20 events.
- `PATCH /:id` — state-machine-validated status transitions. Agent role: only status+metadata, only their own tasks. Emits `task.status_changed`, `task.updated`, `task.assigned` as appropriate. Sets `started_at` on first transition to `in_progress`; `completed_at` on terminal.
- `DELETE /:id` — soft delete (owner|admin|connector). Triggers cascade externals/comments.

- [ ] **Step 4: test/state-machine/tasks.test.ts**

Matrix test of allowed/disallowed transitions:

```ts
for (const [from, to, allowed] of cases) {
  it(`${from} → ${to} ${allowed ? 'allowed' : 'rejected'}`, () => {
    expect(validateTransition(from, to)).toBe(allowed);
  });
}
```

Cover every from-to combination including terminal-states-rejecting-all.

- [ ] **Step 5: test/routes/tasks.test.ts**

Tests: create with/without agent, list with filters, detail includes comments+events, PATCH valid + invalid transitions, agent-role restricted to own tasks, idempotency Layer 1 (header repeat returns cache, different body → 409), Layer 2 (column conflict → 409 with `existing_task_id`), multi-tenant isolation.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): /v1/tasks CRUD + state machine + idempotency"
```

---

## Task 13: Comments CRUD

**Files:**
- Create: `src/routes/comments.ts`
- Create: `test/routes/comments.test.ts`

- [ ] **Step 1: src/routes/comments.ts**

Mounted under `/v1/tasks/:taskId/comments`.

Endpoints:
- `POST /` — any role can comment on a task in their org. Body: `{body: string}`. Emits `comment.created`.
- `GET /` — cursor pagination, oldest-first.

- [ ] **Step 2: test/routes/comments.test.ts**

Tests: create as user, agent, connector. List paginated. Multi-tenant isolation.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): /v1/tasks/:id/comments CRUD"
```

---

## Task 14: External refs CRUD

**Files:**
- Create: `src/routes/external-refs.ts`
- Create: `test/routes/external-refs.test.ts`

- [ ] **Step 1: src/routes/external-refs.ts**

Endpoints:
- `POST /` — body: `{resource_type, resource_id, source_kind, source_id, external_id, external_url?, metadata?}`. For agent role: `source_id` must equal `principal_id` (else 403). Same for connector. Owner/admin can set any. Validates that the target `resource_id` exists in the pool. Emits `external_ref.added`.
- `GET /` — query filters: `resource_type`, `resource_id`, `source_kind`, `source_id`, `external_id`, `cursor`, `limit`.
- `DELETE /:id` — soft delete; same source_id rules for machines.

- [ ] **Step 2: test/routes/external-refs.test.ts**

Tests: agent posts ref for self (200), agent posts ref for other agent (403). Connector same rules. UI/owner can post any. Filter queries work. Soft-delete + active() filter.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): /v1/external_refs CRUD"
```

---

## Task 15: Soft-delete cascade verification + restore guards

**Files:**
- Create: `test/cascade.test.ts`

- [ ] **Step 1: test/cascade.test.ts**

Tests:
- Delete a task → its `task_comments` and `external_refs` rows get `deleted_at` set
- Delete a project → its tasks remain (we don't cascade project→tasks); but project's external_refs do
- Trigger fires on raw SQL UPDATE (bypass app helpers): set `deleted_at` directly via `db.prepare` → verify cascade
- Re-creating after soft-delete works (partial unique index)

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Commit**

```bash
git add services/mission-control/
git commit -m "test(mission-control): soft-delete cascade behavior"
```

---

## Task 16: Multi-tenant isolation matrix test

**Files:**
- Create: `test/isolation.test.ts`
- Create: `test/helpers/fixtures.ts`

- [ ] **Step 1: test/helpers/fixtures.ts — `setupTwoOrgs()`, `mintAgentKey()`, etc.**

A factory that boots two orgs end-to-end via the bootstrap endpoint + creates agents/projects/tasks in each. Returns tokens and IDs for both. Used by every isolation test.

- [ ] **Step 2: test/isolation.test.ts**

For each route in (`agents`, `connectors`, `projects`, `tasks`, `comments`, `external_refs`):
- Create resource in org A
- Use org B's token to GET / PATCH / DELETE → 404 (or empty list)
- Use org A's token → succeeds

This is the single most important test — every test inserts two orgs and verifies cross-org isolation.

Run: `pnpm test`
Expected: PASS (full coverage matrix).

- [ ] **Step 3: Commit**

```bash
git add services/mission-control/
git commit -m "test(mission-control): cross-org isolation matrix for every route"
```

---

## Task 17: Cron triggers (events + idempotency + verification purge)

**Files:**
- Create: `src/jobs/cron.ts`
- Modify: `src/index.ts`
- Create: `test/jobs/cron.test.ts`

- [ ] **Step 1: src/jobs/cron.ts**

```ts
import type { ExecutionContext } from '@cloudflare/workers-types';
import { masterClient, poolClient } from '../db/client.ts';
import { events, idempotencyKeys } from '../db/pool.ts';
import { verification } from '../db/master.ts';
import { lt } from 'drizzle-orm';

export async function handleScheduled(event: ScheduledEvent, env: any, _ctx: ExecutionContext) {
  const now = Date.now();
  // Three cron schedules (in wrangler.toml). Dispatch by cron string.
  if (event.cron === '0 3 * * *') {
    const cutoff = now - (Number(env.EVENTS_RETENTION_DAYS ?? 365) * 86400_000);
    const pool = poolClient(env.DB_MODE === 'split' ? env.POOL_DEFAULT : env.DB);
    await pool.delete(events).where(lt(events.createdAt, cutoff));
  } else if (event.cron === '0 4 * * *') {
    const pool = poolClient(env.DB_MODE === 'split' ? env.POOL_DEFAULT : env.DB);
    await pool.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now));
  } else if (event.cron === '*/15 * * * *') {
    const master = masterClient(env);
    await master.delete(verification).where(lt(verification.expiresAt, new Date(now)));
  }
}
```

- [ ] **Step 2: Wire `scheduled` export from src/index.ts**

```ts
export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
```

- [ ] **Step 3: test/jobs/cron.test.ts**

Tests: insert old events, run handleScheduled('0 3 * * *'), verify old gone, new remain. Same for idempotency. Same for verification.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): cron jobs for events/idempotency/verification purge"
```

---

## Task 18: Logging hygiene + rate limiting + security headers

**Files:**
- Create: `src/logging.ts`
- Create: `src/rate-limit.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: src/logging.ts**

Hono logger middleware that emits one JSON line per request: `{ ts, request_id, method, path, status, ms, org_id?, principal? }`. Body capture **disabled** for paths matching `/v1/auth/*` and `/v1/bootstrap`. Echoes `X-Request-Id` header back.

- [ ] **Step 2: src/rate-limit.ts**

For now, document as "Cloudflare Rate Limiting binding required in production — bind as `RATE_LIMITER` in wrangler.toml [env.production], skipped in dev." Add a no-op middleware in dev. Stub the production wrapper for v1.

(Real RL binding requires Cloudflare account + plan; OK to leave as a stub call that the SaaS deploy hooks up.)

- [ ] **Step 3: Security headers middleware**

```ts
import { secureHeaders } from 'hono/secure-headers';
app.use('/v1/*', secureHeaders());
```

- [ ] **Step 4: Wire all into src/index.ts in correct order**

Order: secureHeaders → CORS → rate-limit → logger → routes.

Run: `pnpm test` + `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): logging hygiene + security headers + rate-limit stub"
```

---

## Task 19: Dockerfile + Node build target

**Files:**
- Create: `Dockerfile`
- Create: `src/node-entry.ts`
- Modify: `package.json` (add `build:node`, `start:node` scripts)

- [ ] **Step 1: src/node-entry.ts**

```ts
// Node + better-sqlite3 entrypoint (OSS self-host target).
import { serve } from '@hono/node-server';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { Hono } from 'hono';
// Re-import the Hono app from src/index.ts and wire Node-specific bindings.
import app from './index.ts';

const dbPath = process.env.MC_DB_PATH ?? '/data/mc.sqlite';
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
const db = drizzleSqlite(sqlite);

// Wrap the Hono app so c.env is populated with our Node-friendly bindings.
const wrapped = new Hono();
wrapped.use('*', async (c, next) => {
  (c.env as any).DB = sqlite;        // best-effort; actual usage goes through helpers
  await next();
});
wrapped.route('/', app);

serve({ fetch: wrapped.fetch, port: Number(process.env.PORT ?? 8787) });
```

(This is sketch — the `c.env.DB` shape between D1 and better-sqlite3 differs. The implementer needs to abstract via `db/client.ts` so both code paths work. May need a thin adapter that exposes D1-shaped methods on top of better-sqlite3 or vice versa. Use better-sqlite3's Drizzle driver consistently for Node and D1 driver for Workers, with a `client.ts` that picks based on `typeof env.DB`.)

- [ ] **Step 2: Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm typecheck

FROM node:22-alpine AS run
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./
VOLUME /data
EXPOSE 8787
ENV NODE_ENV=production MC_DB_PATH=/data/mc.sqlite
CMD ["node", "--experimental-strip-types", "src/node-entry.ts"]
```

- [ ] **Step 3: Add to package.json**

```json
"start:node": "node --experimental-strip-types src/node-entry.ts"
```

Also add `"@hono/node-server": "1.13.0"` (or current) to dependencies.

- [ ] **Step 4: Commit (skip image build; CI will handle)**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): Dockerfile + Node entrypoint for self-host"
```

---

## Task 20: Hermes-stack glue (service.env + compose.yaml + build.sh)

**Files:**
- Create: `service.env`
- Create: `compose.yaml`
- Create: `build.sh`

- [ ] **Step 1: service.env**

Follow hermes-stack convention (mirror `services/hermes-workspace/service.env`).

```bash
SERVICE_RUNNER=docker
SERVICE_DESC="MissionControl master kanban API (multi-agent coordination)"

# Image config — placeholder until we publish.
MC_IMAGE_REPO=mission-control
MC_IMAGE_DEFAULT=local

SERVICE_STACK_ENV='
MC_ADMIN_TOKEN=
BETTER_AUTH_SECRET=
MC_DB_PATH=/data/mc.sqlite
CORS_ALLOWED_ORIGINS=
'
```

- [ ] **Step 2: compose.yaml**

```yaml
services:
  mission-control:
    image: mission-control:local
    build:
      context: ./services/mission-control
      dockerfile: Dockerfile
    profiles: [mission-control]
    ports:
      - "${MC_PORT:-8787}:8787"
    environment:
      MC_ADMIN_TOKEN: ${MC_ADMIN_TOKEN}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
      BETTER_AUTH_URL: http://localhost:${MC_PORT:-8787}
      MC_DB_PATH: /data/mc.sqlite
      CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS:-}
      DB_MODE: single
      NODE_ENV: production
    volumes:
      - mission-control-data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8787/v1/health"]
      interval: 30s
      timeout: 5s

volumes:
  mission-control-data:
```

- [ ] **Step 3: build.sh**

Build the local image; warn if secrets unset.

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -z "${MC_ADMIN_TOKEN:-}" || -z "${BETTER_AUTH_SECRET:-}" ]]; then
  echo "[mission-control] WARNING: MC_ADMIN_TOKEN or BETTER_AUTH_SECRET unset in .stack/.env"
  echo "[mission-control]          run 'just setup' to mint, then 'just enable mission-control'"
fi
docker build -t mission-control:local .
```

Make executable: `chmod +x build.sh`.

- [ ] **Step 4: Commit**

```bash
git add services/mission-control/
git commit -m "feat(mission-control): hermes-stack glue (service.env + compose.yaml + build.sh)"
```

---

## Task 21: README + self-hosting docs

**Files:**
- Modify: `README.md`
- Create: `docs/self-hosting.md`

- [ ] **Step 1: Flesh out README.md**

Sections: overview, quickstart (dev), quickstart (self-host via Docker), production deploy (Cloudflare), env vars table (pointer to .env.example), API reference pointer, license, contributing.

- [ ] **Step 2: docs/self-hosting.md**

Sections: prerequisites, install via Docker, env config, bootstrap first user, backup/restore (SQLite + `db.backup()`), upgrade workflow, troubleshooting.

- [ ] **Step 3: Commit**

```bash
git add services/mission-control/
git commit -m "docs(mission-control): README + self-hosting guide"
```

---

## Final verification

After all 21 tasks complete:

- [ ] Run full test suite: `pnpm test` from `services/mission-control/`. Expect ZERO failures.
- [ ] Run typecheck: `pnpm typecheck`. Expect zero errors.
- [ ] Manually validate the end-to-end curl flow from the spec's "What v1 ships" section:

```bash
# Start dev server with admin token
MC_ADMIN_TOKEN=test BETTER_AUTH_SECRET=$(openssl rand -hex 32) pnpm dev &

# Bootstrap
curl -X POST http://localhost:8787/v1/bootstrap \
  -H "x-mc-admin-token: test" \
  -H "content-type: application/json" \
  -d '{"email":"you@acme.com","password":"testpass123","name":"You","orgName":"Acme","orgSlug":"acme"}'
# capture: PAT

# Create project
curl -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -X POST http://localhost:8787/v1/projects -d '{"name":"Test","slug":"test"}'
# capture: PROJECT_ID

# Create agent
curl -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -X POST http://localhost:8787/v1/agents -d '{"name":"hermes-vm1","kind":"hermes"}'
# capture: AGENT_ID + AGENT_KEY

# Create task assigned to agent
curl -H "Authorization: Bearer $PAT" -H "content-type: application/json" \
  -X POST http://localhost:8787/v1/tasks \
  -d "{\"project_id\":\"$PROJECT_ID\",\"title\":\"Hello\",\"agent_id\":\"$AGENT_ID\"}"
# capture: TASK_ID

# Agent polls
curl -H "Authorization: Bearer $AGENT_KEY" "http://localhost:8787/v1/tasks?status=ready"

# Agent updates status
curl -H "Authorization: Bearer $AGENT_KEY" -H "content-type: application/json" \
  -X PATCH "http://localhost:8787/v1/tasks/$TASK_ID" -d '{"status":"in_progress"}'

# Agent posts external ref
curl -H "Authorization: Bearer $AGENT_KEY" -H "content-type: application/json" \
  -X POST http://localhost:8787/v1/external_refs \
  -d "{\"resource_type\":\"task\",\"resource_id\":\"$TASK_ID\",\"source_kind\":\"hermes\",\"source_id\":\"$AGENT_ID\",\"external_id\":\"t_local_abc\"}"

# Agent posts comment
curl -H "Authorization: Bearer $AGENT_KEY" -H "content-type: application/json" \
  -X POST "http://localhost:8787/v1/tasks/$TASK_ID/comments" -d '{"body":"working on it"}'

# Agent completes
curl -H "Authorization: Bearer $AGENT_KEY" -H "content-type: application/json" \
  -X PATCH "http://localhost:8787/v1/tasks/$TASK_ID" -d '{"status":"completed"}'

# User views final state
curl -H "Authorization: Bearer $PAT" "http://localhost:8787/v1/tasks/$TASK_ID"
```

All commands should return 200/201 with sensible bodies. Verify the events table has rows for each mutation.

- [ ] **Final commit** if anything was tidied during validation:

```bash
git add services/mission-control/
git commit -m "chore(mission-control): final verification + cleanup"
```
