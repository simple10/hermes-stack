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
# HERMES_REMOTE_USER from the hermes block in .stack/.env (default 'hermes';
# users of pre-HERMES_REMOTE_USER VMs can set to whatever orb defaulted to
# for them). Needed for the orb create --user flag AND for templating
# systemd units + bin scripts that hardcode /home/$REMOTE_USER/.hermes/...
# The shell-local var name stays REMOTE_USER (it's just a local; the
# stack-facing name is what gets the prefix).
REMOTE_USER="${HERMES_REMOTE_USER:-hermes}"
m() { orb -m "$VM" bash -lc "$1"; }

# --- mount-aware ~/.hermes writers ----------------------------------------
# When HERMES_MOUNT_ENABLED=true, the VM's /home/$REMOTE_USER/.hermes is a
# bind-mount of the Mac path $MAC_HERMES (= $HERMES_MOUNT_DIR resolved
# absolute). So writes to ~/.hermes/ on the VM should happen Mac-side
# directly — faster, no orb-exec, and `just build`'s edits are immediately
# visible to the live VM via the mount. When disabled, we warn-and-skip
# (config edits through `just build` are mount-enabled-only per design).

HERMES_MOUNT_ENABLED="$(env_get "$ENVF" HERMES_MOUNT_ENABLED)"
HERMES_MOUNT_ENABLED="${HERMES_MOUNT_ENABLED:-true}"
HERMES_MOUNT_DIR="$(env_get "$ENVF" HERMES_MOUNT_DIR)"
HERMES_MOUNT_DIR="${HERMES_MOUNT_DIR:-.stack/hermes/.hermes}"
case "$HERMES_MOUNT_DIR" in
  /*) MAC_HERMES="$HERMES_MOUNT_DIR" ;;
  *)  MAC_HERMES="$STACK_ROOT/$HERMES_MOUNT_DIR" ;;
esac
VM_HERMES="/home/$REMOTE_USER/.hermes"
ORB_MOUNT_SPEC="$MAC_HERMES:$VM_HERMES"

# hermes_write RELPATH [CONTENT]  — write a file under ~/.hermes.
#   mount enabled: write to $MAC_HERMES/RELPATH (Mac-side).
#   mount disabled: warn + skip + print the manual `orb -m` equivalent.
hermes_write() {
  local rel="$1"
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    mkdir -p "$(dirname "$MAC_HERMES/$rel")"
    if [ $# -ge 2 ]; then
      printf '%s' "$2" > "$MAC_HERMES/$rel"
    else
      cat > "$MAC_HERMES/$rel"
    fi
  else
    warn "skip ~/.hermes/$rel (HERMES_MOUNT_ENABLED=false)"
    printf '       apply manually: orb -m %s bash -lc %q\n' "$VM" \
      "umask 077 && mkdir -p ~/.hermes/$(dirname "$rel" 2>/dev/null || echo .) && cat > ~/.hermes/$rel" >&2
    [ $# -ge 2 ] || cat >/dev/null   # drain stdin so producers don't block
  fi
}

# hermes_append RELPATH  — append stdin to ~/.hermes/RELPATH.
hermes_append() {
  local rel="$1"
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    mkdir -p "$(dirname "$MAC_HERMES/$rel")"
    cat >> "$MAC_HERMES/$rel"
  else
    warn "skip append to ~/.hermes/$rel (HERMES_MOUNT_ENABLED=false)"
    printf '       apply manually: orb -m %s bash -lc %q\n' "$VM" \
      "umask 077 && cat >> ~/.hermes/$rel" >&2
    cat >/dev/null
  fi
}

# --- ~/.hermes/.env managed-block helper ----------------------------------
# We own a single block inside ~/.hermes/.env (between MANAGED_OPEN /
# MANAGED_CLOSE markers). Lines OUTSIDE that block are user-owned and
# preserved across every `just build` — that's where plugin env vars
# (HERMES_AGENTS_OBSERVE_URL, HERMES_LANGFUSE_*, etc.) live. Mirrors the
# `#>--- svc ---` block convention already used in .stack/.env.
#
# Migration: first time the helper runs against a marker-less existing
# .env (legacy layout), the entire current file is preserved as user
# content beneath a freshly inserted managed block — nothing is lost.
MANAGED_OPEN='# >>> hermes-stack managed (rewritten on each `just build`) -- DO NOT EDIT >>>'
MANAGED_CLOSE='# <<< hermes-stack managed <<<'
MANAGED_HINT='# User vars below are preserved across `just build`. Add plugin env (e.g. HERMES_AGENTS_OBSERVE_URL) here.'

# hermes_env_rewrite_managed_block CONTENT  — Write CONTENT into the managed
# block of ~/.hermes/.env. Preserves lines outside the markers. Mount-aware
# (no-op + manual-cmd warning when HERMES_MOUNT_ENABLED=false, same shape
# as hermes_write).
#
# Three modes by file state:
#   first   — file missing: write the managed block only, no hint.
#   migrate — file exists with no markers (legacy layout): preserve the
#             file as the user-section beneath a fresh managed block, AND
#             strip lines that set keys the managed block now owns (so
#             stale values can't shadow new ones under either first-wins
#             or last-wins .env parsing).  Inserts the user-hint comment
#             once, immediately after the closing marker.
#   update  — file has the marker pair: rewrite only the content between
#             them; leave everything outside (`pre` + `post`) untouched
#             byte-for-byte.  No hint re-insertion — it lives in `post`
#             from the migrate run, or the user removed it intentionally.
hermes_env_rewrite_managed_block() {
  local content="$1"
  if [ "$HERMES_MOUNT_ENABLED" != "true" ]; then
    warn "skip ~/.hermes/.env managed-block rewrite (HERMES_MOUNT_ENABLED=false)"
    printf '       apply manually inside the VM, taking care to preserve any user-added lines\n' >&2
    return 0
  fi
  local target="$MAC_HERMES/.env"
  mkdir -p "$(dirname "$target")"

  local mode="first" pre="" post=""
  if [ -f "$target" ]; then
    local open_ln close_ln
    open_ln="$(grep -nF "$MANAGED_OPEN"  "$target" 2>/dev/null | head -1 | cut -d: -f1 || true)"
    close_ln="$(grep -nF "$MANAGED_CLOSE" "$target" 2>/dev/null | head -1 | cut -d: -f1 || true)"
    if [ -n "$open_ln" ] && [ -n "$close_ln" ] && [ "$close_ln" -gt "$open_ln" ]; then
      mode="update"
      [ "$open_ln" -gt 1 ] && pre="$(sed -n "1,$((open_ln - 1))p" "$target")"
      post="$(sed -n "$((close_ln + 1)),\$p" "$target")"
    else
      if [ -n "${open_ln:-}${close_ln:-}" ]; then
        warn "~/.hermes/.env: marker pair incomplete — treating entire file as user data and reinserting fresh markers"
      fi
      mode="migrate"
      post="$(cat "$target")"
      # Strip lines from `post` that set any key the managed block owns.
      # Otherwise a stale `OPENROUTER_API_KEY=old-value` left over from the
      # pre-marker layout could shadow the freshly-written managed value
      # (.env parsers vary on first-wins vs last-wins; safe answer: don't
      # ship duplicates). Match only top-level KEY=… assignments; in-value
      # `=` signs (e.g. JWT secrets) don't trip the key-name regex.
      # Comma-flatten the key list — awk -v rejects embedded newlines.
      local managed_keys
      managed_keys="$(printf '%s\n' "$content" | sed -nE 's/^([A-Z_][A-Z0-9_]*)=.*/\1/p' | sort -u | tr '\n' ',')"
      if [ -n "$managed_keys" ]; then
        post="$(printf '%s\n' "$post" | awk -v keys="$managed_keys" '
          BEGIN { n=split(keys, K, ","); for (i=1;i<=n;i++) if (K[i]!="") seen[K[i]]=1 }
          { line=$0
            if (match(line, /^[ \t]*[A-Z_][A-Z0-9_]*=/)) {
              k=substr(line, RSTART, RLENGTH-1); sub(/^[ \t]*/, "", k)
              if (seen[k]) next
            }
            print line
          }')"
      fi
    fi
  fi

  # Trim leading + trailing blank lines from `post` so neither migration
  # nor steady-state re-runs accumulate whitespace each pass.
  local post_clean=""
  if [ -n "$post" ]; then
    post_clean="$(printf '%s' "$post" | awk 'NF{p=1} p' | awk 'BEGIN{n=0} {a[n++]=$0} END{for(i=n-1;i>=0&&a[i]=="";i--); for(j=0;j<=i;j++) print a[j]}')"
  fi

  {
    [ -n "$pre" ] && printf '%s\n' "$pre"
    printf '%s\n' "$MANAGED_OPEN"
    printf '%s\n' "$content"
    printf '%s\n' "$MANAGED_CLOSE"
    if [ "$mode" = "migrate" ]; then
      printf '\n%s\n' "$MANAGED_HINT"
    fi
    if [ -n "$post_clean" ]; then
      [ "$mode" = "update" ] && printf '\n'
      printf '%s\n' "$post_clean"
    fi
  } > "$target"
  chmod 600 "$target"
}

