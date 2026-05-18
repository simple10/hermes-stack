#!/usr/bin/env bash
# litellm/build.sh — render runtime config from template (no secrets baked).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/litellm"
render_template "$D/config.yaml.template" "$D/config.runtime.yaml" litellm

# Own LITELLM_DB_PASSWORD here (decentralized). Read the existing live value
# first (never blind-regen — that would shadow the live pw via last-wins and
# break auth against the existing pg volume). Mirror into db.generated.env
# until the central file is retired (Task 6 / spec step 6).
GEN="$STACK_DIR/litellm.generated.env"
pw="$(env_get "$GEN" LITELLM_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(env_get "$STACK_DIR/db.generated.env" LITELLM_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(openssl rand -hex 16)"
env_upsert "$GEN" LITELLM_DB_PASSWORD "$pw"
env_upsert "$STACK_DIR/db.generated.env" LITELLM_DB_PASSWORD "$pw"
log "litellm: LITELLM_DB_PASSWORD owned in litellm.generated.env (mirrored)"
