# Stack lifecycle & provisioning refactor — design

**Date:** 2026-05-18
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `feat/stack-lifecycle-refactor` (isolated worktree — the shared
`main` checkout + live stack stay undisturbed for concurrent agents; merged
back after user review)

## Goal

Replace the stack's init-only, cross-contaminating Postgres provisioning and
the hardwired `honcho-postup` ordering with a crisp, single-responsibility
service lifecycle, so that **enabling a pg-using service is purely additive,
idempotent, non-destructive, and self-contained**, and **misconfiguration
fails loudly on the terminal before the heavy stack comes up**. Nothing in
`lib/` or the `justfile` knows a service name.

This is **sub-project 1**. The Firecrawl install is **sub-project 2** — the
first consumer / proving ground — specified separately
(`2026-05-18-firecrawl-service-design.md`, after this lands).

## Problem (what's wrong today)

1. **`services/postgres/pg-init/00-init.sql` centralizes every service's
   role/db/extension.** Adding a service edits a shared file; one service's
   names leak into a file every other service shares.
2. **That SQL only runs on an empty `$PGDATA`.** The official `postgres`
   image runs `/docker-entrypoint-initdb.d` only at first `initdb`, so adding
   or altering a service's DB requires recreating the shared
   `<project>_pg-data` volume — **destructive on a live shared stack**. Not a
   Postgres limitation (role/db/extension DDL is online); purely the chosen
   mechanism.
3. **`.stack/db.generated.env` centralizes every service's DB password** in
   one file owned by `services/postgres/build.sh` — same cross-contamination;
   rotation currently needs a volume wipe.
4. **`lib/honcho-postup.sh` hardwires** a honcho-specific post-up dance into
   `lib/` plus a load-bearing `just start` ordering ("Do NOT add a blanket
   `up -d` before honcho-postup").
5. **`services/litellm/start.sh` is misnamed** — by function it runs *before*
   the main stack, bringing up LiteLLM and minting keys consumers need at
   their start. It is a *preflight* step.
6. **No fail-loud preflight validation.** A *present-but-invalid* rendered
   config can't be caught by Docker (only a *missing* bind-mount source fails
   the mount); such errors get buried in container logs / failing
   healthchecks instead of surfacing on the terminal.

## Goals

- Per-service, single-responsibility lifecycle artifacts. Generic discovery —
  no service name in `lib/`/`justfile`.
- DB provisioning is **idempotent and re-run every start**, ordered by
  Compose `depends_on`. Self-healing; the init-only destructiveness is
  *removed*.
- Misconfiguration **fails loudly before the heavy `compose up`**.
- **Multi-stack-safe and non-destructive on the live shared stack** (precise
  definition below).
- Operator control over provisioner-container dashboard clutter.

## Non-goals

- **Firecrawl install** — sub-project 2.
- **Eliminating Honcho's embedding-dim fix** via pre-migration config — later
  optimization; this spec *encapsulates* the proven dance as
  `services/honcho/poststart.sh`.
- **A versioned migration ledger.** Services self-migrate their own schema
  (Honcho `scripts/provision_db.py`, LiteLLM prisma on boot); the stack layer
  is thin role/db/extension bootstrap only.
- **Data migration / volume reattach / PG major-version upgrade.** The
  recreate-from-scratch model is unchanged.

## The lifecycle taxonomy (one job each)

| Artifact | Phase | The single job |
|---|---|---|
| `services/<svc>/build.sh` | `just build` (offline, no Docker) | **produce** — render configs, gen/rotate secrets, fetch sources |
| `services/<svc>/preflight.sh` | `just start`, before main `up` | **prepare inputs** — host script; may `dc up -d <dep>` + mint/edit `.stack/` (e.g. LiteLLM keys) |
| `services/<svc>/prestart.sh` | `just start`, after preflight, before main `up` | **validate / bail early** — host script; misconfig → exit non-zero, abort `start` loudly |
| **provisioner init service** in `services/<svc>/compose.yaml` (`com.stack.role=provisioner`) | Compose `up` (`depends_on`-ordered) | **provision** — role/db/extension/schema; re-runs every start, idempotent |
| `services/<svc>/poststart.sh` | after main `up -d` | **finalize** — steps needing something already serving |
| `machines/<m>/start.sh` | after stack up | bring up the VM/agent (unchanged role) |

