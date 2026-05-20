#!/usr/bin/env bash
# services/hermes/build.sh [machine-name=hermes]
# Provisions an OrbStack Ubuntu machine running Hermes wired to the Dockerized
# Honcho+LiteLLM stack. Installs ONLY messaging/agent services (dashboard,
# gateway, logtail) — NO native honcho/postgres (Honcho is Dockerized).
# SERVICE_RUNNER=vm in service.env: discovered via services/* + STACK_MACHINES,
# NOT via a docker compose profile (this service has no compose.yaml).
# HARD SAFETY: refuses the frozen original `hermes-agent`.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"

# SVC matches the directory name (services/<SVC>/); VM is the actual orb
# machine name, project-prefixed via stack_vm_name so multi-stack runs
# can't collide on orb's global namespace. e.g. service 'hermes' in
# project 'aitools' -> VM 'aitools_hermes'.
SVC="${1:-hermes}"
[ "$SVC" = "hermes-agent" ] && die "REFUSING: 'hermes-agent' is the frozen original — never modified."

require_stack_env
ENVF="$STACK_DIR/.env"
GEN="$STACK_DIR/litellm/.generated.env"
source "$ENVF"
PROJ="$(stack_project)"   # wire this VM to <svc>.$PROJ.orb.local
VM="$(stack_vm_name "$SVC")"
# Key may not exist yet on a from-scratch run (it's minted by litellm during
# `just start`, AFTER build). build.sh just provisions + writes config with
# whatever is available; services/hermes/start.sh (post-mint) applies the
# real key and restarts the gateway. So: do NOT hard-require it here.
HERMES_VIRTUAL_KEY="$(env_get "$GEN" HERMES_VIRTUAL_KEY)"
[ -n "$HERMES_VIRTUAL_KEY" ] || warn "HERMES_VIRTUAL_KEY not minted yet — start.sh will apply it post-mint"
D="$(dirname "${BASH_SOURCE[0]}")"
# REMOTE_USER from the hermes block in .stack/.env (default 'hermes'; users
# of pre-REMOTE_USER VMs can set to whatever orb defaulted to for them).
# It's needed for the orb create --user flag AND for templating systemd
# units + bin scripts that hardcode /home/$REMOTE_USER/.hermes/...
REMOTE_USER="${REMOTE_USER:-hermes}"
m() { orb -m "$VM" bash -lc "$1"; }

log "1. orb create ubuntu $VM (--user $REMOTE_USER --isolated --isolate-network; reuse if exists)"
# Isolation: --isolated disables file sharing/Mac integration (no $HOME, no
# Cmd-clipboard) AND --isolate-network blocks the VM from Mac IPs + sibling
# VMs. Together: a compromised Hermes process can ONLY reach this stack's
# docker network (via orb DNS); it cannot read Mac files or scan Mac
# localhost. Host-bridge to the Mac is via the localhost-proxy service (opt-in
# per-port). orb -m bash -lc exec STILL works under --isolated (verified).
# --user picks the in-VM unix account; default 'hermes' decouples the VM
# from the Mac user (orb create's default mirrors $USER).
if orb list 2>/dev/null | awk '{print $1}' | grep -qx "$VM"; then
  log "machine $VM exists — reusing (REMOTE_USER=$REMOTE_USER must match the unix user inside the VM)"
  # Idempotently ensure both isolation flags are true. Takes effect on next
  # `orb start` of this machine — caller (build.sh standalone, or `just
  # build`) doesn't restart; `just start` enforces + fails-fast if a restart
  # is required so the user runs `just restart` deliberately.
  set +e
  orb_set_machine_isolation "$VM"
  rc=$?
  set -e
  case "$rc" in
    0) ;;
    1) warn "machine $VM: isolation flags were FALSE — flipped to true. Run 'just restart' to apply." ;;
    2) die  "machine $VM: 'orb config set' failed (is OrbStack running?)" ;;
  esac
