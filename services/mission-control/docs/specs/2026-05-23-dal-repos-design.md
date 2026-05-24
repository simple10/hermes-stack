# MissionControl — DAL / Repos Design

**Status:** Draft for review
**Date:** 2026-05-23
**Scope:** Refactor of every data-access call site in MissionControl into a centralized repository layer that mechanically enforces multi-tenant isolation.

---

## Goal

Stop spreading raw Drizzle queries across route handlers. Centralize every `select / insert / update / delete` for every table into a single `src/db/repos/` module. The repository layer **mechanically enforces** the tenant scope (`org_id`) and the per-principal visibility filter (e.g., agents see only their own tasks) — handlers cannot forget the filter because the filter is not theirs to write.

Companion concern: introduce a branded `OrgId` type so the auth-derived org id can be statically distinguished from arbitrary strings (URL params, request bodies, etc.), preventing a class of "wrong org" bugs at compile time.

---

## Non-goals (explicit)

- **Not a full ORM swap.** We keep Drizzle. Repos are a thin facade over Drizzle, not a replacement query language.
- **Not removing all flexibility.** Each repo exposes a `.scoped()` escape hatch for ad-hoc joins / analytics / queries that don't fit the common-operations API. The escape hatch still applies the org scope.
- **Not a behavior change.** Every route handler must produce the same HTTP responses as today. All 378 tests must still pass.
- **Not a write-side refactor.** Sagas (cross-DB operations like agent + apikey mint) stay in route handlers; they call repos but coordinate the steps themselves.

---

## Current state (the problem this solves)

Today every route handler builds its own Drizzle query with hand-rolled `eq(table.orgId, ctx.orgId)` and `active(table)` filters:

```ts
// src/routes/projects.ts — typical pattern, repeated ~50 times across handlers
const rows = await ctx.pool.select().from(projects)
  .where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, id), active(projects)))
  .limit(1);
const project = rows[0];
```

Failure modes:
1. **Forgetting `eq(table.orgId, ctx.orgId)`** — returns rows across orgs in the same pool. Silent leak.
2. **Forgetting `active(table)`** — returns soft-deleted rows. Subtle bug.
3. **Wrong org id passed (URL param vs auth context)** — TS can't catch; both are `string`.
4. **Per-principal filters duplicated** — agent-role "only own tasks" check is repeated in every agent-affecting handler.

Existing defenses: `test/isolation.test.ts` (26 cross-org assertions) catches the most common leak, but every new route file needs a paired isolation test or the protection is incomplete.

---

## Solution architecture

### One file per table

```
src/db/repos/
  index.ts            # facade — re-exports `db.<table>(ctx)` factories
  tasks.ts
  projects.ts
  agents.ts
  connectors.ts
  comments.ts            # task_comments table
  external-refs.ts
  events.ts
  api-keys.ts            # master DB
  users.ts               # master DB
  orgs.ts                # master DB
  members.ts             # master DB (better-auth membership lookups)
  system.ts              # unscoped admin/cron operations (e.g., bulk purge)
```

### Repo contract — every repo conforms to a shape

Each `xxxRepo(ctx: AuthContext)` returns an object with:

```ts
type Repo<T extends SQLiteTable> = {
  // Named common operations — pre-baked, return typed rows
  findById(id: string): Promise<Row<T> | null>;
  list(filter?: FilterOptions): Promise<Row<T>[]>;
  insert(values: InsertInput<T>): Promise<Row<T>>;
  update(id: string, patch: UpdateInput<T>): Promise<Row<T> | null>;
  softDelete(id: string): Promise<Row<T> | null>;

  // Escape hatches for ad-hoc queries — the scope WHERE is exposed
  // so callers can reuse it (e.g., joins from another repo).
  scoped(): SelectBuilder;   // returns `pool.select().from(table).where(scope)`
  scope: SQL;                // the SQL fragment (org_id + active + principal filter)
  table: T;                  // the Drizzle table object — for joins
};
```

Per-resource repos add bespoke methods where useful (e.g., `tasks.byAgentReady()`, `agents.hasActiveTasks(id)`, `apiKeys.mintForAgent(...)`).

### What the scope enforces

`scope` = `and(eq(table.orgId, ctx.orgId), active(table), principalFilter)`

