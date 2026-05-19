#!/usr/bin/env bash
# litellm/build.sh — render runtime config from template (no secrets baked).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/litellm"
mkdir -p "$STACK_DIR/litellm"
render_template "$D/config.yaml.template" "$STACK_DIR/litellm/config.runtime.yaml" litellm

# Own LITELLM_DB_PASSWORD here (decentralized). Read the existing value first
# (the legacy db.generated.env fallback covers stacks migrated from the old
# central scheme); never blind-regen — would shadow a live pw via last-wins.
GEN="$STACK_DIR/litellm/.generated.env"
pw="$(env_get "$GEN" LITELLM_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(openssl rand -hex 16)"
env_upsert "$GEN" LITELLM_DB_PASSWORD "$pw"
log "litellm: LITELLM_DB_PASSWORD owned in litellm.generated.env"
