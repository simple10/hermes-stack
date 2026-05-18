#!/usr/bin/env bash
# litellm/prestart.sh — fail loud BEFORE the heavy `up` if the rendered
# runtime config is missing or unparseable. Validation only; no side effects.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
CFG="$STACK_ROOT/services/litellm/config.runtime.yaml"
[ -f "$CFG" ] || die "litellm: $CFG missing — run: just build"
if command -v yq >/dev/null 2>&1; then
  yq -e '.' "$CFG" >/dev/null 2>&1 || die "litellm: $CFG is not valid YAML"
else
  python3 -c "import sys,yaml; yaml.safe_load(open('$CFG'))" \
    || die "litellm: $CFG is not valid YAML"
fi
log "litellm/prestart: config.runtime.yaml present and parses"
