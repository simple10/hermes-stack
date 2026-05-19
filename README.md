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
  lib/                         # stacklib.sh (helpers incl. dc/stack_project), setup.sh
  .stack/                      # ALL runtime secrets — gitignored (created by `just setup`)
    .env  *.generated.env  .config-hashes/
  .stack.env.example           # documents .stack/.env (the only hand-edited file)
  services/
    postgres/  redis/          # always-on backends (no profile); project-scoped volumes
    litellm/                   # profile [litellm]; *.template -> *.runtime.* (bind-mounted)
    honcho/                    # profile [honcho]; built from pinned _source/ (gitignored)
    honcho-ui/                 # profile [honcho-ui]; OpenConcho SPA, pinned _source/ -> nginx
    agentmemory/               # profile [agentmemory]; npm-pinned image + .env config; LiteLLM-wired
    hindsight/                 # profile [hindsight] (opt-in); pinned image; pg-backed; LiteLLM-wired
    firecrawl/                 # profile [firecrawl] (opt-in); nuq-backed web-scraper API; rabbitmq-wired; LiteLLM-wired
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
  LLM via cliproxy through LiteLLM (deriver/summary/dream →
  `HONCHO_*_MODEL`/`STACK_LLM_MODEL_FAST`, dialectic → `HONCHO_DIALECTIC_MODEL`/
  `STACK_LLM_MODEL`); embeddings Voyage. Models are `.stack/.env` levers
  injected into the rendered `config.runtime.toml` by `honcho/build.sh`.
