"""Kenwood TH-D74 control for the receive side only: set band, frequency and mode over the USB virtual COM port.
Marine Monitor never keys the transmitter.

Radio set-up (TH-D74 menus):
  Menu 980 USB Function   = COM+AF/IF Output   (one USB cable: control port + USB audio to the PC)
  Menu 102 Detect Out     = Detect for AIS / VHF DSC (flat FM discriminator output, best for 9600-baud AIS)
                            Off (AF) for HF DSC in USB mode. (IF output is not used by Marine Monitor.)
  Menu 918 USB Audio Out  = about Level 5
  Squelch open on the band in use. Band B covers 0.1-524 MHz (incl. HF USB); Band A 136-174 / 410-470 MHz.
Serial: 9600 baud, 8N1, commands end with CR (same as Hamlib's TH-D74 driver).
"""
MODES = {'FM': 0, 'AM': 2, 'LSB': 3, 'USB': 4, 'CW': 5, 'NFM': 6, 'WFM': 8}


def fo_with_freq(fo_reply, hz):
    """Take an 'FO b,0145000000,...' reply and put a new 10-digit frequency in it (Hamlib does the same)."""
    if not fo_reply.startswith('FO ') or len(fo_reply) < 15:
        raise ValueError(f'unexpected FO reply: {fo_reply!r}')
    return fo_reply[:5] + f'{int(hz):010d}' + fo_reply[15:]


class Rig:
    """Minimal TH-D74 control. Rig(None) is a dry run that records the commands it would send."""
    def __init__(self, port=None, baud=9600, band='B'):
        self.b = '1' if str(band).upper() in ('B', '1') else '0'
        self.ser, self.sent = None, []
        self.fake_fo = f'FO {self.b},0144000000,0,0,0,0,0,0,0,0,0,08,08,000,0,0000000,0'
        if port:
            import serial  # pyserial
            self.ser = serial.Serial(port, baud, timeout=0.5, xonxoff=True)

    def cmd(self, text):
        self.sent.append(text)
        if not self.ser:
            if text.startswith('FO ') and ',' in text:
                self.fake_fo = text
            return self.fake_fo if text.startswith('FO') else text
        self.ser.reset_input_buffer()
        self.ser.write((text + '\r').encode('ascii'))
        return self.ser.read_until(b'\r').decode('ascii', 'ignore').strip()

    def main_band(self):
        self.cmd(f'BC {self.b}')

    def tune(self, hz, mode='FM', data_mode=True):
        fo = self.cmd(f'FO {self.b}')
        self.cmd(fo_with_freq(fo, hz))
        self.cmd(f'MD {self.b},{MODES[mode]}')
