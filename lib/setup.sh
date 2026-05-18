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

read -rp "Enable Docker profiles (comma list) [litellm,honcho]: " prof
env_upsert "$ENVF" COMPOSE_PROFILES "${prof:-litellm,honcho}"

read -rp "Orb machines to manage (comma list; '-' for none) [hermes]: " mch
mch="${mch:-hermes}"; [ "$mch" = "-" ] && mch=""   # empty input -> default hermes
env_upsert "$ENVF" STACK_MACHINES "$mch"
if echo "$mch" | grep -qw hermes; then
  ask TELEGRAM_BOT_TOKEN     "Telegram bot token (blank ok)"
  ask TELEGRAM_ALLOWED_USERS "Telegram allowed user IDs (csv, blank ok)"
  ask TELEGRAM_HOME_CHANNEL  "Telegram home channel (blank ok)"
fi

# Seed virtual-key allowlist declarations from the example if absent.
for k in LITELLM_VIRTKEY_HONCHO_MODELS LITELLM_VIRTKEY_HERMES_MODELS; do
  [ -n "$(env_get "$ENVF" "$k")" ] || env_upsert "$ENVF" "$k" "$(env_get "$EX" "$k")"
done
chmod 600 "$ENVF"
log "setup complete. Review $ENVF, then: just build && just start"
