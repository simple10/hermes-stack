# Hermes ↔ MissionControl Plugin — Design

**Status:** Draft for review (rev 3 — second-round review fixes)
**Date:** 2026-05-23
**Scope:** v1 of the Hermes stack-side plugin that wires a Hermes VM to a MissionControl (MC) deployment.
**Sibling spec:** `services/mission-control/docs/specs/2026-05-22-master-api-design.md` (MC API)

This spec covers the Hermes-side integration only.

---

## MC version requirements

The plugin assumes the MC v1 API as specified in the sibling doc, with these specific dependencies that should be confirmed before plugin work starts. If the MC implementation deviates, the plugin spec adjusts to match — never the other way around.

| Plugin v1 needs | Status in MC v1 |
|---|---|
| `POST /v1/agents` + key minting (PAT-role) | Documented in MC §"Agents". Spec ships v1. |
| `POST /v1/connectors` + key minting (PAT-role, owner/admin) | Listed under MC v1 routes (`POST /v1/connectors — register a connector (owner|admin)`). NOTE: MC's principal-type table also tags connectors with "(v1.1)". Treat the v1 routes listing as authoritative; the principal-table annotation needs a one-line fix in the MC spec. **Plugin v1 requires MC v1 connector routes.** |
| `POST /v1/agents/:id/rotate-key` + same for connectors | Documented in MC v1. |
| `GET /v1/me` (resolves agent + connector identity) | Documented in MC v1. |
| `GET /v1/tasks?agent_id=…&updated_since=…&cursor=…&limit=…` | Documented in MC v1. |
| `PATCH /v1/tasks/:id` (status + metadata, agent role for own tasks) | Documented in MC v1. |
| `POST /v1/tasks` (connector role) | Documented in MC v1. |
| `POST /v1/tasks/:id/comments` (agent + connector roles for own/all tasks) | Documented in MC v1. |
| `GET /v1/tasks/:id/comments?cursor=…&limit=…` (cursor pagination, stable under insert) | Documented in MC v1. **Plugin v1 requires MC to ALWAYS return `next_cursor` in the response — never `null`.** On the last page, `next_cursor` is a "tip" cursor that, when re-used, returns an empty page; this preserves "resume from here" semantics across polls. Currently MC's spec says `next_cursor: null` on the last page (line 696, "`null` next_cursor means end of results"). **Plugin v1 requires this changed** — see "Required MC changes" below. Without it, the plugin can't reliably resume comment pagination across poll cycles for tasks whose entire comment list fits in one page. |
| `POST /v1/external_refs` (agent role: `source_id == principal_id`) | Documented in MC v1. |

### Required MC spec / implementation changes (prerequisites)

The plugin spec depends on two small MC-side changes. Both are tracked as separate items against the MC spec; plugin implementation pauses until they're confirmed.

1. **`POST /v1/connectors` is a v1 route.** The principal-type table at MC spec line 155 annotates connector as "(v1.1)" which contradicts the v1 routes section (line 626). Reconcile to "connectors are v1." A one-line MC-spec fix.
2. **Pagination response always returns `next_cursor` (never `null`).** On the last page, `next_cursor` is a tip cursor that returns an empty page when re-used. Applies to all list endpoints (tasks, comments, projects, agents, connectors, external_refs). This lets pollers save the cursor unconditionally for resume-from-here semantics. MC spec line 696 currently says "`null` next_cursor means end of results" — change to "the cursor is always returned; an empty `data` array means no new items since last poll." Implementation: the existing HMAC cursor format already encodes a position; the tip cursor for an empty result is "position of the most recent existing row, or 0 if none." One small change to the cursor-construction code.

If either is rejected, the plugin spec needs revisiting — particularly the comment-pull loop in (2).

---

## Goal

Give one Hermes VM a single-paste setup to (a) pull MC-assigned tasks and run them through the existing local kanban dispatcher, (b) push status, comments, and explicitly-promoted local-originated tasks back to MC, and (c) surface human comments left on MC (e.g. via Notion) onto the local task so the next dispatcher invocation sees them — including auto-unblocking `blocked` tasks when a human comments, so the worker re-spawns with the comment in context.

User mental model: *"I assign a task to my Hermes VM via Notion (or the MC UI). Hermes picks it up, works on it, comments on it as it goes, asks for clarification when it needs to, and I can talk back to it through the same MC task — without ever SSHing into the VM."*

### Process locality

The plugin's `register(ctx)` is called in EVERY Hermes process (gateway, every dispatcher-spawned worker, ad-hoc CLI invocations) because plugin discovery runs on every `hermes` startup. The plugin must be safe to load anywhere; the network loops run ONLY in the gateway.

Loop-startup guard (in `register(ctx)`):

```python
def _is_gateway() -> bool:
    # Reuse the existing _HERMES_GATEWAY marker set at module-import of
    # gateway/run.py:543 and already consumed by cli.py:539. The negative
    # HERMES_KANBAN_TASK check excludes dispatcher-spawned workers (which
    # inherit env vars from the gateway).
    return os.environ.get("_HERMES_GATEWAY") == "1" and not os.environ.get("HERMES_KANBAN_TASK")
```

The tools and CLI subcommand are registered unconditionally; only loop startup is gated. A worker that calls `mc_promote_task` makes a direct HTTP POST + writes to `links.db` (cross-process SQLite write, safe in WAL).

**Test-env note:** `_HERMES_GATEWAY=1` is set at module import of `gateway.run`, so any test that imports gateway code would falsely trigger the gateway path. Plugin unit tests use `monkeypatch.delenv("_HERMES_GATEWAY", raising=False)` in their fixtures to simulate non-gateway runs. Documented in `tests/conftest.py`.

---

## Non-goals (explicit)

- A new dispatcher / runner. We reuse the existing in-gateway kanban dispatcher unchanged.
- Multi-org per VM. One VM = one MC agent + connector = one MC org.
- Sharded pool support. v1 of MC is single-pool; the agent never knows pools exist.
- MC `GET /v1/events` consumption (deferred until that endpoint ships in MC v1.1).
- A new tab in the Hermes dashboard. We add a small connection-status widget to the existing settings/plugins surface.
- Auto-promoting local tasks to MC. Promotion is always an explicit operator/agent action.
- Heartbeats (MC v1 bumps `last_seen_at` server-side on every authenticated request).
- Webhooks in (MC → Hermes via inbound HTTP). The agent VM is firewalled; we poll.

---

## Architecture

