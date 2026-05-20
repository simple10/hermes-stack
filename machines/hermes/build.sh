#!/usr/bin/env bash
# machines/hermes/build.sh [machine-name=hermes]
# Provisions an OrbStack Ubuntu machine running Hermes wired to the Dockerized
# Honcho+LiteLLM stack. Installs ONLY messaging/agent services (dashboard,
# gateway, logtail) — NO native honcho/postgres (Honcho is Dockerized).
# HARD SAFETY: refuses the frozen original `hermes-agent`.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"

MACHINE="${1:-hermes}"
[ "$MACHINE" = "hermes-agent" ] && die "REFUSING: 'hermes-agent' is the frozen original — never modified."

require_stack_env
ENVF="$STACK_DIR/.env"
GEN="$STACK_DIR/litellm/.generated.env"
source "$ENVF"
# Key may not exist yet on a from-scratch run (it's minted by litellm during
# `just start`, AFTER build). build.sh just provisions + writes config with
# whatever is available; machines/hermes/start.sh (post-mint) applies the
# real key and restarts the gateway. So: do NOT hard-require it here.
HERMES_VIRTUAL_KEY="$(env_get "$GEN" HERMES_VIRTUAL_KEY)"
[ -n "$HERMES_VIRTUAL_KEY" ] || warn "HERMES_VIRTUAL_KEY not minted yet — start.sh will apply it post-mint"
PROJ="$(stack_project)"   # wire this VM to <svc>.$PROJ.orb.local
D="$(dirname "${BASH_SOURCE[0]}")"; REMOTE_USER="joe"
m() { orb -m "$MACHINE" bash -lc "$1"; }

log "1. orb create ubuntu $MACHINE (reuse if exists)"
orb list 2>/dev/null | awk '{print $1}' | grep -qx "$MACHINE" \
  && log "machine $MACHINE exists — reusing" || orb create ubuntu "$MACHINE"

log "2. apt xz-utils (REQUIRED — Hermes installer extracts Node .tar.xz)"
m 'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils curl ca-certificates'

log "3. install Hermes + seed ~/.hermes/.env"
m 'command -v hermes >/dev/null 2>&1 || curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'
ENV_PAYLOAD="$(cat <<EOF
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS:-}
TELEGRAM_HOME_CHANNEL=${TELEGRAM_HOME_CHANNEL:-}
EOF
)"
printf '%s' "$ENV_PAYLOAD" | orb -m "$MACHINE" bash -lc \
  'mkdir -p ~/.hermes && umask 077 && cat > ~/.hermes/.env && chmod 600 ~/.hermes/.env && echo "~/.hermes/.env seeded"'

MEM="${HERMES_MEMORY:-honcho}"
log "4. configure Hermes memory provider: $MEM"
# Guardrail: the chosen provider's backing service should be in the stack.
case "$MEM" in
  honcho)      echo "${COMPOSE_PROFILES:-}" | grep -qw honcho      || warn "HERMES_MEMORY=honcho but 'honcho' not in COMPOSE_PROFILES";;
  hindsight)   echo "${COMPOSE_PROFILES:-}" | grep -qw hindsight   || warn "HERMES_MEMORY=hindsight but 'hindsight' not in COMPOSE_PROFILES";;
  agentmemory) echo "${COMPOSE_PROFILES:-}" | grep -qw agentmemory || warn "HERMES_MEMORY=agentmemory but 'agentmemory' not in COMPOSE_PROFILES";;
esac
case "$MEM" in
  default)
    log "memory: leaving Hermes' own default untouched (no provider override)"
    ;;
  honcho)
    sed "s/__STACK_PROJECT__/$PROJ/g" "$D/config/honcho.json.tmpl" \
      | orb -m "$MACHINE" bash -lc 'mkdir -p ~/.hermes && cat > ~/.hermes/honcho.json'
    m 'hermes config set memory.provider honcho'
    log "memory: honcho -> honcho-api.$PROJ.orb.local:8000"
    ;;
  hindsight)
    sed "s/__STACK_PROJECT__/$PROJ/g" "$D/config/hindsight.config.json.tmpl" \
      | orb -m "$MACHINE" bash -lc 'mkdir -p ~/.hermes/hindsight && cat > ~/.hermes/hindsight/config.json'
    m 'hermes config set memory.provider hindsight'
    log "memory: hindsight (local_external) -> hindsight.$PROJ.orb.local:8888 (plugin auto-installs hindsight-client on first session)"
    ;;
  holographic)
    m 'hermes config set memory.provider holographic'
    log "memory: holographic (fully local in the VM; no stack service)"
    ;;
  agentmemory)
    # Third-party (NOT in Hermes' official memory-plugin set): the @agentmemory/mcp
    # shim + memory.provider. Our agentmemory is containerized, so the shim must
    # reach it at the orb DNS (NOT localhost:3111) — pass URL + secret via
    # ~/.hermes/.env (step 3 rewrote that file fresh, so this append is
    # idempotent across builds). npx/node must be on the VM PATH.
    printf 'AGENTMEMORY_URL=http://agentmemory.%s.orb.local:3111\nAGENTMEMORY_SECRET=%s\n' \
      "$PROJ" "${AGENTMEMORY_SECRET:-}" \
      | orb -m "$MACHINE" bash -lc 'umask 077; cat >> ~/.hermes/.env'
    m 'hermes config set memory.provider agentmemory'
    orb -m "$MACHINE" bash -lc '
      set -e; cfg=~/.hermes/config.yaml
      py=/home/joe/.hermes/hermes-agent/venv/bin/python; [ -x "$py" ] || py=python3
      "$py" - "$cfg" <<PY
import sys,os
try:
    import yaml
