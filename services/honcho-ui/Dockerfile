# OpenConcho — static SPA (React 19 + Vite 8, TanStack file-based router).
# Two stages: pnpm build of the WEB package only (Tauri/desktop skipped), then
# nginx serving the static bundle. Source is the pinned _source/ tree fetched
# by build.sh (gotcha #6). Node 24 matches the repo's .nvmrc; pnpm version is
# pinned by the repo's package.json "packageManager" (corepack honors it).
FROM node:24-alpine AS build
ENV HUSKY=0
WORKDIR /app
RUN corepack enable
COPY _source/ ./
# Default-endpoint patch: OpenConcho has no config mechanism for a default
# Honcho URL — the first-run form falls back to a hardcoded
# "http://localhost:8000". Rewrite that literal (in src/, NOT src/test/) to
# the same-origin Honcho proxy (HONCHO_BASE_URL, see nginx.conf — Honcho's
# CORS allowlist is hardcoded so a direct cross-origin call is blocked) so
# the connect form opens PRE-FILLED. Only the default/placeholder/fallback
# change; the token field is untouched (still empty, entered in-app — never
# injected). Deterministic, parameterized per project (multi-stack safe);
# _source/ stays pristine/pinned. Same build-time render-and-inject
# philosophy as the other services.
ARG HONCHO_BASE_URL=
RUN if [ -n "$HONCHO_BASE_URL" ]; then \
      find packages/web/src \( -path 'packages/web/src/test' \) -prune -o \
        -type f \( -name '*.ts' -o -name '*.tsx' \) -print \
      | xargs sed -i "s#http://localhost:8000#${HONCHO_BASE_URL}#g"; \
      echo "honcho-ui: default endpoint -> ${HONCHO_BASE_URL}"; \
    fi
# Frozen lockfile = reproducible (pin philosophy). Build only @openconcho/web
# (turbo's default `build` also builds the Tauri desktop app — unwanted here).
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @openconcho/web build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
