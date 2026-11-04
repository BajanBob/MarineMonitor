# Marine Monitor

Coast-watch receiver app for **Ocean City coastal station, 8PFX** (Barbados): virtual radar, live chart, GMDSS alerts and marine weather, in a **day** faceplate and a **night (red)** faceplate.

> **Receive only. Not for navigation.** Marine Monitor never transmits. AIS and internet data can be late, missing or wrong. Never use it instead of a watch, radar, or the official GMDSS equipment and services.

## What it shows

| Tab | What |
|---|---|
| **Radar** | Plan-position plot centred on the station, north up, range 3–96 NM. Each target shows bearing and range from 8PFX, course/speed vector, CPA/TCPA. Colours: internet AIS, direct RF, both, aids to navigation, distress (flashing). |
| **Map** | Live OpenStreetMap + OpenSeaMap seamarks with the same ships, the station and the radar range ring. |
| **GMDSS** | DSC calls (distress, urgency, safety, routine), AIS-SART / MOB / EPIRB-AIS devices, 406 MHz beacon IDs, NAVTEX and Inmarsat-C EGC messages, plus NAVAREA IV warnings. Distress gives a flashing banner and an optional alarm tone. |
| **Weather** | Wind (knots and direction), gusts, wave height/period/direction, swell, surface current and drift, tide curve with highs and lows, pressure, visibility. Sources: NOAA GFS/WaveWatch III (via Open-Meteo), NOAA NDBC buoy 41040, and the TBPB (Grantley Adams) METAR issued by the Barbados Meteorological Services. |
| **Receiver** | What each band is doing (VHF: AIS 1/2, DSC Ch 70, Ch 16 voice is listen-only on your radio; MF/HF: NAVTEX 518/490 kHz, HF DSC; UHF: 406 MHz beacons; L-band: Inmarsat-C EGC SafetyNET) and the kit to receive them. |
| **Settings** | Call sign, station name, **grid square** (e.g. `GK03ec`) or "Use my internet location", relay, receiver address, buoy, METAR station. |

### Services and their limits

- **AIS, DSC, NAVTEX, EPIRB/PLB (406 MHz), AIS-SART/MOB, EGC SafetyNET broadcasts:** decoded when a receiver for that band is connected.
- **SSAS (Ship Security Alert System):** cannot be received by design. It is a covert alert sent from the ship straight to its owner/flag state through satellite, so no coastal receiver can hear it.
- **Inmarsat:** only the public EGC SafetyNET broadcasts (MSI). Private ship traffic is not decoded, and must not be.

## How it fits together

```
 Ships ──AIS── internet ──► AISStream.io ─┐
                                          ├─► relay (server/relay.mjs on Render) ──► app (phone / PC / browser)
 Ships ──radio──► receivers ──► helper ───┘                                 ▲
                                   └──────────── same Wi-Fi (ws://…:8765) ──┘
```

- **Internet AIS works straight away** once the relay has an `AISSTREAM_KEY`.
- **Direct RF** needs receivers at the station and the helper (`helper/marine_helper.py`).

## Set up

### 1. The relay (Render)
1. Render → **New → Blueprint** → choose **BajanBob/MarineMonitor** (uses `render.yaml`).
2. Set **AISSTREAM_KEY**: free key from <https://aisstream.io> (sign in with GitHub → API Keys).
3. Set **FEED_KEY**: any long random text, 16+ characters. The station helper uses the same text.
4. The app is then at `https://marine-monitor.onrender.com`. The apps use that address by default.

### 2. The station receivers (when you have hardware)
Any one of these is enough to start; add more later.

| Band | Kit (approx.) | Decoder |
|---|---|---|
| AIS (161.975 / 162.025 MHz) | RTL-SDR Blog V4 (~US$40) + VHF marine antenna, or a dAISy receiver | AIS-catcher: `AIS-catcher -d:0 -u 127.0.0.1 10110` |
| DSC Ch 70 | A DSC VHF with NMEA out, or a 2nd SDR + DSC decoder | `--serial COM3 --baud 4800` |
| NAVTEX 518/490 kHz | RTL-SDR Blog V4 (HF direct sampling) or SDRplay + long wire / active loop | A NAVTEX decoder writing to `navtex.txt` |
| 406 MHz beacons | RTL-SDR + 406 MHz antenna | A 406 decoder writing beacon hex IDs to `epirb.txt` |
| Inmarsat-C EGC (1537–1545 MHz) | L-band patch antenna + LNA + SDR | An EGC decoder writing messages to `egc.txt` |

Run the helper on the PC/Raspberry Pi next to the receivers (Python 3.9+):

```bash
pip install websockets pyserial
python helper/marine_helper.py --relay https://marine-monitor.onrender.com --feed-key "YOUR FEED_KEY" \
       --navtex-file navtex.txt --epirb-file epirb.txt --egc-file egc.txt
```

It listens for NMEA on UDP 10110, serves the app on the station Wi-Fi at `ws://<pc-address>:8765` (Settings → Station receiver), and pushes everything to the relay so phones anywhere see it.

### 3. The apps
Built by **Actions → Marine Monitor apps** and attached to each GitHub Release: Android APK, Windows installer and portable .exe, unsigned iPhone .ipa. For a permanent Android signing key add the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`marinemonitor`), `ANDROID_KEY_PASSWORD`. Without them each build uses a temporary key.

## Develop

```bash
npm install
npm test           # decoders, geography, relay
npm run test:e2e   # browser test with canned data
npm start          # relay + app on http://127.0.0.1:8800
```

No runtime dependencies. Leaflet 1.9.4 is bundled in `www/vendor` (BSD-2-Clause).
