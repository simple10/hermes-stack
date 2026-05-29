# Architecture

How the stack is laid out and why.

## Repo layout

```
hermes-stack/
  stack-cli                    # bash launcher → bun/node + scripts/cli.ts
  package.json                 # repo-root; deps shared by scripts/ + services/*.ts
  tsconfig.json
  vitest.config.ts
  scripts/
    cli.ts                     # dispatcher
    commands/                  # setup, enable, disable, build, start, stop, info, …
    lib/                       # env, stack, services, dc, compose, orb, …
    test/                      # vitest
  services/<svc>/
    service.yaml               # service descriptor (runner/requires/litellm-key/stack-env block)
    compose.yaml               # for docker services; included by stack-cli's generated compose
    build.ts                   # offline pre-build (gen secrets, render configs, fetch source)
    preflight.ts               # may bring deps up + mint keys (host-side)
    prestart.ts                # fail-loud validation
    poststart.ts               # rare; for hooks needing serving deps
    start.ts                   # VM services only
    README.md
  .stack.defaults.env          # tracked defaults for first-time setup
  .stack/                      # gitignored runtime state (see below)
  docs/
```

## Per-stack scoping

Every stack is one Docker Compose project, named by
`COMPOSE_PROJECT_NAME` in `.stack/.env` (default `aitools`). The
project name scopes:

- **Containers**: `<project>-<service>-N` (e.g. `aitools-litellm-1`).
- **Networks**: `<project>_default`.
- **Volumes**: `<project>_pg-data`, etc.
- **OrbStack DNS**: `<service>.<project>.orb.local`.
- **VMs**: `<project>-<service>` (e.g. `aitools-hermes`).

To run several stacks side-by-side, check out the repo into a separate
directory and use a distinct project name. Each stack is fully
isolated; nothing crosses unless you wire it explicitly.

`stack-cli` derives the project name from `.stack/.env`'s
`COMPOSE_PROJECT_NAME`; nothing depends on the directory name.

## The `.stack/` directory

All per-stack runtime state lives here. Gitignored in full.

```
.stack/
  .env                         # top-level secrets + #>--- <svc> --- blocks
  docker-compose.yaml          # GENERATED include: list (see below)
  <svc>/
    .generated.env             # machine-owned: minted keys, resolved digests, source SHAs, DB pw
    config.runtime.*           # rendered runtime configs (from committed *.template)
    .config-hashes/            # sha256s used to warn on template drift
  litellm/chatgpt/auth.json    # OAuth token if you use ChatGPT-sub
```

`.stack/.env` is the **only** place models, keys, and enabled services
are configured. It's split into:

- **Top-level keys** at the top: project name, provider API keys
  (OpenRouter, Voyage, etc.), stack-wide model levers
  (`STACK_LLM_MODEL`, `STACK_LLM_MODEL_FAST`, `STACK_LLM_EMBEDDING_MODEL`),
  `COMPOSE_PROFILES`, `STACK_MACHINES`.
- **Block sections** delimited by `#>--- <svc> ---` / `#<--- <svc> ---`,
  managed by `./stack-cli enable`/`disable`. Each enabled service's
  declarations from its `env:` block get appended here. User edits
  inside the block survive enable/disable round-trips.

Block-aware writes mean per-service settings (e.g. `HERMES_MEMORY`,
`HONCHO_DERIVER_MODEL`) live next to the service they belong to,
not in a flat top-level dump.

## Service descriptors (`services/<svc>/service.yaml`)

Each service is described by a single `service.yaml`:

```yaml
runner: docker # or "vm" (default docker)
desc: "What it does"
requires: [pg, redis, litellm] # cross-service deps (transitive)
litellmKey: true # mint a litellm virtual key for it
kind: backend # mark as substrate (hidden from setup list)
provides: # user-facing endpoints (rendered by `info` / `start`)
  api: { port: 8000, service: honcho-api } # service: = orb DNS name (default = dir)
  dashboard: # https -> bare auto-HTTPS domain; auth shown under the URL by `info`
    port: 4000
    proto: https
    path: /ui
    auth: { user: admin, pass: "${LITELLM_MASTER_KEY}" } # literals public; ${VAR} masked unless --show-pass
images: # digest-class build metadata (keyed by the *_VERSION knob prefix)
  HONCHO: { repo: ghcr.io/example/honcho, default: sha256:… }
source: { repo: https://github.com/…, default: <sha> } # source-class build metadata
env: | # literal block injected verbatim into the #>--- <svc> --- section of .stack/.env
  HONCHO_DERIVER_MODEL=${STACK_LLM_MODEL_FAST}
  HONCHO_DIALECTIC_MODEL=${STACK_LLM_MODEL}
```

All fields are optional except an implied `runner`. `provides` drives the
URLs shown by `info` and `start`; the render rule is deterministic —
`proto: https` or port 80/443 → bare `https://<host>[path]`, datastore
proto (`postgres`/`redis`/`amqp`) → `proto://<host>:<port>`, otherwise
`http://<host>:<port>[path]`. The host is OrbStack DNS:
`<service>.<project>.orb.local` for containers, `<project>-<svc>.orb.local`
for VMs.

