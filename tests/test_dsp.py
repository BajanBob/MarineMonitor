"""Software receiver tests: synthesise DSC and AIS audio (as an IC-9100 would deliver it), add noise,
and check the decoders recover the calls. The signal generators live here only, for testing."""
import os, sys, unittest
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'helper'))
import mmdsp  # noqa: E402

RATE = 48000
rng = np.random.default_rng(7)


def mm_syms(mmsi):
    d = str(mmsi) + '0'
    return [int(d[i:i + 2]) for i in range(0, 10, 2)]


def dsc_stream(msg):
    """msg = [F, F, …, EOS]. Returns the full DX/RX-interleaved character stream with the ECC."""
    x = 0
    for v in msg[1:]:
        x ^= v
    S = msg + [x]
    dx = [125] * 6 + S + [msg[-1], msg[-1]]
    rx = list(range(111, 103, -1)) + S
    out = []
    for a, b in zip(dx, rx):
        out += [a, b]
    return out


def fsk(syms, mode, dots=20, lead=0.3, noise=0.15):
    bits = [i % 2 for i in range(dots)]
    for s in syms:
        bits += mmdsp.sym_bits(s)
    spb = RATE / mode['baud']
    n = int(len(bits) * spb)
    t = np.arange(n) / RATE
    f = np.array([mode['f_y'] if bits[min(int(i / spb), len(bits) - 1)] else mode['f_b'] for i in range(n)])
    ph = 2 * np.pi * np.cumsum(f) / RATE
    sig = 0.5 * np.sin(ph)
    pad = np.zeros(int(lead * RATE))
    a = np.concatenate([pad, sig, pad])
    return a + noise * rng.standard_normal(len(a))


def ais_audio(payload_bits, noise=0.06):
    data = bytes(int(''.join(map(str, payload_bits[i:i + 8])), 2) for i in range(0, len(payload_bits), 8))
    crc = mmdsp.crc16_x25(data)
    frame = data + bytes([crc & 0xFF, crc >> 8])
    raw = ''.join(f'{b:08b}'[::-1] for b in frame)      # LSB first
    stuffed, ones = [], 0
    for c in raw:
        stuffed.append(c)
        ones = ones + 1 if c == '1' else 0
        if ones == 5:
            stuffed.append('0'); ones = 0
    bits = '01' * 12 + '01111110' + ''.join(stuffed) + '01111110' + '0' * 8
    level, lv = 1, []
    for b in bits:                                        # NRZI: 0 = change
        if b == '0':
            level = -level
        lv.append(level)
    x = np.repeat(np.array(lv, dtype=float), 5)
    g = np.exp(-0.5 * (np.arange(-7, 8) / 2.2) ** 2); g /= g.sum()   # Gaussian (BT ≈ 0.4 at 5 samples/bit)
    x = np.convolve(x, g, 'same') * 0.4
    pad = np.zeros(2000)
    a = np.concatenate([pad, x, pad])
    return a + noise * rng.standard_normal(len(a))


def bits_of(sentence_payload):
    out = []
    for ch in sentence_payload:
        v = ord(ch) - 48
        if v > 40:
            v -= 8
        out += [int(c) for c in f'{v:06b}']
    return out


