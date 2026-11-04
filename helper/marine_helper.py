#!/usr/bin/env python3
"""Marine Monitor station helper — the "direct RF" side. RECEIVE ONLY.

Runs at the coastal station on a PC or Raspberry Pi next to the receivers. It collects:
  * NMEA over UDP (default port 10110) — AIS from AIS-catcher / rtl_ais, DSC ($--DSC) from a
    marine VHF/DSC radio or a DSC decoder, anything else that speaks NMEA 0183;
  * NMEA from a serial port with --serial: the Uniden UM435 (DSC Class D, Ch 70 watch) sends $CDDSC/$CDDSE
    at 4800 baud from its NMEA OUT wires (use a USB-to-RS422/NMEA adapter);
  * the Icom IC-9100 as a software receiver with --rig ic9100: Marine Monitor tunes it over CI-V and
    decodes its USB audio itself (AIS 1/2 scan or single channel, VHF DSC Ch 70, MF/HF DSC);
  * the Kenwood TH-D74 the same way with --d74-port: tuned over its USB COM port, decoding its USB audio
    (Menu 980 = COM+AF/IF Output, Menu 102 = Detect). With both radios each can hold one AIS channel;
  * decoded text from NAVTEX / Inmarsat-C EGC / 406 MHz decoders, appended to text files
    (--navtex-file, --egc-file, --epirb-file) by those programs;
and sends it to:
  * the Marine Monitor app on the local network over WebSocket (port 8765), and/or
  * the Marine Monitor relay (--relay URL --feed-key KEY) so phones anywhere see it.

It never transmits on any radio. Python 3.9+. Optional: `pip install websockets pyserial`.

Typical receiver chains (any one is enough to start):
  AIS (2 channels, one RTL-SDR):   AIS-catcher -d:0 -u 127.0.0.1 10110
  Band A, DSC Ch 70 (Uniden UM435):   --serial COM3 --baud 4800
  Band B, Icom IC-9100 (USB cable):   --rig ic9100 --civ-port COM4 --audio "USB Audio CODEC" --mode ais-a
  Band C, Kenwood TH-D74 (USB cable): --d74-port COM5 --d74-audio "TH-D74" --d74-mode ais-b
  NAVTEX 518 kHz:                  an HF SDR (RTL-SDR Blog V4 / SDRplay) + a NAVTEX decoder writing text to navtex.txt
  406 MHz EPIRB/PLB bursts:        RTL-SDR + a 406 decoder writing beacon hex IDs to epirb.txt
  Inmarsat-C EGC SafetyNET:        L-band antenna + LNA + SDR + an EGC decoder writing messages to egc.txt
"""
import argparse, asyncio, json, os, re, socket, sys, time, urllib.request

HEX15 = re.compile(r"\b([0-9A-Fa-f]{15})\b")


