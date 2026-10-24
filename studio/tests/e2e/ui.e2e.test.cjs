// Real-browser tests: Vite serves the page, a fake API stands in for the Python server, headless Chromium drives it.
// Set E2E_SHOTS=/some/dir to save screenshots. Set BROWSER_PATH to pick a browser (Brave / Chrome / Chromium).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { start, makeState, addAi } = require('./fakeapi.cjs');

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
  const fresh_state = makeState();
  Object.assign(api.state, { plates: fresh_state.plates, sequences: fresh_state.sequences, active: fresh_state.active });
  if (opts.setup) opts.setup(api.state);
  api.state.delays = { purge: 0, generate: 0, invent: 0, export: 0, ai: 600, ...opts.delays };
  api.state.jobs = [];
  api.state.aiFail = opts.aiFail || null;
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
  await page.click('#confirmModal .confirm-foot button >> text=Cancel');
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

const names = async () => page.locator('.card').evaluateAll(els => els.map(e => e.dataset.filename));
const seg = async () => page.locator('#orderSeg button').evaluateAll(els => els.map(e => ({ text: e.textContent.trim(), on: e.classList.contains('on') })));
const clickSeg = async label => { await page.locator('#orderSeg button', { hasText: label }).click(); };
const aiSetup = (summary = 'Hook on k2, lands on k1.') => st => { st.sequences[0].order = ['k3', 'k1', 'k2', 't1', 't2', 't3', 't4']; addAi(st, ['k2', 'k3', 'k1'], { summary }); st.active = 's1'; };

test('orders: one Manual order, and the AI button, are all there is', { skip }, async () => {
  const ctx = await fresh();
  assert.deepEqual(await seg(), [{ text: '✋ Manual (3)', on: true }]);
  assert.equal(await text('#aiBtn'), '✨ Order with AI…');
  assert.equal(await page.locator('#seqMenuBtn, #seqSelect, #cutsToggle, #resetAi:visible').count(), 0);     // no menu, no dropdown, no cuts checkbox
  await shot('11-orders-manual-only');
  await ctx.close();
});

test('orders: switch between Manual and AI without losing either', { skip }, async () => {
  const ctx = await fresh({ setup: aiSetup() });
  assert.deepEqual(await seg(), [{ text: '✋ Manual (3)', on: true }, { text: '✨ AI (3)', on: false }]);
  assert.equal(await text('#aiBtn'), '↻ Redo with AI…');
  assert.deepEqual(await names(), ['k3', 'k1', 'k2']);
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k2');
  assert.deepEqual(await names(), ['k2', 'k3', 'k1']);
  assert.equal(await text('#seqSummary'), 'Hook on k2, lands on k1.');
  assert.equal(await page.locator('#aiNote').isVisible(), true);
  assert.match(await text('#aiNote'), /The AI's note/);
  assert.deepEqual((await seg()).map(x => x.on), [false, true]);
  await shot('12-orders-ai');
  await clickSeg('Manual');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  assert.deepEqual(await names(), ['k3', 'k1', 'k2']);
  assert.equal(await page.locator('#aiNote').isHidden(), true);                      // the note belongs to the AI order only
  await ctx.close();
});

test('player: switching between Manual and AI while playing follows the new order from its first image', { skip }, async () => {
  const ctx = await fresh({ setup: aiSetup() });                                      // Manual: k3,k1,k2   AI: k2,k3,k1
  await page.fill('#bpmSlider', '60'); await page.locator('#bpmSlider').dispatchEvent('input');
  await page.selectOption('#multSelect', '1');                                        // one cut per second
  await page.click('#playBtn');
  const src = async () => (await page.locator('#stageImg').getAttribute('src')).split('/').pop().replace('.svg', '');
  await page.waitForFunction(() => document.getElementById('stageImg').getAttribute('src'));
  assert.equal(await src(), 'k3');                                                    // starts on Manual's first
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k2');
  await page.waitForFunction(() => document.getElementById('stageImg').getAttribute('src').includes('k2'), null, { timeout: 3000 });
  assert.equal(await src(), 'k2');                                                    // AI's first image
  await page.waitForFunction(() => document.getElementById('stageImg').getAttribute('src').includes('k3'), null, { timeout: 3000 });
  assert.equal(await src(), 'k3');                                                    // then AI's second
  await clickSeg('Manual');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  await page.waitForFunction(() => document.getElementById('stageImg').getAttribute('src').includes('k3'));
  assert.equal(await src(), 'k3');                                                    // back to Manual's first
  await page.click('#playBtn');
  await ctx.close();
});

test('orders: dragging edits the order you are looking at; the AI one can be reset; the other order is untouched', { skip }, async () => {
  const ctx = await fresh({ setup: aiSetup('x') });
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k2');
  assert.equal(await page.locator('#resetAi').isHidden(), true);
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));          // k1 onto k2
  await page.waitForSelector('#resetAi:not([hidden])');
  const edited = await names();
  assert.notDeepEqual(edited, ['k2', 'k3', 'k1']);
  assert.equal((await seg()).length, 2);                                              // still just Manual and AI: no copy was made
  await clickSeg('Manual');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  assert.deepEqual(await names(), ['k3', 'k1', 'k2']);                               // Manual untouched
  await clickSeg('AI');
  await page.waitForFunction(first => document.querySelector('.card').dataset.filename === first, edited[0]);
  assert.deepEqual(await names(), edited);                                            // the edit was kept
  await shot('13-ai-edited');
  await page.click('#resetAi');
  await page.waitForFunction(() => document.getElementById('resetAi').hidden);
  assert.deepEqual(await names(), ['k2', 'k3', 'k1']);
  await ctx.close();
});

