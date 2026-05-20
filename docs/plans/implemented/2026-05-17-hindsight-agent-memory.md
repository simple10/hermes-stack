# Hindsight Agent-Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hindsight (`vectorize-io/hindsight`) to hermes-stack as an optional, profile-gated agent-memory service that reuses the stack Postgres and routes LLM + embeddings through LiteLLM on a minted virtual key — mirroring the Honcho pattern.

**Architecture:** Prebuilt all-in-one image `ghcr.io/vectorize-io/hindsight` pinned by digest (gotcha #6), `profiles: [hindsight]`, project-scoped (no `container_name`/shared net). Reaches `pg`/`litellm` by sibling service name; `depends_on` both healthy so the profile auto-pulls them. A `hindsight` Postgres role/db is seeded by `pg-init/00-init.sql` (fresh volume only). `LITELLM_VIRTKEY_HINDSIGHT_MODELS` → `services/litellm/start.sh` mints `HINDSIGHT_VIRTUAL_KEY`. Verification-driven (infra, not unit-tested): each task makes a change, proves it with a concrete command, then commits.

**Tech Stack:** Docker Compose (`include:`), OrbStack, `just`, bash, Postgres (pgvector), LiteLLM proxy, Hindsight v0.6.2.

**Spec:** `docs/superpowers/specs/2026-05-17-hindsight-agent-memory-design.md`

---

## Concurrency & Commit Discipline (READ FIRST — applies to every commit step)

A second agent is concurrently editing `services/agentmemory/`. Hard rules:

- **Never** stage, edit, read-for-modification, or mention `services/agentmemory/**` in any commit.
- New Hindsight-only files (`services/hindsight/*`) → safe, normal commits.
- Shared files (`docker-compose.yaml`, `.stack.env.example`, `justfile`, `services/postgres/*`, `README.md`) → edits MUST be **additive/insertions** (never rewrite existing lines the other agent may also touch), and committed **immediately** after the edit to minimise the contention window.
- **Pre-commit guard (every shared-file commit step):** after `git add <explicit paths>`, run `git diff --cached --name-only` and `git diff --cached`. Confirm: (a) only the exact files this task edited are staged, (b) every staged hunk is Hindsight-related, (c) no `services/agentmemory/**` path appears. If a foreign/agentmemory hunk is staged (the other agent edited the same file concurrently): run `git restore --staged <file>`, do **not** commit, and surface to the user for coordination — do not commit another agent's work. `git add -p` is unavailable (non-interactive env), so the mitigation is the immediate-commit window + this guard, not interactive hunk selection.
- Branch is `feat/hindsight-agent-memory` (already created off `main`, which already contains the committed agentmemory work). Verify with `git branch --show-current` before starting.

---

## File Structure

| File | New/Mod | Responsibility |
|------|---------|----------------|
| `services/hindsight/.image-digest` | Create | Pinned image ref mirror (gotcha #6), like `services/litellm/.image-digest` |
| `services/hindsight/compose.yaml` | Create | The Hindsight service definition (profile, image, env, deps, healthcheck) |
| `services/postgres/pg-init/00-init.sql` | Modify (additive) | Seed `hindsight` role + db + `vector` extension |
| `services/postgres/compose.yaml` | Modify (additive) | Inject `HINDSIGHT_PW` + seed-substitution |
| `services/postgres/build.sh` | Modify (additive) | Idempotently ensure `HINDSIGHT_DB_PASSWORD` (incl. reuse path) |
| `docker-compose.yaml` | Modify (additive) | `include:` the hindsight compose |
| `.stack.env.example` | Modify (additive) | Document profile + `LITELLM_VIRTKEY_HINDSIGHT_MODELS` declaration |
| `justfile` | Modify (additive) | Extend staged-`start` litellm-mint guard with `hindsight` |
| `README.md` | Modify (additive, guarded/optional) | Architecture/tree/secrets docs |
| `lib/hindsight-postup.sh` | Create (contingency only — Task 9) | One-shot migration step IF Hindsight does not auto-migrate |

---

## Task 0: Pre-flight

**Files:** none

- [ ] **Step 1: Confirm branch and clean-ish state**

Run:
```bash
git branch --show-current && git status --porcelain
```
Expected: prints `feat/hindsight-agent-memory`. Any `services/agentmemory/**` entries in status belong to the other agent — leave them entirely alone for the whole plan.

---

## Task 1: Pin the Hindsight image by digest

**Files:**
- Create: `services/hindsight/.image-digest`

- [ ] **Step 1: Inspect the existing pin format to mirror it**

Run:
```bash
cat services/litellm/.image-digest
```
Expected: a single pinned ref line of the form `ghcr.io/berriai/litellm-database@sha256:<64hex>` (mirror this exact one-line format for Hindsight).

- [ ] **Step 2: Resolve the v0.6.2 manifest digest**

Run (tries the release tag, then `v`-prefixed, then `latest`):
```bash
mkdir -p services/hindsight
DIG=""
for TAG in 0.6.2 v0.6.2 latest; do
  DIG="$(docker buildx imagetools inspect "ghcr.io/vectorize-io/hindsight:${TAG}" --format '{{.Manifest.Digest}}' 2>/dev/null || true)"
  [ -n "$DIG" ] && { echo "resolved tag=${TAG} digest=${DIG}"; break; }
done
[ -n "$DIG" ] || { echo "FATAL: could not resolve hindsight digest"; exit 1; }
printf 'ghcr.io/vectorize-io/hindsight@%s\n' "$DIG" > services/hindsight/.image-digest
cat services/hindsight/.image-digest
```
Expected: prints `resolved tag=0.6.2 digest=sha256:...` (or a fallback tag) and the file contents: `ghcr.io/vectorize-io/hindsight@sha256:<64hex>`.

- [ ] **Step 3: Sanity-check the digest format**

Run:
```bash
grep -Eq '^ghcr\.io/vectorize-io/hindsight@sha256:[0-9a-f]{64}$' services/hindsight/.image-digest && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Commit (new file — safe)**

```bash
git add services/hindsight/.image-digest
git commit -m "feat(hindsight): pin all-in-one image by digest (v0.6.2)"
```

---

## Task 2: Create the Hindsight compose service

**Files:**
- Create: `services/hindsight/compose.yaml`

- [ ] **Step 1: Write the compose file with a digest placeholder token**

Use a quoted heredoc so Compose `${...}` interpolation is preserved literally and no shell expansion occurs. The literal token `__HINDSIGHT_IMAGE__` is substituted in Step 2.

```bash
cat > services/hindsight/compose.yaml <<'EOF'
# hindsight (vectorize-io/hindsight) — OPTIONAL agent memory. profile
# [hindsight]. Project-scoped (no container_name / no shared net). Prebuilt
# all-in-one image PINNED by digest (gotcha #6) — mirrored in
# services/hindsight/.image-digest; bump deliberately via commit (update both).
#
# Reaches pg + litellm by sibling service name on the Compose default
# network. depends_on pg+litellm so COMPOSE_PROFILES=hindsight auto-pulls
# them (Honcho pattern). LLM + embeddings route through LiteLLM on the
# minted HINDSIGHT_VIRTUAL_KEY (glm/grok + voyage; NEVER chatgpt/* —
# gotcha #5, non-streaming). The hindsight DB role/db is seeded by
# services/postgres/pg-init/00-init.sql (FRESH pg volume only — adding this
# to a live stack needs the <project>_pg-data volume recreated).
#
# All-in-one image runs the API (:8888, health GET /health) + the
# Control-Plane Web UI (:9999). Not published to the host; reachable on the
# project net as hindsight:8888 and from the Hermes VM at
# hindsight.<project>.orb.local:8888 / :9999.

services:
  hindsight:
    image: __HINDSIGHT_IMAGE__
    profiles: [hindsight]
    restart: unless-stopped
    expose:
      - "8888"
      - "9999"
    environment:
      HINDSIGHT_API_DATABASE_URL: postgresql://hindsight:${HINDSIGHT_DB_PASSWORD}@pg:5432/hindsight
      HINDSIGHT_API_LLM_PROVIDER: litellm
      HINDSIGHT_API_LITELLM_API_BASE: http://litellm:4000
      HINDSIGHT_API_LLM_API_KEY: ${HINDSIGHT_VIRTUAL_KEY}
      HINDSIGHT_API_LLM_MODEL: glm-4.7-flash
      HINDSIGHT_API_EMBEDDINGS_PROVIDER: litellm
      HINDSIGHT_API_EMBEDDINGS_LITELLM_MODEL: voyage-4-lite
    depends_on:
      pg: { condition: service_healthy }
      litellm: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8888/health || exit 1"]
      interval: 10s
      timeout: 6s
      start_period: 60s
      retries: 30
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
EOF
```

- [ ] **Step 2: Substitute the pinned digest from Task 1**

```bash
PIN="$(cat services/hindsight/.image-digest)"
sed -i '' "s#__HINDSIGHT_IMAGE__#${PIN}#" services/hindsight/compose.yaml
grep -n 'image:' services/hindsight/compose.yaml
```
Expected: `image: ghcr.io/vectorize-io/hindsight@sha256:<64hex>` (no `__HINDSIGHT_IMAGE__` token remains). Note: `sed -i ''` is the BSD/macOS form (this host is darwin).

- [ ] **Step 3: Validate the compose fragment parses in the unified project**

Run:
```bash
set -a; source lib/stacklib.sh; set +a
export COMPOSE_ENV_FILES="$(compose_env_files)"
dc config --services 2>/dev/null | grep -x hindsight && echo "hindsight service parsed OK"
```
Expected: prints `hindsight` then `hindsight service parsed OK`. (This will only succeed once Task 5 adds the `include:` line — if run before Task 5, instead validate standalone: `docker compose -f services/hindsight/compose.yaml config -q && echo "fragment OK"`. Use the standalone form here; the unified check is repeated in Task 5.)

Standalone fallback for this step:
```bash
docker compose -f services/hindsight/compose.yaml config -q && echo "fragment OK"
```
Expected: `fragment OK` (Compose may warn that `${HINDSIGHT_DB_PASSWORD}`/`${HINDSIGHT_VIRTUAL_KEY}` are unset — that is expected here; `-q` exits 0 if the YAML is structurally valid).

- [ ] **Step 4: Commit (new file — safe)**

```bash
git add services/hindsight/compose.yaml
git commit -m "feat(hindsight): add profiled service (pg + LiteLLM-routed)"
```

---

## Task 3: Seed the `hindsight` Postgres role/db

**Files:**
- Modify: `services/postgres/pg-init/00-init.sql`
- Modify: `services/postgres/compose.yaml`

- [ ] **Step 1: Read the current init SQL (to anchor the additive edits)**

Run:
```bash
cat services/postgres/pg-init/00-init.sql
```
Expected (current content):
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

- [ ] **Step 2: Add the hindsight role/db (additive — insert after the litellm DB line)**

Use the Edit tool. Replace exactly:
```
CREATE ROLE litellm LOGIN PASSWORD ':LITELLM_PW';
CREATE DATABASE litellm OWNER litellm;
```
with:
```
CREATE ROLE litellm LOGIN PASSWORD ':LITELLM_PW';
CREATE DATABASE litellm OWNER litellm;
CREATE ROLE hindsight LOGIN PASSWORD ':HINDSIGHT_PW';
CREATE DATABASE hindsight OWNER hindsight;
```

- [ ] **Step 3: Add the hindsight extension/grant block (additive — append after the honcho block)**

Use the Edit tool. Replace exactly:
```
\connect honcho
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO honcho;
```
with:
```
\connect honcho
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO honcho;
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO hindsight;
```

- [ ] **Step 4: Inject `HINDSIGHT_PW` into the pg service env**

Use the Edit tool on `services/postgres/compose.yaml`. Replace exactly:
```
      HONCHO_PW: ${HONCHO_DB_PASSWORD}
      LITELLM_PW: ${LITELLM_DB_PASSWORD}
```
with:
```
      HONCHO_PW: ${HONCHO_DB_PASSWORD}
      LITELLM_PW: ${LITELLM_DB_PASSWORD}
      HINDSIGHT_PW: ${HINDSIGHT_DB_PASSWORD}
```

- [ ] **Step 5: Add the hindsight seed-substitution to the entrypoint sed**

Use the Edit tool on `services/postgres/compose.yaml`. Replace exactly:
```
        sed -e "s/:HONCHO_PW/$${HONCHO_PW}/" -e "s/:LITELLM_PW/$${LITELLM_PW}/" \
          /seed/00-init.sql > /docker-entrypoint-initdb.d/00-init.sql && \
```
with:
```
        sed -e "s/:HONCHO_PW/$${HONCHO_PW}/" -e "s/:LITELLM_PW/$${LITELLM_PW}/" \
          -e "s/:HINDSIGHT_PW/$${HINDSIGHT_PW}/" \
          /seed/00-init.sql > /docker-entrypoint-initdb.d/00-init.sql && \
```

- [ ] **Step 6: Verify the edits**

Run:
```bash
grep -n 'hindsight' services/postgres/pg-init/00-init.sql
grep -nE 'HINDSIGHT_PW|HINDSIGHT_DB_PASSWORD' services/postgres/compose.yaml
docker compose -f services/postgres/compose.yaml config -q && echo "pg compose OK"
```
Expected: 4 hindsight lines in the SQL (role, database, `\connect hindsight`, `GRANT ... hindsight`); 2 matches in the compose (`HINDSIGHT_PW:` env line, `s/:HINDSIGHT_PW/` sed); `pg compose OK`.

- [ ] **Step 7: Commit (shared files — apply the Pre-commit guard)**

```bash
git add services/postgres/pg-init/00-init.sql services/postgres/compose.yaml
git diff --cached --name-only
git diff --cached
```
Confirm only these two files, only hindsight hunks, no `services/agentmemory/**`. Then:
```bash
git commit -m "feat(hindsight): seed hindsight pg role/db + pgvector"
```

---

## Task 4: Generate `HINDSIGHT_DB_PASSWORD` (incl. reuse path)

**Files:**
- Modify: `services/postgres/build.sh`

- [ ] **Step 1: Read the current build.sh**

Run:
```bash
cat services/postgres/build.sh
```
Expected: contains an `if [ -f "$DBENV" ] && [ -n "$(env_get "$DBENV" POSTGRES_SUPERPASS)" ]; then ... else ... env_upsert ... LITELLM_DB_PASSWORD ... fi` block and a trailing comment line `# No shared external network — Compose creates a per-project default network.`

- [ ] **Step 2: Add an idempotent post-block guard for `HINDSIGHT_DB_PASSWORD`**

Use the Edit tool. Replace exactly:
```
  env_upsert "$DBENV" LITELLM_DB_PASSWORD "$(openssl rand -hex 16)"
fi
# No shared external network — Compose creates a per-project default network.
```
with:
```
  env_upsert "$DBENV" LITELLM_DB_PASSWORD "$(openssl rand -hex 16)"
fi
# Per-service passwords added after initial generation must also appear when
# REUSING an older db.generated.env. env_upsert is idempotent; only generate
# when absent so existing honcho/litellm pw keep matching the pg volume.
# NOTE: the matching pg role/db is only seeded when 00-init.sql runs (fresh
# <project>_pg-data volume) — adding a service to a LIVE stack requires
# recreating that volume.
[ -n "$(env_get "$DBENV" HINDSIGHT_DB_PASSWORD)" ] || \
  env_upsert "$DBENV" HINDSIGHT_DB_PASSWORD "$(openssl rand -hex 16)"
# No shared external network — Compose creates a per-project default network.
```

- [ ] **Step 3: Verify build.sh produces the password (both paths)**

Run:
```bash
bash -n services/postgres/build.sh && echo "syntax OK"
bash services/postgres/build.sh
grep -q '^HINDSIGHT_DB_PASSWORD=..*' .stack/db.generated.env && echo "HINDSIGHT_DB_PASSWORD present"
# idempotency: value must not change on a second run
A="$(grep '^HINDSIGHT_DB_PASSWORD=' .stack/db.generated.env)"
bash services/postgres/build.sh
B="$(grep '^HINDSIGHT_DB_PASSWORD=' .stack/db.generated.env)"
[ "$A" = "$B" ] && echo "idempotent OK"
```
Expected: `syntax OK`; `HINDSIGHT_DB_PASSWORD present`; `idempotent OK`. (`.stack/db.generated.env` is gitignored — never staged.)

- [ ] **Step 4: Commit (shared file — apply the Pre-commit guard)**

```bash
git add services/postgres/build.sh
git diff --cached --name-only
git diff --cached
```
Confirm only `services/postgres/build.sh`, only the hindsight hunk, no agentmemory. Then:
```bash
git commit -m "feat(hindsight): generate HINDSIGHT_DB_PASSWORD on build (reuse-safe)"
```

---

## Task 5: Wire the service into the unified compose

**Files:**
- Modify: `docker-compose.yaml`

- [ ] **Step 1: Read the current include list**

Run:
```bash
cat docker-compose.yaml
```
Expected: an `include:` list ending with the existing service compose entries (the last entry may be `services/honcho/compose.yaml` or `services/agentmemory/compose.yaml` depending on the other agent's progress — do NOT modify or reorder any existing line).

- [ ] **Step 2: Append the hindsight include (additive — new last line only)**

Use the Edit tool. Append `  - services/hindsight/compose.yaml` as a new final line under `include:`. Anchor on the current final include entry observed in Step 1: replace that exact final line `  - services/<last>/compose.yaml` with itself followed by a newline and `  - services/hindsight/compose.yaml`. Do not alter any other line. Resulting tail must look like (example if honcho is last):
```yaml
  - services/honcho/compose.yaml
  - services/hindsight/compose.yaml
```

- [ ] **Step 3: Validate the unified project resolves hindsight**

Run:
```bash
set -a; source lib/stacklib.sh; set +a
export COMPOSE_ENV_FILES="$(compose_env_files)"
dc config --services | sort
```
Expected: service list includes `hindsight` (alongside `pg`, `redis`, `litellm`, `honcho`, and possibly `agentmemory`). No YAML/include errors.

- [ ] **Step 4: Commit (shared file — apply the Pre-commit guard)**

```bash
git add docker-compose.yaml
git diff --cached --name-only
git diff --cached
```
Confirm only `docker-compose.yaml`, only the single added include line, no agentmemory hunks. Then:
```bash
git commit -m "feat(hindsight): include service in unified compose"
```

---

## Task 6: Declare the LiteLLM virtual key + document the profile

**Files:**
- Modify: `.stack.env.example`

- [ ] **Step 1: Read the env example**

Run:
```bash
cat .stack.env.example
```
Note the `# --- what runs ---` block (with `COMPOSE_PROFILES=`) and the `# --- virtual-key allowlist DECLARATIONS ...` block ending with the `LITELLM_VIRTKEY_HERMES_MODELS=` line.

- [ ] **Step 2: Add a Hindsight note line above `COMPOSE_PROFILES` (insertion — do not edit the existing `# Available:` line)**

Use the Edit tool. Replace exactly:
```
COMPOSE_PROFILES=litellm,honcho,agentmemory
```
with:
```
# hindsight: OPTIONAL pg-backed agent memory (LiteLLM-routed). Opt-in — add
# `hindsight` here and set LITELLM_VIRTKEY_HINDSIGHT_MODELS below. New pg
# role/db => recreate the <project>_pg-data volume.
COMPOSE_PROFILES=litellm,honcho,agentmemory
```
(If the other agent has changed the `COMPOSE_PROFILES=` value, anchor instead on the unique substring `COMPOSE_PROFILES=` line as it currently reads and prepend the same 3 comment lines immediately before it. Do not change the value itself — Hindsight stays opt-in.)

- [ ] **Step 3: Append the Hindsight virtkey declaration (insertion after the HERMES line)**

Use the Edit tool. Replace exactly the current `LITELLM_VIRTKEY_HERMES_MODELS=...` line (copy its full value verbatim from Step 1 — do not truncate) appending the Hindsight declaration after it. Concretely, replace:
```
LITELLM_VIRTKEY_HERMES_MODELS=<EXACT VALUE FROM STEP 1>
```
with:
```
LITELLM_VIRTKEY_HERMES_MODELS=<EXACT VALUE FROM STEP 1>
# Hindsight: glm/grok (LLM) + voyage (embeddings) ONLY — NEVER chatgpt/*
# (gotcha #5, non-streaming). Mirrors Honcho. Copy this line into
# .stack/.env to mint HINDSIGHT_VIRTUAL_KEY.
LITELLM_VIRTKEY_HINDSIGHT_MODELS=glm-4.7-flash,grok-4.3,glm-5,voyage-4-lite,voyage-4-large,voyage-4
```

- [ ] **Step 4: Verify**

Run:
```bash
grep -n 'hindsight\|HINDSIGHT' .stack.env.example
```
Expected: the 3-line opt-in comment above `COMPOSE_PROFILES`, the Hindsight virtkey comment, and the `LITELLM_VIRTKEY_HINDSIGHT_MODELS=glm-4.7-flash,grok-4.3,glm-5,voyage-4-lite,voyage-4-large,voyage-4` line. The `COMPOSE_PROFILES=` value is unchanged.

- [ ] **Step 5: Commit (shared file — apply the Pre-commit guard)**

```bash
git add .stack.env.example
git diff --cached --name-only
git diff --cached
```
Confirm only `.stack.env.example`, only hindsight insertions, no agentmemory hunks. Then:
```bash
git commit -m "feat(hindsight): document profile + LITELLM_VIRTKEY_HINDSIGHT_MODELS"
```

---

## Task 7: Mint the virtual key during staged start

**Files:**
- Modify: `justfile`

- [ ] **Step 1: Read the staged-start litellm guard**

Run:
```bash
grep -n 'grep -qw litellm\|grep -qw honcho\|services/litellm/start.sh' justfile
```
Expected: the `start:` recipe contains:
```
     if echo "${COMPOSE_PROFILES:-}" | grep -qw litellm || \
        echo "${COMPOSE_PROFILES:-}" | grep -qw honcho; then \
       dc up -d litellm; \
       bash "{{root}}/services/litellm/start.sh"; \
```

- [ ] **Step 2: Extend the guard with `hindsight` (additive — one extra OR clause)**

Use the Edit tool. Replace exactly:
```
     if echo "${COMPOSE_PROFILES:-}" | grep -qw litellm || \
        echo "${COMPOSE_PROFILES:-}" | grep -qw honcho; then \
```
with:
```
     if echo "${COMPOSE_PROFILES:-}" | grep -qw litellm || \
        echo "${COMPOSE_PROFILES:-}" | grep -qw honcho || \
        echo "${COMPOSE_PROFILES:-}" | grep -qw hindsight; then \
```

- [ ] **Step 3: Verify justfile still parses**

Run:
```bash
just --list >/dev/null && echo "justfile OK"
grep -n 'grep -qw hindsight' justfile
```
Expected: `justfile OK`; one match showing the added clause.

- [ ] **Step 4: Commit (shared file — apply the Pre-commit guard)**

```bash
git add justfile
git diff --cached --name-only
git diff --cached
```
Confirm only `justfile`, only the added OR clause, no agentmemory. Then:
```bash
git commit -m "feat(hindsight): mint HINDSIGHT_VIRTUAL_KEY in staged start"
```

---

## Task 8: README docs (additive, guarded — lowest priority)

**Files:**
- Modify: `README.md`

> The other agent recently rewrote README sections for agentmemory. Treat this task as **best-effort/optional**: if `README.md` shows concurrent uncommitted changes from the other agent (`git status --porcelain README.md` non-empty for reasons unrelated to this task), **skip this task**, note it in the final summary, and proceed — functional behaviour does not depend on it.

- [ ] **Step 1: Check contention**

Run:
```bash
git status --porcelain README.md; echo "---"; grep -n 'honcho\|agentmemory' README.md | head -40
```
If `git status --porcelain README.md` is non-empty (other agent mid-edit), **skip to Task 9** and record "README docs deferred (concurrent edit)".

- [ ] **Step 2: Add a Hindsight bullet to the services list (additive)**

Use the Edit tool to add, immediately after the existing `- **honcho** — ...` architecture bullet (copy that bullet's exact surrounding text from Step 1 to anchor), a new bullet:
```
- **hindsight** — service `hindsight` (optional), prebuilt
  `vectorize-io/hindsight` all-in-one image **pinned by digest**. Profile
  `[hindsight]`; `depends_on` pg/litellm so `COMPOSE_PROFILES=hindsight`
  auto-pulls them. LLM + embeddings via LiteLLM (glm/grok + voyage; never
  `chatgpt/*`). API `:8888`, Control-Plane UI `:9999`.
```

- [ ] **Step 3: Add secrets-table rows (additive)**

In the Secrets-model table, add two rows after the `.stack/db.generated.env` and `.stack/litellm.generated.env` rows respectively — i.e. note that `HINDSIGHT_DB_PASSWORD` is owned by `services/postgres/build.sh` and `HINDSIGHT_VIRTUAL_KEY` by `services/litellm/start.sh`. Use the Edit tool to extend the existing cell text for those two rows (append `, HINDSIGHT_DB_PASSWORD` and `, HINDSIGHT_VIRTUAL_KEY` to the respective Contents cells) rather than restructuring the table.

- [ ] **Step 4: Verify & commit (shared file — apply the Pre-commit guard)**

```bash
grep -n 'hindsight\|HINDSIGHT' README.md
git add README.md
git diff --cached --name-only
git diff --cached
```
Confirm only `README.md`, only hindsight additions, no agentmemory hunks. Then:
```bash
git commit -m "docs(hindsight): architecture + secrets table"
```

---

## Task 9: End-to-end verification (fresh stack) + auto-migration contingency

**Files:** none (unless contingency triggers → creates `lib/hindsight-postup.sh`)

This task uses superpowers:verification-before-completion: claims require command output.

- [ ] **Step 1: Enable the profile + declare the virtkey in the real env**

Run:
```bash
test -f .stack/.env || just setup   # only if missing; otherwise edit in place
# Ensure hindsight is in COMPOSE_PROFILES and the virtkey declaration exists:
grep -q '^LITELLM_VIRTKEY_HINDSIGHT_MODELS=' .stack/.env || \
  echo 'LITELLM_VIRTKEY_HINDSIGHT_MODELS=glm-4.7-flash,grok-4.3,glm-5,voyage-4-lite,voyage-4-large,voyage-4' >> .stack/.env
grep -q '^COMPOSE_PROFILES=.*hindsight' .stack/.env || \
  sed -i '' 's/^\(COMPOSE_PROFILES=.*\)$/\1,hindsight/' .stack/.env
grep -E '^COMPOSE_PROFILES=|^LITELLM_VIRTKEY_HINDSIGHT_MODELS=' .stack/.env
```
Expected: `COMPOSE_PROFILES` contains `hindsight`; the `LITELLM_VIRTKEY_HINDSIGHT_MODELS=` line is present. (`.stack/.env` is gitignored — never staged.)

- [ ] **Step 2: Recreate from scratch (new pg volume so 00-init.sql seeds hindsight)**

Run:
```bash
set -a; source lib/stacklib.sh; set +a
P="$(stack_project)"
just stop || true
docker volume rm "${P}_pg-data" 2>/dev/null || true
just build
just start
```
Expected: `just start` completes ("start complete"). Note: removing `${P}_pg-data` wipes Honcho/LiteLLM data too — this is the stack's supported recreate-from-scratch model (gotcha #4 self-heals LiteLLM keys). Confirm with the user before running if any local data matters.

- [ ] **Step 3: Confirm the virtual key was minted**

Run:
```bash
grep -n '^HINDSIGHT_VIRTUAL_KEY=' .stack/litellm.generated.env
```
Expected: a `HINDSIGHT_VIRTUAL_KEY=sk-...` line.

- [ ] **Step 4: Confirm the hindsight role/db were seeded**

Run:
```bash
set -a; source lib/stacklib.sh; set +a
dc exec -T pg psql -U postgres -d hindsight -c '\dx' -c "select current_database();"
```
Expected: connects to db `hindsight`; `\dx` lists the `vector` extension; `current_database()` = `hindsight`.

- [ ] **Step 5: Confirm container health**

Run:
```bash
set -a; source lib/stacklib.sh; set +a
dc ps hindsight
for i in $(seq 1 30); do
  s="$(dc ps --format '{{.Service}} {{.Health}}' | awk '$1=="hindsight"{print $2}')"
  echo "health=$s"; [ "$s" = "healthy" ] && break; sleep 10
done
```
Expected: `hindsight` reaches `healthy` within ~5 min.

- [ ] **Step 6: Verify auto-migration (RISK #1 decision point)**

Run:
```bash
set -a; source lib/stacklib.sh; set +a
dc logs hindsight | grep -iE 'alembic|migrat|upgrade head' | tail -20
dc exec -T pg psql -U postgres -d hindsight -c "\dt" -c "select count(*) from information_schema.tables where table_schema='public';"
```
Expected (auto-migrate success): logs show an alembic/migration run; `\dt` lists Hindsight tables (count > 0).

**If tables are absent / no migration ran → contingency (create `lib/hindsight-postup.sh`):**

- [ ] **Step 6a (contingency only): Create the one-shot migration step**

Inspect how Hindsight runs migrations:
```bash
set -a; source lib/stacklib.sh; set +a
dc exec -T hindsight sh -lc 'command -v alembic; ls -d /app* 2>/dev/null; alembic --help 2>/dev/null | head -1'
```
Then create `lib/hindsight-postup.sh` mirroring `lib/honcho-postup.sh`'s structure (read it first: `cat lib/honcho-postup.sh`), running the discovered migration command via `dc exec -T hindsight <migrate cmd>` after the service is up, idempotent and safe to re-run. Commit (new file — safe):
```bash
git add lib/hindsight-postup.sh
git commit -m "fix(hindsight): one-shot migration postup (no auto-migrate)"
```

- [ ] **Step 6b (contingency only): Hook it into staged start**

Use the Edit tool on `justfile`: directly after the `if ... grep -qw honcho ... bash "{{root}}/lib/honcho-postup.sh"; fi;` block, add a parallel guarded block:
```
     if echo "${COMPOSE_PROFILES:-}" | grep -qw hindsight; then \
       bash "{{root}}/lib/hindsight-postup.sh"; \
     fi; \
```
placed BEFORE the final `dc up -d;`. Verify `just --list >/dev/null && echo OK`, re-run `just start`, repeat Step 6. Commit (shared file — Pre-commit guard):
```bash
git add justfile
git diff --cached
git commit -m "fix(hindsight): run hindsight-postup in staged start"
```

- [ ] **Step 7: End-to-end retain → recall round-trip (RISK #2 & #3)**

Run (from the Hermes-network reachable host; uses the project net via a throwaway curl container, or `dc exec` into hindsight):
```bash
set -a; source lib/stacklib.sh; set +a
# retain
dc exec -T hindsight sh -lc 'curl -fsS -X POST http://localhost:8888/v1/retain \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"The hermes-stack pins images by digest (gotcha 6).\",\"agent_id\":\"smoke\"}"' ; echo
# recall
dc exec -T hindsight sh -lc 'curl -fsS -X POST http://localhost:8888/v1/recall \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"how are images pinned?\",\"agent_id\":\"smoke\"}"' ; echo
```
Expected: `retain` returns 2xx (memory id); `recall` returns the stored memory. If the exact route differs by version, discover it: `dc exec -T hindsight sh -lc 'curl -fsS http://localhost:8888/openapi.json' | python3 -m json.tool | grep -i '"/v1\|retain\|recall'` and use the correct paths. (Endpoint shape is version-dependent; the success criterion is a working retain→recall, not a literal path.)

- [ ] **Step 8: Confirm model traffic went through LiteLLM (RISK #2/#3 evidence)**

Run:
```bash
set -a; source lib/stacklib.sh; set +a
dc logs hindsight | grep -iE 'error|exception|dimension|embed' | tail -20
dc exec -T pg psql -U postgres -d litellm -c \
  "select model, count(*) from \"LiteLLM_SpendLogs\" where api_key in (select token from \"LiteLLM_VerificationToken\" where key_alias='hindsight') group by model;"
```
Expected: no fatal embedding-dimension/structured-output errors in hindsight logs; SpendLogs shows `glm-4.7-flash` (LLM) and `voyage-4-lite` (embeddings) calls attributed to the `hindsight` key — proving LLM + embeddings routed through LiteLLM on the minted key. (If the SpendLogs query column names differ by LiteLLM version, fall back to the LiteLLM UI / `/spend/logs` — the criterion is: hindsight's glm + voyage calls are visible under the hindsight key.)

- [ ] **Step 9: Regression check (other services unaffected)**

Run:
```bash
set -a; source lib/stacklib.sh; set +a
dc ps
```
Expected: `pg`, `redis`, `litellm`, `honcho` (and `agentmemory` if enabled) all still healthy/running; nothing crash-looped by the change.

- [ ] **Step 10: Verification summary**

Per superpowers:verification-before-completion, state each acceptance criterion from the spec with the command output that proves it (service healthy; schema present incl. how migrations ran; retain→recall round-trip; glm+voyage in SpendLogs under the hindsight key; no regression). Only claim "done" with that evidence pasted.

---

## Post-plan: Self-Review

Checked against the spec (`2026-05-17-hindsight-agent-memory-design.md`):

- **Architecture** (compose service, digest pin, profile, expose 8888/9999, deps, healthcheck `/health:8888`) → Tasks 1–2. ✓
- **Postgres role/db + pgvector + HINDSIGHT_PW + sed** → Task 3. ✓
- **build.sh reuse-safe HINDSIGHT_DB_PASSWORD** → Task 4. ✓
- **LLM+embeddings via LiteLLM, no chatgpt/\*** → compose env (Task 2) + virtkey decl (Task 6). ✓
- **Root include / .stack.env.example / justfile staged-start / README** → Tasks 5, 6, 7, 8. ✓
- **Risk #1 auto-migration (verify + contingency postup)** → Task 9 Step 6 / 6a / 6b. ✓
- **Risk #2 voyage 1024-dim / Risk #3 glm-grok structured output** → Task 9 Steps 7–8. ✓
- **Recreate-from-scratch operational note** → Tasks 4 (comment), 6 (env comment), 9 Step 2. ✓
- **Concurrency: additive + scoped commits, never touch agentmemory** → Concurrency section + every shared-file commit step's Pre-commit guard. ✓

Placeholder scan: the only deferred-value tokens are the image digest (resolved by a concrete command in Task 1, scripted into Task 2) and version-dependent API routes / SpendLogs columns (Task 9 gives a concrete discovery command + an explicit success criterion) — these are execution-time facts, not unfilled plan gaps. Type/name consistency: `HINDSIGHT_DB_PASSWORD`, `HINDSIGHT_VIRTUAL_KEY`, `HINDSIGHT_PW`, `LITELLM_VIRTKEY_HINDSIGHT_MODELS`, profile `hindsight`, service `hindsight` used consistently across all tasks and the spec. No gaps found.