except Exception:
    raise SystemExit("pyyaml unavailable in venv; add mcp_servers.agentmemory to config.yaml manually")
p=sys.argv[1]
d=(yaml.safe_load(open(p)) if os.path.exists(p) else {}) or {}
ms=d.get("mcp_servers") or {}
ms["agentmemory"]={"command":"npx","args":["-y","@agentmemory/mcp"]}
d["mcp_servers"]=ms
mem=d.get("memory") or {}; mem["provider"]="agentmemory"; d["memory"]=mem
yaml.safe_dump(d,open(p,"w"),sort_keys=False,default_flow_style=False)
print("config.yaml: mcp_servers.agentmemory + memory.provider merged")
PY'
    log "memory: agentmemory (MCP shim -> agentmemory.$PROJ.orb.local:3111). Deeper 6-hook provider is manual: copy integrations/hermes -> ~/.hermes/plugins/agentmemory."
    ;;
  *)
    die "unknown HERMES_MEMORY='$MEM' (use: default|honcho|hindsight|agentmemory|holographic)"
    ;;
esac

# Firecrawl (profile [firecrawl]): the self-hosted firecrawl-api ignores
# client auth (USE_DB_AUTHENTICATION=false), but the firecrawl SDK requires a
# non-empty FIRECRAWL_API_KEY — so a fixed, clearly-labelled no-auth
# placeholder (NOT a secret). Append URL+placeholder to ~/.hermes/.env (step 3
# rewrites that file fresh, so this is idempotent across builds). Only wired
# when the firecrawl profile is active — don't point Hermes at a dead endpoint.
if echo "${COMPOSE_PROFILES:-}" | grep -qw firecrawl; then
  printf 'FIRECRAWL_API_URL=http://firecrawl-api.%s.orb.local:3002\nFIRECRAWL_API_KEY=%s\n' \
    "$PROJ" "fc-selfhost-noauth" \
    | orb -m "$MACHINE" bash -lc 'umask 077; cat >> ~/.hermes/.env'
  log "firecrawl: FIRECRAWL_API_URL=http://firecrawl-api.$PROJ.orb.local:3002 + placeholder key -> ~/.hermes/.env"
else
  warn "firecrawl not in COMPOSE_PROFILES — skipping Hermes firecrawl env (add 'firecrawl' to COMPOSE_PROFILES to e2e-test it)"
fi

# Camofox (profile [camofox-browser]): self-hosted Camoufox/Firefox automation
# server for Hermes's first-class browser provider. Hermes reads CAMOFOX_URL
# from ~/.hermes/.env and auto-uses camofox as the browser_provider. Hermes
# does NOT send any auth header to Camofox (verified in
# hermes-agent/tools/browser_camofox.py: bare requests.{get,post,delete}), so
# the camofox-browser service must run without CAMOFOX_ACCESS_KEY — set
# CAMOFOX_AUTH=disabled in .stack/.env. Only wired when the profile is active.
if echo "${COMPOSE_PROFILES:-}" | grep -qw camofox-browser; then
  printf 'CAMOFOX_URL=http://camofox-browser.%s.orb.local:9377\n' "$PROJ" \
    | orb -m "$MACHINE" bash -lc 'umask 077; cat >> ~/.hermes/.env'
  log "camofox: CAMOFOX_URL=http://camofox-browser.$PROJ.orb.local:9377 -> ~/.hermes/.env"
else
  warn "camofox-browser not in COMPOSE_PROFILES — skipping Hermes camofox env"
fi

log "5. patch ~/.hermes/config.yaml model: block (litellm.$PROJ.orb.local; key via stdin, never argv)"
HM="${HERMES_MODEL:-cliproxy/gpt-5.5}"   # HERMES_MODEL lever from sourced .stack/.env
MODEL_BLOCK="$(sed -e "s|\${HERMES_VIRTUAL_KEY}|$HERMES_VIRTUAL_KEY|" -e "s/__STACK_PROJECT__/$PROJ/g" -e "s|__HERMES_MODEL__|$HM|g" "$D/config/config.yaml.model.tmpl" | grep -v '^#')"
printf '%s\n' "$MODEL_BLOCK" | orb -m "$MACHINE" bash -lc '
  set -e; umask 077; cfg=~/.hermes/config.yaml
  [ -f "$cfg" ] || hermes config init >/dev/null 2>&1 || touch "$cfg"
  cp "$cfg" "$cfg.bak.prebuild" 2>/dev/null || true
  nb="$(cat)"
  python3 - "$cfg" <<PY
import sys,os
p=sys.argv[1]; nb="""$nb"""
lines=open(p).read().splitlines() if os.path.exists(p) else []
out=[]; i=0; n=len(lines); rep=False
while i<n:
    ln=lines[i]
    if ln.rstrip()=="model:" or ln.startswith("model:"):
        i+=1
        while i<n and (lines[i].startswith(" ") or lines[i].strip()==""): i+=1
        out.append(nb.rstrip()); rep=True; continue
    out.append(ln); i+=1
if not rep: out.insert(0, nb.rstrip())
open(p,"w").write("\n".join(out)+"\n"); print("model: block patched")
PY'

log "6. install units + logtail (NO native honcho/pg)"
orb -m "$MACHINE" bash -lc 'sudo tee /usr/local/bin/hermes-logtail.sh >/dev/null && sudo chmod +x /usr/local/bin/hermes-logtail.sh' < "$D/bin/hermes-logtail.sh"
for unit in hermes-dashboard hermes-gateway hermes-logtail; do
  orb -m "$MACHINE" bash -lc "sudo tee /etc/systemd/system/$unit.service >/dev/null" < "$D/systemd/$unit.service"
done
log "machines/hermes/build.sh DONE for '$MACHINE' (start.sh enables units)"
