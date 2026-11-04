// AIS decoder for NMEA !AIVDM / !AIVDO sentences (ITU-R M.1371). Receive-only.
// Handles multi-sentence messages and the types a coast watch needs:
// 1/2/3 Class A position · 4 base station · 5 Class A static/voyage · 9 SAR aircraft ·
// 14 safety broadcast (AIS-SART / MOB / EPIRB-AIS test & active) · 18/19 Class B position ·
// 21 aid to navigation · 24 Class B static.

export function nmeaChecksumOk(line) {
  const m = /^[!$]([^*]+)\*([0-9A-Fa-f]{2})\s*$/.exec(line);
  if (!m) return false;
  let c = 0; for (const ch of m[1]) c ^= ch.charCodeAt(0);
  return c === parseInt(m[2], 16);
}

function payloadBits(payload, fill) {
  const bits = [];
  for (const ch of payload) {
    let v = ch.charCodeAt(0) - 48; if (v > 40) v -= 8;
    if (v < 0 || v > 63) throw new Error('bad AIS character');
    for (let i = 5; i >= 0; i--) bits.push((v >> i) & 1);
  }
  if (fill) bits.length -= fill;
  return bits;
}
const uint = (b, s, n) => { let v = 0; for (let i = s; i < s + n && i < b.length; i++) v = v * 2 + b[i]; return v; };
const int = (b, s, n) => { const v = uint(b, s, n); return b[s] ? v - 2 ** n : v; };
const text = (b, s, n) => {
  let out = '';
  for (let i = s; i + 6 <= s + n && i + 6 <= b.length; i += 6) { const c = uint(b, i, 6); out += String.fromCharCode(c < 32 ? c + 64 : c); }
  return out.replace(/@.*$/, '').trim();
};
const lonOf = (v) => (v === 0x6791AC0 ? null : v / 600000); // 181° = not available
const latOf = (v) => (v === 0x3412140 ? null : v / 600000); // 91° = not available

