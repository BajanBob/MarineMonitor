// Marine Monitor relay — zero npm dependencies (Node ≥ 22).
// • Serves the Marine Monitor web app.
// • Internet AIS: keeps one connection to AISStream.io (needs AISSTREAM_KEY; their service does
//   not allow browser connections) and hands the app the ships in the area.
// • Direct-RF feed: a receiver at the coastal station (helper/marine_helper.py) can push the
//   NMEA it hears (AIS, DSC) and decoded alerts (NAVTEX, 406 MHz beacons) here with FEED_KEY,
//   so phones anywhere see the station's own RF picture too.
// • Weather: aggregates NOAA (GFS/WaveWatch via Open-Meteo, NDBC buoys, aviationweather.gov METAR
//   issued by the Barbados Meteorological Services for TBPB) and NGA NAVAREA IV warnings.
// Receive-only: nothing here transmits on any radio.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AisDecoder, mmsiKind, mmsiCountry, shipType } from '../www/lib/ais.js';
import { parseDsc, parseNavtex, parseBeaconHex } from '../www/lib/gmdss.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.join(HERE, '..', 'www');
const KN = 1.852; // km/h per knot

// ---------------------------------------------------------------- ship picture
export function createFleet({ now = Date.now, maxAgeMs = 20 * 60e3, max = 8000 } = {}) {
  const ships = new Map(); // mmsi → ship
  const alerts = [];       // newest first, capped
  function upsert(mmsi, fields, src) {
    if (!mmsi) return null;
    const s = ships.get(mmsi) || { mmsi, kind: mmsiKind(mmsi), country: mmsiCountry(mmsi), sources: {} };
    for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') s[k] = v;
    s.sources[src] = now(); s.last = now();
    ships.set(mmsi, s);
    if (ships.size > max) { const oldest = [...ships.values()].sort((a, b) => a.last - b.last)[0]; ships.delete(oldest.mmsi); }
    return s;
  }
  function addAlert(a) {
    const key = `${a.kind}|${a.mmsi || a.hex || a.number || ''}|${a.to || ''}|${a.level}|${a.body || a.nature || ''}|${a.ack || ''}`.slice(0, 200);
    const dup = alerts.find((x) => x.key === key && now() - x.at < 15 * 60e3);
    if (dup) { dup.count = (dup.count || 1) + 1; dup.last = now(); return dup; }
    const rec = { ...a, key, id: crypto.randomBytes(6).toString('base64url'), at: now() };
    alerts.unshift(rec); if (alerts.length > 300) alerts.length = 300;
    return rec;
  }
  /** One decoded AIS message (from our own AIS decoder). */
  function fromAis(m, src) {
    if (!m?.mmsi) return;
    const f = { lat: m.lat, lon: m.lon, sog: m.sog, cog: m.cog, heading: m.heading, status: m.statusText, name: m.name, callsign: m.callsign,
      destination: m.destination, shipType: m.shipTypeText, imo: m.imo, length: m.length || null, cls: m.cls, aton: m.aton || null, base: m.base || null };
    if (m.lat == null || m.lon == null) { delete f.lat; delete f.lon; }
    const s = upsert(m.mmsi, f, src);
    if (m.distress || m.type === 14) addAlert({ kind: 'ais', level: m.distress ? 'distress' : 'safety', mmsi: String(m.mmsi), device: m.kind, text: m.safetyText || `${m.kind} ${m.distress ? 'ACTIVE' : 'message'}`, lat: s?.lat, lon: s?.lon, src });
  }
  function list(bbox = null) {
    const t = now();
    for (const [k, s] of ships) if (t - s.last > maxAgeMs) ships.delete(k);
    return [...ships.values()].filter((s) => s.lat != null && s.lon != null && (!bbox || (s.lat >= bbox[0] && s.lat <= bbox[2] && s.lon >= bbox[1] && s.lon <= bbox[3])))
      .map((s) => ({ ...s, sources: Object.keys(s.sources).filter((k) => t - s.sources[k] < maxAgeMs), age: Math.round((t - s.last) / 1000) }));
  }
  return { upsert, fromAis, addAlert, list, alerts: () => alerts.slice(0, 100), size: () => ships.size };
}

