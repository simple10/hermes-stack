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

# Staged bring-up. ORDER IS LOAD-BEARING:
#   pg+redis -> litellm -> mint virtual keys -> honcho-postup (brings honcho up
#   correctly for fresh DB) -> settle up -d -> machines.
# Do NOT add a blanket `up -d` before honcho-postup: on a fresh DB honcho-api
# crash-loops on the 1536/1024 validator until postup applies the dim fix.
start:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     set -a; source "{{root}}/.stack/.env"; set +a; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     echo "project=$(stack_project)  COMPOSE_PROFILES=${COMPOSE_PROFILES:-}  COMPOSE_ENV_FILES=$COMPOSE_ENV_FILES"; \
     dc up -d pg redis; \
     if echo "${COMPOSE_PROFILES:-}" | grep -qw litellm || \
        echo "${COMPOSE_PROFILES:-}" | grep -qw honcho || \
        echo "${COMPOSE_PROFILES:-}" | grep -qw hindsight; then \
       dc up -d litellm; \
       bash "{{root}}/services/litellm/start.sh"; \
       export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     fi; \
     if echo "${COMPOSE_PROFILES:-}" | grep -qw honcho; then \
       bash "{{root}}/lib/honcho-postup.sh"; \
     fi; \
     dc up -d; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$mch" ] && [ -x "{{root}}/machines/$mch/start.sh" ] && \
         bash "{{root}}/machines/$mch/start.sh" "$mch"; \
     done; \
     echo "start complete"

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