- **honcho-ui** — service `honcho-ui` (optional), the
  [OpenConcho](https://github.com/offendingcommit/openconcho) web UI for
  Honcho. No published image: a multi-stage Dockerfile pnpm-builds the static
  SPA from a **pinned** `offendingcommit/openconcho` commit (gitignored
  `_source/`, fetched by `honcho-ui/build.sh`) and serves it via nginx.
  Profile `[honcho-ui]`; `depends_on honcho-api` so
  `COMPOSE_PROFILES=honcho-ui` auto-pulls Honcho's API (enable the `honcho`
  profile too for the deriver/dream features). Stateless — no DB, no secrets,
  no model/env levers: connection config lives in browser localStorage
  (OpenConcho's design). nginx also **reverse-proxies Honcho under `/honcho/`
  on the same origin**: Honcho hardcodes its CORS allowlist (no config knob),
  so a direct cross-origin browser call from the UI is blocked — same-origin
  proxying sidesteps CORS entirely and keeps honcho-ui decoupled from Honcho
  internals. Upstream has no default-endpoint config, so the Dockerfile
  build-time patches the hardcoded `http://localhost:8000` default to that
  same-origin proxy path (`HONCHO_BASE_URL` build arg, project-scoped via
  `COMPOSE_PROJECT_NAME`; `_source/` stays pristine). The **token is never
  injected** — it remains a manual in-app field. nginx listens on `:80` and
  OrbStack fronts it with auto-HTTPS; nginx **308-redirects plain http to
  https** (detected via `X-Forwarded-Proto`; the loopback healthcheck uses
  an exempt `/healthz`), so the canonical URL is
  `https://honcho-ui.<project>.orb.local`. The first-run form opens
  **pre-filled** with `https://honcho-ui.<project>.orb.local/honcho` — same
  scheme as the page OrbStack serves, so no CORS / mixed-content (Honcho
  runs `USE_AUTH=false` here → token can stay blank). Just click Save.
- **agentmemory** — service `agentmemory`, persistent agent memory. Profile
  `[agentmemory]`; standalone (file-based state on its own volume — no
  pg/redis). No published image: built from a Dockerfile that npm-installs
  the **pinned, maintainer-tested** `@agentmemory/agentmemory` release
  (`AGENTMEMORY_VERSION`, bump for newer "stable" code) + the pinned iii
  engine binary. LLM via cliproxy through LiteLLM (`AGENTMEMORY_MODEL` lever)
  + Voyage embeddings (`AGENTMEMORY_EMBEDDING_MODEL`). Config split: committed
  non-secret `services/agentmemory/.env` (flags only — no model/secret) +
  Compose `environment:` injecting the model levers + secrets from
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
  auto-pulls them. LLM via cliproxy through LiteLLM (`HINDSIGHT_MODEL`
  lever) + Voyage embeddings (`HINDSIGHT_EMBEDDING_MODEL`). **Reranker** is
  the `HINDSIGHT_RERANKER` lever: `local` (in-process Torch cross-encoder,
  best quality, ~600 MB RAM), `litellm` (rerank via LiteLLM →
  `HINDSIGHT_RERANK_MODEL`, default the `rerank-voyage` model →
  Voyage `rerank-2.5-lite`; **no Torch, ~300 MB saved**, observable in
  SpendLogs, small per-rerank API cost), or `rrf` (rank-fusion; no
  model/API/RAM, weakest). `.stack.env.example` defaults `local`; the lever
  switches with no git edits. API `:8888`, Control-Plane UI `:9999`. Seeds
  its own pg role/db (fresh `<project>_pg-data` volume only). Not yet wired
  into Hermes.
- **firecrawl** — service `firecrawl` (optional), web-scraper API backed by the
  nuq (non-uniform queue) engine. Profile `[firecrawl]`; opt-in via the
  `firecrawl` profile; needs the always-on `rabbitmq` backend (stateless
  notify/prefetch transport). Uses a **dedicated `firecrawl-postgres`** appliance
  — never the shared `pg` — for its pg_cron-driven queue engine. Extract
  routed via LiteLLM.
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
  LLM/embedding calls route through LiteLLM. **Memory backend** is the
  single `HERMES_MEMORY` lever in `.stack/.env`
  (`default|honcho|hindsight|holographic|agentmemory`, default `honcho`):
  `machines/hermes/build.sh` translates it to Hermes' official
  `hermes config set memory.provider` + seeds that provider's config to point
  at the in-stack service (`honcho` → `honcho.json`; `hindsight` →
  `~/.hermes/hindsight/config.json` *local_external* →
  `hindsight.<project>.orb.local:8888`; `holographic` → local, no service;
  `agentmemory` → third-party `@agentmemory/mcp` shim +
  `AGENTMEMORY_URL`/`AGENTMEMORY_SECRET` → `agentmemory.<project>...:3111`).
  Switch backends = edit the lever + `just build` (no git-tracked edits);
  build.sh warns if the chosen provider's service isn't in `COMPOSE_PROFILES`.

Traffic: **everything chat-LLM → LiteLLM → CLIProxyAPI → ChatGPT
subscription** (Hermes brain, Honcho, agentmemory, hindsight), streaming +
non-streaming both verified; **embeddings → LiteLLM → Voyage** (unchanged).
Every call is in LiteLLM SpendLogs attributed per consumer key
(`hermes`/`honcho`/`agentmemory`/`hindsight`); the resolved model logs as
`openai/<model>` (cliproxy entries) or `voyage/<model>`. Centralized
fallback: any `cliproxy/*` error (ChatGPT-sub quota/429) transparently
retries on `glm-4.7-flash` (OpenRouter). Old `chatgpt/*` responses-bridge
entries kept for rollback.

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
- **`just build`** runs `services/postgres/build.sh` (generate/reuse only
  `POSTGRES_SUPERPASS`), each enabled service's `build.sh` (render
  `*.template` → gitignored `*.runtime.*`; clone+pin `services/honcho/_source`;
  **own its `<SVC>_DB_PASSWORD`** in `.stack/<svc>.generated.env`), and each
  `STACK_MACHINES` machine's `build.sh`. A changed committed template only
  **warns** (`just reconfigure <svc>` to re-render) — no migration system.
- **`just start`** is a **generic pipeline** (no service names beyond the
  `pg redis` backend substrate): `dc up -d pg redis` → each enabled
  profile's `services/<p>/preflight.sh` (e.g. `litellm/preflight.sh` brings
  up litellm + mints one **unrestricted** virtual key per `LITELLM_VIRTKEYS`
  alias into `.stack/litellm.generated.env`) → recompute `COMPOSE_ENV_FILES`
  → each `services/<p>/prestart.sh` (fail-loud config validation) →
  `dc up -d` (each service's one-shot **provisioner**(s) create its
  role/db/extension/schema, ordered by `depends_on` — e.g. honcho:
  `pg → honcho-provision → honcho-schema → honcho-api`) → each
  `services/<p>/poststart.sh` (generic hook; currently unused) →
  `machines/<m>/start.sh` → optional `just start-cleanup`.
  `build.sh` does **not** require the minted `HERMES_VIRTUAL_KEY` (it doesn't
  exist until `start` mints it); `machines/hermes/start.sh` applies it
  post-mint and restarts the gateway. `litellm/preflight.sh` self-heals: if a
  stored key isn't valid in this DB (fresh/rotated/recreated), it re-mints.

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
| `just start` | generic pipeline: backends → `preflight.sh` (mint) → `prestart.sh` (validate) → `up -d` (provisioners) → `poststart.sh` → machines |
| `just start-cleanup` | remove this project's exited provisioner containers (auto-run by `start` when `STACK_AUTO_REMOVE_PROVISIONERS=true`) |
| `just stop` | `docker compose down --remove-orphans` (volumes kept; machines left running) |
| `just status` | this project's container health + `orb list` |
| `just logs [machine]` | `orb logs <machine>` (OrbStack Logs tab = the console) |
| `just reconfigure <svc>` | back up + re-render a service's runtime config from its template |