class Hub:
    def __init__(self, relay=None, feed_key=None):
        self.clients = set()
        self.relay, self.feed_key = relay, feed_key
        self.lines, self.alerts = [], []
        self.bands = {}  # channel name -> {"live": bool, "count": n, "last": t}
        self.rigs = {}   # key -> SoftReceiver ('ic9100', 'thd74')
        self.station = None  # station.Station: radio configuration editable from the app
        self.net = None  # last station network check (netcheck.run)
        self.netcheck_args = {}
        self.forwards = []  # [{name, host, port, sent, last}] — AIS heard by radio, shared with AIS networks over UDP
        self.fsock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def heard(self, band):
        b = self.bands.setdefault(band, {"live": False, "count": 0, "last": 0})
        b["count"] += 1; b["last"] = time.time(); b["live"] = True

    async def broadcast(self, obj):
        msg = json.dumps(obj)
        for ws in list(self.clients):
            try: await ws.send(msg)
            except Exception: self.clients.discard(ws)

    async def nmea(self, line, band=None, extra=None):
        line = line.strip()
        if not line or line[0] not in "!$": return
        if band: self.heard(band)
        elif "VDM" in line[:7] or "VDO" in line[:7]:
            self.heard("AIS 1 (Ch 87B)" if ",A," in line[:20] else "AIS 2 (Ch 88B)")
        elif line[3:6] in ("DSC", "DSE"):
            self.heard("DSC Ch 70 (UM435)")
        if line[3:6] == "DSE": return  # position extension: the app shows DSC positions already
        if self.forwards and line[3:6] in ("VDM", "VDO"): self.forward(line)
        if line[3:6] == "DSC" and extra and (extra.get("to") or extra.get("area")):
            self.alerts.append({"kind": "dsc", "line": line, "to": extra.get("to"), "area": extra.get("area"), "freq": extra.get("freq")})
        else:
            self.lines.append(line)
        await self.broadcast({"type": "nmea", "line": line, **({"to": extra.get("to"), "area": extra.get("area"), "freq": extra.get("freq")} if extra else {})})

    async def alert(self, kind, **fields):
        band = {"navtex": "NAVTEX (international)", "egc": "Inmarsat-C EGC SafetyNET", "epirb": "EPIRB / PLB (COSPAS-SARSAT)"}[kind]
        self.heard(band)
        a = {"kind": kind, **fields}
        self.alerts.append(a)
        await self.broadcast({"type": "alert", **a})

    async def status_loop(self):
        n = 0
        while True:
            if self.station and n % 6 == 0: await asyncio.to_thread(self.station.refresh_devices)
            n += 1
            now = time.time()
            for b in self.bands.values(): b["live"] = now - b["last"] < 600
            await self.broadcast(self.status())
            await asyncio.sleep(10)

    def forward(self, line):
        """Share an AIS sentence received by radio with each AIS network (vesseltracker, AISHub, MarineTraffic…)."""
        data = (line + "\r\n").encode("ascii", "ignore")
        for f in self.forwards:
            try:
                self.fsock.sendto(data, (f["host"], f["port"])); f["sent"] += 1; f["last"] = int(time.time() * 1000); f["error"] = None
            except OSError as e:
                f["error"] = str(e)[:80]

    def status(self):
        rigs = {k: r.status() for k, r in self.rigs.items()}
        return {"type": "status", "bands": self.bands, "rigs": rigs, "rx": next(iter(rigs.values()), None), "net": self.net,
                "forwards": [{k: f[k] for k in ("name", "host", "port", "sent", "last", "error")} for f in self.forwards],
                **({"station": self.station.status()} if self.station else {})}

    async def run_netcheck(self):
        import netcheck
        self.net = await asyncio.to_thread(netcheck.run, **self.netcheck_args)
        bad = [c["name"] for c in self.net["checks"] if not c["ok"]]
        print("Network check: " + ("all OK" if not bad else "FAILED: " + ", ".join(bad)))
        await self.broadcast(self.status())

    async def netcheck_loop(self):
        while True:
            try: await self.run_netcheck()
            except Exception as e: print(f"network check error: {e}", file=sys.stderr)
            await asyncio.sleep(600)

    async def command(self, msg):
        """From the app on the local network: change the IC-9100 scan plan. Receive-side only."""
        if msg.get("type") == "netcheck":
            await self.run_netcheck(); return
        if msg.get("type") == "config" and self.station:
            self.station.apply(msg.get("radios"))
            await self.broadcast(self.status()); return
        if msg.get("type") == "rescan" and self.station:
            await asyncio.to_thread(self.station.refresh_devices)
            await self.broadcast(self.status()); return
        if msg.get("type") == "tune":
            key = str(msg.get("rig") or "ic9100")
            try:
                if self.station: await asyncio.to_thread(self.station.tune, key, str(msg.get("mode")), msg.get("dwell"))
                elif key in self.rigs: await asyncio.to_thread(self.rigs[key].set_mode, str(msg.get("mode")), msg.get("dwell"))
            except ValueError: return
            await self.broadcast(self.status())

    async def push_loop(self):
        """Send what was heard to the relay every few seconds (only if a relay and key are set)."""
        while self.relay and self.feed_key:
            await asyncio.sleep(5)
            if not self.lines and not self.alerts and int(time.time()) % 60 > 5: continue
            st = self.status()
            body = json.dumps({"lines": self.lines[:2000], "alerts": self.alerts[:200], "bands": st["bands"], "rx": st["rx"], "rigs": st["rigs"], "net": st["net"], "forwards": st["forwards"]}).encode()
            self.lines, self.alerts = self.lines[2000:], self.alerts[200:]
            req = urllib.request.Request(self.relay.rstrip("/") + "/api/feed", data=body, method="POST",
                                         headers={"content-type": "application/json", "x-feed-key": self.feed_key})
            try:
                await asyncio.to_thread(urllib.request.urlopen, req, None, 15)
            except Exception as e:
                print(f"relay push failed: {e}", file=sys.stderr)


