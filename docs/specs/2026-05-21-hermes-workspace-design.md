# hermes-workspace service (v1) + Hermes gateway access gate

Date: 2026-05-21
Status: approved, ready for implementation

## Goal

Add the upstream Hermes Workspace web UI (`ghcr.io/outsourc-e/hermes-workspace`)
to the stack as a docker service that connects to the *existing* Hermes VM's
gateway. Ship it behind an explicit security gate on the hermes side, so the
gateway only binds to 0.0.0.0 when a user deliberately opts in.

This is v1. Out of scope: running the hermes-agent as a container, building
the workspace from `_source/`, dashboard auth, sharing the VM's `~/.hermes`
with the workspace container.

## Architecture

```
┌─ Mac (compose project: aitools) ──────────────────────────────┐
│                                                                │
│   hermes-workspace (container)        aitools-hermes (orb VM)  │
│   ┌─────────────────────┐             ┌─────────────────────┐  │
│   │ :3000 (UI)          │  HTTP/orb   │ :8642 gateway       │  │
│   │  HERMES_API_URL ────┼────DNS─────▶│  (bound 0.0.0.0     │  │
│   │  HERMES_API_TOKEN ──┼─auth──┐     │   *only when gate*  │  │
│   └─────────────────────┘       │     │   *is open*)        │  │
│                                 ▼     └─────────────────────┘  │
│                              API_SERVER_KEY=$HERMES_GATEWAY_API_KEY
│                                                                │
│   OrbStack auto-HTTPS:                                         │
│     https://hermes-workspace.aitools.orb.local                 │
└────────────────────────────────────────────────────────────────┘
```

