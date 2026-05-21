# hermes-stack — composable Docker services + Orb machines.
# Secrets live ONLY in .stack/ (gitignored). The Compose PROJECT name comes
# from COMPOSE_PROJECT_NAME in .stack/.env (default `aitools`) so multiple
# independent stacks coexist; `dc` (from lib/stacklib.sh) binds every compose
# call to that project. Services are reachable at <service>.<project>.orb.local.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

root := justfile_directory()
lib  := root / "lib/stacklib.sh"

# Convenience aliases.
alias up   := start
alias down := stop

# Default: list targets.
default:
    @just --list

# Interactive: create/refresh .stack/.env.
setup:
    @bash "{{root}}/lib/setup.sh"

# Add a service to .stack/.env (idempotent). Reads services/<svc>/service.env
# for SERVICE_RUNNER (docker|vm), SERVICE_PROFILE, SERVICE_LITELLM_KEY,
# SERVICE_STACK_ENV. Toggles the #>--- svc --- block back from disabled if
# present. Then prints the next-step commands.
# Enable a service — toggle into .stack/.env (CSV + #>--- svc --- block).
enable svc:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     lib_enable_service "{{svc}}"; \
     stack_render_compose; \
     echo ""; \
     echo "next: just build && just start    (or 'just restart' if the stack is already up)"

# Remove a service from .stack/.env (idempotent). Comments out its
# #>--- svc --- block so user edits inside are preserved for re-enable.
# Warns + prompts if other enabled services depend on this one
# (STACK_FORCE=1 to skip).
# Disable a service — remove from CSVs, comment out its #>--- svc --- block.
disable svc:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     lib_disable_service "{{svc}}"; \
     stack_render_compose; \
     echo ""; \
     echo "next: just stop && just start    (to remove the service's containers; volumes stay)"

# List currently-enabled services in .stack/.env (COMPOSE_PROFILES + STACK_MACHINES).
enabled:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     lib_list_enabled_services

# Render configs, fetch pinned sources, generate DB passwords, provision machines.
build:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     stack_render_compose; \
     echo "== Phase 1: resolve digest-class images =="; \
     stack_resolve_images; \
     echo "== Phase 1 done — image refs in .stack/<svc>/.generated.env =="; \
     bash "{{root}}/services/pg/build.sh"; \
     for p in $(stack_profiles | tr ',' ' '); do \
       if [ "$p" = "pg" ]; then continue; fi; \
       if [ -x "{{root}}/services/$p/build.sh" ]; then \
         bash "{{root}}/services/$p/build.sh" \
           || { echo "FATAL: services/$p/build.sh failed (exit $?)" >&2; exit 1; }; \
       fi; \
     done; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       if [ -z "$mch" ]; then continue; fi; \
       if [ -x "{{root}}/services/$mch/build.sh" ]; then \
         bash "{{root}}/services/$mch/build.sh" "$mch" \
           || { echo "FATAL: services/$mch/build.sh failed (exit $?)" >&2; exit 1; }; \
       fi; \
     done; \
     echo "build complete"

