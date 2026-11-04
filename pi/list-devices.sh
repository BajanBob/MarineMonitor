#!/usr/bin/env bash
# Shows the radios' serial ports and the sound cards, for /etc/marine-monitor.conf
echo "== Serial ports (use the /dev/serial/by-id names: they don't change when you re-plug)"
ls -l /dev/serial/by-id/ 2>/dev/null || echo "(none found: is the radio plugged in and switched on?)"
ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null
echo
echo "== Sound cards (IC-9100: 'USB Audio CODEC'; TH-D74: its own name; Plugable: 'USB Audio Device')"
PY=/opt/marine-monitor/venv/bin/python; [ -x "$PY" ] || PY=python3
"$PY" -c "import sounddevice as sd
for i, d in enumerate(sd.query_devices()):
    if d['max_input_channels'] > 0: print(f\"{i:2}  {d['name']}  (inputs: {d['max_input_channels']})\")" 2>/dev/null || arecord -l