// ---------------------------------------------------------------- AISStream (internet AIS)
export function startAisStream(fleet, { key = process.env.AISSTREAM_KEY || '', bbox = JSON.parse(process.env.AIS_BBOX || '[[[9.5,-65.5],[19.5,-53.5]]]'), WebSocketImpl = globalThis.WebSocket } = {}) {
  const state = { enabled: !!key, connected: false, messages: 0, error: key ? null : 'Set AISSTREAM_KEY (free at aisstream.io) to show internet AIS ships' };
  if (!key || !WebSocketImpl) return state;
  let backoff = 2000;
  const connect = () => {
    let ws;
    try { ws = new WebSocketImpl('wss://stream.aisstream.io/v0/stream'); } catch (e) { state.error = e.message; return setTimeout(connect, backoff); }
    ws.onopen = () => {
      ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: bbox, FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport', 'SafetyBroadcastMessage', 'AidsToNavigationReport'] }));
      state.connected = true; state.error = null; backoff = 2000;
    };
    ws.onmessage = async (e) => {
      try { handleAisStream(fleet, JSON.parse(typeof e.data === 'string' ? e.data : await new Response(e.data).text())); state.messages++; } catch { /* skip */ }
    };
    ws.onerror = () => { state.error = 'AISStream connection error'; };
    ws.onclose = () => { state.connected = false; backoff = Math.min(backoff * 2, 120e3); setTimeout(connect, backoff); };
  };
  connect();
  return state;
}

/** One AISStream.io message → fleet. Field names follow their documentation (both casings accepted). */
export function handleAisStream(fleet, msg) {
  const md = msg.MetaData || {};
  const mmsi = +(md.MMSI ?? md.mmsi ?? 0);
  if (!mmsi) return;
  const lat = md.latitude ?? md.Latitude, lon = md.longitude ?? md.Longitude;
  const body = msg.Message?.[msg.MessageType] || {};
  const f = { name: (md.ShipName || '').trim() || undefined };
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) { f.lat = lat; f.lon = lon; }
  switch (msg.MessageType) {
    case 'PositionReport': case 'StandardClassBPositionReport': case 'ExtendedClassBPositionReport':
      Object.assign(f, { sog: body.Sog < 102.3 ? body.Sog : undefined, cog: body.Cog < 360 ? body.Cog : undefined, heading: body.TrueHeading < 360 ? body.TrueHeading : undefined, cls: msg.MessageType === 'PositionReport' ? 'A' : 'B' });
      if (body.NavigationalStatus != null) f.status = ['Under way (engine)', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draught', 'Moored', 'Aground', 'Fishing', 'Under way (sail)'][body.NavigationalStatus];
      break;
    case 'ShipStaticData': {
      const dim = body.Dimension || {};
      Object.assign(f, { name: (body.Name || f.name || '').trim() || undefined, callsign: (body.CallSign || '').trim() || undefined, destination: (body.Destination || '').trim() || undefined,
        shipType: body.Type ? shipType(body.Type) : undefined, imo: body.ImoNumber || undefined, length: (dim.A || 0) + (dim.B || 0) || undefined });
      break;
    }
    case 'StaticDataReport': {
      const a = body.ReportA, b = body.ReportB;
      if (a?.Valid && a.Name) f.name = a.Name.trim();
      if (b?.Valid) { if (b.ShipType) f.shipType = shipType(b.ShipType); if (b.CallSign) f.callsign = b.CallSign.trim(); }
      break;
    }
    case 'AidsToNavigationReport': f.aton = true; if (body.Name) f.name = body.Name.trim(); break;
    case 'SafetyBroadcastMessage':
      fleet.addAlert({ kind: 'ais', level: ['AIS-SART', 'MOB device', 'EPIRB-AIS'].includes(mmsiKind(mmsi)) && !/TEST/i.test(body.Text || '') ? 'distress' : 'safety', mmsi: String(mmsi), device: mmsiKind(mmsi), text: body.Text || '', lat: f.lat, lon: f.lon, src: 'internet' });
      break;
    default: break;
  }
  const s = fleet.upsert(mmsi, f, 'internet');
  if (['AIS-SART', 'MOB device', 'EPIRB-AIS'].includes(s.kind) && s.lat != null) fleet.addAlert({ kind: 'ais', level: 'distress', mmsi: String(mmsi), device: s.kind, text: `${s.kind} active`, lat: s.lat, lon: s.lon, src: 'internet' });
}

