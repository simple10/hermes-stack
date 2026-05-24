# MissionControl — Self-Hosting Guide

This guide covers running MissionControl on your own infrastructure using Docker
or directly via `wrangler dev`. No Cloudflare account is required — wrangler
creates a local SQLite-backed D1 database automatically.

---

## How it works

The self-host story uses **`wrangler dev`** as the runtime. Wrangler:
- Serves the Cloudflare Workers bundle locally on `localhost:8787`
- Automatically provisions a local SQLite-backed D1 database (stored under
  `.wrangler/state/v3/d1/`)
- Applies migrations from `migrations/combined/` on first start via
  `wrangler d1 migrations apply`

This means there is no separate Node server, no `better-sqlite3`, and no
native build step — the same code that deploys to Cloudflare Workers runs
locally.

---

## Prerequisites

**Docker path (recommended)**

- Docker Engine 24+ (or Docker Desktop 4.26+)
- 256 MB RAM, 1 CPU core minimum
- A persistent volume / directory for wrangler state

**Direct wrangler path (contributors / advanced)**

- Node 22+
- pnpm (`corepack enable` will install the version pinned in `package.json`)
- wrangler installed globally: `npm install -g wrangler`

---

## Install via Docker

### Build the image

The image is not yet published to a public registry. Build it from source:

```sh
git clone <repo-url>
cd services/mission-control
docker build -t mission-control:local .
```

The build step runs `pnpm install` and `pnpm cf:types` inside the container.

### Run a single container

```sh
docker run -d \
  --name mission-control \
  --restart unless-stopped \
  -p 8787:8787 \
  -v mc-data:/data \
  -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  -e MC_ADMIN_TOKEN="$(openssl rand -hex 16)" \
  -e BETTER_AUTH_URL="http://localhost:8787" \
  mission-control:local
```

The container starts `wrangler dev --persist-to /data`. The SQLite-backed D1
state lives at `/data/.wrangler/state/v3/d1/` on the volume.

### Verify it's up

```sh
curl http://localhost:8787/v1/health
# → {"status":"ok"}
```

### Docker Compose

A `compose.yaml` is provided for hermes-stack users. For standalone use:

```yaml
# docker-compose.yml
services:
  mission-control:
    image: mission-control:local
    restart: unless-stopped
    ports:
      - "8787:8787"
    environment:
      BETTER_AUTH_SECRET: "${BETTER_AUTH_SECRET}"
      BETTER_AUTH_URL: "http://localhost:8787"
      MC_ADMIN_TOKEN: "${MC_ADMIN_TOKEN}"
    volumes:
      - mc-data:/data

volumes:
  mc-data:
```

```sh
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
MC_ADMIN_TOKEN=$(openssl rand -hex 16) \
docker compose up -d
```

---

## Install without Docker (wrangler dev directly)

```sh
git clone <repo-url>
cd services/mission-control
pnpm install
pnpm cf:types                 # generate worker-configuration.d.ts
cp .env.example .dev.vars     # edit: set BETTER_AUTH_SECRET, MC_ADMIN_TOKEN
pnpm db:migrate:local         # apply migrations to local D1
pnpm dev                      # wrangler dev → http://localhost:8787
```

---

## Configure environment variables

Set secrets at container start time via `-e` flags or an `.env` file. Never
bake secrets into the image.

| Variable | Required | Default | Description |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | yes | — | 32+ byte secret for session / JWT signing. Generate: `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | yes | — | Public base URL the service is reachable at (e.g. `https://mc.example.com`). Used in auth redirect URLs. |
| `MC_ADMIN_TOKEN` | first boot | — | Admin token for the `/v1/bootstrap` endpoint. Unset or remove after first user is created. |
| `CORS_ALLOWED_ORIGINS` | no | — | Comma-separated browser origins. Empty = no browser clients allowed. |
| `EVENTS_RETENTION_DAYS` | no | `365` | Days before events rows are purged by the nightly cron. |
| `IDEMPOTENCY_TTL_SECONDS` | no | `86400` | How long idempotency keys are retained (seconds). |
| `KEY_ROTATION_GRACE_SECONDS` | no | `300` | Overlap window (seconds) during API key rotation. |

---

## Bootstrap first user

The `/v1/bootstrap` endpoint is only active when `MC_ADMIN_TOKEN` is set and no
users exist. Call it once after the service starts:

