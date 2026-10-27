const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, film, curate, skip, api, page, consoleErrors, addAi, tempo, mult, change, noChange } = require('./harness.cjs');
register();

test('AI re-order: panel, live progress, the new order, and Undo puts the old one back', { skip }, async () => {
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
  assert.equal(await page.locator('#aiLock').isVisible(), true, 'a banner says the selection is locked');
  assert.equal(await text('#gridHint'), 'Locked while the AI orders');
  await shot('16-ai-progress');
  await page.waitForFunction(() => /Done — AI re-order: Opens on k3/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  await enabled('#aiBtn');
  assert.equal(await page.locator('#statusText .slot.ok').count(), 4);
  assert.equal(await page.locator('#aiLock').isVisible(), false);
  const body = api.state.jobs[0].body;
  assert.deepEqual([body.direction, body.length, 'first' in body, 'last' in body], ['end on the blue one', null, false, false]);
  assert.deepEqual(await names(), ['k3', 'k2', 'k1']);
  assert.match(await text('#statusText'), /Opens on k3, lands on k1/, 'what the AI did, in the status bar');
  await shot('17-ai-done');
  await page.click('#toast button');                                                 // Undo: the order as it was
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
  for (const id of ['#generateBtn', '#worldSelect', '#aiBtn', '#exportBtn']) await enabled(id);
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
  await enabled('#aiBtn');
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
  await shot('18-best-n');
  await film();
  assert.equal(await page.locator('#filmstrip button').count(), 2, 'the film strip holds only the edit');
  await tempo(220);
  await mult('9');
  await page.click('#playBtn');
  const seen = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) { seen.add(await page.locator('#stageImg').getAttribute('src')); await page.waitForTimeout(20); }
  await page.click('#playBtn');
  assert.deepEqual([...seen].filter(Boolean).map(u => u.split('/').pop().replace('.svg', '')).sort(), cards.slice(0, 2).sort());
  await ctx.close();
});

test('AI re-order: no confirmation (it can be undone); two re-orders undo one at a time, with their best-N cut', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 200 } });
  const run = async len => { await page.click('#aiBtn'); if (len) await page.evaluate(n => { const o = document.createElement('option'); o.value = n; o.textContent = `Best ${n}`; document.getElementById('aiLength').appendChild(o); document.getElementById('aiLength').value = n; }, String(len)); await page.click('#aiGo'); await page.waitForSelector('#aiBtn:disabled'); await page.waitForFunction(() => /Done — AI re-order/.test(document.getElementById('statusText').textContent) && !document.getElementById('aiBtn').disabled, null, { timeout: 15000 }); };
  await run(2);
  assert.equal(await page.locator('#confirmModal.open').count(), 0, 'no question asked');
  assert.deepEqual(await names(), ['k3', 'k2', 'k1']);
  assert.equal(await page.locator('.edit-divider').count(), 1, 'best 2: the divider');
  await run(null);
  assert.deepEqual(await names(), ['k1', 'k2', 'k3'], 'the second re-order reverses the first');
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  assert.equal(await page.locator('.edit-divider').count(), 1, 'undo brings back the cut too');
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k1' && !document.querySelector('.edit-divider'));
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('AI order: a failure is reported and everything unlocks', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 400 }, aiFail: 'Kimi exploded' });
  await page.click('#aiBtn');
  await page.click('#aiGo');
  await page.waitForFunction(() => /AI order failed: Kimi exploded/.test(document.getElementById('statusText').textContent), null, { timeout: 10000 });
  await enabled('#aiBtn');
  await enabled('#generateBtn');
  await ctx.close();
});

