#!/usr/bin/env bash
# litellm/build.sh — render runtime config from template (no secrets baked).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/litellm"
render_template "$D/config.yaml.template" "$D/config.runtime.yaml" litellm
