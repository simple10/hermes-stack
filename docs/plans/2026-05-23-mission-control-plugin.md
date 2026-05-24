# Hermes ↔ MissionControl Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the stack-side `mission-control` Hermes plugin so a Hermes VM bidirectionally syncs tasks/comments with a MissionControl deployment.

**Architecture:** One daemon thread inside the gateway runs two asyncio loops (pull + push reactor) against the MC HTTP API. Pulled tasks land in a dedicated kanban board (`HERMES_MC_BOARD`, default `mc`); a separate `links.db` SQLite tracks MC↔local mappings and an `mc_apply_log` anti-feedback table. Stack-side `build.sh` wires env vars and syncs the plugin into the OrbStack VM.

**Tech Stack:** Python 3.11+, httpx, pytest, respx, sqlite3 (WAL), Hermes plugin loader (`PluginContext`).

**Spec:** `docs/specs/2026-05-23-mission-control-plugin-design.md` (rev 3).

---

## File map

| File | Purpose |
|---|---|
| `services/mission-control/docs/specs/2026-05-22-master-api-design.md` (modify) | Two-line fix: connector v1 annotation; `next_cursor` always-returned semantics |
| `services/mission-control/src/db/helpers.ts` (modify) | Cursor builder returns a tip-cursor on empty/final page |
| `services/mission-control/src/routes/*` (modify, ~5 files) | Use the tip-cursor helper for every paginated response |
| `services/mission-control/test/db/repos/_cursor.ts` (new) | Tip-cursor unit test added to the consolidated repo-tests file |
| `services/hermes/_source/hermes_cli/kanban_db.py` (modify) | Add `list_events_since(conn, last_id, limit)` helper |
| `services/hermes/plugins/mission-control/plugin.yaml` (new) | Manifest |
| `services/hermes/plugins/mission-control/__init__.py` (new) | `register(ctx)` entry; gateway detection; loop startup |
| `services/hermes/plugins/mission-control/config.py` (new) | Env loading; `~/.hermes/auth.json` read+cache |
| `services/hermes/plugins/mission-control/client.py` (new) | httpx wrapper for MC API |
| `services/hermes/plugins/mission-control/registrar.py` (new) | PAT → agent + connector keys; project cache |
| `services/hermes/plugins/mission-control/links_db.py` (new) | `links.db` schema + helpers |
| `services/hermes/plugins/mission-control/status_map.py` (new) | local↔MC status mapping (pure functions) |
| `services/hermes/plugins/mission-control/apply.py` (new) | MC→local writes via kanban_db; mc_apply_log capture |
| `services/hermes/plugins/mission-control/pull.py` (new) | Pull loop |
| `services/hermes/plugins/mission-control/push.py` (new) | Push reactor |
| `services/hermes/plugins/mission-control/runtime.py` (new) | Daemon thread that owns asyncio loop |
| `services/hermes/plugins/mission-control/tools.py` (new) | `mc_promote_task` tool |
| `services/hermes/plugins/mission-control/cli.py` (new) | `hermes mc <subcommand>` |
| `services/hermes/plugins/mission-control/dashboard/manifest.json` (new) | Widget manifest |
| `services/hermes/plugins/mission-control/dashboard/plugin_api.py` (new) | `GET /api/plugins/mission-control/status` |
| `services/hermes/plugins/mission-control/README.md` (new) | Operator docs |
| `services/hermes/plugins/mission-control/pyproject.toml` (new) | Dev deps + pytest config |
| `services/hermes/plugins/mission-control/tests/conftest.py` (new) | sys.path bridge to `_source/`; env scrub |
| `services/hermes/plugins/mission-control/tests/test_*.py` (10 files, new) | Per-module unit tests |
| `services/hermes/plugins/mission-control/tests/integration/test_end_to_end.py` (new, marker-gated) | wrangler-dev e2e |
| `services/hermes/build.sh` (modify) | Add `hermes_sync_plugin`, `hermes_enable_plugin` helpers + MC lever section |
| `services/hermes/build.test.sh` (modify) | New test cases for MC managed-block injection |
| `services/hermes/README.md` (modify) | Document the lever |

---

## Phase 0 — Prerequisites

### Task 1: MC spec — fix connector v1 annotation

**Files:**
- Modify: `services/mission-control/docs/specs/2026-05-22-master-api-design.md`

- [ ] **Step 1: Read the contradicting lines**

Open the file. Find the principal-type table (around line 155). It includes a row tagging connectors as "(v1.1)". Also find the v1 routes section (around line 626) which lists `POST /v1/connectors — register a connector (owner|admin)` as a v1 route.

- [ ] **Step 2: Edit the principal-type table**

Replace the parenthetical "(v1.1)" annotation on the connector row with no version annotation (connectors are v1).

- [ ] **Step 3: Commit**

```bash
git add services/mission-control/docs/specs/2026-05-22-master-api-design.md
git commit -m "docs(mc spec): clarify connectors are v1 (not v1.1)

The principal-type table tagged connectors with (v1.1) but the v1
routes section lists POST /v1/connectors as a v1 route. The Hermes
MC plugin spec (rev 3) depends on connector minting being v1 for its
PAT-driven registration flow."
```

---

### Task 2: MC implementation — `{data, next_cursor}` envelope + always-return tip cursor

