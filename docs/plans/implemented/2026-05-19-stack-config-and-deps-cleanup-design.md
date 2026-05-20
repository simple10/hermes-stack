# Stack config & cross-service dependency cleanup — design

Date: 2026-05-19
Status: approved; self-re-reviewed 2026-05-19 (fixed: postgres→pg rename
invariant, POSTGRES_SUPERPASS preservation, chatgpt tracked-README split)

## Problem

Two coupled pain points in how a stack's identity is expressed:

1. **Profile coupling.** `rabbitmq` is gated by `profiles: ["firecrawl"]` because
   firecrawl-api is currently its only consumer. Adding a second AMQP consumer
   means editing rabbitmq's compose. More broadly, `pg` and `redis` are
   profile-*less* (always-on), so a stack with no pg/redis consumers still runs
   them, and `just start` hardcodes `dc up -d pg redis`. Cross-profile
   `depends_on` edges currently "work" only because the default
   `COMPOSE_PROFILES` happens to run the dependent profiles together; with
   Compose v5.1.2 a `depends_on` on a service whose profile is inactive is a
   hard `undefined service` error (verified non-destructively).

2. **Split stack identity.** A stack's runtime state is split across two trees:
   rendered configs (`services/<svc>/config.runtime.*`) and stateful bind dirs
   (`services/litellm/chatgpt/`) live in the git tree (gitignored), while
   `.stack/<svc>.generated.env` and `.stack/.config-hashes/` live in `.stack/`.
   This makes worktrees that run against the main stack, and full-config
   snapshots/backups, non-trivial.

## Goals

- A service declares its cross-service dependencies once, in one place; adding
  a new consumer never edits the dependency's compose file.
- `pg`, `redis`, `rabbitmq` run only when something in the active stack needs
  them. `just start` derives the backends-first bring-up from declarations
  instead of hardcoding `pg redis`.
- A stack's entire mutable identity lives under `.stack/<svc>/`. Backing up a
  stack = copying `.stack/`. Nothing stack-state remains in the git tree.

## Non-goals

- No general topological dependency engine. Compose's own `depends_on` +
  healthchecks continue to own ordering and readiness. The new mechanism only
  decides which **profiles** are active and which **substrate services** are
  brought up before preflight.
- No permanent backward-compatibility / fallback code. The live `main` stack is
  migrated once, by hand (see Migration runbook).
- No change to honcho's internal config rendering quirks, image pinning, or
  any service's runtime behavior.

---

## Design A — Declarative cross-service dependencies

### Substrate gets its own profile

| Service compose | Before | After |
|---|---|---|
| `services/pg/compose.yaml` (`pg`) | no `profiles:` (always-on) | `profiles: [pg]` |
| `services/redis/compose.yaml` (`redis`) | no `profiles:` (always-on) | `profiles: [redis]` |
| `services/rabbitmq/compose.yaml` (`rabbitmq`) | `profiles: ["firecrawl"]` | `profiles: [rabbitmq]` |

**Invariant:** for substrate, **directory == compose service == profile**
(`pg`, `redis`, `rabbitmq`). This makes a required name usable as a
`COMPOSE_PROFILES` entry, a `dc up -d <name>` target, *and* a
`services/<name>/service.env` path — all with zero lookup tables.

**Required rename:** the directory is currently `services/postgres/` but the
compose service is `pg` (every `depends_on: pg`, `@pg:5432`,
`PGPASSWORD`/`POSTGRES_PASSWORD` uses `pg`). `git mv services/postgres
services/pg` to satisfy the invariant. The compose **service name stays `pg`**
— this is a structural/path rename only, **no runtime change**. Update the two
references: `docker-compose.yaml` include (`services/postgres/compose.yaml` →
`services/pg/compose.yaml`) and `justfile` build
(`{{root}}/services/postgres/build.sh` → `{{root}}/services/pg/build.sh`).
`redis` and `rabbitmq` dirs already satisfy the invariant (no rename).

### Per-service manifest

