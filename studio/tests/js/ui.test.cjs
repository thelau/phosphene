const test = require('node:test');
const assert = require('node:assert/strict');
const { load, WEB } = require('./harness.cjs');
const fs = require('fs');

const baseRoutes = () => ({
  '/api/state': { plates: [], krea_connected: true, kimi_configured: true },
  '/api/worlds': { worlds: [{ name: 'Editorial Print', brief: 'Swiss grid.', n: 21, kept: 2, wildcard: false }, { name: 'Harbor & Signal', brief: 'Ports.', n: 0, kept: 0, wildcard: true }] },
});
const settle = () => new Promise(r => setImmediate(r));
const mkPlate = (name, trashed = false) => ({ filename: name, url: `/p/${name}`, trashed, title: name, prompt: 'p', model: 'm' });

// ---------- helpers ----------

test('fmtElapsed formats m:ss', () => {
  const { run } = load({ routes: baseRoutes() });
  assert.equal(run('fmtElapsed(0)'), '0:00');
  assert.equal(run('fmtElapsed(59999)'), '0:59');
  assert.equal(run('fmtElapsed(65000)'), '1:05');
  assert.equal(run('fmtElapsed(600000)'), '10:00');
});

test('escapeHtml escapes markup', () => {
  const { run } = load({ routes: baseRoutes() });
  assert.equal(run(`escapeHtml('<b a="1">&')`), '&lt;b a=&quot;1&quot;&gt;&amp;');
});

test('formatModelShort strips provider', () => {
  const { run } = load({ routes: baseRoutes() });
  assert.equal(run(`formatModelShort('google/nano-banana-2.1')`), 'nano-banana-2.1');
  assert.equal(run(`formatModelShort('plain')`), 'plain');
  assert.equal(run(`formatModelShort('')`), 'nano-banana-2');
});

test('updateTempo computes frames per cut and persists', () => {
  const { run, $, store } = load({ routes: baseRoutes() });
  $('bpmInput').value = '120'; $('multSelect').value = '2';
  run('updateTempo()');
  assert.equal(run('framesPerCut'), 7.5);                      // 1800 / (120*2)
  assert.equal($('speedVal').textContent, '7.5f');
  const saved = JSON.parse(store.studioSettings);
  assert.equal(saved.bpmInput, '120'); assert.equal(saved.multSelect, '2');
  $('bpmInput').value = '220'; $('multSelect').value = '9';
  run('updateTempo()');
  assert.equal(run('framesPerCut'), 1);                        // never below one frame
});

test('restoreSettings brings back remembered values (and ignores unknown options)', () => {
  const { run, $ } = load({ routes: baseRoutes(), storage: { studioSettings: JSON.stringify({ bpmInput: '150', directionInput: 'wet' }) } });
  assert.equal($('bpmInput').value, '150');
  assert.equal($('directionInput').value, 'wet');
});

test('activePlates and tab counts reflect selection vs trash', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a'), mkPlate('b'), mkPlate('c', true)] };
  const { run, $ } = load({ routes: r });
  await settle(); await settle();
  assert.equal(run('activePlates().length'), 2);
  assert.equal($('selCount').textContent, 2);
  assert.equal($('trashCount').textContent, 1);
  assert.equal($('statusText').textContent, 'Ready');           // the bar never carries counts
});

// ---------- status bar ----------

test('setStatus is a toast and never touches the generation status bar', () => {
  const { run, $ } = load({ routes: baseRoutes() });
  assert.equal($('statusText').textContent, 'Ready');
  run(`setStatus('Prompt copied.')`);
  assert.equal($('toast').textContent, 'Prompt copied.');
  assert.equal($('statusText').textContent, 'Ready');
  run(`setStatus('')`);
  assert.equal($('toast').textContent, '');
});

test('toasts during a generation do not replace the progress', () => {
  const { run, $ } = load({ routes: baseRoutes() });
  run(`progStart(4); prog.stage='render'; prog.total=4; prog.world='Harbor'; prog.slots=['ok','run','wait','wait']; prog.titles=['a','b','c','d']; progRender();`);
  const before = $('statusText').innerHTML;
  run(`setStatus('Prompt copied.')`);
  assert.equal($('statusText').innerHTML, before);
  assert.equal($('toast').textContent, 'Prompt copied.');
});

// ---------- territory / direction controls ----------

test('direction placeholder follows the territory selection', async () => {
  const { run, $ } = load({ routes: baseRoutes() });
  await settle(); await settle();
  $('worldSelect').value = '';
  run('updateDirectionHint()');
  assert.match($('directionInput').placeholder, /what do you want/i);
  $('worldSelect').value = '__wildcard__';
  run('updateDirectionHint()');
  assert.match($('directionInput').placeholder, /hint for the new territory/i);
  $('worldSelect').value = '__custom__';
  run('updateDirectionHint()');
  assert.match($('directionInput').placeholder, /Describe your territory \(required\)/);
  $('worldSelect').value = 'Editorial Print';
  run('updateDirectionHint()');
  assert.match($('directionInput').placeholder, /focus inside Editorial Print/);
});

test('loadWorlds fills the dropdown with "X of Y kept" and wildcard marker', async () => {
  const { $, run } = load({ routes: baseRoutes() });
  await settle(); await settle();
  const labels = $('worldSelect').options.map(o => o.textContent);
  assert.ok(labels.includes('Editorial Print (2 of 21 kept)'));
  assert.ok(labels.includes('✨ Harbor & Signal (0 of 0 kept)'));
});

test('changing territory clears the direction text', async () => {
  const { $ } = load({ routes: baseRoutes() });
  await settle();
  $('directionInput').value = 'wet apparel';
  $('worldSelect').fire('change');
  assert.equal($('directionInput').value, '');
});

test('setGenerating locks and unlocks all generation controls', () => {
  const { run, $ } = load({ routes: baseRoutes() });
  const ids = ['worldSelect', 'directionInput', 'batchCountSelect', 'modelSelect', 'generateBtn'];
  run('setGenerating(true)');
  ids.forEach(id => assert.equal($(id).disabled, true, id));
  run('setGenerating(false)');
  ids.forEach(id => assert.equal($(id).disabled, false, id));
});

// ---------- progress rendering ----------

test('progRender: invent stage shows an indeterminate bar, no count', () => {
  const { run, $ } = load({ routes: baseRoutes() });
  run('progStart(6)');
  const html = $('statusText').innerHTML;
  assert.match(html, /indeterminate/);
  assert.match(html, /Choosing a territory and writing 6 scenes/);
  assert.doesNotMatch(html, /<b>/);
});

test('progRender: slot states, count, running tally and world name', () => {
  const { run, $ } = load({ routes: baseRoutes() });
  run(`progStart(6); prog.stage='render'; prog.total=6; prog.world='Harbor & <Signal>';
       prog.slots=['ok','trash','err','run','run','wait']; prog.titles=['a','b','c','d','e','f']; prog.t0=Date.now()-65000; progRender();`);
  const html = $('statusText').innerHTML;
  assert.match(html, /<b>3\/6<\/b>/);
  assert.equal((html.match(/class="slot ok"/g) || []).length, 1);
  assert.equal((html.match(/class="slot trash"/g) || []).length, 1);
  assert.equal((html.match(/class="slot err"/g) || []).length, 1);
  assert.equal((html.match(/class="slot run"/g) || []).length, 2);
  assert.equal((html.match(/class="slot wait"/g) || []).length, 1);
  assert.match(html, /Harbor &amp; &lt;Signal&gt;/);              // escaped
  assert.match(html, /1:05 · 2 rendering/);
});

test('progStop keeps a summary and stops the timer', () => {
  const { run, $ } = load({ routes: baseRoutes() });
  run(`progStart(2)`);
  assert.ok(run('prog.timer'));
  run(`progStop('Done — 2 added')`);
  assert.equal(run('prog.timer'), null);
  assert.match($('statusText').innerHTML, /Done — 2 added/);
});

// ---------- generateImages end to end (fake server) ----------

const ideas = n => Array.from({ length: n }, (_, i) => ({ title: `Idea ${i}`, prompt: `p${i}`, guide: i % 2 ? 'light' : 'dark', world: 'Harbor & Signal', idea: `i${i}` }));

function genRoutes({ n = 4, gen } = {}) {
  const r = baseRoutes();
  r['/api/invent-prompts'] = { ok: true, ideas: ideas(n) };
  r['/api/generate-image'] = gen || (async () => ({ ok: true, qa_passed: true, filename: 'f.jpg' }));
  return r;
}

async function runGenerate(h) {
  h.$('kimiKeyInput').value = 'sk-x';
  h.$('batchCountSelect').value = '4';
  const p = h.run('generateImages()');
  return p;
}

test('generateImages: success path locks controls, reports progress, then unlocks and clears direction', async () => {
  let observed = null;
  const h = load({ routes: genRoutes({ n: 4, gen: async () => { observed = observed || ['worldSelect', 'directionInput', 'batchCountSelect', 'generateBtn'].map(id => h.$(id).disabled); return { ok: true, qa_passed: true }; } }) });
  await settle(); await settle();
  h.$('directionInput').value = 'harbour fog';
  await runGenerate(h);
  assert.deepEqual(observed, [true, true, true, true]);                            // locked while running
  ['worldSelect', 'directionInput', 'batchCountSelect', 'generateBtn', 'modelSelect'].forEach(id => assert.equal(h.$(id).disabled, false, id));
  assert.equal(h.$('directionInput').value, '');                                   // cleared after the batch
  assert.deepEqual(h.run('prog.slots'), ['ok', 'ok', 'ok', 'ok']);
  assert.match(h.$('statusText').innerHTML, /Done — 4 added/);
  assert.equal(h.run('prog.timer'), null);
  const gen = h.calls.filter(c => c.url === '/api/generate-image');
  assert.equal(gen.length, 4);
  assert.equal(gen[0].body.model, h.$('modelSelect').value);
  assert.equal(gen[0].body.world, 'Harbor & Signal');
});

test('generateImages sends territory, direction and count to the idea endpoint', async () => {
  const h = load({ routes: genRoutes({ n: 2 }) });
  await settle(); await settle();
  h.$('worldSelect').value = 'Editorial Print';
  h.$('directionInput').value = 'big type';
  h.$('batchCountSelect').value = '6';
  h.$('kimiKeyInput').value = 'sk-x';
  await h.run('generateImages()');
  const inv = h.calls.find(c => c.url === '/api/invent-prompts');
  assert.equal(inv.body.world, 'Editorial Print');
  assert.equal(inv.body.direction, 'big type');
  assert.equal(inv.body.count, 6);
});

