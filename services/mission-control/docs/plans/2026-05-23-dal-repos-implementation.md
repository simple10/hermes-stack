# DAL / Repos Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize every Drizzle query into `src/db/repos/` modules; remove every raw `ctx.pool.*` call from `src/routes/`. Mechanical enforcement of org/principal scope replaces hand-rolled `WHERE` clauses.

**Architecture:** Per the spec at `docs/specs/2026-05-23-dal-repos-design.md`. Each table gets its own `src/db/repos/<name>.ts` file with a `<name>Repo(ctx)` factory. A single `src/db/index.ts` exports `db.<table>(ctx)` factories. `OrgId` becomes a branded type.

**Tech Stack:** TypeScript, Drizzle 1.0.0-rc.3, Hono 4.12, Vitest 4. No new deps.

**Workspace:** `services/mission-control/` — all paths in this plan are relative to it.

---

## Conventions

- After every task: `pnpm typecheck && pnpm test` must both pass. No commit on red.
- Use the **Read+Edit** flow — DO NOT use `perl -i -pe` for multiline replacements (catastrophic corruption per session history; see `git log e034167..` for the recovery commits).
- One task = one focused commit. Commit message format: `refactor(mission-control): <one-line>`.
- NO Claude attribution in commit messages (repo policy).
- DO NOT run `pnpm install` — the lockfile is already correct.
- For verification: `node_modules/.bin/tsc --noEmit` (src), `node_modules/.bin/tsc --noEmit -p test/tsconfig.json` (test). Both must exit 0.

---

## Task 1: Brand the OrgId type

**Files:**
- Modify: `src/auth/types.ts`
- Modify: `src/auth/middleware.ts` (cast string → OrgId at auth boundary)

- [ ] **Step 1: Add OrgId brand to types.ts**

```ts
// src/auth/types.ts (add at top, alongside existing types)
declare const orgIdBrand: unique symbol;
export type OrgId = string & { readonly [orgIdBrand]: never };
/** Cast a string to OrgId. Use ONLY at the auth boundary after verifying the
 * value comes from a trusted source (verified bearer / session). */
export function asOrgId(s: string): OrgId { return s as OrgId; }
```

Change `AuthContext.orgId: string` → `AuthContext.orgId: OrgId`.

- [ ] **Step 2: Apply cast in middleware**

In `src/auth/middleware.ts`, wherever `orgId` is set in the auth context (currently raw strings from sessions / apiKey rows), wrap with `asOrgId(...)`. There are two paths (session and bearer); both need the cast.

- [ ] **Step 3: Run typecheck**

```sh
node_modules/.bin/tsc --noEmit
```

