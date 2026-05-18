#!/usr/bin/env bash
# honcho-postup.sh — bring Honcho up correctly for a fresh (or, if ever, an
# existing) DB. Multi-stack safe: all docker access is project-scoped via the
# `dc` helper + `docker compose exec` (no fixed container names, no shared net).
#   1. up honcho-api  (its entrypoint runs `alembic upgrade` -> schema)
#   2. TOLERANT wait for the `documents` table (alembic finished) — NOT a
#      health wait: on a fresh DB honcho-api is intentionally unhealthy
#      (1536 cols vs configured 1024) until the dim fix below.
#   3. read embedding col dims:
#        vector(1024) => nothing to alter
#        else (1536)  => FRESH db: alter to 1024 via the IN-IMAGE venv python
#          (NOT `uv run` — it rebuilds in-image and fails), then force-recreate
#   4. wait honcho-api healthy
# Called by `just start` AFTER litellm keys are minted and BEFORE the final
# settle up -d.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
source "$STACK_DIR/.env"
echo "${COMPOSE_PROFILES:-}" | grep -qw honcho || { log "honcho not in profiles — skip postup"; exit 0; }
HPW="$(env_get "$STACK_DIR/honcho.generated.env" HONCHO_DB_PASSWORD)"
[ -n "$HPW" ] || die "HONCHO_DB_PASSWORD missing in .stack/honcho.generated.env"
export COMPOSE_ENV_FILES="$(compose_env_files)"

# pgq SQL -> result. Runs psql INSIDE this stack's pg container (project-scoped).
pgq() {
  dc exec -T -e PGPASSWORD="$HPW" pg \
    psql -h 127.0.0.1 -U honcho -d honcho -tAc "$1" 2>/dev/null || true
}

log "honcho: starting honcho-api (entrypoint runs alembic upgrade)"
dc up -d honcho-api

log "honcho: waiting (tolerant, ~4min) for alembic to create the 'documents' table"
for i in $(seq 1 48); do
  [ "$(pgq "SELECT to_regclass('documents');" | tr -d '[:space:]')" = "documents" ] && break
  sleep 5
  [ "$i" = 48 ] && die "honcho: 'documents' table never appeared — alembic failed (check: dc logs honcho-api)"
done

dims="$(pgq "SELECT format_type(atttypid,atttypmod) FROM pg_attribute WHERE attname='embedding' AND attrelid='documents'::regclass;" | tr -d '[:space:]')"
if echo "$dims" | grep -q '1024'; then
  log "honcho: embedding cols already vector(1024) — no dim fix"
else
  log "honcho: FRESH db (cols='${dims:-unknown}') — applying 1024 dim fix via in-image venv"
  dc run --rm --entrypoint /app/.venv/bin/python \
    honcho-api scripts/configure_embeddings.py --yes
  dc up -d --force-recreate honcho-api honcho-deriver
fi

for i in $(seq 1 36); do
  cid="$(dc ps -q honcho-api 2>/dev/null || true)"
  h="$( [ -n "$cid" ] && docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo none)"
  [ "$h" = healthy ] && { log "honcho-api healthy"; exit 0; }
  sleep 5
done
die "honcho-api unhealthy after postup (check: dc logs honcho-api)"
