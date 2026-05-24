# agents-observe — Hermes plugin

Fire-and-forget observability for Hermes. Ships every supported hook
payload to an [agents-observe](https://github.com/simple10/agents-observe)
HTTP backend so Hermes shows up in the same dashboard as Claude Code.

**Pure observation.** Never mutates payloads, never blocks the agent. The
hot path in the agent thread is a shallow dict copy and a non-blocking
queue put (~µs). All sanitization, serialization, and network I/O happen
on a daemon worker thread. A missing or hung backend is invisible to
Hermes — the worker fails or times out independently and the agent keeps
running without ever waiting on a socket.

## Install

This plugin lives in the stack repo at
`services/hermes/plugins/agents-observe/`. Drop it into the Hermes VM's
user-plugin dir:

```bash
# With HERMES_MOUNT_ENABLED=true (the default), this is just a Mac-side copy:
mkdir -p .stack/hermes/.hermes/plugins
cp -r services/hermes/plugins/agents-observe .stack/hermes/.hermes/plugins/

# With the mount disabled, copy into the VM:
orb -m aitools-hermes bash -lc 'mkdir -p ~/.hermes/plugins'
tar -C services/hermes/plugins -cf - agents-observe \
  | orb -m aitools-hermes -- tar -C ~/.hermes/plugins -xf -
```

Then enable it inside the VM:

```bash
orb -m aitools-hermes -- hermes plugins enable agents-observe
```

Or check the box in the interactive `hermes plugins` UI.

## Configure

Set in `~/.hermes/.env` (or `.stack/hermes/.hermes/.env` with the mount).
Add the line **outside** the `# >>> hermes-stack managed >>>` block —
i.e. below the closing `# <<< hermes-stack managed <<<` marker — so
`just build` doesn't overwrite it. See *What `just build` writes* in
`services/hermes/README.md`.

```bash
HERMES_AGENTS_OBSERVE_URL=http://host.docker.internal:4981
```

The plugin is **inert** when this var is unset — `register()` returns
immediately and no hooks are wired, so the per-hook cost is zero.

Optional tuning:

```bash
HERMES_AGENTS_OBSERVE_PROJECT_SLUG=hermes        # _meta.project.slug on every envelope
HERMES_AGENTS_OBSERVE_TIMEOUT_MS=2000            # per-POST HTTP timeout (worker only)
HERMES_AGENTS_OBSERVE_QUEUE_SIZE=1000            # max queued envelopes before drop
HERMES_AGENTS_OBSERVE_MAX_CHARS=12000            # per-string truncation cap
HERMES_AGENTS_OBSERVE_DEBUG=true                 # INFO-level worker logs
```

`HERMES_AGENTS_OBSERVE_URL` should point at wherever `agents-observe` is
serving its API. From an OrbStack VM, `host.docker.internal` resolves to
the Mac; if `agents-observe` is running on the Mac at port 4981 (the
default), the URL above just works.

## What gets sent

For every fired hook, a single JSON POST to
`${HERMES_AGENTS_OBSERVE_URL}/api/events`:

```json
{
  "agentClass": "hermes",
  "sessionId":  "<session_id or empty>",
  "agentId":    "<same as sessionId>",
  "hookName":   "post_tool_call",
  "cwd":        "<cwd or null>",
  "timestamp":  1747800000.123,
  "payload":    { /* sanitized raw hook kwargs */ },
  "_meta":      { "project": { "slug": "hermes" } }
}
```

Mirrors the agents-observe Claude Code envelope so the existing dashboard
ingests both without a server-side change.

### Hooks observed (17)

| Category | Hooks |
|---|---|
| Tool | `pre_tool_call`, `post_tool_call` |
| Transform | `transform_terminal_output`, `transform_tool_result`, `transform_llm_output` |
| LLM | `pre_llm_call`, `post_llm_call` |
| API | `pre_api_request`, `post_api_request` |
| Session | `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset` |
| Delegation | `subagent_stop` |
| Gateway | `pre_gateway_dispatch` |
| Approval | `pre_approval_request`, `post_approval_response` |

The transform / gateway observers all return `None` so Hermes keeps the
original value — observation never alters the data flow.

### Sanitization

Done in the worker (off the hot path):

- Recursion depth capped at 6; deeper structures collapse to `"<max-depth>"`.
- Strings truncated to `HERMES_AGENTS_OBSERVE_MAX_CHARS` (default 12 000).
- Dicts/lists capped at 200 entries.
- `bytes` → `{"_type": "bytes", "len": N}`.
- Non-primitive / non-collection objects (e.g. live `MessageEvent`) →
  `"<TypeName>"`.
- Base64 image data > 4 000 chars inside Claude-style `tool_response`
  arrays → `"[REDACTED]"`.

Anything still unserializable falls back through `json.dumps(default=repr)`.

## Verify

```bash
orb -m aitools-hermes -- hermes plugins list        # agents-observe → enabled
orb -m aitools-hermes -- hermes chat -q "hello"     # fires pre_llm_call, etc.
open http://localhost:4981                          # events should appear
```

If nothing arrives, set `HERMES_AGENTS_OBSERVE_DEBUG=true`, restart the
gateway, and check the Hermes logs for `agents-observe:` lines — POST
errors are logged at INFO when debug is on.

## Disable

```bash
orb -m aitools-hermes -- hermes plugins disable agents-observe
```

Or unset `HERMES_AGENTS_OBSERVE_URL` — the plugin is inert without it.

## Why fire-and-forget?

Observability should never be on the critical path. The plugin's hot path
costs are bounded as follows:

| Backend state | What Hermes feels |
|---|---|
| URL unset | Nothing — no hooks registered. |
| Connection refused | Worker fails in ms; agent thread untouched. |
| Hung TCP | Worker blocks ≤ 2 s; queue fills behind it; agent's `put_nowait` keeps dropping. |
| Slow backend | Worker drains at 1/timeout; queue overflows → drop. |
| Worker crash | Outer `try/except` re-enters the loop; if it dies entirely, drops continue silently. |

The agent thread *never* makes the HTTP call, never serializes, never
holds a lock longer than `Queue.put_nowait` itself.
