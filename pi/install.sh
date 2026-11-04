#!/usr/bin/env bash
# Marine Monitor station: Raspberry Pi installer (Raspberry Pi OS Bookworm or newer, 64-bit recommended).
# Installs the station helper to /opt/marine-monitor, settings in /etc/marine-monitor.conf,
# and a service that starts at boot. Receive only: nothing here transmits.
#   Usage:  unzip MarineMonitor-*-Pi.zip && cd MarineMonitor-Pi && sudo ./install.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo ./install.sh"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
APP=/opt/marine-monitor
CONF=/etc/marine-monitor.conf

echo "== Installing system packages"
apt-get update -qq
apt-get install -y -qq python3 python3-venv python3-numpy python3-serial libportaudio2 alsa-utils >/dev/null

echo "== Creating the service user (serial ports + audio)"
id marinemon >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin marinemon
usermod -aG dialout,audio marinemon

echo "== Copying the station helper to $APP"
mkdir -p "$APP"
cp -r "$HERE/helper" "$HERE/run.sh" "$HERE/list-devices.sh" "$APP/"
python3 -m venv --system-site-packages "$APP/venv"
"$APP/venv/bin/pip" install -q --upgrade pip
"$APP/venv/bin/pip" install -q -r "$HERE/helper/requirements.txt"
chown -R marinemon:marinemon "$APP"

if [ ! -f "$CONF" ]; then
  echo "== Writing settings to $CONF"
  cp "$HERE/marine-monitor.conf" "$CONF"
else
  echo "== Keeping your existing settings in $CONF"
fi
chmod 640 "$CONF"; chown root:marinemon "$CONF"

echo "== Installing the service"
cp "$HERE/marine-monitor.service" /etc/systemd/system/marine-monitor.service
systemctl daemon-reload
systemctl enable --now marine-monitor.service
sleep 3
systemctl --no-pager --lines=8 status marine-monitor.service || true

IP=$(hostname -I | awk '{print $1}')
cat <<MSG

Marine Monitor station installed.
  1. Put in your FEED_KEY and radios:  sudo nano $CONF
  2. Apply:                            sudo systemctl restart marine-monitor
  Live log:        journalctl -u marine-monitor -f
  Radios & audio:  $APP/list-devices.sh
  In the app:      Settings -> Station receiver = ws://$IP:8765
MSG
