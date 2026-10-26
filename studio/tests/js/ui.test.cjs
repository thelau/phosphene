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
  $('bpmSlider').value = '120'; $('multSelect').value = '2';
  run('updateTempo()');
  assert.equal(run('framesPerCut'), 7.5);                      // 1800 / (120*2)
  assert.equal($('speedVal').textContent, '7.5f');
  assert.equal($('bpmVal').textContent, '120 BPM');
  const saved = JSON.parse(store.studioSettings);
  assert.equal(saved.bpmSlider, '120'); assert.equal(saved.multSelect, '2');
  $('bpmSlider').value = '220'; $('multSelect').value = '9';
  run('updateTempo()');
  assert.equal(run('framesPerCut'), 1);                        // never below one frame
});

test('restoreSettings brings back remembered values (and ignores unknown options)', () => {
  const { run, $ } = load({ routes: baseRoutes(), storage: { studioSettings: JSON.stringify({ bpmSlider: '150', directionInput: 'wet' }) } });
  assert.equal($('bpmSlider').value, '150');
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
  h.$('bpmSlider').value = '200'; h.$('multSelect').value = '3'; h.run('updateTempo()');   // a beat of 9 frames, 3 picture cuts per beat: 100 ms per cut
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
  h.$('bpmSlider').value = '136'; h.$('multSelect').value = '4'; h.$('invertSelect').value = 'mono'; h.$('zoomSelect').value = 'out'; h.$('zoomAmt').value = '1.2';
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
  assert.match(link.textContent, /Download Demo-136bpm/);
  assert.match(h.$('toast').textContent, /12 images, 6s/);
  assert.equal(h.$('exportBtn').disabled, false);
  assert.equal(h.$('exportBtn').textContent, 'Export MP4');
});

test('export failures show a message and unlock the button', async () => {
  const r = baseRoutes();
  r['/api/export-video'] = { ok: false, error: 'No active plates' };
  const h = load({ routes: r });
  await settle(); await settle();
  await h.run('exportVideo()');
  assert.match(h.$('toast').textContent, /Export failed: No active plates/);
  assert.equal(h.$('exportBtn').disabled, false);
  const r2 = baseRoutes();
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
  h.$('bpmSlider').value = '120'; h.$('multSelect').value = '2'; h.$('zoomSelect').value = 'off';
  h.run('updateTempo()');
  return h;
}

test('with music off, Play never asks for music or creates audio', async () => {
  const h = await playerWith();
  h.run('togglePlay()');
  await settle();
  assert.equal(h.calls.some(c => c.url === '/api/music'), false);
  assert.equal(h.ctx.__audios.length, 0);
  assert.equal(h.$('playBtn').textContent, '⏸ Pause');
});

test('with the drone on, Play starts it live from the top with the settings and where every cut falls', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on'; h.$('invertSelect').value = 'colour';
  h.$('pulseRange').value = '40'; h.$('lowRange').value = '80'; h.$('brightRange').value = '20'; h.$('widthRange').value = '90'; h.$('spaceRange').value = '75'; h.$('powerRange').value = '55'; h.$('seedVal').value = '42';
  h.$('pitchRange').value = '50'; h.$('movementRange').value = '50'; h.$('echoRange').value = '0'; h.$('chordSelect').value = '0'; h.$('washRange').value = '0'; h.$('ringRange').value = '0'; h.$('shimmerRange').value = '0'; h.$('subWaveSelect').value = '0'; h.$('padWaveSelect').value = '0';
  for (const id of ['hitTypeSelect', 'hitOnSelect', 'arpStepsSelect', 'arpRateSelect', 'dynSelect']) h.$(id).value = '0';
  h.$('hitRange').value = '0'; h.$('arpRange').value = '0';
  h.$('bpmSlider').value = '200'; h.$('multSelect').value = '3'; h.run('updateTempo()');   // a beat of 9 frames, 3 picture cuts per beat: 100 ms per cut
  h.run('togglePlay()');
  await settle(); await settle();
  assert.equal(h.calls.some(c => c.url === '/api/music'), false);           // nothing is rendered on the server
  const play = h.ctx.__drone.plays[0];
  assert.deepEqual(JSON.parse(JSON.stringify(play.params)), { pulse: 0.4, low: 0.8, bright: 0.2, width: 0.9, space: 0.75, power: 0.55, pitch: 0.5, chord: 0, movement: 0.5, echo: 0, wash: 0, ring: 0, shimmer: 0, hitType: 0, hit: 0, hitOn: 0, arp: 0, arpSteps: 0, arpRate: 0, dynamics: 0, subWave: 0, padWave: 0, seed: 42, paired: true, landAt: 0.4 });
  assert.equal(play.offset, 0);
  assert.equal(play.starts.length, 3);                                      // the music follows the beats (2 of them for 6 picture cuts at 3 per beat) + the end
  assert.ok(Math.abs(play.starts[2] - 0.6) < 1e-9 && Math.abs(play.starts[1] - 0.3) < 1e-9);
  assert.equal(h.$('playBtn').textContent, '⏸ Pause');
  h.run('togglePlay()');                                                    // pause stops the sound
  assert.equal(h.ctx.__drone.stops > 0, true);
});

test('while the drone plays it is the clock: the picture follows its position', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on'; h.$('invertSelect').value = 'off';
  h.$('bpmSlider').value = '200'; h.$('multSelect').value = '3'; h.run('updateTempo()');   // a beat of 9 frames, 3 picture cuts per beat: 100 ms per cut
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
  h.$('bpmSlider').value = '200'; h.$('multSelect').value = '3'; h.run('updateTempo()');   // a beat of 9 frames, 3 picture cuts per beat: 100 ms per cut
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
  assert.equal(h.$('musicState').hidden, true);
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
  h.$('bpmSlider').value = '120'; h.$('multSelect').value = '2'; h.run('updateTempo()');
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
  const updates = h.ctx.__drone.updates.length;
  h.run('restartPlay()');
  assert.equal(h.run('cutPos'), 0); assert.equal(h.run('currentIdx'), 0);
  assert.equal(h.run('isPlaying'), true);
  assert.equal(h.ctx.__drone.updates.length, updates + 1);
  assert.equal(h.ctx.__drone.updates[updates].offset, 0);
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
  h.$('bpmSlider').value = '120'; h.$('multSelect').value = '4'; h.run('updateTempo()');
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
    for (const variable of [false, true]) for (const invert of ['off', 'mono', 'colour']) for (const bpm of [60, 136, 250]) for (const mult of ['0.25', '1', '1.3333333', '4', '9']) {
      h.$('rhythmSelect').value = variable ? 'variable' : 'flat'; h.$('invertSelect').value = invert; h.$('bpmSlider').value = String(bpm); h.$('multSelect').value = mult;
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
  h.$('bpmSlider').value = '250'; h.$('multSelect').value = '9'; h.run('updateTempo()');
  assert.equal(h.run('framesPerCut'), 1);                                     // 1800 / (250 * 9) is below a frame: never below one
  assert.equal(h.$('bpmVal').textContent, '250 BPM');
});

test('changing the Multiple while playing asks the sound for an update, from where the picture is, with the same beat grid', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 12 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('stageImg').style.display = 'block';
  h.$('musicSelect').value = 'on'; h.$('bpmSlider').value = '120'; h.$('multSelect').value = '1'; h.run('updateTempo()');
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