test('generateImages runs at most 3 renders in parallel', async () => {
  let cur = 0, max = 0;
  const h = load({ routes: genRoutes({ n: 8, gen: async () => { cur++; max = Math.max(max, cur); await settle(); cur--; return { ok: true, qa_passed: true }; } }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.equal(max, 3);
  assert.equal(h.calls.filter(c => c.url === '/api/generate-image').length, 8);
});

test('generateImages: logo-check failures show as trash slots and in the summary', async () => {
  let i = 0;
  const h = load({ routes: genRoutes({ n: 4, gen: async () => (i++ % 2 ? { ok: true, qa_passed: false, qa_issues: ['Low center logo fidelity'] } : { ok: true, qa_passed: true }) }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.deepEqual(h.run('prog.slots').slice().sort(), ['ok', 'ok', 'trash', 'trash']);
  assert.match(h.$('statusText').innerHTML, /2 added, 2 in Trash \(Low center logo fidelity\)/);
});

test('generateImages: server errors on an image become err slots, batch continues', async () => {
  let i = 0;
  const h = load({ routes: genRoutes({ n: 3, gen: async () => (i++ === 1 ? { ok: false, error: 'Krea 500' } : { ok: true, qa_passed: true }) }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.equal(h.run('prog.slots').filter(s => s === 'err').length, 1);
  assert.match(h.$('statusText').innerHTML, /2 added, 1 failed \(Krea 500\)/);
});

test('generateImages: thrown network errors do not freeze the page', async () => {
  const h = load({ routes: genRoutes({ n: 2, gen: async () => { throw new Error('socket hang up'); } }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.deepEqual(h.run('prog.slots'), ['err', 'err']);
  assert.equal(h.$('generateBtn').disabled, false);
});

test('generateImages: Krea login needed stops remaining renders', async () => {
  const h = load({ routes: genRoutes({ n: 6, gen: async () => ({ ok: false, needs_auth: true }) }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.ok(h.calls.filter(c => c.url === '/api/generate-image').length <= 3);     // only the in-flight ones were sent
  assert.equal(h.run('prog.slots').every(s => s === 'err'), true);
  assert.match(h.$('statusText').innerHTML, /Krea login needed/);
});

test('generateImages: prompt-writing failure shows an error and unlocks', async () => {
  const r = baseRoutes();
  r['/api/invent-prompts'] = { ok: false, error: 'Extra data: line 1 column 798' };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('directionInput').value = 'keep me';
  await runGenerate(h);
  assert.match(h.$('statusText').innerHTML, /Error: Extra data/);
  assert.equal(h.$('generateBtn').disabled, false);
  assert.equal(h.$('directionInput').value, 'keep me');           // nothing ran, so the text stays
  assert.equal(h.calls.filter(c => c.url === '/api/generate-image').length, 0);
});

test('generateImages: missing Kimi key opens settings and does not start', async () => {
  const h = load({ routes: genRoutes() });
  await settle(); await settle();
  h.run('kimiConfigured = false');
  h.$('kimiKeyInput').value = '';
  await h.run('generateImages()');
  assert.equal(h.calls.filter(c => c.url === '/api/invent-prompts').length, 0);
  assert.match(h.$('toast').textContent, /Paste your Kimi API key/);
  assert.equal(h.$('generateBtn').disabled, false);
});

test('background polling does not overwrite live progress', async () => {
  const h = load({ routes: genRoutes() });
  await settle(); await settle();
  h.run(`progStart(3)`);
  h.run(`refreshIdle()`);
  assert.match(h.$('statusText').innerHTML, /prog-world/);
});

test('changing the territory never writes to the status bar', async () => {
  const h = load({ routes: genRoutes() });
  await settle(); await settle();
  h.run(`progStart(2)`);
  const before = h.$('statusText').innerHTML;
  h.$('worldSelect').value = 'Editorial Print';
  h.$('worldSelect').fire('change');
  assert.equal(h.$('statusText').innerHTML, before);
});

test('custom territory requires a description before anything is generated', async () => {
  const h = load({ routes: genRoutes() });
  await settle(); await settle();
  h.$('kimiKeyInput').value = 'sk-x';
  h.$('worldSelect').value = '__custom__';
  h.$('directionInput').value = '   ';
  await h.run('generateImages()');
  assert.equal(h.calls.filter(c => c.url === '/api/invent-prompts').length, 0);
  assert.match(h.$('toast').textContent, /Describe your custom territory/);
  assert.equal(h.$('generateBtn').disabled, false);
});

test('custom territory sends its description as the direction', async () => {
  const h = load({ routes: genRoutes({ n: 2 }) });
  await settle(); await settle();
  h.$('kimiKeyInput').value = 'sk-x';
  h.$('worldSelect').value = '__custom__';
  h.$('directionInput').value = '  fog, clouds, rain  ';
  await h.run('generateImages()');
  const inv = h.calls.find(c => c.url === '/api/invent-prompts');
  assert.equal(inv.body.world, '__custom__');
  assert.equal(inv.body.direction, 'fog, clouds, rain');
});

test('territory dropdown offers Mix it up, Custom and New', () => {
  const { $, run } = load({ routes: baseRoutes() });
  const html = fs.readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<option value="">🎲 Mix it up<\/option>/);
  assert.match(html, /<option value="__custom__">✍️ Custom territory…<\/option>/);
  assert.match(html, /<option value="__wildcard__">✨ New territory/);
});

test('every inline handler in the markup and templates is exported on window', () => {
  const html = fs.readFileSync(WEB('index.html'), 'utf8');
  const app = fs.readFileSync(WEB('src', 'app.js'), 'utf8');
  const used = new Set();
  for (const m of (html + app).matchAll(/\bon[a-z]+="(?:[^"]*?[;\s])?([A-Za-z_]\w*)\(/g)) used.add(m[1]);
  used.delete('event'); used.delete('if');
  const h = load({ routes: baseRoutes() });
  const missing = [...used].filter(n => h.run(`typeof window.${n}`) !== 'function');
  assert.deepEqual(missing, []);
  assert.ok(used.size >= 20);
});

test('the page entry is a module with a stylesheet, and markup has no inline script or style blocks', () => {
  const html = fs.readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/src\/app.js">/);
  assert.match(html, /<link rel="stylesheet" href="\/src\/style.css"/);
  assert.doesNotMatch(html, /<style>/);
});

// ---------- cut plan, zoom and invert (same vectors as tests/test_cutplan.py) ----------

const PLAN_VECTORS = [
  [0.0, 3, 'off', 0, 0, false], [1.2, 3, 'off', 1, 1, false], [3.9, 3, 'off', 3, 0, false],
  [0.0, 3, 'mono', 0, 0, false], [1.0, 3, 'mono', 1, 0, true], [2.5, 3, 'colour', 2, 1, false],
  [3.5, 3, 'colour', 3, 1, true], [6.0, 3, 'mono', 6, 0, false],
];
const ZOOM_VECTORS = [
  ['off', 5, 0.5, 1.0], ['out', 1, 0.0, 1.01], ['out', 1, 1.0, 1.0], ['in', 1, 0.0, 1.0], ['in', 1, 1.0, 1.01], ['out', 0.6, 0.5, 1.003],
];

test('planAt follows uneven cuts (music-driven) and wraps around the sequence', () => {
  const { run } = load({ routes: baseRoutes() });
  assert.deepEqual(JSON.parse(JSON.stringify(run('planAt(2.0, 4, "off", [0, 1, 3, 4.5])'))).cut, 1);
  const r = run('planAt(2.0, 4, "off", [0, 1, 3, 4.5])');
  assert.ok(Math.abs(r.p - 0.5) < 1e-9);
  assert.equal(run('planAt(6.0, 4, "off", [0, 1, 3, 4.5])').cut, 1);   // 6.0 wraps to 1.5
});

test('planAt matches the server plan vectors', () => {
  const { run } = load({ routes: baseRoutes() });
  for (const [pos, n, inv, cut, plate, flipped] of PLAN_VECTORS) {
    const r = run(`planAt(${pos}, ${n}, '${inv}')`);
    assert.deepEqual([r.cut, r.plate, r.inverted], [cut, plate, flipped], `${pos} ${inv}`);
  }
});

test('zoomScale matches the server zoom vectors', () => {
  const { run } = load({ routes: baseRoutes() });
  for (const [mode, amt, zp, expected] of ZOOM_VECTORS) {
    assert.ok(Math.abs(run(`zoomScale('${mode}', ${amt}, ${zp})`) - expected) < 1e-9, `${mode} ${amt} ${zp}`);
  }
});

test('updateFx shows the amount, disables it when zoom is off, and remembers the choice', () => {
  const { run, $, store } = load({ routes: baseRoutes() });
  $('zoomSelect').value = 'out'; $('zoomAmt').value = '1.5'; $('invertSelect').value = 'mono';
  run('updateFx()');
  assert.equal($('zoomAmtVal').textContent, '1.5%');
  assert.equal($('zoomAmt').disabled, false);
  const saved = JSON.parse(store.studioSettings);
  assert.deepEqual([saved.zoomSelect, saved.zoomAmt, saved.invertSelect], ['out', '1.5', 'mono']);
  $('zoomSelect').value = 'off';
  run('updateFx()');
  assert.equal($('zoomAmt').disabled, true);
});

test('applyFx sets scale and the invert filter on the stage image', () => {
  const { run, $ } = load({ routes: baseRoutes() });
  run(`applyFx({cut:0, p:0, inverted:true}, {invert:'mono', zoom:'out', amount:2})`);
  assert.equal($('stageImg').style.transform, 'scale(1.02000)');
  assert.equal($('stageImg').style.filter, 'invert(1) grayscale(1)');
  run(`applyFx({cut:1, p:0.5, inverted:true}, {invert:'colour', zoom:'off', amount:2})`);
  assert.equal($('stageImg').style.transform, '');
  assert.equal($('stageImg').style.filter, 'invert(1)');
  run(`applyFx({cut:2, p:0.5, inverted:false}, {invert:'colour', zoom:'in', amount:2})`);
  assert.equal($('stageImg').style.filter, '');
  run('clearFx()');
  assert.equal($('stageImg').style.transform, '');
});

test('the preview loop alternates image and inverted image, then moves on', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [{ filename: 'a', url: '/p/a', trashed: false }, { filename: 'b', url: '/p/b', trashed: false }] };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('stageImg').style.display = 'block';
  h.$('invertSelect').value = 'mono';
  h.$('zoomSelect').value = 'off';
  h.$('bpmInput').value = '200'; h.$('multSelect').value = '3'; h.run('updateTempo()');   // a beat of 9 frames, 3 picture cuts per beat: 100 ms per cut
  h.run('isPlaying = true; cutPos = 0');
  const tick = h.timers.intervals[h.timers.intervals.length - 1].fn;
  const seen = [];
  // drive time by hand: each tick advances exactly one cut (100ms at 3 frames / 30fps)
  h.ctx.performance.now = (() => { let t = 0; return () => (t += 100); })();
  h.run('lastTick = performance.now()');
  for (let i = 0; i < 4; i++) { tick(); seen.push([h.$('stageImg').src, h.$('stageImg').style.filter]); }
  assert.deepEqual(seen.map(s => s[1]), ['invert(1) grayscale(1)', '', 'invert(1) grayscale(1)', '']);
  assert.deepEqual(seen.map(s => s[0]), ['/p/a', '/p/b', '/p/b', '/p/a']);
});

test('the dark/light twin feature is gone from the page', () => {
  const html = fs.readFileSync(WEB('index.html'), 'utf8');
  const app = fs.readFileSync(WEB('src', 'app.js'), 'utf8');
  for (const word of ['twin', 'Twin', 'Dark↔light']) {
    assert.ok(!html.includes(word), `index.html still mentions ${word}`);
    assert.ok(!app.includes(word), `app.js still mentions ${word}`);
  }
});

test('export leaves the preview alone and offers a download link', async () => {
  const r = baseRoutes();
  r['/api/export-video'] = { ok: true, images: 12, seconds: 6.0, video_url: '/outputs/Demo-136bpm-x4-20261025-093005.mp4', filename: 'Demo-136bpm-x4-20261025-093005.mp4' };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('stageImg').src = '/p/a';
  h.$('stageImg').style.display = 'block';
  h.$('bpmInput').value = '136'; h.$('multSelect').value = '4'; h.$('invertSelect').value = 'mono'; h.$('zoomSelect').value = 'out'; h.$('zoomAmt').value = '1.2';
  await h.run('exportVideo()');
  const body = h.calls.find(c => c.url === '/api/export-video').body;
  assert.deepEqual([body.invert_mode, body.zoom_mode, body.zoom_amount, body.bpm], ['mono', 'out', 1.2, 136]);
  assert.equal('total_seconds' in body, false);                       // no fixed duration: the server exports every selected image
  assert.equal(h.$('stageImg').src, '/p/a');
  assert.equal(h.$('stageImg').style.display, 'block');
  const link = h.$('downloadLink');
  assert.equal(link.hidden, false);
  assert.equal(link.href, '/outputs/Demo-136bpm-x4-20261025-093005.mp4');
  assert.equal(link.download, 'Demo-136bpm-x4-20261025-093005.mp4');
  assert.equal(h.$('exportFile').textContent, 'Demo-136bpm-x4-20261025-093005.mp4');
  assert.match(h.$('toast').textContent, /12 images, 6s/);
  assert.equal(h.$('exportDock').dataset.state, 'ready');                 // "Downloaded", with Export again and Download again
});

test('export failures show a message and unlock the button; with no images there is nothing to export', async () => {
  const r0 = baseRoutes();
  const h0 = load({ routes: r0 }); await settle(); await settle();
  assert.equal(h0.$('exportBtn').disabled, true, 'no images: Export is off');
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a')] };
  r['/api/export-video'] = { ok: false, error: 'No active plates' };
  const h = load({ routes: r });
  await settle(); await settle();
  await h.run('exportVideo()');
  assert.match(h.$('toast').textContent, /Export failed: No active plates/);
  assert.equal(h.$('exportBtn').disabled, false);
  const r2 = baseRoutes();
  r2['/api/state'] = { plates: [mkPlate('a')] };
  r2['/api/export-video'] = async () => { throw new Error('socket hang up'); };
  const h2 = load({ routes: r2 });
  await settle(); await settle();
  await h2.run('exportVideo()');
  assert.match(h2.$('toast').textContent, /Export failed: socket hang up/);
});

test('the preview no longer has a video element to replace it with', () => {
  const html = fs.readFileSync(WEB('index.html'), 'utf8');
  const app = fs.readFileSync(WEB('src', 'app.js'), 'utf8');
  assert.ok(!html.includes('stageVideo') && !app.includes('stageVideo'));
});

// ---------- trash: selection and permanent delete ----------

const trashRoutes = (extra = {}) => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('1_a', true), mkPlate('2_b', true), mkPlate('3_c', true), mkPlate('4_d', true), mkPlate('5_k', false)] };
  return Object.assign(r, extra);
};
async function inTrash(extra) {
  const h = load({ routes: trashRoutes(extra) });
  await settle(); await settle();
  h.run('showTrash = true');
  await h.run('loadState()');
  return h;
}
const ev = (o = {}) => ({ shiftKey: false, ...o });

test('trash bar only shows in the trash view and counts what is selected', async () => {
  const h = await inTrash();
  assert.equal(h.$('trashBar').hidden, false);
  assert.equal(h.$('trashEmpty').textContent, 'Empty trash (4)…');
  assert.equal(h.$('trashDelSel').disabled, true);
  h.run(`cardClick(${JSON.stringify(ev())}, '2_b')`);
  assert.equal(h.$('trashSelCount').textContent, '1 selected');
  assert.equal(h.$('trashDelSel').textContent, 'Delete 1 selected…');
  assert.equal(h.$('trashDelSel').disabled, false);
  h.run(`cardClick(${JSON.stringify(ev())}, '2_b')`);                  // click again deselects
  assert.equal(h.$('trashSelCount').textContent, '0 selected');
  await h.run('setTrashView(false)');
  assert.equal(h.$('trashBar').hidden, true);
});

test('in the selection view a click previews instead of selecting', async () => {
  const h = load({ routes: trashRoutes() });
  await settle(); await settle();
  h.run(`cardClick(${JSON.stringify(ev())}, '5_k')`);
  assert.equal(h.run('trashSel.size'), 0);
  assert.equal(h.$('stageImg').src, '/p/5_k');
});

test('shift-click selects a range; select all toggles', async () => {
  const h = await inTrash();
  const order = h.run('visiblePlates().map(p => p.filename)');
  h.run(`cardClick(${JSON.stringify(ev())}, '${order[0]}')`);
  h.run(`cardClick(${JSON.stringify(ev({ shiftKey: true }))}, '${order[2]}')`);
  assert.equal(h.run('trashSel.size'), 3);
  h.run('selectAllTrash()');
  assert.equal(h.run('trashSel.size'), 4);
  assert.equal(h.$('trashSelAll').textContent, 'Clear selection');
  h.run('selectAllTrash()');
  assert.equal(h.run('trashSel.size'), 0);
});

test('deleting selected asks first, and cancelling deletes nothing', async () => {
  const h = await inTrash({ '/api/purge': { ok: true, deleted: 2, freed_mb: 3.1 } });
  h.run(`cardClick(${JSON.stringify(ev())}, '1_a')`); h.run(`cardClick(${JSON.stringify(ev())}, '2_b')`);
  const p = h.run('deleteSelected()');
  assert.equal(h.$('confirmModal').classList.contains('open'), true);
  assert.match(h.$('confirmTitle').textContent, /Delete 2 images permanently\?/);
  assert.match(h.$('confirmBody').textContent, /can't be undone/);
  assert.match(h.$('confirmBody').textContent, /keep\/trash history stays/);
  assert.equal(h.$('confirmYes').textContent, 'Delete 2');
  h.run('confirmAnswer(false)');
  await p;
  assert.equal(h.$('confirmModal').classList.contains('open'), false);
  assert.equal(h.calls.filter(c => c.url === '/api/purge').length, 0);
  assert.equal(h.run('trashSel.size'), 2);                              // selection survives a cancel
});

test('confirming deletes exactly the selected files and reports what was freed', async () => {
  const h = await inTrash({ '/api/purge': { ok: true, deleted: 2, freed_mb: 3.1 } });
  h.run(`cardClick(${JSON.stringify(ev())}, '1_a')`); h.run(`cardClick(${JSON.stringify(ev())}, '3_c')`);
  const p = h.run('deleteSelected()');
  h.run('confirmAnswer(true)');
  await p;
  const call = h.calls.find(c => c.url === '/api/purge');
  assert.deepEqual(call.body.filenames.slice().sort(), ['1_a', '3_c']);
  assert.equal(call.body.all, undefined);
  assert.match(h.$('toast').textContent, /Deleted 2 images \(3.1 MB freed\)/);
  assert.equal(h.run('trashSel.size'), 0);
  assert.equal(h.$('trashDelSel').disabled, true);
});

test('empty trash asks with the count and sends all=true', async () => {
  const h = await inTrash({ '/api/purge': { ok: true, deleted: 4, freed_mb: 9 } });
  const p = h.run('emptyTrash()');
  assert.match(h.$('confirmTitle').textContent, /Empty the trash \(4 images\)\?/);
  assert.equal(h.$('confirmYes').textContent, 'Delete all 4');
  h.run('confirmAnswer(true)');
  await p;
  assert.deepEqual(h.calls.find(c => c.url === '/api/purge').body, { all: true });
});

test('a failed delete reports the error and unlocks the buttons', async () => {
  const h = await inTrash({ '/api/purge': { ok: false, error: 'disk busy' } });
  const p = h.run('emptyTrash()');
  h.run('confirmAnswer(true)');
  await p;
  assert.match(h.$('toast').textContent, /Delete failed: disk busy/);
  assert.equal(h.$('trashEmpty').disabled, false);
});

test('selection forgets images that are no longer in the trash (restored)', async () => {
  const h = await inTrash();
  h.run(`cardClick(${JSON.stringify(ev())}, '1_a')`);
  h.run(`plates.find(p => p.filename === '1_a').trashed = false`);
  h.run('updateTrashBar()');
  assert.equal(h.run('trashSel.size'), 0);
});

test('beforeunload asks only while a job is running', async () => {
  const h = load({ routes: baseRoutes() });
  const handler = h.ctx.__listeners.beforeunload;
  assert.equal(typeof handler, 'function');
  const ev = () => { const e = { prevented: false, preventDefault() { this.prevented = true; }, returnValue: undefined }; return e; };
  let e = ev(); handler(e); assert.equal(e.prevented, false);
  for (const flag of ['generating', 'aiRunning', 'exporting', 'purging']) {
    h.run(`${flag} = true`);
    e = ev(); handler(e); assert.equal(e.prevented, true, flag);
    h.run(`${flag} = false`);
  }
  assert.equal(h.run('isBusy()'), false);
});


// ---------- rhythm and music ----------

async function playerWith(extra = {}) {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a'), mkPlate('b'), mkPlate('c')] };
  r['/api/music'] = extra.music || { ok: true };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('stageImg').style.display = 'block';
  h.$('bpmInput').value = '120'; h.$('multSelect').value = '2'; h.$('zoomSelect').value = 'off';
  h.run('updateTempo()');
  return h;
}

test('with music off, Play never asks for music or creates audio', async () => {
  const h = await playerWith();
  h.run('togglePlay()');
  await settle();
  assert.equal(h.calls.some(c => c.url === '/api/music'), false);
  assert.equal(h.ctx.__audios.length, 0);
  assert.equal(h.$('playBtn').textContent, 'Pause');
});

test('with the drone on, Play starts it live from the top with the settings and where every cut falls', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on'; h.$('invertSelect').value = 'colour';
  h.$('pulseRange').value = '40'; h.$('lowRange').value = '80'; h.$('brightRange').value = '20'; h.$('widthRange').value = '90'; h.$('spaceRange').value = '75'; h.$('powerRange').value = '55'; h.$('seedVal').value = '42';
  h.$('pitchRange').value = '50'; h.$('movementRange').value = '50'; h.$('echoRange').value = '0'; h.$('chordSelect').value = '0'; h.$('washRange').value = '0'; h.$('ringRange').value = '0'; h.$('shimmerRange').value = '0'; h.$('subWaveSelect').value = '0'; h.$('padWaveSelect').value = '0';
  for (const id of ['hitTypeSelect', 'hitOnSelect', 'arpStepsSelect', 'arpRateSelect', 'dynSelect']) h.$(id).value = '0';
  h.$('hitRange').value = '0'; h.$('arpRange').value = '0';
  h.$('bpmInput').value = '200'; h.$('multSelect').value = '3'; h.run('updateTempo()');   // a beat of 9 frames, 3 picture cuts per beat: 100 ms per cut
  h.run('togglePlay()');
  await settle(); await settle();
  assert.equal(h.calls.some(c => c.url === '/api/music'), false);           // nothing is rendered on the server
  const play = h.ctx.__drone.plays[0];
  assert.deepEqual(JSON.parse(JSON.stringify(play.params)), { pulse: 0.4, low: 0.8, bright: 0.2, width: 0.9, space: 0.75, power: 0.55, pitch: 0.5, chord: 0, prog: 0, pad: 0, tape: 0, progEvery: 0, bass: 0, bassPattern: 0, bassRate: 0, arrange: 0, movement: 0.5, echo: 0, wash: 0, ring: 0, shimmer: 0, choir: 0, industrial: 0, hitType: 0, hit: 0, hitOn: 0, arp: 0, arpMood: 0, arpSteps: 0, arpRate: 0, dynamics: 0, subWave: 0, padWave: 0, seed: 42, paired: true, landAt: 0.4 });
  assert.equal(play.offset, 0);
  assert.equal(play.starts.length, 3);                                      // the music follows the beats (2 of them for 6 picture cuts at 3 per beat) + the end
  assert.ok(Math.abs(play.starts[2] - 0.6) < 1e-9 && Math.abs(play.starts[1] - 0.3) < 1e-9);
  assert.equal(h.$('playBtn').textContent, 'Pause');
  h.run('togglePlay()');                                                    // pause stops the sound
  assert.equal(h.ctx.__drone.stops > 0, true);
});

test('while the drone plays it is the clock: the picture follows its position', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on'; h.$('invertSelect').value = 'off';
  h.$('bpmInput').value = '200'; h.$('multSelect').value = '3'; h.run('updateTempo()');   // a beat of 9 frames, 3 picture cuts per beat: 100 ms per cut
  h.run('togglePlay()');
  await settle(); await settle();
  const tick = h.timers.intervals[h.timers.intervals.length - 1].fn;
  h.ctx.__drone.position = 0.25;                                            // cut 2 -> third image
  tick();
  assert.equal(h.$('stageImg').src, '/p/c');
  h.ctx.__drone.position = 0.05;
  tick();
  assert.equal(h.$('stageImg').src, '/p/a');
});

test('changing the tempo or invert while playing swaps the sound live, from where the picture is, with no render', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on';
  h.$('bpmInput').value = '200'; h.$('multSelect').value = '3'; h.run('updateTempo()');   // a beat of 9 frames, 3 picture cuts per beat: 100 ms per cut
  h.run('togglePlay()');
  await settle(); await settle();
  h.run('cutPos = 4.5');                                                     // 150 ms into the clip (frames)
  h.$('invertSelect').value = 'mono';
  h.run('updateFx()');
  const up = h.ctx.__drone.updates[h.ctx.__drone.updates.length - 1];
  assert.equal(up.params.paired, true);
  assert.equal(up.starts.length, 3);                                         // the music's cuts are the beats: 6 picture cuts / 3 per beat = 2 beats + the end
  assert.ok(Math.abs(up.offset - 0.15) < 1e-9);
  assert.equal(h.calls.some(c => c.url === '/api/music'), false);
  assert.ok(!h.$('musicState').textContent);                                 // no loader: it is instant
});

test('a slider moved while the drone plays updates it at once', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on';
  h.run('togglePlay()');
  await settle(); await settle();
  const before = h.ctx.__drone.updates.length;
  h.$('lowRange').value = '10';
  h.run('updateMusic()');
  assert.equal(h.ctx.__drone.updates.length, before + 1);
  assert.equal(h.ctx.__drone.updates[before].params.low, 0.1);
});

test('export renders the same drone in the page, sends it, then asks for the video with the music choice', async () => {
  const r = baseRoutes();
  r['/api/export-video'] = { ok: true, images: 3, seconds: 2, video_url: '/outputs/x.mp4', filename: 'x.mp4' };
  r['/api/export-audio'] = { ok: true, bytes: 44 };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('musicSelect').value = 'on';
  await h.run('exportVideo()');
  assert.equal(h.ctx.__drone.exports.length, 1);
  const urls = h.calls.map(c => c.url);
  assert.ok(urls.indexOf('/api/export-audio') >= 0 && urls.indexOf('/api/export-audio') < urls.indexOf('/api/export-video'));
  assert.equal(h.calls.find(c => c.url === '/api/export-video').body.music, 'synth');
  assert.equal(h.$('exportDock').dataset.state, 'ready');
});

test('export without music does not render or send any sound', async () => {
  const r = baseRoutes();
  r['/api/export-video'] = { ok: true, images: 3, seconds: 2, video_url: '/outputs/x.mp4', filename: 'x.mp4' };
  const h = load({ routes: r });
  await settle(); await settle();
  await h.run('exportVideo()');
  assert.equal(h.ctx.__drone.exports.length, 0);
  assert.equal(h.calls.some(c => c.url === '/api/export-audio'), false);
  assert.equal(h.calls.find(c => c.url === '/api/export-video').body.music, 'off');
});

test('music choices are remembered', () => {
  const h = load({ routes: baseRoutes() });
  h.$('musicSelect').value = 'on'; h.$('echoRange').value = '30'; h.$('chordSelect').value = '2';
  h.run('updateMusic()');
  const saved = JSON.parse(h.store.studioSettings);
  assert.deepEqual([saved.musicSelect, saved.echoRange, saved.chordSelect], ['on', '30', '2']);
});

// ---------- variable speed (same vectors as tests/test_cutplan.py) ----------

test('variableStarts matches the server timeline', () => {
  const h = load({ routes: baseRoutes() });
  const near = (a, b) => assert.ok(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.001), `${a} vs ${b}`);
  for (const [n, a, b, ramp, at, exp] of [[6, 100, 600, 3, 'end', [0, 3, 6, 9, 14.451, 24.357, 42.357]], [6, 100, 600, 3, 'start', [0, 3, 10.348, 28.348, 46.348, 64.348, 82.348]],
    [5, 200, 200, 12, 'end', [0, 6, 12, 18, 24, 30]], [1, 300, 100, 12, 'end', [0, 3]], [4, 400, 100, 99, 'end', [0, 8.485, 14.485, 18.728, 21.728]]]) {
    near(JSON.parse(JSON.stringify(h.run(`variableStarts(${n}, ${a}, ${b}, ${ramp}, '${at}')`))), exp);
  }
});

test('Variable speed swaps the controls, drives the timeline in frames, the sound and the export', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a'), mkPlate('b'), mkPlate('c')] };
  r['/api/export-video'] = { ok: true, images: 3, seconds: 2, video_url: '/outputs/x.mp4', filename: 'x.mp4' };
  r['/api/export-audio'] = { ok: true, bytes: 44 };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('rhythmSelect').value = 'variable'; h.$('startMsRange').value = '100'; h.$('endMsRange').value = '600'; h.$('rampRange').value = '2'; h.$('atSelect').value = 'end';
  h.run('updateRhythm()');
  assert.equal(h.$('flatBox').hidden, true); assert.equal(h.$('varBox').hidden, false);
  assert.equal(h.$('startMsVal').textContent, '100 ms'); assert.equal(h.$('rampVal').textContent, '2 cuts');
  assert.equal(h.$('rampRange').max, '3');                                    // 3 images = 3 cuts
  assert.match(h.$('rhythmInfo').textContent, /^3 images · \d+(\.\d)? s · cuts 100 ms, then 600 ms over the last 2$/);
  const starts = JSON.parse(JSON.stringify(h.run('timelineFor(3)')));
  assert.equal(starts.length, 4);
  assert.ok(starts[3] - starts[2] > starts[2] - starts[1]);                    // slowing down at the end
  h.$('musicSelect').value = 'on';
  await h.run('exportVideo()');
  const sent = h.ctx.__drone.exports[0].starts;
  assert.ok(Math.abs(sent[1] - 0.1) < 1e-9);                                  // seconds, not frames
  assert.ok(Math.abs(sent[sent.length - 1] - starts[3] / 30) < 1e-9);
  const body = h.calls.find(c => c.url === '/api/export-video').body;
  assert.deepEqual([body.rhythm, body.start_ms, body.end_ms, body.ramp, body.at], ['variable', 100, 600, 2, 'end']);
  h.$('rhythmSelect').value = 'flat'; h.run('updateRhythm()');
  assert.equal(h.$('flatBox').hidden, false); assert.equal(h.$('varBox').hidden, true);
  h.$('bpmInput').value = '120'; h.$('multSelect').value = '2'; h.run('updateTempo()');
  assert.equal(JSON.parse(JSON.stringify(h.run('timelineFor(3)'))).join(), '0,7.5,15,22.5');       // flat: 120 BPM x2 = 7.5 frames a cut, in frames
});

test('the info line says what variable speed does in plain words', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 40 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('rhythmSelect').value = 'variable'; h.$('startMsRange').value = '100'; h.$('endMsRange').value = '700'; h.$('rampRange').value = '12';
  h.run('updateRhythm()');
  assert.match(h.$('rhythmInfo').textContent, /^40 images · .* cuts 100 ms, then 700 ms over the last 12$/);
  h.$('atSelect').value = 'start'; h.run('updateRhythm()');
  assert.match(h.$('rhythmInfo').textContent, /cuts 100 ms → 700 ms over the first 12$/);
  h.$('rampRange').value = '60'; h.run('updateRhythm()');
  assert.match(h.$('rhythmInfo').textContent, /cuts 100 ms → 700 ms$/);
});

test('Restart starts again from the first image and the start of the sound, and starts playing when stopped', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on';
  h.run('restartPlay()');                                                    // stopped: it plays
  await settle(); await settle();
  assert.equal(h.run('isPlaying'), true);
  h.run('cutPos = 2.5; currentIdx = 2');
  const restarts = h.ctx.__drone.restarts || 0;
  h.run('restartPlay()');
  assert.equal(h.run('cutPos'), 0); assert.equal(h.run('currentIdx'), 0);
  assert.equal(h.run('isPlaying'), true);
  assert.equal(h.ctx.__drone.restarts, restarts + 1);                        // the sound goes back to its start itself (an update with unchanged settings is skipped)
});

test('"Change over" follows the number of cuts: its range grows and shrinks with the selection and the invert pairs', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 40 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('rampRange').value = '30'; h.run('updateRhythm()');
  assert.equal(h.$('rampRange').max, '40'); assert.equal(h.$('rampVal').textContent, '30 cuts');
  h.$('invertSelect').value = 'mono'; h.run('drawInfo()');
  assert.equal(h.$('rampRange').max, '80');                                   // each image takes two cuts
  h.$('rampRange').value = '80'; h.run('updateRhythm()');
  assert.equal(h.$('rampVal').textContent, 'all 80');
  h.$('invertSelect').value = 'off'; h.run('drawInfo()');                     // fewer cuts: the value comes down with the range
  assert.equal(h.$('rampRange').max, '40'); assert.equal(h.$('rampRange').value, '40'); assert.equal(h.$('rampVal').textContent, 'all 40');
});