class Dsc(unittest.TestCase):
    def test_vhf_individual_call(self):
        msg = [120, 120] + mm_syms(314123450) + [100] + mm_syms('003140001') + [100, 126, 90, 0, 72, 117]
        calls = mmdsp.decode_dsc(fsk(dsc_stream(msg), mmdsp.VHF), RATE, mmdsp.VHF)
        self.assertEqual(len(calls), 1)
        c = calls[0]
        self.assertEqual((c['formatName'], c['to'], c['fr'], c['category'], c['ack']), ('individual', '314123450', '003140001', 100, 'R'))
        self.assertTrue(c['nmea'].startswith('$CDDSC,20,0031400010,00,00,26,900072,'), c['nmea'])

    def test_vhf_group_call(self):
        msg = [114, 114] + mm_syms('031400010') + [108] + mm_syms('003140001') + [100, 126, 90, 0, 6, 127]
        c = mmdsp.decode_dsc(fsk(dsc_stream(msg), mmdsp.VHF), RATE, mmdsp.VHF)[0]
        self.assertEqual((c['formatName'], c['to'], c['category']), ('group', '031400010', 108))
        self.assertIn('$CDDSC,14,', c['nmea'])

    def test_vhf_distress_with_noise(self):
        # Distress from 314999990, sinking (05), 13°05'N 059°37'W, 14:23 UTC, voice (100)
        msg = [112, 112] + mm_syms(314999990) + [5] + [11, 30, 50, 59, 37] + [14, 23] + [100, 127]
        calls = mmdsp.decode_dsc(fsk(dsc_stream(msg), mmdsp.VHF, noise=0.35), RATE, mmdsp.VHF)
        self.assertEqual(calls[0]['fr'], '314999990')
        self.assertEqual(calls[0]['position'], '1130505937')
        self.assertTrue(calls[0]['nmea'].startswith('$CDDSC,12,3149999900,12,05,00,1130505937,1423,'), calls[0]['nmea'])

    def test_hf_100_baud(self):
        msg = [116, 116, 108] + mm_syms('003140001') + [100, 126, 90, 0, 16, 127]
        calls = mmdsp.decode_dsc(fsk(dsc_stream(msg), mmdsp.HF, dots=200), RATE, mmdsp.HF)
        self.assertEqual(calls[0]['formatName'], 'all ships')

    def test_bad_ecc_is_rejected(self):
        msg = [120, 120] + mm_syms(314123450) + [100] + mm_syms('003140001') + [100, 126, 90, 0, 72, 117]
        s = dsc_stream(msg)
        # corrupt the ECC in both DX and RX positions
        idx = [i for i, v in enumerate(s) if v == 117]
        ecc_dx = idx[0] + 2
        s[ecc_dx] = (s[ecc_dx] + 1) % 128
        rx_ecc = [i for i in range(1, len(s), 2) if s[i] == 117][0] + 2
        if rx_ecc < len(s):
            s[rx_ecc] = (s[rx_ecc] + 1) % 128
        self.assertEqual(mmdsp.decode_dsc(fsk(s, mmdsp.VHF), RATE, mmdsp.VHF), [])

    def test_silence(self):
        self.assertEqual(mmdsp.decode_dsc(0.2 * rng.standard_normal(RATE), RATE, mmdsp.VHF), [])


class Ais(unittest.TestCase):
    PAYLOAD = '15MgK45P3@G?fl0E`JbR0OwT0@MS'   # type 1, MMSI 366730000

    def test_position_report(self):
        bits = bits_of(self.PAYLOAD)
        msgs = mmdsp.decode_ais(ais_audio(bits), RATE, 'B')
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0][0].split(',')[5], self.PAYLOAD)
        self.assertEqual(msgs[0][0].split(',')[4], 'B')

    def test_inverted_polarity_and_noise(self):
        msgs = mmdsp.decode_ais(-ais_audio(bits_of(self.PAYLOAD), noise=0.08), RATE)
        self.assertEqual(msgs[0][0].split(',')[5], self.PAYLOAD)

    def test_long_message_is_split(self):
        bits = [int(b) for b in f'{5:06b}'] + list(rng.integers(0, 2, 418))   # 424-bit type 5
        msgs = mmdsp.decode_ais(ais_audio([int(x) for x in bits]), RATE)
        self.assertEqual(len(msgs[0]), 2)
        self.assertTrue(msgs[0][0].startswith('!AIVDM,2,1,'))

    def test_bad_crc_rejected(self):
        a = ais_audio(bits_of(self.PAYLOAD), noise=0)
        a[2000 + 5 * 120: 2000 + 5 * 126] *= -1          # flip a few bits mid-frame
        self.assertEqual(mmdsp.decode_ais(a, RATE), [])


class Civ(unittest.TestCase):
    def test_frequency_frame(self):
        import icom_civ
        f = icom_civ.frame(0x7C, 0x05, icom_civ.bcd_freq(161_975_000))
        self.assertEqual(f.hex(), 'fefe7ce0050050976101fd')
        self.assertEqual(icom_civ.bcd_freq(156_525_000).hex(), '0050525601')