**Background.** The MC spec consistently shows list responses as `{ "data": [...], "next_cursor": "..." }` (see spec lines 694, 825). The current MC implementation diverged: every route returns its resource name as the key (`{tasks, next_cursor}`, `{projects, next_cursor}`, `{comments, next_cursor}`, etc.) and emits `next_cursor: null` on the last page. The plugin's pull loop (and the entire plan that follows) assumes the spec — `{data, next_cursor}` with a tip cursor on the last page. This task brings the MC implementation back into line with its own spec.

**Files (verified against the real tree — note hyphenated paths):**
- Modify: `services/mission-control/src/pagination.ts` — add `paginated()` async helper (`encodeCursor` is async and takes `(payload, secret)`)
- Modify: `services/mission-control/src/routes/tasks.ts` (around line 320-352 — replaces the `let nextCursor: string | null = null; if (hasMore) ...` block + the `{tasks: ..., next_cursor: nextCursor}` envelope)
- Modify: `services/mission-control/src/routes/projects.ts`
- Modify: `services/mission-control/src/routes/agents.ts`
- Modify: `services/mission-control/src/routes/connectors.ts`
- Modify: `services/mission-control/src/routes/comments.ts`
- Modify: `services/mission-control/src/routes/external-refs.ts` (hyphenated)
- Modify: every existing test under `services/mission-control/test/routes/` and `test/isolation.test.ts` that asserts on `response.tasks` / `response.projects` / `response.comments` / etc. (find with: `grep -nR "body\.\(tasks\|projects\|comments\|agents\|connectors\|external_refs\)" services/mission-control/test/`)
- Modify: `services/mission-control/docs/specs/2026-05-22-master-api-design.md` pagination section (the spec already documents `{data, ...}` correctly — just update the "`null` next_cursor" sentence)
- Test: `services/mission-control/test/routes/pagination-envelope.test.ts` (new) — uses the existing route-test pattern (`import app from '../../src/index.ts'` + `app.fetch(req, TEST_ENV)`). NOT to be confused with the existing `test/pagination.test.ts` which tests the cursor primitives.

- [ ] **Step 1: Confirm shape of the existing code**

```bash
grep -n "encodeCursor\|next_cursor" services/mission-control/src/pagination.ts
sed -n '320,355p' services/mission-control/src/routes/tasks.ts
head -30 services/mission-control/test/routes/tasks.test.ts
```

Confirm (already verified in prior review):
- `encodeCursor` is `async (payload, secret) => Promise<string>`.
- Each route does: `let nextCursor: string | null = null; if (hasMore) nextCursor = await encodeCursor({updatedAt, id, orgId}, secret); return c.json({tasks: rows..., next_cursor: nextCursor})`.
- Test pattern: `import app from '../../src/index.ts'`, `import { createOrgFixture, createMemberFixture } from '../helpers/orgs.ts'`, `const TEST_ENV = { ...env, MC_ADMIN_TOKEN: '...' }`, then `app.fetch(new Request(url, init), TEST_ENV)`.

- [ ] **Step 2: Write the failing test (new file)**

Create `services/mission-control/test/routes/pagination-envelope.test.ts`:

```ts
/**
 * Verifies the {data, next_cursor} envelope and tip-cursor behavior the
 * Hermes MC plugin's pull loop depends on.
 *
 * Distinct from test/pagination.test.ts (which tests cursor primitives).
 */
import { describe, it, expect, beforeAll, inject } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import app from '../../src/index.ts';
import { createOrgFixture } from '../helpers/orgs.ts';

const ADMIN_TOKEN = 'pagination-envelope-test-token';
const TEST_ENV = { ...env, MC_ADMIN_TOKEN: ADMIN_TOKEN } as any;

let pat = '';
let orgId = '';
let projectId = '';

beforeAll(async () => {
  await applyD1Migrations(env.DB as D1Database, inject('d1Migrations') as D1Migration[]);

  const fix = await createOrgFixture(env.DB as D1Database, 'Envelope Test Org', 'env-test');
  pat = fix.pat;
  orgId = fix.orgId;

  // Create one project to use across tests.
  const r = await app.fetch(new Request('http://x/v1/projects', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'P', slug: 'p-env-test' }),
  }), TEST_ENV);
  const body = await r.json() as { project: { id: string } };
  projectId = body.project.id;

  // And one task so list endpoints have content.
  await app.fetch(new Request('http://x/v1/tasks', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, title: 't' }),
  }), TEST_ENV);
});

describe('pagination envelope + tip cursor', () => {
  it('GET /v1/tasks returns {data, next_cursor} with non-null cursor even on the last page', async () => {
    const res = await app.fetch(new Request('http://x/v1/tasks?limit=100', {
      headers: { 'Authorization': `Bearer ${pat}` },
    }), TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; next_cursor: string | null };
    expect(body).toHaveProperty('data');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.next_cursor).not.toBeNull();
    expect(body.next_cursor).not.toBe('');
    expect((body as any).tasks).toBeUndefined();  // envelope normalized away
  });

  it('reusing the tip cursor returns empty data with a still-valid cursor', async () => {
    const page1res = await app.fetch(new Request('http://x/v1/tasks?limit=100', {
      headers: { 'Authorization': `Bearer ${pat}` },
    }), TEST_ENV);
    const page1 = await page1res.json() as any;

    const page2res = await app.fetch(new Request(
      `http://x/v1/tasks?limit=100&cursor=${encodeURIComponent(page1.next_cursor)}`,
      { headers: { 'Authorization': `Bearer ${pat}` } },
    ), TEST_ENV);
    const page2 = await page2res.json() as any;
    expect(page2.data.length).toBe(0);
    expect(page2.next_cursor).not.toBeNull();
  });

  it.each([
    '/v1/projects',
    '/v1/agents',
    '/v1/connectors',
  ])('GET %s returns {data, next_cursor} envelope', async (path) => {
    const res = await app.fetch(new Request(`http://x${path}?limit=100`, {
      headers: { 'Authorization': `Bearer ${pat}` },
    }), TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('next_cursor');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.next_cursor).not.toBeNull();
  });

  it('GET /v1/tasks/:id/comments returns {data, next_cursor} with tip cursor even on empty', async () => {
    // Fresh task with zero comments.
    const c = await app.fetch(new Request('http://x/v1/tasks', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, title: 't-no-comments' }),
    }), TEST_ENV);
    const task = await c.json() as { task: { id: string } };

    const res = await app.fetch(new Request(`http://x/v1/tasks/${task.task.id}/comments?limit=100`, {
      headers: { 'Authorization': `Bearer ${pat}` },
    }), TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('data');
    expect(body.data).toEqual([]);
    expect(body.next_cursor).not.toBeNull();
  });
});
```

(If `POST /v1/projects` returns a different shape than `{project: {id}}`, check the route's response and adapt — the shape pattern follows tasks.ts.)

- [ ] **Step 3: Run the new test — verify it fails**

```bash
cd services/mission-control && pnpm test -- test/routes/pagination-envelope.test.ts
```

Expected: all assertions fail — current envelopes use `tasks`/`projects`/`comments`/etc. keys and `next_cursor: null` on last page.

- [ ] **Step 4: Add a shared envelope helper**

Append to `services/mission-control/src/pagination.ts` (next to the existing `encodeCursor` / `decodeCursor`):

```ts
/**
 * Build a paginated response envelope from a list of rows.
 *
 * Rows are the result of `repo.list({ limit, cursor })`. The envelope key
 * is always `data` (per spec). `next_cursor` is always populated — when
 * the rows fit in one page, the cursor is a "tip" pointing at the last
 * row's position, so future polls resume cleanly. When `rows` is empty,
 * returns a zero-position tip cursor so first polls also have something
 * to save.
 *
 * Callers must pre-trim `rows` to `limit` items (do NOT pass `limit + 1`
 * here — this helper just emits whatever you give it).
 */
export async function paginated<T extends { id: string; updatedAt: number }>(
  rows: T[],
  orgId: string,
  secret: string,
): Promise<{ data: T[]; next_cursor: string }> {
  const cursorRow = rows.length > 0
    ? { updatedAt: rows[rows.length - 1]!.updatedAt, id: rows[rows.length - 1]!.id }
    : { updatedAt: 0, id: '' };
  const next_cursor = await encodeCursor(
    { updatedAt: cursorRow.updatedAt, id: cursorRow.id, orgId },
    secret,
  );
  return { data: rows, next_cursor };
}
```

- [ ] **Step 5: Update each list route to use the helper**

Pattern, applied to every list handler in `src/routes/*.ts`. The handler keeps requesting `limit + 1` rows so it can detect "has more", but for `next_cursor` it just calls the helper unconditionally with the trimmed `rows`. The old `let nextCursor: string | null = null; if (hasMore) ...` block goes away.

Before:
```ts
let rows = await db.tasks(ctx).list({ /* ... */ limit: limit + 1, cursor });
const hasMore = rows.length > limit;
if (hasMore) rows = rows.slice(0, limit);

let nextCursor: string | null = null;
if (hasMore) {
  const last = rows[rows.length - 1]!;
  nextCursor = await encodeCursor({ updatedAt: last.updatedAt, id: last.id, orgId: ctx.orgId }, secret);
}
return c.json({ tasks: rows.map(serializeTimestamps), next_cursor: nextCursor });
```

After:
```ts
import { paginated } from '../pagination.ts';
// ...
let rows = await db.tasks(ctx).list({ /* ... */ limit: limit + 1, cursor });
if (rows.length > limit) rows = rows.slice(0, limit);

