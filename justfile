# hermes-stack — composable Docker services + Orb machines.
# Secrets live ONLY in .stack/ (gitignored). The Compose PROJECT name comes
# from COMPOSE_PROJECT_NAME in .stack/.env (default `aitools`) so multiple
# independent stacks coexist; `dc` (from lib/stacklib.sh) binds every compose
# call to that project. Services are reachable at <service>.<project>.orb.local.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

root := justfile_directory()
lib  := root / "lib/stacklib.sh"

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
# Generic: no service names except the pg/redis backend substrate.
start:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     echo "project=$(stack_project)  COMPOSE_PROFILES=${COMPOSE_PROFILES:-}"; \
     dc up -d pg redis; \
     for p in $(echo "${COMPOSE_PROFILES:-}" | tr ',' ' '); do \
       [ -n "$p" ] && [ -x "{{root}}/services/$p/preflight.sh" ] && \
         { echo "== preflight: $p =="; bash "{{root}}/services/$p/preflight.sh"; }; \
     done; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
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

# Stop containers (keep volumes). Machines left running.
stop:
    @set -a; source "{{lib}}"; set +a; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     set -a; source "{{root}}/.stack/.env" 2>/dev/null || true; set +a; \
     export COMPOSE_PROFILES="${COMPOSE_PROFILES:-litellm,honcho}"; \
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
