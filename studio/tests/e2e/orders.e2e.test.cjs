const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, film, curate, skip, api, page, consoleErrors, addAi } = require('./harness.cjs');
register();

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
  assert.equal(await text('#aiBtn'), '↻ Re-order');
  assert.deepEqual(await names(), ['k3', 'k1', 'k2']);
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k2');
  assert.deepEqual(await names(), ['k2', 'k3', 'k1']);
  assert.equal(await text('#seqSummary'), 'Hook on k2, lands on k1.');
  assert.equal(await page.locator('#aiNote').isVisible(), true);
  assert.match(await text('#aiNote'), /AI order notes/i);
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
  await film();
  await page.fill('#bpmInput', '60'); await page.locator('#bpmInput').dispatchEvent('input');
  await page.selectOption('#multSelect', '1');                                        // one cut per second
  await page.click('#playBtn');
  const src = async () => (await page.locator('#stageImg').getAttribute('src')).split('/').pop().replace('.svg', '');
  await page.waitForFunction(() => document.getElementById('stageImg').getAttribute('src'));
  assert.equal(await src(), 'k3');                                                    // starts on Manual's first
  await curate();                                                                     // the orders live in Curate; the film keeps playing
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
  await page.keyboard.press(' ');                                                     // Space pauses from Curate too
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Play');
  await ctx.close();
});

test('orders: the AI order is read-only; dragging there offers to make it your Manual order, and the drag then works in Manual', { skip }, async () => {
  const ctx = await fresh({ setup: aiSetup('x') });                                   // Manual: k3,k1,k2   AI: k2,k3,k1
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k2');
  assert.equal(await text('#gridHint'), 'The AI order is read-only');
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));
  await page.waitForSelector('#confirmModal.open');
  assert.match(await text('#confirmTitle'), /The AI order is read-only/);
  assert.equal(await text('#confirmYes'), 'Use as my Manual order');
  await page.click('#confirmModal .confirm-foot button >> text=Cancel');
  assert.deepEqual(await names(), ['k2', 'k3', 'k1'], 'cancelled: nothing moved');
  assert.equal(api.state.calls.filter(c => c.path === '/api/reorder').length, 0);
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));
  await page.click('#confirmYes');
  await page.waitForFunction(() => document.querySelector('#orderSeg button.on').textContent.includes('Manual'));
  assert.deepEqual(await names(), ['k2', 'k3', 'k1'], 'Manual is now a copy of the AI order');
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));             // and here the drag works
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k1');
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k2');
  assert.deepEqual(await names(), ['k2', 'k3', 'k1'], 'the AI order is as the AI made it');
  assert.equal(await page.locator('#resetAi').isHidden(), true);
  await ctx.close();
});

test('orders: an AI order edited before it became read-only can still go back to what the AI made', { skip }, async () => {
  const ctx = await fresh({ setup: st => { aiSetup('x')(st); st.sequences.find(q => q.kind === 'ai').order = ['k1', 'k2', 'k3']; } });
  await clickSeg('AI');
  await page.waitForSelector('#resetAi:not([hidden])');
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

test('orders: the order tools sit right after the Selection / Trash tabs, the trash buttons take their place in the trash, size and hint on the right', { skip }, async () => {
  const ctx = await fresh();
  const bar = await page.locator('.gallery-head').boundingBox();
  const tabs = await page.locator('.gallery-head > .seg').boundingBox();
  const tools = await page.locator('#seqBox').boundingBox();
  const size = await page.locator('.size-seg').boundingBox();
  assert.ok(tools.x > tabs.x + tabs.width && tools.x < tabs.x + tabs.width + 40, 'right after the tabs');
  assert.ok(size.x + size.width > bar.x + bar.width - 40, 'the thumbnail size on the right edge');
  await page.click('#tabTrash');
  await page.waitForSelector('#trashBar:not([hidden])');
  const trash = await page.locator('#trashBar').boundingBox();
  assert.ok(trash.x > tabs.x + tabs.width && trash.x < tabs.x + tabs.width + 40, 'trash buttons in the same place');
  assert.equal(await page.locator('#seqBox').isHidden(), true);
  await shot('14-orders-right');
  await ctx.close();
});

test('AI order can replace the Manual order, after a confirmation; the AI order stays', { skip }, async () => {
  const ctx = await fresh({ setup: st => { aiSetup('x')(st); st.sequences.find(q => q.kind === 'ai').order = ['k1', 'k2', 'k3']; } });   // an AI order edited before it became read-only
  assert.equal(await page.locator('#aiNote').isHidden(), true);                       // the button lives in the AI view only
  await clickSeg('AI');
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k1');
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

