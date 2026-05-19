#!/usr/bin/env bash
# Tests for stack_required / stack_profiles / stack_backends.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. lib/stacklib.sh

fail=0
# set-equality: args = "actual" "expected-space-list"
seteq() {
  local a b
  a="$(printf '%s\n' $1 | sort | tr '\n' ' ')"
  b="$(printf '%s\n' $2 | sort | tr '\n' ' ')"
  if [ "$a" = "$b" ]; then echo "ok: [$1] == {$2}"; else
    echo "FAIL: got [$a] want [$b]"; fail=1; fi
}

# stack_profiles is comma-joined -> normalize to spaces for set compare.
# honcho requires litellm; hindsight requires litellm; agentmemory requires
# litellm; litellm requires pg,redis (transitive fixpoint).
seteq "$(stack_profiles 'litellm,honcho' | tr ',' ' ')"  'litellm honcho pg redis'
seteq "$(stack_profiles 'honcho-ui' | tr ',' ' ')"       'honcho-ui honcho pg redis litellm'
seteq "$(stack_profiles 'hindsight' | tr ',' ' ')"       'hindsight pg litellm redis'
seteq "$(stack_profiles 'agentmemory' | tr ',' ' ')"     'agentmemory litellm pg redis'
seteq "$(stack_profiles 'firecrawl' | tr ',' ' ')"       'firecrawl redis rabbitmq litellm pg'
# stack_backends is already space-separated
seteq "$(stack_backends 'litellm,honcho,cliproxyapi,honcho-ui')" 'pg redis'
seteq "$(stack_backends 'firecrawl')"                 'pg redis rabbitmq'
seteq "$(stack_backends 'cliproxyapi')"               ''
exit $fail
