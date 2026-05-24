#!/usr/bin/env bash
# Tests for services/hermes/build.sh helpers.
# Currently covers hermes_env_rewrite_managed_block — the marker-delimited
# ~/.hermes/.env rewriter that owns stack-derived keys (OPENROUTER_API_KEY,
# TELEGRAM_*, AGENTMEMORY_*, FIRECRAWL_*, CAMOFOX_URL, SEARXNG_URL) inside
# the # >>> hermes-stack managed >>> block while preserving every user
# line outside it (plugin env, comments, blank lines).
#
# Run: bash services/hermes/build.test.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

REPO_ROOT="$(pwd)"
BUILD_SH="$REPO_ROOT/services/hermes/build.sh"

# Extract just the helper section + marker constants from build.sh into a
# self-contained harness. Sourcing build.sh directly is impossible — it
# kicks off the full provisioner — so we slice out the unit under test.
HARNESS_DIR="$(mktemp -d -t hermes-build-test.XXXXXX)"
trap 'rm -rf "$HARNESS_DIR"' EXIT

cat > "$HARNESS_DIR/harness.sh" <<'OUTER'
#!/usr/bin/env bash
set -euo pipefail
HERMES_MOUNT_ENABLED=true
MAC_HERMES="$1"
warn() { printf '[warn] %s\n' "$*" >&2; }
OUTER
sed -n '/^MANAGED_OPEN=/,/^}$/p' "$BUILD_SH" >> "$HARNESS_DIR/harness.sh"

pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1"; fail=$((fail + 1)); }
check() { eval "$1" && ok "$2" || bad "$2"; }

# run FIXTURE-DIR  CONTENT  — invoke the helper under FIXTURE-DIR
run() {
  local fix="$1" content="$2"
  cat > "$HARNESS_DIR/r.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "$HARNESS_DIR/harness.sh" "$HARNESS_DIR/$fix"
hermes_env_rewrite_managed_block "$content"
EOF
  bash "$HARNESS_DIR/r.sh"
}

# --------------------------------------------------------------------------
# F1: first-ever build (no existing file)
# --------------------------------------------------------------------------
echo "F1: first-ever build (no existing ~/.hermes/.env)"
mkdir -p "$HARNESS_DIR/f1"
run f1 'OPENROUTER_API_KEY=ok-1
TELEGRAM_BOT_TOKEN=tg-1'
check "grep -q '^OPENROUTER_API_KEY=ok-1$' '$HARNESS_DIR/f1/.env'"      "managed key written"
check "grep -q 'hermes-stack managed' '$HARNESS_DIR/f1/.env'"            "open marker present"
check "! grep -q 'User vars below' '$HARNESS_DIR/f1/.env'"               "no migration-hint on empty-first build"
check "[ \"\$(stat -f %A '$HARNESS_DIR/f1/.env' 2>/dev/null || stat -c %a '$HARNESS_DIR/f1/.env')\" = '600' ]"  "mode 0600"
echo

# --------------------------------------------------------------------------
# F2: legacy file with user vars and stale stack vars (migration)
# --------------------------------------------------------------------------
echo "F2: migration from marker-less legacy file"
mkdir -p "$HARNESS_DIR/f2"
cat > "$HARNESS_DIR/f2/.env" <<'EOF'
OPENROUTER_API_KEY=old-stack-value
TELEGRAM_BOT_TOKEN=old-stack-value
# User-added below
HERMES_AGENTS_OBSERVE_URL=http://host.docker.internal:4981
HERMES_LANGFUSE_PUBLIC_KEY=pk-lf-XXXX
EOF
run f2 'OPENROUTER_API_KEY=new-stack-value
TELEGRAM_BOT_TOKEN=new-stack-value'
check "grep -q '^HERMES_AGENTS_OBSERVE_URL=' '$HARNESS_DIR/f2/.env'"     "user var preserved"
check "[ \"\$(grep -c '^OPENROUTER_API_KEY=' '$HARNESS_DIR/f2/.env')\" = '1' ]" "stack key not duplicated"
check "[ \"\$(grep -c 'User vars below' '$HARNESS_DIR/f2/.env')\" = '1' ]"       "migration-hint emitted once"
check "grep -q '^OPENROUTER_API_KEY=new-stack-value$' '$HARNESS_DIR/f2/.env'"     "managed value wins over stale duplicate"
check "grep -q '# User-added below' '$HARNESS_DIR/f2/.env'"               "user comment preserved"
echo

