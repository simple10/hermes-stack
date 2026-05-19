#!/usr/bin/env bash
# postgres/build.sh — generate ONLY the superuser password into
# .stack/db.generated.env. Per-service DB passwords are decentralized: each
# pg-using service owns its own <SVC>_DB_PASSWORD in .stack/<svc>.generated.env
# (services/<svc>/build.sh) and provisions its role/db via its own one-shot
# provisioner. Reused on re-run so it keeps matching the pg data volume.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
DBENV="$STACK_DIR/pg/.generated.env"; mkdir -p "$(dirname "$DBENV")"
if [ -f "$DBENV" ] && [ -n "$(env_get "$DBENV" POSTGRES_SUPERPASS)" ]; then
  log "postgres: reusing existing POSTGRES_SUPERPASS (keeps matching pg volume)"
else
  log "postgres: generating POSTGRES_SUPERPASS -> $DBENV"
  env_upsert "$DBENV" POSTGRES_SUPERPASS "$(openssl rand -hex 16)"
fi
