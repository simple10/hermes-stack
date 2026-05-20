#!/bin/sh
# OrbStack machine "Logs" tab = the machine CONSOLE (/dev/console), NOT journald.
# Mirror signal-bearing Hermes file logs to the console. agent.log is
# intentionally EXCLUDED (DEBUG-spammy, would flood the Logs tab).
tail -n0 -F /home/__REMOTE_USER__/.hermes/logs/gateway.log 2>/dev/null | sed -u "s/^/[hermes-gateway] /" > /dev/console &
tail -n0 -F /home/__REMOTE_USER__/.hermes/logs/errors.log  2>/dev/null | sed -u "s/^/[hermes-errors] /"  > /dev/console &
wait