# hermes_sync_plugin NAME  — Copy services/hermes/plugins/<NAME>/ into the
# VM's ~/.hermes/plugins/<NAME>/, mount-aware. Excludes Python build
# artifacts (.venv, __pycache__, .pytest_cache).
#
# When HERMES_MOUNT_ENABLED=false, no-op + print the equivalent manual
# orb command for the operator to apply inside the VM.
hermes_sync_plugin() {
  local name="$1"
  local src="$D/plugins/$name"      # $D is the script's dir (services/hermes/)
  [ -d "$src" ] || die "hermes_sync_plugin: source plugin dir not found: $src"

  if [ "$HERMES_MOUNT_ENABLED" != "true" ]; then
    warn "skip plugin sync for '$name' (HERMES_MOUNT_ENABLED=false)"
    printf '       apply manually inside the VM:\n' >&2
    printf '         orb -m %s bash -lc '\''mkdir -p ~/.hermes/plugins/%s && rsync -a --delete --exclude=.venv/ --exclude=__pycache__/ --exclude=.pytest_cache/ <repo>/services/hermes/plugins/%s/ ~/.hermes/plugins/%s/'\''\n' "$VM" "$name" "$name" "$name" >&2
    return 0
  fi

  local dest="$MAC_HERMES/plugins/$name"
  mkdir -p "$dest"
  rsync -a --delete \
    --exclude=.venv/ \
    --exclude=__pycache__/ \
    --exclude=.pytest_cache/ \
    "$src/" "$dest/"
  log "synced plugin '$name' → $dest"
}

