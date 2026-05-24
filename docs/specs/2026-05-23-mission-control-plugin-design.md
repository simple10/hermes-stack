# Hermes ↔ MissionControl Plugin — Design

**Status:** Draft for review (rev 4 — events-driven architecture)
**Date:** 2026-05-23
**Scope:** v1 of the Hermes stack-side plugin that wires a Hermes VM to a MissionControl (MC) deployment.
**Sibling spec:** `services/mission-control/docs/specs/2026-05-22-master-api-design.md` (MC API)

This spec covers the Hermes-side integration only.

---

## Goal

Give one Hermes VM a single-paste setup to:

1. **Subscribe** to MC's `GET /v1/events` stream and react to task/comment changes for tasks assigned to this VM's agent identity.
2. **Mirror** local kanban status + comments back to MC so the human can see live progress from MC's UI (or Notion via a connector).
3. **Promote** local-originated tasks up to MC explicitly via a CLI flag or LLM-callable tool.
4. **Auto-unblock** a `blocked` local task when the human leaves a new comment via MC, so the dispatcher re-spawns the worker with that comment in context.

User mental model: *"I assign a task to my Hermes VM from Notion / the MC UI. Hermes picks it up, works on it, posts status updates and comments as it goes, asks for clarification when it needs to, and I can talk back through the same MC task — without ever SSHing into the VM."*

### Process locality

Hermes' plugin loader calls `register(ctx)` in every Hermes process: the gateway, every dispatcher-spawned worker, and ad-hoc CLI invocations. The plugin must be safe to load anywhere; **the polling thread runs ONLY in the gateway**.

Loop-startup guard in `register(ctx)`:

```python
def _is_gateway() -> bool:
    # Reuse the existing _HERMES_GATEWAY marker set at module-import of
    # gateway/run.py:543 and already consumed by cli.py:539. The negative
    # HERMES_KANBAN_TASK check excludes dispatcher-spawned workers (which
    # inherit env vars from the gateway).
    return os.environ.get("_HERMES_GATEWAY") == "1" and not os.environ.get("HERMES_KANBAN_TASK")
```

Tools and CLI register unconditionally so workers can invoke `mc_promote_task`. Only the polling thread is gated.

**Test-env note:** `_HERMES_GATEWAY=1` is set at module-import of `gateway/run.py`, so any test that imports gateway code would falsely trigger the gateway path. Plugin unit tests use `monkeypatch.delenv("_HERMES_GATEWAY", raising=False)` in their fixtures.

---

## MC version requirements

The plugin requires MC v1 + the small set of pulled-from-v1.1 features listed below. All three landed in MC alongside the plugin spec:

| Plugin v1 needs | Status |
|---|---|
| `POST /v1/agents` + key minting (PAT-role) | MC v1. |
| `POST /v1/connectors` + key minting (PAT-role, owner/admin) | MC v1. (Earlier spec drafts tagged "v1.1" in one annotation table; corrected.) |
| `POST /v1/agents/:id/rotate-key` + same for connectors | MC v1. |
| `GET /v1/me` | MC v1. |
| `GET /v1/events?since=…&kinds=…&limit=…` | **Pulled into MC v1** (was v1.1). The first consumer is this plugin. |
| `PATCH /v1/tasks/:id` (agent role, own tasks, status + metadata) | MC v1. |
| `POST /v1/tasks` (connector role) | MC v1. |
| `POST /v1/tasks/:id/comments` (agent + connector roles) | MC v1. |
| `POST /v1/external_refs` (agent role) | MC v1. |
| `GET /v1/tasks/:id` (one-shot fetch, for hydrate-after-event) | MC v1. |
| `GET /v1/projects` (PAT role, for project-list cache) | MC v1. |
| Idempotency-key regex validation | **Pulled into MC v1** (was v1.1). Plugin keys (`hermes:<task_id>`, `mc:<mc_task_id>`, etc.) match the format. |

Plugin does NOT depend on: `GET /v1/tasks/:id/comments` pagination (the events stream carries comment-created events), heartbeats, SSE, server-side cursors, or per-row event visibility for agent role.

---

## Architecture

