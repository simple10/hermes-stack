# Firecrawl Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-hosted Firecrawl (nuq architecture) as an opt-in `[firecrawl]` profile + a shared always-on `rabbitmq` backend, integrated with the landed stack lifecycle.

**Architecture:** 3 profiled services (`firecrawl-api`, `firecrawl-playwright`, dedicated self-initializing `firecrawl-postgres` — upstream `nuq-postgres` image) + a new shared `rabbitmq` backend. Images digest-pinned. AI extract routed through LiteLLM via a minted virtual key. No shared-`pg` change, no provisioner/preflight/poststart needed. Spec: `docs/superpowers/specs/2026-05-18-firecrawl-service-design.md`.

**Tech Stack:** Docker Compose v2, bash, just, RabbitMQ 4.x, Postgres 17 (`nuq-postgres`), LiteLLM. Platform darwin. Branch: `feat/firecrawl` (off `main`@`d2c46fe`).

**Conventions (from the merged sub-project 1):** project-scoped compose (no top-level `name:`, no custom networks — use the Compose default per-project network; siblings reach each other by service name). No host `ports:` — `expose:` only (orb DNS `<svc>.<project>.orb.local`). Per-service secrets via `services/<svc>/build.sh` → `.stack/<svc>.generated.env` (read-existing-first, never blind-regen). Backends (no profile) are always-on and brought up by the `just start` "backends-first" line. `just build` runs `services/<p>/build.sh` for each active profile; `compose_env_files()` auto-globs `.stack/*.generated.env`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `services/rabbitmq/compose.yaml` | Create | shared always-on rabbitmq backend (no profile) |
| `services/firecrawl/build.sh` | Create | own `FIRECRAWL_DB_PASSWORD` + `FIRECRAWL_BULL_AUTH_KEY` |
| `services/firecrawl/.image-digest` | Create | the 3 pinned `ghcr.io/firecrawl/*@sha256` digests |
| `services/firecrawl/compose.yaml` | Create | `firecrawl-api`/`-playwright`/`-postgres`, `profiles:[firecrawl]` |
| `docker-compose.yaml` | Modify | `include:` += rabbitmq + firecrawl |
| `justfile` | Modify | backends-first line `dc up -d pg redis` → `… rabbitmq` |
| `.stack.env.example` | Modify | firecrawl profile doc, `FIRECRAWL_MODEL`, resource levers, `LITELLM_VIRTKEYS+=firecrawl` |
| `README.md` | Modify | service entry + gotcha |

---

## Task 1: RabbitMQ shared backend

**Files:**
- Create: `services/rabbitmq/compose.yaml`
- Modify: `docker-compose.yaml` (`include:` list)
- Modify: `justfile` (the `start:` recipe backends line)

- [ ] **Step 1: Resolve a specific RabbitMQ 4.x management tag**

Run:
```bash
docker pull rabbitmq:4-management >/dev/null && \
docker image inspect rabbitmq:4-management \
  --format '{{ index .Config.Labels "org.opencontainers.image.version" }}'
```
Expected: a version like `4.1.4` (record it; use `rabbitmq:<that>-management` below, e.g. `rabbitmq:4.1.4-management`). If the label is empty, run `docker run --rm rabbitmq:4-management rabbitmqctl version` and use that. This pins a concrete patch (the redis:8.6.3 precedent — backends use specific tag pins, not digests).

- [ ] **Step 2: Create `services/rabbitmq/compose.yaml`**

Replace `RMQ_TAG` with the exact tag from Step 1 (e.g. `4.1.4-management`):

```yaml
# rabbitmq. No profile => always-on shared backend (nuq transport for
# firecrawl; reusable by future services). Project-scoped (no container_name
# / no shared network). Siblings reach it at host `rabbitmq:5672`; mgmt UI
# at rabbitmq.<project>.orb.local:15672 (default guest/guest — localhost-only
# by RabbitMQ default, so orb-DNS is effectively read-blocked; the AMQP path
# on the project net is unauthenticated, same as upstream firecrawl). Tag-
# pinned like redis:8.6.3 (backends use tag pins, not digests).
services:
  rabbitmq:
    image: rabbitmq:RMQ_TAG
    restart: unless-stopped
    command: ["rabbitmq-server"]
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
    healthcheck:
      # N2: timings intentionally more generous than the redis/pg backend
      # precedent (5s/5s/10, no start_period) — RabbitMQ's epmd/beam boot is
      # genuinely slower (~10-20s). Do NOT "normalize" back to 5s/3 retries
      # (causes flaky firecrawl-api `depends_on: rabbitmq service_healthy`).
      test: ["CMD", "rabbitmq-diagnostics", "-q", "check_running"]
      interval: 10s
      timeout: 6s
      retries: 10
      start_period: 20s

volumes:
  rabbitmq-data:
```

