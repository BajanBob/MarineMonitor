// Geography helpers: Maidenhead grid squares, great-circle bearing and distance (nautical miles).

const R_NM = 3440.065; // mean Earth radius in nautical miles
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Maidenhead locator (4, 6, 8 or 10 characters) → centre of the square { lat, lon }. */
export function gridToLatLon(grid) {
  const g = String(grid || '').trim();
  if (!/^[A-Ra-r]{2}([0-9]{2}([A-Xa-x]{2}([0-9]{2}([A-Xa-x]{2})?)?)?)?$/.test(g) || g.length < 4) throw new Error('Enter a grid square like FK93 or FK93nc');
  const u = g.toUpperCase();
  let lon = (u.charCodeAt(0) - 65) * 20 - 180, lat = (u.charCodeAt(1) - 65) * 10 - 90;
  let w = 20, h = 10; // size of the current square in degrees
  lon += +u[2] * 2; lat += +u[3]; w = 2; h = 1;
  if (u.length >= 6) { w /= 24; h /= 24; lon += (u.charCodeAt(4) - 65) * w; lat += (u.charCodeAt(5) - 65) * h; }
  if (u.length >= 8) { w /= 10; h /= 10; lon += +u[6] * w; lat += +u[7] * h; }
  if (u.length >= 10) { w /= 24; h /= 24; lon += (u.charCodeAt(8) - 65) * w; lat += (u.charCodeAt(9) - 65) * h; }
  return { lat: lat + h / 2, lon: lon + w / 2 };
}

/** lat/lon → 6-character Maidenhead locator. */
export function latLonToGrid(lat, lon) {
  let x = lon + 180, y = lat + 90;
  const A = (n) => String.fromCharCode(65 + n), a = (n) => String.fromCharCode(97 + n);
  const f1 = Math.floor(x / 20), f2 = Math.floor(y / 10);
  x -= f1 * 20; y -= f2 * 10;
  const s1 = Math.floor(x / 2), s2 = Math.floor(y);
  x -= s1 * 2; y -= s2;
  return `${A(f1)}${A(f2)}${s1}${s2}${a(Math.floor(x * 12))}${a(Math.floor(y * 24))}`;
}

/** Initial great-circle bearing (degrees true, 0–360) from a to b. */
export function bearing(a, b) {
  const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Great-circle distance in nautical miles. */
export function distanceNm(a, b) {
  const p1 = rad(a.lat), p2 = rad(b.lat), dp = p2 - p1, dl = rad(b.lon - a.lon);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point reached from `a` going `nm` nautical miles on bearing `brg`. */
export function destination(a, brg, nm) {
  const d = nm / R_NM, t = rad(brg), p1 = rad(a.lat), l1 = rad(a.lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lon: ((deg(l2) + 540) % 360) - 180 };
}

/** Closest point of approach of a moving target to a fixed station (flat-earth, fine within ~100 NM).
 *  Returns { cpaNm, tcpaMin } — tcpaMin < 0 means it is moving away. */
export function cpa(station, target) {
  if (!(target.sog > 0.1) || target.cog == null) return null;
  const brg = rad(bearing(station, target)), dist = distanceNm(station, target);
  const px = dist * Math.sin(brg), py = dist * Math.cos(brg); // target position, NM east/north of station
  const vx = target.sog * Math.sin(rad(target.cog)) / 60, vy = target.sog * Math.cos(rad(target.cog)) / 60; // NM per minute
  const v2 = vx * vx + vy * vy;
  const t = -(px * vx + py * vy) / v2;
  const cx = px + vx * Math.max(0, t), cy = py + vy * Math.max(0, t);
  return { cpaNm: Math.hypot(cx, cy), tcpaMin: t };
}

export const compass = (d) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
export const fmtLat = (v) => `${Math.floor(Math.abs(v))}°${((Math.abs(v) % 1) * 60).toFixed(2).padStart(5, '0')}′${v >= 0 ? 'N' : 'S'}`;
export const fmtLon = (v) => `${String(Math.floor(Math.abs(v))).padStart(3, '0')}°${((Math.abs(v) % 1) * 60).toFixed(2).padStart(5, '0')}′${v >= 0 ? 'E' : 'W'}`;
