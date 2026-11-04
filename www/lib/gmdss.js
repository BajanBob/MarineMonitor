// GMDSS receive-side decoders: DSC (as NMEA $--DSC from a DSC radio or decoder), NAVTEX message
// headers, and 406 MHz EPIRB / PLB / ELT beacon hex IDs. Receive-only: nothing here transmits.
import { mmsiCountry } from './ais.js';

export const DSC_CATEGORY = { '00': 'Routine', '08': 'Safety (Sécurité)', '10': 'Urgency (Pan-Pan)', '12': 'Distress (Mayday)' };
export const DSC_FORMAT = { '02': 'Geographic area', '12': 'Distress alert', '16': 'All ships', '20': 'Individual', '23': 'Individual (auto)' };
export const DSC_NATURE = { '00': 'Fire, explosion', '01': 'Flooding', '02': 'Collision', '03': 'Grounding', '04': 'Listing, danger of capsizing', '05': 'Sinking', '06': 'Disabled and adrift', '07': 'Undesignated distress', '08': 'Abandoning ship', '09': 'Piracy / armed robbery', '10': 'Man overboard', '12': 'EPIRB emission' };

/** DSC position field (10 digits: quadrant, lat ddmm, lon dddmm) → { lat, lon } or null. */
export function dscPosition(p) {
  if (!/^\d{10}$/.test(p) || p === '9999999999') return null;
  const q = +p[0], lat = +p.slice(1, 3) + +p.slice(3, 5) / 60, lon = +p.slice(5, 8) + +p.slice(8, 10) / 60;
  if (lat > 90 || lon > 180 || q > 3) return null;
  return { lat: q === 2 || q === 3 ? -lat : lat, lon: q === 1 || q === 3 ? -lon : lon };
}

/** Parse an NMEA DSC sentence ($CDDSC / $--DSC). Returns null if it isn't one. */
export function parseDsc(line) {
  const m = /^\$..DSC,([^*]*)/.exec(String(line).trim());
  if (!m) return null;
  const f = m[1].split(',');
  const [fmt, addr, cat, nat, comm, pos, time, mmsiDistress, natDistress, ack, exp] = f;
  const category = DSC_CATEGORY[cat] || (fmt === '12' ? 'Distress (Mayday)' : `Category ${cat || '?'}`);
  const distress = fmt === '12' || cat === '12';
  const raw = (distress && mmsiDistress ? mmsiDistress : addr || '').trim();
  const from = /^\d{10}$/.test(raw) ? raw.slice(0, 9) : raw; // NMEA carries the 9-digit MMSI plus a trailing digit
  const out = {
    kind: 'dsc', format: DSC_FORMAT[fmt] || `Format ${fmt}`, category, level: distress ? 'distress' : cat === '10' ? 'urgency' : cat === '08' ? 'safety' : 'routine',
    mmsi: from, country: from ? mmsiCountry(from) : '', nature: distress ? (DSC_NATURE[natDistress || nat] || '') : '',
    position: dscPosition(pos || ''), time: /^\d{4}$/.test(time || '') && time !== '8888' ? `${time.slice(0, 2)}:${time.slice(2)} UTC` : null,
    ack: ack === 'B' ? 'Acknowledgement' : ack === 'R' ? 'Acknowledgement request' : '', expansion: exp === 'E',
  };
  return out;
}

// NAVTEX: "ZCZC B1B2B3B4" header. B1 = transmitter, B2 = subject, B3B4 = number.
export const NAVTEX_SUBJECT = { A: 'Navigational warning', B: 'Meteorological warning', C: 'Ice report', D: 'Search & rescue / piracy', E: 'Weather forecast', F: 'Pilot service', G: 'AIS', H: 'LORAN', J: 'GNSS', K: 'Other navaid', L: 'Navigational warning (extra)', V: 'Special', W: 'Special', X: 'Special', Y: 'Special', Z: 'No messages on hand' };
export function parseNavtex(textIn) {
  const t = String(textIn);
  const m = /ZCZC\s+([A-Z])([A-Z])(\d{2})/.exec(t);
  if (!m) return null;
  const body = t.slice(m.index + m[0].length).replace(/NNNN[\s\S]*$/, '').trim();
  const s = m[2];
  return { kind: 'navtex', code: `${m[1]}${m[2]}${m[3]}`, station: m[1], subject: NAVTEX_SUBJECT[s] || s, number: m[3], body, level: s === 'D' ? 'distress' : s === 'A' || s === 'B' || s === 'L' ? 'safety' : 'routine' };
}

// 406 MHz beacons: the 15-hex-character ID (bits 26–85 of the burst). Bit 26 is the protocol flag,
// bits 27–36 the country code (same MID numbers as MMSIs).
const PROTOCOLS_USER = { 2: 'EPIRB (maritime MMSI)', 6: 'EPIRB (radio call sign)', 3: 'Serial (ELT/EPIRB/PLB)', 0: 'Orbitography', 1: 'ELT (aviation)', 4: 'National', 5: 'Spare', 7: 'Test' };
const PROTOCOLS_LOC = { 2: 'EPIRB, MMSI (standard location)', 3: 'ELT, 24-bit address', 4: 'ELT serial', 5: 'ELT operator', 6: 'EPIRB serial', 7: 'PLB serial', 8: 'ELT national', 10: 'EPIRB national', 11: 'PLB national', 12: 'Ship security (SSAS)', 14: 'Standard test', 15: 'National test' };
export function parseBeaconHex(hex) {
  const h = String(hex).trim().toUpperCase();
  if (!/^[0-9A-F]{15}$/.test(h)) return null;
  const bits = [...h].map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
  const userProtocol = bits[0] === '1';
  const country = parseInt(bits.slice(1, 11), 2);
  const proto = userProtocol ? parseInt(bits.slice(11, 14), 2) : parseInt(bits.slice(11, 15), 2);
  const type = userProtocol ? PROTOCOLS_USER[proto] || `User protocol ${proto}` : PROTOCOLS_LOC[proto] || `Location protocol ${proto}`;
  return { kind: 'epirb', hex: h, country, countryName: mmsiCountry(`${country}000000`) || `MID ${country}`, type, test: /test/i.test(type), level: /test/i.test(type) ? 'routine' : 'distress' };
}
