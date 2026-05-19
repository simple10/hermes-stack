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
     bash "{{root}}/services/postgres/build.sh"; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
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
     dc up -d pg redis; \
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

# Stop this stack's machines, then bring containers down (keep volumes).
# Only machines listed in this stack's .stack/.env STACK_MACHINES are touched.
stop:
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
       t="$d/config.$ext.template"; o="$d/config.runtime.$ext"; \
       if [ -f "$t" ]; then \
         [ -f "$o" ] && cp "$o" "$o.bak.$(date +%s)" && echo "backed up $o"; \
         rm -f "$o"; render_template "$t" "$o" "{{svc}}"; \
       fi; \
     done