New file `services/<svc>/service.env` — shell-sourceable, two optional keys:

```sh
# services/firecrawl/service.env
SERVICE_REQUIRES=redis,rabbitmq,litellm   # profiles this profile needs active

# services/postgres/service.env
SERVICE_KIND=backend                       # substrate: single-service, brought
                                           # up in the backends-first phase
```

- `SERVICE_REQUIRES` — comma list of **profile names** that this service's
  profile needs active (cross-profile `depends_on` targets + substrate it
  connects to). Drives `COMPOSE_PROFILES` expansion.
- `SERVICE_KIND=backend` — marks a single-service substrate profile (`pg`,
  `redis`, `rabbitmq`) whose name equals its service name, so it is a valid
  `dc up -d <name>` target and is brought up in the backends-first phase.
  Absent (the default) = an application profile, never `dc up -d`'d early
  (it comes up via the later full `dc up -d` + Compose `depends_on`).

It is a plain file (not a compose label) precisely because
`docker compose config` itself errors on an inactive cross-profile
`depends_on`, so requirements cannot be discovered by introspecting compose.

**Populating it (required implementation audit).** For every service compose,
`SERVICE_REQUIRES` must list the profile of:
- every **cross-profile `depends_on` target** (a `depends_on` on a service in a
  different profile), and
- every **substrate** (`pg`/`redis`/`rabbitmq`) the service connects to at
  runtime via env URL even when there is no explicit compose `depends_on`,
