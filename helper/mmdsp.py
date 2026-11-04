"""Marine Monitor software receiver: decoders for audio from a radio such as the Icom IC-9100.

RECEIVE ONLY. Turns receiver audio into the same NMEA sentences a hardware decoder would give:
  * DSC (ITU-R M.493): VHF Ch 70 (1200 baud, 1300/2100 Hz FM audio) and MF/HF (100 baud,
    1615/1785 Hz in USB audio with the dial 1.7 kHz below the assigned frequency).
    Output: $CDDSC sentences (+ the called address, which NMEA leaves out).
  * AIS: 9600 baud GMSK from FM discriminator audio (NRZI, HDLC, CRC-16). Output: !AIVDM sentences.
Needs numpy. Audio is float samples in -1..1 at any rate (48 kHz recommended).
"""
import numpy as np

# --------------------------------------------------------------------------- DSC (ITU-R M.493)
EOS = (117, 122, 127)          # 117 = ack requested, 122 = ack given, 127 = other
EOS_FLAG = {117: 'R', 122: 'B', 127: 'S'}
FORMATS = {102: 'area', 112: 'distress', 114: 'group', 116: 'all ships', 120: 'individual', 123: 'individual (auto)'}
VHF = dict(baud=1200, f_b=2100.0, f_y=1300.0)
HF = dict(baud=100, f_b=1785.0, f_y=1615.0)


def sym_bits(v):
    """10-bit DSC character: 7 information bits LSB first (Y=1, B=0), then the count of B bits, MSB first."""
    info = [(v >> i) & 1 for i in range(7)]
    zeros = info.count(0)
    return info + [(zeros >> 2) & 1, (zeros >> 1) & 1, zeros & 1]


def _symbols_at_every_bit(bits):
    """Value of the 10-bit character starting at every bit position; -1 where the check bits fail."""
    b = np.asarray(bits, dtype=np.int16)
    n = len(b) - 9
    if n <= 0:
        return np.zeros(0, dtype=np.int16)
    w = np.lib.stride_tricks.sliding_window_view(b, 10)[:n]
    info = w[:, :7]
    val = (info * (1 << np.arange(7))).sum(axis=1)
    zeros = 7 - info.sum(axis=1)
    chk = w[:, 7] * 4 + w[:, 8] * 2 + w[:, 9]
    return np.where(chk == zeros, val, -1).astype(np.int16)


def fsk_bits(audio, rate, baud, f_b, f_y, phase):
    """Non-coherent FSK: energy at each tone over one bit, sampled once per bit from `phase`."""
    spb = rate / baud
    t = np.arange(len(audio)) / rate
    n = max(2, int(round(spb)))
    k = np.ones(n) / n
    mb = np.abs(np.convolve(audio * np.exp(-2j * np.pi * f_b * t), k, 'same'))
    my = np.abs(np.convolve(audio * np.exp(-2j * np.pi * f_y * t), k, 'same'))
    idx = np.round(np.arange(phase, len(audio) - 1, spb)).astype(int)
    idx = idx[idx < len(audio)]
    return (my[idx] > mb[idx]).astype(np.int8)


def _digits(syms):
    return ''.join(f'{s:02d}' for s in syms)


def _read_call(get):
    """Read the message part (from the first format specifier) using get(i) → symbol or None."""
    seq = []
    i = 0
    while i < 60:
        s = get(i)
        if s is None:
            return None
        seq.append(s)
        if i >= 8 and s in EOS:
            ecc = get(i + 1)
            if ecc is None:
                return None
            x = 0
            for v in seq[1:]:           # format specifier once, then everything up to and including EOS
                x ^= v
            return seq if x == ecc else None
        i += 1
    return None


def parse_call(seq):
    """Symbols (F F … EOS) → dict with the fields of the call."""
    f = seq[0]
    if f not in FORMATS or seq[1] != f:
        return None
    r = seq[2:-1]
    eos = seq[-1]
    out = {'format': f, 'formatName': FORMATS[f], 'eos': eos, 'ack': EOS_FLAG[eos]}
    mm = lambda s: _digits(s)[:9]
    try:
        if f == 112:                                         # distress alert
            out.update(fr=mm(r[0:5]), nature=r[5], position=_digits(r[6:11]), time=_digits(r[11:13]), comm=r[13], category=112)
            return out
        if f in (114, 120, 123):
            out['to'] = mm(r[0:5]); r = r[5:]
        elif f == 102:
            out['area'] = _digits(r[0:5]); r = r[5:]
        out['category'] = r[0]
        out['fr'] = mm(r[1:6])
        r = r[6:]
        if out['category'] == 112:                           # distress relay / acknowledgement
            out.update(tc1=r[0], distressMmsi=mm(r[1:6]), nature=r[6], position=_digits(r[7:12]), time=_digits(r[12:14]), comm=r[14])
        else:
            out.update(tc1=r[0], tc2=r[1], freq=_digits(r[2:]))
        return out
    except (IndexError, ValueError):
        return None