test('orders: a restored image lands at the end of both orders, and the order tools hide in the trash view', { skip }, async () => {
  const ctx = await fresh({ setup: st => { st.sequences[0].order = ['k1', 'k2', 'k3', 't1', 't2', 't3', 't4']; addAi(st, ['k3', 'k2', 'k1', 't1', 't2', 't3', 't4'], { summary: 'x' }); st.active = 's1'; } });
  await page.click('#tabTrash');
  await page.waitForSelector('#trashBar:not([hidden])');
  assert.equal(await page.locator('#seqBox').isHidden(), true);
  await page.locator('.card[data-filename="t2"]').hover();
  await page.locator('.card[data-filename="t2"] .action-btn', { hasText: 'Restore' }).click();
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.includes('(4)'));
  await page.click('#tabSelection');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
  assert.equal(await page.locator('#seqBox').isVisible(), true);
  assert.equal(await page.locator('#trashBar').isHidden(), true);
  assert.deepEqual(await names(), ['k1', 'k2', 'k3', 't2']);
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  assert.deepEqual(await names(), ['k3', 'k2', 'k1', 't2']);
  await ctx.close();
});

test('orders: the tools sit on the right of the gallery bar, where the trash buttons take over in the trash tab', { skip }, async () => {
  const ctx = await fresh();
  const bar = await page.locator('.gallery-head').boundingBox();
  const tabs = await page.locator('.gallery-head > .seg').boundingBox();
  const tools = await page.locator('#seqBox').boundingBox();
  assert.ok(tools.x > tabs.x + tabs.width, 'right of the tabs');
  assert.ok(tools.x + tools.width > bar.x + bar.width - 40, 'pushed to the right edge');
  await page.click('#tabTrash');
  await page.waitForSelector('#trashBar:not([hidden])');
  const trash = await page.locator('#trashBar').boundingBox();
  assert.ok(trash.x + trash.width > bar.x + bar.width - 40, 'trash buttons on the same right edge');
  assert.equal(await page.locator('#seqBox').isHidden(), true);
  await shot('14-orders-right');
  await ctx.close();
});

