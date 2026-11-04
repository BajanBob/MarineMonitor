// Marine Monitor — coast-watch receiver display. Receive-only.
import { gridToLatLon, gridBounds, latLonToGrid, bearing, distanceNm, destination, cpa, compass, fmtLat, fmtLon } from './lib/geo.js';
import { AisDecoder, mmsiKind, mmsiCountry, mmsiDecode } from './lib/ais.js';
import { parseDsc, parseNavtex, parseBeaconHex, buildDscCall } from './lib/gmdss.js';
import { Radar } from './lib/radar.js';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (v == null || v === false) continue; if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
  e.append(...kids.flat().filter((x) => x != null && x !== false));
  return e;
};
const store = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* fine */ } } };
function toast(m, ms = 3500) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }
const n1 = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : (+v).toFixed(d));
const ago = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
const localTime = (iso) => { const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`); return Number.isNaN(+d) ? iso : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }); };

// ---------------------------------------------------------------- settings
const hosted = /^https?:$/.test(location.protocol) && !['localhost', ''].includes(location.hostname);
const DEFAULTS = { call: '8PFX', name: 'Ocean City', grid: 'GK03ec', grid2: 'GK03ff', origin: 'sw', mmsi: '', aisSrc: 'both', dscSrc: 'both', lat: null, lon: null, relay: hosted ? '' : 'https://marine-monitor-16qf.onrender.com', rx: '', buoy: '41040', metar: 'TBPB', alarm: true, demo: false, face: 'day', range: 24 };
const S = { ...DEFAULTS, ...store.get('mm-settings', {}) };
const save = () => store.set('mm-settings', S);
/** Station reference point and watch area from the SW and NE grid squares (default GK03ec Bridgetown → GK03ff Bathsheba). */
function area() {
  try {
    const a = gridBounds(S.grid), b = S.grid2 ? gridBounds(S.grid2) : a;
    return { s: Math.min(a.s, b.s), w: Math.min(a.w, b.w), n: Math.max(a.n, b.n), e: Math.max(a.e, b.e) };
  } catch { return null; }
}
function computeStation() {
  try {
    const sw = gridToLatLon(S.grid), ne = S.grid2 ? gridToLatLon(S.grid2) : sw;
    const p = S.origin === 'ne' ? ne : S.origin === 'centre' ? { lat: (sw.lat + ne.lat) / 2, lon: (sw.lon + ne.lon) / 2 } : sw;
    S.lat = p.lat; S.lon = p.lon;
  } catch { /* typed location (internet) kept */ }
}
if (S.lat == null && S.grid) computeStation();
const station = () => (S.lat != null ? { lat: S.lat, lon: S.lon } : null);
const api = (p) => `${(S.relay || '').replace(/\/$/, '')}${p}`;

function applyFace() {
  document.body.className = S.face === 'night' ? 'night' : 'day';
  $('#face-day').classList.toggle('on', S.face !== 'night'); $('#face-night').classList.toggle('on', S.face === 'night');
  document.querySelector('meta[name=theme-color]').setAttribute('content', S.face === 'night' ? '#000000' : '#06141f');
}
$('#face-day').addEventListener('click', () => { S.face = 'day'; save(); applyFace(); });
$('#face-night').addEventListener('click', () => { S.face = 'night'; save(); applyFace(); });

function stationLine() {
  const s = station();
  const g = S.grid ? `${S.grid}${S.grid2 && S.grid2 !== S.grid ? `–${S.grid2}` : ''}` : latLonToGrid(s?.lat || 0, s?.lon || 0);
  $('#station-line').textContent = s ? `${S.call} ${S.name} · ${g} · ${fmtLat(s.lat)} ${fmtLon(s.lon)}` : `${S.call} ${S.name} · set the grid square in Settings`;
}

// ---------------------------------------------------------------- tabs
let map = null;
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
function showTab(id) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('on', b.dataset.tab === id);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.id === `tab-${id}`);
  if (id === 'map') { initMap(); setTimeout(() => map?.invalidateSize(), 50); }
  if (id === 'wx') drawTide();
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
}

// ---------------------------------------------------------------- ships (internet AIS + direct RF)
const ships = new Map();      // mmsi → ship (merged)
const localRf = new Map();    // ships heard on the LAN receiver
const decoder = new AisDecoder();
let alerts = [], localAlerts = [], aisState = null, rfFeedAt = null;
let selected = null;

function merged() {
  const out = new Map();
  for (const s of ships.values()) out.set(s.mmsi, { ...s, sources: [...(s.sources || [])] });
  for (const s of localRf.values()) {
    const o = out.get(s.mmsi) || { mmsi: s.mmsi, kind: mmsiKind(s.mmsi), country: mmsiCountry(s.mmsi), sources: [] };
    for (const [k, v] of Object.entries(s)) if (v != null && v !== '') o[k] = v;
    if (!o.sources.includes('rf')) o.sources.push('rf');
    out.set(s.mmsi, o);
  }
  if (S.demo) for (const d of demoTargets()) out.set(d.mmsi, d);
  const st = station();
  const want = S.aisSrc === 'internet' ? ['internet'] : S.aisSrc === 'rf' ? ['rf'] : ['internet', 'rf'];
  const list = [...out.values()].map((s) => ({ ...s, sources: s.sources.filter((x) => want.includes(x)) })).filter((s) => s.lat != null && s.sources.length);
  for (const s of list) {
    s.alarm = ['AIS-SART', 'MOB device', 'EPIRB-AIS'].includes(s.kind);
    if (st) { s.brg = bearing(st, s); s.rng = distanceNm(st, s); const c = cpa(st, s); s.cpa = c && c.tcpaMin > 0 ? c.cpaNm : null; s.tcpa = c && c.tcpaMin > 0 ? c.tcpaMin : null; }
  }
  return list.sort((a, b) => (b.alarm - a.alarm) || (a.rng ?? 1e9) - (b.rng ?? 1e9));
}

let demoT0 = Date.now();
function demoTargets() {
  const st = station(); if (!st) return [];
  const mins = (Date.now() - demoT0) / 60000;
  const mk = (mmsi, name, brg, nm, cog, sog, extra = {}) => ({ mmsi, name: `DEMO ${name}`, ...destination(destination(st, brg, nm), cog, (sog * mins) / 60), cog, sog, heading: cog, sources: ['internet'], demo: true, kind: mmsiKind(mmsi), ...extra });
  return [mk(900000001, 'CARGO', 250, 14, 120, 12.5, { shipType: 'Cargo' }), mk(900000002, 'FISHING', 200, 5, 30, 4, { sources: ['rf'], shipType: 'Fishing' }),
    mk(900000003, 'CRUISE', 300, 9, 135, 15, { sources: ['internet', 'rf'], shipType: 'Passenger' }), mk(970000009, 'SART', 160, 7, 0, 0, { kind: 'AIS-SART' })];
}

async function loadShips() {
  try {
    const r = await fetch(api('/api/ships'), { cache: 'no-store' });
    const j = await r.json();
    ships.clear(); for (const s of j.ships) ships.set(s.mmsi, s);
    aisState = j.ais; rfFeedAt = j.rfFeed;
    if (!rxWs && j.rfStatus) { rxStatus = j.rfStatus; renderRx(); }
  } catch { aisState = { error: 'Can’t reach the Marine Monitor relay' }; }
  refreshTargets();
}

let radar = null;
function refreshTargets() {
  const list = merged();
  radar?.setTargets(list);
  $('#tcount').textContent = `(${list.length})`;
  const net = list.filter((s) => s.sources.includes('internet')).length, rf = list.filter((s) => s.sources.includes('rf')).length;
  $('#ais-status').textContent = `Showing: ${{ internet: 'internet AIS only', rf: 'direct RF only', both: 'internet + RF' }[S.aisSrc]} · Internet AIS: ${aisState?.connected ? `live · ${net} ships` : aisState?.error || 'connecting…'} · Direct RF: ${rf ? `${rf} ships` : rfFeedAt || rxWs ? 'no ships heard yet' : 'no receiver connected'}${S.demo ? ' · DEMO targets shown' : ''}`;
  $('#tlist tbody').replaceChildren(...list.slice(0, 200).map((s) => el('tr', { class: `${s.mmsi === selected ? 'sel' : ''} ${s.alarm ? 'alarm' : ''}`, onclick: () => pick(s.mmsi) },
    el('td', {}, (s.name || String(s.mmsi)) + (s.demo ? ' ' : ''), s.demo ? el('span', { class: 'demo-tag', text: 'DEMO' }) : null),
    el('td', { class: 'num', text: n1(s.brg, 0) }), el('td', { class: 'num', text: n1(s.rng) }), el('td', { class: 'num', text: n1(s.sog) }), el('td', { class: 'num', text: n1(s.cog, 0) }),
    el('td', { class: 'num', text: s.cpa != null ? `${n1(s.cpa)} / ${Math.round(s.tcpa)}m` : '–' }), el('td', { text: s.sources.map((x) => (x === 'rf' ? 'RF' : 'Net')).join('+') }))));
  showTarget(list.find((s) => s.mmsi === selected) || null);
  updateMap(list);
}

function pick(mmsi) { selected = mmsi; radar?.select(mmsi); refreshTargets(); }
function showTarget(s) {
  const box = $('#target');
  if (!s) { box.replaceChildren(el('p', { class: 'muted', text: 'Tap a target for bearing and range from the station.' })); return; }
  const rows = [
    ['Bearing from ' + S.call, s.brg != null ? `${n1(s.brg, 0)}° T (${compass(s.brg)})` : 'set station'], ['Range', s.rng != null ? `${n1(s.rng)} NM` : '–'],
    ['MMSI', `${s.mmsi} · ${s.kind}${s.country ? ` · ${s.country}` : ''}`], ['Call sign', s.callsign], ['Type', s.shipType], ['Status', s.status],
    ['SOG / COG', `${n1(s.sog)} kn / ${n1(s.cog, 0)}°`], ['Heading', s.heading != null ? `${s.heading}°` : null],
    ['CPA to station', s.cpa != null ? `${n1(s.cpa)} NM in ${Math.round(s.tcpa)} min` : 'opening / stationary'], ['Destination', s.destination], ['Length', s.length ? `${s.length} m` : null],
    ['Position', `${fmtLat(s.lat)} ${fmtLon(s.lon)}`], ['Heard by', s.sources.map((x) => (x === 'rf' ? 'direct RF' : 'internet AIS')).join(' + ')], ['Last report', s.age != null ? `${ago(s.age)} ago` : null],
  ].filter(([, v]) => v);
  box.replaceChildren(...[el('div', { class: 'big', text: `${s.name || s.mmsi}${s.demo ? ' (demo)' : ''}` }), s.alarm ? el('p', { class: 'lv', text: `⚠ ${s.kind} ACTIVE — distress device` }) : null,
    el('dl', {}, rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))].filter(Boolean));
}

// ---------------------------------------------------------------- map
let shipLayer = null, stationLayer = null, lineLayer = null;
function initMap() {
  if (map || !window.L) return;
  const st = station() || { lat: 13.1, lon: -59.6 };
  map = L.map('map').setView([st.lat, st.lon], 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
  L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { maxZoom: 18, attribution: 'Seamarks © OpenSeaMap' }).addTo(map);
  shipLayer = L.layerGroup().addTo(map); stationLayer = L.layerGroup().addTo(map); lineLayer = L.layerGroup().addTo(map);
  refreshTargets();
}
function shipIcon(s) {
  const col = s.alarm ? 'var(--t-alarm)' : s.aton ? 'var(--t-aton)' : s.sources.includes('rf') && s.sources.includes('internet') ? 'var(--t-both)' : s.sources.includes('rf') ? 'var(--t-rf)' : 'var(--t-net)';
  const rot = s.heading ?? s.cog ?? 0;
  return L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: `<svg class="ship-icon" viewBox="0 0 18 18" style="transform:rotate(${Number(rot) || 0}deg)"><path d="M9 1 L15 16 L9 12 L3 16 Z" style="fill:${col}" stroke="#000" stroke-width="1"/></svg>` });
}
function updateMap(list) {
  if (!map) return;
  shipLayer.clearLayers(); stationLayer.clearLayers(); lineLayer.clearLayers();
  const st = station();
  if (st) {
    L.circleMarker([st.lat, st.lon], { radius: 6, color: '#000', fillColor: '#ffe066', fillOpacity: 1 }).bindTooltip(`${S.call} ${S.name}`).addTo(stationLayer);
    const ar = area();
    if (ar) L.rectangle([[ar.s, ar.w], [ar.n, ar.e]], { color: '#ffe066', weight: 1.5, fill: false }).bindTooltip(`Watch area ${S.grid}${S.grid2 ? `–${S.grid2}` : ''}`).addTo(stationLayer);
    for (const nm of [S.range / 2, S.range]) L.circle([st.lat, st.lon], { radius: nm * 1852, color: '#46e0b4', weight: 1, fill: false, dashArray: '4 6' }).addTo(stationLayer);
  }
  for (const s of list) {
    // Names come from radio and internet data: tooltips are built as text, never HTML.
    const tip = document.createElement('div');
    tip.textContent = `${s.name || s.mmsi}${s.demo ? ' (demo)' : ''} · ${s.brg != null ? `${Math.round(s.brg)}° ${n1(s.rng)} NM` : ''} · ${n1(s.sog)} kn`;
    L.marker([s.lat, s.lon], { icon: shipIcon(s), keyboard: false }).bindTooltip(tip).on('click', () => pick(s.mmsi)).addTo(shipLayer);
    if (st && s.mmsi === selected) L.polyline([[st.lat, st.lon], [s.lat, s.lon]], { color: '#ffe066', weight: 2, dashArray: '6 6' }).addTo(lineLayer);
  }
}

// ---------------------------------------------------------------- GMDSS alerts
const LEVEL = { distress: 'DISTRESS', urgency: 'URGENCY', safety: 'SÉCURITÉ', routine: 'Routine' };
async function loadAlerts() {
  try { alerts = (await (await fetch(api('/api/alerts'), { cache: 'no-store' })).json()).alerts || []; } catch { /* keep */ }
  renderAlerts();
}
function alertTitle(a) {
  if (a.kind === 'dsc') return `DSC ${a.format && !/Distress/.test(a.format) ? `${a.format} · ` : ''}${a.category}${a.nature ? ` · ${a.nature}` : ''}`;
  if (a.kind === 'ais') return `${a.device || 'AIS'} · ${a.text || ''}`;
  if (a.kind === 'navtex') return `NAVTEX ${a.code || a.station + a.number} · ${a.subject}`;
  if (a.kind === 'epirb') return `406 MHz beacon · ${a.type} · ${a.countryName}`;
  if (a.kind === 'egc') return `Inmarsat-C SafetyNET (EGC)`;
  return a.kind;
}
let alarmedIds = new Set(store.get('mm-alarmed', []));
function renderAlerts() {
  const dscOk = (a, local) => a.kind !== 'dsc' || S.dscSrc === 'both' || (S.dscSrc === 'rf') === local;
  const all = [...localAlerts.filter((a) => dscOk(a, true)), ...alerts.filter((a) => dscOk(a, false))].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 150);
  watchCalls([...localAlerts, ...alerts]);
  const st = station();
  $('#alerts').replaceChildren(...(all.length ? all.map((a) => {
    const pos = a.position || (a.lat != null ? { lat: a.lat, lon: a.lon } : null);
    const where = pos ? `${fmtLat(pos.lat)} ${fmtLon(pos.lon)}${st ? ` · ${Math.round(bearing(st, pos))}° T ${n1(distanceNm(st, pos))} NM from ${S.call}` : ''}` : '';
    return el('li', { class: a.level },
      el('div', {}, el('span', { class: 'lv', text: `${LEVEL[a.level] || a.level} ` }), document.createTextNode(alertTitle(a))),
      forMe(a) ? el('div', { class: 'forme', text: `▶ Call for ${forMe(a)}` }) : null,
      el('div', { class: 'meta', text: [a.mmsi ? `From MMSI ${a.mmsi}${a.country ? ` (${a.country})` : ''}` : '', a.to ? `to ${a.to}${dirName(a.to) ? ` (${dirName(a.to)})` : ''}` : '', a.channel || '', a.telecommand || '', a.ack || '', a.hex ? `Beacon ${a.hex}` : '', where, a.time || '', a.src === 'rf' ? 'direct RF' : a.src === 'internet' ? 'internet AIS' : '', a.at ? new Date(a.at).toLocaleString() : '', a.count > 1 ? `×${a.count}` : ''].filter(Boolean).join(' · ') }),
      a.body ? el('pre', { text: a.body }) : null);
  }) : [el('li', { class: 'muted', text: 'No alerts heard. Distress, urgency and safety calls from DSC, AIS-SART/MOB/EPIRB, NAVTEX, 406 MHz beacons and SafetyNET appear here.' })]));
  const live = all.filter((a) => a.level === 'distress' && Date.now() - (a.last || a.at || 0) < 2 * 3600e3);
  const badge = $('#alert-count'); badge.hidden = !live.length; badge.textContent = String(live.length);
  const banner = $('#distress');
  banner.hidden = !live.length;
  if (live.length) banner.textContent = `⚠ DISTRESS: ${alertTitle(live[0])}${live[0].mmsi ? ` · MMSI ${live[0].mmsi}` : ''} — see GMDSS tab`;
  const fresh = live.filter((a) => a.id && !alarmedIds.has(a.id));
  if (fresh.length && S.alarm) alarm();
  for (const a of fresh) alarmedIds.add(a.id);
  store.set('mm-alarmed', [...alarmedIds].slice(-300));
}
$('#distress').addEventListener('click', () => showTab('alerts'));
function alarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < 6; i++) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = i % 2 ? 1300 : 2200; g.gain.value = 0.15; o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.25); o.stop(ctx.currentTime + i * 0.25 + 0.22); }
  } catch { /* audio blocked until the page is tapped */ }
}
async function loadMsi() {
  try {
    const j = await (await fetch(api('/api/msi'))).json();
    if (j.error) throw new Error(j.error);
    $('#msi').replaceChildren(...(j.warnings.length ? j.warnings.map((w) => el('li', { class: w.level }, el('div', {}, el('span', { class: 'lv', text: `${w.id} ` }), document.createTextNode(w.issued || '')), el('pre', { text: w.text }))) : [el('li', { class: 'muted', text: 'No active NAVAREA IV warnings.' })]));
  } catch (e) { $('#msi').replaceChildren(el('li', { class: 'muted', text: `NAVAREA IV warnings unavailable (${e.message}).` })); }
}

// ---------------------------------------------------------------- weather
let wx = null;
async function loadWx() {
  const st = station(); if (!st) { $('#wx-where').textContent = 'Set the station grid square in Settings to see local marine weather.'; return; }
  try {
    wx = await (await fetch(api(`/api/wx?lat=${st.lat.toFixed(3)}&lon=${st.lon.toFixed(3)}&buoy=${encodeURIComponent(S.buoy)}&metar=${encodeURIComponent(S.metar)}`))).json();
    renderWx();
  } catch { $('#wx-where').textContent = 'Weather unavailable: can’t reach the Marine Monitor relay.'; }
}
function tile(k, big, sub) { return el('div', { class: 'tile' }, el('div', { class: 'k', text: k }), el('b', { text: big }), sub ? el('span', { text: sub }) : null); }
function renderWx() {
  if (!wx) return;
  $('#wx-where').textContent = `Marine weather at ${S.call} ${S.name} (${fmtLat(wx.lat)} ${fmtLon(wx.lon)}) · updated ${new Date(wx.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const w = wx.wind || {}, p = wx.pressure || {}, v = wx.visibility || {}, wv = wx.waves || {}, c = wx.current || {}, t = wx.tide || {};
  const trend = p.trend3h == null ? '' : p.trend3h > 0.5 ? `rising ${p.trend3h} hPa / 3 h` : p.trend3h < -0.5 ? `falling ${p.trend3h} hPa / 3 h` : 'steady';
  $('#wx-tiles').replaceChildren(
    tile('Wind', w.kt != null ? `${n1(w.kt, 0)} kn` : '–', w.dir != null ? `from ${Math.round(w.dir)}° (${compass(w.dir)})${w.gustKt != null ? ` · gusts ${n1(w.gustKt, 0)} kn` : ''}` : ''),
    tile('Pressure', p.hpa != null ? `${n1(p.hpa, 1)} hPa` : '–', trend),
    tile('Visibility', v.nm != null ? `${n1(v.nm)} NM` : wx.metar?.vis ? `${wx.metar.vis} SM` : '–', wx.metar?.vis ? `METAR ${wx.metar.station}: ${wx.metar.vis} SM` : ''),
    tile('Waves', wv.m != null ? `${n1(wv.m)} m` : '–', wv.periodS != null ? `period ${n1(wv.periodS)} s · from ${Math.round(wv.dir ?? 0)}°` : ''),
    tile('Swell', wv.swellM != null ? `${n1(wv.swellM)} m` : '–', wv.swellPeriodS != null ? `${n1(wv.swellPeriodS)} s from ${Math.round(wv.swellDir ?? 0)}°` : ''),
    tile('Tidal / current drift', c.kt != null ? `${n1(c.kt, 2)} kn` : '–', c.setDeg != null ? `set towards ${Math.round(c.setDeg)}° (${compass(c.setDeg)})` : ''),
    tile('Sea level now', t.nowM != null ? `${t.nowM >= 0 ? '+' : ''}${n1(t.nowM, 2)} m` : '–', t.turns?.[0] ? `next ${t.turns[0].type.toLowerCase()} ${localTime(t.turns[0].time)}` : ''),
    tile('Sea / air', wx.seaC != null ? `${n1(wx.seaC)} °C` : '–', wx.airC != null ? `air ${n1(wx.airC)} °C` : ''));
  $('#tide-turns').textContent = (t.turns || []).map((x) => `${x.type} ${localTime(x.time)} (${x.m >= 0 ? '+' : ''}${n1(x.m, 2)} m)`).join(' · ') || '';
  const b = wx.buoy, m = wx.metar;
  $('#obs').replaceChildren(
    m ? el('div', {}, el('h3', { text: `${m.station} METAR — Barbados Meteorological Services` }), el('pre', { text: m.raw || '' }), el('p', { class: 'small', text: `Wind ${m.windDir ?? '–'}° ${m.windKt ?? '–'} kn${m.gustKt ? ` gusting ${m.gustKt}` : ''} · visibility ${m.vis ?? '–'} SM · ${m.pressureHpa ?? '–'} hPa` })) : el('p', { class: 'muted', text: 'METAR unavailable.' }),
    b ? el('div', {}, el('h3', { text: `NOAA NDBC buoy ${b.id}` }), el('p', { class: 'small', text: `${b.time} · wind ${b.windDir ?? '–'}° ${b.windKt ?? '–'} kn (gust ${b.gustKt ?? '–'}) · waves ${b.waveM ?? '–'} m, ${b.wavePeriodS ?? '–'} s · ${b.pressureHpa ?? '–'} hPa${b.pressureTendency != null ? ` (${b.pressureTendency > 0 ? '+' : ''}${b.pressureTendency})` : ''} · sea ${b.seaC ?? '–'} °C${b.visNm != null ? ` · vis ${b.visNm} NM` : ''}` })) : el('p', { class: 'muted', text: `Buoy ${S.buoy} unavailable.` }));
  $('#wx-src').textContent = `Sources: ${(wx.sources || []).join(' · ')}`;
  drawTide();
}
function drawTide() {
  const cv = $('#tide'), series = wx?.tide?.series?.filter((x) => x.m != null) || [];
  if (!cv.clientWidth) return;
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  if (series.length < 2) return;
  const cs = getComputedStyle(document.body), fg = cs.getPropertyValue('--accent').trim(), mu = cs.getPropertyValue('--muted').trim();
  const lo = Math.min(...series.map((x) => x.m)), hi = Math.max(...series.map((x) => x.m)), pad = 20;
  const X = (i) => pad + (i / (series.length - 1)) * (w - pad * 2), Y = (m) => h - pad - ((m - lo) / ((hi - lo) || 1)) * (h - pad * 2);
  g.strokeStyle = mu; g.globalAlpha = 0.4; g.beginPath(); g.moveTo(pad, Y(0)); g.lineTo(w - pad, Y(0)); g.stroke(); g.globalAlpha = 1;
  g.strokeStyle = fg; g.lineWidth = 2; g.beginPath(); series.forEach((x, i) => (i ? g.lineTo(X(i), Y(x.m)) : g.moveTo(X(i), Y(x.m)))); g.stroke();
  const nowIso = new Date().toISOString().slice(0, 13); const ni = series.findIndex((x) => x.t.slice(0, 13) >= nowIso);
  if (ni >= 0) { g.fillStyle = fg; g.beginPath(); g.arc(X(ni), Y(series[ni].m), 4, 0, Math.PI * 2); g.fill(); g.fillStyle = mu; g.font = '11px system-ui'; g.fillText('now', X(ni) + 6, Y(series[ni].m) - 6); }
}
addEventListener('resize', () => drawTide());

// ---------------------------------------------------------------- receiver (dual band)
const BAND_A = [['DSC Ch 70 (UM435)', '156.525 MHz · constant DSC watch'], ['Ch 16 distress (listen on the UM435)', '156.800 MHz']];
const BAND_B = [['AIS 1 (Ch 87B)', '161.975 MHz · FM'], ['AIS 2 (Ch 88B)', '162.025 MHz · FM'], ['DSC Ch 70 (IC-9100)', '156.525 MHz · FM (backup to the UM435)'],
  ...[2187.5, 4207.5, 6312, 8414.5, 12577, 16804.5].map((k) => [`HF DSC ${k} kHz`, `USB, dial ${(k - 1.7).toFixed(1)} kHz`])];
const BAND_C = [['NAVTEX (international)', '518 kHz'], ['NAVTEX (national)', '490 kHz'], ['EPIRB / PLB (COSPAS-SARSAT)', '406.0–406.1 MHz'], ['Homing', '121.5 MHz'], ['Inmarsat-C EGC SafetyNET', '1537–1545 MHz (L-band)']];
const RX_MODES = [['ais-scan', 'AIS scan', 'Alternate AIS 1 (87B) and AIS 2 (88B)'], ['ais-a', 'AIS 1', 'Ch 87B only'], ['ais-b', 'AIS 2', 'Ch 88B only'], ['dsc70', 'DSC 70', 'VHF DSC Ch 70 only'], ['ais-dsc', 'AIS + DSC', 'AIS 1 → AIS 2 → DSC 70 in turn'], ['hf-dsc', 'HF DSC', 'MF/HF DSC distress frequencies in turn']];
let rxWs = null, rxStatus = null;
function renderRx() {
  const heard = (k) => rxStatus?.bands?.[k];
  const cur = rxStatus?.rx;
  const li = ([n, f]) => { const h = heard(n), on = cur?.channel === n; return el('li', { class: on ? 'tuned' : '' }, el('div', {}, el('div', { text: `${on ? '▶ ' : ''}${n}` }), el('div', { class: 'f', text: f })), el('span', { class: `st ${h?.live ? 'live' : ''}`, text: h?.live ? `live${h.count ? ` · ${h.count}` : ''}` : rxWs || rfFeedAt ? 'idle' : 'no receiver' })); };
  $('#band-a').replaceChildren(...BAND_A.map(li)); $('#band-b').replaceChildren(...BAND_B.map(li)); $('#band-c').replaceChildren(...BAND_C.map(li));
  $('#rx-modes').replaceChildren(...RX_MODES.map(([v, label, tip]) => el('button', { type: 'button', class: cur?.mode === v || (!cur && S.rxMode === v) ? 'on' : '', text: label, title: `${tip}${rxWs ? '' : ' (connect to the station helper on the local network to change)'}`, disabled: !rxWs, onclick: () => tune(v) })));
  if (cur?.dwell) $('#rx-dwell').value = cur.dwell;
  $('#rx-dwell').disabled = !rxWs;
  $('#rx-now').textContent = cur ? `IC-9100: ${cur.modeName} · now on ${cur.channel}${cur.freq ? ` (${(cur.freq / 1e6).toFixed(cur.freq < 30e6 ? 4 : 3)} MHz)` : ''}` : 'IC-9100 not reporting yet.';
  $('#rx-status').textContent = rxWs ? `Connected to the station receiver at ${S.rx}.` : rfFeedAt ? `Station receiver reporting through the relay (last ${new Date(rfFeedAt).toLocaleTimeString()}). Scan control works on the station's local network.` : 'No station receiver connected yet: internet AIS and weather work now; direct RF needs the station helper (see below).';
}
function tune(mode) {
  if (!rxWs) return;
  S.rxMode = mode; save();
  rxWs.send(JSON.stringify({ type: 'tune', mode, dwell: +$('#rx-dwell').value || 20 }));
}
$('#rx-dwell').addEventListener('change', () => { if (rxStatus?.rx?.mode) tune(rxStatus.rx.mode); });
function connectRx() {
  try { rxWs?.close(); } catch { /* ignore */ }
  rxWs = null; renderRx();
  if (!/^wss?:\/\//.test(S.rx || '')) return;
  let ws; try { ws = new WebSocket(S.rx); } catch { toast('Receiver address isn’t valid'); return; }
  ws.onopen = () => { rxWs = ws; renderRx(); toast('Station receiver connected'); };
  ws.onclose = () => { if (rxWs === ws) { rxWs = null; renderRx(); setTimeout(connectRx, 10e3); } };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'status') { rxStatus = m; renderRx(); return; }
    if (m.type === 'nmea') {
      const a = decoder.push(m.line);
      if (a?.mmsi && a.lat != null) { localRf.set(a.mmsi, { ...(localRf.get(a.mmsi) || {}), ...a, age: 0 }); refreshTargets(); }
      else if (a?.mmsi) { const o = localRf.get(a.mmsi); if (o) Object.assign(o, a); }
      const d = parseDsc(m.line); if (d) { localAlerts.unshift({ ...d, to: m.to || null, at: Date.now(), id: `l${Date.now()}${Math.random()}`, src: 'rf' }); renderAlerts(); }
      if (a?.distress) { localAlerts.unshift({ kind: 'ais', level: 'distress', mmsi: String(a.mmsi), device: a.kind, text: a.safetyText || `${a.kind} active`, lat: a.lat, lon: a.lon, at: Date.now(), id: `l${a.mmsi}`, src: 'rf' }); renderAlerts(); }
    }
    if (m.type === 'alert') {
      const p = m.kind === 'navtex' ? parseNavtex(m.text || '') : m.kind === 'epirb' ? parseBeaconHex(m.hex || '') : m.kind === 'egc' ? { kind: 'egc', level: 'safety', body: m.text } : null;
      if (p) { localAlerts.unshift({ ...p, at: Date.now(), id: `l${Date.now()}`, src: 'rf' }); renderAlerts(); }
    }
  };
}

// ---------------------------------------------------------------- settings forms
function fillForms() {
  $('#st-call').value = S.call; $('#st-name').value = S.name; $('#st-grid').value = S.grid || ''; $('#st-grid2').value = S.grid2 || ''; $('#st-origin').value = S.origin || 'sw'; $('#st-mmsi').value = S.mmsi || '';
  $('#cfg-relay').value = S.relay; $('#cfg-rx').value = S.rx; $('#cfg-buoy').value = S.buoy; $('#cfg-metar').value = S.metar; $('#cfg-alarm').checked = S.alarm; $('#cfg-demo').checked = S.demo;
}
$('#st-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = $('#st-msg');
  try {
    const norm = (g) => g.slice(0, 4).toUpperCase() + g.slice(4).toLowerCase();
    const grid = $('#st-grid').value.trim(), grid2 = $('#st-grid2').value.trim(), mmsi = $('#st-mmsi').value.replace(/\s/g, '');
    gridToLatLon(grid); if (grid2) gridToLatLon(grid2);
    if (mmsi && !/^\d{9}$/.test(mmsi)) throw new Error('The station MMSI is 9 digits');
    Object.assign(S, { call: $('#st-call').value.trim().toUpperCase() || '8PFX', name: $('#st-name').value.trim() || 'Ocean City', grid: norm(grid), grid2: grid2 ? norm(grid2) : '', origin: $('#st-origin').value, mmsi });
    computeStation(); save(); stationChanged();
    msg.textContent = `Saved: bearings from ${{ sw: 'the south-west square', ne: 'the north-east square', centre: 'the centre of the area' }[S.origin]}, ${fmtLat(S.lat)} ${fmtLon(S.lon)}${S.grid2 ? ` · watch area ${S.grid}–${S.grid2}` : ''}.`;
  } catch (err) { msg.textContent = err.message; }
});
$('#st-ip').addEventListener('click', async () => {
  const msg = $('#st-msg'); msg.textContent = 'Looking up your approximate location…';
  try {
    const j = await (await fetch(api('/api/where'))).json();
    if (j.error) throw new Error(j.error);
    Object.assign(S, { lat: j.lat, lon: j.lon, grid: latLonToGrid(j.lat, j.lon), grid2: '', origin: 'sw' });
    save(); fillForms(); stationChanged();
    msg.textContent = `Approximate location from your internet address: ${j.city ? `${j.city}, ` : ''}${j.country} (${S.grid}). This is only city-level: type the exact grid square for accurate bearings.`;
  } catch (err) { msg.textContent = err.message; }
});
$('#cfg-form').addEventListener('submit', (e) => {
  e.preventDefault();
  Object.assign(S, { relay: $('#cfg-relay').value.trim(), rx: $('#cfg-rx').value.trim(), buoy: $('#cfg-buoy').value.trim() || '41040', metar: $('#cfg-metar').value.trim().toUpperCase() || 'TBPB', alarm: $('#cfg-alarm').checked, demo: $('#cfg-demo').checked });
  save(); toast('Saved'); connectRx(); loadAll();
});
function stationChanged() { stationLine(); radar?.setStation(station()); refreshTargets(); loadWx(); if (map && station()) map.setView([S.lat, S.lon], map.getZoom()); }