class Udp(asyncio.DatagramProtocol):
    def __init__(self, hub): self.hub = hub
    def datagram_received(self, data, addr):
        for line in data.decode("ascii", "ignore").splitlines():
            asyncio.ensure_future(self.hub.nmea(line))


async def follow(path, on_text, split_on=None):
    """Tail a text file that a decoder appends to."""
    while not os.path.exists(path): await asyncio.sleep(2)
    with open(path, "r", errors="ignore") as f:
        f.seek(0, 2); buf = ""
        while True:
            chunk = f.read()
            if not chunk: await asyncio.sleep(1); continue
            buf += chunk
            if split_on:
                while split_on in buf:
                    part, buf = buf.split(split_on, 1)
                    await on_text(part + split_on)
            else:
                *done, buf = buf.split("\n")
                for line in done: await on_text(line)


async def serial_reader(hub, port, baud):
    """NMEA from a serial port (UM435). If the radio or adapter is unplugged, keep retrying every 10 s."""
    try:
        import serial  # pyserial
    except ImportError:
        print("pip install pyserial to read a serial NMEA device", file=sys.stderr); return
    while True:
        s = None
        try:
            s = serial.Serial(port, baud, timeout=1)
            print(f"Serial NMEA connected: {port} at {baud} baud")
            while True:
                line = await asyncio.to_thread(s.readline)
                if line: await hub.nmea(line.decode("ascii", "ignore"))
        except (OSError, serial.SerialException) as e:
            print(f"Serial {port}: {e} (retrying in 10 s)", file=sys.stderr)
            await asyncio.sleep(10)
        finally:
            if s: s.close()