test('the multiple only changes the picture: the music keeps the beat, in Flat and in Variable', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 8 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('bpmInput').value = '120'; h.$('multSelect').value = '4'; h.run('updateTempo()');
  const flat4 = JSON.parse(JSON.stringify(h.run('rhythmFor(8)')));
  assert.equal(flat4.pic.length, 9); assert.ok(Math.abs(flat4.pic[1] - 3.75) < 1e-9);                 // 4 picture cuts per 15-frame beat
  assert.equal(flat4.audio.length, 3); assert.ok(Math.abs(flat4.audio[1] - 0.5) < 1e-9);               // the music: a beat every 0.5 s, 2 beats for 8 cuts
  h.$('multSelect').value = '1'; h.run('updateTempo()');
  const flat1 = JSON.parse(JSON.stringify(h.run('rhythmFor(8)')));
  assert.ok(Math.abs(flat1.pic[1] - 15) < 1e-9);
  assert.deepEqual(flat1.audio.slice(0, 3), flat4.audio.slice(0, 3));                                   // same beat grid whatever the multiple
  h.$('rhythmSelect').value = 'variable'; h.$('startMsRange').value = '300'; h.$('endMsRange').value = '300'; h.$('multSelect').value = '3'; h.run('updateRhythm(); updateTempo()');
  const v = JSON.parse(JSON.stringify(h.run('rhythmFor(8)')));
  assert.ok(Math.abs(v.pic[1] - 3) < 1e-9);                                                             // 300 ms base cut / 3
  assert.ok(Math.abs(v.audio[1] - 0.3) < 1e-9);
});