def dsc_nmea(c):
    """Decoded call → $CDDSC sentence (NMEA 0183 field order). Address = the calling station."""
    two = lambda v: '' if v is None else f'{v - 100:02d}' if v >= 100 else f'{v:02d}'
    fmt = f"{c['format'] - 100:02d}"
    addr = c['fr'] + '0'
    cat = two(c.get('category')) if c['format'] != 112 else '12'
    if c['format'] == 112:
        f4, f5, f6, f7 = f"{c['nature']:02d}", two(c.get('comm')), c['position'], c['time']
        f8, f9 = '', ''
    elif c.get('category') == 112:
        f4, f5, f6, f7 = two(c['tc1']), two(c.get('comm')), c['position'], c['time']
        f8, f9 = c['distressMmsi'] + '0', f"{c['nature']:02d}"
    else:
        f4, f5, f6, f7, f8, f9 = two(c['tc1']), two(c['tc2']), c.get('freq', ''), '', '', ''
    body = f"CDDSC,{fmt},{addr},{cat},{f4},{f5},{f6},{f7},{f8},{f9},{c['ack']},"
    return f'${body}*{nmea_cs(body)}'


def nmea_cs(body):
    x = 0
    for ch in body:
        x ^= ord(ch)
    return f'{x:02X}'


def decode_dsc(audio, rate, mode=VHF):
    """All DSC calls in a block of audio → list of dicts (each with 'nmea')."""
    spb = rate / mode['baud']
    found, seen = [], set()
    for ph in np.linspace(0, spb, 8, endpoint=False):
        bits = fsk_bits(audio, rate, mode['baud'], mode['f_b'], mode['f_y'], ph)
        sv = _symbols_at_every_bit(bits)
        L = len(sv)
        cand = np.nonzero(sv[:max(0, L - 20)] == 125)[0]
        for p in cand:
            v = int(sv[p + 10])
            if not 104 <= v <= 111 or int(sv[p + 20]) != 125:
                continue
            j = 111 - v                      # RX phasing index of the character after this DX
            s0 = p - 20 * j                  # bit position of slot 0
            def slot(k):
                q = s0 + 10 * k
                return int(sv[q]) if 0 <= q < L else None
            def get(d):                      # message character d: DX at slot 2(d+6), RX copy at 2(d+8)+1
                a, b = slot(2 * (d + 6)), slot(2 * (d + 8) + 1)
                if a is not None and a >= 0:
                    return a
                if b is not None and b >= 0:
                    return b
                return None
            seq = _read_call(get)
            if not seq:
                continue
            c = parse_call(seq)
            if not c:
                continue
            key = tuple(seq)
            if key in seen:
                continue
            seen.add(key)
            c['nmea'] = dsc_nmea(c)
            found.append(c)
        if found:
            break
    return found


# --------------------------------------------------------------------------- AIS (9600 baud GMSK)
def crc16_x25(data):
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return crc ^ 0xFFFF


def _armour(bits):
    fill = (-len(bits)) % 6
    bits = list(bits) + [0] * fill
    out = []
    for i in range(0, len(bits), 6):
        v = 0
        for b in bits[i:i + 6]:
            v = (v << 1) | b
        out.append(chr(v + 48 if v < 40 else v + 56))
    return ''.join(out), fill


_seq = 0


def ais_sentences(msg_bits, channel='A'):
    """Message bits → one or more !AIVDM sentences."""
    global _seq
    payload, fill = _armour(msg_bits)
    parts = [payload[i:i + 60] for i in range(0, len(payload), 60)] or ['']
    seq = ''
    if len(parts) > 1:
        _seq = (_seq + 1) % 10
        seq = str(_seq)
    out = []
    for k, part in enumerate(parts, 1):
        f = fill if k == len(parts) else 0
        body = f'AIVDM,{len(parts)},{k},{seq},{channel},{part},{f}'
        out.append(f'!{body}*{nmea_cs(body)}')
    return out


def _frames(bits):
    """NRZI-decoded bits → HDLC frames (bit-unstuffed, between 0x7E flags)."""
    s = ''.join('1' if b else '0' for b in bits)
    frames, pos = [], 0
    while True:
        a = s.find('01111110', pos)
        if a < 0:
            break
        b = s.find('01111110', a + 8)
        if b < 0:
            break
        body = s[a + 8:b]
        pos = b
        if len(body) < 56 or len(body) > 1200:
            continue
        frames.append(body.replace('111110', '11111'))
    return frames


def decode_ais(audio, rate, channel='A'):
    """FM discriminator audio → list of !AIVDM sentence lists (one list per message)."""
    x = np.asarray(audio, dtype=float)
    if rate != 48000:
        n = int(len(x) * 48000 / rate)
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    x = x - np.convolve(x, np.ones(480) / 480, 'same')        # remove DC / slow drift
    x = np.convolve(x, np.ones(4) / 4, 'same')                # ≈ matched to one bit (5 samples)
    out, seen = [], set()
    for ph in range(5):
        lv = x[ph::5] > 0
        nrzi = np.empty(len(lv), dtype=np.int8)
        nrzi[0] = 1
        nrzi[1:] = (lv[1:] == lv[:-1])                         # no change = 1, change = 0
        for body in _frames(nrzi):
            n8 = len(body) // 8
            if n8 < 7:
                continue
            data = bytes(int(body[i * 8:i * 8 + 8][::-1], 2) for i in range(n8))
            if crc16_x25(data[:-2]) != (data[-2] | data[-1] << 8):
                continue
            payload = data[:-2]
            if payload in seen:
                continue
            seen.add(payload)
            msg_bits = [int(c) for byte in payload for c in f'{byte:08b}']
            out.append(ais_sentences(msg_bits, channel))
    return out
