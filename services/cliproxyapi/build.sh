#!/usr/bin/env bash
# cliproxyapi/build.sh — render config.yaml.template -> config.runtime.yaml
# (gitignored, bind-mounted) and inject the two secrets from .stack/.env.
# CLIProxyAPI has no env-var config support, so the rendered runtime file
# carries the keys; it is gitignored (hard rule = no secret in git).
# Deterministic each build (the file is generated, not hand-tuned).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/cliproxyapi"
require_stack_env

API_KEY="$(env_get "$STACK_DIR/.env" CLIPROXY_API_KEY)"
MGMT_KEY="$(env_get "$STACK_DIR/.env" CLIPROXY_MANAGEMENT_KEY)"
[ -n "$API_KEY" ]  || die "CLIPROXY_API_KEY missing in .stack/.env (run: just setup)"
[ -n "$MGMT_KEY" ] || die "CLIPROXY_MANAGEMENT_KEY missing in .stack/.env (run: just setup)"

tmp="$(mktemp)"
sed -e "s|__CLIPROXY_API_KEY__|${API_KEY}|g" \
    -e "s|__CLIPROXY_MGMT_KEY__|${MGMT_KEY}|g" \
    "$D/config.yaml.template" > "$tmp"
mv "$tmp" "$D/config.runtime.yaml"
chmod 600 "$D/config.runtime.yaml"
log "cliproxyapi: rendered config.runtime.yaml (secrets injected from .stack/.env)"
