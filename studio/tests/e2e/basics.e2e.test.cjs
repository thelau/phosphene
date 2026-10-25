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
  for (const id of ['#brightRange', '#widthRange', '#randomBtn']) assert.ok(await page.locator(id).isVisible(), `${id} is there at once`);
  for (const id of ['#brightRange', '#widthRange', '#randomBtn']) assert.ok(await page.locator(id).isVisible(), id);
  assert.ok(!(await page.locator('#bpmSlider').isVisible()));
  const exp2 = await box('#exportBtn');
  assert.ok(exp2.y > (await box('#echoRange')).y, 'export stays below whichever tab is open');
  await shot('music-tab');
  await page.click('#tabVideo');
  assert.ok(await page.locator('#bpmSlider').isVisible());
  await ctx.close();
});

test('variable speed: Flat shows tempo and multiple, Variable shows start, end and curve, and the picture accelerates', { skip }, async () => {
  const ctx = await fresh();
  assert.ok(await page.locator('#bpmSlider').isVisible() && !(await page.locator('#startMsRange').isVisible()));
  await page.selectOption('#rhythmSelect', 'variable');
  assert.ok(!(await page.locator('#bpmSlider').isVisible()) && !(await page.locator('#multSelect').isVisible()));
  for (const id of ['#startMsRange', '#endMsRange', '#curveRange']) assert.ok(await page.locator(id).isVisible(), id);
  await page.fill('#startMsRange', '600'); await page.fill('#endMsRange', '100');
  assert.match(await text('#rhythmInfo'), /cuts 600 ms → 100 ms$/);
  await page.selectOption('#invertSelect', 'mono');
  assert.match(await text('#rhythmInfo'), /^3 images · .* cuts 600 ms → 100 ms$/);
  await page.click('#playBtn');
  await page.waitForFunction(() => document.getElementById('playBtn').textContent.includes('Pause'));
  await page.waitForTimeout(300);
  assert.ok(await page.locator('#stageImg').getAttribute('src'));
  await page.click('#playBtn');
  await page.click('#exportBtn');
  await page.waitForSelector('#downloadLink:not([hidden])');
  const body = api.state.calls.filter(c => c.path === '/api/export-video').pop().body;
  assert.deepEqual([body.rhythm, body.start_ms, body.end_ms], ['variable', 600, 100]);
  await ctx.close();
});

test('synthesized music: the drone plays live in the page, settings swap it at once, export renders it in the page and sends it', { skip }, async () => {
  const ctx = await fresh();
  assert.match(await text('#rhythmInfo'), /^3 images · \d+ s · cuts \d+ ms$/);
  await page.click('#tabMusic');
  assert.deepEqual(await page.locator('#musicSelect option').allTextContents(), ['Off', 'Synthesized']);
  await page.selectOption('#musicSelect', 'on');
  await page.fill('#pulseRange', '80');
  assert.ok(await page.locator('#musicState').isHidden(), 'no render, no loader');
  await page.click('#playBtn');
  await page.waitForFunction(() => document.getElementById('playBtn').textContent.includes('Pause'));
  await page.waitForFunction(() => document.getElementById('stageImg').getAttribute('src'));
  assert.equal(api.state.calls.filter(c => c.path === '/api/music').length, 0, 'the server renders nothing for the drone');
  await page.fill('#lowRange', '30');                                        // swapped live while playing
  await page.waitForTimeout(400);
  assert.ok(await page.locator('#musicState').isHidden());
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

test('Random sound: every draw stays a dark, heavy, level drone and a new sound plays live', { skip }, async () => {
  const ctx = await fresh();
  await page.click('#tabMusic');
  await page.selectOption('#musicSelect', 'on');
  const before = await page.evaluate(() => JSON.stringify([...document.querySelectorAll('#synthBox input[type=range], #chordSelect')].map(e => e.value)));
  await page.click('#randomBtn');
  const after = await page.evaluate(() => JSON.stringify([...document.querySelectorAll('#synthBox input[type=range], #chordSelect')].map(e => e.value)));
  assert.notEqual(before, after, 'the sliders moved');
  const rows = await page.evaluate(async () => {
    const out = [];
    const starts = Array.from({ length: 21 }, (_, i) => i * 0.2);
    for (let t = 0; t < 4; t++) {
      randomMusic();                                                           // the page's own draw, rendered by the real engine
      const u = id => parseInt(document.getElementById(id).value, 10) / 100;
      const prm = { pulse: u('pulseRange'), low: u('lowRange'), bright: u('brightRange'), width: u('widthRange'), space: u('spaceRange'), power: u('powerRange'), pitch: u('pitchRange'), movement: u('movementRange'), echo: u('echoRange'), chord: parseInt(document.getElementById('chordSelect').value, 10), seed: parseInt(document.getElementById('seedVal').value, 10) };
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
    return out;
  });
  for (const m of rows) {
    assert.ok(m.dom > 34 && m.dom < 76, `dominant ${m.dom}`);
    assert.ok(m.low > 0.45, `energy below 80 Hz ${m.low}`);
    assert.ok(m.high < 0.02, `above 2 kHz ${m.high}`);
    assert.ok(Math.abs(m.rms - 0.17) < 0.01 && m.peak <= 0.97 + 1e-6, `level ${m.rms} peak ${m.peak}`);
  }
  await ctx.close();
});