# Staged bring-up. ORDER: enforce VM isolation -> backends -> per-profile
# preflight.sh (+ env recompute) -> per-profile prestart.sh -> dc up -d
# (provisioners ordered by depends_on) -> per-profile poststart.sh -> machines
# -> optional cleanup. Generic: the ONLY service names here are the pg/redis
# backend substrate (genuinely shared — litellm/honcho/hindsight all need pg;
# preflight needs it up to mint keys). Everything else, incl. rabbitmq, comes
# up via its profile + depends_on inside `dc up -d`.
# Isolation enforcement: every STACK_MACHINES VM must have both
# machine.<name>.isolated AND .isolate_network = true (OrbStack config). If
# either is false, we flip it and fail-fast — `orb config set` only takes
# effect on next machine start, so the VM has to be cycled (`just restart`).
# Bring up the stack — VM isolation enforced, backends -> dc up -d -> machines.
start:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     stack_render_compose; \
     set +e; \
     for svc in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$svc" ] || continue; \
       vm="$(stack_vm_name "$svc")"; \
       orb_set_machine_isolation "$vm"; rc=$?; \
       case "$rc" in \
         0) ;; \
         1) die "machine '$vm': isolation flags were FALSE — flipped to true in orb config. Run 'just restart' to apply (config changes take effect on next VM start)." ;; \
         2) die "machine '$vm': 'orb config set' failed (is OrbStack running?)" ;; \
       esac; \
     done; \
     set -e; \
     echo "project=$(stack_project)  COMPOSE_PROFILES=${COMPOSE_PROFILES:-}"; \
     b="$(stack_backends)"; [ -n "$b" ] && dc up -d $b; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
       [ -n "$p" ] && [ -x "{{root}}/services/$p/preflight.sh" ] && \
         { echo "== preflight: $p =="; bash "{{root}}/services/$p/preflight.sh"; }; \
     done; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
       [ -n "$p" ] && [ -x "{{root}}/services/$p/prestart.sh" ] && \
         { echo "== prestart: $p =="; bash "{{root}}/services/$p/prestart.sh"; }; \
     done; \
     dc up -d; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
       [ -n "$p" ] && [ -x "{{root}}/services/$p/poststart.sh" ] && \
         { echo "== poststart: $p =="; bash "{{root}}/services/$p/poststart.sh"; }; \
     done; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$mch" ] && [ -x "{{root}}/services/$mch/start.sh" ] && \
         bash "{{root}}/services/$mch/start.sh" "$mch"; \
     done; \
     if [ "${STACK_AUTO_REMOVE_PROVISIONERS:-false}" = "true" ]; then just start-cleanup; fi; \
     echo "start complete"

# Remove this project's exited provisioner containers (multi-stack-safe).
start-cleanup:
    @set -a; source "{{lib}}"; set +a; \
     ids="$(docker ps -aq \
       --filter "label=com.stack.role=provisioner" \
       --filter "label=com.docker.compose.project=$(stack_project)" \
       --filter "status=exited")"; \
     if [ -n "$ids" ]; then docker rm $ids || true; fi; \
     echo "start-cleanup done"

