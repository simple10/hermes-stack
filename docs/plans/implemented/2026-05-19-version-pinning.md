# Version Pinning & Build Strategy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace opaque commit-SHA / image-digest pins + per-build-script
clone/checkout duplication with one stacklib-driven model: every
externally-sourced thing has a `<NAME>_VERSION` lever in `.stack/.env`, an
annotated immutable default in tracked code, and an auto-detected lock so
bumps "just work."

**Architecture:** Two new stacklib helpers (`stack_source` for git clone +
tag/SHA → commit resolution; `stack_image` for tag/digest → digest
resolution) plus one orchestrator (`stack_resolve_images`). `justfile`'s
`build:` becomes two explicit phases: Phase 1 resolves every digest-class
image unconditionally (compose `include:` interpolates the whole tree on
every `dc` call, so partial resolution is fatal); Phase 2 iterates
`stack_profiles | tr ',' ' '` (transitive) for per-service `build.sh`
runs. Tag-class images (Docker Hub / Hub-style ghcr) use raw compose
`${VAR:-default}` interpolation; digest-class ghcr images use
`"${<NAME>_IMAGE:?…}"`.

**Tech Stack:** bash (`lib/stacklib.sh`), `just` (justfile), Docker Compose
v5 + buildx (`docker buildx imagetools inspect` for tag→digest), git.

**Spec:** `docs/superpowers/specs/2026-05-19-version-pinning-design.md`

