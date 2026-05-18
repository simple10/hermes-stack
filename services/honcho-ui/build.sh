#!/usr/bin/env bash
# honcho-ui/build.sh — fetch pinned OpenConcho source (build context for the
# multi-stage Dockerfile). Mirrors services/honcho/build.sh. No config to
# render: OpenConcho is a static SPA whose connection config (Honcho base URL
# + optional token) is entered in-app and kept in browser localStorage — there
# are no build-time/runtime env levers and no secrets, so nothing is injected.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/honcho-ui"
# offendingcommit/openconcho pinned (v0.8.0). Bump deliberately (gotcha #6).
OPENCONCHO_PIN="e490d911fcb27ee193558fd9a28856cde2057665"

if [ -d "$D/_source" ] && [ -f "$D/_source/package.json" ]; then
  log "honcho-ui: _source present (pinned build context) — reusing"
else
  log "honcho-ui: cloning offendingcommit/openconcho @ $OPENCONCHO_PIN"
  git clone https://github.com/offendingcommit/openconcho "$D/_source"
  git -C "$D/_source" checkout "$OPENCONCHO_PIN"
  rm -rf "$D/_source/.git"
fi
log "honcho-ui: source ready (pin ${OPENCONCHO_PIN:0:12})"
