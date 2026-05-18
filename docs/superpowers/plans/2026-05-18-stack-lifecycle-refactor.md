# Stack Lifecycle & Provisioning Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `00-init.sql` + `lib/honcho-postup.sh` + the hardcoded `just start` ordering with a generic, single-responsibility lifecycle (build → preflight → prestart → compose-ordered provisioner → poststart), so enabling a pg-using service is additive, idempotent, and non-destructive.

**Architecture:** Per-service host hooks (`preflight.sh`, `prestart.sh`, `poststart.sh`) discovered generically by `just start` (no service names in the justfile beyond the `pg redis` backend substrate); DB role/db/extension via a one-shot Compose **provisioner** container per service, ordered by `depends_on`. Spec: `docs/superpowers/specs/2026-05-18-stack-lifecycle-refactor-design.md`.

**Tech Stack:** bash, just, Docker Compose v2 (5.1.2), Postgres 18 (`pgvector/pgvector:pg18`), `psql`, `yq`. Platform darwin.

**Execution note:** Run inside the `feat/stack-lifecycle-refactor` worktree (created via `superpowers:using-git-worktrees` at execution start). Each task is independently verifiable and non-destructive on the live `aitools` stack; commit after each task.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `justfile` | Modify | `start` re-shaped to generic pipeline; add `start-cleanup` |
| `.stack.env.example` | Modify | document `STACK_AUTO_REMOVE_PROVISIONERS` |
| `services/litellm/start.sh` → `services/litellm/preflight.sh` | Rename+modify | also `dc up -d litellm` (self-contained) |
| `services/litellm/prestart.sh` | Create | validate rendered `config.runtime.yaml` (first concrete prestart) |
| `services/litellm/provision.sql` | Create | litellm role/db (no extension) |
| `services/litellm/compose.yaml` | Modify | add `litellm-provision`; add `litellm` `depends_on` edge |
| `services/litellm/build.sh` | Modify | own `LITELLM_DB_PASSWORD` (read-or-gen + mirror) |
| `services/honcho/provision.sql` | Create | honcho role/db + `vector` |
| `services/honcho/compose.yaml` | Modify | add `honcho-provision`; edges on honcho-api+deriver |
| `services/honcho/build.sh` | Modify | own `HONCHO_DB_PASSWORD` (read-or-gen + mirror) |
| `services/honcho/poststart.sh` | Create | relocated honcho-postup (password line repointed) |
| `lib/honcho-postup.sh` | Delete | (step 5) |
| `services/hindsight/provision.sql` | Create | hindsight role/db + `vector` |
| `services/hindsight/compose.yaml` | Modify | add `hindsight-provision`; edge on hindsight |
| `services/hindsight/build.sh` | Create | own `HINDSIGHT_DB_PASSWORD` (read-or-gen + mirror) |
| `services/postgres/build.sh` | Modify | (step 6) slim to `POSTGRES_SUPERPASS` only |
| `services/postgres/compose.yaml` | Modify | (step 6) un-wrap entrypoint |
| `services/postgres/pg-init/00-init.sql` | Delete | (step 6) |
| `README.md` | Modify | (step 7) taxonomy + gotchas |

---

## Task 1: Generic justfile pipeline + `start-cleanup` (inert until hooks exist)

**Files:**
- Modify: `justfile` (the `start:` recipe, lines ~37–62; add a `start-cleanup:` recipe)
- Modify: `.stack.env.example`

- [ ] **Step 1: Replace the `start:` recipe**

Replace the comment block immediately above `start:` (the two `# Do NOT add a blanket ...` lines and the staged-bring-up comment) and the entire `start:` recipe body with:

```makefile
# Staged bring-up. ORDER: backends -> per-profile preflight.sh (+ env
# recompute) -> per-profile prestart.sh -> dc up -d (provisioners ordered by
# depends_on) -> per-profile poststart.sh -> machines -> optional cleanup.
# Generic: no service names except the pg/redis backend substrate.
start:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     echo "project=$(stack_project)  COMPOSE_PROFILES=${COMPOSE_PROFILES:-}"; \
     dc up -d pg redis; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
       [ -n "$p" ] && [ -x "{{root}}/services/$p/preflight.sh" ] && \
         { echo "== preflight: $p =="; bash "{{root}}/services/$p/preflight.sh"; }; \
     done; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
       [ -n "$p" ] && [ -x "{{root}}/services/$p/prestart.sh" ] && \
         { echo "== prestart: $p =="; bash "{{root}}/services/$p/prestart.sh"; }; \
     done; \
     dc up -d; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
       [ -n "$p" ] && [ -x "{{root}}/services/$p/poststart.sh" ] && \
         { echo "== poststart: $p =="; bash "{{root}}/services/$p/poststart.sh"; }; \
     done; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$mch" ] && [ -x "{{root}}/machines/$mch/start.sh" ] && \
         bash "{{root}}/machines/$mch/start.sh" "$mch"; \
     done; \
     if [ "${STACK_AUTO_REMOVE_PROVISIONERS:-false}" = "true" ]; then just start-cleanup; fi; \
     echo "start complete"

# Remove this project's exited provisioner containers (multi-stack-safe).
start-cleanup:
    @set -a; source "{{lib}}"; set +a; \
     ids="$(docker ps -aq \
       --filter "label=com.stack.role=provisioner" \
       --filter "label=com.docker.compose.project=$(stack_project)" \
       --filter "status=exited")"; \
     if [ -n "$ids" ]; then docker rm $ids || true; fi; \
     echo "start-cleanup done"
```