```
┌─ MissionControl (Cloudflare Workers + D1, cloud) ─────────────────────────┐
│  GET   /v1/me                         (any key)                           │
│  GET   /v1/events?since=…&kinds=…     (connector key)                     │
│  GET   /v1/tasks/:id                  (one-shot hydrate, connector key)   │
│  PATCH /v1/tasks/:id                  (agent key)                         │
│  POST  /v1/tasks                      (connector key)                     │
│  POST  /v1/tasks/:id/comments         (agent key)                         │
│  POST  /v1/external_refs              (agent key)                         │
└──────────────────────────▲──────────────────────┬─────────────────────────┘
                           │ Bearer mcagt_…       │ Bearer mccnn_…
                           │                      │
┌─ Hermes VM (in gateway, via a daemon thread) ───┴────────────────────────┐
│                                                                            │
│  ┌─ plugin: mission-control ────────────────────────────────────────────┐ │
│  │                                                                       │ │
│  │  config.py    — env loading; auth.json read/write w/ mtime cache     │ │
│  │  client.py    — httpx wrapper: events_list, tasks_*, comments_*,     │ │
│  │                  external_refs, agents/connectors lifecycle, projects│ │
│  │  registrar.py — PAT → agent + connector keys; project cache          │ │
│  │  links_db.py  — schema + helpers (mc_links, mc_comment_links,         │ │
│  │                  mc_apply_log, mc_event_cursor)                       │ │
│  │  pull.py      — events loop (GET /v1/events, dispatch via apply.py)  │ │
│  │  push.py      — kanban task_events reactor (PATCH back to MC)        │ │
│  │  apply.py     — kind-dispatch table for incoming MC events           │ │
│  │  status_map.py — single source of truth for local↔MC status         │ │
│  │  tools.py     — mc_promote_task tool                                │ │
│  │  cli.py       — `hermes mc {register,status,promote,refresh-…,…}` │ │
│  │  runtime.py   — daemon thread that runs asyncio.run(both_loops())   │ │
│  │  __init__.py  — register(ctx); detects gateway; starts thread       │ │
│  │  plugin.yaml                                                         │ │
│  │  README.md                                                           │ │
│  │  dashboard/                                                          │ │
│  │    manifest.json — widget on the settings tab                       │ │
│  │    plugin_api.py — GET /api/plugins/mission-control/status          │ │
│  │  tests/        — pytest                                              │ │
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

Why a thread (not `asyncio.create_task` on the gateway's loop): plugin `register(ctx)` is called from plain-sync discovery context, BEFORE `asyncio.run(start_gateway())`. The agents-observe plugin uses the same daemon-thread pattern.

| Loop | Cadence | Reads | Writes |
|---|---|---|---|
| **Pull loop** | `MC_POLL_INTERVAL` (default 10s; min 2s) | `GET /v1/events?since=<cursor>&kinds=task,comment,external_ref&limit=100` (connector key) | Dispatches each event via `apply.py`; updates `mc_event_cursor`; records applied kanban events in `mc_apply_log` |
| **Push reactor** | Tails kanban `task_events` (1s SQLite poll) on the MC-pinned board | `task_events` rows since cursor, skipping ids in `mc_apply_log`; cross-checks `mc_links` membership | `PATCH /v1/tasks/:id` (status), `POST /v1/tasks/:id/comments` (locally-authored), `POST /v1/external_refs` (on first promotion); clears `push_dirty`, updates `last_pushed_at` + `last_terminal_state` |

**Failure isolation:** MC outages must never block the kanban dispatcher or freeze the gateway. Each loop catches `httpx.RequestError` / `httpx.HTTPStatusError` for 5xx / `asyncio.TimeoutError`, backs off (5s → 30s → 120s with ±25% jitter), logs WARN per failure and INFO on recovery, never advances cursors on failure. On 401: all loops stop, plugin status = `auth_failed`, ERROR logged with remediation; re-run `hermes mc register` to recover.

Loops run only after `register(ctx)` confirms `_is_gateway() == True` AND `~/.hermes/auth.json` has a `mission_control` block with non-empty agent + connector keys.

### Why events-driven (vs tasks+comments polling)

Earlier drafts of this spec had the plugin polling `GET /v1/tasks?updated_since=…` plus per-link `GET /v1/tasks/:id/comments?cursor=…`. That works for tasks (which have a since-filter) but is awkward for comments (no since-filter; cursor doesn't survive empty pages well). MC v1 already maintains an `events` append-only table for exactly this use case — the read endpoint was deferred only because no consumer existed yet. With the plugin as the first consumer, MC promotes `GET /v1/events` to v1 and the plugin's pull loop becomes:

- One cursor (highest `events.id` seen) instead of one per-tasks-cursor + one per-link comment cursor.
- One endpoint instead of two with per-link iteration.
- Event payloads carry the data needed to apply locally (full task on `task.created`, full comment on `comment.created`, status diff on `task.status_changed`); fetch-on-demand for `task.updated` non-status diffs via `GET /v1/tasks/:id`.
- Future SSE upgrade (v1.1) is a transport swap on the same endpoint, no architectural change.

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
  pull.py                  # events loop
  push.py                  # kanban task_events reactor
  apply.py                 # MC event-kind dispatch
  status_map.py
  tools.py
  cli.py
  runtime.py               # daemon thread + lifecycle
  README.md
  dashboard/
    manifest.json
    plugin_api.py
  tests/
    conftest.py
    test_status_map.py
    test_links_db.py
    test_client.py
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
description: "Bidirectional sync between this Hermes VM and a MissionControl deployment. Subscribes to MC's events stream for tasks/comments assigned to this VM; mirrors local status back; auto-unblocks tasks when a human comments via MC."
author: hermes-stack
kind: standalone
requires_env:
  - HERMES_MC_URL
provides_tools:
  - mc_promote_task
```

No hooks. The plugin runs background loops + provides a tool + adds a CLI command + ships a dashboard widget.

The plugin opts in via the existing `plugins.enabled` allow-list in `~/.hermes/config.yaml` — `build.sh` appends `mission-control` on the first build that has `HERMES_MC_URL` set (idempotent: `hermes_enable_plugin "mission-control"`).

---

## Configuration

### Stack-side `.stack/.env` levers (in the `#>--- hermes ---` block)

```
HERMES_MC_URL=                       # base URL (e.g. https://mc.example.com)
HERMES_MC_USER_PAT=                  # one-time mcpat_… PAT for first-run; clear after
HERMES_MC_AGENT_NAME=                # override; default = OrbStack VM name
HERMES_MC_BOARD=mc                   # dedicated kanban board for MC tasks
HERMES_MC_POLL_INTERVAL=10           # seconds between event-poll cycles (min 2)
HERMES_MC_BOOTSTRAP_SINCE_DAYS=7     # ignore MC events older than this many days
                                     # on first sync (avoid replaying years of history)
HERMES_MC_DEFAULT_PROJECT_SLUG=      # used by `hermes kanban create --mc`
HERMES_MC_DEBUG=false                # extra DEBUG-level logs
```

All keys carry the `HERMES_MC_` prefix all the way into the VM (no rename in the managed `.env` block).

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

`config.py` loads this once and caches in module state with mtime invalidation. Avoids per-worker disk hits in hot kanban paths.

