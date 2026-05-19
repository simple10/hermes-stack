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

# --- stack_image (fake-docker shim) ----------------------------------------
_fake_docker_dir() {
  local d="$1"
  mkdir -p "$d/bin"
  cat > "$d/bin/docker" <<'SH'
#!/usr/bin/env bash
set -e
if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then
  ref="$4"
  case "$ref" in
    *":BADTAG") echo "fake-docker: not found" >&2; exit 1 ;;
    *)          digest="sha256:$(printf '%s' "$ref" | shasum -a 256 | cut -c1-64)"
                echo "$digest" ;;
  esac
  exit 0
fi
echo "fake-docker: unsupported args: $*" >&2; exit 2
SH
  chmod +x "$d/bin/docker"
}

test_stack_image_digest_passthrough() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _fake_docker_dir "$d"
  PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" \
    stack_image LITELLM ghcr.io/x/y sha256:abc123 litellm
  grep -q '^LITELLM_IMAGE=ghcr.io/x/y@sha256:abc123$' "$d/.stack/litellm/.generated.env" \
    || { echo "FAIL: LITELLM_IMAGE not written or wrong value"; return 1; }
  grep -q 'requested=sha256:abc123' "$d/.stack/litellm/.image.LITELLM.lock" \
    || { echo "FAIL: lock missing requested"; return 1; }
  echo "ok: stack_image digest passthrough"
}

test_stack_image_tag_resolve_via_fake_docker() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _fake_docker_dir "$d"
  PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" \
    stack_image LITELLM ghcr.io/x/y v1.78.6 litellm
  local val; val="$(env_get "$d/.stack/litellm/.generated.env" LITELLM_IMAGE)"
  [[ "$val" =~ ^ghcr.io/x/y@sha256:[0-9a-f]{64}$ ]] \
    || { echo "FAIL: tag-resolved LITELLM_IMAGE shape wrong: $val"; return 1; }
  echo "ok: stack_image tag-resolve"
}

test_stack_image_multi_image_coresident() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _fake_docker_dir "$d"
  PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" \
    stack_image FIRECRAWL_API ghcr.io/firecrawl/firecrawl sha256:aaa firecrawl
  PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" \
    stack_image FIRECRAWL_PLAYWRIGHT ghcr.io/firecrawl/playwright-service sha256:bbb firecrawl
  PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" \
    stack_image FIRECRAWL_POSTGRES ghcr.io/firecrawl/nuq-postgres sha256:ccc firecrawl
  local g="$d/.stack/firecrawl/.generated.env"
  grep -q '^FIRECRAWL_API_IMAGE=ghcr.io/firecrawl/firecrawl@sha256:aaa$' "$g" \
    && grep -q '^FIRECRAWL_PLAYWRIGHT_IMAGE=' "$g" \
    && grep -q '^FIRECRAWL_POSTGRES_IMAGE=' "$g" \
    || { echo "FAIL: multi-image env vars missing"; return 1; }
  ls "$d/.stack/firecrawl/.image.FIRECRAWL_API.lock" \
     "$d/.stack/firecrawl/.image.FIRECRAWL_PLAYWRIGHT.lock" \
     "$d/.stack/firecrawl/.image.FIRECRAWL_POSTGRES.lock" >/dev/null \
    || { echo "FAIL: per-image lock files missing"; return 1; }
  echo "ok: stack_image multi-image co-resident"
}

test_stack_image_fail_loud_on_bad_ref() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _fake_docker_dir "$d"
  if ( PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" \
       stack_image LITELLM ghcr.io/x/y BADTAG litellm ) 2>/dev/null; then
    echo "FAIL: bad ref did not die"; return 1
  fi
  echo "ok: stack_image fail-loud on bad ref"
}

test_stack_resolve_images_parses_real_format() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _fake_docker_dir "$d"
  mkdir -p "$d/services/litellm" "$d/services/firecrawl"
  cat > "$d/services/litellm/images.env" <<'EOF'
# litellm digest-class
LITELLM=ghcr.io/berriai/litellm-database@sha256:7bb80500  # tag v1.78.6
EOF
  cat > "$d/services/firecrawl/images.env" <<'EOF'
FIRECRAWL_API=ghcr.io/firecrawl/firecrawl@sha256:fb156ea5    # tag X

# blank line above and inline comment ok
FIRECRAWL_PLAYWRIGHT=ghcr.io/firecrawl/playwright-service@sha256:9e0737bc # tag Y
FIRECRAWL_POSTGRES=ghcr.io/firecrawl/nuq-postgres@sha256:f9388bd2# tag Z
EOF
  PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" stack_resolve_images
  local lg="$d/.stack/litellm/.generated.env"
  local fg="$d/.stack/firecrawl/.generated.env"
  grep -q '^LITELLM_IMAGE=ghcr.io/berriai/litellm-database@sha256:7bb80500$' "$lg" \
    || { echo "FAIL: LITELLM_IMAGE wrong"; cat "$lg"; return 1; }
  grep -q '^FIRECRAWL_API_IMAGE=ghcr.io/firecrawl/firecrawl@sha256:fb156ea5$' "$fg" \
    && grep -q '^FIRECRAWL_PLAYWRIGHT_IMAGE=' "$fg" \
    && grep -q '^FIRECRAWL_POSTGRES_IMAGE=' "$fg" \
    || { echo "FAIL: firecrawl multi-image"; cat "$fg"; return 1; }
  echo "ok: stack_resolve_images parses real format"
}

test_stack_resolve_images_skips_blank_and_comment_lines() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "${d:-}"' RETURN
  _fake_docker_dir "$d"
  mkdir -p "$d/services/hindsight"
  cat > "$d/services/hindsight/images.env" <<'EOF'
# all comments

#   indented comment
HINDSIGHT=ghcr.io/vectorize-io/hindsight@sha256:cafef00d  # tag t
EOF
  PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" stack_resolve_images
  grep -q '^HINDSIGHT_IMAGE=ghcr.io/vectorize-io/hindsight@sha256:cafef00d$' \
    "$d/.stack/hindsight/.generated.env" \
    || { echo "FAIL: hindsight not resolved"; return 1; }
  echo "ok: stack_resolve_images skips blanks + comments"
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
  test_stack_image_digest_passthrough || return 1
  test_stack_image_tag_resolve_via_fake_docker || return 1
  test_stack_image_multi_image_coresident || return 1
  test_stack_image_fail_loud_on_bad_ref || return 1
  test_stack_resolve_images_parses_real_format || return 1
  test_stack_resolve_images_skips_blank_and_comment_lines || return 1
}

run_helpers_tests || fail=1
exit $fail
