const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, skip, api, page, consoleErrors, addAi } = require('./harness.cjs');
register();

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
  for (const id of ['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn']) await enabled(id);
  assert.equal(await page.inputValue('#directionInput'), '');
  assert.equal(await page.locator('#statusText .slot.ok').count(), 4);
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.includes('(7)'));
  const inv = api.state.calls.find(c => c.path === '/api/invent-prompts').body;
  assert.deepEqual([inv.world, inv.direction, inv.count], ['__custom__', 'fog, clouds, rain', 4]);
  await shot('07-done');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('generate: failed images are explained (hover) and counted, the rest still arrive', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 100, generate: 200 }, failGen: n => n % 4 !== 1 });          // only every 4th request succeeds: 1 of 4
  await page.selectOption('#batchCountSelect', '4');
  await page.click('#generateBtn');
  await page.waitForFunction(() => /Done — 1 added, 3 failed/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  const text_ = await text('#statusText');
  assert.match(text_, /Krea 429: too many requests/);
  assert.match(text_, /hover the red bars/);
  const reds = await page.locator('#statusText .slot.err').evaluateAll(els => els.map(e => e.title));
  assert.equal(reds.length, 3);
  assert.ok(reds.every(t => /Fog \d — Krea 429/.test(t)), JSON.stringify(reds));
  assert.equal(await page.locator('#tabSelection').innerText().then(t => /\(4\)/.test(t)), true);
  await ctx.close();
});

test('a server restart during a batch does not reload the page underneath it', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 100, generate: 5000 } });                // long enough for two version checks while it runs
  await page.selectOption('#batchCountSelect', '2');
  await page.evaluate(() => { window.__marker = 'still here'; });
  await page.click('#generateBtn');
  await page.waitForSelector('#statusText .slot.run');
  for (let i = 0; i < 50 && !api.state.calls.some(c => c.path === '/api/version'); i++) await page.waitForTimeout(100);     // the page has recorded the server it started with
  api.state.boot = 'restarted';                                                       // the dev runner restarted the server
  await page.waitForFunction(() => /The server restarted/.test(document.getElementById('toast').textContent), null, { timeout: 6000 });
  assert.equal(await page.evaluate(() => window.__marker), 'still here');             // no reload happened
  await page.waitForFunction(() => /Done — 2 added/.test(document.getElementById('statusText').textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => window.__marker === undefined, null, { timeout: 8000 });     // the reload happens afterwards, once idle
  await ctx.close();
});

test('closing or reloading the page during a batch asks first (and not when idle)', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 100, generate: 1500 } });
  const asks = () => page.evaluate(() => { const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; });
  assert.equal(await asks(), false);                                                  // idle: leave freely
  await page.selectOption('#batchCountSelect', '2');
  await page.click('#generateBtn');
  await page.waitForSelector('#statusText .slot.run');
  assert.equal(await asks(), true);                                                   // generating: the browser will ask first
  await page.waitForFunction(() => /Done — 2 added/.test(document.getElementById('statusText').textContent), null, { timeout: 20000 });
  await enabled('#generateBtn');
  assert.equal(await asks(), false);
  await ctx.close();
});

