#!/usr/bin/env bash
# setup.sh — interactively create/refresh .stack/.env. Non-destructive: keeps
# existing values as defaults.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stacklib.sh"
ENVF="$STACK_DIR/.env"
mkdir -p "$STACK_DIR"
EX="$STACK_ROOT/.stack.env.example"

ask() { # ask VAR PROMPT [secret]
  local var="$1" prompt="$2" secret="${3:-}" cur def
  cur="$(env_get "$ENVF" "$var")"
  def="${cur:-$(env_get "$EX" "$var")}"
  if [ "$secret" = secret ]; then
    read -rsp "$prompt [${cur:+<keep current>}]: " val; echo
  else
    read -rp "$prompt [${def}]: " val
  fi
  val="${val:-${cur:-$def}}"
  env_upsert "$ENVF" "$var" "$val"
}

log "hermes-stack setup -> $ENVF"

# Per-stack identity. Containers/volumes/network are project-scoped and
# OrbStack exposes services at <service>.<project>.orb.local. Use a DISTINCT
# project name (and a distinct STACK_MACHINES name) per stack to run several
# side by side.
curproj="$(env_get "$ENVF" COMPOSE_PROJECT_NAME)"
read -rp "Compose project name [${curproj:-aitools}]: " proj
env_upsert "$ENVF" COMPOSE_PROJECT_NAME "${proj:-${curproj:-aitools}}"

ask OPENROUTER_API_KEY "OpenRouter API key" secret
ask VOYAGE_API_KEY     "Voyage API key" secret
mk="$(env_get "$ENVF" LITELLM_MASTER_KEY)"
[ -n "$mk" ] || { mk="sk-$(openssl rand -hex 24)"; log "generated LITELLM_MASTER_KEY"; }
env_upsert "$ENVF" LITELLM_MASTER_KEY "$mk"
ams="$(env_get "$ENVF" AGENTMEMORY_SECRET)"
[ -n "$ams" ] || { ams="$(openssl rand -hex 32)"; log "generated AGENTMEMORY_SECRET"; }
env_upsert "$ENVF" AGENTMEMORY_SECRET "$ams"
cpk="$(env_get "$ENVF" CLIPROXY_API_KEY)"
[ -n "$cpk" ] || { cpk="sk-$(openssl rand -hex 24)"; log "generated CLIPROXY_API_KEY"; }
env_upsert "$ENVF" CLIPROXY_API_KEY "$cpk"
cpm="$(env_get "$ENVF" CLIPROXY_MANAGEMENT_KEY)"
[ -n "$cpm" ] || { cpm="$(openssl rand -hex 32)"; log "generated CLIPROXY_MANAGEMENT_KEY"; }
env_upsert "$ENVF" CLIPROXY_MANAGEMENT_KEY "$cpm"

read -rp "Enable Docker profiles (comma list) [litellm,honcho]: " prof
env_upsert "$ENVF" COMPOSE_PROFILES "${prof:-litellm,honcho}"

read -rp "Orb machines to manage (comma list; '-' for none) [hermes]: " mch
mch="${mch:-hermes}"; [ "$mch" = "-" ] && mch=""   # empty input -> default hermes
env_upsert "$ENVF" STACK_MACHINES "$mch"
if echo "$mch" | grep -qw hermes; then
  ask TELEGRAM_BOT_TOKEN     "Telegram bot token (blank ok)"
  ask TELEGRAM_ALLOWED_USERS "Telegram allowed user IDs (csv, blank ok)"
  ask TELEGRAM_HOME_CHANNEL  "Telegram home channel (blank ok)"
  curmem="$(env_get "$ENVF" HERMES_MEMORY)"
  read -rp "Hermes memory [default|honcho|hindsight|agentmemory|holographic] [${curmem:-honcho}]: " hmem
  env_upsert "$ENVF" HERMES_MEMORY "${hmem:-${curmem:-honcho}}"
fi

# Seed model levers + virtual-key list from the example if absent. ORDER
# MATTERS: presets must land in .stack/.env ABOVE the per-service ${...} refs
# (the file is bash-sourced; refs expand against earlier definitions). The
# literal "${STACK_LLM_MODEL}" value is copied verbatim — that indirection is
# intentional and resolves on source.
for k in \
  STACK_LLM_MODEL STACK_LLM_MODEL_FAST STACK_LLM_EMBEDDING_MODEL \
  HERMES_MODEL AGENTMEMORY_MODEL AGENTMEMORY_EMBEDDING_MODEL \
  HINDSIGHT_MODEL HINDSIGHT_EMBEDDING_MODEL \
  HONCHO_DERIVER_MODEL HONCHO_SUMMARY_MODEL HONCHO_DREAM_MODEL \
  HONCHO_DIALECTIC_MODEL HONCHO_EMBEDDING_MODEL \
  HERMES_MEMORY LITELLM_VIRTKEYS; do
  [ -n "$(env_get "$ENVF" "$k")" ] || env_upsert "$ENVF" "$k" "$(env_get "$EX" "$k")"
done
chmod 600 "$ENVF"
log "setup complete. Review $ENVF, then: just build && just start"