Note: `litellm/start.sh` and `lib/honcho-postup.sh` are NOT yet renamed/relocated, and no `preflight.sh`/`prestart.sh`/`poststart.sh` files exist — so the three loops are inert and this recipe currently brings up `pg redis` then `dc up -d` (litellm key minting is temporarily not invoked; that gap is closed atomically in Task 2). Do NOT run `just start` on the live stack between Task 1 and Task 2.

- [ ] **Step 2: Add the env-example flag**

In `.stack.env.example`, in the `# --- what runs ---` section, **after the `STACK_MACHINES=hermes` line** (keeps the `COMPOSE_PROFILES`/`STACK_MACHINES` doc grouping intact), add:

```bash
# Remove exited provisioner containers at the end of `just start`
# (false keeps them so their provisioning logs are inspectable).
STACK_AUTO_REMOVE_PROVISIONERS=false
```

- [ ] **Step 3: Verify the recipe parses and `start-cleanup` is safe when empty**

Run: `just --summary | tr ' ' '\n' | grep -x start-cleanup`
Expected: `start-cleanup`

Run: `just start-cleanup`
Expected: prints `start-cleanup done`, exit 0 (no provisioners exist yet → `ids` empty → `if` skipped; recipe must NOT abort under `set -eu -o pipefail`).

- [ ] **Step 4: Commit**

```bash
git add justfile .stack.env.example
git commit -m "feat(just): generic preflight/prestart/poststart pipeline + start-cleanup"
```

---

## Task 2: LiteLLM preflight rename + first concrete prestart (atomic with Task 1's gap)

**Files:**
- Rename: `services/litellm/start.sh` → `services/litellm/preflight.sh`
- Modify: `services/litellm/preflight.sh` (prepend `dc up -d litellm`)
- Create: `services/litellm/prestart.sh`

- [ ] **Step 1: git-rename the script**

Run: `git mv services/litellm/start.sh services/litellm/preflight.sh`

- [ ] **Step 2: Make preflight self-contained (it brings up litellm itself)**

In `services/litellm/preflight.sh`, immediately after the line `export COMPOSE_ENV_FILES="$(compose_env_files)"` (near the top, before the `# Wait for litellm to actually serve` block), insert:

```bash
# Bring up litellm ourselves (the justfile no longer does this for us).
# `pg` is already running from the start pipeline's backends-first step;
# from the Task 3 provisioner edge this also pulls litellm-provision.
log "litellm/preflight: dc up -d litellm"
dc up -d litellm
```

- [ ] **Step 3: Create the concrete prestart validator**

Create `services/litellm/prestart.sh`:

```bash
#!/usr/bin/env bash
# litellm/prestart.sh — fail loud BEFORE the heavy `up` if the rendered
# runtime config is missing or unparseable. Validation only; no side effects.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
CFG="$STACK_ROOT/services/litellm/config.runtime.yaml"
[ -f "$CFG" ] || die "litellm: $CFG missing — run: just build"
if command -v yq >/dev/null 2>&1; then
  yq -e '.' "$CFG" >/dev/null 2>&1 || die "litellm: $CFG is not valid YAML"
else
  python3 -c "import sys,yaml; yaml.safe_load(open('$CFG'))" \
    || die "litellm: $CFG is not valid YAML"
fi
log "litellm/prestart: config.runtime.yaml present and parses"
```

Run: `chmod +x services/litellm/prestart.sh`

- [ ] **Step 4: Verify preflight still mints and prestart passes (live stack, non-destructive)**

Run: `bash services/litellm/preflight.sh`
Expected: brings up `litellm` (already healthy → no-op recreate), logs `litellm: <alias> key present (unrestricted)` for each `LITELLM_VIRTKEYS` alias, exit 0. Confirm keys unchanged: `grep -c _VIRTUAL_KEY .stack/litellm.generated.env` ≥ 1.

