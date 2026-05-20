#!/usr/bin/env bash
# searxng/build.sh — own SEARXNG_SECRET_KEY (gen-once) + render the overlay
# settings.yml from template. Standalone service — no backend deps, no
# preflight/prestart/poststart. Image is tag-class (official upstream), pulled
# at `dc up`; no eager build needed.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"

D="$STACK_ROOT/services/searxng"
GEN_DIR="$STACK_DIR/searxng"
GEN="$GEN_DIR/.generated.env"
SETTINGS_OUT="$GEN_DIR/settings.yml"
mkdir -p "$GEN_DIR"

# SEARXNG_SECRET_KEY: required by searxng, gen-once, kept stable across rebuilds
# (rotating it invalidates active session cookies — not a concern for our
# headless agent use but no reason to churn). 32 hex chars = 128 bits.
key="$(env_get "$GEN" SEARXNG_SECRET_KEY)"
if [ -z "$key" ]; then
  key="$(openssl rand -hex 32)"
  env_upsert "$GEN" SEARXNG_SECRET_KEY "$key"
  log "searxng: generated SEARXNG_SECRET_KEY -> $GEN"
else
  log "searxng: reusing existing SEARXNG_SECRET_KEY"
fi

# Render settings.yml from template. NOT using render_template's drift-check
# pattern: this file is generated state (secret embedded), not a user-editable
# config — it should always reflect template + current secret. If you need to
# tweak settings, edit the .template and re-run `just build` (or rm the output).
tpl="$D/settings.yml.template"
[ -f "$tpl" ] || die "searxng: missing $tpl"
# Use a sentinel substitution (NOT sed with the secret as the rhs — a literal
# `&` or `/` in the key would corrupt the result; openssl rand -hex emits only
# 0-9a-f so this is safe, but the awk form is robust regardless).
awk -v k="$key" '{ gsub(/__SEARXNG_SECRET_KEY__/, k); print }' "$tpl" > "$SETTINGS_OUT"
chmod 600 "$SETTINGS_OUT"
log "searxng: rendered $SETTINGS_OUT (use_default_settings=true + json format)"

log "searxng/build.sh DONE"
