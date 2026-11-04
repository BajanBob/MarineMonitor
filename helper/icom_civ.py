"""Icom CI-V control (IC-9100 and similar) for the receive side only: set frequency, mode, main band.
Marine Monitor never keys the transmitter. CI-V over the radio's USB port (virtual COM port).
IC-9100 defaults: address 0x7C, 19200 baud (set "CI-V USB Baud Rate" and "CI-V USB Echo Back OFF" in the menu).
"""
CONTROLLER = 0xE0
MODES = {'LSB': 0x00, 'USB': 0x01, 'AM': 0x02, 'CW': 0x03, 'RTTY': 0x04, 'FM': 0x05}


def bcd_freq(hz):
    """Frequency in Hz → 5 bytes BCD, least significant byte first (Icom format)."""
    d = f'{int(hz):010d}'
    return bytes(int(d[8 - 2 * i] + d[9 - 2 * i], 16) for i in range(5))


def frame(addr, cmd, data=b''):
    return bytes([0xFE, 0xFE, addr, CONTROLLER, cmd]) + bytes(data) + b'\xFD'


class Rig:
    """Minimal CI-V rig. Use Rig(None) for a dry run (no serial port)."""
    def __init__(self, port=None, baud=19200, addr=0x7C):
        self.addr, self.ser, self.sent = addr, None, []
        if port:
            import serial  # pyserial
            self.ser = serial.Serial(port, baud, timeout=0.2)

    def _send(self, cmd, data=b''):
        f = frame(self.addr, cmd, data)
        self.sent.append(f)
        if self.ser:
            self.ser.write(f)
            self.ser.read(64)   # discard the OK / echo

    def main_band(self):
        self._send(0x07, b'\xD0')

    def tune(self, hz, mode='FM', data_mode=True):
        """Receive on `hz` in `mode`. data_mode routes the receiver audio to USB with flat response (FM-D / USB-D)."""
        self._send(0x05, bcd_freq(hz))
        self._send(0x06, bytes([MODES[mode], 0x01]))
        self._send(0x1A, bytes([0x06, 0x01 if data_mode else 0x00, 0x01 if data_mode else 0x00]))

    def close(self):
        if self.ser:
            try: self.ser.close()
            finally: self.ser = None
