# hermes-stack — one-command orchestration.
# Requires: docker (OrbStack engine), orb CLI, secrets.env (cp from example).

# Default: list targets.
default:
    @just --list

# Bring up the full Docker side (aitools-backends -> aitools-services).
up:
    ./build-stack.sh

# Tear down both compose projects (keeps volumes).
down:
    docker compose -f aitools-services/compose.yaml --env-file aitools-services/.env down || docker compose -f aitools-services/compose.yaml down
    docker compose -f aitools-backends/compose.yaml --env-file aitools-backends/.env down || docker compose -f aitools-backends/compose.yaml down

# Provision a fresh Hermes orb VM (default name: hermes-fresh).
hermes machine="hermes-fresh":
    ./build-hermes.sh {{machine}}

# Container health + orb machine list.
status:
    @docker ps --filter "name=aitools-" --format "table {{{{.Names}}}}\t{{{{.Status}}}}"
    @echo "---"
    @orb list

# Tail the Hermes orb VM console logs (OrbStack Logs tab = the console).
logs machine="hermes-fresh":
    orb logs {{machine}}
