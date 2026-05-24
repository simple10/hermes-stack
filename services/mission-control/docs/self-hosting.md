# MissionControl — Self-Hosting Guide

This guide covers running MissionControl on your own infrastructure using Docker
(or plain Node 22+). No Cloudflare account is required.

---

## Prerequisites

**Docker path (recommended)**

- Docker Engine 24+ (or Docker Desktop 4.26+)
- 256 MB RAM, 1 CPU core minimum
- A persistent volume / directory for the SQLite file

**Node path (advanced)**

- Node 22+ (for `--experimental-strip-types`)
- `pnpm install` (includes `better-sqlite3` which requires a C++ toolchain). If you don't have pnpm, run `corepack enable` first — Node's Corepack will install the version pinned in `package.json`.
- A writable path for the SQLite file

---

## Install via Docker

### Pull / build the image

The image is not yet published to a public registry. Build it from source:

```sh
git clone <repo-url>
cd services/mission-control
docker build -t mission-control:local .
```

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

The container applies pending migrations automatically on every start before
accepting requests.

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
      DB_MODE: single
      NODE_ENV: production
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

## Configure environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | yes | — | 32+ byte secret for session / JWT signing. Generate: `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | yes | — | Public base URL the service is reachable at (e.g. `https://mc.example.com`). Used in auth redirect URLs. |
| `MC_ADMIN_TOKEN` | first boot | — | Admin token for the `/v1/bootstrap` endpoint. Unset or remove after first user is created. |
| `MC_DB_PATH` | no | `/data/mc.sqlite` | Path to the SQLite database file inside the container. |
| `PORT` | no | `8787` | Port the server listens on inside the container. |
| `CORS_ALLOWED_ORIGINS` | no | — | Comma-separated browser origins. Empty = no browser clients allowed. |
| `EVENTS_RETENTION_DAYS` | no | `365` | Days before events rows are purged by the nightly cron. |
| `IDEMPOTENCY_TTL_SECONDS` | no | `86400` | How long idempotency keys are retained (seconds). |
| `KEY_ROTATION_GRACE_SECONDS` | no | `300` | Overlap window (seconds) during API key rotation. |

Set secrets at container start time via `-e` flags or an `.env` file. Never bake
secrets into the image.

---

## Bootstrap first user

The `/v1/bootstrap` endpoint is only active when `MC_ADMIN_TOKEN` is set and no
users exist. Call it once after the container starts:

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
environment and restart the container. The endpoint returns 409 if any user
already exists, and 403 if the token is missing or wrong.

Use the PAT as a Bearer token for all subsequent requests:

```sh
curl -H "Authorization: Bearer $PAT" "$MC_URL/v1/me"
```

---

## Backup and restore

The entire database is a single SQLite file at `MC_DB_PATH` (default
`/data/mc.sqlite`). SQLite runs in WAL mode, so a plain file copy is safe as
long as you also copy the WAL file (`mc.sqlite-wal`) and SHM file
(`mc.sqlite-shm`) atomically.

### Hot backup (container running)

The safest approach is an online backup via the SQLite backup API:

```sh
# Run a backup inside the container
docker exec mission-control \
  sqlite3 /data/mc.sqlite ".backup /data/mc-backup-$(date +%Y%m%d).sqlite"
```

Or copy the files out after checkpointing the WAL:

```sh
# Checkpoint WAL so the main file is fully up to date
docker exec mission-control \
  sqlite3 /data/mc.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"

# Copy from the named volume
docker run --rm \
  -v mc-data:/data \
  -v "$(pwd)/backups":/out \
  alpine cp /data/mc.sqlite /out/mc-$(date +%Y%m%d).sqlite
```

### Cold restore

```sh
# Stop the container
docker stop mission-control

# Replace the database file
docker run --rm \
  -v mc-data:/data \
  -v "$(pwd)/backups":/in \
  alpine cp /in/mc-20260101.sqlite /data/mc.sqlite

# Restart
docker start mission-control
```

---

## Upgrade workflow

Migrations run automatically on container start; there is no manual migration
step.

```sh
# 1. Build the new image
docker build -t mission-control:local .

# 2. Stop the running container (graceful shutdown)
docker stop mission-control

# 3. Start the new image (migrations apply automatically)
docker start mission-control
# Or if you need to recreate:
# docker rm mission-control && docker run -d ... mission-control:local
```

With Docker Compose:

```sh
docker compose pull      # if using a published image
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
- `BETTER_AUTH_SECRET` not set → fatal error at startup.
- SQLite file permissions — ensure the volume mount is writable by the `node`
  user (UID 1000 in the official Node Alpine image).

### `ENOENT` on migration directory

The container expects `migrations/combined/` to exist alongside `src/`. If you
built a custom image that omitted it, rebuild from the repository root.

### Port conflict

Change the host port: `-p 8888:8787` (host 8888 → container 8787).

### `MC_ADMIN_TOKEN` 403 after bootstrap

The bootstrap endpoint returns 403 if any user already exists, regardless of the
token. This is by design. If you need to re-bootstrap (e.g. lost the PAT), stop
the container, delete the database, and restart from scratch — or use the
better-auth admin APIs to create additional users.

### Database locked errors

Ensure only one container accesses the SQLite file at a time. SQLite does not
support multiple writers across processes; run a single container instance.
For horizontal scaling, use the Cloudflare Workers + D1 target instead.

### Slow queries / high memory

Run `PRAGMA optimize;` periodically (e.g. via a cron outside the container):

```sh
docker exec mission-control sqlite3 /data/mc.sqlite "PRAGMA optimize;"
```