```
┌─ MissionControl (Cloudflare Workers + D1, cloud) ─────────────────────────┐
│  GET   /v1/me                         (any key — identity check)          │
│  GET   /v1/tasks                      (agent key)                         │
│  PATCH /v1/tasks/:id                  (agent key)                         │
│  POST  /v1/tasks                      (connector key)                     │
│  POST  /v1/tasks/:id/comments         (agent or connector key)            │
│  GET   /v1/tasks/:id/comments         (agent key; opaque cursor)          │
│  POST  /v1/external_refs              (agent key; source_id=agent_id)     │
└──────────────────────────▲──────────────────────┬─────────────────────────┘
                           │ Bearer mcagt_…       │ Bearer mccnn_…
                           │                      │
┌─ Hermes VM (in gateway, via a daemon thread) ───┴────────────────────────┐
│                                                                            │
│  ┌─ plugin: mission-control ────────────────────────────────────────────┐ │
│  │                                                                       │ │
│  │  config.py    — env loading; auth.json read/write w/ mtime cache     │ │
│  │  client.py    — httpx wrapper: retry/backoff/idempotency-key/cursor  │ │
│  │  registrar.py — PAT → agent + connector keys; caches projects        │ │
│  │  links_db.py  — schema + helpers (mc_links, mc_comment_links,         │ │
│  │                  mc_apply_log, mc_pull_cursor)                        │ │
│  │  pull.py      — pull loop                                            │ │
│  │  push.py      — push reactor (tails kanban task_events for one board)│ │
│  │  apply.py     — applies MC → local using kanban_db helpers safely   │ │
│  │  status_map.py — single source of truth for local↔MC status        │ │
│  │  tools.py     — mc_promote_task tool                                │ │
│  │  cli.py       — `hermes mc {register,status,promote,refresh-…,…}` │ │
│  │  runtime.py   — daemon thread that runs asyncio.run(both_loops())   │ │
│  │  __init__.py  — register(ctx); detects gateway; starts thread       │ │
│  │  plugin.yaml                                                         │ │
│  │  README.md                                                           │ │
│  │  dashboard/                                                          │ │
│  │    manifest.json — widget on the settings tab                       │ │
│  │    plugin_api.py — GET /api/plugins/mission-control/status          │ │
│  │  tests/        — pytest (see "Tests location" below)               │ │
│  └────────────┬──────────────────────────────────┬───────────────────────┘ │
│               │ writes/reads kanban (one board)  │ reads task_events       │
│               ▼                                  ▼                         │
│   ┌─ ~/.hermes/kanban/<HERMES_MC_BOARD>.db (default "mc") ──────────────┐ │
│   │  tasks  task_events  task_comments  (unchanged upstream schema)     │ │
│   └──────────────┬──────────────────────────────────────────────────────┘ │
│                  │ unchanged                                              │
│                  ▼                                                        │
│   ┌─ kanban dispatcher (existing, in-gateway, sees the same board) ───┐ │
│   │  picks ready tasks, spawns workers, manages logs/result            │ │
│   └─────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

**One daemon thread** inside the gateway runs both async loops concurrently in its own asyncio event loop:

```python
def _thread_target():
    asyncio.run(_run_loops())

async def _run_loops():
    await asyncio.gather(pull_loop(), push_reactor())
```

`asyncio.run` inside a non-main thread is safe (Python 3.8+). The thread is `daemon=True` so it doesn't block process exit; on gateway shutdown, the thread is abandoned (cleanly — both loops are sleep-bound with no held resources beyond open `httpx.AsyncClient`s and SQLite connections that close themselves on GC).

Why a thread (not `asyncio.create_task` on the gateway's loop): plugin `register(ctx)` is called from plain-sync discovery context, BEFORE `asyncio.run(start_gateway())`. `asyncio.create_task` would raise `RuntimeError: no running event loop`. The agents-observe plugin uses the same daemon-thread pattern for exactly this reason.

| Loop | Cadence | Reads | Writes |
|---|---|---|---|
| **Pull loop** | `MC_POLL_INTERVAL` (default 10s; min 2s) | `GET /v1/tasks?agent_id=self&updated_since=<cursor>&limit=100` then per-active-link `GET /v1/tasks/:id/comments?cursor=<saved>&limit=100` | Upserts kanban tasks + comments via `apply.py`; auto-unblocks `blocked` tasks on new MC comment; records applied event ids in `mc_apply_log`; advances cursors only after both phases complete |
| **Push reactor** | Tails kanban `task_events` (1s SQLite poll) on the MC-pinned board | `task_events` rows since cursor, skipping ids in `mc_apply_log`; cross-checks `mc_links` membership | `PATCH /v1/tasks/:id` (status), `POST /v1/tasks/:id/comments` (locally-authored), `POST /v1/external_refs` (on first promotion); clears `push_dirty`, updates `last_pushed_at` + `last_terminal_state` |

**Failure isolation:** MC outages must never block the kanban dispatcher or freeze the gateway. Each loop catches `httpx.RequestError` / `httpx.HTTPStatusError` for 5xx / `asyncio.TimeoutError`, backs off (5s → 30s → 120s with ±25% jitter), logs WARN per failure and INFO on recovery, never advances cursors on partial failure. On 401: all loops stop, plugin status = `auth_failed`, ERROR logged with remediation; re-run `hermes mc register` to recover.

Loops run only after `register(ctx)` confirms `_is_gateway() == True` AND `~/.hermes/auth.json` has a `mission_control` block with non-empty `agent_key`. When either condition is missing, the plugin is inert (mirrors agents-observe).

---

## Plugin layout

Stack-side source — same deployment pattern as `services/hermes/plugins/agents-observe/`:

```
services/hermes/plugins/mission-control/
  plugin.yaml
  __init__.py              # register(ctx)
  config.py                # env loading; auth.json read/write; mtime cache
  client.py                # httpx-based MC HTTP client
  registrar.py             # PAT → mints/rotates agent + connector keys
  links_db.py              # schema + helpers
  pull.py
  push.py
  apply.py                 # MC → local writes via kanban_db helpers
  status_map.py
  tools.py
  cli.py
  runtime.py               # daemon thread + lifecycle
  README.md
  dashboard/
    manifest.json
    plugin_api.py
  tests/
    test_status_map.py
    test_links_db.py
    test_client.py            # respx-mocked HTTP
    test_registrar.py
    test_apply.py
    test_pull.py
    test_push.py
    test_auto_unblock.py
    test_loop_guard.py
    test_promote_idempotency.py
```

The plugin is deployed into the VM at `~/.hermes/plugins/mission-control/` by `services/hermes/build.sh` (new helper `hermes_sync_plugin "mission-control"`), same pattern as `agents-observe`.

### `plugin.yaml`

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

The plugin registers no hooks. The `requires_env` key triggers Hermes' built-in inert-plugin behavior when `HERMES_MC_URL` is unset. We deliberately keep the `HERMES_MC_` prefix everywhere — inside the VM env, in plugin code, and in the manifest. (Earlier draft proposed an unprefixed-inside-VM convention; dropped for consistency.)

The plugin opts in via the existing `plugins.enabled` allow-list in `~/.hermes/config.yaml` — `build.sh` appends `mission-control` to that list on the first build that has `HERMES_MC_URL` set (idempotent: `hermes_enable_plugin "mission-control"`).

### Gateway marker

No upstream change needed. The plugin reuses the existing `_HERMES_GATEWAY=1` env marker set at module-import in `gateway/run.py:543` and already consumed by `cli.py:539`. (An earlier draft of this spec proposed adding a new `HERMES_GATEWAY` marker — review caught the duplication.)

---

## Configuration

### Stack-side `.stack/.env` levers (in the `#>--- hermes ---` block)

```
HERMES_MC_URL=                          # base URL (e.g. https://mc.example.com)
HERMES_MC_USER_PAT=                     # one-time mcpat_… PAT for first-run; clear after
HERMES_MC_AGENT_NAME=                   # override; default = OrbStack VM name
HERMES_MC_BOARD=mc                      # dedicated kanban board for MC tasks
HERMES_MC_POLL_INTERVAL=10              # seconds between pull cycles (min 2)
HERMES_MC_BOOTSTRAP_SINCE=7d            # how far back to pull on first sync
HERMES_MC_DEFAULT_PROJECT_SLUG=         # used by `hermes kanban create --mc`
HERMES_MC_CONFLICT_SLOP_MS=5000         # window for treating a re-pull as a no-op
HERMES_MC_DEBUG=false                   # extra DEBUG-level logs
```

All keys carry the `HERMES_MC_` prefix. `build.sh` writes them into the managed block of `~/.hermes/.env` with prefix intact. The plugin reads `os.environ["HERMES_MC_*"]` directly — no rename in the VM.

### `~/.hermes/auth.json` after registration

```jsonc
{
  "providers": {
    "mission_control": {
      "url":           "https://mc.example.com",
      "org_id":        "org_AbCdEf123",
      "agent_id":      "agt_AbCdEf456",
      "agent_key":     "mcagt_xxxxxxxxxxxxx",
      "connector_id":  "cnn_AbCdEf789",
      "connector_key": "mccnn_xxxxxxxxxxxxx",
      "registered_at": 1747987200000
    }
  }
}
```

