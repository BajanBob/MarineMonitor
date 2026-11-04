import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, handleAisStream, createFleet, parseNdbc, tideTurns, ingestFeed } from '../server/relay.mjs';
import { AisDecoder } from '../www/lib/ais.js';

const NDBC = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
2026 11 04 05 00  90  7.0  9.0   1.8     9   6.1  80 1013.2  27.1  28.4  23.0   MM -0.6    MM
2026 11 04 04 00  85  6.5  8.0   1.7     9   6.0  80 1013.6  27.0  28.4  23.0   MM -0.4    MM`;

function fakeFetch(url) {
  const json = (o) => Promise.resolve({ ok: true, json: () => Promise.resolve(o), text: () => Promise.resolve(JSON.stringify(o)) });
  if (url.includes('//api.open-meteo.com')) return json({ current: { time: '2026-11-04T05:00', wind_speed_10m: 15.2, wind_direction_10m: 85, wind_gusts_10m: 21, pressure_msl: 1013.5, temperature_2m: 28 }, hourly: { time: ['2026-11-04T02:00', '2026-11-04T03:00', '2026-11-04T04:00', '2026-11-04T05:00'], visibility: [24000, 24000, 22000, 18520], pressure_msl: [1014.5, 1014.1, 1013.8, 1013.5] } });
  if (url.includes('marine-api')) return json({ current: { time: '2026-11-04T05:00', wave_height: 1.9, wave_period: 8.5, wave_direction: 75, swell_wave_height: 1.4, swell_wave_period: 10, swell_wave_direction: 70, ocean_current_velocity: 1.852, ocean_current_direction: 290, sea_level_height_msl: 0.12, sea_surface_temperature: 28.3 }, hourly: { time: ['2026-11-04T04:00', '2026-11-04T05:00', '2026-11-04T06:00', '2026-11-04T07:00', '2026-11-04T08:00', '2026-11-04T09:00', '2026-11-04T10:00'], sea_level_height_msl: [0.0, 0.12, 0.25, 0.3, 0.2, 0.05, 0.1] } });
  if (url.includes('ndbc')) return Promise.resolve({ ok: true, text: () => Promise.resolve(NDBC) });
  if (url.includes('aviationweather')) return json([{ rawOb: 'TBPB 040500Z 09012KT 9999 FEW020 28/23 Q1013', wdir: 90, wspd: 12, visib: '6+', altim: 1013, temp: 28, reportTime: '2026-11-04 05:00:00' }]);
  if (url.includes('nga.mil')) return json({ 'broadcast-warn': [{ msgYear: 2026, msgNumber: 812, navArea: '4', subregion: '24', text: 'CARIBBEAN SEA. BARBADOS. LIGHTED BUOY OFF STATION 13-05N 059-37W.', issueDate: '031200Z NOV 2026', authority: 'NAVAREA IV' }, { msgYear: 2026, msgNumber: 9, navArea: '12', text: 'PACIFIC', issueDate: '011200Z NOV 2026' }] });
  if (url.includes('ipapi.co')) return json({ latitude: 13.09, longitude: -59.6, city: 'Bridgetown', country_name: 'Barbados' });
  return Promise.resolve({ ok: false, status: 404 });
}

test('weather aggregation: wind in knots, pressure trend, visibility NM, waves, current, tides, buoy, METAR', async () => {
  const s = await startRelay({ port: 0, fetchImpl: fakeFetch, feedKey: 'k'.repeat(20) });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    const w = await (await fetch(`${base}/api/wx?lat=13.1&lon=-59.6`)).json();
    assert.equal(w.wind.kt, 15.2); assert.equal(w.wind.dir, 85); assert.equal(w.pressure.trend3h, -1);
    assert.equal(w.visibility.nm, 10); assert.equal(w.waves.m, 1.9); assert.equal(w.waves.periodS, 8.5);
    assert.equal(w.current.kt, 1); assert.equal(w.current.setDeg, 290);
    assert.deepEqual(w.tide.turns.map((t) => t.type), ['High', 'Low']);
    assert.equal(w.buoy.windKt, 13.6); assert.equal(w.buoy.waveM, 1.8); assert.equal(w.buoy.pressureHpa, 1013.2);
    assert.match(w.metar.raw, /^TBPB/); assert.ok(w.sources.some((x) => /Barbados Meteorological/.test(x)));
    const m = await (await fetch(`${base}/api/msi`)).json();
    assert.equal(m.warnings.length, 1); assert.equal(m.warnings[0].id, 'NAVAREA IV 812/2026');
    const where = await (await fetch(`${base}/api/where`)).json(); assert.equal(where.city, 'Bridgetown');
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.match(await (await fetch(`${base}/lib/ais.js`)).text(), /AisDecoder/);
  } finally { s.close(); }
});

test('internet AIS (AISStream format) and direct-RF feed are merged per ship, with sources', async () => {
  const s = await startRelay({ port: 0, fetchImpl: fakeFetch, feedKey: 'k'.repeat(20) });
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    handleAisStream(s.fleet, { MessageType: 'PositionReport', MetaData: { MMSI: 477553000, ShipName: 'TEST SHIP  ', latitude: 13.2, longitude: -59.7 }, Message: { PositionReport: { Sog: 11.5, Cog: 200, TrueHeading: 199, NavigationalStatus: 0 } } });
    handleAisStream(s.fleet, { MessageType: 'ShipStaticData', MetaData: { MMSI: 477553000 }, Message: { ShipStaticData: { Name: 'TEST SHIP', CallSign: 'VRAB1', Destination: 'BRIDGETOWN', Type: 70, Dimension: { A: 100, B: 20 } } } });
    const post = (body, key = 'k'.repeat(20)) => fetch(`${base}/api/feed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feed-key': key }, body: JSON.stringify(body) });
    assert.equal((await post({ lines: [] }, 'wrong-key-wrong-key-x')).status, 403);
    const r = await (await post({ lines: ['!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C', '$CDDSC,12,3141234560,12,05,00,1130505936,1423,,,S,E*00'],
      alerts: [{ kind: 'navtex', text: 'ZCZC JA42 BUOY OFF STATION NNNN', freq: 518 }, { kind: 'epirb', hex: 'B3A400000000000' }, { kind: 'egc', text: 'SAFETYNET MAYDAY RELAY 12N 058W' }] })).json();
    assert.equal(r.accepted, 5); // AIS + DSC + NAVTEX + 406 MHz beacon + EGC
    const { ships } = await (await fetch(`${base}/api/ships`)).json();
    const sh = ships.find((x) => x.mmsi === 477553000);
    assert.deepEqual(sh.sources.sort(), ['internet', 'rf']); assert.equal(sh.name, 'TEST SHIP'); assert.equal(sh.callsign, 'VRAB1'); assert.equal(sh.shipType, 'Cargo'); assert.equal(sh.length, 120);
    const { alerts } = await (await fetch(`${base}/api/alerts`)).json();
    assert.deepEqual(alerts.map((a) => a.kind).sort(), ['dsc', 'egc', 'epirb', 'navtex']);
    assert.equal(alerts.find((a) => a.kind === 'dsc').level, 'distress');
    const st = await (await fetch(`${base}/api/status`)).json(); assert.equal(st.ais.enabled, false); assert.ok(st.rfFeed.last);
  } finally { s.close(); }
});

test('AIS-SART seen on the internet raises a distress alert once', () => {
  const f = createFleet();
  for (let i = 0; i < 3; i++) handleAisStream(f, { MessageType: 'PositionReport', MetaData: { MMSI: 970012345, latitude: 13.0, longitude: -59.5 }, Message: { PositionReport: { Sog: 0, Cog: 0 } } });
  const a = f.alerts(); assert.equal(a.length, 1); assert.equal(a[0].level, 'distress'); assert.equal(a[0].device, 'AIS-SART'); assert.equal(a[0].count, 3);
});

test('NDBC parsing and tide turns', () => {
  const b = parseNdbc(NDBC); assert.equal(b.windDir, 90); assert.equal(b.visNm, null); assert.equal(b.pressureTendency, -0.6);
  assert.deepEqual(tideTurns(['a', 'b', 'c', 'd', 'e'], [0, 1, 0, -1, 0]).map((x) => `${x.type}@${x.time}`), ['High@b', 'Low@d']);
  const n = ingestFeed(createFleet(), new AisDecoder(), { lines: ['garbage', '$GPGGA,1'] }); assert.equal(n, 0);
});