`HERMES_MC_USER_PAT` is read only when `auth.json` lacks a `mission_control` block (first run) OR when the operator explicitly runs `hermes mc register` / `refresh-projects`. After first run, the operator may delete `HERMES_MC_USER_PAT` from `.stack/.env`.

### Two keys per VM (with distinct roles)

- **Agent key** (`mcagt_…`) — status PATCH, comment POST, external_ref POST. Scope: read/update/comment on own tasks (`agent_id == principal_id`). All `external_refs` rows the plugin creates use `source_kind='hermes'`, `source_id=self_agent_id` (the agent role enforces this match).
- **Connector key** (`mccnn_…`) — events stream poll, one-shot task hydrate, local-originated promotion (`POST /v1/tasks`). Scope: full task/project CRUD + events read for the org. This is the right surface for "this VM is also a task source and an org-wide event consumer."

Why the events poll uses the connector key (not the agent key): MC's events stream is a whole-org change feed; per-row visibility filtering by `agent_id` would require joining events to the underlying resource on every read, which is expensive. The plugin filters events client-side (skip events for tasks where `agent_id != self_agent_id`).

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
  last_event_applied   INTEGER NOT NULL DEFAULT 0,    -- highest MC event id applied to this link
  last_pushed_at       INTEGER NOT NULL DEFAULT 0,    -- mc updated_at returned by our PATCH
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

