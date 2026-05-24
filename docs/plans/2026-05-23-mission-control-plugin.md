# Hermes ↔ MissionControl Plugin Implementation Plan (rev 4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the events-driven `mission-control` Hermes plugin (and the small MC bits it depends on).

**Architecture:** One daemon thread inside the gateway runs two asyncio loops: a **pull loop** that subscribes to MC's `GET /v1/events` and dispatches each event via `apply.py`, and a **push reactor** that tails local kanban `task_events` on a dedicated board (`HERMES_MC_BOARD`, default `mc`) and PATCHes/POSTs back to MC. A plugin-owned `links.db` (separate SQLite) tracks MC↔local mappings + an `mc_apply_log` anti-feedback table + cursors.

**Tech Stack:** Python 3.11+, httpx, pytest, respx, sqlite3 (WAL), Hermes plugin loader.

**Spec:** `docs/specs/2026-05-23-mission-control-plugin-design.md` (rev 4).

**Companion:** `docs/plans/2026-05-23-mission-control-plugin-part2.md` (Tasks 4-23 in TDD detail — most of those task bodies still apply unchanged; deltas called out below).

---

## What's already done

- **Task 1** (commit `add8ecb`): MC spec connector annotation corrected from v1.1 to v1.
- **MC spec changes** (commit `841f6e8`): `GET /v1/events` promoted to v1; idempotency-key regex added; deferred-features table updated.
- **Plugin spec rev 4** (commit `b801cd1`): events-driven architecture.

## File map

### MC side (Phase 0)

| File | Purpose |
|---|---|
| `services/mission-control/src/db/repos/events.ts` (modify) | Add `list({since, kinds?, limit, cursor?})` method to the events repo |
| `services/mission-control/src/routes/events.ts` (new) | `GET /v1/events` route handler |
| `services/mission-control/src/index.ts` (modify) | Mount the events router |
| `services/mission-control/src/routes/tasks.ts` (modify) | Add idempotency-key regex validation to the POST body schema |
| `services/mission-control/src/routes/external-refs.ts` (modify) | Same regex validation if external-refs accept idempotency keys |
| `services/mission-control/test/routes/events.test.ts` (new) | Route tests |
| `services/mission-control/test/routes/tasks.test.ts` (modify) | Add tests for regex rejection |

### Hermes plugin (Phases 1-10)

| File | Purpose |
|---|---|
| `services/hermes/plugins/mission-control/plugin.yaml` | Manifest |
| `.../mission-control/__init__.py` | `register(ctx)` entry |
| `.../mission-control/config.py` | Env + auth.json with mtime cache |
| `.../mission-control/client.py` | MC HTTP client (events_list, tasks_*, comments_*, external_refs, agents/connectors, projects) |
| `.../mission-control/registrar.py` | PAT → keys + cursor init + project cache |
| `.../mission-control/links_db.py` | Plugin-owned SQLite schema + helpers |
| `.../mission-control/status_map.py` | Pure mapping (local↔MC + kanban event-kind→MC PATCH) |
| `.../mission-control/apply.py` | MC event-kind dispatch (writes to kanban via helpers + mc_apply_log capture) |
| `.../mission-control/pull.py` | Events-poll loop |
| `.../mission-control/push.py` | Kanban task_events reactor |
| `.../mission-control/runtime.py` | Daemon thread + lifecycle |
| `.../mission-control/tools.py` | `mc_promote_task` |
| `.../mission-control/cli.py` | `hermes mc` subcommands |
| `.../mission-control/dashboard/{manifest.json,plugin_api.py}` | Status endpoint (no React UI in v1) |
| `.../mission-control/README.md` | Operator docs |
| `.../mission-control/pyproject.toml` | Dev deps |
| `.../mission-control/tests/conftest.py` | sys.path bridge + env scrub |
| `.../mission-control/tests/test_*.py` | Per-module unit tests |
| `.../mission-control/tests/integration/test_end_to_end.py` | Marker-gated wrangler-dev e2e |
| `services/hermes/build.sh` (modify) | `hermes_sync_plugin` + `hermes_enable_plugin` helpers + MC lever section |
| `services/hermes/build.test.sh` (modify) | New cases for MC managed-block injection |
| `services/hermes/README.md` (modify) | Document the lever |

