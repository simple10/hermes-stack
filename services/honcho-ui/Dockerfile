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
# Frozen lockfile = reproducible (pin philosophy). Build only @openconcho/web
# (turbo's default `build` also builds the Tauri desktop app — unwanted here).
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @openconcho/web build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