// ---------- extremes: the page's rhythm in every combination ----------

function clean(v) { return JSON.parse(JSON.stringify(v)); }

test('rhythmFor is a clean timeline for every tempo, multiple, invert mode and number of images, in both speed modes', async () => {
  for (const nImages of [0, 1, 2, 9, 133, 500]) {
    const r = baseRoutes();
    r['/api/state'] = { plates: Array.from({ length: nImages }, (_, i) => mkPlate('p' + i)) };
    const h = load({ routes: r });
    await settle(); await settle();
    for (const variable of [false, true]) for (const invert of ['off', 'mono', 'colour']) for (const bpm of [60, 136, 250, 500]) for (const mult of ['0.25', '1', '1.3333333', '4', '9']) {
      h.$('rhythmSelect').value = variable ? 'variable' : 'flat'; h.$('invertSelect').value = invert; h.$('bpmInput').value = String(bpm); h.$('multSelect').value = mult;
      h.$('startMsRange').value = '50'; h.$('endMsRange').value = '1000'; h.$('rampRange').value = '60'; h.$('atSelect').value = variable && bpm === 136 ? 'start' : 'end';
      h.run('updateTempo(); updateRhythm()');
      const n = nImages * (invert === 'off' ? 1 : 2);
      const t = clean(h.run(`rhythmFor(${nImages})`));
      const label = `${nImages} images, ${variable ? 'variable' : 'flat'}, ${invert}, ${bpm}, x${mult}`;
      assert.equal(t.pic.length, n + 1, label);
      assert.equal(t.pic[0], 0, label);
      assert.ok(t.pic.every((v, i) => Number.isFinite(v) && (i === 0 || v - t.pic[i - 1] >= 1 - 1e-9)), `${label}: increasing, at least a frame a cut`);
      assert.ok(t.audio.length >= 2 && t.audio.every((v, i) => Number.isFinite(v) && (i === 0 || (nImages ? v > t.audio[i - 1] : v >= t.audio[i - 1]))), `${label}: the music's cuts increase`);
      if (nImages) assert.ok(Math.abs(t.audio[t.audio.length - 1] - t.end / 30) < 1e-9, `${label}: the music ends with the picture`);
      assert.ok(Number.isFinite(t.landAt) && t.landAt >= 0 && t.landAt <= t.end / 30 + 1e-9, `${label}: landing inside the clip`);
    }
  }
});

test('with no images nothing plays, nothing throws, and the info line is empty', async () => {
  const h = load({ routes: baseRoutes() });                                  // baseRoutes has no plates in the grid for the player
  await settle(); await settle();
  h.run('drawInfo()');
  h.$('musicSelect').value = 'on';
  assert.doesNotThrow(() => h.run('togglePlay(); togglePlay(); restartPlay(); restartPlay()'));
  assert.doesNotThrow(() => h.run('syncRampRange(); updateRhythm(); updateTempo(); updateMusic()'));
});

test('extreme slider values keep the labels and the ranges sane', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a')] };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('rampRange').value = '999'; h.$('invertSelect').value = 'off'; h.run('updateRhythm()');
  assert.equal(h.$('rampRange').max, '2');                                    // one image: at least 2 so the slider still has a range
  assert.equal(h.$('rampRange').value, '2');
  h.$('bpmInput').value = '500'; h.$('multSelect').value = '9'; h.run('updateTempo()');
  assert.equal(h.run('framesPerCut'), 1);                                     // 1800 / (500 * 9) is below a frame: never below one
});

test('changing the Multiple while playing asks the sound for an update, from where the picture is, with the same beat grid', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 12 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('stageImg').style.display = 'block';
  h.$('musicSelect').value = 'on'; h.$('bpmInput').value = '120'; h.$('multSelect').value = '1'; h.run('updateTempo()');
  h.run('togglePlay()');
  await settle(); await settle();
  h.run('cutPos = 30');
  const before = h.ctx.__drone.updates.length;
  h.$('multSelect').value = '4'; h.run('updateTempo()');
  assert.equal(h.ctx.__drone.updates.length, before + 1);
  const u = h.ctx.__drone.updates[before];
  assert.ok(Math.abs(u.offset - 1) < 1e-9);                                  // the clip position is kept: 30 frames = 1 s
  const grid = clean(u.starts);
  assert.ok(Math.abs(grid[1] - 0.5) < 1e-9 && Math.abs(grid[2] - 1) < 1e-9);  // beats every 0.5 s at 120 BPM, whatever the multiple
});

test('the tempo slider is 1 to 500 BPM, and whatever it holds is kept inside that', () => {
  const { run, $, store } = load({ routes: baseRoutes() });
  $('multSelect').value = '1';
  for (const [typed, bpm] of [['0', 1], ['-50', 1], ['500', 500], ['999', 500], ['12.5', 12.5], ['', 120], ['abc', 120], ['  90 ', 90], ['1e2', 100]]) {
    $('bpmInput').value = typed; run('updateTempo()');
    assert.equal(run('bpmValue()'), bpm, `value "${typed}"`);
    assert.equal(run('framesPerCut'), Math.max(1, 1800 / bpm), `value "${typed}"`);
    assert.equal($('bpmVal').textContent, `${Math.round(bpm)} BPM`);
    const t = JSON.parse(JSON.stringify(run('rhythmFor(3)')));
    assert.ok(t.pic.every(Number.isFinite) && t.audio.every(Number.isFinite), `value "${typed}"`);
  }
  assert.equal(JSON.parse(store.studioSettings).bpmInput, '1e2');
});

test('the check "The Multiple also changes the music" puts the music on the picture cuts; unchecked it stays on the beat', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 8 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('bpmInput').value = '120'; h.$('multSelect').value = '4'; h.run('updateTempo()');
  const beat = JSON.parse(JSON.stringify(h.run('rhythmFor(8)')));
  assert.equal(beat.audio.length, 3);                                         // 2 beats for 8 picture cuts
  h.$('followCuts').checked = true; h.run('updateTempo()');
  const follow = JSON.parse(JSON.stringify(h.run('rhythmFor(8)')));
  assert.equal(follow.audio.length, 9);                                       // every picture cut
  assert.ok(follow.audio.every((v, i) => Math.abs(v - follow.pic[i] / 30) < 1e-9));
  assert.deepEqual(follow.pic, beat.pic);                                     // the pictures do not change
  assert.equal(JSON.parse(h.store.studioSettings).followCuts !== undefined, true);
  h.$('followCuts').checked = false; h.run('updateTempo()');
  assert.equal(JSON.parse(JSON.stringify(h.run('rhythmFor(8)'))).audio.length, 3);
});

test('turning "The Multiple also changes the music" on or off while playing swaps the music from where the picture is', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 12 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('stageImg').style.display = 'block';
  h.$('musicSelect').value = 'on'; h.$('multSelect').value = '2'; h.run('updateTempo()'); h.run('togglePlay()');
  await settle(); await settle();
  h.run('cutPos = 15');
  const before = h.ctx.__drone.updates.length;
  h.$('followCuts').checked = true; h.run('updateTempo()');
  assert.equal(h.ctx.__drone.updates.length, before + 1);
  assert.ok(Math.abs(h.ctx.__drone.updates[before].offset - 0.5) < 1e-9);
  assert.equal(h.ctx.__drone.updates[before].starts.length, 13);              // 12 picture cuts + the end
});

test('Random video: every draw is a valid speed and look inside the slider ranges, and Undo brings the old settings back', async () => {
  const h = await playerWith();
  h.$('bpmInput').value = '77'; h.$('rhythmSelect').value = 'flat'; h.$('invertSelect').value = 'colour'; h.run('updateTempo(); updateRhythm()');
  const seen = { flat: 0, variable: 0 };
  for (let i = 0; i < 300; i++) {
    h.run('randomVideo()');
    const mode = h.$('rhythmSelect').value; seen[mode]++;
    if (mode === 'flat') { const b = +h.$('bpmInput').value; assert.ok(b >= 60 && b <= 200, `tempo ${b}`); }
    else {
      const s = +h.$('startMsRange').value, e = +h.$('endMsRange').value, r = +h.$('rampRange').value;
      assert.ok(s >= 60 && s <= 900 && e >= 60 && e <= 900 && r >= 2 && r <= 20, `variable ${s} ${e} ${r}`);
      assert.ok(['end', 'start'].includes(h.$('atSelect').value));
    }
    assert.ok(['off', 'mono', 'colour'].includes(h.$('invertSelect').value) && ['off', 'out', 'in'].includes(h.$('zoomSelect').value));
    const z = +h.$('zoomAmt').value; assert.ok(z >= 0.2 && z <= 3, `zoom ${z}`);
    assert.ok(Number.isFinite(h.run('framesPerCut')) && h.run('framesPerCut') >= 1);
  }
  assert.ok(seen.flat > 60 && seen.variable > 60, `both speeds come up (${JSON.stringify(seen)})`);
  h.$('bpmInput').value = '77'; h.$('rhythmSelect').value = 'flat'; h.$('invertSelect').value = 'colour'; h.$('multSelect').value = '2';
  h.run('commitSettings(); history.length = 0');                                   // the hand-set values are a step of their own (the 300 draws filled the history: start clean)
  const n = h.run('history.length');
  h.run('randomVideo()');
  assert.equal(h.$('undoRandomBtn').disabled, false);
  assert.equal(h.run('history.length'), n + 1, 'one Random, one step');
  h.run('undoRandom()'); await settle();
  assert.deepEqual([h.$('bpmInput').value, h.$('rhythmSelect').value, h.$('invertSelect').value, h.$('multSelect').value], ['77', 'flat', 'colour', '2']);
  assert.equal(h.run('history.length'), n);
  h.run('history.length = 0; showUndo()');
  assert.equal(h.$('undoRandomBtn').disabled, true, 'nothing left: the button is off');
  assert.doesNotThrow(() => h.run('undoRandom()'));                                 // nothing left to undo
});

test('Random turns the sound on, rolls inside the type (Any: anything), and the parts agree', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'off';
  const n = id => +h.$(id).value;
  const R = h.run('RANDOM_RANGES');
  const types = ['any', ...Object.keys(JSON.parse(JSON.stringify(h.run('CHARACTERS'))))];
  assert.equal(types.length, 9, 'Any and eight types');
  for (let i = 0; i < 450; i++) {
    h.$('characterSelect').value = types[i % types.length];
    h.run('randomAll()');
    assert.equal(h.$('musicSelect').value, 'on');
    for (const [k, [lo, hi]] of Object.entries(JSON.parse(JSON.stringify(R)))) {
      const v = n(`${k}Range`);
      assert.ok(v === 0 || (v >= lo && v <= hi), `${k} ${v} stays inside what keeps it a dark, heavy drone`);
    }
    const rate = h.run('rhythmCutsPerSecond()');
    const textures = ['echoRange', 'washRange', 'ringRange', 'shimmerRange'].filter(id => n(id) > 0).length;
    assert.ok(textures <= 2, 'two textures at most');
    assert.ok(n('arpRange') === 0 || n('arpRange') >= 20, 'an arpeggio is on properly or off');
    if (n('dynSelect') === 3) assert.equal(h.$('rhythmSelect').value, 'variable', 'Follows the speed only with a speed that changes');
    if (n('brightRange') > 45) assert.ok(n('ringRange') <= 20 && n('shimmerRange') <= 20, 'bright plus metal is held back');
    if (n('pitchRange') > 60) assert.ok(n('subWaveSelect') !== 2 && n('ringRange') <= 20, 'a high root keeps its weight');
    if (rate > 6) assert.equal(n('echoRange'), 0);
    if (rate <= 1.5) { assert.ok(n('arpRateSelect') >= 2 && n('hitOnSelect') === 0 && n('spaceRange') >= 40, 'slow cuts: busier notes, every-cut hits, a big room'); }
    if (rate >= 4) { assert.ok(n('arpRateSelect') <= 1 && n('hitOnSelect') > 0 && n('spaceRange') <= 50 && n('echoRange') <= 20, 'fast cuts: sparse notes and hits, a drier room'); }
  }
  const before = JSON.stringify(h.run('settingsSnap()'));
  h.run('randomAll()'); h.run('undoRandom()'); await settle();                       // one step back covers both halves
  assert.equal(JSON.stringify(h.run('settingsSnap()')), before);
  assert.equal(h.run('future.length'), 1, 'and it can be redone');
  h.run('redoLast()'); await settle();
  assert.notEqual(JSON.stringify(h.run('settingsSnap()')), before);
});

