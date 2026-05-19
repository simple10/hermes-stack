# Stack config & cross-service dependency cleanup — design

Date: 2026-05-19
Status: approved (pending spec review)

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
| `services/postgres/compose.yaml` (`pg`) | no `profiles:` (always-on) | `profiles: [pg]` |
| `services/redis/compose.yaml` (`redis`) | no `profiles:` (always-on) | `profiles: [redis]` |
| `services/rabbitmq/compose.yaml` (`rabbitmq`) | `profiles: ["firecrawl"]` | `profiles: [rabbitmq]` |

**Rule:** every single-service substrate profile's name **equals its service
name** (`pg`, `redis`, `rabbitmq`). This makes a required name usable both as a
`COMPOSE_PROFILES` entry *and* as a `dc up -d <name>` target with no lookup.

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
  runtime via env URL even when there is no explicit compose `depends_on`.

Starting table from the current audit (implementation must re-verify every
compose; mark "—" for none, omit the file when empty):

| Service dir | `service.env` | Reason |
|---|---|---|
| `postgres` | `SERVICE_KIND=backend` | substrate (service `pg`, profile `pg`) |
| `redis` | `SERVICE_KIND=backend` | substrate |
| `rabbitmq` | `SERVICE_KIND=backend` | substrate |
| `litellm` | `SERVICE_REQUIRES=pg,redis` | provision→pg; `REDIS_URL` redis (no compose depends_on) |
| `honcho` | `SERVICE_REQUIRES=pg,redis` | `CONNECTION_URI` pg; `redis://redis` |
| `hindsight` | `SERVICE_REQUIRES=pg` | provision.sql / `@pg:` |
| `firecrawl` | `SERVICE_REQUIRES=redis,rabbitmq,litellm` | depends_on redis, rabbitmq, **litellm (cross-profile)**; uses own `firecrawl-postgres`, **not** shared `pg` |
| `honcho-ui` | `SERVICE_REQUIRES=honcho` | depends_on `honcho-api` (cross-profile) |
| `agentmemory` | — (verify) | LiteLLM consumer via env; verify in implementation |
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
  <svc>/
    .generated.env                  # was .stack/<svc>.generated.env
    config.runtime.{yaml,toml}      # was services/<svc>/config.runtime.*
    .config-hashes/<file>.sha256    # was .stack/.config-hashes/<svc>.<file>.sha256
  litellm/
    chatgpt/                        # was services/litellm/chatgpt/  (live auth tokens)
```

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
- **`services/litellm/build.sh`, `services/honcho/build.sh`**: render into
  `.stack/<svc>/config.runtime.*`; read/write the DB password only from
  `.stack/<svc>/.generated.env`. The legacy `db.generated.env` fallback line
  is **removed** (values are preserved by the one-time manual migration).
- **`just reconfigure svc`**: back up + re-render under `.stack/<svc>/`.
- **`.gitignore`**: remove now-dead `services/*/config.runtime.*` and
  `services/*/chatgpt/` entries — `.stack/` is already gitignored wholesale,
  so no stack-state remains tracked-but-ignored in the git tree.

---

## Migration runbook (one-time, `main`, performed by hand)

The live `main` `.stack/` is migrated once during implementation. No fallback
code ships. Moving bound files does **not** kill running containers (they keep
the old inode until recreated), so this is non-destructive to the shared live
stack until a coordinated recreate.

1. Verify per-service generated envs already hold the DB passwords
   (`LITELLM_DB_PASSWORD` in `.stack/litellm.generated.env`,
   `HONCHO_DB_PASSWORD` in `.stack/honcho.generated.env`). They do, from prior
   builds; abort if not.
2. `mkdir -p .stack/<svc>` and `mv .stack/<svc>.generated.env
   .stack/<svc>/.generated.env` for `litellm honcho hindsight firecrawl`
   (guard each with `[ -f ]`).
3. `mv services/litellm/config.runtime.yaml .stack/litellm/config.runtime.yaml`;
   `mv services/litellm/chatgpt .stack/litellm/chatgpt`;
   `mv services/honcho/config.runtime.toml .stack/honcho/config.runtime.toml`;
   `mv services/cliproxyapi/config.runtime.yaml
   .stack/cliproxyapi/config.runtime.yaml` (each guarded with `[ -e ]`).
4. `mkdir -p .stack/<svc>/.config-hashes`; move
   `.stack/.config-hashes/<svc>.<file>.sha256`
   → `.stack/<svc>/.config-hashes/<file>.sha256`; `rmdir .stack/.config-hashes`.
5. Delete the now-vestigial `.stack/db.generated.env` (only after step 1
   verification passes).
6. Land the code changes, then a **coordinated** `just build` (re-render is a
   no-op: files already moved) + recreate to rebind containers to the new
   paths.

**Concurrent-agent coordination.** `main` is sometimes worked by multiple
agents against one live shared stack (`aitools`). The compose bind-path change
takes effect only when containers are recreated; until then running containers
keep working on the old inode. The recreate must therefore be coordinated with
any other agent on this checkout (do not unilaterally `just down`/destroy
shared pg data — non-destructive recreate only).

---

## Acceptance criteria

1. `services/rabbitmq/compose.yaml` has `profiles: [rabbitmq]`; `pg`/`redis`
   have `profiles: [pg]`/`[redis]`.
2. `lib/stacklib.sh` provides `stack_required`, `stack_profiles`,
   `stack_backends`; `dc()` uses `stack_profiles` for the injected
   `COMPOSE_PROFILES`. `postgres`/`redis`/`rabbitmq` have
   `service.env` with `SERVICE_KIND=backend`.
3. `just start` derives the backends-first bring-up from `stack_backends`
   (no hardcoded `pg redis`); with the default profiles it resolves to
   exactly the substrate the active stack needs.
4. **Non-destructive profile-resolution test passes** for: the default
   `COMPOSE_PROFILES`, and each profile individually — using
   `dc … up -d --dry-run` (or `dc config`) which must succeed with **no
   `undefined service`** error. (Run against the live stack — `--dry-run`
   creates nothing.)
5. All `config.runtime.*`, `<svc>/.generated.env`, per-svc `.config-hashes`,
   and `litellm/chatgpt/` resolve under `.stack/<svc>/`; no
   `services/*/config.runtime.*` or `services/*/chatgpt/` remains; the
   corresponding `.gitignore` lines are removed.
6. The live `main` stack, after migration + coordinated recreate, comes up
   healthy (`just status`) with unchanged DB passwords (pg auth intact) and
   unchanged litellm ChatGPT auth (tokens preserved).
7. Adding a hypothetical new AMQP consumer requires editing only that
   service's `service.env` — `rabbitmq/compose.yaml` is untouched.

## Risks

- **Incomplete manifest audit** → `undefined service` at `dc up`. Mitigated by
  acceptance test #4 (covers default + every single profile).
- **Recreate timing on shared stack** → mitigated by the coordination note;
  migration `mv`s are non-destructive to running containers.
- **A service connects to substrate with neither compose `depends_on` nor an
  obvious env URL** → caught by acceptance test #4 only if that profile is
  exercised; implementation audit must read each compose's `environment:` for
  `pg`/`redis`/`rabbitmq` hostnames, not just `depends_on:`.
