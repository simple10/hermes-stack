# hermes-stack

A composable, **multi-stack** personal AI stack: shared **Dockerized
backends** (Postgres + Redis), **AI services** (LiteLLM proxy + Honcho
memory), and an optional **Hermes agent** in an OrbStack Ubuntu machine — all
LLM/embedding traffic through LiteLLM for key rotation + observability. One
root compose (`include:` per service), Orb VMs under `machines/`, every
runtime secret in one gitignored `.stack/` dir. The Compose **project name**
(`COMPOSE_PROJECT_NAME` in `.stack/.env`, default `aitools`) scopes
containers/volumes/network, so several independent stacks run side by side;
OrbStack exposes each at `<service>.<project>.orb.local`.

```
hermes-stack/
  docker-compose.yaml          # NO name: (project = COMPOSE_PROJECT_NAME); include: services/*
  justfile                     # setup | build | start | stop | status | logs | reconfigure
  lib/                         # stacklib.sh (helpers incl. dc/stack_project), setup.sh, honcho-postup.sh
  .stack/                      # ALL runtime secrets — gitignored (created by `just setup`)
    .env  *.generated.env  .config-hashes/
  .stack.env.example           # documents .stack/.env (the only hand-edited file)
  services/
    postgres/  redis/          # always-on backends (no profile); project-scoped volumes
    litellm/                   # profile [litellm]; *.template -> *.runtime.* (bind-mounted)
    honcho/                    # profile [honcho]; built from pinned _source/ (gitignored)
    agentmemory/               # profile [agentmemory]; npm-pinned image + .env config; LiteLLM-wired
    hindsight/                 # profile [hindsight] (opt-in); pinned image; pg-backed; LiteLLM-wired
  machines/
    hermes/                    # build.sh + start.sh + systemd/ + bin/ + config/
  docs/plans/                  # 06 is current; 00–05 superseded (kept for history)
```

## Architecture

Services use plain names (no `aitools-` prefix, no `container_name:`); the
Compose project name namespaces everything. Within a stack, services reach
each other by service name on the Compose default network
(`<project>_default`). Nothing is published to the host; Hermes (outside the
project) reaches services via OrbStack DNS `<service>.<project>.orb.local`.

- **postgres / redis** — `pgvector/pgvector:pg18` (service `pg`; DBs `honcho`
  + `litellm`, each a least-priv role) and `redis:8.6.3` (service `redis`).
  No Compose profile → always-on shared backends.
- **litellm** — service `litellm`, official `litellm-database` image **pinned
  by digest**. Profile `[litellm]`.
- **honcho** — services `honcho-api` + `honcho-deriver`, built from a
  **pinned** `plastic-labs/honcho` commit. Profile `[honcho]`;
  `depends_on` pg/redis/litellm so `COMPOSE_PROFILES=honcho` auto-pulls them.
- **agentmemory** — service `agentmemory`, persistent agent memory. Profile
  `[agentmemory]`; standalone (file-based state on its own volume — no
  pg/redis). No published image: built from a Dockerfile that npm-installs
  the **pinned, maintainer-tested** `@agentmemory/agentmemory` release
  (`AGENTMEMORY_VERSION`, bump for newer "stable" code) + the pinned iii
  engine binary. LLM + embeddings routed through LiteLLM. Config split:
  committed non-secret `services/agentmemory/.env` (deviations from upstream
  defaults documented inline) + secrets via Compose `environment:` from
  `.stack/.env`. REST API at `agentmemory.<project>.orb.local:3111`; the
  **viewer web UI at `:3113`** (upstream binds it 127.0.0.1-only, so an
  in-container `socat` forwards the container's external IP:3113 → loopback
  and `VIEWER_ALLOWED_HOSTS` allowlists the orb host). ⚠️ The viewer is an
  unauthenticated admin surface — reachable only within OrbStack's local
  network (your Mac + your orb VMs), never the LAN/public internet. Disable
  it any time by setting `AGENTMEMORY_EXPOSE_VIEWER=0` in `.stack/.env` and
  recreating (no edit to the git-tracked compose; `:3113` then stays
  loopback-only). Not yet wired into Hermes (next step).