Expect: zero errors (we haven't yet narrowed any function params to require `OrgId`, so existing code still passes strings around freely; the brand is just available for repos to require).

- [ ] **Step 4: Run tests**

```sh
pnpm test
```

Expected: all 378 pass.

- [ ] **Step 5: Commit**

```sh
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add services/mission-control/src/auth/
git commit -m "refactor(mission-control): brand OrgId type — applied at auth boundary"
```

---

## Task 2: Repo scaffolding — shared base utilities

**Files:**
- Create: `src/db/repos/_base.ts`
- Create: `src/db/repos/index.ts` (empty facade — will fill in later tasks)

- [ ] **Step 1: Create _base.ts with shared helpers**

```ts
// src/db/repos/_base.ts
/**
 * Shared utilities for every repo.
 * Repos are thin facades over Drizzle that mechanically enforce tenant scope.
 *
 * Each repo file exports a single factory `<name>Repo(ctx)` returning an
 * object with named common operations + `.scoped()` / `.scope` / `.table`
 * escape hatches.
 */
import { isNull } from 'drizzle-orm';
import type { AuthContext } from '../../auth/types.ts';

export type { AuthContext };

/** Drizzle predicate: WHERE deleted_at IS NULL */
export function activeRows(t: { deletedAt: Parameters<typeof isNull>[0] }) {
  return isNull(t.deletedAt);
}
```

(Note: this is intentionally minimal. Each repo will import the table + scope-building logic locally so each repo file is self-contained / readable.)

- [ ] **Step 2: Create empty index.ts**

```ts
// src/db/repos/index.ts
// Facade — exports `db.<table>(ctx)` factories.
// Filled in as each repo is added.

export const db = {} as Record<string, never>;
```

- [ ] **Step 3: Typecheck**

```sh
node_modules/.bin/tsc --noEmit
```

Clean.

- [ ] **Step 4: Commit**

```sh
git add services/mission-control/src/db/repos/
git commit -m "refactor(mission-control): scaffold src/db/repos/ — base + facade"
```

---

## Task 3: Build pool-DB repos — tasks, projects, agents, connectors

**Files:**
- Create: `src/db/repos/tasks.ts`
- Create: `src/db/repos/projects.ts`
- Create: `src/db/repos/agents.ts`
- Create: `src/db/repos/connectors.ts`
- Modify: `src/db/repos/index.ts` (export new repos)

This task creates the four "primary entity" repos. Comments and external-refs come in Task 4 (they have sharper per-principal filters).

- [ ] **Step 1: Build src/db/repos/tasks.ts**

Per the spec's "Repo example — tasks (full)" section. Key requirements:
- `tasksRepo(ctx)` returns object with `findById`, `list`, `insert`, `update`, `softDelete`, `countActiveByAgent`, `scoped`, `scope`, `table`
- Scope = `and(eq(tasks.orgId, ctx.orgId), active(tasks), principalFilter)` where principalFilter is `eq(tasks.agentId, ctx.principal.id)` when `ctx.principal.type === 'agent'`
- `insert` payload type: `Omit<InsertInput, 'id' | 'orgId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>`
- `insert` generates `id`, `createdAt`, `updatedAt`, stamps `orgId`
- `update` cannot change `id`, `orgId`, `createdAt`, or any `deleted*` field
- `softDelete` writes `deletedAt`, `deletedByType`, `deletedById` from the principal
- All mutations include `scope` in their WHERE — cross-org updates/deletes are silently a no-op (return null)
- Wrap insert/update in `isUniqueViolation(e)` catch from `src/db/helpers.ts` if needed (e.g., `idempotencyKey` collisions on tasks) — re-throw as `HttpError(409, 'task.duplicate_idempotency_key', ...)`. Reuse the existing helper.

- [ ] **Step 2: Build src/db/repos/projects.ts**

Similar shape to tasks. Differences:
- No per-principal filter (everyone in the org sees all projects)
- `insert` may throw on slug-uniqueness; catch with `isUniqueViolation` → `HttpError(409, 'project.duplicate_slug', { existing_project_id })`. Repo does the conflict lookup to populate `existing_project_id` from a follow-up `select`.
- Standard `findById`, `list`, `update`, `softDelete`

- [ ] **Step 3: Build src/db/repos/agents.ts**

- No per-principal filter (agent-role principals can see other agents? Yes — they're org members, just with restricted task visibility. Confirm by reading current handlers; mirror today's behavior.)
- `insert` catches uniqueViolation → 409 `agent.duplicate_name`
- Resource-specific: `hasActiveTasks(id): Promise<{ count: number; sampleIds: string[] }>` — used by `softDelete` precondition
- `softDelete` calls `hasActiveTasks` first; if `count > 0`, throws `HttpError(409, 'agent.has_active_tasks', { task_ids })` — actually no, keep that check in the route handler; the repo just does the delete. The route stays responsible for the business rule.

  Wait — re-read spec: "softDelete is the only path that writes deletedAt." OK so repo handles the soft-delete write; the route handler does the precondition check using `db.tasks(ctx).countActiveByAgent(agentId)` (the task method from Task 3 Step 1).

- [ ] **Step 4: Build src/db/repos/connectors.ts**

Mirror agents. The "active refs" check is `db.externalRefs(ctx).countBySource('connector-kind', connectorId)` (provided by the externalRefs repo in Task 4).

- [ ] **Step 5: Update facade**

```ts
// src/db/repos/index.ts
import type { AuthContext } from '../../auth/types.ts';
import { tasksRepo } from './tasks.ts';
import { projectsRepo } from './projects.ts';
import { agentsRepo } from './agents.ts';
import { connectorsRepo } from './connectors.ts';

export const db = {
  tasks: tasksRepo,
  projects: projectsRepo,
  agents: agentsRepo,
  connectors: connectorsRepo,
};

export type DB = typeof db;
```

- [ ] **Step 6: Typecheck + test**

```sh
node_modules/.bin/tsc --noEmit
pnpm test
```

All clean. No route handlers use the repos yet, so behavior should be unchanged.

- [ ] **Step 7: Commit**

```sh
git add services/mission-control/src/db/repos/
git commit -m "refactor(mission-control): pool-DB repos — tasks/projects/agents/connectors"
```

---

## Task 4: Build remaining pool-DB repos — comments, external_refs, events

**Files:**
- Create: `src/db/repos/comments.ts`
- Create: `src/db/repos/external-refs.ts`
- Create: `src/db/repos/events.ts`
- Modify: `src/db/repos/index.ts`

- [ ] **Step 1: Build src/db/repos/comments.ts**

- Per-task scope: `commentsRepo(ctx)` works against the `task_comments` table
- Per-principal: agent role can only post comments on tasks where `tasks.agentId == ctx.principal.id`. That requires either a join or a precondition check. Simplest: a `canCommentOn(taskId): Promise<boolean>` helper the route uses before calling `insert`. Repo doesn't enforce cross-table preconditions.
- Methods: `listByTask(taskId, paginationOpts)`, `insert(taskId, body)`, `softDelete(id)`, `findById(id)`
- `insert` stamps `orgId`, `authorType`, `authorId` from `ctx.principal`

- [ ] **Step 2: Build src/db/repos/external-refs.ts**

- Per-principal filter on `sourceId` for agent/connector roles
- Methods: `findById`, `list(filter)`, `insert(values)`, `softDelete(id)`, `countBySource(sourceKind, sourceId)`
- `insert` catches uniqueViolation → 409 `external_ref.duplicate`
- For agent/connector roles: `insert` MUST enforce `sourceId === ctx.principal.id`. Repo throws `HttpError(403, 'external_ref.source_id_forbidden', ...)` if a machine principal tries to insert a ref with a different `sourceId`. This is the "agent can only post refs for its own source_id" rule moved out of routes.

- [ ] **Step 3: Build src/db/repos/events.ts**

- Append-only. No `softDelete`, no `update`. Just `insert` + (eventually v1.1) `list`.
- `insert(values)` stamps `orgId` from ctx; payload always serialized to JSON.
- This effectively replaces the existing `src/events/emit.ts` `emitEvent` function — preserve the existing `emit.ts` as a re-export from the repo so existing route imports keep working:

  ```ts
  // src/events/emit.ts (after refactor)
  export { emitEvent } from '../db/repos/events.ts';
  ```

  The repo's `insert` becomes the actual implementation; `emitEvent` is just an alias for `db.events(ctx).insert(...)` shaped per the existing call signature. Concretely, expose a method `emit(args)` on the repo that takes the existing emitEvent's args.

- [ ] **Step 4: Extend facade**

Add the three to `src/db/repos/index.ts`.

- [ ] **Step 5: Typecheck + test**

Clean.

- [ ] **Step 6: Commit**

```sh
git add services/mission-control/src/db/repos/ services/mission-control/src/events/
git commit -m "refactor(mission-control): pool-DB repos — comments/external-refs/events"
```

---

## Task 5: Build master-DB repos — users, orgs, members, api-keys

**Files:**
- Create: `src/db/repos/users.ts`
- Create: `src/db/repos/orgs.ts`
- Create: `src/db/repos/members.ts`
- Create: `src/db/repos/api-keys.ts`
- Modify: `src/db/repos/index.ts`

Master-DB repos use `masterClient(ctx.env)` internally; handlers don't see the master/pool split.

- [ ] **Step 1: Build src/db/repos/users.ts**

- Scope = (member of `ctx.orgId`). Lookup goes: query the `member` table to find users in this org, then resolve.
- Methods: `findById(userId)` — returns user only if they're a member of `ctx.orgId`. `listByOrg()` — same.
- Insert/update: defer to better-auth's own API; the repo only reads.

- [ ] **Step 2: Build src/db/repos/orgs.ts**

- Scope = `ctx.orgId` (you can only operate on YOUR org via this repo)
- Methods: `findById()` (always returns ctx.orgId's org or null), `update(patch)` (owner only — repo doesn't check the role; route does)

- [ ] **Step 3: Build src/db/repos/members.ts**

- Special: this repo is needed by the auth middleware ITSELF, before `ctx` exists. So expose both styles:
  - `membersRepo(ctx).roleForCurrentUser()` — for handlers that have a ctx
  - `membersRepoFor(env, userId, orgId).roleFor()` — for middleware bootstrap (takes env, not ctx)
- Resolve the design subtlety here: the middleware call doesn't have AuthContext yet because it's BUILDING the ctx. So the static variant is the only viable approach. Implement as a separate exported function: `lookupMemberRole(env, userId, orgId): Promise<{role: string} | null>`.

- [ ] **Step 4: Build src/db/repos/api-keys.ts**

- Scope = `eq(apiKey.orgId, ctx.orgId)` (note: this is the apiKey's `orgId` additionalField, not the user's)
- Methods: `findById`, `listForUser(userId)`, `revoke(id)`, `mintForUser(args)`, `mintForAgent(agentId, args)`, `mintForConnector(connectorId, args)`
- The `mintFor*` variants take the existing `mintApiKey` implementation from `src/auth/api-keys.ts` and adapt it. Preserve the existing `src/auth/api-keys.ts` as a thin re-export so other callers don't break:

  ```ts
  // src/auth/api-keys.ts (after refactor)
  // Backward-compat re-exports — the real implementation lives in db/repos/api-keys.ts
  export { mintApiKey, disableApiKey, generateRawKey, hashKey } from '../db/repos/api-keys.ts';
  ```

  Or alternatively, leave the low-level primitives (`generateRawKey`, `hashKey`) in `src/auth/api-keys.ts` and have the repo import them. Either is fine; the choice is about whose file owns the SHA-256+base64url logic.

- [ ] **Step 5: Extend facade**

```ts
// src/db/repos/index.ts (final shape)
export const db = {
  // pool
  tasks: tasksRepo,
  projects: projectsRepo,
  agents: agentsRepo,
  connectors: connectorsRepo,
  comments: commentsRepo,
  externalRefs: externalRefsRepo,
  events: eventsRepo,
  // master
  users: usersRepo,
  orgs: orgsRepo,
  members: membersRepo,
  apiKeys: apiKeysRepo,
};
```

- [ ] **Step 6: Typecheck + test**

Clean.

- [ ] **Step 7: Commit**

```sh
git add services/mission-control/src/db/repos/ services/mission-control/src/auth/api-keys.ts
git commit -m "refactor(mission-control): master-DB repos — users/orgs/members/api-keys"
```

---

## Task 6: System namespace — admin/cron unscoped ops

**Files:**
- Create: `src/db/repos/system.ts`
- Modify: `src/db/repos/index.ts` (export `system`)

- [ ] **Step 1: Build src/db/repos/system.ts**

```ts
// src/db/repos/system.ts
/**
 * Unscoped admin / cron operations.
 *
 * Functions in this module operate across orgs and DO NOT take an AuthContext.
 * Callers must include a `// system: <reason>` comment justifying use. The
 * ESLint rule flags any call to `system.*` without that comment.
 */
import { lt } from 'drizzle-orm';
import { events, idempotencyKeys } from '../pool.ts';
import { verification } from '../master.ts';
import { masterClient, poolClient } from '../client.ts';
import type { Env } from '../client.ts';

export const system = {
  events: {
    /** Purge events older than the cutoff (ms epoch). */
    async purgeOlderThan(env: Env, cutoff: number, binding: D1Database) {
      const pool = poolClient(binding);
      await pool.delete(events).where(lt(events.createdAt, cutoff));
    },
  },
  idempotencyKeys: {
    async purgeExpired(env: Env, now: number, binding: D1Database) {
      const pool = poolClient(binding);
      await pool.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now));
    },
  },
  verification: {
    async purgeExpired(env: Env, now: number) {
      const master = masterClient(env);
      await master.delete(verification).where(lt(verification.expiresAt, new Date(now)));
    },
  },
};
```

(The pool functions take an explicit `binding` because cron may iterate across pools when sharded — single-pool today, but the signature is forward-compatible.)

- [ ] **Step 2: Update src/jobs/cron.ts to use system.* (with the // system: comment)**

```ts
// src/jobs/cron.ts (changes)
import { system } from '../db/repos/system.ts';
// …
// system: scheduled retention purge (events grow unbounded otherwise)
await system.events.purgeOlderThan(env, cutoff, env.DB_MODE === 'split' ? env.POOL_DEFAULT! : env.DB!);
```

- [ ] **Step 3: Typecheck + test (cron test still passes)**

```sh
node_modules/.bin/tsc --noEmit
pnpm test test/jobs/cron.test.ts
```

Clean.

- [ ] **Step 4: Commit**

```sh
git add services/mission-control/src/db/repos/system.ts services/mission-control/src/jobs/cron.ts
git commit -m "refactor(mission-control): system namespace + migrate cron jobs"
```

---

## Task 7: Migrate routes — projects + comments + external-refs

**Files:**
- Modify: `src/routes/projects.ts`
- Modify: `src/routes/comments.ts`
- Modify: `src/routes/external-refs.ts`

These three are the simplest; doing them first warms up the migration pattern.

For each file:

- [ ] **Step 1: Replace `ctx.pool.*` calls with `db.<resource>(ctx).<method>(...)`**

Match each query to the corresponding repo method. When no method fits the case, ADD the method to the repo (don't escape unless truly necessary). Common patterns:

| Current shape | Replacement |
|---|---|
| `ctx.pool.select().from(t).where(and(eq(t.orgId, ctx.orgId), eq(t.id, id), active(t))).limit(1)` | `db.X(ctx).findById(id)` |
| `ctx.pool.insert(t).values({...})` | `db.X(ctx).insert({...})` (omit orgId — stamped) |
| `ctx.pool.update(t).set({...}).where(and(eq(t.orgId, ctx.orgId), eq(t.id, id))).returning()` | `db.X(ctx).update(id, {...})` |
| `ctx.pool.update(t).set({ deletedAt: now, ... }).where(...)` | `db.X(ctx).softDelete(id)` |

- [ ] **Step 2: Verify each migrated file's test suite passes**

```sh
pnpm test test/routes/projects.test.ts
pnpm test test/routes/comments.test.ts
pnpm test test/routes/external-refs.test.ts
```

Each should be fully green. If anything fails, the migration changed behavior — investigate, don't paper over.

- [ ] **Step 3: Typecheck**

Clean.

- [ ] **Step 4: Commit**

```sh
git add services/mission-control/src/routes/projects.ts services/mission-control/src/routes/comments.ts services/mission-control/src/routes/external-refs.ts
git commit -m "refactor(mission-control): migrate projects + comments + external-refs to repos"
```

---

## Task 8: Migrate routes — tasks + agents + connectors

**Files:**
- Modify: `src/routes/tasks.ts`
- Modify: `src/routes/agents.ts`
- Modify: `src/routes/connectors.ts`

These are larger and have sagas. Take them one at a time.

- [ ] **Step 1: Migrate src/routes/tasks.ts**

Tasks has the state machine + idempotency + heavy filtering. Map each query to repo methods. The state machine validation stays in the handler; the repo just does the writes.

Tests:
```sh
pnpm test test/routes/tasks.test.ts test/state-machine/tasks.test.ts
```

- [ ] **Step 2: Migrate src/routes/agents.ts**

Saga: insert agent + mint apiKey + compensating delete. Each step is now a repo call:
```ts
const agent = await db.agents(ctx).insert({ name, kind, description, createdByUserId: ctx.viaUserId });
try {
  const { rawKey } = await db.apiKeys(ctx).mintForAgent(agent.id, { name: `agent: ${agent.name}`, ... });
  // emit + respond
} catch (e) {
  await db.agents(ctx).softDelete(agent.id);
  throw new HttpError(500, 'agent.key_mint_failed', ...);
}
```

Active-tasks gate on delete: `await db.tasks(ctx).countActiveByAgent(agent.id)` → 409 if > 0.

Tests:
```sh
pnpm test test/routes/agents.test.ts
```

- [ ] **Step 3: Migrate src/routes/connectors.ts**

Mirror of agents. Active-refs gate: `await db.externalRefs(ctx).countBySource('connector-of-some-kind', connector.id)` — actually a connector's "active refs" probably means any external_ref whose source_id matches the connector id (regardless of source_kind). Check current behavior; mirror it.

Tests:
```sh
pnpm test test/routes/connectors.test.ts
```

- [ ] **Step 4: Full suite + typecheck**

```sh
node_modules/.bin/tsc --noEmit
pnpm test
```

All 378 green.

- [ ] **Step 5: Commit**

```sh
git add services/mission-control/src/routes/tasks.ts services/mission-control/src/routes/agents.ts services/mission-control/src/routes/connectors.ts
git commit -m "refactor(mission-control): migrate tasks + agents + connectors to repos"
```

---

## Task 9: Migrate identity routes — bootstrap, /me, auth middleware

**Files:**
- Modify: `src/routes/bootstrap.ts`
- Modify: `src/routes/me.ts`
- Modify: `src/auth/middleware.ts`

- [ ] **Step 1: Migrate bootstrap.ts**

Uses better-auth + direct inserts on user/organization/member. The "no users exist" gate becomes `await db.users.exists(env)` — add a static `exists(env)` to `usersRepo` that doesn't take ctx (the bootstrap endpoint runs BEFORE any user exists).

PAT minting becomes `await db.apiKeys.mintForUserBootstrap(env, userId, orgId, name)` — another static (env-only) variant.

Tests:
```sh
pnpm test test/routes/bootstrap.test.ts
```

- [ ] **Step 2: Migrate me.ts**

```ts
const ctx = c.var.auth;
const base = { org_id: ctx.orgId, role: ctx.role, principal_type: ctx.principal.type, principal_id: ctx.principal.id };
if (ctx.principal.type === 'agent') {
  const agent = await db.agents(ctx).findById(ctx.principal.id);
  if (agent) base.agent = serializeTimestamps(agent);
}
if (ctx.principal.type === 'connector') {
  const connector = await db.connectors(ctx).findById(ctx.principal.id);
  if (connector) base.connector = serializeTimestamps(connector);
}
return c.json(base);
```

Tests:
```sh
pnpm test test/routes/me.test.ts
```

- [ ] **Step 3: Migrate src/auth/middleware.ts**

The middleware reads the `member` table and `apiKey` table BEFORE ctx exists. Use the static lookups: `lookupMemberRole(env, userId, orgId)` and `lookupApiKey(env, hashedToken)` (add the latter to `apiKeysRepo` as another env-only static).

Tests:
```sh
pnpm test test/auth/
```

- [ ] **Step 4: Full suite + typecheck**

Clean.

- [ ] **Step 5: Commit**

```sh
git add services/mission-control/src/routes/bootstrap.ts services/mission-control/src/routes/me.ts services/mission-control/src/auth/middleware.ts
git commit -m "refactor(mission-control): migrate bootstrap/me/auth-middleware to repos"
```

---

## Task 10: Per-repo unit tests

**Files:**
- Create: `test/db/repos/tasks.test.ts`
- Create: `test/db/repos/projects.test.ts`
- Create: `test/db/repos/agents.test.ts`
- Create: `test/db/repos/connectors.test.ts`
- Create: `test/db/repos/comments.test.ts`
- Create: `test/db/repos/external-refs.test.ts`
- Create: `test/db/repos/events.test.ts`
- Create: `test/db/repos/api-keys.test.ts`
- Create: `test/db/repos/users.test.ts`
- Create: `test/db/repos/orgs.test.ts`

Per-repo coverage: each method's happy path + the org-scope enforcement + per-principal filter (where applicable). Pattern:

```ts
// test/db/repos/tasks.test.ts (sketch)
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { db } from '../../../src/db/repos/index.ts';
import { createOrgFixture } from '../../helpers/orgs.ts';