class Kenwood(unittest.TestCase):
    def test_fo_frequency_rewrite(self):
        import kenwood_cat
        fo = 'FO 1,0144390000,0,0,0,0,0,0,0,0,0,08,08,000,0,0000000,0'
        self.assertEqual(kenwood_cat.fo_with_freq(fo, 161_975_000), 'FO 1,0161975000,0,0,0,0,0,0,0,0,0,08,08,000,0,0000000,0')
        with self.assertRaises(ValueError):
            kenwood_cat.fo_with_freq('N', 1)

    def test_tune_sequence(self):
        import kenwood_cat
        r = kenwood_cat.Rig(None, band='B')
        r.main_band(); r.tune(162_025_000, 'FM'); r.tune(8_412_800, 'USB')
        self.assertEqual(r.sent[0], 'BC 1')
        self.assertEqual(r.sent[1:4], ['FO 1', 'FO 1,0162025000,0,0,0,0,0,0,0,0,0,08,08,000,0,0000000,0', 'MD 1,0'])
        self.assertEqual(r.sent[-1], 'MD 1,4')
        self.assertIn('FO 1,0008412800', r.sent[-2])

    def test_d74_receiver_decodes_detect_audio(self):
        import receiver, kenwood_cat
        heard = []
        rig = kenwood_cat.Rig(None)
        rx = receiver.SoftReceiver(lambda line, band, extra=None: heard.append((band, line)), rig=rig, rate=RATE, mode='ais-b', label='TH-D74', key='thd74')
        self.assertIn('FO 1,0162025000', rig.sent[-2])
        rx.feed(ais_audio(bits_of(Ais.PAYLOAD))); rx.flush()
        self.assertEqual(heard[0][0], 'AIS 2 (Ch 88B)')
        rx.set_mode('dsc70')
        self.assertEqual(rx.status()['channel'], 'DSC Ch 70 (TH-D74)')
        self.assertEqual(rx.status()['rig'], 'thd74')


class NetCheck(unittest.TestCase):
    def test_tcp_ntp_and_failures(self):
        import netcheck, socket, struct, threading, time as _t
        srv = socket.socket(); srv.bind(('127.0.0.1', 0)); srv.listen(1)
        def ssh():
            c, _ = srv.accept(); c.sendall(b'SSH-2.0-OpenSSH_9.6\r\n'); c.close()
        threading.Thread(target=ssh, daemon=True).start()
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); udp.bind(('127.0.0.1', 0))
        def ntp():
            d, a = udp.recvfrom(64); r = bytearray(48); r[40:44] = struct.pack('!I', int(_t.time()) + 2208988800); udp.sendto(bytes(r), a)
        threading.Thread(target=ntp, daemon=True).start()
        ok = netcheck.tcp_check('ssh', '127.0.0.1', srv.getsockname()[1])
        self.assertTrue(ok['ok'], ok); self.assertIn('SSH-2.0', ok['detail'])
        n = netcheck.ntp_check('127.0.0.1', udp.getsockname()[1])
        self.assertTrue(n['ok'], n)
        closed = socket.socket(); closed.bind(('127.0.0.1', 0)); port = closed.getsockname()[1]; closed.close()
        bad = netcheck.tcp_check('blocked', '127.0.0.1', port, timeout=1)
        self.assertFalse(bad['ok']); self.assertIn('TCP 22', bad['fix'])
        r = netcheck.run(tcp_targets=[('blocked', '127.0.0.1', port)], ntp_server='127.0.0.1')
        self.assertFalse(r['ok']); self.assertEqual(len(r['checks']), 2)


class Forward(unittest.TestCase):
    def test_only_radio_ais_is_shared(self):
        import asyncio, socket, marine_helper
        rxs = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); rxs.bind(('127.0.0.1', 0)); rxs.settimeout(2)
        h = marine_helper.Hub()
        h.forwards.append({'name': 'vesseltracker', 'host': '127.0.0.1', 'port': rxs.getsockname()[1], 'sent': 0, 'last': None, 'error': None})
        line = '!AIVDM,1,1,,A,15MgK45P3@G?fl0E`JbR0OwT0@MS,0*4E'
        asyncio.run(h.nmea(line))
        asyncio.run(h.nmea('$CDDSC,20,3140001110,00,00,26,900072,,,,B,*00'))   # DSC is not shared
        self.assertEqual(rxs.recv(200).decode().strip(), line)
        self.assertEqual(h.status()['forwards'][0]['sent'], 1)