async def main():
    ap = argparse.ArgumentParser(description="Marine Monitor station helper (receive only)")
    ap.add_argument("--udp", type=int, default=10110, help="UDP port for NMEA (AIS-catcher, rtl_ais, OpenCPN-style)")
    ap.add_argument("--serial", help="serial NMEA device, e.g. /dev/ttyUSB0 or COM3")
    ap.add_argument("--baud", type=int, default=38400, help="38400 for AIS, 4800 for most DSC radios")
    ap.add_argument("--ws", type=int, default=8765, help="WebSocket port for the app on the local network (0 = off)")
    ap.add_argument("--relay", help="Marine Monitor relay URL, e.g. https://marine-monitor-16qf.onrender.com")
    ap.add_argument("--feed-key", default=os.environ.get("FEED_KEY"), help="the relay's FEED_KEY")
    ap.add_argument("--navtex-file"); ap.add_argument("--egc-file"); ap.add_argument("--epirb-file")
    ap.add_argument("--rig", choices=["ic9100", "none"], default="none", help="radio used as a software receiver (Band B)")
    ap.add_argument("--civ-port", help="IC-9100 CI-V port, e.g. COM4 or /dev/ttyUSB1 (omit for audio only)")
    ap.add_argument("--civ-baud", type=int, default=19200); ap.add_argument("--civ-addr", default="0x7C")
    ap.add_argument("--audio", help="sound device name/number of the radio's USB audio (default: system default)")
    ap.add_argument("--audio-channel", type=int, default=0, help="0 = left/main, 1 = right")
    ap.add_argument("--mode", default="ais-scan", help="ais-scan | ais-a | ais-b | dsc70 | ais-dsc | hf-dsc")
    ap.add_argument("--dwell", type=float, default=20, help="seconds on each channel when scanning")
    ap.add_argument("--d74-port", help="Kenwood TH-D74 USB COM port, e.g. COM5 or /dev/ttyACM0 (enables the TH-D74)")
    ap.add_argument("--d74-audio", help="sound device name/number of the TH-D74's USB audio")
    ap.add_argument("--d74-band", default="B", choices=["A", "B"], help="TH-D74 band to use (B covers HF too)")
    ap.add_argument("--d74-mode", default="ais-b", help="ais-scan | ais-a | ais-b | dsc70 | ais-dsc | hf-dsc")
    ap.add_argument("--d74-dwell", type=float, default=20)
    ap.add_argument("--d74-baud", type=int, default=9600, help="TH-D74 USB COM baud rate (9600)")
    ap.add_argument("--d74-audio-channel", type=int, default=0, help="0 = left, 1 = right")
    ap.add_argument("--forward", action="append", default=[], metavar="NAME=HOST:PORT",
                    help="share AIS heard by radio with an AIS network over UDP, e.g. vesseltracker=HOST:PORT (repeatable)")
    ap.add_argument("--config", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "station.json"), help="where radio settings from the app are saved")
    ap.add_argument("--no-netcheck", action="store_true", help="don't run the station network check (vesseltracker TCP 22, NTP, relay)")
    ap.add_argument("--check", action="append", default=[], metavar="NAME=HOST:PORT", help="extra TCP address to test, e.g. MarineTraffic=5.9.207.224:10000")
    a = ap.parse_args()
    hub = Hub(a.relay, a.feed_key)
    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(lambda: Udp(hub), local_addr=("0.0.0.0", a.udp))
    tasks = [hub.status_loop(), hub.push_loop()]
    hub.netcheck_args = {"relay": a.relay, "extra": a.check}
    for item in a.forward:
        name, _, hp = item.rpartition("=")
        host, _, port = hp.rpartition(":")
        if not host or not port.isdigit(): ap.error(f"--forward needs NAME=HOST:PORT, got {item!r}")
        hub.forwards.append({"name": name or host, "host": host, "port": int(port), "sent": 0, "last": None, "error": None})
        print(f"Sharing radio AIS with {name or host} ({host}:{port} UDP)")
    if not a.no_netcheck: tasks.append(hub.netcheck_loop())
    # Radios: station.json (edited from the app's Receiver tab) wins; command-line radio options seed it the first time.
    import station as st
    hub.station = st.Station(hub, loop, a.config)
    saved = hub.station.load()
    seeded = st.from_args(a)
    if saved and any(saved[k]["enabled"] for k in saved):
        print(f"Radio settings from {a.config} (change them in the app's Receiver tab)")
        cfg = saved
    else:
        cfg = seeded
    await asyncio.to_thread(hub.station.refresh_devices)
    hub.station.apply(cfg, save=bool(any(cfg[k]["enabled"] for k in cfg)))
    if a.navtex_file: tasks.append(follow(a.navtex_file, lambda t: hub.alert("navtex", text=t) if "ZCZC" in t else asyncio.sleep(0), split_on="NNNN"))
    if a.egc_file: tasks.append(follow(a.egc_file, lambda t: hub.alert("egc", text=t.strip()) if t.strip() else asyncio.sleep(0)))
    async def epirb_line(t):
        m = HEX15.search(t)
        if m: await hub.alert("epirb", hex=m.group(1).upper())
    if a.epirb_file: tasks.append(follow(a.epirb_file, epirb_line))
    if a.ws:
        try:
            import websockets
            async def handler(ws, *_):
                hub.clients.add(ws)
                await ws.send(json.dumps(hub.status()))
                try:
                    async for raw in ws:
                        try: await hub.command(json.loads(raw))
                        except (ValueError, TypeError, AttributeError): pass
                finally: hub.clients.discard(ws)
            async def ws_server():
                async with websockets.serve(handler, "0.0.0.0", a.ws, max_size=4096):
                    await asyncio.Future()
            tasks.append(ws_server())
            print(f"App connection: ws://{socket.gethostbyname(socket.gethostname())}:{a.ws}")
        except ImportError:
            print("pip install websockets to let the app connect on the local network", file=sys.stderr)
    print(f"Listening for NMEA on UDP {a.udp}" + (f", pushing to {a.relay}" if a.relay and a.feed_key else ""))
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
