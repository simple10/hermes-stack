# Unified Stack Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two-compose-project layout (`aitools-backends` + `aitools-services`) plus standalone build scripts into one composable stack: a single root `docker-compose.yaml` (`include:` per service), Docker services under `services/`, Orb VMs under `machines/`, and ALL runtime secrets in one `.stack/` dir — driven by `just setup|build|start`.

**Architecture:** Each `services/<svc>/compose.yaml` is self-contained (own external-network + pinned-volume decls) so it runs standalone *and* merges via root `include:`. App services carry Docker `profiles:`; shared backends (postgres, redis) carry none (always-on). `COMPOSE_PROFILES` (in `.stack/.env`) is the single source of truth for what runs; `depends_on` auto-pulls dependencies. Secrets split: hand-edited `.stack/.env` vs machine-owned `.stack/*.generated.env`, all loaded via `COMPOSE_ENV_FILES`. Service config ships as `*.template` (committed); a gitignored rendered `*.runtime.*` is bind-mounted. LiteLLM virtual keys are *declared* at build, *minted* by LiteLLM post-health and written back. Existing Docker volumes are reattached by explicit name so **no Honcho memory / LiteLLM keys are lost** in the restructure.

**Tech Stack:** Docker Compose v2 (`include:`, `COMPOSE_ENV_FILES`, profiles), OrbStack (Docker engine + Linux machines), `just`, bash, pgvector/pgvector:pg18, redis:8.6.3, LiteLLM (pinned digest), Honcho (pinned source commit), Hermes (Orb VM).

---

## Design Decisions (locked — agreed in design discussion)

1. **`services/` = strictly Docker, `machines/` = strictly Orb VMs.** Hermes stays an Orb VM at `machines/hermes/`.
2. **Single root `docker-compose.yaml`** = `name:` + `include:` only. Each `services/<svc>/compose.yaml` declares its own external `aitools-net` + pinned volumes. **postgres/redis/litellm validate & run standalone** (`cd services/<svc> && docker compose ...`). **honcho is the deliberate exception:** it carries cross-file `depends_on` (pg/redis/litellm) for profile auto-pull + ordering, so it does NOT validate standalone (and running honcho without its backends is meaningless anyway) — honcho is validated/run via the root `include:` merged model, which is the supported path for it.
3. **Profiles:** postgres + redis have **no `profiles:`** (always-on shared backends). litellm → `profiles: [litellm]`. honcho → `profiles: [honcho]` + `depends_on` postgres, redis, litellm. `COMPOSE_PROFILES` in `.stack/.env` is the only knob; `depends_on` auto-pulls dependency services even if their profile is inactive (Compose ≥ v2.20.3).
4. **`.stack/` holds ALL runtime secrets, gitignored entirely.** `.stack/.env` = hand-edited core (provider keys, `LITELLM_MASTER_KEY`, Telegram, `COMPOSE_PROFILES`, `STACK_MACHINES`, `LITELLM_VIRTKEY_*_MODELS` allowlist *declarations*). `.stack/db.generated.env` = postgres-owned DB passwords. `.stack/litellm.generated.env` = litellm-owned minted virtual keys. The `.generated.` infix marks "machinery may truncate+rewrite this; never hand-edit."
5. **`.stack/.env` is NOT auto-loaded** (it is not in the compose project root). The justfile always sets `COMPOSE_ENV_FILES=.stack/.env,<glob .stack/*.generated.env>` (`.env` first = lowest precedence). A bare `docker compose up` from repo root therefore fails fast (no vars) — this is the *desired* guard against accidental parent-chain `.env` walking when running a single service dir.
6. **Config = `*.template` (committed) → rendered `*.runtime.*` (gitignored, bind-mounted).** Render = copy template→runtime **only if runtime absent** (never clobber a user-customized runtime). Templates contain **no secrets** — secrets stay placeholders the container resolves from env at runtime (LiteLLM `os.environ/...`; Honcho `env > config.toml` precedence). HARD RULE: no `.env` or rendered runtime config ever committed (per-service `.gitignore` + root globs).
7. **Virtual-key timing:** `build` renders config + ensures the *declaration* exists in `.stack/.env`. `litellm/start.sh` (post-litellm-health) mints/reconciles each `LITELLM_VIRTKEY_<ALIAS>_MODELS` and writes `<ALIAS>_VIRTUAL_KEY` into `.stack/litellm.generated.env`. Honcho/Hermes consume those env vars and therefore start **after** mint. `just start` is **staged**, not one `compose up`.
8. **Volume preservation:** the new project reattaches the EXISTING named volumes by explicit `name:` so the restructure does NOT rebuild PG → Honcho memory and LiteLLM virtual keys survive. Container names stay `aitools-pg`/`aitools-redis`/`aitools-litellm`/`aitools-honcho-api`/`aitools-honcho-deriver`. **The Hermes VM MUST use the BARE `<container>.orb.local` DNS**, never `<container>.<project>.orb.local` — the project name changed to `hermes-stack` (no per-file `name:`, per decision 2/C1), so a project-qualified FQDN breaks. honcho.json already uses the bare form; `config.yaml.model.tmpl` uses `http://aitools-litellm.orb.local:4000/v1`.
9. **Template-drift = warn only.** Record template sha256 at render; `just build` warns if a committed template changed since the rendered file was produced. No migration system (user upgrades by hand, same as any standalone service).
10. **`hermes-agent` is the frozen original — `machines/hermes/build.sh` MUST refuse it absolutely.** The `hermes` clone IS authorized for rebuild (user: "safe to rebuild as needed"). Default machine = `hermes`.

## Target File Structure

```
hermes-stack/
  docker-compose.yaml              # name: + include: (NEW; replaces 2 project files)
  justfile                         # setup|build|start|stop|status|logs|reconfigure (REWRITE)
  lib/stacklib.sh                  # shared bash helpers (NEW)
  .stack/                          # ALL secrets — gitignored (NEW, created by `just setup`)
    .env  *.generated.env  .config-hashes/
  .stack.env.example               # documents .stack/.env (NEW; replaces secrets.env.example)
  services/
    postgres/{compose.yaml, build.sh, pg-init/00-init.sql}
    redis/compose.yaml
    litellm/{compose.yaml, build.sh, start.sh, .gitignore,
             config.yaml.template, chatgpt/.gitkeep, README.md}
    honcho/{compose.yaml, build.sh, .gitignore,
            config.toml.template, _source/(gitignored)}
  machines/
    hermes/{build.sh, start.sh, systemd/*.service, bin/hermes-logtail.sh,
            config/honcho.json.tmpl, config/config.yaml.model.tmpl}
  docs/plans/                      # existing + this (06); 00–05 get a superseded banner
  README.md                        # REWRITE for new layout + gotchas
  # REMOVED: aitools-backends/  aitools-services/  build-stack.sh  build-hermes.sh
  #          secrets.env.example  hermes-vm/  hermes-config-snapshot/
```

## Gotchas to carry forward (hard-won — must remain encoded)

1. **xz-utils**: Hermes installer extracts Node `.tar.xz`; minimal Ubuntu lacks it → `machines/hermes/build.sh` apt-installs it.
2. **Honcho fresh-DB dim fix uses the in-image venv, NOT `uv run`** (`uv run` rebuilds the project in-image and fails): `--entrypoint /app/.venv/bin/python ... scripts/configure_embeddings.py --yes`. Only on a FRESH honcho DB (cols default to 1536 → must become 1024); skip when reattaching existing 1024 data.
3. **`chatgpt/*` via LiteLLM: non-streaming completions fail (known bug); streaming OK.** Hermes streams → fine. **Honcho must NEVER get `chatgpt/*`** in its virtual-key allowlist (its deriver/summary/dream/dialectic-tool steps are non-streaming) — keep Honcho on glm/grok/voyage.
4. **A PG *major* rebuild wipes the LiteLLM DB → virtual keys vanish.** This plan AVOIDS that by reattaching the existing volume. If a wipe ever happens, `litellm/start.sh` re-mints (idempotent) and Honcho/Hermes pick up the new keys on next `just start`.
5. **OrbStack machine "Logs" tab = the console (`/dev/console`), not journald.** `hermes-logtail.sh` mirrors gateway.log+errors.log there as root; `agent.log` excluded (DEBUG-spam).
6. **Pin everything**: litellm by digest (`services/litellm/.image-digest`), honcho by source commit, pg/redis by tag. Deliberate bumps via commits.
7. **Voyage embeddings**: keep Honcho `embedding.dimensions_mode="never"` (Voyage 400s on `dimensions`); pgvector cols must be `vector(1024)`.
8. **`.stack/.env` not auto-loaded by design** (decision 5) — every compose call goes through the justfile's `COMPOSE_ENV_FILES`.
9. **ChatGPT `auth.json` is a required runtime artifact.** It is gitignored and lives in no `.env`. Without it (bind-mounted at `services/litellm/chatgpt/auth.json`) LiteLLM blocks on an interactive device-code prompt at boot and never goes healthy. Migrate it like the DB passwords; on a truly fresh install complete the device pairing once (`docker logs aitools-litellm` prints the code) — the token then persists in the bind-mounted dir.
10. **Hermes must use BARE OrbStack DNS** (`aitools-litellm.orb.local`, `aitools-honcho-api.orb.local`), never `<container>.<project>.orb.local`. The Compose project is `hermes-stack` (no per-file `name:`); a project-qualified FQDN silently dies and Hermes's brain call fails with "Connection error" while Honcho (already bare) keeps working.

