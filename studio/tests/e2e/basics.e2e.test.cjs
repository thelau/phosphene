const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, film, curate, choose, skip, api, page, consoleErrors, addAi, tempo, mult, change, noChange } = require('./harness.cjs');
register();

test('page loads without errors: Curate first, generation in one tidy row, no status bar while idle', { skip }, async () => {
  const ctx = await fresh();
  assert.deepEqual(consoleErrors, []);
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'curate');
  assert.equal(await page.locator('#statusText').isVisible(), false, 'the status bar only shows while something runs');
  const box = async sel => page.locator(sel).first().boundingBox();
  const [world, dir, count, gen, settings] = await Promise.all(['#terrBtn', '#refineOpen', '.csel[data-for="batchCountSelect"]', '#generateBtn', '#settingsBtn'].map(box));
  const header = await box('header');
  assert.ok(header.height <= 57, `header is ${header.height}px tall`);
  assert.ok(world.x + world.width <= dir.x + 1 && dir.x + dir.width <= count.x + 1 && count.x + count.width <= gen.x + 1, 'territory, Refine, count, Generate: left to right');
  assert.ok(world.width > dir.width, 'the territory leads: it is the bigger part');
  assert.equal(await text('#terrName'), 'Mix it up');
  for (const b of [dir, count, gen]) assert.ok(Math.abs(b.y + b.height / 2 - (world.y + world.height / 2)) < 4, 'one row');
  assert.ok(settings.y < world.y, 'Settings stays in the header');
  assert.equal(await text('#tabSelection'), 'Selection (3)');
  assert.equal(await text('#tabTrash'), '🗑️ Trash (4)');
  await shot('01-loaded');
  await ctx.close();
});

test('Film: preview, then the timeline (transport and group on top, tempo and Multiple over the lanes); the inspector on the right with Look over Sound and Export at its foot', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });   // the size of the design: a 16-inch MacBook Pro
  const tabs = await page.locator('.gallery-head').boundingBox();
  const firstCard = await page.locator('.card').first().boundingBox();
  assert.ok(tabs.y + tabs.height <= firstCard.y, 'Curate: the tabs are above the cards');
  assert.equal(await page.locator('#exportBtn').isVisible(), false, 'no film settings while curating');
  await film();
  const box = async sel => page.locator(sel).first().boundingBox();
  const [look, stage, play, tl, insp, exp, editBar, group, tempoF, speed] = await Promise.all(['.look-bar', '.stage', '#playBtn', '.timeline', '.inspector', '#exportBtn', '.edit-bar', '.csel[data-for="filmGroup"]', '#tempoField', '#rsSpeed'].map(box));
  assert.ok(stage.y + stage.height <= tl.y && play.y >= tl.y && play.y + play.height <= tempoF.y, 'top to bottom: preview, then the timeline with the transport on top');
  assert.ok(Math.abs(group.y + group.height / 2 - (play.y + play.height / 2)) < 4 && group.x > play.x, 'the group sits in the transport row');
  assert.ok(tempoF.y + tempoF.height <= speed.y, 'the tempo and the Multiple above the lanes');
  assert.ok(editBar.x >= insp.x && editBar.y - insp.y < 16 && look.y >= editBar.y + editBar.height, 'the snapshots head the inspector, then Type, Random and Undo');
  assert.ok(insp.x >= stage.x + stage.width && Math.abs(insp.width - 440) < 2, `the inspector is on the right, 440 px (${insp.width})`);
  const [pic, snd] = await Promise.all(['#inspPicture', '#inspSound'].map(box));
  assert.ok(snd.y >= pic.y + pic.height - 1 && Math.abs(snd.width - pic.width) < 2, 'Look as a band on top, Sound below it, full width');
  assert.equal(await page.locator('#rhythmSelect, #bpmInput, #multSelect').evaluateAll(els => els.filter(e => e.offsetParent).length), 0, 'no rhythm controls in the inspector: the timeline is the control');
  assert.ok(exp.y + exp.height <= 945 && exp.y > insp.y + insp.height - 120, 'Export sits at the foot of the inspector');
  assert.ok(stage.height >= 470 && Math.abs(stage.width / stage.height - 9 / 16) < 0.01, `a 9:16 preview, ${stage.height}px tall`);
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
  await tempo(60);
  await mult('2');                       // 2 cuts a second: a cut lasts 500ms
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