Run: `bash services/litellm/prestart.sh`
Expected: prints `litellm/prestart: config.runtime.yaml present and parses`, exit 0.

- [ ] **Step 5: Verify the negative path (injected malformed config)**

```bash
cp services/litellm/config.runtime.yaml /tmp/llm.cfg.bak
printf '\n: : bad yaml : :\n' >> services/litellm/config.runtime.yaml
bash services/litellm/prestart.sh; echo "exit=$?"
cp /tmp/llm.cfg.bak services/litellm/config.runtime.yaml && rm /tmp/llm.cfg.bak
```
Expected: prints `FATAL: litellm: ...config.runtime.yaml is not valid YAML`, `exit=1`; after restore, re-running `bash services/litellm/prestart.sh` passes.

- [ ] **Step 6: Verify end-to-end generic pipeline (live, non-destructive)**

Run: `just start`
Expected: `dc up -d pg redis` → `== preflight: litellm ==` (mints) → `== prestart: litellm ==` (passes) → `dc up -d` (all services `up-to-date`/healthy) → `== poststart: ... ==` (none yet) → `start complete`. Confirm no service was destroyed: `docker ps --filter label=com.docker.compose.project=aitools --format '{{.Names}} {{.Status}}'` shows pg/redis with their long uptimes preserved.

- [ ] **Step 7: Commit**

```bash
git add services/litellm/preflight.sh services/litellm/prestart.sh
git commit -m "feat(litellm): preflight.sh (renamed, self-bringup) + prestart.sh validator"
```

---

## Task 3: LiteLLM provisioner + decentralized password (acceptance gate)

**Files:**
- Create: `services/litellm/provision.sql`
- Modify: `services/litellm/compose.yaml`
- Modify: `services/litellm/build.sh`

- [ ] **Step 1: Create the idempotent, footgun-free provision SQL**