- and any cross-service host (`litellm`, `honcho-api`, …) referenced from an
  **`env_file`** (e.g. `agentmemory`'s `./.env`), not just from `compose.yaml`
  — the audit must read `env_file` targets too.

Starting table from the current audit (implementation must re-verify every
compose; mark "—" for none, omit the file when empty):

| Service dir | `service.env` | Reason |
|---|---|---|
| `pg` (renamed from `postgres`) | `SERVICE_KIND=backend` | substrate (dir==service==profile==`pg`) |
| `redis` | `SERVICE_KIND=backend` | substrate |
| `rabbitmq` | `SERVICE_KIND=backend` | substrate |
| `litellm` | `SERVICE_REQUIRES=pg,redis` | provision→pg; `REDIS_URL` redis (no compose depends_on) |
| `honcho` | `SERVICE_REQUIRES=pg,redis,litellm` | honcho-api depends_on pg, redis, **litellm (cross-profile)** |
| `hindsight` | `SERVICE_REQUIRES=pg,litellm` | depends_on pg, **litellm (cross-profile)**; litellm pulls redis |
| `firecrawl` | `SERVICE_REQUIRES=redis,rabbitmq,litellm` | depends_on redis, rabbitmq, **litellm (cross-profile)**; uses own `firecrawl-postgres`, **not** shared `pg` |
| `honcho-ui` | `SERVICE_REQUIRES=honcho` | depends_on `honcho-api` (cross-profile); fixpoint pulls honcho's deps |
| `agentmemory` | `SERVICE_REQUIRES=litellm` | `OPENAI_BASE_URL=http://litellm:4000` in `env_file ./.env` + `AGENTMEMORY_VIRTUAL_KEY`; **no compose `depends_on`** |
| `cliproxyapi` | — | no pg/redis/litellm deps (per its compose header) |
| `camofox-browser` | — | standalone |

`pg`/`redis`/`rabbitmq` have no `SERVICE_REQUIRES` (they need nothing); app
profiles have no `SERVICE_KIND`. A dir with neither key needs no `service.env`.

### stacklib helpers

Add to `lib/stacklib.sh` (additive — new functions; one changed line in `dc`):

- `stack_required` — print the deduped union of `SERVICE_REQUIRES` across the
  active user profiles. Active user profiles = `COMPOSE_PROFILES` from
  `.stack/.env`. Iterate to a fixpoint (a required profile's own
  `services/<p>/service.env` may add more); terminates quickly (substrate
  requires nothing).
- `stack_profiles` — print `COMPOSE_PROFILES` (`.stack/.env`) ∪ `stack_required`,
  deduped. The full set of profiles that must be active (used by `dc` for the
  injected `COMPOSE_PROFILES` — includes app profiles like `honcho`).
- `stack_backends` — print the subset of `stack_profiles` whose
  `services/<name>/service.env` declares `SERVICE_KIND=backend`. These are the
  single-service substrate profiles (name == service), the only valid early
  `dc up -d` targets. App profiles (`honcho`, `litellm`, …) are excluded — they
  are not `dc up -d`-able by profile name and come up via the later full
  `dc up -d` + Compose `depends_on`.

`dc()` change: replace
`prof="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)"`
with
`prof="$(stack_profiles)"`.

Single touch-point: **every** `dc` invocation — `just start`, preflight
scripts that call `dc` directly, manual `dc` — sees the same expanded profile
set, so every cross-profile `depends_on` validates.

### justfile `start`

Replace the hardcoded backends-first line:

```
dc up -d pg redis
```

with:

```
dc up -d $(... stack_backends ...)        # e.g. resolves to: pg redis  (or + rabbitmq, …)
```

(Exact shell wiring decided in the plan.) `stack_backends` yields only
`SERVICE_KIND=backend` single-service substrate, so every element is a valid
`dc up -d` target — app profiles like `honcho` are never passed here. The
preflight / prestart / poststart loops continue to iterate the user-declared
`COMPOSE_PROFILES` (substrate has no lifecycle scripts, so unaffected).

### Correctness note

Manifest completeness is correctness-critical: if an active profile's service
has a cross-profile `depends_on` whose profile is not pulled in via
`SERVICE_REQUIRES`, `dc` fails with `undefined service`. This is covered by the
acceptance test below.

---

## Design B — `.stack/<svc>/` consolidation

### Target layout

```
.stack/
  .env                              # unchanged — the lever surface
  pg/
    .generated.env                  # POSTGRES_SUPERPASS — was .stack/db.generated.env
  <svc>/
    .generated.env                  # was .stack/<svc>.generated.env
    config.runtime.{yaml,toml}      # was services/<svc>/config.runtime.*
    .config-hashes/<file>.sha256    # was .stack/.config-hashes/<svc>.<file>.sha256
  litellm/
    chatgpt/
      auth.json                     # was services/litellm/chatgpt/auth.json (token)
```

`POSTGRES_SUPERPASS` is **actively used** (pg container password +
every provisioner's `PGPASSWORD`); `db.generated.env` is **not** vestigial.
It is *renamed/moved* to `.stack/pg/.generated.env`, never deleted —
`dc()`'s new glob still passes it to Compose. The litellm `chatgpt/`
dir mixes a **tracked** `README.md` (docs) with an ignored `auth.json`
(state): only `auth.json` is stack state and moves; the README stays a
tracked doc (relocated to `services/litellm/README-chatgpt.md`).

### Code changes (no fallback — new paths only)

- **Compose binds** (`services/<svc>/compose.yaml`): `./config.runtime.yaml`
  → `../../.stack/<svc>/config.runtime.yaml`; honcho `./config.runtime.toml`
  → `../../.stack/honcho/config.runtime.toml`; cliproxyapi likewise; litellm
  `./chatgpt` → `../../.stack/litellm/chatgpt`. Paths are relative to the
  included compose file (`services/<svc>/`), so `../../.stack/...` is the
  repo-root `.stack/` — checkout-portable, no absolute-path env var.
- **`dc()` env-file glob**: `ls "$STACK_DIR"/*.generated.env`
  → `ls "$STACK_DIR"/*/.generated.env` (the `*` glob skips the dot-prefixed
  `.config-hashes` dirs; `.generated.env` is matched by explicit name).
- **`render_template`**: writes `OUT` and its hash under
  `.stack/<svc>/` and `.stack/<svc>/.config-hashes/<basename>.sha256`.
- **`services/pg/build.sh`** (renamed dir): `DBENV="$STACK_DIR/db.generated.env"`
  → `DBENV="$STACK_DIR/pg/.generated.env"` (still reuse-if-present so it keeps
  matching the pg volume). `mkdir -p` the parent.
- **`services/litellm/build.sh`, `services/honcho/build.sh`,
  `services/hindsight/build.sh`**: render into `.stack/<svc>/config.runtime.*`;
  read/write `<SVC>_DB_PASSWORD` only from `.stack/<svc>/.generated.env`. The
  legacy `db.generated.env` fallback line is **removed** — confirmed a dead
  no-op for the live stack (the per-service passwords live in the per-service
  files, never in `db.generated.env`, which holds only `POSTGRES_SUPERPASS`).
- **`just reconfigure svc`**: back up + re-render under `.stack/<svc>/`.
- **`.gitignore`**: actual current entries are `**/*.runtime.{toml,yaml,json}`
  and `services/litellm/chatgpt/auth.json` (not `services/*/config.runtime.*`
  or `services/*/chatgpt/`). After the move these become dead (everything lives
  under the already-ignored `.stack/`). Removing them is **optional cleanup**,
  not correctness-relevant; do it for tidiness. Keep `.stack/` and
  `**/*.generated.env`.

---

## Migration runbook (one-time, `main`, performed by hand)

The live `main` `.stack/` is migrated once during implementation. No fallback
code ships.

**Bind-mounted artifacts are `cp`'d, not `mv`'d**, until a verified recreate.
Relying on a running container tolerating its bind source being moved is
unsafe across file-sharing backends (OrbStack virtiofs); copying leaves the
old path intact as a rollback and the container untouched until it is
recreated onto the new bind. `.generated.env` / hash files are *not*
bind-mounted (they are `--env-file` / build inputs), so those are plain `mv`.

1. **Password preservation gate (abort on failure).** Confirm
   `POSTGRES_SUPERPASS` is present in `.stack/db.generated.env`;
   `LITELLM_DB_PASSWORD` in `.stack/litellm.generated.env`;
   `HONCHO_DB_PASSWORD` in `.stack/honcho.generated.env`;
   `HINDSIGHT_DB_PASSWORD` in `.stack/hindsight.generated.env`;
   `FIRECRAWL_DB_PASSWORD` in `.stack/firecrawl.generated.env`. Abort the
   whole migration if any is missing.
2. `mv .stack/db.generated.env .stack/pg/.generated.env`
   (`mkdir -p .stack/pg` first). **Never delete it** — it carries
   `POSTGRES_SUPERPASS`, which must keep matching the existing pg volume.
3. For `litellm honcho hindsight firecrawl`: `mkdir -p .stack/<svc>` and
   `mv .stack/<svc>.generated.env .stack/<svc>/.generated.env`
   (guard each with `[ -f ]`).
4. `cp` rendered configs / token to the new paths (originals stay until
   step 8): `services/litellm/config.runtime.yaml` →
   `.stack/litellm/config.runtime.yaml`; `services/honcho/config.runtime.toml`
   → `.stack/honcho/config.runtime.toml`;
   `services/cliproxyapi/config.runtime.yaml` →
   `.stack/cliproxyapi/config.runtime.yaml` (each guarded with `[ -e ]`);
   `services/litellm/chatgpt/auth.json` →
   `.stack/litellm/chatgpt/auth.json`.
5. Relocate the tracked doc: `git mv services/litellm/chatgpt/README.md
   services/litellm/README-chatgpt.md`; then the now-empty
   `services/litellm/chatgpt/` is removed by the rename/cleanup.
6. `mkdir -p .stack/<svc>/.config-hashes`; move
   `.stack/.config-hashes/<svc>.<file>.sha256`
   → `.stack/<svc>/.config-hashes/<file>.sha256`; `rmdir .stack/.config-hashes`.
7. Land all code changes (incl. `git mv services/postgres services/pg` and the
   two path-reference updates). `just build` is then a no-op re-render
   (files already in place; passwords reused, not regenerated).
8. **Coordinated recreate** (non-destructive — volumes preserved): bring the
   stack down (containers only) and back up so containers rebind to the new
   paths. Verify health, then delete the old `services/*/config.runtime.*`
   originals left from step 4.

**Concurrent-agent coordination.** `main` is sometimes worked by multiple
agents against one live shared stack (`aitools`). Migration steps 1–6 do not
disturb running containers (no bind source is moved; only copies + non-bound
`mv`s). The recreate (step 8) keeps volumes (`just down` removes containers,
not volumes; never `docker volume rm`) so pg data and passwords are intact.
Coordinate the recreate with any other agent on this checkout.

---

## Acceptance criteria

1. `git mv services/postgres services/pg` done; `docker-compose.yaml` include
   and `justfile` build reference updated; `services/pg/compose.yaml` service
   is still named `pg`.
2. `services/rabbitmq/compose.yaml` has `profiles: [rabbitmq]`; `pg`/`redis`
   have `profiles: [pg]`/`[redis]`.
3. `lib/stacklib.sh` provides `stack_required`, `stack_profiles`,
   `stack_backends`; `dc()` uses `stack_profiles` for the injected
   `COMPOSE_PROFILES`. `pg`/`redis`/`rabbitmq` have `service.env` with
   `SERVICE_KIND=backend`.
4. `just start` derives the backends-first bring-up from `stack_backends`
   (no hardcoded `pg redis`); with the default profiles it resolves to
   exactly the substrate the active stack needs.
5. **Non-destructive profile-resolution test passes.** For the default
   `COMPOSE_PROFILES` *and* each user profile individually: compute the
   expanded set via `stack_profiles` (with `COMPOSE_PROFILES` overridden to
   the profile under test) and run `docker compose --profile <expanded…> …
   up --dry-run` — must succeed with **no `undefined service`** error.
   `--dry-run` creates nothing; safe on the live stack. (The test must
   exercise the *expanded* set — that is what proves the manifests are
   complete.)
6. `.stack/pg/.generated.env` holds `POSTGRES_SUPERPASS`; no
   `.stack/db.generated.env` remains and no superpass was regenerated. All
   `config.runtime.*`, every `<svc>/.generated.env`, per-svc
   `.config-hashes`, and `litellm/chatgpt/auth.json` resolve under
   `.stack/<svc>/`. No `services/*/config.runtime.*` and no
   `services/litellm/chatgpt/` remain; `services/litellm/README-chatgpt.md`
   is tracked.
7. The live `main` stack, after migration + coordinated recreate, comes up
   healthy (`just status`) with: pg superuser auth intact (a provisioner
   re-run / `psql` as superuser succeeds against the existing volume), each
   service authenticates to its DB (no `*_DB_PASSWORD` regenerated — values
   byte-identical to pre-migration), litellm ChatGPT auth preserved
   (`auth.json` unchanged).
8. Adding a hypothetical new AMQP consumer requires editing only that
   service's `service.env` — `rabbitmq/compose.yaml` is untouched.

## Risks

- **Deleting/regenerating `POSTGRES_SUPERPASS`** → pg superuser + all
  provisioners break against the existing volume. Mitigated: explicit
  `mv db.generated.env → pg/.generated.env` (never delete), step-1 gate,
  acceptance #6/#7. `pg/build.sh` reuses-if-present.
- **Incomplete manifest audit** → `undefined service` at `dc up`. Mitigated by
  acceptance #5 (default + every single profile, on the expanded set).
- **Bind source moved under a running container** → avoided: bind-mounted
  artifacts are `cp`'d (not `mv`'d) until a verified recreate; rollback = the
  untouched originals.
- **A service connects to substrate with neither compose `depends_on` nor an
  obvious env URL** → implementation audit must read each compose's
  `environment:` for `pg`/`redis`/`rabbitmq` hostnames, not just
  `depends_on:`; acceptance #5 catches it only for exercised profiles.
