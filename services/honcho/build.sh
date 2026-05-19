#!/usr/bin/env bash
# honcho/build.sh — fetch pinned source + render runtime config.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/honcho"
HONCHO_PIN="8fcbb54a49292341dba79d606ee332c50778429b"  # plastic-labs/honcho pinned

if [ -d "$D/_source" ] && [ -f "$D/_source/Dockerfile" ]; then
  log "honcho: _source present (pinned build context) — reusing"
else
  log "honcho: cloning plastic-labs/honcho @ $HONCHO_PIN"
  rm -rf "$D/_source"   # recover from a partial/interrupted prior clone
  git clone https://github.com/plastic-labs/honcho "$D/_source"
  git -C "$D/_source" checkout "$HONCHO_PIN"
  rm -rf "$D/_source/.git"
fi
# Render config.runtime.toml from the template, injecting the per-module
# model levers from .stack/.env. Bash-source so the ${STACK_LLM_MODEL*} refs
# in .stack/.env expand (presets defined above the per-service lines). Secret
# placeholders (CONNECTION_URI / HONCHO_VIRTUAL_KEY) stay as-is — resolved at
# container runtime via env, never written to the file. Deterministic each
# build (generated file; gitignored).
set -a; . "$STACK_DIR/.env"; set +a
mkdir -p "$STACK_DIR/honcho"
sed -e "s|__HONCHO_DERIVER_MODEL__|${HONCHO_DERIVER_MODEL:-cliproxy/gpt-5.4-mini}|g" \
    -e "s|__HONCHO_SUMMARY_MODEL__|${HONCHO_SUMMARY_MODEL:-cliproxy/gpt-5.4-mini}|g" \
    -e "s|__HONCHO_DREAM_MODEL__|${HONCHO_DREAM_MODEL:-cliproxy/gpt-5.4-mini}|g" \
    -e "s|__HONCHO_DIALECTIC_MODEL__|${HONCHO_DIALECTIC_MODEL:-cliproxy/gpt-5.5}|g" \
    -e "s|__HONCHO_EMBEDDING_MODEL__|${HONCHO_EMBEDDING_MODEL:-voyage-4-lite}|g" \
    "$D/config.toml.template" > "$STACK_DIR/honcho/config.runtime.toml"
log "honcho: rendered config.runtime.toml (models: deriver=${HONCHO_DERIVER_MODEL:-} dialectic=${HONCHO_DIALECTIC_MODEL:-} embed=${HONCHO_EMBEDDING_MODEL:-})"

# Own HONCHO_DB_PASSWORD (decentralized). Read existing value first (legacy
# db.generated.env fallback for migrated stacks); never blind-regen.
GEN="$STACK_DIR/honcho/.generated.env"
pw="$(env_get "$GEN" HONCHO_DB_PASSWORD)"
[ -n "$pw" ] || pw="$(openssl rand -hex 16)"
env_upsert "$GEN" HONCHO_DB_PASSWORD "$pw"
log "honcho: HONCHO_DB_PASSWORD owned in honcho.generated.env"

# Eager build (honcho-ui / camofox-browser precedent) — surface the heavy
# plastic-labs/honcho image build at `just build`, not deep in `just start`'s
# `dc up -d` after backends+preflight are already up. honcho-api and
# honcho-deriver share one build context (./_source) → a single image.
# Layer-cached: a no-op when nothing changed.
log "honcho: building image (honcho-api + honcho-deriver share one context)"
dc build honcho-api honcho-deriver