-- Single global cursor pair: MC events id (pull loop) and local kanban
-- task_events id (push reactor).
CREATE TABLE IF NOT EXISTS mc_cursors (
  k           TEXT    PRIMARY KEY,              -- 'events' (MC) or 'kanban_events' (local)
  cursor      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
```

**Why a separate DB:** the upstream kanban schema is owned by hermes; we don't add columns to it. Plugin tables live in their own SQLite (WAL mode, multi-writer-safe — gateway pull/push + occasional worker promotion call all open the same file).

**Denormalized `local_status`:** updated transactionally in `links.db` every time we apply an MC event or observe a kanban event. Lets `list_active_links()` be a pure links.db query (no per-link kanban-DB hit). Stale by at most one event cycle.

**No `last_comment_cursor` column** (rev-3 had one) — comments arrive via the unified `comment.created` event in the MC events stream; no per-link comment paging needed.

**`mc_apply_log`:** the anti-feedback mechanism. When `apply.py` writes a status change or comment to kanban (via the proper kanban_db helper), it captures the resulting `task_events.id`s (via pre/post-MAX range on the same kanban connection) and inserts them here. The push reactor's query filters out anything in this log. Bounded — entries older than 24h are purged on idle ticks.

**Drift handling:**
- If a kanban task referenced by `mc_links.local_task_id` is hard-deleted (rare; archive is the normal path), the push reactor sees no row, logs WARN, deletes the orphan link.
- If a `task.deleted` event arrives for a linked task, archive the local task with `result='removed from mc'`.

### Status mapping (`status_map.py`)

Hermes local statuses: `triage`, `todo`, `scheduled`, `ready`, `running`, `blocked`, `review`, `done`, `archived`.
MC statuses: `pending`, `ready`, `in_progress`, `blocked`, `completed`, `failed`, `cancelled`.

| Hermes local | MC | Mechanism |
|---|---|---|
| `triage` | (no push — wait until promotion) | Link doesn't exist yet for unpushed tasks. |
| `todo` (with parents not done) | (no push) | Same. |
| `todo` (no parents) | `pending` | Only meaningful for connector-pushed tasks pre-assignment. |
| `scheduled` | `ready` | `metadata.scheduled_for: <iso8601>` carried in PATCH body. |
| `ready` | `ready` | Direct. |
| `running` | `in_progress` | MC sets `started_at` on ready→in_progress. |
| `blocked` | `blocked` | `metadata.block_reason` from `block_task`'s `reason` arg. |
| `review` | `in_progress` | `metadata.review_pending: true`. |
| `done` + `last_terminal_state == 'completed'` | `completed` | Source of truth is the link, not result-string parsing. |
| `done` + `last_terminal_state == 'failed'` | `failed` | Set by push reactor when it observes a `completed` event whose `latest_run.outcome` is not `completed`. |
| `archived` | `cancelled` | `metadata.cancellation_reason` if known. |

| MC event kind | Local action |
|---|---|
| `task.created` (payload: `{task: full row}`) | If task.agent_id == our agent_id AND no link exists: `kanban_db.create_task(conn, ..., initial_status='ready', tenant=f'mc:{org_id}:{project_id}', assignee=our_agent_id, idempotency_key=f'mc:{mc_task_id}', board=cfg.board)`. Insert link `source='pulled', local_status='ready'`. POST `/v1/external_refs` with the agent key. If task.agent_id != us: skip. |
| `task.assigned` (payload: `{from, to}`) | If `to == our_agent_id` AND no link: hydrate via `GET /v1/tasks/:id` and apply the create-flow above. If `from == our_agent_id` AND we have a link: log info; the task is no longer ours but we keep the link until a terminal event arrives (so we still see status changes the new agent makes). |
| `task.status_changed` (payload: `{from, to, reason?}`) | If link exists: apply `to` via the appropriate kanban_db helper (block_task / complete_task / archive_task / no-op for transient transitions the dispatcher already owns). Update `link.local_status` + `last_terminal_state` if terminal. |
| `task.updated` (payload: `{changed: {field: [old, new]}}`) | v1: ignore non-status changes (the plugin's local kanban row keeps its original title/body; humans refer to MC for the latest). v1.1 may add re-fetch + local mirror. |
| `task.deleted` | If link exists: `kanban_db.archive_task(conn, local_task_id)` + `link.last_terminal_state='cancelled'` + record apply. |
| `comment.created` (payload: `{comment: full row}`) | If link exists for the parent task AND `mc_comment_links.has_mc(comment.id) is False`: `kanban_db.add_comment(conn, local_task_id, author=f'mission-control:{comment.author_type}:{comment.author_id}', body=comment.body)`. Record apply. Insert `mc_comment_links(source='pulled')`. If `link.local_status == 'blocked'`: auto-unblock via `kanban_db.unblock_task(conn, local_task_id)` (after first appending a system-comment "auto-unblock: new comment from <author_type>"). |
| `comment.deleted` | v1: ignore. (Comment stays in local kanban for audit.) |
| `external_ref.added` / `external_ref.removed` | v1: ignore. (Plugin posts its own external_refs; others' refs aren't actionable here.) |
| `agent.*` / `connector.*` / `project.*` | v1: ignore. (Plugin doesn't react to org topology changes.) |

`apply.py` exposes one function per event kind plus a dispatch table; unknown kinds (forward-compat with future MC versions) are logged at DEBUG and skipped.

---

## Sync semantics

### kanban_db helpers used (verified signatures from `services/hermes/_source/hermes_cli/kanban_db.py`)

- `connect(db_path=None, *, board=None) -> sqlite3.Connection`
- `create_task(conn, *, title, body=None, assignee=None, ..., tenant=None, idempotency_key=None, initial_status='running', board=None) -> str` — we pass `initial_status='ready'`, `tenant=f'mc:{org_id}:{project_id}'`, `idempotency_key=f'mc:{mc_task_id}'`.
- `add_comment(conn, task_id, author, body) -> int`
- `block_task(conn, task_id, *, reason=None, expected_run_id=None) -> bool`
- `unblock_task(conn, task_id) -> bool`
- `complete_task(conn, task_id, *, result=None, summary=None, metadata=None, created_cards=None, expected_run_id=None) -> bool`
- `archive_task(conn, task_id) -> bool`
- `latest_run(conn, task_id) -> Optional[Run]` — used by the push reactor to look up `task_runs.outcome` when processing a `completed` event.
- Plugin runs raw SQL `SELECT id, task_id, kind, payload, run_id, created_at FROM task_events WHERE id > ? ORDER BY id ASC LIMIT ?` directly against the kanban connection for the push reactor's tail. `services/hermes/_source/` is gitignored (separately-cloned upstream tree), so we don't add a helper upstream for v1; raw SQL is the documented fallback.

**`tasks.idempotency_key` is NOT uniquely indexed.** Existing index is non-unique; kanban_db dedups by SELECT-then-INSERT. The pull loop is single-writer (only the gateway runs it), so the race is not a real problem.

### Event kinds the push reactor observes

Real kanban event kinds (audited from `_append_event` callsites):

`assigned`, `blocked`, `commented`, `promoted`, `scheduled`, `spawned`, `claimed`, `archived`, `completed`, `unblocked`, `completion_blocked_hallucination`.

The push reactor maps them:

| Event kind | Mapped MC PATCH (or POST) |
|---|---|
| `claimed` | PATCH status=`in_progress` |
| `blocked` | PATCH status=`blocked` + `metadata.block_reason` from payload |
| `unblocked` | PATCH status=`ready` (or `in_progress` if a `spawned` follows within 1s; reactor coalesces) |
| `completed` | PATCH MC status — first call `kanban_db.latest_run(conn, ev.task_id)` to read `Run.outcome`. Map: `outcome='completed'` → MC `completed`; everything else (`crashed`, `timed_out`, `spawn_failed`, `gave_up`, `reclaimed`, `blocked`) → MC `failed` + `metadata.failure_reason = task.last_failure_error or task.result or f'kanban outcome: {outcome}'`. The `completed` event payload itself does not carry outcome — outcome lives on `task_runs`. Always set `link.last_terminal_state`. |
| `completion_blocked_hallucination` | PATCH MC status=`failed` + `metadata.failure_reason='hallucinated subtask references; see kanban logs'`. Set `link.last_terminal_state='failed'`. |
| `archived` | PATCH status=`cancelled` |
| `scheduled` | PATCH status=`ready` + `metadata.scheduled_for` |
| `commented` | POST /v1/tasks/:id/comments unless filtered by `mc_comment_links.has_local()` or `author.startswith('mission-control:')` |
| `assigned`, `promoted`, `spawned` | No push (local-only details) |

### Pull loop

```python
async def pull_loop():
    backoff = Backoff(base=5, factor=2, cap=120, jitter=0.25)
    while not _stopping:
        try:
            cursor = links_db.get_cursor('events')
            highest = cursor
            had_more = True
            while had_more:
                resp = await client.events_list(
                    connector_key=cfg.connector_key,
                    since=highest,
                    kinds='task,comment,external_ref',
                    limit=100,
                )
                events = resp['events']
                for ev in events:
                    if ev['id'] <= cfg.bootstrap_min_event_id:
                        continue   # skip pre-bootstrap history
                    await apply.handle_one_event(ev)
                    highest = max(highest, ev['id'])
                had_more = bool(resp.get('next_cursor')) or len(events) >= 100
                # next_cursor (when present) is for within-since-window paging.
                # Once we drain, we advance `since` and re-poll on the normal
                # interval — no need to follow next_cursor across loop iterations.
                # Break early once we've drained the window.
                if not events:
                    break

            links_db.set_cursor('events', highest)
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

**`cfg.bootstrap_min_event_id`:** at registration time, the registrar calls `client.events_list(since=0, limit=1)` to get the current head of the events stream, then sets `bootstrap_min_event_id` to `head_id - (HERMES_MC_BOOTSTRAP_SINCE_DAYS converted to estimated event count)`. Approximation: for a fresh agent we want to start at "now"; for one that's been offline a few days we want to replay recent history. Simpler v1 approach: at registration time set `events` cursor to `0` and use `bootstrap_min_event_id = head_id - 100000` (skip everything before — practically "now-ish"). The exact tunable behavior can live in a config; the spec just needs to make sure we don't replay years of history on first run.

Actually simpler still: at registration time, set the `events` cursor to the current head id minus a "small replay window" (e.g. last 1000 events). The plugin will see the last day or so of events, dedup via idempotency keys / link membership, and proceed. No need for the `bootstrap_min_event_id` separate filter.

**`apply.handle_one_event(ev)`** dispatches on `ev['kind']` per the table in "Status mapping" above. Each handler opens a kanban connection on demand and captures the resulting `task_events.id`s via pre/post-MAX range into `mc_apply_log`:

```python
def _apply_with_log(local_task_id, fn, *args, **kwargs):
    """Wrap a kanban_db mutation. Captures any task_events rows it emits
    for this task into mc_apply_log so the push reactor skips them."""
    with kanban_db.connect(board=cfg.board) as conn:
        pre_max = conn.execute(
            "SELECT IFNULL(MAX(id), 0) FROM task_events WHERE task_id = ?",
            (local_task_id,)).fetchone()[0]
        result = fn(conn, local_task_id, *args, **kwargs)
        post_max = conn.execute(
            "SELECT IFNULL(MAX(id), 0) FROM task_events WHERE task_id = ?",
            (local_task_id,)).fetchone()[0]
        with links_db.connect(cfg.links_db_path()) as ldb:
            for event_id in range(pre_max + 1, post_max + 1):
                links_db.record_apply(ldb, event_id=event_id, link_id=local_task_id)
        return result
```

The pre/post-MAX range correctly captures every event the helper emitted for this task (no other writer touches the same task_id concurrently — the dispatcher and pull loop are serialized on per-task state via the link).

### Push reactor

The kanban dispatcher writes `task_events` rows on every status change, comment, etc. We tail this table on a 1s SQLite poll (cheap in WAL):

```python
async def push_reactor():
    last_event_id = links_db.get_cursor('kanban_events')
    backoff = Backoff(base=5, factor=2, cap=60, jitter=0.25)
    while not _stopping:
        try:
            with kanban_db.connect(board=cfg.board) as kconn:
                rows = kconn.execute(
                    "SELECT id, task_id, kind, payload, run_id, created_at "
                    "FROM task_events WHERE id > ? ORDER BY id ASC LIMIT 200",
                    (last_event_id,)).fetchall()

            with links_db.connect(cfg.links_db_path()) as ldb:
                for r in rows:
                    last_event_id = r['id']
                    if links_db.is_in_apply_log(ldb, r['id']):
                        continue   # echo of a pulled event — skip
                    link = links_db.get_link(ldb, r['task_id'])
                    if not link:
                        continue   # not an MC-mirrored task
                    await _handle_kanban_event(link, r)
                links_db.set_cursor(ldb, 'kanban_events', last_event_id)

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

`_handle_kanban_event(link, r)` consults `status_map.event_kind_to_patch(r.kind, r.payload)` for status events; for `commented` events, filters via `mc_comment_links.has_local(r.payload.get('comment_id'))` AND a defensive check that the comment author doesn't start with `mission-control:`. For `completed` events, calls `kanban_db.latest_run(conn, r.task_id)` and uses the `Run.outcome` per the mapping table.

On successful PATCH/POST: clear `push_dirty`, update `link.last_pushed_at` to the response's `updated_at`, set `link.last_terminal_state` if terminal. On failure: leave `push_dirty=1`, set `push_failed_until=now+backoff`. On 409 state-machine conflict: re-pull MC's canonical state (via the events stream's natural delivery), clear `push_dirty`.

No ping-pong defer needed — `mc_apply_log` suppresses pull→push echoes, and any remaining race (operator changes MC after our PATCH within the cursor window) is just last-writer-wins, which is the documented v1 semantic.

### Comment dedup

Bidirectional dedup uses two mechanisms layered together:

- **Pull direction (MC → local):** before adding a comment, check `mc_comment_links.has_mc(mc_comment.id)`. If true → already mirrored; skip. Else → add comment with author prefix `mission-control:<author_type>:<author_id>` and insert `mc_comment_links(source='pulled')`.
- **Push direction (local → MC):** the reactor's `commented` handler filters by (a) `mc_comment_links.has_local(local_comment_id)` AND (b) author prefix check (skip if author starts with `mission-control:`). This is defense-in-depth — if a future bug skips the `mc_comment_links` insert, the author prefix catches it. On successful POST, insert `mc_comment_links(source='pushed')` with the MC's returned `cmt_…` id.

### Local-originated promotion

User runs `hermes mc promote <local_task_id> [--project <slug>]` or the LLM calls `mc_promote_task(local_task_id, project_slug=None)`. Flow:

1. Resolve `project_slug → project_id` via `~/.hermes/mission-control/projects.json` (cached). Fail with friendly error pointing to `hermes mc refresh-projects` if unknown.
2. Look up `links_db.get_link(local_task_id)` — if present, return `{mc_task_id: existing, already_linked: True}`.
3. Read local kanban task via `kanban_db.connect(board=cfg.board)` + `kanban_db.get_task(conn, local_task_id)`.
4. `client.tasks_create(connector_key=cfg.connector_key, project_id=project_id, title=task.title, body=task.body, agent_id=cfg.agent_id, idempotency_key=f'hermes:{local_task_id}', metadata={'origin': 'hermes'})`. Header `Idempotency-Key: hermes:{local_task_id}`.
5. On `IdempotencyConflict` whose `existing_task_id` matches our link → return `already_linked=True`. Mismatch → log ERROR + raise to caller.
6. Insert `mc_links(local_task_id, mc_task_id, source='pushed', last_pushed_at=mc_task.updated_at, local_status='ready', ...)`.
7. POST `/v1/external_refs` with the **agent** key (`source_id=cfg.agent_id`, `idempotency_key=f'hermes:xrf:{local_task_id}'`).
8. Return `{mc_task_id, already_linked: False}`.

The MC `task.created` event for this newly-created task will arrive in the next pull cycle. The apply handler sees we already have a `mc_links` row for `mc_task_id`, so it's a no-op.

### Idempotency keys

All keys conform to MC's regex `^[a-z][a-z0-9_-]{0,31}:.{1,200}$` (1-32 char source prefix + colon + payload).

| Operation | Key |
|---|---|
| Pull → create local task | `kanban_db.create_task(..., idempotency_key=f'mc:{mc_task_id}')` |
| Push → create MC task (promotion) | Header `Idempotency-Key: hermes:<local_task_id>` + body field `idempotency_key: hermes:<local_task_id>`. Both layers. |
| Push → MC PATCH | None needed; PATCH is naturally idempotent (we always send the full desired status + metadata). |
| Push → comment | Header `Idempotency-Key: hermes:cmt:<local_comment_id>` |
| Push → external_ref | Header `Idempotency-Key: hermes:xrf:<local_task_id>` (also second-layer dedup via MC's unique index on `(resource_type, resource_id, source_kind, source_id)`) |

---

## Surfacing MC comments to running work

`ctx.inject_message()` only delivers to the host's interactive CLI — workers are separate `hermes -p <profile>` subprocesses and are NOT addressable that way. The existing Hermes worker pattern: workers don't poll comments mid-flight; new comments become visible on the NEXT worker invocation, where the kanban-worker skill's standard "orient" step calls `kanban_list_comments` and includes them in context.

Two mechanisms cover this:

1. **All MC comments → local kanban thread.** `comment.created` events land via `kanban_db.add_comment(conn, task_id, author=f'mission-control:{author_type}:{author_id}', body=...)`. Permanent, visible in dashboard / CLI / `kanban_list_comments`. Next worker invocation sees them.
2. **MC comment on a `blocked` task → auto-unblock.** When the apply handler sees a `comment.created` event for a task whose `link.local_status == 'blocked'`, it calls `kanban_db.unblock_task(conn, local_task_id)` after writing the comment. The dispatcher re-claims the task on its next tick and spawns a new worker, which orients via `kanban_list_comments` and sees the human's response.

Comments on `running`/`ready`/other non-blocked tasks accumulate silently. Future config knob: `HERMES_MC_AUTO_UNBLOCK_STATUSES` (default `blocked`).

The plugin does NOT register `on_session_start` / `on_session_end` hooks — no live-session state needed.

The author prefix `mission-control:` (not `mc:`, which is too short) is the defense-in-depth filter on the push side: any local comment whose author starts with `mission-control:` is skipped by the push reactor regardless of `mc_comment_links` state.

---

## Agent tool

One tool exposed to the LLM (registered via `ctx.register_tool`):

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

**Why no `mc_status` tool:** `hermes mc status` (CLI) covers this for operators. For the LLM, the existing kanban status tools already show task state.

**Why no `mc_update_status` tool:** status transitions go through the normal kanban lifecycle (`kanban_block`, `kanban_complete`, etc.); the push reactor mirrors them.

---

## CLI

`hermes mc <subcommand>` — registered via `ctx.register_cli_command(name='mc', help='MissionControl integration', setup_fn=_mc_setup, handler_fn=_mc_handler)` (verified at `_source/hermes_cli/plugins.py:387`).

```
hermes mc register [--pat mcpat_…] [--name <agent-name>]
                              # First-run registration OR re-register. Reads PAT
                              # from --pat or HERMES_MC_USER_PAT. Mints (or rotates)
                              # agent + connector keys. Writes ~/.hermes/auth.json.
                              # Caches projects. Sets initial events cursor.
                              # Idempotent: re-running by an already-registered VM
                              # rotates BOTH keys.
                              # Fails hard if POST /v1/connectors returns 404/403
                              # (mc.connector_routes_unavailable).

hermes mc status              # Print URL, org, agent_id, connector_id, last
                              # event cursor, last pull/push, error counts.

hermes mc refresh-projects [--pat mcpat_…]
                              # Re-fetch the project list.

hermes mc promote <local_task_id> [--project <slug>]
                              # Promote a local task to MC.

hermes mc unlink <local_task_id>
                              # Remove the MC link. Local task unaffected.
                              # MC task NOT deleted (use MC API directly).

hermes mc test                # Smoke test:
                              #   1. GET /v1/me with agent key
                              #   2. GET /v1/me with connector key
                              #   3. GET /v1/events?limit=1
                              # Exit 0 on green; non-zero with diagnostics on fail.
```

`hermes kanban create --mc [<slug>]` — added in v1.1 once the upstream `register_subcommand_extension` API lands; v1 ships `hermes mc promote` as the operator-side path.

---

## Build.sh wiring

New section in `services/hermes/build.sh`, alongside the existing lever-conditional sections:

```bash
if [ -n "${HERMES_MC_URL:-}" ]; then
  HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
HERMES_MC_URL=$HERMES_MC_URL
HERMES_MC_AGENT_NAME=${HERMES_MC_AGENT_NAME:-$VM}
HERMES_MC_BOARD=${HERMES_MC_BOARD:-mc}
HERMES_MC_POLL_INTERVAL=${HERMES_MC_POLL_INTERVAL:-10}
HERMES_MC_BOOTSTRAP_SINCE_DAYS=${HERMES_MC_BOOTSTRAP_SINCE_DAYS:-7}
HERMES_MC_DEFAULT_PROJECT_SLUG=${HERMES_MC_DEFAULT_PROJECT_SLUG:-}
HERMES_MC_DEBUG=${HERMES_MC_DEBUG:-false}"

  if [ -n "${HERMES_MC_USER_PAT:-}" ]; then
    HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
HERMES_MC_USER_PAT=$HERMES_MC_USER_PAT"
  fi

  hermes_sync_plugin "mission-control"
  hermes_enable_plugin "mission-control"
  log "mission-control: HERMES_MC_URL=$HERMES_MC_URL -> managed .env + plugin enabled"
else
  warn "mission-control: HERMES_MC_URL unset in .stack/.env — plugin not enabled"
fi
```

`hermes_sync_plugin` and `hermes_enable_plugin` are new shell helpers in `build.sh` (mount-aware; degrade gracefully when `HERMES_MOUNT_ENABLED=false` with print-the-orb-command fallback).

After registration completes, the operator may delete `HERMES_MC_USER_PAT` from `.stack/.env` — next `just build` will see it unset and stop including it in the managed block.

---

## Dashboard widget

One widget contribution to the existing settings tab. v1 ships only the status API endpoint; the React widget bundle is deferred to v1.1 once the upstream dashboard plugin-bundle pipeline is documented. Operators get the same info via `hermes mc status`.

`dashboard/manifest.json`:

```json
{
  "name": "mission-control",
  "label": "MissionControl",
  "description": "Sync status with MissionControl",
  "icon": "Cloud",
  "version": "1.0.0",
  "widget": { "host": "settings", "position": "after:plugins" },
  "api": "plugin_api.py"
}
```

`dashboard/plugin_api.py` exposes:

```
GET /status   →   {
  "registered": bool,
  "url": str | null,
  "org_id": str | null,
  "agent_id": str | null,
  "connector_id": str | null,
  "loops_running": bool,
  "events_cursor": int,
  "last_pull_ok_at": int | null,
  "last_push_ok_at": int | null,
  "consecutive_pull_errors": int,
  "consecutive_push_errors": int,
  "links_total": int,
  "links_dirty": int,
  "recent_errors": [{"at": int, "where": "pull"|"push", "msg": str}]
}
```

---

## Error handling

| Condition | Behavior |
|---|---|
| MC unreachable (connection error, timeout) | Loop backs off (5/30/120s ±25% jitter); cursors stay; logs WARN. |
| MC 5xx | Same as unreachable. |
| MC 401 (agent key) | All loops stop. Plugin status = `auth_failed`. ERROR logged. Re-run `hermes mc register` to recover. |
| MC 401 (connector key, on events poll) | Same — both keys are needed for the plugin to function. |
| MC 403 | Same as 401 but message points at "permissions changed in MC". |
| MC 404 on a known task (during push) | Delete the local link; archive the local task with `result='removed from mc'`; emit one local comment "MC task no longer accessible". |
| MC 409 on push (state machine) | Log WARN with both states. The next pull cycle's events will re-sync canonical MC state; clear `push_dirty`. |
| MC 409 on POST (idempotency conflict) | If `details.existing_task_id` matches our link → no-op success. Else log ERROR. |
| MC 422 (semantic) | Surface via `hermes mc status`; tasks remain unsynced until operator intervenes. |
| Kanban DB locked (rare in WAL) | Retry 3× with 50/100/200ms backoff, then log + skip the row. |
| `auth.json` corrupt / missing keys | Plugin status = `not_registered`; loops not started. |
| Pull-then-push echo | Suppressed by `mc_apply_log` event-id skip. |

All MC error envelopes are dot-namespaced (`task.invalid_transition`, etc.). Plugin logs the full code + message + details; the dashboard widget shows the last 5.

---

## Observability

Plugin logging goes to `~/.hermes/logs/agent.log` (and stderr when `HERMES_PLUGINS_DEBUG=1`), with the logger named `hermes.plugins.mission_control`.

Metrics surfaced through `hermes mc status` (not externalized to Prometheus in v1):
- `pull.last_success_at`, `pull.last_error`, `pull.consecutive_errors`, `pull.events_cursor`
- `push.last_success_at`, `push.last_error`, `push.queue_depth`, `push.consecutive_errors`
- `links.total`, `links.dirty`, `comments.linked`
- `loops_running`

The plugin registers no hooks, so it does not interact with `agents-observe` or other observer chains.

---

## Testing strategy

### Tests location

Pytest tests live under `services/hermes/plugins/mission-control/tests/`. The plugin ships its own `pyproject.toml` with pytest+respx as devDependencies. CI: `cd services/hermes/plugins/mission-control && pytest tests/ -v`.

**PYTHONPATH strategy:** `tests/conftest.py` prepends `services/hermes/_source/` to `sys.path` so plugin imports of `hermes_cli.kanban_db`, etc. resolve. Same conftest scrubs `_HERMES_GATEWAY` and `HERMES_KANBAN_TASK` from every test's env.

### Unit tests (pytest, mocked HTTP via respx_mock fixture)

| File | Coverage |
|---|---|
| `tests/test_status_map.py` | local↔MC status mapping; metadata patching; failure-vs-success disambiguation. |
| `tests/test_links_db.py` | Schema; cursor advance; dirty-flag lifecycle; comment-link dedup; apply-log purge; denormalized `local_status` updates. |
| `tests/test_client.py` | Each MC endpoint wrapper (respx_mock): success, 401 (AuthFailed), 5xx, 409 (IdempotencyConflict + existing_task_id), Idempotency-Key header inclusion, events cursor passthrough. |
| `tests/test_registrar.py` | PAT happy path; existing-agent rotation; mints connector; no-PAT inert; 401 PAT; project caching; events-cursor initialization (sets `mc_cursors.events` to current head). |
| `tests/test_apply.py` | One test per event kind in the dispatch table; auto-unblock on blocked; comment dedup via mc_comment_links; mc_apply_log capture via pre/post-MAX range. |
| `tests/test_pull.py` | Event loop: cursor advance, kind dispatch, AuthFailed propagation, 5xx backoff schedule, board= kwarg always passed, drain-paginated-window-then-advance. |
| `tests/test_push.py` | Each kanban event kind, `completed` outcome-disambiguation via `latest_run`, comment dedup both paths (mc_comment_links + author prefix), 409 state conflict, 404 orphan delete, idempotency headers, agent-key vs connector-key per endpoint. |
| `tests/test_auto_unblock.py` | Pulled `comment.created` on `blocked` task triggers `unblock_task`; on `running` task does NOT; defense-in-depth `mission-control:` author filter. |
| `tests/test_loop_guard.py` | `register(ctx)` skips loop startup when `_HERMES_GATEWAY!=1` or `HERMES_KANBAN_TASK` set; tools + CLI still register. |
| `tests/test_promote_idempotency.py` | `mc_promote_task` re-call returns `already_linked=True`; 409 with matching existing id surfaces success; 409 with non-matching id surfaces error. |

### Integration tests

`tests/integration/test_end_to_end.py` — spins up `wrangler dev` against MC's local single-DB build, bootstraps user + agent + connector + project via the bootstrap endpoint, registers the plugin against that URL, exercises:

1. Operator creates an MC task assigned to agent → events stream delivers `task.created` → local kanban row appears.
2. Local dispatcher transitions `ready → running` → MC PATCH lands; next pull is a no-op (echo suppressed via `mc_apply_log`).
3. Operator POSTs MC comment → events delivers `comment.created` → kanban comment appears.
4. Operator POSTs MC comment on a `blocked` task → local task auto-unblocks.
5. Agent (worker) calls `mc_promote_task(local_id)` → MC POST → link inserted with `source='pushed'`.
6. MC task gets `cancelled` → events delivers `task.deleted` (or `task.status_changed → cancelled`) → local task archived.
7. Worker writes comment via `kanban_comment` → push reactor mirrors to MC → next pull no-ops (dedup via mc_comment_links).

Behind `@pytest.mark.integration`; skipped when `MC_INTEGRATION_TEST_URL` is unset.

### Build-sh test

A new test in `services/hermes/build.test.sh` covers the managed-block injection of MC keys (matrix: `HERMES_MC_URL` set/unset, `HERMES_MC_USER_PAT` set/unset, second-build idempotency).

---

## What's NOT in v1

- Multi-org per VM. One MC org per VM.
- Multi-pool awareness. MC v1 is single-pool.
- SSE push from MC. When MC ships `GET /v1/stream/events`, the pull loop swaps `client.events_list` for an EventSource-style consumer; the apply layer is unchanged.
- Heartbeat endpoint. `last_seen_at` is bumped server-side on every authed request.
- Rate-limit handling (MC v1 has stub rate-limiting).
- Conflict resolution beyond last-writer-wins.
- Local task → MC project autocreate. Promotion requires an existing MC project.
- React dashboard widget bundle (deferred until upstream's dashboard-bundle pipeline is documented).
- `hermes kanban create --mc <slug>` (depends on upstream `register_subcommand_extension`).
- Reacting to `task.updated` events for non-status field changes (e.g. title/body edits).
- Reacting to `comment.deleted` events (local comment stays for audit).
- `external_ref.*` / `agent.*` / `connector.*` / `project.*` event handling.

---

## Future work (out of scope)

- **Multi-VM coordination.** Two Hermes VMs in the same MC org — each has its own agent_id + connector + cursor; the events stream's client-side filter (`task.agent_id == self`) does the work naturally.
- **SSE upgrade.** Swap `pull_loop`'s `events_list` poll for an EventSource consumer; nothing else changes.
- **MCP server façade.** Wrap the MC tools as an MCP server so other MCP clients (Claude Code, etc.) can use the same MC connection.
- **React widget.** Once the upstream dashboard-bundle pipeline is documented, add the widget on top of the existing status API.

---

## Resolved design questions (review trail)

- **One loop or two?** One pull loop on `GET /v1/events`, one push reactor on local `task_events`.
- **Why connector key for events?** Per-row agent visibility is impractical on a stream; connector role's whole-org read is the right surface.
- **How to filter MC events?** Server-side by `kinds=task,comment,external_ref`; client-side by `task.agent_id == self_agent_id` (and link membership).
- **Cursor type?** Single integer (`events.id` monotonic per pool).
- **How to bootstrap?** Registrar sets initial `mc_cursors.events` to the current MC events-head id, so the first cycle picks up only new events. `HERMES_MC_BOOTSTRAP_SINCE_DAYS` is reserved for a future "replay the last N days" feature; v1 starts at head.
- **Comment paging?** Not needed — comments arrive as events.
- **Echo suppression?** `mc_apply_log` event-id skip in the push reactor.
- **Bidirectional comment dedup?** `mc_comment_links` table + `mission-control:` author prefix (defense-in-depth).
- **Auto-unblock?** Yes for `blocked` tasks on `comment.created`; configurable later.
- **Why both agent and connector keys?** Agent key is narrowly scoped (PATCH own tasks, comment, external_refs); connector key is the events-poll + promotion credential.
- **kanban_db helpers vs upstream PR?** Use real helper names (verified against `_source/hermes_cli/kanban_db.py`); the only upstream addition we wanted (`list_events_since`) is replaced by inline raw SQL since `_source/` is gitignored.
- **Worker subprocess loop?** No — `_is_gateway()` guard via `_HERMES_GATEWAY` env marker.
