#!/usr/bin/env bash
# services/hermes/start.sh [machine=hermes] — enable + (re)start hermes units.
# Re-applies the virtual key in case it was re-minted (idempotent).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../../lib/stacklib.sh"
# SVC = service name (matches services/<SVC>/ + STACK_MACHINES entries).
# VM  = actual orb VM name, project-prefixed via stack_vm_name.
SVC="${1:-hermes}"
[ "$SVC" = "hermes-agent" ] && die "REFUSING: 'hermes-agent' is the frozen original."
GEN="$STACK_DIR/litellm/.generated.env"
HK="$(env_get "$GEN" HERMES_VIRTUAL_KEY)"
PROJ="$(stack_project)"
VM="$(stack_vm_name "$SVC")"
# bash-source .stack/.env so HERMES_MODEL=${STACK_LLM_MODEL} expands.
set -a; . "$STACK_DIR/.env"; set +a
HM="${HERMES_MODEL:-cliproxy/gpt-5.5}"
D="$(dirname "${BASH_SOURCE[0]}")"
if [ -n "$HK" ]; then
  MB="$(sed -e "s|\${HERMES_VIRTUAL_KEY}|$HK|" -e "s/__STACK_PROJECT__/$PROJ/g" -e "s|__HERMES_MODEL__|$HM|g" "$D/config/config.yaml.model.tmpl" | grep -v '^#')"
  printf '%s\n' "$MB" | orb -m "$VM" bash -lc '
    cfg=~/.hermes/config.yaml; nb="$(cat)"
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
open(p,"w").write("\n".join(out)+"\n")
PY'
fi
orb -m "$VM" bash -lc 'sudo systemctl daemon-reload && sudo systemctl enable --now hermes-dashboard hermes-gateway hermes-logtail && sudo systemctl restart hermes-gateway hermes-logtail'
echo -n "services: "; orb -m "$VM" bash -lc 'systemctl is-active hermes-dashboard hermes-gateway hermes-logtail | tr "\n" " "; echo'
echo -n "honcho reachable: "; orb -m "$VM" bash -lc "curl -sS -m6 http://honcho-api.$PROJ.orb.local:8000/health || true"; echo
