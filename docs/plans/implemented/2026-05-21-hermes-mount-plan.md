# Hermes mount: codify the live OrbStack `~/.hermes` bind-mount into the stack

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codify the OrbStack selective-mount of `~/.hermes/` (Mac → VM) into `services/hermes/build.sh`, gated by `HERMES_MOUNT_ENABLED` + `HERMES_MOUNT_DIR` levers. Includes relocating hermes-agent to `/opt/hermes-agent` via `HERMES_INSTALL_DIR`, fixing the now-stale `__REMOTE_USER__/.hermes/hermes-agent` paths in the systemd unit + build.sh, and formalizing the workspace container's bind.

**Architecture:** Bind-mount `<repo-root>/.stack/hermes/.hermes/` → `/home/$REMOTE_USER/.hermes/` via `orb config add machine.<vm>.mounts SOURCE:DEST` (or `orb create --mount` on fresh VMs). Hermes-agent venv + source live at `/opt/hermes-agent/` (VM-native, outside the share). All `~/.hermes/*` writes in build.sh go through new `hermes_write`/`hermes_append` helpers that dispatch local-vs-orb-exec on `HERMES_MOUNT_ENABLED`. When mount is disabled, build.sh skips those writes and prints the equivalent `orb -m` command for manual application — "config changes through `just build` are supported only when mount is enabled" per the spec.

**Tech Stack:** bash (justfile recipes), OrbStack VM mounts (`orb config` list semantics), virtio-fs (uid-remapping in containers), systemd (drain-aware unit reload via `hermes gateway restart --system`).

**Spec:** `docs/specs/2026-05-21-hermes-mount.md`. Live system is ALREADY in the target state (mount manually applied, hermes reinstalled to `/opt/hermes-agent`, workspace bind already swapped). This plan codifies that into source so subsequent `just build` / fresh-install paths reproduce the working layout.

