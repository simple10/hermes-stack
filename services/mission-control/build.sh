#!/usr/bin/env bash
# services/mission-control/build.sh — build the mission-control Docker image.
#
# Called by `just build` (stack_resolve_images phase) or directly.
# Warns if required secrets are unset but does NOT abort — the compose.yaml
# will fail loudly at `just start` time with a clear error if BETTER_AUTH_SECRET
# is missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .stack/.env so we can inspect the secret state before building.
STACK_ENV="${SCRIPT_DIR}/../../.stack/.env"
if [[ -f "$STACK_ENV" ]]; then
  # shellcheck source=/dev/null
  set -a; source "$STACK_ENV"; set +a
fi

# Warn (don't die) if secrets look unset.
if [[ -z "${BETTER_AUTH_SECRET:-}" ]]; then
  echo "[mission-control] WARNING: BETTER_AUTH_SECRET is not set in .stack/.env"
  echo "[mission-control]          The container will refuse to start without it."
  echo "[mission-control]          Generate one with: openssl rand -hex 32"
fi

if [[ -z "${MC_ADMIN_TOKEN:-}" ]]; then
  echo "[mission-control] INFO: MC_ADMIN_TOKEN is not set — /v1/bootstrap will be disabled."
  echo "[mission-control]       Set it to bootstrap the first user, then you can unset it."
fi

# Build the Docker image.
cd "$SCRIPT_DIR"
IMAGE_TAG="${MC_IMAGE:-mission-control:local}"
echo "[mission-control] building image: $IMAGE_TAG"
docker build -t "$IMAGE_TAG" .
echo "[mission-control] build complete: $IMAGE_TAG"
