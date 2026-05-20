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

# Render configs, fetch pinned sources, generate DB passwords, provision machines.
build:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     echo "== Phase 1: resolve digest-class images =="; \
     stack_resolve_images; \
     echo "== Phase 1 done — image refs in .stack/<svc>/.generated.env =="; \
     bash "{{root}}/services/pg/build.sh"; \
     for p in $(stack_profiles | tr ',' ' '); do \
       [ "$p" = "pg" ] && continue; \
       [ -x "{{root}}/services/$p/build.sh" ] && bash "{{root}}/services/$p/build.sh" || true; \
     done; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$mch" ] && [ -x "{{root}}/machines/$mch/build.sh" ] && \
         bash "{{root}}/machines/$mch/build.sh" "$mch" || true; \
     done; \
     echo "build complete"

# Staged bring-up. ORDER: backends -> per-profile preflight.sh (+ env
# recompute) -> per-profile prestart.sh -> dc up -d (provisioners ordered by
# depends_on) -> per-profile poststart.sh -> machines -> optional cleanup.
# Generic: the ONLY service names here are the pg/redis backend substrate
# (genuinely shared — litellm/honcho/hindsight all need pg; preflight needs
# it up to mint keys). Everything else, incl. rabbitmq, comes up via its
# profile + depends_on inside `dc up -d`.
start:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
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
       [ -n "$mch" ] && [ -x "{{root}}/machines/$mch/start.sh" ] && \
         bash "{{root}}/machines/$mch/start.sh" "$mch"; \
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

# Use this to manually log in / solve captcha in a real Chrome, then
# `/browser connect <url>` from a hermes session to drive the already-
# authenticated browser. LAN-safe by construction:
#  - Chrome binds 127.0.0.1 only (LAN can't open the TCP socket).
#  - socat forwarder ALSO binds 127.0.0.1 (same).
#  - VM reaches via OrbStack's `host.docker.internal` — an OrbStack-internal
#    DNS name unresolvable from LAN, routed to the Mac's loopback.
#  - --remote-allow-origins=* on Chrome bypasses its DNS-rebinding Host check
#    (Chrome 111+ rejects non-localhost Host headers even from loopback
#    connections); without this the forwarded request gets a 500.
# Defaults (override in .stack/.env):
#   CHROME_CDP_PORT=19298         # Chrome's loopback CDP port
#   CHROME_CDP_BRIDGE_PORT=19299  # socat's port — Hermes connects here via host.docker.internal
# Non-default ports avoid colliding with any other unrelated CDP on this Mac.
# Multi-stack: each stack's .stack/.env picks its own ports → independent CDPs;
# or set the same ports across stacks to share one CDP.
# Profile data lives at .stack/chrome-cdp/data (gitignored, per-stack).
# Layer-2 pf restriction is intentionally NOT applied yet (Chrome+socat both
# loopback-bound + OrbStack-only DNS already isolates LAN); add a pf anchor
# later if needed.
# Launch Mac-host Chrome with CDP enabled + a loopback-bound socat forwarder.
chrome-cdp:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     port="${CHROME_CDP_PORT:-19298}"; bport="${CHROME_CDP_BRIDGE_PORT:-19299}"; \
     run_dir="{{root}}/.stack/chrome-cdp"; data_dir="$run_dir/data"; \
     mkdir -p "$data_dir"; \
     chrome_pid="$run_dir/chrome.pid"; socat_pid="$run_dir/socat.pid"; \
     chrome_bin="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; \
     [ -x "$chrome_bin" ] || die "Google Chrome not found at $chrome_bin"; \
     command -v socat >/dev/null || die "socat not installed. Run: brew install socat"; \
     if [ -f "$chrome_pid" ] && kill -0 "$(cat "$chrome_pid")" 2>/dev/null; then \
       die "chrome-cdp already running (Chrome PID $(cat "$chrome_pid")). Use 'just chrome-cdp-stop' first."; \
     fi; \
     lsof -nP -iTCP:$port  -sTCP:LISTEN >/dev/null 2>&1 && die "port $port in use (CHROME_CDP_PORT)"; \
     lsof -nP -iTCP:$bport -sTCP:LISTEN >/dev/null 2>&1 && die "port $bport in use (CHROME_CDP_BRIDGE_PORT)"; \
     log "chrome-cdp: launching Chrome (port $port, data $data_dir)"; \
     "$chrome_bin" --remote-debugging-port="$port" --user-data-dir="$data_dir" \
                   --remote-allow-origins='*' \
                   --no-first-run --no-default-browser-check >/dev/null 2>&1 & \
     echo $! > "$chrome_pid"; \
     for i in $(seq 1 30); do \
       curl -sS -m1 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 && break; sleep 0.5; \
     done; \
     curl -sS -m1 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 \
       || { kill "$(cat "$chrome_pid")" 2>/dev/null; rm -f "$chrome_pid"; die "CDP did not come up on $port"; }; \
     log "chrome-cdp: socat forwarder 127.0.0.1:$bport -> 127.0.0.1:$port (loopback only; VM reaches via host.docker.internal)"; \
     socat TCP-LISTEN:$bport,bind=127.0.0.1,reuseaddr,fork TCP:127.0.0.1:$port >/dev/null 2>&1 & \
     echo $! > "$socat_pid"; \
     sleep 0.3; \
     kill -0 "$(cat "$socat_pid")" 2>/dev/null \
       || { rm -f "$socat_pid"; die "socat failed to start (check port $bport)"; }; \
     # Hermes URL MUST use the IP form (not host.docker.internal). Chrome 111+ \
     # rejects any Host header that isn't 'localhost' or an IP — DNS-rebinding \
     # defense, separate from --remote-allow-origins (which only fixes the \
     # WebSocket Origin check). Dynamically resolve from the first stack machine; \
     # fall back to OrbStack's documented default if no machine is up yet. \
     first_mch="$(echo "${STACK_MACHINES:-hermes}" | tr ', ' ' ' | awk '{print $1}')"; \
     hd_ip="$(orb -m "$first_mch" bash -lc 'getent hosts host.docker.internal 2>/dev/null | awk "{print \$1}"' 2>/dev/null || true)"; \
     [ -n "$hd_ip" ] || hd_ip="0.250.250.254"; \
     log "chrome-cdp: ready"; \
     log "  Hermes URL:  http://$hd_ip:$bport   (IP form required — Chrome rejects hostname Host headers)"; \
     log "  per-session: /browser connect http://$hd_ip:$bport"; \
     log "  persistent:  orb -m $first_mch bash -lc 'hermes config set browser.cdp_url http://$hd_ip:$bport'"