- [ ] **Step 3: Add rabbitmq to the root compose `include:`**

In `docker-compose.yaml`, change:
```yaml
include:
  - services/postgres/compose.yaml
  - services/redis/compose.yaml
```
to:
```yaml
include:
  - services/postgres/compose.yaml
  - services/redis/compose.yaml
  - services/rabbitmq/compose.yaml
```

- [ ] **Step 4: Add rabbitmq to the `just start` backends-first line**

In `justfile`, in the `start:` recipe, change the single line:
```
     dc up -d pg redis; \
```
to:
```
     dc up -d pg redis rabbitmq; \
```
(rabbitmq is a no-profile always-on backend, exactly like pg/redis — it must be up before any firecrawl preflight/`dc up -d`.)

- [ ] **Step 5: Verify rabbitmq comes up healthy in an isolated project**

Run:
```bash
T=/tmp/fcr-rmq && rm -rf $T && mkdir -p $T/.stack && cp .stack/.env $T/.stack/.env
sed -i '' 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=fcrrmq/' $T/.stack/.env
docker compose -p fcrrmq -f docker-compose.yaml --env-file $T/.stack/.env up -d rabbitmq
for i in $(seq 1 24); do s=$(docker inspect -f '{{.State.Health.Status}}' fcrrmq-rabbitmq-1 2>/dev/null||echo none); echo "t=$((i*5)) $s"; [ "$s" = healthy ] && break; sleep 5; done
docker compose -p fcrrmq down -v --remove-orphans; rm -rf $T
docker ps --filter label=com.docker.compose.project=aitools -q | wc -l | tr -d ' '
```
Expected: rabbitmq reaches `healthy`; teardown clean; the `aitools` container count is unchanged (live stack untouched).

- [ ] **Step 6: Commit**

```bash
git add services/rabbitmq/compose.yaml docker-compose.yaml justfile
```
(substitute the real tag in the message)

---

## Task 2: `services/firecrawl/build.sh` + env-example levers

**Files:**
- Create: `services/firecrawl/build.sh`
- Modify: `.stack.env.example`

- [ ] **Step 1: Create `services/firecrawl/build.sh`**

```bash
#!/usr/bin/env bash
# firecrawl/build.sh — own FIRECRAWL_DB_PASSWORD + FIRECRAWL_BULL_AUTH_KEY
# (decentralized). Read existing first so they keep matching the dedicated
# firecrawl-pg-data volume / the running queue-admin UI; never blind-regen.
# Firecrawl is all-env (no config template to render).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
GEN="$STACK_DIR/firecrawl.generated.env"

dbpw="$(env_get "$GEN" FIRECRAWL_DB_PASSWORD)"
[ -n "$dbpw" ] || dbpw="$(openssl rand -hex 16)"
env_upsert "$GEN" FIRECRAWL_DB_PASSWORD "$dbpw"

bull="$(env_get "$GEN" FIRECRAWL_BULL_AUTH_KEY)"
[ -n "$bull" ] || bull="$(openssl rand -hex 16)"
env_upsert "$GEN" FIRECRAWL_BULL_AUTH_KEY "$bull"

log "firecrawl: FIRECRAWL_DB_PASSWORD + FIRECRAWL_BULL_AUTH_KEY owned in firecrawl.generated.env"
```

Run: `chmod +x services/firecrawl/build.sh`

- [ ] **Step 2: Verify build.sh is idempotent (isolated copy — must NOT touch the real `.stack/`)**

> **Why this exact form (B1):** `lib/stacklib.sh` line 7 is an
> *unconditional* `STACK_DIR="$STACK_ROOT/.stack"` — a pre-exported
> `STACK_DIR` is **overwritten** when build.sh sources stacklib, so an
> env-override would write into the **real live `.stack/`**
> (shared-checkout hazard) and false-pass. Line 6 *does* honor a
> pre-exported `STACK_ROOT` (`STACK_ROOT="${STACK_ROOT:-…}"`), so override
> `STACK_ROOT` against an rsync'd copy and grep that copy's `.stack/`.

