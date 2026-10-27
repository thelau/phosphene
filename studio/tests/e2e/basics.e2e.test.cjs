const { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, film, curate, choose, skip, api, page, consoleErrors, addAi, tempo, mult, change, noChange } = require('./harness.cjs');
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

test('export: preview is untouched, the panel shows the work, then Downloaded with Export again and Download again', { skip }, async () => {
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
  await link.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#exportDock').getAttribute('data-state'), 'ready');
  assert.equal(await link.getAttribute('download'), 'Demo-test.mp4');
  assert.equal(await link.getAttribute('href'), '/outputs/Demo-test.mp4');
  assert.equal(await text('#exportFile'), 'Demo-test.mp4');
  assert.equal(await page.locator('#stageImg').getAttribute('src'), before);
  assert.equal(await page.locator('#stageCanvas').isVisible(), true, 'the stage draws with WebGL');
  const body = api.state.calls.find(c => c.path === '/api/export-video').body;
  assert.equal('total_seconds' in body, false);
  await shot('09-export');
  await page.click('#exportAgainBtn');                                            // a second export straight from the ready panel
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
  await page.click('#exportAgainBtn');
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
  await page.click('#directionInput');
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

test('many groups: the chips scroll sideways with a fade on the side that has more, never under the pick bar; a group chosen in Film scrolls into view', { skip }, async () => {
  const ctx = await fresh({ width: 1280, height: 720 });
  await curate();
  await page.evaluate(async () => {
    for (const name of ['Night city reflections', 'Paper and print', 'Brushed metal', 'Studio still lifes', 'Water and glass', 'Concrete and stone', 'Grain and strata', 'Editorial print', 'Screens and interfaces', 'Out of home', 'Last one here'])
      await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', name, files: ['k1', 'k2'] }) });
  });
  await page.click('#refreshBtn');
  await page.waitForFunction(() => document.querySelectorAll('#groupBar .chip').length >= 9);
  const bar = () => page.locator('#groupBar').evaluate(b => ({ l: b.classList.contains('fade-l'), r: b.classList.contains('fade-r'), right: b.getBoundingClientRect().right, scrolls: b.scrollWidth > b.clientWidth }));
  let b = await bar();
  assert.ok(b.scrolls && b.r && !b.l, `more on the right only: ${JSON.stringify(b)}`);
  await page.locator('.card[data-filename="k1"]').click({ modifiers: ['Meta'] });
  const pickLeft = await page.locator('#pickBar').evaluate(p => p.getBoundingClientRect().left);
  b = await bar();
  assert.ok(b.right <= pickLeft, `the chips end before the pick bar: ${b.right} vs ${pickLeft}`);
  await page.locator('#groupBar').hover();
  await page.mouse.wheel(0, 4000);                                                 // a plain mouse wheel scrolls the chips
  await page.waitForFunction(() => { const x = document.getElementById('groupBar'); return x.classList.contains('fade-l') && !x.classList.contains('fade-r'); });
  await page.keyboard.press('Escape');
  await page.locator('#groupBar').evaluate(x => { x.scrollLeft = 0; });
  await film();
  await page.selectOption('#filmGroup', { label: 'Last one here (2)' });
  await curate();
  const inView = await page.locator('#groupBar .chip.on').evaluate(c => { const r = c.getBoundingClientRect(), p = c.parentElement.getBoundingClientRect(); return r.left >= p.left + 40 && r.right <= p.right - 40; });
  assert.equal(inView, true, 'the chosen chip is in view, clear of the fades');
  await shot('26-groups-scroll');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the pick circle: hidden until hover, a click picks without opening the image, every card shows it while picking, a second click unpicks', { skip }, async () => {
  const ctx = await fresh();
  await curate();
  const card = n => page.locator('.card').nth(n), pick = n => card(n).locator('.card-pick');
  const shown = async n => +(await pick(n).evaluate(e => getComputedStyle(e).opacity));
  await page.mouse.move(5, 5);
  assert.equal(await shown(0), 0, 'out of the way at rest');
  await card(0).hover();
  assert.equal(await shown(0), 1, 'on hover');
  const src = await page.locator('#stageImg').getAttribute('src');
  await pick(0).click();
  assert.equal(await text('#pickCount'), '1 selected');
  assert.equal(await card(0).evaluate(e => e.classList.contains('sel')), true);
  assert.equal(await page.locator('#stageImg').getAttribute('src'), src, 'picking does not open the image');
  await page.mouse.move(5, 5);
  assert.equal(await shown(1), 1, 'while picking, every card shows its circle');
  await shot('27-pick-circle');
  await card(1).hover(); await pick(1).click();
  assert.equal(await text('#pickCount'), '2 selected');
  await pick(0).click();
  assert.equal(await text('#pickCount'), '1 selected', 'a second click unpicks');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#pickBar').isVisible(), false);
  await page.mouse.move(5, 5);
  assert.equal(await shown(1), 0, 'and they hide again');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('snapshots: ＋ Snapshot keeps the film under a name it picks, switching brings back group and settings, Replace asks first, rename after; Film only', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await curate();
  assert.equal(await page.locator('#editBtn').isVisible(), false, 'snapshots are a Film thing');
  await film();
  assert.equal(await text('#editName'), 'No snapshot yet');
  await tempo(120);
  await page.click('#editSaveBtn');                                                 // no name asked: it names itself, two words
  await page.waitForFunction(() => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(document.getElementById('editName').textContent));
  const first = await text('#editName');
  // a second one: another group and tempo, with ⌘S
  await page.selectOption('#filmGroup', 'look:warm');
  await tempo(150);
  assert.equal(await page.locator('#editDirty').isVisible(), true, 'changed since the snapshot: a dot');
  await page.locator('#stage').click();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(n => { const t = document.getElementById('editName').textContent; return t !== n && /^[A-Z][a-z]+ (Ember|Copper|Saffron|Magma|Rust|Amber)$/.test(t); }, first);   // a warm group: a warm word
  assert.equal(await page.locator('#editDirty').isVisible(), false);
  // switch back: the group and the tempo come back
  await page.click('#editBtn');
  await page.locator('#editMenu .gm-item', { hasText: first }).click();
  assert.equal(await page.locator('#filmGroup').inputValue(), 'all');
  assert.equal(await page.locator('#bpmInput').inputValue(), '120');
  // Replace: only when changed, and asked first
  await page.click('#editBtn');
  assert.equal(await page.locator('#editReplaceBtn').isDisabled(), true, 'nothing changed: nothing to replace');
  await page.click('#editBtn');
  await tempo(90);
  await page.click('#editBtn'); await page.click('#editReplaceBtn');
  assert.equal(await text('#confirmTitle'), `Replace “${first}”?`);
  await page.click('#confirmModal button:not(#confirmYes)');                         // No: nothing replaced
  let saved = await page.evaluate(async n => (await (await fetch('/api/state')).json()).edits.find(e => e.name === n), first);
  assert.equal(saved.settings.bpmInput, '120');
  await page.click('#editBtn'); await page.click('#editReplaceBtn'); await page.click('#confirmYes');
  await page.waitForFunction(() => document.getElementById('editDirty').hidden);
  saved = await page.evaluate(async n => (await (await fetch('/api/state')).json()).edits.find(e => e.name === n), first);
  assert.equal(saved.settings.bpmInput, '90', 'replaced after Yes');
  // rename afterwards
  await page.click('#editBtn');
  await page.locator('#editMenu .gm-item', { hasText: 'Rename' }).click();
  await page.fill('#editNameInput', 'Slow all');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('editName').textContent === 'Slow all');
  // the export carries its name
  let sent = null;
  page.on('request', r => { if (r.url().endsWith('/api/export-video')) sent = JSON.parse(r.postData()); });
  await page.click('#exportBtn');
  await page.waitForFunction(() => document.getElementById('exportDock').dataset.state === 'ready', null, { timeout: 15000 });
  assert.equal(sent.edit, 'Slow all');
  await page.click('#editBtn');
  await shot('28-snapshots');
  // delete, then undo
  await page.locator('#editMenu .gm-item', { hasText: 'Delete' }).click();
  assert.equal(await text('#confirmTitle'), 'Delete “Slow all”?', 'asked first');
  await page.click('#confirmModal button:not(#confirmYes)');
  assert.equal(await text('#editName'), 'Slow all', 'Cancel keeps it');
  await page.click('#editBtn');
  await page.locator('#editMenu .gm-item', { hasText: 'Delete' }).click();
  await page.click('#confirmYes');
  await page.waitForFunction(() => document.getElementById('editName').textContent === 'No snapshot selected');   // another one is still there
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => document.getElementById('editName').textContent === 'Slow all');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});
test('projects: the header shows the brand; New project takes a mark (drawn to a PNG here), places it, makes it the open project; the logo target follows', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  assert.equal(await text('#projectName'), 'Demo');
  await page.click('#projectBtn');
  await page.waitForSelector('#projectMenu:not([hidden])');
  assert.deepEqual(await page.locator('#projectMenu .gm-item').allTextContents(), ['Demo', 'New project…', 'Project settings…', 'Export project…', 'Import project…']);
  assert.equal(await page.locator('#projectMenu .gm-item.on').textContent(), 'Demo');
  await page.locator('#projectMenu .gm-item', { hasText: 'Project settings' }).click();       // DEMO: name, brand and colours; its mark, place and words locked
  assert.equal(await page.locator('#projectModal').isVisible(), true);
  for (const id of ['#pfMark', '#pfSize', '#pfX', '#pfY', '#pfShape', '#pfNoun']) assert.equal(await page.locator(id).isDisabled(), true, id);
  assert.equal(await page.locator('#pfName').isDisabled(), false);
  assert.equal(await page.locator('#pfLocked').isVisible(), true);
  await page.fill('#pfBrief', 'Demo, a toolkit');
  await page.click('#pfSave');
  for (let i = 0; i < 50 && !api.state.calls.some(c => c.path === '/api/projects' && c.body && c.body.action === 'update'); i++) await page.waitForTimeout(100);
  await page.waitForSelector('#loader', { state: 'detached' });
  assert.deepEqual(Object.keys(api.state.calls.filter(c => c.path === '/api/projects' && c.body && c.body.action).pop().body).sort(), ['action', 'brief', 'name', 'palette', 'slug'], 'only what DEMO lets change');
  await page.click('#projectBtn');
  await page.locator('#projectMenu .gm-item', { hasText: 'New project' }).click();
  for (const id of ['#pfMark', '#pfSize', '#pfShape']) assert.equal(await page.locator(id).isDisabled(), false, `a new project sets ${id}`);
  assert.equal(await page.locator('#projectModal').isVisible(), true);
  await page.fill('#pfName', 'Night Owl');
  await page.click('#pfSave');
  assert.match(await text('#pfError'), /Choose the mark/, 'a mark is needed');
  const png = await page.evaluate(async () => {                               // a wide mark on a transparent background
    const c = document.createElement('canvas'); c.width = 200; c.height = 100; const x = c.getContext('2d');
    x.fillStyle = '#f0a020'; x.fillRect(10, 20, 120, 60); return c.toDataURL('image/png').split(',')[1];
  });
  await page.setInputFiles('#pfMark', { name: 'owl.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => document.getElementById('pfPreviewMark').getAttribute('src'));
  await page.waitForFunction(() => document.getElementById('pfShape').value === 'horizontal bar mark');
  assert.equal(await page.locator('#pfPalette').inputValue(), '#F0A020 #1A1A1A', 'the mark\'s own colours, then Kimi\'s');
  assert.match(await text('#pfKimi'), /suggestions/);
  await page.fill('#pfSize', '30'); await page.locator('#pfSize').dispatchEvent('input');
  await page.fill('#pfY', '40'); await page.locator('#pfY').dispatchEvent('input');
  assert.equal(await text('#pfSizeVal'), '30%');
  const prev = await page.locator('#pfPreview').boundingBox(), mark = await page.locator('#pfPreviewMark').boundingBox();
  assert.ok(Math.abs(mark.width - prev.width * 0.3) < 2 && Math.abs(mark.y + mark.height / 2 - (prev.y + prev.height * 0.4)) < 2, 'the preview places it at its size and height');
  await page.fill('#pfShape', 'owl wordmark'); await page.fill('#pfNoun', 'owl'); await page.fill('#pfBrief', 'Night Owl, a late bar');   // typed by hand: Kimi never writes over it
  await page.fill('#pfPalette', '#223344 #ff8800 nope'); await page.locator('#pfPalette').dispatchEvent('input');
  assert.equal(await page.locator('#pfSwatches i').count(), 2);
  await shot('32-new-project');
  await page.click('#pfSave');
  await page.waitForFunction(() => document.getElementById('projectName').textContent === 'Night Owl', null, { timeout: 10000 });
  await page.waitForSelector('#loader', { state: 'detached' });
  const sent = api.state.calls.filter(c => c.path === '/api/projects').pop().body;
  assert.deepEqual([sent.action, sent.name, sent.mark_size, sent.mark_y, sent.mark_shape, sent.mark_noun, sent.palette], ['create', 'Night Owl', 30, 40, 'owl wordmark', 'owl', ['#223344', '#ff8800']]);
  assert.match(api.state.markSent, /^data:image\/png;base64,/, 'the mark goes as a PNG');
  assert.deepEqual(await page.evaluate(async u => { const i = new Image(); i.src = u; await i.decode(); return [i.width, i.height]; }, api.state.markSent), [120, 60], 'trimmed to the mark itself');
  assert.equal(await page.locator('.card').count(), 0, 'a new project starts empty');
  const vars = await page.evaluate(() => ['--mark-w', '--mark-y', '--mark-ar', '--mark-r'].map(v => document.documentElement.style.getPropertyValue(v)));
  assert.deepEqual(vars, ['30%', '40%', '0.5', '2px'], 'the logo target takes the mark\'s size, place and proportions: always its box');
  assert.equal(await text('#retLabel'), 'logo · 50%, 40% · 30%');
  await page.click('#projectBtn');
  await page.locator('#projectMenu .gm-item', { hasText: 'Demo' }).click();
  await page.waitForFunction(() => document.getElementById('projectName').textContent === 'Demo', null, { timeout: 10000 });
  await page.waitForSelector('#loader', { state: 'detached' });
  assert.equal(await page.locator('.card').count(), 0, 'switching reloads with the other project');   // (the fake keeps one library)
  await page.click('#projectBtn');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#projectMenu .gm-item', { hasText: 'Export project' }).click()]);
  assert.ok(dl, 'Export project downloads the project file');
  await page.setInputFiles('#pfImport', { name: 'demo.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004 a zip') });
  await page.waitForFunction(() => document.getElementById('projectName').textContent === 'Imported', null, { timeout: 10000 });
  await page.waitForSelector('#loader', { state: 'detached' });
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('Download in Curate: the images shown (All or the group), in their order, as one zip; not in the Trash', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  assert.equal(await page.locator('#downloadBtn').isVisible(), true);
  assert.match(await page.locator('#downloadBtn').getAttribute('title'), /Download the 3 images shown/);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  assert.equal(dl.suggestedFilename(), 'x.zip', 'the browser saves it');
  assert.deepEqual(api.state.zipAsked, { files: ['k1', 'k2', 'k3'], label: 'All' });
  await page.locator('#groupRow button.chip', { hasText: 'Warm' }).first().click();
  await page.waitForFunction(() => /Download the 2 images/.test(document.getElementById('downloadBtn').title));
  await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  assert.deepEqual(api.state.zipAsked, { files: ['k2', 'k3'], label: 'Warm' }, 'just the group, named after it');
  await page.click('#tabTrash');
  await page.waitForSelector('#trashBar:not([hidden])');
  assert.equal(await page.locator('#downloadBtn').isVisible(), false, 'not in the Trash');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('no project (a first launch): the usual page, empty, says where to start; the menu offers New project and Import', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945, empty: true, setup: st => { st.project = null; st.plates = []; } });
  assert.equal(await page.locator('#firstRun').count(), 0, 'no welcome screen over the page');
  assert.equal(await text('#projectName'), 'No project');
  assert.equal(await text('#gridEmpty'), 'No images yet');
  const box = await page.locator('#gridEmpty').boundingBox(), vp = page.viewportSize();
  assert.ok(Math.abs(box.x + box.width / 2 - (vp.width - 0) / 2) < vp.width * 0.2 && box.height > 300, 'in the middle of the page');
  assert.equal(await page.locator('#miniPlayBtn').isDisabled(), true, 'nothing to play');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#playBtn').textContent(), 'Play', 'Space plays nothing either');
  assert.equal(await page.locator('#gridTargetBtn').isDisabled(), true, 'no mark: no logo target');
  await film();
  assert.equal(await page.locator('#reticle').isVisible(), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('filmstrip'), '::after').content), '"No images selected"');
  await curate();
  await page.click('#projectBtn');
  await page.waitForSelector('#projectMenu:not([hidden]) .gm-item');
  assert.equal(await page.locator('#projectMenu').isVisible(), true, 'the menu shows, nothing over it');
  assert.deepEqual(await page.locator('#projectMenu .gm-item').allTextContents(), ['Demo', 'New project…', 'Import project…']);
  await page.keyboard.press('Escape'); await page.mouse.click(700, 500);
  api.state.projects = [];                                                        // nothing to list: no line above New project
  await page.click('#projectBtn');
  await page.waitForSelector('#projectMenu:not([hidden]) .gm-item');
  assert.equal(await page.evaluate(() => document.getElementById('projectMenu').firstElementChild.tagName), 'BUTTON');
  await page.locator('#projectMenu .gm-item', { hasText: 'New project…' }).click();
  assert.equal(await page.locator('#projectModal').isVisible(), true);
  assert.equal(await text('#projectTitle'), 'New project');
  await shot('33-no-project');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the film strip: one thumbnail per image in order, click jumps there; no key trashes from the Film', { skip }, async () => {
  const ctx = await fresh();
  await film();
  assert.equal(await page.locator('#filmstrip button').count(), 3);
  await page.locator('#filmstrip button').nth(2).click();
  assert.match(await page.locator('#stageImg').getAttribute('src'), /k3/);
  assert.equal(await page.locator('#curTitle').count(), 0, 'no image names over the strip while the film plays');
  assert.equal(await page.locator('#filmstrip button.cur').count(), 1);
  assert.match(await text('#timecode'), /cut 3 \/ 3/);
  await page.keyboard.press('Delete');                                            // Film never trashes: images go to the Trash by hand, in Curate
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#filmstrip button').count(), 3);
  assert.equal(await text('#tabSelection'), 'Selection (3)');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the timeline is the rhythm control: drag or type the tempo and the Multiple; click the line to add a change, drag its points and curve, Delete removes it', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await film();
  await choose('musicSelect', 'on');
  const val = id => page.evaluate(id => document.getElementById(id).value, id);
  assert.equal(await text('#tempoVal'), '136 BPM'); assert.equal(await text('#tempoMs'), '441 ms'); assert.equal(await text('#multVal'), '×4');
  // the tempo: drag up is faster, arrows step, double-click to type (BPM or ms), Esc keeps it
  const tf = await page.locator('#tempoField').boundingBox();
  await page.mouse.move(tf.x + tf.width / 2, tf.y + tf.height / 2); await page.mouse.down();
  await page.mouse.move(tf.x + tf.width / 2, tf.y - 60, { steps: 6 });
  assert.ok(await page.locator('#tempoField.dragging').count(), 'it shows the drag');
  await page.mouse.up();
  const dragged = +(await val('bpmInput'));
  assert.ok(dragged > 136 * 1.2, `dragging up speeds it up: ${dragged}`);
  await page.keyboard.press('ArrowDown');
  assert.equal(+(await val('bpmInput')), dragged - 1, 'an arrow steps it');
  await page.dblclick('#tempoField');
  await page.keyboard.press('Meta+a'); await page.keyboard.type('120'); await page.keyboard.press('Enter');
  assert.equal(await val('bpmInput'), '120'); assert.equal(await text('#tempoVal'), '120 BPM');
  await page.dblclick('#tempoField'); await page.keyboard.press('Meta+a'); await page.keyboard.type('600 ms'); await page.keyboard.press('Enter');
  assert.equal(await val('bpmInput'), '100', 'a length in ms works too');
  await page.dblclick('#tempoField'); await page.keyboard.type('999'); await page.keyboard.press('Escape');
  assert.equal(await val('bpmInput'), '100', 'Esc keeps it');
  // the Multiple steps through its values
  const mf = await page.locator('#multField').boundingBox();
  await page.mouse.move(mf.x + mf.width / 2, mf.y + mf.height / 2); await page.mouse.down();
  await page.mouse.move(mf.x + mf.width / 2, mf.y + mf.height / 2 - 15, { steps: 3 }); await page.mouse.up();
  assert.equal(await text('#multVal'), '×6', 'one step up');
  await page.dblclick('#multField'); await page.keyboard.press('Meta+a'); await page.keyboard.type('2'); await page.keyboard.press('Enter');
  assert.equal(await val('multSelect'), '2');
  // the speed lane: near the line a click adds a change; elsewhere a click does nothing to the film
  const lane = await page.locator('#rsSpeed').boundingBox();
  const flatY = await page.evaluate(() => parseFloat(document.getElementById('rsCurve').getAttribute('points').split(' ')[0].split(',')[1]));
  await page.mouse.move(lane.x + lane.width * 0.3, lane.y + 4);
  assert.equal(await page.locator('#rsHover').isVisible(), false, 'away from the line: no offer');
  await page.mouse.click(lane.x + lane.width * 0.3, lane.y + 4);
  assert.equal(await val('rhythmSelect'), 'flat', 'a click away from the line adds nothing');
  await page.mouse.move(lane.x + lane.width * 0.4, lane.y + (lane.height * flatY) / 100 + 3);
  assert.equal(await page.locator('#rsHover').isVisible(), true, 'near the line: "Click to add a change"');
  await page.mouse.click(lane.x + lane.width * 0.4, lane.y + (lane.height * flatY) / 100 + 3);
  assert.equal(await val('rhythmSelect'), 'variable');
  for (const id of ['#rsStart', '#rsEnd', '#rsCurveHandle', '#rsBand', '#rsRemove']) assert.ok(await page.locator(id).isVisible(), id);
  assert.match(await text('#rsStartL'), /^Start 600 ms · pictures 300$/, 'the music\'s value, the picture\'s beside it');
  assert.ok(Math.abs(+(await val('changeFrom')) - 0.4) < 0.08, `the change starts where the click was: ${await val('changeFrom')}`);
  // drag End later and slower; the tooltip says where and how fast
  let e = await page.locator('#rsEnd').boundingBox();
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2); await page.mouse.down();
  await page.mouse.move(lane.x + lane.width * 0.85, lane.y + lane.height * 0.9, { steps: 8 });
  assert.match(await text('#rsTip'), /^End · [\d.]+ s\s*\d+ ms · \d+ BPM\s*pictures \d+ ms$/);
  await page.mouse.up();
  assert.equal(await page.locator('#rsTip').isVisible(), false);
  const end = +(await val('endMsRange'));
  assert.ok(Math.abs(end - 1068) < 35, `End dragged 90% down the log scale is ~1068 ms: ${end}`);   // a pixel's rounding is ~2% on a log scale
  const endBox = await page.locator('#rsEnd').boundingBox();
  assert.ok(Math.abs(endBox.x + endBox.width / 2 - (lane.x + lane.width * 0.85)) < 12, 'the point sits under the pointer');
  // drag Start up: faster, and it is the tempo
  e = await page.locator('#rsStart').boundingBox();
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2); await page.mouse.down();
  await page.mouse.move(e.x + e.width / 2, lane.y + lane.height * 0.15, { steps: 6 }); await page.mouse.up();
  const bpm = +(await val('bpmInput'));
  assert.ok(bpm > 300, `Start up is faster: ${bpm} BPM`); assert.equal(await text('#tempoVal'), `${bpm} BPM`, 'the Start point is the tempo');
  // the curve handle
  const c0 = +(await val('curveVal'));
  e = await page.locator('#rsCurveHandle').boundingBox();
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2); await page.mouse.down();
  await page.mouse.move(e.x + e.width / 2, e.y - 14, { steps: 4 });
  assert.match(await text('#rsTip'), /^Curve · /); assert.equal(await page.locator('#rsLinear').isVisible(), true, 'the even change shows as a dashed line while shaping');
  await page.mouse.up();
  assert.notEqual(+(await val('curveVal')), c0, 'the curve changed');
  await shot('31-timeline-change');
  // the timeline drives the picture and the music
  const lens = await page.evaluate(() => { const x = document.getElementById('rsTicks').getAttribute('d').match(/M[\d.]+/g).map(m => +m.slice(1)); return [x[1] - x[0], 1000 - x[x.length - 1]]; });   // the first cut, and the last (it ends at the film's end)
  assert.ok(lens[1] > lens[0] * 3, `the cuts slow down: ${lens}`);
  // a click on the cuts or the ruler jumps; the speed lane never does
  await page.click('#rsCuts', { position: { x: lane.width * 0.5, y: 10 } });
  const head = () => page.evaluate(() => parseFloat(document.getElementById('rsPlayhead').style.left));
  const at = await head();
  assert.ok(Math.abs(at - 50) < 3, `the cut ticks jump: ${at}%`);
  await page.mouse.click(lane.x + lane.width * 0.7, lane.y + 3);
  assert.equal(await head(), at, 'the speed lane does not move the playhead');
  assert.equal(await page.locator('#rsRemove').isVisible(), false, 'it clears the selection');
  await page.click('#rsAxis', { position: { x: 5, y: 9 } });
  assert.ok(await head() < 5, 'the ruler jumps');
  // select a point, Delete removes the change; Undo brings it back
  await page.click('#rsEnd');
  assert.equal(await page.locator('#rsEnd.sel').count(), 1);
  await page.keyboard.press('Delete');
  assert.equal(await val('rhythmSelect'), 'flat');
  assert.equal(await page.locator('#filmstrip button').count(), 3, 'Delete never touches an image');
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => document.getElementById('rhythmSelect').value === 'variable');
  // the export carries the speeds for its name
  await page.click('#exportBtn');
  await page.waitForSelector('#downloadLink:not([hidden])');
  const body = api.state.calls.filter(c => c.path === '/api/export-video').pop().body;
  assert.deepEqual([body.rhythm, body.bpm, body.end_ms], ['variable', bpm, +(await val('endMsRange'))]);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('synthesized music: the drone plays live in the page, settings swap it at once, export renders it in the page and sends it', { skip }, async () => {
  const ctx = await fresh();
  await film();
  assert.match(await text('#rhythmInfo'), /^3 images · \d+ s · pictures \d+ ms$/);
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

test('the timeline in the page: ticks, band, beats and axis follow the settings; labels stay inside; the playhead moves; old settings come back as a change', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await film();
  const ticks = async () => (await page.locator('#rsTicks').getAttribute('d')).split('M').length - 1;
  assert.equal(await ticks(), 3, 'one tick per picture cut');
  assert.equal(await page.locator('#rsBand').isVisible(), false, 'one speed: no band');
  await choose('invertSelect', 'mono');
  assert.equal(await ticks(), 6, 'each image and its inverted copy');
  await mult('1');
  await change({ from: 0.6, to: 1, end: 600, start: 100 });                    // a landing over the last music cuts
  assert.equal(await page.locator('#rsBand').isVisible(), true);
  assert.equal(await text('#rsEndL'), 'End 600 ms', 'no Multiple: no picture value');
  const body0 = await page.locator('#rsBody').boundingBox();
  await page.click('#rsEnd');                                                  // selected at the film's end: the × stays inside
  for (const id of ['#rsStartL', '#rsEndL', '#rsRemove']) {
    const lab = await page.locator(id).boundingBox();
    assert.ok(lab.x >= body0.x - 1 && lab.x + lab.width <= body0.x + body0.width + 1, `${id} stays inside the timeline`);
  }
  await shot('19-rhythm-landing');
  const band = await page.locator('#rsBand').boundingBox();
  assert.ok(band.x > body0.x + body0.width / 4 && Math.abs(band.x + band.width - (body0.x + body0.width)) < 2, 'the landing sits at the end, in time');
  assert.match(await text('#rhythmInfo'), /^3 images · .* · pictures 100→\d+ ms$/, 'the summary counts in pictures: the first and last picture cut');
  await page.click('#rsCuts', { position: { x: body0.width * 0.75, y: 10 } });
  const at = await page.evaluate(() => parseFloat(document.getElementById('rsPlayhead').style.left));
  assert.ok(Math.abs(at - 75) < 1, `playhead at ${at}%`);
  await page.click('#playBtn');
  await page.waitForTimeout(500);
  assert.notEqual(await page.evaluate(() => parseFloat(document.getElementById('rsPlayhead').style.left)), at, 'the playhead moves while playing');
  await page.click('#playBtn');
  assert.equal((await page.locator('#rsAxis span').allTextContents())[0], '0 s');
  // settings saved before the timeline (Variable: Start, End, Change over, Change at) open as the same film
  await page.evaluate(() => localStorage.setItem('studioSettings', JSON.stringify({ rhythmSelect: 'variable', startMsRange: '100', endMsRange: '600', rampRange: '2', atSelect: 'end', multSelect: '1' })));
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  assert.equal(await page.locator('#rhythmSelect').inputValue(), 'variable');
  assert.equal(await page.locator('#bpmInput').inputValue(), '600', 'Start 100 ms is the tempo, 600 BPM');
  assert.equal(await page.locator('#endMsRange').inputValue(), '600');
  assert.ok(+(await page.locator('#changeFrom').inputValue()) > 0.3 && (await page.locator('#changeTo').inputValue()) === '1', 'a landing: the change at the end');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the rhythm strip stays readable from 1 image to 300 at one frame a cut', { skip }, async () => {
  const ctx = await fresh({ width: 1280, height: 720 });
  for (let i = 0; i < 300; i++) { const f = `q${i}`; api.state.plates.push({ ...api.state.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg` }); api.state.sequences[0].order.push(f); }
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  await film();
  await tempo(450);
  await mult('4');
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
  await tempo(450);
  await mult('4');
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

test('keys in the page: arrows step, F fills the screen with the preview and F leaves', { skip }, async () => {
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
  assert.equal(await page.locator('#keysPanel dt:not(.app-only)').count(), 13);
  assert.equal(await page.locator('#keysPanel dt.app-only').isVisible(), false, 'the app menu\'s shortcuts only in the app');
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
  // the Chord, high in the Sound: opens downward
  await page.click('#soundTabTone');
  await page.click('.csel[data-for="chordSelect"]');
  await page.waitForSelector('#cselMenu:not([hidden])');
  assert.equal(await page.locator('#cselMenu').getAttribute('data-side'), 'down');
  assert.deepEqual(await page.locator('#cselMenu .csel-item').allTextContents(), ['Dark cluster', 'Open fifth', 'Minor', 'Suspended']);
  assert.equal(await page.locator('#cselMenu [aria-selected="true"]').textContent(), 'Dark cluster');
  await shot('24-dropdown');
  await page.locator('#cselMenu .csel-item', { hasText: 'Minor' }).first().click();
  assert.equal(await page.locator('#chordSelect').inputValue(), '2', 'the real select took the value');
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
  await page.evaluate(() => { const c = document.getElementById('chordSelect'); c.value = '0'; c.dispatchEvent(new Event('change')); });   // from the first chord (picked above)
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
  // after a pick, by mouse or keyboard, the keys work again (the dropdown let go of the focus)
  await page.click('.csel[data-for="chordSelect"]');
  await page.locator('#cselMenu .csel-item', { hasText: 'Suspended' }).first().click();
  await page.keyboard.press(' ');
  assert.equal(await page.locator('#playBtn').getAttribute('aria-label'), 'Pause', 'Space plays right after a pick');
  await page.keyboard.press(' ');
  await page.click('.csel[data-for="characterSelect"]');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#characterSelect').inputValue(), 'landing');
  const seed = await page.locator('#seedVal').inputValue();
  await page.keyboard.press('s');
  assert.notEqual(await page.locator('#seedVal').inputValue(), seed, 'S works right after a keyboard pick');
  await page.click('.csel[data-for="chordSelect"]'); await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  assert.equal(await page.locator('#reticle').evaluate(e => e.classList.contains('visible')), true, 'and after Esc');
  // no system dropdown is left in the page (the segmented ones are buttons)
  const native = await page.evaluate(() => [...document.querySelectorAll('select')].filter(s => !s.classList.contains('seg-src') && !s.parentElement.classList.contains('csel')).map(s => s.id));
  assert.deepEqual(native, []);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the tempo lock is a small lock next to the tempo on the timeline: on, Random keeps the tempo', { skip }, async () => {
  const ctx = await fresh();
  await film();
  await tempo(97);
  await page.click('.lock');
  assert.equal(await page.locator('#bpmLock').isChecked(), true);
  for (let i = 0; i < 5; i++) await page.keyboard.press('r');
  assert.equal(await page.locator('#bpmInput').inputValue(), '97');
  assert.equal(await text('#tempoVal'), '97 BPM');
  assert.equal(await page.locator('#rhythmSelect').inputValue(), 'flat', 'and adds no change: the tempo is where a change starts');
  await ctx.close();
});

test('the info panel on a card: less at small sizes, the text scrolls, Copy copies even a prompt with quotes', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945, setup: st => { st.plates[0].prompt = 'A "mirror" logo, 50mm, the brand\'s mark at the center ' + 'and more words '.repeat(40); } });
  await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async t => { window.__copied.push(t); }; });
  const open = async () => { await page.locator('.card[data-filename="k1"]').hover(); await page.locator('.card[data-filename="k1"] .info-btn').click({ force: true }); };
  const seen = async () => page.evaluate(() => { const o = document.querySelector('.card[data-filename="k1"] .prompt-overlay'); const v = sel => { const e = o.querySelector(sel); return !!e && getComputedStyle(e).display !== 'none'; }; return { world: v('.po-world'), idea: v('.po-idea'), prompt: v('.po-prompt'), scrolls: o.querySelector('.prompt-overlay-text').scrollHeight > o.querySelector('.prompt-overlay-text').clientHeight, copyIn: (() => { const c = o.querySelector('.po-copy').getBoundingClientRect(), b = o.getBoundingClientRect(); return c.bottom <= b.bottom + 1 && c.right <= b.right + 1; })() }; });
  for (const [size, want] of [['S', { world: false, idea: false }], ['M', { world: true, idea: false }], ['L', { world: true, idea: true }]]) {
    await page.click(`#thumb${size}`);
    await open();
    const s = await seen();
    assert.equal(s.prompt, true, size); assert.equal(s.world, want.world, `${size} territory`); assert.equal(s.idea, want.idea, `${size} idea`);
    assert.equal(s.copyIn, true, `${size}: Copy inside the card`);
    if (size === 'S') { assert.equal(s.scrolls, true, 'a long prompt scrolls inside'); await shot('25-info-small'); }
    assert.equal(await page.locator('.card[data-filename="k1"] .card-num').isVisible(), false, 'the number steps back');
    await page.locator('.card[data-filename="k1"] .po-copy').click();
    await page.locator('.card[data-filename="k1"] .prompt-overlay').click({ position: { x: 20, y: 20 } });   // closes it
  }
  const copied = await page.evaluate(() => window.__copied);
  assert.equal(copied.length, 3);
  assert.match(copied[0], /^A "mirror" logo, 50mm, the brand's mark/);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('groups: chips for All, yours and the automatic looks; pick cards, make a group, the film plays just the group; undo', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  const chips = async () => page.locator('#groupBar .chip').evaluateAll(b => b.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(await chips(), ['All 3', 'Warm 2'], 'automatic groups appear once they have two images');
  await page.click('#groupBar .chip[data-key="look:warm"]');
  assert.deepEqual(await names(), ['k2', 'k3'], 'the grid shows the group');
  await film();
  assert.equal(await page.locator('#filmstrip button').count(), 2, 'and so does the film');
  await curate();
  await page.click('#groupBar .chip[data-key="all"]');
  // pick two with Cmd-click, make a group of them
  const rowBox = () => page.locator('#groupRow').evaluate(r => { const b = r.getBoundingClientRect(), c = r.querySelector('.chip').getBoundingClientRect(); return [b.height, c.top]; });
  const before = await rowBox();
  await page.locator('.card[data-filename="k1"]').click({ modifiers: ['Meta'] });
  await page.locator('.card[data-filename="k3"]').click({ modifiers: ['Meta'] });
  assert.equal(await text('#pickCount'), '2 selected');
  assert.deepEqual(await rowBox(), before, 'the pick bar does not move the chips');
  await page.click('#addToGroupBtn');
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
  assert.equal(await text('#pickCount'), '3 selected');
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
  assert.equal(await page.locator('#cselMenu .csel-group').textContent(), 'Automatic');
  await page.locator('#cselMenu .csel-item', { hasText: 'Warm' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#filmstrip button').length === 2);
  await shot('27-film-group');
  await curate();
  assert.equal(await page.locator('#groupBar .chip.on').getAttribute('data-key'), 'look:warm', 'the same choice in Curate');
  await page.click('#groupBar .chip[data-key="all"]');
  await film();
  assert.equal(await page.locator('.csel[data-for="filmGroup"] .csel-face').textContent(), 'All (3)');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});
