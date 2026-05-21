#!/usr/bin/env bash
# services/hermes-workspace/build.sh — refuse-to-build until the user opens
# the Hermes gateway access gate. Phase 1 (stack_resolve_images in `just
# build`) already resolves HERMES_WORKSPACE_IMAGE from service.env; this
# script's only job is the safety check.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
require_stack_env

allow="$(env_get "$STACK_DIR/.env" HERMES_GATEWAY_ALLOW_ACCESS)"
if [ "$allow" != "true" ]; then
  die "hermes-workspace requires HERMES_GATEWAY_ALLOW_ACCESS=true in .stack/.env.

       The Hermes gateway defaults to loopback-only inside the VM. To allow
       hermes-workspace to reach it, opt in:

         1. edit .stack/.env: HERMES_GATEWAY_ALLOW_ACCESS=true
         2. just setup       # mints HERMES_GATEWAY_API_KEY (and HERMES_WORKSPACE_PASSWORD)
         3. just build       # rebuilds the hermes systemd unit + this service
         4. just start       # drain-restarts the gateway + brings up workspace

       SECURITY: this binds the gateway to 0.0.0.0 on the orb docker network.
       HERMES_GATEWAY_API_KEY is required on every inbound request. Only
       enable on a trusted dev Mac."
fi

# Note: HERMES_GATEWAY_URL is written by services/hermes/build.sh (which
# runs LATER in the same `just build` — the STACK_MACHINES loop runs after
# the COMPOSE_PROFILES loop). We deliberately don't read it here. compose.yaml
# uses ${HERMES_GATEWAY_URL:?...} as a runtime defense, so `just start` still
# fails loudly if hermes/build.sh somehow didn't write it.
log "hermes-workspace: gate open (HERMES_GATEWAY_ALLOW_ACCESS=true) — image resolution handled by Phase 1; URL written by services/hermes/build.sh"
