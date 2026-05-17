#!/usr/bin/env bash
# honcho/build.sh — fetch pinned source + render runtime config.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/honcho"
HONCHO_PIN="8fcbb54a49292341dba79d606ee332c50778429b"  # plastic-labs/honcho pinned

if [ -d "$D/_source" ] && [ -f "$D/_source/Dockerfile" ]; then
  log "honcho: _source present (pinned build context) — reusing"
else
  log "honcho: cloning plastic-labs/honcho @ $HONCHO_PIN"
  git clone https://github.com/plastic-labs/honcho "$D/_source"
  git -C "$D/_source" checkout "$HONCHO_PIN"
  rm -rf "$D/_source/.git"
fi
render_template "$D/config.toml.template" "$D/config.runtime.toml" honcho