test('AI order: panel, note, live progress, and the Manual order stays exactly as it was', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 2000 } });
  assert.deepEqual(await names(), ['k1', 'k2', 'k3']);
  await page.click('#aiBtn');
  await page.waitForSelector('#aiPanel:not([hidden])');
  await shot('15-ai-panel');
  await page.click('#aiBtn');
  assert.equal(await page.locator('#aiPanel').isHidden(), true);
  assert.equal(await page.locator('.action-btn[title*="Pin"], .pin-badge, #aiPins').count(), 0);        // no pins any more

  await page.click('#aiBtn');
  await page.fill('#aiDirection', 'end on the blue one');
  await page.click('#aiGo');
  await page.waitForSelector('#statusText .slot');
  assert.match(await text('#statusText'), /AI order/);
  assert.equal(await page.locator('#statusText .slot').count(), 4);
  await shot('16-ai-progress');
  await page.waitForFunction(() => /Done — AI: Opens on k3/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  assert.equal(await page.locator('#aiBtn').isDisabled(), false);
  assert.equal(await page.locator('#statusText .slot.ok').count(), 4);
  const body = api.state.jobs[0].body;
  assert.deepEqual([body.direction, body.length, 'first' in body, 'last' in body], ['end on the blue one', null, false, false]);
  assert.deepEqual(await seg(), [{ text: '✋ Manual (3)', on: false }, { text: '✨ AI (3)', on: true }]);
  assert.deepEqual(await names(), ['k3', 'k2', 'k1']);
  assert.match(await text('#seqSummary'), /Opens on k3, lands on k1/);
  await shot('17-ai-done');
  await clickSeg('Manual');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k1');
  assert.deepEqual(await names(), ['k1', 'k2', 'k3']);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('AI order: while it works nothing that changes the selection can run', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 2400 } });
  await page.click('#aiBtn');
  await page.click('#aiGo');
  await page.waitForSelector('#statusText .slot');
  // the controls are locked...
  for (const id of ['#generateBtn', '#worldSelect', '#directionInput', '#batchCountSelect', '#aiBtn', '#exportBtn']) assert.equal(await page.locator(id).isDisabled(), true, `${id} locked`);
  assert.equal(await page.locator('body.ai-running').count(), 1);
  // ...a card's trash button cannot be used...
  const before = await names();
  await page.locator('.card[data-filename="k1"]').hover();
  await page.locator('.card[data-filename="k1"] .trash-btn').click({ force: true });
  assert.deepEqual(await names(), before);
  assert.equal(api.state.calls.filter(c => c.path === '/api/trash').length, 0);
  // ...dragging does nothing...
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));
  assert.equal(api.state.calls.filter(c => c.path === '/api/reorder').length, 0);
  assert.deepEqual(await names(), before);
  // ...and the trash tab's delete buttons are locked (the tab itself can still be looked at)
  await page.click('#tabTrash');
  await page.waitForSelector('#trashBar:not([hidden])');
  assert.equal(await page.locator('#tabTrash').getAttribute('class'), 'on');                // the active tab is highlighted even while locked
  assert.equal(await page.locator('#tabSelection').getAttribute('class') || '', '');
  for (const id of ['#trashEmpty', '#trashSelAll', '#trashDelSel']) assert.equal(await page.locator(id).isDisabled(), true, `${id} locked`);
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('#tabTrash').getAttribute('class'), 'on', 'still highlighted a moment later');
  await shot('20-ai-locked');
  await page.click('#tabSelection');
  await page.waitForFunction(() => /Done — AI/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  // everything is back
  for (const id of ['#generateBtn', '#worldSelect', '#aiBtn', '#exportBtn']) assert.equal(await page.locator(id).isDisabled(), false, `${id} unlocked`);
  assert.equal(await page.locator('body.ai-running').count(), 0);
  await page.locator('.card[data-filename="k1"]').hover();
  await page.locator('.card[data-filename="k1"] .trash-btn').click();
  await page.waitForFunction(() => document.getElementById('tabTrash').textContent.includes('(5)'));
  await ctx.close();
});

test('AI order: it cannot start while images are being generated', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 400, generate: 1200 } });
  await page.click('#generateBtn');
  await page.waitForSelector('#statusText .slot');
  assert.equal(await page.locator('#aiBtn').isDisabled(), true);
  await page.waitForFunction(() => /Done — 4 added/.test(document.getElementById('statusText').textContent), null, { timeout: 20000 });
  assert.equal(await page.locator('#aiBtn').isDisabled(), false);
  assert.equal(api.state.calls.filter(c => c.path === '/api/order-ai').length, 0);
  await ctx.close();
});

