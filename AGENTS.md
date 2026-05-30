# AGENTS.md

Orientation for coding agents working in this repo. Read this first, then the
deep docs under `docs/` as needed.

## What this is

A personal **Hermes agent stack** for macOS + OrbStack. One CLI (`stack-cli`)
brings up the Hermes agent (in an isolated OrbStack VM) plus supporting Docker
services (memory, LLM gateway, web search, browser automation). See
[README.md](README.md) for the user-facing pitch.

## Layout

```
stack-cli              # bash launcher → bun/node + scripts/cli.ts
scripts/
  cli.ts               # command dispatcher
  commands/            # setup, enable, disable, build, start, stop, info, …
  lib/                 # env, stack, services, dc, compose, orb, secrets, …
  test/                # vitest (lib parsing / upsert / cascade contracts)
services/<svc>/        # one dir per service (see "Adding a service")
.stack.defaults.env    # tracked defaults for first-time setup
.stack/                # gitignored per-stack runtime state (.env, generated configs)
docs/                  # architecture, services, gotchas, development
```

## Dev commands

```bash
bun install            # deps shared by scripts/ and services/*.ts (single root package.json)
bun run typecheck      # tsc --noEmit
bun run test           # vitest run   (tests live in scripts/test/)
bun run format         # prettier --write
```

There are no docker integration tests — end-to-end verification is
`./stack-cli build && ./stack-cli start && ./stack-cli info`.

TypeScript is strict with `verbatimModuleSyntax`; imports use explicit `.ts`
extensions. Both Bun and Node 23+ strip TS at runtime.

## How the CLI works

- `setup` (interactive) → `build` (resolve image digests, fetch pinned sources,
  render configs, gen secrets) → `start` → `stop`. `info` shows runtime state.
- `enable <svc>` cascades `requires` transitively (leaf-first); `disable`
  refuses while a dependant is still enabled.
- **build pipeline:** image-digest resolution → per-service `build.ts`.
- **start pipeline:** backends up → `preflight.ts` → `prestart.ts` →
  `dc up -d` (provisioners run via compose `depends_on`) → `poststart.ts` →
  per-VM `start.ts`.

## Service anatomy

Each `services/<svc>/`:

| File | Role |
|---|---|
| `service.yaml` | **required** descriptor — `runner`, `desc`, `requires`, `litellmKey`, `provides`, `images`/`source`, `env:` block |
| `compose.yaml` | docker services; included by the generated compose |
| `build.ts` | offline pre-build (gen secrets, render templates, fetch source) |
| `preflight.ts` / `prestart.ts` / `poststart.ts` | host-side hooks (mint keys / validate / post-up) |
| `start.ts` | **required** for `runner: vm` |
| `*.template` | rendered → `.stack/<svc>/config.runtime.*` |
| `provision.sql` | one-shot idempotent pg provisioner (via a compose service) |
| `README.md` | per-service levers / lifecycle / security caveats |

`runner: docker` (default) wires a compose profile; `runner: vm` (hermes only)
is an OrbStack VM and skips compose. `kind: backend` hides substrate from the
setup UI. Full descriptor schema: [docs/development.md](docs/development.md),
[docs/architecture.md](docs/architecture.md).

## Architecture invariants — DO NOT BREAK

- **One source of truth.** `.stack/.env` is the *only* place models, keys, and
  enabled services are configured. Don't add a second config file; don't read
  host env vars.
- **`.stack/.env` is block-structured.** Top-level keys at the top; per-service
  declarations live in `#>--- <svc> ---` … `#<--- <svc> ---` blocks managed by
  `enable`/`disable`. User edits inside a block survive round-trips — preserve
  this when touching the upsert logic.
- **Hermetic env.** `dc()` (`lib/dc.ts`) strips the host env to a tight
  allowlist and passes explicit `--env-file`s; `lib/orb.ts` does the same for
  `orb`. Never shell out to `docker compose`/`orb` directly — go through these.
- **Decentralized secrets.** Each service owns its own
  `<SVC>_DB_PASSWORD` etc. in `.stack/<svc>/.generated.env`. No central secrets
  file beyond `.stack/.env`.
- **Idempotent provisioners.** Every provisioner is safe to run on every start
  (`CREATE … IF NOT EXISTS`, `ALTER ROLE … PASSWORD` re-sync).
- **No `container_name:`, no published host ports.** The compose project name
  namespaces everything; services reach each other by service name on the
  default network, and outside callers use OrbStack DNS
  (`<service>.<project>.orb.local`).

## Project conventions (from maintainer)

- **Commits:** no Claude/AI attribution lines. Never override the git author
  email (`-c user.email=…`, `--author=`, `GIT_AUTHOR_EMAIL=`) — just
  `git commit` and let the configured noreply alias apply.
- **Backups:** back up `.stack/` to repo-root `_bak/`, never `/tmp`
  (`.stack/.env` holds secrets).
- **Package manager:** run `bun`/`pnpm`/`npm` normally; don't reach for raw
  binaries to bypass wrappers.
- **Docs:** active specs in `docs/specs/`, active plans in `docs/plans/`;
  shipped pairs move to `docs/plans/implemented/`.

## Going deeper

- [docs/architecture.md](docs/architecture.md) — scoping, secrets, build/start
  pipeline, the `dc()` wrapper, hermetic env, memory backends.
- [docs/services.md](docs/services.md) — per-service reference.
- [docs/gotchas.md](docs/gotchas.md) — read before debugging.
- [docs/development.md](docs/development.md) — adding/modifying a service.
