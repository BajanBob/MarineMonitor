#!/usr/bin/env bash
# Started by the marine-monitor service: reads /etc/marine-monitor.conf and runs the station helper.
set -euo pipefail
RELAY=(); UM435=(); IC9100=(); THD74=(); SHARE=(); EXTRA=()
# shellcheck disable=SC1091
source /etc/marine-monitor.conf
if [[ " ${RELAY[*]} " == *PUT-YOUR-FEED_KEY-HERE* ]]; then
  echo "No FEED_KEY set in /etc/marine-monitor.conf: running on the local network only (no relay)."; RELAY=()
fi
cd /opt/marine-monitor/helper
exec /opt/marine-monitor/venv/bin/python -u marine_helper.py "${RELAY[@]}" "${UM435[@]}" "${IC9100[@]}" "${THD74[@]}" "${SHARE[@]}" "${EXTRA[@]}"
