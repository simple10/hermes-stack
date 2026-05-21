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
orb -m "$VM" bash -lc '
  set -e
  sudo systemctl daemon-reload
  sudo systemctl enable --now hermes-dashboard hermes-gateway hermes-logtail
  # logtail is not task-bearing; a plain restart is fine and picks up any
  # tail-script changes installed by build.sh.
  sudo systemctl restart hermes-logtail
  # Drain-aware gateway restart: hermes-cli internally sends SIGUSR1, waits
  # for in-flight agent runs to finish (bounded by agent.restart_drain_timeout),
  # then exits with code 75 — systemd auto-relaunches via RestartForceExitStatus=75
  # with the freshly daemon-reloaded unit. Falls back to a harder restart
  # path internally if drain times out. See hermes_cli/gateway.py systemd_restart.
  #
  # `sudo hermes` resolves via /usr/local/bin/hermes (symlink installed by
  # build.sh step 3) — keeps sudo'"'"'s secure_path clean and makes
  # `sudo hermes ...` work from any shell in the VM.
  sudo hermes gateway restart --system
'
echo -n "services: "; orb -m "$VM" bash -lc 'systemctl is-active hermes-dashboard hermes-gateway hermes-logtail | tr "\n" " "; echo'
echo -n "honcho reachable: "; orb -m "$VM" bash -lc "curl -sS -m6 http://honcho-api.$PROJ.orb.local:8000/health || true"; echo