## Service lifecycle

Each service owns its lifecycle via per-service artifacts, discovered
generically by `just` (no service names in `lib/`/`justfile` beyond the
`pg redis` backend substrate):

| Artifact | Phase | One job |
|---|---|---|
| `services/<svc>/build.sh` | `just build` (offline, no Docker) | render configs, gen/rotate secrets (incl. own `<SVC>_DB_PASSWORD`), fetch sources |
| `services/<svc>/preflight.sh` | `just start`, before main `up` | host script; may `dc up -d <dep>` + mint/edit `.stack/` (e.g. LiteLLM keys) |
| `services/<svc>/prestart.sh` | `just start`, after preflight | host script; validate env/config, **fail loud** before the heavy `up` |
| **provisioner**(s) in `compose.yaml` (`com.stack.role=provisioner`) | Compose `up` (`depends_on`) | one-shot; idempotent role/db/extension/schema. A service may chain >1 (honcho: `honcho-provision` role/db → `honcho-schema` migrate+`configure_embeddings`@1024) |
| `services/<svc>/poststart.sh` | after main `up -d` | generic hook for steps needing something serving — **currently unused** (honcho's old dim-fix is now the pre-start `honcho-schema` one-shot) |
| `machines/<m>/start.sh` | after stack up | bring up the VM/agent |

**Container vs host-script principle:** if a step must be ordered *within*
the main `up` relative to a service → it's a **provisioner container** (only
Compose `depends_on: service_completed_successfully` can express that gate);
if it must run *before* the main `up` to produce inputs the up consumes
(minted keys in env) → it's a **host `preflight.sh`**. `build` produces,
`preflight` prepares inputs, `prestart` validates, the provisioner
provisions, `poststart` finalizes.

## Gotchas (hard-won — keep encoded)

1. **`xz-utils` required** — the Hermes installer extracts a Node `.tar.xz`;
   minimal Ubuntu lacks it. `machines/hermes/build.sh` apt-installs it first.
2. **Honcho config = `config.toml` + env; precedence `env > .env >
   config.toml`.** Templates carry placeholders only; the DB URI + virtual
   key come from compose env. No secret in any committed/rendered config.
3. **Honcho embedding dim is set BEFORE honcho-api serves, by the
   `honcho-schema` one-shot — never resized post-start.** Alembic hardcodes
   `vector(1536)`; `honcho-schema` runs `provision_db.py` then
   `scripts/configure_embeddings.py --yes` via the **in-image venv**
   (`/app/.venv/bin/python`, **NOT `uv run`** — it rebuilds in-image + fails),
   which ALTERs the **empty** `documents`/`message_embeddings` columns to
   `EMBEDDING_VECTOR_DIMENSIONS` (set to `1024` as env on
   honcho-api/deriver/schema; honcho settings precedence is env > TOML, and
   the startup validator refuses to serve unless the physical dim matches).
   `configure_embeddings.py` **refuses a populated column** and **no-ops when
   the dim already matches** → safe & idempotent every start. In-place resize
   of a *populated* column is out of scope (needs an out-of-band re-embed
   migration), never automated.
4. **A PG rebuild / fresh project wipes the LiteLLM DB → stored virtual keys
   become invalid.** `services/litellm/preflight.sh` self-heals: it tries
   `/key/update` and, if the key isn't valid in this DB, re-mints and
   overwrites `.stack/litellm.generated.env`. So recreating a stack from
   scratch just works on the next `just start`.
