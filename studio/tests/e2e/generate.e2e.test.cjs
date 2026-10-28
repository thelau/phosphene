const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, skip, api, page, consoleErrors, addAi } = require('./harness.cjs');
register();

test('generate: a custom territory waits for its description; controls lock, progress shows per image and on the button; the refinement stays', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 300, generate: 500 } });
  await page.click('#terrBtn');                                     // the territory list: Custom at its foot
  await page.waitForSelector('#terrMenu:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'terrFilter', 'type to filter at once');
  const [btnBox, menuBox] = [await page.locator('#terrBtn').boundingBox(), await page.locator('#terrMenu').boundingBox()];
  assert.ok(Math.abs(btnBox.width - menuBox.width) < 2 && Math.abs(btnBox.x - menuBox.x) < 2, `the list as wide as its button: ${btnBox.width} / ${menuBox.width}`);
  const [label, name] = [await page.locator('.terr-label').boundingBox(), await page.locator('#terrName').boundingBox()];
  assert.ok(Math.abs(label.y + label.height - (name.y + name.height)) < 6 && label.x < name.x, 'one line: TERRITORY, then the name');
  await shot('04-territory-list');
  await page.click('#terrMenu .tm-item[data-v="__custom__"]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'directionInput', 'its description opens at once');
  assert.match(await page.locator('#directionInput').getAttribute('placeholder'), /what is it\?/);
  assert.equal(await text('#refineLabel'), 'Describe');
  assert.equal(await page.locator('#refineReq').isVisible(), true, 'Required');
  assert.equal(await page.locator('#generateBtn').isDisabled(), true, 'Generate waits for the description');
  await page.selectOption('#batchCountSelect', '4');
  await page.fill('#directionInput', 'fog, clouds, rain');
  await page.click('#generateBtn');
  for (const id of ['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn']) assert.equal(await page.locator(id).isDisabled(), true, `${id} locked`);
  await page.waitForSelector('#statusText .indeterminate');
  await shot('05-writing-scenes');
  await page.waitForSelector('#statusText .slot');
  assert.equal(await page.locator('#statusText .slot').count(), 4);
  await page.waitForSelector('#statusText .slot.run');
  assert.match(await text('#statusText'), /Fog & Vapor/);
  assert.match(await text('#genLabel'), /^Generating \d of 4$/, 'the batch on the button itself');
  await shot('06-rendering');
  await page.waitForSelector('.pending-card');                                    // the images still coming hold their place at the end of the grid
  assert.ok(await page.locator('.pending-card').count() >= 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.pending-ring')).borderRadius), '2px', 'the mark\'s box, as the logo target, not a circle');
  await page.waitForFunction(() => /Done · 4 added/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  for (const id of ['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn']) await enabled(id);
  assert.equal(await page.inputValue('#directionInput'), 'fog, clouds, rain', 'the description stays for the next batch');
  assert.equal(await text('#genLabel'), 'Generate');
  assert.equal(await page.locator('#statusText .slot.ok').count(), 4);
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.replace(/\s+/g, ' ').trim().endsWith(' 7'));
  assert.equal(await page.locator('.pending-card').count(), 0);
  assert.equal(await page.locator('.card .card-new').count(), 4, 'the new images are marked New');
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
  await page.waitForFunction(() => /Done · 1 added · 3 failed/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  const text_ = await text('#statusText');
  assert.doesNotMatch(text_, /Krea 429/, 'one short line: the reasons are on hover');
  assert.match(await page.getAttribute('#statusText .prog-note', 'title'), /Krea is busy: try again in a minute/, 'in a few words (the full error is in the log)');
  const reds = await page.locator('#statusText .slot.err').evaluateAll(els => els.map(e => e.title));
  assert.equal(reds.length, 3);
  assert.ok(reds.every(t => /Fog \d — Krea is busy/.test(t)), JSON.stringify(reds));
  assert.equal(await page.locator('#tabSelection').innerText().then(t => /^Selection 4$/.test(t.trim())), true);
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
  await page.waitForFunction(() => /Done · 2 added/.test(document.getElementById('statusText').textContent), null, { timeout: 20000 });
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
  await page.waitForFunction(() => /Done · 2 added/.test(document.getElementById('statusText').textContent), null, { timeout: 20000 });
  await enabled('#generateBtn');
  assert.equal(await asks(), false);
  await ctx.close();
});


test('the batch size list offers up to 20 images and sends the chosen number', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 50, generate: 20 } });
  const options = await page.locator('#batchCountSelect option').evaluateAll(els => els.map(e => e.value));
  assert.deepEqual(options, ['2', '4', '6', '8', '12', '16', '20']);
  assert.equal(await page.locator('#batchCountSelect option[value="20"]').innerText(), '20 images');
  await page.selectOption('#batchCountSelect', '12');
  await page.click('#generateBtn');
  await page.waitForFunction(() => /Done · 12 added/.test(document.getElementById('statusText').textContent), null, { timeout: 20000 });
  assert.equal(api.state.calls.find(c => c.path === '/api/invent-prompts').body.count, 12);
  assert.equal(await page.locator('#statusText .slot.ok').count(), 12);
  assert.equal(await page.locator('#tabSelection').innerText().then(t => /^Selection 15$/.test(t.trim())), true);          // 3 kept + 12 new
  await page.reload();
  await page.waitForSelector('.card');
  assert.equal(await page.inputValue('#batchCountSelect'), '12');                                          // remembered
  await ctx.close();
});