---

## Task 1: Scaffold lib + .stack model + root compose

**Files:**
- Create: `lib/stacklib.sh`
- Create: `docker-compose.yaml`
- Create: `.stack.env.example`
- Modify: `.gitignore` (add `.stack.env.example` negation note; root globs already added)

- [ ] **Step 1: Write `lib/stacklib.sh`** (shared helpers; `set -euo pipefail` by callers)

```bash
#!/usr/bin/env bash
# stacklib.sh — shared helpers for hermes-stack scripts. Source, don't exec.
# Callers set `set -euo pipefail`.

stack_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }
STACK_ROOT="${STACK_ROOT:-$(stack_root)}"
STACK_DIR="$STACK_ROOT/.stack"

log()  { printf '\n=== %s ===\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

# env_upsert FILE KEY VALUE — idempotent: replace `^KEY=` line or append. Never dupes.
env_upsert() {
  local f="$1" k="$2" v="$3"
  mkdir -p "$(dirname "$f")"; touch "$f"
  if grep -q "^${k}=" "$f" 2>/dev/null; then
    local tmp; tmp="$(mktemp)"
    grep -v "^${k}=" "$f" > "$tmp" || true
    printf '%s=%s\n' "$k" "$v" >> "$tmp"
    mv "$tmp" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
  chmod 600 "$f"
}

# env_get FILE KEY — print value or empty.
env_get() { grep "^${2}=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# render_template TEMPLATE OUT SERVICE — copy TEMPLATE->OUT only if OUT missing;
# record template hash; if OUT exists, drift-check (warn only).
render_template() {
  local tpl="$1" out="$2" svc="$3"
  local hdir="$STACK_DIR/.config-hashes"; mkdir -p "$hdir"
  local hf="$hdir/${svc}.$(basename "$out").sha256"
  local cur; cur="$(shasum -a 256 "$tpl" | cut -d' ' -f1)"
  if [ ! -f "$out" ]; then
    cp "$tpl" "$out"; printf '%s\n' "$cur" > "$hf"
    log "rendered $out from $(basename "$tpl")"
  else
    local rec; rec="$(cat "$hf" 2>/dev/null || echo none)"
    if [ "$cur" != "$rec" ]; then
      warn "$svc: $(basename "$tpl") changed since $(basename "$out") was rendered."
      warn "  Review changes and re-render with: just reconfigure $svc"
    else
      log "$out present and up to date (no template drift)"
    fi
  fi
}

# require_secrets_file — .stack/.env must exist.
require_stack_env() {
  [ -f "$STACK_DIR/.env" ] || die ".stack/.env missing — run: just setup"
}

# compose_env_files — print comma list: .stack/.env first, then *.generated.env.
compose_env_files() {
  local list=".stack/.env"
  local g
  for g in "$STACK_DIR"/*.generated.env; do
    [ -e "$g" ] && list="$list,.stack/$(basename "$g")"
  done
  printf '%s' "$list"
}
```

- [ ] **Step 2: Write root `docker-compose.yaml`**

```yaml
# hermes-stack — unified compose. Run via `just` (it sets COMPOSE_ENV_FILES;
# .stack/.env is intentionally NOT auto-loaded — see plan decision 5).
# Each services/<svc>/compose.yaml is self-contained (own network/volume decls)
# so it also runs standalone: `cd services/<svc> && docker compose up`.
name: hermes-stack

include:
  - services/postgres/compose.yaml
  - services/redis/compose.yaml
  - services/litellm/compose.yaml
  - services/honcho/compose.yaml
```

- [ ] **Step 3: Write `.stack.env.example`**

```bash
# Copy to .stack/.env (gitignored) — or run `just setup` to generate it.
# This is the ONLY hand-edited secrets file. db passwords + minted virtual
# keys are machine-owned in .stack/*.generated.env (never hand-edit those).

# --- providers (consumed by LiteLLM at container runtime) ---
OPENROUTER_API_KEY=
VOYAGE_API_KEY=

# --- LiteLLM admin key (blank => `just setup` generates a stable one) ---
LITELLM_MASTER_KEY=

# --- Telegram (Hermes gateway; only needed if machines includes hermes) ---
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USERS=
TELEGRAM_HOME_CHANNEL=

# --- what runs ---
# Docker service profiles (single source of truth; deps auto-pulled):
COMPOSE_PROFILES=litellm,honcho
# Orb machines (space/comma list; e.g. hermes). Empty = no machines.
STACK_MACHINES=hermes

# --- virtual-key allowlist DECLARATIONS (non-secret; minted by litellm) ---
# Honcho: glm/grok/voyage ONLY — NEVER chatgpt/* (non-streaming bug).
LITELLM_VIRTKEY_HONCHO_MODELS=glm-4.7-flash,grok-4.3,glm-5,voyage-4-lite,voyage-4-large,voyage-4,voyage-code-3,voyage-finance-2,voyage-law-2
# Hermes brain: chatgpt/* (streams) + glm/grok fallback.
LITELLM_VIRTKEY_HERMES_MODELS=chatgpt/gpt-5.5,chatgpt/gpt-5.4,chatgpt/gpt-5.4-mini,chatgpt/gpt-5.3-codex,chatgpt/gpt-5.3-codex-spark,glm-4.7-flash,grok-4.3,glm-5
```

- [ ] **Step 4: Add `.stack.env.example` keep-rule to `.gitignore`**

Append under the unified-stack section (root `.stack/` is already ignored; we must force-track the example which lives at repo root, not in `.stack/`, so no change needed — verify `.stack.env.example` is NOT matched by `.stack/`). Run:

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git check-ignore -v .stack.env.example && echo "BUG: example is ignored" || echo "ok: example trackable"
```
Expected: `ok: example trackable`

- [ ] **Step 5: Verify lib + compose syntax**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
bash -n lib/stacklib.sh && echo "stacklib ok"
# compose config can't fully validate until service files exist (Task 2-4);
# just assert YAML parses:
python3 -c "import yaml,sys; yaml.safe_load(open('docker-compose.yaml')); print('compose yaml ok')"
```
Expected: `stacklib ok` then `compose yaml ok`

- [ ] **Step 6: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add lib/stacklib.sh docker-compose.yaml .stack.env.example .gitignore
git commit -m "feat(stack): scaffold lib helpers, root include compose, .stack env model"
```

---

## Task 2: services/postgres + services/redis (always-on backends, volume reattach)

**Files:**
- Create: `services/postgres/compose.yaml`, `services/postgres/build.sh`, `services/postgres/pg-init/00-init.sql`
- Create: `services/redis/compose.yaml`
- Reference (unchanged content): `aitools-backends/pg-init/00-init.sql`

- [ ] **Step 1: Discover the live volume names to reattach** (prevents data loss)

```bash
docker volume ls --format '{{.Name}}' | grep -Ei 'pg-data|redis-data' || echo "(none — fresh install)"
```
Record the exact pg + redis volume names (expected from the live stack:
`aitools-backends_aitools-pg-data`, `aitools-backends_aitools-redis-data`).
Use those literal strings in Step 2/3 `volumes.*.name`. If none exist this is
a fresh install — still pin explicit names (use the same literals so a future
rebuild reattaches).

- [ ] **Step 2: Write `services/postgres/pg-init/00-init.sql`** (copy from `aitools-backends/pg-init/00-init.sql`, byte-identical)

```sql
-- Runs once on first cluster init (empty data dir), as POSTGRES superuser.
-- Passwords are injected at runtime by an entrypoint wrapper (see compose).
CREATE ROLE honcho LOGIN PASSWORD ':HONCHO_PW';
CREATE DATABASE honcho OWNER honcho;
CREATE ROLE litellm LOGIN PASSWORD ':LITELLM_PW';
CREATE DATABASE litellm OWNER litellm;
\connect honcho
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO honcho;
```

- [ ] **Step 3: Write `services/postgres/compose.yaml`** (self-contained; reattach existing volume by literal name from Step 1)

```yaml
# postgres (pgvector). No profile => always-on shared backend.
# Volume pinned by explicit name to REATTACH existing data (no rebuild).
# NOTE: no `name:` here — under root `include:` a per-file name: is ignored
# (top-level project name `hermes-stack` wins). Reattachment is guaranteed
# SOLELY by the explicit `volumes.aitools-pg-data.name:` below — DO NOT remove
# or change that literal or existing Honcho/LiteLLM data is lost.

