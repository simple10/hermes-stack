#!/usr/bin/env bash
# Spawn one socat per mapping in LOCALHOST_PROXY_PORTS (CSV of "listen:target").
# Each socat listens on container:listen and forwards to host.docker.internal:target.
# The container's --add-host=host.docker.internal:host-gateway (set in compose)
# resolves host.docker.internal to the Mac → containers are NOT subject to VM
# network isolation, so this hop works even when the consuming VM is isolated.
#
# Empty LOCALHOST_PROXY_PORTS → sleep forever (the service stays up so future
# recipes can `dc up -d localhost-proxy` idempotently; restart on env change).
set -euo pipefail

if [ -z "${LOCALHOST_PROXY_PORTS:-}" ]; then
  echo "[localhost-proxy] LOCALHOST_PROXY_PORTS is empty — nothing to proxy. Sleeping."
  echo "[localhost-proxy] Set LOCALHOST_PROXY_PORTS=<listen>:<target>[,<listen>:<target>...] in .stack/.env"
  exec sleep infinity
fi

declare -a pids=()
IFS=',' read -r -a mappings <<<"$LOCALHOST_PROXY_PORTS"
for map in "${mappings[@]}"; do
  map="${map// /}"             # strip whitespace
  [ -z "$map" ] && continue
  listen="${map%%:*}"
  target="${map##*:}"
  # If no ':' was present, %% and ## both return $map → bad mapping.
  if [ "$listen" = "$map" ] || [ -z "$listen" ] || [ -z "$target" ]; then
    echo "[localhost-proxy] BAD mapping '$map' (expected listen:target) — skipping"
    continue
  fi
  echo "[localhost-proxy] TCP $listen -> host.docker.internal:$target"
  socat -dd "TCP-LISTEN:$listen,fork,reuseaddr" "TCP:host.docker.internal:$target" &
  pids+=("$!")
done

if [ "${#pids[@]}" -eq 0 ]; then
  echo "[localhost-proxy] no valid mappings parsed — sleeping"
  exec sleep infinity
fi

# If ANY socat dies, exit non-zero so Docker restarts the whole container
# (restart: unless-stopped). Cleaner than letting a dead listener silently
# leave a hole in the proxy table.
trap 'echo "[localhost-proxy] received signal — killing children"; kill "${pids[@]}" 2>/dev/null; exit 143' INT TERM
wait -n
status=$?
echo "[localhost-proxy] a socat exited (status $status) — terminating all so docker restarts us"
kill "${pids[@]}" 2>/dev/null || true
exit "$status"