// ---------------------------------------------------------------- direct-RF feed (from the station's receiver)
export function ingestFeed(fleet, decoder, { lines = [], alerts = [] } = {}) {
  let n = 0;
  for (const raw of lines.slice(0, 2000)) {
    const line = String(raw).trim();
    if (!line) continue;
    const ais = decoder.push(line);
    if (ais) { fleet.fromAis(ais, 'rf'); n++; continue; }
    const dsc = parseDsc(line);
    if (dsc) { fleet.addAlert({ ...dsc, src: 'rf' }); n++; }
  }
  for (const a of alerts.slice(0, 200)) {
    if (a?.kind === 'dsc' && a.line) { const d = parseDsc(String(a.line)); if (d) { fleet.addAlert({ ...d, to: /^\d{9}$/.test(String(a.to)) ? String(a.to) : null, freq: Number.isFinite(a.freq) ? a.freq : null, src: 'rf' }); n++; } }
    else if (a?.kind === 'navtex' && a.text) { const p = parseNavtex(a.text); if (p) { fleet.addAlert({ ...p, freq: a.freq || null, src: 'rf' }); n++; } }
    else if (a?.kind === 'epirb' && a.hex) { const p = parseBeaconHex(a.hex); if (p) { fleet.addAlert({ ...p, lat: a.lat ?? null, lon: a.lon ?? null, src: 'rf' }); n++; } }
    else if (a?.kind === 'egc' && a.text) { fleet.addAlert({ kind: 'egc', level: /MAYDAY|DISTRESS/i.test(a.text) ? 'distress' : /PAN.?PAN|URGENT/i.test(a.text) ? 'urgency' : 'safety', body: String(a.text).slice(0, 4000), service: 'Inmarsat-C SafetyNET', src: 'rf' }); n++; }
  }
  return n;
}

// ---------------------------------------------------------------- weather and warnings
const num = (v) => (v === null || v === undefined || v === '' || v === 'MM' || Number.isNaN(+v) ? null : +v);

/** Parse the newest observation from an NDBC realtime2 text file. */
export function parseNdbc(text) {
  const lines = String(text).split('\n').filter(Boolean);
  const head = (lines.find((l) => l.startsWith('#YY')) || '').replace('#', '').trim().split(/\s+/);
  const row = lines.find((l) => !l.startsWith('#'));
  if (!head.length || !row) return null;
  const v = Object.fromEntries(row.trim().split(/\s+/).map((x, i) => [head[i], x]));
  const ms = (x) => (num(x) == null ? null : Math.round(num(x) * 1.94384 * 10) / 10);
  return {
    time: `${v.YY}-${v.MM}-${v.DD}T${v.hh}:${v.mm}:00Z`, windDir: num(v.WDIR), windKt: ms(v.WSPD), gustKt: ms(v.GST), waveM: num(v.WVHT), wavePeriodS: num(v.DPD), avgPeriodS: num(v.APD),
    waveDir: num(v.MWD), pressureHpa: num(v.PRES), airC: num(v.ATMP), seaC: num(v.WTMP), visNm: num(v.VIS), pressureTendency: num(v.PTDY), tideFt: num(v.TIDE),
  };
}

/** High and low waters from an hourly sea-level series (local extrema). */
export function tideTurns(times, levels) {
  const out = [];
  for (let i = 1; i < levels.length - 1; i++) {
    const a = levels[i - 1], b = levels[i], c = levels[i + 1];
    if (a == null || b == null || c == null) continue;
    const type = b > a && b >= c ? 'High' : b < a && b <= c ? 'Low' : null;
    if (!type) continue;
    const prev = out[out.length - 1];
    if (prev?.type === type) { if ((type === 'High') === (b > prev.m)) Object.assign(prev, { time: times[i], m: b }); continue; } // one turn per high/low
    out.push({ type, time: times[i], m: b });
  }
  return out;
}