# Use this to manually log in / solve captcha in a real Chrome, then drive the
# already-authenticated session from Hermes via CDP. Defense-in-depth:
#  - Chrome binds 127.0.0.1 only (Mac loopback; LAN can't open the TCP socket).
#  - hermes VM is --isolated --isolate-network — it CANNOT reach Mac IPs.
#  - localhost-proxy (this stack's only Mac<->VM bridge) lives on the project's
#    docker network; VM reaches it via orb DNS; proxy reaches Chrome via
#    host.docker.internal (containers aren't subject to VM net-isolation).
#  - --remote-allow-origins=* bypasses Chrome's WebSocket Origin check
#    (DNS-rebinding defense). Chrome 111+ ALSO checks the HTTP Host header;
#    we hand Hermes the proxy container's IP (literal, not hostname) so the
#    Host header is an IP → Chrome accepts. Resolved fresh each run.
#  - Blast radius of a compromised Hermes dep = exactly these ports on the
#    Mac, nothing else. Adjust by editing LOCALHOST_PROXY_PORTS in .stack/.env.
# Defaults (override in .stack/.env):
#   CHROME_CDP_PORT=19298         # Chrome's loopback CDP port (Mac side)
#   CHROME_CDP_BRIDGE_PORT=19299  # proxy's listen port (Hermes connects here)
# Non-default ports avoid colliding with any other unrelated CDP on this Mac.
# Multi-stack: each stack's .stack/.env picks its own ports → independent CDPs;
# or set the same ports across stacks to share one CDP.
# Profile data lives at .stack/chrome-cdp/data (gitignored, per-stack).
# localhost-proxy is a TRANSIENT sidecar (lives only while chrome-cdp is
# active), never in COMPOSE_PROFILES. Since stack_render_compose only
# include:s services that ARE in COMPOSE_PROFILES, we surface localhost-proxy
# to compose with an explicit second -f file each time we touch it (chrome-cdp
# + chrome-cdp-stop). Docker compose merges multiple -f files; the
# `--profile localhost-proxy` flag activates the now-visible service.
# Launch Mac-host Chrome + bring up localhost-proxy + offer to wire Hermes.
chrome-cdp:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     port="${CHROME_CDP_PORT:-19298}"; bport="${CHROME_CDP_BRIDGE_PORT:-19299}"; \
     proj="$(stack_project)"; \
     run_dir="{{root}}/.stack/chrome-cdp"; data_dir="$run_dir/data"; \
     mkdir -p "$data_dir"; \
     chrome_pid="$run_dir/chrome.pid"; \
     chrome_bin="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; \
     [ -x "$chrome_bin" ] || die "Google Chrome not found at $chrome_bin"; \
     if [ -f "$chrome_pid" ] && kill -0 "$(cat "$chrome_pid")" 2>/dev/null; then \
       die "chrome-cdp already running (Chrome PID $(cat "$chrome_pid")). Use 'just chrome-cdp-stop' first."; \
     fi; \
     lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && die "port $port in use (CHROME_CDP_PORT)"; \
     log "chrome-cdp: launching Chrome (loopback :$port, data $data_dir)"; \
     "$chrome_bin" --remote-debugging-port="$port" --user-data-dir="$data_dir" \
                   --remote-allow-origins='*' \
                   --no-first-run --no-default-browser-check >/dev/null 2>&1 & \
     echo $! > "$chrome_pid"; \
     for i in $(seq 1 30); do \
       curl -sS -m1 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break; sleep 0.5; \
     done; \
     curl -sS -m1 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 \
       || { kill "$(cat "$chrome_pid")" 2>/dev/null; rm -f "$chrome_pid"; die "CDP did not come up on $port"; }; \
     log "chrome-cdp: bringing up localhost-proxy with chrome mapping (+ any LOCALHOST_PROXY_PORTS extras)"; \
     user_ports="$(env_get "$STACK_DIR/.env" LOCALHOST_PROXY_PORTS)"; \
     chrome_map="$bport:$port"; \
     case ",$user_ports," in *",$chrome_map,"*) merged="$user_ports" ;; *) merged="${user_ports:+$user_ports,}$chrome_map" ;; esac; \
     mkdir -p "$STACK_DIR/localhost-proxy"; \
     env_upsert "$STACK_DIR/localhost-proxy/.generated.env" LOCALHOST_PROXY_PORTS "$merged"; \
     dc -f services/localhost-proxy/compose.yaml --profile localhost-proxy up -d --force-recreate localhost-proxy >/dev/null; \
     first_svc="$(echo "${STACK_MACHINES:-hermes}" | tr ', ' ' ' | awk '{print $1}')"; \
     first_vm="$(stack_vm_name "$first_svc")"; \
     mch_running="$(orb list 2>/dev/null | awk -v m="$first_vm" '$1==m && $2=="running"{print "1"}')"; \
     [ -n "$mch_running" ] || die "machine '$first_vm' not running — start it first ('just start') so chrome-cdp can resolve the proxy IP from the VM's perspective (orb-DNS NAT differs from docker inspect; printing the docker IP would give Hermes an address it can't reach under --isolate-network)."; \
     for i in $(seq 1 30); do \
       proxy_ip="$(orb -m "$first_vm" bash -lc "getent hosts localhost-proxy.$proj.orb.local 2>/dev/null | awk '{print \$1}'" 2>/dev/null)"; \
       [ -n "$proxy_ip" ] && break; sleep 0.3; \
     done; \
     [ -n "$proxy_ip" ] || die "could not resolve localhost-proxy.$proj.orb.local from machine '$first_vm' — check 'dc logs localhost-proxy' and that orb DNS is up"; \
     cdp_url="http://$proxy_ip:$bport"; \
     log "chrome-cdp: ready"; \
     log "  Hermes URL:  $cdp_url   (IP literal, VM-resolved — Chrome 111+ rejects hostname Host headers)"; \
     log "  port list:   LOCALHOST_PROXY_PORTS=$merged"; \
     if [ ! -t 0 ]; then \
       log "  non-interactive — wire Hermes manually:"; \
       log "    orb -m $first_vm bash -lc 'sed -i \"/^BROWSER_CDP_URL=/d\" ~/.hermes/.env; echo BROWSER_CDP_URL=$cdp_url >> ~/.hermes/.env; sudo hermes gateway restart --system'"; \
       exit 0; \
     fi; \
     printf "\nWire BROWSER_CDP_URL=%s into machine '%s' and restart hermes-gateway? [y/N] " "$cdp_url" "$first_vm"; \
     read -r ans; \
     case "$ans" in \
       y|Y|yes|YES) \
         orb -m "$first_vm" bash -lc "set -e; umask 077; \
           sed -i '/^BROWSER_CDP_URL=/d' ~/.hermes/.env 2>/dev/null || true; \
           echo 'BROWSER_CDP_URL=$cdp_url' >> ~/.hermes/.env; \
           sudo hermes gateway restart --system"; \
         log "  Hermes: BROWSER_CDP_URL=$cdp_url applied, hermes-gateway restarted" ;; \
       *) log "  skipped — apply later with: orb -m $first_vm bash -lc 'hermes config set browser.cdp_url $cdp_url'" ;; \
     esac

