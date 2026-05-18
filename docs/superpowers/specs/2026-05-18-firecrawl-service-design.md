# Firecrawl service (sub-project 2) — design

**Date:** 2026-05-18
**Status:** Draft — for review (brainstorm decisions locked early-session; this
consolidates them + integrates the now-landed lifecycle refactor)
**Branch:** `feat/firecrawl` (plain feature branch off `main` @ `d2c46fe`,
which includes sub-project 1)

## Goal

Add self-hosted [Firecrawl](https://github.com/firecrawl/firecrawl) (current
**nuq** architecture: Postgres-backed queue + RabbitMQ transport) as an
**opt-in** `[firecrawl]` profile, integrated with the landed stack lifecycle
(generic `just start`, decentralized passwords, LiteLLM-minted virtual keys).
Source already vendored at `services/firecrawl/_source` (gitignored).

## Locked decisions (from the early-session brainstorm + requirements review)

| # | Decision |
|---|---|
| 1 | **RabbitMQ = shared always-on backend** — new `services/rabbitmq/`, no profile, in root compose, brought up by the backends-first step alongside `pg`/`redis`. `rabbitmq:4.x-management` **tag-pinned** (backends use tag pins like `redis:8.6.3`, not digests — per the lifecycle "surgical/backends" convention). v3→v4 is safe: nuq uses amqplib AMQP 0-9-1 with quorum + non-mirrored classic queues (4.x-recommended). |
| 2 | **Firecrawl = `profiles: [firecrawl]`** (opt-in; heavy). |
| 3 | **AI extract via LiteLLM** — `OPENAI_BASE_URL=http://litellm:4000/v1`, `OPENAI_API_KEY=${FIRECRAWL_VIRTUAL_KEY}`, `MODEL_NAME=${FIRECRAWL_MODEL}` (hindsight pattern; `firecrawl` added to `LITELLM_VIRTKEYS`). |
| 4 | **Images digest-pinned** — `ghcr.io/firecrawl/{firecrawl,playwright-service,nuq-postgres}` each `@sha256` (upstream ships only rolling `:latest`; digest is the sole stable pin — gotcha #6), mirrored in `services/firecrawl/.image-digest`. |
| 5 | **Resource levers, lighter defaults** — `FIRECRAWL_API_MEM`/`_CPU` (def `4g`/`2`), `FIRECRAWL_PLAYWRIGHT_MEM`/`_CPU` (def `2g`/`2`). |
| 6 | **Reuse shared `redis`** at `redis://redis:6379/3` (logical db 3 isolates the keyspace from honcho/litellm db0). **Supabase NOT used** (self-host can't configure it; `USE_DB_AUTHENTICATION=false`). |
| 7 | **Dedicated `firecrawl-postgres`** (NOT the shared `pg`) — see Architecture. |

## Non-goals

- Fire-engine / cloud-only features (self-host limitation, upstream-documented).
- SearXNG `/search` (defaults to direct Google; optional, not wired).
- Wiring Firecrawl into Hermes/Telegram (later).
- Changing the shared `pg` or any sub-project-1 service (purely additive).

## Architecture — why a dedicated `firecrawl-postgres`

`ghcr.io/firecrawl/nuq-postgres` is **not stock Postgres**: `postgres:17` +
`pg_cron` with `shared_preload_libraries='pg_cron'` (server-preload, set
before first start), `cron.database_name='postgres'`, and `nuq.sql` baked
into `/docker-entrypoint-initdb.d` running cluster-wide `ALTER SYSTEM`
tuning (`max_wal_size=16GB`, aggressive bgwriter/checkpoint) + ~40 `pg_cron`
jobs (sub-minute reapers, nightly `REINDEX CONCURRENTLY`) over an
18M-row-class queue table.

Per the landed **"surgical bucket"** principle (lifecycle spec): pg_cron
preload + cluster-wide `ALTER SYSTEM` must never land on the **shared** `pg`
(would force a rebuilt+restarted shared image and impose firecrawl's
queue-tuned WAL/vacuum/REINDEX churn on honcho/litellm/hindsight). The clean
resolution — and why this is *not* a shared-pg surgical change at all —
Firecrawl brings its **own dedicated, single-tenant** `firecrawl-postgres`
(the digest-pinned upstream `nuq-postgres` image, own
`firecrawl-pg-data` volume). It **self-initializes** via its image's own
initdb (`nuq.sql` + pg_cron preload) on its own fresh volume — so it needs
**no `*-provision` one-shot** (the lifecycle provisioner pattern exists to
de-cross-contaminate the *shared* `pg`; a dedicated self-initializing DB is
exactly the case it doesn't apply to).

### Services (all `profiles: [firecrawl]` except rabbitmq)

| Container | Image | Notes |
|---|---|---|
| `firecrawl-api` | `ghcr.io/firecrawl/firecrawl@sha256:…` | API + nuq workers (`harness.js --start-docker`). `mem_limit/cpus` = levers. No host port — orb DNS `firecrawl-api.<project>.orb.local:3002`; queue admin `/admin/<bull-key>/queues`. |
| `firecrawl-playwright` | `ghcr.io/firecrawl/playwright-service@sha256:…` | Headless browser. `mem_limit/cpus` = levers. `firecrawl-api` → `PLAYWRIGHT_MICROSERVICE_URL=http://firecrawl-playwright:3000/scrape`. |
| `firecrawl-postgres` | `ghcr.io/firecrawl/nuq-postgres@sha256:…` | Dedicated; `firecrawl-pg-data` volume; self-init nuq.sql+pg_cron; healthcheck `pg_isready`. No host port. |
| `rabbitmq` | `rabbitmq:4.x-management` (tag-pinned) | **New `services/rabbitmq/`**, shared always-on backend (no profile), `rabbitmq-data` volume, `rabbitmq-diagnostics check_running` healthcheck. |
| *(reuse)* `redis` | existing `redis:8.6.3` | nuq rate-limit/cache only, db `/3`. |

`firecrawl-api` env (key lines): `REDIS_URL`/`REDIS_RATE_LIMIT_URL=redis://redis:6379/3` · `PLAYWRIGHT_MICROSERVICE_URL=http://firecrawl-playwright:3000/scrape` · `POSTGRES_HOST=firecrawl-postgres` `POSTGRES_USER=postgres` `POSTGRES_PASSWORD=${FIRECRAWL_DB_PASSWORD}` `POSTGRES_DB=postgres` · `USE_DB_AUTHENTICATION=false` · `NUQ_RABBITMQ_URL=amqp://rabbitmq:5672` · `BULL_AUTH_KEY=${FIRECRAWL_BULL_AUTH_KEY}` · extract: `OPENAI_API_KEY=${FIRECRAWL_VIRTUAL_KEY}` `OPENAI_BASE_URL=http://litellm:4000/v1` `MODEL_NAME=${FIRECRAWL_MODEL}`.
`depends_on`: `firecrawl-postgres` (service_healthy), `rabbitmq` (service_healthy), `redis` (service_healthy), `firecrawl-playwright` (service_started), `litellm` (service_healthy → the `firecrawl` profile auto-pulls litellm, hindsight pattern).

## Lifecycle integration (sub-project 1 — minimal, mostly automatic)

- **No new `just start` logic.** The generic pipeline already does
  backends-first → profile-iterated preflight → prestart → `dc up -d` →
  poststart. Adding `rabbitmq` to the always-on backend bring-up line
  (`dc up -d pg redis rabbitmq`) + `services/rabbitmq/compose.yaml` to the
  root `include:` is the only justfile-area touch (a backend, not a profile).
- **Virtual key:** `firecrawl` added to `LITELLM_VIRTKEYS`. The landed
  `litellm/preflight.sh` already mints one key per alias →
  `.stack/litellm.generated.env` → `${FIRECRAWL_VIRTUAL_KEY}`. `firecrawl-api`
  `depends_on litellm: service_healthy` so `COMPOSE_PROFILES=…,firecrawl`
  auto-pulls litellm and the credential step mints the key before the main
  `dc up -d` starts `firecrawl-api`. **No firecrawl-specific preflight.**
- **No provisioner / no prestart:** `firecrawl-postgres` self-initializes
  (dedicated image); firecrawl is all-env (no rendered config file to
  validate). `services/firecrawl/build.sh` follows the decentralized-secret
  convention: read-or-gen `FIRECRAWL_DB_PASSWORD` **and**
  `FIRECRAWL_BULL_AUTH_KEY` into `.stack/firecrawl.generated.env`
  (read-existing-first so they keep matching the `firecrawl-pg-data` volume —
  the mandatory-read rule from sub-project 1).
- **No poststart.**

## Files

**New:** `services/firecrawl/compose.yaml`, `services/firecrawl/build.sh`,
`services/firecrawl/.image-digest`; `services/rabbitmq/compose.yaml`.
**Modify:** root `docker-compose.yaml` (`include:` += rabbitmq, firecrawl);
`justfile` (backends line += `rabbitmq`); `.stack.env.example` (firecrawl
profile doc, `FIRECRAWL_MODEL=${STACK_LLM_MODEL}`, resource levers,
`LITELLM_VIRTKEYS` += `firecrawl`); `.gitignore` already covers
`**/_source/`; `README.md` (+ service, + gotcha).

## Delivery (staged, each independently verifiable)

1. `services/rabbitmq/compose.yaml` + root include + justfile backends line; verify `rabbitmq` healthy alongside pg/redis (no profile).
2. `services/firecrawl/build.sh` (gen `FIRECRAWL_DB_PASSWORD` + `FIRECRAWL_BULL_AUTH_KEY`, read-or-gen). `.stack.env.example` levers + `LITELLM_VIRTKEYS+=firecrawl`.
3. `services/firecrawl/compose.yaml` (3 services, `profiles:[firecrawl]`, digest-pinned, resource levers, depends_on, env) + `.image-digest` (resolve the 3 digests) + root include.
4. README + gotcha (dedicated nuq-postgres / pg_cron isolated in its own image; rabbitmq always-on; firecrawl opt-in).
5. Validate in an **isolated** compose project (the sub-project-1 venue): `COMPOSE_PROFILES=litellm,firecrawl`, `just build && just start` → litellm preflight mints `FIRECRAWL_VIRTUAL_KEY`; `firecrawl-postgres` self-inits (nuq schema + pg_cron); `firecrawl-api`+`firecrawl-playwright` healthy; smoke `POST /v1/scrape {"url":"https://example.com"}` and a JSON `/v1/extract` (exercises the LiteLLM path). Never the live `aitools` stack.

## Risks / validation points

- Exact LiteLLM base-URL suffix (`/v1` vs bare) for Firecrawl's OpenAI client; whether `MODEL_EMBEDDING_NAME` is exercised by self-host extract — resolved at step 5.
- `firecrawl-api` healthcheck endpoint (root `/` vs `/v1/health`) — resolve at step 5; TCP-on-3002 fallback.
- Resolve the 3 `@sha256` digests + current `rabbitmq:4.x-management` patch tag at step 1/3.
- Heavy footprint when the profile is on (~4G API + 2G playwright + dedicated pg + rabbitmq) — mitigated by the resource levers + opt-in profile.

## Acceptance

- `COMPOSE_PROFILES` incl. `firecrawl` + `just build && just start` (isolated project) → `firecrawl-api`/`firecrawl-playwright`/`firecrawl-postgres` healthy; `rabbitmq` healthy; `FIRECRAWL_VIRTUAL_KEY` minted; a scrape and a LiteLLM-routed `/v1/extract` succeed.
- `firecrawl` absent from `COMPOSE_PROFILES` → stack unaffected; `rabbitmq` still up (always-on) but idle.
- Adding firecrawl touched only `services/firecrawl/`, `services/rabbitmq/`, root `include:`, the justfile backends line, `.stack.env.example`, README — zero changes to shared `pg` or any sub-project-1 service.
- No regression to the lifecycle refactor or existing services.