test('each character keeps the rhythm and the look inside its own kind of film', async () => {
  const h = await playerWith();
  const C = JSON.parse(JSON.stringify(h.run('CHARACTERS')));
  for (const [key, c] of Object.entries(C)) {
    for (let i = 0; i < 60; i++) {
      h.$('characterSelect').value = key;
      assert.equal(h.run('randomAll()'), key, 'Random stays inside the type chosen');
      assert.equal(h.$('rhythmSelect').value, c.rhythm.mode, key);
      if (c.rhythm.mode === 'flat') { const b = +h.$('bpmInput').value; assert.ok(b >= c.rhythm.bpm[0] && b <= c.rhythm.bpm[1], `${key} tempo ${b}`); }
      else {
        const st = +h.$('startMsRange').value, en = +h.$('endMsRange').value;
        assert.ok(st >= c.rhythm.start[0] - 5 && st <= c.rhythm.start[1] + 5 && en >= c.rhythm.end[0] - 5 && en <= c.rhythm.end[1] + 5, `${key} ${st} → ${en}`);
        assert.ok([].concat(c.rhythm.at).includes(h.$('atSelect').value));
      }
      assert.ok(c.rhythm.mult.includes(h.$('multSelect').value), `${key} multiple`);
      assert.ok(c.look.invert.includes(h.$('invertSelect').value) && c.look.zoom.includes(h.$('zoomSelect').value), `${key} look`);
      assert.ok(c.sound.chord.includes(h.$('chordSelect').value) && (c.sound.hitType.includes(h.$('hitTypeSelect').value) || +h.$('industrialRange').value > 0), `${key} sound`);
    }
  }
  // choosing a character in the menu rolls at once, and can be undone
  h.$('characterSelect').value = 'float'; h.run('pickCharacter()');
  assert.equal(h.$('rhythmSelect').value, 'flat'); assert.ok(+h.$('bpmInput').value <= 80);
  assert.equal(h.$('undoRandomBtn').disabled, false);
});

test('Type Any: Random makes anything (both speeds, every look, the music check now and then); multiples stay modest; the type is kept by Undo', async () => {
  const h = await playerWith();
  h.$('characterSelect').value = 'any';
  const seen = { flat: 0, variable: 0, zoom: new Set(), invert: new Set(), follow: 0, mults: [] };
  for (let i = 0; i < 400; i++) {
    assert.equal(h.run('randomAll()'), 'any');
    seen[h.$('rhythmSelect').value]++; seen.zoom.add(h.$('zoomSelect').value); seen.invert.add(h.$('invertSelect').value);
    if (h.$('followCuts').checked) seen.follow++;
    seen.mults.push(+h.$('multSelect').value);
  }
  assert.ok(seen.variable > 100 && seen.flat > 100, `both speeds come up (${seen.flat} flat, ${seen.variable} variable)`);
  assert.deepEqual([...seen.zoom].sort(), ['in', 'off', 'out']); assert.deepEqual([...seen.invert].sort(), ['colour', 'mono', 'off']);
  assert.ok(seen.follow > 30 && seen.follow < 150, `the music check is rolled too (${seen.follow} of 400)`);
  assert.ok(seen.mults.every(m => m <= 4) && seen.mults.filter(m => m <= 2).length > 250, 'mostly ×1 or ×2, never above ×4');
  const mults = [];
  for (const k of Object.keys(JSON.parse(JSON.stringify(h.run('CHARACTERS'))))) { h.$('characterSelect').value = k; for (let i = 0; i < 40; i++) { h.run('randomAll()'); mults.push(+h.$('multSelect').value); } }
  assert.ok(mults.every(m => m <= 4), 'no type goes above ×4');
  h.$('characterSelect').value = 'landing'; h.run('randomAll()'); h.run('undoRandom()');
  assert.equal(h.$('characterSelect').value, 'landing', 'Undo changes the settings, not the type');
});

test('the sound is matched to the speed: very fast cuts thin the notes, slow cuts fill them', async () => {
  const h = await playerWith();
  const n = id => +h.$(id).value;
  h.$('rhythmSelect').value = 'flat'; h.$('bpmInput').value = '300'; h.$('followCuts').checked = false; h.run('updateTempo(); updateRhythm()');
  h.$('arpRateSelect').value = '3'; h.$('hitOnSelect').value = '0'; h.$('spaceRange').value = '80'; h.$('echoRange').value = '50';
  h.run('matchSoundToSpeed(); soundRules()');
  assert.ok(n('arpRateSelect') <= 1 && n('hitOnSelect') > 0 && n('spaceRange') === 50 && n('echoRange') <= 20);
  h.$('bpmInput').value = '60'; h.run('updateTempo()');
  h.$('arpRateSelect').value = '0'; h.$('hitOnSelect').value = '2'; h.$('spaceRange').value = '10';
  h.run('matchSoundToSpeed()');
  assert.ok(n('arpRateSelect') >= 2 && n('hitOnSelect') === 0 && n('spaceRange') === 40);
});

test('Random sound alone leaves the speed and the effects untouched', async () => {
  const h = await playerWith();
  const before = [h.$('rhythmSelect').value, h.$('bpmInput').value, h.$('multSelect').value, h.$('invertSelect').value, h.$('zoomSelect').value];
  for (let i = 0; i < 20; i++) h.run('randomMusic()');
  assert.deepEqual([h.$('rhythmSelect').value, h.$('bpmInput').value, h.$('multSelect').value, h.$('invertSelect').value, h.$('zoomSelect').value], before);
});

test('Choir and Industrial: layers over the drone that Random adds now and then, one at a time, with room around them; remembered and sent', async () => {
  const h = await playerWith();
  const n = id => +h.$(id).value;
  const seen = { none: 0, choir: 0, industrial: 0 };
  const check = (why) => {
    const c = n('choirRange'), m = n('industrialRange');
    assert.ok(!(c && m), `${why}: never both`);
    if (c || m) {
      assert.ok(['echoRange', 'washRange', 'ringRange', 'shimmerRange'].filter(id => n(id) > 0).length <= 1, `${why}: one texture at most beside a layer`);
      if (c) assert.ok(n('arpRange') <= 30, `${why}: no busy arpeggio under the voices`);
      if (m) assert.equal(n('hitTypeSelect'), 0, `${why}: the bursts are the hits`);
    }
    seen[c ? 'choir' : m ? 'industrial' : 'none']++;
  };
  const tempo = bpm => { h.$('rhythmSelect').value = 'flat'; h.$('bpmInput').value = String(bpm); h.$('bpmLock').checked = true; };
  tempo(60);                                                                       // slow cuts: room for voices
  for (let i = 0; i < 600; i++) { h.run('randomMusic()'); check('Random sound, slow'); }
  const slow = { ...seen };
  assert.ok(slow.choir > 3 * slow.industrial && slow.industrial > 0, `slow cuts: mostly the choir: ${JSON.stringify(slow)}`);
  assert.ok(slow.none > 0.55 * 600, `the plain drone most of the time: ${JSON.stringify(slow)}`);
  for (const k in seen) seen[k] = 0;
  tempo(240);                                                                      // fast cuts: metal, the choir rarely
  for (let i = 0; i < 600; i++) { h.run('randomMusic()'); check('Random sound, fast'); }
  assert.ok(seen.industrial > seen.choir && seen.choir > 0, `fast cuts: mostly metal: ${JSON.stringify(seen)}`);
  tempo(420);
  for (let i = 0; i < 200; i++) { h.run('randomMusic()'); assert.equal(+h.$('choirRange').value, 0, 'no voices over a strobe'); }
  h.$('bpmLock').checked = false;
  const types = JSON.parse(JSON.stringify(h.run('CHARACTERS')));
  for (const [key, c] of Object.entries(types)) {
    h.$('characterSelect').value = key;
    for (let i = 0; i < 40; i++) {
      h.run('randomAll()'); check(key);
      for (const k of ['choir', 'industrial']) if (n(`${k}Range`)) assert.ok(c.sound.layer[k], `${key} only carries its own layer, not ${k}`);
    }
  }
  h.$('choirRange').value = '40';
  h.run('updateMusic()');
  assert.equal(h.run('synthParams()').choir, 0.4);
  h.run('saveSettings()');
  assert.equal(JSON.parse(h.store.studioSettings).choirRange, '40', 'remembered');
});

