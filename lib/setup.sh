#!/usr/bin/env bash
# setup.sh — initialize .stack/.env. Safe to re-run.
#
# Flow:
#   1. Seed .stack/.env from .stack.defaults.env (first run = copy; every
#      run = additive merge of missing keys).
#   2. Show available services + prompt the user for which to enable.
#   3. For each selected service: lib_enable_service (cascades
#      SERVICE_REQUIRES, writes the #>--- svc --- block).
#   4. Interactive secret prompts — block-aware via stack_upsert, so
#      values land inside the owning service's block (e.g.,
#      LITELLM_MASTER_KEY -> litellm block, TELEGRAM_* -> hermes block).
#      ONLY prompted when the owning service is enabled.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stacklib.sh"

ENVF="$STACK_DIR/.env"
DEFAULTS="$STACK_ROOT/.stack.defaults.env"
[ -f "$DEFAULTS" ] || die "missing $DEFAULTS — refusing to setup blind"
mkdir -p "$STACK_DIR"

# ---- helpers ---------------------------------------------------------------

# Prompt (visible). Default = current value if any, else default arg.
# Uses stack_upsert so block-owned keys land in the right block.
ask_plain() {  # ask_plain VAR PROMPT DEFAULT
  local var="$1" prompt="$2" def="${3:-}" cur val
  cur="$(stack_get "$var")"
  read -rp "$prompt [${cur:-$def}]: " val
  val="${val:-${cur:-$def}}"
  stack_upsert "$var" "$val"
}

# Prompt (silent). Blank = keep current.
ask_secret() {  # ask_secret VAR PROMPT
  local var="$1" prompt="$2" cur val
  cur="$(stack_get "$var")"
  read -rsp "$prompt [${cur:+<keep current>}]: " val; echo
  val="${val:-$cur}"
  stack_upsert "$var" "$val"
}

# Generate if missing (gen-once). Stable across re-runs.
gen_if_missing() {  # gen_if_missing VAR PREFIX BYTES
  local var="$1" prefix="$2" bytes="$3" cur
  cur="$(stack_get "$var")"
  if [ -z "$cur" ]; then
    cur="${prefix}$(openssl rand -hex "$bytes")"
    log "generated $var"
  fi
  stack_upsert "$var" "$cur"
}

# ---- step 1: seed .stack/.env from .stack.defaults.env ---------------------

if [ ! -f "$ENVF" ]; then
  cp "$DEFAULTS" "$ENVF"
  chmod 600 "$ENVF"
  log "$ENVF created from .stack.defaults.env"
