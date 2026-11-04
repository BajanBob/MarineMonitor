"""Software receiver: tunes a radio (Icom IC-9100 over CI-V, Kenwood TH-D74 over its USB COM port) through a
channel plan and decodes its USB audio. Each radio hears one frequency at a time. Modes:
  ais-scan  AIS 1 and AIS 2 alternately (dwell seconds each)    ais-a / ais-b  one AIS channel only
  dsc70     VHF DSC Ch 70 (software decoder; the UM435 also watches Ch 70 as Band A)
  ais-dsc   AIS 1, AIS 2 and DSC Ch 70 in turn                   hf-dsc  MF/HF DSC distress frequencies in turn
"""
import threading, time
from dataclasses import dataclass
import numpy as np
import mmdsp


@dataclass(frozen=True)
class Chan:
    name: str
    freq: int          # assigned frequency (Hz)
    dial: int          # what the radio is tuned to
    mode: str          # FM or USB
    kind: str          # 'ais' | 'dsc-vhf' | 'dsc-hf'
    ais_ch: str = ''


AIS1 = Chan('AIS 1 (Ch 87B)', 161_975_000, 161_975_000, 'FM', 'ais', 'A')
AIS2 = Chan('AIS 2 (Ch 88B)', 162_025_000, 162_025_000, 'FM', 'ais', 'B')
HFDSC = [Chan(f'HF DSC {k:g} kHz', int(k * 1000), int(k * 1000) - 1700, 'USB', 'dsc-hf') for k in (2187.5, 4207.5, 6312, 8414.5, 12577, 16804.5)]


def plans(label='IC-9100'):
    dsc70 = Chan(f'DSC Ch 70 ({label})', 156_525_000, 156_525_000, 'FM', 'dsc-vhf')
    return {'ais-scan': [AIS1, AIS2], 'ais-a': [AIS1], 'ais-b': [AIS2], 'dsc70': [dsc70], 'ais-dsc': [AIS1, AIS2, dsc70], 'hf-dsc': HFDSC}


PLANS = plans()
MODE_NAMES = {'ais-scan': 'AIS scan (87B ⇄ 88B)', 'ais-a': 'AIS 1 only (Ch 87B)', 'ais-b': 'AIS 2 only (Ch 88B)', 'dsc70': 'DSC Ch 70', 'ais-dsc': 'AIS 1 → AIS 2 → DSC 70', 'hf-dsc': 'MF/HF DSC scan'}


class SoftReceiver:
    def __init__(self, emit, rig=None, rate=48000, mode='ais-scan', dwell=20.0, label='IC-9100', key='ic9100'):
        self.emit, self.rig, self.rate, self.label, self.key = emit, rig, rate, label, key
        self.plans = plans(label)
        self.dwell = dwell
        self.buf = np.zeros(0)
        self.lock = threading.Lock()
        self.seen = {}
        self.set_mode(mode)

    def set_mode(self, mode, dwell=None):
        if mode not in self.plans:
            raise ValueError(f'unknown mode {mode}')
        with self.lock:
            self.mode, self.plan, self.idx = mode, self.plans[mode], 0
            if dwell:
                self.dwell = max(2.0, float(dwell))
            self.buf = np.zeros(0)
            self._tune()

    @property
    def chan(self):
        return self.plan[self.idx]

    def _tune(self):
        self.since = time.monotonic()
        if self.rig:
            self.rig.tune(self.chan.dial, self.chan.mode)

    def status(self):
        return {'rig': self.key, 'label': self.label, 'mode': self.mode, 'modeName': MODE_NAMES[self.mode], 'channel': self.chan.name, 'freq': self.chan.freq, 'dwell': self.dwell, 'modes': MODE_NAMES}

    def tick(self):
        """Call regularly: steps to the next channel of a scan after `dwell` seconds."""
        if len(self.plan) > 1 and time.monotonic() - self.since >= self.dwell:
            with self.lock:
                self._decode()
                self.idx = (self.idx + 1) % len(self.plan)
                self.buf = np.zeros(0)
                self._tune()

    def feed(self, samples):
        """Audio from the radio (float, -1..1). Decodes every ~2 s (HF: ~10 s) with overlap."""
        with self.lock:
            self.buf = np.concatenate([self.buf, np.asarray(samples, dtype=float)])
            span = 12 if self.chan.kind == 'dsc-hf' else 2
            if len(self.buf) >= span * self.rate:
                self._decode()
                keep = int((8 if self.chan.kind == 'dsc-hf' else 1) * self.rate)
                self.buf = self.buf[-keep:]

    def flush(self):
        with self.lock:
            self._decode()
            self.buf = np.zeros(0)

    def _new(self, key):
        now = time.monotonic()
        for k in [k for k, t in self.seen.items() if now - t > 30]:
            del self.seen[k]
        if key in self.seen:
            return False
        self.seen[key] = now
        return True

    def _decode(self):
        c, a = self.chan, self.buf
        if len(a) < self.rate * 0.05:
            return
        if c.kind == 'ais':
            for sentences in mmdsp.decode_ais(a, self.rate, c.ais_ch):
                if self._new(sentences[0].split(',')[5]):
                    for s in sentences:
                        self.emit(s, c.name)
        else:
            for call in mmdsp.decode_dsc(a, self.rate, mmdsp.VHF if c.kind == 'dsc-vhf' else mmdsp.HF):
                if self._new(call['nmea']):
                    self.emit(call['nmea'], c.name, {'to': call.get('to'), 'freq': c.freq})


def run_audio(rx, device=None, channel=0):
    """Read the radio's USB audio (needs `pip install sounddevice`) and feed the receiver forever.
    If the sound card is missing or unplugged, keep retrying every 10 s."""
    def cb(indata, frames, t, status):
        rx.feed(indata[:, channel].copy())
    while True:
        try:
            import sounddevice as sd  # needs the PortAudio library (Pi: libportaudio2)
            with sd.InputStream(device=device, channels=channel + 1, samplerate=rx.rate, blocksize=4800, callback=cb):
                print(f"{rx.label} audio connected: {device or 'default sound card'}")
                while True:
                    time.sleep(0.5)
                    rx.tick()
        except Exception as e:  # noqa: BLE001 (PortAudio raises several types)
            print(f"{rx.label} audio ({device or 'default'}): {e} (retrying in 10 s)")
            time.sleep(10)
