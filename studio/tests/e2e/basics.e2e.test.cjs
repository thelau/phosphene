const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, film, curate, choose, skip, api, page, consoleErrors, addAi } = require('./harness.cjs');
register();

test('page loads without errors: Curate first, generation in one tidy row, no status bar while idle', { skip }, async () => {
  const ctx = await fresh();
  assert.deepEqual(consoleErrors, []);
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'curate');
  assert.equal(await page.locator('#statusText').isVisible(), false, 'the status bar only shows while something runs');
  const box = async sel => page.locator(sel).first().boundingBox();
  const [world, dir, count, gen, settings] = await Promise.all(['#worldSelect', '#directionInput', '#batchCountSelect', '#generateBtn', '#settingsBtn'].map(box));
  const header = await box('header');
  assert.ok(header.height <= 57, `header is ${header.height}px tall`);
  assert.ok(world.x + world.width <= dir.x + 1 && dir.x + dir.width <= count.x + 1 && count.x + count.width <= gen.x + 1, 'world, direction, count, Generate: left to right');
  for (const b of [dir, count, gen]) assert.ok(Math.abs(b.y + b.height / 2 - (world.y + world.height / 2)) < 4, 'one row');
  assert.ok(settings.y < world.y, 'Settings stays in the header');
  assert.equal(await text('#tabSelection'), 'Selection (3)');
  assert.equal(await text('#tabTrash'), '🗑️ Trash (4)');
  await shot('01-loaded');
  await ctx.close();
});

test('Film: look bar, preview, transport, timeline down the middle; the inspector on the right with Export pinned at its foot', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });   // the size of the design: a 16-inch MacBook Pro
  const tabs = await page.locator('.gallery-head').boundingBox();
  const firstCard = await page.locator('.card').first().boundingBox();
  assert.ok(tabs.y + tabs.height <= firstCard.y, 'Curate: the tabs are above the cards');
  assert.equal(await page.locator('#exportBtn').isVisible(), false, 'no film settings while curating');
  await film();
  const box = async sel => page.locator(sel).first().boundingBox();
  const [look, stage, play, tl, insp, exp] = await Promise.all(['.look-bar', '.stage', '#playBtn', '.timeline', '.inspector', '#exportBtn'].map(box));
  assert.ok(stage.y + stage.height <= play.y && play.y + play.height <= tl.y, 'top to bottom: preview, transport, timeline');
  assert.ok(look.x >= insp.x && Math.abs(look.y - insp.y) < 2, 'Type, Random and Undo head the inspector');
  assert.ok(insp.x >= stage.x + stage.width && Math.abs(insp.width - 600) < 2, 'the inspector is on the right, 600 px');
  const [pic, snd] = await Promise.all(['#inspPicture', '#inspSound'].map(box));
  assert.ok(Math.abs(pic.y - snd.y) < 1 && snd.x >= pic.x + pic.width - 1, 'two columns: rhythm and look, then sound');
  const soundTop = (await box('#musicSelect + .segctl')).y;
  await choose('rhythmSelect', 'variable');
  assert.equal((await box('#musicSelect + .segctl')).y, soundTop, 'Variable adds controls on the left; the sound does not move');
  await choose('rhythmSelect', 'flat');
  assert.ok(exp.y + exp.height <= 945 && exp.y > insp.y + insp.height - 120, 'Export sits at the foot of the inspector');
  assert.ok(stage.height >= 452 && Math.abs(stage.width / stage.height - 9 / 16) < 0.01, `a 9:16 preview, ${stage.height}px tall`);
  assert.equal(await page.locator('.grid-col').isVisible(), false, 'no grid while filming');
  assert.deepEqual(consoleErrors, []);
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
  await film();
  await choose('invertSelect', 'mono');
  await choose('zoomSelect', 'out');
  assert.equal(await page.locator('#invertSelect').inputValue(), 'mono', 'the segmented control drives the select');
  await page.fill('#zoomAmt', '5');
  await page.locator('#zoomAmt').dispatchEvent('input');
  assert.equal(await text('#zoomAmtVal'), '5.0%');
  await page.fill('#bpmInput', '60');
  await page.locator('#bpmInput').dispatchEvent('input');
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

test('export: preview is untouched, the panel shows the work, then Downloaded with Export again and Download again', { skip }, async () => {
  const ctx = await fresh({ delays: { export: 400 } });
  await page.locator('.card').nth(1).click();
  await film();
  const before = await page.locator('#stageImg').getAttribute('src');
  assert.match(before, /k2/, 'the image clicked in Curate is on the stage');
  assert.match(await text('#exportMeta'), /^1080 × 1920 · \d+ s · silent$/);
  await page.click('#exportBtn');
  await page.waitForSelector('#exportDock[data-state="busy"]');
  assert.match(await text('#musicState'), /Rendering on the server/);
  const link = page.locator('#downloadLink');
  await link.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#exportDock').getAttribute('data-state'), 'ready');
  assert.equal(await link.getAttribute('download'), 'Demo-test.mp4');
  assert.equal(await link.getAttribute('href'), '/outputs/Demo-test.mp4');
  assert.equal(await text('#exportFile'), 'Demo-test.mp4');
  assert.equal(await page.locator('#stageImg').getAttribute('src'), before);
  assert.equal(await page.locator('#stageImg').isVisible(), true);
  const body = api.state.calls.find(c => c.path === '/api/export-video').body;
  assert.equal('total_seconds' in body, false);
  await shot('09-export');
  await page.click('#exportAgainBtn');                                            // a second export straight from the ready panel
  await page.waitForSelector('#exportDock[data-state="ready"]');
  assert.equal(api.state.calls.filter(c => c.path === '/api/export-video').length, 2);
  await ctx.close();
});

test('export: the button is always in view (pinned under the inspector) and the finished file downloads by itself', { skip }, async () => {
  const ctx = await fresh({ width: 1280, height: 720 });
  await film();
  const inView = async () => { const b = await page.locator('#exportBtn').boundingBox(); return b && b.y >= 0 && b.y + b.height <= 720; };
  assert.equal(await inView(), true, 'visible with the sound off');
  await choose('musicSelect', 'on');
  await page.click('#soundTabNotes');
  await page.evaluate(() => { document.getElementById('inspSound').scrollTop = 99999; });
  assert.equal(await inView(), true, 'visible with the longest sound group, scrolled to the bottom');
  await page.evaluate(() => { window.__clicked = []; HTMLAnchorElement.prototype.click = function () { window.__clicked.push(this.getAttribute('download')); }; });
  await page.click('#exportBtn');
  await page.waitForSelector('#downloadLink:not([hidden])');
  assert.deepEqual(await page.evaluate(() => window.__clicked), ['Demo-test.mp4']);
  assert.match(await text('#toast'), /Export ready, downloading/);
  await ctx.close();
});

