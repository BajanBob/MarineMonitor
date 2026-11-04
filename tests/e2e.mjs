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
  // Default station area: GK03ec (Bridgetown, SW) to GK03ff (Bathsheba, NE), bearings from the SW square.
  await page.waitForSelector('#tab-radar.on');
  await page.waitForFunction(() => /8PFX Ocean City · GK03ec–GK03ff · 13°06\.25′N 059°37\.50′W/.test(document.querySelector('#station-line').textContent));
  await page.click('[data-tab=settings]');
  assert.equal(await page.inputValue('#st-grid2'), 'GK03ff'); assert.equal(await page.inputValue('#st-origin'), 'sw');
  await page.fill('#st-mmsi', '003140001'); await page.click('#st-form button[type=submit]');
  await page.waitForFunction(() => /watch area GK03ec–GK03ff/.test(document.querySelector('#st-msg').textContent));
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
  // AIS source switch: RF only hides the internet-only ship
  await page.click('#ais-src button:has-text("RF")');
  await page.waitForFunction(() => !/ISLAND TRADER/.test(document.querySelector('#tlist').innerText));
  assert.match(await page.innerText('#ais-status'), /direct RF only/);
  await page.click('#ais-src button:has-text("Both")');
  await page.waitForFunction(() => /ISLAND TRADER/.test(document.querySelector('#tlist').innerText));
  await page.click('#face-night'); assert.equal(await page.getAttribute('body', 'class'), 'night'); await shot('radar-night');
  await page.click('#face-day');
  await page.click('[data-tab=map]'); await page.waitForSelector('.leaflet-marker-icon');
  assert.ok(await page.$('.leaflet-overlay-pane path'), 'watch area drawn'); await shot('map');
  await page.click('[data-tab=alerts]');
  await page.waitForFunction(() => /DISTRESS/.test(document.querySelector('#alerts').innerText));
  const al = await page.innerText('#alerts');
  assert.match(al, /DSC Distress \(Mayday\) · Sinking/); assert.match(al, /NAVTEX JA42/); assert.match(al, /° T [\d.]+ NM from 8PFX/);
  assert.equal(await page.isVisible('#distress'), true, 'distress banner shown');
  await page.waitForFunction(() => /NAVAREA IV 812\/2026/.test(document.querySelector('#msi').innerText));
  // DSC source: "RF" = local receiver only, so relay-reported DSC disappears
  await page.click('#dsc-src button:has-text("RF")');
  await page.waitForFunction(() => !/DSC Distress/.test(document.querySelector('#alerts').innerText));
  await page.click('#dsc-src button:has-text("Both")');
  await page.waitForFunction(() => /DSC Distress/.test(document.querySelector('#alerts').innerText));
  await shot('gmdss');
  // MMSI: decoder, directory, individual call with acknowledgement, group call, call addressed to us
  await page.click('[data-tab=mmsi]');
  await page.fill('#mmsi-in', '314000111'); await page.click('#mmsi-form button[type=submit]');
  const dec = await page.innerText('#mmsi-out');
  assert.match(dec, /Ship/); assert.match(dec, /Barbados · 314/); assert.match(dec, /ISLAND TRADER · \d+° T/);
  await page.fill('#mmsi-in', '031400010'); await page.click('#mmsi-form button[type=submit]');
  assert.match(await page.innerText('#mmsi-out'), /group MMSI/);
  await page.fill('#dir-name', 'Island Trader'); await page.fill('#dir-mmsi', '314000111'); await page.click('#dir-form button[type=submit]');
  await page.fill('#dir-name', 'Oistins fleet'); await page.fill('#dir-mmsi', '031400010'); await page.fill('#dir-members', '314000111'); await page.click('#dir-form button[type=submit]');
  assert.match(await page.innerText('#dir'), /Oistins fleet\s+031400010 · Group · Barbados[\s\S]*Members: Island Trader/);
  await page.click('#dir li:has-text("Island Trader") button:has-text("Call")');
  await page.selectOption('#call-ch', '72'); await page.click('#call-form button[type=submit]');
  const cc = await page.innerText('#call-out');
  assert.match(cc, /Individual call → Island Trader/); assert.match(cc, /120 120 \| to 31 40 00 11 10 \| cat 100 \| from 00 31 40 00 10 \| 100 126 \| Ch 72 \| EOS 117 \| ECC \d+/);
  await page.click('#call-out button:has-text("Log as sent")');
  assert.match(await page.innerText('#call-log'), /waiting for acknowledgement/);
  await fetch(`${base}/api/feed`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-feed-key': 'f'.repeat(24) }, body: JSON.stringify({ alerts: [
    { kind: 'dsc', line: '$CDDSC,20,3140001110,00,00,26,900072,,,,B,*00', to: '003140001' },
    { kind: 'dsc', line: '$CDDSC,14,3149990000,00,00,26,900006,,,,S,*00', to: '031400010' }], bands: { 'AIS 1 (Ch 87B)': { live: true, count: 12 }, 'DSC Ch 70 (UM435)': { live: true, count: 2 } }, rx: { mode: 'ais-scan', modeName: 'AIS scan (87B ⇄ 88B)', channel: 'AIS 1 (Ch 87B)', freq: 161975000 } }) });
  await page.evaluate(() => document.querySelector('[data-tab=alerts]').click());
  await page.waitForFunction(() => /acknowledged ✓/.test(document.querySelector('#call-log').innerText), null, { timeout: 25000 });
  const al2 = await page.innerText('#alerts');
  assert.match(al2, /Call for 8PFX \(this station\)/); assert.match(al2, /Call for your group Oistins fleet/); assert.match(al2, /Ch 72/);
  await page.click('[data-tab=mmsi]'); await page.click('#call-type button:has-text("Group")'); await page.fill('#call-to', '031400010'); await page.click('#call-form button[type=submit]');
  assert.match(await page.innerText('#call-out'), /114 114 \| to 03 14 00 01 00 .*EOS 127/);
  await shot('mmsi');
  await page.click('[data-tab=wx]');
  await page.waitForFunction(() => /kn/.test(document.querySelector('#wx-tiles').innerText));
  const w = await page.innerText('#wx-tiles');
  assert.match(w, /15 kn/); assert.match(w, /1013\.5 hPa/); assert.match(w, /10(\.0)? NM/); assert.match(w, /1\.9 m/); assert.match(w, /1\.00 kn/);
  assert.match(await page.innerText('#obs'), /TBPB/);
  await shot('weather');
  await page.click('[data-tab=rx]');
  assert.match(await page.innerText('#band-a'), /DSC Ch 70 \(UM435\)[\s\S]*live · 2/); assert.match(await page.innerText('#band-b'), /▶ AIS 1 \(Ch 87B\)[\s\S]*161\.975 MHz[\s\S]*live · 12[\s\S]*HF DSC 8414\.5 kHz/);
  assert.match(await page.innerText('#band-c'), /406\.0–406\.1 MHz/); assert.match(await page.innerText('#rx-now'), /IC-9100: AIS scan .* now on AIS 1 \(Ch 87B\) \(161\.975 MHz\)/);
  assert.equal(await page.isDisabled('#rx-modes button:has-text("AIS 2")'), true, 'scan control needs the local helper');
  await shot('receiver');
  assert.equal((await page.evaluate(() => document.documentElement.scrollWidth)), 412, 'no sideways scrolling on a phone');
  assert.deepEqual(errors, []);
  console.log('✓ Marine Monitor browser test passed');
} finally { await browser.close(); relay.close(); }