test('AI order: "best N" cuts the edit and shows what was left out; playback uses only the edit', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 400 } });
  api.state.plates.push(...['k4', 'k5', 'k6'].map(f => ({ ...api.state.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg` })));
  api.state.sequences[0].order.push('k4', 'k5', 'k6');
  await page.reload();
  await page.waitForSelector('.card');
  await page.click('#aiBtn');
  await page.evaluate(() => { const o = document.createElement('option'); o.value = '2'; o.textContent = 'Best 2'; document.getElementById('aiLength').appendChild(o); });
  await page.selectOption('#aiLength', '2');
  await page.click('#aiGo');
  await page.waitForFunction(() => /Done — AI/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  await page.waitForSelector('.edit-divider');
  assert.match(await text('.edit-divider'), /left out of this edit \(4\)/);
  const cards = await names();
  assert.equal(cards.length, 6);
  assert.equal(await page.evaluate(() => [...document.getElementById('grid').children].findIndex(e => e.classList.contains('edit-divider'))), 2);
  assert.deepEqual(await seg(), [{ text: '✋ Manual (6)', on: false }, { text: '✨ AI (2 of 6)', on: true }]);
  await shot('18-best-n');
  await page.fill('#bpmSlider', '220'); await page.locator('#bpmSlider').dispatchEvent('input');
  await page.selectOption('#multSelect', '9');
  await page.click('#playBtn');
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) { seen.add(await page.locator('#stageImg').getAttribute('src')); await page.waitForTimeout(20); }
  await page.click('#playBtn');
  assert.deepEqual([...seen].filter(Boolean).map(u => u.split('/').pop().replace('.svg', '')).sort(), cards.slice(0, 2).sort());
  await ctx.close();
});

test('AI order: redoing replaces the AI order and always asks first', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 400 }, setup: aiSetup('x') });
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k2');
  await page.click('#aiBtn');
  await page.click('#aiGo');
  await page.waitForSelector('#confirmModal.open');                                  // never edited: still asks
  assert.match(await text('#confirmTitle'), /Replace the current AI order\?/);
  assert.doesNotMatch(await text('#confirmBody'), /drops the changes/);
  await page.click('#confirmModal .confirm-foot button >> text=Cancel');
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));
  await page.waitForSelector('#resetAi:not([hidden])');
  await page.click('#aiBtn');
  await page.click('#aiGo');
  await page.waitForSelector('#confirmModal.open');                                  // edited: says what is lost
  assert.match(await text('#confirmBody'), /drops the changes you made/);
  await page.click('#confirmModal .confirm-foot button >> text=Cancel');
  assert.equal(api.state.calls.filter(c => c.path === '/api/order-ai').length, 0);
  await page.click('#aiBtn');
  await page.click('#aiGo');
  await page.click('#confirmYes');
  await page.waitForFunction(() => /Done — AI/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  assert.equal((await seg()).length, 2);                                              // still one Manual and one AI
  assert.equal(await page.locator('#resetAi').isHidden(), true);                      // the new AI order is unedited
  await ctx.close();
});

test('AI order: a failure is reported and everything unlocks', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 400 }, aiFail: 'Kimi exploded' });
  await page.click('#aiBtn');
  await page.click('#aiGo');
  await page.waitForFunction(() => /AI order failed: Kimi exploded/.test(document.getElementById('statusText').textContent), null, { timeout: 10000 });
  assert.equal(await page.locator('#aiBtn').isDisabled(), false);
  assert.equal(await page.locator('#generateBtn').isDisabled(), false);
  assert.equal((await seg()).length, 1);
  await ctx.close();
});

test('AI order can replace the Manual order, after a confirmation; the AI order stays', { skip }, async () => {
  const ctx = await fresh({ setup: aiSetup('x') });                                   // Manual: k3,k1,k2   AI: k2,k3,k1
  assert.equal(await page.locator('#aiNote').isHidden(), true);                       // the button lives in the AI view only
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k2');
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));            // edit the AI order first
  await page.waitForSelector('#resetAi:not([hidden])');
  const edited = await names();
  await shot('21-use-as-manual');
  await page.click('#makeManual');
  await page.waitForSelector('#confirmModal.open');
  assert.match(await text('#confirmTitle'), /Replace your Manual order\?/);
  assert.match(await text('#confirmBody'), /can't be undone/);
  assert.equal(await text('#confirmYes'), 'Replace Manual');
  await page.click('#confirmModal .confirm-foot button >> text=Cancel');
  assert.equal(api.state.calls.filter(c => c.path === '/api/sequence' && c.body.action === 'make_manual').length, 0);
  await clickSeg('Manual');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  assert.deepEqual(await names(), ['k3', 'k1', 'k2']);                                // cancelling changed nothing
  await clickSeg('AI');
  await page.waitForFunction(first => document.querySelector('.card').dataset.filename === first, edited[0]);
  await page.click('#makeManual');
  await page.click('#confirmYes');
  await page.waitForFunction(() => document.querySelector('#orderSeg button.on').textContent.includes('Manual'));
  assert.deepEqual(await names(), edited);                                            // Manual is now a copy of the edited AI order
  assert.match(await text('#toast'), /Manual order is now a copy of the AI order/);
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('#orderSeg button.on').textContent.includes('AI'));
  assert.deepEqual(await names(), edited);                                            // the AI order is still there, still edited
  assert.equal(await page.locator('#resetAi').isHidden(), false);
  await ctx.close();
});

test('best N: the left-out divider has an "Include them all" button, and converting keeps the cut', { skip }, async () => {
  const ctx = await fresh({ setup: st => { addAi(st, ['k1', 'k2', 'k3', 't1', 't2', 't3', 't4'], { summary: 'x', cut_off: 2 }); } });   // AI active, 2 of 3 in the edit
  assert.deepEqual(await seg(), [{ text: '✋ Manual (3)', on: false }, { text: '✨ AI (2 of 3)', on: true }]);
  assert.match(await text('.edit-divider'), /left out of this edit \(1\)/);
  await page.click('#makeManual');
  await page.click('#confirmYes');
  await page.waitForFunction(() => document.querySelector('#orderSeg button.on').textContent.includes('Manual'));
  assert.deepEqual((await seg())[0], { text: '✋ Manual (2 of 3)', on: true });       // the cut came along
  await page.click('.edit-divider button');
  await page.waitForFunction(() => !document.querySelector('.edit-divider'));
  assert.deepEqual((await seg())[0], { text: '✋ Manual (3)', on: true });
  assert.equal((await seg())[1].text, '✨ AI (2 of 3)');                              // the AI order keeps its own cut
  await ctx.close();
});
