# Hindsight as optional agent memory — design

**Date:** 2026-05-17
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `feat/hindsight-agent-memory`

## Goal

Add [Hindsight](https://github.com/vectorize-io/hindsight) (`vectorize-io/hindsight`)
to hermes-stack as an **optional** agent-memory service that reuses the
stack's existing Postgres. Model traffic (LLM + embeddings) routes through
LiteLLM via a minted virtual key, exactly like Honcho.

Reference compose (external Postgres flavour):
`https://github.com/vectorize-io/hindsight/blob/main/docker/docker-compose/external-pg/docker-compose.yaml`

## Non-goals

- Wiring Hindsight into the Hermes agent / Telegram gateway (later).
- Data migration / volume reattach. The stack's model is recreate-from-
  scratch; this is unchanged.
- Changing Honcho, LiteLLM, or the uncommitted `agentmemory` service. All
  edits are additive.

## Architecture

Mirrors the Honcho precedent (`services/honcho/`): pg-backed,
profile-scoped, project-scoped (no `container_name`, no shared network).

- New `services/hindsight/compose.yaml`, profile `[hindsight]`.
- Prebuilt image `ghcr.io/vectorize-io/hindsight` **pinned by digest**
  (gotcha #6), with the digest mirrored in `services/hindsight/.image-digest`
  exactly like `services/litellm/.image-digest`. The exact pinned digest is
  resolved during implementation.
- Reaches `pg` and `litellm` by sibling service name on the Compose default
  per-project network.
- `depends_on: { pg: service_healthy, litellm: service_healthy }` so
  `COMPOSE_PROFILES=hindsight` auto-pulls both (Honcho pattern).
- API on `:8888`, Web UI on `:9999`. `expose`d only — **not** host-
  published. Reachable on the project net as `hindsight:8888` and from the
  Hermes VM at `hindsight.<project>.orb.local:8888` / `:9999`.
- Healthcheck against the API port (`:8888`) using the in-image Python or
  `curl`, following the Honcho/agentmemory healthcheck style. Exact health
  path confirmed during implementation (Hindsight exposes an API health
  endpoint; CP UI excludes `/api/health` from auth).

No `build.sh` for Hindsight: it is a prebuilt image with no source to fetch
and no config template to render (unlike Honcho). The digest pin lives
inline in `compose.yaml` + mirrored `.image-digest`, matching LiteLLM.

## Postgres changes (mirror the Honcho role/db recipe)

`services/postgres/pg-init/00-init.sql` — add, following the existing
honcho/litellm pattern:

```sql
CREATE ROLE hindsight LOGIN PASSWORD ':HINDSIGHT_PW';
CREATE DATABASE hindsight OWNER hindsight;
```

and a connect block (Hindsight defaults to the `pgvector` vector extension;
the `pgvector/pgvector:pg18` image supplies it; pre-creating it as the
superuser sidesteps the non-superuser `CREATE EXTENSION` privilege issue):

```sql
\connect hindsight
CREATE EXTENSION IF NOT EXISTS vector;
GRANT ALL ON SCHEMA public TO hindsight;
```

`services/postgres/compose.yaml`:

- Add `HINDSIGHT_PW: ${HINDSIGHT_DB_PASSWORD}` to the `pg` service `environment`.
- Add `-e "s/:HINDSIGHT_PW/$${HINDSIGHT_PW}/"` to the seed-substitution
  `sed` in the entrypoint wrapper (alongside the existing HONCHO_PW /
  LITELLM_PW substitutions).

`services/postgres/build.sh`:

- Ensure `HINDSIGHT_DB_PASSWORD` is present in `.stack/db.generated.env`
  **idempotently and on the reuse path too** (the current `if`/`else` only
  generates on first creation; a stack that already has a `db.generated.env`
  must still gain a Hindsight password). Use an `env_get`-guarded
  `env_upsert` so existing honcho/litellm passwords keep matching the pg
  volume while a missing `HINDSIGHT_DB_PASSWORD` gets generated once.
- **Operational note (documented, expected):** the new `hindsight` role/db
  is only seeded when `00-init.sql` runs, i.e. on a fresh `<project>_pg-data`
  volume. Adding Hindsight to an already-initialised stack requires
  recreating that volume — consistent with the stack's documented
  recreate-from-scratch model (README "Multiple stacks" / gotcha #4).

## LLM + embeddings via LiteLLM

Hindsight ships a native `litellm` provider for both LLM and embeddings.
`services/hindsight/compose.yaml` `environment`:

```
HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:${HINDSIGHT_DB_PASSWORD}@pg:5432/hindsight
HINDSIGHT_API_LLM_PROVIDER=litellm
HINDSIGHT_API_LITELLM_API_BASE=http://litellm:4000
HINDSIGHT_API_LLM_API_KEY=${HINDSIGHT_VIRTUAL_KEY}
HINDSIGHT_API_LLM_MODEL=glm-4.7-flash
HINDSIGHT_API_EMBEDDINGS_PROVIDER=litellm
HINDSIGHT_API_EMBEDDINGS_LITELLM_MODEL=voyage-4-lite
```

(`HINDSIGHT_API_LITELLM_API_BASE` is shared by both the LLM and the
embeddings `litellm` providers; the single minted virtual key authorises
both.)

Virtual key minting (same mechanism as Honcho, via
`services/litellm/start.sh`):

- Add to `.stack.env.example` (and operator's `.stack/.env`):
  ```
  LITELLM_VIRTKEY_HINDSIGHT_MODELS=glm-4.7-flash,grok-4.3,glm-5,voyage-4-lite,voyage-4-large,voyage-4
  ```
- `services/litellm/start.sh` already mints `<ALIAS>_VIRTUAL_KEY` for every
  `LITELLM_VIRTKEY_<ALIAS>_MODELS=` line into
  `.stack/litellm.generated.env` → produces `HINDSIGHT_VIRTUAL_KEY`. No
  change to `start.sh` itself.
- **Per gotcha #5: no `chatgpt/*`** in the allowlist. Hindsight's
  retain/reflect are non-streaming/structured (the same constraint that
  keeps Honcho off `chatgpt/*`), so Hindsight stays on glm/grok + voyage.

### Embeddings decision (resolved)

LiteLLM → Voyage (`voyage-4-lite`, 1024-dim) — chosen for stack
consistency (all model traffic observable / key-rotated through LiteLLM,
matching Honcho). Hindsight's local default (`BAAI/bge-small-en-v1.5`,
384-dim) was the considered lower-effort alternative and is **not** used.

## Wiring

- **Root `docker-compose.yaml`**: append `- services/hindsight/compose.yaml`
  to the `include:` list. Additive — the uncommitted `agentmemory` include
  line is left intact.
- **`.stack.env.example`**: add `hindsight` to the "Available" profiles
  comment and add the `LITELLM_VIRTKEY_HINDSIGHT_MODELS=` declaration line.
  Hindsight is **left out of the default `COMPOSE_PROFILES`** value — it is
  opt-in/"optional"; the operator enables it by adding `hindsight` to
  `COMPOSE_PROFILES` in `.stack/.env`. (The virtkey declaration is non-
  secret and harmless when the profile is off — `start.sh` minting an
  unused key has no effect.)
- **`justfile`**: add `hindsight` to the staged-`start` condition that
  brings up `litellm` and runs `services/litellm/start.sh`, so
  `HINDSIGHT_VIRTUAL_KEY` is minted (and `COMPOSE_ENV_FILES` re-sourced)
  before the settling `dc up -d`. Concretely, extend the existing
  `grep -qw litellm || grep -qw honcho` guard with `|| grep -qw hindsight`.
  No `honcho-postup`-style step is added (see risk #1).
- **`README.md`**: add Hindsight to the architecture section, the directory
  tree, the profiles description, and the secrets table
  (`HINDSIGHT_DB_PASSWORD` owned by `services/postgres/build.sh`;
  `HINDSIGHT_VIRTUAL_KEY` owned by `services/litellm/start.sh`).

## Risks / verification (resolved during implementation, not blocking design)

1. **Auto-migration.** The external-pg reference compose does a bare
   `docker compose up -d` with no manual migrate step, implying the
   container runs `alembic upgrade head` on boot (repo has
   `hindsight-api-slim/hindsight_api/alembic/`). Verify on first boot via
   container logs that the schema is created. **If it does not auto-migrate**,
   add a one-shot migration step to staged `start` analogous to
   `lib/honcho-postup.sh` and document it (load-bearing order).
2. **Voyage 1024-dim.** Confirm Hindsight's `litellm` embedding provider
   negotiates the 1024-dim `voyage-4-lite` vectors and creates matching
   pgvector columns. Verify after a `retain` call. Changing the embedding
   model/dimension later → recreate the `hindsight` DB (same constraint
   shape as Honcho gotcha #3).
3. **glm/grok structured output.** Hindsight retain/reflect need
   structured/tool output; Honcho runs fine on glm/grok via LiteLLM, so
   expected OK. Verify a `retain` succeeds end-to-end.

## Acceptance

- `COMPOSE_PROFILES` including `hindsight` + fresh `just build && just start`
  brings the `hindsight` service to healthy.
- Hindsight schema exists in the `hindsight` Postgres DB (auto-migrated, or
  via the added one-shot step per risk #1).
- A `retain` then `recall` round-trips, with the LLM and embedding calls
  visible in LiteLLM SpendLogs (confirms model traffic is going through the
  proxy on the minted `HINDSIGHT_VIRTUAL_KEY`).
- Stack with `hindsight` absent from `COMPOSE_PROFILES` is unaffected.
- No regression to Honcho / LiteLLM / agentmemory.

## As-built (resolved 2026-05-17, verified end-to-end)

The design's env block (`HINDSIGHT_API_LLM_PROVIDER=litellm` + a single
`HINDSIGHT_API_LITELLM_API_BASE`/`HINDSIGHT_API_LLM_API_KEY`) **does not
work** against an auth-enforcing LiteLLM proxy with custom aliases. Two
root causes were found (v0.6.2 source + LiteLLM boundary tests) and fixed
in `services/hindsight/compose.yaml`:

- **LLM:** `provider=litellm` passes the bare alias to the litellm **SDK**,
  which can't resolve a provider for a custom proxy alias →
  `litellm.BadRequestError: LLM Provider NOT provided`. Fix: use Hindsight's
  documented OpenAI-compatible path — `HINDSIGHT_API_LLM_PROVIDER=openai`
  + `HINDSIGHT_API_LLM_BASE_URL=http://litellm:4000` (alias passed through;
  LiteLLM resolves it).
- **Embeddings (fatal):** the `litellm` embeddings provider POSTs to
  `<base>/embeddings` and sends `Authorization` **only if its own key is
  set**. It reads `HINDSIGHT_API_EMBEDDINGS_LITELLM_API_KEY`, falling back
  to the shared `HINDSIGHT_API_LITELLM_API_KEY` — it never reads
  `HINDSIGHT_API_LLM_API_KEY`. Missing → LiteLLM 401 → startup abort. Fix:
  add `HINDSIGHT_API_LITELLM_API_KEY=${HINDSIGHT_VIRTUAL_KEY}` (and keep
  `HINDSIGHT_API_LITELLM_API_BASE` for the embeddings provider).

As-built env: `LLM_PROVIDER=openai`, `LLM_BASE_URL=http://litellm:4000`,
`LLM_API_KEY=${HINDSIGHT_VIRTUAL_KEY}`, `LLM_MODEL=glm-4.7-flash`;
`EMBEDDINGS_PROVIDER=litellm`, `EMBEDDINGS_LITELLM_MODEL=voyage-4-lite`,
`LITELLM_API_BASE=http://litellm:4000`,
`LITELLM_API_KEY=${HINDSIGHT_VIRTUAL_KEY}`.

Risk outcomes:
1. **Auto-migration — RESOLVED, no contingency.** Hindsight runs its own
   schema/migration on startup (`hindsight_api.migrations`: creates tables,
   alters vector dims, builds HNSW). No `lib/hindsight-postup.sh` / staged
   step needed.
2. **Voyage 1024-dim — RESOLVED.** Hindsight detected `dim: 1024` and
   migrated pgvector columns 384→1024 + HNSW indexes automatically.
3. **glm structured output — RESOLVED in practice.** Startup *verification
   probe* logs a benign WARNING (`empty message content,
   finish_reason=length`) because GLM-4.7-flash is a reasoning model and the
   probe uses a tiny token budget; **real** retain/reflect (max_tokens=4096)
   works — `retain`→`recall` round-trips, `usage` ~5k tokens. Model left as
   `glm-4.7-flash` (mirrors Honcho); switch to `grok-4.3` only if the
   cosmetic startup warning is undesirable.

Verified: container `healthy`; `retain`→`recall` round-trip HTTP 200;
LiteLLM SpendLogs under the `hindsight` key show `openrouter/z-ai/
glm-4.7-flash` (LLM) + `voyage/voyage-4-lite` (embeddings) only — gotcha #5
honored. Surgical (non-destructive) verify used: `hindsight` role/db seeded
into the live pg, only the `hindsight` container started (no stack
teardown). The plan's Task 9 volume-recreate remains valid for clean-room
installs.