// ---------------------------------------------------------------- source switches (AIS / DSC: internet, RF, both)
function segment(box, key, opts, after) {
  const draw = () => $(box).replaceChildren(...opts.map(([v, label, tip]) => el('button', { type: 'button', class: S[key] === v ? 'on' : '', text: label, title: tip, onclick: () => { S[key] = v; save(); draw(); after(); } })));
  draw();
}
segment('#ais-src', 'aisSrc', [['internet', 'Internet', 'Ships from internet AIS (AISStream) only'], ['rf', 'RF', 'Ships heard directly by the station receivers only'], ['both', 'Both', 'Merge internet AIS and direct RF']], refreshTargets);
segment('#dsc-src', 'dscSrc', [['internet', 'Internet', 'DSC calls reported through the relay (from the station, over the internet)'], ['rf', 'RF', 'DSC calls from the station receiver on this local network (UM435 / IC-9100)'], ['both', 'Both', 'All DSC calls']], renderAlerts);

// ---------------------------------------------------------------- MMSI: decoder, directory, individual / group calls
let dir = store.get('mm-dir', []);
let calls = store.get('mm-calls', []);
const dirName = (m) => dir.find((d) => d.mmsi === m)?.name || '';
const forMe = (a) => (a.kind !== 'dsc' || !a.to ? '' : a.to === S.mmsi ? `${S.call} (this station)` : dir.some((d) => d.mmsi === a.to && d.mmsi.startsWith('0') && !d.mmsi.startsWith('00')) ? `your group ${dirName(a.to)}` : '');
const notified = new Set(store.get('mm-notified', []));
function watchCalls(list) {
  let changed = false;
  for (const a of list) {
    if (a.kind !== 'dsc') continue;
    const id = a.id || `${a.mmsi}|${a.at}`;
    // acknowledgement of one of our logged calls
    const c = calls.find((x) => !x.ackAt && x.to === a.mmsi && /Acknowledgement$/.test(a.ack || '') && (a.at || 0) >= x.at - 60e3 && (a.at || 0) - x.at < 15 * 60e3);
    if (c) { c.ackAt = a.at || Date.now(); changed = true; toast(`✓ ${dirName(c.to) || c.to} acknowledged your call`); }
    if (forMe(a) && !notified.has(id)) { notified.add(id); toast(`DSC call for ${forMe(a)} from ${a.mmsi}${dirName(a.mmsi) ? ` (${dirName(a.mmsi)})` : ''}${a.channel ? ` · ${a.channel}` : ''}`, 8000); if (S.alarm && (Date.now() - (a.at || 0)) < 10 * 60e3) alarm(); }
  }
  store.set('mm-notified', [...notified].slice(-300));
  if (changed) { store.set('mm-calls', calls); renderCalls(); }
}
function decodeMmsi(v) {
  const d = mmsiDecode(v), out = $('#mmsi-out');
  if (!d.valid) { out.replaceChildren(el('p', { class: 'small', text: d.error })); return; }
  const live = merged().find((x) => String(x.mmsi) === d.mmsi);
  const heard = [...localAlerts, ...alerts].find((a) => a.mmsi === d.mmsi || a.to === d.mmsi);
  const rows = [['Type', d.kind], ['Format', d.format], ['Country (MID)', d.mid ? `${d.country} · ${d.mid}` : '–'], ['DSC address', d.dscAddress], ['In directory', dirName(d.mmsi) || 'no'],
    ['On AIS now', live ? `${live.name || 'yes'} · ${Math.round(live.brg)}° T ${n1(live.rng)} NM from ${S.call}` : 'not seen'], ['Last DSC', heard ? `${heard.format || heard.kind} ${heard.category || ''} · ${new Date(heard.at).toLocaleString()}` : 'none heard']];
  out.replaceChildren(el('dl', { class: 'facts' }, rows.flatMap(([k, val]) => [el('dt', { text: k }), el('dd', { text: val })])), ...d.notes.map((t) => el('p', { class: 'small', text: t })),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn', text: 'Call this MMSI', title: 'Prepare an individual (or group) DSC call to this MMSI', onclick: () => { setCallType(d.kind === 'Group' ? 'group' : 'individual'); $('#call-to').value = d.mmsi; $('#call-form').scrollIntoView({ behavior: 'smooth' }); } }),
      el('a', { class: 'btn', href: `https://www.itu.int/mmsapp/ShipStation/list?mmsi=${d.mmsi}`, target: '_blank', rel: 'noopener', text: 'ITU MARS lookup', title: 'Look up the registered ship or station in the ITU database' })));
}
$('#mmsi-form').addEventListener('submit', (e) => { e.preventDefault(); decodeMmsi($('#mmsi-in').value); });
let callType = 'individual';
function setCallType(t) { callType = t; for (const b of $('#call-type').children) b.classList.toggle('on', b.dataset.v === t); renderDir(); }
for (const b of $('#call-type').children) b.addEventListener('click', () => setCallType(b.dataset.v));
const CHANNELS = [['06', 'Ch 06 · ship-to-ship safety'], ['08', 'Ch 08 · ship-to-ship'], ['09', 'Ch 09 · calling'], ['10', 'Ch 10'], ['12', 'Ch 12 · port operations'], ['13', 'Ch 13 · bridge-to-bridge'], ['14', 'Ch 14 · port operations'], ['16', 'Ch 16 · distress, safety, calling'], ['67', 'Ch 67'], ['68', 'Ch 68'], ['69', 'Ch 69'], ['72', 'Ch 72 · ship-to-ship'], ['73', 'Ch 73'], ['77', 'Ch 77 · ship-to-ship']];
$('#call-ch').replaceChildren(...CHANNELS.map(([v, t]) => el('option', { value: v, text: t })));
$('#call-ch').value = '72';
$('#call-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const out = $('#call-out'), to = $('#call-to').value.replace(/\s/g, ''), cat = $('#call-cat').value, ch = $('#call-ch').value;
  try {
    if (!/^\d{9}$/.test(S.mmsi || '')) throw new Error('First enter the station MMSI in Settings (the MMSI programmed in the UM435).');
    const c = buildDscCall({ type: callType, to, from: S.mmsi, category: cat, channel: +ch });
    const name = dirName(to), d = mmsiDecode(to);
    const steps = [`On the UM435 open the DSC menu and choose ${callType === 'group' ? 'GROUP CALL' : 'INDIVIDUAL CALL'}.`, `Enter ${callType === 'group' ? 'group ' : ''}MMSI ${to}${name ? ` (${name})` : ''}.`, `Choose ${cat === 'routine' ? 'Routine' : cat === 'safety' ? 'Safety' : 'Urgency'} and working channel ${ch}.`, 'Send. Then press "Log as sent" so Marine Monitor watches for the acknowledgement.'];
    out.replaceChildren(el('div', { class: 'callcard' },
      el('div', { class: 'big', text: `${callType === 'group' ? 'Group' : 'Individual'} call → ${name || to}` }),
      el('p', { class: 'small', text: `${d.kind}${d.country ? ` · ${d.country}` : ''} · ${cat} · working channel ${ch} · from ${S.call} (${S.mmsi})` }),
      el('p', { class: 'small', text: 'DSC sequence (ITU-R M.493):' }), el('pre', { text: c.text }),
      el('ol', { class: 'small' }, steps.map((t) => el('li', { text: t }))),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn primary', text: 'Log as sent', title: 'Record the call; Marine Monitor marks it when the acknowledgement is received', onclick: () => { calls.unshift({ at: Date.now(), type: callType, to, cat, ch, name }); calls = calls.slice(0, 200); store.set('mm-calls', calls); renderCalls(); toast('Call logged: watching for the acknowledgement'); out.replaceChildren(); } }))));
  } catch (err) { out.replaceChildren(el('p', { class: 'small', text: err.message })); }
});
function renderCalls() {
  $('#call-log').replaceChildren(...(calls.length ? calls.slice(0, 50).map((c) => el('li', { class: c.ackAt ? 'safety' : c.type === 'group' ? 'routine' : 'urgency' },
    el('div', {}, el('span', { class: 'lv', text: `${c.type === 'group' ? 'Group' : 'Individual'} ` }), document.createTextNode(`→ ${c.name || dirName(c.to) || c.to} (${c.to}) · ${c.cat} · Ch ${c.ch}`)),
    el('div', { class: 'meta', text: `${new Date(c.at).toLocaleString()} · ${c.type === 'group' ? 'group calls are not acknowledged' : c.ackAt ? `acknowledged ✓ ${new Date(c.ackAt).toLocaleTimeString()}` : Date.now() - c.at < 15 * 60e3 ? 'waiting for acknowledgement…' : 'no acknowledgement heard'}` }))) : [el('li', { class: 'muted', text: 'No calls logged yet.' })]));
}
function renderDir() {
  $('#dir-list').replaceChildren(...dir.filter((d) => (callType === 'group') === (d.mmsi.startsWith('0') && !d.mmsi.startsWith('00'))).map((d) => el('option', { value: d.mmsi, text: d.name })));
  $('#dir').replaceChildren(...(dir.length ? dir.map((d) => { const k = mmsiDecode(d.mmsi); return el('li', { class: 'routine' },
    el('div', {}, el('span', { class: 'lv', text: `${d.name} ` }), document.createTextNode(`${d.mmsi} · ${k.kind}${k.country ? ` · ${k.country}` : ''}`)),
    d.members?.length ? el('div', { class: 'meta', text: `Members: ${d.members.map((m) => dirName(m) || m).join(', ')}` }) : null,
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn', text: 'Call', title: `Prepare a DSC call to ${d.name}`, onclick: () => { setCallType(k.kind === 'Group' ? 'group' : 'individual'); $('#call-to').value = d.mmsi; $('#call-form').scrollIntoView({ behavior: 'smooth' }); } }),
      el('button', { type: 'button', class: 'btn', text: 'Remove', title: `Remove ${d.name} from the directory`, onclick: () => { dir = dir.filter((x) => x !== d); store.set('mm-dir', dir); renderDir(); } }))); }) : [el('li', { class: 'muted', text: 'Add the ships, coast stations and groups you call often.' })]));
}
$('#dir-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#dir-name').value.trim(), mmsi = $('#dir-mmsi').value.replace(/\s/g, '');
  const members = $('#dir-members').value.split(/[,\s]+/).filter((m) => /^\d{9}$/.test(m));
  if (!name || !/^\d{9}$/.test(mmsi)) { toast('Enter a name and a 9-digit MMSI'); return; }
  dir = [...dir.filter((d) => d.mmsi !== mmsi), { name, mmsi, members }].sort((a, b) => a.name.localeCompare(b.name));
  store.set('mm-dir', dir); renderDir(); e.target.reset(); toast(`${name} saved`);
});
renderCalls(); renderDir();

// ---------------------------------------------------------------- start
const RANGES = [3, 6, 12, 24, 48, 96];
$('#ranges').replaceChildren(...RANGES.map((r) => el('button', { type: 'button', class: r === S.range ? 'on' : '', text: `${r}`, title: `${r} nautical miles`, onclick: (e) => { S.range = r; save(); radar.setRange(r); for (const b of $('#ranges').children) b.classList.toggle('on', b === e.currentTarget); } })));
radar = new Radar($('#radar'), { onPick: (s) => pick(s?.mmsi ?? null) });
radar.setRange(S.range); radar.setStation(station());
applyFace(); stationLine(); fillForms(); renderRx(); connectRx();
function loadAll() { loadShips(); loadAlerts(); loadWx(); loadMsi(); }
loadAll();
setInterval(loadShips, 10e3); setInterval(loadAlerts, 15e3); setInterval(loadWx, 10 * 60e3); setInterval(loadMsi, 30 * 60e3);
setInterval(() => { if (S.demo) refreshTargets(); renderAlerts(); }, 5e3);
showTab(['radar', 'map', 'alerts', 'mmsi', 'wx', 'rx', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : station() ? 'radar' : 'settings');
