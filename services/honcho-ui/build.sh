#!/usr/bin/env bash
# honcho-ui/build.sh — fetch pinned OpenConcho source, then build the image so
# the per-project default-endpoint patch (HONCHO_BASE_URL build arg) is baked
# deterministically by `just build` (multi-stack safe). _source/ stays
# pristine/pinned; the only injected value is the default Honcho URL — no
# secrets, and the in-app token field is never touched.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/honcho-ui"
# Pin from services/honcho-ui/service.env (HONCHO_UI_SOURCE_REPO/_DEFAULT).
# Bumpable via .stack/.env HONCHO_UI_VERSION (tag or commit SHA).
stack_source honcho-ui

# Build the image so COMPOSE_PROJECT_NAME -> HONCHO_BASE_URL is resolved
# and the source patch is baked (compose only builds lazily on first `up`,
# which would miss a project rename). Skip when source unchanged.
set -a; . "$STACK_DIR/.env"; set +a
GEN="$STACK_DIR/honcho-ui/.generated.env"
if [ -n "$(env_get "$GEN" HONCHO_UI_SOURCE_REBUILD)" ]; then
  log "honcho-ui: source changed — building image (default endpoint -> http://honcho-api.$(stack_project).orb.local:8000)"
  dc build honcho-ui
  env_upsert "$GEN" HONCHO_UI_SOURCE_REBUILD ""
else
  log "honcho-ui: source unchanged — skipping dc build"
fi