---

## Phase 0 — MC prerequisites

### Task 2: MC `GET /v1/events` endpoint

**Files:**
- Modify: `services/mission-control/src/db/repos/events.ts`
- Create: `services/mission-control/src/routes/events.ts`
- Modify: `services/mission-control/src/index.ts`
- Create: `services/mission-control/test/routes/events.test.ts`

- [ ] **Step 1: Read the existing events repo + a sibling route for shape**

```bash
cat services/mission-control/src/db/repos/events.ts
sed -n '1,80p' services/mission-control/src/routes/projects.ts
grep -n "app\.route\|router" services/mission-control/src/index.ts | head -10
```

Confirm: `eventsRepo(ctx)` has only `emit()` + `table` today; sibling routes use `requireAnyRole`, query parsing via Zod, `db.X(ctx).list(...)`, `serializeTimestamps`; `index.ts` mounts via `app.route('/v1/X', xRouter)`.

- [ ] **Step 2: Write the failing route test**

Create `services/mission-control/test/routes/events.test.ts`:

```ts
/**
 * Integration tests for GET /v1/events.
 * Coverage: envelope shape, since (exclusive), kinds filter, agent role
 * 403, owner allowed, cross-org isolation.
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';
import { createOrgFixture } from '../helpers/orgs.ts';

const ADMIN_TOKEN = 'events-route-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let pat = '', orgId = '', projectId = '', agentKey = '';

beforeAll(async () => {
  await applyD1Migrations(env.DB as D1Database, inject('d1Migrations') as D1Migration[]);

  const fix = await createOrgFixture(env.DB as D1Database, 'Events Test', 'events-test');
  pat = fix.pat; orgId = fix.orgId;

  const p = await app.fetch(new Request('http://x/v1/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'P', slug: 'events-p' }),
  }), TEST_ENV);
  projectId = (await p.json() as { project: { id: string } }).project.id;

  const a = await app.fetch(new Request('http://x/v1/agents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'a1', kind: 'hermes' }),
  }), TEST_ENV);
  agentKey = (await a.json() as { key: string }).key;

  await app.fetch(new Request('http://x/v1/tasks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, title: 't' }),
  }), TEST_ENV);
});

describe('GET /v1/events', () => {
  it('returns {events, next_cursor} envelope with rows after setup', async () => {
    const res = await app.fetch(new Request('http://x/v1/events?since=0&limit=100', {
      headers: { Authorization: `Bearer ${pat}` },
    }), TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { events: any[]; next_cursor: string | null };
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    expect('next_cursor' in body).toBe(true);
    expect(body.events[0]).toHaveProperty('id');
    expect(body.events[0]).toHaveProperty('resource_type');
    expect(body.events[0]).toHaveProperty('kind');
  });

  it('respects since as exclusive lower bound', async () => {
    const all = await (await app.fetch(new Request('http://x/v1/events?since=0&limit=100', {
      headers: { Authorization: `Bearer ${pat}` },
    }), TEST_ENV)).json() as { events: any[] };
    const mid = all.events[Math.floor(all.events.length / 2)].id;
    const after = await (await app.fetch(new Request(`http://x/v1/events?since=${mid}&limit=100`, {
      headers: { Authorization: `Bearer ${pat}` },
    }), TEST_ENV)).json() as { events: any[] };
    expect(after.events.every((e: any) => e.id > mid)).toBe(true);
  });

  it('filters by kinds (resource_type)', async () => {
    const tasksOnly = await (await app.fetch(new Request('http://x/v1/events?since=0&kinds=task&limit=100', {
      headers: { Authorization: `Bearer ${pat}` },
    }), TEST_ENV)).json() as { events: any[] };
    expect(tasksOnly.events.every((e: any) => e.resource_type === 'task')).toBe(true);
    expect(tasksOnly.events.length).toBeGreaterThan(0);
  });

  it('rejects agent role with 403', async () => {
    const res = await app.fetch(new Request('http://x/v1/events?since=0&limit=10', {
      headers: { Authorization: `Bearer ${agentKey}` },
    }), TEST_ENV);
    expect(res.status).toBe(403);
  });

  it('isolation: org B sees only its own events', async () => {
    const orgB = await createOrgFixture(env.DB as D1Database, 'Org B', 'org-b');
    const res = await app.fetch(new Request('http://x/v1/events?since=0&limit=100', {
      headers: { Authorization: `Bearer ${orgB.pat}` },
    }), TEST_ENV);
    const body = await res.json() as { events: any[] };
    expect(body.events.length).toBe(0);  // Org B has no activity yet.
  });
});
```

- [ ] **Step 3: Run — verify failures**

```bash
cd services/mission-control && pnpm test -- test/routes/events.test.ts
```

Expected: 404s / route-not-found.

- [ ] **Step 4: Extend the events repo with `list`**

In `services/mission-control/src/db/repos/events.ts`, after `emit()`, add:

```ts
    /**
     * List events for this org with id > since, optionally filtered by
     * resource_type. Returns up to `limit` rows ordered by id ASC.
     * events.id is monotonic per pool DB; v1 has one pool so a single
     * integer `since` cursor suffices. `cursor` (opaque, currently the
     * Number-as-string of the last seen id) is used for within-window
     * paging when a single since-window has more than `limit` events.
     */
    async list(args: {
      since: number;
      kinds?: string[];
      limit: number;
      cursor?: string | null;
    }): Promise<{ rows: any[]; nextCursorId: number | null }> {
      const lower = args.cursor ? Number(args.cursor) : args.since;
      const conditions = [
        eq(events.orgId, ctx.orgId),
        gt(events.id, lower),
      ];
      if (args.kinds && args.kinds.length > 0) {
        conditions.push(inArray(events.resourceType, args.kinds));
      }
      const rows = await ctx.pool
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(asc(events.id))
        .limit(args.limit + 1);
      const hasMore = rows.length > args.limit;
      const trimmed = hasMore ? rows.slice(0, args.limit) : rows;
      const nextCursorId = hasMore ? (trimmed[trimmed.length - 1] as any).id : null;
      return { rows: trimmed, nextCursorId };
    },
