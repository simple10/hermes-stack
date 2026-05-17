> **SUPERSEDED by docs/plans/06-unified-stack-architecture.md** — kept for history only.

# hermes-stack — Architecture & Phasing Plan

> Master planning doc. Per-phase bite-sized implementation plans (01–04)
> are written *after* this is approved and after the LiteLLM↔Voyage
> embedding spike runs (Phase 0). Writing them earlier = placeholders.

**Goal:** Move shared AI infra (Postgres, LiteLLM, Honcho) into OrbStack
Docker as independently-managed compose stacks; keep Hermes in the isolated
orb VM; route Hermes + Honcho LLM/embedding traffic through LiteLLM for key
rotation + observability.

**Repo:** this directory (`hermes-stack`) holds all compose files, configs,
docs, and a snapshot of the Hermes configs once complete.

---

## Locked decisions (from discussion)

- **Docker engine: OrbStack.** Already the active engine (`/var/run/docker.sock
  → ~/.orbstack/run/docker.sock`, context `orbstack *`). Docker Desktop is
  dormant; no revert needed. Containers run in OrbStack's engine.
- **Hermes stays native in the isolated `hermes-agent` orb VM.** Not
  containerized.
- **One shared Postgres** (`aitools-pg`), AI-tools-only — *not* a general
  local-PG for every app. One instance, separate DBs/roles per consumer.
- **Hermes + Honcho proxy LLM/embeddings through LiteLLM** for key rotation
  + observability.