test('the logo target: one switch for the Film preview and every Curate card (T or either button), remembered', async () => {
  const h = load({ routes: baseRoutes() });
  await settle();
  const state = () => [h.$('reticle').classList.contains('visible'), h.ctx.document.body.classList.contains('target-on'), h.$('targetBtn').getAttribute('aria-pressed'), h.$('gridTargetBtn').getAttribute('aria-pressed')];
  assert.deepEqual(state().slice(0, 2), [false, false], 'off at first');
  h.run('toggleReticle()');                                                          // the Curate button
  assert.deepEqual(state(), [true, true, 'true', 'true'], 'on in both modes at once');
  assert.equal(h.store.studioTarget, '1');
  h.ctx.onKey({ key: 't', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.deepEqual(state(), [false, false, 'false', 'false'], 'T turns it off everywhere');
  const again = load({ routes: baseRoutes(), storage: { studioTarget: '1' } });
  await settle();
  assert.equal(again.ctx.document.body.classList.contains('target-on'), true, 'on again after a reload');
  assert.equal(again.$('gridTargetBtn').getAttribute('aria-pressed'), 'true');
});

test('arpeggio moods: Random draws them all (Pluck often), a type keeps to its own, Phase unhurried', async () => {
  const h = await playerWith();
  const n = id => +h.$(id).value;
  const seen = [0, 0, 0, 0, 0, 0, 0];
  const rules = why => {
    if ([2, 6].includes(n('arpMoodSelect')) && h.run('rhythmCutsPerSecond()') > 2.5) assert.ok(n('arpRateSelect') <= 1, `${why}: Phase and Acid on fast cuts play a note a cut at most`);
    if (n('choirRange') > 0) assert.ok(![0, 1, 6].includes(n('arpMoodSelect')) && n('padRange') <= 35, `${why}: under the choir, no Pluck, Dark or Acid, and a quieter pad`);
  };
  for (let i = 0; i < 800; i++) { h.run('randomMusic()'); seen[n('arpMoodSelect')]++; rules('Random sound'); }
  assert.ok(seen.every(c => c > 25), `every mood comes up: ${seen}`);
  assert.ok(seen[0] > 0.18 * 800, `Pluck, the first arpeggio, often (the choir trades Pluck and Dark for the soft moods): ${seen}`);
  const types = JSON.parse(JSON.stringify(h.run('CHARACTERS')));
  for (const [key, c] of Object.entries(types)) {
    h.$('characterSelect').value = key;
    for (let i = 0; i < 30; i++) {
      h.run('randomAll()'); rules(key);
      if (!n('choirRange')) assert.ok(c.sound.mood.includes(h.$('arpMoodSelect').value), `${key}: mood ${h.$('arpMoodSelect').value}`);
    }
  }
  h.$('arpMoodSelect').value = '3'; h.run('updateMusic()');
  assert.equal(h.run('synthParams()').arpMood, 3);
  h.run('saveSettings()');
  assert.equal(JSON.parse(h.store.studioSettings).arpMoodSelect, '3', 'remembered');
});

test('chord changes: Random turns them on now and then, each chord 1 to 4 seconds long whatever the speed; sent and remembered', async () => {
  const h = await playerWith();
  const n = id => +h.$(id).value;
  const tempo = bpm => { h.$('rhythmSelect').value = 'flat'; h.$('bpmInput').value = String(bpm); h.$('bpmLock').checked = true; };
  for (const [bpm, allowed] of [[60, [0, 1]], [160, [0, 1, 2]], [480, [2, 3]]]) {  // 1, 2.7 and 8 cuts a second: 1-4 s a chord in whole cut counts
    tempo(bpm); let on = 0; const seen = new Set();
    for (let i = 0; i < 300; i++) { h.run('randomMusic()'); if (n('progSelect')) { on++; seen.add(n('progEverySelect')); assert.ok(allowed.includes(n('progEverySelect')), `${bpm} BPM: every ${n('progEverySelect')}`); } }
    assert.ok(on > 70 && on < 140, `now and then: ${on} of 300`);
    assert.ok(seen.size >= 2, `${bpm} BPM: the pace varies: ${[...seen]}`);
  }
  h.$('bpmLock').checked = false;
  h.$('progSelect').value = '1'; h.$('progEverySelect').value = '2'; h.run('updateMusic()');
  assert.deepEqual([h.run('synthParams()').prog, h.run('synthParams()').progEvery], [1, 2]);
  h.run('saveSettings()');
  assert.equal(JSON.parse(h.store.studioSettings).progSelect, '1');
});

test('bassline and arrangement: Random brings them in by type, an arrangement always has layers to move, Follows needs a changing speed; sent', async () => {
  const h = await playerWith();
  const n = id => +h.$(id).value;
  const types = JSON.parse(JSON.stringify(h.run('CHARACTERS')));
  for (const key of ['any', ...Object.keys(types)]) {
    h.$('characterSelect').value = key; let bass = 0;
    for (let i = 0; i < 60; i++) {
      h.run('randomAll()');
      if (n('bassRange')) bass++;
      if (n('arrangeSelect')) assert.ok([n('arpRange'), n('bassRange'), n('hitTypeSelect')].filter(Boolean).length >= 2, `${key}: an arrangement has at least two layers to move`);
      if (n('arrangeSelect') === 3) assert.equal(h.$('rhythmSelect').value, 'variable', `${key}: Follows the speed only on a changing speed`);
      if (h.run('rhythmCutsPerSecond()') > 5) assert.equal(n('bassRateSelect'), 0, `${key}: fast cuts, a bass note a cut`);
      if (types[key]) assert.ok(types[key].sound.shape.arrange.includes(h.$('arrangeSelect').value) || (h.$('arrangeSelect').value === '1' && types[key].sound.shape.arrange.includes('3')), `${key}: arrangement ${h.$('arrangeSelect').value}`);
    }
    if (types[key] && types[key].sound.shape.bass >= 0.7) assert.ok(bass > 30, `${key}: mostly a bassline (${bass} of 60)`);
  }
  h.$('bassRange').value = '50'; h.$('bassPatternSelect').value = '3'; h.$('arrangeSelect').value = '2'; h.run('updateMusic()');
  const p = h.run('synthParams()');
  assert.deepEqual([p.bass, p.bassPattern, p.arrange], [0.5, 3, 2]);
});

test('pad and tape: Random keeps the pad modest and, when both come, keeps both low', async () => {
  const h = await playerWith();
  const n = id => +h.$(id).value;
  for (let i = 0; i < 400; i++) {
    h.run(i % 2 ? 'randomMusic()' : 'randomAll()');
    assert.ok(n('padRange') <= 45 && n('tapeRange') <= 45, `modest: pad ${n('padRange')}, tape ${n('tapeRange')}`);
    if (n('padRange') && n('tapeRange')) assert.ok(n('padRange') <= 30 && n('tapeRange') <= 25, 'together, both low');
  }
});

test('Curate and Film: the mode switch is remembered, and Tab / Space work except while typing', async () => {
  const h = await playerWith();
  assert.equal(h.ctx.document.body.dataset.mode, 'curate');                        // a first visit opens on the images
  h.run("setMode('film')");
  assert.equal(h.ctx.document.body.dataset.mode, 'film');
  assert.equal(h.$('modeFilm').getAttribute('aria-pressed'), 'true');
  assert.equal(h.store.studioMode, 'film');
  let prevented = 0;
  const key = (k, target = { tagName: 'BODY' }) => h.ctx.onKey({ key: k, target, preventDefault: () => { prevented++; } });
  key('Tab');
  assert.equal(h.ctx.document.body.dataset.mode, 'curate');
  key('Tab', { tagName: 'BUTTON', blur() {} });                                     // a focused button does not keep Tab
  assert.equal(h.ctx.document.body.dataset.mode, 'film');
  key('Tab', { tagName: 'INPUT', type: 'text' });                                   // typing: Tab moves between fields
  key('Tab', { tagName: 'SELECT' });
  assert.equal(h.ctx.document.body.dataset.mode, 'film');
  key(' ');
  assert.equal(h.run('isPlaying'), true);
  key(' ', { tagName: 'INPUT', type: 'text' });
  assert.equal(h.run('isPlaying'), true, 'a space typed in a field is a space');
  key(' ', { tagName: 'INPUT', type: 'range' });
  assert.equal(h.run('isPlaying'), false, 'a slider with focus does not swallow Space');
  assert.equal(prevented, 4);
  h.$('confirmModal').classList.add('open');
  key('Tab');
  assert.equal(h.ctx.document.body.dataset.mode, 'film', 'nothing switches under a confirmation');
  const again = load({ routes: baseRoutes(), storage: { studioMode: 'film' } });
  assert.equal(again.ctx.document.body.dataset.mode, 'film');
});

test('the film strip and Curate clicks put the playhead on an image, and the drone follows while playing', async () => {
  const h = await playerWith();
  h.$('invertSelect').value = 'mono'; h.run('updateFx()');
  h.run("jumpToPlate(2)");
  const pic = h.run('timelineFor(3)');
  assert.equal(h.run('cutPos'), pic[4]);                                           // image 3 starts at cut 5 when every image has its inverted copy
  assert.equal(h.run('currentIdx'), 2);
  assert.equal(h.$('stageImg').src, '/p/c');
  assert.match(h.$('timecode').innerHTML, /cut 5 \/ 6/);
  h.$('musicSelect').value = 'on'; h.run('updateMusic()');
  h.run('togglePlay()'); await settle();
  assert.ok(Math.abs(h.ctx.__drone.plays.at(-1).offset - pic[4] / 30) < 1e-9, 'Play carries on from the playhead');
  h.run("previewPlate('b')");
  assert.ok(Math.abs(h.ctx.__drone.seeks.at(-1) - pic[2] / 30) < 1e-9, 'the sound jumps with the picture');
  assert.equal(h.run('jumpToPlate(99), currentIdx'), 2, 'past the end: the last image');
  h.run('restartPlay()');
  assert.equal(h.run('cutPos'), 0);
});

test('trash the image on screen from the film strip, and Undo puts it back where it was', async () => {
  const r = baseRoutes();
  let st = [mkPlate('a'), mkPlate('b'), mkPlate('c')];
  r['/api/state'] = () => ({ plates: st });
  r['/api/trash'] = body => { st = st.map(p => (p.filename === body.filename ? { ...p, trashed: body.trashed } : p)); if (!body.trashed) { const p = st.find(x => x.filename === body.filename); st = st.filter(x => x !== p).concat([p]); } return { ok: true }; };
  r['/api/reorder'] = body => { st = body.order.map(f => st.find(p => p.filename === f)).concat(st.filter(p => !body.order.includes(p.filename))); return { ok: true }; };
  const h = load({ routes: r });
  await settle(); await settle();
  await h.run("setTrash({ stopPropagation() {} }, 'b', true)");
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['a', 'c']);
  assert.match(h.$('toast').textContent, /“b” moved to Trash/);
  const undo = h.$('toast').options.at(-1);                                         // the toast's action button
  assert.equal(undo.textContent, 'Undo');
  undo.onclick(); await settle(); await settle(); await settle();
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['a', 'b', 'c'], 'back in its place, not at the end');
});

test('one sound switch: Source (no second one in the transport), and the sound groups show one at a time', async () => {
  const h = await playerWith();
  assert.equal(h.$('synthBox').hidden, true); assert.equal(h.$('soundOffNote').hidden, false);
  h.$('musicSelect').value = 'on'; h.run('updateMusic()');
  assert.equal(h.$('synthBox').hidden, false); assert.equal(h.$('soundOffNote').hidden, true);
  assert.equal(h.run('typeof toggleSound'), 'undefined');
  h.run("showSoundGroup('notes')");
  assert.equal(h.$('groupNotes').hidden, false); assert.equal(h.$('groupBed').hidden, true);
  assert.equal(h.$('soundTabNotes').getAttribute('aria-selected'), 'true');
  h.run("showSoundGroup('nonsense')");
  assert.equal(h.$('groupBed').hidden, false);
});

test('the check "The Multiple also changes the music" is remembered (a checkbox saves its state, not its value)', async () => {
  const h = await playerWith();
  h.$('followCuts').type = 'checkbox'; h.$('followCuts').checked = true; h.run('updateTempo()');
  const saved = JSON.parse(h.store.studioSettings);
  assert.equal(saved.followCuts, true);
  const again = load({ routes: baseRoutes(), storage: { studioSettings: h.store.studioSettings } });
  again.$('followCuts').type = 'checkbox';
  again.run('restoreSettings()');
  assert.equal(again.$('followCuts').checked, true);
});

test('the frames readout next to the Multiple: one number for Flat, start → end for Variable', async () => {
  const h = await playerWith();
  h.$('bpmInput').value = '120'; h.$('multSelect').value = '2'; h.run('updateTempo()');
  assert.equal(h.$('speedVal').textContent, '7.5f');
  h.$('rhythmSelect').value = 'variable'; h.$('startMsRange').value = '100'; h.$('endMsRange').value = '600'; h.$('multSelect').value = '1'; h.run('updateTempo(); updateRhythm()');
  assert.equal(h.$('speedVal').textContent, '3→18f');
});

test('the rhythm strip is drawn from the real timeline: a tick per picture cut, the speed line, the band, the beats', async () => {
  const h = await playerWith();                                                  // 3 images, 120 BPM ×2
  const plain = o => JSON.parse(JSON.stringify(o));
  // Flat: even ticks, a flat line, a beat on every second picture cut, no band and no handles
  let m = plain(h.run('rhythmStripModel(3)'));
  const pic = plain(h.run('timelineFor(3)'));
  assert.equal(m.ticks.length, 3);
  assert.deepEqual(m.ticks.map(x => +x.toFixed(3)), pic.slice(0, -1).map(f => +((f / pic.at(-1)) * 1000).toFixed(3)));
  assert.ok(m.curve.every(([, y]) => y === 14), 'a flat speed is a flat line');
  assert.equal(m.band, null); assert.deepEqual(m.handles, []);
  assert.deepEqual(m.beats.map(Math.round), [0, 667], 'the music is on the beat: every second cut at ×2');
  assert.equal(m.beatText, 'Music on the beat · 120 BPM');
  h.$('followCuts').checked = true; h.run('updateTempo()');
  m = plain(h.run('rhythmStripModel(3)'));
  assert.equal(m.beats.length, 3); assert.equal(m.beatText, 'Music on every picture cut');
  h.$('followCuts').checked = false;
  // Variable with a landing: the last cuts are long (low on the line), the band covers the change, Start and End marked
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 24 }, (_, i) => mkPlate('p' + i)) };
  const v = load({ routes: r }); await settle(); await settle();
  v.$('rhythmSelect').value = 'variable'; v.$('startMsRange').value = '100'; v.$('endMsRange').value = '600'; v.$('rampRange').value = '8'; v.$('atSelect').value = 'end'; v.$('multSelect').value = '1';
  v.run('updateTempo(); updateRhythm()');
  m = plain(v.run('rhythmStripModel(24)'));
  const ys = m.curve.slice(1, -1).map(([, y]) => y);
  assert.ok(ys.slice(0, 16).every(y => Math.abs(y - 10) < 1e-6), 'the fast hold sits at the top');
  assert.ok(Math.abs(ys.at(-1) - 40) < 1e-6, 'the slowest cut at the bottom');
  for (let i = 16; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], 'it slows down cut after cut');
  const vpic = plain(v.run('timelineFor(24)'));
  assert.ok(Math.abs(m.band.left - (vpic[16] / vpic.at(-1)) * 100) < 1e-6 && Math.abs(m.band.left + m.band.width - 100) < 1e-6, 'the band starts where the change does');
  assert.equal(m.band.label, 'Landing · 8 cuts');
  assert.deepEqual(m.handles.map(x => x.label), ['Start 100 ms', 'End 600 ms']);
  assert.ok(Math.abs(m.handles[0].top - 10) < 1e-6 && Math.abs(m.handles[1].top - 40) < 1e-6);
  assert.match(m.beatText, /^Music on the run · 24 cuts$/);
  v.$('atSelect').value = 'start'; v.$('startMsRange').value = '600'; v.$('endMsRange').value = '100'; v.run('updateRhythm()');
  m = plain(v.run('rhythmStripModel(24)'));
  assert.equal(m.band.left, 0); assert.equal(m.band.label, 'Build-up · 8 cuts');
  // one frame a cut: flagged; no images: nothing to draw
  h.$('bpmInput').value = '500'; h.$('multSelect').value = '9'; h.run('updateTempo()');
  assert.equal(h.run('rhythmStripModel(3)').oneFrame, true);
  assert.equal(h.run('rhythmStripModel(0)'), null);
  // the axis is in seconds and ends inside the clip
  m = plain(v.run('rhythmStripModel(24)'));
  assert.equal(m.axis[0].text, '0 s'); assert.ok(m.axis.every(a => a.left >= 0 && a.left <= 100));
});

test('a click on the rhythm strip puts the playhead there, and the sound follows while playing', async () => {
  const h = await playerWith();
  h.$('rsBody').getBoundingClientRect = () => ({ left: 100, width: 400 });
  const total = h.run('timelineFor(3).at(-1)');
  h.run('rhythmStripClick({ clientX: 300 })');                                    // half way
  assert.ok(Math.abs(h.run('cutPos') - total / 2) < 1e-9);
  assert.equal(h.$('rsPlayhead').style.left, '50%');
  h.$('musicSelect').value = 'on'; h.run('updateMusic()'); h.run('togglePlay()'); await settle();
  h.run('rhythmStripClick({ clientX: 100 })');
  assert.equal(h.ctx.__drone.seeks.at(-1), 0);
  h.run('rhythmStripClick({ clientX: 9999 })');                                  // past the end: the last moment, never a wrap to the start
  assert.ok(h.run('cutPos') > total * 0.99);
});

test('paused, the timecode follows a tempo change at once (the length of the film changes)', async () => {
  const h = await playerWith();
  h.$('bpmInput').value = '60'; h.$('multSelect').value = '1'; h.run('updateTempo()');
  assert.match(h.$('timecode').innerHTML, /\/ 0:03\.0 · cut 1 \/ 3/);
  h.$('bpmInput').value = '120'; h.run('updateTempo()');
  assert.match(h.$('timecode').innerHTML, /\/ 0:01\.5 · cut 1 \/ 3/);
});

test('refresh: the buttons fetch at once and say what changed; by itself the page fetches only when the fingerprint moved, at most every 15 s', async () => {
  const r = baseRoutes();
  let st = { plates: [mkPlate('a'), mkPlate('b')], state_sig: 's1' };
  r['/api/state'] = () => st;
  const h = load({ routes: r });
  await settle(); await settle();
  const fetches = () => h.calls.filter(c => c.url === '/api/state').length;
  await h.run('refreshLibrary(true)');
  assert.match(h.$('toast').textContent, /Up to date/);
  st = { plates: [mkPlate('a'), mkPlate('b'), mkPlate('c')], state_sig: 's2' };
  await h.run('refreshLibrary(true)');
  assert.match(h.$('toast').textContent, /\+1 new image/);
  assert.equal(h.run('activePlates().length'), 3);
  assert.equal(h.$('refreshBtn').classList.contains('spinning'), false); assert.equal(h.$('refreshFilmBtn').classList.contains('spinning'), false);
  let n = fetches();
  h.run("libraryMoved('s2')"); await settle();
  assert.equal(fetches(), n, 'the same fingerprint: nothing to fetch');
  h.run('lastAutoRefresh = 0'); h.run("libraryMoved('s3')"); await settle(); await settle();
  assert.equal(fetches(), n + 1, 'it moved: one fetch');
  n = fetches();
  h.run("libraryMoved('s4')"); await settle();
  assert.equal(fetches(), n, 'not again within 15 s');
  h.run('lastAutoRefresh = 0; generating = true'); h.run("libraryMoved('s5')"); await settle();
  assert.equal(fetches(), n, 'a running batch refreshes as it goes: no extra fetch');
  h.run('generating = false');
});

