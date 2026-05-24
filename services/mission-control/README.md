# MissionControl

MissionControl is a multi-tenant kanban API for coordinating work across agent instances. It provides a single REST surface for creating projects, tasks, agents, and connectors; tracking state transitions; and streaming an audit log of every mutation. It ships as a Cloudflare Workers + D1 deployment for SaaS use and as a Docker image backed by SQLite for self-hosted teams.

**Status:** v1 draft — feature-complete, production-hardened for single-pool deployments.
See [`docs/specs/2026-05-22-master-api-design.md`](docs/specs/2026-05-22-master-api-design.md) for the full design spec.

---

## Quick start — contributor dev (Cloudflare Workers)

This project uses **pnpm** (pinned via `packageManager` in `package.json`).
If you don't have pnpm, run `corepack enable` once — Node ships with Corepack
which will manage the right version automatically.

```sh
pnpm install
cp .env.example .dev.vars   # then edit: set BETTER_AUTH_SECRET, MC_ADMIN_TOKEN
pnpm db:migrate:local        # apply migrations to local D1
pnpm dev                     # wrangler dev → http://localhost:8787
pnpm test                    # run vitest suite (requires wrangler D1 + miniflare)
```

### Bootstrap first user (dev)

```sh
curl -X POST http://localhost:8787/v1/bootstrap \
  -H "x-mc-admin-token: $MC_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"email":"you@example.com","password":"changeme123","name":"You","orgName":"Acme","orgSlug":"acme"}'
# Response includes a PAT — use it as Bearer token for all other requests.
```

---

## Quick start — self-host via Docker

```sh
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

See [`docs/self-hosting.md`](docs/self-hosting.md) for the full guide, including backup/restore and upgrade workflow.

---

## Production deploy — Cloudflare Workers

1. Create D1 databases in the Cloudflare dashboard (or via `wrangler d1 create`).
2. Update `wrangler.toml` with the real `database_id` values.
3. Set secrets:
   ```sh
   wrangler secret put BETTER_AUTH_SECRET
   wrangler secret put MC_ADMIN_TOKEN
   ```
4. Apply migrations and deploy:
   ```sh
   pnpm db:migrate:remote
   pnpm deploy
   ```
5. Bootstrap the first user via `POST /v1/bootstrap` with the `x-mc-admin-token` header.

---

## Architecture

MissionControl is a Hono application on Cloudflare Workers (Module Worker format) backed by two tiers of D1 — a master DB for identity (users, orgs, API keys via better-auth) and per-org pool DBs for work data (projects, tasks, agents, connectors, events). In self-host / single-DB mode both tiers collapse into a single SQLite file. See the [spec](docs/specs/2026-05-22-master-api-design.md) for the full two-tier sharding design, auth flows, and event model.

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

## License

MIT — see [LICENSE](LICENSE).
