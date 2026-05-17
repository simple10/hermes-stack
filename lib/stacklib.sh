#!/usr/bin/env bash
# stacklib.sh — shared helpers for hermes-stack scripts. Source, don't exec.
# Callers set `set -euo pipefail`.

stack_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }
STACK_ROOT="${STACK_ROOT:-$(stack_root)}"
STACK_DIR="$STACK_ROOT/.stack"

log()  { printf '\n=== %s ===\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

# env_upsert FILE KEY VALUE — idempotent: replace `^KEY=` line or append. Never dupes.
env_upsert() {
  local f="$1" k="$2" v="$3"
  mkdir -p "$(dirname "$f")"; touch "$f"
  if grep -q "^${k}=" "$f" 2>/dev/null; then
    local tmp; tmp="$(mktemp)"
    grep -v "^${k}=" "$f" > "$tmp" || true
    printf '%s=%s\n' "$k" "$v" >> "$tmp"
    mv "$tmp" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
  chmod 600 "$f"
}

# env_get FILE KEY — print value or empty.
env_get() { grep "^${2}=" "$1" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# render_template TEMPLATE OUT SERVICE — copy TEMPLATE->OUT only if OUT missing;
# record template hash; if OUT exists, drift-check (warn only).
render_template() {
  local tpl="$1" out="$2" svc="$3"
  local hdir="$STACK_DIR/.config-hashes"; mkdir -p "$hdir"
  local hf="$hdir/${svc}.$(basename "$out").sha256"
  local cur; cur="$(shasum -a 256 "$tpl" | cut -d' ' -f1)"
  if [ ! -f "$out" ]; then
    cp "$tpl" "$out"; printf '%s\n' "$cur" > "$hf"
    log "rendered $out from $(basename "$tpl")"
  else
    local rec; rec="$(cat "$hf" 2>/dev/null || echo none)"
    if [ "$cur" != "$rec" ]; then
      warn "$svc: $(basename "$tpl") changed since $(basename "$out") was rendered."
      warn "  Review changes and re-render with: just reconfigure $svc"
    else
      log "$out present and up to date (no template drift)"
    fi
  fi
}

# require_secrets_file — .stack/.env must exist.
require_stack_env() {
  [ -f "$STACK_DIR/.env" ] || die ".stack/.env missing — run: just setup"
}

# compose_env_files — print comma list: .stack/.env first, then *.generated.env.
compose_env_files() {
  local list=".stack/.env"
  local g
  for g in "$STACK_DIR"/*.generated.env; do
    [ -e "$g" ] && list="$list,.stack/$(basename "$g")"
  done
  printf '%s' "$list"
}