test('refresh while playing: a longer or shorter film updates the sound, the same film leaves it alone', async () => {
  const r = baseRoutes();
  let st = { plates: [mkPlate('a'), mkPlate('b')], state_sig: 's1' };
  r['/api/state'] = () => st;
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('stageImg').style.display = 'block';
  h.$('musicSelect').value = 'on'; h.run('updateMusic()'); h.run('togglePlay()'); await settle();
  const u = h.ctx.__drone.updates.length;
  await h.run('refreshLibrary(true)');
  assert.equal(h.ctx.__drone.updates.length, u);
  st = { plates: [mkPlate('a'), mkPlate('b'), mkPlate('c')], state_sig: 's2' };
  await h.run('refreshLibrary(true)');
  assert.equal(h.ctx.__drone.updates.length, u + 1);
  assert.equal(h.ctx.__drone.updates.at(-1).starts.length, h.run('synthStartsSec().length'));
});

test('playing, the stage only switches to an image that is decoded; it decodes the next ones ahead; paused, it shows at once', async () => {
  const h = await playerWith();
  const pending = new Map();
  h.ctx.Image = class { set src(u) { this._src = u; } get src() { return this._src; } decode() { return new Promise(res => pending.set(this._src, res)); } };
  h.$('bpmInput').value = '60'; h.$('multSelect').value = '1'; h.run('updateTempo()');
  h.run('aheadFrom = -1; jumpToPlate(0)');                                         // paused: straight away, decoded or not
  assert.equal(h.$('stageImg').src, '/p/a');
  assert.ok(['/p/a', '/p/b', '/p/c'].every(u => pending.has(u)), 'the next images are decoding');
  h.run('isPlaying = true');
  h.run('cutPos = 30.5; drawFrame()');                                              // image 2 is due but not decoded yet
  assert.equal(h.$('stageImg').src, '/p/a', 'holds the last frame');
  assert.equal(h.run('stageStats().lateFrames'), 1);
  pending.get('/p/b')(); await settle();
  h.run('drawFrame()');
  assert.equal(h.$('stageImg').src, '/p/b', 'and switches as soon as it can paint');
  h.run('isPlaying = false');
});

test('keys: ← → step one image (wrapping), Delete never trashes, Cmd+Z undoes the last Random', async () => {
  const r = baseRoutes();
  let st = [mkPlate('a'), mkPlate('b'), mkPlate('c')];
  r['/api/state'] = () => ({ plates: st });
  r['/api/trash'] = body => { st = st.map(p => (p.filename === body.filename ? { ...p, trashed: body.trashed } : p)); return { ok: true }; };
  r['/api/reorder'] = () => ({ ok: true });
  const h = load({ routes: r });
  await settle(); await settle();
  const key = (k, extra = {}) => h.ctx.onKey({ key: k, target: { tagName: 'BODY' }, preventDefault() {}, ...extra });
  key('ArrowRight'); assert.equal(h.run('currentIdx'), 1);
  key('ArrowRight'); key('ArrowRight'); assert.equal(h.run('currentIdx'), 0, 'wraps to the first');
  key('ArrowLeft'); assert.equal(h.run('currentIdx'), 2);
  h.ctx.onKey({ key: 'ArrowLeft', target: { tagName: 'INPUT', type: 'text' }, preventDefault() {} });
  assert.equal(h.run('currentIdx'), 2, 'in a text field the arrows move the caret');
  for (const mode of ['curate', 'film']) {                                          // no key trashes: images go to the Trash by hand, in Curate
    h.run(`setMode('${mode}')`);
    key('Delete'); key('Backspace'); await settle();
  }
  assert.equal(h.calls.filter(c => c.url === '/api/trash').length, 0, 'Delete and Backspace never trash');
  const snap = () => ['rhythmSelect', 'bpmInput', 'startMsRange', 'multSelect', 'invertSelect', 'zoomSelect', 'pulseRange', 'chordSelect', 'seedVal', 'musicSelect'].map(id => h.$(id).value).join('|');
  const before = snap();
  h.run('randomAll()');
  assert.notEqual(snap(), before);
  key('z', { ctrlKey: true });
  assert.equal(snap(), before, 'Ctrl+Z undoes a Random');
  key('z', { metaKey: true });                                                     // nothing left: harmless
});

test('the inner point of the rhythm strip sets Change over when dragged sideways, snapping to the cuts of the run', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 24 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r }); await settle(); await settle();
  h.$('rhythmSelect').value = 'variable'; h.$('startMsRange').value = '100'; h.$('endMsRange').value = '600'; h.$('rampRange').value = '8'; h.$('atSelect').value = 'end'; h.$('multSelect').value = '1';
  h.run('updateTempo(); updateRhythm()');
  assert.equal(h.$('rsH0').classList.contains('inner'), true, 'landing: the Start point is the one to drag');
  assert.equal(h.$('rsH1').classList.contains('inner'), false);
  // wherever it is dropped, the point lands there: Change over is solved for that, since the change itself makes the film longer or shorter
  const pointAt = () => JSON.parse(JSON.stringify(h.run('rhythmStripModel(24)'))).band.left / 100;
  for (const u of [0.2, 0.35, 0.5, 0.7]) {
    h.$('rampRange').value = String(h.run(`rampAt(${u})`)); h.run('updateRhythm()');
    assert.ok(Math.abs(pointAt() - u) < 0.06, `dropped at ${u}, the point is at ${pointAt().toFixed(3)}`);
  }
  assert.equal(h.run('rampAt(-1)'), 24, 'all the way left: every cut');
  assert.equal(h.run('rampAt(2)'), 2, 'all the way right: the least there is');
  h.$('rsBody').getBoundingClientRect = () => ({ left: 0, width: 1000 });
  const target = { classList: h.$('rsH0').classList, setPointerCapture() {} };
  h.run('pointDown')({ currentTarget: target, preventDefault() {}, stopPropagation() {}, pointerId: 1 });
  h.run('pointMove')({ clientX: 500 });
  const k = h.$('rampRange').value;
  assert.equal(k, String(h.run('rampAt(0.5)')));
  assert.equal(h.run('rhythmStripModel(24)').band.label, `Landing · ${k} cuts`, 'the band follows while dragging');
  h.run('pointUp')();
  const before = h.run('cutPos');
  h.run('rhythmStripClick({ clientX: 10 })');
  assert.equal(h.run('cutPos'), before, 'letting go is not a click that jumps');
  h.$('atSelect').value = 'start'; h.$('startMsRange').value = '600'; h.$('endMsRange').value = '100'; h.run('updateRhythm()');
  assert.equal(h.$('rsH1').classList.contains('inner'), true, 'build-up: the End point is the one to drag');
  h.$('rampRange').value = String(h.run('rampAt(0.4)')); h.run('updateRhythm()');
  const m = JSON.parse(JSON.stringify(h.run('rhythmStripModel(24)')));
  assert.ok(Math.abs(m.band.width / 100 - 0.4) < 0.06, `build-up: the End point lands where it is dropped (${m.band.width})`);
});

test('the Start and End points say what the picture does: with a Multiple, the cut the picture really makes', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 24 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r }); await settle(); await settle();
  h.$('rhythmSelect').value = 'variable'; h.$('startMsRange').value = '840'; h.$('endMsRange').value = '110'; h.$('atSelect').value = 'start'; h.$('multSelect').value = '2';
  h.run('updateTempo(); updateRhythm()');
  const m = JSON.parse(JSON.stringify(h.run('rhythmStripModel(24)')));
  assert.deepEqual(m.handles.map(x => x.label), ['Start 420 ms', 'End 55 ms'], 'as in the line under the strip');
});

test('Export says how long it will take once it has seen one: the median of the last exports, per second of film', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a'), mkPlate('b'), mkPlate('c')] };
  r['/api/export-video'] = { ok: true, images: 3, seconds: 2, video_url: '/outputs/x.mp4', filename: 'x.mp4' };
  const h = load({ routes: r }); await settle(); await settle();
  h.$('bpmInput').value = '60'; h.$('multSelect').value = '1'; h.run('updateTempo()');
  assert.doesNotMatch(h.$('exportMeta').textContent, /to make/, 'no guess before the first export');
  h.run("localStorage.setItem('studioExportRates', JSON.stringify([2, 4, 3]))"); h.run('drawInfo()');
  assert.match(h.$('exportMeta').textContent, /about 9 s to make$/, '3 s of film × the median 3');
  let t = 1000; h.ctx.performance.now = () => (t += 6000);
  await h.run('exportVideo()');
  assert.equal(JSON.parse(h.store.studioExportRates).length, 4);
  h.run("localStorage.setItem('studioExportRates', 'nonsense')"); h.run('drawInfo()');
  assert.doesNotMatch(h.$('exportMeta').textContent, /to make/, 'a broken memory is ignored');
});