`config.py` loads this once and caches in module state with mtime invalidation (re-reads if file changed). Avoids per-worker disk hits in hot kanban paths.

`HERMES_MC_USER_PAT` is read only when `auth.json` lacks a `mission_control` block (first run) OR when the operator explicitly runs `hermes mc register` / `refresh-projects`. After first run, the operator may delete `HERMES_MC_USER_PAT` from `.stack/.env` — subsequent restarts use stored keys.

### Two keys per VM

- **Agent key** (`mcagt_…`) — pull loop, status PATCH, comment POST, external_ref POST. Scope: read/update/comment on own tasks (`agent_id == principal_id`). All `external_refs` rows the plugin creates use `source_kind='hermes'`, `source_id=self_agent_id` (the agent role enforces this match).
- **Connector key** (`mccnn_…`) — local-originated task promotion (`POST /v1/tasks`) only. Scope: full task/project CRUD for the org.

The split mirrors MC's role design. Same VM acts as both, with two independent keys minted at registration.

### Project list cache

Cached at `~/.hermes/mission-control/projects.json`, written by the registrar via the PAT (which has list permission). Format: `[{"id": "prj_…", "slug": "…", "name": "…"}, …]`. Refreshed by `hermes mc refresh-projects [--pat mcpat_…]`.

---

## Local kanban ↔ MC data model

### Dedicated board

All MC-mirrored tasks live in ONE kanban board, slug `HERMES_MC_BOARD` (default `"mc"`). This solves two problems: (1) the push reactor only tails one board's `task_events`, (2) the operator can `hermes kanban list -b mc` to see only MC work. Plugin code always passes `board=os.environ["HERMES_MC_BOARD"]` to every `kanban_db.connect(...)` call.

### `links.db` (plugin-owned, at `~/.hermes/mission-control/links.db`, WAL mode)

```sql
CREATE TABLE IF NOT EXISTS mc_links (
  local_task_id        TEXT    PRIMARY KEY,    -- kanban.tasks.id (in HERMES_MC_BOARD)
  mc_task_id           TEXT    NOT NULL UNIQUE, -- 't_xxxxx'
  mc_org_id            TEXT    NOT NULL,
  mc_project_id        TEXT    NOT NULL,
  mc_agent_id          TEXT,                    -- the agent assigned in MC
  source               TEXT    NOT NULL,        -- 'pulled' | 'pushed'
  local_status         TEXT    NOT NULL,        -- denorm cache of kanban.tasks.status
  last_terminal_state  TEXT,                    -- 'completed'|'failed'|'cancelled'|NULL
  last_pulled_at       INTEGER NOT NULL DEFAULT 0,   -- mc updated_at last applied locally
  last_pushed_at       INTEGER NOT NULL DEFAULT 0,   -- mc updated_at returned by our PATCH
  last_pull_applied_at INTEGER NOT NULL DEFAULT 0,   -- wall-clock when pull last touched local
  last_comment_cursor  TEXT    NOT NULL DEFAULT '',  -- opaque cursor from MC comments paginator
  push_dirty           INTEGER NOT NULL DEFAULT 0,
  push_failed_until    INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mc_links_dirty_idx
  ON mc_links(push_dirty) WHERE push_dirty = 1;
CREATE INDEX IF NOT EXISTS mc_links_active_idx
  ON mc_links(local_status) WHERE local_status NOT IN ('done', 'archived');

CREATE TABLE IF NOT EXISTS mc_comment_links (
  local_comment_id  INTEGER PRIMARY KEY,        -- kanban.task_comments.id
  mc_comment_id     TEXT    NOT NULL UNIQUE,    -- 'cmt_xxx'
  local_task_id     TEXT    NOT NULL,
  source            TEXT    NOT NULL,           -- 'pulled' | 'pushed'
  created_at        INTEGER NOT NULL
);

-- Records every kanban task_events row written by the pull-apply path.
-- The push reactor skips events whose id appears here, preventing feedback.
CREATE TABLE IF NOT EXISTS mc_apply_log (
  event_id    INTEGER PRIMARY KEY,              -- kanban.task_events.id
  link_id     TEXT    NOT NULL,                 -- mc_links.local_task_id
  applied_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mc_apply_log_applied ON mc_apply_log(applied_at);

CREATE TABLE IF NOT EXISTS mc_pull_cursor (
  k           TEXT    PRIMARY KEY,              -- 'tasks' or 'events'
  cursor      INTEGER NOT NULL DEFAULT 0,       -- mc updated_at (tasks) | local task_events.id (events)
  updated_at  INTEGER NOT NULL
);
```

**Why a separate DB:** the upstream kanban schema is owned by hermes; we don't add columns to it. Plugin tables live in their own SQLite (WAL mode, multi-writer-safe).

**Denormalized `local_status`:** updated transactionally in `links.db` every time we apply a pull or observe a push event. Lets `list_active_links()` be a pure links.db query (no per-link kanban-DB hit). Stale by at most one event cycle.

**`mc_apply_log`:** the anti-feedback mechanism. When `apply.py` writes a status change to kanban (via the proper kanban_db helper), it captures the resulting `task_events.id` and inserts it here. The push reactor's main query becomes: `SELECT * FROM task_events WHERE id > ? AND id NOT IN (SELECT event_id FROM mc_apply_log WHERE applied_at > ?-86400000) ORDER BY id LIMIT 200`. Keeps the log bounded (purge entries older than 24h via a small periodic cleanup in the pull loop's idle ticks).

**Drift handling:**
- If a kanban task referenced by `mc_links.local_task_id` is hard-deleted (rare; archive is the normal path), next push attempt sees no row, logs WARN, deletes the orphan link.
- If `mc_task_id` returns 404 on a poll cycle, delete the link and archive the local task with `result='removed from mc'`.

### Status mapping (`status_map.py`)

Hermes local statuses: `triage`, `todo`, `scheduled`, `ready`, `running`, `blocked`, `review`, `done`, `archived`.
MC statuses: `pending`, `ready`, `in_progress`, `blocked`, `completed`, `failed`, `cancelled`.

| Hermes local | MC | Mechanism |
|---|---|---|
| `triage` | (no push — wait until promotion) | Link doesn't exist yet for unpushed tasks. |
| `todo` (with parents not done) | (no push) | Same; link may exist but state is "waiting for parents". |
| `todo` (no parents) | `pending` | Only meaningful for connector-pushed tasks pre-assignment. |
| `scheduled` | `ready` | `metadata.scheduled_for: <iso8601>` carried in PATCH body. |
| `ready` | `ready` | Direct. |
| `running` | `in_progress` | MC sets `started_at` on ready→in_progress. |
| `blocked` | `blocked` | `metadata.block_reason` from `block_task`'s `reason` arg. |
| `review` | `in_progress` | `metadata.review_pending: true`. |
| `done` + `last_terminal_state == 'completed'` | `completed` | Source of truth is the link, not result-string parsing. |
| `done` + `last_terminal_state == 'failed'` | `failed` | Set by push reactor when it observes the `completion_blocked_hallucination` kind OR a `completed` event whose payload `outcome == 'failed'`. |
| `archived` | `cancelled` | `metadata.cancellation_reason` if known. |

