# mission-control (Hermes plugin)

Bidirectional sync between this Hermes VM and a [MissionControl](https://github.com/openclaw/hermes-stack/tree/main/services/mission-control) deployment.

- **Subscribe** to MC's `GET /v1/events` stream for tasks/comments assigned to this VM's agent identity.
- **Mirror** local kanban status + comments back to MC so the human can see live progress from the MC UI (or Notion via a connector).
- **Promote** local-originated tasks up to MC explicitly via `hermes mc promote` or the `mc_promote_task` agent tool.
- **Auto-unblock** a `blocked` local task when a human comments on it via MC, so the dispatcher re-spawns the worker with that comment in context.

Design: `docs/specs/2026-05-23-mission-control-plugin-design.md` (rev 4) in the repo root.

---

## One-time setup

1. **Mint a Personal Access Token (PAT) in MC.** From the MC UI (or via curl against the MC API), create a PAT and copy the `mcpat_…` value. The PAT only needs to live in your env long enough to register; the plugin minted agent + connector keys are what stays.

2. **Set the levers** in `.stack/.env` (the stack-side env file):

   ```bash
   # HERMES_MC_URL is the base URL of MC's API, UP TO BUT NOT INCLUDING /v1/.
   # The plugin appends /v1/<resource> to every request. This decouples
   # deployment topology (combined SPA+API vs split subdomain) from the plugin.
   #   - Combined SPA + API on one Worker:    HERMES_MC_URL=https://mc.example.com/api
   #   - API on its own subdomain:            HERMES_MC_URL=https://api.example.com
   # Trailing slashes are stripped automatically.
   HERMES_MC_URL=https://mc.example.com/api
   HERMES_MC_USER_PAT=mcpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   # Optional:
   # HERMES_MC_AGENT_NAME=my-vm           # default: OrbStack VM name
   # HERMES_MC_BOARD=mc                   # local kanban board for MC tasks
   # HERMES_MC_POLL_INTERVAL=10           # min 2
   # HERMES_MC_DEFAULT_PROJECT_SLUG=…     # used by `hermes mc promote` w/o --project
   # HERMES_MC_DEBUG=false
   ```

3. **Build:** `just build hermes`. This syncs the plugin into `~/.hermes/plugins/mission-control/` and adds `mission-control` to your `~/.hermes/config.yaml`'s `plugins.enabled` list. It also writes the env vars into the managed block of `~/.hermes/.env`.

4. **Register** (inside the VM):

   ```bash
   orb -m <vm> bash -lc 'hermes mc register'
   ```

   This mints an agent key (`mcagt_…`) and a connector key (`mccnn_…`), writes them to `~/.hermes/auth.json`, caches the project list, and sets the initial events cursor to MC's current head so the first poll picks up only NEW events.

5. **Verify:**

   ```bash
   orb -m <vm> bash -lc 'hermes mc status'
   ```

   Look for `registered: true` and `loops_running: true`.

6. **Clear the PAT** from `.stack/.env` (recommended). The plugin no longer needs it; the next `just build` will see `HERMES_MC_USER_PAT` unset and stop including it in the managed block. The minted agent + connector keys in `~/.hermes/auth.json` are what the running plugin uses from here on.

---

## Day-to-day commands

| | |
|---|---|
| `hermes mc status` | Connection summary + cursors + recent errors. |
| `hermes mc promote <local_task_id> [--project <slug>]` | Push a local kanban task up to MC. Idempotent — re-running returns the same `mc_task_id`. |
| `hermes mc unlink <local_task_id>` | Forget the MC↔local link locally. The MC task is NOT deleted (use the MC API directly). |
| `hermes mc refresh-projects [--pat …]` | Re-fetch the project list cache (e.g. after creating a new project in MC). |
| `hermes mc test` | Smoke-check `/v1/me` with both keys + `/v1/events` with the connector key. |
| `hermes mc register [--pat …] [--name …]` | Re-register / rotate keys. Idempotent — rotates existing agent/connector keys instead of creating duplicates. |

The LLM running inside Hermes can call the `mc_promote_task` tool to push a local task up to MC (e.g. when it decides the human should see it). Pull + status mirroring + comment sync happen automatically once registered.

---

## How tasks land locally

MC-assigned tasks arrive on a dedicated kanban board (slug `HERMES_MC_BOARD`, default `mc`). They show up alongside any local tasks created with `hermes kanban add` on that board:

```bash
hermes kanban list -b mc
```

The local kanban dispatcher runs MC tasks the same way it runs any other tasks — no special path. Status transitions (`claimed` → `running`, `blocked`, `completed`, etc.) are mirrored back to MC automatically.

Comments left on an MC task (e.g. via Notion) land in the local kanban thread for that task. If the local task is `blocked` when the comment arrives, the plugin auto-unblocks it so the dispatcher re-spawns the worker with the comment visible.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `hermes mc status` shows `registered: false` | Register hasn't been run yet, or `~/.hermes/auth.json` is missing the `mission_control` provider block. Re-run `hermes mc register`. |
| `loops_running: false` even after register | You're running the command from outside the gateway process. The loops only start inside the gateway. Restart the gateway (`systemctl --user restart hermes-gateway` or `just restart hermes`). |
| `status: auth_failed` | MC rejected our agent or connector key (401/403). Re-run `hermes mc register` to rotate. |
| Tasks not arriving | Check `hermes mc status` for `events_cursor` movement and `consecutive_pull_errors`. If the cursor is stuck and errors are high, MC may be unreachable; verify with `hermes mc test`. |
| `mc_promote_task` returns `mc.unknown_project` | Project slug not in the cached project list. Run `hermes mc refresh-projects` (needs PAT). |
| `mc.idempotency_conflict_mismatch` from `mc_promote_task` | The MC idempotency key `hermes:<local_task_id>` is already in use by a different local task. Likely a stale state from a prior environment — investigate via the MC UI; if needed, `hermes mc unlink` and try again with a fresh local task. |
| `connector_routes_unavailable` from `hermes mc register` | MC deployment doesn't expose `POST /v1/connectors`. Plugin v1 requires it. Either upgrade MC, or wait for plugin v1.1 (agent-only mode). |

For deeper debugging set `HERMES_MC_DEBUG=true` and check `~/.hermes/logs/agent.log` (filter on `mission_control`).

---

## What lives where

```
~/.hermes/
├── auth.json                        # providers.mission_control block holds the keys + org
├── config.yaml                      # plugins.enabled includes 'mission-control'
├── plugins/mission-control/         # plugin source (synced by build.sh)
└── mission-control/
    ├── projects.json                # cached project list (refresh on demand)
    └── links.db                     # MC↔local mappings + cursors + apply log
```

`auth.json` and `links.db` are written by the plugin. `projects.json` is the project-cache; refresh it after creating new projects in MC.

---

## Development

Plugin tests live under `tests/`. To run them:

```bash
cd services/hermes/plugins/mission-control
uv venv && source .venv/bin/activate
uv pip install pytest pytest-asyncio respx httpx pyyaml fastapi
pytest tests/ -v
```

The dashboard widget's React bundle is deferred to v1.1. The plugin currently ships only the status API endpoint (`GET /api/plugins/mission-control/status`); operators get the same info via `hermes mc status`.