test('menu labels in the page are what they should be (a bulk edit once renamed the batch sizes)', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
  const opts = id => { const m = html.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`)); return [...m[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map(x => `${x[1]}=${x[2]}`); };
  assert.deepEqual(opts('batchCountSelect'), ['2=2 images', '4=4 images', '6=6 images', '8=8 images', '12=12 images', '16=16 images', '20=20 images']);
  assert.deepEqual(opts('multSelect'), ['0.25=×¼', '0.5=×½', '1=×1', '1.3333333=×1⅓', '2=×2', '3=×3', '4=×4', '6=×6', '8=×8', '9=×9']);
  assert.deepEqual(opts('atSelect'), ['end=Landing', 'start=Build-up']);
});

// ---- bugs found by the code review of the redesign (each test reproduces the reported steps) ----

test('review #1: Change over keeps its value across a reload and when the cut count dips (it was reset to 2 before the images loaded)', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 30 }, (_, i) => mkPlate('p' + i)) };
  const saved = JSON.stringify({ rhythmSelect: 'variable', rampRange: '20', multSelect: '1' });
  const h = load({ routes: r, storage: { studioSettings: saved } });
  await settle(); await settle();
  assert.equal(h.$('rampRange').value, '20');
  assert.equal(JSON.parse(h.store.studioSettings).rampRange, '20', 'and it is saved as 20');
  h.$('multSelect').value = '6'; h.run('updateTempo()');                            // 5 cuts of the run: the slider shows 5
  assert.equal(h.$('rampRange').value, '5');
  assert.equal(JSON.parse(h.store.studioSettings).rampRange, '20', 'but remembers 20');
  h.$('multSelect').value = '1'; h.run('updateTempo()');
  assert.equal(h.$('rampRange').value, '20', 'and goes back to it');
  h.$('rampRange').value = '9'; h.run('updateRhythm()');                            // a new value by hand is the new request
  h.$('multSelect').value = '6'; h.run('updateTempo()'); h.$('multSelect').value = '1'; h.run('updateTempo()');
  assert.equal(h.$('rampRange').value, '9');
});

test('review #2: trashing (or undoing a trash) while playing updates the sound to the new length', async () => {
  const r = baseRoutes();
  let st = [mkPlate('a'), mkPlate('b'), mkPlate('c')];
  r['/api/state'] = () => ({ plates: st });
  r['/api/trash'] = body => { st = st.map(p => (p.filename === body.filename ? { ...p, trashed: body.trashed } : p)); return { ok: true }; };
  r['/api/reorder'] = () => ({ ok: true });
  const h = load({ routes: r }); await settle(); await settle();
  h.$('stageImg').style.display = 'block';
  h.$('musicSelect').value = 'on'; h.run('updateMusic()'); h.run('togglePlay()'); await settle();
  const u = h.ctx.__drone.updates.length;
  await h.run("setTrash({ stopPropagation() {} }, activePlates()[currentIdx].filename, true)");
  assert.equal(h.ctx.__drone.updates.length, u + 1, 'the drone was told');
  assert.equal(h.ctx.__drone.updates.at(-1).starts.length, h.run('synthStartsSec().length'));
});

test('review #4: Undo of a trash puts the image back into the order as it is now (a drag made since is kept)', async () => {
  const r = baseRoutes();
  let st = [mkPlate('a'), mkPlate('b'), mkPlate('c'), mkPlate('d')];
  let seqs = [{ id: 'm', kind: 'manual', count: 4 }, { id: 'ai', kind: 'ai', count: 4 }], active = 'm';
  r['/api/state'] = () => ({ plates: st, sequences: seqs, active_sequence: active });
  r['/api/trash'] = body => { const p = st.find(x => x.filename === body.filename); st = st.filter(x => x !== p).concat([{ ...p, trashed: body.trashed }]); return { ok: true }; };
  r['/api/reorder'] = body => { st = body.order.map(f => st.find(p => p.filename === f)).concat(st.filter(p => !body.order.includes(p.filename))); return { ok: true }; };
  r['/api/sequence'] = body => { active = body.id; return { ok: true }; };
  const h = load({ routes: r }); await settle(); await settle();
  await h.run("setTrash({ stopPropagation() {} }, 'b', true)");
  st = [st[2], st[0], st[1], st[3]];                                               // a drag after the trash: d, a, c (+ b in the trash)
  await h.run('loadState()');
  h.ctx.onKey({ key: 'z', metaKey: true, target: { tagName: 'BODY' }, preventDefault() {} });
  await settle(); await settle(); await settle(); await settle();
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['d', 'b', 'a', 'c'], 'b goes back to place 2 of the order as it is now; the drag is kept');
});

test('review #6: an image that fails to load is asked for once, and never holds the film', async () => {
  const h = await playerWith();
  let made = 0;
  h.ctx.Image = class { constructor() { made++; } set src(u) { this._s = u; } get src() { return this._s; } decode() { return Promise.reject(new Error('404')); } };
  h.$('bpmInput').value = '60'; h.$('multSelect').value = '1'; h.run('updateTempo()');
  h.run('aheadFrom = -1; jumpToPlate(0)'); await settle();
  const after = made;
  h.run('isPlaying = true');
  for (let i = 0; i < 50; i++) h.run('cutPos = 30.5; drawFrame()');
  assert.equal(made, after, 'no new request on every tick');
  assert.equal(h.$('stageImg').src, '/p/b', 'not held forever: it moves on');
  h.run('isPlaying = false');
});

test('held keys act once; a slider with focus keeps its arrows', async () => {
  const h = await playerWith();
  h.run("setMode('film')");
  h.ctx.onKey({ key: 'Tab', repeat: true, target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(h.ctx.document.body.dataset.mode, 'film', 'a held Tab does not flicker the modes');
  const before = h.run('currentIdx');
  h.ctx.onKey({ key: 'ArrowRight', target: { tagName: 'INPUT', type: 'range' }, preventDefault() {} });
  assert.equal(h.run('currentIdx'), before);
});

test('keys: 0 / Home back to the start (playing stays playing), T the target, R Random, S Random sound (turns the sound on)', async () => {
  const h = await playerWith();
  const key = k => h.ctx.onKey({ key: k, target: { tagName: 'BODY' }, preventDefault() {} });
  h.run('jumpToPlate(2)');
  key('0'); assert.equal(h.run('cutPos'), 0); assert.equal(h.run('currentIdx'), 0); assert.equal(h.run('isPlaying'), false, 'paused stays paused');
  h.$('musicSelect').value = 'on'; h.run('updateMusic()'); h.run('togglePlay()'); await settle();
  h.run('jumpToPlate(2)'); const restarts = h.ctx.__drone.restarts || 0;
  key('Home'); assert.equal(h.run('cutPos'), 0); assert.equal(h.run('isPlaying'), true);
  assert.equal(h.ctx.__drone.restarts, restarts + 1, 'the sound starts again too');
  h.run('togglePlay()');
  key('t'); assert.equal(h.$('reticle').classList.contains('visible'), true);
  key('T'); assert.equal(h.$('reticle').classList.contains('visible'), false);
  const snap = () => ['rhythmSelect', 'bpmInput', 'invertSelect', 'zoomSelect', 'seedVal'].map(id => h.$(id).value).join();
  h.run('jumpToPlate(2)');
  let a = snap(); key('r'); assert.notEqual(snap(), a, 'R rolls everything');
  assert.equal(h.run('cutPos'), 0, 'and starts the new film from its beginning');
  assert.equal(h.$('randomAllBtn').classList.contains('flash'), true, 'the Random button flashes');
  h.$('musicSelect').value = 'off'; h.run('updateMusic()');
  a = ['rhythmSelect', 'bpmInput', 'invertSelect'].map(id => h.$(id).value).join(); const seed = h.$('seedVal').value;
  h.run('jumpToPlate(1)'); const at = h.run('cutPos');
  key('s');
  assert.equal(h.$('randomBtn').classList.contains('flash'), true, 'the Random sound button flashes');
  assert.equal(h.run('cutPos'), at, 'a new sound for the same cut: the playhead stays');
  assert.equal(h.$('musicSelect').value, 'on', 'S turns the sound on');
  assert.notEqual(h.$('seedVal').value, seed);
  assert.equal(['rhythmSelect', 'bpmInput', 'invertSelect'].map(id => h.$(id).value).join(), a, 'and leaves the video alone');
  h.ctx.onKey({ key: 'r', target: { tagName: 'INPUT', type: 'text' }, preventDefault() {} });   // typing an r is typing
});

test('the Keys panel opens with ? or the hint, and Esc closes it', async () => {
  const h = await playerWith();
  const key = k => h.ctx.onKey({ key: k, target: { tagName: 'BODY' }, preventDefault() {} });
  h.$('keysPanel').hidden = true;
  key('?'); assert.equal(h.$('keysPanel').hidden, false);
  key('Escape'); assert.equal(h.$('keysPanel').hidden, true);
  h.run('toggleKeys()'); assert.equal(h.$('keysPanel').hidden, false);
});

test('one undo history for the app: settings settle into one step each, trash and moves are steps, Cmd+Z goes back in order, Cmd+Shift+Z forward', async () => {
  const r = baseRoutes();
  let st = [mkPlate('a'), mkPlate('b'), mkPlate('c')];
  r['/api/state'] = () => ({ plates: st });
  r['/api/trash'] = body => { const p = st.find(x => x.filename === body.filename); st = st.filter(x => x !== p).concat([{ ...p, trashed: body.trashed }]); return { ok: true }; };
  r['/api/reorder'] = body => { st = body.order.map(f => st.find(p => p.filename === f)).concat(st.filter(p => !body.order.includes(p.filename))); return { ok: true }; };
  const h = load({ routes: r }); await settle(); await settle();
  const key = (shiftKey = false) => h.ctx.onKey({ key: 'z', metaKey: true, shiftKey, target: { tagName: 'BODY' }, preventDefault() {} });
  const flush = async () => { for (let i = 0; i < 6; i++) await settle(); };
  assert.equal(h.$('undoRandomBtn').disabled, true, 'nothing yet');
  // a slider dragged through many values is one step
  const bpm0 = h.$('bpmInput').value;
  for (const v of ['100', '110', '120', '130']) { h.$('bpmInput').value = v; h.run('updateTempo()'); }
  h.run('commitSettings()');                                                     // what 0.7 s of quiet does
  assert.equal(h.run('history.length'), 1);
  assert.equal(h.run('history[0].label'), 'a setting');
  const inv0 = h.$('invertSelect').value;
  h.$('invertSelect').value = 'mono'; h.run('updateFx()');
  // trashing: a step, after the settings change (which is committed first)
  await h.run("setTrash({ stopPropagation() {} }, 'b', true)");
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('history.map(s => s.label)'))), ['a setting', 'a setting', 'Trash “b”'], 'the invert, committed before the trash: in the order they happened');
  assert.match(h.$('undoRandomBtn').title, /Undo Trash “b”/);
  key(); await flush();
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['a', 'b', 'c'], '1: the trash');
  key(); await flush();
  assert.equal(h.$('invertSelect').value, inv0, '2: the invert');
  key(); await flush();
  assert.equal(h.$('bpmInput').value, bpm0, '3: the tempo, back to where it started');
  key(true); await flush();
  assert.equal(h.$('bpmInput').value, '130', 'redo: forward again');
  key(true); key(true); await flush();
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['a', 'c'], 'redo the trash too');
  // a new change after undoing drops the redo
  key(); await flush();
  h.$('zoomSelect').value = 'out'; h.run('updateFx(); commitSettings()');
  assert.equal(h.run('future.length'), 0);
});

test('a drag in the grid is a step: undo puts the order back, unless the other order is shown', async () => {
  const r = baseRoutes();
  let st = [mkPlate('a'), mkPlate('b'), mkPlate('c')];
  r['/api/state'] = () => ({ plates: st });
  r['/api/reorder'] = body => { st = body.order.map(f => st.find(p => p.filename === f)); return { ok: true }; };
  const h = load({ routes: r }); await settle(); await settle();
  h.run("draggedFilename = 'c'");
  await h.run("onDrop({ preventDefault() {}, currentTarget: { classList: { remove() {} } } }, 'a')");
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['c', 'a', 'b']);
  assert.equal(h.run('history.at(-1).label'), 'Move “c”');
  await h.run('undoLast()'); await settle();
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['a', 'b', 'c']);
});

test('R never shows a stray image: every frame drawn during a Random is from the new film\'s start', async () => {
  const h = await playerWith();
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 12 }, (_, i) => mkPlate('p' + i)) };
  const v = load({ routes: r }); await settle(); await settle();
  v.$('stageImg').style.display = 'block';
  v.run('jumpToPlate(9)');
  const shown = [];
  let src = v.$('stageImg').src;
  Object.defineProperty(v.$('stageImg'), 'src', { get: () => src, set: u => { src = u; shown.push(u); } });
  for (let i = 0; i < 20; i++) { shown.length = 0; v.run('jumpToPlate(9); randomAll()'); assert.deepEqual(shown.slice(1), shown.length > 1 ? Array(shown.length - 1).fill('/p/p0') : [], `only the first image after the jump: ${shown}`); }
});

test('the tempo lock: Random (any type, the R key, Random rhythm) keeps the tempo and a Flat speed; the Multiple still rolls; it is remembered', async () => {
  const h = await playerWith();
  h.$('bpmLock').type = 'checkbox'; h.$('bpmLock').checked = true;
  h.$('bpmInput').value = '97'; h.run('updateTempo()');
  const mults = new Set();
  for (const k of ['any', ...Object.keys(JSON.parse(JSON.stringify(h.run('CHARACTERS'))))]) {
    h.$('characterSelect').value = k;
    for (let i = 0; i < 15; i++) {
      h.run('randomAll()'); h.run('randomRhythm()');
      assert.equal(h.$('bpmInput').value, '97', `${k}: the tempo stays`);
      assert.equal(h.$('rhythmSelect').value, 'flat', `${k}: and the speed stays Flat`);
      mults.add(h.$('multSelect').value);
    }
  }
  assert.ok(mults.size > 2, 'the Multiple still changes');
  assert.equal(JSON.parse(h.store.studioSettings).bpmLock, true, 'remembered');
  h.$('bpmLock').checked = false;
  const seen = new Set(); for (let i = 0; i < 30; i++) { h.$('characterSelect').value = 'any'; h.run('randomAll()'); seen.add(h.$('bpmInput').value + h.$('rhythmSelect').value); }
  assert.ok(seen.size > 5, 'unlocked: Random changes it again');
});

test('groups: the grid, the film, AI re-order and export follow the group chosen; a group that is gone falls back to All', async () => {
  const r = baseRoutes();
  const P = (f, look, world) => ({ ...mkPlate(f), look, world });
  let state = { plates: [P('a', ['warm'], 'Fog'), P('b', ['cold'], 'Fog'), P('c', ['warm', 'dark'], 'Fog'), P('d', [], 'Fog'), P('f', [], 'Fog'), P('g', [], 'Fog'), P('e', [], 'Sea')], groups: [{ id: 'g1', name: 'Mine', files: ['b', 'd'] }], kimi_configured: true };
  r['/api/state'] = () => state;
  r['/api/order-ai'] = { ok: true, job: 'j1', steps: ['a'] };
  r['/api/export-video'] = { ok: true, images: 2, seconds: 1, video_url: '/x.mp4', filename: 'x.mp4' };
  const h = load({ routes: r }); await settle(); await settle();
  const chips = JSON.parse(JSON.stringify(h.run('groupChips()')));
  assert.deepEqual(chips.chips.map(c => `${c.key}=${c.n}`), ['all=7', 'g:g1=2']);
  assert.deepEqual(chips.auto.map(c => `${c.key}=${c.n}`), ['look:warm=2', 'world:Fog=6'], 'a look needs 2 images, a territory 6, to make a chip');
  h.run("setGroup('look:warm')");
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['a', 'c']);
  assert.deepEqual(h.run('visiblePlates().map(p => p.filename)'), ['a', 'c']);
  assert.equal(h.store.studioGroup, 'look:warm', 'remembered');
  h.run("setGroup('g:g1')");
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['b', 'd']);
  assert.equal(h.$('aiLength').disabled, true, 'best N belongs to the whole selection');
  await h.run('exportVideo()');
  assert.deepEqual(h.calls.find(c => c.url === '/api/export-video').body.files, ['b', 'd']);
  h.ctx.setTimeout = () => 0;                                                     // the AI job is not followed here: only what it is asked
  h.run('startAiOrder()'); await settle(); await settle();
  assert.deepEqual(h.calls.find(c => c.url === '/api/order-ai').body.files, ['b', 'd']);
  state = { ...state, groups: [] };                                               // the group was deleted elsewhere
  await h.run('loadState()');
  assert.equal(h.run('currentGroup'), 'all');
  assert.equal(h.run('activePlates().length'), 7);
});

test('Trail: the same opacity curve as the export (shared vectors), and the stage overlays the previous cut as it ended', async () => {
  const TRAIL_VECTORS = [[0.0, 0.4, 0.4], [0.9, 0.4, 0.4], [1.0, 0.4, 0.3], [3.5, 0.4, 0.1], [4.0, 0.4, 0.0], [-0.5, 0.4, 0.0], [0.0, 0.0, 0.0], [0.0, 5.0, 0.6]];   // = test_cutplan.TRAIL_VECTORS
  const h = await playerWith();
  for (const [k, a, want] of TRAIL_VECTORS) assert.ok(Math.abs(h.run(`trailAlpha(${k}, ${a})`) - want) < 1e-9, `${k} ${a}`);
  h.$('bpmInput').value = '60'; h.$('multSelect').value = '1'; h.$('invertSelect').value = 'mono'; h.$('zoomSelect').value = 'out'; h.$('zoomAmt').value = '2';
  h.$('trailRange').value = '40'; h.run('updateTempo(); updateFx()');
  assert.equal(h.$('trailVal').textContent, '40%');
  h.run('isPlaying = true');
  const tl = h.run('timelineFor(3)');
  h.run(`cutPos = ${tl[1]} + 0.5; drawFrame()`);                                 // first frame of cut 1: the inverted copy of a
  assert.equal(h.$('stageGhost').src, '/p/a', 'the previous cut lingers');
  assert.equal(h.$('stageGhost').style.filter, '', 'as it was: not inverted');
  assert.equal(h.$('stageGhost').style.transform, '', 'and as it ended: zoomed out to 1');
  assert.equal(h.$('stageGhost').style.opacity, '0.400');
  h.run(`cutPos = ${tl[2]} + 2.2; drawFrame()`);                                 // cut 2 (b), third frame: the inverted a lingers, fading
  assert.equal(h.$('stageGhost').style.filter, 'invert(1) grayscale(1)');
  assert.equal(h.$('stageGhost').style.opacity, '0.200');
  h.run(`cutPos = ${tl[2]} + 5; drawFrame()`);
  assert.equal(h.$('stageGhost').style.opacity, '0');
  h.$('trailRange').value = '0'; h.run('updateFx()');
  h.run(`cutPos = ${tl[1]} + 0.2; drawFrame()`);
  assert.equal(h.$('stageGhost').style.opacity, '0', 'off is off');
  assert.equal(h.$('trailVal').textContent, 'Off');
  h.run('isPlaying = false');
});
