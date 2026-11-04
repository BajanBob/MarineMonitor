# Marine Monitor

Coast-watch receiver app for **Ocean City coastal station, 8PFX** (Barbados): virtual radar, live chart, GMDSS alerts, MMSI tools and marine weather, in a **day** faceplate and a **night (red)** faceplate.

**Station area:** grid squares **GK03ec** (Bridgetown, south-west) to **GK03ff** (Bathsheba, north-east). Bearings and ranges are measured from the south-west square by default (Settings → *Bearings measured from*).

**Radios:**
- **Band A, Uniden UM435:** a type-approved DSC Class D radio. It keeps a constant watch on Ch 70 and sends every DSC call it receives to Marine Monitor (`$CDDSC`, NMEA OUT, 4800 baud). DSC calls are transmitted only by this radio.
- **Band B, Icom IC-9100:** used as a software receiver. Marine Monitor tunes it over CI-V and decodes its USB audio itself:
  - AIS scan (Ch 87B ⇄ 88B), or AIS 1 or AIS 2 on its own;
  - VHF DSC Ch 70, or AIS + DSC in turn;
  - MF/HF DSC (2187.5 / 4207.5 / 6312 / 8414.5 / 12577 / 16804.5 kHz).
- **Band C, Kenwood TH-D74:** a second software receiver, tuned over its USB COM port, with its USB audio decoded the same way and the same modes.
  - TH-D74 menus: **980 USB Function** = *COM+AF/IF Output*; **102 Detect Out** = *Detect* for AIS and VHF DSC (flat FM-detector audio, the best for 9600-baud AIS), or *Off (AF)* for HF DSC; **918 USB audio level** about 5; squelch open.
  - Marine Monitor tunes Band B, which covers 0.1–524 MHz including HF USB.
  - With both radios, put the **IC-9100 on AIS 1** and the **TH-D74 on AIS 2**, so both AIS channels are heard all the time.

> **Receive only. Not for navigation.** Marine Monitor never transmits. AIS and internet data can be late, missing or wrong. Never use it instead of a watch, radar, or the official GMDSS equipment and services.

## What it shows

| Tab | What |
|---|---|
| **Radar** | AIS source switch (**Internet / RF / Both**). Plan-position plot centred on the station, north up, range 3–96 NM. Each target shows bearing and range from 8PFX, course/speed vector, CPA/TCPA. Colours: internet AIS, direct RF, both, aids to navigation, distress (flashing). |
| **Map** | Live OpenStreetMap + OpenSeaMap seamarks with the same ships, the station and the radar range ring. |
| **GMDSS** | DSC source switch (**Internet / RF / Both**). DSC calls (distress, urgency, safety, routine), AIS-SART / MOB / EPIRB-AIS devices, 406 MHz beacon IDs, NAVTEX and Inmarsat-C EGC messages, plus NAVAREA IV warnings. Distress gives a flashing banner and an optional alarm tone. |
| **MMSI** | **MMSI decoder** (ship, coast station, group, SAR aircraft, AtoN, SART/MOB/EPIRB, country from the MID), **directory** of ships and groups, **individual and group DSC calls**: the app shows the exact ITU-R M.493 sequence and the UM435 steps, logs the call and marks it ✓ when the acknowledgement is heard. Calls addressed to your station MMSI or your groups are flagged. |
| **Weather** | Wind (knots and direction), gusts, wave height/period/direction, swell, surface current and drift, tide curve with highs and lows, pressure, visibility. Sources: NOAA GFS/WaveWatch III (via Open-Meteo), NOAA NDBC buoy 41040, and the TBPB (Grantley Adams) METAR issued by the Barbados Meteorological Services. |
| **Receiver** | Band A (UM435) and Band B (IC-9100) channel by channel, what is live, what the IC-9100 is tuned to, and its scan mode and dwell. The scan mode can be changed from the app on the station's local network. Optional extra receivers: NAVTEX, 406 MHz, EGC. |
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
4. The app is then at `https://marine-monitor-16qf.onrender.com`. The apps use that address by default.

### 2. The station radios

```bash
pip install -r helper/requirements.txt
python helper/marine_helper.py \
  --serial COM3 --baud 4800 \
  --rig ic9100 --civ-port COM4 --mode ais-scan --dwell 20 \
  --relay https://marine-monitor-16qf.onrender.com --feed-key "YOUR FEED_KEY"
```

The `--serial` line is the UM435 (through a USB-to-NMEA/RS-422 adapter on its NMEA OUT wires). The `--rig` line is the IC-9100: one USB cable carries both CI-V and audio.

IC-9100 menu settings:
- CI-V USB Echo Back **OFF**
- CI-V baud **19200**
- USB audio output level about **50%**

Use `--audio` to choose the sound device if the radio isn't the default one. For the TH-D74 add `--d74-port COM5 --d74-audio "TH-D74" --d74-mode ais-b`. Modes: `ais-scan`, `ais-a`, `ais-b`, `dsc70`, `ais-dsc`, `hf-dsc`.

> The IC-9100's main receiver hears one frequency at a time, so AIS scan catches each AIS channel about half the time. FM audio filtering also limits AIS decoding (9600 baud). Busy waters need a dedicated dual-channel AIS receiver such as a dAISy or an RTL-SDR with AIS-catcher; those feed the same helper over UDP 10110. DSC (1200 and 100 baud) decodes well from the IC-9100.

#### Other receivers you can add
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
python helper/marine_helper.py --relay https://marine-monitor-16qf.onrender.com --feed-key "YOUR FEED_KEY" \
       --navtex-file navtex.txt --epirb-file epirb.txt --egc-file egc.txt
```

It listens for NMEA on UDP 10110, serves the app on the station Wi-Fi at `ws://<pc-address>:8765` (Settings → Station receiver), and pushes everything to the relay so phones anywhere see it.

### 3. The apps
Built by **Actions → Marine Monitor apps** and attached to each GitHub Release: Android APK, Windows installer and portable .exe, unsigned iPhone .ipa. For a permanent Android signing key add the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`marinemonitor`), `ANDROID_KEY_PASSWORD`. Without them each build uses a temporary key.

## Develop

```bash
npm install
npm test           # decoders, geography, relay
python -m unittest discover -s tests -p 'test_dsp.py'   # software receiver (needs numpy)
npm run test:e2e   # browser test with canned data
npm start          # relay + app on http://127.0.0.1:8800
```

No runtime dependencies. Leaflet 1.9.4 is bundled in `www/vendor` (BSD-2-Clause).