return c.json(await paginated(rows.map(serializeTimestamps), ctx.orgId, secret));
```

Apply to: `tasks.ts`, `projects.ts`, `agents.ts`, `connectors.ts`, `comments.ts`, `external-refs.ts`. For each file, also re-check that the response envelope key is now uniformly `data` (no `tasks:` / `projects:` / `comments:` / etc.). Note for `routes/comments.ts`: the helper takes `secret` — the same `BETTER_AUTH_SECRET ?? ''` the route already passes to `encodeCursor`.

If `serializeTimestamps` strips the `updatedAt` numeric (replacing it with an ISO string), keep a parallel `rowsForCursor` reference with the numeric value, or split: compute the cursor BEFORE serialization (since the helper reads `rows[last].updatedAt`). Concrete pattern:

```ts
const trimmed = rows.length > limit ? rows.slice(0, limit) : rows;
const envelope = await paginated(trimmed, ctx.orgId, secret);
return c.json({ data: envelope.data.map(serializeTimestamps), next_cursor: envelope.next_cursor });
```

- [ ] **Step 6: Update existing tests that assert on the old envelope keys**

```bash
cd services/mission-control && grep -nE "body\.(tasks|projects|comments|agents|connectors|external_refs)\b" test/ | head -50
```

For each hit where the access is on a parsed-JSON response (e.g. `body.tasks.length`), rename to `body.data.length`. Don't change repo-internal references (`db.tasks(ctx)...`) — those stay. Be careful in `test/isolation.test.ts` and `test/cascade.test.ts` — both touch list endpoints.

- [ ] **Step 7: Update the spec prose**

Edit `services/mission-control/docs/specs/2026-05-22-master-api-design.md` pagination section. Replace "`null` next_cursor means end of results" with: "`next_cursor` is always populated. An empty `data` array means no items past the cursor — callers can re-save the cursor and re-poll later to pick up new items."

(The spec already documents the `{data, ...}` envelope correctly — no change needed there.)

- [ ] **Step 8: Run the full MC suite — verify everything green**

```bash
cd services/mission-control && pnpm test
```

Expected: ~456 + new pagination tests, all green. If any pre-existing test fails because it still references the old envelope key, fix it in this commit.

- [ ] **Step 9: Commit**

```bash
git add services/mission-control/src/pagination.ts \
        services/mission-control/src/routes/ \
        services/mission-control/test/routes/ \
        services/mission-control/test/isolation.test.ts \
        services/mission-control/test/cascade.test.ts \
        services/mission-control/docs/specs/2026-05-22-master-api-design.md
git commit -m "feat(mc): {data, next_cursor} envelope + tip cursor on last page

Brings the implementation back into line with its own spec (which has
documented {data, next_cursor} since rev 1). Two related changes:

- Every list response is wrapped via paginated() helper so the envelope
  key is uniformly 'data' (was: 'tasks'/'projects'/'comments'/etc).
- next_cursor is always populated — on the last page it's a tip cursor
  encoding the last row's position (or position zero if no rows). Lets
  pollers save the cursor unconditionally for resume-from-here semantics.

Required by the upcoming Hermes MC plugin's pull-loop comment paging."
```

---

### Task 3: Upstream Hermes — add `kanban_db.list_events_since` helper

**Files:**
- Modify: `services/hermes/_source/hermes_cli/kanban_db.py` (add one function)
- Test: `services/hermes/_source/tests/test_kanban_db.py` (if file exists; else add to nearest existing kanban test module)

- [ ] **Step 1: Locate the existing event helpers**

```bash
grep -n "def list_events\|def _append_event\|task_events" services/hermes/_source/hermes_cli/kanban_db.py | head -20
```

Confirm there's an existing `list_events(conn, task_id)` (per-task) and no `list_events_since` (global since-cursor).

- [ ] **Step 2: Write the failing test**

Find or create a test file under `services/hermes/_source/tests/` that already imports `hermes_cli.kanban_db`. Append:

```python
def test_list_events_since_orders_by_id_strictly(tmp_path, monkeypatch):
    """list_events_since must order by id ASC, not created_at.

    created_at has 1-second granularity in kanban_db so ties are common
    when many events land in the same second; the cursor caller needs
    a strict total order, hence id-ordering.
    """
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "k.db"))
    from hermes_cli import kanban_db as kb
    conn = kb.connect()
    tid = kb.create_task(conn, title="t1", assignee="x", initial_status="ready")
    # Force 3 events within the same epoch second by patching int(time.time()).
    import time as _t
    fixed = int(_t.time())
    monkeypatch.setattr(_t, "time", lambda: fixed)
    kb.add_comment(conn, tid, "x", "a")
    kb.add_comment(conn, tid, "x", "b")
    kb.add_comment(conn, tid, "x", "c")
    rows = kb.list_events_since(conn, 0, limit=10)
    ids = [r.id for r in rows]
    assert ids == sorted(ids), f"events out of id order: {ids}"
    assert len(rows) >= 3

def test_list_events_since_respects_cursor(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "k.db"))
    from hermes_cli import kanban_db as kb
    conn = kb.connect()
    tid = kb.create_task(conn, title="t1", assignee="x", initial_status="ready")
    kb.add_comment(conn, tid, "x", "a")
    kb.add_comment(conn, tid, "x", "b")
    all_rows = kb.list_events_since(conn, 0, limit=100)
    mid = all_rows[len(all_rows) // 2].id
    after = kb.list_events_since(conn, mid, limit=100)
    assert all(r.id > mid for r in after)

def test_list_events_since_respects_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "k.db"))
    from hermes_cli import kanban_db as kb
    conn = kb.connect()
    tid = kb.create_task(conn, title="t1", assignee="x", initial_status="ready")
    for i in range(20):
        kb.add_comment(conn, tid, "x", f"c{i}")
    rows = kb.list_events_since(conn, 0, limit=5)
    assert len(rows) == 5
