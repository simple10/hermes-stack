#!/usr/bin/env bash
# camofox-browser/build.sh — own CAMOFOX_ACCESS_KEY (decentralized, gen-once)
# + fetch pinned _source + eager image build. Standalone service: no backend
# deps, no preflight/prestart/poststart.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
D="$STACK_ROOT/services/camofox-browser"
CAMOFOX_PIN="c9a90dafc76d2dfa0eb5d74fa36ef28f3ba98b29"  # jo-inc/camofox-browser pinned

# Own CAMOFOX_ACCESS_KEY (generated, hermetic). Read existing value first;
# never blind-regen (rotating would orphan any Hermes config already wired).
GEN="$STACK_DIR/camofox-browser.generated.env"
key="$(env_get "$GEN" CAMOFOX_ACCESS_KEY)"
[ -n "$key" ] || key="$(openssl rand -hex 32)"
env_upsert "$GEN" CAMOFOX_ACCESS_KEY "$key"
log "camofox-browser: CAMOFOX_ACCESS_KEY owned in camofox-browser.generated.env"

# Pinned build context (honcho precedent: reuse if present, else clone+pin,
# drop .git). rm a partial/corrupt clone (missing Dockerfile.ci) first.
if [ -d "$D/_source" ] && [ -f "$D/_source/Dockerfile.ci" ]; then
  log "camofox-browser: _source present (pinned build context) — reusing"
else
  log "camofox-browser: cloning jo-inc/camofox-browser @ $CAMOFOX_PIN"
  rm -rf "$D/_source"
  git clone https://github.com/jo-inc/camofox-browser "$D/_source"
  git -C "$D/_source" checkout "$CAMOFOX_PIN"
  rm -rf "$D/_source/.git"
fi

# Eager build (honcho-ui precedent) — surface the heavy Camoufox/Firefox
# build at `just build`, not mid-`just start`. First build downloads ~300MB
# Camoufox + apt Firefox/Xvfb deps (needs build-time network).
log "camofox-browser: building image (Dockerfile.ci)"
dc build camofox-browser
log "camofox-browser/build.sh DONE"
