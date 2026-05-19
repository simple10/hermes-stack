#!/usr/bin/env bash
# hindsight/build.sh — own HINDSIGHT_DB_PASSWORD (decentralized). Hindsight
# is a prebuilt image (no template/source), so password ownership is the
# only build-time concern.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
mkdir -p "$STACK_DIR/hindsight"
GEN="$STACK_DIR/hindsight/.generated.env"
pw="$(env_get "$GEN" HINDSIGHT_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(openssl rand -hex 16)"
env_upsert "$GEN" HINDSIGHT_DB_PASSWORD "$pw"
log "hindsight: HINDSIGHT_DB_PASSWORD owned in hindsight.generated.env"