```

Add the missing imports at the top of the file: `import { and, asc, eq, gt, inArray } from 'drizzle-orm';` (extend the existing imports — don't duplicate).

- [ ] **Step 5: Create the route handler**

Create `services/mission-control/src/routes/events.ts`:

```ts
/**
 * GET /v1/events — change log read API.
 *
 * Role: owner | admin | member | connector (NOT agent — events carry
 * resource data across the whole org; per-row visibility would require
 * joining events to underlying resources on every read; connector role's
 * whole-org read is the right consumer surface).
 *
 * Query:
 *   since   integer event id, exclusive lower bound (default 0)
 *   kinds   comma-separated resource_type (default all)
 *   limit   1-200 (default 100)
 *   cursor  opaque; when present overrides `since` for within-window paging
 *
 * Response: { events: [...], next_cursor: <opaque>|null }
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/repos/index.ts';
import { requireAnyRole } from '../auth/middleware.ts';
import { errorResponse } from '../errors.ts';
import { serializeTimestamps } from '../db/helpers.ts';
import type { AppEnv } from '../types.ts';

const eventsRouter = new Hono<AppEnv>();

const VALID_KINDS = ['task', 'project', 'agent', 'connector', 'comment', 'external_ref'] as const;

const querySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  kinds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
});

eventsRouter.get(
  '/',
  requireAnyRole('owner', 'admin', 'member', 'connector'),
  async (c) => {
    try {
      const ctx = c.get('auth');
      const parsed = querySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
      if (!parsed.success) {
        return c.json({ error: { code: 'request.invalid', message: parsed.error.message } }, 400);
      }
      const { since, kinds, limit, cursor } = parsed.data;

      let kindsList: string[] | undefined;
      if (kinds) {
        kindsList = kinds.split(',').map(s => s.trim()).filter(Boolean);
        for (const k of kindsList) {
          if (!(VALID_KINDS as readonly string[]).includes(k)) {
            return c.json({
              error: {
                code: 'request.invalid',
                message: `invalid kind '${k}'; valid: ${VALID_KINDS.join(',')}`,
              },
            }, 400);
          }
        }
      }

      const { rows, nextCursorId } = await db.events(ctx).list({
        since, kinds: kindsList, limit, cursor: cursor ?? null,
      });

      return c.json({
        events: rows.map(serializeTimestamps),
        next_cursor: nextCursorId !== null ? String(nextCursorId) : null,
      });
    } catch (e) {
      return errorResponse(c, e);
    }
  },
);

export default eventsRouter;
```

Verify the imports match real names: `requireAnyRole` is at `src/auth/middleware.ts`; `errorResponse` at `src/errors.ts`; `serializeTimestamps` at `src/db/helpers.ts`; `AppEnv` is whatever the existing routes import as their Hono env type. Adapt by reading one existing route (e.g. `projects.ts`).

- [ ] **Step 6: Mount the router**

Edit `services/mission-control/src/index.ts`. Find existing route mounts (`app.route('/v1/X', xRouter)`) and add:

```ts
import eventsRouter from './routes/events.ts';
// ...
app.route('/v1/events', eventsRouter);
```

- [ ] **Step 7: Run — verify pass**

```bash
cd services/mission-control && pnpm test -- test/routes/events.test.ts
```

Expected: 5/5 pass.

- [ ] **Step 8: Run the full MC suite**

```bash
cd services/mission-control && pnpm test
```

Expected: existing suite + new tests, all green.

- [ ] **Step 9: Commit**

```bash
git add services/mission-control/src/db/repos/events.ts \
        services/mission-control/src/routes/events.ts \
        services/mission-control/src/index.ts \
        services/mission-control/test/routes/events.test.ts
git commit -m "feat(mc): GET /v1/events change-log read endpoint

First consumer is the Hermes mission-control plugin. Endpoint promoted
from v1.1 to v1 per the spec change in 841f6e8.

- Adds eventsRepo.list({since, kinds?, limit, cursor?}) — single-pool
  integer cursor (events.id monotonic per pool).
- Adds GET /v1/events route — accepts since/kinds/limit/cursor; returns
  {events, next_cursor}. Rejects agent role with 403.
- Tests cover envelope, since semantics, kinds filter, role rejection,
  cross-org isolation."
```

---

### Task 3: Idempotency-key regex validation

**Files:**
- Modify: `services/mission-control/src/routes/tasks.ts` (the `idempotency_key` Zod schema)
- Modify: `services/mission-control/src/routes/external-refs.ts` (if it accepts `idempotency_key` in body)
- Test: extend `services/mission-control/test/routes/tasks.test.ts`

- [ ] **Step 1: Find current validation**

```bash
grep -n "idempotency_key" services/mission-control/src/routes/tasks.ts services/mission-control/src/routes/external-refs.ts
```

Current: `idempotency_key: z.string().max(200).optional()` (no regex).

- [ ] **Step 2: Write failing tests**

Append to `test/routes/tasks.test.ts`:

```ts
describe('POST /v1/tasks — idempotency_key regex validation', () => {
  it.each([
    ['no-prefix-no-colon', 400],
    [':no-source-prefix', 400],
    ['UpperCaseSource:bad', 400],
    ['hermes:t_valid_id_123', 201],
    ['notion:ws_abc:page_xyz:v3', 201],
    ['mc:t_xyz', 201],
  ])('idempotency_key %s → %d', async (key, expectedStatus) => {
    const res = await app.fetch(new Request('http://x/v1/tasks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, title: `regex test ${key}`, idempotency_key: key }),
    }), TEST_ENV);
    expect(res.status).toBe(expectedStatus);
  });
});
```

- [ ] **Step 3: Run — verify failures**

Invalid-key cases will return 201 because regex isn't enforced yet.

- [ ] **Step 4: Add the regex**

In `src/routes/tasks.ts`:

```ts
const IDEMPOTENCY_KEY_RE = /^[a-z][a-z0-9_-]{0,31}:.{1,200}$/;

// In the body schema, replace:
idempotency_key: z.string().regex(IDEMPOTENCY_KEY_RE, {
  message: "idempotency_key must match <source_prefix>:<payload> where source_prefix is 1-32 lowercase chars (a-z, 0-9, _, -) starting with a letter",
}).optional(),
```

Same in `external-refs.ts` if applicable.

- [ ] **Step 5: Run — verify pass**

All 6 cases pass.

- [ ] **Step 6: Run full MC suite**

If any pre-existing test passes an invalid key (e.g. `"simple-string"`), update it to the prefix format.

- [ ] **Step 7: Commit**

```bash
git add services/mission-control/src/routes/tasks.ts \
        services/mission-control/src/routes/external-refs.ts \
        services/mission-control/test/routes/tasks.test.ts
git commit -m "feat(mc): idempotency_key format validation

Regex ^[a-z][a-z0-9_-]{0,31}:.{1,200}$ — catches the common footgun
of passing a raw external id without source-kind prefix. Returns
400 on mismatch."
```

---

## Phases 1-10 — see part 2

Tasks 4-23 follow the patterns documented in `docs/plans/2026-05-23-mission-control-plugin-part2.md` with the following **deltas vs. that file**:

### Δ vs part-2 Task 7 (`links_db.py`)
- Drop the `last_comment_cursor` column from `mc_links`.
- Replace `mc_pull_cursor` table with `mc_cursors` table (keys: `events`, `kanban_events`).
- Drop the `set_link_comment_cursor` helper.
- Rename `get_pull_cursor` / `set_pull_cursor` → `get_cursor` / `set_cursor`.
- Tests for cursor roundtrip use the new key names.

### Δ vs part-2 Task 9 (`client.py`)
- Add `async events_list(connector_key, since, kinds=None, limit=100, cursor=None) -> dict` returning `{"events": [...], "next_cursor": str|None}`.
- `task_comments_list` no longer used by the hot path (keep the method for one-shot reads via promote/admin paths, but its tests can be lighter).
- New respx tests for `events_list`: success, since/kinds/cursor passthrough, 401 (AuthFailed), 403 (AuthFailed for agent key).

### Δ vs part-2 Task 10 (`apply.py`)
The summary-style behavior in part-2 Task 10 is replaced by the event-kind dispatch from spec rev 4 §"Local kanban ↔ MC data model → Status mapping" event table. One entry point `async def handle_one_event(ev, env, auth, client)` dispatches on `ev['kind']`. The `_apply_with_log` helper (pre/post-MAX range capture) is unchanged in pattern.

Per-kind handlers:
- `task.created`: if `ev.payload.task.agent_id == auth.agent_id` and no link → create local task + link + external_ref.
- `task.assigned`: if `ev.payload.to == auth.agent_id` and no link → `client.tasks_get(...)` then create-flow.
- `task.status_changed`: if link → status_map.mc_to_local() → appropriate kanban_db helper → record apply.
- `task.deleted`: if link → archive_task + last_terminal_state.
- `comment.created`: if link AND not already in mc_comment_links → add_comment + insert_comment_link + (if blocked) auto-unblock.
- Other kinds: log DEBUG + skip.

Tests: one happy-path test per kind + the same dedup/auto-unblock tests as part-2.

### Δ vs part-2 Task 11 (`pull.py`)
Replace the "two-phase tasks-then-comments" pull from part-2 with the single-loop events pull from spec rev 4 §"Pull loop". One cursor (`'events'`), one endpoint (`client.events_list`), one dispatch (`apply.handle_one_event`). Drain within-window pagination via `next_cursor`; advance `since` for subsequent poll cycles. Purge mc_apply_log >24h on idle.

Tests: cursor advance, kind dispatch, AuthFailed propagation, 5xx backoff, drain-window-then-advance.

### Δ vs part-2 Task 14 (`registrar.py`)
Add a final step: `client.events_list(connector_key, since=0, limit=1)` to get current head id; `links_db.set_cursor(ldb, 'events', head_id)`. Empty stream → cursor stays 0.

Test: cursor initialization happy path + empty-stream path.

### Δ vs part-2 Task 16 (`cli.py`)
- `hermes mc status` includes `events_cursor` field.
- `hermes mc test` calls `client.events_list(connector_key, since=0, limit=1)` (not `tasks_list`).

### Δ vs part-2 Task 18 (`dashboard/plugin_api.py`)
Response shape includes `events_cursor: int` (the MC-side cursor). Remove `last_comment_cursor` references.

### Δ vs part-2 Tasks 19-20 (`build.sh`)
Env var list in the managed block omits `bootstrap_since` and `conflict_slop_ms` (no longer needed in the events architecture). Include only `HERMES_MC_URL`, `HERMES_MC_AGENT_NAME`, `HERMES_MC_BOARD`, `HERMES_MC_POLL_INTERVAL`, `HERMES_MC_DEFAULT_PROJECT_SLUG`, `HERMES_MC_DEBUG`, plus `HERMES_MC_USER_PAT` conditionally.

### Δ vs part-2 Task 23 (integration tests)
Scenarios re-stated against the events stream:
1. Operator POSTs task → events delivers `task.created` → local row appears.
2. Local dispatcher `ready → running` → MC PATCH lands; next pull no-ops (echo via mc_apply_log).
3. Operator POSTs comment → events delivers `comment.created` → kanban comment appears.
4. Operator POSTs comment on `blocked` task → local auto-unblocks.
5. Agent (worker) calls `mc_promote_task` → MC POST → link inserted.
6. MC `cancelled` → events delivers `task.deleted` (or `task.status_changed` to `cancelled`) → local archived.
7. Worker `kanban_comment` → push reactor mirrors to MC → next pull no-ops (dedup).

All other part-2 task bodies (Tasks 4-6, 8, 12-13, 15, 17, 21-22) apply unchanged.

---

## Phase 11 — Wrap-up

After Task 23:

1. Run plugin unit suite + MC suite + hermes-side build test; all green.
2. Move spec + plan(s) into `docs/plans/implemented/`.
3. Open PR `feat/mc-plugin` → `main`.

---

## Self-review checklist

- [ ] Every spec rev-4 requirement has a task.
- [ ] No TODO/FIXME in shipped code.
- [ ] All idempotency keys match MC's regex (`^[a-z][a-z0-9_-]{0,31}:.{1,200}$`).
- [ ] All MC writes use agent key OR connector key per spec table.
- [ ] All kanban writes use `board=env.board` kwarg.
- [ ] All MC→local kanban writes go through `_apply_with_log`.
- [ ] No direct `os.environ` reads outside `config.py`.
- [ ] No direct `httpx` calls outside `client.py`.
- [ ] No direct `sqlite3` outside `links_db.py` (+ test fixtures).
- [ ] `register(ctx)` is a no-op when `HERMES_MC_URL` is unset.
- [ ] All pulled comments authored with `mission-control:` prefix.
- [ ] `mc_apply_log` is fed by every `_apply_with_log` call.
- [ ] Plugin unit suite runs in <30s on a laptop.
