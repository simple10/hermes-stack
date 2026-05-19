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

# _svc_requires PROFILE — SERVICE_REQUIRES from services/PROFILE/service.env (csv or empty).
_svc_requires() { env_get "$STACK_ROOT/services/$1/service.env" SERVICE_REQUIRES; }

# stack_required [SEED_CSV] — space-separated fixpoint expansion of the active
# profiles' SERVICE_REQUIRES. SEED defaults to COMPOSE_PROFILES in .stack/.env.
# Cycle-safe (bounded worklist; each profile visited once).
stack_required() {
  local seed; seed="${1:-$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)}"
  local out="" work p r next
  work="$(printf '%s' "$seed" | tr ',' ' ')"
  while [ -n "$(printf '%s' "$work" | tr -d '[:space:]')" ]; do
    next=""
    for p in $work; do
      case " $out " in *" $p "*) continue;; esac
      out="$out $p"
      for r in $(_svc_requires "$p" | tr ',' ' '); do
        [ -n "$r" ] && next="$next $r"
      done
    done
    work="$next"
  done
  printf '%s' "$out" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ' | sed 's/ $//'
}

# stack_profiles [SEED_CSV] — COMPOSE_PROFILES ∪ stack_required, COMMA-joined
# (ready for the COMPOSE_PROFILES env var). Used by dc().
stack_profiles() {
  local seed; seed="${1:-$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)}"
  stack_required "$seed" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -
}

# stack_backends [SEED_CSV] — SPACE-separated subset of stack_profiles whose
# services/<name>/service.env declares SERVICE_KIND=backend. Valid `dc up -d`
# targets (dir==service==profile for substrate). Used by `just start`.
stack_backends() {
  local seed; seed="${1:-$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)}"
  local n out=""
  for n in $(stack_required "$seed"); do
    [ "$(env_get "$STACK_ROOT/services/$n/service.env" SERVICE_KIND)" = "backend" ] \
      && out="$out $n"
  done
  printf '%s' "$out" | sed 's/^ //'
}

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
  # `--verify` is required: without it, `git rev-parse 'bogus^{commit}'`
  # prints the literal string to stdout AND exits 128, defeating our
  # empty-string failure detection. With --verify, failure prints nothing
  # to stdout (errors go to stderr, suppressed).
  git -C "$src" fetch --tags origin
  local sha
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
  printf 'requested=%s\nresolved_digest=%s\n' "$requested" "$digest" > "$lock"
  env_upsert "$genenv" "${name}_IMAGE" "${repo}@${digest}"
  log "stack_image($name): $requested -> ${digest:0:19}…"
}

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
      name="$(printf '%s' "$name" | sed -e 's/^[[:space:]]*//')"
      [ -z "$name" ] && continue
      case "$name" in '#'*) continue;; esac
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
  prof="$(stack_profiles)"
  local args=(-p "$proj" -f "$STACK_ROOT/docker-compose.yaml" --env-file "$STACK_DIR/.env")
  # generated overlays — via `ls` (no bare glob: zsh aborts on no-match).
  while IFS= read -r g; do
    [ -n "$g" ] && args+=(--env-file "$g")
  done <<EOF
$(ls "$STACK_DIR"/*/.generated.env 2>/dev/null)
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
  local hdir="$STACK_DIR/$svc/.config-hashes"; mkdir -p "$hdir"
  local hf="$hdir/$(basename "$out").sha256"
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