test('Random (any character or a chosen one), the card dice and Undo work in the real page and the sound keeps playing', { skip }, async () => {
  const ctx = await fresh();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await film();
  await page.click('#playBtn');
  for (let i = 0; i < 6; i++) { await page.click('#randomAllBtn'); await page.waitForTimeout(250); }
  assert.equal(await page.locator('#musicSelect').inputValue(), 'on');
  assert.equal(await page.locator('#characterSelect').inputValue(), 'any', 'Random does not change the type');
  assert.equal(await page.locator('#undoRandomBtn').isEnabled(), true);
  const snap = () => page.evaluate(() => ['rhythmSelect', 'bpmInput', 'invertSelect', 'seedVal'].map(id => document.getElementById(id).value).join());
  const last = await snap();
  await page.click('#randomAllBtn');
  assert.notEqual(await snap(), last);
  await page.click('#undoRandomBtn');                                          // one click: back to before that Random
  await page.waitForFunction(s => ['rhythmSelect', 'bpmInput', 'invertSelect', 'seedVal'].map(id => document.getElementById(id).value).join() === s, last);
  assert.match(await text('#toast'), /^Undone: Random/);
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForFunction(s => ['rhythmSelect', 'bpmInput', 'invertSelect', 'seedVal'].map(id => document.getElementById(id).value).join() !== s, last);
  await page.selectOption('#characterSelect', 'float');                       // choosing a character rolls inside it
  assert.equal(await page.locator('#rhythmSelect').inputValue(), 'flat');
  assert.ok(+(await page.locator('#bpmInput').inputValue()) <= 80);
  assert.equal(await page.locator('.segctl[data-for="rhythmSelect"] button[aria-pressed="true"]').textContent(), 'Flat', 'the segmented controls follow a random');
  for (let i = 0; i < 4; i++) { await page.click('#randomAllBtn'); assert.ok(+(await page.locator('#bpmInput').inputValue()) <= 80, 'Random stays inside Float'); }
  await page.click('#randomBtn');
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Pause', 'still playing');
  await ctx.close();
});

test('window size: a 13" laptop (1280 × 720) fits both modes; below 1200 × 640 a message asks for a bigger window', { skip }, async () => {
  let ctx = await fresh({ width: 1280, height: 720 });
  assert.equal(await page.locator('#tooSmall').isVisible(), false);
  const fits = async () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight);
  assert.ok(await fits(), 'Curate: no page scroll');
  const gen = await page.locator('#generateBtn').boundingBox();
  assert.ok(gen.x + gen.width <= 1280);
  await film();
  assert.ok(await fits(), 'Film: no page scroll');
  for (const id of ['#playBtn', '#exportBtn', '#randomAllBtn', '#filmstrip', '#bpmInput']) {
    const b = await page.locator(id).boundingBox();
    assert.ok(b && b.y >= 0 && b.y + b.height <= 720 && b.x + b.width <= 1280, `${id} in view`);
  }
  const stage = await page.locator('.stage').boundingBox();
  assert.ok(stage.height >= 200, `the preview stays usable: ${stage.height}px`);
  await choose('musicSelect', 'on'); await choose('rhythmSelect', 'variable');
  const cut = await page.evaluate(() => [...document.querySelectorAll('.segctl button, .row > .lbl, .sound-tabs button, #multSelect')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim()));
  assert.deepEqual(cut, [], 'no label is cut off on a 13" screen');
  await shot('10-laptop');
  await ctx.close();
  ctx = await fresh({ width: 1100, height: 800 });
  assert.equal(await page.locator('#tooSmall').isVisible(), true);
  assert.match(await text('#tooSmall'), /Make the window bigger/);
  await ctx.close();
});

test('the inspector: Rhythm, Look and Sound always open; Sound in four groups; Amount waits for a zoom', { skip }, async () => {
  const ctx = await fresh();
  await film();
  for (const id of ['#bpmInput', '#multSelect', '#followCuts', '#zoomAmt', '#randomBtn']) assert.ok(await page.locator(id).isVisible(), id);
  assert.equal(await page.locator('#randomRhythmBtn, #randomLookBtn').count(), 0, 'one Random for the film, one for the sound: no dice that repeat them');
  assert.equal(await text('#randomBtn'), 'Random sound');
  assert.deepEqual(await page.locator('.segctl[data-for="invertSelect"] button').allTextContents(), ['Off', 'Grey', 'Colour']);
  assert.equal(await page.locator('#zoomAmt').isDisabled(), true, 'Amount is there but off until a zoom is chosen');
  await choose('zoomSelect', 'out');
  assert.equal(await page.locator('#zoomAmt').isDisabled(), false);
  await choose('zoomSelect', 'off');
  assert.ok(!(await page.locator('#pulseRange').isVisible()), 'no synth settings while the sound is off');
  assert.ok(await page.locator('#soundOffNote').isVisible());
  await choose('musicSelect', 'on');
  assert.equal(await page.locator('#soundBtn').count(), 0, 'Source is the only sound switch');
  const groups = { Bed: ['#pulseRange', '#lowRange', '#powerRange', '#spaceRange', '#brightRange', '#widthRange'], Tone: ['#pitchRange', '#chordSelect', '#subWaveSelect', '#padWaveSelect', '#movementRange'], Texture: ['#echoRange', '#washRange', '#ringRange', '#shimmerRange'], Notes: ['#hitTypeSelect', '#hitRange', '#hitOnSelect', '#arpRange', '#arpStepsSelect', '#arpRateSelect', '#dynSelect'] };
  for (const [g, ids] of Object.entries(groups)) {
    await page.click(`#soundTab${g}`);
    for (const id of ids) assert.ok(await page.locator(id).isVisible(), `${g}: ${id}`);
    for (const [other, oids] of Object.entries(groups)) if (other !== g) assert.ok(!(await page.locator(oids[0]).isVisible()), `${g} hides ${other}`);
  }
  assert.deepEqual(await page.locator('#chordSelect option').allTextContents(), ['Dark cluster', 'Open fifth', 'Minor', 'Suspended'], 'the real names');
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'film', 'the mode is remembered');
  await shot('music-tab');
  await ctx.close();
});