Create `services/litellm/provision.sql` (role/db only — litellm needs no extension, matching today's `00-init.sql`):

```sql
\set ON_ERROR_STOP on
-- role: create without password if absent, then always re-sync password.
-- :'pw' is a psql quoted-literal (safe); role/db names are literal here
-- (per-service file) so there is no identifier-interpolation footgun.
SELECT 'CREATE ROLE litellm LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litellm') \gexec
ALTER ROLE litellm WITH PASSWORD :'pw';
SELECT 'CREATE DATABASE litellm OWNER litellm'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm') \gexec
```

- [ ] **Step 2: Add the provisioner service + the litellm depends_on edge**

In `services/litellm/compose.yaml`, add a new service (sibling of `litellm:`) and add a `depends_on` to the existing `litellm:` service:

```yaml
  litellm-provision:
    image: pgvector/pgvector:pg18
    profiles: [litellm]
    restart: "no"
    labels:
      com.stack.role: provisioner
    environment:
      PGPASSWORD: ${POSTGRES_SUPERPASS}
      SVC_DB_PASSWORD: ${LITELLM_DB_PASSWORD}
    depends_on:
      pg: { condition: service_healthy }
    volumes:
      - ./provision.sql:/provision.sql:ro
    command:
      - sh
      - -c
      - 'psql -v ON_ERROR_STOP=1 -h pg -U postgres -d postgres -v pw="$SVC_DB_PASSWORD" -f /provision.sql'
```

> **Why `sh -c` (not `command: >`):** Compose tokenizes a bare `command`
> into argv with **no shell** and converts `$$`→`$` literally, so
> `psql -v pw="$SVC_DB_PASSWORD"` would receive the literal string
> `${SVC_DB_PASSWORD}` and set every role's password to that literal
> (silently breaking live auth). The `sh -c` form makes the **container
> shell** expand `$SVC_DB_PASSWORD` from the (correctly compose-interpolated)
> `environment:` map. `PGPASSWORD` is read by `psql` directly from env — no
> shell needed for it.

Add to the existing `litellm:` service (it has **no** `depends_on` today — adding this recreates litellm once, expected/non-destructive):

```yaml
    depends_on:
      litellm-provision: { condition: service_completed_successfully }
```

- [ ] **Step 3: Decentralize the password in build.sh (read-or-gen + mirror)**

Append to `services/litellm/build.sh`:

```bash
# Own LITELLM_DB_PASSWORD here (decentralized). Read the existing live value
# first (never blind-regen — that would shadow the live pw via last-wins and
# break auth against the existing pg volume). Mirror into db.generated.env
# until the central file is retired (Task 7 / spec step 6).
GEN="$STACK_DIR/litellm.generated.env"
pw="$(env_get "$GEN" LITELLM_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(env_get "$STACK_DIR/db.generated.env" LITELLM_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(openssl rand -hex 16)"
env_upsert "$GEN" LITELLM_DB_PASSWORD "$pw"
env_upsert "$STACK_DIR/db.generated.env" LITELLM_DB_PASSWORD "$pw"
log "litellm: LITELLM_DB_PASSWORD owned in litellm.generated.env (mirrored)"
```

- [ ] **Step 4: ACCEPTANCE GATE — prove the provisioner is a no-op on the live volume**

```bash
just build
LIVE="$(set -a; . .stack/db.generated.env; echo "$LITELLM_DB_PASSWORD")"
GENV="$(set -a; . .stack/litellm.generated.env; echo "$LITELLM_DB_PASSWORD")"
[ "$LIVE" = "$GENV" ] && echo "PW-MATCH ok" || echo "PW-MISMATCH (ABORT)"
just start
docker logs "$(docker ps -aq --filter label=com.docker.compose.project=aitools \
  --filter name=litellm-provision)" 2>&1 | tail -5
# REAL-AUTH probe (catches B1-class bugs the env-file compare cannot):
# connect AS the litellm role over TCP using the per-service env password.
RPW="$(set -a; . .stack/litellm.generated.env; echo "$LITELLM_DB_PASSWORD")"
docker exec -e PGPASSWORD="$RPW" aitools-pg-1 \
  psql -h 127.0.0.1 -U litellm -d litellm -tAc 'select 1' || echo "AUTH-FAIL (ABORT)"
docker exec aitools-pg-1 psql -U postgres -tAc \
  "select count(*) from pg_database where datname='litellm';"
```
Expected: `PW-MATCH ok`; provision container exits 0 (role/db exist → `\gexec` no-ops, `ALTER ROLE` re-syncs the real pw); the **REAL-AUTH probe prints `1`** (proves the role password equals the per-service env password — i.e. `:'pw'` got the real value, not a literal); `count` is `1`; LiteLLM `healthy`. **If `PW-MISMATCH` or `AUTH-FAIL`, STOP** — the password wiring is wrong and is breaking live auth.

- [ ] **Step 5: Commit**

```bash
git add services/litellm/provision.sql services/litellm/compose.yaml services/litellm/build.sh
git commit -m "feat(litellm): pg provisioner container + decentralized DB password (mirrored)"
```

---

## Task 4: Honcho + Hindsight provisioners + decentralized passwords

**Files:**
- Create: `services/honcho/provision.sql`, `services/hindsight/provision.sql`
- Modify: `services/honcho/compose.yaml`, `services/honcho/build.sh`
- Modify: `services/hindsight/compose.yaml`
- Create: `services/hindsight/build.sh`

- [ ] **Step 1: honcho provision SQL (role/db + vector)**

Create `services/honcho/provision.sql`:

```sql
\set ON_ERROR_STOP on
SELECT 'CREATE ROLE honcho LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'honcho') \gexec
ALTER ROLE honcho WITH PASSWORD :'pw';
SELECT 'CREATE DATABASE honcho OWNER honcho'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'honcho') \gexec
\connect honcho
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO honcho;
```

- [ ] **Step 2: hindsight provision SQL (role/db + vector)**

Create `services/hindsight/provision.sql`:

```sql
\set ON_ERROR_STOP on
SELECT 'CREATE ROLE hindsight LOGIN'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'hindsight') \gexec
ALTER ROLE hindsight WITH PASSWORD :'pw';
SELECT 'CREATE DATABASE hindsight OWNER hindsight'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hindsight') \gexec
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO hindsight;
```

- [ ] **Step 3: honcho compose — provisioner + edges on api & deriver**

In `services/honcho/compose.yaml` add the provisioner service and add `honcho-provision` to BOTH `honcho-api` and `honcho-deriver` `depends_on` maps:

```yaml
  honcho-provision:
    image: pgvector/pgvector:pg18
    profiles: [honcho]
    restart: "no"
    labels:
      com.stack.role: provisioner
    environment:
      PGPASSWORD: ${POSTGRES_SUPERPASS}
      SVC_DB_PASSWORD: ${HONCHO_DB_PASSWORD}
    depends_on:
      pg: { condition: service_healthy }
    volumes:
      - ./provision.sql:/provision.sql:ro
    command:
      - sh
      - -c
      - 'psql -v ON_ERROR_STOP=1 -h pg -U postgres -d postgres -v pw="$SVC_DB_PASSWORD" -f /provision.sql'
```

In `honcho-api.depends_on` and `honcho-deriver.depends_on`, add:

```yaml
      honcho-provision: { condition: service_completed_successfully }
```

- [ ] **Step 4: hindsight compose — provisioner + edge**

In `services/hindsight/compose.yaml` add the provisioner and add the edge to `hindsight.depends_on`:

```yaml
  hindsight-provision:
    image: pgvector/pgvector:pg18
    profiles: [hindsight]
    restart: "no"
    labels:
      com.stack.role: provisioner
    environment:
      PGPASSWORD: ${POSTGRES_SUPERPASS}
      SVC_DB_PASSWORD: ${HINDSIGHT_DB_PASSWORD}
    depends_on:
      pg: { condition: service_healthy }
    volumes:
      - ./provision.sql:/provision.sql:ro
    command:
      - sh
      - -c
      - 'psql -v ON_ERROR_STOP=1 -h pg -U postgres -d postgres -v pw="$SVC_DB_PASSWORD" -f /provision.sql'
```

Add to `hindsight.depends_on`:

```yaml
      hindsight-provision: { condition: service_completed_successfully }
```

- [ ] **Step 5: honcho build.sh — own + mirror its password**

Append to `services/honcho/build.sh`:

```bash
# Own HONCHO_DB_PASSWORD (decentralized). Read existing live value first;
# mirror into db.generated.env until step 6 (honcho-postup still reads it
# until Task 5 repoints it).
GEN="$STACK_DIR/honcho.generated.env"
pw="$(env_get "$GEN" HONCHO_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(env_get "$STACK_DIR/db.generated.env" HONCHO_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(openssl rand -hex 16)"
env_upsert "$GEN" HONCHO_DB_PASSWORD "$pw"
env_upsert "$STACK_DIR/db.generated.env" HONCHO_DB_PASSWORD "$pw"
log "honcho: HONCHO_DB_PASSWORD owned in honcho.generated.env (mirrored)"
```

- [ ] **Step 6: create hindsight build.sh (none today)**

Create `services/hindsight/build.sh`:

```bash
#!/usr/bin/env bash
# hindsight/build.sh — own HINDSIGHT_DB_PASSWORD (decentralized). Hindsight
# is a prebuilt image (no template/source), so password ownership is the
# only build-time concern.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
GEN="$STACK_DIR/hindsight.generated.env"
pw="$(env_get "$GEN" HINDSIGHT_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(env_get "$STACK_DIR/db.generated.env" HINDSIGHT_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(openssl rand -hex 16)"
env_upsert "$GEN" HINDSIGHT_DB_PASSWORD "$pw"
env_upsert "$STACK_DIR/db.generated.env" HINDSIGHT_DB_PASSWORD "$pw"
log "hindsight: HINDSIGHT_DB_PASSWORD owned in hindsight.generated.env (mirrored)"
```

Run: `chmod +x services/hindsight/build.sh`

- [ ] **Step 7: Acceptance gate — no-op on live volume for both**

```bash
just build
for s in honcho hindsight; do
  L="$(set -a; . .stack/db.generated.env; eval echo \$$(echo $s|tr a-z A-Z)_DB_PASSWORD)"
  G="$(set -a; . .stack/$s.generated.env; eval echo \$$(echo $s|tr a-z A-Z)_DB_PASSWORD)"
  [ "$L" = "$G" ] && echo "$s PW-MATCH ok" || echo "$s PW-MISMATCH (ABORT)"
done
just start
for s in honcho hindsight; do
  docker logs "$(docker ps -aq --filter label=com.docker.compose.project=aitools \
    --filter name=$s-provision)" 2>&1 | tail -3
  RPW="$(set -a; . .stack/$s.generated.env; eval echo \$$(echo $s|tr a-z A-Z)_DB_PASSWORD)"
  docker exec -e PGPASSWORD="$RPW" aitools-pg-1 \
    psql -h 127.0.0.1 -U "$s" -d "$s" -tAc 'select 1' \
    && echo "$s AUTH ok" || echo "$s AUTH-FAIL (ABORT)"
done
docker exec aitools-pg-1 psql -U postgres -tAc \
 "select string_agg(datname,',') from pg_database where datname in ('honcho','hindsight');"
```
Expected: both `PW-MATCH ok`; both provision containers exit 0; both **`<svc> AUTH ok`** (REAL-AUTH probe — role password equals the per-service env password); db list `honcho,hindsight`; honcho-api/honcho-deriver/hindsight `healthy`. **Any `PW-MISMATCH` or `AUTH-FAIL` → STOP.**

- [ ] **Step 8: Commit**

```bash
git add services/honcho/provision.sql services/honcho/compose.yaml services/honcho/build.sh \
        services/hindsight/provision.sql services/hindsight/compose.yaml services/hindsight/build.sh
git commit -m "feat(honcho,hindsight): pg provisioner containers + decentralized passwords (mirrored)"
```

---

## Task 5: Relocate honcho-postup → honcho/poststart.sh (strictly after Task 4)

**Files:**
- Create: `services/honcho/poststart.sh` (from `lib/honcho-postup.sh`, password line repointed)
- Delete: `lib/honcho-postup.sh`

- [ ] **Step 1: git-move and repoint the password source**

Run: `git mv lib/honcho-postup.sh services/honcho/poststart.sh`

In `services/honcho/poststart.sh`, change the line:

```bash
HPW="$(env_get "$STACK_DIR/db.generated.env" HONCHO_DB_PASSWORD)"
```

to:

```bash
HPW="$(env_get "$STACK_DIR/honcho.generated.env" HONCHO_DB_PASSWORD)"
```

and update its `die` message accordingly:

```bash
[ -n "$HPW" ] || die "HONCHO_DB_PASSWORD missing in .stack/honcho.generated.env"
```

Also fix the relative source path (it now lives one dir deeper). Change:

```bash
. "$(dirname "${BASH_SOURCE[0]}")/stacklib.sh"
```

to:

```bash
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
```

Everything else (its own `dc up -d honcho-api`, the tolerant `documents`-table wait, the dim-fix, the profile guard) stays **verbatim** — it is not provisioner-able.

- [ ] **Step 2: Verify the relocated poststart runs via the generic loop**

Run: `just start`
Expected: `== poststart: honcho ==` appears; poststart reads the password from `honcho.generated.env`, finds embedding cols already `vector(1024)` (live DB), logs `honcho: embedding cols already vector(1024) — no dim fix`, honcho-api `healthy`, `start complete`. No reference to `lib/honcho-postup.sh` anywhere.

Run: `grep -rn "honcho-postup" justfile lib/ || echo "no honcho-postup refs"`
Expected: `no honcho-postup refs`

- [ ] **Step 3: Commit**

```bash
# `git mv` (Step 1) already staged the old-path deletion; just add the
# in-file edits made after the mv.
git add services/honcho/poststart.sh
git commit -m "refactor(honcho): relocate honcho-postup -> services/honcho/poststart.sh (password repointed)"
```

---

## Task 6: Retire `00-init.sql`, un-wrap pg, drop the mirror

**Files:**
- Delete: `services/postgres/pg-init/00-init.sql`
- Modify: `services/postgres/compose.yaml`
- Modify: `services/postgres/build.sh`
- Modify: `services/{litellm,honcho,hindsight}/build.sh` (remove the mirror line)

- [ ] **Step 1: Un-wrap the pg entrypoint**

In `services/postgres/compose.yaml`, replace the `entrypoint:` block + the `HONCHO_PW`/`LITELLM_PW`/`HINDSIGHT_PW` env lines + the `/seed/00-init.sql` volume line with the default command (keep `max_connections`):

```yaml
  pg:
    image: pgvector/pgvector:pg18
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_SUPERPASS}
      POSTGRES_DB: postgres
      PGDATA: /var/lib/postgresql/data/pgdata
    command: ["postgres", "-c", "max_connections=200"]
    volumes:
      - pg-data:/var/lib/postgresql/data/
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
```

(Keep the existing `volumes: pg-data:` block at the bottom of the file.)

> **Expected one-time `pg` recreate (S3):** this changes the `pg` service
> definition (entrypoint un-wrapped, `command:` added, the three `*_PW` env
> + `/seed` mount removed), so the next `just start`'s `dc up -d` **recreates
> the `pg` container once**. This is the spec's *surgical-bucket* recreate:
> volume `pg-data` re-mounts, all data/roles/dbs preserved (Postgres just
> starts against the existing data dir). Expected and non-destructive — do
> NOT abort. Dependents drop+reconnect their pooled connections.

- [ ] **Step 2: Slim postgres/build.sh to superpass-only**

In `services/postgres/build.sh`, remove the `HONCHO_DB_PASSWORD` / `LITELLM_DB_PASSWORD` / `HINDSIGHT_DB_PASSWORD` `env_upsert` lines (and the `HINDSIGHT_DB_PASSWORD` reuse-path block). Keep only the `POSTGRES_SUPERPASS` generation. The file's `if [ -f "$DBENV" ] && [ -n "$(env_get "$DBENV" POSTGRES_SUPERPASS)" ]` reuse guard stays.

- [ ] **Step 3: Drop the mirror line from each service build.sh**

In `services/litellm/build.sh`, `services/honcho/build.sh`, `services/hindsight/build.sh`, delete the line:

```bash
env_upsert "$STACK_DIR/db.generated.env" <SVC>_DB_PASSWORD "$pw"
```

(the `db.generated.env` line, keeping the `$GEN` per-service line). No reader of the central per-service passwords remains (Task 5 repointed the last one).

- [ ] **Step 4: Delete 00-init.sql**

Run: `git rm services/postgres/pg-init/00-init.sql`
(Leave the now-empty `pg-init/` dir removal to git; if `rmdir services/postgres/pg-init` succeeds, include it.)

- [ ] **Step 5: Verify non-destructive on the live stack**

```bash
just build
just stop
just start
docker exec aitools-pg-1 psql -U postgres -tAc \
 "select string_agg(datname,',' order by datname) from pg_database \
  where datname in ('honcho','litellm','hindsight');"
docker ps --filter label=com.docker.compose.project=aitools \
  --format '{{.Names}} {{.Status}}'
```
Expected: db list `hindsight,honcho,litellm` (data preserved — provisioners were no-ops; `pg-data` volume NOT recreated); every enabled service returns `healthy`; no `00-init.sql` reference (`grep -rn 00-init services/ justfile || echo none` → `none`).

- [ ] **Step 6: Commit**

```bash
git add -A services/postgres services/litellm/build.sh services/honcho/build.sh services/hindsight/build.sh
git commit -m "refactor(pg): retire 00-init.sql, un-wrap entrypoint, drop password mirror"
```

---

## Task 7: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the lifecycle**

Add a "Service lifecycle" subsection to `README.md` (near the existing service/architecture section) covering: the five artifacts table (`build.sh`/`preflight.sh`/`prestart.sh`/provisioner container/`poststart.sh`), the container-vs-script principle, `STACK_AUTO_REMOVE_PROVISIONERS`, `just start-cleanup`, the surgical pg-image bucket, and the gotcha "adding a pg-using service is additive — own `<svc>.generated.env`, ship `provision.sql` + a provisioner service; no `00-init.sql`, no volume recreate." Mirror the wording of the spec's taxonomy + "Postgres image / cluster-level changes" sections.

- [ ] **Step 2: Verify + commit**

Run: `grep -n "com.stack.role=provisioner\|provision.sql\|STACK_AUTO_REMOVE_PROVISIONERS" README.md | head`
Expected: matches present.

```bash
git add README.md
git commit -m "docs: stack lifecycle taxonomy + provisioner/preflight gotchas"
```

---

## Task 8: From-scratch validation (separate compose project)

**Files:** none (validation only)

- [ ] **Step 1: Spin up a clean isolated project**

```bash
cp .stack/.env /tmp/scratch.env
sed -i '' 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=lcscratch/' /tmp/scratch.env
rm -rf /tmp/lcscratch && cp -R . /tmp/lcscratch
rm -rf /tmp/lcscratch/.stack /tmp/lcscratch/.git
mkdir -p /tmp/lcscratch/.stack && cp /tmp/scratch.env /tmp/lcscratch/.stack/.env
cd /tmp/lcscratch && just build && just start
```
Note: `cp -R .` also copies `services/*/_source` (gitignored, ~19M honcho) — this is intended: `honcho/build.sh` **reuses** an existing `_source` (no network re-clone, faster). `.git` is removed so the scratch tree isn't a confusing second worktree. Fresh `COMPOSE_PROJECT_NAME=lcscratch` ⇒ fresh volumes ⇒ a true from-scratch DB.
Expected: `just build` generates `.stack/{litellm,honcho,hindsight}.generated.env` (+ `db.generated.env` superpass) with **fresh random** DB passwords (no prior values in the scratch `.stack`); `just start` → backends → `== preflight: litellm ==` mints → `== prestart: litellm ==` passes → `dc up -d` (each `*-provision` runs, exits 0; services start) → `== poststart: honcho ==` (fresh DB → applies the dim fix) → all services `healthy`. No `00-init.sql`.

- [ ] **Step 2: Assert provisioning + negative prestart**

```bash
docker exec lcscratch-pg-1 psql -U postgres -tAc \
 "select string_agg(datname,',' order by datname) from pg_database \
  where datname in ('honcho','litellm','hindsight');"
cd /tmp/lcscratch && cp services/litellm/config.runtime.yaml /tmp/lcs.cfg.bak && \
  printf '\n:::bad\n' >> services/litellm/config.runtime.yaml && \
  (just start; echo "exit=$?"); \
  cp /tmp/lcs.cfg.bak services/litellm/config.runtime.yaml && rm /tmp/lcs.cfg.bak && \
  (just start >/dev/null 2>&1; echo "restored-exit=$?")
```
Expected: db list `hindsight,honcho,litellm`; the malformed run prints `FATAL: litellm: ...not valid YAML` and aborts before `dc up -d` (`exit` non-zero). `config.runtime.yaml` is gitignored, so it is restored via the `cp` backup (NOT `git checkout`); after restore `restored-exit=0` (start proceeds).

- [ ] **Step 3: Tear down the scratch project (no trace on aitools)**

```bash
cd /tmp/lcscratch && docker compose -p lcscratch down -v --remove-orphans
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack && rm -rf /tmp/lcscratch /tmp/scratch.env
docker ps --filter label=com.docker.compose.project=aitools --format '{{.Names}} {{.Status}}'
```
Expected: `lcscratch` project + volumes gone; the `aitools` stack untouched (same containers/uptimes as before Task 8).

---

## Task 9: Non-destructive live-stack validation

**Files:** none (validation only)

- [ ] **Step 1: Snapshot, run, compare**

```bash
docker exec aitools-pg-1 pg_dumpall -U postgres --schema-only --globals-only \
  | grep -c 'CREATE ROLE' > /tmp/roles.before
docker volume ls --format '{{.Name}}' | grep aitools_pg-data
just stop && just start
docker exec aitools-pg-1 psql -U postgres -tAc \
 "select string_agg(datname,',' order by datname) from pg_database \
  where datname in ('honcho','litellm','hindsight');"
docker exec aitools-pg-1 pg_dumpall -U postgres --schema-only --globals-only \
  | grep -c 'CREATE ROLE' > /tmp/roles.after
diff /tmp/roles.before /tmp/roles.after && echo "ROLES UNCHANGED"
docker volume ls --format '{{.Name}}' | grep -c aitools_pg-data
```
Expected: db list `hindsight,honcho,litellm`; `ROLES UNCHANGED`; the `aitools_pg-data` volume name unchanged and count `1` (NOT recreated).

- [ ] **Step 2: e2e round-trips through the proxy**

```bash
curl -fsS "http://litellm.aitools.orb.local:4000/health/liveliness" && echo " litellm-ok"
curl -fsS "http://honcho-api.aitools.orb.local:8000/health" && echo " honcho-ok"
curl -fsS "http://hindsight.aitools.orb.local:8888/health" && echo " hindsight-ok"
```
Expected: each prints its OK marker (services serving against the preserved data).

- [ ] **Step 3: Auto-remove flag behavior**

```bash
docker ps -a --filter label=com.stack.role=provisioner \
  --filter label=com.docker.compose.project=aitools --format '{{.Names}} {{.Status}}'
just start-cleanup
docker ps -a --filter label=com.stack.role=provisioner \
  --filter label=com.docker.compose.project=aitools --format '{{.Names}} {{.Status}}'
```
Expected: before cleanup, `*-provision` containers show `Exited (0)`; after `just start-cleanup`, none remain; other services untouched.

- [ ] **Step 4: Final commit (validation notes, if any) + report**

If any divergence from expected output was found and fixed, commit the fix referencing the task. Then report to the user: implementation complete, both from-scratch (Task 8) and non-destructive live (Task 9) validations passed, ready for merge review of `feat/stack-lifecycle-refactor`.

---

## Self-Review (completed by plan author)

**Spec coverage:** build.sh decentralization (T3/T4 + T6 slim), preflight.sh rename+self-bringup (T2), prestart.sh concrete validator (T2), provisioner container + idioms + B1 edges + S1 acceptance gate (T3/T4), poststart relocation w/ S3/S4 password repoint (T5), 00-init.sql/un-wrap/mirror-drop (T6), `just start` backends-first (B1) + generic loops + COMPOSE_ENV_FILES recompute + start-cleanup w/ S5 `|| true` (T1), STACK_AUTO_REMOVE_PROVISIONERS (T1), README/surgical-bucket (T7), from-scratch + non-destructive acceptance (T8/T9). All spec sections mapped.

**Placeholder scan:** no TBD/TODO; the spec's deferred psql quoting is resolved concretely in T3/T4 Step 1 (role created password-less + `ALTER ROLE … :'pw'`, literal role/db names — footgun sidestepped) with a no-op acceptance gate.

**Type/name consistency:** `com.stack.role=provisioner`, `<svc>-provision`, `SVC_DB_PASSWORD`/`PGPASSWORD`/`:'pw'`, `STACK_AUTO_REMOVE_PROVISIONERS`, `services/<svc>/{preflight,prestart,poststart}.sh` used consistently across tasks and match the spec.
