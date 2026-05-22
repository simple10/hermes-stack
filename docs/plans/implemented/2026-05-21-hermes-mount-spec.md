# Bind-mount Hermes home (`~/.hermes`) into the VM from the Mac

Date: 2026-05-21
Status: approved, ready for implementation

## Goal

Make the Hermes VM's `~/.hermes/` directory live on the Mac side at a
stack-managed Mac path (default `.stack/hermes/.hermes/`) via an OrbStack
selective-mount. This gives the stack three things in one architectural move:

1. **`just build` can edit Hermes config locally** — no more `orb -m bash -lc`
   dances for `config.yaml`, `.env`, `honcho.json`, etc. Builds get simpler
   and faster.
2. **Single-tarball backups via `_bak/`** — `tar` of `.stack/` captures the
   full Hermes state (config, secrets, plugins, profiles, skills, sessions,
   DBs, logs). One source of truth, no per-file mount audit.
3. **Future-proofs the hermes-workspace deployment** — same Mac path can be
   bind-mounted into the workspace container later for full Settings-UI
   functionality (follow-up; not part of this spec).

The heavy native bits (`hermes-agent/` source + venv, ~1.4 GB) are relocated
out of `~/.hermes/` via the installer's `HERMES_INSTALL_DIR` env var, so the
share doesn't carry platform-specific Linux binaries or hundreds of thousands
of venv files.

## Levers (in the `#>--- hermes ---` block of `.stack/.env`)

| Lever | Default | Effect |
|---|---|---|
| `HERMES_MOUNT_ENABLED` | `true` | Master toggle. `true`: add/maintain the OrbStack mount AND run config edits Mac-side. `false`: skip mount management AND skip any build-time edit that would touch `~/.hermes/`, emitting a clear warning per skipped step. |
| `HERMES_MOUNT_DIR` | `.stack/hermes/.hermes` | Mac-side source path for the mount (relative paths resolved against `$STACK_ROOT`). Becomes the absolute SOURCE in `orb config add machine.<vm>.mounts <SOURCE>:<DEST>`. Must already exist + contain a populated `config.yaml` (or be initialized on first install — see Bootstrap). |

Hardcoded (not levers):

- `HERMES_INSTALL_DIR` is set to **`/opt/hermes-agent`** (VM-native) in
  `services/hermes/build.sh`, passed into the upstream installer. The
  installer's `--dir` flag and `HERMES_INSTALL_DIR` env var are official
  upstream contracts.