# --------------------------------------------------------------------------
# F3: steady-state re-run (markers present, new stack key added)
# --------------------------------------------------------------------------
echo "F3: steady-state re-run with markers present"
mkdir -p "$HARNESS_DIR/f3"; cp "$HARNESS_DIR/f2/.env" "$HARNESS_DIR/f3/.env"
run f3 'OPENROUTER_API_KEY=newer
TELEGRAM_BOT_TOKEN=newer
FIRECRAWL_API_URL=http://firecrawl-api.test.orb.local:3002
FIRECRAWL_API_KEY=fc-selfhost-noauth'
check "[ \"\$(grep -c 'User vars below' '$HARNESS_DIR/f3/.env')\" = '1' ]" "migration-hint not duplicated on re-run"
check "grep -q '^HERMES_AGENTS_OBSERVE_URL=' '$HARNESS_DIR/f3/.env'"        "user var still preserved"
check "grep -q '^FIRECRAWL_API_URL=' '$HARNESS_DIR/f3/.env'"                "new stack key added"
check "grep -q '^OPENROUTER_API_KEY=newer$' '$HARNESS_DIR/f3/.env'"          "stack value updated again"
echo

# --------------------------------------------------------------------------
# F4: stack drops firecrawl — stale key must NOT linger
# --------------------------------------------------------------------------
echo "F4: service disabled — stale stack key removed"
mkdir -p "$HARNESS_DIR/f4"; cp "$HARNESS_DIR/f3/.env" "$HARNESS_DIR/f4/.env"
run f4 'OPENROUTER_API_KEY=newer
TELEGRAM_BOT_TOKEN=newer'
check "! grep -q '^FIRECRAWL_API_URL=' '$HARNESS_DIR/f4/.env'"        "stale firecrawl key dropped"
check "grep -q '^HERMES_AGENTS_OBSERVE_URL=' '$HARNESS_DIR/f4/.env'"  "user var still preserved"
echo

# --------------------------------------------------------------------------
# F5: same input twice → byte-identical output
# --------------------------------------------------------------------------
echo "F5: idempotency"
mkdir -p "$HARNESS_DIR/f5"; cp "$HARNESS_DIR/f4/.env" "$HARNESS_DIR/f5/.env"
sha1_before=$(shasum "$HARNESS_DIR/f5/.env" | cut -d' ' -f1)
run f5 'OPENROUTER_API_KEY=newer
TELEGRAM_BOT_TOKEN=newer'
sha1_after=$(shasum "$HARNESS_DIR/f5/.env" | cut -d' ' -f1)
check "[ '$sha1_before' = '$sha1_after' ]" "byte-identical re-run with same input"
echo

# --------------------------------------------------------------------------
# F6: corrupted markers (open only) — recover without data loss
# --------------------------------------------------------------------------
echo "F6: corrupted marker pair (open only)"
mkdir -p "$HARNESS_DIR/f6"
cat > "$HARNESS_DIR/f6/.env" <<'EOF'
USER_PRE_MARKER=keepme
# >>> hermes-stack managed (rewritten on each `just build`) -- DO NOT EDIT >>>
OPENROUTER_API_KEY=broken
HERMES_X=should_be_preserved
EOF
run f6 'OPENROUTER_API_KEY=fixed' 2>/dev/null
check "grep -q '^USER_PRE_MARKER=' '$HARNESS_DIR/f6/.env'"  "pre-marker user data preserved"
check "grep -q '^HERMES_X=' '$HARNESS_DIR/f6/.env'"          "in-block non-managed data preserved"
check "[ \"\$(grep -c '^OPENROUTER_API_KEY=' '$HARNESS_DIR/f6/.env')\" = '1' ]"  "stale broken key removed"
check "grep -q '^OPENROUTER_API_KEY=fixed$' '$HARNESS_DIR/f6/.env'"               "fresh managed key written"
echo

# --------------------------------------------------------------------------
# F7: build.sh proper still parses (catches typos in the surrounding flow)
# --------------------------------------------------------------------------
echo "F7: build.sh syntax"
check "bash -n '$BUILD_SH'" "bash -n services/hermes/build.sh"
echo

echo "===== RESULT: $pass passed, $fail failed ====="
exit $fail