beforeAll(async () => {
  await applyD1Migrations((env.DB as D1Database), inject('d1Migrations') as D1Migration[]);
});

describe('tasksRepo', () => {
  it('findById returns row scoped to ctx.orgId', async () => {
    const orgA = await createOrgFixture(...);
    const orgB = await createOrgFixture(...);
    // Insert a task into orgA via Drizzle directly (bypass the repo we're testing)
    // … then verify orgB's repo can't find it
  });

  it('insert stamps ctx.orgId, ignoring caller-supplied org_id', async () => {
    // Pass an orgId in the values; verify the stored row has ctx.orgId instead
  });

  it('update with cross-org id returns null (does not mutate)', async () => {
    // Repo's update returns null instead of throwing when the WHERE doesn't match
  });

  it('agent-role ctx only sees own tasks via list()', async () => {
    // Same orgId, two agents, two tasks. Agent A's ctx → list returns only A's tasks
  });

  it('softDelete writes deleted_at + deleted_by_*', async () => { /* … */ });

  it('countActiveByAgent counts non-terminal tasks correctly', async () => { /* … */ });
});
```

- [ ] **Step 1: Write all 10 repo test files**

Roughly 5-8 tests per file = ~60-80 new tests.

- [ ] **Step 2: Run all tests**

```sh
pnpm test
```

All ~440 tests pass.

- [ ] **Step 3: Commit**

```sh
git add services/mission-control/test/db/repos/
git commit -m "test(mission-control): per-repo unit tests for the new DAL"
```

---

## Task 11: ESLint rule banning raw ctx.pool in routes

**Files:**
- Create: `eslint-rules/no-raw-pool-in-routes.cjs` (or `.js` — depending on existing eslint setup)
- Modify: `package.json` (add eslint + the local rule)
- Modify: `.eslintrc.cjs` or `eslint.config.js` (whichever exists; check repo)

**Investigation first** — what eslint setup, if any, currently exists in the repo? Run:
```sh
ls .eslintrc* eslint.config* 2>/dev/null
grep -n "lint" package.json
```

If no eslint is installed, this task installs it (user must run `pnpm install` after the package.json edit). Note the manual install requirement in the commit message.

- [ ] **Step 1: Build the rule**

```js
// eslint-rules/no-raw-pool-in-routes.cjs
/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Route handlers must use src/db/repos, not raw ctx.pool.*',
    },
    schema: [],
  },
  create(ctx) {
    return {
      MemberExpression(node) {
        // Look for ctx.pool.select(), ctx.pool.insert(), ctx.pool.update(), ctx.pool.delete()
        if (
          node.object &&
          node.object.type === 'MemberExpression' &&
          node.object.object?.name === 'ctx' &&
          node.object.property?.name === 'pool' &&
          ['select', 'insert', 'update', 'delete'].includes(node.property?.name)
        ) {
          // Allow if prior line has `// repo-escape:` comment
          const sourceCode = ctx.getSourceCode();
          const comments = sourceCode.getCommentsBefore(node);
          const hasEscape = comments.some(c => /repo-escape:/.test(c.value));
          if (!hasEscape) {
            ctx.report({
              node,
              message:
                'Direct ctx.pool.* call in route handler. Use src/db/repos instead, or add `// repo-escape: <reason>` above this line.',
            });
          }
        }
      },
    };
  },
};
```

- [ ] **Step 2: Add eslint config**

If a config doesn't exist, create `eslint.config.js`:
```js
import noRawPool from './eslint-rules/no-raw-pool-in-routes.cjs';

