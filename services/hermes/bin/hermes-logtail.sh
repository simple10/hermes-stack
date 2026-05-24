#!/bin/sh
# OrbStack machine "Logs" tab = the machine CONSOLE (/dev/console), NOT journald.
# Mirror signal-bearing Hermes file logs to the console. agent.log is
# intentionally EXCLUDED (DEBUG-spammy, would flood the Logs tab).
# The hermes-dashboard line is rendered in by services/hermes/build.sh
# from the HERMES_LOGTAIL_DASHBOARD lever (true → journalctl tail of the
# unit's journal; false → a no-op comment); see build.sh step 6.
tail -n0 -F /home/__REMOTE_USER__/.hermes/logs/gateway.log 2>/dev/null | sed -u "s/^/[hermes-gateway] /" > /dev/console &
tail -n0 -F /home/__REMOTE_USER__/.hermes/logs/errors.log  2>/dev/null | sed -u "s/^/[hermes-errors] /"  > /dev/console &
__LOGTAIL_DASHBOARD_LINE__
wait
