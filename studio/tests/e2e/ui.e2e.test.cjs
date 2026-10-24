// Real-browser tests: Vite serves the page, a fake API stands in for the Python server, headless Chromium drives it.
// Set E2E_SHOTS=/some/dir to save screenshots. Set BROWSER_PATH to pick a browser (Brave / Chrome / Chromium).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { start, makeState } = require('./fakeapi.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PORT = 5410 + Math.floor(Math.random() * 400);
const SHOTS = process.env.E2E_SHOTS;

function findBrowser() {
  const c = [process.env.BROWSER_PATH, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  return c.find(p => fs.existsSync(p));
}
const browserPath = findBrowser();

let api, vite, browser, page, consoleErrors;

async function waitForUrl(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${url}`);
}
const shot = async name => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
const text = sel => page.locator(sel).first().innerText();

test.before(async () => {
  api = await start();
  vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'studio/web', '--port', String(PORT), '--strictPort'], { cwd: ROOT, env: { ...process.env, API_URL: api.url }, stdio: 'ignore' });
  await waitForUrl(`http://localhost:${PORT}/`);
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
});

test.after(async () => {
  await browser?.close();
  vite?.kill();
  await api?.close();
});

async function fresh(opts = {}) {
  api.state.plates = makeState().plates;
  api.state.delays = { purge: 0, generate: 0, invent: 0, export: 0, ...opts.delays };
  api.state.genCount = 0;
  api.state.calls.length = 0;
  const ctx = await browser.newContext({ viewport: { width: opts.width || 1500, height: opts.height || 900 } });
  page = await ctx.newPage();
  consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text() + ' ' + (m.location().url || '')); });
  page.on('pageerror', e => consoleErrors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#loader', { state: 'detached' });
  await page.waitForSelector('.card');
  return ctx;
}

const skip = browserPath ? false : 'no Chromium-based browser found (set BROWSER_PATH)';

test('page loads without errors and the header is one tidy row', { skip }, async () => {
  const ctx = await fresh();
  assert.deepEqual(consoleErrors, []);
  assert.equal(await text('#statusText'), 'Ready');
  const box = async sel => page.locator(sel).first().boundingBox();
  const [world, dir, count, gen, settings] = await Promise.all(['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn', '#settingsBtn'].map(box));
  const header = await box('header');
  assert.ok(header.height < 75, `header is ${header.height}px tall`);
  // left to right, no overlaps
  assert.ok(world.x + world.width <= dir.x + 1 && dir.x + dir.width <= count.x + 1 && count.x + count.width <= gen.x + 1 && gen.x + gen.width <= settings.x + 1);
  for (const b of [world, dir, count, gen, settings]) assert.ok(Math.abs(b.y + b.height / 2 - (header.y + header.height / 2)) < 12, 'controls share one row');
  assert.ok(gen.width > 120, 'Generate keeps its size');
  assert.equal(await text('#tabSelection'), 'Selection (3)');
  assert.equal(await text('#tabTrash'), '🗑️ Trash (4)');
  await shot('01-loaded');
  await ctx.close();
});

test('export sits under the player, and trash tabs sit above the gallery', { skip }, async () => {
  const ctx = await fresh();
  const exp = await page.locator('#exportBtn').boundingBox();
  const play = await page.locator('#playBtn').boundingBox();
  const tabs = await page.locator('.gallery-head').boundingBox();
  const firstCard = await page.locator('.card').first().boundingBox();
  assert.ok(exp.y > play.y, 'Export is below Play');
  assert.ok(tabs.y + tabs.height <= firstCard.y, 'tabs are above the cards');
  await ctx.close();
});

