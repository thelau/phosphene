const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, skip, api, page, consoleErrors, addAi } = require('./harness.cjs');
register();
// the count: a number field (1 to 20), as the Film's Tempo; double-click, type, Enter
async function setCount(n) {
  await page.dblclick('#countField');
  await page.keyboard.press('Meta+a');
  await page.keyboard.type(String(n));
  await page.keyboard.press('Enter');
  if (n >= 1 && n <= 20) assert.equal(await page.inputValue('#batchCountSelect'), String(n));
}

test('generate: a custom territory waits for its description; controls lock, progress shows per image and on the button; the refinement stays', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 300, generate: 500 } });
  await page.click('#terrBtn');                                     // the territory list: Custom at its foot
  await page.waitForSelector('#terrMenu:not([hidden])');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'terrMenu', 'the list has the keys at once (no search field)');
  const [btnBox, menuBox] = [await page.locator('#terrBtn').boundingBox(), await page.locator('#terrMenu').boundingBox()];
  assert.ok(menuBox.width >= btnBox.width && Math.abs(btnBox.x - menuBox.x) < 2, `the list under its button, at least as wide: ${btnBox.width} / ${menuBox.width}`);
  assert.equal(await page.locator('.terr-label').count(), 0, 'no TERRITORY label: they all are');
  assert.match(await page.locator('#terrMenu .tm-item[data-v="__wildcard__"]').textContent(), /Surprise me\s+Kimi invents a territory/);
  assert.equal(await page.locator('#terrMenu .tm-item[data-v=""]').count(), 0, 'no Mix it up: you pick the territory');
  assert.match(await page.locator('#terrMenu .tm-item[data-v="__sampler__"]').textContent(), /Sampler\s+2 images from your least tried territories/, 'the count, capped at the territories there are');
  await shot('04-territory-list');
  await page.click('#terrMenu .tm-item[data-v="__custom__"]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'directionInput', 'its description opens at once');
  assert.match(await page.locator('#directionInput').getAttribute('placeholder'), /what is it\?/);
  assert.equal(await text('#refineLabel'), 'Describe');
  assert.equal(await page.locator('#refineReq').isVisible(), true, 'Required');
  assert.equal(await page.locator('#directionInput').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'the field takes the tinted area\'s colour, no box of its own');
  assert.equal(await page.locator('#generateBtn').isDisabled(), true, 'Generate waits for the description');
  await setCount(4);
  const oneLine = (await page.locator('#directionInput').boundingBox()).height;
  const size = page.viewportSize();
  await page.setViewportSize({ width: 1200, height: size.height });               // a narrow window: the hint is longer than the field
  await page.locator('#directionInput').focus();
  assert.equal((await page.locator('#directionInput').boundingBox()).height, oneLine, 'empty, it stays one line: the hint never grows it');
  assert.equal(await page.locator('#refine.tall').count(), 0);
  await page.locator('#directionInput').blur();
  await page.setViewportSize(size);
  const edit = () => page.locator('.refine-edit').evaluate(e => { const r = e.getBoundingClientRect(), t = e.querySelector('textarea').getBoundingClientRect(); const mid = q => { const b = e.querySelector(q).getBoundingClientRect(); return Math.round((b.y + b.height / 2) * 2) / 2; }; return { label: mid('.refine-label'), tag: mid('.refine-req'), x: r.x, y: r.y, w: r.width, tx: t.x, ty: t.y, radius: getComputedStyle(e).borderTopLeftRadius, shadow: getComputedStyle(e).boxShadow }; });
  await page.locator('#directionInput').blur();
  const resting = await edit();
  await page.locator('#directionInput').focus();
  const typing = await edit();
  assert.deepEqual([typing.x, typing.y, typing.w, typing.tx, typing.ty, typing.label, typing.tag], [resting.x, resting.y, resting.w, resting.tx, resting.ty, resting.label, resting.tag], 'a click in it changes nothing: no box, no shift, Describe and Required stay put');
  assert.equal(typing.shadow, 'none', 'no edge while it is one line');
  await page.fill('#directionInput', 'fog, clouds, rain');
  await page.keyboard.press('Shift+Enter');                                        // a whole brief: ⇧↩ for new lines, the field grows
  for (const [k, line] of ['Low cloud over wet stone.', 'Never a sunny sky.', 'No people.'].entries()) {
    if (k) await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(line);
  }
  const open = await page.locator('#directionInput').boundingBox();
  const tall = await edit(), first = tall.ty + 9;                                    // the middle of the brief's first line
  assert.ok(Math.abs(tall.label - first) <= 1 && Math.abs(tall.tag - first) <= 1, `Describe and Required stay on the first line (${tall.label}, ${tall.tag} vs ${first})`);
  assert.ok(Math.abs(tall.label - resting.label) <= 1, 'and where they were');
  assert.ok(open.height > oneLine * 3, `the field grows with the brief (${oneLine} → ${open.height})`);
  await shot('04b-describe-brief');
  await page.keyboard.press('Enter');                                              // ↩ alone: done
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'directionInput');
  assert.ok((await page.locator('#directionInput').boundingBox()).height <= oneLine + 1, 'back to one line in the row');
  const brief = 'fog, clouds, rain\nLow cloud over wet stone.\nNever a sunny sky.\nNo people.';
  assert.equal(await page.inputValue('#directionInput'), brief);
  await page.click('#generateBtn');
  for (const id of ['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn']) assert.equal(await page.locator(id).isDisabled(), true, `${id} locked`);
  await page.waitForSelector('#statusText .indeterminate');
  await shot('05-writing-scenes');
  await page.waitForSelector('#statusText .slot');
  assert.equal(await page.locator('#statusText .slot').count(), 4);
  await page.waitForSelector('#statusText .slot.run');
  assert.match(await text('#statusText'), /Fog & Vapor/);
  assert.equal(await text('#genLabel'), 'Generating', 'just that, with a spinner (the footer has the detail)');
  assert.equal(Math.round((await page.locator('#generateBtn').boundingBox()).width), 150, 'the same width as idle: nothing in the row moves');
  await shot('06-rendering');
  await page.waitForSelector('.pending-card');                                    // the images still coming hold their place at the end of the grid
  assert.ok(await page.locator('.pending-card').count() >= 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.pending-ring')).borderRadius), '2px', 'the mark\'s box, as the logo target, not a circle');
  const inGroups = await page.evaluate(() => {                                     // a group shows only the placeholders that will belong to it
    const n = () => document.querySelectorAll('.pending-card').length, out = {};
    setGroup('world:Editorial Print'); out.other = n();                            // another territory: none of these
    setGroup('world:Fog & Vapor'); out.own = n();                                  // the batch's own territory: all of them
    setGroup('all'); out.all = n();
    setGroup('pos:exact'); out.pos = n(); setGroup('src:generated'); out.src = n(); setGroup('all');   // an On target batch: its Position and Source groups too
    return out;
  });
  assert.equal(inGroups.other, 0, 'no placeholder in a group the new images will not be in');
  assert.ok(inGroups.own >= 1 && inGroups.own === inGroups.all, `the batch's territory shows them (${JSON.stringify(inGroups)})`);
  assert.ok(inGroups.pos === inGroups.all && inGroups.src === inGroups.all, `and its position and source (${JSON.stringify(inGroups)})`);
  await page.waitForFunction(() => /Done · 4 added/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  for (const id of ['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn']) await enabled(id);
  await page.waitForFunction(() => document.getElementById('worldSelect').value === 'Fog & Vapor');
  assert.equal(await text('#terrName'), 'Fog & Vapor', 'your territory exists now: the next batch carries on in it');
  assert.equal(await page.inputValue('#directionInput'), '', 'its brief lives in the territory, not in the field');
  assert.match(await page.locator('#terrBtn').getAttribute('title'), /in your words: fog, clouds, rain/);
  assert.equal(await text('#genLabel'), 'Generate');
  assert.equal(await page.locator('#statusText .slot.ok').count(), 4);
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.replace(/\s+/g, ' ').trim().endsWith(' 7'));
  assert.equal(await page.locator('.pending-card').count(), 0);
  assert.equal(await page.locator('.card .card-new').count(), 4, 'the new images are marked New');
  const inv = api.state.calls.find(c => c.path === '/api/invent-prompts').body;
  assert.deepEqual([inv.world, inv.direction, inv.count], ['__custom__', brief, 4], 'the brief as written, new lines and all');
  await shot('07-done');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('generate: failed images are explained (hover) and counted, the rest still arrive', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 100, generate: 200 }, failGen: n => n % 4 !== 1 });          // only every 4th request succeeds: 1 of 4
  await setCount(4);
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
  await setCount(2);
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
  await setCount(2);
  await page.click('#generateBtn');
  await page.waitForSelector('#statusText .slot.run');
  assert.equal(await asks(), true);                                                   // generating: the browser will ask first
  await page.waitForFunction(() => /Done · 2 added/.test(document.getElementById('statusText').textContent), null, { timeout: 20000 });
  await enabled('#generateBtn');
  assert.equal(await asks(), false);
  await ctx.close();
});


