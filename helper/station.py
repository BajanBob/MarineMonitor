"""Station radio configuration: which radios are connected, on which ports, and how they are used.

The app's Receiver tab edits this over the local network; changes are applied live and saved to station.json.
Receive only: nothing here transmits.
"""
import asyncio, json, os, re, sys, threading
import receiver

DEFAULT = {
    'um435':  {'enabled': False, 'port': '', 'baud': 4800},
    'ic9100': {'enabled': False, 'port': '', 'baud': 19200, 'addr': '0x7C', 'audio': '', 'channel': 0, 'mode': 'ais-a', 'dwell': 20},
    'thd74':  {'enabled': False, 'port': '', 'baud': 9600, 'band': 'B', 'audio': '', 'channel': 0, 'mode': 'ais-b', 'dwell': 20},
}
BAUDS = (1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200)
LABELS = {'um435': 'UM435', 'ic9100': 'IC-9100', 'thd74': 'TH-D74'}


def clean(cfg):
    """Validate a radio configuration from the app (or a file) against the defaults."""
    out = json.loads(json.dumps(DEFAULT))
    cfg = cfg if isinstance(cfg, dict) else {}
    for key, base in out.items():
        src = cfg.get(key) if isinstance(cfg.get(key), dict) else {}
        for k, v in base.items():
            x = src.get(k, v)
            if isinstance(v, bool): x = bool(x)
            elif k == 'baud': x = int(x) if str(x).isdigit() and int(x) in BAUDS else v
            elif k == 'channel': x = 1 if str(x) == '1' else 0
            elif k == 'dwell':
                try: x = min(300.0, max(2.0, float(x)))
                except (TypeError, ValueError): x = v
            elif k == 'mode': x = x if x in receiver.PLANS else v
            elif k == 'band': x = 'A' if str(x).upper() == 'A' else 'B'
            elif k == 'addr': x = x if re.fullmatch(r'0x[0-9A-Fa-f]{2}', str(x)) else v
            else: x = re.sub(r'[\x00-\x1f]', '', str(x or ''))[:160]   # port / audio names
            base[k] = x
    return out


def from_args(a):
    """Initial configuration from the command line."""
    cfg = json.loads(json.dumps(DEFAULT))
    if a.serial: cfg['um435'].update(enabled=True, port=a.serial, baud=a.baud)
    if a.rig == 'ic9100':
        cfg['ic9100'].update(enabled=True, port=a.civ_port or '', baud=a.civ_baud, addr=a.civ_addr, audio=a.audio or '', channel=a.audio_channel, mode=a.mode, dwell=a.dwell)
    if a.d74_port or a.d74_audio:
        cfg['thd74'].update(enabled=True, port=a.d74_port or '', baud=a.d74_baud, band=a.d74_band, audio=a.d74_audio or '', channel=a.d74_audio_channel, mode=a.d74_mode, dwell=a.d74_dwell)
    return clean(cfg)


def list_ports():
    try:
        from serial.tools import list_ports as lp
        return [{'device': p.device, 'description': p.description or ''} for p in lp.comports()][:30]
    except Exception:  # noqa: BLE001
        return []


def list_audio():
    try:
        import sounddevice as sd
        return [{'index': i, 'name': d['name'], 'inputs': d['max_input_channels']} for i, d in enumerate(sd.query_devices()) if d['max_input_channels'] > 0][:30]
    except Exception:  # noqa: BLE001
        return []


class Station:
    def __init__(self, hub, loop, path=None):
        self.hub, self.loop, self.path = hub, loop, path
        self.cfg = clean({})
        self.um_task = None
        self.stops = {}          # rig key -> threading.Event
        self.ports, self.audio = [], []

    def load(self):
        if self.path and os.path.exists(self.path):
            with open(self.path) as f:
                return clean(json.load(f))
        return None

    def save(self):
        if not self.path: return
        tmp = self.path + '.tmp'
        with open(tmp, 'w') as f: json.dump(self.cfg, f, indent=2)
        os.replace(tmp, self.path)

    def refresh_devices(self):
        self.ports, self.audio = list_ports(), list_audio()

    def status(self):
        return {'config': self.cfg, 'ports': self.ports, 'audio': self.audio}

    def stop_all(self):
        if self.um_task: self.um_task.cancel(); self.um_task = None
        for key, ev in list(self.stops.items()):
            ev.set()
            rx = self.hub.rigs.pop(key, None)
            try: getattr(getattr(rx, 'rig', None), 'close', lambda: None)()
            except Exception: pass  # noqa: BLE001
        self.stops.clear()

    def apply(self, cfg, save=True):
        """Stop every radio, then start the enabled ones with the new settings."""
        self.cfg = clean(cfg)
        self.stop_all()
        from marine_helper import serial_reader
        u = self.cfg['um435']
        if u['enabled'] and u['port']:
            self.um_task = asyncio.ensure_future(serial_reader(self.hub, u['port'], u['baud']), loop=self.loop)
        for key in ('ic9100', 'thd74'):
            c = self.cfg[key]
            if c['enabled']: self._start_rig(key, c)
        if save:
            try: self.save()
            except OSError as e: print(f'Could not save {self.path}: {e}', file=sys.stderr)
        print('Radios: ' + (', '.join(f'{LABELS[k]} on {self.cfg[k]["port"] or "(audio only)"}' for k in LABELS if self.cfg[k]['enabled']) or 'none enabled'))

    def _start_rig(self, key, c):
        if key == 'ic9100':
            from icom_civ import Rig
            make = lambda port: Rig(port, c['baud'], int(c['addr'], 16))
        else:
            from kenwood_cat import Rig
            make = lambda port: Rig(port, c['baud'], band=c['band'])
        try:
            rig = make(c['port'] or None)
            if c['port']: rig.main_band()
        except Exception as e:  # noqa: BLE001
            print(f'{LABELS[key]} control port {c["port"]}: {e}. Decoding audio without tuning.', file=sys.stderr)
            rig = make(None)
        emit = lambda line, band, extra=None: asyncio.run_coroutine_threadsafe(self.hub.nmea(line, band, extra), self.loop)
        rx = receiver.SoftReceiver(emit, rig=rig, mode=c['mode'], dwell=c['dwell'], label=LABELS[key], key=key)
        self.hub.rigs[key] = rx
        stop = threading.Event(); self.stops[key] = stop
        dev = int(c['audio']) if str(c['audio']).isdigit() else (c['audio'] or None)
        threading.Thread(target=receiver.run_audio, args=(rx, dev, c['channel'], stop), daemon=True).start()

    def tune(self, key, mode, dwell=None):
        """Change one radio's receive mode (and remember it)."""
        rx = self.hub.rigs.get(key)
        if rx: rx.set_mode(mode, dwell)
        if key in self.cfg and mode in receiver.PLANS:
            self.cfg[key]['mode'] = mode
            if dwell: self.cfg[key]['dwell'] = clean({key: {**self.cfg[key], 'dwell': dwell}})[key]['dwell']
            try: self.save()
            except OSError: pass
