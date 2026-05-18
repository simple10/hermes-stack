#!/usr/bin/env bash
# litellm/start.sh — run AFTER the `litellm` service is up. Idempotently mints
# (or reconciles) a virtual key per LITELLM_VIRTKEY_<ALIAS>_MODELS declaration
# and writes <ALIAS>_VIRTUAL_KEY into .stack/litellm.generated.env.
#
# Multi-stack safe: talks to LiteLLM via `docker compose exec` into THIS
# stack's `litellm` service (project-scoped — no fixed container name, no
# shared network). The admin master key is read from the litellm container's
# OWN environment, so it never appears in a host process argv.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
require_stack_env
ENVF="$STACK_DIR/.env"
GEN="$STACK_DIR/litellm.generated.env"
export COMPOSE_ENV_FILES="$(compose_env_files)"

# Wait for litellm to actually serve (exec fails until the container runs).
ok=
for i in $(seq 1 48); do
  if dc exec -T litellm python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://localhost:4000/health/liveliness',timeout=3).status==200 else 1)" 2>/dev/null; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || die "litellm not serving /health/liveliness after ~4min (check: $(dc ps) ; docker logs)"

# llm_api METHOD PATH JSON -> response body. Master key from the container env.
llm_api() {
  dc exec -T litellm python - "$1" "$2" "$3" <<'PY'
import os,sys,urllib.request
method,path,body=sys.argv[1],sys.argv[2],sys.argv[3]
req=urllib.request.Request("http://localhost:4000"+path,data=body.encode(),
  headers={"Authorization":"Bearer "+os.environ["LITELLM_MASTER_KEY"],
           "Content-Type":"application/json"},method=method)
print(urllib.request.urlopen(req,timeout=15).read().decode())
PY
}

grep -E '^LITELLM_VIRTKEY_[A-Z0-9]+_MODELS=' "$ENVF" | while IFS= read -r line; do
  alias_uc="$(echo "$line" | sed -E 's/^LITELLM_VIRTKEY_([A-Z0-9]+)_MODELS=.*/\1/')"
  csv="$(echo "$line" | cut -d= -f2-)"
  models_json="$(python3 -c 'import sys,json;print(json.dumps([s for s in sys.argv[1].split(",") if s]))' "$csv")"
  out_var="${alias_uc}_VIRTUAL_KEY"
  alias_lc="$(echo "$alias_uc" | tr 'A-Z' 'a-z')"
  existing="$(env_get "$GEN" "$out_var")"
  mint() {
    local k
    k="$(llm_api POST /key/generate "{\"key_alias\":\"$alias_lc\",\"models\":$models_json}" \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')"
    [ -n "$k" ] || die "litellm: failed to mint key for $alias_lc"
    env_upsert "$GEN" "$out_var" "$k"
  }
  if [ -n "$existing" ]; then
    # Reconcile the allowlist. If the key isn't valid in THIS db (fresh /
    # rotated / recreated stack), re-mint instead of failing (gotcha #4).
    if llm_api POST /key/update "{\"key\":\"$existing\",\"models\":$models_json}" >/dev/null 2>&1; then
      log "litellm: reconciled allowlist for $alias_lc key"
    else
      warn "litellm: $alias_lc key not in this db (fresh/rotated) — re-minting"
      mint; log "litellm: re-minted $out_var (alias=$alias_lc)"
    fi
  else
    mint; log "litellm: minted $out_var (alias=$alias_lc)"
  fi
done