# hermes_enable_plugin NAME  — Idempotently append NAME to ~/.hermes/
# config.yaml's plugins.enabled list. Mount-aware (no-op + warn when
# HERMES_MOUNT_ENABLED=false). Uses pyyaml round-trip; comments inside
# the file may be lost (pyyaml limitation — same trade-off as the
# agentmemory section).
hermes_enable_plugin() {
  local name="$1"

  if [ "$HERMES_MOUNT_ENABLED" != "true" ]; then
    warn "skip plugin enable for '$name' (HERMES_MOUNT_ENABLED=false)"
    printf '       apply manually inside the VM:\n' >&2
    printf '         orb -m %s bash -lc '\''hermes plugins enable %s'\''\n' "$VM" "$name" >&2
    return 0
  fi

  local cfg="$MAC_HERMES/config.yaml"
  mkdir -p "$(dirname "$cfg")"
  python3 - "$cfg" "$name" <<'PY'
import sys
try:
    import yaml
except Exception:
    raise SystemExit("pyyaml unavailable; pip install pyyaml on the Mac")
import os
path, name = sys.argv[1], sys.argv[2]
d = (yaml.safe_load(open(path)) if os.path.exists(path) else {}) or {}
plugins = d.setdefault("plugins", {}) if isinstance(d.get("plugins") or {}, dict) else {}
if not isinstance(plugins, dict):
    plugins = {}
    d["plugins"] = plugins
enabled = plugins.get("enabled") or []
if not isinstance(enabled, list):
    enabled = []
if name not in enabled:
    enabled.append(name)
plugins["enabled"] = enabled
d["plugins"] = plugins
yaml.safe_dump(d, open(path, "w"), sort_keys=False, default_flow_style=False)
print(f"plugins.enabled now: {enabled}")
PY
  log "enabled plugin '$name' in ~/.hermes/config.yaml"
}