Where `principalFilter` is:
- For `tasks` when `ctx.principal.type === 'agent'`: `eq(tasks.agentId, ctx.principal.id)`
- For `external_refs` when `ctx.principal.type === 'agent'`: `eq(externalRefs.sourceId, ctx.principal.id)` — only refs the agent itself posted
- For `external_refs` when `ctx.principal.type === 'connector'`: `eq(externalRefs.sourceId, ctx.principal.id)`
- For everything else: no extra filter

Per-principal filtering documentation lives in each repo's file. Adding a new principal restriction = one-place change.

### Insert/Update type-safety: org_id stamped, can't be overridden

Insert payload types are `Omit<Insert<T>, 'orgId' | 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>`. Server-controlled columns can't be supplied by the caller; the repo generates them.

Update payload types are `Omit<Update<T>, 'id' | 'orgId' | 'createdAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>`. `updatedAt` is bumped by the repo.

`softDelete` is the only path that writes `deletedAt`. No handler should construct that triple by hand.

### Branded OrgId

```ts
// src/auth/types.ts
declare const orgIdBrand: unique symbol;
export type OrgId = string & { readonly [orgIdBrand]: never };
export const OrgId = (s: string): OrgId => s as OrgId;
```

`AuthContext.orgId: OrgId` (was `string`). Anywhere that accepts an `orgId` parameter from URL/body params is typed as `string` and must explicitly cast via a validator — preventing "I'll just pass `req.body.org_id`" footguns.

Repos accept only `OrgId` for cross-org checks (the auth-derived one) and `string` for resource ids.

### Master DB repos hide the cross-DB split

`db.users(ctx)`, `db.apiKeys(ctx)`, `db.orgs(ctx)`, `db.members(ctx)` internally use `masterClient(env)`. Handlers don't know which DB each resource lives in — the repo handles it.

### Unscoped operations — `system` namespace

A small `src/db/repos/system.ts` exposes admin/cron operations that DON'T take an `AuthContext`:

- `system.events.purgeOlderThan(env, cutoffMs)` — used by cron
- `system.idempotencyKeys.purgeExpired(env)` — used by cron
- `system.verification.purgeExpired(env)` — better-auth cleanup
- `system.bootstrap.createFirstUser(env, ...)` — the bootstrap endpoint

Anything that genuinely operates across orgs goes here. Files calling `system.*` must include a `// system: <reason>` comment justifying it. ESLint rule (below) enforces.

---

## ESLint rule — banning raw `ctx.pool` in route handlers

A custom rule under `eslint-rules/no-raw-pool-in-routes.ts`:

- Walks `src/routes/**/*.ts`
- Flags any reference to `ctx.pool.{select|insert|update|delete}` or `masterClient(ctx.env)` followed by `.select()/.insert()/.update()/.delete()`
- Allowed exception: a comment `// repo-escape: <reason>` on the line immediately above the call

This catches "someone copy-pasted an old handler" regressions.

CI runs `pnpm lint` as a required check.

---

## Migration approach

Per-route migration. Steps for each route file:

1. Identify every `ctx.pool.*` call site in the route.
2. Replace with `db.<resource>(ctx).<method>(...)`.
3. If no method fits, add the method to the repo (don't escape to raw unless necessary).
4. If still no method fits, use `db.<resource>(ctx).scoped().…` with the chainable builder.
5. Run `pnpm test test/routes/<route>.test.ts` after each route. Move on when green.

Tests don't change. They hit HTTP routes; the underlying DAL is invisible to them. Any test failure indicates a real behavior change that needs investigation.

---

## Repo example — tasks (full)

```ts
// src/db/repos/tasks.ts
import { eq, and, gt, lt, desc, asc, sql, type SQL } from 'drizzle-orm';
import { tasks } from '../pool.ts';
import { active } from '../helpers.ts';
import type { AuthContext } from '../../auth/types.ts';
import { emitEvent } from '../../events/emit.ts';
import { makeId } from '../../ids.ts';
import type { TaskStatus } from '../../state-machine/tasks.ts';

type TaskRow = typeof tasks.$inferSelect;
type TaskInsertInput = Omit<typeof tasks.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>;
type TaskUpdateInput = Partial<Omit<typeof tasks.$inferInsert,
  'id' | 'orgId' | 'createdAt' | 'deletedAt' | 'deletedByType' | 'deletedById'>>;

export interface TaskListFilter {
  projectId?: string;
  agentId?: string;
  statuses?: TaskStatus[];
  updatedSince?: number;
  limit?: number;
  cursor?: { updatedAt: number; id: string };  // already decoded by caller
}

export function tasksRepo(ctx: AuthContext) {
  // Per-principal filter — agent role only sees its own tasks
  const principalFilter = ctx.principal.type === 'agent'
    ? eq(tasks.agentId, ctx.principal.id)
    : undefined;

  const scope = and(eq(tasks.orgId, ctx.orgId), active(tasks), principalFilter);

  return {
    async findById(id: string): Promise<TaskRow | null> {
      const rows = await ctx.pool.select().from(tasks)
        .where(and(scope, eq(tasks.id, id))).limit(1);
      return rows[0] ?? null;
    },

    async list(filter: TaskListFilter = {}): Promise<TaskRow[]> {
      const conditions: SQL[] = [scope!];
      if (filter.projectId)   conditions.push(eq(tasks.projectId, filter.projectId));
      if (filter.agentId)     conditions.push(eq(tasks.agentId, filter.agentId));
      if (filter.statuses?.length)
        conditions.push(sql`${tasks.status} IN ${filter.statuses}`);
      if (filter.updatedSince)
        conditions.push(gt(tasks.updatedAt, filter.updatedSince));
      if (filter.cursor) conditions.push(
        // keyset: (updatedAt, id) < cursor
        sql`(${tasks.updatedAt}, ${tasks.id}) < (${filter.cursor.updatedAt}, ${filter.cursor.id})`,
      );
      return ctx.pool.select().from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.updatedAt), desc(tasks.id))
        .limit(filter.limit ?? 50);
    },

    async insert(values: TaskInsertInput): Promise<TaskRow> {
      const id = makeId('task');
      const now = Date.now();
      const row = {
        ...values,
        id,
        orgId: ctx.orgId,    // STAMPED
        createdAt: now,
        updatedAt: now,
      };
      const inserted = await ctx.pool.insert(tasks).values(row).returning();
      return inserted[0]!;
    },

    async update(id: string, patch: TaskUpdateInput): Promise<TaskRow | null> {
      const updated = await ctx.pool.update(tasks)
        .set({ ...patch, updatedAt: Date.now() })
        .where(and(scope, eq(tasks.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    async softDelete(id: string): Promise<TaskRow | null> {
      const updated = await ctx.pool.update(tasks)
        .set({
          deletedAt: Date.now(),
          deletedByType: ctx.principal.type,
          deletedById: ctx.principal.id,
        })
        .where(and(scope, eq(tasks.id, id)))
        .returning();
      return updated[0] ?? null;
    },

    // Resource-specific: count active tasks for an agent (used by agent.delete)
    async countActiveByAgent(agentId: string): Promise<number> {
      const result = await ctx.pool.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(
          eq(tasks.orgId, ctx.orgId),
          eq(tasks.agentId, agentId),
          active(tasks),
          sql`${tasks.status} IN ('ready','in_progress','blocked')`,
        ));
      return result[0]?.count ?? 0;
    },

    // Escape hatch — raw builder pre-scoped to the org
    scoped: () => ctx.pool.select().from(tasks).where(scope),
    scope: scope!,
    table: tasks,
  };
}
```

### Saga callsite (the route handler stays orchestration-only)

```ts
// src/routes/agents.ts — POST /v1/agents
app.post('/', requireAnyRole('owner','admin','member'), async (c) => {
  const { name, kind, description } = createBody.parse(await c.req.json());
  const ctx = c.var.auth;

  // 1. Insert agent in pool
  const agent = await db.agents(ctx).insert({ name, kind, description, createdByUserId: ctx.viaUserId });

  // 2. Mint apiKey in master
  let key: string;
  try {
    const minted = await db.apiKeys(ctx).mintForAgent(agent.id);
    key = minted.rawKey;
  } catch (e) {
    // 3. Compensating action
    await db.agents(ctx).softDelete(agent.id);
    throw new HttpError(500, 'agent.key_mint_failed', ...);
  }

  // 4. Emit event + respond
  await emitEvent(ctx.pool, { resourceType: 'agent', resourceId: agent.id, kind: 'agent.created', ... });
  return c.json({ agent: serializeRow(agent), key }, 201);
});
```

The handler shrinks. Validation, role gate, saga orchestration, event emission, response shaping. Zero raw SQL.

---

## Testing strategy

- Existing 378 tests pass unchanged. They hit HTTP routes; the underlying DAL is invisible to them.
- Add **per-repo unit tests** in `test/db/repos/<repo>.test.ts` — one file per repo, covering: each method's happy path, the org-scope filter (insert can't override `orgId`; update across orgs returns null), the per-principal filter (agent role can't see another agent's tasks), the escape-hatch shape.
- Existing `test/isolation.test.ts` matrix stays — it's the integration-level proof that the DAL actually enforces what it claims.

