# agents-observe Hermes plugin

Date: 2026-05-21
Status: approved, ready for implementation

## Goal

Ship every Hermes hook payload to the
[agents-observe](https://github.com/simple10/agents-observe) HTTP backend so
Hermes shows up in the same observability dashboard as Claude Code. Pure
observation — the plugin must never mutate payloads or block the agent's hot
path, and a missing or hung backend must be invisible to Hermes.

Out of scope: stack-side service wiring (we're not adding
`services/agents-observe/`), build.sh deployment, dashboard rendering of
Hermes-shape envelopes, callback/system-message handling.

## Architecture

```
┌─ Hermes VM ──────────────────────────────────────────┐
│                                                       │
│  agent thread          worker thread (daemon)         │
│  ┌──────────────┐      ┌──────────────────────────┐   │
│  │ hook fires   │      │ _worker_loop:            │   │
│  │  _observer() │      │   ts, hook, kwargs = q.get()
│  │   put_nowait │─────▶│   envelope = sanitize+   │   │
│  │   return None│  q   │              build       │   │
│  └──────────────┘      │   urlopen POST 2 s       │   │
│         │              └──────────────────────────┘   │
│         │ ~µs                       │                 │
│         ▼                           │                 │
│   (continue agent work)             ▼                 │
│                            HERMES_AGENTS_OBSERVE_URL  │
│                            /api/events                │
└───────────────────────────────────────────────────────┘
```

The agent thread does *only* `dict(kwargs)` + `queue.put_nowait(...)`. No
JSON, no sanitization, no network, no waiting. The daemon worker drains the
queue, sanitizes, serializes, and POSTs. A failed/hung backend is bounded to
the worker — the queue fills behind it and `put_nowait` drops on overflow.

## Wire format

POSTed to `${HERMES_AGENTS_OBSERVE_URL}/api/events` with
`Content-Type: application/json`:

```json
{
  "agentClass": "hermes",
  "sessionId": "<session_id or empty>",
  "agentId":   "<same as sessionId>",
  "hookName":  "post_tool_call",
  "cwd":       "<cwd or null>",
  "timestamp": 1747800000.123,
  "payload":   { /* sanitized raw hook kwargs */ },
  "_meta":     { "project": { "slug": "<slug>" } }
}
```

Mirrors the agents-observe Claude Code envelope so the existing dashboard
can ingest both without a server-side schema change. The response body is
ignored — no callbacks, no system messages.

## Hook coverage (17 total)

| Category | Hooks |
|---|---|
| Tool | `pre_tool_call`, `post_tool_call` |
| Transform | `transform_terminal_output`, `transform_tool_result`, `transform_llm_output` (return `None`) |
| LLM | `pre_llm_call`, `post_llm_call` |
| API | `pre_api_request`, `post_api_request` |
| Session | `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset` |
| Delegation | `subagent_stop` |
| Gateway | `pre_gateway_dispatch` (return `None`) |
| Approval | `pre_approval_request`, `post_approval_response` |

All observers return `None`, so transform/dispatch hooks leave the agent's
data flow unchanged.

## Sanitization

Done in the worker (off the hot path), bounded by:

- Recursion depth capped at 6 — deeper structures collapse to `"<max-depth>"`.
- Strings truncated to `HERMES_AGENTS_OBSERVE_MAX_CHARS` (default 12 000).
- Dicts/lists capped at 200 entries.
- `bytes` → `{"_type": "bytes", "len": N}`.
- Non-primitive / non-collection objects (e.g. `MessageEvent`,
  `GatewayRunner`, `SessionStore`) → `"<TypeName>"`.
- Base64 image data inside `tool_response` arrays > 4 000 chars →
  `"[REDACTED]"` (same heuristic as agents-observe Claude Code lib).

Anything still unserializable at `json.dumps` time falls back through
`default=repr`.

## Config (env vars in `~/.hermes/.env`)

| Var | Required | Default | Notes |
|---|---|---|---|
| `HERMES_AGENTS_OBSERVE_URL` | yes | — | e.g. `http://host.docker.internal:4981`. Unset → plugin inert; no hooks register. |
| `HERMES_AGENTS_OBSERVE_PROJECT_SLUG` | no | — | Sets `_meta.project.slug` on every envelope. |
| `HERMES_AGENTS_OBSERVE_TIMEOUT_MS` | no | `2000` | Per-request HTTP timeout. |
| `HERMES_AGENTS_OBSERVE_QUEUE_SIZE` | no | `1000` | Max queued envelopes; drops on overflow. |
| `HERMES_AGENTS_OBSERVE_MAX_CHARS` | no | `12000` | Per-string truncation cap. |
| `HERMES_AGENTS_OBSERVE_DEBUG` | no | `false` | INFO-level worker logging. |

## Failure modes (all invisible to Hermes)

| Backend state | Behavior |
|---|---|
| URL unset | `register()` no-ops; zero overhead per hook. |
| Connection refused | Worker fails in ms; agent thread untouched. |
| Hung TCP | Worker blocks ≤ 2 s; queue fills behind it; agent keeps `put_nowait`-ing and dropping. |
| Slow (per-request latency) | Worker drains at 1/timeout; queue overflows → drop. |
| Worker crash | Outer `try/except` re-enters the loop; if the thread dies entirely, `put_nowait` keeps dropping silently. |

## Files

```
services/hermes/plugins/agents-observe/
  plugin.yaml         # manifest
  __init__.py         # register(ctx) + sanitization + worker
  README.md           # enable / env vars / install path
```

Lives under `services/hermes/` because it's Hermes-specific source the
stack ships alongside the VM definition (same family as
`services/hermes/systemd/`, `services/hermes/bin/`). Not wired into
`build.sh` — install is manual today (see the plugin README).

Standalone plugin (`kind: standalone`); opt-in via
`hermes plugins enable agents-observe`. Installed into
`~/.hermes/plugins/agents-observe/` on the Hermes VM (Mac-side under the
mount: `.stack/hermes/.hermes/plugins/agents-observe/`).
