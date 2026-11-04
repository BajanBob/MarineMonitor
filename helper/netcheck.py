"""Station network check: can this network reach the services the station depends on?

Marine Monitor can't change the router; it tests the routes and says what to fix:
  * vesseltracker.com station tunnel: outbound TCP 22 to 83.220.137.136 and 85.10.199.209 (SSH banner expected)
  * time sync: UDP 123 (NTP) — a station with the wrong clock can't keep its tunnel up
  * the Marine Monitor relay (HTTPS)
Run from the station PC on the same network (and VPN routing) as the receivers.
"""
import socket, struct, time, urllib.request

VESSELTRACKER = [('vesseltracker tunnel 1', '83.220.137.136', 22), ('vesseltracker tunnel 2', '85.10.199.209', 22)]
FIX_TCP = 'Allow outbound TCP 22 to this address in the router firewall (Synology: Network Center → Security → Firewall), and exclude the station from the NordVPN tunnel.'
FIX_NTP = 'Allow outbound UDP 123 (NTP) in the router firewall; some VPNs and "threat prevention" settings block it.'
FIX_RELAY = 'Check the internet connection and the relay address; the free Render server can take up to a minute to wake.'


def tcp_check(name, host, port, timeout=6.0, expect=b'SSH-'):
    t = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            s.settimeout(timeout)
            banner = b''
            try:
                banner = s.recv(64)
            except socket.timeout:
                pass
            ms = round((time.monotonic() - t) * 1000)
            if expect and not banner.startswith(expect):
                return dict(name=name, target=f'{host}:{port} TCP', ok=False, ms=ms, detail='connected, but no SSH reply (something on the network is intercepting it)', fix=FIX_TCP)
            return dict(name=name, target=f'{host}:{port} TCP', ok=True, ms=ms, detail=banner.split(b'\r')[0].decode('ascii', 'ignore')[:40] or 'open')
    except OSError as e:
        return dict(name=name, target=f'{host}:{port} TCP', ok=False, ms=None, detail=str(e)[:80] or 'blocked', fix=FIX_TCP)


def ntp_check(server='pool.ntp.org', port=123, timeout=5.0):
    pkt = b'\x1b' + 47 * b'\0'                      # SNTP v3 client request
    t = time.monotonic()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.sendto(pkt, (server, port))
            data, _ = s.recvfrom(512)
        secs = struct.unpack('!I', data[40:44])[0] - 2208988800
        off = secs - time.time()
        ok = abs(off) < 5
        return dict(name='Time sync (NTP)', target=f'{server}:{port} UDP', ok=ok, ms=round((time.monotonic() - t) * 1000),
                    detail=f'clock offset {off:+.1f} s', fix=None if ok else 'The station clock is wrong: turn on automatic time sync.')
    except OSError as e:
        return dict(name='Time sync (NTP)', target=f'{server}:{port} UDP', ok=False, ms=None, detail=str(e)[:80] or 'no reply', fix=FIX_NTP)


def http_check(url, name='Marine Monitor relay', timeout=60):
    t = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return dict(name=name, target=url, ok=200 <= r.status < 300, ms=round((time.monotonic() - t) * 1000), detail=f'HTTP {r.status}')
    except Exception as e:  # noqa: BLE001
        return dict(name=name, target=url, ok=False, ms=None, detail=str(e)[:80], fix=FIX_RELAY)


def run(relay=None, extra=(), ntp_server='pool.ntp.org', tcp_targets=VESSELTRACKER):
    checks = [tcp_check(n, h, p) for n, h, p in tcp_targets]
    for item in extra:                               # "name=host:port" or "host:port"
        name, _, hp = item.rpartition('=')
        host, _, port = hp.rpartition(':')
        checks.append(tcp_check(name or hp, host, int(port), expect=None))
    checks.append(ntp_check(ntp_server))
    if relay:
        checks.append(http_check(relay.rstrip('/') + '/api/status'))
    return {'at': int(time.time() * 1000), 'ok': all(c['ok'] for c in checks), 'checks': checks}
