# 01 — aitools-backends (Postgres + Redis) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> superpowers:subagent-driven-development or superpowers:executing-plans.
> Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stand up the shared AI-tools data layer — `pgvector/pgvector:pg17`
+ `redis:8.2` — as the `aitools-backends` compose on an external
`aitools-net`, with `honcho` and `litellm` databases/roles and the `vector`
extension, independently reusable by any AI tool.

**Architecture:** Two containers (`aitools-pg`, `aitools-redis`), explicit
`container_name:` for stable `.orb.local` DNS, joined to a pre-created
external Docker network `aitools-net`. No host port publishing — consumers
on `aitools-net` reach them by alias (`aitools-pg:5432`,
`aitools-redis:6379`); the isolated orb VM can also reach them via
`<name>.orb.local` (OrbStack exposes all containers — verified Phase 0).
DB/role isolation is logical (separate DBs+roles), not network.

**Tech Stack:** OrbStack docker engine (active), Docker Compose v2,
`pgvector/pgvector:pg17`, `redis:8.2`.

---

### Task 1: Repo scaffold + external network

**Files:**
- Create: `aitools-backends/` (dir)

- [ ] **Step 1: Create the external network (idempotent)**

Run: `docker network create aitools-net 2>/dev/null || echo "exists"`
Expected: a network ID, or `exists`.

- [ ] **Step 2: Verify it exists**

Run: `docker network inspect aitools-net -f '{{.Name}}'`
Expected: `aitools-net`

- [ ] **Step 3: Create the component directory**

Run: `mkdir -p aitools-backends/pg-init`
Expected: no output, exit 0.

---

### Task 2: Backend env file

**Files:**
- Create: `aitools-backends/.env.example`
- Create: `aitools-backends/.env` (gitignored)

- [ ] **Step 1: Write `aitools-backends/.env.example`**

```env
# Postgres superuser (admin only; apps use the per-app roles below)
POSTGRES_SUPERPASS=change-me-super
# Per-consumer DB role passwords
HONCHO_DB_PASSWORD=change-me-honcho
LITELLM_DB_PASSWORD=change-me-litellm
```

- [ ] **Step 2: Create the real `.env` from it with strong values**

Run:
```bash
cd aitools-backends && \
sed -e "s/change-me-super/$(openssl rand -hex 16)/" \
    -e "s/change-me-honcho/$(openssl rand -hex 16)/" \
    -e "s/change-me-litellm/$(openssl rand -hex 16)/" \
    .env.example > .env && echo written
```
Expected: `written`

- [ ] **Step 3: Gitignore the real .env**

Append to `hermes-stack/.gitignore` (create if absent):
```
**/.env
```

- [ ] **Step 4: Commit**

```bash
git add aitools-backends/.env.example .gitignore docs/plans/01-aitools-backends.md
git commit -m "feat(aitools-backends): env scaffold + network"
```

---

### Task 3: Postgres init SQL

**Files:**
- Create: `aitools-backends/pg-init/00-init.sql`

- [ ] **Step 1: Write the init script**

```sql
-- Runs once on first cluster init (empty data dir), as POSTGRES superuser.
-- Passwords are injected at runtime by entrypoint envsubst (see compose).
CREATE ROLE honcho LOGIN PASSWORD ':HONCHO_PW';
CREATE DATABASE honcho OWNER honcho;
CREATE ROLE litellm LOGIN PASSWORD ':LITELLM_PW';
CREATE DATABASE litellm OWNER litellm;
\connect honcho
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO honcho;
```

> Note: `:HONCHO_PW` / `:LITELLM_PW` are placeholders substituted by a tiny
> entrypoint wrapper (Task 4) so secrets stay in `.env`, not in git.

- [ ] **Step 2: Commit**

```bash
git add aitools-backends/pg-init/00-init.sql
git commit -m "feat(aitools-backends): pg init (honcho/litellm dbs + pgvector)"
```

---

### Task 4: Compose file

**Files:**
- Create: `aitools-backends/compose.yaml`

- [ ] **Step 1: Write `aitools-backends/compose.yaml`**

```yaml
name: aitools-backends

services:
  aitools-pg:
    image: pgvector/pgvector:pg17
    container_name: aitools-pg
    restart: unless-stopped
    command: ["postgres", "-c", "max_connections=200"]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_SUPERPASS}
      POSTGRES_DB: postgres
      PGDATA: /var/lib/postgresql/data/pgdata
      HONCHO_PW: ${HONCHO_DB_PASSWORD}
      LITELLM_PW: ${LITELLM_DB_PASSWORD}
    # Substitute the :HONCHO_PW / :LITELLM_PW placeholders into a runtime
    # copy of the init script before the stock entrypoint runs it.
    entrypoint:
      - bash
      - -c
      - |
        mkdir -p /tmp/init && \
        sed -e "s/:HONCHO_PW/${HONCHO_PW}/" -e "s/:LITELLM_PW/${LITELLM_PW}/" \
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

  aitools-redis:
    image: redis:8.2
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
  aitools-pg-data:
  aitools-redis-data:

networks:
  aitools-net:
    external: true
```