`HERMES_HOME` stays at `/home/$HERMES_REMOTE_USER/.hermes` (no need to
override — that's exactly the mount destination).

## Architecture

```
Mac (this repo)                        VM (aitools-hermes)
──────────────────────                 ──────────────────────────────────
.stack/hermes/.hermes/  ◄──virtio-fs──►  /home/$HERMES_REMOTE_USER/.hermes/
  config.yaml                            ├── config.yaml          (shared)
  .env                                   ├── .env                 (shared)
  honcho.json                            ├── honcho.json          (shared)
  auth.json, auth-profiles.json          ├── auth*.json           (shared)
  mcp-presets.json                       ├── mcp-presets.json     (shared)
  plugins/, skills/, profiles/           ├── plugins/, skills/, … (shared)
  hindsight/                             ├── hindsight/           (shared)
  node/                                  ├── node/                (shared, ~197 MB)
  state.db, kanban.db, response_store.db ├── *.db (+ WAL)         (shared, small)
  logs/                                  ├── logs/                (shared)
  sessions/, cache/, etc.                └── sessions/, etc.      (shared)

                                       /opt/hermes-agent/         (VM-native)
                                         ├── venv/                (~1.4 GB)
                                         ├── node_modules/
                                         └── (cloned source)

                                       /usr/local/bin/hermes      (VM-native)
                                         → symlink to
                                           /opt/hermes-agent/venv/bin/hermes
                                         (installer creates ~/.local/bin/hermes
                                          → $INSTALL_DIR/venv/bin/hermes; our
                                          existing /usr/local/bin/hermes
                                          symlink follows that chain)
```

**Why not the hermes-agent source on the share:** ~1.4 GB of platform-specific
Linux binaries (venv `.so` files, node_modules) is wasteful on virtio-fs and
pointless in backups (regenerable by `hermes install`).

**Why node/, DBs, logs ARE on the share:** virtio-fs perf cost is small;
SQLite locking is safe because only the VM has writers; logs being Mac-readable
via `tail -f .stack/hermes/.hermes/logs/…` is a real convenience. Backups can
`--exclude='node'` if size matters.

## Bootstrap states & behavior

`services/hermes/build.sh` handles four states based on `(MOUNT_ENABLED, mount_dir_state, vm_state)`:

### State 1: `MOUNT_ENABLED=true`, `$HERMES_MOUNT_DIR` empty or missing, no VM yet

**Action:** Fresh install path.

1. Create the Mac dir: `mkdir -p "$STACK_ROOT/$HERMES_MOUNT_DIR"`.
2. `orb create --user $HERMES_REMOTE_USER --isolated --isolate-network --mount "<abs-mac-path>:/home/$HERMES_REMOTE_USER/.hermes" ubuntu $VM` — mount applied at creation, no restart cycle.
3. Run hermes installer with `HERMES_INSTALL_DIR=/opt/hermes-agent` — the installer writes a brand-new `config.yaml`, `.env`, etc. directly into the shared dir (= populating the Mac side).
4. Continue with normal build steps (memory wiring, model patch, systemd units) — all `~/.hermes/*` edits happen Mac-side now.

### State 2: `MOUNT_ENABLED=true`, `$HERMES_MOUNT_DIR/config.yaml` exists, VM exists, mount already configured + applied

**Action:** Steady state — proceed normally with all Mac-side edits.

### State 3: `MOUNT_ENABLED=true`, `$HERMES_MOUNT_DIR/config.yaml` exists, VM exists, mount NOT configured (or configured but not yet applied)

**Action:** Add the mount config; fail-fast asking for a VM cycle, mirroring the existing `orb_set_machine_isolation` "flipped, run just restart" pattern.

```sh
orb config add "machine.$VM.mounts" "$ABS_MAC_DIR:$VM_DEST" 2>/dev/null || true
# Detect "configured but not currently mounted in the running VM":
if orb config get "machine.$VM.mounts" | grep -qxF "$ABS_MAC_DIR:$VM_DEST"; then
  is_mounted="$(orb -m "$VM" mount 2>/dev/null | grep -c " on $VM_DEST type" || true)"
  if [ "$is_mounted" = "0" ]; then
    die "mount '$ABS_MAC_DIR -> $VM_DEST' configured but not yet applied — run 'just restart' to cycle the VM"
  fi
fi
```

### State 4: `MOUNT_ENABLED=true`, `$HERMES_MOUNT_DIR` empty/missing but VM has live `~/.hermes/` data

**Action:** Refuse with migration instructions — do NOT add the mount (would shadow live VM data; recovery is manual but ugly).

```
die "HERMES_MOUNT_ENABLED=true but $HERMES_MOUNT_DIR is empty (or missing
     config.yaml) AND the VM has an existing ~/.hermes/. Refusing to add the
     mount — it would shadow live VM data.

     Migrate first:
       1. just stop      # stop the VM so the source files are quiescent
       2. mkdir -p $HERMES_MOUNT_DIR
       3. orb -m $VM bash -lc 'tar -C ~/.hermes -cf - .' \
          | tar -C $HERMES_MOUNT_DIR -xf -        # OR copy via ~/OrbStack/$VM/...
       4. rm -rf the VM-side ~/.hermes/hermes-agent (will be reinstalled at
          /opt/hermes-agent on next build) — saves 1.4 GB in the Mac copy
       5. just build && just restart"
```

(The user has stated they'll handle the migration manually for this VM; the
die message is for any other operator hitting this state.)

### State 5: `MOUNT_ENABLED=false`

**Action:** Don't touch orb config. Skip every step that would write to
`~/.hermes/` on the VM. Each skipped step prints a WARNING with the exact
`orb -m $VM bash -lc '…'` command the user can run manually.

Build still does the VM-native parts: `orb create`, apt installs, cups
removal, hermes installer (with `HERMES_INSTALL_DIR=/opt/hermes-agent`),
`/usr/local/bin/hermes` symlink, systemd unit install, gateway-gate drop-in.

**Stated policy:** "we support config changes through `just build` for hermes
only when mount is enabled." With mount disabled, build.sh becomes a
provision-VM-only script; config changes are the user's responsibility.

## `services/hermes/build.sh` — specific changes

### New helpers at the top

```sh
HERMES_MOUNT_ENABLED="$(env_get "$ENVF" HERMES_MOUNT_ENABLED)"
HERMES_MOUNT_ENABLED="${HERMES_MOUNT_ENABLED:-true}"
HERMES_MOUNT_DIR="$(env_get "$ENVF" HERMES_MOUNT_DIR)"
HERMES_MOUNT_DIR="${HERMES_MOUNT_DIR:-.stack/hermes/.hermes}"
# Resolve to absolute Mac path (orb wants absolute).
case "$HERMES_MOUNT_DIR" in
  /*) MAC_HERMES="$HERMES_MOUNT_DIR" ;;
  *)  MAC_HERMES="$STACK_ROOT/$HERMES_MOUNT_DIR" ;;
esac
VM_HERMES="/home/$REMOTE_USER/.hermes"

# Write a file into ~/.hermes — Mac-side when mount enabled, warn-and-skip
# when disabled. Reads stdin or takes content as $2.
hermes_write() {  # hermes_write RELPATH [CONTENT]
  local rel="$1" content="${2:-}"
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    mkdir -p "$(dirname "$MAC_HERMES/$rel")"
    if [ $# -ge 2 ]; then
      printf '%s' "$content" > "$MAC_HERMES/$rel"
    else
      cat > "$MAC_HERMES/$rel"
    fi
  else
    warn "skip ~/.hermes/$rel (HERMES_MOUNT_ENABLED=false). To apply manually:"
    printf '       orb -m %s bash -lc %q\n' "$VM" \
      "umask 077 && mkdir -p ~/.hermes/$(dirname "$rel") && cat > ~/.hermes/$rel" >&2
    if [ $# -ge 2 ]; then :; else cat >/dev/null; fi   # consume stdin
  fi
}

# Append to a ~/.hermes file (idempotent — caller's job to dedupe).
hermes_append() {  # hermes_append RELPATH
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    mkdir -p "$(dirname "$MAC_HERMES/$1")"
    cat >> "$MAC_HERMES/$1"
  else
    warn "skip append to ~/.hermes/$1 (HERMES_MOUNT_ENABLED=false). To apply manually:"
    printf '       orb -m %s bash -lc %q\n' "$VM" \
      "umask 077 && cat >> ~/.hermes/$1" >&2
    cat >/dev/null   # consume stdin
  fi
}
```

### New step: mount setup (before step 1's `orb create`)

```sh
log "0. resolve mount config (HERMES_MOUNT_ENABLED=$HERMES_MOUNT_ENABLED;
   HERMES_MOUNT_DIR=$HERMES_MOUNT_DIR -> $MAC_HERMES)"
ORB_MOUNT_SPEC="$MAC_HERMES:$VM_HERMES"

if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
  # Refuse-to-shadow guard (State 4).
  vm_has_hermes_data=0
  if orb list 2>/dev/null | awk '{print $1}' | grep -qx "$VM"; then
    orb -m "$VM" bash -lc 'test -s ~/.hermes/config.yaml' 2>/dev/null && vm_has_hermes_data=1
  fi
  mac_has_config=0
  [ -s "$MAC_HERMES/config.yaml" ] && mac_has_config=1
  if [ "$vm_has_hermes_data" = "1" ] && [ "$mac_has_config" = "0" ]; then
    die "<the State 4 migration message above>"
  fi

  mkdir -p "$MAC_HERMES"
fi
```

### Modified step 1: `orb create` includes `--mount` on FRESH create

```sh
if orb list 2>/dev/null | awk '{print $1}' | grep -qx "$VM"; then
  log "machine $VM exists — reusing"
  # ... existing isolation flag check ...

  # NEW: ensure the mount is on the existing VM (idempotent; fail-fast if not applied)
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    orb config add "machine.$VM.mounts" "$ORB_MOUNT_SPEC" 2>/dev/null || true
    is_mounted="$(orb -m "$VM" mount 2>/dev/null | grep -c " on $VM_HERMES type" || true)"
    if [ "$is_mounted" = "0" ]; then
      die "mount '$ORB_MOUNT_SPEC' configured but not yet applied — run 'just restart' to cycle the VM"
    fi
  fi
else
  # Fresh create — bake mount in at create time when enabled.
  if [ "$HERMES_MOUNT_ENABLED" = "true" ]; then
    orb create --user "$REMOTE_USER" --isolated --isolate-network \
               --mount "$ORB_MOUNT_SPEC" ubuntu "$VM"
  else
    orb create --user "$REMOTE_USER" --isolated --isolate-network ubuntu "$VM"
  fi
fi
```

### Modified step 3: hermes install with `HERMES_INSTALL_DIR`

```sh
log "3. install Hermes (HERMES_INSTALL_DIR=/opt/hermes-agent, VM-native)
       + seed ~/.hermes/.env"
m 'command -v hermes >/dev/null 2>&1 \
   || curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
      | HERMES_INSTALL_DIR=/opt/hermes-agent bash'
# /usr/local/bin/hermes symlink already follows ~/.local/bin/hermes →
# $INSTALL_DIR/venv/bin/hermes after install (existing line, unchanged).
m "sudo ln -sf /home/$REMOTE_USER/.local/bin/hermes /usr/local/bin/hermes"

# .env seed — Mac-side when mounted, else warn-skip.
ENV_PAYLOAD="$(cat <<EOF
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
TELEGRAM_BOT_TOKEN=${HERMES_TELEGRAM_BOT_TOKEN:-}
TELEGRAM_ALLOWED_USERS=${HERMES_TELEGRAM_ALLOWED_USERS:-}
TELEGRAM_HOME_CHANNEL=${HERMES_TELEGRAM_HOME_CHANNEL:-}
EOF
)"
printf '%s' "$ENV_PAYLOAD" | hermes_write ".env"
[ "$HERMES_MOUNT_ENABLED" = "true" ] && chmod 600 "$MAC_HERMES/.env" || true
```

### Modified step 4: memory backend wiring

Replace the existing patterns:

| Current (always `orb -m` + heredoc) | New (`hermes_write` / `hermes_append`) |
|---|---|
| `sed … honcho.json.tmpl \| orb -m $VM bash -lc 'cat > ~/.hermes/honcho.json'` | `sed … honcho.json.tmpl \| hermes_write honcho.json` |
| `sed … hindsight.config.json.tmpl \| orb -m $VM bash -lc 'cat > ~/.hermes/hindsight/config.json'` | `sed … \| hermes_write hindsight/config.json` |
| `printf 'AGENTMEMORY_URL=…' \| orb -m $VM bash -lc 'cat >> ~/.hermes/.env'` | `printf 'AGENTMEMORY_URL=…' \| hermes_append .env` |
| `printf 'FIRECRAWL_API_URL=…' \| orb -m $VM bash -lc 'cat >> ~/.hermes/.env'` | `printf 'FIRECRAWL_API_URL=…' \| hermes_append .env` |
| `printf 'CAMOFOX_URL=…' \| orb -m $VM bash -lc 'cat >> ~/.hermes/.env'` | `printf 'CAMOFOX_URL=…' \| hermes_append .env` |
| `printf 'SEARXNG_URL=…' \| orb -m $VM bash -lc 'cat >> ~/.hermes/.env'` | `printf 'SEARXNG_URL=…' \| hermes_append .env` |

The `hermes config set memory.provider …` and `hermes config set web.search_backend …` invocations still go via `m '…'` — they run the `hermes` CLI inside the VM, which then writes config.yaml. When mount is enabled, those writes land Mac-side via the mount; when disabled, they land VM-native. We don't gate them — they're side-effect-free to the mount question.

For agentmemory's Python-rewriting-config.yaml block (the heredoc in step 4): when mount is enabled, run the Python LOCALLY on Mac against `$MAC_HERMES/config.yaml`. When disabled, keep the existing `orb -m bash` invocation. A small if/else around that block.

### Modified step 5: model-block patch

Currently uses `m 'python3 - …'` inside the VM to rewrite `~/.hermes/config.yaml`. When mounted, run that Python on the Mac against `$MAC_HERMES/config.yaml`. When unmounted, keep the existing `orb -m` invocation.

### Unchanged steps

- Step 2 (apt xz-utils) — VM-native, mount-independent.
- Step 2b (cups removal) — VM-native, mount-independent.
- Step 6 (systemd unit install) — writes to `/etc/systemd/`, mount-independent.
- Step 7 (gateway-gate drop-in) — writes to `/etc/systemd/`, mount-independent.

### `start.sh` — no changes needed

start.sh's drain-restart (`sudo hermes gateway restart --system`) is
mount-independent. The post-mount `~/.hermes/` state is what the gateway
reads; nothing in start.sh changes.

## `service.env` SERVICE_STACK_ENV additions

Append to the existing hermes block declaration:

```sh
# Bind-mount Hermes home (~/.hermes) from this Mac path into the VM, so
# `just build`'s config edits happen locally + `_bak/` tar of .stack/ captures
# the full Hermes state. heavy native bits (venv at /opt/hermes-agent;
# Linux node binary in ~/.hermes/node) bypass the share or are relocated
# via HERMES_INSTALL_DIR. Default on; flip false to disable mount management
# AND skip build-time edits to ~/.hermes/ (each skipped step prints the
# manual orb command).
HERMES_MOUNT_ENABLED=true
# Mac-side source for the mount. Relative paths resolved against the repo
# root. Must exist + contain a populated config.yaml before each build
# (first-build path: the hermes installer populates this dir).
HERMES_MOUNT_DIR=.stack/hermes/.hermes
```

## `.gitignore`

`.stack/` is already gitignored wholesale. The mount dir lives under it, so
no new ignore line is needed. `_bak/` is already gitignored too.

## Backup story

```sh
# Snapshot stack-wide (recommended baseline)
tar -czf "_bak/stack-$(date +%Y%m%d-%H%M%S).tgz" \
    --exclude='hermes/.hermes/node' \
    --exclude='hermes/.hermes/*.db-wal' \
    --exclude='hermes/.hermes/*.db-shm' \
    .stack/

# Restore:
#   1. just stop
#   2. rm -rf .stack/ && tar -xzf _bak/stack-….tgz
#   3. just build && just start   # hermes installer reinstates ~/.hermes/node
```

WAL/SHM excluded because they're transient SQLite sidecar files; the real
state is in the `.db` files (which we DO back up). Excluding `node/` saves
~197 MB per backup; the installer regenerates it.

## Verification

After implementing + a `just build && just restart`:

1. `orb config get machine.aitools-hermes.mounts` shows `<abs>/Users/joe/…/.stack/hermes/.hermes:/home/joe/.hermes`.
2. `orb -m aitools-hermes mount | grep '/home/joe/.hermes'` shows the bind mounted via virtio-fs.
3. `cat .stack/hermes/.hermes/config.yaml | head` and `orb -m aitools-hermes cat ~/.hermes/config.yaml | head` are byte-identical.
4. Edit `.stack/hermes/.hermes/.env`, write a line; `orb -m aitools-hermes cat ~/.hermes/.env` shows it instantly (no orb-exec dance).
5. `ls /opt/hermes-agent/venv/bin/python` exists on the VM (HERMES_INSTALL_DIR honored).
6. `du -sh .stack/hermes/.hermes/` is under ~250 MB (no 1.4 GB hermes-agent on Mac).
7. `hermes gateway restart --system` still drain-restarts cleanly via `sudo hermes …` (PID changes).
8. workspace UI's Skills/Memory/Cron tabs still load (dashboard URL path unaffected). Settings panes can now write because the file the workspace will read in a follow-up commit is on the same shared Mac path.
9. Negative test: flip `HERMES_MOUNT_ENABLED=false`, run `just build` — every step that would touch `~/.hermes/` prints its `orb -m …` equivalent and skips cleanly; build still completes.

## Migration notes (operator-handled for this VM)

The user (Joe) has stated they'll manually migrate the live VM's `~/.hermes/`
contents into `.stack/hermes/.hermes/`. Suggested procedure (out of scope for
build.sh):

```sh
# 1. Stop the VM so source files are quiescent
just stop

# 2. Mac-side: create the target dir
mkdir -p .stack/hermes/.hermes

# 3. Copy via ~/OrbStack/aitools-hermes/home/joe/.hermes  (user has read access)
cp -a ~/OrbStack/aitools-hermes/home/joe/.hermes/. .stack/hermes/.hermes/

# 4. Remove the heavy bits from the Mac copy (they'll be reinstalled at /opt/hermes-agent)
rm -rf .stack/hermes/.hermes/hermes-agent

# 5. Re-build + restart — build.sh adds the mount, fails-fast asking for restart
just build       # adds the mount config; dies "run just restart"
just restart     # cycles VM; mount applies; build picks up

# 6. (After the VM is back up) Verify the live VM sees the Mac content
orb -m aitools-hermes bash -lc 'head ~/.hermes/config.yaml'

# 7. (Cleanup) The OLD VM-native ~/.hermes/hermes-agent/ is now SHADOWED by
#    the mount. It's still on the underlying VM disk; harmless but wastes
#    1.4 GB. Optional cleanup: detach mount once, rm the old dir, re-attach:
#    just stop
#    orb config remove machine.aitools-hermes.mounts "<mount-spec>"
#    just start    (VM boots with native ~/.hermes briefly)
#    orb -m aitools-hermes rm -rf ~/.hermes/hermes-agent
#    just stop
#    orb config add machine.aitools-hermes.mounts "<mount-spec>"
#    just restart
#    (or just leave it — it's just 1.4 GB of dead VM disk, not on backups)
```

Subsequent fresh installs on other Macs/projects need no migration — the
installer writes a fresh config.yaml directly into the shared dir on first
build (State 1).

## Out of scope (intentionally deferred)

- **Workspace container mount.** Once this lands, the same Mac path can be
  bind-mounted into the hermes-workspace container at `/home/workspace/.hermes`
  so its Settings UI writes propagate to the agent. UID-mapping question
  (workspace runs as uid 10010; Mac files appear as Mac-user-uid via virtio-fs)
  needs a separate look. Tracked as follow-up.
- **Per-file mounts.** Selectively mounting just `config.yaml`, `.env`, etc.
  was the alternative explored in the brainstorm; explicitly rejected here in
  favor of wholesale mount + `HERMES_INSTALL_DIR` (one mount entry, automatic
  forward-compatibility with new hermes files).
- **`just backup-hermes` recipe.** Easy follow-up once this lands. Spec the
  tar exclude list above as the basis.
- **Mount path-drift detection.** If the user moves the repo, the absolute
  Mac path embedded in `orb config get machine.<vm>.mounts` becomes stale.
  Future: detect + offer to update. For now: documented as a known limitation;
  fix is `orb config remove old; orb config add new; just restart`.
- **Workspace container's volume.** This spec does not change
  `services/hermes-workspace/compose.yaml`. That comes in a follow-up.

## Commits (planned)

Two scoped commits:

1. **`feat(hermes): bind-mount ~/.hermes/ from Mac via OrbStack selective mount`**
   - `services/hermes/service.env`: new SERVICE_STACK_ENV keys (mount enabled + dir)
   - `services/hermes/build.sh`: helpers (`hermes_write`, `hermes_append`), step-0 mount config, modified step 1/3/4/5 to dispatch local-vs-orb-exec
   - `services/hermes/README.md`: levers table + bootstrap notes
2. **`docs(specs): add 2026-05-21-hermes-mount.md`** (this file). Could be folded into commit 1; preference is split for git-blame clarity.

(After merge: move spec from `docs/specs/` to `docs/plans/implemented/` per
the `docs-plans-specs-layout` convention.)
