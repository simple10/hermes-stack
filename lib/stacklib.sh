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

# _env_value FILE KEY — env_get + strip inline "# comment" + trim whitespace.
# Use for service.env declaration keys that legitimately carry annotations
# (REPO, DEFAULT, PIN). env_get itself stays raw (passwords can contain '#').
_env_value() {
  local v; v="$(env_get "$1" "$2")"
  v="${v%%#*}"
  printf '%s' "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

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

# stack_source SVC [REPO DEFAULT_PIN] — clone-and-pin services/SVC/_source/ to
# ${<SVC_UC>_VERSION:-DEFAULT_PIN}. REPO/DEFAULT_PIN default to
# <SVC_UC>_SOURCE_REPO / <SVC_UC>_SOURCE_DEFAULT in services/SVC/service.env.
# Reuse fast-path on lock+HEAD match. Always leaves _source at the resolved SHA,
# keeps .git, ensures _source/.dockerignore. ALL state (lock + rebuild flag)
# lives in .stack/SVC/.generated.env under <SVC_UC>_SOURCE_* keys.
stack_source() {
  local svc="$1" repo="${2:-}" default_pin="${3:-}"
  local svc_uc; svc_uc="$(_svc_uc "$svc")"
  local svcenv="$STACK_ROOT/services/$svc/service.env"
  if [ -z "$repo" ]; then
    repo="$(_env_value "$svcenv" "${svc_uc}_SOURCE_REPO")"
    [ -n "$repo" ] || die "stack_source($svc): no REPO arg and no ${svc_uc}_SOURCE_REPO in $svcenv"
  fi
  if [ -z "$default_pin" ]; then
    default_pin="$(_env_value "$svcenv" "${svc_uc}_SOURCE_DEFAULT")"
    [ -n "$default_pin" ] || die "stack_source($svc): no DEFAULT_PIN arg and no ${svc_uc}_SOURCE_DEFAULT in $svcenv"
  fi
  local requested; eval "requested=\${${svc_uc}_VERSION:-\$default_pin}"
  local src="$STACK_ROOT/services/$svc/_source"
  local genenv="$STACK_DIR/$svc/.generated.env"
  mkdir -p "$STACK_DIR/$svc"

  # Identity check on existing _source (refuse if origin doesn't match).
  if [ -d "$src/.git" ]; then
    local origin_url; origin_url="$(git -C "$src" remote get-url origin 2>/dev/null || true)"
    if [ -n "$origin_url" ] && [ "$origin_url" != "$repo" ]; then
      die "stack_source($svc): $src origin '$origin_url' != expected '$repo' (re-clone manually if intended)"
    fi
  fi

  # Reuse fast-path: lock matches + HEAD matches -> no network, no rebuild flag.
  if [ -d "$src/.git" ] && [ -f "$genenv" ]; then
    local lock_req lock_sha head
    lock_req="$(env_get "$genenv" "${svc_uc}_SOURCE_REQUESTED")"
    lock_sha="$(env_get "$genenv" "${svc_uc}_SOURCE_RESOLVED_SHA")"
    head="$(git -C "$src" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$lock_req" ] && [ "$lock_req" = "$requested" ] && [ "$head" = "$lock_sha" ]; then
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

  # Resolve requested (tag, SHA, or branch). `--verify` is mandatory: without
  # it `git rev-parse 'bogus^{commit}'` prints the literal to stdout AND
  # exits 128, defeating our empty-string failure detection.
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

  env_upsert "$genenv" "${svc_uc}_SOURCE_REQUESTED" "$requested"
  env_upsert "$genenv" "${svc_uc}_SOURCE_RESOLVED_SHA" "$sha"
  env_upsert "$genenv" "${svc_uc}_SOURCE_REBUILD" "1"
  log "stack_source($svc): pinned $requested -> ${sha:0:12} (rebuild flag set)"
}

# stack_image NAME REPO DEFAULT_PIN [SVC] — resolve ${<NAME>_VERSION:-DEFAULT_PIN}
# (tag or sha256: digest) to a concrete digest; write <NAME>_IMAGE=REPO@digest
# into .stack/<SVC>/.generated.env (along with <NAME>_IMAGE_REQUESTED +
# <NAME>_IMAGE_RESOLVED_DIGEST lock state). SVC defaults to NAME.
stack_image() {
  local name="$1" repo="$2" default_pin="$3"
  local svc="${4:-$1}"
  local requested; eval "requested=\${${name}_VERSION:-\$default_pin}"
  local lockdir="$STACK_DIR/$svc"
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
  env_upsert "$genenv" "${name}_IMAGE_REQUESTED" "$requested"
  env_upsert "$genenv" "${name}_IMAGE_RESOLVED_DIGEST" "$digest"
  env_upsert "$genenv" "${name}_IMAGE" "${repo}@${digest}"
  log "stack_image($name): $requested -> ${digest:0:19}…"
}

