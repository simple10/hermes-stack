# firecrawl-ui — Vue 3 + Vite SPA (obeone/firecrawl-ui), served static by nginx.
#
# Mirrors the upstream _source/Dockerfile but adds ONE thing: bake the Firecrawl
# API base URL at build time (VITE_FIRECRAWL_API_BASE_URL) so the UI opens
# PRE-WIRED to this stack's firecrawl-api instead of the hosted cloud default
# (https://api.firecrawl.dev). The URL is project-scoped (compose passes
# FIRECRAWL_API_BASE_URL) and points at OrbStack's auto-HTTPS endpoint for
# firecrawl-api — same scheme as this page (no mixed content) and the API sends
# Access-Control-Allow-Origin:* (no CORS proxy needed, unlike honcho-ui).
# The user can still override base URL + key in the in-app settings (localStorage).
#
# Build context is the SERVICE dir (COPY _source/...), matching honcho-ui — see
# the service-level .dockerignore which keeps _source/.git out of the context.

# Stage 1: build the static bundle.
FROM node:24-slim AS build
WORKDIR /app
# Deps first for layer caching.
COPY _source/package.json _source/package-lock.json ./
RUN npm install
COPY _source/ ./
# Empty default keeps a bare `docker build` working; compose always passes it.
ARG FIRECRAWL_API_BASE_URL=
ENV VITE_FIRECRAWL_API_BASE_URL=$FIRECRAWL_API_BASE_URL
RUN npm run build

# Stage 2: serve via unprivileged nginx (upstream's nginx.conf: :8080 + SPA fallback).
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY _source/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