export async function getWeather({ lat, lon, buoy = '41040', metar = 'TBPB' }, fetchImpl = globalThis.fetch) {
  const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`;
  const get = async (url, kind = 'json') => {
    const r = await fetchImpl(url, { headers: { 'user-agent': 'MarineMonitor/1.0 (coast watch)' }, signal: AbortSignal.timeout(12e3) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return kind === 'json' ? r.json() : r.text();
  };
  const [fc, mar, ndbc, met] = await Promise.allSettled([
    get(`https://api.open-meteo.com/v1/forecast?${q}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,temperature_2m,weather_code&hourly=visibility,pressure_msl&wind_speed_unit=kn&past_hours=3&forecast_hours=24&timezone=UTC`),
    get(`https://marine-api.open-meteo.com/v1/marine?${q}&current=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction,ocean_current_velocity,ocean_current_direction,sea_level_height_msl,sea_surface_temperature&hourly=sea_level_height_msl,wave_height&past_hours=6&forecast_hours=36&timezone=UTC&cell_selection=sea`),
    /^[A-Z0-9]{5}$/i.test(buoy) ? get(`https://www.ndbc.noaa.gov/data/realtime2/${buoy.toUpperCase()}.txt`, 'text') : Promise.reject(new Error('no buoy')),
    /^[A-Z]{4}$/i.test(metar) ? get(`https://aviationweather.gov/api/data/metar?ids=${metar.toUpperCase()}&format=json`) : Promise.reject(new Error('no station')),
  ]);
  const out = { lat, lon, sources: [], at: Date.now() };
  if (fc.status === 'fulfilled') {
    const c = fc.value.current || {}, h = fc.value.hourly || {};
    const i = (h.time || []).findIndex((t) => t >= (c.time || '')); const vis = i >= 0 ? h.visibility?.[i] : null;
    const p3 = h.pressure_msl?.[Math.max(0, i - 3)];
    out.wind = { kt: c.wind_speed_10m, dir: c.wind_direction_10m, gustKt: c.wind_gusts_10m, source: 'NOAA GFS via Open-Meteo' };
    out.pressure = { hpa: c.pressure_msl, trend3h: c.pressure_msl != null && p3 != null ? Math.round((c.pressure_msl - p3) * 10) / 10 : null };
    out.visibility = { nm: vis != null ? Math.round((vis / 1852) * 10) / 10 : null };
    out.airC = c.temperature_2m; out.weatherCode = c.weather_code;
    out.sources.push('NOAA GFS model (Open-Meteo)');
  }
  if (mar.status === 'fulfilled') {
    const c = mar.value.current || {}, h = mar.value.hourly || {};
    out.waves = { m: c.wave_height, periodS: c.wave_period, dir: c.wave_direction, swellM: c.swell_wave_height, swellPeriodS: c.swell_wave_period, swellDir: c.swell_wave_direction };
    out.current = { kt: c.ocean_current_velocity != null ? Math.round((c.ocean_current_velocity / KN) * 100) / 100 : null, setDeg: c.ocean_current_direction }; // set = direction towards; drift = speed
    out.seaC = c.sea_surface_temperature;
    out.tide = { nowM: c.sea_level_height_msl, series: (h.time || []).map((t, k) => ({ t, m: h.sea_level_height_msl?.[k] })), turns: tideTurns(h.time || [], h.sea_level_height_msl || []).filter((x) => x.time >= (c.time || '')).slice(0, 4) };
    out.sources.push('NOAA WaveWatch III / global ocean model (Open-Meteo Marine)');
  }
  if (ndbc.status === 'fulfilled') { out.buoy = { id: buoy.toUpperCase(), ...parseNdbc(ndbc.value) }; out.sources.push(`NOAA NDBC buoy ${buoy.toUpperCase()}`); }
  if (met.status === 'fulfilled' && Array.isArray(met.value) && met.value[0]) {
    const m = met.value[0];
    out.metar = { station: metar.toUpperCase(), raw: m.rawOb, time: m.reportTime || m.obsTime, windDir: m.wdir, windKt: m.wspd, gustKt: m.wgst ?? null, vis: m.visib, pressureHpa: m.altim, airC: m.temp };
    out.sources.push(`${metar.toUpperCase()} METAR (Barbados Meteorological Services, via NOAA aviationweather.gov)`);
  }
  return out;
}