**Concurrent-stack rule:** `.stack/` is gitignored shared state; never
delete docker volumes; live-stack default round-trip must be non-
destructive (Acceptance #6). Commit with explicit `git add <paths>`;
inspect `git diff --cached` before each commit.

---

## File Structure

**Created:**
- `services/litellm/images.env` (1 line)
- `services/hindsight/images.env` (1 line)
- `services/firecrawl/images.env` (3 lines)
- `services/honcho-ui/.dockerignore` (1 line: `_source/.git/`)
- `lib/stacklib.test.sh` (tests for the 3 new helpers; appended to existing test file)

**Modified:**
- `lib/stacklib.sh` — add `stack_source`, `stack_image`, `stack_resolve_images`,
  internal `ensure_dockerignore` helper.
- `justfile` — restructure `build:` recipe (Phase 1 + Phase 2 expansion).
- `services/honcho/build.sh`, `services/honcho-ui/build.sh`,
  `services/camofox-browser/build.sh`, `services/browser-use/build.sh` —
  replace clone/checkout/rm-rf blocks with `stack_source` calls.
- `services/pg/compose.yaml`, `services/redis/compose.yaml`,
  `services/rabbitmq/compose.yaml`, `services/honcho/compose.yaml`
  (honcho-provision), `services/litellm/compose.yaml` (litellm-provision),
  `services/hindsight/compose.yaml` (hindsight-provision) — tag-class
  interpolation (6 lines).
- `services/litellm/compose.yaml`, `services/hindsight/compose.yaml`,
  `services/firecrawl/compose.yaml` — digest-class `image:` lines (5
  total) AND update line-4 header comments referencing `.image-digest`.
- `.stack.env.example` — version-lever block.
- `README.md` — pinning section (paths + helper model).

**Deleted:**
- `services/litellm/.image-digest`
- `services/firecrawl/.image-digest`
- `services/hindsight/.image-digest`

---

### Task 1: Feature branch

**Files:** none (git only)

- [ ] **Step 1: Branch off main (NOT a worktree — same checkout)**

Run:
```bash
cd /Users/joe/Development/ai-tools/openclaw/hermes-stack
git status --porcelain && echo "(clean)"
git checkout -b feat/version-pinning
git branch --show-current
```
Expected: `(clean)` then `feat/version-pinning`. If working tree is dirty, stop and inspect.

---

### Task 2: `ensure_dockerignore` + `stack_source` helpers (with tests)

**Files:**
- Modify: `lib/stacklib.sh` (add after the `stack_backends` function)
- Modify: `lib/stacklib.test.sh` (add new test cases)

- [ ] **Step 1: Write failing tests for `ensure_dockerignore` + `stack_source`**

Append to `lib/stacklib.test.sh`:

```bash

# --- ensure_dockerignore -----------------------------------------------------
# Hermetic: uses tmp dirs only.
test_ensure_dockerignore() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
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
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  _stack_source_make_upstream "$d"
  # Run stack_source against a fake SVC. Override the source dir + lock dir.
  local svc="testsvc"; local svc_dir="$d/services/$svc"; mkdir -p "$svc_dir"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  [ -d "$svc_dir/_source/.git" ] || { echo "FAIL: .git not retained"; return 1; }
  local sha; sha=$(git -C "$svc_dir/_source" rev-parse HEAD)
  grep -q "resolved_sha=$sha" "$d/.stack/$svc/.source.lock" || { echo "FAIL: lock missing resolved_sha"; return 1; }
  grep -qFx '.git/' "$svc_dir/_source/.dockerignore" || { echo "FAIL: .dockerignore not written"; return 1; }
  echo "ok: stack_source tag-resolve + .dockerignore + lock"
}

test_stack_source_reuse_no_network() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  _stack_source_make_upstream "$d"
  local svc="testsvc"; mkdir -p "$d/services/$svc"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  # Remove the upstream entirely; reuse-fast-path must still work.
  rm -rf "$d/upstream.git"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  echo "ok: stack_source reuse path is offline"
}

test_stack_source_unknown_ref_fails_loud() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  _stack_source_make_upstream "$d"
  mkdir -p "$d/services/testsvc"
  if ( STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" no-such-ref ) 2>/dev/null; then
    echo "FAIL: unknown ref did not die"; return 1
  fi
  echo "ok: stack_source unknown-ref dies loud"
}

test_stack_source_sidebranch_sha_fetch_fallback() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  _stack_source_make_upstream "$d"
  mkdir -p "$d/services/testsvc"
  local side; side="$(cat "$d/sidebranch_sha")"
  # First fetch the default branch via tag, then ask for the sidebranch SHA
  # — exercises the `git fetch origin <sha>` fallback path.
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" "$side"
  [ "$(git -C "$d/services/testsvc/_source" rev-parse HEAD)" = "$side" ] \
    || { echo "FAIL: sidebranch SHA not checked out"; return 1; }
  echo "ok: stack_source sidebranch-SHA fetch fallback"
}

test_stack_source_change_detection() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  _stack_source_make_upstream "$d"
  mkdir -p "$d/services/testsvc"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  rm -f "$d/.stack/testsvc/.source.rebuild"   # caller would clear it
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v2
  [ -f "$d/.stack/testsvc/.source.rebuild" ] \
    || { echo "FAIL: rebuild marker missing after version change"; return 1; }
  echo "ok: stack_source change-detection sets rebuild marker"
}

test_stack_source_origin_url_mismatch_fails_loud() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  _stack_source_make_upstream "$d"
  mkdir -p "$d/services/testsvc"
  STACK_ROOT="$d" STACK_DIR="$d/.stack" _stack_source_run testsvc "$d/upstream.git" v1
  # Change origin url to something unexpected; call should die.
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
# Append "run_helpers_tests || fail=1" before "exit $fail" — see step 5.
```

- [ ] **Step 2: Wire the new tests into `lib/stacklib.test.sh`**

Open `lib/stacklib.test.sh`. Immediately before the final `exit $fail` line, insert:
```bash
run_helpers_tests || fail=1
```

- [ ] **Step 3: Run the test; verify it FAILs (helpers undefined)**

Run:
```bash
bash lib/stacklib.test.sh 2>&1 | tail -5; echo "exit=$?"
```
Expected: errors like `ensure_dockerignore: command not found` / `stack_source: command not found`; `exit=1`.

- [ ] **Step 4: Implement `ensure_dockerignore` + `stack_source` in `lib/stacklib.sh`**

In `lib/stacklib.sh`, immediately after the `stack_backends() { … }` function, add:

```bash

# _svc_uc NAME — uppercase with hyphens->underscores. Internal to stack_source.
_svc_uc() { printf '%s' "$1" | tr 'a-z-' 'A-Z_'; }

# ensure_dockerignore SRC_DIR — make SRC_DIR/.dockerignore exist with `.git/`
# as one of its lines. Preserves any pre-existing content (idempotent).
ensure_dockerignore() {
  local src="$1" f="$1/.dockerignore"
  [ -d "$src" ] || die "ensure_dockerignore: $src is not a directory"
  if [ ! -f "$f" ]; then
    printf '.git/\n' > "$f"
    return 0
  fi
  if ! grep -qFx '.git/' "$f"; then
    printf '.git/\n' >> "$f"
  fi
}

# stack_source SVC REPO DEFAULT_PIN — clone-and-pin services/SVC/_source/ to
# ${<SVC_UC>_VERSION:-DEFAULT_PIN}. Reuse fast-path on lock+HEAD match. Always
# leaves _source at the resolved SHA, keeps .git, ensures _source/.dockerignore.
stack_source() {
  local svc="$1" repo="$2" default_pin="$3"
  local svc_uc; svc_uc="$(_svc_uc "$svc")"
  local requested; eval "requested=\${${svc_uc}_VERSION:-\$default_pin}"
  local src="$STACK_ROOT/services/$svc/_source"
  local lockdir="$STACK_DIR/$svc"
  local lock="$lockdir/.source.lock"

  # Identity check on existing _source (refuse if origin doesn't match).
  if [ -d "$src/.git" ]; then
    local origin_url; origin_url="$(git -C "$src" remote get-url origin 2>/dev/null || true)"
    if [ -n "$origin_url" ] && [ "$origin_url" != "$repo" ]; then
      die "stack_source($svc): $src origin '$origin_url' != expected '$repo' (re-clone manually if intended)"
    fi
  fi

  # Reuse fast-path: lock matches + HEAD matches -> no network, no marker.
  if [ -d "$src/.git" ] && [ -f "$lock" ]; then
    local lock_req lock_sha head
    lock_req="$(env_get "$lock" requested)"
    lock_sha="$(env_get "$lock" resolved_sha)"
    head="$(git -C "$src" rev-parse HEAD 2>/dev/null || true)"
    if [ "$lock_req" = "$requested" ] && [ "$head" = "$lock_sha" ]; then
      ensure_dockerignore "$src"
      log "stack_source($svc): reuse — $requested @ ${head:0:12}"
      return 0
    fi
  fi

  # Fresh clone if missing
  if [ ! -d "$src/.git" ]; then
    rm -rf "$src"
    log "stack_source($svc): cloning $repo (keeping .git)"
    git clone "$repo" "$src"
  fi

  # Resolve requested (tag, SHA, or branch).
  git -C "$src" fetch --tags origin
  local sha
  # `--verify` is required: without it, `git rev-parse 'bogus^{commit}'`
  # prints the literal string to stdout AND exits 128, defeating our
  # empty-string failure detection. With --verify, failure prints nothing
  # to stdout (errors go to stderr, suppressed).
  sha="$(git -C "$src" rev-parse --verify "${requested}^{commit}" 2>/dev/null || true)"
  if [ -z "$sha" ]; then
    git -C "$src" fetch origin "$requested" 2>/dev/null || true
    sha="$(git -C "$src" rev-parse --verify "${requested}^{commit}" 2>/dev/null \
        || git -C "$src" rev-parse --verify "origin/${requested}^{commit}" 2>/dev/null \
        || git -C "$src" rev-parse --verify "FETCH_HEAD^{commit}" 2>/dev/null \
        || true)"
  fi
  [ -n "$sha" ] || die "stack_source($svc): cannot resolve '$requested' in $repo"

  git -C "$src" checkout --detach "$sha"
  ensure_dockerignore "$src"

  mkdir -p "$lockdir"
  printf 'requested=%s\nresolved_sha=%s\n' "$requested" "$sha" > "$lock"
  touch "$lockdir/.source.rebuild"
  log "stack_source($svc): pinned $requested -> ${sha:0:12} (rebuild marker set)"
}
```

- [ ] **Step 5: Run tests; verify PASS**

Run:
```bash
bash lib/stacklib.test.sh 2>&1 | tail -10; echo "exit=$?"
```
Expected: `ok: ensure_dockerignore`, `ok: stack_source …` (three lines), and any pre-existing tests; `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add lib/stacklib.sh lib/stacklib.test.sh
git diff --cached --stat
git commit -m "feat(stacklib): stack_source + ensure_dockerignore (clone-pin + .git retention)"
```

---

### Task 3: `stack_image` helper (with tests via fake-docker shim)

**Files:**
- Modify: `lib/stacklib.sh` (add `stack_image` after `stack_source`)
- Modify: `lib/stacklib.test.sh` (add test cases)

- [ ] **Step 1: Write failing tests using a fake `docker` shim**

Append to `lib/stacklib.test.sh`, before the `run_helpers_tests` definition:

```bash

# Fake `docker` shim placed first on PATH; supports
#   docker buildx imagetools inspect REPO:TAG --format '{{.Manifest.Digest}}'
# Returns a deterministic digest derived from the tag (or fails for "BADTAG").
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
    *)          # synth digest deterministically from ref
                digest="sha256:$(printf '%s' "$ref" | shasum -a 256 | cut -c1-64)"
                echo "$digest" ;;
  esac
  exit 0
fi
echo "fake-docker: unsupported args: $*" >&2; exit 2
SH
  chmod +x "$d/bin/docker"
}

test_stack_image_digest_passthrough() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
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
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  _fake_docker_dir "$d"
  PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" \
    stack_image LITELLM ghcr.io/x/y v1.78.6 litellm
  local val; val="$(env_get "$d/.stack/litellm/.generated.env" LITELLM_IMAGE)"
  [[ "$val" =~ ^ghcr.io/x/y@sha256:[0-9a-f]{64}$ ]] \
    || { echo "FAIL: tag-resolved LITELLM_IMAGE shape wrong: $val"; return 1; }
  echo "ok: stack_image tag-resolve"
}

test_stack_image_multi_image_coresident() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
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
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
  _fake_docker_dir "$d"
  if ( PATH="$d/bin:$PATH" STACK_ROOT="$d" STACK_DIR="$d/.stack" \
       stack_image LITELLM ghcr.io/x/y BADTAG litellm ) 2>/dev/null; then
    echo "FAIL: bad ref did not die"; return 1
  fi
  echo "ok: stack_image fail-loud on bad ref"
}
```

Append into `run_helpers_tests`:
```bash
  test_stack_image_digest_passthrough || return 1
  test_stack_image_tag_resolve_via_fake_docker || return 1
  test_stack_image_multi_image_coresident || return 1
  test_stack_image_fail_loud_on_bad_ref || return 1
```

- [ ] **Step 2: Run; verify FAIL (`stack_image` undefined)**

Run: `bash lib/stacklib.test.sh 2>&1 | tail -5; echo "exit=$?"`
Expected: `stack_image: command not found`; exit non-zero.

- [ ] **Step 3: Implement `stack_image` in `lib/stacklib.sh`**

In `lib/stacklib.sh`, immediately after the new `stack_source` function, add:

```bash

# stack_image NAME REPO DEFAULT_PIN [SVC] — resolve ${<NAME>_VERSION:-DEFAULT_PIN}
# (tag or sha256: digest) to a concrete digest; write <NAME>_IMAGE=REPO@digest
# into .stack/<SVC>/.generated.env. SVC defaults to NAME (single-image services).
stack_image() {
  local name="$1" repo="$2" default_pin="$3"
  local svc="${4:-$1}"
  local requested; eval "requested=\${${name}_VERSION:-\$default_pin}"
  local lockdir="$STACK_DIR/$svc"
  local lock="$lockdir/.image.${name}.lock"
  local genenv="$lockdir/.generated.env"

  local digest
  case "$requested" in
    sha256:*) digest="$requested" ;;
    *)
      digest="$(docker buildx imagetools inspect "${repo}:${requested}" \
                  --format '{{.Manifest.Digest}}')" \
        || die "stack_image($name): 'docker buildx imagetools inspect ${repo}:${requested}' failed (network/auth/unknown tag)"
      [ -n "$digest" ] \
        || die "stack_image($name): empty digest for ${repo}:${requested}"
      ;;
  esac

  mkdir -p "$lockdir"
  # Write/update lock (cheap; idempotent).
  printf 'requested=%s\nresolved_digest=%s\n' "$requested" "$digest" > "$lock"
  # Always write the env var (idempotent via env_upsert).
  env_upsert "$genenv" "${name}_IMAGE" "${repo}@${digest}"
  log "stack_image($name): $requested -> ${digest:0:19}…"
}
```

- [ ] **Step 4: Run tests; verify PASS**

Run: `bash lib/stacklib.test.sh 2>&1 | tail -15; echo "exit=$?"`
Expected: all `ok:` lines including 4 new `stack_image` ones; `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add lib/stacklib.sh lib/stacklib.test.sh
git diff --cached --stat
git commit -m "feat(stacklib): stack_image (tag/digest -> digest resolver, multi-image)"
```

---

### Task 4: `stack_resolve_images` orchestrator (with tests)

**Files:**
- Modify: `lib/stacklib.sh` (add `stack_resolve_images` after `stack_image`)
- Modify: `lib/stacklib.test.sh` (add test cases)

- [ ] **Step 1: Write failing tests**

Append to `lib/stacklib.test.sh`, before `run_helpers_tests`:

```bash

test_stack_resolve_images_parses_real_format() {
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
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
  local d; d="$(mktemp -d)"; trap 'rm -rf "$d"' RETURN
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
```

Append into `run_helpers_tests`:
```bash
  test_stack_resolve_images_parses_real_format || return 1
  test_stack_resolve_images_skips_blank_and_comment_lines || return 1
```

- [ ] **Step 2: Run; verify FAIL**

Run: `bash lib/stacklib.test.sh 2>&1 | tail -5; echo "exit=$?"`
Expected: `stack_resolve_images: command not found`; exit non-zero.

- [ ] **Step 3: Implement `stack_resolve_images` in `lib/stacklib.sh`**

In `lib/stacklib.sh`, immediately after the new `stack_image` function, add:

```bash

# stack_resolve_images — iterate every services/*/images.env and resolve each
# image via stack_image. Runs UNCONDITIONALLY from `just build` Phase 1 because
# compose include: interpolates every file on every dc call.
stack_resolve_images() {
  local f svc name rest repo_pin repo default
  for f in "$STACK_ROOT"/services/*/images.env; do
    [ -e "$f" ] || continue
    svc="$(basename "$(dirname "$f")")"
    while IFS='=' read -r name rest; do
      # strip CRLF tail from BOTH name and rest (or the no-inline-comment
      # path leaves a literal \r in the resolved digest value).
      name="${name%$'\r'}"; rest="${rest%$'\r'}"
      # trim leading whitespace from name
      name="$(printf '%s' "$name" | sed -e 's/^[[:space:]]*//')"
      [ -z "$name" ] && continue
      case "$name" in '#'*) continue;; esac
      # strip inline "# …" comment, then trim outer whitespace via read -r.
      repo_pin="${rest%%#*}"
      read -r repo_pin <<<"$repo_pin"
      [ -n "$repo_pin" ] || die "stack_resolve_images: malformed (empty value) in $f: '$name'"
      repo="${repo_pin%@*}"
      default="${repo_pin#*@}"
      [ -n "$repo" ] && [ -n "$default" ] && [ "$repo" != "$repo_pin" ] \
        || die "stack_resolve_images: malformed (need REPO@PIN) in $f: '$name=$repo_pin'"
      stack_image "$name" "$repo" "$default" "$svc"
    done < "$f"
  done
}
```

- [ ] **Step 4: Run tests; verify PASS**

Run: `bash lib/stacklib.test.sh 2>&1 | tail -20; echo "exit=$?"`
Expected: all `ok:` lines (including 2 new `stack_resolve_images`); `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add lib/stacklib.sh lib/stacklib.test.sh
git diff --cached --stat
git commit -m "feat(stacklib): stack_resolve_images orchestrator (unconditional Phase 1)"
```

---

### Task 5: `justfile build:` two-phase orchestration

**Files:** Modify `justfile`

- [ ] **Step 1: Read current build recipe**

Run:
```bash
sed -n '/^build:/,/^[[:alnum:]_-]\+:\|^$/p' justfile | head -25
```
Note the current layout: explicit `services/pg/build.sh` call + per-`COMPOSE_PROFILES` loop + per-`STACK_MACHINES` loop.

- [ ] **Step 2: Replace build recipe with two-phase form**

Open `justfile`. Find the `build:` recipe. Replace its body with:

```just
build:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     echo "== Phase 1: resolve digest-class images =="; \
     stack_resolve_images; \
     echo "== Phase 1 done — image refs in .stack/<svc>/.generated.env =="; \
     bash "{{root}}/services/pg/build.sh"; \
     for p in $(stack_profiles | tr ',' ' '); do \
       [ "$p" = "pg" ] && continue; \
       [ -x "{{root}}/services/$p/build.sh" ] && bash "{{root}}/services/$p/build.sh" || true; \
     done; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$mch" ] && [ -x "{{root}}/machines/$mch/build.sh" ] && \
         bash "{{root}}/machines/$mch/build.sh" "$mch" || true; \
     done; \
     echo "build complete"
```

(Key differences from existing: `stack_resolve_images` call first; `for p in $(stack_profiles | tr ',' ' ')` instead of raw COMPOSE_PROFILES.)

- [ ] **Step 3: Verify just still parses**

Run: `just --list >/dev/null && echo PARSE_OK`
Expected: `PARSE_OK`.

- [ ] **Step 4: Commit**

```bash
git add justfile
git diff --cached --stat
git commit -m "feat(justfile): build runs stack_resolve_images first + expands stack_profiles"
```

---

### Task 6: Tag-class compose interpolation (6 lines)

**Files:** modify 6 compose files

- [ ] **Step 1: pg compose — `${PG_VERSION:-pg18}`**

In `services/pg/compose.yaml`, change:
```yaml
    image: pgvector/pgvector:pg18
```
to:
```yaml
    image: "pgvector/pgvector:${PG_VERSION:-pg18}"
```

- [ ] **Step 2: redis compose — `${REDIS_VERSION:-8.6.3}`**

In `services/redis/compose.yaml`, change:
```yaml
    image: redis:8.6.3
```
to:
```yaml
    image: "redis:${REDIS_VERSION:-8.6.3}"
```

- [ ] **Step 3: rabbitmq compose — `${RABBITMQ_VERSION:-4.3.0-management}`**

In `services/rabbitmq/compose.yaml`, change:
```yaml
    image: rabbitmq:4.3.0-management
```
to:
```yaml
    image: "rabbitmq:${RABBITMQ_VERSION:-4.3.0-management}"
```

- [ ] **Step 4: honcho-provision (line ~67) — pgvector interpolation**

In `services/honcho/compose.yaml`, find the `honcho-provision:` block. Change:
```yaml
    image: pgvector/pgvector:pg18
```
to:
```yaml
    image: "pgvector/pgvector:${PG_VERSION:-pg18}"
```

- [ ] **Step 5: litellm-provision (line ~42) — pgvector interpolation**

In `services/litellm/compose.yaml`, find the `litellm-provision:` block. Change:
```yaml
    image: pgvector/pgvector:pg18
```
to:
```yaml
    image: "pgvector/pgvector:${PG_VERSION:-pg18}"
```

- [ ] **Step 6: hindsight-provision (line ~76) — pgvector interpolation**

In `services/hindsight/compose.yaml`, find the `hindsight-provision:` block. Change:
```yaml
    image: pgvector/pgvector:pg18
```
to:
```yaml
    image: "pgvector/pgvector:${PG_VERSION:-pg18}"
```

- [ ] **Step 7: Verify coverage + compose parses**

Run:
```bash
echo "=== all pgvector refs interpolated? ===" && grep -rn 'pgvector/pgvector' services/*/compose.yaml
echo "=== redis ref ===" && grep -n 'image:' services/redis/compose.yaml
echo "=== rabbitmq ref ===" && grep -n 'image:' services/rabbitmq/compose.yaml
echo "=== dc config still resolves ===" && bash -c '. lib/stacklib.sh; dc config --services 2>/dev/null | sort | tr "\n" " "; echo'
```
Expected: every `pgvector/pgvector` line contains `${PG_VERSION:-pg18}`; redis/rabbitmq similarly; `dc config --services` lists the default services with no error.

- [ ] **Step 8: Commit**

```bash
git add services/pg/compose.yaml services/redis/compose.yaml services/rabbitmq/compose.yaml \
        services/honcho/compose.yaml services/litellm/compose.yaml services/hindsight/compose.yaml
git diff --cached --stat
git commit -m "feat(compose): tag-class images interpolated (PG/REDIS/RABBITMQ_VERSION; 4× pgvector coherent)"
```

---

### Task 7: Convert `_source` build scripts to `stack_source`

**Files:** modify 4 build.sh files; create `services/honcho-ui/.dockerignore`

- [ ] **Step 1: honcho/build.sh — replace clone/checkout block**

Open `services/honcho/build.sh`. Replace the lines (currently):
```bash
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
```
with:
```bash
# Pinned commit of plastic-labs/honcho. Bumpable via .stack/.env HONCHO_VERSION
# (tag or commit SHA). Tracked default below MUST stay annotated with a tag.
stack_source honcho https://github.com/plastic-labs/honcho \
  8fcbb54a49292341dba79d606ee332c50778429b   # tag <annotate after first build>
```

Then update the eager-build block — currently:
```bash
log "honcho: building image (honcho-api + honcho-deriver share one context)"
dc build honcho-api honcho-deriver
```
Change to (only rebuild when `stack_source` marked it):
```bash
if [ -f "$STACK_DIR/honcho/.source.rebuild" ]; then
  log "honcho: source changed — building image (honcho-api + honcho-deriver share one context)"
  dc build honcho-api honcho-deriver
  rm -f "$STACK_DIR/honcho/.source.rebuild"
else
  log "honcho: source unchanged — skipping dc build"
fi
```

- [ ] **Step 2: honcho-ui/build.sh — same conversion**

Open `services/honcho-ui/build.sh`. Replace its clone/checkout block (around lines 11–22) — `OPENCONCHO_PIN=...` plus the `if [ -d "$D/_source" ] ... fi` block plus the `rm -rf "$D/_source/.git"` plus the trailing `log "honcho-ui: source ready ..."` — with:
```bash
stack_source honcho-ui https://github.com/offendingcommit/openconcho \
  e490d911fcb27ee193558fd9a28856cde2057665   # tag <annotate after first build>
```
And conditionalize any subsequent `dc build` call the same way as honcho:
```bash
if [ -f "$STACK_DIR/honcho-ui/.source.rebuild" ]; then
  log "honcho-ui: source changed — building image"
  dc build honcho-ui
  rm -f "$STACK_DIR/honcho-ui/.source.rebuild"
else
  log "honcho-ui: source unchanged — skipping dc build"
fi
```

- [ ] **Step 3: camofox-browser/build.sh — same conversion**

Open `services/camofox-browser/build.sh`. Replace the lines (currently):
```bash
CAMOFOX_PIN="c9a90dafc76d2dfa0eb5d74fa36ef28f3ba98b29"  # jo-inc/camofox-browser pinned

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
```
with:
```bash
stack_source camofox-browser https://github.com/jo-inc/camofox-browser \
  c9a90dafc76d2dfa0eb5d74fa36ef28f3ba98b29   # tag <annotate after first build>
```
And conditionalize the existing `dc build camofox-browser` line:
```bash
if [ -f "$STACK_DIR/camofox-browser/.source.rebuild" ]; then
  log "camofox-browser: source changed — building image (Dockerfile.ci)"
  dc build camofox-browser
  rm -f "$STACK_DIR/camofox-browser/.source.rebuild"
else
  log "camofox-browser: source unchanged — skipping dc build"
fi
```

- [ ] **Step 4: browser-use/build.sh — same conversion**

Open `services/browser-use/build.sh`. Replace the lines (currently):
```bash
BROWSER_USE_PIN="157779338afdcc03023010ec3c24ad63d820453c"

if [ -d "$D/_source" ] && [ -f "$D/_source/Dockerfile" ]; then
  log "browser-use: _source present (pinned build context) — reusing"
else
  log "browser-use: cloning browser-use/browser-use @ $BROWSER_USE_PIN"
  git clone https://github.com/browser-use/browser-use "$D/_source"
  git -C "$D/_source" checkout "$BROWSER_USE_PIN"
  rm -rf "$D/_source/.git"
fi
log "browser-use: source ready (pin ${BROWSER_USE_PIN:0:12})"
```
with:
```bash
stack_source browser-use https://github.com/browser-use/browser-use \
  157779338afdcc03023010ec3c24ad63d820453c   # tag <annotate after first build>
```
And conditionalize the existing eager `dc build browser-use`:
```bash
if [ -f "$STACK_DIR/browser-use/.source.rebuild" ]; then
  log "browser-use: source changed — building image (upstream Dockerfile)"
  dc build browser-use
  rm -f "$STACK_DIR/browser-use/.source.rebuild"
else
  log "browser-use: source unchanged — skipping dc build"
fi
```

- [ ] **Step 5: Create tracked honcho-ui `.dockerignore`**

Reason: honcho-ui's `build.context: .` (not `./_source`), so `_source/.dockerignore` is not consulted by Docker — only a tracked file at `services/honcho-ui/.dockerignore` works.

Write `services/honcho-ui/.dockerignore`:
```
_source/.git/
```

- [ ] **Step 6: Verify all build.sh files have no leftover clone/checkout/rm-.git lines**

Run:
```bash
for s in honcho honcho-ui camofox-browser browser-use; do
  echo "== $s =="; grep -nE '_PIN=|git clone|git checkout|rm -rf .*\.git' services/$s/build.sh && echo "STALE!" || echo "clean"
done
```
Expected: `clean` for all four. (No `_PIN=` literals, no inline `git clone`/`checkout`, no `rm -rf .git`.)

- [ ] **Step 7: Annotate the four `# tag <annotate after first build>` comments**

Resolve each pin's actual upstream tag (one of):
- `git -C services/<svc>/_source describe --tags --always <sha>` after a build, OR
- check upstream releases page,
- if no exact tag matches, annotate with date or branch (e.g. `# main@2026-05-15`).

For each of `honcho`, `honcho-ui`, `camofox-browser`, `browser-use`, replace the `<annotate after first build>` text in build.sh with the actual finding. The annotation MUST be honest; never leave the placeholder text.

(Concrete: do this after Task 8 completes the first `just build` and produces `_source` checkouts with `.git`, then `git describe` resolves each.)

- [ ] **Step 8: Commit (annotations included)**

```bash
git add services/honcho/build.sh services/honcho-ui/build.sh \
        services/camofox-browser/build.sh services/browser-use/build.sh \
        services/honcho-ui/.dockerignore
git diff --cached --stat
git commit -m "feat(build): _source services use stack_source; honcho-ui .dockerignore"
```

---

### Task 8: Create `images.env` for digest-class services + annotate tags

**Files:**
- Create: `services/litellm/images.env`,
  `services/hindsight/images.env`, `services/firecrawl/images.env`

- [ ] **Step 1: Capture current digests (for the tracked defaults)**

Run:
```bash
grep -E '^\s*image:.*@sha256:' services/litellm/compose.yaml services/hindsight/compose.yaml services/firecrawl/compose.yaml
```
Record the 5 current digests (litellm-database, hindsight, firecrawl, playwright-service, nuq-postgres).

- [ ] **Step 2: Resolve each digest's upstream tag (research)**

For each digest, run:
```bash
# Generic recipe — try a few known tag patterns + cross-check digest equality.
docker buildx imagetools inspect '<REPO>:<TAG>' --format '{{.Manifest.Digest}}'
```
Match the printed digest against the captured digest. If no obvious tag matches, fall back to date (`git log` of the commit that added the digest) and use `# main@YYYY-MM-DD` style.

Concrete starting tags to try (do NOT trust without verification):
- `ghcr.io/berriai/litellm-database`: try recent `main-v1.x.x-stable` tags.
- `ghcr.io/firecrawl/firecrawl`, `playwright-service`, `nuq-postgres`: try `latest`, `v1.x`, dated tags.
- `ghcr.io/vectorize-io/hindsight`: try `v0.x`, `latest`.

Record the resolved tag for each.

- [ ] **Step 3: Write `services/litellm/images.env`**

Replace `<DIGEST_FROM_STEP1>` and `<TAG_FROM_STEP2>` with the captured/resolved values:
```
# litellm — digest-class (ghcr). Bump via LITELLM_VERSION in .stack/.env
# (tag or sha256: digest). Default is immutable + annotated with its tag.
LITELLM=ghcr.io/berriai/litellm-database@<DIGEST_FROM_STEP1>  # tag <TAG_FROM_STEP2>
```

- [ ] **Step 4: Write `services/hindsight/images.env`**

```
# hindsight — digest-class (ghcr). Bump via HINDSIGHT_VERSION.
HINDSIGHT=ghcr.io/vectorize-io/hindsight@<DIGEST_FROM_STEP1>  # tag <TAG_FROM_STEP2>
```

- [ ] **Step 5: Write `services/firecrawl/images.env`**

```
# firecrawl — digest-class (ghcr). Bump via FIRECRAWL_API_VERSION /
# FIRECRAWL_PLAYWRIGHT_VERSION / FIRECRAWL_POSTGRES_VERSION.
#
# Provenance (from the deleted services/firecrawl/.image-digest):
#   Resolved 2026-05-18 from :latest (upstream ships no semver; digest is
#   the only stable pin). Bump deliberately: re-resolve + update both
#   here AND in services/firecrawl/compose.yaml in one commit.
FIRECRAWL_API=ghcr.io/firecrawl/firecrawl@<DIGEST_FROM_STEP1>            # tag <TAG_FROM_STEP2>
FIRECRAWL_PLAYWRIGHT=ghcr.io/firecrawl/playwright-service@<DIGEST_FROM_STEP1>  # tag <TAG_FROM_STEP2>
FIRECRAWL_POSTGRES=ghcr.io/firecrawl/nuq-postgres@<DIGEST_FROM_STEP1>    # tag <TAG_FROM_STEP2>
```

(Before deleting `services/firecrawl/.image-digest` in Task 10, copy any
existing provenance header from it into the comment block above; same for
litellm/hindsight images.env if their `.image-digest` files have non-trivial
context.)

- [ ] **Step 6: Verify the resolver consumes them correctly**

Run:
```bash
bash -c '. lib/stacklib.sh; require_stack_env; stack_resolve_images && echo "OK"'
ls .stack/litellm/.image.LITELLM.lock \
   .stack/hindsight/.image.HINDSIGHT.lock \
   .stack/firecrawl/.image.{FIRECRAWL_API,FIRECRAWL_PLAYWRIGHT,FIRECRAWL_POSTGRES}.lock
grep -E '_IMAGE=' .stack/{litellm,hindsight,firecrawl}/.generated.env
```
Expected: `OK`, 5 lock files exist, 5 `<NAME>_IMAGE=…@sha256:…` lines.

- [ ] **Step 7: Commit**

```bash
git add services/litellm/images.env services/hindsight/images.env services/firecrawl/images.env
git diff --cached --stat
git commit -m "feat(images): tracked images.env declarations for digest-class services"
```

---

### Task 9: Convert digest-class compose `image:` lines + update header comments

**Files:** modify `services/litellm/compose.yaml`, `services/hindsight/compose.yaml`, `services/firecrawl/compose.yaml`

- [ ] **Step 1: litellm compose — `image:` + header comment**

In `services/litellm/compose.yaml`, change the line (currently):
```yaml
    image: ghcr.io/berriai/litellm-database@sha256:7bb80500...
```
to:
```yaml
    image: "${LITELLM_IMAGE:?run 'just build' to resolve LITELLM_VERSION}"
```

Then update the line-4 header comment (currently mentions `services/litellm/.image-digest`):
```
# services/litellm/.image-digest; bump deliberately via commit (update both).
```
Replace with (still around line 4):
```
# Digest resolved at build time from services/litellm/images.env -> LITELLM_IMAGE;
# bump via .stack/.env LITELLM_VERSION (tag or sha256 digest).
```

- [ ] **Step 2: hindsight compose — `image:` + header comment**

In `services/hindsight/compose.yaml`, change:
```yaml
    image: ghcr.io/vectorize-io/hindsight@sha256:...
```
to:
```yaml
    image: "${HINDSIGHT_IMAGE:?run 'just build' to resolve HINDSIGHT_VERSION}"
```

Update line-4 comment:
```
# services/hindsight/.image-digest; bump deliberately via commit (update both).
```
→
```
# Digest resolved at build time from services/hindsight/images.env -> HINDSIGHT_IMAGE;
# bump via .stack/.env HINDSIGHT_VERSION (tag or sha256 digest).
```

- [ ] **Step 3: firecrawl compose — 3 `image:` lines + header comment**

In `services/firecrawl/compose.yaml`:

- `firecrawl-postgres:` block — change:
  ```yaml
      image: ghcr.io/firecrawl/nuq-postgres@sha256:...
  ```
  to:
  ```yaml
      image: "${FIRECRAWL_POSTGRES_IMAGE:?run 'just build' to resolve FIRECRAWL_POSTGRES_VERSION}"
  ```

- `firecrawl-playwright:` block — change:
  ```yaml
      image: ghcr.io/firecrawl/playwright-service@sha256:...
  ```
  to:
  ```yaml
      image: "${FIRECRAWL_PLAYWRIGHT_IMAGE:?run 'just build' to resolve FIRECRAWL_PLAYWRIGHT_VERSION}"
  ```

- `firecrawl-api:` block — change:
  ```yaml
      image: ghcr.io/firecrawl/firecrawl@sha256:...
  ```
  to:
  ```yaml
      image: "${FIRECRAWL_API_IMAGE:?run 'just build' to resolve FIRECRAWL_API_VERSION}"
  ```

Update line-4 comment (currently mentions `services/firecrawl/.image-digest`):
```
# #6) — mirrored in services/firecrawl/.image-digest. firecrawl-postgres is
```
→
```
# #6) — digests resolved at build time from services/firecrawl/images.env ->
# FIRECRAWL_{API,PLAYWRIGHT,POSTGRES}_IMAGE; bump via FIRECRAWL_*_VERSION in
# .stack/.env. firecrawl-postgres is
```

- [ ] **Step 4: Verify compose parse (after Task 8 wrote env vars)**

Run:
```bash
bash -c '. lib/stacklib.sh; dc config --services 2>&1 | grep -E "(undefined|required variable)" && echo "BAD" || echo "OK"'
bash lib/profiles.test.sh >/dev/null 2>&1 && echo "profiles.test PASS" || echo "profiles.test FAIL"
```
Expected: `OK` and `profiles.test PASS`. If "required variable" appears, Task 8 wasn't run or `<NAME>_IMAGE` is missing.

- [ ] **Step 5: Commit**

```bash
git add services/litellm/compose.yaml services/hindsight/compose.yaml services/firecrawl/compose.yaml
git diff --cached --stat
git commit -m "feat(compose): digest-class image: lines use \${...:?} (resolved by stack_resolve_images)"
```

---

### Task 10: Delete `.image-digest` sidecars

**Files:** delete 3 files

- [ ] **Step 1: Confirm files exist + delete**

Run:
```bash
ls services/litellm/.image-digest services/hindsight/.image-digest services/firecrawl/.image-digest
git rm services/litellm/.image-digest services/hindsight/.image-digest services/firecrawl/.image-digest
git status --porcelain
```
Expected: 3 lines deleted (`D` prefix in status).

- [ ] **Step 2: Commit**

```bash
git diff --cached --stat
git commit -m "chore(images): remove .image-digest sidecars (replaced by images.env + locks)"
```

---

### Task 11: `.stack.env.example` — version-lever block

**Files:** modify `.stack.env.example`

- [ ] **Step 1: Insert version block**

Open `.stack.env.example`. Find the `LITELLM_VIRTKEYS=...` line near the end. Immediately AFTER that line, append:

```sh

# === Service versions ========================================================
# All OPTIONAL; defaults are the tracked annotated pins in
# services/<svc>/images.env (digest class) and services/<svc>/build.sh
# (source class).
#
# Tag class — accepts an upstream tag (pulled as-is; minor drift accepted):
#   PG_VERSION=pg18
#   REDIS_VERSION=8.6.3
#   RABBITMQ_VERSION=4.3.0-management
#   CLIPROXY_VERSION=v7.1.11
#
# Digest class — accepts a tag (resolved to digest at build) OR a sha256: digest:
#   LITELLM_VERSION=<tag-or-digest>
#   HINDSIGHT_VERSION=<tag-or-digest>
#   FIRECRAWL_API_VERSION=<tag-or-digest>
#   FIRECRAWL_PLAYWRIGHT_VERSION=<tag-or-digest>
#   FIRECRAWL_POSTGRES_VERSION=<tag-or-digest>
#
# Source class — accepts a tag OR commit SHA (fetched, checked out, rebuilt):
#   HONCHO_VERSION=<tag-or-sha>
#   HONCHO_UI_VERSION=<tag-or-sha>
#   CAMOFOX_BROWSER_VERSION=<tag-or-sha>
#   BROWSER_USE_VERSION=<tag-or-sha>
```

- [ ] **Step 2: Commit**

```bash
git add .stack.env.example
git diff --cached --stat
git commit -m "docs(env-example): document the new version-pinning levers"
```

---

### Task 12: README pinning section update

**Files:** modify `README.md`

- [ ] **Step 1: Locate pinning-related prose to UPDATE**

Run:
```bash
grep -nE 'pinned by digest|digest-pinned|image-digest|PIN=|HONCHO_PIN|_PIN' README.md
```
The lines to UPDATE are those that:
- assert "**pinned by digest**" or "digest-pinned" (factual claim now mediated
  by `images.env` + `<NAME>_VERSION`), or
- mention `.image-digest` sidecars (deleted in Task 10), or
- name a specific `<SVC>_PIN` constant that no longer exists.

Lines that just say "pinned `_source/`" or "pinned commit" in service
descriptions are still accurate (the source IS pinned, via `stack_source`)
— leave them. Do NOT rewrite unaffected prose.

- [ ] **Step 2: Update the Architecture intro's "image pinning" sentence**

Find any sentence that asserts "images are digest-pinned" or references hand-edited digest pins. Replace with a one-paragraph summary:

> Image and source pinning uses one model: each externally-sourced thing
> has a `<NAME>_VERSION` lever in `.stack/.env`, an annotated immutable
> default tracked in code (`services/<svc>/images.env` for digest-class
> images; the `stack_source` call's third arg in `build.sh` for `_source`
> services), and an auto-detected lock at `.stack/<svc>/.image.<NAME>.lock`
> or `.stack/<svc>/.source.lock`. `just build` Phase 1 unconditionally
> resolves every digest-class image (compose `include:` is global);
> Phase 2 iterates `stack_profiles` (transitive) for per-service builds.

- [ ] **Step 3: Commit**

```bash
git add README.md
git diff --cached --stat
git commit -m "docs(readme): describe new version-pinning model (helpers + two-phase build)"
```

---

### Task 13: Live-stack non-destructive verification (Acceptance #5 + #6)

**Files:** none (live `.stack/` + containers)

- [ ] **Step 1: Snapshot current resolved image refs (pre-build)**

Run:
```bash
bash -c '. lib/stacklib.sh; dc ps --format "{{.Service}}: {{.Image}}" | sort | tee /tmp/pin-pre.txt'
```

- [ ] **Step 2: Run `just build` — Phase 1 + Phase 2; expect zero secret regenerations**

Run:
```bash
just build 2>&1 | tail -25
```
Expected: ends with `build complete`. Look for log lines like
`stack_image(LITELLM): sha256:… -> …` (Phase 1) and either
`stack_source(...): cloning …` (first run on this stack — existing
`_source` had no `.git` from the old pattern) **or**
`stack_source(...): reuse …` (subsequent runs). No `regenerating` lines
for passwords.

- [ ] **Step 3: Verify all `_source` dirs retain `.git`**

Run:
```bash
for s in honcho honcho-ui camofox-browser browser-use; do
  if [ -d services/$s/_source/.git ]; then
    echo "$s: HEAD=$(git -C services/$s/_source rev-parse HEAD | cut -c1-12)  lock=$(env_get .stack/$s/.source.lock resolved_sha | cut -c1-12)"
  fi
done
```
(Only services whose `_source` was already present will show. For services freshly cloned by this run, the same line still applies.)
Expected: HEAD matches lock for each.

- [ ] **Step 4: Acceptance #5 — inactive-profile resolution (B1 fix)**

`dc()` reads its profile set from `.stack/.env` via `stack_profiles`, not
from the shell env (because of `env -i`). To exercise the
`COMPOSE_PROFILES=cliproxyapi`-only scenario WITHOUT mutating `.stack/.env`,
call `docker compose` directly with explicit `--env-file` globs and just
the `cliproxyapi` profile:

```bash
docker compose -f docker-compose.yaml \
  --env-file .stack/.env \
  $(printf -- '--env-file %s ' .stack/*/.generated.env) \
  --profile cliproxyapi \
  config -q 2>&1 | head
echo "exit=$?"
```
Expected: empty output (no errors), `exit=0`. Compose interpolation parses
EVERY included file regardless of profile, so this proves that with
Phase 1 having populated every `<NAME>_IMAGE`, the `${…:?}` references in
litellm/hindsight/firecrawl compose are satisfied even when those profiles
are inactive. If you see `required variable … is missing`, Phase 1 didn't
populate one of the env-vars — investigate `.stack/<svc>/.generated.env`.

- [ ] **Step 5: Acceptance #6 — non-destructive default round-trip**

Run:
```bash
bash -c '. lib/stacklib.sh; dc up -d 2>&1 | tail -10'
bash -c '. lib/stacklib.sh; dc ps --format "{{.Service}}: {{.Image}}" | sort > /tmp/pin-post.txt'
diff /tmp/pin-pre.txt /tmp/pin-post.txt && echo "NO_DRIFT" || echo "DRIFT"
just status | sed -n '/DOCKER/,/VMs/p'
```
Expected: `dc up -d` reports `0 created, 0 recreated`. `NO_DRIFT`. `just status` shows all services healthy.

---

### Task 14: Commit final docs adjustments + report

**Files:** any docs the previous tasks deferred.

- [ ] **Step 1: Fill the four `# tag <annotate …>` placeholders in build.sh + commit**

By this point Task 13's `just build` has populated every `_source/.git`, so
`git describe` resolves. Run:
```bash
grep -n 'annotate after first build' services/*/build.sh || echo "no placeholders found"
```
For each match:
```bash
# inside services/<svc>/_source, with .git present:
git -C services/<svc>/_source describe --tags --always
```
If `describe` returns an exact tag (e.g. `v0.12.7`), replace the placeholder
text with `# tag v0.12.7`. If it returns a "tag-N-gHASH" form, use the base
tag + commit info (e.g. `# tag v0.12.7-3-gabcdef`). If `describe` returns
only a short SHA (no tag in history), use `# main@YYYY-MM-DD` (date of the
commit: `git -C services/<svc>/_source log -1 --format=%cs HEAD`).

Then make a **new commit at HEAD** (do NOT amend — the commit to update is
several back, and interactive rebase is unavailable):
```bash
git add services/honcho/build.sh services/honcho-ui/build.sh \
        services/camofox-browser/build.sh services/browser-use/build.sh
git diff --cached --stat
git commit -m "docs(build): annotate stack_source default pins with upstream tags"
grep -n 'annotate after first build' services/*/build.sh && echo "STILL PLACEHOLDER" || echo "annotated"
```
Expected: `annotated`.

- [ ] **Step 2: Report**

Run:
```bash
git log --oneline main..HEAD
just status | sed -n '/DOCKER/,/VMs/p'
bash lib/stacklib.test.sh >/dev/null && echo "tests PASS"
bash lib/profiles.test.sh >/dev/null && echo "profiles PASS"
```
Tell the user the branch is ready for review; do NOT merge to main without explicit user approval.

---

## Self-Review

**Spec coverage:**
- Design A (`stack_source`/`stack_image`/`stack_resolve_images` + tests) → Tasks 2, 3, 4. ✓
- Design B (`_source` services, `.dockerignore` handling) → Task 7. ✓
- Design C (digest-class declarative `images.env` + tag-class interpolation) → Tasks 6, 8, 9, 10. ✓
- Design D (`just build` Phase 1 + Phase 2, `stack_profiles | tr ',' ' '`) → Task 5. ✓
- Design E (`.stack/.env` ergonomics) → Task 11. ✓
- README pinning sync → Task 12. ✓
- Acceptance #1 (helpers + tests) → Tasks 2, 3, 4. ✓
- Acceptance #2 (`_source` build.sh: no clone/checkout/rm-.git) → Task 7 step 6. ✓
- Acceptance #3 (`.git` retained) → Task 13 step 3. ✓
- Acceptance #4 (interpolation coverage of all pg/redis/rabbitmq + digest-class) → Task 6 step 7. ✓
- Acceptance #5 (B1 inactive-profile resolution) → Task 13 step 4. ✓
- Acceptance #6 (non-destructive round-trip) → Task 13 step 5. ✓
- Acceptance #7 (bump round-trip) → exercised implicitly by tests; not a live-stack step (low value vs cost).
- Acceptance #8 (`.image-digest` sidecars removed + comment updates) → Tasks 9, 10. ✓
- Acceptance #9 (`.stack.env.example` documents every lever) → Task 11. ✓

**Placeholder scan:** The build.sh `# tag <annotate after first build>`
markers and the `images.env` `<TAG_FROM_STEP2>` / `<DIGEST_FROM_STEP1>`
markers are NOT placeholders in the disallowed sense — each is explicitly
the output of a concrete resolution step the engineer executes (Task 7
step 7; Task 8 steps 1–2). Task 14 step 1 hard-gates that no
`annotate after first build` text survives in any commit.

**Type/name consistency:** `stack_source` signature is `(SVC, REPO,
DEFAULT_PIN)`; `stack_image` is `(NAME, REPO, DEFAULT_PIN, [SVC])`;
`stack_resolve_images` discovers `services/*/images.env`. NAME is always
UPPERCASE (matches spec round-2 fix). Locks: `.source.lock` for sources,
`.image.<NAME>.lock` for images. Env-var written: `<NAME>_IMAGE`. All
consistent across Tasks 3, 4, 8, 9.

---

## Execution handoff

Per user direction ("implement in a feature branch, not a worktree" + "don't
stop for any reviews from me"), this plan will be executed with
superpowers:executing-plans inline in the current session on
`feat/version-pinning`. No interactive checkpoints; final report when the
branch is verified non-destructive against the live stack.
