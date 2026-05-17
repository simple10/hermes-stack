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
GEN="$STACK_DIR/litellm.generated.env"
source "$ENVF"
HERMES_VIRTUAL_KEY="$(env_get "$GEN" HERMES_VIRTUAL_KEY)"
[ -n "$HERMES_VIRTUAL_KEY" ] || die "HERMES_VIRTUAL_KEY missing — run \`just start\` (litellm mint) first."
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

log "4. write ~/.hermes/honcho.json"
orb -m "$MACHINE" bash -lc 'mkdir -p ~/.hermes && cat > ~/.hermes/honcho.json' < "$D/config/honcho.json.tmpl"

log "5. patch ~/.hermes/config.yaml model: block (key via stdin, never argv)"
MODEL_BLOCK="$(sed "s|\${HERMES_VIRTUAL_KEY}|$HERMES_VIRTUAL_KEY|" "$D/config/config.yaml.model.tmpl" | grep -v '^#')"
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