services:
  aitools-pg:
    image: pgvector/pgvector:pg18
    container_name: aitools-pg
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_SUPERPASS}
      POSTGRES_DB: postgres
      PGDATA: /var/lib/postgresql/data/pgdata
      HONCHO_PW: ${HONCHO_DB_PASSWORD}
      LITELLM_PW: ${LITELLM_DB_PASSWORD}
    entrypoint:
      - bash
      - -c
      - |
        sed -e "s/:HONCHO_PW/$${HONCHO_PW}/" -e "s/:LITELLM_PW/$${LITELLM_PW}/" \
          /seed/00-init.sql > /docker-entrypoint-initdb.d/00-init.sql && \
        exec docker-entrypoint.sh postgres -c max_connections=200
    volumes:
      - aitools-pg-data:/var/lib/postgresql/data/
      - ./pg-init/00-init.sql:/seed/00-init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks: [aitools-net]

volumes:
  aitools-pg-data:
    name: aitools-backends_aitools-pg-data   # <- literal from Task2/Step1; reattach

networks:
  aitools-net:
    external: true
```

> **Volume reattachment is the explicit `volumes.aitools-pg-data.name:`
> literal — nothing else.** Under root `include:`, a `name:` key inside an
> included file is NOT honored as a project name (Compose uses the top-level
> `hermes-stack`). Standalone (`cd services/postgres && docker compose up`)
> the project name would default to the dir (`postgres`) but the explicit
> `volumes.*.name:` still pins the exact existing volume, so reattachment
> works both ways. This is a data-loss-critical invariant — never "simplify"
> it away.

- [ ] **Step 4: Write `services/redis/compose.yaml`** (self-contained; reattach existing redis volume)

```yaml
# redis. No profile => always-on shared backend. No `name:` (see postgres
# note); reattachment is the explicit volumes.aitools-redis-data.name: below.

services:
  aitools-redis:
    image: redis:8.6.3
    container_name: aitools-redis
    restart: unless-stopped
    command: ["redis-server", "--save", "60", "1"]
    volumes:
      - aitools-redis-data:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli ping | grep -q PONG"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks: [aitools-net]

volumes:
  aitools-redis-data:
    name: aitools-backends_aitools-redis-data   # <- literal from Task2/Step1

networks:
  aitools-net:
    external: true
```

- [ ] **Step 5: Write `services/postgres/build.sh`** (owns DB passwords; idempotent reuse)

```bash
#!/usr/bin/env bash
# postgres/build.sh — generate DB role passwords ONCE into .stack/db.generated.env.
# Reused on re-run so they keep matching the (reattached) pg data volume.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
DBENV="$STACK_DIR/db.generated.env"
if [ -f "$DBENV" ] && [ -n "$(env_get "$DBENV" POSTGRES_SUPERPASS)" ]; then
  log "postgres: reusing existing $DBENV (keeps matching pg volume)"
else
  log "postgres: generating DB role passwords -> $DBENV"
  env_upsert "$DBENV" POSTGRES_SUPERPASS  "$(openssl rand -hex 16)"
  env_upsert "$DBENV" HONCHO_DB_PASSWORD  "$(openssl rand -hex 16)"
  env_upsert "$DBENV" LITELLM_DB_PASSWORD "$(openssl rand -hex 16)"
fi
docker network create aitools-net 2>/dev/null && log "created network aitools-net" \
  || log "network aitools-net exists"
```

- [ ] **Step 6: Verify** (syntax + standalone config validity)

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
bash -n services/postgres/build.sh && echo "build.sh ok"
diff <(sed -n '1,9p' aitools-backends/pg-init/00-init.sql) services/postgres/pg-init/00-init.sql \
  && echo "pg-init byte-identical"
for s in postgres redis; do
  ( cd services/$s && POSTGRES_SUPERPASS=x HONCHO_DB_PASSWORD=x LITELLM_DB_PASSWORD=x \
    docker compose config -q && echo "services/$s compose valid" )
done
```
Expected: `build.sh ok`, `pg-init byte-identical`, two `compose valid` lines.

- [ ] **Step 7: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add services/postgres services/redis
git commit -m "feat(services): postgres+redis self-contained compose, volume reattach, pw build.sh"
```

---

## Task 3: services/litellm (profile, templated config, mint start.sh)

**Files:**
- Create: `services/litellm/compose.yaml`, `services/litellm/build.sh`, `services/litellm/start.sh`, `services/litellm/.gitignore`, `services/litellm/.image-digest`, `services/litellm/chatgpt/.gitkeep`
- Create: `services/litellm/config.yaml.template` (from `aitools-services/litellm/config.yaml`, byte-identical)
- Create: `services/litellm/README.md` (move from `aitools-services/litellm/chatgpt/README.md` content; keep ChatGPT auth notes)

- [ ] **Step 1: Write `services/litellm/config.yaml.template`** — copy `aitools-services/litellm/config.yaml` verbatim (it already uses `os.environ/...` indirection = no secrets; it is a template as-is).

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
mkdir -p services/litellm/chatgpt
cp aitools-services/litellm/config.yaml services/litellm/config.yaml.template
cp aitools-services/.litellm-image-digest services/litellm/.image-digest
cp aitools-services/litellm/chatgpt/README.md services/litellm/README.md
touch services/litellm/chatgpt/.gitkeep
```

- [ ] **Step 2: Write `services/litellm/.gitignore`**

```
config.runtime.yaml
chatgpt/auth.json
```

- [ ] **Step 3: Write `services/litellm/compose.yaml`** (profile `litellm`; bind-mounts the *rendered* runtime config)

```yaml
# litellm. profile [litellm]. No `name:` (see postgres note). Image PINNED by
# digest (gotcha #6) — value mirrored in services/litellm/.image-digest;
# bump deliberately via commit (update both).

services:
  aitools-litellm:
    image: ghcr.io/berriai/litellm-database@sha256:7bb80500033392233c79f74d4f99d43512da47626cdc9bf46e53df16803d88cd
    container_name: aitools-litellm
    profiles: [litellm]
    restart: unless-stopped
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    environment:
      LITELLM_MASTER_KEY: ${LITELLM_MASTER_KEY}
      DATABASE_URL: postgresql://litellm:${LITELLM_DB_PASSWORD}@aitools-pg:5432/litellm
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      VOYAGE_API_KEY: ${VOYAGE_API_KEY}
      REDIS_URL: redis://aitools-redis:6379
      CHATGPT_TOKEN_DIR: /root/.codex/chatgpt
      CHATGPT_AUTH_FILE: auth.json
      CHATGPT_DEFAULT_INSTRUCTIONS: " "
    volumes:
      - ./config.runtime.yaml:/app/config.yaml:ro
      - ./chatgpt:/root/.codex/chatgpt
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:4000/health/liveliness',timeout=3).status==200 else 1)\""]
      interval: 10s
      timeout: 6s
      retries: 18
    networks: [aitools-net]

networks:
  aitools-net:
    external: true
```

> No `name:` in this file (it would be ignored under `include:` anyway).
> litellm holds no persistent data, so volume reattachment is N/A here; its
> state lives in the `litellm` DB on the reattached `aitools-pg` volume.

- [ ] **Step 4: Write `services/litellm/build.sh`** (render config from template + drift check)

```bash
#!/usr/bin/env bash
# litellm/build.sh — render runtime config from template (no secrets baked).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/litellm"
render_template "$D/config.yaml.template" "$D/config.runtime.yaml" litellm
```

- [ ] **Step 5: Write `services/litellm/start.sh`** (post-health: mint/reconcile virtual keys → `.stack/litellm.generated.env`)

```bash
#!/usr/bin/env bash
# litellm/start.sh — run AFTER aitools-litellm is healthy. Idempotently mints a
# virtual key per LITELLM_VIRTKEY_<ALIAS>_MODELS declaration and writes
# <ALIAS>_VIRTUAL_KEY into .stack/litellm.generated.env.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
require_stack_env
ENVF="$STACK_DIR/.env"
GEN="$STACK_DIR/litellm.generated.env"
MK="$(env_get "$ENVF" LITELLM_MASTER_KEY)"
[ -n "$MK" ] || die "LITELLM_MASTER_KEY empty in .stack/.env"

api() { docker run --rm --network aitools-net curlimages/curl -s "$@"; }
csv_to_json() { python3 -c "import sys,json;print(json.dumps([s for s in sys.argv[1].split(',') if s]))" "$1"; }

# Wait for litellm health (defensive; just start also gates on this).
for i in $(seq 1 36); do
  h=$(docker inspect -f '{{.State.Health.Status}}' aitools-litellm 2>/dev/null || echo none)
  [ "$h" = healthy ] && break
  sleep 5; [ "$i" = 36 ] && die "aitools-litellm not healthy ($h)"
done

# Each declaration: LITELLM_VIRTKEY_<ALIAS>_MODELS=csv
grep -E '^LITELLM_VIRTKEY_[A-Z0-9]+_MODELS=' "$ENVF" | while IFS= read -r line; do
  alias_uc="$(echo "$line" | sed -E 's/^LITELLM_VIRTKEY_([A-Z0-9]+)_MODELS=.*/\1/')"
  csv="$(echo "$line" | cut -d= -f2-)"
  models_json="$(csv_to_json "$csv")"
  out_var="${alias_uc}_VIRTUAL_KEY"
  existing="$(env_get "$GEN" "$out_var")"
  alias_lc="$(echo "$alias_uc" | tr 'A-Z' 'a-z')"
  if [ -n "$existing" ]; then
    api -X POST http://aitools-litellm:4000/key/update \
      -H "Authorization: Bearer $MK" -H "Content-Type: application/json" \
      -d "{\"key\":\"$existing\",\"models\":$models_json}" >/dev/null \
      && log "litellm: reconciled allowlist for $alias_lc key"
  else
    key="$(api -X POST http://aitools-litellm:4000/key/generate \
      -H "Authorization: Bearer $MK" -H "Content-Type: application/json" \
      -d "{\"key_alias\":\"$alias_lc\",\"models\":$models_json}" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')"
    [ -n "$key" ] || die "litellm: failed to mint key for $alias_lc"
    env_upsert "$GEN" "$out_var" "$key"
    log "litellm: minted $out_var (alias=$alias_lc)"
  fi
done
```

