#!/usr/bin/env bash
# honcho-ui/build.sh — fetch pinned OpenConcho source, then build the image so
# the per-project default-endpoint patch (HONCHO_BASE_URL build arg) is baked
# deterministically by `just build` (multi-stack safe). _source/ stays
# pristine/pinned; the only injected value is the default Honcho URL — no
# secrets, and the in-app token field is never touched.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/honcho-ui"
# offendingcommit/openconcho pinned (v0.8.0). Bump deliberately (gotcha #6).
OPENCONCHO_PIN="e490d911fcb27ee193558fd9a28856cde2057665"

if [ -d "$D/_source" ] && [ -f "$D/_source/package.json" ]; then
  log "honcho-ui: _source present (pinned build context) — reusing"
else
  log "honcho-ui: cloning offendingcommit/openconcho @ $OPENCONCHO_PIN"
  rm -rf "$D/_source"   # recover from a partial/interrupted prior clone
  git clone https://github.com/offendingcommit/openconcho "$D/_source"
  git -C "$D/_source" checkout "$OPENCONCHO_PIN"
  rm -rf "$D/_source/.git"
fi
log "honcho-ui: source ready (pin ${OPENCONCHO_PIN:0:12})"

# Build the image now so COMPOSE_PROJECT_NAME -> HONCHO_BASE_URL is resolved
# and the source patch is baked (compose only builds lazily on first `up`,
# which would miss a project rename). Layer-cached: no-op if nothing changed.
set -a; . "$STACK_DIR/.env"; set +a
log "honcho-ui: building image (default endpoint -> http://honcho-api.$(stack_project).orb.local:8000)"
dc build honcho-ui
