# Marine Monitor station: Raspberry Pi

Runs the station helper on a Raspberry Pi (Pi 4 or Pi 5 with Raspberry Pi OS Bookworm, 64-bit, recommended).
It connects the station radios to the Marine Monitor app. **Receive only: nothing here transmits.**

Use a **separate Pi** from the vesseltracker.com Raspberry Pi, and leave theirs as it is.

## Install
1. Copy `MarineMonitor-<version>-Pi.zip` to the Pi.
2. Run:
   ```
   unzip MarineMonitor-*-Pi.zip && cd MarineMonitor-Pi && sudo ./install.sh
   ```
3. Edit the settings with `sudo nano /etc/marine-monitor.conf`:
   - Put your **FEED_KEY** (the one set on Render) in place of `PUT-YOUR-FEED_KEY-HERE`.
   - Un-comment the lines for the radios you have connected.
4. Apply them: `sudo systemctl restart marine-monitor`.
5. In the app, set **Settings → Station receiver** to `ws://<pi-address>:8765` (the installer prints the address).

## Radios
| Radio | Cable | Settings line |
|---|---|---|
| Uniden UM435 (DSC watch) | NMEA OUT → USB-NMEA (RS-422) adapter | `UM435=(--serial /dev/ttyUSB0 --baud 4800)` |
| Icom IC-9100 | USB (CI-V + audio). Menu: CI-V USB Echo Back OFF, CI-V baud 19200 | `IC9100=(--rig ic9100 --civ-port /dev/ttyUSB1 --audio "USB Audio CODEC" --mode ais-a)` |
| Kenwood TH-D74 | micro-USB. Menu 980 = COM+AF/IF Output, Menu 102 = Detect | `THD74=(--d74-port /dev/ttyACM0 --d74-audio "TH-D74" --d74-mode ais-b)` |

Run `/opt/marine-monitor/list-devices.sh` to see the real port and sound-card names. Use the `/dev/serial/by-id/...` names, which stay the same when cables are re-plugged.

## Useful commands
- Live log: `journalctl -u marine-monitor -f`
- Restart after changing settings: `sudo systemctl restart marine-monitor`
- Stop: `sudo systemctl stop marine-monitor`
- Start at boot: `sudo systemctl enable marine-monitor`

## Sharing and the network check
- **Sharing:** add `SHARE=(--forward vesseltracker=HOST:PORT)` to share the AIS your radios hear. Ask each AIS network for its UDP host and port.
- **Network check:** every 10 minutes the station tests the vesseltracker tunnel (TCP 22 to 83.220.137.136 and 85.10.199.209), time sync (UDP 123) and the relay. The results are in the app's Receiver tab.