# Tear down Mac-host Chrome + localhost-proxy + ALWAYS clear stale
# BROWSER_CDP_URL from Hermes (the URL embeds the proxy's container IP, which
# changes on next recreate — a leftover URL points Hermes at a dead address).
# Stop Chrome + localhost-proxy + clear stale BROWSER_CDP_URL on hermes. Idempotent.
chrome-cdp-stop:
    @set -a; source "{{lib}}"; set +a; \
     run_dir="{{root}}/.stack/chrome-cdp"; \
     pid_file="$run_dir/chrome.pid"; \
     if [ -f "$pid_file" ]; then \
       pid="$(cat "$pid_file" 2>/dev/null)"; \
       if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then \
         echo "== chrome-cdp: stopping Chrome (PID $pid) =="; \
         kill "$pid" 2>/dev/null || true; \
         for i in 1 2 3 4 5 6; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done; \
         kill -9 "$pid" 2>/dev/null || true; \
       fi; \
       rm -f "$pid_file"; \
     fi; \
     if [ -f "$STACK_DIR/.env" ]; then \
       echo "== chrome-cdp: stopping localhost-proxy =="; \
       dc -f services/localhost-proxy/compose.yaml --profile localhost-proxy stop localhost-proxy >/dev/null 2>&1 || true; \
       dc -f services/localhost-proxy/compose.yaml --profile localhost-proxy rm -f localhost-proxy >/dev/null 2>&1 || true; \
       rm -f "$STACK_DIR/localhost-proxy/.generated.env"; \
     fi; \
     first_svc="$(env_get "$STACK_DIR/.env" STACK_MACHINES 2>/dev/null | tr ', ' ' ' | awk '{print $1}')"; \
     [ -z "$first_svc" ] && exit 0; \
     first_vm="$(stack_vm_name "$first_svc")"; \
     orb list 2>/dev/null | awk '{print $1}' | grep -qx "$first_vm" || exit 0; \
     orb -m "$first_vm" bash -lc 'test -f ~/.hermes/.env && grep -q "^BROWSER_CDP_URL=" ~/.hermes/.env' 2>/dev/null \
       || exit 0; \
     echo "== chrome-cdp: clearing stale BROWSER_CDP_URL on '$first_vm' =="; \
     orb -m "$first_vm" bash -lc "sed -i '/^BROWSER_CDP_URL=/d' ~/.hermes/.env 2>/dev/null || true; sudo hermes gateway restart --system 2>/dev/null || true"

