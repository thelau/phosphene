const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, skip, api, page, consoleErrors, addAi } = require('./harness.cjs');
register();

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



test('the player panel: preview, play / target, then Video and Music tabs with their settings, export below', { skip }, async () => {
  const ctx = await fresh();
  const box = async sel => page.locator(sel).first().boundingBox();
  const [title, stage, play, target, tabs, exp] = await Promise.all(['.panel-title', '.stage', '#playBtn', '#targetBtn', '.fx-tabs', '#exportBtn'].map(box));
  assert.equal((await text('.panel-title')).toLowerCase(), 'preview sequence');
  assert.ok(title.y < stage.y && stage.y + stage.height <= play.y && play.y + play.height <= tabs.y && tabs.y + tabs.height <= exp.y, 'top to bottom: title, preview, play row, tabs, export');
  assert.ok(Math.abs(play.y - target.y) < 4, 'Play and Target share a row');
  assert.equal(await text('#targetBtn'), '🎯 Target');
  // Video tab is open: its settings are visible, the music ones are not
  for (const id of ['#bpmSlider', '#multSelect', '#invertSelect', '#zoomSelect']) assert.ok(await page.locator(id).isVisible(), id);
  assert.ok(!(await page.locator('#zoomAmt').isVisible()), 'Amount appears only once a zoom is chosen');
  await page.selectOption('#zoomSelect', 'out');
  assert.ok(await page.locator('#zoomAmt').isVisible());
  await page.selectOption('#zoomSelect', 'off');
  assert.ok(!(await page.locator('#pulseRange').isVisible()));
  await page.click('#tabMusic');
  assert.ok(await page.locator('#musicSelect').isVisible());
  assert.ok(!(await page.locator('#pulseRange').isVisible()), 'no synth settings while the music is off');
  await page.selectOption('#musicSelect', 'on');
  for (const id of ['#pulseRange', '#lowRange', '#powerRange', '#spaceRange']) assert.ok(await page.locator(id).isVisible(), id);
  for (const id of ['#brightRange', '#widthRange', '#seedBtn']) assert.ok(!(await page.locator(id).isVisible()), `${id} sits under More`);
  await page.click('#moreMusic summary');
  for (const id of ['#brightRange', '#widthRange', '#seedBtn']) assert.ok(await page.locator(id).isVisible(), id);
  assert.ok(!(await page.locator('#bpmSlider').isVisible()));
  const exp2 = await box('#exportBtn');
  assert.ok(exp2.y > (await box('#seedBtn')).y, 'export stays below whichever tab is open');
  await shot('music-tab');
  await page.click('#tabVideo');
  assert.ok(await page.locator('#bpmSlider').isVisible());
  await ctx.close();
});

test('synthesized music: settings render in the background with a loader, Play is instant, settings and export carry the choices', { skip }, async () => {
  const ctx = await fresh();
  assert.match(await text('#rhythmInfo'), /^3 images · \d+ s · cuts \d+ ms$/);
  await page.click('#tabMusic');
  assert.deepEqual(await page.locator('#musicSelect option').allTextContents(), ['Off · silent', 'Synthesized · follows the tempo', 'My track · drives the cuts']);
  await page.selectOption('#musicSelect', 'on');
  await page.fill('#pulseRange', '80');
  await page.waitForFunction(() => /ready/i.test(document.getElementById('musicState').textContent), null, { timeout: 5000 });
  const before = api.state.calls.filter(c => c.path === '/api/music').length;
  await page.click('#playBtn');
  await page.waitForFunction(() => document.getElementById('playBtn').textContent.includes('Pause'));
  assert.equal(api.state.calls.filter(c => c.path === '/api/music').length, before, 'already rendered: Play does not render again');
  const call = api.state.calls.filter(c => c.path === '/api/music').pop();
  assert.equal(call.body.music, 'synth'); assert.equal(call.body.pulse, 0.8); assert.equal(call.body.space, 0.6);
  await shot('music-synth');
  await page.click('#playBtn');
  await page.click('#exportBtn');
  await page.waitForSelector('#downloadLink:not([hidden])');
  assert.equal(api.state.calls.filter(c => c.path === '/api/export-video').pop().body.music, 'synth');
  await ctx.close();
});

test('music-driven: choose a track, the cuts follow it, Play uses its sound, export says track', { skip }, async () => {
  const ctx = await fresh();
  await page.click('#tabMusic');
  await page.selectOption('#musicSelect', 'track');
  assert.ok(await page.locator('#trackBtn').isVisible() && !(await page.locator('#pulseRange').isVisible()));
  assert.equal(await text('#trackName'), 'No track yet');
  await page.setInputFiles('#trackFile', { name: 'glitch-loop.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('not really audio, the fake server accepts anything') });
  await page.waitForFunction(() => document.getElementById('trackName').textContent === 'glitch-loop.mp3');
  assert.match(await text('#trackInfo'), /126 BPM · 30 s · 210 hits · 64 notes found/);
  await page.selectOption('#cutOnSelect', 'hits');
  await page.fill('#sensRange', '70');
  await page.fill('#nudgeRange', '40');
  assert.equal(await text('#nudgeVal'), '40 ms');
  await page.waitForFunction(() => /ready/i.test(document.getElementById('musicState').textContent), null, { timeout: 5000 });
  const cuts = api.state.calls.filter(c => c.path === '/api/track-cuts').pop();
  assert.equal(cuts.body.cut_on, 'hits'); assert.equal(cuts.body.sensitivity, 0.7); assert.equal(cuts.body.nudge, 0.04);
  await page.click('#tabVideo');
  assert.ok(await page.locator('#bpmSlider').isDisabled(), 'the tempo no longer drives the cuts');
  assert.match(await text('#rhythmInfo'), /^3 images · 1 s · cuts 100 ms – 300 ms$/);   // uneven cuts: the range, shortest to longest
  await shot('music-driven');
  await page.click('#playBtn');
  await page.waitForFunction(() => document.getElementById('playBtn').textContent.includes('Pause'));
  assert.equal(api.state.calls.filter(c => c.path === '/api/music').pop().body.music, 'track');
  await page.click('#playBtn');
  await page.click('#exportBtn');
  await page.waitForSelector('#downloadLink:not([hidden])');
  const exp = api.state.calls.filter(c => c.path === '/api/export-video').pop().body;
  assert.deepEqual([exp.music, exp.cut_on, exp.sensitivity], ['track', 'hits', 0.7]);
  await page.click('#tabMusic');
  await page.click('#trackClear');
  await page.waitForFunction(() => document.getElementById('trackName').textContent === 'No track yet');
  assert.equal(await page.locator('#musicSelect').inputValue(), 'off');
  await ctx.close();
});