test('export: preview is untouched, the panel shows the work, then Downloaded for a moment and the Export button again (no Export again)', { skip }, async () => {
  const ctx = await fresh({ delays: { export: 400 } });
  await page.locator('.card').nth(1).click();
  await film();
  const before = await page.locator('#stageImg').getAttribute('src');
  assert.match(before, /k2/, 'the image clicked in Curate is on the stage');
  assert.match(await text('#exportMeta'), /^1080 × 1920 · \d+ s · silent$/);
  await page.click('#exportBtn');
  await page.waitForSelector('#exportDock[data-state="busy"]');
  assert.match(await text('#musicState'), /Exporting|Rendering|Encoding/);
  const link = page.locator('#downloadLink');
  await page.waitForSelector('#exportDock[data-state="ready"]');
  assert.equal(await link.isVisible(), false, 'no Download again');
  assert.equal(await page.locator('#exportAgainBtn').count(), 0, 'no Export again');
  assert.equal(await link.getAttribute('download'), 'Demo-test.mp4');
  assert.equal(await link.getAttribute('href'), '/outputs/Demo-test.mp4');
  assert.equal(await text('#exportFile'), 'Demo-test.mp4');
  assert.equal(await page.locator('#stageImg').getAttribute('src'), before);
  assert.equal(await page.locator('#stageCanvas').isVisible(), true, 'the stage draws with WebGL');
  const body = api.state.calls.find(c => c.path === '/api/export-video').body;
  assert.equal('total_seconds' in body, false);
  await shot('09-export');
  await page.waitForSelector('#exportDock[data-state="idle"]', { timeout: 8000 });     // "Downloaded" for a moment, then the Export button
  assert.equal(await page.locator('#exportBtn').isVisible(), true);
  await page.click('#exportBtn');
  await page.waitForSelector('#exportDock[data-state="ready"]');
  assert.equal(api.state.calls.filter(c => c.path === '/api/export-video').length, 2);
  await ctx.close();
});