Run:
```bash
B=/tmp/fcr-b && rm -rf $B && mkdir -p $B
rsync -a --exclude .git --exclude .stack --exclude '.claude' \
  /Users/joe/Development/ai-tools/openclaw/hermes-stack/. "$B/"
mkdir -p "$B/.stack"
STACK_ROOT="$B" bash "$B/services/firecrawl/build.sh"
a="$(grep '^FIRECRAWL_DB_PASSWORD=' "$B/.stack/firecrawl.generated.env")"
STACK_ROOT="$B" bash "$B/services/firecrawl/build.sh"
b="$(grep '^FIRECRAWL_DB_PASSWORD=' "$B/.stack/firecrawl.generated.env")"
keys="$(grep -c '=' "$B/.stack/firecrawl.generated.env")"
{ [ "$a" = "$b" ] && [ "$keys" -eq 2 ]; } \
  && echo "IDEMPOTENT ok ($keys keys)" || echo "NOT IDEMPOTENT (FAIL)"
rm -rf "$B"
```
Expected: `IDEMPOTENT ok (2 keys)` — 2nd run reuses the same password (read-existing-first); both `FIRECRAWL_DB_PASSWORD` + `FIRECRAWL_BULL_AUTH_KEY` present. The real repo `.stack/` is never written (we run the rsync'd copy with `STACK_ROOT` overridden — the only honored override).

- [ ] **Step 3: `.stack.env.example` — profile doc + model lever + resource levers + virtkey**

(a) Find the `COMPOSE_PROFILES=` line and the comment above it listing available profiles. In that comment's "Available:" enumeration, add `firecrawl`. Do **NOT** add `firecrawl` to the `COMPOSE_PROFILES=` value itself (opt-in). Add this doc line to that comment block:
```
# firecrawl: OPTIONAL web-scraper API (nuq). Opt-in — add `firecrawl`. Heavy
# (api+playwright+dedicated pg); auto-pulls litellm; needs the always-on
# rabbitmq backend. Extract routed via LiteLLM (FIRECRAWL_VIRTUAL_KEY).
```

(b) In the `# === Model levers ===` section, on the line after `HINDSIGHT_MODEL=${STACK_LLM_MODEL}`, add:
```
FIRECRAWL_MODEL=${STACK_LLM_MODEL}
```

(c) Immediately after the `STACK_AUTO_REMOVE_PROVISIONERS=false` line, add:
```bash
# Firecrawl resource limits (profile [firecrawl]; lighter than upstream's
# 8G/4CPU + 4G/2CPU defaults — bump per crawl workload).
FIRECRAWL_API_MEM=4g
FIRECRAWL_API_CPU=2
FIRECRAWL_PLAYWRIGHT_MEM=2g
FIRECRAWL_PLAYWRIGHT_CPU=2
```

(d) Change the `LITELLM_VIRTKEYS=` line:
```
LITELLM_VIRTKEYS=hermes,honcho,agentmemory,hindsight
```
to:
```
LITELLM_VIRTKEYS=hermes,honcho,agentmemory,hindsight,firecrawl
```

- [ ] **Step 4: Verify**

Run: `grep -nE 'FIRECRAWL_MODEL=|FIRECRAWL_API_MEM=|FIRECRAWL_PLAYWRIGHT_CPU=|LITELLM_VIRTKEYS=.*firecrawl|^# firecrawl: OPTIONAL' .stack.env.example`
Expected: all five lines present; `LITELLM_VIRTKEYS` ends with `,firecrawl`; `COMPOSE_PROFILES=` value still has NO `firecrawl`.

- [ ] **Step 5: Commit**

```bash
git add services/firecrawl/build.sh .stack.env.example
```

---

## Task 3: Resolve + pin the 3 Firecrawl image digests

**Files:**
- Create: `services/firecrawl/.image-digest`

- [ ] **Step 1: Resolve the three manifest digests**

Run (primary = manifest-list digest via imagetools; real fallback =
`RepoDigests` after a pull — S2: the old `python3 -c '…print()'` fallback
was bogus, it emitted an empty digest):
```bash
for i in firecrawl playwright-service nuq-postgres; do
  d=$(docker buildx imagetools inspect ghcr.io/firecrawl/$i:latest \
        --format '{{.Manifest.Digest}}' 2>/dev/null)
  if [ -z "$d" ]; then
    docker pull -q ghcr.io/firecrawl/$i:latest >/dev/null
    ref=$(docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/firecrawl/$i:latest)
    d=${ref#*@}
  fi
  case "$d" in sha256:*) echo "ghcr.io/firecrawl/$i@$d";;
    *) echo "RESOLVE-FAILED for $i (got: '$d') — STOP"; esac
done
```
Expected: exactly three `ghcr.io/firecrawl/<img>@sha256:<64hex>` lines, no `RESOLVE-FAILED`. The manifest-list digest pulls correctly on darwin/arm64 (Docker resolves the per-arch image from the list digest — same mechanism as the existing pinned `litellm`/`hindsight` digests).

- [ ] **Step 2: Write `services/firecrawl/.image-digest`**

Create the file with the three resolved lines from Step 1. **S6:** this is a *documented variant* of the `services/litellm/.image-digest` convention (litellm's is a single bare line, no comment) — three pinned refs + a leading `#` provenance/bump-instruction header. Nothing parses `.image-digest` mechanically (purely documentary across litellm/hindsight/here), so the comment is safe:

```
# Resolved <YYYY-MM-DD> from :latest (gotcha #6 — upstream ships no semver;
# digest is the only stable pin). Bump deliberately: re-resolve + update
# BOTH this file and services/firecrawl/compose.yaml in one commit.
ghcr.io/firecrawl/firecrawl@sha256:<resolved-1>
ghcr.io/firecrawl/playwright-service@sha256:<resolved-2>
ghcr.io/firecrawl/nuq-postgres@sha256:<resolved-3>
```
(substitute the real digests + today's date)

- [ ] **Step 3: Commit**

```bash
git add services/firecrawl/.image-digest
```

---

## Task 4: `services/firecrawl/compose.yaml`

**Files:**
- Create: `services/firecrawl/compose.yaml`
- Modify: `docker-compose.yaml` (`include:` list)

- [ ] **Step 1: Create `services/firecrawl/compose.yaml`**

Substitute `<digest-N>` with the exact `@sha256:…` from `services/firecrawl/.image-digest` (Task 3). NB upstream translation: dropped `name: firecrawl` and the custom `backend` network (stack uses the Compose default per-project network — siblings reach each other by service name); dropped host `ports:` (use `expose:` + orb DNS); `nuq-postgres`→`firecrawl-postgres`, `playwright-service`→`firecrawl-playwright`, `api`→`firecrawl-api`.

```yaml
# firecrawl (nuq architecture). profile [firecrawl]. Project-scoped (no
# container_name / no shared network — Compose default per-project net;
# siblings reach each other by service name). Images digest-pinned (gotcha
# #6) — mirrored in services/firecrawl/.image-digest. firecrawl-postgres is
# DEDICATED & self-initializing (upstream nuq-postgres image bakes nuq.sql +
# pg_cron); it is NOT the shared `pg` and needs no provisioner. Extract is
# routed through LiteLLM on the minted FIRECRAWL_VIRTUAL_KEY.
services:
  firecrawl-postgres:
    image: ghcr.io/firecrawl/nuq-postgres@<digest-3>
    profiles: [firecrawl]
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${FIRECRAWL_DB_PASSWORD}
      POSTGRES_DB: postgres
    volumes:
      - firecrawl-pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 20
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  firecrawl-playwright:
    image: ghcr.io/firecrawl/playwright-service@<digest-2>
    profiles: [firecrawl]
    restart: unless-stopped
    expose:
      - "3000"
    environment:
      PORT: "3000"
      # S3: deliberate stack default — upstream leaves BLOCK_MEDIA UNSET
      # (media NOT blocked). We block media (lighter/faster scrapes; no
      # binary fetches). Flip to "false" if a use case needs media.
      BLOCK_MEDIA: "true"
      # static value (upstream derives this from CRAWL_CONCURRENT_REQUESTS).
      MAX_CONCURRENT_PAGES: "10"
    cpus: ${FIRECRAWL_PLAYWRIGHT_CPU:-2}
    mem_limit: ${FIRECRAWL_PLAYWRIGHT_MEM:-2g}
    tmpfs:
      - /tmp/.cache:noexec,nosuid,size=1g
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  firecrawl-api:
    image: ghcr.io/firecrawl/firecrawl@<digest-1>
    profiles: [firecrawl]
    restart: unless-stopped
    command: ["node", "dist/src/harness.js", "--start-docker"]
    ulimits:
      nofile: { soft: 65535, hard: 65535 }
    extra_hosts:
      - "host.docker.internal:host-gateway"
    expose:
      - "3002"
    environment:
      HOST: "0.0.0.0"
      PORT: "3002"
      EXTRACT_WORKER_PORT: "3004"
      WORKER_PORT: "3005"
      ENV: local
      HARNESS_STARTUP_TIMEOUT_MS: "60000"
      REDIS_URL: redis://redis:6379/3
      REDIS_RATE_LIMIT_URL: redis://redis:6379/3
      PLAYWRIGHT_MICROSERVICE_URL: http://firecrawl-playwright:3000/scrape
      POSTGRES_HOST: firecrawl-postgres
      POSTGRES_PORT: "5432"
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${FIRECRAWL_DB_PASSWORD}
      POSTGRES_DB: postgres
      USE_DB_AUTHENTICATION: "false"
      NUQ_RABBITMQ_URL: amqp://rabbitmq:5672
      BULL_AUTH_KEY: ${FIRECRAWL_BULL_AUTH_KEY}
      OPENAI_API_KEY: ${FIRECRAWL_VIRTUAL_KEY}
      OPENAI_BASE_URL: http://litellm:4000/v1
      MODEL_NAME: ${FIRECRAWL_MODEL}
      # B2: upstream supplies these via `<<: *common-env` with
      # `${VAR:-<default>}` — that default substitution happens in the
      # UPSTREAM compose, NOT here, so an omitted key is simply UNSET in our
      # container (no default). NUM_WORKERS_PER_QUEUE drives harness worker
      # spawning — unset ⇒ risk of a zero-worker API (jobs enqueue, never
      # process; Task 6 scrape hangs). Set explicitly to upstream's defaults.
      # (Implementer: skim `services/firecrawl/_source/apps/api/src/config.ts`
      # for any other common-env key that is required-with-no-in-app-default
      # and add it here too.)
      NUM_WORKERS_PER_QUEUE: "8"
      CRAWL_CONCURRENT_REQUESTS: "10"
      MAX_CONCURRENT_JOBS: "5"
      BROWSER_POOL_SIZE: "5"
    depends_on:
      firecrawl-postgres: { condition: service_healthy }
      firecrawl-playwright: { condition: service_started }
      rabbitmq: { condition: service_healthy }
      redis: { condition: service_healthy }
      litellm: { condition: service_healthy }
    healthcheck:
      # S1: spec acceptance requires firecrawl-api "healthy". No HTTP health
      # path is guaranteed across firecrawl builds, so use a TCP probe on the
      # API port; harness boot can take a while (HARNESS_STARTUP_TIMEOUT_MS).
      test: ["CMD-SHELL", "node -e 'require(\"net\").connect(3002,\"127.0.0.1\").on(\"connect\",()=>process.exit(0)).on(\"error\",()=>process.exit(1))'"]
      interval: 10s
      timeout: 6s
      retries: 30
      start_period: 90s
    cpus: ${FIRECRAWL_API_CPU:-2}
    mem_limit: ${FIRECRAWL_API_MEM:-4g}
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  firecrawl-pg-data:
```

- [ ] **Step 2: Add firecrawl to the root compose `include:`**

In `docker-compose.yaml` append to the `include:` list (after `services/cliproxyapi/compose.yaml`):
```yaml
  - services/firecrawl/compose.yaml
```

- [ ] **Step 3: Verify the merged compose config resolves (no live stack)**

Run:
```bash
T=/tmp/fcr-cfg && rm -rf $T && mkdir -p $T/.stack && cp .stack/.env $T/.stack/.env
printf 'FIRECRAWL_DB_PASSWORD=x\nFIRECRAWL_BULL_AUTH_KEY=y\nFIRECRAWL_VIRTUAL_KEY=z\n' >> $T/.stack/.env
sed -i '' 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=litellm,firecrawl/' $T/.stack/.env
COMPOSE_PROFILES=litellm,firecrawl docker compose -p fcrcfg -f docker-compose.yaml \
  --env-file $T/.stack/.env config >/dev/null && echo "compose config OK"
COMPOSE_PROFILES=litellm,firecrawl docker compose -p fcrcfg -f docker-compose.yaml \
  --env-file $T/.stack/.env config | grep -E 'firecrawl-(api|playwright|postgres)|image: ghcr.io/firecrawl|rabbitmq' | head
rm -rf $T
```
Expected: `compose config OK`; the 3 `firecrawl-*` services + 3 `ghcr.io/firecrawl/...@sha256` images present; no interpolation errors.

- [ ] **Step 4: Commit**

```bash
git add services/firecrawl/compose.yaml docker-compose.yaml
```

---

## Task 5: README + gotcha

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the service + gotcha**

In `README.md`: (a) add `firecrawl` to the services directory-tree comment and the profiles description ("OPTIONAL web-scraper (nuq); opt-in; needs the always-on `rabbitmq` backend; extract via LiteLLM"); (b) add a gotcha entry:
```
14. **Firecrawl uses a DEDICATED `firecrawl-postgres`, never the shared `pg`.**
   `nuq-postgres` is a purpose-built appliance: `pg_cron`
   `shared_preload_libraries` + cluster-wide `ALTER SYSTEM` + ~40 cron jobs
   that ARE the queue engine (reapers/GC/REINDEX). It self-initializes its
   own single-tenant `firecrawl-pg-data` volume (no provisioner). `rabbitmq`
   is a stateless nuq notify/prefetch transport → shared always-on backend.
   Losing `firecrawl-pg-data` loses only in-flight jobs (ephemeral queue).
```
(N1: there are **13** existing gotchas in README.md — this is **#14**. Verify with `grep -nE '^[0-9]+\. ' README.md | tail -1` before writing.)

- [ ] **Step 2: Verify + commit**

Run: `grep -n 'firecrawl' README.md | head`
Expected: directory-tree + profiles + gotcha references present.
```bash
git add README.md
```

---

## Task 6: Isolated end-to-end validation (never the live `aitools` stack)

**Files:** none (validation only). Uses an isolated throwaway compose project (the proven sub-project-1 venue).

- [ ] **Step 1: Build the isolated harness with the firecrawl profile**

```bash
MAIN=/Users/joe/Development/ai-tools/openclaw/hermes-stack
rm -rf /tmp/fcrval && rsync -a --exclude .git --exclude .stack --exclude '.claude' "$MAIN/." /tmp/fcrval/
for s in litellm honcho cliproxyapi; do [ -d "$MAIN/services/$s/_source" ] && cp -R "$MAIN/services/$s/_source" "/tmp/fcrval/services/$s/_source"; done
for s in litellm honcho cliproxyapi; do for e in yaml toml; do f="$MAIN/services/$s/config.runtime.$e"; [ -f "$f" ] && cp "$f" "/tmp/fcrval/services/$s/"; done; done
[ -d "$MAIN/services/litellm/chatgpt" ] && cp -R "$MAIN/services/litellm/chatgpt/." "/tmp/fcrval/services/litellm/chatgpt/"
mkdir -p /tmp/fcrval/.stack && cp "$MAIN/.stack/.env" /tmp/fcrval/.stack/.env
sed -i '' 's/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=fcrval/' /tmp/fcrval/.stack/.env
sed -i '' 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=litellm,firecrawl/' /tmp/fcrval/.stack/.env
sed -i '' 's/^STACK_MACHINES=.*/STACK_MACHINES=-/' /tmp/fcrval/.stack/.env
grep -q '^LITELLM_VIRTKEYS=' /tmp/fcrval/.stack/.env && sed -i '' 's/^LITELLM_VIRTKEYS=.*/LITELLM_VIRTKEYS=firecrawl/' /tmp/fcrval/.stack/.env
cp "$MAIN"/.stack/*.generated.env /tmp/fcrval/.stack/ 2>/dev/null || true
rm -f /tmp/fcrval/.stack/firecrawl.generated.env   # force fresh firecrawl secrets
cd /tmp/fcrval && just build && just start 2>&1 | tail -8
```
Expected: `just build` runs `services/firecrawl/build.sh` → `.stack/firecrawl.generated.env` has `FIRECRAWL_DB_PASSWORD`+`FIRECRAWL_BULL_AUTH_KEY`; `just start` → backends incl. `rabbitmq` → `== preflight: litellm ==` mints `FIRECRAWL_VIRTUAL_KEY` → `dc up -d` brings up `firecrawl-postgres` (self-init nuq schema+pg_cron), `firecrawl-playwright`, `firecrawl-api`.

- [ ] **Step 2: Assert services + nuq schema + pg_cron**

```bash
docker ps -a --filter label=com.docker.compose.project=fcrval --format '{{.Names}}\t{{.Status}}' | sort
docker exec fcrval-firecrawl-postgres-1 psql -U postgres -tAc \
  "select count(*) from information_schema.schemata where schema_name='nuq';"
docker exec fcrval-firecrawl-postgres-1 psql -U postgres -tAc \
  "select count(*) from cron.job;"
grep -c _VIRTUAL_KEY /tmp/fcrval/.stack/litellm.generated.env
```
Expected: `firecrawl-postgres` healthy; `firecrawl-playwright` up; `firecrawl-api` up (give it `HARNESS_STARTUP_TIMEOUT_MS`); `nuq` schema count = `1`; `cron.job` count ≥ 1 (pg_cron jobs loaded); ≥1 `_VIRTUAL_KEY` minted.

- [ ] **Step 3: e2e scrape + LiteLLM-routed extract**

```bash
API=fcrval-firecrawl-api-1
docker exec $API sh -c 'curl -fsS -X POST http://localhost:3002/v1/scrape -H "Content-Type: application/json" -d "{\"url\":\"https://example.com\"}"' | head -c 300; echo
docker exec $API sh -c 'curl -fsS -X POST http://localhost:3002/v1/extract -H "Content-Type: application/json" -d "{\"urls\":[\"https://example.com\"],\"prompt\":\"the page title\"}"' | head -c 300; echo
docker logs fcrval-litellm-1 2>&1 | tail -3
```
Expected: scrape returns JSON with markdown/content for example.com; extract returns/queues (200) and LiteLLM logs show a request on the firecrawl key (confirms the `OPENAI_BASE_URL=http://litellm:4000/v1` + `FIRECRAWL_VIRTUAL_KEY` path). If `/v1/extract` shape differs in this firecrawl build, treat a 200 + a LiteLLM hit as pass; record the exact endpoint.

- [ ] **Step 4: Teardown + report**

```bash
docker compose -p fcrval down -v --remove-orphans
docker volume rm fcrval_pg-data fcrval_rabbitmq-data fcrval_redis-data fcrval_firecrawl-pg-data 2>/dev/null || true
rm -rf /tmp/fcrval
docker ps --filter label=com.docker.compose.project=aitools --format '{{.Names}} {{.Status}}' | wc -l | tr -d ' '
```
Expected: `fcrval` + volumes gone; `aitools` count unchanged (live stack untouched throughout). Then report: firecrawl validated in isolation, ready for merge review of `feat/firecrawl`.

---

## Self-Review (completed by plan author)

**Spec coverage:** rabbitmq shared backend (T1) · digest-pin .image-digest (T3) · 3 profiled services + dedicated self-init firecrawl-postgres + resource levers + redis/3 + extract-via-LiteLLM + no host ports/expose + no custom net (T4) · build.sh decentralized FIRECRAWL_DB_PASSWORD+BULL key + env levers + LITELLM_VIRTKEYS+=firecrawl + FIRECRAWL_MODEL (T2) · justfile backends line (T1) · README+gotcha (T5) · isolated validation incl. nuq schema + pg_cron + e2e extract-via-LiteLLM, never live (T6). Supabase omitted (not in any env block — correct, spec non-goal). All spec sections mapped.

**Placeholder scan:** `RMQ_TAG`/`<digest-N>`/`<YYYY-MM-DD>` are *resolve-then-substitute* steps with the exact resolving command given (T1S1, T3S1) — house-style, not TBDs. No bare TODO/“handle errors”.

**Type/name consistency:** `firecrawl-api`/`firecrawl-playwright`/`firecrawl-postgres`, `FIRECRAWL_DB_PASSWORD`/`FIRECRAWL_BULL_AUTH_KEY`/`FIRECRAWL_VIRTUAL_KEY`/`FIRECRAWL_MODEL`, `FIRECRAWL_{API,PLAYWRIGHT}_{MEM,CPU}`, `firecrawl-pg-data`, `redis://redis:6379/3`, `amqp://rabbitmq:5672`, `http://litellm:4000/v1` used consistently across tasks and match the spec.
