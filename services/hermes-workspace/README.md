# hermes-workspace

The Hermes Workspace web UI (upstream: `ghcr.io/outsourc-e/hermes-workspace`),
connected to the existing Hermes Agent gateway running on this project's
`hermes` VM.

- **Image:** digest-pinned in `service.yaml` (`HERMES_WORKSPACE_IMAGE_DEFAULT`).
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
| `HERMES_WORKSPACE_VERSION` | Override the digest pinned in `service.yaml` (set to `sha256:...` of a different upstream image). |

## What's NOT here (v1)

- Running the hermes-agent as a container (upstream's primary mode). Out
  of scope; this stack runs hermes as an OrbStack VM via `STACK_MACHINES`.
- Building from `_source/`. The upstream clone is on disk for reference
  only and is `**/_source/`-gitignored.
- A shared volume between the VM and the workspace container — the VM
  owns `~/.hermes/` and the workspace gets its own.

## Security notes

### HermesWorld feature — egress to third-party servers

The upstream workspace ships a 3D multiplayer game ("HermesWorld") at
the `/playground` and `/hermes-world` routes. Visiting either:

- Opens a **WebSocket** to `wss://hermes-playground-ws.myaurora-agi.workers.dev`
  and HTTP-polls it at 1 Hz, broadcasting your avatar config, in-game
  name + color, and 3D position. The endpoint is a Cloudflare Worker
  run by the workspace developer (not Anthropic / NousResearch). No
  PII / agent state / conversation contents are sent (audited
  2026-05-21), but the hub has **no auth** (JWT is listed as TODO in
  the worker's README) and `Access-Control-Allow-Origin: *`.
- Loads an **iframe** from `https://hermes-world.ai/play/` — third-party
  site, its own JavaScript runs in your browser session.

### Mitigation in this stack

`compose.yaml` sets `VITE_HERMESWORLD_ENABLED=0` on the container, which
*would* hide the gold sidebar link if upstream's bundle read the env at
runtime. **It doesn't, on the currently-pinned image:** Vite already
inlined `import.meta.env.*` to `const fpe={}` at build time, so the
runtime env is ignored. To actually hide the link on the pinned digest,
the ad-hoc patch is:

```sh
docker exec -u 0 aitools-hermes-workspace-1 sh -c \
  "sed -i 's|const fpe={}|const fpe={VITE_HERMESWORLD_ENABLED:\"0\"}|g' \
      /app/dist/client/assets/main-*.js"
# hard-refresh the workspace UI in your browser
```

That sed reverts on container recreate (image bundle is unchanged; the
patch lives only in the container's writable layer). Re-apply after
any `dc up --force-recreate hermes-workspace` or `just stop && just
start`.

**Important:** hiding the sidebar link is cosmetic. The `/playground`
and `/hermes-world` routes still exist — typing the URL still loads
the iframe + opens the WebSocket.

### Durable options (deferred)

When we revisit this:

1. **Compose entrypoint override** that runs the sed before starting
   the server, so the patch reapplies on every container start.
   Cheap; brittle if upstream's minified variable name (`fpe`) changes
   on a future bump — would silently no-op.
2. **Mac `/etc/hosts` block** — bulletproof regardless of bundle
   changes; blocks network connections, not just the UI link:
   ```
   127.0.0.1 hermes-playground-ws.myaurora-agi.workers.dev hermes-world.ai
   ```
   Affects all browsers on the Mac; easy to revert.
3. **Build a custom workspace image** with `VITE_HERMESWORLD_ENABLED=0`
   set during `pnpm build`. Most invasive; requires owning a Dockerfile
   and the per-bump rebuild cycle.

### Other audit findings (informational, no action taken)

- **No telemetry SDKs anywhere** — Sentry, PostHog, Mixpanel, Amplitude,
  Segment, Bugsnag, Rollbar, Datadog, NewRelic: all absent from `package.json`,
  `pnpm-lock.yaml`, and the bundled JS. Clean.
- **MCP Hub** auto-fetches `https://registry.smithery.ai/servers` when
  the user visits the MCP Hub screen. Public catalog, no user data. The
  source is a built-in (`builtin: true` in `mcp-hub-sources-store.ts`)
  and cannot be removed from the UI.
- **Provider usage** (Dashboard screen) calls Anthropic / OpenAI /
  Codex / OpenRouter usage APIs when their credentials are present in
  the container env. Conversation contents are never sent — only OAuth
  tokens for auth, results displayed locally.
- **CSP** in the renderer is wide open (`connect-src 'self' ws: wss:
  http: https:`) — relies on Electron's sandbox + (for us) the
  OrbStack auto-HTTPS scope. Not a concern given our deployment isn't
  exposed beyond the Mac.
- **Electron-app concerns** (auto-installer running `curl | bash` from
  GitHub on first launch, unsigned Mac binary, electron-updater) do
  NOT apply to our Docker deployment — those code paths only execute
  in the `main.cjs` Electron bootstrap, which the workspace container
  never runs.