| MC | Hermes local | Apply mechanism (kanban_db helper) |
|---|---|---|
| `pending` | (skip — agent role can't see) | — |
| `ready` | `ready` | New tasks: `kanban_db.create_task(conn, ..., initial_status='ready', tenant=..., assignee=...)`. Existing-task transitions: no-op if already `ready`/`scheduled`/`triage`/`todo`. Don't fight the dispatcher. |
| `in_progress` | `running` | Almost always no-op (we're the agent — we're the one running it). If we see `in_progress` on a task whose local status is `ready` (operator force-set in MC), call nothing — the dispatcher's next claim cycle will transition it. |
| `blocked` | `blocked` | `kanban_db.block_task(conn, task_id, reason=mc_block_reason)`. |
| `completed` | `done` | `kanban_db.complete_task(conn, task_id, result='completed via mc', summary='completed via mc', metadata={'mc_terminal': 'completed'})`. Set `link.last_terminal_state='completed'`. (No `outcome=` kwarg — `complete_task` doesn't take one; the local run-row outcome is always `completed`.) |
| `failed` | `done` | Same call but with `result=f'failed via mc: {reason}'`, `metadata={'mc_terminal': 'failed', 'mc_failure_reason': reason}`. Set `link.last_terminal_state='failed'`. (kanban_db has no `failed` task status; we surface failure as `done` + result/metadata. The local kanban dashboard's "completion outcome" column reads from the run-row, but for MC-applied completions we don't have a real run — the metadata is the source of truth.) |
| `cancelled` | `archived` | `kanban_db.archive_task(conn, task_id)`. Set `link.last_terminal_state='cancelled'`. |

`apply.py` wraps each kanban_db helper call to:
1. Open `kanban_db.connect(board=HERMES_MC_BOARD)`.
2. `pre_max = conn.execute("SELECT IFNULL(MAX(id), 0) FROM task_events WHERE task_id = ?", (task_id,)).fetchone()[0]`.
3. Call the helper (e.g. `kanban_db.block_task(conn, task_id, reason=...)`).
4. `post_max = conn.execute("SELECT IFNULL(MAX(id), 0) FROM task_events WHERE task_id = ?", (task_id,)).fetchone()[0]`.
5. For each `event_id in range(pre_max + 1, post_max + 1)`, INSERT into `links.db.mc_apply_log(event_id, link_id, applied_at)`. Range-INSERT (not `event_id IN (...)`) is correct because no other writer touches THIS task_id concurrently — the dispatcher only writes to a task after it has been claimed, and the pull-apply path runs on tasks the dispatcher isn't actively touching (or, when it is, the events are interleaved in id order and the range still captures them all).
6. Update `mc_links.local_status`, `last_pulled_at`, `last_pull_applied_at`, and (if terminal) `last_terminal_state` in one `links.db` transaction.

The pre/post-max approach replaces the earlier "highest id whose task_id matches" — that was race-vulnerable. Reading both bookends under the same kanban connection captures every event the helper emitted for this task, and no others.

If step 5 fails after step 3 succeeds (rare crash window), the push reactor will see the events and try to push them back to MC. MC's PATCH is naturally idempotent for status (we send the desired state, MC accepts) so this is at worst a wasted PATCH, not corruption.

---

## Sync semantics

### kanban_db helpers used (verified signatures)

The plugin calls the following from `hermes_cli.kanban_db`. All take a `sqlite3.Connection` as first arg (obtained via `kanban_db.connect(board=...)`):

- `connect(board: str | None = None) -> sqlite3.Connection`
- `create_task(conn, *, title, body=None, assignee=None, ..., tenant=None, idempotency_key=None, initial_status='running', board=None) -> str` — we pass `initial_status='ready'`, `tenant=f'mc:{org_id}:{project_id}'`, `idempotency_key=f'mc:{mc_task_id}'`.
- `add_comment(conn, task_id, author, body) -> int` — returns the comment row id.
- `list_comments(conn, task_id) -> list[Comment]`
- `block_task(conn, task_id, *, reason=None, expected_run_id=None) -> bool` (kwarg-only after positional task_id)
- `unblock_task(conn, task_id) -> bool` — there is no `by=` kwarg; if we want to record "unblocked by MC", we append a kanban comment first.
- `complete_task(conn, task_id, *, result=None, summary=None, metadata=None, created_cards=None, expected_run_id=None) -> bool` — kwarg-only after positional task_id; no `outcome` kwarg exists.
- `archive_task(conn, task_id) -> bool`
- `latest_run(conn, task_id) -> Optional[Run]` — used by the push reactor to look up `task_runs.outcome` when processing a `completed` event.
- **New upstream helper #1:** `kanban_db.list_events_since(conn, last_id, limit) -> list[Event]` — must return rows ordered by `id ASC` (NOT `created_at` — that has 1-second tie risk) with fields `(id, task_id, kind, payload, run_id, created_at)`. ~15 LOC. If upstream rejects, the plugin runs the raw SQL itself against `kanban_db.connect(board=...)` connection.

**`tasks.idempotency_key` is NOT uniquely indexed.** The existing index is non-unique and kanban_db's `create_task` dedups by SELECT-then-INSERT. The pull loop is single-writer (only the gateway runs it), so the create-then-check race is not a real problem — we accept it explicitly. The earlier draft claimed a partial unique index; correction noted.

### Event kinds the push reactor observes

Real kanban event kinds (audited from `_append_event` callsites):

`assigned`, `blocked`, `commented`, `promoted`, `scheduled`, `spawned`, `claimed`, `archived`, `completed`, `unblocked`, `completion_blocked_hallucination`.

The push reactor maps them as follows:

| Event kind | Mapped MC PATCH |
|---|---|
| `claimed` | PATCH status=`in_progress` |
| `blocked` | PATCH status=`blocked` + `metadata.block_reason` from payload |
| `unblocked` | PATCH status=`ready` (or `in_progress` if a `spawned` follows immediately; reactor coalesces in a 1s window) |
| `completed` | PATCH MC status — but FIRST call `kanban_db.latest_run(conn, ev.task_id)` to read `Run.outcome`. The complete `task_runs.outcome` enum is `completed | blocked | crashed | timed_out | spawn_failed | gave_up | reclaimed | NULL` (NULL while still running). Map: `completed` → MC `completed`; everything else (`crashed`, `timed_out`, `spawn_failed`, `gave_up`, `reclaimed`, `blocked`) → MC `failed` with `metadata.failure_reason = task.last_failure_error or task.result or f'kanban outcome: {outcome}'`. The `completed` event payload itself does not carry outcome — outcome lives on `task_runs`. Always set `link.last_terminal_state` to whichever you sent. |
| `completion_blocked_hallucination` | PATCH MC status=`failed` + `metadata.failure_reason='hallucinated subtask references; see kanban logs'`. Set `link.last_terminal_state='failed'`. |
| `archived` | PATCH status=`cancelled` |
| `scheduled` | PATCH status=`ready` + `metadata.scheduled_for` |
| `assigned` | (no push — the agent_id doesn't change for MC-pulled tasks; for connector-pushed tasks, MC's POST already set it) |
| `promoted` | (no push — local "todo→ready" already pushed via the ready mapping above when status reaches `ready`) |
| `spawned` | (no push — implementation detail) |
| `commented` | POST /v1/tasks/:id/comments (unless filtered out by `mc_comment_links` or `mission-control:` author prefix) |

### Pull loop

```python
async def pull_loop():
    backoff = Backoff(base=5, factor=2, cap=120, jitter=0.25)
    while not _stopping:
        try:
            tasks_cursor = links_db.get_pull_cursor('tasks')
            new_tasks_cursor = tasks_cursor

            page = await client.tasks_list(
                agent_key=cfg.agent_key,
                agent_id=cfg.agent_id,
                updated_since=tasks_cursor,
                limit=100,
            )
            for mc_task in page.data:
                await apply.handle_one_task(mc_task)
                new_tasks_cursor = max(new_tasks_cursor, mc_task['updated_at'])
            while page.next_cursor:
                page = await client.tasks_list(agent_key=cfg.agent_key, cursor=page.next_cursor)
                for mc_task in page.data:
                    await apply.handle_one_task(mc_task)
                    new_tasks_cursor = max(new_tasks_cursor, mc_task['updated_at'])

            for link in links_db.list_active_links():     # filters local_status in {ready,running,blocked,scheduled,review}
                cursor = link.last_comment_cursor or None
                while True:
                    cpage = await client.task_comments_list(
                        agent_key=cfg.agent_key,
                        mc_task_id=link.mc_task_id,
                        cursor=cursor,
                        limit=100,
                    )
                    for c in cpage.data:
                        await apply.handle_one_comment(link, c)
                    # Per "Required MC changes" #2: cpage.next_cursor is ALWAYS
                    # populated (it's a "tip" cursor on the last page that
                    # returns an empty page next time). Save it every iteration,
                    # then break when an empty data page comes back.
                    links_db.set_link_comment_cursor(link.local_task_id, cpage.next_cursor)
                    if not cpage.data:
                        break
                    cursor = cpage.next_cursor

            # Advance the global tasks-cursor ONLY after both phases succeed.
            links_db.set_pull_cursor('tasks', new_tasks_cursor)

            # Purge apply-log entries older than 24h (idle housekeeping).
            links_db.purge_apply_log(older_than_ms=24*3600*1000)

            backoff.reset()
        except (httpx.RequestError, httpx.HTTPStatusError, asyncio.TimeoutError) as e:
            log.warning("mc pull: transient failure (%s); backing off", e)
            await asyncio.sleep(backoff.next())
            continue
        except AuthFailed:
            log.error("mc pull: auth failed; stopping all loops until re-registration")
            _set_status('auth_failed')
            return
        await asyncio.sleep(cfg.poll_interval_s)
```

`handle_one_task(mc_task)` in `apply.py`:

1. Lookup `mc_links` by `mc_task_id`.
2. **No link**, MC status is one of `{ready, in_progress, blocked}`:
   - `kanban_db.create_task(conn, title=mc_task.title, body=mc_task.body, tenant=f'mc:{org_id}:{project_id}', assignee=cfg.agent_id, initial_status='ready', idempotency_key=f'mc:{mc_task.id}', board=cfg.board)` → `local_task_id`.
   - Insert link: `source='pulled', mc_agent_id=mc_task.agent_id, local_status='ready', last_pulled_at=mc_task.updated_at`.
   - POST `/v1/external_refs` with `source_kind='hermes', source_id=cfg.agent_id, external_id=local_task_id, resource_type='task', resource_id=mc_task.id` using **agent key** (Idempotency-Key: `hermes:xrf:{local_task_id}`).
   - Record the created-task event id in `mc_apply_log`.
3. **No link**, MC status is one of `{pending, completed, failed, cancelled}`: skip (no value in mirroring terminal/unassigned).
4. **Link exists, source='pulled', mc_task.updated_at > link.last_pulled_at**:
   - Compute `(local_status, terminal)` from `status_map.mc_to_local(mc_task)`.
   - If `terminal`: call appropriate `kanban_db.{complete,archive}_task(...)`, set `link.last_terminal_state`.
   - Else if `local_status == 'blocked'`: `kanban_db.block_task(conn, local_task_id, reason=mc_task.metadata.get('block_reason'))`.
   - Else: log and no-op (state transitions like `ready→in_progress` are owned by the dispatcher, not us).
   - Record event id(s) in `mc_apply_log`. Update `link.local_status`, `last_pulled_at`, `last_pull_applied_at`.
5. **Link exists, source='pushed', mc_task.updated_at > link.last_pushed_at + cfg.conflict_slop_ms**:
   - Genuine conflict (operator edited in MC after our PATCH). Log WARN with both updated_ats; apply MC state as in step 4.
6. **Otherwise (echo of our own push, within slop window):** no-op, but update `link.last_pulled_at` to acknowledge.

`handle_one_comment(link, mc_comment)`:

1. If `mc_comment_links.has_mc(mc_comment.id)`: skip (already mirrored).
2. Open `kanban_db.connect(board=cfg.board)`.
3. `comment_id = kanban_db.add_comment(conn, link.local_task_id, author=f'mission-control:{mc_comment.author_type}:{mc_comment.author_id}', body=mc_comment.body)`.
4. Record the comment-row's `task_events` row id in `mc_apply_log` (kanban emits a `commented` event row alongside the comment row; we capture both via the highest event id post-insert).
5. INSERT `mc_comment_links(local_comment_id=comment_id, mc_comment_id=mc_comment.id, source='pulled', ...)`.
6. **Auto-unblock**: if `link.local_status == 'blocked'`:
   - Append a system-comment first noting the unblock trigger: `add_comment(conn, link.local_task_id, author='mission-control:system', body=f'auto-unblock: new comment from {mc_comment.author_type}')`.
   - `kanban_db.unblock_task(conn, link.local_task_id)`.
   - Record the unblocked event id in `mc_apply_log`.
   - Update `link.local_status='ready'`.

### Push reactor

```python
async def push_reactor():
    last_event_id = links_db.get_pull_cursor('events')
    backoff = Backoff(base=5, factor=2, cap=60, jitter=0.25)
    while not _stopping:
        try:
            conn = kanban_db.connect(board=cfg.board)
            events = kanban_db.list_events_since(conn, last_event_id, limit=200)
            for ev in events:
                last_event_id = ev.id
                if links_db.is_in_apply_log(ev.id):
                    continue
                link = links_db.get_link(ev.task_id)
                if not link:
                    log.debug("event %d on unlinked task %s — skip", ev.id, ev.task_id)
                    continue
                _handle_event(link, ev)
            await _drain_push_queue()
            links_db.set_pull_cursor('events', last_event_id)
            backoff.reset()
        except (httpx.RequestError, httpx.HTTPStatusError, asyncio.TimeoutError) as e:
            log.warning("mc push: transient failure (%s); backing off", e)
            await asyncio.sleep(backoff.next())
            continue
        except AuthFailed:
            log.error("mc push: auth failed; stopping all loops until re-registration")
            _set_status('auth_failed')
            return
        await asyncio.sleep(1.0)
```

`_handle_event(link, ev)` consults `status_map.event_kind_to_patch(ev.kind, ev.payload)` for status events; for `commented` events, it filters via `mc_comment_links.has_local(ev.payload.get('comment_id'))` AND a defensive check that the comment author doesn't start with `mission-control:` (defense-in-depth — if a future bug skips the mc_comment_links insert, the author prefix catches it). For `completed` events, it calls `kanban_db.latest_run(conn, ev.task_id)` and uses the `Run.outcome` per the mapping table.

`_drain_push_queue()` issues PATCH and POST in serial, marks `push_dirty=0`, updates `link.last_pushed_at` to the response's `updated_at`, and (for terminal transitions) sets `link.last_terminal_state`. On failure: leaves `push_dirty=1`, sets `push_failed_until=now+backoff`.

**No ping-pong defer.** Earlier draft had a `last_pull_applied_at`-based defer; rev-2 review showed it caused every newly-pulled task's first `ready→in_progress` PATCH to be deferred by `poll_interval + slop` (~15s default). The defer was over-cautious — the `mc_apply_log` mechanism is sufficient to suppress echoes, and any remaining race (operator changes MC after our PATCH within the cursor window) is just last-writer-wins, which is already the v1 semantic. The defer mechanism is removed. (`last_pull_applied_at` is kept on the link for diagnostics only.)

### Local-originated promotion

User runs `hermes kanban create --mc [<project-slug>] -t "task title"` (uses the existing `create` subcommand — there is no `add` alias). The `--mc` flag is added by the plugin via a register-time extension to the kanban subparser.

**Subparser extension mechanism:** plugin discovery runs before the gateway starts but AFTER the kanban subparser is constructed in `cli.py` (line ordering verified in upstream). The plugin reaches into `hermes_cli.kanban.build_parser`'s output via `ctx.register_subcommand_extension('kanban', _extend_kanban_create)`. **This API does not exist on PluginContext today** — the plugin spec includes adding it as a one-method upstream change (same family as the `list_events_since` helper). Without it, the fallback is for `hermes mc` to provide `hermes mc promote <task_id>` only, and `hermes kanban create --mc` ships in plugin v1.1 once the upstream API lands.

The promotion flow (used by both the CLI extension and the `mc_promote_task` tool):

1. Resolve `project_slug → project_id` via `~/.hermes/mission-control/projects.json` (cached). Fail with friendly error pointing to `hermes mc refresh-projects` if unknown.
2. Create the local kanban task in board `cfg.board`: `kanban_db.create_task(conn, ..., tenant=f'mc:{org_id}:{project_id}', initial_status='ready', assignee=cfg.agent_id, board=cfg.board)`.
3. Call `client.tasks_create(connector_key=cfg.connector_key, project_id=project_id, title=..., body=..., agent_id=cfg.agent_id, idempotency_key=f'hermes:{local_task_id}', metadata={'origin': 'hermes'})`. Header `Idempotency-Key: hermes:{local_task_id}` for the additional Stripe-style guard.
4. Insert `mc_links(local_task_id, mc_task_id, source='pushed', last_pushed_at=mc_task.updated_at, local_status='ready', ...)`.
5. POST `/v1/external_refs` with the **agent** key (`source_id=cfg.agent_id`).

Calling promotion twice on the same local task is idempotent: the MC body-level idempotency_key returns 409 with `details.existing_task_id`. We compare to our link; if it matches → return success with `already_linked=true`; else log ERROR (someone else used the same key) and return 409 to the caller.

### Idempotency summary

| Operation | Key |
|---|---|
| Pull → create local task | `kanban_db.create_task(..., idempotency_key=f'mc:{mc_task_id}')` — accepts the SELECT-then-INSERT race because pull is single-writer. |
| Push → create MC task (promotion) | `Idempotency-Key: hermes:<local_task_id>` header + `idempotency_key: hermes:<local_task_id>` body field. Both layers. |
| Push → MC PATCH | None needed; PATCH is naturally idempotent (we always send full desired status + metadata). |
| Push → comment | `Idempotency-Key: hermes:cmt:<local_comment_id>` header. |
| Push → external_ref | `Idempotency-Key: hermes:xrf:<local_task_id>` header. The unique index on `(resource_type, resource_id, source_kind, source_id)` is the second layer. |

---

## Surfacing MC comments to running work

`ctx.inject_message()` only delivers to the host's interactive CLI — workers are separate `hermes -p <profile>` subprocesses and are NOT addressable that way. The existing Hermes worker pattern: workers don't poll comments mid-flight; new comments become visible on the NEXT worker invocation, where the kanban-worker skill's standard "orient" step calls `kanban_list_comments` and includes them in context.

Two mechanisms cover this:

1. **All MC comments → local kanban thread.** Pulled comments land via `kanban_db.add_comment(conn, task_id, author=f'mission-control:{author_type}:{author_id}', body=...)`. Permanent, visible in dashboard / CLI / `kanban_list_comments`. Next worker invocation sees them.

2. **MC comment on a `blocked` task → auto-unblock.** When `apply.handle_one_comment(link, c)` sees `link.local_status == 'blocked'`, it calls `kanban_db.unblock_task(conn, local_task_id)` after writing the comment. The dispatcher re-claims the task on its next tick and spawns a new worker, which orients via `kanban_list_comments` and sees the human's response.

Comments on `running`/`ready`/other non-blocked tasks accumulate silently (not lost, just don't interrupt). Future config knob: `HERMES_MC_AUTO_UNBLOCK_STATUSES` (default `blocked`).

The plugin does NOT register `on_session_start` / `on_session_end` hooks — no live-session state needed.

The author prefix `mission-control:` (not `mc:`, which is too short and reserves too much) is the defense-in-depth filter on the push side: any local comment whose author starts with `mission-control:` is skipped by the push reactor regardless of `mc_comment_links` state.

---

## Agent tool

ONE tool exposed to the LLM (registered via `ctx.register_tool`):

### `mc_promote_task`

```jsonc
{
  "name": "mc_promote_task",
  "description": "Promote an existing local kanban task to MissionControl so the human can see/comment on it from Notion or the MC UI. Returns the MC task id. If the task is already promoted, returns the existing mc_task_id (idempotent).",
  "parameters": {
    "type": "object",
    "properties": {
      "local_task_id": {"type": "string", "description": "id of the local kanban task"},
      "project_slug":  {"type": "string", "description": "MC project slug (omit to use HERMES_MC_DEFAULT_PROJECT_SLUG)"}
    },
    "required": ["local_task_id"]
  }
}
```

Returns `{"mc_task_id": "t_xyz", "already_linked": <bool>}`.

**Why no `mc_comment` tool:** the existing `kanban_comment(task_id, body)` tool already adds the comment to the local thread; the push reactor mirrors any local comment on a linked task up to MC automatically. A separate `mc_comment` would be a redundant alias.

**Why no `mc_status` tool:** `hermes mc status` (CLI) covers this for operators. For the LLM, the existing kanban status tools already show task state; the MC linkage info is operator-debug, not agent-decision-relevant. Skip.

**Why no `mc_update_status` tool:** status transitions go through the normal kanban lifecycle (`kanban_block`, `kanban_complete`, etc.), and the push reactor mirrors them. Direct status writes from the LLM would bypass the dispatcher's bookkeeping.

---

## CLI

`hermes mc <subcommand>` — registered via `ctx.register_cli_command(name='mc', help='MissionControl integration', setup_fn=_mc_setup, handler_fn=_mc_handler)`. PluginContext API verified in `_source/hermes_cli/plugins.py:387`. `setup_fn(parser)` adds the subparsers; `handler_fn(args)` dispatches.

```
hermes mc register [--pat mcpat_…] [--name <agent-name>] [--bootstrap-since 7d]
                              # First-run registration OR re-register. Reads PAT
                              # from --pat or HERMES_MC_USER_PAT. Mints (or rotates)
                              # agent + connector keys. Writes ~/.hermes/auth.json.
                              # Caches projects.
                              # Idempotent: re-running by an already-registered VM
                              # rotates BOTH keys via POST /v1/agents/:id/rotate-key
                              # and POST /v1/connectors/:id/rotate-key.
                              #
                              # Fails hard if POST /v1/connectors returns 404/403:
                              # error code 'mc.connector_routes_unavailable' with
                              # message "MC deployment does not support connector
                              # minting; promotion features unavailable. Either
                              # upgrade MC to a version with POST /v1/connectors,
                              # or wait for plugin v1.1 which can run agent-only."

hermes mc status              # Print URL, org, agent_id, connector_id, last
                              # successful pull/push, queue depth, last 5 errors,
                              # loop-running indicator.

hermes mc refresh-projects [--pat mcpat_…]
                              # Re-fetch the project list. PAT read from
                              # HERMES_MC_USER_PAT if --pat omitted.

hermes mc promote <local_task_id> [--project <slug>]
                              # Promote an already-existing local task to MC.

hermes mc unlink <local_task_id>
                              # Remove the MC link. Local task is unaffected.
                              # MC task is NOT deleted (use MC API directly).

hermes mc test                # Smoke test:
                              #   1. GET /v1/me with agent key
                              #   2. GET /v1/me with connector key
                              #   3. GET /v1/tasks?limit=1
                              # Exit 0 on green; non-zero + diagnostics on fail.
```

`hermes kanban create --mc [<slug>]` — added via the subparser-extension mechanism described in "Local-originated promotion". If the upstream extension API isn't available yet, this flag ships in plugin v1.1; v1 uses `hermes mc promote` as the operator-side path.

---

## Build.sh wiring

New section in `services/hermes/build.sh`, executed alongside the other lever-conditional sections. Pseudocode:

```bash
# MissionControl (lever: HERMES_MC_URL non-empty in .stack/.env)
if [ -n "${HERMES_MC_URL:-}" ]; then
  HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
HERMES_MC_URL=$HERMES_MC_URL
HERMES_MC_AGENT_NAME=${HERMES_MC_AGENT_NAME:-$VM}
HERMES_MC_BOARD=${HERMES_MC_BOARD:-mc}
HERMES_MC_POLL_INTERVAL=${HERMES_MC_POLL_INTERVAL:-10}
HERMES_MC_BOOTSTRAP_SINCE=${HERMES_MC_BOOTSTRAP_SINCE:-7d}
HERMES_MC_DEFAULT_PROJECT_SLUG=${HERMES_MC_DEFAULT_PROJECT_SLUG:-}
HERMES_MC_CONFLICT_SLOP_MS=${HERMES_MC_CONFLICT_SLOP_MS:-5000}
HERMES_MC_DEBUG=${HERMES_MC_DEBUG:-false}"

  # Only sync USER_PAT into the VM if still set (operator hasn't cleared it).
  if [ -n "${HERMES_MC_USER_PAT:-}" ]; then
    HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
HERMES_MC_USER_PAT=$HERMES_MC_USER_PAT"
  fi

  hermes_sync_plugin "mission-control"        # new helper — rsync plugin into VM
  hermes_enable_plugin "mission-control"      # new helper — append to plugins.enabled
  log "mission-control: HERMES_MC_URL=$HERMES_MC_URL -> managed .env block + plugin enabled"
else
  warn "mission-control: HERMES_MC_URL unset in .stack/.env — plugin not enabled"
fi
```

`hermes_sync_plugin` and `hermes_enable_plugin` are new shell helpers in `build.sh` (style mirrors existing `hermes_write` / `hermes_env_rewrite_managed_block`). Both are mount-aware: with `HERMES_MOUNT_ENABLED=true` they write Mac-side; with `false` they print the manual `orb -m` command and warn.

`hermes_enable_plugin "mission-control"` reads `~/.hermes/config.yaml`, parses (via the same pyyaml round-trip used elsewhere in `build.sh`), appends `'mission-control'` to `plugins.enabled` if absent, writes back. Idempotent.

After registration completes, the operator may delete `HERMES_MC_USER_PAT` from `.stack/.env` — the next `just build` will see it unset and stop including it in the managed block.

---

## Dashboard widget

The plugin contributes one widget to the existing settings tab. We don't claim a precedent plugin (earlier draft cited `example-dashboard`/`spotify`, neither of which exists in `services/hermes/plugins/`) — instead, the widget API used here mirrors the upstream hermes dashboard plugin contract (manifest + Python router file, like `_source/plugins/kanban/dashboard/`).

`dashboard/manifest.json`:

```json
{
  "name": "mission-control",
  "label": "MissionControl",
  "description": "Sync status with MissionControl",
  "icon": "Cloud",
  "version": "1.0.0",
  "widget": {
    "host": "settings",
    "position": "after:plugins"
  },
  "api": "plugin_api.py"
}
```

`dashboard/plugin_api.py` exposes a FastAPI `APIRouter` (mounted at `/api/plugins/mission-control/`) with:

```
GET /status   →   {
  "registered": bool,
  "url": str | null,
  "org_id": str | null,
  "agent_id": str | null,
  "connector_id": str | null,
  "loops_running": bool,
  "last_pull_ok_at": int | null,
  "last_push_ok_at": int | null,
  "consecutive_pull_errors": int,
  "consecutive_push_errors": int,
  "queue_depth": int,
  "links_total": int,
  "links_dirty": int,
  "recent_errors": [{"at": int, "where": "pull"|"push", "msg": str}]
}
```

The widget HTML (a small React component bundled into `dist/index.js`) shows these fields read-only. No actions (use the CLI for register / promote / etc.).

Implementation note: the widget bundle is built with the same upstream tooling as `_source/plugins/kanban/dashboard/`; we lift the build config (esbuild + Tailwind plugin loader) from there. The stack-side plugin ships the pre-built `dist/` artifact alongside source, so build.sh doesn't need a Node toolchain on the build host.

---

## Error handling

| Condition | Behavior |
|---|---|
| MC unreachable (connection error, timeout) | Loop backs off (5/30/120s with ±25% jitter); cursors stay; logs WARN. |
| MC 5xx | Same as unreachable. |
| MC 401 (agent key) | All loops stop. Plugin status = `auth_failed`. Logs ERROR. Re-run `hermes mc register` to recover. |
| MC 401 (connector key, on a promote path) | Push side surfaces error to caller (CLI or tool). Pull loop unaffected. |
| MC 403 | Same as 401 but message points at "permissions changed in MC; check org membership/role". |
| MC 404 on a known task | Delete the local link; archive the local task with `result='removed from mc'`; emit one local comment "MC task no longer accessible". |
| MC 409 on push (state machine) | Log WARN with both states. Re-pull canonical state from MC and apply locally. Clear `push_dirty`. |
| MC 409 on POST (idempotency conflict) | If `details.existing_task_id` matches our link → no-op success. Else log ERROR. |
| MC 422 (semantic — e.g. assigned to deleted agent) | Surface via `hermes mc status`; tasks remain unsynced until operator intervenes. |
| Kanban DB locked (rare in WAL) | Retry 3× with 50/100/200ms backoff, then log + skip the row. |
| `auth.json` corrupt / missing keys | Plugin status = `not_registered`; loops not started. |
| Ping-pong (pull then push then pull within `poll_interval + slop`) | Push reactor defers PATCH by 1 reactor tick; re-evaluates after the window passes. |

All MC error envelopes are dot-namespaced (`task.invalid_transition`, etc.). The plugin logs the full code + message + details; the dashboard widget shows the last 5.

---

## Observability

Plugin logging goes to `~/.hermes/logs/agent.log` (and stderr when `HERMES_PLUGINS_DEBUG=1`), with the logger named `hermes.plugins.mission_control`.

Metrics surfaced through `hermes mc status` (not externalized to Prometheus in v1):

- `pull.last_success_at`, `pull.last_error`, `pull.consecutive_errors`
- `push.last_success_at`, `push.last_error`, `push.queue_depth`, `push.consecutive_errors`
- `links.total`, `links.dirty`, `comments.linked`
- `loops_running`

The plugin registers no hooks, so it does not interact with `agents-observe` or other observer chains — they coexist trivially.

---

## Testing strategy

### Tests location

Pytest tests live under `services/hermes/plugins/mission-control/tests/`. The plugin ships its own `pyproject.toml` with pytest+respx as devDependencies. CI runs `cd services/hermes/plugins/mission-control && pytest tests/ -v` as a new job in the repo's CI workflow.

**PYTHONPATH strategy.** Plugin tests import `hermes_cli.kanban_db`, `gateway.run`, etc. — these aren't installed packages; they live in `services/hermes/_source/`. We add a `tests/conftest.py` that prepends `services/hermes/_source/` to `sys.path` at session start, so unmodified `import hermes_cli.kanban_db` works:

```python
# tests/conftest.py
import sys
from pathlib import Path
HERMES_SOURCE = Path(__file__).resolve().parents[4] / "services/hermes/_source"
sys.path.insert(0, str(HERMES_SOURCE))

import pytest
@pytest.fixture(autouse=True)
def _scrub_gateway_marker(monkeypatch):
    # _HERMES_GATEWAY=1 is set at module-import of gateway.run; scrub it
    # so unit tests don't falsely trigger the gateway loop-startup path.
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.delenv("HERMES_KANBAN_TASK", raising=False)
```

CI needs the hermes source tree checked out at `services/hermes/_source/` (already the case for the rest of the stack — confirmed in `services/hermes/build.sh`'s vendoring step). No extra checkout step needed.

This is a new convention for stack-side plugins (agents-observe ships no tests today). We pick this approach because (a) it keeps plugin tests close to plugin code, (b) it doesn't require touching the upstream hermes test infrastructure, (c) it lets the plugin pin its own pytest version without coordinating with upstream.

### Unit tests (pytest, mocked HTTP)

| File | Coverage |
|---|---|
| `tests/test_status_map.py` | Every local↔MC status mapping; metadata patching; failure-vs-success disambiguation; event-kind→PATCH mapping. |
| `tests/test_links_db.py` | Schema migration; cursor advance; dirty-flag lifecycle; comment-link dedup; apply-log purge; denormalized `local_status` updates. |
| `tests/test_client.py` | Each MC endpoint wrapper (using `respx`): success path, 401, 5xx-with-retry, 409-with-existing-id, idempotency header inclusion, cursor pagination on comments. |
| `tests/test_registrar.py` | PAT-flow happy path; existing-agent-rotation path (mints connector if missing); no-PAT path returns inert; 401 PAT; project caching to `~/.hermes/mission-control/projects.json`. |
| `tests/test_apply.py` | `handle_one_task` for each of 6 (state × link-presence) combinations; `handle_one_comment` with and without auto-unblock; mc_apply_log capture. |
| `tests/test_pull.py` | End-to-end pull cycle: new task creation, status update, comment pull, cursor advancement only after both phases, conflict detection. |
| `tests/test_push.py` | Status push for each event kind, `completed`-event outcome-disambiguation via `latest_run`, comment push, dirty-flag clearing, retry-after-cooldown, comment dedup. |
| `tests/test_auto_unblock.py` | Pulled comment on `blocked` task triggers `kanban_db.unblock_task`; pulled comment on `running` task does NOT; defense-in-depth `mission-control:` author filter. |
| `tests/test_loop_guard.py` | `register(ctx)` skips loop startup when `_HERMES_GATEWAY!=1` or `HERMES_KANBAN_TASK` set; tools still register; CLI still registers. |
| `tests/test_promote_idempotency.py` | `mc_promote_task` re-call returns `already_linked=true`; 409 from MC with non-matching existing id surfaces as error. |

### Integration tests

`tests/integration/test_end_to_end.py` — spins up `wrangler dev` against MC's single-DB-mode build (uses the existing `pnpm test` infrastructure as a fixture in `services/mission-control/`), bootstraps a user + agent + project via the bootstrap endpoint, registers the plugin against that URL, then exercises:

1. Operator creates an MC task assigned to agent → plugin pulls → local kanban row appears.
2. Local dispatcher transitions `ready → running` → MC PATCH lands (verified via GET /v1/tasks/:id) → next pull is a no-op (the local update was already echoed via `mc_apply_log` suppression; the MC GET returns the same updated_at our PATCH set).
3. Operator POSTs MC comment on a non-blocked task → plugin pulls → kanban comment appears.
4. Operator POSTs MC comment on a `blocked` task → local task auto-unblocks.
5. Agent (in a simulated worker) calls `mc_promote_task(local_id)` → MC POST → link inserted with `source='pushed'`.
6. MC task gets `cancelled` → local task gets `archived`.
7. Worker writes a comment via `kanban_db.add_comment` → push reactor mirrors to MC → next pull no-ops (dedup via mc_comment_links).

Integration tests live behind a `pytest -m integration` marker, skipped when `MC_INTEGRATION_TEST_URL` is unset.

### Build-sh test

A new test in `services/hermes/build.test.sh` covers the managed-block injection of MC keys (matrix: `HERMES_MC_URL` set/unset, `HERMES_MC_USER_PAT` set/unset, second-build idempotency).

---

## Upstream Hermes changes required

The plugin spec depends on small additions to the upstream hermes-agent codebase, all separately reviewable and small:

1. **`kanban_db.list_events_since(conn, last_id, limit) -> list[Event]`** — public helper: `SELECT id, task_id, kind, payload, run_id, created_at FROM task_events WHERE id > ? ORDER BY id ASC LIMIT ?`. **Order by `id` strictly**, NOT `created_at` (1-sec tie risk). ~15 lines. If upstream rejects, the plugin runs the raw SQL against `kanban_db.connect(board=...)`.
2. **`PluginContext.register_subcommand_extension(parent_cmd, extender_fn)`** — lets a plugin add flags/subparsers to an existing built-in subcommand parser (kanban, in our case). ~30 lines. **Optional** for plugin v1: if not landed, `hermes kanban create --mc` ships in plugin v1.1; v1 ships `hermes mc promote` instead.

(An earlier draft also proposed a `HERMES_GATEWAY=1` env marker — review noted the existing `_HERMES_GATEWAY` already does this. No new env-marker change is needed.)

(`kanban_db.latest_run` already exists and is reused for closing-run lookup; no upstream change for that path.)

These upstream changes are tracked as separate hermes-stack tasks; the plugin's plan starts with the PR for #1. #2 is plugin-v1.1-conditional.

---

## What's NOT in v1

- Multi-org per VM (one MC org per VM).
- Multi-pool awareness (MC v1 is single-pool).
- MC `GET /v1/events` consumption (deferred to MC v1.1).
- SSE push from MC (when MC adds it, the pull loop becomes a WebSocket; nothing else changes).
- Heartbeat endpoint (v1.1 MC-side).
- Rate-limit handling (MC v1 has stub rate-limiting).
- Conflict-of-record resolution beyond last-writer-wins.
- Local task → MC project autocreate (promotion requires an existing MC project; otherwise the CLI errors with "create the project in MC first").
- Comments from `agents-observe` events echoing to MC.
- `hermes kanban create --mc <slug>` if `register_subcommand_extension` doesn't land in upstream by v1.

---

## Future work (out of scope here)

- **Multi-VM coordination.** Two Hermes VMs both registered in the same MC org work trivially — each has its own agent_id + key; pull loops filter by own agent_id.
- **Auto-refresh project cache** when MC ships project.created events.
- **MCP server façade** wrapping the MC tools so other MCP clients (Claude Code, etc.) can use the same MC connection without the plugin.
- **Per-task quota / fairness.** Dispatcher's `kanban.parallel_limit` already controls worker concurrency; the plugin does no rate shaping itself.

---

## Resolved design questions (review trail)

- ~~How does the agent map to local kanban?~~ → tenant tag `mc:<org_id>:<project_id>` on the kanban row + plugin-owned `mc_links` table on a dedicated board.
- ~~Where do plugin tables live?~~ → Separate SQLite at `~/.hermes/mission-control/links.db`.
- ~~Why two MC credentials per VM?~~ → MC agent role can't `POST /v1/tasks`; promotion needs connector role.
- ~~How does the plugin surface human feedback to a running worker?~~ → It doesn't directly. Comments land in `kanban_db`; the next worker invocation orients on them. `blocked` tasks auto-unblock when a new MC comment arrives, so the dispatcher re-spawns the worker with the comment in context.
- ~~How do we avoid pulled-status updates triggering a push that mirrors the same value back?~~ → `mc_apply_log` table records every `task_events.id` written by the pull-apply path; the push reactor skips any event id present there. Defense-in-depth: the `mission-control:` author prefix on pulled comments. (Earlier draft also had a "ping-pong window" defer; rev-3 review showed it was over-cautious and removed it.)
- ~~How do we run async loops from a sync `register()` callsite?~~ → Daemon thread that owns its own asyncio event loop, matches the agents-observe pattern.
- ~~Polling cadence?~~ → Default 10s, min 2s.
- ~~Push trigger?~~ → Tail `task_events` on the MC-pinned board with a 1s SQLite poll; cursor in `links.db`.
- ~~Which kanban board do MC tasks live in?~~ → A dedicated one, slug `HERMES_MC_BOARD` (default `"mc"`). Plugin always passes `board=` to kanban_db calls.
- ~~How does the plugin know it's in the gateway?~~ → Existing `_HERMES_GATEWAY=1` env marker set at module-import of `gateway/run.py`. Worker subprocesses are identified by `HERMES_KANBAN_TASK`.
- ~~How are kanban event kinds mapped to MC?~~ → Per the table in "Event kinds the push reactor observes" — uses real kanban event-kind names (claimed, blocked, unblocked, completed with outcome, archived, scheduled, commented).