export default [
  {
    files: ['src/routes/**/*.ts'],
    plugins: {
      'mc-local': { rules: { 'no-raw-pool-in-routes': noRawPool } },
    },
    rules: {
      'mc-local/no-raw-pool-in-routes': 'error',
    },
  },
];
```

Add to package.json scripts: `"lint": "eslint src/routes/"`.

If eslint isn't installed, add to devDependencies: `"eslint": "9.x"` (check latest stable). NOTE: the user will need to manually run `pnpm install` to pick up this dep. Document in the commit message.

- [ ] **Step 3: Verify the rule fires + passes**

Run `pnpm lint`. Expected output: zero violations (every route should now use repos). If there are violations, they indicate routes that were NOT fully migrated in earlier tasks — go fix them.

Add one deliberately bad test case under `eslint-rules/__tests__/` proving the rule catches the bad pattern.

- [ ] **Step 4: Commit**

```sh
git add eslint-rules/ services/mission-control/eslint.config.js services/mission-control/package.json
git commit -m "feat(mission-control): ESLint rule banning raw ctx.pool.* in route handlers"
```

(If eslint dep was added: mention in commit message that the user needs to run pnpm install before lint will run.)

---

## Task 12: Final verification + cleanup

- [ ] **Step 1: Grep for any remaining raw ctx.pool uses in routes**

```sh
grep -rn "ctx\.pool\." src/routes/ | grep -v "repo-escape:"
```

Expected: empty (all routes go through repos).

- [ ] **Step 2: Full typecheck + test suite**

```sh
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsc --noEmit -p test/tsconfig.json
pnpm test
```

All green, all 440+ tests pass.

- [ ] **Step 3: Re-run end-to-end smoke (the curl flow from the spec)**

Boot wrangler dev, run the bootstrap → create project → create agent → create task → poll → claim → complete sequence. Verify nothing broke.

- [ ] **Step 4: Final commit if anything was tidied**

```sh
git add -u
git diff --cached
# If clean: skip commit. If not: commit message describes what was tidied.
```

---

## Open questions to resolve during implementation

1. **`db.X(ctx)` per-call vs cached** — the spec says per-call (cheap). Verify there's no measurable overhead in tests; revisit if needed.
2. **`scoped()` return type** — Drizzle's chainable builder may need an explicit return type or generic to flow properly. Address during Task 3 Step 1.
3. **`scope` extraction for joins** — if no concrete join callsite exists, defer the join-helper pattern; just expose `table` and `scope` for now and add joins on demand.
4. **`api-keys` repo overlap with `src/auth/api-keys.ts`** — pick one: either move the SHA-256+base64url primitives into the repo, or keep them in auth/api-keys.ts as low-level utilities and have the repo wrap them. Task 5 Step 4 picks the latter; verify it actually works.

---

## Reviewer findings — plan amendments

A pre-implementation review surfaced concrete plan gaps. Amendments to the tasks below; see the spec's "Reviewer findings — resolved" for the architectural decisions.

### Amendment A: Task 2 — `_base.ts` is no-op

`_base.ts` is empty/optional now. Each repo imports `active` from `src/db/helpers.ts` directly and re-exports `AuthContext` from `src/auth/types.ts`. Delete the `activeRows` proposal.

### Amendment B: Task 2 — Add `src/db/repos/_errors.ts`

Add a new file containing the typed domain errors (`DuplicateError`, `ForbiddenError`) per spec's updated error model. Import these from every repo that catches a UNIQUE violation. Step 1 becomes "create `_errors.ts` + the empty `index.ts`".

### Amendment C: Task 4 — Events repo signature

The `db.events(ctx).emit({resourceType, resourceId, kind, payload})` method takes only kind-specific args. `orgId` + `actor` come from ctx.

**Add migration step:** find every `emitEvent(pool, {...})` callsite and rewrite to `db.events(ctx).emit({...})`. Concrete files to update (verified via grep):
- `src/routes/agents.ts`
- `src/routes/connectors.ts`
- `src/routes/projects.ts`
- `src/routes/tasks.ts`
- `src/routes/comments.ts`
- `src/routes/external-refs.ts`
- `src/routes/bootstrap.ts` (if it emits an org.created event — verify)

After every callsite is updated, **delete `src/events/emit.ts` entirely** (no shim). Update the events test if it imports the old function.

This is a bigger Task-4 commit than originally scoped. Adjust commit message accordingly.

### Amendment D: Task 5 — `apiKeysRepo` rotate-key

Add method `db.apiKeys(ctx).mintAndExpireExisting({...newKeyArgs}, oldKeyId, expiresAt)` — used by agent/connector rotate-key routes. Atomically (well, sequentially) mints a new key and sets the old key's expiresAt to `now + grace`. Returns `{newKey, oldExpiresAt}`.

### Amendment E: Task 6 — `system.*` signatures

```ts
system.events.purgeOlderThan(binding: D1Database, cutoff: number): Promise<void>
system.idempotencyKeys.purgeExpired(binding: D1Database, now: number): Promise<void>
system.verification.purgeExpired(masterBinding: D1Database, now: number): Promise<void>
```

Drop the `env` arg; callers pass the binding explicitly. `src/jobs/cron.ts` resolves the right binding from env and passes it.

### Amendment F: Task 7 — Handler error-mapping pattern

Every route handler now needs:

```ts
import { DuplicateError, ForbiddenError } from '../db/repos/_errors.ts';

