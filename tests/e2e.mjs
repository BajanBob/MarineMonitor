// Browser test: station set-up, radar with targets from internet AIS + direct RF, map, GMDSS alerts,
// weather, day/night faceplates. Uses a local relay with canned data (no internet needed).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { startRelay, handleAisStream } from '../server/relay.mjs';

const req = createRequire(import.meta.url);
let pw; try { pw = req('playwright'); } catch { pw = req(process.env.PLAYWRIGHT_PATH || 'playwright'); }
const SHOTS = process.env.SHOTS || '';
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures.json', import.meta.url)));
const fakeFetch = async (url) => {
  const key = Object.keys(fixtures).find((k) => url.includes(k));
  if (!key) return { ok: false, status: 404 };
  const v = fixtures[key];
  return { ok: true, json: async () => v, text: async () => (typeof v === 'string' ? v : JSON.stringify(v)) };
};

const relay = await startRelay({ port: 0, fetchImpl: fakeFetch, feedKey: 'f'.repeat(24) });
const base = `http://127.0.0.1:${relay.address().port}`;
// Internet AIS: a cargo ship west of the station; direct RF: a fishing boat + a DSC distress.
handleAisStream(relay.fleet, { MessageType: 'PositionReport', MetaData: { MMSI: 314000111, ShipName: 'ISLAND TRADER', latitude: 13.15, longitude: -59.8 }, Message: { PositionReport: { Sog: 10, Cog: 90, TrueHeading: 90, NavigationalStatus: 0 } } });
await fetch(`${base}/api/feed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feed-key': 'f'.repeat(24) }, body: JSON.stringify({ lines: ['$CDDSC,12,3141234560,12,05,00,1130505936,1423,,,S,E*00'], alerts: [{ kind: 'navtex', text: 'ZCZC JA42\nBUOY OFF STATION 13-05N 059-37W\nNNNN' }] }) });

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|tile/.test(m.text())) errors.push(m.text()); });
await page.route(/tile\.openstreetmap\.org|openseamap/, (r) => r.abort());
const shot = (n) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: true }) : null);
try {
  await page.goto(`${base}/`);
  await page.waitForSelector('#tab-settings.on'); // no station yet → Settings first
  await page.fill('#st-grid', 'GK03ec'); await page.click('#st-form button[type=submit]');
  await page.waitForFunction(() => /8PFX Ocean City · GK03ec/.test(document.querySelector('#station-line').textContent));
  await page.check('#cfg-demo'); await page.click('#cfg-form button[type=submit]');
  await page.click('[data-tab=radar]');
  await page.waitForFunction(() => document.querySelectorAll('#tlist tbody tr').length >= 5);
  const rows = await page.$$eval('#tlist tbody tr', (r) => r.map((x) => x.innerText));
  assert.ok(rows.some((r) => /ISLAND TRADER/.test(r)), 'internet AIS ship listed');
  assert.match(rows[0], /SART/, 'distress device listed first');
  await page.click('#tlist tbody tr:has-text("ISLAND TRADER")');
  const info = await page.innerText('#target');
  assert.match(info, /Bearing from 8PFX\s+\d+° T/); assert.match(info, /Range\s+[\d.]+ NM/); assert.match(info, /Barbados/);
  await shot('radar-day');
  await page.click('#face-night'); assert.equal(await page.getAttribute('body', 'class'), 'night'); await shot('radar-night');
  await page.click('#face-day');
  await page.click('[data-tab=map]'); await page.waitForSelector('.leaflet-marker-icon'); await shot('map');
  await page.click('[data-tab=alerts]');
  await page.waitForFunction(() => /DISTRESS/.test(document.querySelector('#alerts').innerText));
  const al = await page.innerText('#alerts');
  assert.match(al, /DSC Distress \(Mayday\) · Sinking/); assert.match(al, /NAVTEX JA42/); assert.match(al, /° T [\d.]+ NM from 8PFX/);
  assert.equal(await page.isVisible('#distress'), true, 'distress banner shown');
  await page.waitForFunction(() => /NAVAREA IV 812\/2026/.test(document.querySelector('#msi').innerText));
  await shot('gmdss');
  await page.click('[data-tab=wx]');
  await page.waitForFunction(() => /kn/.test(document.querySelector('#wx-tiles').innerText));
  const w = await page.innerText('#wx-tiles');
  assert.match(w, /15 kn/); assert.match(w, /1013\.5 hPa/); assert.match(w, /10(\.0)? NM/); assert.match(w, /1\.9 m/); assert.match(w, /1\.00 kn/);
  assert.match(await page.innerText('#obs'), /TBPB/);
  await shot('weather');
  await page.click('[data-tab=rx]'); assert.match(await page.innerText('#band-a'), /161\.975 MHz/); assert.match(await page.innerText('#band-b'), /406\.0–406\.1 MHz/); await shot('receiver');
  assert.equal((await page.evaluate(() => document.documentElement.scrollWidth)), 412, 'no sideways scrolling on a phone');
  assert.deepEqual(errors, []);
  console.log('✓ Marine Monitor browser test passed');
} finally { await browser.close(); relay.close(); }