**Why some steps are containers and some are host scripts** (so the mixed
taxonomy is principled, not arbitrary):

> If a step must be ordered **within** the main `up` relative to a service →
> it's a **provisioner container** (`honcho-api depends_on honcho-provision:
> service_completed_successfully` — only Compose can express that gate). If a
> step must happen **before** the main `up` to **produce inputs the up
> consumes** (minted keys in env) → it's a **host `preflight.sh` script** (it
> is not a node in the up graph; it feeds the graph).

`00-init.sql` and `lib/honcho-postup.sh` both die; `services/litellm/start.sh`
becomes `services/litellm/preflight.sh`.

### `build.sh` — offline produce (decentralize DB passwords)

Host-side only: no Docker daemon, no DB. Renders `*.template` → `*.runtime.*`,
generates/rotates secrets, fetches pinned sources. Idempotent. `just build`
runs `services/postgres/build.sh` **unconditionally first**, then iterates
active `COMPOSE_PROFILES` for `services/<p>/build.sh` (N3: a per-service
`<SVC>_DB_PASSWORD` is generated only when that profile is active — same
gating as today's central generation).

Change: **each pg-using service generates its OWN DB password** into
`.stack/<svc>.generated.env`. Eventually `services/postgres/build.sh` is
slimmed to generate **only** `POSTGRES_SUPERPASS`.

`compose_env_files()` (`lib/stacklib.sh`) lists `.stack/.env` then
`*.generated.env` in **shell glob = alphabetical** order; Compose env-file
precedence is **last-wins**. `<svc>.generated.env` sorts *after*
`db.generated.env` for `honcho`/`litellm`/`hindsight`, so the per-service
file correctly shadows the central one during migration.

**Mandatory migration rule (load-bearing for non-destructiveness, S2/B2):**
each migrated `build.sh` MUST first
`env_get .stack/db.generated.env <SVC>_DB_PASSWORD` and **only `openssl rand`
a fresh password if that read is empty** — a blind regen would, via
last-wins, silently shadow the correct live password and break that
service's auth against the existing `pg` volume. Until **Delivery step 6**,
`build.sh` also **mirrors** the value back into `db.generated.env` so the
still-wired `lib/honcho-postup.sh` (`:20` hard-reads `db.generated.env`)
keeps working. The mirror is removed only at step 6.

### `preflight.sh` — host script: prepare inputs before the main `up`

Runs in `just start`, profile-iterated, **before** the heavy `dc up -d`. May
bring up a dependency it needs and mutate `.stack/`. Generic discovery: the
justfile loops active profiles and runs `services/<p>/preflight.sh` if
present; **non-zero aborts `start` loudly**. After all preflights, the
justfile **recomputes `COMPOSE_ENV_FILES`** (a `*.generated.env` may have
been created), so the subsequent main `up` interpolates the fresh values.

`services/litellm/preflight.sh` — **renamed from `start.sh`**, and it now
*also* does the `dc up -d litellm` the justfile used to do (self-contained).
Concretely: `dc up -d litellm` — `pg` is **already running** from pipeline
step 0 (backends-first), so litellm boots its prisma migration against a
live DB; from Delivery step 3 litellm also gains its own
`litellm → litellm-provision → pg` `depends_on` edges (defense-in-depth, and
they make the litellm-provision role/db a no-op when it already exists). Then
wait healthy, mint virtual keys via `dc exec` into the running litellm
(master key read **inside** the container — never on a host argv; security
property preserved verbatim from today's `start.sh`), write
`.stack/litellm.generated.env`, idempotent re-mint (`/key/update` probe →
re-mint only if missing/invalid, gotcha #4). This is the **only** preflight
today.

Two `up`s are intrinsic and fine: preflight's `dc up -d litellm` is up #1
(partial — litellm only, pg already up from step 0); the main `dc up -d` is
up #2 and re-reads the now-updated env files. The justfile skeleton stays
**generic** (~6 lines, no per-service logic — only the infra-substrate
`pg redis` is named, as today); all LiteLLM specifics live in
`litellm/preflight.sh`. No `preflight` profile / preflight container / bind
mount is used — a host script avoids the bind-mount uid friction and keeps
the master key off the host argv. No teardown step: everything a preflight
touches (litellm, pg) is a real stack service the main `up` wants anyway;
the main `up -d` is idempotent and just keeps it running.

### `prestart.sh` — host script: validate, bail early

Runs in `just start` **after** all `preflight.sh` (so minted keys exist) and
**before** the main `dc up -d`, profile-iterated. Just a script whose
intended job is to validate env/rendered config and **exit non-zero to abort
`start` with a clear message** rather than let a misconfig bury itself in
container logs. No artificial restriction on what it may do — it is simply
the early-bail hook. Absent ⇒ skip.

### Provisioner init service — Compose-ordered DB bootstrap (replaces `00-init.sql`)

Each pg-using service ships, in its **own** `services/<svc>/compose.yaml`, a
one-shot init service:

- `image: pgvector/pgvector:pg18` (already pulled; ships `psql`).
- `labels: { com.stack.role: provisioner }` — function-named marker;
  identity comes free from Compose's `com.docker.compose.service` /
  `com.docker.compose.project`.
- `depends_on: { pg: { condition: service_healthy } }`. `restart: "no"`.
- Runs an idempotent SQL file bind-mounted from `services/<svc>/provision.sql`
  as the **superuser**: `psql -h pg -U postgres -d postgres` with
  `PGPASSWORD=${POSTGRES_SUPERPASS}` injected via Compose env (never a host
  argv). `POSTGRES_USER=postgres` + maintenance db `postgres` are the connect
  target (mirrors today's `00-init.sql`). `${POSTGRES_SUPERPASS}` resolves —
  `services/postgres/compose.yaml` already maps it and it lives in
  `db.generated.env` ∈ `COMPOSE_ENV_FILES`.
- The service password is injected via env (`<SVC>_DB_PASSWORD`), **not baked
  into the SQL**. Exact psql `-v`/quoting (the `\gexec` `CREATE DATABASE`
  guard interpolation is a known footgun) is proven against the live `pg` in
  Delivery step 3, not fixed by this spec (house-style deferral).
- Exits 0; the real service declares
  `depends_on: { <svc>-provision: { condition: service_completed_successfully } }`.

**Verified (spike, 2026-05-18, Compose 5.1.2):** a plain `docker compose
up -d` **re-runs** the provisioner every start (restarts the exited
container; `StartedAt` advances; command re-executes) while leaving healthy
long-running services as `up-to-date` (not recreated). The
`service_completed_successfully` gate orders `pg → provisioner → service`
natively — no justfile DB ordering.

**Retrofit recreates each gated service exactly once (B1/S3 — stated, not
hidden).** `services/litellm/compose.yaml` has **no `depends_on` at all**
today (verified); honcho/hindsight depend only on `pg`/`litellm`. Adding the
`depends_on: <svc>-provision` edge changes that service's Compose definition,
so the next `dc up -d` **recreates that container once** (litellm,
honcho-api, honcho-deriver, hindsight) and adds a *new* `pg: service_healthy`
gate to litellm (benign tightening). This one-time recreate is **expected
and is what "non-destructive" means here** — volume/cluster/roles/dbs/data
preserved; only the stateless app container is replaced and reconnects. Not
a volume recreate or stack teardown.

**"Idempotent no-op on the live volume" is a step-3 acceptance gate, not an
a-priori guarantee (S1).** Step 3 MUST demonstrate the provisioner running
as a true no-op against the live `pg` (roles/dbs already present;
`ALTER ROLE … PASSWORD` re-syncs the *same* value via the mandatory
migration read) before later steps proceed.

Idempotent SQL idioms (exact quoting resolved in step 3): role via
`DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$;`; password
re-sync `ALTER ROLE … WITH PASSWORD …` every run; db via `SELECT … WHERE NOT
EXISTS (SELECT FROM pg_database …) \gexec`. **Each service's
`provision.sql` declares only what *it* needs** (N-3): today only
honcho/hindsight do `CREATE EXTENSION IF NOT EXISTS vector;` +
`GRANT ALL ON SCHEMA public TO …` inside their own db — **litellm's
`provision.sql` is role/db only, no extension**, exactly matching
`00-init.sql` today (it has no `\connect litellm`/extension). Running as
superuser sidesteps the non-superuser `CREATE EXTENSION` privilege issue,
exactly as `00-init.sql`'s `\connect` blocks do.

**Cluster-global config stays OUT of provisioners.** `ALTER SYSTEM` /
`shared_preload_libraries` are cluster-wide — a service mutating them is the
same cross-contamination as a shared init file, via `postgresql.auto.conf`.
They go in the surgical bucket below. Provisioners may set **per-table**
storage params (scoped, harmless).

The ~10-line provisioner Compose snippet is copied per service (kept
self-contained; optional shared fragment is a later DRY pass, non-goal now).

### `poststart.sh` — finalize / needs-something-serving

After the final `dc up -d`, profile-iterated for services then machines.

- `services/honcho/poststart.sh` — **relocated from `lib/honcho-postup.sh`**.
  The proven embedding-dim-fix dance, made idempotent + profile-discovered,
  with **no** justfile special-casing. It is *not* provisioner-able: it needs
  honcho-api's own alembic to have already created the tables (post
  honcho-start), whereas a provisioner runs *before* honcho-api. (Eliminating
  it via pre-migration config = future non-goal.)
- `machines/<m>/start.sh` — unchanged role.

So honcho = provisioner (role/db/ext) + poststart (dim-fix); **no preflight**.

## `just` targets

### `just start` (re-shaped, generic — no service names)

Assumes `just build` already ran. Pipeline:

0. **backends first** — `dc up -d pg redis` (the no-profile always-on
   substrate). **Load-bearing and retained from today's recipe (B-1):** the
   current `just start` brings up `pg`/`redis` unconditionally *before*
   anything touches litellm, and `services/litellm/compose.yaml` has **no
   `depends_on`** — so without this step `litellm/preflight.sh`'s
   `dc up -d litellm` would start litellm with no `pg` and its prisma boot
   would fail. `pg`/`redis` are infra substrate (not pluggable profile
   services); naming them here is the same explicit backend bring-up the
   stack does today, not per-service logic.
1. **preflight** — iterate active `COMPOSE_PROFILES`; run
   `services/<p>/preflight.sh` if present (litellm's mints keys against the
   now-running pg). Any non-zero aborts with that service's message. Then
   **unconditionally recompute + re-export `COMPOSE_ENV_FILES`** (S-1 —
   mandatory every pass: on a scratch project `litellm.generated.env` did not
   exist when `start` began, so this is what makes the minted keys visible to
   the main `up`).
2. **prestart** — iterate active profiles; run `services/<p>/prestart.sh` if
   present. Any non-zero aborts loudly (misconfig caught *before* the heavy
   up).
3. **`dc up -d`** — Compose brings up backends → each active service's
   provisioner (`depends_on pg healthy`; idempotent SQL; exits) → services
   (`depends_on` provisioner `completed_successfully` + healthchecks), env now
   populated from the merged `*.generated.env`.
4. **poststart** — iterate active profiles → `services/<p>/poststart.sh`;
   then `machines/<m>/start.sh`.
5. If `STACK_AUTO_REMOVE_PROVISIONERS=true` → `just start-cleanup`.

This collapses the current load-bearing staged ordering (keeping only the
backends-first invariant) and deletes `lib/honcho-postup.sh` + its "do not
blanket `up -d`" comment.

### `just start-cleanup`

Reap exited provisioner containers, multi-stack-safe:

```
ids="$(docker ps -aq \
  --filter "label=com.stack.role=provisioner" \
  --filter "label=com.docker.compose.project=$(stack_project)" \
  --filter "status=exited")"
