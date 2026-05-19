#!/usr/bin/env bash
# browser-use/build.sh — fetch pinned browser-use source, then build the
# image via the UPSTREAM Dockerfile (it bundles python3.12 + uv + system
# Chromium + browser-use and all extras — comprehensive, no need to author
# our own). Mirrors honcho-ui/build.sh (clone+pin, eager `dc build` so
# `just build` produces the image deterministically). _source/ stays
# pristine/pinned: browser-use is pointed at LiteLLM purely via runtime env
# (compose.yaml) — NO source patching, NO secrets baked.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/browser-use"
# Pin from services/browser-use/service.env. Bumpable via .stack/.env
# BROWSER_USE_VERSION (tag or commit SHA).
stack_source browser-use

# Build the image now (compose only builds lazily on first `up`). Heavy
# (Chromium apt + uv sync --all-extras) but layer-cached: no-op if unchanged.
set -a; . "$STACK_DIR/.env"; set +a
GEN="$STACK_DIR/browser-use/.generated.env"
if [ -n "$(env_get "$GEN" BROWSER_USE_SOURCE_REBUILD)" ]; then
  log "browser-use: source changed — building image (upstream Dockerfile; Chromium + uv bundled)"
  dc build browser-use
  env_upsert "$GEN" BROWSER_USE_SOURCE_REBUILD ""
else
  log "browser-use: source unchanged — skipping dc build"
fi
