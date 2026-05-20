#!/usr/bin/env bash
# setup.sh — initialize .stack/.env (core + secrets). Non-destructive:
# keeps existing values as defaults. Only the bits that don't belong to any
# specific service live here — provider API keys, generated secrets, the
# project name. Per-service config (versions, model levers, virtkeys, etc.)
# is written by `just enable <svc>`, NOT here.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stacklib.sh"

ENVF="$STACK_DIR/.env"
mkdir -p "$STACK_DIR"
touch "$ENVF"

ask_secret() {  # ask_secret VAR PROMPT  (silent input; blank = keep current)
  local var="$1" prompt="$2" cur val
  cur="$(env_get "$ENVF" "$var")"
  read -rsp "$prompt [${cur:+<keep current>}]: " val; echo
  val="${val:-$cur}"
  env_upsert "$ENVF" "$var" "$val"
}
ask_plain() {   # ask_plain VAR PROMPT DEFAULT  (visible; blank = default)
  local var="$1" prompt="$2" def="$3" cur val
  cur="$(env_get "$ENVF" "$var")"
  read -rp "$prompt [${cur:-$def}]: " val
  val="${val:-${cur:-$def}}"
  env_upsert "$ENVF" "$var" "$val"
}
gen_if_missing() {  # gen_if_missing VAR PREFIX BYTES
  local var="$1" prefix="$2" bytes="$3" cur
  cur="$(env_get "$ENVF" "$var")"
  if [ -z "$cur" ]; then
    env_upsert "$ENVF" "$var" "${prefix}$(openssl rand -hex "$bytes")"
    log "generated $var"
  fi
}

log "hermes-stack setup -> $ENVF"

# Per-stack identity. Project name scopes containers / volumes / network;
# OrbStack exposes services at <service>.<project>.orb.local. Use a DISTINCT
# name per stack to run several side by side.
ask_plain COMPOSE_PROJECT_NAME "Compose project name" aitools

# Provider API keys (consumed by LiteLLM at container runtime).
ask_secret OPENROUTER_API_KEY "OpenRouter API key"
ask_secret VOYAGE_API_KEY     "Voyage API key"

# Telegram (Hermes gateway; only used when 'hermes' is enabled — harmless
# to leave blank for non-hermes stacks).
ask_plain TELEGRAM_BOT_TOKEN     "Telegram bot token (blank ok)" ""
ask_plain TELEGRAM_ALLOWED_USERS "Telegram allowed user IDs (csv, blank ok)" ""
ask_plain TELEGRAM_HOME_CHANNEL  "Telegram home channel (blank ok)" ""

# Generated secrets (kept stable across re-runs — rotating them invalidates
# DB credentials / active sessions / config-baked auth tokens).
gen_if_missing LITELLM_MASTER_KEY       "sk-" 24
gen_if_missing AGENTMEMORY_SECRET       ""    32
gen_if_missing CLIPROXY_API_KEY         "sk-" 24
gen_if_missing CLIPROXY_MANAGEMENT_KEY  ""    32

# Stack-core CSVs — initialize empty if not set. enable/disable manage these
# from here on; user can also edit by hand if they want.
[ -n "$(env_get "$ENVF" COMPOSE_PROFILES)" ] || env_upsert "$ENVF" COMPOSE_PROFILES ""
[ -n "$(env_get "$ENVF" LITELLM_VIRTKEYS)" ] || env_upsert "$ENVF" LITELLM_VIRTKEYS ""
[ -n "$(env_get "$ENVF" STACK_MACHINES)"   ] || env_upsert "$ENVF" STACK_MACHINES   ""

# Stack-core flags — set defaults if not present (user can edit afterward).
[ -n "$(env_get "$ENVF" STACK_AUTO_REMOVE_PROVISIONERS)" ] \
  || env_upsert "$ENVF" STACK_AUTO_REMOVE_PROVISIONERS "false"

chmod 600 "$ENVF"

log "setup complete. Next steps:"
log "  1. Enable services:    just enable hermes   (cascades litellm + pg + redis)"
log "                         just enable honcho   (a memory backend for hermes)"
log "                         just enable searxng  (privacy-respecting web search)"
log "                         just enable firecrawl, agentmemory, hindsight, ..."
log "                         just enabled        # show current selection"
log "  2. Build + start:      just build && just start"
log "  3. Browse services:    services/<svc>/README.md for per-service config"