# stack_resolve_images — scan every services/*/service.env for *_IMAGE_REPO
# keys; for each, read the matching *_IMAGE_DEFAULT and call stack_image.
# Runs UNCONDITIONALLY from `just build` Phase 1 because compose include:
# interpolates every file on every dc call.
stack_resolve_images() {
  local f svc names name repo default
  for f in "$STACK_ROOT"/services/*/service.env; do
    [ -e "$f" ] || continue
    svc="$(basename "$(dirname "$f")")"
    # Extract NAME from every "<NAME>_IMAGE_REPO=" key (uppercase, alnum/_).
    names="$(grep -oE '^[A-Z][A-Z0-9_]*_IMAGE_REPO=' "$f" | sed 's/_IMAGE_REPO=$//' || true)"
    [ -z "$names" ] && continue
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      repo="$(_env_value "$f" "${name}_IMAGE_REPO")"
      default="$(_env_value "$f" "${name}_IMAGE_DEFAULT")"
      [ -n "$repo" ] && [ -n "$default" ] \
        || die "stack_resolve_images: $f missing ${name}_IMAGE_REPO or ${name}_IMAGE_DEFAULT"
      stack_image "$name" "$repo" "$default" "$svc"
    done <<<"$names"
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
  # docker's own networking + its auto-injection of proxy build-args).
  # Users behind a corporate/captive proxy set HTTP_PROXY etc. in their
  # shell — dc() passes them through. No auto-derive from the daemon: we
  # tried that once (OrbStack reports its built-in proxy.orb.internal in
  # `docker info`) and BuildKit would fail with NXDOMAIN when the OrbStack
  # proxy was disabled/auto/unreachable. Set proxy vars yourself if needed.
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

# orb_get_machine_flag MACHINE FLAG — print the boolean value of
# machine.<MACHINE>.<FLAG> from `orb config show` (or empty if unset).
# `orb config get` returns a non-zero status with no output when the key is
# unset; we don't want callers to have to handle that.
orb_get_machine_flag() {
  local mch="$1" flag="$2"
  orb config show 2>/dev/null \
    | awk -v k="machine.$mch.$flag:" '$1==k {print $2; exit}'
}

# orb_set_machine_isolation MACHINE — idempotently flip BOTH isolation flags
# (isolated + isolate_network) to true. Changes only take effect on next
# machine start; caller is responsible for prompting/running `just restart`.
# Returns 0 if already isolated (no change), 1 if it had to flip (restart
# required), 2 on orb command failure.
orb_set_machine_isolation() {
  local mch="$1"
  local iso net changed=0
  iso="$(orb_get_machine_flag "$mch" isolated)"
  net="$(orb_get_machine_flag "$mch" isolate_network)"
  if [ "$iso" != "true" ]; then
    orb config set "machine.$mch.isolated" true 2>/dev/null || return 2
    changed=1
  fi
  if [ "$net" != "true" ]; then
    orb config set "machine.$mch.isolate_network" true 2>/dev/null || return 2
    changed=1
  fi
  return "$changed"   # 0 = already isolated, 1 = flipped (restart needed)
}

# (compose env-file wiring lives solely in dc() now — it passes absolute
# --env-file args under a stripped env. No separate COMPOSE_ENV_FILES export
# anywhere: that was relative-path + host-precedence prone. Single source.)

# ============================================================================
# enable / disable plumbing — used by `just enable <svc>` / `just disable <svc>`
# ============================================================================
# Each service declares (in services/<svc>/service.env, all optional):
#   SERVICE_RUNNER=docker|vm        # default docker; routes to COMPOSE_PROFILES or STACK_MACHINES
#   SERVICE_PROFILE=<name>          # default = <svc>; CSV-member name
#   SERVICE_LITELLM_KEY=true|false  # default false; mints <profile>_VIRTUAL_KEY
#   SERVICE_STACK_ENV='<multi-line>'# default empty; vars injected into .stack/.env
#                                   # as a #>--- svc --- ... #<--- svc --- block.
# Optional services/<svc>/{enable,disable}.sh run AFTER the lib logic.
#
# Block on/off state in .stack/.env: ENABLED = bare markers + body; DISABLED
# = every line in the block (markers included) prefixed with "# ". Detection
# of disabled state = start marker begins with "# #>---". Round-trips
# preserve user edits inside the block (one-char-deep "# " prefix only).

# csv_add FILE KEY VAL — add VAL to CSV at KEY (idempotent; init if missing).
csv_add() {
  local file="$1" key="$2" val="$3" cur
  cur="$(env_get "$file" "$key")"
  case ",$cur," in *",$val,"*) return 0 ;; esac
  env_upsert "$file" "$key" "${cur:+$cur,}$val"
}

# csv_remove FILE KEY VAL — remove VAL from CSV at KEY (idempotent).
csv_remove() {
  local file="$1" key="$2" val="$3" cur new
  cur="$(env_get "$file" "$key")"
  [ -z "$cur" ] && return 0
  new="$(printf '%s\n' "$cur" | tr ',' '\n' | grep -vxF "$val" | paste -sd, - 2>/dev/null)"
  env_upsert "$file" "$key" "$new"
}

# _svc_env_field SVC FIELD — read FIELD from services/SVC/service.env (or "").
_svc_env_field() {
  local svc="$1" field="$2" f="$STACK_ROOT/services/$1/service.env"
  [ -f "$f" ] || return 0
  env_get "$f" "$field"
}

# stack_env_block_status SVC — print enabled|disabled|missing.
stack_env_block_status() {
  local svc="$1" f="$STACK_DIR/.env"
  [ -f "$f" ] || { echo missing; return; }
  if   grep -qE "^#>--- $svc ---"   "$f"; then echo enabled
  elif grep -qE "^# +#>--- $svc ---" "$f"; then echo disabled
  else echo missing
  fi
}

# stack_env_block_append SVC < body
# Append a new ENABLED block at the end of .stack/.env (caller ensures it
# doesn't already exist; use after stack_env_block_status == "missing").
stack_env_block_append() {
  local svc="$1" f="$STACK_DIR/.env" body
  body="$(cat)"
  {
    echo ""
    echo "#>--- $svc ---"
    printf '%s\n' "$body"
    echo "#<--- $svc ---"
  } >> "$f"
  chmod 600 "$f"
}

# stack_env_block_toggle SVC enabled|disabled
# Flip in-place: prefix every line in the block with "# " (disable) or strip
# one "# " (enable). No-op if already in target state. Markers themselves
# are also toggled, so detection-by-marker keeps working.
stack_env_block_toggle() {
  local svc="$1" target="$2" f="$STACK_DIR/.env" tmp
  tmp="$(mktemp)"
  awk -v svc="$svc" -v target="$target" '
    BEGIN { in_block = 0; state = "" }
    {
      orig = $0; out = $0
      if (orig ~ "^#>--- " svc " ---")     { in_block = 1; state = "enabled" }
      else if (orig ~ "^# +#>--- " svc " ---") { in_block = 1; state = "disabled" }
      if (in_block) {
        if (target == "disabled" && state == "enabled")  { out = "# " orig }
        else if (target == "enabled" && state == "disabled") {
          out = orig; sub(/^# /, "", out)
        }
      }
      print out
      if (orig ~ "^#<--- " svc " ---" || orig ~ "^# +#<--- " svc " ---") {
        in_block = 0; state = ""
      }
    }
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
  chmod 600 "$f"
}

# stack_env_block_sync SVC SCHEMA — additive sync (option b). For each
# KEY=... line in SCHEMA, if KEY is not present in the current (enabled)
# block, append it just before the end marker. Preserves user values for
# existing KEYs.
stack_env_block_sync() {
  local svc="$1" schema="$2" f="$STACK_DIR/.env" body new_lines="" key line tmp
  body="$(awk -v svc="$svc" '
    BEGIN { in_block = 0 }
    {
      if ($0 ~ "^#>--- " svc " ---") { in_block = 1; next }
      if ($0 ~ "^#<--- " svc " ---") { in_block = 0; next }
      if (in_block) print
    }
  ' "$f")"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in '#'*) continue ;; esac
    key="${line%%=*}"
    [ -z "$key" ] && continue
    if ! printf '%s\n' "$body" | grep -qE "^${key}="; then
      new_lines+="$line"$'\n'
    fi
  done <<< "$schema"
  [ -z "$new_lines" ] && return 0
  # awk -v can't carry literal newlines, so stash new_lines in a tempfile
  # and have awk slurp it in BEGIN. Cheaper than per-line subprocess calls.
  local newf; newf="$(mktemp)"
  printf '%s' "$new_lines" > "$newf"
  tmp="$(mktemp)"
  awk -v svc="$svc" -v newf="$newf" '
    BEGIN {
      while ((getline ln < newf) > 0) new = new ln "\n"
      close(newf)
      in_block = 0
    }
    {
      if ($0 ~ "^#<--- " svc " ---" && in_block) { printf "%s", new; in_block = 0 }
      if ($0 ~ "^#>--- " svc " ---") in_block = 1
      print
    }
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
  rm -f "$newf"
  chmod 600 "$f"
}

# _is_enabled SVC — return 0 if SVC is in COMPOSE_PROFILES or STACK_MACHINES.
_is_enabled() {
  local svc="$1" lists v
  for v in COMPOSE_PROFILES STACK_MACHINES; do
    lists="$(env_get "$STACK_DIR/.env" "$v")"
    case ",$lists," in *",$svc,"*) return 0 ;; esac
  done
  return 1
}

# find_dependants SVC — print space-separated list of enabled services
# (docker + vm) whose SERVICE_REQUIRES contains SVC.
find_dependants() {
  local svc="$1" all dep req deps=""
  all="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES),$(env_get "$STACK_DIR/.env" STACK_MACHINES)"
  for dep in $(printf '%s' "$all" | tr ',' ' '); do
    [ -z "$dep" ] && continue
    [ "$dep" = "$svc" ] && continue
    req="$(_svc_requires "$dep")"
    case ",$req," in *",$svc,"*) deps+="$dep " ;; esac
  done
  printf '%s' "${deps% }"
}

# _enable_one SVC — do the actual enable for one service (no dep cascade).
# Caller is lib_enable_service (which handles transitive SERVICE_REQUIRES).
_enable_one() {
  local svc="$1"
  local svc_env="$STACK_ROOT/services/$svc/service.env"
  [ -f "$svc_env" ] || die "no such service: $svc (services/$svc/service.env not found)"
  local runner profile virtkey stack_env status
  runner="$(env_get  "$svc_env" SERVICE_RUNNER)";       runner="${runner:-docker}"
  profile="$(env_get "$svc_env" SERVICE_PROFILE)";      profile="${profile:-$svc}"
  virtkey="$(env_get "$svc_env" SERVICE_LITELLM_KEY)"
  stack_env="$(env_get "$svc_env" SERVICE_STACK_ENV)"

  case "$runner" in
    docker) csv_add "$STACK_DIR/.env" COMPOSE_PROFILES "$profile" ;;
    vm)     csv_add "$STACK_DIR/.env" STACK_MACHINES   "$profile" ;;
    *)      die "$svc: unknown SERVICE_RUNNER=$runner (expected docker|vm)" ;;
  esac
  [ "$virtkey" = "true" ] && csv_add "$STACK_DIR/.env" LITELLM_VIRTKEYS "$profile"

  status="$(stack_env_block_status "$svc")"
  case "$status" in
    enabled)  : ;;
    disabled) stack_env_block_toggle "$svc" enabled ;;
    missing)
      [ -n "$stack_env" ] && printf '%s' "$stack_env" | stack_env_block_append "$svc"
      ;;
  esac
  if [ -n "$stack_env" ] && [ "$status" != "missing" ]; then
    stack_env_block_sync "$svc" "$stack_env"
  fi

  [ -x "$STACK_ROOT/services/$svc/enable.sh" ] && bash "$STACK_ROOT/services/$svc/enable.sh"
  # No per-service log here — lib_enable_service emits one summary line at
  # the top. Cascade activations are communicated via the "auto-enabling X
  # (required by Y)" lines printed in _enable_with_deps.
}

# __ENABLE_VISITED — global colon-delimited dedup set for the cascade.
# Reset at the top of every lib_enable_service call. Global (not passed)
# so SIBLING branches of the recursion see each other's marks (passing it
# by-value gave each branch its own copy → dupes when the same service
# was a transitive dep of two siblings). bash 3.2 has no associative
# arrays — macOS /bin/bash is 3.2.
__ENABLE_VISITED=""

_enable_with_deps() {
  local s="$1" req r
  case ":$__ENABLE_VISITED:" in *":$s:"*) return 0 ;; esac
  __ENABLE_VISITED="$__ENABLE_VISITED:$s"
  [ -f "$STACK_ROOT/services/$s/service.env" ] \
    || die "no such service: $s (services/$s/service.env not found)"
  req="$(_svc_requires "$s")"
  for r in $(printf '%s' "$req" | tr ',' ' '); do
    [ -z "$r" ] && continue
    if ! _is_enabled "$r"; then
      printf 'auto-enabling %s (required by %s)\n' "$r" "$s"
    fi
    _enable_with_deps "$r"
  done
  _enable_one "$s"
}

# lib_enable_service SVC — idempotently enable; auto-enables (leaf-first)
# every service in the transitive SERVICE_REQUIRES closure. Cycle-safe.
# Compares before/after .stack/.env CSVs to decide whether to log "X
# enabled" or "X already enabled — no changes" (block-only changes from
# SERVICE_STACK_ENV sync also count as changes via the file hash check).
lib_enable_service() {
  local svc="$1"
  local before_csv before_hash after_csv after_hash
  before_csv="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES),$(env_get "$STACK_DIR/.env" STACK_MACHINES),$(env_get "$STACK_DIR/.env" LITELLM_VIRTKEYS)"
  before_hash="$(shasum -a 256 "$STACK_DIR/.env" 2>/dev/null | cut -d' ' -f1)"
  __ENABLE_VISITED=""
  _enable_with_deps "$svc"
  __ENABLE_VISITED=""
  after_csv="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES),$(env_get "$STACK_DIR/.env" STACK_MACHINES),$(env_get "$STACK_DIR/.env" LITELLM_VIRTKEYS)"
  after_hash="$(shasum -a 256 "$STACK_DIR/.env" 2>/dev/null | cut -d' ' -f1)"
  if [ "$before_csv" = "$after_csv" ] && [ "$before_hash" = "$after_hash" ]; then
    log "$svc already enabled — no changes"
  else
    log "$svc enabled"
  fi
}

# lib_disable_service SVC — idempotently disable. REFUSES (exit 1) if any
# enabled service has SERVICE_REQUIRES containing this one. No force flag —
# the user disables dependants first, period. No "required" services
# either; only the dependency graph matters.
lib_disable_service() {
  local svc="$1"
  local svc_env="$STACK_ROOT/services/$svc/service.env"
  [ -f "$svc_env" ] || die "no such service: $svc"
  local runner profile virtkey deps status
  runner="$(env_get  "$svc_env" SERVICE_RUNNER)";       runner="${runner:-docker}"
  profile="$(env_get "$svc_env" SERVICE_PROFILE)";      profile="${profile:-$svc}"
  virtkey="$(env_get "$svc_env" SERVICE_LITELLM_KEY)"

  deps="$(find_dependants "$svc")"
  if [ -n "$deps" ]; then
    warn "refusing to disable '$svc' — these enabled services depend on it:"
    printf '         %s\n' "$deps"
    die  "disable them first:  just disable $deps"
  fi

  # Snapshot before so we can tell "no change" vs "actually disabled"
  local before_hash; before_hash="$(shasum -a 256 "$STACK_DIR/.env" 2>/dev/null | cut -d' ' -f1)"

  case "$runner" in
    docker) csv_remove "$STACK_DIR/.env" COMPOSE_PROFILES "$profile" ;;
    vm)     csv_remove "$STACK_DIR/.env" STACK_MACHINES   "$profile" ;;
  esac
  [ "$virtkey" = "true" ] && csv_remove "$STACK_DIR/.env" LITELLM_VIRTKEYS "$profile"

  status="$(stack_env_block_status "$svc")"
  case "$status" in
    enabled)  stack_env_block_toggle "$svc" disabled ;;
    disabled) : ;;
    missing)  : ;;
  esac

  [ -x "$STACK_ROOT/services/$svc/disable.sh" ] && bash "$STACK_ROOT/services/$svc/disable.sh"
  local after_hash; after_hash="$(shasum -a 256 "$STACK_DIR/.env" 2>/dev/null | cut -d' ' -f1)"
  if [ "$before_hash" = "$after_hash" ]; then
    log "$svc already disabled — no changes"
  else
    log "$svc disabled"
  fi
}

# lib_list_enabled_services — pretty-print current COMPOSE_PROFILES + STACK_MACHINES.
lib_list_enabled_services() {
  local profs machines svc
  profs="$(env_get "$STACK_DIR/.env" COMPOSE_PROFILES)"
  machines="$(env_get "$STACK_DIR/.env" STACK_MACHINES)"
  printf 'Docker services (COMPOSE_PROFILES):\n'
  for svc in $(printf '%s' "$profs" | tr ',' ' '); do
    [ -n "$svc" ] && printf '  - %s\n' "$svc"
  done
  printf 'VM services (STACK_MACHINES):\n'
  for svc in $(printf '%s' "$machines" | tr ',' ' '); do
    [ -n "$svc" ] && printf '  - %s\n' "$svc"
  done
}