class StationConfig(unittest.TestCase):
    def test_clean_rejects_bad_values(self):
        import station
        c = station.clean({'ic9100': {'enabled': 1, 'baud': 1234, 'mode': 'rm -rf', 'addr': 'zz', 'dwell': 9999, 'port': 'COM4\n'},
                           'thd74': {'band': 'a', 'channel': '1'}, 'junk': {}})
        self.assertEqual(c['ic9100'], {'enabled': True, 'port': 'COM4', 'baud': 19200, 'addr': '0x7C', 'audio': '', 'channel': 0, 'mode': 'ais-a', 'dwell': 300.0})
        self.assertEqual((c['thd74']['band'], c['thd74']['channel']), ('A', 1))
        self.assertNotIn('junk', c)

    def test_apply_tune_save_and_stop(self):
        import asyncio, json, os, tempfile, station, marine_helper
        path = os.path.join(tempfile.mkdtemp(), 'station.json')
        async def go():
            hub = marine_helper.Hub()
            stn = station.Station(hub, asyncio.get_running_loop(), path); hub.station = stn
            stn.apply({'ic9100': {'enabled': True, 'mode': 'ais-scan', 'audio': 'NoSuchCard'}, 'thd74': {'enabled': True, 'mode': 'dsc70'},
                       'um435': {'enabled': True, 'port': '/dev/ttyNOPE', 'baud': 4800}})
            self.assertEqual(sorted(hub.rigs), ['ic9100', 'thd74'])
            self.assertEqual(hub.rigs['thd74'].status()['channel'], 'DSC Ch 70 (TH-D74)')
            await hub.command({'type': 'tune', 'rig': 'ic9100', 'mode': 'ais-b', 'dwell': 30})
            self.assertEqual(hub.rigs['ic9100'].status()['channel'], 'AIS 2 (Ch 88B)')
            saved = json.load(open(path))
            self.assertEqual((saved['ic9100']['mode'], saved['ic9100']['dwell'], saved['um435']['port']), ('ais-b', 30.0, '/dev/ttyNOPE'))
            self.assertIn('station', hub.status())
            await hub.command({'type': 'config', 'radios': {'thd74': {'enabled': True, 'band': 'A', 'mode': 'ais-a'}}})
            self.assertEqual(sorted(hub.rigs), ['thd74'])
            self.assertEqual(hub.rigs['thd74'].rig.b, '0')
            stn.stop_all(); self.assertEqual(hub.rigs, {})
            await asyncio.sleep(0)
        asyncio.run(go())


class Scan(unittest.TestCase):
    def test_plans(self):
        import receiver
        self.assertEqual([c.name for c in receiver.PLANS['ais-scan']], ['AIS 1 (Ch 87B)', 'AIS 2 (Ch 88B)'])
        self.assertEqual([c.name for c in receiver.PLANS['ais-a']], ['AIS 1 (Ch 87B)'])
        self.assertEqual(receiver.PLANS['hf-dsc'][0].dial, 2_185_800)

    def test_feeds_decoders_by_channel(self):
        import receiver
        heard = []
        rx = receiver.SoftReceiver(lambda line, band, extra=None: heard.append((band, line)), rig=None, rate=RATE)
        rx.set_mode('ais-b')
        rx.feed(ais_audio(bits_of(Ais.PAYLOAD)))
        rx.flush()
        self.assertEqual(heard[0][0], 'AIS 2 (Ch 88B)')
        self.assertIn(',B,', heard[0][1])
        rx.set_mode('dsc70')
        msg = [120, 120] + mm_syms(314123450) + [100] + mm_syms('003140001') + [100, 126, 90, 0, 72, 117]
        rx.feed(fsk(dsc_stream(msg), mmdsp.VHF))
        rx.flush()
        self.assertEqual(heard[-1][0], 'DSC Ch 70 (IC-9100)')
        self.assertTrue(heard[-1][1].startswith('$CDDSC,20,'))


if __name__ == '__main__':
    unittest.main()