# chrome-cdp stops FIRST (depends_on) so a stale CDP can't be reattached
# accidentally on next start. Only machines in STACK_MACHINES are touched.
# Stop this stack's chrome-cdp + machines, then bring containers down (keep volumes).
stop: chrome-cdp-stop
    @set -a; source "{{lib}}"; set +a; \
     svcs="$(env_get "$STACK_DIR/.env" STACK_MACHINES | tr ', ' ' ')"; \
     if [ -n "$(echo "$svcs" | tr -d '[:space:]')" ]; then \
       ol="$(orb list 2>/dev/null || true)"; \
       for svc in $svcs; do \
         [ -n "$svc" ] || continue; \
         vm="$(stack_vm_name "$svc")"; \
         row="$(echo "$ol" | awk -v m="$vm" '$1==m')"; \
         if [ -n "$row" ]; then \
           echo "== stopping machine: $vm =="; orb stop "$vm" || true; \
         else \
           echo "(machine $vm not created — skipping)"; \
         fi; \
       done; \
     fi; \
     dc down --remove-orphans

# Full down + up cycle. The PRIMARY way to apply OrbStack machine-config
# changes (incl. isolation flags), which only take effect on next VM start.
# Cycle the stack — `stop` then `start` (applies machine-config changes).
restart: stop start

# --- (defense-in-depth, intentionally NOT enabled yet) ---
# When the bind-to-bridge-IP alone feels insufficient, an extra Mac-host pf
# anchor would further restrict inbound to CHROME_CDP_BRIDGE_PORT to
# bridge100 only. Pseudo-config:
#   block in proto tcp to any port {{CHROME_CDP_BRIDGE_PORT}}
#   pass  in on bridge100 proto tcp to <bridge100-ip> port {{CHROME_CDP_BRIDGE_PORT}}
# Loaded via `sudo pfctl -a com.hermes-stack-cdp -f /etc/pf.anchors/...`.
# Add a `chrome-cdp-pf` recipe when ready.

# This stack's container health + machine list.
status:
    @set -a; source "{{lib}}"; set +a; \
     p="$(stack_project)"; \
     echo "========== PROJECT: $p =========="; \
     echo ""; \
     echo "----- DOCKER ----"; \
     docker ps --filter "label=com.docker.compose.project=$p" \
       --format "table {{{{.Label \"com.docker.compose.service\"}}\t{{{{.Status}}\t{{{{.Ports}}"; \
     echo ""; \
     echo "------- VMs -------"; \
     svcs="$(env_get "$STACK_DIR/.env" STACK_MACHINES | tr ',' ' ')"; \
     if [ -z "$(echo "$svcs" | tr -d '[:space:]')" ]; then \
       echo "(no STACK_MACHINES configured for this stack)"; \
     else \
       ol="$(orb list 2>/dev/null || true)"; \
       for svc in $svcs; do \
         vm="$(stack_vm_name "$svc")"; \
         row="$(echo "$ol" | awk -v m="$vm" '$1==m')"; \
         [ -n "$row" ] && echo "$row" || echo "$vm  (not created)"; \
       done; \
     fi

# Tail an Orb machine console (OrbStack Logs tab = console).
# Arg is the SERVICE name (matches STACK_MACHINES); we translate to the
# project-prefixed VM name via stack_vm_name.
logs svc="hermes":
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     orb logs "$(stack_vm_name "{{svc}}")"

# Re-render a service runtime config from its template (backs up the old one).
reconfigure svc:
    @set -a; source "{{lib}}"; set +a; \
     d="{{root}}/services/{{svc}}"; \
     for ext in toml yaml json; do \
       t="$d/config.$ext.template"; o="{{root}}/.stack/{{svc}}/config.runtime.$ext"; \
       mkdir -p "{{root}}/.stack/{{svc}}"; \
       if [ -f "$t" ]; then \
         [ -f "$o" ] && cp "$o" "$o.bak.$(date +%s)" && echo "backed up $o"; \
         rm -f "$o"; render_template "$t" "$o" "{{svc}}"; \
       fi; \
     done
