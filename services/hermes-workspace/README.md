# hermes-workspace

The Hermes Workspace web UI (upstream: `ghcr.io/outsourc-e/hermes-workspace`),
connected to the existing Hermes Agent gateway running on this project's
`hermes` VM.

- **Image:** digest-pinned in `service.env` (`HERMES_WORKSPACE_IMAGE_DEFAULT`).
- **Profile:** `hermes-workspace`. `SERVICE_REQUIRES=hermes`, so enabling
  this service keeps `hermes` in `STACK_MACHINES`.
- **URL after enable:** `https://hermes-workspace.<project>.orb.local`
  (OrbStack auto-HTTPS; default project `aitools`).
- **What the UI does:** lets you drive the agent gateway, manage skills,
  browse memory and workspace files, etc. The container is stateless;
  state lives in two project-scoped Docker volumes
  (`hermes-workspace-config`, `hermes-workspace-files`) — they survive
  container recreation and a normal `docker compose down`.

## First-time setup

The Hermes gateway defaults to loopback inside the VM. To let the workspace
reach it, open the gate explicitly:

```sh
$EDITOR .stack/.env
# set: HERMES_GATEWAY_ALLOW_ACCESS=true

just setup                       # mints HERMES_GATEWAY_API_KEY + HERMES_WORKSPACE_PASSWORD
just enable hermes-workspace     # adds profile + service block
just build                       # writes new gateway systemd unit + resolves image digest
just start                       # drain-restarts the gateway, brings up workspace
```

Then open `https://hermes-workspace.aitools.orb.local` and log in with
`HERMES_WORKSPACE_PASSWORD` from `.stack/.env`.

### Security note

Opening the gate binds the Hermes gateway (`:8642`) to `0.0.0.0` inside the
VM — every container on this project's orb docker network can reach it.
`HERMES_GATEWAY_API_KEY` is enforced on every inbound request, but that's
your only defense in depth. **Only open the gate on a trusted dev Mac.**
Don't pair this with any service that publishes `:8642` onto the LAN.

To close the gate later: set `HERMES_GATEWAY_ALLOW_ACCESS=false`, run
`just build && just start`. The gateway returns to loopback-only; the
workspace container can't reach it but `just disable hermes-workspace`
stops it cleanly.

## Levers (in `.stack/.env`, hermes-workspace block)

| Key | Purpose |
|---|---|
| `HERMES_WORKSPACE_PASSWORD` | Web-UI session password. Auto-minted by `just setup`. |
| `HERMES_WORKSPACE_COOKIE_SECURE` | Sets `Secure` on session cookies. Default `true` (OrbStack auto-HTTPS terminates TLS). |
| `HERMES_WORKSPACE_TRUST_PROXY` | Trust `X-Forwarded-*` headers from the orb proxy. Default `true`. |
| `HERMES_WORKSPACE_VERSION` | Override the digest pinned in `service.env` (set to `sha256:...` of a different upstream image). |

## What's NOT here (v1)

- Running the hermes-agent as a container (upstream's primary mode). Out
  of scope; this stack runs hermes as an OrbStack VM via `STACK_MACHINES`.
- Building from `_source/`. The upstream clone is on disk for reference
  only and is `**/_source/`-gitignored.
- A shared volume between the VM and the workspace container — the VM
  owns `~/.hermes/` and the workspace gets its own.