- [ ] **Step 6: Verify**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
diff aitools-services/litellm/config.yaml services/litellm/config.yaml.template \
  && echo "litellm config template byte-identical"
bash -n services/litellm/build.sh && bash -n services/litellm/start.sh && echo "scripts ok"
( cd services/litellm && cp config.yaml.template config.runtime.yaml \
  && LITELLM_MASTER_KEY=x LITELLM_DB_PASSWORD=x OPENROUTER_API_KEY=x VOYAGE_API_KEY=x \
     COMPOSE_PROFILES=litellm docker compose config -q \
  && echo "services/litellm compose valid" && rm -f config.runtime.yaml )
git check-ignore -q services/litellm/config.runtime.yaml services/litellm/chatgpt/auth.json \
  && echo "runtime+auth correctly ignored"
# image digest pinned consistently between compose and the mirrored record:
grep -q "$(cut -d@ -f2 services/litellm/.image-digest)" services/litellm/compose.yaml \
  && echo "litellm image digest pinned + matches .image-digest"
```
Expected: byte-identical, `scripts ok`, `compose valid`, `runtime+auth correctly ignored`, `litellm image digest pinned + matches .image-digest`.

- [ ] **Step 7: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add services/litellm
git commit -m "feat(services): litellm profile compose, templated runtime config, key-mint start.sh"
```

---

## Task 4: services/honcho (profile, build-from-source, templated config)

**Files:**
- Create: `services/honcho/compose.yaml`, `services/honcho/build.sh`, `services/honcho/.gitignore`
- Create: `services/honcho/config.toml.template` (from `aitools-services/honcho/config.toml`, byte-identical — already placeholdered, no secrets)

- [ ] **Step 1: Create template + .gitignore**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
mkdir -p services/honcho
cp aitools-services/honcho/config.toml services/honcho/config.toml.template
printf 'config.runtime.toml\n_source/\n' > services/honcho/.gitignore
```

- [ ] **Step 2: Write `services/honcho/compose.yaml`** (profile `honcho`; depends_on backends + litellm; bind-mounts rendered runtime config; builds from pinned `_source/`)

```yaml
# honcho api+deriver. profile [honcho]. No `name:` (see postgres note).
# Honcho's persistent state is the `honcho` DB on the reattached aitools-pg
# volume — there is no honcho-local volume to pin.

services:
  aitools-honcho-api:
    build: { context: ./_source, dockerfile: Dockerfile }
    container_name: aitools-honcho-api
    profiles: [honcho]
    restart: unless-stopped
    entrypoint: ["sh", "docker/entrypoint.sh"]
    environment:
      DB_CONNECTION_URI: postgresql+psycopg://honcho:${HONCHO_DB_PASSWORD}@aitools-pg:5432/honcho
      CACHE_URL: redis://aitools-redis:6379/0?suppress=true
      CACHE_ENABLED: "true"
      HONCHO_VIRTUAL_KEY: ${HONCHO_VIRTUAL_KEY}
    volumes:
      - ./config.runtime.toml:/app/config.toml:ro
    depends_on:
      aitools-pg: { condition: service_healthy }
      aitools-redis: { condition: service_healthy }
      aitools-litellm: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health',timeout=3).status==200 else 1)\""]
      interval: 10s
      timeout: 6s
      retries: 30
    networks: [aitools-net]

  aitools-honcho-deriver:
    build: { context: ./_source, dockerfile: Dockerfile }
    container_name: aitools-honcho-deriver
    profiles: [honcho]
    restart: unless-stopped
    entrypoint: ["/app/.venv/bin/python", "-m", "src.deriver"]
    environment:
      DB_CONNECTION_URI: postgresql+psycopg://honcho:${HONCHO_DB_PASSWORD}@aitools-pg:5432/honcho
      CACHE_URL: redis://aitools-redis:6379/0?suppress=true
      CACHE_ENABLED: "true"
      HONCHO_VIRTUAL_KEY: ${HONCHO_VIRTUAL_KEY}
    volumes:
      - ./config.runtime.toml:/app/config.toml:ro
    depends_on:
      aitools-pg: { condition: service_healthy }
      aitools-redis: { condition: service_healthy }
      aitools-honcho-api: { condition: service_healthy }
    networks: [aitools-net]

networks:
  aitools-net:
    external: true
```

> `depends_on aitools-litellm` makes `COMPOSE_PROFILES=honcho` auto-pull
> litellm (Compose ≥ v2.20.3) even though litellm carries its own profile.

- [ ] **Step 3: Write `services/honcho/build.sh`** (clone+pin source; render config; fresh-DB 1024 dim flag)

```bash
#!/usr/bin/env bash
# honcho/build.sh — fetch pinned source + render runtime config.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/honcho"
HONCHO_PIN="8fcbb54a49292341dba79d606ee332c50778429b"  # plastic-labs/honcho pinned

if [ -d "$D/_source" ] && [ -f "$D/_source/Dockerfile" ]; then
  log "honcho: _source present (pinned build context) — reusing"
else
  log "honcho: cloning plastic-labs/honcho @ $HONCHO_PIN"
  git clone https://github.com/plastic-labs/honcho "$D/_source"
  git -C "$D/_source" checkout "$HONCHO_PIN"
  rm -rf "$D/_source/.git"
fi
render_template "$D/config.toml.template" "$D/config.runtime.toml" honcho
```

- [ ] **Step 4: Verify**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
diff aitools-services/honcho/config.toml services/honcho/config.toml.template \
  && echo "honcho config template byte-identical"
bash -n services/honcho/build.sh && echo "build.sh ok"
( cd services/honcho && cp config.toml.template config.runtime.toml \
  && mkdir -p _source && : > _source/Dockerfile \
  && HONCHO_DB_PASSWORD=x HONCHO_VIRTUAL_KEY=x COMPOSE_PROFILES=honcho \
     docker compose config -q && echo "services/honcho compose valid" \
  && rm -rf config.runtime.toml _source )
grep -q 'set-via-DB_CONNECTION_URI-env' services/honcho/config.toml.template \
  && grep -q 'set-via-HONCHO_VIRTUAL_KEY-env' services/honcho/config.toml.template \
  && echo "template carries placeholders, no secrets"
```
Expected: byte-identical, `build.sh ok`, `compose valid`, `template carries placeholders, no secrets`.

- [ ] **Step 5: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add services/honcho
git commit -m "feat(services): honcho profile compose, pinned _source build, templated config"
```

---

## Task 5: justfile (setup / build / start / stop / status / logs / reconfigure)

**Files:**
- Modify (rewrite): `justfile`

- [ ] **Step 1: Rewrite `justfile`**

```make
# hermes-stack — composable Docker services + Orb machines.
# Secrets live ONLY in .stack/ (gitignored). .stack/.env is intentionally not
# auto-loaded — recipes set COMPOSE_ENV_FILES explicitly (plan decision 5).

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

root := justfile_directory()
lib  := root / "lib/stacklib.sh"

# Default: list targets.
default:
    @just --list

# Interactive: create/refresh .stack/.env.
setup:
    @bash "{{root}}/lib/setup.sh"

# Render configs, fetch pinned sources, generate DB passwords, provision machines.
build:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     bash "{{root}}/services/postgres/build.sh"; \
     source "{{root}}/.stack/.env"; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
       [ -x "{{root}}/services/$p/build.sh" ] && bash "{{root}}/services/$p/build.sh" || true; \
     done; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$mch" ] && [ -x "{{root}}/machines/$mch/build.sh" ] && \
         bash "{{root}}/machines/$mch/build.sh" "$mch" || true; \
     done; \
     echo "build complete"

