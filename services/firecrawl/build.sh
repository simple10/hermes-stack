#!/usr/bin/env bash
# firecrawl/build.sh — own FIRECRAWL_DB_PASSWORD + FIRECRAWL_BULL_AUTH_KEY
# (decentralized). Read existing first so they keep matching the dedicated
# firecrawl-pg-data volume / the running queue-admin UI; never blind-regen.
# Firecrawl is all-env (no config template to render).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
mkdir -p "$STACK_DIR/firecrawl"
GEN="$STACK_DIR/firecrawl/.generated.env"

dbpw="$(env_get "$GEN" FIRECRAWL_DB_PASSWORD)"
[ -n "$dbpw" ] || dbpw="$(openssl rand -hex 16)"
env_upsert "$GEN" FIRECRAWL_DB_PASSWORD "$dbpw"

bull="$(env_get "$GEN" FIRECRAWL_BULL_AUTH_KEY)"
[ -n "$bull" ] || bull="$(openssl rand -hex 16)"
env_upsert "$GEN" FIRECRAWL_BULL_AUTH_KEY "$bull"

log "firecrawl: FIRECRAWL_DB_PASSWORD + FIRECRAWL_BULL_AUTH_KEY owned in firecrawl.generated.env"
