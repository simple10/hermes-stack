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
HERMES_MODEL=${STACK_LLM_MODEL}    # default: cliproxy/gpt-5.5
HERMES_MEMORY=honcho               # memory backend (one at a time)
```

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
