#!/usr/bin/env bash
# postgres/build.sh — generate DB role passwords ONCE into .stack/db.generated.env.
# Reused on re-run so they keep matching the pg data volume. Recreate-from-
# scratch is fine (no data of value); to fully reset, also remove the
# <project>_pg-data volume before `just start`.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
DBENV="$STACK_DIR/db.generated.env"
if [ -f "$DBENV" ] && [ -n "$(env_get "$DBENV" POSTGRES_SUPERPASS)" ]; then
  log "postgres: reusing existing $DBENV (keeps matching pg volume)"
else
  log "postgres: generating DB role passwords -> $DBENV"
  env_upsert "$DBENV" POSTGRES_SUPERPASS  "$(openssl rand -hex 16)"
  env_upsert "$DBENV" HONCHO_DB_PASSWORD  "$(openssl rand -hex 16)"
  env_upsert "$DBENV" LITELLM_DB_PASSWORD "$(openssl rand -hex 16)"
fi
# No shared external network — Compose creates a per-project default network.