log "0. resolve hermes mount config
   HERMES_MOUNT_ENABLED=$HERMES_MOUNT_ENABLED
   HERMES_MOUNT_DIR=$HERMES_MOUNT_DIR
   resolves to: $ORB_MOUNT_SPEC"

if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
  # Refuse-to-shadow guard: if Mac dir is empty but VM has live ~/.hermes
  # data, mounting would shadow it and break the gateway. Tell the user to
  # snapshot first (procedure in docs/plans/implemented/2026-05-21-hermes-mount.md).
  vm_has_data=0
  if orb list 2>/dev/null | awk '{print $1}' | grep -qx "$VM"; then
    orb -m "$VM" bash -lc 'test -s ~/.hermes/config.yaml' 2>/dev/null && vm_has_data=1
  fi
  mac_has_config=0
  [ -s "$MAC_HERMES/config.yaml" ] && mac_has_config=1
  if [ "$vm_has_data" = "1" ] && [ "$mac_has_config" = "0" ]; then
    die "HERMES_MOUNT_ENABLED=true but $HERMES_MOUNT_DIR is empty (no config.yaml)
       AND the VM has an existing ~/.hermes/. Refusing to add the mount — it
       would shadow live VM data.

       Migrate first:
         1. just stop                                       # quiesce the VM
         2. mkdir -p $HERMES_MOUNT_DIR
         3. cp -a ~/OrbStack/$VM/$VM_HERMES/. $HERMES_MOUNT_DIR/
         4. rm -rf $HERMES_MOUNT_DIR/hermes-agent           # regenerable
         5. just build && just restart"
  fi
  mkdir -p "$MAC_HERMES"
fi

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
  # Ensure the bind mount is on this existing VM. orb config add is
  # idempotent (no-op if entry already present); a configured-but-not-yet-
  # applied mount is the same fail-fast pattern as the isolation flags.
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    orb config add "machine.$VM.mounts" "$ORB_MOUNT_SPEC" 2>/dev/null || true
    is_mounted="$(orb -m "$VM" mount 2>/dev/null | grep -c " on $VM_HERMES type" || true)"
    if [ "$is_mounted" = "0" ]; then
      die "mount '$ORB_MOUNT_SPEC' configured but not yet applied — run 'just restart' to cycle the VM"
    fi
  fi
else
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    orb create --user "$REMOTE_USER" --isolated --isolate-network \
               --mount "$ORB_MOUNT_SPEC" ubuntu "$VM"
  else
    orb create --user "$REMOTE_USER" --isolated --isolate-network ubuntu "$VM"
  fi
fi

log "2. apt xz-utils (REQUIRED — Hermes installer extracts Node .tar.xz)"
m 'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xz-utils curl ca-certificates'

