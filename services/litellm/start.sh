#!/usr/bin/env bash
# litellm/start.sh — run AFTER aitools-litellm is healthy. Idempotently mints a
# virtual key per LITELLM_VIRTKEY_<ALIAS>_MODELS declaration and writes
# <ALIAS>_VIRTUAL_KEY into .stack/litellm.generated.env.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
require_stack_env
ENVF="$STACK_DIR/.env"
GEN="$STACK_DIR/litellm.generated.env"
MK="$(env_get "$ENVF" LITELLM_MASTER_KEY)"
[ -n "$MK" ] || die "LITELLM_MASTER_KEY empty in .stack/.env"

api() { docker run --rm --network aitools-net curlimages/curl -s "$@"; }
csv_to_json() { python3 -c "import sys,json;print(json.dumps([s for s in sys.argv[1].split(',') if s]))" "$1"; }

# Wait for litellm health (defensive; just start also gates on this).
for i in $(seq 1 36); do
  h=$(docker inspect -f '{{.State.Health.Status}}' aitools-litellm 2>/dev/null || echo none)
  [ "$h" = healthy ] && break
  sleep 5; [ "$i" = 36 ] && die "aitools-litellm not healthy ($h)"
done

# Each declaration: LITELLM_VIRTKEY_<ALIAS>_MODELS=csv
grep -E '^LITELLM_VIRTKEY_[A-Z0-9]+_MODELS=' "$ENVF" | while IFS= read -r line; do
  alias_uc="$(echo "$line" | sed -E 's/^LITELLM_VIRTKEY_([A-Z0-9]+)_MODELS=.*/\1/')"
  csv="$(echo "$line" | cut -d= -f2-)"
  models_json="$(csv_to_json "$csv")"
  out_var="${alias_uc}_VIRTUAL_KEY"
  existing="$(env_get "$GEN" "$out_var")"
  alias_lc="$(echo "$alias_uc" | tr 'A-Z' 'a-z')"
  if [ -n "$existing" ]; then
    api -X POST http://aitools-litellm:4000/key/update \
      -H "Authorization: Bearer $MK" -H "Content-Type: application/json" \
      -d "{\"key\":\"$existing\",\"models\":$models_json}" >/dev/null \
      && log "litellm: reconciled allowlist for $alias_lc key"
  else
    key="$(api -X POST http://aitools-litellm:4000/key/generate \
      -H "Authorization: Bearer $MK" -H "Content-Type: application/json" \
      -d "{\"key_alias\":\"$alias_lc\",\"models\":$models_json}" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')"
    [ -n "$key" ] || die "litellm: failed to mint key for $alias_lc"
    env_upsert "$GEN" "$out_var" "$key"
    log "litellm: minted $out_var (alias=$alias_lc)"
  fi
done
