#!/usr/bin/env bash
# build-hermes.sh [machine-name=hermes-fresh]
#
# Provisions a NEW OrbStack Ubuntu machine running Hermes, wired to the
# Dockerized Honcho + LiteLLM stack (build-stack.sh must have run first).
#
# Installs ONLY the messaging/agent services (hermes-dashboard, hermes-gateway,
# hermes-logtail). Does NOT install native honcho / postgres — Honcho is
# Dockerized.
#
# HARD SAFETY: refuses to operate on the existing `hermes-agent` (frozen
# original) or `hermes` (current prod clone) machines. A reproducible build
# starts from a fresh `orb create`, never from those.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

MACHINE="${1:-hermes-fresh}"
if [ "$MACHINE" = "hermes-agent" ] || [ "$MACHINE" = "hermes" ]; then
  echo "REFUSING: '$MACHINE' is a protected existing machine (frozen original / prod clone)." >&2
  echo "Pick a fresh name, e.g. ./build-hermes.sh hermes-fresh" >&2
  exit 1
fi

SECRETS="$REPO/secrets.env"
KEYS="$REPO/aitools-services/keys.generated.env"
[ -f "$SECRETS" ] || { echo "FATAL: $SECRETS not found." >&2; exit 1; }
[ -f "$KEYS" ]    || { echo "FATAL: $KEYS not found — run ./build-stack.sh first." >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$SECRETS"; set +a
HERMES_VIRTUAL_KEY="$(grep '^HERMES_VIRTUAL_KEY=' "$KEYS" | cut -d= -f2-)"
[ -n "$HERMES_VIRTUAL_KEY" ] || { echo "FATAL: HERMES_VIRTUAL_KEY missing in $KEYS" >&2; exit 1; }

REMOTE_USER="joe"
m() { orb -m "$MACHINE" bash -lc "$1"; }
log() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------------------
log "1. orb create ubuntu $MACHINE"
if orb list 2>/dev/null | awk '{print $1}' | grep -qx "$MACHINE"; then
  echo "machine $MACHINE already exists — reusing"
else
  orb create ubuntu "$MACHINE"
fi

# ---------------------------------------------------------------------------
log "2. apt-get install -y xz-utils (REQUIRED — Hermes installer extracts Node .tar.xz)"
m 'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils curl ca-certificates'

# ---------------------------------------------------------------------------
log "3. install Hermes + seed ~/.hermes/.env from secrets.env"
m 'command -v hermes >/dev/null 2>&1 || curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'
# Seed only the keys the build needs; values passed via env to avoid argv leak.
ENV_PAYLOAD="$(cat <<EOF
OPENROUTER_API_KEY=${OPENROUTER_API_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS:-}
TELEGRAM_HOME_CHANNEL=${TELEGRAM_HOME_CHANNEL:-}
EOF
)"
printf '%s' "$ENV_PAYLOAD" | orb -m "$MACHINE" bash -lc '
  mkdir -p ~/.hermes && umask 077 && cat > ~/.hermes/.env && chmod 600 ~/.hermes/.env && echo "~/.hermes/.env seeded ($(grep -c = ~/.hermes/.env) keys)"'

# ---------------------------------------------------------------------------
log "4. write ~/.hermes/honcho.json from template"
orb -m "$MACHINE" bash -lc 'mkdir -p ~/.hermes && cat > ~/.hermes/honcho.json' < "$REPO/hermes-vm/config/honcho.json.tmpl"
m 'python3 -c "import json;d=json.load(open(\"/home/'"$REMOTE_USER"'/.hermes/honcho.json\"));print(\"baseUrl=\",d[\"baseUrl\"],\"peerName=\",d[\"hosts\"][\"hermes\"][\"peerName\"],\"pin=\",d[\"hosts\"][\"hermes\"][\"pinPeerName\"])"'

# ---------------------------------------------------------------------------
log "5. patch ~/.hermes/config.yaml model: block (api_key = HERMES_VIRTUAL_KEY)"
# Resolve the template placeholder LOCALLY, pipe via stdin (key never in argv).
MODEL_BLOCK="$(sed "s|\${HERMES_VIRTUAL_KEY}|$HERMES_VIRTUAL_KEY|" "$REPO/hermes-vm/config/config.yaml.model.tmpl" | grep -v '^#')"
printf '%s\n' "$MODEL_BLOCK" | orb -m "$MACHINE" bash -lc '
  set -e
  cfg=~/.hermes/config.yaml
  [ -f "$cfg" ] || hermes config init >/dev/null 2>&1 || touch "$cfg"
  cp "$cfg" "$cfg.bak.prebuild" 2>/dev/null || true
  newblock="$(cat)"
  python3 - "$cfg" <<PY
import sys
p=sys.argv[1]
nb="""$newblock"""
import io
lines=open(p).read().splitlines() if __import__("os").path.exists(p) else []
out=[]; i=0; n=len(lines)
replaced=False
while i<n:
    ln=lines[i]
    if ln.rstrip()=="model:" or ln.startswith("model:"):
        # skip the existing model: block (until next top-level key)
        i+=1
        while i<n and (lines[i].startswith(" ") or lines[i].strip()==""):
            i+=1
        out.append(nb.rstrip())
        replaced=True
        continue
    out.append(ln); i+=1
if not replaced:
    out.insert(0, nb.rstrip())
open(p,"w").write("\n".join(out)+"\n")
print("model: block patched")
PY'

# ---------------------------------------------------------------------------
log "6. install hermes-dashboard / hermes-gateway / hermes-logtail units (NO native honcho/pg)"
orb -m "$MACHINE" bash -lc 'sudo tee /usr/local/bin/hermes-logtail.sh >/dev/null && sudo chmod +x /usr/local/bin/hermes-logtail.sh' < "$REPO/hermes-vm/bin/hermes-logtail.sh"
for unit in hermes-dashboard hermes-gateway hermes-logtail; do
  orb -m "$MACHINE" bash -lc "sudo tee /etc/systemd/system/$unit.service >/dev/null" < "$REPO/hermes-vm/systemd/$unit.service"
done

# ---------------------------------------------------------------------------
log "7. daemon-reload + enable --now"
m 'sudo systemctl daemon-reload && sudo systemctl enable --now hermes-dashboard hermes-gateway hermes-logtail'

# ---------------------------------------------------------------------------
log "8. verify"
echo -n "services: "; m 'systemctl is-active hermes-dashboard hermes-gateway hermes-logtail | tr "\n" " "; echo'
echo -n "honcho reachability: "; m 'curl -sS -m6 http://aitools-honcho-api.orb.local:8000/health || true'; echo
echo "hermes one-shot (streams -> LiteLLM chatgpt/gpt-5.5):"
m 'timeout 90 /home/'"$REMOTE_USER"'/.local/bin/hermes -z "reply with exactly: pong" 2>&1 | tail -3' || echo "(one-shot inconclusive — check orb logs $MACHINE)"

echo
echo "build-hermes.sh DONE for machine '$MACHINE'."
echo "Logs: orb logs $MACHINE   (OrbStack Logs tab = the console; hermes-logtail mirrors there)"
