"""Live test (CI): start the station helper, connect like the app does over WebSocket, change the radios
from the "app", and check the helper reconnects them and saves station.json. Needs: pip install numpy websockets"""
import asyncio, json, os, socket, subprocess, sys, tempfile, time
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


async def status(ws, cond, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout=max(0.1, end - time.monotonic())))
        if m.get('type') == 'status' and cond(m): return m
    raise AssertionError('status condition not met')


async def main():
    ws_port, cfg = free_port(), os.path.join(tempfile.mkdtemp(), 'station.json')
    p = subprocess.Popen([sys.executable, '-u', os.path.join(HERE, '..', 'helper', 'marine_helper.py'), '--ws', str(ws_port), '--udp', str(free_port()),
                          '--no-netcheck', '--config', cfg, '--rig', 'ic9100', '--mode', 'ais-scan'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(50):
            try:
                ws = await websockets.connect(f'ws://127.0.0.1:{ws_port}'); break
            except OSError:
                await asyncio.sleep(0.2)
        else:
            raise AssertionError('helper did not start')
        m = await status(ws, lambda m: 'ic9100' in (m.get('rigs') or {}))
        assert m['station']['config']['ic9100']['enabled'] and m['rigs']['ic9100']['mode'] == 'ais-scan', m
        await ws.send(json.dumps({'type': 'config', 'radios': {'thd74': {'enabled': True, 'port': '', 'mode': 'dsc70', 'band': 'A'}, 'ic9100': {'enabled': False}}}))
        m = await status(ws, lambda m: list((m.get('rigs') or {})) == ['thd74'])
        assert m['rigs']['thd74']['channel'] == 'DSC Ch 70 (TH-D74)', m['rigs']
        await ws.send(json.dumps({'type': 'tune', 'rig': 'thd74', 'mode': 'ais-b', 'dwell': 25}))
        m = await status(ws, lambda m: (m.get('rigs') or {}).get('thd74', {}).get('mode') == 'ais-b')
        saved = json.load(open(cfg))
        assert saved['thd74'] == {**saved['thd74'], 'enabled': True, 'band': 'A', 'mode': 'ais-b', 'dwell': 25.0} and not saved['ic9100']['enabled'], saved
        await ws.close()
        print('✓ station helper: radios changed from the app over WebSocket, applied live and saved')
    finally:
        p.terminate()
        out = p.communicate(timeout=10)[0]
        if os.environ.get('VERBOSE'): print(out)


asyncio.run(main())
