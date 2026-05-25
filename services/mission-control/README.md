# MissionControl

MissionControl is a multi-tenant kanban API for coordinating work across agent instances. It provides a single REST surface for creating projects, tasks, agents, and connectors; tracking state transitions; and streaming an audit log of every mutation. It ships as a Cloudflare Workers + D1 deployment for SaaS use and as a Docker image running `wrangler dev` against a local SQLite-backed D1 for self-hosted teams.

**Status:** v1 draft — feature-complete, production-hardened for single-pool deployments.
See [`docs/specs/2026-05-22-master-api-design.md`](docs/specs/2026-05-22-master-api-design.md) for the full design spec.

---

## Quick start — contributor dev (Cloudflare Workers)

This project uses **pnpm** (pinned via `packageManager` in `package.json`).
If you don't have pnpm, run `corepack enable` once — Node's Corepack will
install the right version automatically.

**Wrangler is NOT a project dep** — install it globally once:
`npm install -g wrangler` (or `pnpm add -g wrangler`).

```sh
pnpm install                 # installs deps (wrangler stays global)
pnpm cf:types                # generate worker-configuration.d.ts from wrangler.jsonc
cp .env.example .dev.vars    # then edit: set BETTER_AUTH_SECRET, MC_ADMIN_TOKEN
pnpm db:migrate:local        # apply migrations to local D1
pnpm dev                     # wrangler dev → http://localhost:8787
pnpm test                    # run vitest suite (requires wrangler D1 + miniflare)
```

Re-run `pnpm cf:types` any time you change bindings in `wrangler.jsonc`
(new D1 binding, new env var, new compatibility flag, etc.).

### Bootstrap first user (dev)

```sh
curl -X POST http://localhost:8787/v1/bootstrap \
  -H "x-mc-admin-token: $MC_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"changeme123","name":"You","orgName":"Acme","orgSlug":"acme"}'
# Response includes a PAT — use it as Bearer token for all other requests.
```

---

## Quick start — self-host via Docker (wrangler dev)

The container runs `wrangler dev` against a local SQLite-backed D1 — no
Cloudflare account required. State is persisted to `/data` on the volume.

```sh
# Build from source
git clone <repo-url>
cd services/mission-control
docker build -t mission-control:local .

# Run
docker run -d \
  --name mission-control \
  -p 8787:8787 \
  -v mc-data:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e MC_ADMIN_TOKEN="$(openssl rand -hex 16)" \
  -e BETTER_AUTH_URL="http://localhost:8787" \
  mission-control:local
```

Or with Docker Compose (hermes-stack users):

```sh
# In .stack/.env:
#   BETTER_AUTH_SECRET=<32 random bytes hex>
#   MC_ADMIN_TOKEN=<admin token>

just build mission-control   # builds the image
just enable mission-control  # adds to docker compose profile
just start                   # brings up all enabled services
```

**No-Docker self-host** (clone + run locally):

```sh
pnpm install
pnpm cf:types
cp .env.example .dev.vars     # set BETTER_AUTH_SECRET, MC_ADMIN_TOKEN
pnpm db:migrate:local         # apply migrations to local D1
pnpm dev                      # wrangler dev → http://localhost:8787
```

See [`docs/self-hosting.md`](docs/self-hosting.md) for the full guide, including backup/restore and upgrade workflow.

---

## Production deploy — Cloudflare Workers

1. Create D1 databases in the Cloudflare dashboard (or via `wrangler d1 create`).
2. Update `wrangler.jsonc` with the real `database_id` values.
3. Regenerate types after editing wrangler.jsonc: `pnpm cf:types`.
4. Set secrets:
   ```sh
   wrangler secret put BETTER_AUTH_SECRET
   wrangler secret put MC_ADMIN_TOKEN
   ```
5. Apply migrations and deploy:
   ```sh
   pnpm db:migrate:remote
   pnpm deploy
   ```
5. Bootstrap the first user via `POST /v1/bootstrap` with the `x-mc-admin-token` header.

---

## Architecture

MissionControl is a Hono application on Cloudflare Workers (Module Worker format) backed by two tiers of D1 — a master DB for identity (users, orgs, API keys via better-auth) and per-org pool DBs for work data (projects, tasks, agents, connectors, events). In self-host / single-DB mode both tiers collapse into a single local SQLite file managed by `wrangler dev`. See the [spec](docs/specs/2026-05-22-master-api-design.md) for the full two-tier sharding design, auth flows, and event model.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | yes | — | 32+ byte random secret for JWT signing |
| `BETTER_AUTH_URL` | yes | — | Public base URL (e.g. `https://mc.example.com`) |
| `DB_MODE` | no | `single` | `single` (self-host) or `split` (multi-pool SaaS) |
| `MC_ADMIN_TOKEN` | first boot | — | Token for `/v1/bootstrap`; unset after first user |
| `CORS_ALLOWED_ORIGINS` | no | — | Comma-separated browser origins |
| `EVENTS_RETENTION_DAYS` | no | `365` | Days before events rows are purged |
| `IDEMPOTENCY_TTL_SECONDS` | no | `86400` | Idempotency key TTL |
| `KEY_ROTATION_GRACE_SECONDS` | no | `300` | Overlap window during API key rotation |

See [`.env.example`](.env.example) for the full list.

