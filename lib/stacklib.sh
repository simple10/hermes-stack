#!/usr/bin/env bash
# stacklib.sh — shared helpers for hermes-stack scripts. Source, don't exec.
# Callers set `set -euo pipefail`.

# STACK_ROOT is ALWAYS derived from THIS file's own location — never from the
# ambient/host environment (a stray exported STACK_ROOT once redirected the
# whole stack at the wrong .stack/). Resolution is shell-PORTABLE: bash sets
# BASH_SOURCE; zsh does not (it uses ${(%):-%x}); plain sh has neither. If the
# resolved dir doesn't look like the hermes-stack root we DIE LOUDLY rather
# than silently operate on the wrong directory — that silent mis-resolution
# (under zsh `dirname ""`=. , so `./..`=PARENT) was the real footgun, hidden
# until now because `just` runs recipes under bash. To run against an isolated
# copy, rsync the repo and source THAT copy's lib/stacklib.sh — self-resolving,
# no override needed. The ONLY config source remains .stack/.env (+
# .stack/*.generated.env); no script reads a host env var as an override.
_stack_self() {
  if [ -n "${BASH_SOURCE:-}" ]; then printf '%s' "${BASH_SOURCE[0]}"
  elif [ -n "${ZSH_VERSION:-}" ]; then eval 'printf "%s" "${(%):-%x}"'
  else printf '%s' "$0"; fi
}
STACK_ROOT="$(cd "$(dirname "$(_stack_self)")/.." 2>/dev/null && pwd)"
if [ ! -f "$STACK_ROOT/docker-compose.yaml" ] || [ ! -f "$STACK_ROOT/lib/stacklib.sh" ]; then
  printf 'FATAL: stacklib.sh could not locate the hermes-stack root (resolved "%s").\n' "$STACK_ROOT" >&2
  printf '       Source it from inside the repo (bash or zsh) or use `just`. $STACK_ROOT is NOT honored by design.\n' >&2
  return 1 2>/dev/null || exit 1
fi
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

# stack_project — Compose project name from .stack/.env (default "aitools").
# This is THE per-stack identity: containers/volumes/network are project-scoped
# and OrbStack exposes services at <service>.<project>.orb.local.
stack_project() { local p; p="$(env_get "$STACK_DIR/.env" COMPOSE_PROJECT_NAME)"; printf '%s' "${p:-aitools}"; }

# dc — `docker compose` for THIS stack, run HERMETICALLY. Compose sees ONLY
# .stack/.env (+ .stack/*.generated.env), passed as ABSOLUTE --env-file args,
# with the host environment STRIPPED (env -i + a tight docker-operational
# allowlist). Why BOTH: Compose interpolation precedence is host-env >
# --env-file, so without env -i a stray exported var (POSTGRES_SUPERPASS,
# *_DB_PASSWORD, *_VIRTUAL_KEY, COMPOSE_PROFILES, …) silently outranks the
# real .stack value — the STACK_ROOT footgun, generalized to every secret.
# project + profiles are injected explicitly from .stack/.env so they never
# depend on Compose's env-file precedence rules or on the caller's CWD.
dc() {
  local proj prof v val g
  proj="$(stack_project)"
  prof="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)"
  local args=(-p "$proj" -f "$STACK_ROOT/docker-compose.yaml" --env-file "$STACK_DIR/.env")
  # generated overlays — via `ls` (no bare glob: zsh aborts on no-match).
  while IFS= read -r g; do
    [ -n "$g" ] && args+=(--env-file "$g")
  done <<EOF
$(ls "$STACK_DIR"/*.generated.env 2>/dev/null)
EOF
  # operational allowlist — ONLY what the docker CLI needs to reach the daemon
  # and build/pull over the network (these are NOT Compose interpolation
  # inputs — no compose file references ${HTTP_PROXY} etc.; they only affect
  # docker's own networking + its auto-injection of proxy build-args). The
  # *_PROXY set is REQUIRED on proxied hosts (e.g. OrbStack's
  # proxy.orb.internal): without it `dc build` for build-from-source services
  # (honcho/honcho-ui/camofox-browser) has no egress and apt-get fails.
  # Everything else is absent by design. `printenv` (not bash-only ${!v}) so
  # this is bash/zsh-portable; exit status distinguishes set-but-empty/unset.
  local pass=()
  for v in PATH HOME USER LOGNAME TERM TMPDIR TZ LANG LC_ALL \
           SSH_AUTH_SOCK XDG_CONFIG_HOME XDG_RUNTIME_DIR \
           DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY \
           HTTP_PROXY HTTPS_PROXY FTP_PROXY ALL_PROXY NO_PROXY \
           http_proxy https_proxy ftp_proxy all_proxy no_proxy; do
    if val="$(printenv "$v" 2>/dev/null)"; then pass+=("$v=$val"); fi
  done
  [ -n "$prof" ] && pass+=("COMPOSE_PROFILES=$prof")
  # Proxied-host build egress: if NO *_PROXY came from the host env but the
  # DAEMON has one configured, forward the daemon's proxy into the hermetic
  # env. docker auto-injects env *_PROXY into builds (verified: `dc build`
  # & `up --build`), so build-from-source services
  # (honcho/honcho-ui/camofox-browser) can fetch packages on a proxied host
  # (e.g. OrbStack proxy.orb.internal) where BuildKit has no direct egress.
  # Portable & non-hardcoded: a no-op when the daemon reports no proxy;
  # host/user-set *_PROXY always wins (probe skipped). Inert for non-build
  # subcommands. One `docker info` only when needed.
  case " ${pass[*]} " in
    *" HTTP_PROXY="*|*" http_proxy="*|*" HTTPS_PROXY="*|*" https_proxy="*) : ;;
    *)
      local dp hp sp np rest
      dp="$(docker info --format '{{.HTTPProxy}}|{{.HTTPSProxy}}|{{.NoProxy}}' 2>/dev/null || true)"
      hp="${dp%%|*}"; rest="${dp#*|}"; sp="${rest%%|*}"; np="${rest#*|}"
      if [ -n "$hp" ] || [ -n "$sp" ]; then
        [ -n "$hp" ] && pass+=("HTTP_PROXY=$hp" "http_proxy=$hp")
        [ -n "$sp" ] && pass+=("HTTPS_PROXY=$sp" "https_proxy=$sp")
        [ -n "$np" ] && pass+=("NO_PROXY=$np" "no_proxy=$np")
      fi
      ;;
  esac
  env -i "${pass[@]}" docker compose "${args[@]}" "$@"
}

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

# (compose env-file wiring lives solely in dc() now — it passes absolute
# --env-file args under a stripped env. No separate COMPOSE_ENV_FILES export
# anywhere: that was relative-path + host-precedence prone. Single source.)