if [ -n "$ids" ]; then docker rm $ids || true; fi
```

`project`+`exited` filters are **load-bearing** (never touch another stack's,
nor a running/converging, provisioner). **S5:** the justfile shell is
`set -eu -o pipefail`; a trailing `[ -n "$ids" ] && …` short-circuits to
exit 1 when empty and aborts the recipe — must use `if … then … fi`. The
`docker ps`→`docker rm` window is **TOCTOU-racy under the shared-stack
concurrent-agent model** (a peer's `dc up -d` re-runs/recreates a
provisioner between snapshot and rm): the `|| true` tolerates a vanished/
now-running id so cleanup never aborts `start` (never `-f` — must not kill a
provisioner that just started running for someone else).
Directly runnable; auto-invoked as step 5 when the flag is true. Fresh-log
re-provision idiom: `just start-cleanup && just start`.

## `.stack/.env`

- New flag **`STACK_AUTO_REMOVE_PROVISIONERS`**, default **`false`** —
  removing the container destroys its provisioning logs (the thing you want
  "some of the time"); opt-in per stack. Documented in `.stack.env.example`.

## Multi-stack & non-destructive guarantees

**Definition.** "Non-destructive" = **no `<project>_pg-data` recreate, no
data/role/db loss, no full-stack teardown.** It does **not** mean zero
container churn — adding a provisioner `depends_on` edge recreates that one
stateless app container exactly once.

- All Docker ops via the `dc` helper or explicit
  `--filter com.docker.compose.project=$(stack_project)`.
- **One-time recreates, by design (enumerated):** `litellm` (gains
  `litellm → litellm-provision → pg`; none today), `honcho-api`,
  `honcho-deriver`, `hindsight`. Each replaced once on the `dc up -d` after
  its step; reconnects to the unchanged cluster.
- **Non-destructive on the live volume — *demonstrated* at step 3, not
  assumed (S1).** Idempotent provisioners must detect-and-skip;
  `ALTER ROLE … PASSWORD` re-syncs the *same* value (mandatory migration
  read; never a fresh random — S2). No `<project>_pg-data` recreation.
- `00-init.sql` deletion + `pg` entrypoint un-wrapping + dropping the
  `db.generated.env` mirror happen **only at step 6**, after every consumer
  has a working provisioner and `honcho-postup` is relocated (step 5).

## Postgres image / cluster-level changes (the surgical bucket)

Provisioners handle *in-database* changes only. Changes needing a new
extension *binary*, `shared_preload_libraries`, or global `ALTER SYSTEM`
tuning are the central, git-tracked `services/postgres/` bucket. The key
fact:

> **Postgres data lives in the `<project>_pg-data` volume, independent of the
> image and config.** Replacing the `pg` *container* (new image/flags) while
> re-attaching the same volume is **non-destructive within a PG major
> version** — it just starts against the existing data dir. Data ≠ image ≠
> config.

| Change | Where | How it applies | Data impact |
|---|---|---|---|
| role / db / `CREATE EXTENSION <installed>` / schema | per-service **provisioner** | every `up`, online, idempotent | none |
| **cluster config** — `shared_preload_libraries`, global `ALTER SYSTEM` | git-tracked `services/postgres/` (`command:` flags or mounted conf) | deliberate `pg` container **recreate** | none — config read at start; `ALTER SYSTEM` persists in `postgresql.auto.conf` *inside the volume* |
| **extension binary** — `apt install postgresql-18-<ext>` (e.g. `pg_cron`), pgvector bump within pg18 | git-tracked `services/postgres/Dockerfile` → `build:` in its compose | `dc up -d` recreates `pg` (definition changed) | none — same pg18 data dir, new binaries; then the needing service's provisioner `CREATE EXTENSION IF NOT EXISTS` |

**Mechanism for "update pg without losing data":** change the git-tracked
`services/postgres/` definition, commit (reviewed centrally — never smuggled
in by a consumer), `dc up -d pg`. Compose replaces **only** `pg` and
re-mounts `<project>_pg-data`; dependents aren't recreated — their pooled
connections drop and reconnect (brief blip on the shared stack, data
intact). For a *preloaded* extension (pg_cron): (1) Dockerfile adds the
binary, (2) conf adds it to `shared_preload_libraries`, (3) recreate `pg`,
(4) the consumer's provisioner `CREATE EXTENSION`. Steps 1–3 = one reviewed
central commit; step 4 stays in the service.

**The only data-destructive pg change is a major-version bump** (18→19,
needs `pg_upgrade`/dump-restore) — explicit non-goal. A service needing only
an *already-installed* extension (`vector`, in `pgvector/pgvector:pg18`)
needs **no** pg change — just `CREATE EXTENSION IF NOT EXISTS vector` in its
provisioner. The deliberate `pg` recreate is the one "announce-it-on-the-
shared-stack" op, distinct from the everyday additive provisioner path.
(This is exactly Firecrawl + `pg_cron`, sub-project 2.)

## Delivery (staged; each step independently verifiable & non-destructive)

1. **justfile/stacklib:** add generic `preflight.sh`/`prestart.sh`/
   `poststart.sh` discovery loops, `COMPOSE_ENV_FILES` recompute after
   preflight, `start-cleanup`, `STACK_AUTO_REMOVE_PROVISIONERS`. The loops
   are **inert** at this step (no hook files exist yet) and the existing
   hardcoded litellm ordering is left intact; step 2 swaps the two
   atomically (rename `start.sh`→`preflight.sh` *and* delete the hardcoded
   path in the same change) so there is never a double-run or gap window.
2. **litellm preflight + first concrete prestart (closes S-2):** rename
   `services/litellm/start.sh` → `services/litellm/preflight.sh`; move the
   `dc up -d litellm` into it (atomically with deleting the hardcoded
   litellm/honcho/hindsight `grep` ordering from the justfile — backends are
   still brought up by pipeline step 0). **Also ship
   `services/litellm/prestart.sh`** — the first real validator: assert the
   rendered `services/litellm/config.runtime.yaml` exists and parses (`yq`),
   exit non-zero with `litellm: <problem>` otherwise. (LiteLLM is the natural
   first prestart: it is the one service with a rendered runtime config.)
   Verify on the live stack: keys still mint, consumers stay healthy; an
   injected malformed `config.runtime.yaml` aborts `just start` before the
   heavy `up`.
3. **litellm provisioner:** add `services/litellm/` provisioner init service
   **and the `litellm → litellm-provision (completed) → pg (healthy)` edges
   to `services/litellm/compose.yaml`** (B1 — recreates litellm once). Move
   `LITELLM_DB_PASSWORD` into `services/litellm/build.sh` with the **mandatory
   migration read + `db.generated.env` mirror** (S2/B2). **Acceptance gate
   (S1):** demonstrate the provisioner is a true no-op against the live
   volume + LiteLLM healthy before proceeding.
4. **honcho, then hindsight:** repeat (3) — provisioner + `<svc>-provision`
   edge (honcho-api + honcho-deriver) + decentralized password w/ mirror +
   `vector` extension. `HONCHO_DB_PASSWORD` keeps being **mirrored into
   `db.generated.env`** so the still-wired `lib/honcho-postup.sh` (`:20`)
   doesn't die before step 5 (B2).
5. **Strictly after step 4.** Relocate `lib/honcho-postup.sh` →
   `services/honcho/poststart.sh`. The dance is kept **verbatim** — its own
   `dc up -d honcho-api` + the *tolerant wait on the `documents` table*
   (created by honcho-api's **alembic**, NOT by any provisioner) + the
   embedding-dim fix — because none of that is provisioner-able (S-3). The
   *only* things that change: (a) the role/db/`vector` precondition it
   implicitly relied on `00-init.sql` for is now the `honcho-provision`
   container's job (delegated); (b) **the password-source line is repointed**
   `env_get .stack/db.generated.env HONCHO_DB_PASSWORD` →
   `.stack/honcho.generated.env` (S-4 — mandatory: step 6 drops the
   `db.generated.env` mirror, which would otherwise strand this read). Made
   idempotent + profile-discovered. Delete the lib file + the load-bearing
   justfile ordering.
6. Once all consumers have working provisioners **and** `honcho-postup` is
   relocated: delete `00-init.sql`, un-wrap
   `services/postgres/compose.yaml`'s entrypoint, slim
   `services/postgres/build.sh` to superpass-only, **drop the
   `db.generated.env` mirror** from each migrated `build.sh` (no reader
   remains). Verify full `just stop`/`just start` on a scratch project **and**
   a non-destructive pass on the live stack.
7. **README:** architecture, the lifecycle taxonomy + container-vs-script
   principle, gotchas (provisioner pattern; preflight/prestart; surgical pg
   bucket; `STACK_AUTO_REMOVE_PROVISIONERS`; adding a pg-using service no
   longer needs a volume recreate).

## Risks / edge cases (resolved in design; not blocking)

- **Provisioner log accumulation** (keep=false): a restarted provisioner
  appends logs across starts. Cosmetic; `start-cleanup && start` or the flag
  gives fresh logs.
- **Concurrent agents** (shared live stack): `status=exited` filter prevents
  cleanup touching a running/converging provisioner; provisioners idempotent
  so concurrent re-runs are safe.
- **Two `up`s** (preflight partial up + main up): intrinsic to env-injected
  keys; generic, no per-service justfile logic; no teardown (preflight deps
  are real stack services).
- **Per-service Compose boilerplate** (~10 lines) duplicated: accepted for
  self-containment; optional later DRY (non-goal).

## Acceptance

- Fresh scratch project: `just build && just start` → all enabled services
  healthy; each role/db/extension created by its own provisioner;
  `00-init.sql` gone; `litellm/preflight.sh` mints keys. The prestart
  mechanism is verified concretely via `services/litellm/prestart.sh`: an
  injected malformed `services/litellm/config.runtime.yaml` makes `just start`
  abort *before* the heavy `up` with a clear `litellm: <problem>` message;
  reverting it lets `start` proceed.
- Live shared stack: **no `<project>_pg-data` recreate, no data/role/db loss,
  no stack teardown.** `litellm`, `honcho-api`, `honcho-deriver`, `hindsight`
  each recreated **once** (by design) and return healthy against the
  unchanged cluster; `pg`/`redis` untouched. Step-3 no-op gate demonstrated
  before the rest proceeds.
- Adding a NEW pg-using service touches **only** its own `services/<svc>/`
  dir + the root `include:` + one `.stack.env.example` profile line — **zero**
  edits to any other service, `lib/`, or `00-init.sql`.
- `STACK_AUTO_REMOVE_PROVISIONERS=true` → no `Exited (0)` clutter after
  `just start`; `=false` (default) → provisioners linger with readable logs,
  cleared by `just stop`.
- `just start-cleanup` only ever removes **this** project's exited
  provisioners.
- No regression to honcho / litellm / hindsight / agentmemory / cliproxyapi.