**Self-review check before commit (Task 8):** every step that would write `~/.hermes/*` in build.sh goes through `hermes_write`/`hermes_append`; no orb-exec heredoc writing to `~/.hermes/*` remains.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `services/hermes/service.env` | Per-service env declaration | **Modify** — append two keys to `SERVICE_STACK_ENV` |
| `services/hermes/systemd/hermes-gateway.service` | systemd unit template (initial install only — `hermes gateway restart --system` rewrites it from hermes-cli's own template thereafter) | **Modify** — swap `__REMOTE_USER__/.hermes/hermes-agent` → `/opt/hermes-agent` in 4 lines |
| `services/hermes/build.sh` | VM provisioning | **Modify** — add helpers, new step 0 (mount setup), `HERMES_INSTALL_DIR` in step 3, replace 6 orb-exec writes with helpers, kill the stale agentmemory `~/.hermes/hermes-agent/venv/bin/python` fallback line |
| `services/hermes-workspace/compose.yaml` | Workspace docker service | **Modify** — formalize the manually-applied bind from `../../.stack/hermes/.hermes` → `/home/workspace/.hermes` (replaces deleted `hermes-workspace-config` named volume) |
| `services/hermes/README.md` | Hermes service docs | **Modify** — document the two new levers + bootstrap behavior |
| `docs/specs/2026-05-21-hermes-mount.md` | Spec | **Move** to `docs/plans/implemented/` per `docs-plans-specs-layout` memory convention |
| `docs/plans/2026-05-21-hermes-mount.md` | This plan | **Move** to `docs/plans/implemented/` with the spec after merge |

**Explicitly NOT modified:**
- `services/hermes/start.sh` — drain-aware restart already in place (commit `5768910`); mount status is read by `dc()`/build.sh, not start.sh.
- `services/hermes/systemd/hermes-dashboard.service` — already executes via `~/.local/bin/hermes` wrapper (which the installer rewrites to point at `/opt/hermes-agent/venv/bin/hermes`); no path baked in.
- `services/hermes/systemd/hermes-logtail.service` — executes `/usr/local/bin/hermes-logtail.sh`, no `.hermes/hermes-agent` ref.
- `lib/stacklib.sh` / `lib/setup.sh` — no mount-related logic needed there.

---

### Task 1: Add `HERMES_MOUNT_ENABLED` + `HERMES_MOUNT_DIR` levers to `service.env`

**Files:**
- Modify: `services/hermes/service.env` — append inside the `SERVICE_STACK_ENV='...'` single-quoted block, BEFORE the closing `'`

- [ ] **Step 1: Read current end of SERVICE_STACK_ENV block**

```bash
grep -n "HERMES_GATEWAY_API_KEY=" services/hermes/service.env
# expected last keyed line in the block before the closing '
```

- [ ] **Step 2: Append the two new keys**

Find the line `HERMES_GATEWAY_API_KEY=` in `services/hermes/service.env` and add immediately AFTER it (still inside the single-quoted SERVICE_STACK_ENV):

```
# Bind-mount Hermes home (~/.hermes) from this Mac path into the VM, so
# `just build`'"'"'s config edits happen locally + `_bak/` tar of .stack/
# captures the full Hermes state. heavy native bits (venv at
# /opt/hermes-agent; Linux node binary in ~/.hermes/node) bypass the share
# or are relocated via HERMES_INSTALL_DIR. Default on; flip false to
# disable mount management AND skip build-time edits to ~/.hermes/ (each
# skipped step prints the manual orb command).
HERMES_MOUNT_ENABLED=true
# Mac-side source for the mount. Relative paths resolved against the
# repo root. Must exist + contain a populated config.yaml before each
# build (first-build path: the hermes installer populates this dir).
HERMES_MOUNT_DIR=.stack/hermes/.hermes
```

(Apostrophe-in-comment requires bash escape `'"'"'`.)

- [ ] **Step 3: Verify file sources cleanly**

```bash
bash -c 'set -e; SERVICE_STACK_ENV=""; . services/hermes/service.env; \
  echo "$SERVICE_STACK_ENV" | grep -E "^HERMES_MOUNT_ENABLED=true$"'
```
Expected: prints `HERMES_MOUNT_ENABLED=true` (sources without parse errors).

- [ ] **Step 4: Re-run block sync into live `.stack/.env`** *(idempotent; just enable already runs sync)*

```bash
bash -c '. lib/stacklib.sh; lib_enable_service hermes' 2>&1 | tail -5
grep -A99 '^#>--- hermes ---' .stack/.env | grep -E "HERMES_MOUNT_(ENABLED|DIR)"
```
Expected: both keys present in the hermes block of `.stack/.env`.

---

### Task 2: Update `hermes-gateway.service` template to `/opt/hermes-agent`

**Files:**
- Modify: `services/hermes/systemd/hermes-gateway.service` lines 11, 12, 16, 17

(`hermes gateway restart --system` rewrites the unit from hermes-cli's template post-install, so this only matters until the first restart — but matching reality keeps the template honest and avoids the gateway briefly running on the wrong path on first-install.)

- [ ] **Step 1: Read current state**

```bash
grep -nE "(ExecStart|WorkingDirectory|Environment=\"(PATH|VIRTUAL_ENV)=)" \
  services/hermes/systemd/hermes-gateway.service
```

- [ ] **Step 2: Replace the four lines**

Apply these exact edits to `services/hermes/systemd/hermes-gateway.service`:

```diff
-ExecStart=/home/__REMOTE_USER__/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace
+ExecStart=/opt/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace

-WorkingDirectory=/home/__REMOTE_USER__/.hermes/hermes-agent
+WorkingDirectory=/opt/hermes-agent

-Environment="PATH=/home/__REMOTE_USER__/.hermes/hermes-agent/venv/bin:/home/__REMOTE_USER__/.hermes/hermes-agent/node_modules/.bin:/home/__REMOTE_USER__/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
+Environment="PATH=/opt/hermes-agent/venv/bin:/opt/hermes-agent/node_modules/.bin:/home/__REMOTE_USER__/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

-Environment="VIRTUAL_ENV=/home/__REMOTE_USER__/.hermes/hermes-agent/venv"
+Environment="VIRTUAL_ENV=/opt/hermes-agent/venv"
```

Leave `Environment="HERMES_HOME=/home/__REMOTE_USER__/.hermes"` UNCHANGED — that's the data dir, still under the user home (mounted).

- [ ] **Step 3: Verify no stale paths remain**

```bash
grep -nF "/.hermes/hermes-agent" services/hermes/systemd/hermes-gateway.service
```
Expected: empty (no matches).

- [ ] **Step 4: Verify the awk-template substitution still produces valid systemd**

(Simulates what build.sh's per-unit loop does — sed `__REMOTE_USER__` → `joe` and confirm the rendered unit parses.)

```bash
sed 's|__REMOTE_USER__|joe|g' services/hermes/systemd/hermes-gateway.service \
  | grep -E "^(ExecStart|WorkingDirectory|Environment)=" | head -10
```
Expected: ExecStart shows `/opt/hermes-agent/venv/bin/python`, PATH shows `/opt/hermes-agent/venv/bin:...`, HERMES_HOME still `/home/joe/.hermes`.

---

### Task 3: Add `hermes_write` / `hermes_append` helpers + mount-setup step 0 to `build.sh`

**Files:**
- Modify: `services/hermes/build.sh` — insert helpers AFTER the `m()` definition (currently line ~38), insert step 0 (mount setup) BEFORE step 1 (orb create)

- [ ] **Step 1: Insert helpers + mount-vars resolution right after the `m()` helper**

Find the line `m() { orb -m "$VM" bash -lc "$1"; }` in `services/hermes/build.sh` and add immediately AFTER it:

```sh

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
```

- [ ] **Step 2: Insert mount-setup step 0 immediately BEFORE the `log "1. orb create …"` line**

Find `log "1. orb create ubuntu $VM` in `services/hermes/build.sh` and add immediately BEFORE it:

```sh
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
```

- [ ] **Step 3: Verify bash syntax + sourcing**

```bash
bash -n services/hermes/build.sh && echo "syntax ok"
```
Expected: prints `syntax ok` (no parse errors).

---

### Task 4: Wire mount into `orb create` / `orb config add` in step 1

**Files:**
- Modify: `services/hermes/build.sh` step 1 (the if/else around line ~48 — `if orb list … grep -qx "$VM"; then … else orb create …`)

- [ ] **Step 1: Add mount-on-existing-VM branch inside the `if … reuse` block**

Find this block in `services/hermes/build.sh`:

```sh
if orb list 2>/dev/null | awk '{print $1}' | grep -qx "$VM"; then
  log "machine $VM exists — reusing (REMOTE_USER=$REMOTE_USER must match the unix user inside the VM)"
  …
  set +e
  orb_set_machine_isolation "$VM"
  rc=$?
  set -e
  case "$rc" in
    …
  esac
else
  orb create --user "$REMOTE_USER" --isolated --isolate-network ubuntu "$VM"
fi
```

Add this AFTER the closing `esac` of the existing `case "$rc" in …` block and BEFORE the matching `else` (i.e., inside the `then`-branch, as the last lines before the `else`):

```sh
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
```

- [ ] **Step 2: Update the fresh-create branch to pass `--mount` when enabled**

Replace the `else` branch (`orb create --user "$REMOTE_USER" --isolated --isolate-network ubuntu "$VM"`) with:

```sh
else
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    orb create --user "$REMOTE_USER" --isolated --isolate-network \
               --mount "$ORB_MOUNT_SPEC" ubuntu "$VM"
  else
    orb create --user "$REMOTE_USER" --isolated --isolate-network ubuntu "$VM"
  fi
fi
```

- [ ] **Step 3: Syntax check**

```bash
bash -n services/hermes/build.sh && echo "syntax ok"
```
Expected: `syntax ok`.

- [ ] **Step 4: Idempotency probe against the live VM**

(VM is currently running with the mount applied; this is the steady-state path.)

```bash
bash -c '. lib/stacklib.sh; require_stack_env; set -a; . .stack/.env; set +a;
  HERMES_MOUNT_ENABLED="${HERMES_MOUNT_ENABLED:-true}"
  HERMES_MOUNT_DIR="${HERMES_MOUNT_DIR:-.stack/hermes/.hermes}"
  case "$HERMES_MOUNT_DIR" in /*) MAC_HERMES="$HERMES_MOUNT_DIR" ;; *) MAC_HERMES="$STACK_ROOT/$HERMES_MOUNT_DIR" ;; esac
  VM_HERMES="/home/${HERMES_REMOTE_USER:-hermes}/.hermes"
  ORB_MOUNT_SPEC="$MAC_HERMES:$VM_HERMES"
  echo "spec: $ORB_MOUNT_SPEC"
  echo "registered: $(orb config get machine.aitools-hermes.mounts)"
  echo "is_mounted: $(orb -m aitools-hermes mount 2>/dev/null | grep -c " on $VM_HERMES type")"
'
```
Expected: `registered` line matches `spec`; `is_mounted` = 1.

---

### Task 5: Swap step 3 install to `HERMES_INSTALL_DIR=/opt/hermes-agent` + use `hermes_write` for `.env` seed

**Files:**
- Modify: `services/hermes/build.sh` step 3 (currently the `curl … install.sh | bash` line + the `ENV_PAYLOAD` heredoc that's piped into `orb -m … 'cat > ~/.hermes/.env …'`)

- [ ] **Step 1: Update the installer invocation to set `HERMES_INSTALL_DIR`**

Find this line in `services/hermes/build.sh` (step 3 — likely line 73-ish):

```sh
m 'command -v hermes >/dev/null 2>&1 || curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'
```

Replace with:

```sh
# Install to /opt/hermes-agent (NOT ~/.hermes/hermes-agent) so the 1.4 GB
# venv + source + node_modules stay VM-native and don't traverse the mount.
# The installer's HERMES_INSTALL_DIR env var is the official override; it
# also creates a tiny wrapper at ~/.local/bin/hermes that exec's
# $INSTALL_DIR/venv/bin/hermes, so /usr/local/bin/hermes → ~/.local/bin/hermes
# (installed below) still resolves cleanly for `sudo hermes …`.
m 'command -v hermes >/dev/null 2>&1 \
   || curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
      | HERMES_INSTALL_DIR=/opt/hermes-agent bash'
```

- [ ] **Step 2: Replace the ENV_PAYLOAD orb-exec write with `hermes_write`**

Find this block in step 3:

```sh
ENV_PAYLOAD="$(cat <<EOF
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
TELEGRAM_BOT_TOKEN=${HERMES_TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${HERMES_TELEGRAM_ALLOWED_USERS:-}
TELEGRAM_HOME_CHANNEL=${HERMES_TELEGRAM_HOME_CHANNEL:-}
EOF
)"
printf '%s' "$ENV_PAYLOAD" | orb -m "$VM" bash -lc \
  'mkdir -p ~/.hermes && umask 077 && cat > ~/.hermes/.env && chmod 600 ~/.hermes/.env && echo "~/.hermes/.env seeded"'
```

Replace with:

```sh
# Map stack-side HERMES_TELEGRAM_* → upstream's un-prefixed TELEGRAM_* names
# inside the VM (~/.hermes/.env is consumed by hermes-agent, which reads
# the upstream names). Mount-aware: hermes_write writes Mac-side under the
# mount when enabled, warn-skips when disabled.
ENV_PAYLOAD="$(cat <<EOF
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
TELEGRAM_BOT_TOKEN=${HERMES_TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${HERMES_TELEGRAM_ALLOWED_USERS:-}
TELEGRAM_HOME_CHANNEL=${HERMES_TELEGRAM_HOME_CHANNEL:-}
EOF
)"
printf '%s' "$ENV_PAYLOAD" | hermes_write .env
if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
  chmod 600 "$MAC_HERMES/.env"
  log "~/.hermes/.env seeded (Mac-side via mount)"
fi
```

- [ ] **Step 3: Syntax check**

```bash
bash -n services/hermes/build.sh && echo "syntax ok"
```
Expected: `syntax ok`.

---

### Task 6: Refactor step 4 memory-backend writes to use helpers (+ kill stale `~/.hermes/hermes-agent/venv/bin/python` fallback)

**Files:**
- Modify: `services/hermes/build.sh` step 4 (memory backend dispatch + per-service env appends — currently roughly lines 82-190, includes `honcho.json.tmpl`, `hindsight.config.json.tmpl`, agentmemory block with its python config-rewriter, and the firecrawl/camofox/searxng URL appends)

- [ ] **Step 1: Replace the `honcho` and `hindsight` config writes**

Find this block in the `case "$MEM" in` switch:

```sh
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
```

Replace with:

```sh
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
```

- [ ] **Step 2: Replace agentmemory's `~/.hermes/.env` append**

Find inside the `agentmemory)` case:

```sh
    printf 'AGENTMEMORY_URL=http://agentmemory.%s.orb.local:3111\nAGENTMEMORY_SECRET=%s\n' \
      "$PROJ" "${AGENTMEMORY_SECRET:-}" \
      | orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'
```

Replace with:

```sh
    printf 'AGENTMEMORY_URL=http://agentmemory.%s.orb.local:3111\nAGENTMEMORY_SECRET=%s\n' \
      "$PROJ" "${AGENTMEMORY_SECRET:-}" \
      | hermes_append .env
```

- [ ] **Step 3: Make agentmemory's `config.yaml` Python merge mount-aware (Mac-local when mounted)**

Find this block inside `agentmemory)`:

```sh
    orb -m "$VM" bash -lc '
      set -e; cfg=~/.hermes/config.yaml
      py=~/.hermes/hermes-agent/venv/bin/python; [ -x "$py" ] || py=python3
      "$py" - "$cfg" <<PY
import sys,os
…(unchanged Python body)…
yaml.safe_dump(d,open(p,"w"),sort_keys=False,default_flow_style=False)
print("config.yaml: mcp_servers.agentmemory + memory.provider merged")
PY'
```

Replace with:

```sh
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
```

Note: the in-VM fallback now uses `/opt/hermes-agent/venv/bin/python` (replacing the stale `~/.hermes/hermes-agent/venv/bin/python` from the original).

- [ ] **Step 4: Replace the three per-service URL appends (firecrawl, camofox, searxng)**

Find and replace each of these blocks:

```sh
# firecrawl
  printf 'FIRECRAWL_API_URL=http://firecrawl-api.%s.orb.local:3002\nFIRECRAWL_API_KEY=%s\n' \
    "$PROJ" "fc-selfhost-noauth" \
    | orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'
```
→ swap the trailing `| orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'` with `| hermes_append .env`.

Do the same for the `camofox` block:

```sh
  printf 'CAMOFOX_URL=http://camofox-browser.%s.orb.local:9377\n' "$PROJ" \
    | orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'
```
→ `| hermes_append .env`.

And searxng:

```sh
  printf 'SEARXNG_URL=http://searxng.%s.orb.local:8080\n' "$PROJ" \
    | orb -m "$VM" bash -lc 'umask 077; cat >> ~/.hermes/.env'
```
→ `| hermes_append .env`.

- [ ] **Step 5: Syntax check + grep audit**

```bash
bash -n services/hermes/build.sh && echo "syntax ok"
echo "--- remaining orb-exec writes to ~/.hermes/ (should be EMPTY): ---"
grep -n "orb -m.*~/.hermes" services/hermes/build.sh || echo "(none)"
echo "--- remaining stale .hermes/hermes-agent refs (should be EMPTY): ---"
grep -nF "/.hermes/hermes-agent" services/hermes/build.sh || echo "(none)"
```
Expected: syntax ok; both grep results are `(none)`.

---

### Task 7: Make step 5's model-block patch mount-aware

**Files:**
- Modify: `services/hermes/build.sh` step 5 (the Python-via-orb-exec that rewrites `~/.hermes/config.yaml`'s `model:` block)

- [ ] **Step 1: Replace the step-5 block**

Find this block in `services/hermes/build.sh` (step 5, currently roughly line 191-213):

```sh
log "5. patch ~/.hermes/config.yaml model: block (litellm.$PROJ.orb.local; key via stdin, never argv)"
HM="${HERMES_MODEL:-cliproxy/gpt-5.5}"
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
```

Replace with:

```sh
log "5. patch config.yaml model: block (litellm.$PROJ.orb.local; key via stdin, never argv)"
HM="${HERMES_MODEL:-cliproxy/gpt-5.5}"
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
```

- [ ] **Step 2: Syntax check + final grep**

```bash
bash -n services/hermes/build.sh && echo "syntax ok"
grep -n "orb -m.*~/.hermes\|/.hermes/hermes-agent" services/hermes/build.sh || echo "(clean)"
```
Expected: `syntax ok` then `(clean)`.

---

### Task 8: Formalize the hermes-workspace bind in compose.yaml

**Files:**
- Modify: `services/hermes-workspace/compose.yaml` (CHANGE IS ALREADY APPLIED LIVE — this task verifies + commits it; no functional change)

- [ ] **Step 1: Verify the manual change is still in place**

```bash
grep -A2 "^    volumes:" services/hermes-workspace/compose.yaml | head -10
```
Expected output includes:
```
      - ../../.stack/hermes/.hermes:/home/workspace/.hermes
```
(not the old `hermes-workspace-config:/home/workspace/.hermes` named-volume form)

- [ ] **Step 2: Verify the named volume declaration was removed**

```bash
awk '/^volumes:/,EOF' services/hermes-workspace/compose.yaml | head -5
```
Expected: shows `volumes:` with `hermes-workspace-files:` only (no `hermes-workspace-config:`).

(If both checks pass, the file is in the right state from our earlier live edit; nothing more to do here. The task exists for the plan's completeness so the implementer doesn't skip it.)

---

### Task 9: Update `services/hermes/README.md` with the new levers

**Files:**
- Modify: `services/hermes/README.md` (the levers section we updated in commit `5560001` — add the two new lever rows)

- [ ] **Step 1: Find the levers code block**

```bash
grep -n "HERMES_REMOTE_USER=hermes" services/hermes/README.md
```

- [ ] **Step 2: Add mount levers + explanation**

In the `## Levers (in the #>--- hermes --- block of .stack/.env)` section, find this code block:

```
```
HERMES_REMOTE_USER=hermes          # unix user inside the VM (orb create --user)
HERMES_MODEL=${STACK_LLM_MODEL}    # default: cliproxy/gpt-5.5
HERMES_MEMORY=honcho               # memory backend (one at a time)
HERMES_TELEGRAM_BOT_TOKEN=         # gateway Telegram integration (optional)
HERMES_TELEGRAM_ALLOWED_USERS=
HERMES_TELEGRAM_HOME_CHANNEL=
HERMES_GATEWAY_ALLOW_ACCESS=false  # bind gateway 0.0.0.0:8642 for docker consumers
HERMES_GATEWAY_API_KEY=             # minted by setup when ALLOW_ACCESS=true
```
```

Append these two lines BEFORE the closing ```` ``` ````:

```
HERMES_MOUNT_ENABLED=true          # bind-mount ~/.hermes/ from Mac path below
HERMES_MOUNT_DIR=.stack/hermes/.hermes  # Mac-side source for the mount
```

- [ ] **Step 3: Add an explanation paragraph after the existing prose**

Find the paragraph that ends with `(just setup auto-migrates the legacy un-prefixed REMOTE_USER / TELEGRAM_* keys on first run.)`. Add immediately AFTER it:

```markdown

`HERMES_MOUNT_ENABLED` + `HERMES_MOUNT_DIR` together drive a virtio-fs
bind-mount from `<repo-root>/.stack/hermes/.hermes/` (Mac) into
`/home/$HERMES_REMOTE_USER/.hermes/` (VM). When enabled (default):

- `build.sh` writes config edits Mac-side directly (no `orb -m` dance);
  the running gateway/dashboard see them immediately via the mount.
- A `tar` of `.stack/` captures the full Hermes state for backup.
- The hermes-workspace container can bind the same Mac path at
  `/home/workspace/.hermes/`, so its Settings UI edits the agent's
  actual `config.yaml` (no docker-volume divergence).

The heavy hermes-agent venv + source live at `/opt/hermes-agent/`
(VM-native, NOT on the share) via the installer's `HERMES_INSTALL_DIR`
env var — so the mount carries only user config + runtime state
(~250 MB), not the 1.4 GB Python venv.

When disabled, `build.sh` skips every step that would edit `~/.hermes/*`
and prints the equivalent `orb -m bash -lc` command for manual apply.
Other build steps (orb create, apt installs, systemd unit install, the
gateway-access drop-in) still run normally. Config changes through
`just build` are mount-enabled-only by design — keeps the dispatch
logic simple.
```

- [ ] **Step 4: Verify rendering**

```bash
grep -A2 "HERMES_MOUNT_ENABLED" services/hermes/README.md | head -10
```
Expected: shows the new lines without breaking surrounding markdown.

---

### Task 10: End-to-end smoke verify against the live stack

**Files:** none modified; this is a verification gate before commit.

- [ ] **Step 1: `just build` runs to completion with no errors**

```bash
just build 2>&1 | tail -30
```
Expected: ends with `build complete`; no FATAL lines; the new `0. resolve hermes mount config` step prints; existing mount detected as applied (idempotent, no fail-fast).

- [ ] **Step 2: `just start` drain-restarts cleanly**

```bash
just start 2>&1 | grep -E "PID|System service|services:|start complete" | head -8
```
Expected: drain-restart line (`PID X → PID Y`), `services: active active active`, `start complete`.

- [ ] **Step 3: Live gateway + dashboard + workspace probes**

```bash
key=$(grep ^HERMES_GATEWAY_API_KEY= .stack/.env | cut -d= -f2)
curl -sS -o /dev/null -w "gateway /health (auth): HTTP %{http_code}\n" -H "Authorization: Bearer $key" http://aitools-hermes.orb.local:8642/health
curl -sS -o /dev/null -w "dashboard /:           HTTP %{http_code}\n" http://aitools-hermes.orb.local:9119/
curl -sS -o /dev/null -w "workspace UI:          HTTP %{http_code}\n" https://hermes-workspace.aitools.orb.local/
```
Expected: all three `HTTP 200`.

- [ ] **Step 4: Mount sanity (three-way)**

```bash
echo "smoke-$(date +%s)" > .stack/hermes/.hermes/.smoke-test
echo "Mac:       $(cat .stack/hermes/.hermes/.smoke-test)"
echo "VM:        $(orb -m aitools-hermes cat /home/joe/.hermes/.smoke-test)"
echo "Workspace: $(docker exec aitools-hermes-workspace-1 cat /home/workspace/.hermes/.smoke-test)"
rm .stack/hermes/.hermes/.smoke-test
```
Expected: all three lines show the same `smoke-<epoch>` string.

- [ ] **Step 5: stacklib tests still green**

```bash
bash lib/stacklib.test.sh > /dev/null 2>&1 && echo "stacklib tests: PASS"
```
Expected: `stacklib tests: PASS`.

---

### Task 11: Commit + move spec to `docs/plans/implemented/`

**Files:**
- Move: `docs/specs/2026-05-21-hermes-mount.md` → `docs/plans/implemented/2026-05-21-hermes-mount-spec.md`
- Move: `docs/plans/2026-05-21-hermes-mount.md` → `docs/plans/implemented/2026-05-21-hermes-mount-plan.md`

- [ ] **Step 1: Move spec + plan into implemented/**

```bash
git mv docs/specs/2026-05-21-hermes-mount.md \
       docs/plans/implemented/2026-05-21-hermes-mount-spec.md
git mv docs/plans/2026-05-21-hermes-mount.md \
       docs/plans/implemented/2026-05-21-hermes-mount-plan.md
```

- [ ] **Step 2: Stage the implementation files**

```bash
git add services/hermes/service.env \
        services/hermes/systemd/hermes-gateway.service \
        services/hermes/build.sh \
        services/hermes/README.md \
        services/hermes-workspace/compose.yaml \
        docs/plans/implemented/
git status --short
```
Expected: the 5 modified files + the 2 spec/plan moves staged.

- [ ] **Step 3: Single focused commit**

```bash
git commit -m "feat(hermes): bind-mount ~/.hermes/ from Mac via OrbStack selective mount

Codifies the live setup: ~/.hermes/ on the VM is now a virtio-fs bind of
<repo-root>/.stack/hermes/.hermes/ on the Mac. Config edits via \`just
build\` happen Mac-side directly; the running gateway/dashboard see them
immediately. The hermes-workspace container binds the same Mac path so its
Settings UI edits the agent's actual config.yaml. A tar of .stack/ now
captures the full Hermes state.

Two new levers in the hermes block of .stack/.env:
  HERMES_MOUNT_ENABLED=true            (master toggle; default on)
  HERMES_MOUNT_DIR=.stack/hermes/.hermes (Mac-side source path)

Architecture:
- services/hermes/build.sh: new helpers \`hermes_write\` / \`hermes_append\`
  dispatch ~/.hermes/* writes to the Mac path when mount enabled, warn-skip
  with the manual orb-exec equivalent when disabled. Six call sites
  refactored (.env seed, honcho.json, hindsight config, agentmemory env +
  python config merge, firecrawl/camofox/searxng URL appends, model-block
  patch). New step 0 resolves mount vars + adds the refuse-to-shadow guard.
  Step 1's orb create passes --mount on fresh VMs; existing-VM path runs
  \`orb config add\` + fails-fast asking for \`just restart\` if not applied.
- HERMES_INSTALL_DIR=/opt/hermes-agent passed to the upstream installer
  so the 1.4 GB venv + source stay VM-native, off the share.
- services/hermes/systemd/hermes-gateway.service template updated to
  reference /opt/hermes-agent instead of __REMOTE_USER__/.hermes/hermes-agent
  (the on-disk unit gets rewritten by \`hermes gateway restart --system\`
  post-install anyway, but the template should match reality for first-boot
  consistency).
- services/hermes-workspace/compose.yaml swapped from named volume
  hermes-workspace-config (deleted) to a bind from ../../.stack/hermes/.hermes
  → /home/workspace/.hermes. OrbStack's virtio-fs auto-remaps uids so the
  workspace user (10010) sees the files owned correctly with no chown
  dance.

Mount-disabled path: build.sh runs the VM-provisioning steps (orb create,
apt installs, hermes install, systemd units, gateway drop-in) but skips
every ~/.hermes/* write with a clear warning containing the orb-exec
equivalent. Stated policy: config changes via \`just build\` are
mount-enabled-only by design.

Migration: documented in the moved spec; existing users snapshot
~/.hermes/ from the VM to .stack/hermes/.hermes/ once before running
\`just build\`. The refuse-to-shadow guard in step 0 enforces this for
any operator who tries to skip it.

Live-verified end-to-end before commit: three-way file share confirmed
(Mac/VM/workspace all see identical content), gateway responds 200 with
auth, dashboard 200, workspace UI 200, stacklib tests green.

Spec + plan moved into docs/plans/implemented/." 2>&1 | tail -3
```
Expected: prints `[main <hash>] feat(hermes): ...` and `X files changed`.

- [ ] **Step 4: Final state**

```bash
git log --oneline -3
git status
```
Expected: new commit at HEAD; working tree clean (or only the `TASKS.md` leftover from before that's not ours).

---

## Out of scope (intentionally deferred)

- **Workspace container HERMES_MOUNT_DIR interpolation.** The compose bind is currently a hardcoded relative path (`../../.stack/hermes/.hermes`). Future iteration: drive it via `${HERMES_MOUNT_DIR}` interpolation from `.stack/.env` (workspace would need the absolute path; we'd write it to `.stack/hermes/.generated.env` from build.sh). Not blocking; the default path matches the default `HERMES_MOUNT_DIR`.
- **chrome-cdp's `~/.hermes/.env` writes** (`justfile:217-263`) still use `orb -m bash -lc 'sed -i …'`. They work correctly through the mount (sed edits a file the VM sees as ~/.hermes/.env, which IS the Mac file). Migrating to the new helpers is a consistency-only change; defer.
- **`just backup-hermes` recipe.** Now feasible (single `tar` of `.stack/hermes/.hermes/` with the documented excludes). Separate small follow-up.
- **`HERMES_INSTALL_DIR` as a lever.** Currently hardcoded to `/opt/hermes-agent` in build.sh. Surface as a lever only if a user needs to override (YAGNI).
- **Mount path-drift detection.** If user moves the repo, the absolute Mac path embedded in `orb config get` becomes stale. Future: detect + offer to update. For now: documented limitation; fix is `orb config remove old; orb config add new; just restart`.
