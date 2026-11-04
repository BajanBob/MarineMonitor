// Virtual radar (PPI): the coastal station at the centre, north up, range rings in nautical miles,
// targets placed by true bearing and range from the station. Not a real radar — a plot of AIS.
import { bearing, distanceNm } from './geo.js';

export class Radar {
  constructor(canvas, { onPick } = {}) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.onPick = onPick;
    this.range = 24; this.targets = []; this.station = null; this.selected = null; this.sweep = 0; this.t0 = performance.now();
    canvas.addEventListener('click', (e) => this.#click(e));
    const loop = (t) => { this.#draw(t); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  setStation(s) { this.station = s; }
  setRange(nm) { this.range = nm; }
  setTargets(list) { this.targets = list; }
  select(mmsi) { this.selected = mmsi; }

  #colors() {
    const cs = getComputedStyle(this.c);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    return { bg: v('--radar-bg', '#021'), ring: v('--radar-ring', '#1f6f5c'), text: v('--radar-text', '#8fe0c8'), sweep: v('--radar-sweep', 'rgba(60,255,180,0.25)'),
      net: v('--t-net', '#46e0b4'), rf: v('--t-rf', '#ffb547'), both: v('--t-both', '#ffffff'), alarm: v('--t-alarm', '#ff3b4a'), aton: v('--t-aton', '#c58cff'), sel: v('--t-sel', '#ffe066') };
  }
  #geom() {
    const dpr = window.devicePixelRatio || 1, w = this.c.clientWidth, h = this.c.clientHeight;
    if (this.c.width !== Math.round(w * dpr) || this.c.height !== Math.round(h * dpr)) { this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr); }
    const r = Math.min(w, h) / 2 - 22;
    return { dpr, w, h, cx: w / 2, cy: h / 2, r };
  }
  /** Screen position of a target, or null if outside the range. */
  pos(t, geo = this.#geom()) {
    if (!this.station || t.lat == null) return null;
    const d = distanceNm(this.station, t); if (d > this.range * 1.02) return null;
    const b = bearing(this.station, t) * Math.PI / 180, k = (d / this.range) * geo.r;
    return { x: geo.cx + k * Math.sin(b), y: geo.cy - k * Math.cos(b), d, b: b * 180 / Math.PI };
  }
  #draw(t) {
    const geo = this.#geom(), g = this.g;
    if (geo.r < 10 || document.hidden) return; // tab not on screen
    const C = this.#colors();
    g.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, geo.w, geo.h);
    // rings + labels
    g.strokeStyle = C.ring; g.fillStyle = C.text; g.lineWidth = 1; g.font = '11px ui-monospace, monospace'; g.textAlign = 'left';
    for (let i = 1; i <= 4; i++) { g.beginPath(); g.arc(geo.cx, geo.cy, (geo.r * i) / 4, 0, Math.PI * 2); g.stroke(); g.fillText(`${+(this.range * i / 4).toFixed(1)} NM`, geo.cx + 3, geo.cy - (geo.r * i) / 4 + 12); }
    // bearing scale
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 10) {
      const ar = a * Math.PI / 180, x1 = geo.cx + geo.r * Math.sin(ar), y1 = geo.cy - geo.r * Math.cos(ar), k = a % 30 === 0 ? 8 : 4;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(geo.cx + (geo.r + k) * Math.sin(ar), geo.cy - (geo.r + k) * Math.cos(ar)); g.stroke();
      if (a % 30 === 0) g.fillText(a === 0 ? 'N' : String(a).padStart(3, '0'), geo.cx + (geo.r + 15) * Math.sin(ar), geo.cy - (geo.r + 15) * Math.cos(ar));
    }
    g.beginPath(); g.moveTo(geo.cx - geo.r, geo.cy); g.lineTo(geo.cx + geo.r, geo.cy); g.moveTo(geo.cx, geo.cy - geo.r); g.lineTo(geo.cx, geo.cy + geo.r); g.globalAlpha = 0.35; g.stroke(); g.globalAlpha = 1;
    // sweep (decorative, one turn every 6 s; off when the device asks for reduced motion)
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.sweep = (((t - this.t0) / 6000) * Math.PI * 2) % (Math.PI * 2);
      const grad = g.createConicGradient ? g.createConicGradient(this.sweep - Math.PI / 2 - 0.6, geo.cx, geo.cy) : null;
      if (grad) { grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.095, C.sweep); grad.addColorStop(0.1, 'rgba(0,0,0,0)'); g.fillStyle = grad; g.beginPath(); g.arc(geo.cx, geo.cy, geo.r, 0, Math.PI * 2); g.fill(); }
    }
    // station
    g.fillStyle = C.text; g.beginPath(); g.arc(geo.cx, geo.cy, 3, 0, Math.PI * 2); g.fill();
    // targets
    const blink = Math.floor(t / 400) % 2 === 0;
    for (const s of this.targets) {
      const p = this.pos(s, geo); if (!p) continue;
      const rf = s.sources?.includes('rf'), net = s.sources?.includes('internet');
      const col = s.alarm ? (blink ? C.alarm : C.bg) : s.aton ? C.aton : rf && net ? C.both : rf ? C.rf : C.net;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.5;
      if (s.aton || s.base) { g.beginPath(); g.moveTo(p.x, p.y - 5); g.lineTo(p.x + 5, p.y); g.lineTo(p.x, p.y + 5); g.lineTo(p.x - 5, p.y); g.closePath(); g.stroke(); }
      else {
        const hd = ((s.heading ?? s.cog ?? 0) * Math.PI) / 180;
        g.save(); g.translate(p.x, p.y); g.rotate(hd);
        g.beginPath(); g.moveTo(0, -8); g.lineTo(5, 6); g.lineTo(-5, 6); g.closePath(); s.alarm ? g.fill() : g.stroke();
        g.restore();
        if (s.sog > 0.3 && s.cog != null) { // 6-minute course vector
          const vlen = Math.min(60, ((s.sog / 10) / this.range) * geo.r), c = (s.cog * Math.PI) / 180;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x + vlen * Math.sin(c), p.y - vlen * Math.cos(c)); g.stroke();
        }
      }
      if (s.mmsi === this.selected) { g.strokeStyle = C.sel; g.lineWidth = 1; g.strokeRect(p.x - 11, p.y - 11, 22, 22); g.setLineDash([4, 4]); g.beginPath(); g.moveTo(geo.cx, geo.cy); g.lineTo(p.x, p.y); g.stroke(); g.setLineDash([]); }
      if (this.range <= 24 || s.mmsi === this.selected || s.alarm) { g.fillStyle = col; g.textAlign = 'left'; g.font = '10px ui-monospace, monospace'; g.fillText((s.name || String(s.mmsi)).slice(0, 16), p.x + 9, p.y - 8); }
    }
  }
  #click(e) {
    const r = this.c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, geo = this.#geom();
    let best = null, bd = 18;
    for (const s of this.targets) { const p = this.pos(s, geo); if (!p) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = s; } }
    this.selected = best?.mmsi ?? null;
    this.onPick?.(best);
  }
}