- **LiteLLM stores prompts in usage logs** (visible in UI) initially.
  Temporary until an llmetry endpoint is added. Accept the data-sensitivity
  (memory/conversation content in LiteLLM's Postgres + UI) — lock down UI
  auth + that DB.
- **Honcho data: migrate via pg_dump if cheap; else start fresh.** Data is
  minimal but no longer empty (user repopulated). Fallback to fresh is
  acceptable.
- **Redis: included** as shared `aitools-redis` (serves Honcho cache +
  LiteLLM).
- **Grouping: two composes, not one-with-profiles.** `aitools-backends`
  (pg + redis) and `aitools-services` (honcho + litellm), joined by an
  **external** `aitools-net`. Profiles rejected: they'd make backends
  non-independently-reusable (a future AI tool couldn't attach to just the
  backends), which defeats the `aitools-` reuse goal. One-command ergonomics
  come from a thin top-level orchestrator (`justfile`/`Makefile`/`bin/up`)
  that brings composes up in order + starts the orb — not from collapsing
  into one project.
- **Builds:** Honcho from pinned source (no published image — mandatory).
  LiteLLM: **official image + mounted custom-handler module** (recommended)
  for the Voyage dimensions fix — *not* a source build, unless LiteLLM core
  patching is later required. Source-building LiteLLM = fork/upstream-merge
  maintenance for a handler-level change. Pending final user confirmation.

## HARD CONSTRAINT — do not touch `hermes-agent`

The existing `hermes-agent` orb VM is a **frozen backup/reference**. It must
**not be modified** until the new stack is fully operational and tested.
- Allowed: `orb stop hermes-agent` (briefly, for a consistent clone), then
  `orb start hermes-agent` to leave it running as a reference. Stopping/
  starting is not "modifying" (no data change).
- Forbidden: changing configs, services, data, or running anything that
  writes inside `hermes-agent`.
- The new production Hermes lives in a **clone**: `orb stop hermes-agent` →
  `orb clone hermes-agent hermes` → `orb start hermes-agent`. All work
  (strip Honcho/native-PG, rewire) happens in the clone `hermes`.
- The clone's native Postgres carries the repopulated Honcho data → it is
  the **pg_dump migration source** for Phase 3 (original never read/written
  for migration).

## Naming convention

Generic AI tools are prefixed `aitools-` (they're broadly useful, not
Hermes-specific):

| Thing | Name |
|-------|------|
| Compose project / dir | `aitools-backends` (pg+redis), `aitools-services` (honcho+litellm) |
| Shared external network | `aitools-net` (external; created standalone or by backends) |
| Containers / aliases | `aitools-pg`, `aitools-redis`, `aitools-honcho-api`, `aitools-honcho-deriver`, `aitools-litellm` |
| PG databases/roles | `honcho`, `litellm` (per-consumer, least-priv) |
| Top-level orchestrator | `hermes-stack/justfile` (or Makefile / `bin/up`) — ordered up/down + orb start |

## Key technical findings (grounded, not assumed)

1. **No published Honcho image.** Honcho's official compose `build:`s
   `api` + `deriver` from the repo's Dockerfile. `aitools-honcho` must
   build from a **pinned checkout of plastic-labs/honcho** (current cloned
   head: `8fcbb54`). Pin the commit for reproducibility.
2. **Honcho's reference DB is `pgvector/pgvector:pg15`** — but Honcho runs
   fine on PG17 (we've run it natively on 17 all along). Existing data is
   **PG17**. → `aitools-pg` = **`pgvector/pgvector:pg17`** so pg_dump/restore
   is a same-major operation (dumping 17→15 would be an unsupported
   downgrade).
3. **Redis: decided IN.** Shared `aitools-redis` (official `redis:` image)
   in `aitools-backends`, serving Honcho cache (`CACHE_ENABLED=true`,
   `CACHE_URL=redis://aitools-redis:6379`) + LiteLLM. Matches Honcho's
   reference compose.
6. **LiteLLM ships official images** (`ghcr.io/berriai/litellm`) and
   supports custom callbacks/handlers via a **mounted Python module** in
   `litellm_config.yaml` — the Voyage `dimensions`→`output_dimension` fix is
   a handler, not a core patch. Plan baseline = official image + mounted
   handler. Source-building LiteLLM only if core patching is later required
   (heavier: fork/upstream maintenance). *Pending final user confirm.*
4. **LiteLLM needs its own Postgres DB** for keys/spend/**prompt logs**.
   So `aitools-pg` serves both `honcho` and `litellm` databases. Strict
   bring-up order: pg → litellm → honcho.
5. **Honcho's carefully-built config must be reproduced**: Voyage
   `voyage-4-lite` @1024 with `dimensions_mode="never"`, GLM/Grok tiering,
   and the post-migrate `scripts/configure_embeddings.py` step to set
   pgvector columns to 1024. With LiteLLM in front, Honcho's model +
   embedding `base_url` point at `aitools-litellm`, not OpenRouter/Voyage
   directly.

## Network model (one verification required)

- `aitools-pg` + `aitools-redis` on `aitools-net`, **not** host-published
  (AI-tools-internal).
- `aitools-litellm` + `aitools-honcho` join `aitools-net` (reach pg/redis by
  alias), and **publish** their ports for the Hermes VM to reach.
- **RESOLVED (Phase 0 spike, 2026-05-17):** the isolated `hermes-agent` VM
  reaches OrbStack containers **both** ways — verified with a throwaway
  container:
  - `host.internal:<published-port>` → HTTP 200 (Mac host bridge).
  - **`<container>.orb.local:<container-internal-port>` → HTTP 200, resolves
    from the isolated VM, NO published port required.** ← **chosen.**
  **Decision:** Hermes(VM)→services uses `<container>.orb.local:<internal-
  port>` (e.g. `aitools-litellm.orb.local:4000`,
  `aitools-honcho-api.orb.local:8000`). No host port-publishing needed for
  the Hermes path; this also removes the host.internal/firewall-tension
  coupling for Hermes↔services. Containers set explicit `container_name:` so
  the `.orb.local` name is stable. pg/redis stay internal on `aitools-net`
  (unpublished). (Caveat: `--isolate-network` would still block this —
  full network isolation remains incompatible; plain `--isolated` is fine,
  proven.)

## Phase 0 — decisions + spikes — COMPLETE (2026-05-17)

- [x] Include `aitools-redis`: **yes**.
- [x] LiteLLM image vs source: **official image** (handler mechanism not even
  needed — see below).
- [x] **Spike — networking:** RESOLVED. Use `<container>.orb.local:
  <internal-port>` from the isolated VM (works, no publishing). See network
  model above.
- [x] **Spike — LiteLLM↔Voyage embeddings:** RESOLVED. Official
  `ghcr.io/berriai/litellm` proxies `voyage/voyage-4-lite` out of the box:
  bare call → 1024 (OpenAI-shaped); `dimensions=1024`→1024;
  `dimensions=512`→512 — i.e. **LiteLLM natively translates OpenAI
  `dimensions` → Voyage `output_dimension`**. Direct-to-Voyage 400'd on
  `dimensions`; via LiteLLM it works. **Consequences:** (a) no custom
  handler needed — drop that fallback entirely; (b) Honcho's
  `dimensions_mode="never"` workaround is no longer *required* once Honcho
  points at LiteLLM, but **keep it** (proven, minimal-change; LiteLLM
  handles either way); (c) Phase 3 embedding wiring is now low-risk:
  Honcho embedding `base_url` → `aitools-litellm.orb.local:4000`,
  model `voyage-4-lite`, key = a LiteLLM virtual key.

## Phasing (each phase independently testable)

### Phase 1 — `aitools-backends` (pg + redis, foundation)
`aitools-backends` compose: `pgvector/pgvector:pg17` + official `redis:`,
own volumes, creates the **external** `aitools-net`. PG init script creates
`honcho` + `litellm` databases + roles + `CREATE EXTENSION vector`.
**Acceptance:** from another container on `aitools-net`, `psql` connects to
both DBs and `SELECT '[1,2,3]'::vector` works, `redis-cli ping` works; from
the orb VM, the verified addressing reaches `aitools-pg`.

### Phase 1b — Clone `hermes-agent` → `hermes` (new prod VM)
`orb stop hermes-agent` → `orb clone hermes-agent hermes` →
`orb start hermes-agent` (original left running, **frozen, never modified**).
All later VM work happens in the clone `hermes`. The clone's native
Postgres is the Phase-3 pg_dump source. **Acceptance:** `hermes` machine
exists & boots; `hermes-agent` still present and untouched (its honcho/pg
still intact as reference); from `hermes`, `hermes`'s own native Honcho/PG
still run (pre-strip).

### Phase 2 — `aitools-services`: LiteLLM
`aitools-services` compose, `aitools-litellm` (official `ghcr.io/berriai/
litellm` pinned + mounted custom-handler module), joins `aitools-net`,
`DATABASE_URL` → `aitools-pg`/`litellm`, `LITELLM_MASTER_KEY`,
`STORE_MODEL_IN_DB`, prompt-logging-to-spend-logs ON, UI. Virtual keys for
`hermes` and `honcho` consumers. **Acceptance:** a test chat + embedding
call through a virtual key succeeds and the prompt is visible in the UI;
spend attributed to the key. (Task 1 pins the exact prompt-logging config
knob via `litellm` docs — known-stable feature, not a placeholder.)

### Phase 3 — `aitools-services`: Honcho
Same `aitools-services` compose, `aitools-honcho-api` + `aitools-honcho-
deriver` built from pinned honcho source, joins `aitools-net`,
DB → `aitools-pg`/`honcho`, cache → `aitools-redis`. Reproduce
the Voyage-1024 + GLM/Grok config but with model + embedding `base_url` →
`http://aitools-litellm:4000` (container-to-container) and key = a LiteLLM
virtual key. Migrate data: pg_dump the **clone `hermes`'s native Honcho
`postgres` DB** (NOT the original `hermes-agent`) → restore into
`aitools-pg`/`honcho`; verify 1024 vector columns + HNSW + Voyage
embeddings survive + `embedding_validator` passes + `configure_embeddings.py`
reports dim 1024. **Fallback:** if restore doesn't verify quickly, start
fresh (alembic upgrade head + configure_embeddings --yes). After verified,
strip native honcho-api/honcho-deriver systemd services + native PG **in
the clone `hermes`** (the original `hermes-agent` is never touched).
**Acceptance:** ingest → 1024-dim Voyage vector stored via LiteLLM path →
search + dialectic work.

### Phase 4 — Hermes rewire (in the clone `hermes` only)
In the clone `hermes` (never `hermes-agent`): `~/.hermes/honcho.json`
`baseUrl` → `http://aitools-honcho-api.orb.local:8000`. Hermes agent model
(`config.yaml`) → `http://aitools-litellm.orb.local:4000` with its own
LiteLLM virtual key. **Acceptance:** Hermes chat (in clone) end-to-end
exercises Hermes→LiteLLM (agent) and Hermes→Honcho→LiteLLM (memory),
prompts visible in LiteLLM UI, attributed to the correct virtual keys.
Snapshot final Hermes configs into this repo. `hermes-agent` remains a
working untouched fallback until you explicitly retire it.

## Final state — 2026-05-17 (BUILD COMPLETE)

All phases executed & independently verified:
- **Plan 01** `aitools-backends` (pg17 + redis) ✓
- **Phase 1b** clone `hermes-agent` → `hermes`; original **stopped/frozen/
  untouched** ✓
- **Plan 02** `aitools-litellm` (official image, prompt logging, virtual
  keys) ✓
- **Plan 03** `aitools-honcho` (built from pinned source; data **migrated**
  via pg_dump; 1024 Voyage schema; all LLM+embedding routed through LiteLLM
  — proven by growing spend logs) ✓
- **Plan 04a** clone Hermes rewired → Dockerized Honcho; clone's native
  honcho/pg retired; sanitized config snapshot committed ✓
- **Plan 04b** routing Hermes's *own agent model* through LiteLLM —
  **DONE (2026-05-17)**: user found a LiteLLM ChatGPT-subscription path and
  added `chatgpt/*` models to LiteLLM via the UI (store_model_in_db). Clone
  Hermes `config.yaml` → `provider: custom`,
  `base_url: http://aitools-litellm.aitools-services.orb.local:4000/v1`,
  `api_key: <HERMES_VIRTUAL_KEY>`, `model.default: chatgpt/gpt-5.5`. Hermes
  virtual-key model-allowlist expanded to the chatgpt/* family (+glm/grok)
  via `/key/update` (key value unchanged). Verified: `hermes -z` one-shot
  returned correct output; LiteLLM gpt-5.5 spend logs grew (Hermes agent
  now flows through LiteLLM). **Caveat:** the ChatGPT-subscription bridge
  500s on some edge/trivial requests (`ChatgptException - Unknown items …
  []`); LiteLLM retry masks it for real Hermes calls — robustness is a
  LiteLLM-chatgpt-model-side concern (retries/fallback), not Hermes.
- Security: the briefly-committed `HONCHO_VIRTUAL_KEY` was **rotated** (old
  key revoked → 401; new key gitignored only). Committed config carries an
  env-resolved placeholder, no secrets.

`hermes-agent` remains a stopped, intact, restorable fallback
(`orb start hermes-agent`) until the user retires it. Honcho memory is
migrated & queryable but sparse (source had ~8 msgs) — data content, not a
defect.

## Out of scope / deferred

- llmetry endpoint (prompt logging moves there later).
- Network-isolating the orb VM (`--isolate-network`): **incompatible** with
  this architecture's `host.internal` path — explicitly deferred; revisit
  only if switching to `.orb.local` direct addressing proves viable.
- PG18 (staying on 17; matches existing data + Honcho-proven).