test('trash: select, shift-select, cancel, delete with a loader, empty trash', { skip }, async () => {
  const ctx = await fresh({ delays: { purge: 700 } });
  await page.click('#tabTrash');
  await page.waitForSelector('#trashBar:not([hidden])');
  assert.equal(await page.locator('.card').count(), 4);
  assert.equal(await text('#trashEmpty'), 'Empty trash (4)…');
  assert.equal(await page.locator('#trashDelSel').isDisabled(), true);

  const cards = page.locator('.card');
  await cards.nth(0).click({ position: { x: 100, y: 120 } });
  await cards.nth(2).click({ position: { x: 100, y: 120 }, modifiers: ['Shift'] });
  assert.equal(await page.locator('.card.sel').count(), 3);
  assert.equal(await text('#trashSelCount'), '3 selected');
  await shot('02-trash-selected');

  await page.click('#trashDelSel');
  await page.waitForSelector('#confirmModal.open');
  assert.match(await text('#confirmTitle'), /Delete 3 images permanently\?/);
  await shot('03-confirm');
  await page.click('.confirm-foot button >> text=Cancel');
  await page.waitForSelector('#confirmModal.open', { state: 'detached' }).catch(() => {});
  assert.equal(await page.locator('#confirmModal.open').count(), 0);
  assert.equal(api.state.calls.filter(c => c.path === '/api/purge').length, 0);
  assert.equal(await page.locator('.card.sel').count(), 3);

  await page.click('#trashDelSel');
  await page.click('#confirmYes');
  await page.waitForSelector('#busy:not([hidden])');             // the loader
  assert.match(await text('#busyMsg'), /Deleting 3 images/);
  await shot('04-deleting-loader');
  await page.waitForSelector('#busy', { state: 'hidden' });
  assert.equal(await page.locator('.card').count(), 1);
  assert.match(await text('#toast'), /Deleted 3 images \(4.5 MB freed\)/);
  assert.deepEqual(api.state.calls.find(c => c.path === '/api/purge').body.filenames.length, 3);

  await page.click('#trashEmpty');
  assert.match(await text('#confirmTitle'), /Empty the trash \(1 images\)\?/);
  await page.click('#confirmYes');
  await page.waitForSelector('#busy:not([hidden])');
  await page.waitForSelector('#busy', { state: 'hidden' });
  assert.equal(await page.locator('.card').count(), 0);
  assert.equal(await page.locator('#trashBar').isHidden(), true);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('restoring from the trash moves the image back to the selection', { skip }, async () => {
  const ctx = await fresh();
  await page.click('#tabTrash');
  await page.locator('.card').first().hover();
  await page.locator('.card').first().locator('.action-btn', { hasText: 'Restore' }).click();
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.includes('(4)'));
  assert.equal(await page.locator('.card').count(), 3);
  await ctx.close();
});

test('generate: controls lock, progress shows per image, direction clears afterwards', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 300, generate: 500 } });
  await page.selectOption('#worldSelect', '__custom__');
  assert.match(await page.locator('#directionInput').getAttribute('placeholder'), /Describe your territory/);
  await page.selectOption('#batchCountSelect', '4');

  await page.click('#generateBtn');                                 // custom needs a description first
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'));
  assert.match(await text('#toast'), /Describe your custom territory/);
  assert.equal(api.state.calls.filter(c => c.path === '/api/invent-prompts').length, 0);

  await page.fill('#directionInput', 'fog, clouds, rain');
  await page.click('#generateBtn');
  for (const id of ['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn']) assert.equal(await page.locator(id).isDisabled(), true, `${id} locked`);
  await page.waitForSelector('#statusText .indeterminate');
  await shot('05-writing-scenes');
  await page.waitForSelector('#statusText .slot');
  assert.equal(await page.locator('#statusText .slot').count(), 4);
  await page.waitForSelector('#statusText .slot.run');
  assert.match(await text('#statusText'), /Fog & Vapor/);
  await shot('06-rendering');
  await page.waitForFunction(() => /Done — 4 added/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  for (const id of ['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn']) assert.equal(await page.locator(id).isDisabled(), false, `${id} unlocked`);
  assert.equal(await page.inputValue('#directionInput'), '');
  assert.equal(await page.locator('#statusText .slot.ok').count(), 4);
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.includes('(7)'));
  const inv = api.state.calls.find(c => c.path === '/api/invent-prompts').body;
  assert.deepEqual([inv.world, inv.direction, inv.count], ['__custom__', 'fog, clouds, rain', 4]);
  await shot('07-done');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('player: invert pairs and slow zoom show up on the preview image', { skip }, async () => {
  const ctx = await fresh();
  await page.selectOption('#invertSelect', 'mono');
  await page.selectOption('#zoomSelect', 'out');
  await page.fill('#zoomAmt', '5');
  await page.locator('#zoomAmt').dispatchEvent('input');
  assert.equal(await text('#zoomAmtVal'), '5.0%');
  await page.fill('#bpmSlider', '60');
  await page.locator('#bpmSlider').dispatchEvent('input');
  await page.selectOption('#multSelect', '2');                       // 2 cuts a second: a cut lasts 500ms
  await page.click('#playBtn');
  const seen = { inverted: false, normal: false, zoomed: false, srcs: new Set() };
  const t0 = Date.now();
  while (Date.now() - t0 < 2600) {
    const s = await page.evaluate(() => { const i = document.getElementById('stageImg'); return { f: i.style.filter, t: i.style.transform, src: i.getAttribute('src') }; });
    if (s.f.includes('invert(1) grayscale(1)')) seen.inverted = true; else seen.normal = true;
    if (/scale\(1\.0[1-9]/.test(s.t)) seen.zoomed = true;
    seen.srcs.add(s.src);
    await page.waitForTimeout(40);
  }
  assert.ok(seen.inverted && seen.normal, 'alternates between the image and its inverted copy');
  assert.ok(seen.zoomed, 'zoom scale applied');
  assert.ok(seen.srcs.size >= 2, 'moves on to the next image');
  await shot('08-player-fx');
  await page.click('#playBtn');
  const after = await page.evaluate(() => { const i = document.getElementById('stageImg'); return { f: i.style.filter, t: i.style.transform }; });
  assert.deepEqual(after, { f: '', t: '' });
  await ctx.close();
});

test('export: preview is untouched and a download link appears', { skip }, async () => {
  const ctx = await fresh({ delays: { export: 400 } });
  await page.locator('.card').first().click();
  const before = await page.locator('#stageImg').getAttribute('src');
  await page.click('#exportBtn');
  assert.equal(await text('#exportBtn'), 'Rendering...');
  const link = page.locator('#downloadLink');
  await link.waitFor({ state: 'visible' });
  assert.equal(await link.getAttribute('download'), 'Demo-test.mp4');
  assert.equal(await link.getAttribute('href'), '/outputs/Demo-test.mp4');
  assert.equal(await page.locator('#stageImg').getAttribute('src'), before);
  assert.equal(await page.locator('#stageImg').isVisible(), true);
  assert.equal(await text('#exportBtn'), 'Export MP4');
  const body = api.state.calls.find(c => c.path === '/api/export-video').body;
  assert.equal('total_seconds' in body, false);
  await shot('09-export');
  await ctx.close();
});

test('narrow window: the header wraps without squeezing the Generate button', { skip }, async () => {
  const ctx = await fresh({ width: 900 });
  const gen = await page.locator('#generateBtn').boundingBox();
  const world = await page.locator('#worldSelect').boundingBox();
  assert.ok(gen.width > 120);
  assert.ok(gen.x >= world.x, 'still in the header');
  assert.ok(gen.x + gen.width <= 900, 'not clipped by the window edge');
  await shot('10-narrow');
  await ctx.close();
});