Coverage gate: every repo file has ≥ 80% line coverage from its unit tests.

---

## Error model

Repos throw **typed domain errors** — never HTTP-aware. Route handlers catch these and map to HTTP responses.

```ts
// src/db/repos/_errors.ts
export class DuplicateError extends Error {
  constructor(public resource: string, public details: Record<string, unknown> = {}) {
    super(`${resource} already exists`);
    this.name = 'DuplicateError';
  }
}

export class ForbiddenError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ForbiddenError';
  }
}
```

How each layer signals:
- **Not found**: repos return `null` (or `[]`). Handler maps null → 404 with the right error code (`task.not_found`, etc.).
- **Duplicate**: repos throw `DuplicateError('task', { existing_task_id })`. Handler maps → `HttpError(409, 'task.duplicate_idempotency_key', ...)`.
- **Forbidden** (machine principal trying to act outside its scope, e.g. agent posting external_ref with someone else's source_id): repo throws `ForbiddenError('external_ref.source_id_forbidden', ...)`. Handler maps → `HttpError(403, ...)`.
- **State-machine violations**: stay in the handler. The repo accepts the new status; the handler validates the transition first.

Pattern in handlers:

```ts
try {
  const task = await db.tasks(ctx).insert(values);
  return c.json({ task: serializeRow(task) }, 201);
} catch (e) {
  if (e instanceof DuplicateError) {
    return errorResponse(c, new HttpError(409, 'task.duplicate_idempotency_key', e.message, e.details));
  }
  if (e instanceof ForbiddenError) {
    return errorResponse(c, new HttpError(403, e.code, e.message, e.details));
  }
  throw e;
}
```

Repos stay HTTP-agnostic; handlers translate domain errors into HTTP. Same `HttpError` class as today.

---

## What stays out of repos

| Concern | Stays in |
|---|---|
| Auth (resolving the bearer, building `ctx`) | `src/auth/middleware.ts` |
| Role gates (`requireMember`, `requireMachine`) | `src/auth/middleware.ts` |
| Body validation | Per-route, with Zod |
| State machine validation | `src/state-machine/tasks.ts` + tasks route |
| Saga orchestration (cross-DB / cross-resource) | Route handlers |
| Event emission | Route handlers (call `emitEvent` after the repo write) |
| HTTP response shaping (status codes, headers, ISO timestamps) | Route handlers + `serializeRow` |
| Idempotency-key cache layer | `src/idempotency.ts` (separate concern) |

---

## Migration risk register

| Risk | Mitigation |
|---|---|
| Subtle behavior change between hand-rolled query and repo method | Per-route tests run after each migration; any failure investigated before moving on |
| Repo adds an inadvertent extra filter (e.g., principal filter applied where it shouldn't) | Per-repo unit tests cover each principal type explicitly |
| Escape hatch overused, eroding the benefit | ESLint rule + code review; "if you escape, write a method instead" |
| Cross-repo transactions / joins become awkward | Repos expose `.table` and `.scope` so joins can be hand-rolled when needed; system repo handles cross-cutting bulk |
| Branded OrgId breaks existing call sites | Compiler errors will point to every site; mechanical fix (cast at the auth boundary, propagate brand from there) |

---

## What v1 ships

After this refactor:
- ✅ `src/db/repos/{tasks,projects,agents,connectors,comments,external-refs,events,api-keys,users,orgs,members,system}.ts`
- ✅ `src/db/index.ts` facade
- ✅ Every route handler under `src/routes/` uses `db.X(ctx).Y(...)` exclusively — no `ctx.pool.*` calls
- ✅ `OrgId` branded type, propagated from `AuthContext`
- ✅ ESLint rule banning raw `ctx.pool` in routes
- ✅ Per-repo unit tests
- ✅ All 378 existing integration tests still pass

Deferred to follow-up:
- Repo-level audit logging (every mutation logged with principal + table + op)
- Repo-level query telemetry (latency per method)
- Per-request memoization (`findById` dedupe within one request)

---

## Open questions

1. **Members table access pattern** — `db.members(ctx).roleFor(userId, orgId)` is needed by auth middleware itself, BEFORE `ctx` exists. The members repo may need a static `membersRepo.roleFor(env, userId, orgId)` variant that doesn't take ctx. Resolve during implementation.
2. **`tasks.list` filter shape vs handler-side decoding** — the handler decodes the cursor; the repo accepts the already-decoded `{updatedAt, id}`. Document the contract; alternative is having the repo decode but that pulls HMAC-secret reading into the repo (smell).
3. **`scoped()` chainable typing** — Drizzle's builder types may flow through cleanly or may need an explicit return type annotation. Find out during implementation; not a blocker.

---

## Reviewer findings — resolved

A pre-implementation sub-agent review surfaced concrete issues. Resolutions:

1. **`emitEvent` signature mismatch with the proposed repo.**
   Current `emitEvent(pool, { orgId, resourceType, resourceId, kind, actor, payload })` takes `pool` + an args object that already includes `orgId`. The proposed `events` repo takes `ctx` and derives orgId.
   **Resolution:** Two-step migration. First, replace the events repo with a NEW method `db.events(ctx).emit({resourceType, resourceId, kind, payload})` that takes only kind-specific args (orgId + actor come from ctx). Then update every `emitEvent(pool, ...)` callsite to `db.events(ctx).emit(...)`. The legacy `emitEvent` function gets deleted; no compat shim. Catch every callsite in one commit during Task 4 Step 3.

2. **Error model contradiction (repos throw HttpError vs HTTP semantics stay in handlers).**
   **Resolution:** Repos throw typed domain errors (`DuplicateError`, `ForbiddenError`); handlers catch and map to HttpError. See updated "Error model" section above.

3. **`softDelete` deleter attribution differs between app-side and trigger-side.**
   Trigger-based cascade uses `deleted_by_type = 'system'` (DB-side; not changeable from app). App-side `softDelete` writes the calling principal.
   **Resolution:** Document the asymmetry explicitly. Direct soft-delete of a parent table writes the principal as deleter; cascade-soft-deleted children get `'system'`. This matches existing behavior (the triggers already do this). Per-repo tests assert both paths.

4. **`apiKeysRepo` missing rotate-key method.**
   **Resolution:** Add `mintAndExpireExisting(args, oldKeyId, expiresAt)` to the api-keys repo. The agent/connector route's rotate handler calls this single repo method instead of orchestrating two operations.

5. **`events.list()` API hand-waving.**
   Spec implied a `list(filter)` method but events are deferred to v1.1. Plan didn't say what to build now.
   **Resolution:** v1 events repo exposes ONLY `emit(...)` — no `list`. When the `/v1/events` route ships in v1.1, add `list(filter)` then.

6. **ESLint rule must cover `masterClient(env)` in routes, not just `ctx.pool`.**
   **Resolution:** Rule flags any of:
   - `ctx.pool.{select|insert|update|delete}`
   - `masterClient(...).{select|insert|update|delete}` (regardless of arg shape)
   - `c.env.DB`, `c.env.MASTER_DB`, `c.env.POOL_*` (direct binding access)
   `// repo-escape: <reason>` comment exempts the next line. Health check exempted via path-level allowlist.

7. **`test/helpers/orgs.ts` needs `OrgId` ripple in Task 10.**
   **Resolution:** Add to Task 10's file list. `createOrgFixture` returns `{userId: string, orgId: OrgId, pat: string}`; tests using the orgId in repo calls get the brand automatically.

8. **`system` namespace `purgeOlderThan` signature inconsistency.**
   **Resolution:** Take `(binding, cutoff)` — binding is mandatory (single-pool today, multi-pool when sharded). Drop `env` arg; binding is the only thing actually needed. Same for `idempotencyKeys.purgeExpired`.

9. **`users` repo `findById` JOIN through `member`.**
   **Resolution:** Repo's `findById(userId)` does:
   ```ts
   select user.* from user
   inner join member on member.user_id = user.id
   where member.organization_id = ctx.orgId AND user.id = userId
   limit 1
   ```
   Documented in the repo file.

10. **Per-repo unit tests will add 30-60s to CI.**
    **Resolution:** Acknowledged. Acceptable for the safety win; revisit if it becomes a productivity drag.

11. **`activeRows` in `_base.ts` duplicates `active` in `helpers.ts`.**
    **Resolution:** Drop `activeRows`; repos import `active` directly from `helpers.ts`.
