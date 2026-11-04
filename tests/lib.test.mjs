import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AisDecoder, decodePayload, nmeaChecksumOk, mmsiKind, mmsiCountry } from '../www/lib/ais.js';
import { gridToLatLon, latLonToGrid, bearing, distanceNm, destination, cpa, compass } from '../www/lib/geo.js';
import { parseDsc, dscPosition, parseNavtex, parseBeaconHex } from '../www/lib/gmdss.js';

const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('AIS type 1 (gpsd reference sentence)', () => {
  const line = '!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C';
  assert.ok(nmeaChecksumOk(line));
  const m = new AisDecoder().push(line);
  assert.equal(m.type, 1); assert.equal(m.mmsi, 477553000);
  close(m.lat, 47.582833, 1e-5, 'lat'); close(m.lon, -122.345832, 1e-5, 'lon');
  assert.equal(m.sog, 0); assert.equal(m.cog, 51); assert.equal(m.heading, 181); assert.equal(m.status, 5);
  assert.equal(m.statusText, 'Moored');
});

test('AIS type 5 static data across two sentences', () => {
  const d = new AisDecoder();
  assert.equal(d.push('!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C'), null);
  const m = d.push('!AIVDM,2,2,1,A,88888888880,2*25');
  assert.equal(m.type, 5); assert.equal(m.mmsi, 351759000);
  assert.equal(m.name, 'EVER DIADEM'); assert.equal(m.callsign, '3FOF8'); assert.equal(m.destination, 'NEW YORK');
  assert.equal(m.imo, 9134270); assert.equal(m.shipType, 70); assert.equal(m.shipTypeText, 'Cargo');
  assert.equal(m.country || mmsiCountry(m.mmsi), 'Panama');
});

test('AIS: bad checksum ignored; distress devices flagged by MMSI', () => {
  assert.equal(new AisDecoder().push('!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5D'), null);
  assert.equal(mmsiKind(970123456), 'AIS-SART'); assert.equal(mmsiKind(972123456), 'MOB device'); assert.equal(mmsiKind(974123456), 'EPIRB-AIS');
  assert.equal(mmsiKind(3140001), 'Coast station'); assert.equal(mmsiCountry(314123000), 'Barbados');
});

test('AIS: round-trip a synthetic SART position report', () => {
  // Build a type-1 payload for MMSI 970012345 at 13.1N 59.6W, status 14.
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push(Math.floor(((v < 0 ? v + 2 ** n : v)) / 2 ** i) % 2); };
  put(1, 6); put(0, 2); put(970012345, 30); put(14, 4); put(-128, 8); put(0, 10); put(1, 1);
  put(Math.round(-59.6 * 600000), 28); put(Math.round(13.1 * 600000), 27); put(3600, 12); put(511, 9); put(0, 6); put(0, 2); put(0, 3); put(0, 1); put(0, 19);
  let p = ''; for (let i = 0; i < bits.length; i += 6) { let v = 0; for (let j = 0; j < 6; j++) v = v * 2 + (bits[i + j] || 0); v += 48; if (v > 87) v += 8; p += String.fromCharCode(v); }
  const m = decodePayload(p, 0);
  assert.equal(m.mmsi, 970012345); assert.equal(m.kind, 'AIS-SART'); assert.equal(m.distress, true);
  close(m.lat, 13.1, 1e-5, 'lat'); close(m.lon, -59.6, 1e-5, 'lon');
});

test('Maidenhead, bearing and distance', () => {
  const p = gridToLatLon('GK03ec'); close(p.lat, 13.104, 0.03, 'lat'); close(p.lon, -59.625, 0.05, 'lon'); // Barbados
  assert.equal(latLonToGrid(13.1, -59.6), 'GK03ec');
  assert.throws(() => gridToLatLon('ZZ99'));
  const bgi = { lat: 13.1, lon: -59.6 }, svg = { lat: 13.25, lon: -61.2 };
  close(bearing(bgi, svg), 276, 2, 'bearing to St Vincent'); close(distanceNm(bgi, svg), 94, 3, 'distance');
  const d = destination(bgi, 90, 60); close(distanceNm(bgi, d), 60, 0.1, 'destination'); close(bearing(bgi, d), 90, 0.5, 'brg');
  assert.equal(compass(270), 'W'); assert.equal(compass(359), 'N');
  const c = cpa(bgi, { ...destination(bgi, 0, 10), sog: 12, cog: 180 }); close(c.cpaNm, 0, 0.05, 'head-on cpa'); close(c.tcpaMin, 50, 1, 'tcpa');
});

test('DSC: distress alert with position, urgency, safety', () => {
  const d = parseDsc('$CDDSC,12,3141234560,12,05,00,1130505936,1423,,,S,E*00');
  assert.equal(d.level, 'distress'); assert.equal(d.mmsi, '314123456'); assert.equal(d.country, 'Barbados');
  assert.equal(d.nature, 'Sinking'); close(d.position.lat, 13.0833, 1e-3, 'lat'); close(d.position.lon, -59.6, 1e-3, 'lon'); assert.equal(d.time, '14:23 UTC');
  assert.equal(parseDsc('$CDDSC,16,0003140000,08,26,00,,,,,S,*00').level, 'safety');
  assert.equal(parseDsc('$CDDSC,20,3141234560,10,00,00,,,,,R,*00').level, 'urgency');
  assert.equal(dscPosition('9999999999'), null); assert.equal(parseDsc('$GPGGA,1,2,3'), null);
});

test('NAVTEX and 406 MHz beacon IDs', () => {
  const n = parseNavtex('ZCZC JA42\nNAVAREA IV 123/26\nBUOY OFF STATION 13-05N 059-37W\nNNNN');
  assert.equal(n.station, 'J'); assert.equal(n.subject, 'Navigational warning'); assert.match(n.body, /BUOY OFF STATION/); assert.equal(n.level, 'safety');
  assert.equal(parseNavtex('ZCZC JD01 MAYDAY RELAY NNNN').level, 'distress');
  // Country code 314 (Barbados): protocol flag 1, then 314 in 10 bits.
  const bits = '1' + (314).toString(2).padStart(10, '0') + '010' + '0'.repeat(46);
  const hex = [...bits.match(/.{4}/g)].map((b) => parseInt(b, 2).toString(16)).join('').toUpperCase();
  const e = parseBeaconHex(hex);
  assert.equal(e.country, 314); assert.equal(e.countryName, 'Barbados'); assert.equal(e.type, 'EPIRB (maritime MMSI)'); assert.equal(e.level, 'distress');
  assert.equal(parseBeaconHex('XYZ'), null);
});