else
  # Additive merge: any key in defaults that's not already in .stack/.env.
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) : ;;
      *) continue ;;
    esac
    k="${line%%=*}"
    v="${line#*=}"
    # Strip trailing inline comments + whitespace from default value.
    v="${v%%#*}"; v="${v%"${v##*[![:space:]]}"}"
    if [ -z "$(env_get "$ENVF" "$k")" ]; then
      env_upsert "$ENVF" "$k" "$v"
      log "seeded missing $k from defaults"
    fi
  done < "$DEFAULTS"
fi

# ---- step 1.5: migrate pre-HERMES-prefix keys ------------------------------
# One-off rename: the hermes block historically held REMOTE_USER and
# TELEGRAM_* without a service prefix, which could collide with future
# services (every other block uses a SERVICE-name prefix). Migration is
# in-place (sed rename in the same block) so values + block placement
# survive. Safe to re-run (no-op once migrated). Drop this block once
# all users have run setup at least once on or after 2026-05-21.
for pair in REMOTE_USER:HERMES_REMOTE_USER \
            TELEGRAM_BOT_TOKEN:HERMES_TELEGRAM_BOT_TOKEN \
            TELEGRAM_ALLOWED_USERS:HERMES_TELEGRAM_ALLOWED_USERS \
            TELEGRAM_HOME_CHANNEL:HERMES_TELEGRAM_HOME_CHANNEL; do
  legacy="${pair%:*}"
  new="${pair#*:}"
  if grep -q "^${legacy}=" "$ENVF" 2>/dev/null; then
    if grep -q "^${new}=" "$ENVF" 2>/dev/null; then
      # new already present (partial migration / earlier setup run) — the
      # legacy line is just dead weight; drop it.
      sed -i.bak "/^${legacy}=/d" "$ENVF" && rm -f "$ENVF.bak"
      log "migration: dropped legacy ${legacy} (${new} already present)"
    else
      # In-place rename preserves the value AND the block placement.
      sed -i.bak "s/^${legacy}=/${new}=/" "$ENVF" && rm -f "$ENVF.bak"
      log "migration: renamed ${legacy} → ${new}"
    fi
  fi
done

# ---- step 2: service selection ---------------------------------------------

log "Available services"
echo
echo "Docker services (backends pg/redis/rabbitmq auto-pulled via SERVICE_REQUIRES):"
for d in "$STACK_ROOT"/services/*/; do
  svc="$(basename "$d")"
  f="$d/service.env"
  [ -f "$f" ] || continue
  runner="$(env_get "$f" SERVICE_RUNNER)"; runner="${runner:-docker}"
  kind="$(env_get "$f" SERVICE_KIND)"
  [ "$runner" = "docker" ] || continue
  [ "$kind" = "backend" ] && continue
  desc="$(env_get "$f" SERVICE_DESC)"
  desc="${desc#\"}"; desc="${desc%\"}"   # strip quotes
  printf '  %-18s %s\n' "$svc" "$desc"
done
echo
echo "VM services:"
for d in "$STACK_ROOT"/services/*/; do
  svc="$(basename "$d")"
  f="$d/service.env"
  [ -f "$f" ] || continue
  runner="$(env_get "$f" SERVICE_RUNNER)"
  [ "$runner" = "vm" ] || continue
  desc="$(env_get "$f" SERVICE_DESC)"
  desc="${desc#\"}"; desc="${desc%\"}"
  printf '  %-18s %s\n' "$svc" "$desc"
done
echo
echo "(See services/<svc>/README.md for per-service details.)"
echo

cur_profiles="$(env_get "$ENVF" COMPOSE_PROFILES)"
cur_machines="$(env_get "$ENVF" STACK_MACHINES)"
read -rp "Docker services to enable (comma list) [${cur_profiles}]: " new_profiles
new_profiles="${new_profiles:-$cur_profiles}"
env_upsert "$ENVF" COMPOSE_PROFILES "$new_profiles"

read -rp "VM services to enable     (comma list, blank ok) [${cur_machines}]: " new_machines
new_machines="${new_machines:-$cur_machines}"
env_upsert "$ENVF" STACK_MACHINES "$new_machines"

# ---- step 3: enable each selected service (writes blocks) ------------------

log "Enabling selected services (cascades SERVICE_REQUIRES, writes blocks)"
for svc in $(printf '%s' "$new_machines" | tr ',' ' ') \
           $(printf '%s' "$new_profiles" | tr ',' ' '); do
  [ -z "$svc" ] && continue
  lib_enable_service "$svc"
done

# ---- step 4: interactive secret prompts ------------------------------------

# Top-level (no owner) — always asked.
log "Provider API keys"
ask_secret OPENROUTER_API_KEY "OpenRouter API key"
ask_secret VOYAGE_API_KEY     "Voyage API key"

# Block-owned secrets — stack_upsert routes into the right block.
# Only asked when the owning service is enabled (otherwise the block
# doesn't exist and stack_upsert would die).
_enabled() { printf '%s' "$new_profiles,$new_machines" | tr ',' '\n' | grep -qxF "$1"; }

if _enabled litellm; then
  log "litellm secrets"
  gen_if_missing LITELLM_MASTER_KEY "sk-" 24
fi

if _enabled agentmemory; then
  log "agentmemory secrets"
  gen_if_missing AGENTMEMORY_SECRET "" 32
fi

if _enabled cliproxyapi; then
  log "cliproxyapi secrets"
  gen_if_missing CLIPROXY_API_KEY        "sk-" 24
  gen_if_missing CLIPROXY_MANAGEMENT_KEY ""    32
fi

if _enabled hermes; then
  log "hermes (Telegram gateway — blank ok)"
  ask_plain HERMES_TELEGRAM_BOT_TOKEN     "Telegram bot token"          ""
  ask_plain HERMES_TELEGRAM_ALLOWED_USERS "Telegram allowed user IDs"   ""
  ask_plain HERMES_TELEGRAM_HOME_CHANNEL  "Telegram home channel"       ""
  # Gateway access key — minted ONLY when the user opened the gate. Closed
  # gate means the gateway binds VM-loopback and the key is unused; keeping
  # it empty in that mode avoids surfacing a phantom secret.
  if [ "$(env_get "$ENVF" HERMES_GATEWAY_ALLOW_ACCESS)" = "true" ]; then
    log "hermes gateway access key (gate=open)"
    gen_if_missing HERMES_GATEWAY_API_KEY "" 32
  fi
fi

if _enabled hermes-workspace; then
  log "hermes-workspace session password"
  gen_if_missing HERMES_WORKSPACE_PASSWORD "" 32
fi

chmod 600 "$ENVF"

log "Setup complete"
echo "  Active docker services:  $(env_get "$ENVF" COMPOSE_PROFILES)"
echo "  Active VM services:      $(env_get "$ENVF" STACK_MACHINES)"
echo
echo "Next steps:"
echo "  just build && just start"
echo "  just enabled               # confirm current selection"
echo "  just enable <svc>          # add another service later"
echo "  just disable <svc>         # remove (refuses if dependants enabled)"