log "2b. VM hardening — remove unwanted snaps. OrbStack's ubuntu base ships
   cups (the printing service) which binds 0.0.0.0:631 and serves a web
   admin UI. We don't print from an isolated agent VM, and even with
   --isolate-network blocking the Mac, exposing :631 on the orb docker
   network is needless surface. \`snap remove cups\` cleans both cupsd +
   cups-browsed in one shot. Idempotent (grep guard: skip if already gone)."
m 'snap list cups >/dev/null 2>&1 && { echo "removing cups snap"; sudo snap remove cups; } || echo "cups snap not installed — skipping"'

log "3. install Hermes + seed ~/.hermes/.env"
# Install to /opt/hermes-agent (NOT ~/.hermes/hermes-agent) so the 1.4 GB
# venv + source + node_modules stay VM-native and don't traverse the mount.
# The installer's HERMES_INSTALL_DIR env var is the official override; it
# also creates a tiny wrapper at ~/.local/bin/hermes that exec's
# $INSTALL_DIR/venv/bin/hermes, so /usr/local/bin/hermes → ~/.local/bin/hermes
# (installed below) still resolves cleanly for `sudo hermes …`.
m 'command -v hermes >/dev/null 2>&1 \
   || curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
      | HERMES_INSTALL_DIR=/opt/hermes-agent bash'
# Symlink hermes into /usr/local/bin so `sudo hermes ...` works without the
# absolute /home/$USER/.local/bin/hermes path. /usr/local/bin is in root's
# secure_path; the installer keeps the user-local binary path stable.
# Idempotent (ln -sf overwrites). Templated REMOTE_USER, like systemd units.
m "sudo ln -sf /home/$REMOTE_USER/.local/bin/hermes /usr/local/bin/hermes"
# Map stack-side HERMES_TELEGRAM_* → upstream's un-prefixed TELEGRAM_* names
# inside the VM (~/.hermes/.env is consumed by hermes-agent, which reads
# the upstream names). The .env is written via a marker-delimited managed
# block: HERMES_ENV_MANAGED accumulates here and in the conditional blocks
# below (agentmemory / firecrawl / camofox / searxng), then
# hermes_env_rewrite_managed_block writes it once before step 5. User
# lines outside the markers (plugin env etc.) are preserved on every
# build — see the helper's docstring above.
HERMES_ENV_MANAGED="OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
TELEGRAM_BOT_TOKEN=${HERMES_TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${HERMES_TELEGRAM_ALLOWED_USERS:-}
TELEGRAM_HOME_CHANNEL=${HERMES_TELEGRAM_HOME_CHANNEL:-}"

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
      | hermes_write honcho.json
    m 'hermes config set memory.provider honcho'
    log "memory: honcho -> honcho-api.$PROJ.orb.local:8000"
    ;;
  hindsight)
    sed "s/__STACK_PROJECT__/$PROJ/g" "$D/config/hindsight.config.json.tmpl" \
      | hermes_write hindsight/config.json
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
    # reach it at the orb DNS (NOT localhost:3111) — append URL + secret to
    # the managed .env block. npx/node must be on the VM PATH.
    HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
AGENTMEMORY_URL=http://agentmemory.$PROJ.orb.local:3111
AGENTMEMORY_SECRET=${AGENTMEMORY_SECRET:-}"
    m 'hermes config set memory.provider agentmemory'
    if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
      # Mount-side: run python locally on Mac against the shared config.yaml.
      python3 - "$MAC_HERMES/config.yaml" <<'PY'
import sys,os
try:
    import yaml
except Exception:
    raise SystemExit("pyyaml unavailable; pip install pyyaml on the Mac, or set HERMES_MOUNT_ENABLED=false to fall back to in-VM editing")
p=sys.argv[1]
d=(yaml.safe_load(open(p)) if os.path.exists(p) else {}) or {}
ms=d.get("mcp_servers") or {}
ms["agentmemory"]={"command":"npx","args":["-y","@agentmemory/mcp"]}
d["mcp_servers"]=ms
mem=d.get("memory") or {}; mem["provider"]="agentmemory"; d["memory"]=mem
yaml.safe_dump(d,open(p,"w"),sort_keys=False,default_flow_style=False)
print("config.yaml: mcp_servers.agentmemory + memory.provider merged (Mac-side)")
PY
    else
      orb -m "$VM" bash -lc '
        set -e; cfg=~/.hermes/config.yaml
        py=/opt/hermes-agent/venv/bin/python; [ -x "$py" ] || py=python3
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
print("config.yaml: mcp_servers.agentmemory + memory.provider merged (in-VM)")
PY'
    fi
    log "memory: agentmemory (MCP shim -> agentmemory.$PROJ.orb.local:3111). Deeper 6-hook provider is manual: copy integrations/hermes -> ~/.hermes/plugins/agentmemory."
    ;;
  *)
    die "unknown HERMES_MEMORY='$MEM' (use: default|honcho|hindsight|agentmemory|holographic)"
    ;;
esac

# Firecrawl (profile [firecrawl]): the self-hosted firecrawl-api ignores
# client auth (USE_DB_AUTHENTICATION=false), but the firecrawl SDK requires a
# non-empty FIRECRAWL_API_KEY — so a fixed, clearly-labelled no-auth
# placeholder (NOT a secret). Append to the managed .env block when the
# firecrawl profile is active; when it's not active, the keys are
# automatically OMITTED from the rewritten managed block (the block always
# reflects current stack state, never accumulates stale keys).
if echo "${COMPOSE_PROFILES:-}" | grep -qw firecrawl; then
  HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
FIRECRAWL_API_URL=http://firecrawl-api.$PROJ.orb.local:3002
FIRECRAWL_API_KEY=fc-selfhost-noauth"
  log "firecrawl: FIRECRAWL_API_URL=http://firecrawl-api.$PROJ.orb.local:3002 + placeholder key -> managed .env block"
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
  HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
CAMOFOX_URL=http://camofox-browser.$PROJ.orb.local:9377"
  log "camofox: CAMOFOX_URL=http://camofox-browser.$PROJ.orb.local:9377 -> managed .env block"
else
  warn "camofox-browser not in COMPOSE_PROFILES — skipping Hermes camofox env"
fi

# SearXNG (profile [searxng]): privacy-respecting metasearch for Hermes'
# web_search capability (Hermes docs:
# https://hermes-agent.nousresearch.com/docs/user-guide/features/web-search).
# Append SEARXNG_URL to the managed .env block AND flip web.search_backend
# to searxng. If both [firecrawl] and [searxng] are active, searxng wins
# (this block runs after firecrawl above + sets search_backend explicitly).
# Override by manually setting web.search_backend in ~/.hermes/config.yaml
# after build.
if echo "${COMPOSE_PROFILES:-}" | grep -qw searxng; then
  HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
SEARXNG_URL=http://searxng.$PROJ.orb.local:8080"
  m 'hermes config set web.search_backend searxng'
  log "searxng: SEARXNG_URL=http://searxng.$PROJ.orb.local:8080 -> managed .env block (web.search_backend=searxng)"
else
  warn "searxng not in COMPOSE_PROFILES — skipping Hermes searxng env"
fi

# MissionControl (lever: HERMES_MC_URL in .stack/.env). Bidirectional
# sync between this Hermes VM and a MissionControl deployment. When
# enabled, this script also syncs services/hermes/plugins/mission-control/
# into the VM and registers it in plugins.enabled.
if [ -n "${HERMES_MC_URL:-}" ]; then
  HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
HERMES_MC_URL=$HERMES_MC_URL
HERMES_MC_AGENT_NAME=${HERMES_MC_AGENT_NAME:-$VM}
HERMES_MC_BOARD=${HERMES_MC_BOARD:-mc}
HERMES_MC_POLL_INTERVAL=${HERMES_MC_POLL_INTERVAL:-10}
HERMES_MC_DEFAULT_PROJECT_SLUG=${HERMES_MC_DEFAULT_PROJECT_SLUG:-}
HERMES_MC_DEBUG=${HERMES_MC_DEBUG:-false}"

  # PAT is only included in the managed block while still set in .stack/.env.
  # The operator clears it after first-run registration; subsequent builds
  # drop the line from the managed block automatically.
  if [ -n "${HERMES_MC_USER_PAT:-}" ]; then
    HERMES_ENV_MANAGED="$HERMES_ENV_MANAGED
HERMES_MC_USER_PAT=$HERMES_MC_USER_PAT"
  fi

  hermes_sync_plugin "mission-control"
  hermes_enable_plugin "mission-control"
  log "mission-control: HERMES_MC_URL=$HERMES_MC_URL -> managed .env block + plugin enabled"
else
  warn "mission-control: HERMES_MC_URL unset in .stack/.env — plugin not enabled"
fi

# Materialize the accumulated managed block now that every conditional
# section has had its chance to add lines. User lines outside the markers
# are preserved (see hermes_env_rewrite_managed_block docstring).
hermes_env_rewrite_managed_block "$HERMES_ENV_MANAGED"
log "~/.hermes/.env managed block rewritten ($(printf '%s\n' "$HERMES_ENV_MANAGED" | wc -l | tr -d ' ') keys; user lines outside markers preserved)"

log "5. patch config.yaml model: block (litellm.$PROJ.orb.local; key via stdin, never argv)"
HM="${HERMES_MODEL:-cliproxy/gpt-5.5}"   # HERMES_MODEL lever from sourced .stack/.env
MODEL_BLOCK="$(sed -e "s|\${HERMES_VIRTUAL_KEY}|$HERMES_VIRTUAL_KEY|" -e "s/__STACK_PROJECT__/$PROJ/g" -e "s|__HERMES_MODEL__|$HM|g" "$D/config/config.yaml.model.tmpl" | grep -v '^#')"

if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
  # Mount-side: rewrite the Mac config.yaml directly with local python3.
  # hermes config init not needed — we know we have config.yaml from the
  # installer's first-run (or from snapshot during migration).
  cfg="$MAC_HERMES/config.yaml"
  [ -f "$cfg" ] || touch "$cfg"
  cp "$cfg" "$cfg.bak.prebuild" 2>/dev/null || true
  printf '%s\n' "$MODEL_BLOCK" | python3 - "$cfg" <<'PY'
import sys,os
p=sys.argv[1]; nb=sys.stdin.read()
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
open(p,"w").write("\n".join(out)+"\n"); print("model: block patched (Mac-side)")
PY
else
  warn "skip config.yaml model: block patch (HERMES_MOUNT_ENABLED=false)"
  printf '       apply manually: orb -m %s bash -lc %q\n' "$VM" \
    "hermes config edit  # then paste model: block from $D/config/config.yaml.model.tmpl" >&2
fi

log "6. install units + logtail (NO native honcho/pg). Templates use
   __REMOTE_USER__ which gets sed-substituted to '$REMOTE_USER' here so
   /home/<user>/... paths inside the VM match the actual unix account.
   HERMES_LOGTAIL_DASHBOARD adds (or omits) a 'journalctl -fu
   hermes-dashboard' line via the __LOGTAIL_DASHBOARD_LINE__ placeholder."
HERMES_LOGTAIL_DASHBOARD_VAL="${HERMES_LOGTAIL_DASHBOARD:-false}"
if [ "$HERMES_LOGTAIL_DASHBOARD_VAL" = "true" ]; then
  # No file log for the dashboard (its unit emits to journald) — tail the
  # unit's journal instead. -n0 starts at the live tail; -o cat strips the
  # systemd prefix so the sed re-prefix isn't doubled.
  LOGTAIL_DASHBOARD_LINE='journalctl -fu hermes-dashboard -n0 -o cat 2>/dev/null | sed -u "s/^/[hermes-dashboard] /" > /dev/console &'
  log "logtail: dashboard journal -> /dev/console (HERMES_LOGTAIL_DASHBOARD=true)"
else
  LOGTAIL_DASHBOARD_LINE='# hermes-dashboard journal tail disabled (HERMES_LOGTAIL_DASHBOARD=false)'
fi
# `&` is a sed replacement-string metachar (= the matched text) — escape it
# so the shell `&` background operator survives into the rendered script.
# `~` is the sed delimiter (the enabled line is pipe-heavy; `#` would clash
# with the disabled-branch's leading comment marker).
LOGTAIL_DASHBOARD_LINE_ESC="$(printf '%s' "$LOGTAIL_DASHBOARD_LINE" | sed 's~&~\\&~g')"
sed -e "s|__REMOTE_USER__|$REMOTE_USER|g" \
    -e "s~__LOGTAIL_DASHBOARD_LINE__~$LOGTAIL_DASHBOARD_LINE_ESC~" \
    "$D/bin/hermes-logtail.sh" \
  | orb -m "$VM" bash -lc 'sudo tee /usr/local/bin/hermes-logtail.sh >/dev/null && sudo chmod +x /usr/local/bin/hermes-logtail.sh'