```sh
export MC_ADMIN_TOKEN="<the token you set>"
export MC_URL="http://localhost:8787"

curl -X POST "$MC_URL/v1/bootstrap" \
  -H "x-mc-admin-token: $MC_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "changeme123",
    "name": "Admin",
    "orgName": "My Org",
    "orgSlug": "my-org"
  }'
```

The response contains:
- `user.id` — your user ID
- `organization.id` — your org ID
- `pat` — a Personal Access Token (PAT); store it securely

```json
{
  "user": { "id": "usr_...", "email": "admin@example.com" },
  "organization": { "id": "org_...", "name": "My Org", "slug": "my-org" },
  "pat": "mcpat_..."
}
```

After a successful bootstrap you should remove `MC_ADMIN_TOKEN` from the
environment and restart. The endpoint returns 409 if any user already exists,
and 403 if the token is missing or wrong.

Use the PAT as a Bearer token for all subsequent requests:

```sh
curl -H "Authorization: Bearer $PAT" "$MC_URL/v1/me"
```

---

## Backup and restore

### Where wrangler stores D1 data

When running with `--persist-to /data`, wrangler stores the SQLite-backed D1
files at:

```
/data/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite
/data/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite-wal
/data/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite-shm
```

The `<hash>` is derived from the D1 binding name — it stays stable across
restarts for the same wrangler.jsonc configuration.

### Hot backup (container running)

Copy the entire `v3/d1/` directory from the volume:

```sh
docker run --rm \
  -v mc-data:/data \
  -v "$(pwd)/backups":/out \
  alpine sh -c "cp -r /data/.wrangler/state/v3/d1 /out/d1-$(date +%Y%m%d)"
```

Or checkpoint the WAL file first for a clean copy:

```sh
# Checkpoint WAL so the main .sqlite file is fully up to date, then copy
docker run --rm \
  -v mc-data:/data \
  alpine sh -c \
    "sqlite3 /data/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite \
      'PRAGMA wal_checkpoint(TRUNCATE);' && \
     cp /data/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite /out/"
```

### Cold restore

```sh
# Stop the container
docker stop mission-control

# Replace the d1 state directory
docker run --rm \
  -v mc-data:/data \
  -v "$(pwd)/backups":/in \
  alpine sh -c "rm -rf /data/.wrangler/state/v3/d1 && cp -r /in/d1-20260101 /data/.wrangler/state/v3/d1"

# Restart
docker start mission-control
```

---

## Upgrade workflow

Migrations are applied automatically via `wrangler d1 migrations apply` before
`wrangler dev` starts. The Dockerfile handles this in the CMD entrypoint; there
is no manual migration step.

```sh
# 1. Build the new image
docker build -t mission-control:local .

# 2. Stop the running container (graceful shutdown)
docker stop mission-control

# 3. Start the new image (migrations apply automatically at startup)
docker start mission-control
# Or if recreating:
# docker rm mission-control && docker run -d ... mission-control:local
```

With Docker Compose:

```sh
docker compose up -d --build   # rebuild local image and recreate the container
```

Migrations are idempotent: already-applied files are skipped. The schema never
drops data in a migration; columns are only added or constraints relaxed.

---

## Troubleshooting

### Container exits immediately

Check logs:

```sh
docker logs mission-control
```

Common causes:
- `BETTER_AUTH_SECRET` not set — wrangler dev will exit if required env vars
  are missing from `.dev.vars` or the environment.
- Permission error on the volume mount — ensure the volume is writable by the
  `node` user (UID 1000 in the official Node Alpine image).

### Port conflict

Change the host port: `-p 8888:8787` (host 8888 → container 8787).

### `MC_ADMIN_TOKEN` 403 after bootstrap

The bootstrap endpoint returns 409 if any user already exists, regardless of
the token. This is by design. If you need to re-bootstrap (e.g. lost the PAT),
stop the container, delete the D1 state from the volume, and restart.

### Database locked errors

Ensure only one container accesses the wrangler state at a time. SQLite does
not support multiple writers; run a single container instance. For horizontal
scaling, use the Cloudflare Workers + D1 target instead.

### Slow queries / high memory

Run `PRAGMA optimize;` via the sqlite3 CLI against the wrangler state file:

```sh
docker run --rm -v mc-data:/data alpine sh -c \
  "sqlite3 /data/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite 'PRAGMA optimize;'"
```