export const NAV_STATUS = ['Under way (engine)', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draught', 'Moored', 'Aground', 'Fishing', 'Under way (sail)', '', '', 'Towing astern', 'Pushing/towing', '', 'AIS-SART / MOB / EPIRB active', 'Not defined'];

export function shipType(n) {
  if (n >= 20 && n < 30) return 'Wing in ground'; if (n === 30) return 'Fishing'; if (n === 31 || n === 32) return 'Towing';
  if (n === 33) return 'Dredging'; if (n === 34) return 'Diving'; if (n === 35) return 'Military'; if (n === 36) return 'Sailing';
  if (n === 37) return 'Pleasure craft'; if (n >= 40 && n < 50) return 'High-speed craft'; if (n === 50) return 'Pilot vessel';
  if (n === 51) return 'Search and rescue'; if (n === 52) return 'Tug'; if (n === 53) return 'Port tender'; if (n === 55) return 'Law enforcement';
  if (n === 58) return 'Medical transport'; if (n >= 60 && n < 70) return 'Passenger'; if (n >= 70 && n < 80) return 'Cargo';
  if (n >= 80 && n < 90) return 'Tanker'; if (n >= 90 && n < 100) return 'Other'; return n ? `Type ${n}` : '';
}

/** What kind of station an MMSI belongs to (ITU-R M.585). */
export function mmsiKind(mmsi) {
  const s = String(mmsi).padStart(9, '0');
  if (s.startsWith('970')) return 'AIS-SART';
  if (s.startsWith('972')) return 'MOB device';
  if (s.startsWith('974')) return 'EPIRB-AIS';
  if (s.startsWith('111')) return 'SAR aircraft';
  if (s.startsWith('99')) return 'Aid to navigation';
  if (s.startsWith('00')) return 'Coast station';
  if (s.startsWith('0')) return 'Group';
  if (s.startsWith('98')) return 'Craft with parent ship';
  if (s.startsWith('8')) return 'Handheld VHF';
  return 'Ship';
}
/** Country (MID) for common Caribbean / regional MIDs; others shown as the MID number. */
const MID = { 314: 'Barbados', 362: 'Trinidad & Tobago', 330: 'Grenada', 375: 'St Vincent & Grenadines', 376: 'St Vincent & Grenadines', 377: 'St Vincent & Grenadines', 343: 'St Lucia', 325: 'Dominica', 304: 'Antigua & Barbuda', 305: 'Antigua & Barbuda', 339: 'Jamaica', 312: 'Belize', 750: 'Guyana', 338: 'USA', 366: 'USA', 367: 'USA', 368: 'USA', 369: 'USA', 316: 'Canada', 232: 'UK', 233: 'UK', 234: 'UK', 235: 'UK', 226: 'France', 227: 'France', 228: 'France', 329: 'Guadeloupe', 347: 'Martinique', 244: 'Netherlands', 245: 'Netherlands', 246: 'Netherlands', 306: 'Curaçao / Sint Maarten', 307: 'Aruba', 308: 'Bahamas', 309: 'Bahamas', 311: 'Bahamas', 310: 'Bermuda', 319: 'Cayman Islands', 351: 'Panama', 352: 'Panama', 353: 'Panama', 354: 'Panama', 355: 'Panama', 356: 'Panama', 357: 'Panama', 370: 'Panama', 371: 'Panama', 372: 'Panama', 373: 'Panama', 374: 'Panama', 636: 'Liberia', 637: 'Liberia', 538: 'Marshall Islands', 248: 'Malta', 249: 'Malta', 256: 'Malta', 209: 'Cyprus', 210: 'Cyprus', 212: 'Cyprus', 775: 'Venezuela', 710: 'Brazil', 345: 'Mexico' };
/** Where the MID (country digits) sits in each kind of MMSI (ITU-R M.585). */
function midOf(s, k) {
  return { Ship: s.slice(0, 3), 'Coast station': s.slice(2, 5), Group: s.slice(1, 4), 'Handheld VHF': s.slice(1, 4), 'Craft with parent ship': s.slice(2, 5), 'Aid to navigation': s.slice(2, 5), 'SAR aircraft': s.slice(3, 6) }[k] || null;
}
export function mmsiCountry(mmsi) {
  const s = String(mmsi).padStart(9, '0');
  const mid = midOf(s, mmsiKind(s));
  return mid ? (MID[+mid] || `MID ${mid}`) : '';
}

/** Full MMSI breakdown for the MMSI decoder (ITU-R M.585). */
export function mmsiDecode(input) {
  const s = String(input || '').replace(/\s/g, '');
  if (!/^\d{9}$/.test(s)) return { valid: false, error: 'An MMSI is exactly 9 digits.' };
  const kind = mmsiKind(s), mid = midOf(s, kind), notes = [];
  const fmt = { Ship: 'MID XXXXXX', 'Coast station': '00 MID XXXX', Group: '0 MID XXXXX', 'Handheld VHF': '8 MID XXXXX', 'Craft with parent ship': '98 MID XXXX', 'Aid to navigation': '99 MID XXXX', 'SAR aircraft': '111 MID XXX', 'AIS-SART': '970 XX YYYY', 'MOB device': '972 XX YYYY', 'EPIRB-AIS': '974 XX YYYY' }[kind];
  if (kind === 'Ship' && s.endsWith('000')) notes.push('Ends in 000: traditionally a ship that can also be reached through Inmarsat.');
  if (kind === 'Ship' && !/^[2-7]/.test(s)) notes.push('Ship MMSIs normally start with 2–7: check the number.');
  if (kind === 'Coast station') notes.push('A coast station: DSC calls to it go to the shore station, not a ship.');
  if (kind === 'Group') notes.push('A group MMSI: one DSC call reaches every radio programmed with this group number.');
  if (kind === 'SAR aircraft') notes.push(s[6] === '5' ? 'Search-and-rescue helicopter.' : s[6] === '1' ? 'Search-and-rescue fixed-wing aircraft.' : 'Search-and-rescue aircraft.');
  if (kind === 'Aid to navigation') notes.push(s[5] === '1' ? 'Physical aid to navigation (buoy, light).' : s[5] === '6' ? 'Virtual aid to navigation (broadcast only).' : 'Aid to navigation.');
  if (['AIS-SART', 'MOB device', 'EPIRB-AIS'].includes(kind)) notes.push(`Distress device: manufacturer code ${s.slice(3, 5)}, serial ${s.slice(5)}. ${s.slice(5) === '0000' ? '' : 'Treat as a real alert unless it says TEST.'}`.trim());
  if (kind === 'Handheld VHF') notes.push('Handheld VHF with DSC and GNSS.');
  if (kind === 'Craft with parent ship') notes.push('Craft (e.g. tender, lifeboat) associated with a parent ship.');
  return { valid: true, mmsi: s, kind, format: fmt, mid: mid ? +mid : null, country: mid ? (MID[+mid] || `MID ${mid} (not in the local list)`) : '', notes, dscAddress: `${s}0` };
}

/** Decode one complete AIS payload. */
export function decodePayload(payload, fill = 0) {
  const b = payloadBits(payload, fill);
  const type = uint(b, 0, 6), mmsi = uint(b, 8, 30);
  const m = { type, mmsi, kind: mmsiKind(mmsi) };
  switch (type) {
    case 1: case 2: case 3: {
      const rot = int(b, 42, 8), sog = uint(b, 50, 10), cog = uint(b, 116, 12), hdg = uint(b, 128, 9);
      Object.assign(m, { status: uint(b, 38, 4), rot: rot === -128 ? null : rot, sog: sog === 1023 ? null : sog / 10,
        lon: lonOf(int(b, 61, 28)), lat: latOf(int(b, 89, 27)), cog: cog === 3600 ? null : cog / 10, heading: hdg === 511 ? null : hdg, cls: 'A' });
      m.statusText = NAV_STATUS[m.status] || '';
      break;
    }
    case 4: Object.assign(m, { lon: lonOf(int(b, 79, 28)), lat: latOf(int(b, 107, 27)), base: true }); break;
    case 5: {
      Object.assign(m, { imo: uint(b, 40, 30) || null, callsign: text(b, 70, 42), name: text(b, 112, 120), shipType: uint(b, 232, 8),
        length: uint(b, 240, 9) + uint(b, 249, 9), beam: uint(b, 258, 6) + uint(b, 264, 6), draught: uint(b, 294, 8) / 10, destination: text(b, 302, 120), cls: 'A' });
      const mo = uint(b, 274, 4), d = uint(b, 278, 5), h = uint(b, 283, 5), mi = uint(b, 288, 6);
      if (mo && d) m.eta = `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')} ${String(h % 24).padStart(2, '0')}:${String(mi % 60).padStart(2, '0')} UTC`;
      m.shipTypeText = shipType(m.shipType);
      break;
    }
    case 9: { const sog = uint(b, 50, 10), cog = uint(b, 116, 12);
      Object.assign(m, { alt: uint(b, 38, 12), sog: sog === 1023 ? null : sog, lon: lonOf(int(b, 61, 28)), lat: latOf(int(b, 89, 27)), cog: cog === 3600 ? null : cog / 10, aircraft: true }); break; }
    case 14: m.safetyText = text(b, 40, b.length - 40); break;
    case 18: case 19: {
      const sog = uint(b, 46, 10), cog = uint(b, 112, 12), hdg = uint(b, 124, 9);
      Object.assign(m, { sog: sog === 1023 ? null : sog / 10, lon: lonOf(int(b, 57, 28)), lat: latOf(int(b, 85, 27)), cog: cog === 3600 ? null : cog / 10, heading: hdg === 511 ? null : hdg, cls: 'B' });
      if (type === 19) { m.name = text(b, 143, 120); m.shipType = uint(b, 263, 8); m.shipTypeText = shipType(m.shipType); }
      break;
    }
    case 21: Object.assign(m, { aidType: uint(b, 38, 5), name: text(b, 43, 120), lon: lonOf(int(b, 164, 28)), lat: latOf(int(b, 192, 27)), aton: true }); break;
    case 24: {
      const part = uint(b, 38, 2);
      if (part === 0) m.name = text(b, 40, 120);
      else { m.shipType = uint(b, 40, 8); m.shipTypeText = shipType(m.shipType); m.callsign = text(b, 90, 42); }
      m.cls = 'B';
      break;
    }
    default: break;
  }
  // AIS-SART / MOB / EPIRB-AIS: distress devices (status 14 or their own MMSI ranges).
  if (['AIS-SART', 'MOB device', 'EPIRB-AIS'].includes(m.kind) || m.status === 14) {
    m.distress = !/TEST/i.test(m.safetyText || '');
  }
  return m;
}

/** Feed NMEA lines one at a time; returns decoded messages when complete (multi-part aware). */
export class AisDecoder {
  constructor() { this.parts = new Map(); }
  push(line) {
    line = String(line).trim();
    if (!/^!(AI|AB|BS|SA|AN)VD[MO],/.test(line)) return null;
    if (/\*[0-9A-F]{2}$/i.test(line) && !nmeaChecksumOk(line)) return null;
    const f = line.split('*')[0].split(',');
    const total = +f[1], num = +f[2], seq = f[3], chan = f[4], payload = f[5], fill = +f[6] || 0;
    if (!(total >= 1 && num >= 1 && num <= total)) return null;
    try {
      if (total === 1) return { ...decodePayload(payload, fill), channel: chan, own: line[5] === 'O' };
      const key = `${seq}|${chan}`;
      const p = this.parts.get(key) || { got: [], at: Date.now() };
      p.got[num - 1] = payload; if (num === total) p.fill = fill;
      this.parts.set(key, p);
      for (const [k, v] of this.parts) if (Date.now() - v.at > 10e3) this.parts.delete(k);
      if (p.got.filter((x) => x != null).length === total) { this.parts.delete(key); return { ...decodePayload(p.got.join(''), p.fill || 0), channel: chan }; }
    } catch { return null; }
    return null;
  }
}
