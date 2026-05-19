#!/usr/bin/env bash
# For the default COMPOSE_PROFILES and each user profile individually,
# expand via stack_profiles and assert `docker compose config` resolves with
# NO "undefined service" (cross-profile depends_on satisfied). Non-destructive.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. lib/stacklib.sh

USER_PROFILES="litellm honcho honcho-ui cliproxyapi hindsight agentmemory firecrawl camofox-browser"
DEFAULT="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)"
fail=0
check() {
  local label="$1" seed="$2" exp pf err
  exp="$(stack_profiles "$seed")"
  pf=""; for p in $(printf '%s' "$exp" | tr ',' ' '); do pf="$pf --profile $p"; done
  err="$(docker compose -f docker-compose.yaml --env-file "$STACK_DIR/.env" $pf config 2>&1 >/dev/null || true)"
  if printf '%s' "$err" | grep -qi 'undefined service'; then
    echo "FAIL [$label] seed=$seed exp=$exp"; printf '%s\n' "$err" | grep -i 'undefined service'; fail=1
  else
    echo "ok   [$label] -> $exp"
  fi
}
check default "$DEFAULT"
for p in $USER_PROFILES; do check "$p" "$p"; done

# Positive check: agentmemory's litellm dep is via env_file (no compose
# depends_on) so the undefined-service test above cannot see it. Assert the
# resolved profile set includes litellm directly.
case ",$(stack_profiles agentmemory)," in
  *,litellm,*) echo "ok   [agentmemory->litellm resolved]";;
  *) echo "FAIL [agentmemory] stack_profiles missing litellm"; fail=1;;
esac
exit $fail