- [ ] **Step 2: Validate the compose merges**

Run: `cd aitools-backends && docker compose --env-file .env config -q && echo OK`
Expected: `OK` (no schema errors)

- [ ] **Step 3: Commit**

```bash
git add aitools-backends/compose.yaml
git commit -m "feat(aitools-backends): pg17 + redis compose on aitools-net"
```

---

### Task 5: Bring up + health

- [ ] **Step 1: Start**

Run: `cd aitools-backends && docker compose --env-file .env up -d`
Expected: `aitools-pg` and `aitools-redis` created & started.

- [ ] **Step 2: Wait for healthy**

Run:
```bash
for i in $(seq 1 20); do \
  s=$(docker inspect -f '{{.State.Health.Status}}' aitools-pg 2>/dev/null); \
  r=$(docker inspect -f '{{.State.Health.Status}}' aitools-redis 2>/dev/null); \
  [ "$s" = healthy ] && [ "$r" = healthy ] && echo "both healthy" && break; \
  sleep 3; done
```
Expected: `both healthy`

---

### Task 6: Verify DBs, roles, pgvector, redis (from aitools-net)

- [ ] **Step 1: Postgres — roles, dbs, vector extension**

Run:
```bash
docker run --rm --network aitools-net -e PGPASSWORD="$(grep ^HONCHO_DB_PASSWORD aitools-backends/.env|cut -d= -f2)" \
  postgres:17 psql -h aitools-pg -U honcho -d honcho \
  -tAc "SELECT current_database(), extversion FROM pg_extension WHERE extname='vector';"
```
Expected: `honcho|0.8.0` (or installed pgvector version)

- [ ] **Step 2: litellm DB reachable as its role**

Run:
```bash
docker run --rm --network aitools-net -e PGPASSWORD="$(grep ^LITELLM_DB_PASSWORD aitools-backends/.env|cut -d= -f2)" \
  postgres:17 psql -h aitools-pg -U litellm -d litellm -tAc "SELECT 'litellm-ok';"
```
Expected: `litellm-ok`

- [ ] **Step 3: pgvector type works**

Run:
```bash
docker run --rm --network aitools-net -e PGPASSWORD="$(grep ^HONCHO_DB_PASSWORD aitools-backends/.env|cut -d= -f2)" \
  postgres:17 psql -h aitools-pg -U honcho -d honcho -tAc "SELECT '[1,2,3]'::vector;"
```
Expected: `[1,2,3]`

- [ ] **Step 4: Redis**

Run: `docker run --rm --network aitools-net redis:8.2 redis-cli -h aitools-redis ping`
Expected: `PONG`

---

### Task 7: Verify orb-VM reachability + final commit

- [ ] **Step 1: From the isolated orb VM, confirm `.orb.local` resolves/reaches pg**

Run:
```bash
orb -m hermes-agent bash -lc 'getent hosts aitools-pg.orb.local && \
  (command -v pg_isready >/dev/null && pg_isready -h aitools-pg.orb.local -p 5432 || \
   curl -sS -m4 -o /dev/null -w "tcp-check %{http_code}\n" telnet://aitools-pg.orb.local:5432 || echo "name resolves; port reachable check best-effort")'
```
Expected: `aitools-pg.orb.local` resolves to an IP (reachability from VM is a debugging convenience; canonical app path is the `aitools-net` alias `aitools-pg:5432`).

- [ ] **Step 2: Mark plan complete + commit**

```bash
git add docs/plans/01-aitools-backends.md
git commit -m "feat(aitools-backends): verified pg17+redis backends up"
```

---

## Acceptance criteria (all must pass)

- `aitools-pg` + `aitools-redis` both `healthy`.
- `honcho` and `litellm` databases exist, owned by their dedicated roles;
  those roles can log in to their own DB.
- `vector` extension present in `honcho` DB; `::vector` cast works.
- `redis-cli ping` → `PONG` from a container on `aitools-net`.
- `aitools-pg.orb.local` resolves from the isolated orb VM.
- `aitools-net` is external and shared (Plan 02/03 attach to it).

## Notes for later plans

- Honcho/LiteLLM connect **container-to-container** via `aitools-pg:5432`
  (network alias), NOT `.orb.local` (that's a debug path).
- Honcho `DB_CONNECTION_URI` →
  `postgresql+psycopg://honcho:<HONCHO_DB_PASSWORD>@aitools-pg:5432/honcho`
- LiteLLM `DATABASE_URL` →
  `postgresql://litellm:<LITELLM_DB_PASSWORD>@aitools-pg:5432/litellm`
- Redis: `redis://aitools-redis:6379` (Honcho `CACHE_URL`, LiteLLM cache).