export async function getNavWarnings(fetchImpl = globalThis.fetch) {
  const urls = ['https://msi.nga.mil/api/publications/broadcast-warn?output=json&navArea=4&status=active', 'https://msi.om.east.paas.nga.mil/api/publications/broadcast-warn?output=json'];
  for (const u of urls) {
    try {
      const r = await fetchImpl(u, { headers: { accept: 'application/json', 'user-agent': 'MarineMonitor/1.0' }, signal: AbortSignal.timeout(15e3) });
      if (!r.ok) continue;
      const j = await r.json();
      const list = (j['broadcast-warn'] || j.broadcastWarn || []).filter((w) => String(w.navArea) === '4' || /^IV$/i.test(String(w.navArea)));
      return list.sort((a, b) => String(b.issueDate).localeCompare(String(a.issueDate))).slice(0, 60)
        .map((w) => ({ id: `NAVAREA IV ${w.msgNumber}/${w.msgYear}`, issued: w.issueDate, subregion: w.subregion, authority: w.authority, text: String(w.text || '').slice(0, 3000), level: /DISTRESS|MAYDAY|OVERDUE|MISSING|SEARCH AND RESCUE|SAR\b/i.test(w.text || '') ? 'urgency' : 'safety' }));
    } catch { /* next */ }
  }
  throw new Error('NAVAREA warnings unavailable');
}

// ---------------------------------------------------------------- HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://*.basemaps.cartocdn.com https://tiles.openseamap.org; connect-src 'self' ws: wss: https:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