test('the count: any number from 1 to 40, as a value field (×N); it sends the number chosen and is remembered', { skip }, async () => {
  const ctx = await fresh({ delays: { invent: 50, generate: 20 } });
  await page.focus('#countField');
  await page.keyboard.press('ArrowUp');
  assert.equal(await text('#countVal'), '×5', 'arrows step by one: no set list');
  for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowUp');
  assert.equal(await text('#countVal'), '×40', 'never past 40');
  await setCount(0);
  assert.equal(await text('#countVal'), '×1', 'nor under 1');
  await setCount(13);
  assert.equal(await text('#countVal'), '×13');
  await setCount(12);
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

test('many territories: one column, Describe your own and Surprise me first, then the territories with where each comes from (the list scrolls); the button keeps its width', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945, setup: st => { st.moreWorlds = Array.from({ length: 30 }, (_, i) => ({ name: `Territory ${i + 1}`, brief: '', n: i % 3 ? 0 : 4, kept: i % 3 ? 0 : 1, wildcard: i > 26, origin: i > 26 ? 'invented' : i > 24 ? 'custom' : 'core' })); } });
  await page.click('#terrBtn');
  await page.waitForSelector('#terrMenu:not([hidden])');
  assert.equal(await page.locator('#terrMenu input').count(), 0, 'no search');
  const order = await page.locator('#terrMenu .tm-item').evaluateAll(els => els.slice(0, 4).map(e => e.dataset.v));
  assert.deepEqual(order, ['__custom__', '__wildcard__', '__sampler__', 'Editorial Print'], 'Describe your own, Surprise me, Sampler, then the territories');
  assert.equal(await page.locator('#terrMenu .tm-sep').count(), 3, 'a line under the two, and between the core, custom and invented groups');
  assert.equal(await page.locator('#terrMenu .tm-world').count(), 32);
  assert.equal(await page.locator('#terrMenu .tm-head').count(), 1);
  assert.match(await page.locator('#terrMenu .tm-item[data-v="__sampler__"]').textContent(), /4 images from your least tried territories/);
  await page.setViewportSize({ width: 1512, height: 700 });                           // a short window: the list scrolls
  await page.click('#terrBtn'); await page.click('#terrBtn');
  assert.equal(await page.locator('#terrMenu .tm-more').isVisible(), true, '"More below" while there is more');
  await page.locator('#terrMenu').evaluate(m => { m.scrollTop = m.scrollHeight; m.dispatchEvent(new Event('scroll')); });
  assert.equal(await page.locator('#terrMenu .tm-more').isVisible(), false, 'gone at the bottom');
  await page.setViewportSize({ width: 1512, height: 945 });
  await page.click('#terrBtn'); await page.click('#terrBtn');
  assert.equal(await page.locator('#terrMenu .tm-item[data-v="Editorial Print"] .tm-origin').textContent(), 'core', 'where it comes from (shown in capitals)');
  assert.equal(await page.locator('#terrMenu .tm-bar, #terrMenu .tm-n').count(), 0, 'no kept-of-made column');
  const groups = await page.locator('#terrMenu .tm-list').evaluate(l => [...l.children].map(c => c.classList.contains('tm-sep') ? '|' : (c.querySelector('.tm-origin') || {}).textContent).filter(Boolean).join(' ').replace(/(\w+)( \1)+/g, '$1'));
  assert.equal(groups, '| core | custom | invented', 'grouped by where they come from, a line between groups');
  const m = await page.locator('#terrMenu').evaluate(e => ({ w: e.getBoundingClientRect().width, bottom: e.getBoundingClientRect().bottom }));
  assert.ok(m.w >= 400 && m.w < 500 && m.bottom <= 945, `one column, on screen (it scrolls): ${JSON.stringify(m)}`);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#worldSelect'), 'Matter & Elements', '↓ ↩ from the first territory picks the second');
  const w0 = (await page.locator('#terrBtn').boundingBox()).width;
  await page.evaluate(() => { const s = document.getElementById('worldSelect'); s.value = '__wildcard__'; s.dispatchEvent(new Event('change')); });
  assert.equal((await page.locator('#terrBtn').boundingBox()).width, w0, 'the button keeps its width whatever the territory');
  await page.click('#terrBtn'); await shot('30-territories-one-column');
  await page.keyboard.press('Escape');
  await ctx.close();
});
