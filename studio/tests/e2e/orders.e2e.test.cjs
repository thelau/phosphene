const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, film, curate, skip, api, page, consoleErrors, addAi, tempo, mult, change, noChange } = require('./harness.cjs');
register();

test('one order: Selection | Trash on the left; AI order, the tools and the size on the right; no Manual / AI switch, no notes row', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  const bar = await page.locator('.gallery-head').boundingBox();
  const box = async sel => page.locator(sel).first().boundingBox();
  const [tabs, ai, tools, size] = await Promise.all(['.gallery-head > .seg', '#aiBtn', '.tool-group', '.size-ctl'].map(box));
  assert.ok(tabs.x < bar.x + 40, 'the tabs on the left');
  assert.ok(ai.x > bar.x + bar.width / 2 && ai.x + ai.width <= tools.x && tools.x + tools.width <= size.x, 'right: AI order, the tools (download, target, refresh), the size');
  assert.ok(size.x + size.width > bar.x + bar.width - 40, 'the size at the right edge');
  assert.equal(await text('#aiBtn'), 'AI order…');
  assert.equal(await page.locator('#orderSeg, #resetAi, #makeManual, #aiNote').count(), 0, 'one order: nothing to switch, reset or copy');
  await page.click('#tabTrash'); await page.waitForSelector('#trashBar:not([hidden])');
  assert.equal(await page.locator('#seqBox').isHidden(), true, 'no re-order in the Trash');
  const lead = await page.locator('#trashLead').boundingBox(), trash = await page.locator('#trashBar').boundingBox();
  assert.ok(lead.x > tabs.x + tabs.width && lead.x < tabs.x + tabs.width + 40, 'what to do, right after the tabs');
  assert.ok(trash.x > bar.x + bar.width / 2, 'Restore, Delete and Empty trash on the right');
  await shot('14-one-order');
  await ctx.close();
});

test('the order is always yours to drag, also after an AI re-order, and a drag can be undone', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 200 } });
  await page.click('#aiBtn'); await page.click('#aiGo');
  await page.waitForFunction(() => /Done — AI re-order/.test(document.getElementById('statusText').textContent) && !document.getElementById('aiBtn').disabled, null, { timeout: 15000 });
  assert.deepEqual(await names(), ['k3', 'k2', 'k1']);
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k1');
  assert.equal(await page.locator('#confirmModal.open').count(), 0, 'no read-only question');
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  await ctx.close();
});

test('player: an AI re-order while playing, the film follows the new order', { skip }, async () => {
  const ctx = await fresh({ delays: { ai: 300 } });
  await film();
  await tempo(20);
  await mult('1');                                        // 3 s a cut
  await page.click('#playBtn');
  await curate();
  await page.click('#aiBtn'); await page.click('#aiGo');
  await page.waitForFunction(() => /Done — AI re-order/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  await film();
  await page.locator('#filmstrip button').nth(0).click();
  assert.match(await page.locator('#stageImg').getAttribute('src'), /k3/, 'the first image is the new first one');
  await page.keyboard.press(' ');
  await ctx.close();
});

test('a restored image lands at the end of the order, and the re-order tool hides in the trash view', { skip }, async () => {
  const ctx = await fresh();
  await page.click('#tabTrash');
  await page.waitForSelector('#trashBar:not([hidden])');
  assert.equal(await page.locator('#seqBox').isHidden(), true);
  await page.locator('.card[data-filename="t2"]').hover();
  await page.locator('.card[data-filename="t2"] .action-btn', { hasText: 'Restore' }).click();
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.replace(/\s+/g, ' ').trim().endsWith(' 4'));
  await page.click('#tabSelection');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
  assert.equal(await page.locator('#seqBox').isVisible(), true);
  assert.equal(await page.locator('#trashBar').isHidden(), true);
  assert.deepEqual(await names(), ['k1', 'k2', 'k3', 't2']);
  await ctx.close();
});

test('one of your groups keeps its own order: a drag there moves only the group, All stays as it was', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await page.evaluate(() => fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', name: 'Night', files: ['k3', 'k1'] }) }));
  await page.evaluate(() => refreshLibrary());
  const all = await names();
  await page.waitForSelector('#groupBar .chip.own');
  await page.click('#groupBar .chip.own');
  await page.waitForFunction(() => document.querySelectorAll('.card[data-filename]').length === 2);
  assert.deepEqual(await names(), ['k3', 'k1'], 'its own order, not All\'s');
  await page.locator('.card[data-filename="k1"]').dragTo(page.locator('.card[data-filename="k3"]'));
  await page.waitForFunction(() => [...document.querySelectorAll('.card[data-filename]')].map(c => c.dataset.filename).join() === 'k1,k3');
  await page.click('#groupRow .chip[data-key="all"]');
  await page.waitForFunction(n => [...document.querySelectorAll('.card[data-filename]')].length === n, all.length);
  assert.deepEqual(await names(), all, 'All did not move');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});