- **hindsight** — service `hindsight` (optional), prebuilt
  `vectorize-io/hindsight` all-in-one image **pinned by digest**. Profile
  `[hindsight]`; `depends_on` pg/litellm so `COMPOSE_PROFILES=hindsight`
  auto-pulls them. LLM + embeddings via LiteLLM (glm/grok + voyage; never
  `chatgpt/*`, gotcha #5). API `:8888`, Control-Plane UI `:9999`. Seeds its
  own pg role/db (fresh `<project>_pg-data` volume only). Not yet wired into
  Hermes.
- **cliproxyapi** — service `cliproxyapi` (optional), router-for-me/CLIProxyAPI
  via the prebuilt `eceasy/cli-proxy-api` image **pinned by tag**
  (`CLIPROXY_VERSION`, bump deliberately). Profile `[cliproxyapi]`;
  **standalone** — an *alternative* OAuth-subscription upstream proxy (ChatGPT
  Codex / Gemini CLI / Claude Code / Grok → OpenAI/Codex-compatible API), NOT
  a LiteLLM consumer (no pg/redis/litellm deps, no virtual key). Intended as a
  **streaming-correct ChatGPT/Codex responses proxy** to sidestep LiteLLM's
  non-streaming `chatgpt/*` bug (gotcha #5). Config is file-based: committed
  `config.yaml.template` → gitignored `config.runtime.yaml` (build.sh injects
  `CLIPROXY_API_KEY` + `CLIPROXY_MANAGEMENT_KEY` from `.stack/.env`). OpenAI/
  Codex API at `cliproxyapi.<project>.orb.local:8317` (api-key gated; orb-DNS
  only, no host ports — stack convention). Health at `/healthz`; the **admin
  UI is `/management.html`** (downloaded SPA; enter `CLIPROXY_MANAGEMENT_KEY`
  when prompted; `/` only returns API-info JSON). OAuth tokens persist in the
  `cliproxyapi-auth` volume. The provider OAuth callback **failing in the
  browser is EXPECTED** — by design you copy that failed callback URL from the
  address bar and paste it into the panel's callback field; the server
  completes the token exchange (no browser->container reachability needed).
  The alternative loopback-publish approach + per-provider fixed callback-port
  map is documented in `services/cliproxyapi/README.md` should we ever want to
  drop the copy/paste step. **Wired into Hermes**: the agent brain is
  `cliproxy/gpt-5.5` (LiteLLM `model_list` openai-compatible entry →
  `http://cliproxyapi:8317/v1`, `CLIPROXY_API_KEY`), streaming-correct and
  fully observable in LiteLLM SpendLogs — the replacement for the broken
  `chatgpt/*` responses bridge (kept for rollback).
- **Hermes** — runs in an OrbStack Ubuntu machine (`machines/hermes/`), not a
  container. Reaches the Dockerized services via
  `<service>.<project>.orb.local` (e.g. `litellm.aitools.orb.local`,
  `honcho-api.aitools.orb.local`). Its own agent brain AND Honcho's
  LLM/embedding calls route through LiteLLM.

Traffic: `Hermes → LiteLLM (cliproxy/gpt-5.5) → CLIProxyAPI → ChatGPT
subscription` for the agent — streaming-correct + fully logged (SpendLogs
records it as `openai/gpt-5.5` for the `hermes` key; the old `chatgpt/*`
LiteLLM responses-bridge entries are kept for one-line rollback);
`Hermes → Honcho → LiteLLM (glm/grok/voyage)` for memory.

## Prerequisites

macOS + **OrbStack** (Docker engine active, `orb` CLI on PATH), `just`,
`git`, `openssl`, `python3`. Docker Compose ≥ v2.20.3 (`include:`,
`COMPOSE_ENV_FILES`, cross-profile `depends_on` auto-pull).

## Quickstart (from scratch)

```bash
just setup     # interactive — writes .stack/.env (the only hand-edited secrets)
just build     # render configs, fetch pinned sources, gen DB passwords, provision machines
just start     # staged bring-up + (first run) ChatGPT device-pair, then everything up
```

- **`just setup`** prompts for the **Compose project name**
  (`COMPOSE_PROJECT_NAME`, default `aitools`), the OpenRouter + Voyage keys, an
  optional LiteLLM master key (blank → generated), Telegram (if `hermes` is
  enabled), the Docker `COMPOSE_PROFILES`, and `STACK_MACHINES`. Everything else (DB
  passwords, minted virtual keys) is machine-generated into
  `.stack/*.generated.env`. To run only part of the stack, set
  `COMPOSE_PROFILES` (e.g. `litellm` alone, or `honcho` — which auto-pulls
  litellm). `.stack/.env` is intentionally **not** auto-loaded by Compose;
  the `justfile` always passes it via `COMPOSE_ENV_FILES`, so a bare
  `docker compose up` from the repo root fails fast by design (guards against
  accidental parent-`.env` walking when running a single `services/<svc>`).
- **`just build`** runs `services/postgres/build.sh` (generate/reuse DB
  passwords), each enabled service's `build.sh` (render `*.template` →
  gitignored `*.runtime.*`; clone+pin `services/honcho/_source`), and each
  `STACK_MACHINES` machine's `build.sh`. A changed committed template only
  **warns** (`just reconfigure <svc>` to re-render) — no migration system.
- **`just start`** is **staged** (order is load-bearing): pg+redis → litellm
  → `services/litellm/start.sh` mints/reconciles a virtual key per
  `LITELLM_VIRTKEY_<ALIAS>_MODELS` into `.stack/litellm.generated.env` →
  `lib/honcho-postup.sh` brings Honcho up correctly (fresh DB → applies the
  1024 dim fix) → settle `up -d` → `machines/<m>/start.sh` last. `build.sh`
  does **not** require the minted `HERMES_VIRTUAL_KEY` (it doesn't exist until
  `start` mints it); `machines/hermes/start.sh` applies it post-mint and
  restarts the gateway. `litellm/start.sh` self-heals: if a stored key isn't
  valid in this DB (fresh/rotated/recreated), it re-mints instead of failing.

First-ever start with no ChatGPT token: LiteLLM prints a device-pair code in
`docker logs $(docker compose -p <project> ps -q litellm)` (visit the URL,
enter the code once); the token then persists in the bind-mounted
`services/litellm/chatgpt/` (gotcha #9).

### Multiple stacks

Each stack is one Compose project. To run a second stack, use a **separate
checkout/`.stack/`** (or just a different `.stack/.env`) with a distinct
`COMPOSE_PROJECT_NAME` **and** a distinct `STACK_MACHINES` name:

```
# stack A: COMPOSE_PROJECT_NAME=aitools   STACK_MACHINES=hermes
#          -> litellm.aitools.orb.local,  VM `hermes`
# stack B: COMPOSE_PROJECT_NAME=lab       STACK_MACHINES=lab-hermes
#          -> litellm.lab.orb.local,      VM `lab-hermes`
```

Containers, volumes (`<project>_pg-data`, …) and the network
(`<project>_default`) are all project-scoped, so the stacks are fully
isolated and never collide. There is **no data migration / volume reattach**:
recreating from scratch is the supported model — `just stop` then remove the
`<project>_*` volumes for a clean slate.

### `justfile` targets

| Target | Action |
|--------|--------|
| `just setup` | interactive `.stack/.env` generator |
| `just build` | render configs, fetch pinned sources, gen DB pw, provision machines |
| `just start` | staged bring-up (mint keys → honcho → machines) |
| `just stop` | `docker compose down --remove-orphans` (volumes kept; machines left running) |
| `just status` | this project's container health + `orb list` |
| `just logs [machine]` | `orb logs <machine>` (OrbStack Logs tab = the console) |
| `just reconfigure <svc>` | back up + re-render a service's runtime config from its template |

## Gotchas (hard-won — keep encoded)

1. **`xz-utils` required** — the Hermes installer extracts a Node `.tar.xz`;
   minimal Ubuntu lacks it. `machines/hermes/build.sh` apt-installs it first.
2. **Honcho config = `config.toml` + env; precedence `env > .env >
   config.toml`.** Templates carry placeholders only; the DB URI + virtual
   key come from compose env. No secret in any committed/rendered config.
3. **Voyage embeddings:** keep Honcho `embedding.dimensions_mode = "never"`.
   pgvector columns must be `vector(1024)`; the fresh-DB fix runs
   `scripts/configure_embeddings.py --yes` via the **in-image venv**
   (`/app/.venv/bin/python`), **NOT `uv run`** (it rebuilds in-image + fails).
4. **A PG rebuild / fresh project wipes the LiteLLM DB → stored virtual keys
   become invalid.** `services/litellm/start.sh` self-heals: it tries
   `/key/update` and, if the key isn't valid in this DB, re-mints and
   overwrites `.stack/litellm.generated.env`. So recreating a stack from
   scratch just works on the next `just start`.
5. **`chatgpt/*` via LiteLLM: non-streaming completions fail (known bug);
   streaming OK.** Hermes streams → fine. **Honcho must NEVER get
   `chatgpt/*`** in its virtual-key allowlist (its deriver/summary/dream/
   dialectic steps are non-streaming) — keep Honcho on glm/grok/voyage. This
   is why the two virtual keys get different `LITELLM_VIRTKEY_*_MODELS`.
6. **OrbStack machine "Logs" tab = the console (`/dev/console`), not
   journald.** `hermes-logtail` (root) mirrors `~/.hermes/logs/{gateway,
   errors}.log` there; `agent.log` excluded (DEBUG-spam).
7. **`hermes-agent` is the frozen original — never modified.**
   `machines/hermes/{build,start}.sh` hard-refuse it. The clone `hermes` is
   the working machine.
8. **`.stack/.env` is not auto-loaded by design.** Every compose call goes
   through the `justfile`'s `COMPOSE_ENV_FILES` (`.stack/.env` first, then
   `.stack/*.generated.env`).
9. **ChatGPT `auth.json` is a required runtime artifact** (gitignored, in no
   `.env`). Without it LiteLLM blocks on an interactive device-code prompt at
   boot and never goes healthy. On a fresh install complete the device pairing
   once (it persists in the bind-mounted `services/litellm/chatgpt/`).
10. **DNS is project-scoped: `<service>.<project>.orb.local`.** Services have
    no `container_name:` and the project name is a deliberate, configured
    value (`COMPOSE_PROJECT_NAME`), so the project-qualified OrbStack name is
    stable and is what isolates stacks. The hermes config templates carry a
    `__STACK_PROJECT__` placeholder that `machines/hermes/{build,start}.sh`
    substitute with `COMPOSE_PROJECT_NAME` (e.g. `litellm.aitools.orb.local`).
    Within a stack, containers reach each other by plain service name on
    `<project>_default`.
11. **agentmemory ≥0.9.18 runs an interactive first-run wizard** whenever
    `~/.agentmemory/preferences.json` is missing — on a non-TTY it
    `process.exit(0)`s, so the container crash-loops. The entrypoint
    pre-seeds `preferences.json` ("onboarding complete") to skip it; provider
    config still comes from env. (Verified empirically: the generic
    `iiidev/iii` image alone 404s every `/agentmemory/*` route — agentmemory
    must be npm-installed into the image, hence the build.)

## Secrets model

Every runtime secret lives in `.stack/` (gitignored in full). Nothing secret
is ever tracked in git.

| File | Contents | Owner |
|------|----------|-------|
| `.stack/.env` | `COMPOSE_PROJECT_NAME`, provider keys, master key, `AGENTMEMORY_SECRET`, Telegram, `COMPOSE_PROFILES`, `STACK_MACHINES`, `LITELLM_VIRTKEY_*_MODELS` declarations | you (`just setup`) |
| `.stack/db.generated.env` | `POSTGRES_SUPERPASS`, `HONCHO_DB_PASSWORD`, `LITELLM_DB_PASSWORD`, `HINDSIGHT_DB_PASSWORD` | `services/postgres/build.sh` |
| `.stack/litellm.generated.env` | minted `*_VIRTUAL_KEY` values | `services/litellm/start.sh` |
| `services/litellm/chatgpt/auth.json` | ChatGPT oauth token | LiteLLM (device pair) |

`*.generated.env` is machine-owned — never hand-edit (it gets
truncated/rewritten). Service config ships as committed `*.template`; the
rendered `*.runtime.*` is gitignored and bind-mounted. `git check-ignore`
covers `.stack/`, `**/*.generated.env`, `**/_source/`, `**/*.runtime.*`, and
`services/litellm/chatgpt/auth.json`.

`services/agentmemory/.env` is the one **committed** `.env` — it is
**non-secret by design** (base URLs, model names, feature flags only;
deviations from upstream defaults documented inline). agentmemory's secrets
(`OPENAI_API_KEY` = a LiteLLM virtual key, `AGENTMEMORY_SECRET`) are NOT in
it — they're injected via the Compose `environment:` block from `.stack/.env`.