# Staged bring-up. ORDER IS LOAD-BEARING:
#   pg+redis -> litellm -> mint virtual keys -> honcho-postup (brings honcho up
#   correctly for fresh OR reattached DB) -> settle up -d -> machines.
# Do NOT add a blanket `up -d` before honcho-postup: on a fresh DB honcho-api
# crash-loops on the 1536/1024 validator until postup applies the dim fix.
start:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     source "{{root}}/.stack/.env"; \
     echo "COMPOSE_ENV_FILES=$COMPOSE_ENV_FILES  COMPOSE_PROFILES=${COMPOSE_PROFILES:-}"; \
     DC="docker compose -f {{root}}/docker-compose.yaml"; \
     $DC up -d aitools-pg aitools-redis; \
     if echo "${COMPOSE_PROFILES:-}" | grep -qw litellm || \
        echo "${COMPOSE_PROFILES:-}" | grep -qw honcho; then \
       $DC up -d aitools-litellm; \
       bash "{{root}}/services/litellm/start.sh"; \
       export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     fi; \
     if echo "${COMPOSE_PROFILES:-}" | grep -qw honcho; then \
       bash "{{root}}/lib/honcho-postup.sh"; \
     fi; \
     $DC up -d; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$mch" ] && [ -x "{{root}}/machines/$mch/start.sh" ] && \
         bash "{{root}}/machines/$mch/start.sh" "$mch"; \
     done; \
     echo "start complete"

# Stop containers (keep volumes). Machines left running.
# Source the user's profiles so profiled services (litellm/honcho) are also
# removed (`--profile "*"` is not valid for `down`).
stop:
    @set -a; source "{{lib}}"; set +a; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     source "{{root}}/.stack/.env" 2>/dev/null || true; \
     export COMPOSE_PROFILES="${COMPOSE_PROFILES:-litellm,honcho}"; \
     docker compose -f "{{root}}/docker-compose.yaml" down --remove-orphans

# Container health + machine list.
status:
    @docker ps --filter "name=aitools-" --format "table {{{{.Names}}}}\t{{{{.Status}}}}"; \
     echo "---"; orb list 2>/dev/null || true

# Tail an Orb machine console (OrbStack Logs tab = console).
logs machine="hermes":
    orb logs {{machine}}

# Re-render a service runtime config from its template (backs up the old one).
reconfigure svc:
    @set -a; source "{{lib}}"; set +a; \
     d="{{root}}/services/{{svc}}"; \
     for ext in toml yaml json; do \
       t="$d/config.$ext.template"; o="$d/config.runtime.$ext"; \
       if [ -f "$t" ]; then \
         [ -f "$o" ] && cp "$o" "$o.bak.$(date +%s)" && echo "backed up $o"; \
         rm -f "$o"; render_template "$t" "$o" "{{svc}}"; \
       fi; \
     done
```

- [ ] **Step 2: Write `lib/setup.sh`** (interactive `.stack/.env` generator)

```bash
#!/usr/bin/env bash
# setup.sh — interactively create/refresh .stack/.env. Non-destructive: keeps
# existing values as defaults.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stacklib.sh"
ENVF="$STACK_DIR/.env"
mkdir -p "$STACK_DIR"
EX="$STACK_ROOT/.stack.env.example"

ask() { # ask VAR PROMPT [secret]
  local var="$1" prompt="$2" secret="${3:-}" cur def
  cur="$(env_get "$ENVF" "$var")"
  def="${cur:-$(env_get "$EX" "$var")}"
  if [ "$secret" = secret ]; then
    read -rsp "$prompt [${cur:+<keep current>}]: " val; echo
  else
    read -rp "$prompt [${def}]: " val
  fi
  val="${val:-${cur:-$def}}"
  env_upsert "$ENVF" "$var" "$val"
}

log "hermes-stack setup -> $ENVF"
ask OPENROUTER_API_KEY "OpenRouter API key" secret
ask VOYAGE_API_KEY     "Voyage API key" secret
mk="$(env_get "$ENVF" LITELLM_MASTER_KEY)"
[ -n "$mk" ] || { mk="sk-$(openssl rand -hex 24)"; log "generated LITELLM_MASTER_KEY"; }
env_upsert "$ENVF" LITELLM_MASTER_KEY "$mk"

read -rp "Enable Docker profiles (comma list) [litellm,honcho]: " prof
env_upsert "$ENVF" COMPOSE_PROFILES "${prof:-litellm,honcho}"

read -rp "Orb machines to manage (comma list; '-' for none) [hermes]: " mch
mch="${mch:-hermes}"; [ "$mch" = "-" ] && mch=""   # empty input -> default hermes
env_upsert "$ENVF" STACK_MACHINES "$mch"
if echo "$mch" | grep -qw hermes; then
  ask TELEGRAM_BOT_TOKEN     "Telegram bot token (blank ok)"
  ask TELEGRAM_ALLOWED_USERS "Telegram allowed user IDs (csv, blank ok)"
  ask TELEGRAM_HOME_CHANNEL  "Telegram home channel (blank ok)"
fi

# Seed virtual-key allowlist declarations from the example if absent.
for k in LITELLM_VIRTKEY_HONCHO_MODELS LITELLM_VIRTKEY_HERMES_MODELS; do
  [ -n "$(env_get "$ENVF" "$k")" ] || env_upsert "$ENVF" "$k" "$(env_get "$EX" "$k")"
done
chmod 600 "$ENVF"
log "setup complete. Review $ENVF, then: just build && just start"
```

- [ ] **Step 3: Write `lib/honcho-postup.sh`** (fresh-DB only: 1024 dim fix via venv, NOT uv run)

```bash
#!/usr/bin/env bash
# honcho-postup.sh — bring Honcho up correctly for BOTH fresh and reattached
# DBs. Mirrors the PROVEN build-stack.sh step-8 sequence (do not "simplify"):
#   1. up aitools-honcho-api  (its entrypoint runs `alembic upgrade` -> schema)
#   2. TOLERANT wait for the `documents` table to exist (alembic finished) —
#      NOT a health wait: on a fresh DB honcho-api is intentionally unhealthy
#      (1536 cols vs configured 1024) until the dim fix below.
#   3. read embedding col dims:
#        vector(1024) => REATTACHED existing data; nothing to alter
#        else (1536)  => FRESH db: alter to 1024 via the IN-IMAGE venv python
#          (NOT `uv run` — it rebuilds in-image and fails), then force-recreate
#   4. wait honcho-api healthy
# Called by `just start` AFTER litellm keys are minted (honcho needs
# HONCHO_VIRTUAL_KEY via COMPOSE_ENV_FILES) and BEFORE the final settle up -d.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stacklib.sh"
source "$STACK_DIR/.env"
echo "${COMPOSE_PROFILES:-}" | grep -qw honcho || { log "honcho not in profiles — skip postup"; exit 0; }
HPW="$(env_get "$STACK_DIR/db.generated.env" HONCHO_DB_PASSWORD)"
[ -n "$HPW" ] || die "HONCHO_DB_PASSWORD missing in .stack/db.generated.env"
export COMPOSE_ENV_FILES="$(compose_env_files)"
DC="docker compose -f $STACK_ROOT/docker-compose.yaml"
pgq() { docker run --rm --network aitools-net -e PGPASSWORD="$HPW" postgres:18 \
          psql -h aitools-pg -U honcho -d honcho -tAc "$1" 2>/dev/null || true; }

log "honcho: starting aitools-honcho-api (entrypoint runs alembic upgrade)"
$DC up -d aitools-honcho-api

log "honcho: waiting (tolerant, ~4min) for alembic to create the 'documents' table"
for i in $(seq 1 48); do
  [ "$(pgq "SELECT to_regclass('documents');" | tr -d '[:space:]')" = "documents" ] && break
  sleep 5
  [ "$i" = 48 ] && die "honcho: 'documents' table never appeared — alembic failed (check: docker logs aitools-honcho-api)"
done

dims="$(pgq "SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attname='embedding' AND attrelid='documents'::regclass;" | tr -d '[:space:]')"
if echo "$dims" | grep -q '1024'; then
  log "honcho: embedding cols already vector(1024) (reattached data) — no dim fix"
else
  log "honcho: FRESH db (cols='${dims:-unknown}') — applying 1024 dim fix via in-image venv"
  $DC run --rm --entrypoint /app/.venv/bin/python \
    aitools-honcho-api scripts/configure_embeddings.py --yes
  $DC up -d --force-recreate aitools-honcho-api aitools-honcho-deriver
fi

for i in $(seq 1 36); do
  h=$(docker inspect -f '{{.State.Health.Status}}' aitools-honcho-api 2>/dev/null || echo none)
  [ "$h" = healthy ] && { log "honcho-api healthy"; exit 0; }
  sleep 5