test('modes: Tab switches, Space plays (also after clicking a button), switching keeps the playhead and the sound', { skip }, async () => {
  const ctx = await fresh();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'film');
  await page.fill('#bpmInput', '20'); await page.locator('#bpmInput').dispatchEvent('input');
  await page.selectOption('#multSelect', '1');                                 // 3 s a cut: the clock cannot loop back to the same reading
  await page.click('#targetBtn');                                             // a clicked button must not swallow Space
  await page.keyboard.press(' ');
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Pause');
  await page.waitForTimeout(600);
  const t1 = await text('#timecode');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'curate');
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  assert.notEqual(await text('#timecode'), t1, 'it kept playing while in Curate');
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Pause');
  await page.keyboard.press(' ');
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Play');
  await page.click('#modeCurate');
  await page.click('#directionInput');
  await page.keyboard.press('Tab');                                           // typing: Tab moves to the next field
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'curate');
  await page.keyboard.type('a b');
  assert.equal(await page.locator('#directionInput').inputValue(), '');      // focus left the field for the count select
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Play', 'typing a space does not play');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the film strip: one thumbnail per image in order, click jumps there, the image on screen can go to the Trash and come back', { skip }, async () => {
  const ctx = await fresh();
  await film();
  assert.equal(await page.locator('#filmstrip button').count(), 3);
  await page.locator('#filmstrip button').nth(2).click();
  assert.match(await page.locator('#stageImg').getAttribute('src'), /k3/);
  assert.match(await text('#curTitle'), /^3 · /);
  assert.equal(await page.locator('#filmstrip button.cur').count(), 1);
  assert.match(await text('#timecode'), /cut 3 \/ 3/);
  await page.click('#trashCurBtn');
  await page.waitForFunction(() => document.querySelectorAll('#filmstrip button').length === 2);
  assert.match(await text('#toast'), /moved to Trash/);
  assert.equal(await text('#tabSelection'), 'Selection (2)');
  await page.click('#toast button');
  await page.waitForFunction(() => document.querySelectorAll('#filmstrip button').length === 3);
  const order = await page.locator('#filmstrip button').evaluateAll(b => b.map(x => x.title.split(' · ')[0]));
  assert.deepEqual(order, ['1', '2', '3']);
  assert.match(await page.locator('#filmstrip button').nth(2).getAttribute('title'), /k3|Plate k3/, 'back in its place');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('variable speed: Flat shows tempo and multiple, Variable shows start, end and curve, and the picture accelerates', { skip }, async () => {
  const ctx = await fresh();
  await film();
  assert.ok(await page.locator('#bpmInput').isVisible() && !(await page.locator('#startMsRange').isVisible()));
  await page.selectOption('#multSelect', '1');
  await choose('rhythmSelect', 'variable');
  assert.ok(!(await page.locator('#bpmInput').isVisible()), 'no tempo in variable');
  assert.ok(await page.locator('#multSelect').isVisible(), 'the multiple stays: it only changes the pictures');
  await choose('rhythmSelect', 'flat');
  assert.equal(await page.locator('#bpmInput').getAttribute('max'), '500'); assert.equal(await page.locator('#bpmInput').getAttribute('min'), '1');
  await page.fill('#bpmInput', '500'); assert.equal(await text('#bpmVal'), '500 BPM');
  await page.fill('#bpmInput', '1'); assert.equal(await text('#bpmVal'), '1 BPM');
  await page.fill('#bpmInput', '136');
  assert.ok(await page.locator('#followCuts').isVisible(), 'the check for the music following every cut');
  await choose('rhythmSelect', 'variable');
  for (const id of ['#startMsRange', '#endMsRange', '#rampRange', '.segctl[data-for="atSelect"]']) assert.ok(await page.locator(id).isVisible(), id);
  await page.fill('#startMsRange', '100'); await page.fill('#endMsRange', '600'); await page.fill('#rampRange', '2');
  assert.match(await text('#rhythmInfo'), /cuts 100 ms, then 600 ms over the last 2$/);
  await choose('invertSelect', 'mono');
  assert.match(await text('#rhythmInfo'), /^3 images · .* cuts 100 ms, then 600 ms over the last 2$/);
  await page.click('#playBtn');
  await page.waitForFunction(() => document.getElementById('playBtn').textContent.includes('Pause'));
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#stageImg').getAttribute('src'));
  await page.click('#playBtn');
  await page.click('#exportBtn');
  await page.waitForSelector('#downloadLink:not([hidden])');
  const body = api.state.calls.filter(c => c.path === '/api/export-video').pop().body;
  assert.deepEqual([body.rhythm, body.start_ms, body.end_ms], ['variable', 100, 600]);
  await ctx.close();
});

test('synthesized music: the drone plays live in the page, settings swap it at once, export renders it in the page and sends it', { skip }, async () => {
  const ctx = await fresh();
  await film();
  assert.match(await text('#rhythmInfo'), /^3 images · \d+ s · cuts \d+ ms$/);
  assert.deepEqual(await page.locator('.segctl[data-for="musicSelect"] button').allTextContents(), ['Off', 'Synthesized']);
  await choose('musicSelect', 'on');
  await page.fill('#pulseRange', '80');
  assert.equal(await page.locator('#exportDock').getAttribute('data-state'), 'idle', 'no render, no loader');
  await page.click('#playBtn');
  await page.waitForFunction(() => document.getElementById('playBtn').textContent.includes('Pause'));
  await page.waitForFunction(() => document.getElementById('stageImg').getAttribute('src'));
  assert.equal(api.state.calls.filter(c => c.path === '/api/music').length, 0, 'the server renders nothing for the drone');
  await page.fill('#lowRange', '30');                                        // swapped live while playing
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#exportDock').getAttribute('data-state'), 'idle');
  await shot('music-synth');
  await page.click('#playBtn');
  await page.click('#exportBtn');
  await page.waitForSelector('#downloadLink:not([hidden])');
  assert.equal(api.state.calls.filter(c => c.path === '/api/export-video').pop().body.music, 'synth');
  const wav = api.state.exportAudio;
  assert.equal(wav.slice(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 2); assert.equal(wav.readUInt32LE(24), 44100);   // stereo, 44.1 kHz
  assert.ok(wav.length > 44100 * 4 * 0.2, `a clip-long sound: ${wav.length} bytes`);
  await ctx.close();
});

test('the drone engine measures like the references: sub-bass bed, dark, level, wide', { skip }, async () => {
  const ctx = await fresh();
  const m = await page.evaluate(async () => {
    const starts = Array.from({ length: 31 }, (_, i) => i * 0.25);
    const r = await window.Drone.renderExport({ pulse: 0.65, low: 0.93, bright: 0.3, width: 0.6, space: 0.06, power: 0.6, seed: 7 }, starts);
    const n = 1 << 18, mono = new Float32Array(n);                           // the first 5.9 s, summed to mono
    for (let i = 0; i < n; i++) mono[i] = (r.left[i] + r.right[i]) / 2 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    const re = Float64Array.from(mono), im = new Float64Array(n);            // iterative radix-2 FFT
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    let total = 0, low = 0, high = 0, peak = 0, peakF = 0;
    for (let k = 1; k < n / 2; k++) {
      const f = (k * 44100) / n, p = re[k] * re[k] + im[k] * im[k];
      total += p; if (f < 80) low += p; if (f > 2000) high += p; if (p > peak) { peak = p; peakF = f; }
    }
    let s = 0, side = 0, mid = 0;
    for (let i = 0; i < r.left.length; i++) { s += r.left[i] ** 2 + r.right[i] ** 2; side += ((r.left[i] - r.right[i]) / 2) ** 2; mid += ((r.left[i] + r.right[i]) / 2) ** 2; }
    let max = 0; for (let i = 0; i < r.left.length; i++) max = Math.max(max, Math.abs(r.left[i]), Math.abs(r.right[i]));
    return { dominant: peakF, low: low / total, high: high / total, rms: Math.sqrt(s / (2 * r.left.length)), sideMid: Math.sqrt(side / mid), peak: max, seconds: r.seconds };
  });
  assert.ok(m.dominant > 40 && m.dominant < 65, `dominant ${m.dominant} Hz is a sub`);
  assert.ok(m.low > 0.6, `energy below 80 Hz ${m.low}`);
  assert.ok(m.high < 0.02, `almost nothing above 2 kHz: ${m.high}`);
  assert.ok(Math.abs(m.rms - 0.17) < 0.01, `level ${m.rms}`);
  assert.ok(m.peak <= 0.97 + 1e-6);
  assert.ok(m.sideMid > 0.05 && m.sideMid < 1, `stereo ${m.sideMid}`);
  assert.equal(m.seconds, 7.5);
  await ctx.close();
});

test('hits, the arpeggio and the dynamics are heard in the real engine and stay dark and level', { skip }, async () => {
  const ctx = await fresh();
  const rows = await page.evaluate(async () => {
    const stats = (r) => {
      const n = r.left.length; let s = 0, mx = 0;
      for (let i = 0; i < n; i++) { s += r.left[i] ** 2 + r.right[i] ** 2; mx = Math.max(mx, Math.abs(r.left[i]), Math.abs(r.right[i])); }
      const half = (a, b) => { let t = 0; for (let i = a; i < b; i++) t += r.left[i] ** 2 + r.right[i] ** 2; return Math.sqrt(t / (2 * (b - a))); };
      // energy above 2 kHz and between 120 Hz and 900 Hz through simple one-pole splits
      const mono = new Float32Array(n); for (let i = 0; i < n; i++) mono[i] = (r.left[i] + r.right[i]) / 2;
      const lp = (x, fc) => { const a = 1 - Math.exp(-2 * Math.PI * fc / 44100); const y = new Float32Array(x.length); let v = 0; for (let i = 0; i < x.length; i++) { v += a * (x[i] - v); y[i] = v; } return y; };
      const e = x => { let t = 0; for (const v of x) t += v * v; return t; };
      const l250 = lp(lp(mono, 120), 120), l1k = lp(lp(mono, 900), 900), l2k = lp(lp(mono, 2000), 2000);
      const total = e(mono);
      const l500 = lp(lp(mono, 500), 500), up = (a, b) => { let t = 0, u = 0; for (let i = a; i < b; i++) { t += mono[i] ** 2; u += (mono[i] - l500[i]) ** 2; } return u / t; };   // share of the energy above ~500 Hz
      return { up1: up(0, n >> 1), up2: up(n >> 1, n), rms: Math.sqrt(s / (2 * n)), crest: mx / Math.sqrt(s / (2 * n)), first: half(0, n >> 1), second: half(n >> 1, n), mid: (e(l1k) - e(l250)) / total, high: (total - e(l2k)) / total, peak: mx };
    };
    const base = { pulse: 0.65, low: 0.93, bright: 0.3, width: 0.6, space: 0.06, power: 0.6, seed: 7 };
    const starts = Array.from({ length: 41 }, (_, i) => i * 0.2);
    const out = {};
    const go = async (name, extra, st = starts) => { out[name] = stats(await window.Drone.renderExport({ ...base, ...extra }, st)); };
    await go('plain', {});
    for (const t of [1, 2, 3, 4]) await go('hit' + t, { hitType: t, hit: 0.8, hitOn: 0 });
    await go('accents', { hitType: 1, hit: 0.8, hitOn: 3 });
    await go('arp', { arp: 0.6, arpSteps: 2, arpRate: 2 });
    const notes = { arp: 0.6, arpSteps: 2, arpRate: 2, hitType: 2, hit: 0.5, hitOn: 0 };
    await go('build', { ...notes, dynamics: 1 });
    await go('fade', { ...notes, dynamics: 2 });
    const variable = [0]; for (let i = 0; i < 40; i++) variable.push(variable[i] + (i < 28 ? 0.1 : 0.1 * Math.pow(7, (i - 27) / 12)));
    await go('follow', { ...notes, dynamics: 3 }, variable);
    await go('followFlat', { ...notes, dynamics: 3 });
    return out;
  });
  for (const [name, m] of Object.entries(rows)) {
    assert.ok(Math.abs(m.rms - 0.17) < 0.01 && m.peak <= 0.97 + 1e-6, `${name}: level ${m.rms}, peak ${m.peak}`);
    assert.ok(m.high < 0.02, `${name}: dark, ${m.high} above 2 kHz`);
  }
  for (const t of [1, 2, 3, 4]) assert.ok(rows['hit' + t].crest > rows.plain.crest + 0.1, `hit type ${t} adds transients (${rows['hit' + t].crest} vs ${rows.plain.crest})`);
  assert.ok(rows.arp.mid > rows.plain.mid * 1.1, `the arpeggio adds notes in the mids (${rows.arp.mid} vs ${rows.plain.mid})`);
  // dynamics shape the notes, never the volume: the level stays flat, the brightness moves
  for (const k of ['build', 'fade', 'follow', 'followFlat']) assert.ok(Math.abs(rows[k].first - rows[k].second) < rows[k].rms * 0.25, `${k}: the volume stays level (${rows[k].first} vs ${rows[k].second})`);
  assert.ok(rows.build.up2 > rows.build.up1 * 1.05, `rise: the notes are brighter at the end (${rows.build.up1} -> ${rows.build.up2})`);
  assert.ok(rows.fade.up1 > rows.fade.up2 * 1.05, `fall: the notes are brighter at the start (${rows.fade.up1} -> ${rows.fade.up2})`);
  assert.ok(rows.follow.up1 > rows.follow.up2 * 1.03, `follows the speed: brighter while the cuts are fast (${rows.follow.up1} -> ${rows.follow.up2})`);
  assert.ok(Math.abs(rows.followFlat.up1 - rows.followFlat.up2) < rows.followFlat.up1 * 0.25, 'a flat speed has nothing to follow');
  await ctx.close();
});

test('Random sound: every draw stays a dark, heavy, level drone and a new sound plays live', { skip }, async () => {
  const ctx = await fresh();
  await film();
  await choose('musicSelect', 'on');
  const before = await page.evaluate(() => JSON.stringify([...document.querySelectorAll('#synthBox input[type=range], #chordSelect')].map(e => e.value)));
  await page.click('#randomBtn');
  const after = await page.evaluate(() => JSON.stringify([...document.querySelectorAll('#synthBox input[type=range], #chordSelect')].map(e => e.value)));
  assert.notEqual(before, after, 'the sliders moved');
  const rows = await page.evaluate(async () => {
    const out = [];
    const starts = Array.from({ length: 21 }, (_, i) => i * 0.2);
    const real = Math.random; let x = 20261026;                               // seeded: the same 10 draws every run, so a failure can be replayed
    Math.random = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
    for (let t = 0; t < 10; t++) {
      randomMusic();                                                           // the page's own draw, rendered by the real engine
      const u = id => parseInt(document.getElementById(id).value, 10) / 100;
      const prm = { pulse: u('pulseRange'), low: u('lowRange'), bright: u('brightRange'), width: u('widthRange'), space: u('spaceRange'), power: u('powerRange'), pitch: u('pitchRange'), movement: u('movementRange'), echo: u('echoRange'), wash: u('washRange'), ring: u('ringRange'), shimmer: u('shimmerRange'), hitType: parseInt(document.getElementById('hitTypeSelect').value, 10), hit: u('hitRange'), hitOn: parseInt(document.getElementById('hitOnSelect').value, 10), arp: u('arpRange'), arpSteps: parseInt(document.getElementById('arpStepsSelect').value, 10), arpRate: parseInt(document.getElementById('arpRateSelect').value, 10), dynamics: parseInt(document.getElementById('dynSelect').value, 10), subWave: parseInt(document.getElementById('subWaveSelect').value, 10), padWave: parseInt(document.getElementById('padWaveSelect').value, 10), chord: parseInt(document.getElementById('chordSelect').value, 10), seed: parseInt(document.getElementById('seedVal').value, 10) };
      const r = await window.Drone.renderExport(prm, starts);
      const n = 1 << 16, re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < n; i++) re[i] = (r.left[i] + r.right[i]) / 2 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
      for (let len = 2; len <= n; len <<= 1) { const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = i + k + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const q = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = q; } } }
      let tot = 0, low = 0, high = 0, pk = 0, pf = 0;
      for (let k = 1; k < n / 2; k++) { const f = (k * 44100) / n, pw = re[k] ** 2 + im[k] ** 2; tot += pw; if (f < 80) low += pw; if (f > 2000) high += pw; if (pw > pk) { pk = pw; pf = f; } }
      let s = 0, mx = 0; for (let i = 0; i < r.left.length; i++) { s += r.left[i] ** 2 + r.right[i] ** 2; mx = Math.max(mx, Math.abs(r.left[i]), Math.abs(r.right[i])); }
      out.push({ dom: pf, low: low / tot, high: high / tot, rms: Math.sqrt(s / (2 * r.left.length)), peak: mx });
    }
    Math.random = real;
    return out;
  });
  for (const m of rows) {
    assert.ok(m.dom > 34 && m.dom < 76, `dominant ${m.dom}`);
    assert.ok(m.low > 0.3, `energy below 80 Hz ${m.low}`);                     // the thinnest of 180 draws measured 0.33, with a very big room
    assert.ok(m.high < 0.02, `above 2 kHz ${m.high}`);
    assert.ok(Math.abs(m.rms - 0.17) < 0.01 && m.peak <= 0.97 + 1e-6, `level ${m.rms} peak ${m.peak}`);
  }
  await ctx.close();
});

