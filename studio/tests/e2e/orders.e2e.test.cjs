const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, film, curate, skip, api, page, consoleErrors, addAi } = require('./harness.cjs');
register();

test('one order: Selection | Trash on the left; AI re-order, sizes and Refresh on the right; no Manual / AI switch, no notes row', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  const bar = await page.locator('.gallery-head').boundingBox();
  const box = async sel => page.locator(sel).first().boundingBox();
  const [tabs, ai, size, refresh] = await Promise.all(['.gallery-head > .seg', '#aiBtn', '.size-seg', '#refreshBtn'].map(box));
  assert.ok(tabs.x < bar.x + 40, 'the tabs on the left');
  assert.ok(ai.x > bar.x + bar.width / 2 && ai.x + ai.width <= size.x && size.x + size.width <= refresh.x, 'right: AI re-order, sizes, Refresh');
  assert.ok(refresh.x + refresh.width > bar.x + bar.width - 40, 'Refresh at the right edge');
  assert.equal(await text('#aiBtn'), '✨ AI re-order…');
  assert.equal(await page.locator('#orderSeg, #resetAi, #makeManual, #aiNote').count(), 0, 'one order: nothing to switch, reset or copy');
  await page.click('#tabTrash'); await page.waitForSelector('#trashBar:not([hidden])');
  assert.equal(await page.locator('#seqBox').isHidden(), true, 'no re-order in the Trash');
  const trash = await page.locator('#trashBar').boundingBox();
  assert.ok(trash.x > tabs.x + tabs.width && trash.x < tabs.x + tabs.width + 40, 'the trash buttons right after the tabs');
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
  await page.fill('#bpmInput', '20'); await page.locator('#bpmInput').dispatchEvent('input');
  await page.selectOption('#multSelect', '1');                                        // 3 s a cut
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
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.includes('(4)'));
  await page.click('#tabSelection');
  await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
  assert.equal(await page.locator('#seqBox').isVisible(), true);
  assert.equal(await page.locator('#trashBar').isHidden(), true);
  assert.deepEqual(await names(), ['k1', 'k2', 'k3', 't2']);
  await ctx.close();
});

test('best N: the left-out divider has an "Include them all" button', { skip }, async () => {
  const ctx = await fresh({ setup: st => { addAi(st, ['k1', 'k2', 'k3', 't1', 't2', 't3', 't4'], { summary: 'x', cut_off: 2 }); } });
  assert.match(await text('.edit-divider'), /left out of this edit \(1\)/);
  await page.click('.edit-divider button');
  await page.waitForFunction(() => !document.querySelector('.edit-divider'));
  assert.equal(await page.locator('.card').count(), 3);
  await ctx.close();
});
