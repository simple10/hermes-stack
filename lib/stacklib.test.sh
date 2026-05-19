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

# --- ensure_dockerignore -----------------------------------------------------
# Hermetic: uses tmp dirs only.
test_ensure_dockerignore() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  # (a) creates file with .git/ when missing
  ensure_dockerignore "$d"
  grep -qFx '.git/' "$d/.dockerignore" || { echo "FAIL: missing .git/ after create"; return 1; }
  # (b) preserves existing content, appends .git/ once
  printf 'foo\nbar\n' > "$d/.dockerignore"
  ensure_dockerignore "$d"
  ensure_dockerignore "$d"   # idempotent
  [ "$(grep -cFx '.git/' "$d/.dockerignore")" = "1" ] || { echo "FAIL: .git/ count != 1"; return 1; }
  grep -qFx 'foo' "$d/.dockerignore" && grep -qFx 'bar' "$d/.dockerignore" \
    || { echo "FAIL: upstream content clobbered"; return 1; }
  # (c) noop if .git/ already present
  printf 'baz\n.git/\nqux\n' > "$d/.dockerignore"
  local before; before="$(cat "$d/.dockerignore")"
  ensure_dockerignore "$d"
  [ "$(cat "$d/.dockerignore")" = "$before" ] || { echo "FAIL: noop case modified file"; return 1; }
  echo "ok: ensure_dockerignore"
}

# --- stack_source ------------------------------------------------------------
# Uses a local file:// bare repo as the upstream so tests are offline-safe.
_stack_source_make_upstream() {
  local d="$1"
  ( cd "$d" && git init -q --initial-branch=main upstream && cd upstream \
    && git config user.email t@t && git config user.name t \
    && printf 'A\n' > a.txt && git add a.txt && git commit -q -m a \
    && git tag v1 \
    && printf 'B\n' > a.txt && git commit -qa -m b \
    && git tag v2 \
    && git checkout -q -b sidebranch \
    && printf 'C\n' > a.txt && git commit -qa -m c \
    && local side_sha; side_sha="$(git rev-parse HEAD)" \
    && git checkout -q main \
    && cd .. && git clone -q --bare upstream upstream.git \
    && echo "$side_sha" > "$d/sidebranch_sha"
  )
}

test_stack_source_tag_resolve_and_dockerignore() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _stack_source_make_upstream "$d"
  local svc="testsvc"; local svc_dir="$d/services/$svc"; mkdir -p "$svc_dir"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  [ -d "$svc_dir/_source/.git" ] || { echo "FAIL: .git not retained"; return 1; }
  local sha; sha=$(git -C "$svc_dir/_source" rev-parse HEAD)
  grep -q "resolved_sha=$sha" "$d/.stack/$svc/.source.lock" || { echo "FAIL: lock missing resolved_sha"; return 1; }
  grep -qFx '.git/' "$svc_dir/_source/.dockerignore" || { echo "FAIL: .dockerignore not written"; return 1; }
  echo "ok: stack_source tag-resolve + .dockerignore + lock"
}

test_stack_source_reuse_no_network() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _stack_source_make_upstream "$d"
  local svc="testsvc"; mkdir -p "$d/services/$svc"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  # Remove the upstream entirely; reuse-fast-path must still work.
  rm -rf "$d/upstream.git"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  echo "ok: stack_source reuse path is offline"
}

test_stack_source_unknown_ref_fails_loud() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _stack_source_make_upstream "$d"
  mkdir -p "$d/services/testsvc"
  if ( STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" no-such-ref ) 2>/dev/null; then
    echo "FAIL: unknown ref did not die"; return 1
  fi
  echo "ok: stack_source unknown-ref dies loud"
}

test_stack_source_sidebranch_sha_fetch_fallback() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _stack_source_make_upstream "$d"
  mkdir -p "$d/services/testsvc"
  local side; side="$(cat "$d/sidebranch_sha")"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" "$side"
  [ "$(git -C "$d/services/testsvc/_source" rev-parse HEAD)" = "$side" ] \
    || { echo "FAIL: sidebranch SHA not checked out"; return 1; }
  echo "ok: stack_source sidebranch-SHA fetch fallback"
}

test_stack_source_change_detection() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _stack_source_make_upstream "$d"
  mkdir -p "$d/services/testsvc"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  rm -f "$d/.stack/testsvc/.source.rebuild"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v2
  [ -f "$d/.stack/testsvc/.source.rebuild" ] \
    || { echo "FAIL: rebuild marker missing after version change"; return 1; }
  echo "ok: stack_source change-detection sets rebuild marker"
}

test_stack_source_origin_url_mismatch_fails_loud() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _stack_source_make_upstream "$d"
  mkdir -p "$d/services/testsvc"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  git -C "$d/services/testsvc/_source" remote set-url origin "$d/totally-different.git"
  if ( STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1 ) 2>/dev/null; then
    echo "FAIL: origin mismatch did not die"; return 1
  fi
  echo "ok: stack_source origin-mismatch dies loud"
}

# Wrapper subshell: runs stack_source with STACK_ROOT/STACK_DIR overrides + set -e.
_stack_source_run() {
  ( set -e; stack_source "$@" )
}

run_helpers_tests() {
  # Isolation: clear any user-set version overrides so default-pin path is
  # actually exercised in tests.
  unset HONCHO_VERSION HONCHO_UI_VERSION CAMOFOX_BROWSER_VERSION BROWSER_USE_VERSION \
        LITELLM_VERSION HINDSIGHT_VERSION \
        FIRECRAWL_API_VERSION FIRECRAWL_PLAYWRIGHT_VERSION FIRECRAWL_POSTGRES_VERSION \
        TESTSVC_VERSION 2>/dev/null || true
  test_ensure_dockerignore || return 1
  test_stack_source_tag_resolve_and_dockerignore || return 1
  test_stack_source_reuse_no_network || return 1
  test_stack_source_origin_url_mismatch_fails_loud || return 1
  test_stack_source_unknown_ref_fails_loud || return 1
  test_stack_source_sidebranch_sha_fetch_fallback || return 1
  test_stack_source_change_detection || return 1
}

run_helpers_tests || fail=1
exit $fail