```

- [ ] **Step 3: Run — verify failure**

```bash
cd services/hermes/_source && python -m pytest tests/test_kanban_db.py::test_list_events_since_orders_by_id_strictly -v
```

Expected: `AttributeError: module 'hermes_cli.kanban_db' has no attribute 'list_events_since'`.

- [ ] **Step 4: Implement**

In `services/hermes/_source/hermes_cli/kanban_db.py`, near the existing `list_events(conn, task_id)` function, add:

```python
def list_events_since(
    conn: sqlite3.Connection,
    last_id: int,
    limit: int = 100,
) -> list[Event]:
    """Return task_events rows with id > last_id, in strict id-ascending order.

    Ordering is by ``id`` only (not ``created_at``) because ``created_at``
    has 1-second granularity and ties are common when many events land
    within the same second. Cursor callers need a strict total order.

    Used by external consumers (e.g. the mission-control plugin's push
    reactor) that tail the global event stream across all tasks on a
    board. For per-task event reads, prefer :func:`list_events`.
    """
    rows = conn.execute(
        "SELECT * FROM task_events WHERE id > ? ORDER BY id ASC LIMIT ?",
        (last_id, limit),
    ).fetchall()
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"]) if r["payload"] else None
        except Exception:
            payload = None
        out.append(
            Event(
                id=r["id"],
                task_id=r["task_id"],
                kind=r["kind"],
                payload=payload,
                created_at=r["created_at"],
                run_id=(int(r["run_id"]) if "run_id" in r.keys() and r["run_id"] is not None else None),
            )
        )
    return out
```

(Mirrors the existing `list_events` body exactly — same payload try/except, same `Event` field order, same `run_id` defensive cast. Verified at `kanban_db.py:1838-1859`.)

- [ ] **Step 5: Run — verify pass**

```bash
cd services/hermes/_source && python -m pytest tests/test_kanban_db.py -k list_events_since -v
```

Expected: all 3 new tests pass.

- [ ] **Step 6: Commit**

```bash
git add services/hermes/_source/hermes_cli/kanban_db.py services/hermes/_source/tests/test_kanban_db.py
git commit -m "feat(kanban_db): add list_events_since global cursor helper

Strict id-ascending order (not created_at — that has tie risk at
1-second granularity). Required by the mission-control plugin's
push reactor which tails the global task_events stream on a board."
```

---

## Phase 1 — Plugin scaffold

### Task 4: Create plugin skeleton

**Files:**
- Create: `services/hermes/plugins/mission-control/plugin.yaml`
- Create: `services/hermes/plugins/mission-control/__init__.py` (stub)
- Create: `services/hermes/plugins/mission-control/README.md` (placeholder)
- Create: `services/hermes/plugins/mission-control/pyproject.toml`

- [ ] **Step 1: Verify parent dir exists**

```bash
ls services/hermes/plugins/
```

Expected: `agents-observe` is the only existing entry. Confirm parent dir exists.

- [ ] **Step 2: Create plugin.yaml**

```bash
mkdir -p services/hermes/plugins/mission-control
```

Then write `services/hermes/plugins/mission-control/plugin.yaml`:

```yaml
name: mission-control
version: "0.1.0"
description: "Bidirectional sync between this Hermes VM and a MissionControl deployment. Pulls assigned tasks into a dedicated local kanban board, mirrors status + comments back, auto-unblocks tasks when a human comments via MC."
author: hermes-stack
kind: standalone
requires_env:
  - HERMES_MC_URL
provides_tools:
  - mc_promote_task
```

- [ ] **Step 3: Stub `__init__.py`**

Write `services/hermes/plugins/mission-control/__init__.py`:

```python
"""mission-control plugin entry point (stub).

Real implementation lands in later tasks. This stub exists so the
plugin loader recognises the directory and the pytest harness can
import the package.
"""
from __future__ import annotations


def register(ctx) -> None:  # noqa: D401
    """Plugin loader entry. Filled in in Task 20."""
    return None
```

- [ ] **Step 4: Stub README**

Write `services/hermes/plugins/mission-control/README.md`:

```markdown
# mission-control (Hermes plugin)

Bidirectional sync between this Hermes VM and a MissionControl deployment.

See `docs/specs/2026-05-23-mission-control-plugin-design.md` (in the repo
root) for the design. Operator-facing docs land in Task 26.
```

- [ ] **Step 5: pyproject.toml**

Write `services/hermes/plugins/mission-control/pyproject.toml`:

```toml
[project]
name = "hermes-plugin-mission-control"
version = "0.1.0"
description = "Hermes ↔ MissionControl bidirectional sync plugin"
requires-python = ">=3.11"

