# Self-host = wrangler dev against local SQLite-backed D1. No Node target.
#
# This container runs `wrangler dev` bound to 0.0.0.0:8787 with --persist-to
# /data so the SQLite-backed D1 state survives container restarts.
#
# Usage (standalone):
#   docker build -t mission-control:local .
#   docker run -d -p 8787:8787 -v mc-data:/data \
#     -e BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
#     -e MC_ADMIN_TOKEN="$(openssl rand -hex 16)" \
#     -e BETTER_AUTH_URL="http://localhost:8787" \
#     mission-control:local
#
# Usage (hermes-stack compose.yaml):
#   just build mission-control && just start
#
# Backup: copy .wrangler/state/v3/d1/ from the /data volume.
# Restore: replace those files and restart the container.

FROM node:22-alpine AS app

WORKDIR /app

# Enable pnpm via corepack (version pinned by package.json `packageManager`).
RUN corepack enable

# Copy manifests first for layer-cache efficiency.
COPY package.json pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./

# Frozen install from the committed lockfile.
RUN pnpm install --frozen-lockfile

# Install wrangler globally inside the container (matches host convention;
# wrangler is NOT a project dep — it stays global everywhere).
RUN npm install -g wrangler

# Copy source after deps so the dep layer is cached on source-only changes.
COPY . .

# Regenerate worker-configuration.d.ts from wrangler.jsonc binding types.
RUN pnpm cf:types

EXPOSE 8787

# Wrangler persists D1 state under <cwd>/.wrangler/state; mounting /data and
# pointing --persist-to there keeps DB files on the named volume.
VOLUME /data

ENV NODE_ENV=production

CMD ["wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787", "--persist-to", "/data"]
