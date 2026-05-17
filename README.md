# hermes-stack

A composable personal AI stack: shared **Dockerized backends** (Postgres +
Redis), **AI services** (LiteLLM proxy + Honcho memory), and an optional
**Hermes agent** in an OrbStack Ubuntu machine — all LLM/embedding traffic
flowing through LiteLLM for key rotation + observability. One root compose
(`include:` per service), Orb VMs under `machines/`, and every runtime secret
in one gitignored `.stack/` dir.

```
hermes-stack/
  docker-compose.yaml          # name: hermes-stack + include: services/*/compose.yaml
  justfile                     # setup | build | start | stop | status | logs | reconfigure
  lib/                         # stacklib.sh (helpers), setup.sh, honcho-postup.sh
  .stack/                      # ALL runtime secrets — gitignored (created by `just setup`)
    .env  *.generated.env  .config-hashes/
  .stack.env.example           # documents .stack/.env (the only hand-edited file)
  services/
    postgres/  redis/          # always-on backends (no profile); volume-pinned
    litellm/                   # profile [litellm]; *.template -> *.runtime.* (bind-mounted)
    honcho/                    # profile [honcho]; built from pinned _source/ (gitignored)
  machines/
    hermes/                    # build.sh + start.sh + systemd/ + bin/ + config/
  docs/plans/                  # 06 is current; 00–05 superseded (kept for history)
```

## Architecture

- **postgres / redis** — `pgvector/pgvector:pg18` (`aitools-pg`; DBs `honcho`
  + `litellm`, each a least-priv role) and `redis:8.6.3` (`aitools-redis`).
  No Compose profile → always-on shared backends. On the external network
  `aitools-net`.
- **litellm** — `aitools-litellm`, official `litellm-database` image **pinned
  by digest**. Profile `[litellm]`.
- **honcho** — `aitools-honcho-api` + `aitools-honcho-deriver`, built from a
  **pinned** `plastic-labs/honcho` commit. Profile `[honcho]`;
  `depends_on` pg/redis/litellm so `COMPOSE_PROFILES=honcho` auto-pulls them.
- **Hermes** — runs in an OrbStack Ubuntu machine (`machines/hermes/`), not a
  container. Reaches the Dockerized services via **bare**
  `<container>.orb.local` DNS. Its own agent brain AND Honcho's
  LLM/embedding calls route through LiteLLM.

Traffic: `Hermes → LiteLLM (chatgpt/gpt-5.5, streaming)` for the agent;
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

- **`just setup`** prompts for the OpenRouter + Voyage keys, an optional
  LiteLLM master key (blank → generated), Telegram (if `hermes` is enabled),
  the Docker `COMPOSE_PROFILES`, and `STACK_MACHINES`. Everything else (DB
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
  `lib/honcho-postup.sh` brings Honcho up correctly for a fresh **or**
  reattached DB → settle `up -d` → `machines/<m>/start.sh` last (it needs the
  minted `HERMES_VIRTUAL_KEY`).

First-ever start with no ChatGPT token: LiteLLM prints a device-pair code in
`docker logs aitools-litellm` (visit the URL, enter the code once); the token
then persists in the bind-mounted `services/litellm/chatgpt/` (gotcha #9).

### Migrating an existing two-project stack

If you previously ran the old `aitools-backends`/`aitools-services` layout:
`docker compose ... down` both old projects (volumes are kept), copy the old
DB passwords into `.stack/db.generated.env`, the old virtual keys into
`.stack/litellm.generated.env`, the provider/master/Telegram values into
`.stack/.env`, and the ChatGPT `auth.json` into
`services/litellm/chatgpt/auth.json` — **before** `just build` (a fresh
`postgres/build.sh` would otherwise generate new passwords and lock out the
reattached PG volume). The new compose reattaches the existing named volumes
by explicit `volumes.*.name:`, so Honcho memory + LiteLLM keys survive
untouched. See `docs/plans/06-*.md` Task 7 for the exact commands.

### `justfile` targets

| Target | Action |
|--------|--------|
| `just setup` | interactive `.stack/.env` generator |
| `just build` | render configs, fetch pinned sources, gen DB pw, provision machines |
| `just start` | staged bring-up (mint keys → honcho → machines) |
| `just stop` | `docker compose down --remove-orphans` (volumes kept; machines left running) |
| `just status` | `aitools-*` container health + `orb list` |
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
4. **A PG major rebuild wipes the LiteLLM DB → virtual keys vanish.** This
   stack avoids it by reattaching the existing volume; if it ever happens,
   `services/litellm/start.sh` re-mints idempotently on the next `just start`.
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
   boot and never goes healthy. Migrate it like the DB passwords; on a fresh
   install complete the device pairing once (it persists in the bind mount).
10. **Hermes uses BARE OrbStack DNS** (`aitools-litellm.orb.local`,
    `aitools-honcho-api.orb.local`) — never `<container>.<project>.orb.local`.
    The project is `hermes-stack` (no per-file `name:`); a project-qualified
    FQDN silently dies (Hermes brain → "Connection error").

## Secrets model

Every runtime secret lives in `.stack/` (gitignored in full). Nothing secret
is ever tracked in git.

| File | Contents | Owner |
|------|----------|-------|
| `.stack/.env` | provider keys, master key, Telegram, `COMPOSE_PROFILES`, `STACK_MACHINES`, `LITELLM_VIRTKEY_*_MODELS` declarations | you (`just setup`) |
| `.stack/db.generated.env` | `POSTGRES_SUPERPASS`, `HONCHO_DB_PASSWORD`, `LITELLM_DB_PASSWORD` | `services/postgres/build.sh` |
| `.stack/litellm.generated.env` | minted `*_VIRTUAL_KEY` values | `services/litellm/start.sh` |
| `services/litellm/chatgpt/auth.json` | ChatGPT oauth token | LiteLLM (device pair) |

`*.generated.env` is machine-owned — never hand-edit (it gets
truncated/rewritten). Service config ships as committed `*.template`; the
rendered `*.runtime.*` is gitignored and bind-mounted. `git check-ignore`
covers `.stack/`, `**/*.generated.env`, `**/_source/`, `**/*.runtime.*`, and
`services/litellm/chatgpt/auth.json`.