---

## API reference

Full endpoint documentation is in the [spec](docs/specs/2026-05-22-master-api-design.md).

Key routes:

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/bootstrap` | First-run: create admin user + org + PAT |
| `GET/POST` | `/v1/auth/*` | better-auth flows (sign-up, sign-in, orgs, API keys) |
| `GET` | `/v1/me` | Current user + org membership |
| `GET/POST` | `/v1/agents` | Agent registry |
| `GET/POST` | `/v1/connectors` | Connector registry |
| `GET/POST` | `/v1/projects` | Project management |
| `GET/POST/PATCH/DELETE` | `/v1/tasks` | Task lifecycle + state machine |
| `GET/POST/DELETE` | `/v1/tasks/:id/comments` | Task comments |
| `GET/POST/DELETE` | `/v1/external_refs` | Polymorphic external references |
| `GET` | `/v1/health` | Health check (no auth) |

---

## Testing

```sh
pnpm test          # vitest run (requires local wrangler D1 / miniflare)
pnpm typecheck     # tsc --noEmit
```

**Note:** running `pnpm test` against all 19 test files concurrently can trip
Miniflare port exhaustion on Node 23. If you hit `EADDRNOTAVAIL`, run files
individually:

```sh
for f in $(find test -name "*.test.ts" | sort); do pnpm vitest run "$f"; done
```

Tests use `@cloudflare/vitest-pool-workers` to run inside a miniflare Workers environment with a real D1 binding. Each test file calls `applyD1Migrations` in a `beforeAll` hook to ensure a fresh, migrated DB for every isolation scope.

---

## UI (SPA — `web/`)

A React SPA lives at `services/mission-control/web/` and is served from the
same Worker via the Cloudflare Workers Assets binding. The Cloudflare Vite
plugin (`@cloudflare/vite-plugin`) builds both the SPA and the Worker in
one pass and runs them together under `pnpm dev` (single port, single
process, unified HMR).

```sh
pnpm dev           # Vite dev server + Worker in-process via miniflare → http://localhost:5173
pnpm build         # → web/dist/client/ (SPA) + dist/<worker>/ (Worker bundle + generated wrangler.json)
pnpm test:web      # Vitest + happy-dom + RTL + MSW component/unit tests
pnpm bundle:report # vite build + du -sh report; budget: 500 KB gzipped SPA
```

Routing: TanStack Router (file-based, paths under `web/src/routes/`).
Auth UI: better-auth-ui shadcn registries (`auth.json`, `settings.json`,
`user-button.json`) — components live under `web/src/components/auth/`.
Operator screens (agents, connectors, projects, PATs, org / members /
invitations): shadcn primitives + better-auth React client.
Read-only screens: tasks list/detail, virtualized events viewer.

See [`docs/specs/2026-05-24-mc-ui-design.md`](../../docs/specs/2026-05-24-mc-ui-design.md)
for the full UI design + the
[`docs/plans/2026-05-24-mc-ui.md`](../../docs/plans/2026-05-24-mc-ui.md)
implementation plan.

### Operating versions

- **Wrangler:** ≥ 4.93.0 globally (required by `@cloudflare/vite-plugin`).
  Pinned via `pnpm.overrides` so the peer-dep resolution sees a compatible
  version without adding wrangler as a project dep.
- **Node:** ≥ 22 (the `engines` field says 22+; tested on 23.8.0 locally).
- **ESLint:** uses `typescript-eslint` for the parser + `eslint-plugin-import`
  with `eslint-import-resolver-typescript` for transitive-import checks.
  `pnpm lint` exits 0 with informational `any` warnings; CI should treat
  errors as blocking and warnings as advisory. Replaces the original
  dependency-cruiser-based plan which didn't run on Node 23.x.
- **shadcn add workflow:** `web/package.json` is a stub that exists only
  because shadcn's CLI requires a package.json in the SPA directory. After
  each `pnpm dlx shadcn add` run, move any new entries from `web/package.json`'s
  `dependencies` up to the parent `services/mission-control/package.json`,
  then reset `web/package.json` back to the stub form. Stray `web/pnpm-lock.yaml`
  files should be `git rm`-ed.

### Email (Cloudflare Email Service)

The UI requires email verification (`requireEmailVerification: true` in
the better-auth config). Outbound mail goes through Cloudflare Email
Service via the `EMAIL` binding declared in `wrangler.jsonc`. All
sending code lives in `src/auth/email.ts` — to swap providers
(MailChannels, Resend, SES) edit only that file.

Setup for production: the sender domain (`EMAIL_FROM` env var, e.g.
`no-reply@mc.example.com`) must use Cloudflare DNS; CES adds the SPF,
DKIM, and DMARC records during onboarding.

In dev/test where `EMAIL_FROM` is unset, `sendEmail` logs and returns
without dispatching — sign-up + verify flows still work end-to-end (the
bootstrap user is pre-verified in `routes/bootstrap.ts`).

### Web bundle budget

Soft cap: **500 KB gzipped** for the SPA JS bundle. Current at v1: ~353 KB
gzipped (71% of budget) — comfortable headroom for additional screens
without restructuring.

Run `pnpm bundle:report` after meaningful additions to check.

---

## License

MIT — see [LICENSE](LICENSE).