test('the rhythm strip in the page: ticks, band, beats and axis follow the settings; the playhead moves; a click jumps', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await film();
  const ticks = async () => (await page.locator('#rsTicks').getAttribute('d')).split('M').length - 1;
  assert.equal(await ticks(), 3, 'one tick per picture cut');
  assert.equal(await page.locator('#rsBand').isVisible(), false, 'Flat: no band');
  await choose('invertSelect', 'mono');
  assert.equal(await ticks(), 6, 'each image and its inverted copy');
  await choose('rhythmSelect', 'variable');
  await page.selectOption('#multSelect', '1');                                     // one picture cut per cut of the run: 6 cuts
  await page.fill('#startMsRange', '100'); await page.fill('#endMsRange', '600'); await page.fill('#rampRange', '2');
  await page.locator('#rampRange').dispatchEvent('input');
  assert.equal(await page.locator('#rsBand').isVisible(), true);
  assert.equal(await page.locator('.segctl[data-for="rhythmSelect"] button[aria-pressed="true"]').evaluate(b => getComputedStyle(b).backgroundColor), 'rgb(254, 255, 231)', 'the chosen segment is lit at once');
  const lab = await page.locator('#rsH0L').boundingBox(), body0 = await page.locator('#rsBody').boundingBox();
  assert.ok(lab.x >= body0.x - 1 && lab.x + lab.width <= body0.x + body0.width + 1, 'the Start label stays inside the strip');
  assert.equal(await text('#rsBandLabel'), 'Landing · 2 cuts');
  assert.equal(await text('#rsH1L'), 'End 600 ms');
  await shot('19-rhythm-landing');
  const box = await page.locator('#rsBody').boundingBox();
  const band = await page.locator('#rsBand').boundingBox();
  assert.ok(band.x > box.x + box.width / 4 && Math.abs(band.x + band.width - (box.x + box.width)) < 2, 'the landing sits at the end, in time');   // the last 2 of 6 cuts are the long ones: about 70% of the time
  await page.mouse.click(box.x + box.width * 0.75, box.y + 30);                   // jump three quarters in
  const at = await page.evaluate(() => parseFloat(document.getElementById('rsPlayhead').style.left));
  assert.ok(Math.abs(at - 75) < 1, `playhead at ${at}%`);
  await page.click('#playBtn');
  await page.waitForTimeout(500);
  const later = await page.evaluate(() => parseFloat(document.getElementById('rsPlayhead').style.left));
  assert.notEqual(later, at, 'the playhead moves while playing');
  await page.click('#playBtn');
  const axis = await page.locator('#rsAxis span').allTextContents();
  assert.equal(axis[0], '0 s');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the rhythm strip stays readable from 1 image to 300 at one frame a cut', { skip }, async () => {
  const ctx = await fresh({ width: 1280, height: 720 });
  for (let i = 0; i < 300; i++) { const f = `q${i}`; api.state.plates.push({ ...api.state.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg` }); api.state.sequences[0].order.push(f); }
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  await film();
  await page.fill('#bpmInput', '450'); await page.locator('#bpmInput').dispatchEvent('input');
  await page.selectOption('#multSelect', '4');
  assert.match(await text('#rsFast'), /1 frame at 30 fps/);
  assert.equal((await page.locator('#rsTicks').getAttribute('d')).split('M').length - 1, 303);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  assert.ok(fits, 'no sideways scroll');
  await shot('19-rhythm-300');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('Curate: thumbnail sizes, trash from the grid with Undo, restore picked images, the floating preview', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  const cols = async () => page.evaluate(() => getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length);
  const m = await cols();
  await page.click('#thumbS'); const sm = await cols();
  await page.click('#thumbL'); const lg = await cols();
  assert.ok(sm > m && m > lg, `S ${sm} > M ${m} > L ${lg} columns`);
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  assert.equal(await page.locator('#thumbL').getAttribute('aria-pressed'), 'true', 'the size is remembered');
  // trash from the grid, then Undo: back in its place
  await page.locator('.card[data-filename="k2"]').hover();
  await page.locator('.card[data-filename="k2"] .trash-btn').click();
  await page.waitForFunction(() => !document.querySelector('.card[data-filename="k2"]'));
  assert.match(await text('#toast'), /moved to Trash/);
  await page.click('#toast button');
  await page.waitForFunction(() => [...document.querySelectorAll('.card')].map(c => c.dataset.filename).join() === 'k1,k2,k3');
  // restore picked images from the Trash in one go
  await page.click('#tabTrash');
  await page.locator('.card').nth(0).click({ position: { x: 60, y: 120 } });
  await page.locator('.card').nth(1).click({ position: { x: 60, y: 120 } });
  assert.equal(await page.locator('.card.sel .card-pick').count(), 2);
  await page.click('#trashRestoreSel');
  await page.waitForFunction(() => document.getElementById('tabSelection').textContent.includes('(5)'));
  assert.equal(await page.locator('.card').count(), 2);
  await page.click('#tabSelection');
  // the floating preview plays the film in Curate, hides to a pill, and opens Film
  assert.equal(await page.locator('#miniPlayer #stageImg').count(), 1, 'the one stage sits in the floating preview');
  await page.click('#miniPlayBtn');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#miniPlayBtn').getAttribute('aria-label'), 'Pause');
  assert.match(await text('#miniCount'), /^\d\/5$/);
  assert.equal(await page.locator('#miniCount').evaluate(e => { e.textContent = '1333/1333'; return e.offsetHeight < 16; }), true, 'one line, even with a big library');
  await page.click('#miniHide');
  assert.equal(await page.locator('#miniPlayer').isVisible(), false);
  assert.equal(await page.locator('#miniPill').isVisible(), true);
  await page.click('#miniPill');
  await page.click('#miniOpenFilm');
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'film');
  assert.equal(await page.locator('#stageHome #stageImg').count(), 1, 'and back on the Film stage');
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Pause', 'still playing');
  await shot('20-curate-film');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('refresh: the Curate and Film buttons pick up new images at once, and the film follows', { skip }, async () => {
  const ctx = await fresh();
  api.state.plates.push({ ...api.state.plates[0], filename: 'k9', title: 'Plate k9', url: '/assets/ai-plates/k9.svg' });
  api.state.sequences[0].order.push('k9');
  await page.click('#refreshBtn');
  await page.waitForSelector('.card[data-filename="k9"]');
  assert.match(await text('#toast'), /\+1 new image/);
  await film();
  assert.equal(await page.locator('#filmstrip button').count(), 4, 'the film has it too');
  api.state.plates.push({ ...api.state.plates[0], filename: 'k10', title: 'Plate k10', url: '/assets/ai-plates/k10.svg' });
  api.state.sequences[0].order.push('k10');
  await page.click('#refreshFilmBtn');
  await page.waitForFunction(() => document.querySelectorAll('#filmstrip button').length === 5);
  await curate();
  assert.equal(await page.locator('.card[data-filename="k10"]').count(), 1, 'and the library, from the Film button');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the grid only touches what changed: a refresh, a reorder or a new image keep the other cards (and their loaded images)', { skip }, async () => {
  const ctx = await fresh();
  const tag = () => page.evaluate(() => document.querySelectorAll('.card[data-filename]').forEach(el => { el.__kept = el.dataset.filename; }));
  const kept = () => page.evaluate(() => [...document.querySelectorAll('.card[data-filename]')].map(el => (el.__kept ? el.dataset.filename : '-' + el.dataset.filename)));
  await tag();
  await page.click('#refreshBtn'); await page.waitForTimeout(300);
  assert.deepEqual(await kept(), ['k1', 'k2', 'k3'], 'nothing changed: every card kept');
  await page.locator('.card').nth(2).dragTo(page.locator('.card').nth(0));
  await page.waitForFunction(() => document.querySelector('.card').dataset.filename === 'k3');
  assert.deepEqual(await kept(), ['k3', 'k1', 'k2'], 'a reorder moves the cards, it does not rebuild them');
  assert.deepEqual(await page.locator('.card-num').allTextContents(), ['01', '02', '03'], 'and the numbers follow');
  api.state.plates.push({ ...api.state.plates[0], filename: 'k9', title: 'Plate k9', url: '/assets/ai-plates/k9.svg' });
  api.state.sequences[0].order.push('k9');
  await page.click('#refreshBtn');
  await page.waitForSelector('.card[data-filename="k9"]');
  assert.deepEqual(await kept(), ['k3', 'k1', 'k2', '-k9'], 'a new image adds one card');
  await tag();
  await page.click('#tabTrash'); await page.waitForSelector('#tabTrash.on');
  await page.click('#tabSelection'); await page.waitForSelector('#tabSelection.on');
  assert.deepEqual(await kept(), ['k3', 'k1', 'k2', 'k9'], 'to the Trash and back: the same cards, not rebuilt');
  await page.locator('.card[data-filename="k1"] .info-btn').click({ force: true });
  await page.click('#refreshBtn'); await page.waitForTimeout(300);
  assert.equal(await page.locator('.card[data-filename="k1"] .prompt-overlay.open').count(), 1, 'an open info panel stays open through a refresh');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('playing 150 images at one frame a cut, the stage never paints an image that is not ready', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945, delays: { image: 40 } })   // each image takes 20-60 ms to arrive (a plate from the local server);
  for (let i = 0; i < 150; i++) { const f = `z${i}`; api.state.plates.push({ ...api.state.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg`, preview: `/assets/ai-plates/${f}.svg?w=540` }); api.state.sequences[0].order.push(f); }   // like the real server: the stage's size is not the film strip's
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  await film();
  await page.fill('#bpmInput', '450'); await page.locator('#bpmInput').dispatchEvent('input');
  await page.selectOption('#multSelect', '4');
  await page.evaluate(() => {
    window.__bad = 0; window.__frames = 0; window.__srcs = new Set();
    const img = document.getElementById('stageImg');
    const loop = () => { window.__frames++; window.__srcs.add(img.getAttribute('src')); if (!(img.complete && img.naturalWidth > 0)) window.__bad++; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await page.click('#playBtn');
  await page.waitForTimeout(3000);
  await page.click('#playBtn');
  const r = await page.evaluate(() => ({ bad: window.__bad, frames: window.__frames, shown: window.__srcs.size, ...window.stageStats() }));
  console.log(`stage: ${r.frames} frames, ${r.shown} images shown, ${r.bad} not ready, ${r.lateFrames} held, ${r.ready} decoded ahead`);
  assert.ok(r.shown > 40, 'it really moved through the images');
  assert.equal(r.bad, 0, 'no frame painted an image that was not ready');
  assert.ok(r.lateFrames < r.frames * 0.15, `it keeps up: ${r.lateFrames} held frames`);   // without decoding ahead, 176 of 184 frames painted an image that was not ready
  await ctx.close();
});

test('keys in the page: arrows step, F fills the screen with the preview and F leaves, Delete trashes and Cmd+Z brings it back', { skip }, async () => {
  const ctx = await fresh();
  await film();
  await page.keyboard.press('ArrowRight');
  assert.match(await page.locator('#stageImg').getAttribute('src'), /k2/);
  await page.keyboard.press('f');
  await page.waitForFunction(() => document.fullscreenElement && document.fullscreenElement.id === 'stage');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('stageImg')).objectFit), 'contain', 'the whole frame, not cropped');
  await page.mouse.move(400, 400);
  assert.equal(await page.locator('#fsBar').isVisible(), true, 'its own controls, for anyone who does not know Esc');
  await page.click('#fsPlayBtn');
  assert.equal(await page.locator('#fsPlayBtn').getAttribute('aria-label'), 'Pause');
  await shot('23-fullscreen');
  await page.waitForTimeout(2300);
  assert.equal(await page.locator('#stage').evaluate(e => e.classList.contains('idle')), true, 'they fade when the mouse rests');
  await page.mouse.move(420, 420);
  await page.click('#fsPlayBtn');
  await page.click('#fsExitBtn');
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.locator('#fsBar').isVisible(), false);
  await page.keyboard.press('f');
  await page.waitForFunction(() => document.fullscreenElement);
  await page.keyboard.press('f');
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => document.querySelectorAll('#filmstrip button').length === 2);
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => document.querySelectorAll('#filmstrip button').length === 3);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('dragging the inner point of a landing with the mouse sets Change over; the playhead does not jump', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  for (let i = 0; i < 21; i++) { const f = `d${i}`; api.state.plates.push({ ...api.state.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg` }); api.state.sequences[0].order.push(f); }
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  await film();
  await choose('rhythmSelect', 'variable');
  await page.selectOption('#multSelect', '1');
  await page.fill('#rampRange', '6'); await page.locator('#rampRange').dispatchEvent('input');
  const dot = await page.locator('#rsH0.inner').boundingBox();
  const body = await page.locator('#rsBody').boundingBox();
  const head = await page.evaluate(() => document.getElementById('rsPlayhead').style.left);
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
  await page.mouse.down();
  await page.mouse.move(body.x + body.width * 0.25, dot.y + dot.height / 2, { steps: 8 });
  await page.mouse.up();
  const ramp = +(await page.locator('#rampRange').inputValue());
  assert.ok(ramp > 6, `dragged left: the change takes more cuts (${ramp})`);
  const dot2 = await page.locator('#rsH0').boundingBox();
  assert.ok(Math.abs(dot2.x + dot2.width / 2 - (body.x + body.width * 0.25)) < body.width * 0.06, 'the point stays under the pointer');
  assert.equal(await text('#rsBandLabel'), `Landing · ${ramp} cuts`);
  assert.equal(await page.evaluate(() => document.getElementById('rsPlayhead').style.left), head, 'letting go did not jump the playhead');
  assert.equal(await page.locator('#rsH1.inner').count(), 0, 'the End point at the very end does not drag');
  await shot('21-drag-point');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('edge states: an empty library says what to do, the Trash has no film preview, a running job never covers the rhythm strip', { skip }, async () => {
  let ctx = await fresh({ width: 1280, height: 720, delays: { invent: 1500 } });
  await page.click('#tabTrash'); await page.waitForSelector('#tabTrash.on');
  assert.equal(await page.locator('#miniPlayer').isVisible(), false, 'no film preview over the Trash');
  assert.equal(await page.locator('.card-num:visible').count(), 0, 'no order numbers in the Trash');
  await page.click('#tabSelection'); await page.waitForSelector('#tabSelection.on');
  assert.equal(await page.locator('#miniPlayer').isVisible(), true);
  await page.click('#generateBtn');                                                // a job: the status bar appears
  await page.waitForSelector('#statusText:not([data-idle="1"])');
  await film();
  const strip = await page.locator('.rs-readout').boundingBox(), bar = await page.locator('#statusText').boundingBox();
  assert.ok(strip.y + strip.height <= bar.y + 1, `the strip stays above the status bar (${strip.y + strip.height} vs ${bar.y})`);
  await page.waitForFunction(() => /Done/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  await ctx.close();
  ctx = await fresh({ empty: true, setup: st => { st.plates.length = 0; st.sequences[0].order.length = 0; } });
  assert.match(await text('#gridEmpty'), /No images yet/);
  await film();
  assert.equal(await page.locator('#exportBtn').isDisabled(), true, 'nothing to export');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the Keys panel: ? opens a tidy list under the hint, Esc and a click elsewhere close it', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await page.keyboard.press('?');
  await page.waitForSelector('#keysPanel:not([hidden])');
  assert.equal(await page.locator('#keysPanel dt').count(), 10);
  const p = await page.locator('#keysPanel').boundingBox();
  assert.ok(p.x >= 0 && p.x + p.width <= 1512 && p.y + p.height <= 945, 'all of it on screen');
  await shot('22-keys');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#keysPanel').isVisible(), false);
  await page.click('#keysBtn');
  assert.equal(await page.locator('#keysPanel').isVisible(), true);
  await page.mouse.click(700, 600);
  assert.equal(await page.locator('#keysPanel').isVisible(), false);
  await ctx.close();
});

test('dropdowns in the app style: open below or above depending on room, pick with the mouse or the keyboard, Esc closes', { skip }, async () => {
  const ctx = await fresh({ width: 1280, height: 720 });
  await film();
  await choose('musicSelect', 'on');
  // the Multiple, high on the page: opens downward
  await page.click('.csel[data-for="multSelect"]');
  await page.waitForSelector('#cselMenu:not([hidden])');
  assert.equal(await page.locator('#cselMenu').getAttribute('data-side'), 'down');
  assert.deepEqual(await page.locator('#cselMenu .csel-item').allTextContents(), ['×¼', '×½', '×1', '×1⅓', '×2', '×3', '×4', '×6', '×8', '×9']);
  assert.equal(await page.locator('#cselMenu [aria-selected="true"]').textContent(), '×4');
  await shot('24-dropdown');
  await page.locator('#cselMenu .csel-item', { hasText: '×2' }).first().click();
  assert.equal(await page.locator('#multSelect').inputValue(), '2', 'the real select took the value');
  assert.equal(await page.locator('.csel[data-for="multSelect"] .csel-face').textContent(), '×2');
  assert.equal(await page.locator('#cselMenu').isVisible(), false);
  // Dynamics, low in the Notes group: opens upward
  await page.click('#soundTabNotes');
  await page.evaluate(() => { document.getElementById('inspSound').scrollTop = 99999; });
  await page.setViewportSize({ width: 1280, height: 640 });                      // a short window: little room under the last dropdown
  await page.evaluate(() => { document.getElementById('inspSound').scrollTop = 99999; });
  const face = await page.locator('.csel[data-for="dynSelect"]').boundingBox();
  await page.click('.csel[data-for="dynSelect"]');
  const menu = await page.locator('#cselMenu').boundingBox(), side = await page.locator('#cselMenu').getAttribute('data-side');
  assert.equal(side, 640 - (face.y + face.height) < face.y ? 'up' : 'down', 'it opens toward the side with more room');
  assert.ok(menu.y >= 0 && menu.y + menu.height <= 640, 'and stays on screen');
  assert.ok(menu.y + menu.height <= face.y + 1 || menu.y >= face.y + face.height - 1, 'without covering its own button');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#cselMenu').isVisible(), false);
  // the keyboard: arrows and Enter
  await page.focus('#chordSelect').catch(() => {});
  await page.click('#soundTabTone');
  await page.focus('#chordSelect');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#cselMenu').isVisible(), true);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#chordSelect').inputValue(), '1');
  assert.equal(await page.locator('.csel[data-for="chordSelect"] .csel-face').textContent(), 'Open fifth');
  // a value set by Random shows on the face too
  await page.click('#randomBtn');
  const v = await page.evaluate(() => { const s = document.getElementById('chordSelect'); return s.options[s.selectedIndex].textContent; });
  assert.equal(await page.locator('.csel[data-for="chordSelect"] .csel-face').textContent(), v);
  // while the film plays (the film strip scrolls by itself) an open menu stays open; scrolling its own panel closes it
  for (let i = 0; i < 40; i++) { const f = `m${i}`; api.state.plates.push({ ...api.state.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg` }); api.state.sequences[0].order.push(f); }
  await page.click('#refreshFilmBtn'); await page.waitForFunction(() => document.querySelectorAll('#filmstrip button').length > 40);
  await page.locator('#filmstrip button').nth(14).click();                         // near the strip's right edge: it has to scroll as it plays
  await page.click('#playBtn');
  await page.click('.csel[data-for="characterSelect"]');
  await page.locator('#cselMenu .csel-item').nth(3).hover();
  const left0 = await page.evaluate(() => document.getElementById('filmstrip').scrollLeft);
  await page.waitForTimeout(2500);
  assert.notEqual(await page.evaluate(() => document.getElementById('filmstrip').scrollLeft), left0, 'the strip did scroll');
  assert.equal(await page.locator('#cselMenu').isVisible(), true, 'still open after 2.5 s of playing');
  await page.evaluate(() => { document.getElementById('inspPicture').scrollTop += 40; });
  await page.evaluate(() => { document.getElementById('cselMenu').hidden || document.getElementById('inspPicture').dispatchEvent(new Event('scroll')); });
  await page.keyboard.press('Escape');
  await page.click('#playBtn');
  // no system dropdown is left in the page (the segmented ones are buttons)
  const native = await page.evaluate(() => [...document.querySelectorAll('select')].filter(s => !s.classList.contains('seg-src') && !s.parentElement.classList.contains('csel')).map(s => s.id));
  assert.deepEqual(native, []);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the tempo lock is a small lock next to the tempo: on, Random keeps the tempo', { skip }, async () => {
  const ctx = await fresh();
  await film();
  await page.fill('#bpmInput', '97'); await page.locator('#bpmInput').dispatchEvent('input');
  await page.click('.lock');
  assert.equal(await page.locator('#bpmLock').isChecked(), true);
  for (let i = 0; i < 5; i++) await page.keyboard.press('r');
  assert.equal(await page.locator('#bpmInput').inputValue(), '97');
  assert.equal(await text('#bpmVal'), '97 BPM');
  await ctx.close();
});
