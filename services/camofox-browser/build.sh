#!/usr/bin/env bash
# camofox-browser/build.sh — own CAMOFOX_ACCESS_KEY (decentralized, gen-once)
# + fetch pinned _source + eager image build. Standalone service: no backend
# deps, no preflight/prestart/poststart.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/camofox-browser"

# CAMOFOX_AUTH lever (.stack/.env): default = generate + reuse a bearer key
# (current behavior). "disabled" = write empty key; server runs without auth.
# The orb-DNS-only exposure (no host port) is the trust boundary in that mode.
# Required for clients that don't send Authorization: Bearer — notably Hermes,
# which only reads CAMOFOX_URL (no auth env var supported).
mkdir -p "$STACK_DIR/camofox-browser"
GEN="$STACK_DIR/camofox-browser/.generated.env"
auth_mode="$(env_get "$STACK_DIR/.env" CAMOFOX_AUTH)"
if [ "$auth_mode" = "disabled" ]; then
  env_upsert "$GEN" CAMOFOX_ACCESS_KEY ""
  log "camofox-browser: CAMOFOX_AUTH=disabled — server runs without bearer auth (Hermes-compatible)"
else
  key="$(env_get "$GEN" CAMOFOX_ACCESS_KEY)"
  [ -n "$key" ] || key="$(openssl rand -hex 32)"
  env_upsert "$GEN" CAMOFOX_ACCESS_KEY "$key"
  log "camofox-browser: CAMOFOX_ACCESS_KEY owned (set CAMOFOX_AUTH=disabled to drop bearer auth)"
fi

# Pin from services/camofox-browser/service.env. Bumpable via .stack/.env
# CAMOFOX_BROWSER_VERSION (tag or commit SHA).
stack_source camofox-browser

# Eager build (honcho-ui precedent) — surface the heavy Camoufox/Firefox
# build at `just build`, not mid-`just start`. First build downloads ~300MB
# Camoufox + apt Firefox/Xvfb deps (needs build-time network).
CAMOFOX_GEN="$STACK_DIR/camofox-browser/.generated.env"
if [ -n "$(env_get "$CAMOFOX_GEN" CAMOFOX_BROWSER_SOURCE_REBUILD)" ]; then
  log "camofox-browser: source changed — building image (Dockerfile.ci)"
  dc build camofox-browser
  env_upsert "$CAMOFOX_GEN" CAMOFOX_BROWSER_SOURCE_REBUILD ""
else
  log "camofox-browser: source unchanged — skipping dc build"
fi
log "camofox-browser/build.sh DONE"
