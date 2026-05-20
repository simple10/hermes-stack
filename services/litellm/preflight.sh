#!/usr/bin/env bash
# litellm/start.sh — run AFTER the `litellm` service is up. Idempotently mints
# one UNRESTRICTED virtual key per LITELLM_VIRTKEYS alias and writes
# <ALIAS>_VIRTUAL_KEY into .stack/litellm.generated.env.
#
# Multi-stack safe: talks to LiteLLM via `docker compose exec` into THIS
# stack's `litellm` service (project-scoped — no fixed container name, no
# shared network). The admin master key is read from the litellm container's
# OWN environment, so it never appears in a host process argv.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
require_stack_env
ENVF="$STACK_DIR/.env"
mkdir -p "$STACK_DIR/litellm"; GEN="$STACK_DIR/litellm/.generated.env"

# Bring up litellm ourselves (the justfile no longer does this for us).
# `pg` is already running from the start pipeline's backends-first step;
# from the Task 3 provisioner edge this also pulls litellm-provision.
log "litellm/preflight: dc up -d litellm"
dc up -d litellm

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

# One key per LITELLM_VIRTKEYS alias, minted UNRESTRICTED (models: [] = all
# proxy models). Per-key model scoping is intentionally dropped — each
# service's model is set explicitly via the .stack/.env levers, so key-level
# allowlists added only clutter + misconfig risk. Distinct keys are kept for
# per-consumer SpendLogs attribution + rotation.
aliases="$(env_get "$ENVF" LITELLM_VIRTKEYS)"
[ -n "$aliases" ] || die "LITELLM_VIRTKEYS empty in .stack/.env (run: just setup)"
echo "$aliases" | tr ',' '\n' | while IFS= read -r a; do
  # Normalize: lowercase + hyphens->underscores so the env var name is
  # POSIX-shell-valid and matches what compose.yaml interpolates. Users may
  # write `browser-use` (matching the profile/service name) OR `browser_use`
  # in LITELLM_VIRTKEYS — both produce the same canonical alias internally.
  alias_lc="$(echo "$a" | tr 'A-Z-' 'a-z_' | tr -d '[:space:]')"
  [ -n "$alias_lc" ] || continue
  out_var="$(echo "$alias_lc" | tr 'a-z' 'A-Z')_VIRTUAL_KEY"
  existing="$(env_get "$GEN" "$out_var")"
  mint() {
    local k
    k="$(llm_api POST /key/generate "{\"key_alias\":\"$alias_lc\",\"models\":[]}" \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')"
    [ -n "$k" ] || die "litellm: failed to mint key for $alias_lc"
    env_upsert "$GEN" "$out_var" "$k"
  }
  if [ -n "$existing" ]; then
    # Ensure the key is still valid in THIS db + unrestricted (models: []).
    # If it's gone (fresh/rotated/recreated db), re-mint (gotcha #4).
    if llm_api POST /key/update "{\"key\":\"$existing\",\"models\":[]}" >/dev/null 2>&1; then
      log "litellm: $alias_lc key present (unrestricted)"
    else
      warn "litellm: $alias_lc key not in this db (fresh/rotated) — re-minting"
      mint; log "litellm: re-minted $out_var (alias=$alias_lc)"
    fi
  else
    mint; log "litellm: minted $out_var (alias=$alias_lc)"
  fi
done