test('WebGL renderer: invert (colour, grey), zoom about the centre and the trail mix give the export\'s numbers', { skip }, async () => {
  const ctx = await fresh();
  const got = await page.evaluate(() => {
    const src = document.createElement('canvas'); src.width = 90; src.height = 160;          // left 30% (200,100,50), the rest (20,40,60)
    const x = src.getContext('2d'); x.fillStyle = 'rgb(20,40,60)'; x.fillRect(0, 0, 90, 160); x.fillStyle = 'rgb(200,100,50)'; x.fillRect(0, 0, 27, 160);
    const ghost = document.createElement('canvas'); ghost.width = 90; ghost.height = 160;
    const y = ghost.getContext('2d'); y.fillStyle = 'rgb(0,0,250)'; y.fillRect(0, 0, 90, 160);
    const c = document.createElement('canvas'); c.width = 90; c.height = 160;
    const r = window.Render.create(c, { keep: true });
    const at = (f, px) => { r.draw(f); const out = new Uint8Array(4); r.gl.readPixels(px, 80, 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, out); return [...out].slice(0, 3); };
    const cur = (o = {}) => ({ cur: { key: 's', img: src, invert: 'off', scale: 1, ...o } });
    return {
      plain: at(cur(), 10), right: at(cur(), 70),
      colour: at(cur({ invert: 'colour' }), 10),
      mono: at(cur({ invert: 'mono' }), 10),
      zoom: at(cur({ scale: 2 }), 18),                    // x = 0.2 samples 0.35 at twice the size: past the band
      unzoomed: at(cur(), 18),
      trail: at({ ...cur(), ghost: { key: 'g', img: ghost, invert: 'off', scale: 1, alpha: 0.3 } }, 10),
    };
  });
  const near = (a, b, label) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 2), `${label}: ${a} vs ${b.map(Math.round)}`);
  near(got.plain, [200, 100, 50], 'plain'); near(got.right, [20, 40, 60], 'the other side');
  near(got.colour, [55, 155, 205], 'colour invert');
  const L = 0.299 * 200 + 0.587 * 100 + 0.114 * 50; near(got.mono, [255 - L, 255 - L, 255 - L], 'grey invert: Pillow\'s L, inverted');
  near(got.zoom, [20, 40, 60], 'zoomed about the centre'); near(got.unzoomed, [200, 100, 50], 'not zoomed');
  near(got.trail, [200 * 0.7, 100 * 0.7, 50 * 0.7 + 250 * 0.3], 'the trail: a plain mix, as Image.blend');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('export with WebGL: the page draws every frame as planAt plans them and the server is only asked to encode', { skip }, async () => {
  const ctx = await fresh();
  await film();
  await choose('invertSelect', 'colour');
  await tempo(60);
  await mult('1');                                     // a cut a second: 30 frames each, 3 images x 2 = 180 frames
  await page.click('#exportBtn');
  await page.waitForFunction(() => document.getElementById('exportDock').dataset.state === 'ready', null, { timeout: 30000 });
  const body = api.state.calls.find(c => c.path === '/api/export-video').body;
  assert.equal(body.frames, 180);
  assert.equal(api.state.frames.length, 180);
  assert.ok(api.state.frames.every(f => f && f.length > 1000 && f[0] === 0xff && f[1] === 0xd8), 'every frame a JPEG');
  const px = async i => page.evaluate(async b64 => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${b64}`)).blob());
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return { size: [bmp.width, bmp.height], rgb: [...x.getImageData(40, 40, 1, 1).data].slice(0, 3) };
  }, api.state.frames[i].toString('base64'));
  const hex = h => [1, 2, 3].map(k => parseInt(h[k] + h[k], 16));
  const COLORS = ['#c44', '#4a6', '#46c', '#ca4', '#a4c', '#4cc', '#888'], colour = n => hex(COLORS[[...n].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length]);
  const first = await px(15), twin = await px(45), second = await px(75);
  assert.deepEqual(first.size, [1080, 1920]);
  const near = (a, b, label) => assert.ok(a.every((v, i) => Math.abs(v - b[i]) <= 4), `${label}: ${a} vs ${b}`);
  near(first.rgb, colour('k1'), 'cut 1: the first image');
  near(twin.rgb, colour('k1').map(v => 255 - v), 'cut 2: its inverted copy');
  near(second.rgb, colour('k2'), 'cut 3: the next image');
  assert.ok(api.state.frameRequests.length < 30, `held cuts go as runs, not a request a frame: ${api.state.frameRequests.length}`);
  await page.fill('#trailRange', '40'); await page.locator('#trailRange').dispatchEvent('input');   // Trail: the cut before shows through, fading over 4 frames
  await page.waitForSelector('#exportDock[data-state="idle"]', { timeout: 8000 });
  await page.click('#exportBtn');
  await page.waitForFunction(() => document.getElementById('exportDock').dataset.state === 'ready', null, { timeout: 30000 });
  const k1i = colour('k1').map(v => 255 - v), mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
  near((await px(30)).rgb, mix(k1i, colour('k1'), 0.4), 'first frame of the inverted copy: 40% of the image before');
  near((await px(31)).rgb, mix(k1i, colour('k1'), 0.3), 'then 30%');
  near((await px(34)).rgb, k1i, 'gone after 4 frames');
  assert.deepEqual(consoleErrors, []);
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
  await page.waitForSelector('#exportDock[data-state="ready"]');
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
  assert.equal(await page.locator('#rsStart').isVisible(), false, 'the timeline follows a random: one speed, no change');
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
  for (const id of ['#playBtn', '#exportBtn', '#randomAllBtn', '#filmstrip', '#tempoField', '#multField', '#rsSpeed', '#rsAxis']) {
    const b = await page.locator(id).boundingBox();
    assert.ok(b && b.y >= 0 && b.y + b.height <= 720 && b.x + b.width <= 1280, `${id} in view`);
  }
  const stage = await page.locator('.stage').boundingBox();
  assert.ok(stage.height >= 330, `the preview stays usable: ${stage.height}px`);
  await choose('musicSelect', 'on'); await change();
  const cut = await page.evaluate(() => [...document.querySelectorAll('.segctl button, .row > .lbl, .sound-tabs button, .vfield, .tl-follow')].filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent.trim()));
  assert.deepEqual(cut, [], 'no label is cut off on a 13" screen');
  await shot('10-laptop');
  await ctx.close();
  ctx = await fresh({ width: 1100, height: 800 });
  assert.equal(await page.locator('#tooSmall').isVisible(), true);
  assert.match(await text('#tooSmall'), /Make the window bigger/);
  await ctx.close();
});

test('the inspector: Look and Sound always open; Sound in four groups; Amount waits for a zoom', { skip }, async () => {
  const ctx = await fresh();
  await film();
  for (const id of ['#tempoField', '#multField', '#followCuts', '#zoomAmt', '#randomBtn']) assert.ok(await page.locator(id).isVisible(), id);
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
  const groups = { Bed: ['#pulseRange', '#lowRange', '#powerRange', '#spaceRange', '#brightRange', '#widthRange'], Tone: ['#pitchRange', '#chordSelect', '#progSelect', '#progEverySelect', '#padRange', '#subWaveSelect', '#padWaveSelect', '#movementRange'], Texture: ['#echoRange', '#washRange', '#ringRange', '#shimmerRange', '#choirRange', '#industrialRange', '#tapeRange'], Notes: ['#hitTypeSelect', '#hitRange', '#hitOnSelect', '#arpRange', '#arpMoodSelect', '#arpStepsSelect', '#arpRateSelect', '#bassRange', '#bassPatternSelect', '#bassRateSelect', '#arrangeSelect', '#dynSelect'] };
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
  await tempo(20);
  await mult('1');                                 // 3 s a cut: the clock cannot loop back to the same reading
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
  await page.click('#refineOpen');                                            // Refine opens in place, the field focused
  assert.equal(await page.evaluate(() => document.activeElement.id), 'directionInput');
  await page.keyboard.press('Tab');                                           // typing: Tab moves to the next field
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'curate');
  await page.keyboard.type('a b');
  assert.equal(await page.locator('#directionInput').inputValue(), '');      // focus left the field for the count select
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Play', 'typing a space does not play');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the logo target in Curate: the switch draws the 18% circle at dead-center on every card, and the Film preview follows', { skip }, async () => {
  const ctx = await fresh();
  await curate();
  const circle = () => page.locator('.card-thumb').first().evaluate(el => {
    const a = getComputedStyle(el, '::after'), r = el.getBoundingClientRect();
    return { shown: a.content !== 'none' && a.display !== 'none', w: parseFloat(a.width) / r.width, x: parseFloat(a.left) / r.width, y: parseFloat(a.top) / r.height };
  });
  assert.equal((await circle()).shown, false);
  await page.click('#gridTargetBtn');
  const c = await circle();
  assert.ok(c.shown && Math.abs(c.w - 0.18) < 0.01 && Math.abs(c.x - 0.5) < 0.01 && Math.abs(c.y - 0.5) < 0.01, JSON.stringify(c));
  assert.equal(await page.locator('.card-thumb').count() > 1, true);
  await shot('25-curate-target');
  await film();
  assert.equal(await page.locator('#reticle').evaluate(e => e.classList.contains('visible')), true, 'one switch: the Film shows it too');
  await page.keyboard.press('t');
  await curate();
  assert.equal((await circle()).shown, false, 'T turned it off everywhere');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('many groups: those that do not fit go behind "+N more" (never the chosen one), the Auto menus on the right; the pick bar floats at the bottom, never over the chips', { skip }, async () => {
  const ctx = await fresh({ width: 1280, height: 720 });
  await curate();
  await page.evaluate(async () => {
    for (const name of ['Night city reflections', 'Paper and print', 'Brushed metal', 'Studio still lifes', 'Water and glass', 'Concrete and stone', 'Grain and strata', 'Editorial print', 'Screens and interfaces', 'Out of home', 'Last one here'])
      await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', name, files: ['k1', 'k2'] }) });
  });
  await page.click('#refreshBtn');
  await page.waitForSelector('#moreChip:not([hidden])');
  const row = await page.locator('#groupRow').boundingBox(), auto = await page.locator('#autoMenus').boundingBox();
  const shown = await page.locator('#groupBar .chip:not(.out):not(.chip-overflow)').evaluateAll(b => b.map(x => ({ key: x.dataset.key, right: x.getBoundingClientRect().right })));
  assert.ok(shown.length >= 3 && shown.every(c => c.right <= auto.x), `the chips that fit end before the Auto menus: ${JSON.stringify(shown)}`);
  const n = +(await text('#moreChip')).match(/\+(\d+)/)[1];
  assert.equal(shown.length + n, 12, 'All and 11 groups: shown or behind +N more');
  await page.click('#moreChip');
  assert.equal(await page.locator('#groupMenu .gm-item').count(), n);
  await page.click('#groupMenu .gm-item >> text=Last one here');
  await page.waitForSelector('#groupBar .chip.on:not(.out)');
  assert.match(await text('#groupBar .chip.on'), /^Last one here/, 'the chosen one is always among the chips shown');
  // the pick bar floats at the bottom centre
  await page.locator('.card[data-filename="k1"]').click({ modifiers: ['Meta'] });
  const pick = await page.locator('#pickBar').boundingBox();
  assert.ok(pick.y > row.y + row.height + 100, 'below the row, at the bottom');
  assert.ok(Math.abs(pick.x + pick.width / 2 - 640) < 4, 'centred');
  assert.equal(await text('#pickCount'), '1 picked');
  await page.keyboard.press('Escape');
  // chosen in Film: shown in Curate too
  await film();
  await page.selectOption('#filmGroup', { label: 'Night city reflections (2)' });
  await curate();
  assert.match(await text('#groupBar .chip.on:not(.out)'), /^Night city reflections/);
  await shot('26-groups-many');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('groups: chips for All, yours and the automatic looks; pick cards, make a group, the film plays just the group; undo', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  const chips = async () => page.locator('#groupBar .chip:not(.chip-overflow)').evaluateAll(b => b.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(await chips(), ['All 3'], 'your groups as chips');
  assert.match(await page.locator('#autoMenus').textContent(), /Auto\s*Look\s*1/, 'automatic groups (once they have two images) in the Auto menus');
  await page.click('#auto-look');
  assert.deepEqual(await page.locator('#groupMenu .gm-item').allTextContents(), ['Warm2']);
  await page.click('#groupMenu .gm-item[data-key="look:warm"]');
  assert.match(await text('#auto-look'), /^Look: Warm\s*2$/, 'the chosen automatic group shows in its button');
  assert.deepEqual(await names(), ['k2', 'k3'], 'the grid shows the group');
  await film();
  assert.equal(await page.locator('#filmstrip button').count(), 2, 'and so does the film');
  await curate();
  await page.click('#autoMenus .auto-x');                                          // × clears it: All again
  await page.waitForSelector('#groupBar .chip.on[data-key="all"]');
  // pick two with Cmd-click, make a group of them
  const rowBox = () => page.locator('#groupRow').evaluate(r => { const b = r.getBoundingClientRect(), c = r.querySelector('.chip').getBoundingClientRect(); return [b.height, c.top]; });
  const before = await rowBox();
  await page.locator('.card[data-filename="k1"]').click({ modifiers: ['Meta'] });
  await page.locator('.card[data-filename="k3"]').click({ modifiers: ['Meta'] });
  assert.equal(await text('#pickCount'), '2 picked');
  assert.deepEqual(await rowBox(), before, 'the pick bar does not move the chips');
  await page.click('#addToGroupBtn');                                             // no group yet: the name field at once
  await page.fill('#groupNameInput', 'Night');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#groupBar .chip.on.own');
  assert.match(await text('#groupBar .chip.on'), /^Night\s*2$/);
  assert.deepEqual(await names(), ['k1', 'k3'], 'the new group is shown');
  assert.equal(await page.locator('#pickBar').isVisible(), false, 'the picks are cleared');
  await shot('26-groups');
  // the export is the group's
  await film();
  await page.click('#exportBtn'); await page.waitForSelector('#exportDock[data-state="ready"]');
  assert.deepEqual(api.state.calls.filter(c => c.path === '/api/export-video').pop().body.files, ['k1', 'k3']);
  await curate();
  // take one out, rename, undo, delete and undo
  await page.locator('.card[data-filename="k3"]').click({ modifiers: ['Meta'] });
  await page.click('#removeFromGroupBtn');
  await page.waitForFunction(() => document.querySelectorAll('.card[data-filename]').length === 1);
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => document.querySelectorAll('.card[data-filename]').length === 2);
  await page.click('#groupMenuBtn');
  await page.fill('#groupNameInput', 'Night chrome'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Night chrome/.test(document.querySelector('#groupBar .chip.on').textContent));
  await page.click('#groupMenuBtn');
  await page.click('.gm-item.danger-text');
  await page.waitForFunction(() => document.querySelector('#groupBar .chip.on').dataset.key === 'all');
  assert.equal(await page.locator('.card[data-filename]').count(), 3, 'deleting a group keeps the images');
  await page.click('#toast button');                                              // Undo
  await page.waitForSelector('#groupBar .chip.own');
  // Cmd+A picks every card shown, Esc clears
  await page.click('#groupBar .chip[data-key="all"]');
  await page.keyboard.press('Meta+a');
  assert.equal(await text('#pickCount'), '3 picked');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#pickBar').isVisible(), false);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('Trail in the page: while playing, the previous image shows faintly just after each cut, and the export is asked for it', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await film();
  await tempo(60);
  await mult('2');
  await page.fill('#trailRange', '50'); await page.locator('#trailRange').dispatchEvent('input');
  assert.equal(await text('#trailVal'), '50%');
  await page.click('#playBtn');
  const seen = await page.evaluate(() => new Promise(res => { const g = document.getElementById('stageGhost'), o = []; let n = 0; const loop = () => { o.push(parseFloat(g.style.opacity) || 0); if (++n < 150) requestAnimationFrame(loop); else res(o); }; requestAnimationFrame(loop); }));
  await page.click('#playBtn');
  assert.ok(Math.max(...seen) > 0.3 && Math.max(...seen) <= 0.5, `it shows (${Math.max(...seen)})`);
  assert.ok(seen.filter(o => o === 0).length > seen.length / 2, 'and only for a few frames after each cut');
  assert.equal(await page.locator('#stageGhost').evaluate(e => getComputedStyle(e).opacity), '0', 'paused: no trail');
  await page.click('#exportBtn'); await page.waitForSelector('#exportDock[data-state="ready"]');
  assert.equal(api.state.calls.filter(c => c.path === '/api/export-video').pop().body.trail, 0.5);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('Film: no Trash button; the group is chosen from a dropdown above the film strip, the same choice as the chips in Curate', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await film();
  assert.equal(await page.locator('#trashCurBtn').count(), 0);
  assert.equal(await page.locator('.csel[data-for="filmGroup"] .csel-face').textContent(), 'All (3)');
  await page.click('.csel[data-for="filmGroup"]');
  assert.deepEqual(await page.locator('#cselMenu .csel-item').allTextContents(), ['All (3)', 'Warm (2)']);
  assert.equal(await page.locator('#cselMenu .csel-group').textContent(), 'Look', 'your groups, then Look, then Territory, as in Curate');
  await page.locator('#cselMenu .csel-item', { hasText: 'Warm' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#filmstrip button').length === 2);
  await shot('27-film-group');
  await curate();
  assert.match(await text('#auto-look'), /^Look: Warm/, 'the same choice in Curate');
  await page.click('#autoMenus .auto-x');
  await film();
  assert.equal(await page.locator('.csel[data-for="filmGroup"] .csel-face').textContent(), 'All (3)');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('a dark mark shows as a light silhouette in the top bar and the project menu; a light one as it is', { skip }, async () => {
  let ctx = await fresh({ width: 1512, height: 945 });
  await page.waitForFunction(() => document.getElementById('projectMark').complete);
  assert.equal(await page.locator('#projectMark.mark-dark').count(), 0, 'DEMO\'s cream mark as it is');
  await ctx.close();
  api.state.markColour = '#111111';
  ctx = await fresh({ width: 1512, height: 945, setup: st => { st.markColour = '#111111'; } });
  await page.waitForSelector('#projectMark.mark-dark');
  assert.match(await page.evaluate(() => getComputedStyle(document.getElementById('projectMark')).filter), /invert/);
  await page.click('#projectBtn');
  await page.waitForSelector('#projectMenu .gm-item img.mark-dark');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the project menu in a real browser: Import project… opens the file chooser, every item runs without an error (a handler calling an unshared function broke Import)', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await page.click('#projectBtn');
  await page.waitForSelector('#projectMenu:not([hidden]) .gm-item');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 3000 }), page.locator('#projectMenu .gm-item', { hasText: 'Import project…' }).click()]);
  assert.ok(chooser, 'the file chooser opens');
  assert.equal(await page.locator('#projectMenu').isVisible(), false, 'and the menu closes');
  await page.click('#projectBtn');
  await page.locator('#projectMenu .gm-item', { hasText: 'New project…' }).click();
  await page.locator('.project-form button', { hasText: 'Cancel' }).click();
  await page.click('#projectBtn');
  await page.locator('#projectMenu .gm-item', { hasText: 'Project settings…' }).click();
  await page.locator('.project-form button', { hasText: 'Cancel' }).click();
  await film();
  await page.locator('label:has(#bpmLock)').click().catch(() => page.locator('#bpmLock').check({ force: true }));
  await page.waitForTimeout(100);
  assert.deepEqual(consoleErrors, [], 'no handler fails (the tempo lock called an unshared saveSettings too)');
  await ctx.close();
});

test('the curve handle stays under the pointer while it is dragged, on a film that speeds up and on one that slows down (it slid sideways)', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945, setup: st => { for (let i = 4; i <= 24; i++) st.plates.push({ ...st.plates[0], filename: `k${i}`, url: st.plates[0].url, title: `K${i}` }); st.sequences[0].order.push(...Array.from({ length: 21 }, (_, i) => `k${i + 4}`)); } });
  await film();
  const lane = await page.locator('#rsSpeed').boundingBox();
  const report = [];
  for (const [label, bpm, from, to, endMs] of [['slows down', 300, 0.2, 0.8, 900], ['speeds up', 60, 0.15, 0.7, 120], ['late and short', 200, 0.6, 0.95, 1200]]) {
    await page.evaluate(([bpm, from, to, endMs]) => {
      const set = (id, v) => { document.getElementById(id).value = String(v); };
      set('bpmInput', bpm); set('rhythmSelect', 'variable'); set('changeFrom', from); set('changeTo', to); set('endMsRange', endMs); set('curveVal', 0);
      updateTempo(); updateRhythm();
    }, [bpm, from, to, endMs]);
    const h = await page.locator('#rsCurveHandle').boundingBox();
    const x0 = h.x + h.width / 2, y0 = h.y + h.height / 2;
    await page.mouse.move(x0, y0); await page.mouse.down();
    const s = await page.locator('#rsStart').boundingBox(), e = await page.locator('#rsEnd').boundingBox();
    const ys = s.y + s.height / 2, ye = e.y + e.height / 2;
    for (const f of [0.15, 0.3, 0.45, 0.2, 0.05]) {                   // towards the Start speed (the change waits) and back
      const py = ye + (ys - ye) * (1 - f) * 0.5 + (ys - ye) * f;        // between the straight middle and the Start's height
      await page.mouse.move(x0 + 3, py, { steps: 3 });
      const b = await page.locator('#rsCurveHandle').boundingBox(), hx = b.x + b.width / 2, hy = b.y + b.height / 2;
      const c = +(await page.evaluate(() => document.getElementById('curveVal').value));
      const atLimit = c <= 0.001 || c >= 0.999;                          // past what the curve can do, it stops on the curve
      if (Math.abs(hx - x0) > 4 || (!atLimit && Math.abs(hy - py) > 4)) report.push(`${label} f=${f}: handle at (${(hx - x0).toFixed(0)}, ${(hy - py).toFixed(0)}) from the pointer`);
    }
    await page.mouse.up();
  }
  assert.deepEqual(report, []);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('Delete project…: asked first (Cancel keeps it), then the project goes and the next one opens; none left, the empty page', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await page.click('#projectBtn');
  await page.locator('#projectMenu .gm-item', { hasText: 'Delete project…' }).click();
  assert.equal(await page.locator('#confirmModal').isVisible(), true);
  assert.match(await text('#confirmTitle'), /^Delete Demo\?$/);
  assert.match(await text('#confirmBody'), /^Its 7 images, groups and snapshots go to the Trash/, 'every image it has, the Trash\'s too');
  await page.locator('#confirmModal button', { hasText: 'Cancel' }).click();
  assert.equal(api.state.deleted, undefined, 'Cancel deletes nothing');
  await page.click('#projectBtn');
  await page.locator('#projectMenu .gm-item', { hasText: 'Delete project…' }).click();
  await page.click('#confirmYes');
  await page.waitForFunction(() => document.getElementById('projectName').textContent === 'No project', null, { timeout: 10000 });
  assert.equal(api.state.deleted, 'demo');
  await page.click('#projectBtn');
  await page.waitForSelector('#projectMenu:not([hidden]) .gm-item');
  assert.equal(await page.locator('#projectMenu .gm-item', { hasText: 'Delete project…' }).count(), 0, 'nothing to delete without a project');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('while images are made, the other projects and New / Import / Delete wait in the menu, and it says why; after, they are back', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945, delays: { invent: 1500 } });
  api.state.projects.push({ ...api.state.projects[0], slug: 'nike', name: 'Nike', fixed: false, round: false });
  await page.click('#generateBtn');
  await page.waitForSelector('#statusText:not([data-idle="1"])');
  await page.click('#projectBtn');
  await page.waitForSelector('#projectMenu:not([hidden]) .gm-item');
  assert.match(await text('#projectMenu .gm-note'), /^Images are being made: other projects wait until it ends\.$/);
  assert.equal(await page.locator('#projectMenu .gm-item[data-slug="nike"]').isDisabled(), true);
  assert.equal(await page.locator('#projectMenu .gm-item[data-slug="demo"]').isDisabled(), false, 'this one stays itself');
  for (const t of ['New project…', 'Import project…', 'Delete project…']) assert.equal(await page.locator('#projectMenu .gm-item', { hasText: t }).isDisabled(), true, t);
  assert.equal(await page.locator('#projectMenu .gm-item', { hasText: 'Export project…' }).isDisabled(), false, 'a copy can still be made');
  await page.keyboard.press('Escape'); await page.mouse.click(700, 500);
  await page.waitForFunction(() => /Done/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  await page.click('#projectBtn');
  await page.waitForSelector('#projectMenu:not([hidden]) .gm-item');
  assert.equal(await page.locator('#projectMenu .gm-note').count(), 0);
  assert.equal(await page.locator('#projectMenu .gm-item[data-slug="nike"]').isDisabled(), false, 'back once it ends');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('guards: another window opens another project → this page shows it; New project (⌘N) and Empty trash wait for a running job; the server is told a job runs', { skip }, async () => {
  let ctx = await fresh({ width: 1512, height: 945, delays: { invent: 1500 } });
  api.state.projects.push({ ...api.state.projects[0], slug: 'nike', name: 'Nike', fixed: false, round: false });
  await page.click('#generateBtn');
  await page.waitForSelector('#statusText:not([data-idle="1"])');
  await page.waitForFunction(() => true); await page.waitForTimeout(150);
  assert.equal(api.state.lease, 30, 'the page holds the server busy for the whole batch');
  await page.evaluate(() => openProjectForm('new'));                                   // as the Mac menu's ⌘N does
  assert.equal(await page.locator('#projectModal').isVisible(), false, 'no new project mid-batch');
  assert.match(await text('#toast'), /Wait until the running job ends/);
  await page.waitForFunction(() => /Done/.test(document.getElementById('statusText').textContent), null, { timeout: 15000 });
  await page.waitForTimeout(150);
  assert.equal(api.state.lease, 0, 'and lets go when it ends');
  api.state.project = 'nike';                                                           // another window switched
  await page.evaluate(() => refreshLibrary(true));
  await page.waitForFunction(() => document.getElementById('projectName').textContent === 'Nike', null, { timeout: 10000 });
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});