done
die "honcho-api unhealthy after postup (check: docker logs aitools-honcho-api)"
```

- [ ] **Step 4: Verify**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
bash -n lib/setup.sh && bash -n lib/honcho-postup.sh && echo "lib scripts ok"
just --list >/dev/null && echo "justfile parses"
chmod +x services/*/build.sh services/litellm/start.sh lib/*.sh
git update-index --chmod=+x services/postgres/build.sh services/litellm/build.sh \
  services/litellm/start.sh services/honcho/build.sh lib/setup.sh lib/honcho-postup.sh 2>/dev/null || true
```
Expected: `lib scripts ok`, `justfile parses`.

- [ ] **Step 5: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add justfile lib/setup.sh lib/honcho-postup.sh services lib
git commit -m "feat(just): unified setup/build/start orchestration with staged key-mint"
```

---

## Task 6: machines/hermes (Orb VM provisioning; refuses frozen original)

**Files:**
- Create: `machines/hermes/build.sh` (from `build-hermes.sh`, adapted to `.stack/` + per-machine layout)
- Create: `machines/hermes/start.sh` (idempotent enable/restart of units)
- Create: `machines/hermes/systemd/{hermes-dashboard,hermes-gateway,hermes-logtail}.service` (copy from `hermes-vm/systemd/`, byte-identical)
- Create: `machines/hermes/bin/hermes-logtail.sh` (copy from `hermes-vm/bin/`, byte-identical)
- Create: `machines/hermes/config/{honcho.json.tmpl,config.yaml.model.tmpl}` (copy from `hermes-vm/config/`, byte-identical)

- [ ] **Step 1: Copy unchanged VM artifacts**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
mkdir -p machines/hermes/systemd machines/hermes/bin machines/hermes/config
cp hermes-vm/systemd/*.service machines/hermes/systemd/
cp hermes-vm/bin/hermes-logtail.sh machines/hermes/bin/
cp hermes-vm/config/honcho.json.tmpl machines/hermes/config/
cp hermes-vm/config/config.yaml.model.tmpl machines/hermes/config/
# CORRECT the model template DNS: legacy used the project-qualified
# `aitools-litellm.aitools-services.orb.local` which DIES under the new
# `hermes-stack` project (decision 8). Use the bare, project-independent form:
sed -i.bak 's#http://aitools-litellm\.aitools-services\.orb\.local:4000/v1#http://aitools-litellm.orb.local:4000/v1#' \
  machines/hermes/config/config.yaml.model.tmpl && rm -f machines/hermes/config/config.yaml.model.tmpl.bak
```

- [ ] **Step 2: Write `machines/hermes/build.sh`** (adapted from `build-hermes.sh`; reads `.stack/.env` + `.stack/litellm.generated.env`; refuses `hermes-agent` absolutely)

```bash
#!/usr/bin/env bash
# machines/hermes/build.sh [machine-name=hermes]
# Provisions an OrbStack Ubuntu machine running Hermes wired to the Dockerized
# Honcho+LiteLLM stack. Installs ONLY messaging/agent services (dashboard,
# gateway, logtail) — NO native honcho/postgres (Honcho is Dockerized).
# HARD SAFETY: refuses the frozen original `hermes-agent`.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"

MACHINE="${1:-hermes}"
[ "$MACHINE" = "hermes-agent" ] && die "REFUSING: 'hermes-agent' is the frozen original — never modified."

require_stack_env
ENVF="$STACK_DIR/.env"
GEN="$STACK_DIR/litellm.generated.env"
source "$ENVF"
HERMES_VIRTUAL_KEY="$(env_get "$GEN" HERMES_VIRTUAL_KEY)"
[ -n "$HERMES_VIRTUAL_KEY" ] || die "HERMES_VIRTUAL_KEY missing — run \`just start\` (litellm mint) first."
D="$(dirname "${BASH_SOURCE[0]}")"; REMOTE_USER="joe"
m() { orb -m "$MACHINE" bash -lc "$1"; }

log "1. orb create ubuntu $MACHINE (reuse if exists)"
orb list 2>/dev/null | awk '{print $1}' | grep -qx "$MACHINE" \
  && log "machine $MACHINE exists — reusing" || orb create ubuntu "$MACHINE"

log "2. apt xz-utils (REQUIRED — Hermes installer extracts Node .tar.xz)"
m 'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils curl ca-certificates'

log "3. install Hermes + seed ~/.hermes/.env"
m 'command -v hermes >/dev/null 2>&1 || curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'
ENV_PAYLOAD="$(cat <<EOF
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS:-}
TELEGRAM_HOME_CHANNEL=${TELEGRAM_HOME_CHANNEL:-}
EOF
)"
printf '%s' "$ENV_PAYLOAD" | orb -m "$MACHINE" bash -lc \
  'mkdir -p ~/.hermes && umask 077 && cat > ~/.hermes/.env && chmod 600 ~/.hermes/.env && echo "~/.hermes/.env seeded"'

log "4. write ~/.hermes/honcho.json"
orb -m "$MACHINE" bash -lc 'mkdir -p ~/.hermes && cat > ~/.hermes/honcho.json' < "$D/config/honcho.json.tmpl"

log "5. patch ~/.hermes/config.yaml model: block (key via stdin, never argv)"
MODEL_BLOCK="$(sed "s|\${HERMES_VIRTUAL_KEY}|$HERMES_VIRTUAL_KEY|" "$D/config/config.yaml.model.tmpl" | grep -v '^#')"
printf '%s\n' "$MODEL_BLOCK" | orb -m "$MACHINE" bash -lc '
  set -e; umask 077; cfg=~/.hermes/config.yaml
  [ -f "$cfg" ] || hermes config init >/dev/null 2>&1 || touch "$cfg"
  cp "$cfg" "$cfg.bak.prebuild" 2>/dev/null || true
  nb="$(cat)"
  python3 - "$cfg" <<PY
import sys,os
p=sys.argv[1]; nb="""$nb"""
lines=open(p).read().splitlines() if os.path.exists(p) else []
out=[]; i=0; n=len(lines); rep=False
while i<n:
    ln=lines[i]
    if ln.rstrip()=="model:" or ln.startswith("model:"):
        i+=1
        while i<n and (lines[i].startswith(" ") or lines[i].strip()==""): i+=1
        out.append(nb.rstrip()); rep=True; continue
    out.append(ln); i+=1
if not rep: out.insert(0, nb.rstrip())
open(p,"w").write("\n".join(out)+"\n"); print("model: block patched")
PY'

log "6. install units + logtail (NO native honcho/pg)"
orb -m "$MACHINE" bash -lc 'sudo tee /usr/local/bin/hermes-logtail.sh >/dev/null && sudo chmod +x /usr/local/bin/hermes-logtail.sh' < "$D/bin/hermes-logtail.sh"
for unit in hermes-dashboard hermes-gateway hermes-logtail; do
  orb -m "$MACHINE" bash -lc "sudo tee /etc/systemd/system/$unit.service >/dev/null" < "$D/systemd/$unit.service"
done
log "machines/hermes/build.sh DONE for '$MACHINE' (start.sh enables units)"
```

- [ ] **Step 3: Write `machines/hermes/start.sh`** (idempotent enable+(re)start; runs LAST in `just start` after keys minted)

```bash
#!/usr/bin/env bash
# machines/hermes/start.sh [machine=hermes] — enable + (re)start hermes units.
# Re-applies the virtual key in case it was re-minted (idempotent).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
MACHINE="${1:-hermes}"
[ "$MACHINE" = "hermes-agent" ] && die "REFUSING: 'hermes-agent' is the frozen original."
GEN="$STACK_DIR/litellm.generated.env"
HK="$(env_get "$GEN" HERMES_VIRTUAL_KEY)"
D="$(dirname "${BASH_SOURCE[0]}")"
if [ -n "$HK" ]; then
  MB="$(sed "s|\${HERMES_VIRTUAL_KEY}|$HK|" "$D/config/config.yaml.model.tmpl" | grep -v '^#')"
  printf '%s\n' "$MB" | orb -m "$MACHINE" bash -lc '
    cfg=~/.hermes/config.yaml; nb="$(cat)"
    python3 - "$cfg" <<PY
import sys,os
p=sys.argv[1]; nb="""$nb"""
lines=open(p).read().splitlines() if os.path.exists(p) else []
out=[]; i=0; n=len(lines); rep=False
while i<n:
    ln=lines[i]
    if ln.rstrip()=="model:" or ln.startswith("model:"):
        i+=1
        while i<n and (lines[i].startswith(" ") or lines[i].strip()==""): i+=1
        out.append(nb.rstrip()); rep=True; continue
    out.append(ln); i+=1
if not rep: out.insert(0, nb.rstrip())
open(p,"w").write("\n".join(out)+"\n")
PY'
fi
orb -m "$MACHINE" bash -lc 'sudo systemctl daemon-reload && sudo systemctl enable --now hermes-dashboard hermes-gateway hermes-logtail && sudo systemctl restart hermes-gateway hermes-logtail'
echo -n "services: "; orb -m "$MACHINE" bash -lc 'systemctl is-active hermes-dashboard hermes-gateway hermes-logtail | tr "\n" " "; echo'
echo -n "honcho reachable: "; orb -m "$MACHINE" bash -lc 'curl -sS -m6 http://aitools-honcho-api.orb.local:8000/health || true'; echo
```