The workspace runs as a container on the project network. It reaches the
hermes VM via `<vm>.orb.local:8642` — OrbStack DNS works from containers
into VMs even with `--isolate-network` on the VM (containers aren't subject
to the VM's net-isolation).

## The gate

The Hermes gateway defaults to loopback inside the VM (unreachable from
outside). Binding 0.0.0.0 publishes it on the orb docker network — a real
security trade-off — so this is a per-stack opt-in.

Three levers in `.stack/.env` (hermes block):

| Lever | Owner | Default | Purpose |
|---|---|---|---|
| `HERMES_GATEWAY_ALLOW_ACCESS` | hermes block | `false` | Master gate. `true` binds gateway to 0.0.0.0 and requires `HERMES_GATEWAY_API_KEY`. |
| `HERMES_GATEWAY_API_KEY` | hermes block | empty | API token. Minted by `just setup` when gate is `true` and key is empty. Required on every inbound gateway request when gate is `true`. |
| `HERMES_GATEWAY_URL` | hermes `.generated.env` | absent | Auto-written by `services/hermes/build.sh` when gate is `true`. Stripped when gate is `false`. Consumers read this single stable lever instead of recomputing `<vm>.orb.local:8642`. |

### Hard invariants

- `HERMES_GATEWAY_ALLOW_ACCESS=true ⇒ HERMES_GATEWAY_API_KEY non-empty`.
  Enforced at the top of `services/hermes/build.sh`; build fails loudly
  ("run `just setup` to mint it") if the user manually flipped the gate
  without minting a key.
- Any dependent service (currently `hermes-workspace`; future consumers
  inherit the pattern) checks the gate at the top of its own `build.sh`
  and dies with a clear "flip the gate first" message when it isn't true.

## Files

### New: `services/hermes-workspace/`

```
services/hermes-workspace/
├── service.env       # SERVICE_DESC, REQUIRES=hermes, image repo+digest, STACK_ENV
├── compose.yaml      # one service, profile [hermes-workspace]
├── build.sh          # gate-check refuse; no other work for v1
└── README.md         # usage + URL
```

`service.env`:
```sh
SERVICE_RUNNER=docker
SERVICE_DESC="Hermes Workspace web UI (connects to existing Hermes VM)"
SERVICE_REQUIRES=hermes
SERVICE_STACK_ENV='
HERMES_WORKSPACE_PASSWORD=
# OrbStack auto-HTTPS fronts the workspace; mark cookies Secure + trust
# the proxy headers it sets.
HERMES_WORKSPACE_COOKIE_SECURE=true
HERMES_WORKSPACE_TRUST_PROXY=true
'

# Single image owned by this service. Bump via HERMES_WORKSPACE_VERSION in .stack/.env.
HERMES_WORKSPACE_IMAGE_REPO=ghcr.io/outsourc-e/hermes-workspace
HERMES_WORKSPACE_IMAGE_DEFAULT=sha256:2d2ba9aa5b1230766267322817e8e51113541780a5797802a582a47cc34a3df3   # latest @ 2026-05-21
```

`compose.yaml` (modeled on honcho-ui's expose-only OrbStack-auto-HTTPS pattern):
```yaml
services:
  hermes-workspace:
    image: "${HERMES_WORKSPACE_IMAGE:?run 'just build' to resolve HERMES_WORKSPACE_VERSION}"
    profiles: [hermes-workspace]
    restart: unless-stopped
    expose: ["3000"]
    environment:
      HERMES_HOME: /home/workspace/.hermes
      HERMES_WORKSPACE_DIR: /workspace
      HERMES_API_URL: ${HERMES_GATEWAY_URL}
      HERMES_API_TOKEN: ${HERMES_GATEWAY_API_KEY}
      HERMES_PASSWORD: ${HERMES_WORKSPACE_PASSWORD}
      COOKIE_SECURE: ${HERMES_WORKSPACE_COOKIE_SECURE:-true}
      TRUST_PROXY: ${HERMES_WORKSPACE_TRUST_PROXY:-true}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
    volumes:
      - hermes-workspace-config:/home/workspace/.hermes
      - hermes-workspace-files:/workspace
    healthcheck:
      test: ["CMD-SHELL", "node -e 'require(\"net\").connect(3000,\"127.0.0.1\").on(\"connect\",()=>process.exit(0)).on(\"error\",()=>process.exit(1))'"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 30s
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  hermes-workspace-config:
  hermes-workspace-files:
```

`build.sh`:
```sh
#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
require_stack_env

allow="$(env_get "$STACK_DIR/.env" HERMES_GATEWAY_ALLOW_ACCESS)"
if [ "$allow" != "true" ]; then
  die "hermes-workspace requires HERMES_GATEWAY_ALLOW_ACCESS=true in .stack/.env.

  The Hermes gateway defaults to loopback inside the VM. To allow
  hermes-workspace to reach it, opt in:

    1. edit .stack/.env: HERMES_GATEWAY_ALLOW_ACCESS=true
    2. just setup       # mints HERMES_GATEWAY_API_KEY
    3. just build       # rebuilds the hermes systemd unit + this service
    4. just start       # cycles the gateway (drain-aware) + brings up workspace

  SECURITY: this binds the gateway to 0.0.0.0 on the orb docker network.
  HERMES_GATEWAY_API_KEY is required on every inbound request. Only enable
  on a trusted dev Mac."
fi
log "hermes-workspace: gate open (HERMES_GATEWAY_ALLOW_ACCESS=true) — image resolution handled by Phase 1"
```

### Modified: `services/hermes/`

**`service.env` — extend `SERVICE_STACK_ENV` block** with the two new levers (and inline comments explaining the security trade-off). No other changes.

**`systemd/hermes-gateway.service`** — add a single placeholder after the existing `Environment="HERMES_HOME=..."` line:
```
Environment="HERMES_HOME=/home/__REMOTE_USER__/.hermes"
__GATEWAY_ACCESS_ENV__
Restart=always
```

**`build.sh`** — between current step 5 (config.yaml patch) and step 6 (unit install):

1. Hard invariant: `[ "$HERMES_GATEWAY_ALLOW_ACCESS" = "true" ] && [ -z "$HERMES_GATEWAY_API_KEY" ] && die ...`
2. Compute `gateway_env_block`: empty when gate is false; four `Environment=` lines (ENABLED, HOST, PORT, KEY) when true.
3. Maintain `.stack/hermes/.generated.env`'s `HERMES_GATEWAY_URL`: `env_upsert` when true; remove the line when false.

In the existing per-unit substitution loop, branch on `unit == hermes-gateway`: substitute both `__REMOTE_USER__` and `__GATEWAY_ACCESS_ENV__`; other units keep their existing single-sub.

**`start.sh`** — replace the unconditional `systemctl restart hermes-gateway hermes-logtail` with a drain-aware path:
```sh
orb -m "$VM" bash -lc '
  set -e
  sudo systemctl daemon-reload
  sudo systemctl enable --now hermes-dashboard hermes-gateway hermes-logtail
  sudo systemctl restart hermes-logtail   # not task-bearing
  # Drain-aware: SIGUSR1 → in-flight runs finish → exit 75 → systemd
  # relaunches with refreshed unit. Idempotent; safe on every just start.
  sudo "$HOME/.local/bin/hermes" gateway restart --system
'
```

`hermes gateway restart --system` is wired (`hermes_cli/gateway.py:2574 systemd_restart → _graceful_restart_via_sigusr1 line 2592`) and handles the start-limit and fallback edge cases internally.

### Modified: `lib/setup.sh`

Two conditional mints, in the existing block-routed-secrets section:

```sh
# hermes gateway access (only mint key when gate is open)
if [ "$(env_get "$ENVF" HERMES_GATEWAY_ALLOW_ACCESS)" = "true" ]; then
  gen_if_missing HERMES_GATEWAY_API_KEY "" 32
fi

# hermes-workspace session password (mint once if the block exists)
if stack_env_block_status hermes-workspace >/dev/null 2>&1; then
  gen_if_missing HERMES_WORKSPACE_PASSWORD "" 32
fi
```

(Exact existing helpers: `gen_if_missing VAR PREFIX BYTES` writes via `stack_upsert` which routes into the right block.)

## User flow

First-time enable of hermes-workspace:

```
# 1. opt in to gateway exposure
$EDITOR .stack/.env              # set HERMES_GATEWAY_ALLOW_ACCESS=true
just setup                       # mints HERMES_GATEWAY_API_KEY

# 2. enable the workspace service
just enable hermes-workspace     # adds profile + #>--- hermes-workspace --- block
                                  # SERVICE_REQUIRES=hermes already keeps hermes in STACK_MACHINES

# 3. apply
just build                       # writes new gateway unit; resolves workspace image digest
just start                       # drain-restart gateway → 0.0.0.0:8642; brings up workspace container

open https://hermes-workspace.aitools.orb.local
# UI prompts for HERMES_WORKSPACE_PASSWORD, then connects to gateway with HERMES_API_TOKEN.
```

Disabling later (gate stays open until user closes it explicitly):
```
just disable hermes-workspace    # removes profile + block (workspace container stops on next start)
$EDITOR .stack/.env              # OPTIONAL: HERMES_GATEWAY_ALLOW_ACCESS=false
just build && just start         # rewrites gateway unit back to loopback if gate was closed
```

## Verification

- `curl -sS http://aitools-hermes.orb.local:8642/health -H "Authorization: Bearer $HERMES_GATEWAY_API_KEY"` → 200 when gate is open.
- `curl -sS http://aitools-hermes.orb.local:8642/health` (no header) → 401 when gate is open.
- `curl -sS http://aitools-hermes.orb.local:8642/health` → connection refused when gate is closed (current behavior preserved).
- Negative path: `HERMES_GATEWAY_ALLOW_ACCESS=true` + empty `HERMES_GATEWAY_API_KEY` → `just build` dies with a clear message.
- Negative path: `just build` with hermes-workspace enabled + gate closed → dies with the "flip the gate first" message.
- `hermes-workspace` container reaches `healthy`; OrbStack publishes it; UI loads at `https://hermes-workspace.<project>.orb.local`.
- `just start` mid-task no longer kills in-flight agent runs (drain-aware restart).

## Commits

Two scoped commits (loosely coupled; gate is reusable):

1. **`feat(hermes): gateway access gate + drain-aware restart`** — touches only `services/hermes/`, `lib/setup.sh`, `lib/stacklib.sh` (if needed). Useful standalone.
2. **`feat(hermes-workspace): add web UI service (connects to existing hermes)`** — new dir + .gitignore impact (nothing, `_source/` already ignored).

## Future iterations (explicitly out of scope)

- Build-from-source mode via a `dev` profile + the existing `_source/`.
- Embedded `hermes-agent` container option (upstream's primary mode), gated behind a separate `HERMES_WORKSPACE_EMBED_AGENT=true` knob.
- Shared volume between the VM and the workspace container (would require an OrbStack-side mount or an SFTP shim — non-trivial).
- Generalizing the gate-check into `stack_require_hermes_gateway` once a second consumer exists.