const cleanRig = (r) => (r && typeof r === 'object' ? { rig: String(r.rig || '').slice(0, 12), label: String(r.label || '').slice(0, 20), mode: String(r.mode || '').slice(0, 12), modeName: String(r.modeName || '').slice(0, 60), channel: String(r.channel || '').slice(0, 60), freq: +r.freq || null, dwell: +r.dwell || null } : null);
export function startRelay({ port = +process.env.PORT || 8800, host = process.env.HOST || '127.0.0.1', fetchImpl = globalThis.fetch, aisKey = process.env.AISSTREAM_KEY || '', feedKey = process.env.FEED_KEY || '', now = Date.now, WebSocketImpl } = {}) {
  const fleet = createFleet({ now });
  const decoder = new AisDecoder();
  const ais = startAisStream(fleet, { key: aisKey, WebSocketImpl });
  const cache = new Map();
  const cached = async (k, ms, fn) => { const c = cache.get(k); if (c && now() - c.at < ms) return c.v; const v = await fn(); cache.set(k, { at: now(), v }); if (cache.size > 300) cache.delete(cache.keys().next().value); return v; };
  let lastFeed = 0, rfStatus = null;
  const files = {};
  const walk = (dir, base = '') => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = `${base}/${e.name}`; if (e.isDirectory()) walk(path.join(dir, e.name), r); else if (TYPES[path.extname(e.name)]) files[r] = { type: TYPES[path.extname(e.name)], body: fs.readFileSync(path.join(dir, e.name)) }; } };
  walk(WWW); files['/'] = files['/index.html'];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const p = url.pathname;
    const send = (code, body, headers = {}) => {
      const json = typeof body !== 'string' && !Buffer.isBuffer(body);
      res.writeHead(code, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-feed-key', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'cache-control': 'no-store', ...(json ? { 'content-type': 'application/json' } : {}), ...headers });
      res.end(json ? JSON.stringify(body) : body);
    };
    try {
      if (req.method === 'OPTIONS') return send(204, '');
      if (p === '/healthz') return send(200, 'ok', { 'content-type': 'text/plain' });
      if (req.method === 'GET' && p === '/api/status') return send(200, { ais: { enabled: ais.enabled, connected: ais.connected, messages: ais.messages, error: ais.error }, ships: fleet.size(), rfFeed: { last: lastFeed || null, keySet: !!feedKey } });
      if (req.method === 'GET' && p === '/api/ships') {
        const b = (url.searchParams.get('bbox') || '').split(',').map(Number);
        return send(200, { ships: fleet.list(b.length === 4 && b.every(Number.isFinite) ? b : null), ais: { enabled: ais.enabled, connected: ais.connected, error: ais.error }, rfFeed: lastFeed || null, rfStatus: lastFeed && now() - lastFeed < 5 * 60e3 ? rfStatus : null, at: now() });
      }
      if (req.method === 'GET' && p === '/api/alerts') return send(200, { alerts: fleet.alerts(), at: now() });
      if (req.method === 'GET' && p === '/api/msi') {
        try { return send(200, { warnings: await cached('msi', 30 * 60e3, () => getNavWarnings(fetchImpl)) }); } catch (e) { return send(502, { error: e.message }); }
      }
      if (req.method === 'GET' && p === '/api/wx') {
        const lat = +url.searchParams.get('lat'), lon = +url.searchParams.get('lon');
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return send(400, { error: 'lat/lon required' });
        const buoy = String(url.searchParams.get('buoy') || '41040').slice(0, 5), metar = String(url.searchParams.get('metar') || 'TBPB').slice(0, 4);
        const k = `wx|${lat.toFixed(2)}|${lon.toFixed(2)}|${buoy}|${metar}`;
        return send(200, await cached(k, 10 * 60e3, () => getWeather({ lat, lon, buoy, metar }, fetchImpl)));
      }
      if (req.method === 'GET' && p === '/api/where') { // approximate location of the person asking, from their IP address
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        try {
          const j = await cached(`ip|${ip}`, 60 * 60e3, async () => { const r = await fetchImpl(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: AbortSignal.timeout(8e3) }); return r.json(); });
          if (!Number.isFinite(j.latitude)) throw new Error('unknown');
          return send(200, { lat: j.latitude, lon: j.longitude, city: j.city || '', country: j.country_name || '' });
        } catch { return send(502, { error: 'Couldn’t work out your location from your internet address — type your grid square instead' }); }
      }
      if (req.method === 'POST' && p === '/api/feed') {
        const k = String(req.headers['x-feed-key'] || '');
        if (feedKey.length < 16 || k.length !== feedKey.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(feedKey))) return send(403, { error: 'bad feed key' });
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 512 * 1024) return send(413, { error: 'too large' }); chunks.push(c); }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const n = ingestFeed(fleet, decoder, body); lastFeed = now();
        if (body.bands && typeof body.bands === 'object') rfStatus = { bands: Object.fromEntries(Object.entries(body.bands).slice(0, 40).map(([k, v]) => [String(k).slice(0, 60), { live: !!v?.live, count: +v?.count || 0 }])), rx: cleanRig(body.rx), rigs: body.rigs && typeof body.rigs === 'object' ? Object.fromEntries(Object.entries(body.rigs).slice(0, 4).filter(([k]) => /^[a-z0-9]{2,12}$/.test(k)).map(([k, v]) => [k, cleanRig(v)])) : null };
        return send(200, { ok: true, accepted: n });
      }
      const f = req.method === 'GET' ? files[p] : null;
      if (f) return send(200, f.body, { 'content-type': f.type, 'content-security-policy': CSP, 'cache-control': p.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache' });
      return send(404, { error: 'not found' });
    } catch (e) { return send(500, { error: e.message }); }
  });
  server.fleet = fleet; server.ais = ais;
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startRelay({ host: process.env.HOST || '0.0.0.0' }).then((s) => console.log(`Marine Monitor relay on ${s.address().port}`));
}
