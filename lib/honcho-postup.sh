#!/usr/bin/env bash
# honcho-postup.sh — bring Honcho up correctly for BOTH fresh and reattached
# DBs. Mirrors the PROVEN build-stack.sh step-8 sequence (do not "simplify"):
#   1. up aitools-honcho-api  (its entrypoint runs `alembic upgrade` -> schema)
#   2. TOLERANT wait for the `documents` table to exist (alembic finished) —
#      NOT a health wait: on a fresh DB honcho-api is intentionally unhealthy
#      (1536 cols vs configured 1024) until the dim fix below.
#   3. read embedding col dims:
#        vector(1024) => REATTACHED existing data; nothing to alter
#        else (1536)  => FRESH db: alter to 1024 via the IN-IMAGE venv python
#          (NOT `uv run` — it rebuilds in-image and fails), then force-recreate
#   4. wait honcho-api healthy
# Called by `just start` AFTER litellm keys are minted (honcho needs
# HONCHO_VIRTUAL_KEY via COMPOSE_ENV_FILES) and BEFORE the final settle up -d.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stacklib.sh"
source "$STACK_DIR/.env"
echo "${COMPOSE_PROFILES:-}" | grep -qw honcho || { log "honcho not in profiles — skip postup"; exit 0; }
HPW="$(env_get "$STACK_DIR/db.generated.env" HONCHO_DB_PASSWORD)"
[ -n "$HPW" ] || die "HONCHO_DB_PASSWORD missing in .stack/db.generated.env"
export COMPOSE_ENV_FILES="$(compose_env_files)"
DC="docker compose -f $STACK_ROOT/docker-compose.yaml"
pgq() { docker run --rm --network aitools-net -e PGPASSWORD="$HPW" postgres:18 \
          psql -h aitools-pg -U honcho -d honcho -tAc "$1" 2>/dev/null || true; }

log "honcho: starting aitools-honcho-api (entrypoint runs alembic upgrade)"
$DC up -d aitools-honcho-api

log "honcho: waiting (tolerant, ~4min) for alembic to create the 'documents' table"
for i in $(seq 1 48); do
  [ "$(pgq "SELECT to_regclass('documents');" | tr -d '[:space:]')" = "documents" ] && break
  sleep 5
  [ "$i" = 48 ] && die "honcho: 'documents' table never appeared — alembic failed (check: docker logs aitools-honcho-api)"
done

dims="$(pgq "SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attname='embedding' AND attrelid='documents'::regclass;" | tr -d '[:space:]')"
if echo "$dims" | grep -q '1024'; then
  log "honcho: embedding cols already vector(1024) (reattached data) — no dim fix"
else
  log "honcho: FRESH db (cols='${dims:-unknown}') — applying 1024 dim fix via in-image venv"
  $DC run --rm --entrypoint /app/.venv/bin/python \
    aitools-honcho-api scripts/configure_embeddings.py --yes
  $DC up -d --force-recreate aitools-honcho-api aitools-honcho-deriver
fi

for i in $(seq 1 36); do
  h=$(docker inspect -f '{{.State.Health.Status}}' aitools-honcho-api 2>/dev/null || echo none)
  [ "$h" = healthy ] && { log "honcho-api healthy"; exit 0; }
  sleep 5
done
die "honcho-api unhealthy after postup (check: docker logs aitools-honcho-api)"