An endpoint may also declare an ordered `auth:` map of credential hints that
`info` renders under the URL. Literal values (`user: admin`) are public;
`${VAR}` references are secrets — shown as the bare `$VAR` name by default and
resolved (from `.stack/.env` + generated overlays) only with `info --show-pass`.

`./stack-cli enable <svc>` cascades `requires` transitively
(leaf-first), so enabling `hermes` auto-enables `litellm`, which
auto-enables `pg` and `redis`. `disable` refuses if anything still
depends on the target — no force flag; the user disables dependants
first.

## The build pipeline (`./stack-cli build`)

Two phases:

1. **Image-digest resolution.** Walks every `service.yaml` `images:`
   entry (`<NAME>: { repo, default }`), resolves each to a
   concrete digest via `docker buildx imagetools inspect`, writes
   `*_IMAGE=repo@digest` + lock state into `.stack/<svc>/.generated.env`.
   Compose's `include:` parses every file regardless of profile, so
   these values must always be resolved.

2. **Per-service `build.ts`.** For each enabled service plus each
   enabled VM, runs `services/<svc>/build.ts` if present. Typical
   responsibilities: render `*.template` → `.stack/<svc>/config.runtime.*`,
   own the service's `<SVC>_DB_PASSWORD` (decentralized; one per
   service), `git clone --checkout` pinned `_source/` directories,
   eager `dc build` when source has changed.

## The start pipeline (`./stack-cli start`)

```
backends-first up -d   →   per-service preflight.ts   →
per-service prestart.ts   →   dc up -d (everything else, provisioners run via depends_on)   →
per-service poststart.ts   →   per-VM start.ts   →   start-cleanup (optional)
```

The backends step brings up substrate that other things depend on
(currently `pg`, `redis`, optionally `rabbitmq`). Preflight runs
host-side and can `dc up -d <dep>` + mint keys before the main `up`
(LiteLLM does this — it brings itself up and mints one virtual key
per `LITELLM_VIRTKEYS` alias). Prestart is fail-loud validation only.
Then the main `dc up -d` brings everything else, with in-tree
provisioners running via Compose `depends_on:
service_completed_successfully` gates.

### Provisioners

A provisioner is a one-shot Compose service with
`labels: [com.stack.role=provisioner]` that initializes role/db/
extension/schema for a real service. It runs every start,
idempotently (role-if-absent + ALTER ROLE … PASSWORD re-sync + db-if-
absent + CREATE EXTENSION IF NOT EXISTS). The real service uses
`depends_on: <svc>-provision: service_completed_successfully`.

Adding a new pg-using service is purely additive: each service ships
a `provision.sql` + a one-shot Compose entry. No central `00-init.sql`.

## The dc() wrapper

`stack-cli` never shells out to `docker compose` directly. All calls
go through `lib/dc.ts`, which:

- Injects `-p <project>` from `.stack/.env`.
- Passes `--env-file .stack/.env` plus every
  `.stack/*/.generated.env` (absolute paths).
- Strips the host environment to a tight docker-operational allowlist
  (PATH, HOME, DOCKER_*, *_PROXY, etc.) before spawning.

The strip matters because Compose interpolation precedence is
host-env > `--env-file`. A stray exported `POSTGRES_SUPERPASS` or
`COMPOSE_PROFILES` would silently outrank the real `.stack` value
without the strip; we'd never know.

`COMPOSE_PROJECT_NAME` and `COMPOSE_PROFILES` are also injected
explicitly so they don't depend on env-file precedence rules.

## OrbStack DNS and isolation

Containers reach each other on the per-project default network by
plain service name. Anything outside the project (Hermes, your Mac
browser) reaches services via OrbStack's `<service>.<project>.orb.local`
DNS — auto-HTTPS too, so the honcho-ui at
`https://honcho-ui.<project>.orb.local` Just Works.

The Hermes VM is created with `--isolated --isolate-network`:

- `--isolated` removes Mac filesystem sharing (no `$HOME` access; no
  Mac clipboard integration).
- `--isolate-network` blocks Mac IPs and sibling VMs.

A compromised Hermes can still reach this stack's containers via
OrbStack DNS, but it cannot reach the Mac. The trust boundary is
"this docker network" — see `docs/gotchas.md` for the multi-stack
caveat.

## Hermetic env handling

The CLI never trusts the ambient shell:

- `STACK_ROOT` is derived from `lib/paths.ts`'s own location, not env.
- `dc()` strips the host env to a tight allowlist.
- `lib/orb.ts` scrubs `HTTP_PROXY` etc. before spawning `orb` (OrbStack
  forwards proxy vars into the VM, which combined with `--isolate-network`
  turns into curl-(7) for everything the VM tries to install).
- Tests use `HERMES_STACK_DIR_OVERRIDE` to point at temp dirs without
  touching the real `.stack/`.

The single source of truth is `.stack/.env`. Period.

## Memory backends

Hermes can use one of:

- **honcho** (default) — graph-based; recommended.
- **hindsight** — vector + reranker.
- **agentmemory** — fast file-based via an MCP shim.
- **holographic** — fully local in the VM, no service.
- **default** — leave Hermes' own default unchanged.

`./stack-cli setup` asks. If you pick a backend that needs a
docker service and you didn't enable that service, setup offers to
cascade-enable it (or print a manual-config note if you decline).