else
  orb create --user "$REMOTE_USER" --isolated --isolate-network ubuntu "$VM"
fi

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
printf '%s' "$ENV_PAYLOAD" | orb -m "$VM" bash -lc \
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
      | orb -m "$VM" bash -lc 'mkdir -p ~/.hermes && cat > ~/.hermes/honcho.json'
    m 'hermes config set memory.provider honcho'
    log "memory: honcho -> honcho-api.$PROJ.orb.local:8000"
    ;;
  hindsight)
    sed "s/__STACK_PROJECT__/$PROJ/g" "$D/config/hindsight.config.json.tmpl" \
      | orb -m "$VM" bash -lc 'mkdir -p ~/.hermes/hindsight && cat > ~/.hermes/hindsight/config.json'
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
      | orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'
    m 'hermes config set memory.provider agentmemory'
    orb -m "$VM" bash -lc '
      set -e; cfg=~/.hermes/config.yaml
      py=~/.hermes/hermes-agent/venv/bin/python; [ -x "$py" ] || py=python3
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
    | orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'
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
    | orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'
  log "camofox: CAMOFOX_URL=http://camofox-browser.$PROJ.orb.local:9377 -> ~/.hermes/.env"
else
  warn "camofox-browser not in COMPOSE_PROFILES — skipping Hermes camofox env"
fi

# SearXNG (profile [searxng]): privacy-respecting metasearch for Hermes'
# web_search capability (Hermes docs:
# https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search).
# Append SEARXNG_URL to ~/.hermes/.env AND flip web.search_backend to searxng.
# If both [firecrawl] and [searxng] are active, searxng wins (this block runs
# after firecrawl above + sets search_backend explicitly). Override by
# manually setting web.search_backend in ~/.hermes/config.yaml after build.
if echo "${COMPOSE_PROFILES:-}" | grep -qw searxng; then
  printf 'SEARXNG_URL=http://searxng.%s.orb.local:8080\n' "$PROJ" \
    | orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'
  m 'hermes config set web.search_backend searxng'
  log "searxng: SEARXNG_URL=http://searxng.$PROJ.orb.local:8080 -> ~/.hermes/.env (web.search_backend=searxng)"
else
  warn "searxng not in COMPOSE_PROFILES — skipping Hermes searxng env"
fi

log "5. patch ~/.hermes/config.yaml model: block (litellm.$PROJ.orb.local; key via stdin, never argv)"
HM="${HERMES_MODEL:-cliproxy/gpt-5.5}"   # HERMES_MODEL lever from sourced .stack/.env
MODEL_BLOCK="$(sed -e "s|\${HERMES_VIRTUAL_KEY}|$HERMES_VIRTUAL_KEY|" -e "s/__STACK_PROJECT__/$PROJ/g" -e "s|__HERMES_MODEL__|$HM|g" "$D/config/config.yaml.model.tmpl" | grep -v '^#')"
printf '%s\n' "$MODEL_BLOCK" | orb -m "$VM" bash -lc '
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

log "6. install units + logtail (NO native honcho/pg). Templates use
   __REMOTE_USER__ which gets sed-substituted to '$REMOTE_USER' here so
   /home/<user>/... paths inside the VM match the actual unix account."
sed "s|__REMOTE_USER__|$REMOTE_USER|g" "$D/bin/hermes-logtail.sh" \
  | orb -m "$VM" bash -lc 'sudo tee /usr/local/bin/hermes-logtail.sh >/dev/null && sudo chmod +x /usr/local/bin/hermes-logtail.sh'
for unit in hermes-dashboard hermes-gateway hermes-logtail; do
  sed "s|__REMOTE_USER__|$REMOTE_USER|g" "$D/systemd/$unit.service" \
    | orb -m "$VM" bash -lc "sudo tee /etc/systemd/system/$unit.service >/dev/null"
done
log "services/hermes/build.sh DONE for '$VM' (start.sh enables units)"
