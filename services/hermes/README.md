# hermes

The [Hermes agent](https://hermes-agent.nousresearch.com/) running as an
OrbStack Ubuntu VM (NOT a Docker container — `SERVICE_RUNNER=vm` in
`service.env`). The only VM-runner service in the stack; everything else is
Dockerized and Hermes reaches them via orb DNS.

Enable: `just enable hermes` (cascades `litellm` + `pg` + `redis`; the rest
are opt-in and Hermes auto-detects each via `~/.hermes/.env` wire-ups in
`build.sh`).

## Levers (in the `#>--- hermes ---` block of `.stack/.env`)

```
HERMES_REMOTE_USER=hermes          # unix user inside the VM (orb create --user)
HERMES_MODEL=${STACK_LLM_MODEL}    # default: cliproxy/gpt-5.5
HERMES_MEMORY=honcho               # memory backend (one at a time)
HERMES_TELEGRAM_BOT_TOKEN=         # gateway Telegram integration (optional)
HERMES_TELEGRAM_ALLOWED_USERS=
HERMES_TELEGRAM_HOME_CHANNEL=
HERMES_GATEWAY_ALLOW_ACCESS=false  # bind gateway 0.0.0.0:8642 for docker consumers
HERMES_GATEWAY_API_KEY=             # minted by setup when ALLOW_ACCESS=true
HERMES_MOUNT_ENABLED=true          # bind-mount ~/.hermes/ from Mac path below
HERMES_MOUNT_DIR=.stack/hermes/.hermes  # Mac-side source for the mount
HERMES_LOGTAIL_DASHBOARD=false     # also mirror hermes-dashboard journal to OrbStack Logs tab
```

All keys carry the `HERMES_` prefix to avoid collisions with other
services. `build.sh` reads the prefixed names from `.stack/.env` and
maps them into `~/.hermes/.env` inside the VM under the **upstream's**
un-prefixed names (e.g. `HERMES_TELEGRAM_BOT_TOKEN` →
`TELEGRAM_BOT_TOKEN`), which is what `hermes-agent` reads.

`HERMES_REMOTE_USER` decouples the VM's unix account from the Mac user.
OrbStack's default for `orb create` is to mirror `$USER`; we override
with `--user $HERMES_REMOTE_USER` to give Hermes a stable identity inside
the VM. systemd units + bin scripts under `services/hermes/` use
`__REMOTE_USER__` placeholders that `build.sh` substitutes at install
time. For existing VMs created before this lever (with the orb default
user), set `HERMES_REMOTE_USER=<that-username>` in `.stack/.env` to keep
the VM working without recreating. (`just setup` auto-migrates the
legacy un-prefixed `REMOTE_USER` / `TELEGRAM_*` keys on first run.)

`HERMES_MOUNT_ENABLED` + `HERMES_MOUNT_DIR` together drive a virtio-fs
bind-mount from `<repo-root>/.stack/hermes/.hermes/` (Mac) into
`/home/$HERMES_REMOTE_USER/.hermes/` (VM). When enabled (default):

- `build.sh` writes config edits Mac-side directly (no `orb -m` dance);
  the running gateway/dashboard see them immediately via the mount.
- A `tar` of `.stack/` captures the full Hermes state for backup.
- The hermes-workspace container can bind the same Mac path at
  `/home/workspace/.hermes/`, so its Settings UI edits the agent's
  actual `config.yaml` (no docker-volume divergence).

The heavy hermes-agent venv + source live at `/opt/hermes-agent/`
(VM-native, NOT on the share) via the installer's `HERMES_INSTALL_DIR`
env var — so the mount carries only user config + runtime state
(~250 MB), not the 1.4 GB Python venv.

When disabled, `build.sh` skips every step that would edit `~/.hermes/*`
and prints the equivalent `orb -m bash -lc` command for manual apply.
Other build steps (orb create, apt installs, systemd unit install, the
gateway-access drop-in) still run normally. Config changes through
`just build` are mount-enabled-only by design — keeps the dispatch
logic simple.

`HERMES_MEMORY` options (each requires the backing service enabled):

| value | backing service | notes |
|---|---|---|
| `default` | — | Hermes' own default (no override) |
| `honcho` | `just enable honcho` | OFFICIAL plugin → `honcho-api.<project>.orb.local:8000` |
| `hindsight` | `just enable hindsight` | OFFICIAL plugin → `hindsight.<project>.orb.local:8888` |
| `holographic` | — | OFFICIAL plugin; fully local in the VM (no stack service) |
| `agentmemory` | `just enable agentmemory` | THIRD-PARTY shim (`@agentmemory/mcp`); needs `npx` |

## Auto-wired by `services/hermes/build.sh` when the relevant profile is active

| profile | what gets injected |
|---|---|
| `firecrawl` | `FIRECRAWL_API_URL` + placeholder `FIRECRAWL_API_KEY` in `~/.hermes/.env` |
| `camofox-browser` | `CAMOFOX_URL` in `~/.hermes/.env` |
| `searxng` | `SEARXNG_URL` in `~/.hermes/.env` + `hermes config set web.search_backend searxng` |

## Telegram

Set the three `TELEGRAM_*` vars at the top of `.stack/.env` (initialized by
`just setup`) — these go into `~/.hermes/.env` on every `just build`.

## Isolation

Hermes VM is always created with `--isolated --isolate-network` (verified in
`just start`'s pre-flight; flip detected → fail-fast with instructions to
`just restart` so the flags take effect). Container reachability via orb DNS
is preserved; Mac IPs / sibling VMs are not. See `services/localhost-proxy/`
for the host-bridge pattern.

## chrome-cdp (manual-Chrome handoff)

Drive a real Mac Chrome (you log in / solve captcha → Hermes takes over via
CDP): `just chrome-cdp`. See `services/localhost-proxy/README.md` for the
network design.