# Stop the Mac-host CDP Chrome + socat forwarder. Idempotent (no-op if not running).
chrome-cdp-stop:
    @set -a; source "{{lib}}"; set +a; \
     run_dir="{{root}}/.stack/chrome-cdp"; \
     for what in socat chrome; do \
       pid_file="$run_dir/$what.pid"; \
       [ -f "$pid_file" ] || continue; \
       pid="$(cat "$pid_file" 2>/dev/null)"; \
       if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then \
         echo "== chrome-cdp: stopping $what (PID $pid) =="; \
         kill "$pid" 2>/dev/null || true; \
         for i in 1 2 3 4 5 6; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done; \
         kill -9 "$pid" 2>/dev/null || true; \
       fi; \
       rm -f "$pid_file"; \
     done

# chrome-cdp stops FIRST (depends_on) so a stale CDP can't be reattached
# accidentally on next start. Only machines in STACK_MACHINES are touched.
# Stop this stack's chrome-cdp + machines, then bring containers down (keep volumes).
stop: chrome-cdp-stop
    @set -a; source "{{lib}}"; set +a; \
     mch="$(env_get "$STACK_DIR/.env" STACK_MACHINES | tr ', ' ' ')"; \
     if [ -n "$(echo "$mch" | tr -d '[:space:]')" ]; then \
       ol="$(orb list 2>/dev/null || true)"; \
       for m in $mch; do \
         [ -n "$m" ] || continue; \
         row="$(echo "$ol" | awk -v m="$m" '$1==m')"; \
         if [ -n "$row" ]; then \
           echo "== stopping machine: $m =="; orb stop "$m" || true; \
         else \
           echo "(machine $m not created — skipping)"; \
         fi; \
       done; \
     fi; \
     dc down --remove-orphans

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
     mch="$(env_get "$STACK_DIR/.env" STACK_MACHINES | tr ',' ' ')"; \
     if [ -z "$(echo "$mch" | tr -d '[:space:]')" ]; then \
       echo "(no STACK_MACHINES configured for this stack)"; \
     else \
       ol="$(orb list 2>/dev/null || true)"; \
       for m in $mch; do \
         row="$(echo "$ol" | awk -v m="$m" '$1==m')"; \
         [ -n "$row" ] && echo "$row" || echo "$m  (not created)"; \
       done; \
     fi

# Tail an Orb machine console (OrbStack Logs tab = console).
logs machine="hermes":
    orb logs {{machine}}

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