[project.optional-dependencies]
dev = [
  "pytest>=8.0",
  "pytest-asyncio>=0.23",
  "respx>=0.21",
  "httpx>=0.27",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
markers = [
  "integration: requires a running MC deployment (skipped unless MC_INTEGRATION_TEST_URL set)",
]
```

- [ ] **Step 6: Commit**

```bash
git add services/hermes/plugins/mission-control/
git commit -m "feat(mc plugin): scaffold

plugin.yaml + stub register() + pyproject + placeholder README.
Real wiring lands in later tasks."
```

---

### Task 5: Test harness (conftest + first passing test)

**Files:**
- Create: `services/hermes/plugins/mission-control/tests/__init__.py`
- Create: `services/hermes/plugins/mission-control/tests/conftest.py`
- Create: `services/hermes/plugins/mission-control/tests/test_scaffold.py`

- [ ] **Step 1: Create empty __init__.py**

```bash
mkdir -p services/hermes/plugins/mission-control/tests
touch services/hermes/plugins/mission-control/tests/__init__.py
```

- [ ] **Step 2: conftest.py**

Write `services/hermes/plugins/mission-control/tests/conftest.py`:

```python
"""Test harness for the mission-control plugin.

Two responsibilities:

1. Make ``hermes_cli.*`` / ``gateway.*`` imports work without installing
   them — the plugin imports from the vendored hermes source tree at
   ``services/hermes/_source/``. We prepend that path to ``sys.path``
   at session start.

2. Scrub the ``_HERMES_GATEWAY`` and ``HERMES_KANBAN_TASK`` env markers
   from every test. The former is set at module-import of
   ``gateway.run`` (so any test that imports gateway code would falsely
   look like the gateway). The latter is set by the dispatcher when
   spawning workers.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Plugin lives at <repo>/services/hermes/plugins/mission-control/.
# Vendored hermes source lives at <repo>/services/hermes/_source/.
HERMES_SOURCE = Path(__file__).resolve().parents[2] / "_source"
if str(HERMES_SOURCE) not in sys.path:
    sys.path.insert(0, str(HERMES_SOURCE))

import pytest


@pytest.fixture(autouse=True)
def _scrub_runtime_markers(monkeypatch):
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
```

- [ ] **Step 3: Write a smoke test**

Write `services/hermes/plugins/mission-control/tests/test_scaffold.py`:

```python
"""Smoke test for the test harness — imports work end-to-end."""
from __future__ import annotations


def test_plugin_package_imports():
    import mission_control  # noqa: F401 — the plugin's package name


def test_hermes_source_imports():
    """conftest.py wires sys.path so hermes_cli is importable."""
    from hermes_cli import kanban_db  # noqa: F401


def test_register_is_callable():
    import mission_control as mc
    assert callable(mc.register)
    # Stub returns None; later we'll add real behaviour.
    assert mc.register(ctx=None) is None
```

The package name is `mission_control` (Python identifier — underscore) but the directory is `mission-control` (Hermes convention — hyphen). Hermes' plugin loader handles the rename via its dynamic-module-name registration. For our pytest harness, we need either (a) to teach pytest about the rename, or (b) symlink the directory at test time.

Actually the simplest: use the `mission-control` directory name and add a tiny `tests/conftest.py` step that registers the plugin as `mission_control` via importlib. Update conftest.py to do so:

Append to `conftest.py`:

```python
import importlib.util

PLUGIN_ROOT = Path(__file__).resolve().parents[1]


def _register_plugin_as_package():
    """Make ``import mission_control`` work in tests despite the hyphenated
    directory name. The plugin's directory is ``mission-control/`` per
    Hermes convention; Python module names can't contain hyphens, so we
    install a synthetic ``mission_control`` package pointing at it."""
    if "mission_control" in sys.modules:
        return
    spec = importlib.util.spec_from_file_location(
        "mission_control",
        PLUGIN_ROOT / "__init__.py",
        submodule_search_locations=[str(PLUGIN_ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load mission-control plugin package")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mission_control"] = mod
    spec.loader.exec_module(mod)


_register_plugin_as_package()
```

- [ ] **Step 4: Install dev deps + run the smoke test**

Ask the user to install dev deps so the plugin's tests can run (no end-running pmg):

```
Please run: cd services/hermes/plugins/mission-control && pip install -e ".[dev]"
```

(Document this in the README for new contributors; the install step is one-time per plugin checkout.)

Once installed, run:

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_scaffold.py -v
```

Expected: 3/3 pass.

**If `test_register_is_callable` passes but a later test like `test_status_map.py` fails with `ModuleNotFoundError: No module named 'mission_control.status_map'`**, the importlib synthetic-package trick isn't resolving submodules. Fallback path: instead of the importlib trick, add a symlink `tests/mission_control -> ..` (i.e. the parent directory) so Python sees a normal `mission_control` package by name. On Windows that's a fixture: create the symlink via `subprocess.run(["cmd", "/c", "mklink", "/D", ...])` once in conftest. Use the simpler symlink approach immediately if the importlib trick proves brittle in your environment.

- [ ] **Step 5: Commit**

```bash
git add services/hermes/plugins/mission-control/tests/
git commit -m "feat(mc plugin): test harness (conftest + scaffold tests)

conftest.py prepends services/hermes/_source/ to sys.path so the
plugin can import hermes_cli/gateway modules, scrubs the
_HERMES_GATEWAY and HERMES_KANBAN_TASK env markers per test, and
registers the hyphenated plugin dir as the 'mission_control' Python
package."
```

---

## Phase 2 — Foundation modules

### Task 6: `status_map.py`

**Files:**
- Create: `services/hermes/plugins/mission-control/status_map.py`
- Test: `services/hermes/plugins/mission-control/tests/test_status_map.py`

- [ ] **Step 1: Write the failing test**

Write `tests/test_status_map.py`:

```python
"""Tests for the local↔MC status mapping (single source of truth)."""
from __future__ import annotations

import pytest

from mission_control import status_map as sm


# ── local → MC ────────────────────────────────────────────────────────

@pytest.mark.parametrize("local,expected_mc,expected_meta_keys", [
    ("ready",     "ready",       []),
    ("running",   "in_progress", []),
    ("blocked",   "blocked",     ["block_reason"]),
    ("review",    "in_progress", ["review_pending"]),
    ("scheduled", "ready",       ["scheduled_for"]),
    ("archived",  "cancelled",   []),
])
def test_local_to_mc_basic(local, expected_mc, expected_meta_keys):
    mc_status, meta = sm.local_to_mc(local, terminal_state=None, kanban_task={
        "status": local,
        "result": None,
        "metadata": {"block_reason": "x", "scheduled_for": "2026-01-01T00:00:00Z"},
    })
    assert mc_status == expected_mc
    for k in expected_meta_keys:
        assert k in meta

def test_local_to_mc_done_uses_link_terminal_state():
    # done + terminal_state='completed' → MC completed
    mc_status, _ = sm.local_to_mc("done", terminal_state="completed", kanban_task={
        "status": "done", "result": "ok", "metadata": {},
    })
    assert mc_status == "completed"

    # done + terminal_state='failed' → MC failed
    mc_status, meta = sm.local_to_mc("done", terminal_state="failed", kanban_task={
        "status": "done", "result": "boom", "metadata": {},
    })
    assert mc_status == "failed"
    assert "failure_reason" in meta

def test_local_to_mc_skips_unsync_states():
    # triage / pre-promotion → no push
    assert sm.local_to_mc("triage", terminal_state=None, kanban_task={"status": "triage"})[0] is None


# ── MC → local ────────────────────────────────────────────────────────

@pytest.mark.parametrize("mc_status,expected_action", [
    ("ready",       "create_or_noop"),
    ("in_progress", "noop"),
    ("blocked",     "block"),
    ("completed",   "complete_success"),
    ("failed",      "complete_failure"),
    ("cancelled",   "archive"),
    ("pending",     "skip"),
])
def test_mc_to_local_action(mc_status, expected_action):
    action, _ = sm.mc_to_local({"status": mc_status, "metadata": {}})
    assert action == expected_action


# ── kanban event-kind → MC PATCH ──────────────────────────────────────

@pytest.mark.parametrize("event_kind,run_outcome,expected_mc", [
    ("claimed",                 None,        "in_progress"),
    ("blocked",                 None,        "blocked"),
    ("unblocked",               None,        "ready"),
    ("archived",                None,        "cancelled"),
    ("scheduled",               None,        "ready"),
    ("completed",               "completed", "completed"),
    ("completed",               "crashed",   "failed"),
    ("completed",               "timed_out", "failed"),
    ("completed",               "spawn_failed", "failed"),
    ("completed",               "gave_up",   "failed"),
    ("completed",               "reclaimed", "failed"),
    ("completed",               "blocked",   "failed"),
    ("completion_blocked_hallucination", None, "failed"),
])
def test_event_kind_to_patch(event_kind, run_outcome, expected_mc):
    result = sm.event_kind_to_patch(event_kind, run_outcome=run_outcome, event_payload={})
    assert result is not None
    assert result["status"] == expected_mc

def test_event_kind_to_patch_returns_none_for_unhandled():
    # assigned/promoted/spawned/commented → no status PATCH
    for kind in ("assigned", "promoted", "spawned", "commented"):
        assert sm.event_kind_to_patch(kind, run_outcome=None, event_payload={}) is None
```

- [ ] **Step 2: Run — verify failure**

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_status_map.py -v
```

Expected: `ModuleNotFoundError: No module named 'mission_control.status_map'`.

- [ ] **Step 3: Implement**

Write `services/hermes/plugins/mission-control/status_map.py`:

```python
"""Local kanban ↔ MissionControl status mapping. Single source of truth.

This module is pure functions — no I/O, no globals (beyond constants).
All state-shape decisions live here so callers in apply.py / push.py
can stay narrowly focused on coordination.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

LocalStatus = str       # 'triage'|'todo'|'scheduled'|'ready'|'running'|'blocked'|'review'|'done'|'archived'
McStatus = str          # 'pending'|'ready'|'in_progress'|'blocked'|'completed'|'failed'|'cancelled'
TerminalState = Literal["completed", "failed", "cancelled"]
McAction = Literal["create_or_noop", "noop", "block", "complete_success", "complete_failure", "archive", "skip"]


# ── local → MC ────────────────────────────────────────────────────────

def local_to_mc(
    local_status: LocalStatus,
    *,
    terminal_state: Optional[TerminalState],
    kanban_task: dict[str, Any],
) -> tuple[Optional[McStatus], dict[str, Any]]:
    """Map a local kanban task's state to (mc_status, metadata_patch).

    Returns (None, {}) when the state shouldn't be pushed at all (e.g.
    triage, or todo with unfulfilled parents).

    ``terminal_state`` is the link's recorded `last_terminal_state`
    column — the source of truth for done-success vs done-failure (the
    local `result` string is too fragile to parse).
    """
    md = kanban_task.get("metadata") or {}

    if local_status in ("triage",):
        return None, {}
    if local_status == "todo":
        # We don't track parent-readiness here; caller passes only ready-to-push tasks.
        return "pending", {}
    if local_status == "ready":
        return "ready", {}
    if local_status == "scheduled":
        return "ready", {"scheduled_for": md.get("scheduled_for")}
    if local_status == "running":
        return "in_progress", {}
    if local_status == "blocked":
        return "blocked", {"block_reason": md.get("block_reason")}
    if local_status == "review":
        return "in_progress", {"review_pending": True}
    if local_status == "archived":
        return "cancelled", _meta_keep(md, ["cancellation_reason"])
    if local_status == "done":
        if terminal_state == "failed":
            return "failed", {"failure_reason": _failure_reason_from(kanban_task)}
        # default to completed (terminal_state='completed' or None)
        return "completed", {}
    return None, {}


def _failure_reason_from(task: dict[str, Any]) -> str:
    md = task.get("metadata") or {}
    return (
        md.get("mc_failure_reason")
        or task.get("last_failure_error")
        or task.get("result")
        or "unknown"
    )


def _meta_keep(md: dict[str, Any], keys: list[str]) -> dict[str, Any]:
    return {k: md[k] for k in keys if k in md and md[k] is not None}


# ── MC → local ────────────────────────────────────────────────────────

def mc_to_local(mc_task: dict[str, Any]) -> tuple[McAction, dict[str, Any]]:
    """Decide what local-side action to take for an incoming MC task state.

    Returns (action, extras) where ``extras`` carries kwargs the caller
    will forward to the kanban_db helper (e.g. ``reason`` for block,
    ``result`` for complete).
    """
    s = mc_task["status"]
    md = mc_task.get("metadata") or {}
    if s == "pending":
        return "skip", {}
    if s == "ready":
        return "create_or_noop", {}
    if s == "in_progress":
        return "noop", {}
    if s == "blocked":
        return "block", {"reason": md.get("block_reason") or "blocked via mc"}
    if s == "completed":
        return "complete_success", {
            "result": "completed via mc",
            "summary": "completed via mc",
            "metadata": {"mc_terminal": "completed"},
        }
    if s == "failed":
        reason = md.get("failure_reason") or "unknown"
        return "complete_failure", {
            "result": f"failed via mc: {reason}",
            "summary": f"failed via mc: {reason}",
            "metadata": {"mc_terminal": "failed", "mc_failure_reason": reason},
        }
    if s == "cancelled":
        return "archive", {}
    # Unknown MC status — log + skip upstream
    return "skip", {}


# ── kanban event-kind → MC PATCH body ─────────────────────────────────

# task_runs.outcome enum from kanban_db: completed | blocked | crashed
# | timed_out | spawn_failed | gave_up | reclaimed | NULL. Only
# 'completed' maps to MC success; everything else is a failure.
_SUCCESSFUL_OUTCOMES = {"completed"}


def event_kind_to_patch(
    kind: str,
    *,
    run_outcome: Optional[str],
    event_payload: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """Translate a kanban task_events kind into an MC PATCH body.

    Returns None when the event should not produce a PATCH (e.g.
    'commented' is handled by the comment-push path, not the status
    path; 'assigned' / 'promoted' / 'spawned' are local-only details).
    """
    if kind == "claimed":
        return {"status": "in_progress"}
    if kind == "blocked":
        return {"status": "blocked", "metadata": {"block_reason": event_payload.get("reason")}}
    if kind == "unblocked":
        return {"status": "ready"}
    if kind == "archived":
        return {"status": "cancelled"}
    if kind == "scheduled":
        return {"status": "ready", "metadata": {"scheduled_for": event_payload.get("scheduled_for")}}
    if kind == "completed":
        if run_outcome in _SUCCESSFUL_OUTCOMES:
            return {"status": "completed"}
        return {
            "status": "failed",
            "metadata": {"failure_reason": event_payload.get("error") or f"kanban outcome: {run_outcome}"},
        }
    if kind == "completion_blocked_hallucination":
        return {
            "status": "failed",
            "metadata": {"failure_reason": "hallucinated subtask references; see kanban logs"},
        }
    return None
```

- [ ] **Step 4: Run — verify pass**

```bash
cd services/hermes/plugins/mission-control && pytest tests/test_status_map.py -v
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/hermes/plugins/mission-control/status_map.py services/hermes/plugins/mission-control/tests/test_status_map.py
git commit -m "feat(mc plugin): status_map (local↔MC pure mapping)

Single source of truth for state translation. Covers local→MC,
MC→local, and kanban event-kind→MC PATCH paths, including the
task_runs.outcome disambiguation for 'completed' events
(only outcome='completed' → MC success; everything else → failed)."
```

---

The remaining tasks (7–27) follow the same TDD pattern. To keep this plan reviewable and to let implementation proceed task-by-task without me dumping ~2000 more lines in one shot, I'm splitting the plan into two files: this one (Phase 0–2) and a follow-on for Phase 3–11. The follow-on lands in the same commit family as Task 7 begins. See:

- `docs/plans/2026-05-23-mission-control-plugin-part2.md` (Phase 3–11)

Phase 0–2 IS executable on its own — completing Tasks 1–6 ships:
- The MC-side prerequisites (cursor fix + spec consistency)
- The upstream Hermes helper
- An empty plugin scaffold + test harness
- The pure-functional status mapping module

After Task 6, the next agent loads the follow-on plan and continues with Task 7 (`links_db.py`).