// at the catch site (or in errorResponse helper):
if (e instanceof DuplicateError) {
  return errorResponse(c, new HttpError(409, `${e.resource}.duplicate`, e.message, e.details));
}
if (e instanceof ForbiddenError) {
  return errorResponse(c, new HttpError(403, e.code, e.message, e.details));
}
```

Cleaner: extend `errorResponse()` itself in `src/errors.ts` to handle these automatically. Recommended approach — one place, every handler benefits. Add as Step 0 of Task 7.

### Amendment G: Task 8 — agent/connector saga semantics preserved

The compensating delete on apiKey-mint failure must keep using `deleted_by_type = 'system'` (matches current behavior; the agent never went live, so the deletion isn't a user-initiated soft-delete). Two options:
- Repo's `softDelete` accepts an optional `actor` override; saga passes `{type:'system', id:'compensating-action'}`.
- Bypass `softDelete` for the compensating path and write `deleted_at` directly via `.scoped().update({...}).where(...)`.

Pick option 1 — keeps all mutations going through the repo.

### Amendment H: Task 9 — `lookupApiKey(env, hashedToken)` for middleware

The middleware also looks up apiKey rows before ctx exists. Add a static lookup (`apiKeysRepo`'s env-only variant) the middleware can call.

Concrete: `apiKeysRepo` exports both:
- `apiKeysRepo(ctx)` — for handlers
- `apiKeysRepoStatic.lookupByHash(env, hashedToken)` — for middleware
Same pattern as `members`.

### Amendment I: Task 10 — Add `test/helpers/orgs.ts` to the files list

After OrgId is branded, `createOrgFixture` returns `{userId, orgId, pat}` where `orgId` is typed `OrgId`. Cast `orgId as OrgId` at the return site of the helper. Tests passing the fixture's `orgId` to repo calls then satisfy the brand.

### Amendment J: Task 11 — ESLint rule expanded scope

Rule must flag:
- `ctx.pool.{select|insert|update|delete}` (current)
- `masterClient(...).{select|insert|update|delete}` (any call returning a Drizzle client followed by a write/read)
- `c.env.DB`, `c.env.MASTER_DB`, `c.env.POOL_*` direct access in route handlers

The rule logic walks `MemberExpression` nodes for these patterns. Allow `// repo-escape: <reason>` exemption.

Allowlist: `src/routes/health.ts` may call `c.env.DB.prepare('SELECT 1')` (the readiness probe). Either exclude via path config or add the exemption comment in the file.

### Amendment K: Task 12 — Grep also for `masterClient`

```sh
grep -rn "ctx\.pool\.\|masterClient(\|c\.env\.\(DB\|MASTER_DB\|POOL_\)" src/routes/ | grep -v "repo-escape:"
```

Expected: only the health.ts probe call (with the exemption comment).
