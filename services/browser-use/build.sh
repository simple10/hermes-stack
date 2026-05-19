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
# browser-use/browser-use pinned (v0.12.7). Bump deliberately (gotcha #6).
BROWSER_USE_PIN="157779338afdcc03023010ec3c24ad63d820453c"

if [ -d "$D/_source" ] && [ -f "$D/_source/Dockerfile" ]; then
  log "browser-use: _source present (pinned build context) — reusing"
else
  log "browser-use: cloning browser-use/browser-use @ $BROWSER_USE_PIN"
  git clone https://github.com/browser-use/browser-use "$D/_source"
  git -C "$D/_source" checkout "$BROWSER_USE_PIN"
  rm -rf "$D/_source/.git"
fi
log "browser-use: source ready (pin ${BROWSER_USE_PIN:0:12})"

# Build the image now (compose only builds lazily on first `up`). Heavy
# (Chromium apt + uv sync --all-extras) but layer-cached: no-op if unchanged.
set -a; . "$STACK_DIR/.env"; set +a
log "browser-use: building image (upstream Dockerfile; Chromium + uv bundled)"
dc build browser-use
