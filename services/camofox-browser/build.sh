#!/usr/bin/env bash
# camofox-browser/build.sh — own CAMOFOX_ACCESS_KEY (decentralized, gen-once)
# + fetch pinned _source + eager image build. Standalone service: no backend
# deps, no preflight/prestart/poststart.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/camofox-browser"

# Own CAMOFOX_ACCESS_KEY (generated, hermetic). Read existing value first;
# never blind-regen (rotating would orphan any Hermes config already wired).
mkdir -p "$STACK_DIR/camofox-browser"
GEN="$STACK_DIR/camofox-browser/.generated.env"
key="$(env_get "$GEN" CAMOFOX_ACCESS_KEY)"
[ -n "$key" ] || key="$(openssl rand -hex 32)"
env_upsert "$GEN" CAMOFOX_ACCESS_KEY "$key"
log "camofox-browser: CAMOFOX_ACCESS_KEY owned in camofox-browser.generated.env"

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
