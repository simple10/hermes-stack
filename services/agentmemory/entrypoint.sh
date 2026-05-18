#!/bin/sh
# agentmemory first-boot entrypoint (adapted from rohitg00/agentmemory
# deploy/coolify). Runs as root so it can:
#   1. Overwrite the npm-bundled iii-config.yaml (binds 127.0.0.1, relative
#      ./data) with a deploy-tuned one (binds 0.0.0.0, absolute /data paths).
#   2. chown the mounted /data volume to the runtime `node` user.
#   3. HMAC secret: if AGENTMEMORY_SECRET is injected via env (.stack/.env ->
#      compose `environment:`), that value is AUTHORITATIVE — persist it to
#      /data/.hmac so it survives, but never silently diverge from .stack.
#      Only if NOTHING is provided do we generate one (and print it once).
# Then execs the agentmemory CLI under gosu as the unprivileged `node` user.

set -eu

DATA_DIR="${AGENTMEMORY_DATA_DIR:-/data}"
HMAC_FILE="${AGENTMEMORY_HMAC_FILE:-/data/.hmac}"
RUN_AS="node:node"
III_CONFIG="/opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml"

mkdir -p "$DATA_DIR"
chown -R "$RUN_AS" "$DATA_DIR"

cat > "$III_CONFIG" <<'EOF'
workers:
  - name: iii-http
    config:
      port: 3111
      host: 0.0.0.0
      default_timeout: 180000
      cors:
        allowed_origins:
          - "http://localhost:3111"
          - "http://localhost:3113"
          - "http://127.0.0.1:3111"
          - "http://127.0.0.1:3113"
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/state_store.db
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: 3112
      host: 0.0.0.0
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/stream_store
  - name: iii-observability
    config:
      enabled: true
      service_name: agentmemory
      exporter: memory
      sampling_ratio: 1.0
      metrics_enabled: true
      logs_enabled: true
      logs_console_output: true
EOF
chown "$RUN_AS" "$III_CONFIG"

if [ -n "${AGENTMEMORY_SECRET:-}" ]; then
  umask 077
  printf '%s\n' "$AGENTMEMORY_SECRET" > "$HMAC_FILE"
  chmod 600 "$HMAC_FILE"; chown "$RUN_AS" "$HMAC_FILE"
  echo "agentmemory: using injected AGENTMEMORY_SECRET (.stack/.env authoritative)"
elif [ ! -s "$HMAC_FILE" ]; then
  SECRET="$(openssl rand -hex 32)"
  umask 077
  printf '%s\n' "$SECRET" > "$HMAC_FILE"
  chmod 600 "$HMAC_FILE"; chown "$RUN_AS" "$HMAC_FILE"
  echo "================================================================"
  echo "agentmemory: generated HMAC secret on first boot"
  echo "AGENTMEMORY_SECRET=$SECRET"
  echo "Copy into .stack/.env to make it stable across volume resets."
  echo "================================================================"
  AGENTMEMORY_SECRET="$SECRET"
else
  AGENTMEMORY_SECRET="$(cat "$HMAC_FILE")"
fi
export AGENTMEMORY_SECRET

# agentmemory >=0.9.18 runs an interactive first-run wizard whenever
# ~/.agentmemory/preferences.json is missing / firstRunAt is null. On a
# non-TTY (container) that wizard process.exit(0)s -> crash loop. Pre-seed
# preferences as "onboarding already completed" so the CLI goes straight to
# starting the server. Provider/config still come from env (process.env).
NODE_HOME="$(getent passwd node | cut -d: -f6)"; NODE_HOME="${NODE_HOME:-/home/node}"
PREFS_DIR="$NODE_HOME/.agentmemory"
mkdir -p "$PREFS_DIR"
cat > "$PREFS_DIR/preferences.json" <<'EOF'
{
  "schemaVersion": 1,
  "lastAgent": null,
  "lastAgents": [],
  "lastProvider": "openai",
  "skipSplash": true,
  "skipNpxHint": true,
  "skipGlobalInstall": true,
  "skipConsoleInstall": true,
  "firstRunAt": "1970-01-01T00:00:00.000Z"
}
EOF
chown -R "$RUN_AS" "$PREFS_DIR"

exec gosu "$RUN_AS" agentmemory "$@"