for unit in hermes-dashboard hermes-gateway hermes-logtail; do
  sed "s|__REMOTE_USER__|$REMOTE_USER|g" "$D/systemd/$unit.service" \
    | orb -m "$VM" bash -lc "sudo tee /etc/systemd/system/$unit.service >/dev/null"
done

log "7. apply HERMES_GATEWAY_ALLOW_ACCESS gate via a systemd DROP-IN. The
   gate binds the gateway to 0.0.0.0:8642 on the orb docker network so
   docker-side consumers (e.g. hermes-workspace) can reach it. Default
   closed (loopback-only inside VM). See services/hermes/service.env for
   the security trade-off.

   WHY DROP-IN, not main-unit edit: 'hermes gateway restart --system'
   rewrites the main unit file from hermes-cli's own template on every
   restart (verified empirically — it logs '↻ Updated gateway system
   service definition'). Drop-ins at /etc/systemd/system/<unit>.d/ are
   the canonical systemd way to layer extra config on top of a CLI-managed
   unit, and they survive that rewrite."
ALLOW="${HERMES_GATEWAY_ALLOW_ACCESS:-false}"
GEN_HERMES="$STACK_DIR/hermes/.generated.env"
DROP_IN_DIR="/etc/systemd/system/hermes-gateway.service.d"
DROP_IN="$DROP_IN_DIR/stack-api-server.conf"
mkdir -p "$STACK_DIR/hermes"
if [ "$ALLOW" = "true" ]; then
  [ -n "${HERMES_GATEWAY_API_KEY:-}" ] \
    || die "HERMES_GATEWAY_ALLOW_ACCESS=true but HERMES_GATEWAY_API_KEY is empty.
       Run 'just setup' to mint it (it only mints when the gate is open)."
  m "sudo mkdir -p $DROP_IN_DIR"
  printf '[Service]\nEnvironment="API_SERVER_ENABLED=true"\nEnvironment="API_SERVER_HOST=0.0.0.0"\nEnvironment="API_SERVER_PORT=8642"\nEnvironment="API_SERVER_KEY=%s"\n' "$HERMES_GATEWAY_API_KEY" \
    | orb -m "$VM" bash -lc "sudo tee $DROP_IN >/dev/null && sudo chmod 600 $DROP_IN"
  env_upsert "$GEN_HERMES" HERMES_GATEWAY_URL   "http://$VM.orb.local:8642"
  # Dashboard URL — also published when the gate is open. The dashboard
  # serves the "extended APIs" the workspace's Skills/Memory/Cron/etc.
  # panels query. Its unit already binds 0.0.0.0:9119 unconditionally
  # (see systemd/hermes-dashboard.service), so no extra drop-in needed;
  # we just need to surface the URL so consumers can reach it.
  env_upsert "$GEN_HERMES" HERMES_DASHBOARD_URL "http://$VM.orb.local:9119"
  log "gateway: gate OPEN — drop-in installed; HERMES_GATEWAY_URL=http://$VM.orb.local:8642; HERMES_DASHBOARD_URL=http://$VM.orb.local:9119"
else
  # Remove any prior drop-in so the gateway falls back to default (loopback).
  m "sudo rm -f $DROP_IN"
  removed_any=0
  if [ -f "$GEN_HERMES" ]; then
    if grep -q '^HERMES_GATEWAY_URL='   "$GEN_HERMES"; then
      sed -i.bak '/^HERMES_GATEWAY_URL=/d'   "$GEN_HERMES" && rm -f "$GEN_HERMES.bak"
      removed_any=1
    fi
    if grep -q '^HERMES_DASHBOARD_URL=' "$GEN_HERMES"; then
      sed -i.bak '/^HERMES_DASHBOARD_URL=/d' "$GEN_HERMES" && rm -f "$GEN_HERMES.bak"
      removed_any=1
    fi
  fi
  if [ "$removed_any" = "1" ]; then
    log "gateway: gate CLOSED — removed drop-in + stale HERMES_{GATEWAY,DASHBOARD}_URL"
  else
    log "gateway: gate CLOSED — loopback-only (default; no drop-in)"
  fi
fi
log "services/hermes/build.sh DONE for '$VM' (start.sh enables units + applies drop-in via daemon-reload)"
