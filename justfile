# hermes-stack — composable Docker services + Orb machines.
# Secrets live ONLY in .stack/ (gitignored). .stack/.env is intentionally not
# auto-loaded — recipes set COMPOSE_ENV_FILES explicitly (plan decision 5).

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
     source "{{root}}/.stack/.env"; \
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
#   correctly for fresh OR reattached DB) -> settle up -d -> machines.
# Do NOT add a blanket `up -d` before honcho-postup: on a fresh DB honcho-api
# crash-loops on the 1536/1024 validator until postup applies the dim fix.
start:
    @set -a; source "{{lib}}"; set +a; \
     require_stack_env; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     source "{{root}}/.stack/.env"; \
     echo "COMPOSE_ENV_FILES=$COMPOSE_ENV_FILES  COMPOSE_PROFILES=${COMPOSE_PROFILES:-}"; \
     DC="docker compose -f {{root}}/docker-compose.yaml"; \
     $DC up -d aitools-pg aitools-redis; \
     if echo "${COMPOSE_PROFILES:-}" | grep -qw litellm || \
        echo "${COMPOSE_PROFILES:-}" | grep -qw honcho; then \
       $DC up -d aitools-litellm; \
       bash "{{root}}/services/litellm/start.sh"; \
       export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     fi; \
     if echo "${COMPOSE_PROFILES:-}" | grep -qw honcho; then \
       bash "{{root}}/lib/honcho-postup.sh"; \
     fi; \
     $DC up -d; \
     for mch in $(echo "${STACK_MACHINES:-}" | tr ', ' ' '); do \
       [ -n "$mch" ] && [ -x "{{root}}/machines/$mch/start.sh" ] && \
         bash "{{root}}/machines/$mch/start.sh" "$mch"; \
     done; \
     echo "start complete"

# Stop containers (keep volumes). Machines left running.
# Source the user's profiles so profiled services (litellm/honcho) are also
# removed (`--profile "*"` is not valid for `down`).
stop:
    @set -a; source "{{lib}}"; set +a; \
     export COMPOSE_ENV_FILES="$(compose_env_files)"; \
     source "{{root}}/.stack/.env" 2>/dev/null || true; \
     export COMPOSE_PROFILES="${COMPOSE_PROFILES:-litellm,honcho}"; \
     docker compose -f "{{root}}/docker-compose.yaml" down --remove-orphans

# Container health + machine list.
status:
    @docker ps --filter "name=aitools-" --format "table {{{{.Names}}}}\t{{{{.Status}}}}"; \
     echo "---"; orb list 2>/dev/null || true

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