5. **The LiteLLM `chatgpt/*` responses-bridge is non-streaming-broken (known
   bug)** — those entries are kept ONLY for rollback. Everything now uses
   `cliproxy/*` (plain openai-compatible upstream → CLIProxyAPI), which is
   verified working for **both** streaming (Hermes) and non-streaming
   (Honcho/agentmemory/hindsight). The constraint is now enforced not by
   per-key model allowlists (virtual keys are unrestricted) but by the
   explicit per-service `.stack/.env` model levers — never set a service's
   `*_MODEL` lever to a `chatgpt/*` value.
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
12. **Adding a pg-using service is purely additive — no `00-init.sql`, no
    volume recreate.** Each service owns its `<SVC>_DB_PASSWORD` in
    `.stack/<svc>.generated.env` (its `build.sh`, read-or-gen — never
    blind-regen, which would shadow a live pw via `*.generated.env`
    last-wins) and ships a `provision.sql` + a one-shot
    **`com.stack.role=provisioner`** Compose service (`depends_on: pg
    healthy`; the real service `depends_on: <svc>-provision
    service_completed_successfully`). A service may chain more than one (e.g.
    honcho: `honcho-provision` role/db/ext → `honcho-schema`
    migrate+`configure_embeddings`). Provisioners run **every `just start`**,
    idempotently (role-if-absent + `ALTER ROLE … PASSWORD` re-sync + db-if-
    absent + `CREATE EXTENSION IF NOT EXISTS`; psql retried ×30 for the
    fresh-pg readiness race) — a no-op on existing data.
    `STACK_AUTO_REMOVE_PROVISIONERS=true` reaps their `Exited (0)` containers.
13. **`pg` extension binaries / `shared_preload_libraries` / global
    `ALTER SYSTEM` are the surgical bucket — never a provisioner's job.**
    Postgres data lives in the `<project>_pg-data` volume, independent of
    image/config: changing the git-tracked `services/postgres/` definition
    and `dc up -d pg` recreates **only** the `pg` container, re-mounting the
    volume — **non-destructive within a PG major** (a major-version bump is
    the only data-destructive change; out of scope). In-database
    role/db/extension stays in the per-service provisioner.
14. **Firecrawl uses a DEDICATED `firecrawl-postgres`, never the shared `pg`.**
    `nuq-postgres` is a purpose-built appliance: `pg_cron`
    `shared_preload_libraries` + cluster-wide `ALTER SYSTEM` + ~40 cron jobs
    that ARE the queue engine (reapers/GC/REINDEX). It self-initializes its
    own single-tenant `firecrawl-pg-data` volume (no provisioner). `rabbitmq`
    is a stateless nuq notify/prefetch transport → shared always-on backend.
    Losing `firecrawl-pg-data` loses only in-flight jobs (ephemeral queue).

## Secrets model

Every runtime secret lives in `.stack/` (gitignored in full). Nothing secret
is ever tracked in git.

**Model levers (single surface).** `.stack/.env` is the *only* place models
are chosen. Presets `STACK_LLM_MODEL` / `STACK_LLM_MODEL_FAST` /
`STACK_LLM_EMBEDDING_MODEL` feed explicit namespaced per-service vars
(`HERMES_MODEL`, `AGENTMEMORY_MODEL`, `HONCHO_DERIVER_MODEL`,
`HONCHO_DIALECTIC_MODEL`, `HINDSIGHT_MODEL`, … + the `*_EMBEDDING_MODEL`
ones). `.stack/.env` is bash-sourced by `just`, so `FOO=${STACK_LLM_MODEL}`
expands (presets must stay above refs). Service `compose.yaml`/templates
reference **only** the namespaced vars — never `STACK_*` — so any model change
is a one-line `.stack/.env` edit with **zero git-tracked file changes / no
`git pull` conflicts**. honcho's per-module values are injected into the
gitignored `config.runtime.toml` by `honcho/build.sh`; agentmemory/hindsight
read theirs via Compose `environment:`; Hermes via `machines/hermes`.

| File | Contents | Owner |
|------|----------|-------|
| `.stack/.env` | `COMPOSE_PROJECT_NAME`, provider keys, master key, `AGENTMEMORY_SECRET`, Telegram, `COMPOSE_PROFILES`, `STACK_MACHINES`, `HERMES_MEMORY`, model levers (`STACK_LLM_MODEL*` + per-service `*_MODEL`), `LITELLM_VIRTKEYS` | you (`just setup`) |
| `.stack/db.generated.env` | `POSTGRES_SUPERPASS` only (per-service DB passwords are decentralized) | `services/postgres/build.sh` |
| `.stack/<svc>.generated.env` | that service's `<SVC>_DB_PASSWORD` (e.g. `litellm`, `honcho`, `hindsight`) | `services/<svc>/build.sh` |
| `.stack/litellm.generated.env` | minted `*_VIRTUAL_KEY` values (+ `LITELLM_DB_PASSWORD`) | `services/litellm/{build,preflight}.sh` |
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
