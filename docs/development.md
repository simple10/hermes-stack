# Development

## Local setup

```bash
git clone <repo> hermes-stack && cd hermes-stack
bun install            # or pnpm/npm — package.json + node_modules at repo root
```

`./stack-cli` installs deps on first run if `node_modules/` is missing.

## Common dev commands

```bash
bun run typecheck      # tsc --noEmit
bun run test           # vitest run
bun run test:watch     # vitest --watch
bun run format         # prettier --write scripts/ services/*.ts
bun run format:check   # CI mode
```

Tests live under `scripts/test/`. They cover the parsing /
block-aware-upsert / cascade contracts in `lib/`. Each test file gets
a fresh forked process (vitest `pool: "forks"`) so the
`HERMES_STACK_DIR_OVERRIDE` test hook can point `STACK_DIR` at a temp
dir without cross-test contamination.

`vitest --watch` covers the lib code. There are no integration tests
that exercise docker today — verification is `./stack-cli build &&
./stack-cli start && ./stack-cli info`.

## Adding a new service

```
services/<svc>/
  service.env         # required: descriptor (see below)
  compose.yaml        # required for docker services; included by the generated compose
  build.ts            # optional: pre-build (gen secrets, render configs, fetch source)
  preflight.ts        # optional: host script run before main `up` (may dc up deps, mint keys)
  prestart.ts         # optional: fail-loud validation
  poststart.ts        # optional: rare; for hooks needing serving deps
  start.ts            # required for SERVICE_RUNNER=vm
  *.template          # optional: rendered into .stack/<svc>/config.runtime.*
  provision.sql       # optional: one-shot SQL provisioner (referenced from compose.yaml)
  README.md           # one-pager: levers, lifecycle, security caveats
```

### `service.env`

```env
SERVICE_RUNNER=docker            # or "vm"
SERVICE_DESC="Short one-liner"
SERVICE_REQUIRES=pg,litellm      # cross-service deps; transitive (cascade)
SERVICE_LITELLM_KEY=true         # if true, gets a virtual key in LITELLM_VIRTKEYS
SERVICE_KIND=backend             # mark as substrate (hidden from setup UI)
SERVICE_PROFILE=other-name       # override compose profile (defaults to dir name)

SERVICE_STACK_ENV='
# This block gets injected into .stack/.env as #>--- <svc> --- on enable.
# Reference STACK_* presets via ${...}; they expand at config-render time.
NEWSVC_MODEL=${STACK_LLM_MODEL}
NEWSVC_FOO=default-value
'

# Image-class services (no _source/) declare a repo+default pair:
NEWSVC_IMAGE_REPO=ghcr.io/example/newsvc
NEWSVC_IMAGE_DEFAULT=sha256:abc…   # or a tag; `./stack-cli build` resolves to a digest
```

### Phase scripts

Each phase script in `services/<svc>/` exports a default async
function. The orchestrator dynamically imports it via `pathToFileURL`.
Common imports:

```ts
import { resolve } from 'node:path'
import { STACK_ROOT, STACK_DIR } from '../../scripts/lib/paths.ts'
import { stackGet } from '../../scripts/lib/stack.ts'
import { generatedGet, generatedUpsert, generatedGenIfMissing } from '../../scripts/lib/generated.ts'
import { renderTemplate } from '../../scripts/lib/template.ts'
import { stackSource, consumeRebuildFlag } from '../../scripts/lib/source.ts'
import { dc } from '../../scripts/lib/dc.ts'
import { log, warn, die } from '../../scripts/lib/log.ts'

export default async function build(): Promise<void> {
  // ...
}
```

### Provisioners

If your service needs a pg role/db/extension, ship a `provision.sql`
and a one-shot Compose service with
`labels: { com.stack.role: provisioner }`. The real service
`depends_on: <svc>-provision: service_completed_successfully`.
Provisioners run every `start`, idempotently — `CREATE ROLE IF NOT
EXISTS`, `ALTER ROLE … PASSWORD` re-sync, `CREATE DATABASE IF NOT
EXISTS`, `CREATE EXTENSION IF NOT EXISTS`.

Pattern: `services/honcho/{provision.sql, compose.yaml}` — chains two
provisioners (`honcho-provision` for role/db/ext, `honcho-schema` for
the embedding-dim ALTER).

### Templates

Committed: `services/<svc>/foo.yaml.template`.
Rendered: `.stack/<svc>/foo.runtime.yaml` (gitignored).

Use `renderTemplate(template, output, svc)` for copy-once + warn-on-
drift. Use `substituteTemplate(body, env, fallback)` for `__KEY__`
placeholder replacement. Loading `loadStackEnv()` first gives you a
flat `Record<string,string>` with `${VAR}` references already
expanded (via dotenv-expand).

### Source pinning

For `_source/` clones use `await stackSource("<svc>")`. Reads
`<SVC_UC>_SOURCE_REPO` + `<SVC_UC>_SOURCE_DEFAULT` from the service.env;
honors a `<SVC_UC>_VERSION` override in `.stack/.env`. Sets a rebuild
flag in `.stack/<svc>/.generated.env`; consume it with
`consumeRebuildFlag("<svc>")` before calling `dc(["build", "<svc>"])`.

## Architecture invariants

- **One source of truth.** `.stack/.env` is the only place models /
  keys / enabled services are configured. Don't add a second config
  file; don't read host env vars.
- **No `container_name:`.** Compose project name namespaces
  everything. Containers reach each other by service name on the
  default network.
- **No published host ports.** Inside the stack, services talk over
  the default network. Outside, use OrbStack DNS.
- **Hermetic env.** `dc()` strips host env and passes explicit
  `--env-file` args. `lib/orb.ts` does the same for `orb` calls.
- **Decentralized secrets.** Each service owns its own
  `<SVC>_DB_PASSWORD` etc. in `.stack/<svc>/.generated.env`. No
  central secrets file beyond `.stack/.env`.
- **Idempotent provisioners.** Every provisioner is safe to run on
  every start. No first-time-only flags.

## What's in `node_modules` and where

Single top-level `package.json` + `node_modules/` at the repo root.
Both `scripts/` and `services/*/*.ts` resolve the same way. This is
intentional — services need `yaml`, `zx`, etc. without a per-service
package.json.

## Style

`prettier` config in `.prettierrc`. Run `bun run format` (or let your
editor handle it). CI should fail on `format:check`.

TypeScript strict; `verbatimModuleSyntax: true`. Imports use the
`.ts` extension explicitly (`allowImportingTsExtensions`). Bun and
Node 23+ both strip TS at runtime.

## Cutting a release

There's no release flow today. Bump component versions via the
`<SVC>_VERSION` levers in `.stack/.env`, `./stack-cli build` (auto-
detects + rebuilds), `./stack-cli restart`.