- [ ] **Step 4: Verify** (byte-identical copies, scripts lint, refuses frozen original)

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
for f in systemd/hermes-dashboard.service systemd/hermes-gateway.service \
         systemd/hermes-logtail.service bin/hermes-logtail.sh \
         config/honcho.json.tmpl; do
  diff "hermes-vm/$f" "machines/hermes/$f" >/dev/null && echo "OK $f" || echo "DIFF $f"
done
# model.tmpl is INTENTIONALLY modified (bare DNS) — assert, don't diff:
grep -q 'http://aitools-litellm.orb.local:4000/v1' machines/hermes/config/config.yaml.model.tmpl \
  && ! grep -q 'aitools-services.orb.local' machines/hermes/config/config.yaml.model.tmpl \
  && echo "OK config/config.yaml.model.tmpl (bare project-independent DNS)"
bash -n machines/hermes/build.sh && bash -n machines/hermes/start.sh && echo "scripts ok"
chmod +x machines/hermes/*.sh
if ! ./machines/hermes/build.sh hermes-agent 2>/dev/null; then echo "refuses hermes-agent"; else echo "FAIL: did not refuse"; fi
if ! ./machines/hermes/start.sh hermes-agent 2>/dev/null; then echo "start.sh refuses hermes-agent"; else echo "FAIL: start.sh did not refuse"; fi
```
Expected: six `OK` lines, `scripts ok`, `refuses hermes-agent`.

- [ ] **Step 5: Commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add machines/hermes
git commit -m "feat(machines): hermes Orb VM build/start scripts, .stack-driven, refuses frozen original"
```

---

## Task 7: Live migration, e2e verification, docs, remove legacy

**Files:**
- Create: `.stack/.env` (via `just setup`, gitignored — NOT committed)
- Modify (rewrite): `README.md`
- Modify: `docs/plans/00-05` (add superseded banner line at top)
- Delete: `aitools-backends/`, `aitools-services/`, `build-stack.sh`, `build-hermes.sh`, `secrets.env.example`, `hermes-vm/`, `hermes-config-snapshot/`

- [ ] **Step 1: Stop the old stack (keep volumes)**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
docker compose -f aitools-services/compose.yaml --env-file aitools-services/.env down 2>/dev/null || true
docker compose -f aitools-backends/compose.yaml --env-file aitools-backends/.env down 2>/dev/null || true
docker volume ls --format '{{.Name}}' | grep -E 'pg-data|redis-data'   # confirm volumes still exist
```
Expected: the two `aitools-backends_*-data` volumes still listed (data preserved).

- [ ] **Step 2: Migrate generated secrets into `.stack/`** (reuse existing DB passwords so the reattached volume still authenticates)

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
mkdir -p .stack
# DB passwords from the OLD generated env -> .stack/db.generated.env (must match volume)
{ echo "POSTGRES_SUPERPASS=$(grep ^POSTGRES_SUPERPASS= aitools-backends/.env|cut -d= -f2-)";
  echo "HONCHO_DB_PASSWORD=$(grep ^HONCHO_DB_PASSWORD= aitools-backends/.env|cut -d= -f2-)";
  echo "LITELLM_DB_PASSWORD=$(grep ^LITELLM_DB_PASSWORD= aitools-backends/.env|cut -d= -f2-)";
} > .stack/db.generated.env
# Existing virtual keys (still valid — same litellm DB volume) -> litellm.generated.env
{ echo "HONCHO_VIRTUAL_KEY=$(grep ^HONCHO_VIRTUAL_KEY= aitools-services/keys.generated.env|cut -d= -f2-)";
  echo "HERMES_VIRTUAL_KEY=$(grep ^HERMES_VIRTUAL_KEY= aitools-services/keys.generated.env|cut -d= -f2-)";
} > .stack/litellm.generated.env
chmod 600 .stack/*.generated.env
# MIGRATE the ChatGPT oauth token (gitignored, NOT in any .env) — without it
# LiteLLM blocks on an interactive device-code prompt at boot and never goes
# healthy. This is a required runtime artifact, like the DB passwords.
if [ -f aitools-services/litellm/chatgpt/auth.json ]; then
  cp -p aitools-services/litellm/chatgpt/auth.json services/litellm/chatgpt/auth.json
  chmod 600 services/litellm/chatgpt/auth.json
  echo "migrated ChatGPT auth.json ($(wc -c < services/litellm/chatgpt/auth.json) bytes, gitignored)"
else
  echo "WARN: no existing ChatGPT auth.json — first litellm boot will print a device-pair code in \`docker logs aitools-litellm\`; complete it once."
fi
```

- [ ] **Step 3: `just setup`** — create `.stack/.env`. Provide the real OpenRouter/Voyage keys and the existing `LITELLM_MASTER_KEY` (from `aitools-services/.env`) when prompted; profiles `litellm,honcho`; machines `hermes`; Telegram from `aitools-services`/secrets if present. (Interactive — run it, answer prompts.)

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
echo "existing master key: $(grep ^LITELLM_MASTER_KEY= aitools-services/.env|cut -d= -f2-)"
just setup
```
Expected: `.stack/.env` written (mode 600); `setup complete`.

- [ ] **Step 4: `just build`** (renders runtime configs, fetches pinned honcho `_source`, reuses DB passwords, provisions/reconfigures the `hermes` machine)

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
# C3 GUARD — db passwords MUST be migrated (Step 2) before build, else
# postgres/build.sh generates FRESH passwords and the reattached pg volume
# (old passwords baked at init, init script will NOT re-run on non-empty data)
# rejects every login = total data lockout.
{ [ -s .stack/db.generated.env ] && grep -q '^POSTGRES_SUPERPASS=' .stack/db.generated.env \
  && grep -q '^HONCHO_DB_PASSWORD=' .stack/db.generated.env \
  && grep -q '^LITELLM_DB_PASSWORD=' .stack/db.generated.env; } \
  || { echo "FATAL: .stack/db.generated.env not migrated — run Step 2 FIRST"; exit 1; }
just build
```
Expected: guard passes silently, then `rendered services/litellm/config.runtime.yaml`, honcho `_source` present, `build complete`. (`hermes` machine reused/reconfigured — `hermes-agent` never touched.)

- [ ] **Step 5: `just start`** (staged: backends → litellm → key reconcile → honcho → hermes machine)

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
just start
```
Expected: `start complete`; `just status` shows `aitools-pg/redis/litellm/honcho-api/honcho-deriver` Up; `hermes` machine units active.

- [ ] **Step 6: End-to-end verification (paste evidence for ALL)**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
source lib/stacklib.sh
HPW="$(env_get .stack/db.generated.env HONCHO_DB_PASSWORD)"
LPW="$(env_get .stack/db.generated.env LITELLM_DB_PASSWORD)"
pg(){ docker run --rm --network aitools-net -e PGPASSWORD="$2" postgres:18 psql -h aitools-pg -U "$1" -d "$1" -tAc "$3"; }
echo "A pg ver:"; pg postgres "$(env_get .stack/db.generated.env POSTGRES_SUPERPASS)" "select version();"|head -1
echo "B honcho embed dims (expect vector(1024)):"; pg honcho "$HPW" "select string_agg(format_type(atttypid,atttypmod),',') from pg_attribute where attname='embedding' and attrelid::regclass::text in ('documents','message_embeddings');"
echo "C honcho data preserved (peer/session counts > 0 if memory survived):"; pg honcho "$HPW" "select (select count(*) from peers), (select count(*) from sessions);"
echo "D litellm spend rows N0:"; N0=$(pg litellm "$LPW" 'select count(*) from "LiteLLM_SpendLogs";'); echo "$N0"
echo "E hermes brain (streams -> chatgpt/gpt-5.5):"; orb -m hermes bash -lc 'timeout 90 ~/.local/bin/hermes -z "reply with exactly: pong" 2>&1 | tail -3'
echo "F hermes->honcho->litellm chain:"; orb -m hermes bash -lc 'timeout 60 ~/.local/bin/hermes honcho status 2>&1 | tail -3'
sleep 25
echo "G litellm spend rows after (expect > N0):"; pg litellm "$LPW" 'select count(*) from "LiteLLM_SpendLogs";'
echo "H logs to OrbStack console:"; orb logs hermes 2>/dev/null | grep -E 'hermes-(gateway|errors)' | tail -3
echo "I hermes-agent UNTOUCHED:"; orb list | grep hermes-agent
```
Expected: A=PostgreSQL 18; B=`vector(1024),vector(1024)`; C nonzero (memory preserved); E prints `pong`; F connection OK; G > N0; H shows prefixed lines; I `hermes-agent` present + `stopped` (never started/modified).

- [ ] **Step 7: Rewrite `README.md`** — full from-scratch procedure for the new layout (`clone → just setup → just build → just start`), the secrets model (`.stack/`), profiles/composability, the staged key-mint, and ALL gotchas from this plan's "Gotchas to carry forward" section. (Replace the existing README entirely; keep it accurate to the new commands — no references to `build-stack.sh`/`build-hermes.sh`/`secrets.env`.)

- [ ] **Step 8: Add superseded banner to old plans**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
for f in docs/plans/0{0,1,2,3,5}-*.md docs/plans/01b-*.md docs/plans/04a-*.md; do
  grep -q 'SUPERSEDED by 06' "$f" 2>/dev/null || \
  sed -i.bak '1i > **SUPERSEDED by docs/plans/06-unified-stack-architecture.md** — kept for history.\n' "$f" && rm -f "$f.bak"
done
```

- [ ] **Step 9: Remove legacy structure** (now fully replaced + verified)

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git rm -r --quiet aitools-backends aitools-services build-stack.sh build-hermes.sh \
  secrets.env.example hermes-vm hermes-config-snapshot
# _README-JOE.md superseded by the rewritten README.md — remove from tree:
git rm -q --cached _README-JOE.md 2>/dev/null || true; rm -f _README-JOE.md
```

- [ ] **Step 9b: Rewrite `.gitignore`** (drop stale rules pointing at deleted paths; keep the unified-stack rules). Replace the entire file with:

```
# --- runtime secrets / generated / build (NEVER committed) ---
# All runtime secrets live in .stack/ (templates live in service dirs).
.stack/
**/*.generated.env
# Build-from-source clones (pinned commit, re-cloned by build scripts).
**/_source/
# Rendered runtime configs (templates are committed as *.template).
**/*.runtime.toml
**/*.runtime.yaml
**/*.runtime.json
# ChatGPT oauth token (LiteLLM codex auth).
services/litellm/chatgpt/auth.json

# --- editor / bak ---
*.bak
*.bak.*
.bak/
```
Verify the example + templates stay trackable:
```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git check-ignore -v .stack.env.example services/litellm/config.yaml.template \
  services/honcho/config.toml.template && echo "BUG: a tracked file is ignored" \
  || echo "ok: example + templates trackable"
git check-ignore -q .stack/.env .stack/db.generated.env \
  services/litellm/config.runtime.yaml services/honcho/_source && echo "ok: secrets/runtime ignored"
```
Expected: `ok: example + templates trackable`, `ok: secrets/runtime ignored`.

- [ ] **Step 10: Final secret-scan + commit**

```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git add -A
git diff --cached --name-only
git grep --cached -nIE 'sk-or-v1-[A-Za-z0-9]{30,}|pa-[A-Za-z0-9_-]{25,}|sk-[A-Za-z0-9]{40,}' -- . \
  && { echo "SECRETS STAGED — ABORT"; exit 1; } || echo "staged content clean"
git check-ignore -q .stack/.env .stack/db.generated.env .stack/litellm.generated.env \
  && echo ".stack secrets ignored"
git commit -m "refactor(stack): unify into services/+machines/+.stack, remove legacy two-project layout"
```
Expected: `staged content clean`, `.stack secrets ignored`, commit succeeds; `.stack/` absent from `git diff --cached --name-only`.

---

## Acceptance criteria (verify ALL)

- `just setup && just build && just start` brings the stack up with secrets ONLY in `.stack/` (`git status` shows no `.stack/` tracked; `git check-ignore` passes for all `.stack/*`).
- Single root `docker-compose.yaml` (`include:`) validates merged (`docker compose -f docker-compose.yaml config -q` with profiles) and contains all 5 services; postgres/redis/litellm also validate standalone; honcho validates only via the root include (by-design cross-file `depends_on`).
- `COMPOSE_PROFILES` in `.stack/.env` is the only run-selection knob; `COMPOSE_PROFILES=honcho` auto-pulls litellm via `depends_on`.
- Honcho memory + LiteLLM virtual keys **preserved** across the restructure (Task 7/Step 6 C nonzero, existing keys still authenticate, embed cols `vector(1024)`).
- Hermes (Orb VM `hermes`) chats via LiteLLM `chatgpt/gpt-5.5` (streaming) and reaches Dockerized Honcho; logs visible in OrbStack console; LiteLLM spend logs grow on a Hermes-driven call.
- `machines/hermes/build.sh hermes-agent` exits non-zero ("REFUSING"); `hermes-agent` machine remains `stopped`/untouched.
- No secret in any tracked file or in git (working tree only — history already scrubbed); legacy `aitools-*`/`build-*.sh`/`hermes-vm/` removed; README documents the new procedure + all gotchas.

## Self-Review

**Spec coverage:** services/+machines/ split (T2,T3,T4,T6) ✓; single root include compose (T1) ✓; `.stack/.env`+`*.generated.env` model (T1,T5) ✓; `COMPOSE_ENV_FILES` not-auto-loaded guard (T1/stacklib, T5) ✓; profiles single-source + depends_on auto-pull (T3,T4) ✓; template→runtime render + drift hash, no secrets in templates (T1,T3,T4,T5) ✓; per-service .gitignore + root globs ✓; virtual-key declare(build)/mint(litellm start)/consume(honcho,hermes) staged ordering (T3,T5,T6) ✓; volume reattach / data preservation (T2,T7) ✓; hermes stays Orb VM, refuses frozen `hermes-agent` (T6) ✓; all 8 gotchas encoded (xz-utils T6, venv-not-uv-run T5/honcho-postup, chatgpt-not-for-honcho via allowlist decls T1, pg-rebuild→remint idempotent T3/T5, console-logs T6 copy, pin digests/commit T3/T4, voyage dims T4 template, .env-not-autoloaded T1/T5) ✓; legacy removal + docs (T7) ✓.

**Placeholder scan:** every script/file given in full literal content; no "TBD"/"similar to"/"add error handling" — each step has exact commands + expected output. README (T7/Step7) is the one prose deliverable — its required contents are enumerated explicitly.

**Type/name consistency:** env var names consistent across files (`HONCHO_DB_PASSWORD`, `LITELLM_DB_PASSWORD`, `POSTGRES_SUPERPASS`, `LITELLM_MASTER_KEY`, `HONCHO_VIRTUAL_KEY`, `HERMES_VIRTUAL_KEY`, `LITELLM_VIRTKEY_<ALIAS>_MODELS`); helper names (`env_upsert`, `env_get`, `render_template`, `compose_env_files`, `require_stack_env`, `die`, `log`, `warn`) defined once in `lib/stacklib.sh` and used identically; container/volume/network names unchanged from the live stack (`aitools-pg`, `aitools-redis`, `aitools-litellm`, `aitools-honcho-api`, `aitools-honcho-deriver`, `aitools-backends_aitools-{pg,redis}-data`, `aitools-net`); per-service compose files carry NO `name:` (ignored under `include:`) — volume reattachment is the explicit `volumes.*.name:` literal only.

## Independent review (resolved)

A separate architect review was run against this plan. All findings resolved IN this document before implementation:

- **C1 (Critical):** per-file `name:` is ignored under `include:`; the old "default volume naming lines up" rationale was false and a data-loss footgun. → Removed all per-file `name:`; corrected the inline rationale to "explicit `volumes.*.name:` is the sole reattachment mechanism." Also: litellm image was an unpinned `:main-latest` (violated gotcha #6). → Pinned to the `@sha256:` digest, mirrored in `.image-digest`, with a consistency check in Task 3/Step 6.
- **C2 (Critical):** the fresh-DB Honcho 1024 sequence was racy/broken (blanket `up -d` before postup → honcho-api crash-loops on the validator; postup queried `documents` before alembic created it). → `just start` no longer does a blanket `up -d` before postup; `lib/honcho-postup.sh` rewritten to mirror the proven build-stack.sh step-8 flow: up honcho-api → tolerant poll for the `documents` table → branch on dims (1024 reattach vs 1536 fresh→venv fix→force-recreate) → wait healthy.
- **C3 (Critical):** running `just build` before the DB-password migration would generate fresh passwords and lock out the reattached pg volume. → Hard guard added to Task 7/Step 4 asserting `.stack/db.generated.env` is migrated first.
- **I1 (Important):** `stop` recipe `--profile "*"` is invalid and would leave profiled containers running. → Rewrote to source `.stack/.env` profiles + `down --remove-orphans`.
- **I2 (Important):** VM-local `config.yaml.bak.prebuild` could be world-readable. → `umask 077` added before the backup.
- **M1:** `${mch-hermes}` (unset-only) skipped hermes on empty input. → `${mch:-hermes}` + explicit `-`=none.
- **M3:** fragile refuse-test in Task 6/Step 4. → `if ! ...; then` form; also tests `start.sh` refusal.
- **M5:** stale `.gitignore` rules referenced deleted paths. → Task 7/Step 9b rewrites `.gitignore`, with trackable/ignored verification.

Plan is final and ready for subagent-driven implementation.
