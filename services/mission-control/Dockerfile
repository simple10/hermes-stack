# ── Build stage ─────────────────────────────────────────────────────────────
# Node 22 Alpine + native build tools for better-sqlite3 (node-gyp requires
# python3 / make / g++).
FROM node:22-alpine AS build

WORKDIR /app

# Install native build deps before pnpm install so the layer is cached.
RUN apk add --no-cache python3 make g++

# Enable pnpm via corepack (version pinned by package.json `packageManager`).
RUN corepack enable

# Copy manifests first for layer-cache efficiency.
COPY package.json pnpm-lock.yaml ./

# Frozen install from the committed lockfile.
RUN pnpm install --frozen-lockfile

# Copy source — deliberately after node_modules to keep dep layer cached.
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

# Type-check (no emit — Node uses --experimental-strip-types at runtime).
RUN pnpm exec tsc --noEmit

# ── Runtime stage ────────────────────────────────────────────────────────────
# Lean runtime image: only the files needed to serve requests.
FROM node:22-alpine AS run

WORKDIR /app

# sqlite CLI useful for manual inspection / backup; wget used by healthcheck.
RUN apk add --no-cache sqlite wget

# Copy the pre-built node_modules (includes better-sqlite3 native .node binary
# compiled for this exact Alpine/Node version in the build stage).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./

# Persistent data volume — mount a host directory or named volume here.
RUN mkdir -p /data
VOLUME /data

EXPOSE 8787

ENV NODE_ENV=production \
    MC_DB_PATH=/data/mc.sqlite \
    PORT=8787

# Node 22 experimental strip-types: run TypeScript directly with no compile step.
CMD ["node", "--experimental-strip-types", "src/node-entry.ts"]
