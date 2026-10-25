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
  h.run('framesPerCut = 3; isPlaying = true; cutPos = 0');
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

test('with music on, Play renders the track for the current settings, then plays it from the top', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on'; h.$('invertSelect').value = 'colour';
  h.$('pulseRange').value = '40'; h.$('lowRange').value = '80'; h.$('brightRange').value = '20'; h.$('widthRange').value = '90'; h.$('spaceRange').value = '75'; h.$('powerRange').value = '55'; h.$('seedVal').value = '42';
  h.run('togglePlay()');
  assert.equal(h.$('playBtn').textContent, '♪ Rendering…');
  await settle(); await settle();
  const call = h.calls.find(c => c.url === '/api/music');
  assert.deepEqual(call.body, { music: 'synth', bpm: 120, multiple: 2, invert_mode: 'colour', pulse: 0.4, low: 0.8, bright: 0.2, width: 0.9, space: 0.75, power: 0.55, seed: 42 });
  assert.equal(h.ctx.__audios.length, 1);
  const a = h.ctx.__audios[0];
  assert.equal(a.paused, false); assert.equal(a.loop, true); assert.equal(a.currentTime, 0);
  assert.equal(h.$('playBtn').textContent, '⏸ Pause');
  h.run('togglePlay()');                                                    // pause stops the sound
  assert.equal(a.paused, true);
});

test('while the music plays it is the clock: the picture follows the audio position', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on'; h.$('invertSelect').value = 'off';
  h.run('framesPerCut = 3');                                                // 100 ms per cut
  h.run('togglePlay()');
  await settle(); await settle();
  const tick = h.timers.intervals[h.timers.intervals.length - 1].fn;
  h.ctx.__audios[0].currentTime = 0.25;                                     // cut 2 -> third image
  tick();
  assert.equal(h.$('stageImg').src, '/p/c');
  h.ctx.__audios[0].currentTime = 0.05;
  tick();
  assert.equal(h.$('stageImg').src, '/p/a');
});

test('changing the tempo or invert while playing stops the old track and renders a new one', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on';
  h.run('togglePlay()');
  await settle(); await settle();
  const first = h.ctx.__audios[0];
  h.$('invertSelect').value = 'mono';
  h.run('updateFx()');
  assert.equal(first.paused, true);                                          // the old track no longer matches
  const wait = h.timers.timeouts[h.timers.timeouts.length - 1];
  assert.ok(wait.ms >= 200);                                                 // debounced: dragging the slider does not hammer the server
  wait.fn();
  await settle(); await settle();
  assert.equal(h.calls.filter(c => c.url === '/api/music').length, 2);
  assert.equal(h.ctx.__audios.length, 2);
  assert.equal(h.ctx.__audios[1].paused, false);
});

test('when the music cannot be rendered the player says so and the picture still plays', async () => {
  const h = await playerWith({ music: { __fail: 500 } });
  h.$('musicSelect').value = 'on';
  h.run('togglePlay()');
  await settle(); await settle();
  assert.match(h.$('toast').textContent, /Could not render the music/);
  assert.equal(h.$('playBtn').textContent, '⏸ Pause');
  const tick = h.timers.intervals[h.timers.intervals.length - 1].fn;
  h.ctx.performance.now = (() => { let t = 0; return () => (t += 100); })();
  h.run('lastTick = performance.now()');
  tick();                                                                    // not stuck waiting for audio
  assert.ok(h.run('cutPos') > 0);
});

test('export sends the music choice', async () => {
  const r = baseRoutes();
  r['/api/export-video'] = { ok: true, images: 3, seconds: 2, video_url: '/outputs/x.mp4', filename: 'x.mp4' };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('musicSelect').value = 'on';
  await h.run('exportVideo()');
  const body = h.calls.find(c => c.url === '/api/export-video').body;
  assert.equal(body.music, 'synth');
});

test('music choices are remembered', () => {
  const h = load({ routes: baseRoutes() });
  h.$('musicSelect').value = 'track'; h.$('cutOnSelect').value = 'beats'; h.$('sensRange').value = '70';
  h.run('updateMusic()');
  const saved = JSON.parse(h.store.studioSettings);
  assert.deepEqual([saved.musicSelect, saved.cutOnSelect, saved.sensRange], ['track', 'beats', '70']);
});


test('the Video and Music tabs show one pane at a time and remember which', () => {
  const h = load({ routes: baseRoutes() });
  h.run("showFxTab('music')");
  assert.equal(h.$('paneVideo').hidden, true); assert.equal(h.$('paneMusic').hidden, false);
  assert.ok(h.$('tabMusic').classList.contains('on') && !h.$('tabVideo').classList.contains('on'));
  assert.equal(JSON.parse(h.store.studioSettings).fxTabVal, 'music');
  h.run("showFxTab('video')");
  assert.equal(h.$('paneVideo').hidden, false); assert.equal(h.$('paneMusic').hidden, true);
});

test('music settings: sliders show their value, only show for the synthesized music, and a new variation changes the seed', () => {
  const h = load({ routes: baseRoutes() });
  h.$('musicSelect').value = 'off'; h.$('pulseRange').value = '35';
  h.run('updateMusic()');
  assert.equal(h.$('pulseVal').textContent, '35');
  assert.equal(h.$('synthBox').hidden, true); assert.match(h.$('styleHint').textContent, /No music/);
  h.$('musicSelect').value = 'on';
  h.run('updateMusic()');
  assert.equal(h.$('synthBox').hidden, false);
  assert.match(h.$('styleHint').textContent, /drone/);
  h.$('seedVal').value = '7';
  h.run('newVariation()');
  assert.notEqual(h.$('seedVal').value, '7');
  assert.equal(h.$('seedNum').textContent, h.$('seedVal').value);
  const saved = JSON.parse(h.store.studioSettings);
  assert.deepEqual([saved.musicSelect, saved.pulseRange, saved.seedVal], ['on', '35', h.$('seedVal').value]);
});

test('the info line says how many images, how long, and how long the cuts are', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 40 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.run('framesPerCut = 3');
  h.run('drawInfo()');
  assert.equal(h.$('rhythmInfo').textContent, '40 images · 4 s · cuts 100 ms');
  h.$('invertSelect').value = 'mono';
  h.run('drawInfo()');
  assert.equal(h.$('rhythmInfo').textContent, '40 images · 8 s · cuts 100 ms');
});

test('the grid uses small thumbnails and the player the preview size, falling back to the full image', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [{ ...mkPlate('a'), thumb: '/api/thumb?f=a&w=360', preview: '/api/thumb?f=a&w=540' }, mkPlate('b')] };
  const h = load({ routes: r });
  await settle(); await settle();
  const html = h.$('grid').innerHTML;
  assert.match(html, /src="\/api\/thumb\?f=a&w=360"/);
  assert.match(html, /src="\/p\/b"/);
  h.$('stageImg').style.display = 'block';
  h.run('framesPerCut = 3; isPlaying = true; cutPos = 0');
  const tick = h.timers.intervals[h.timers.intervals.length - 1].fn;
  h.ctx.performance.now = (() => { let t = 0; return () => (t += 10); })();
  h.run('lastTick = performance.now()');
  tick();
  assert.equal(h.$('stageImg').src, '/api/thumb?f=a&w=540');
});

test('zoom amount only shows while a zoom is chosen', () => {
  const h = load({ routes: baseRoutes() });
  h.$('zoomSelect').value = 'off'; h.run('updateFx()');
  assert.equal(h.$('zoomAmtRow').hidden, true);
  h.$('zoomSelect').value = 'in'; h.run('updateFx()');
  assert.equal(h.$('zoomAmtRow').hidden, false);
});

test('changing a music setting renders the track in the background with a loader, so Play is instant', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on';
  h.run('updateMusic()');
  assert.equal(h.calls.some(c => c.url === '/api/music'), false);             // debounced: dragging a slider does not hammer the server
  const wait = h.timers.timeouts[h.timers.timeouts.length - 1];
  assert.ok(wait.ms >= 500);
  wait.fn();
  assert.equal(h.$('musicState').hidden, false); assert.match(h.$('musicState').textContent, /Rendering/); assert.match(h.$('musicState').className, /busy/);
  await settle(); await settle();
  assert.match(h.$('musicState').textContent, /ready/i);
  assert.equal(h.ctx.__audios.length, 1);
  h.run('togglePlay()');                                                      // already rendered: no second render, plays straight away
  await settle();
  assert.equal(h.calls.filter(c => c.url === '/api/music').length, 1);
  assert.equal(h.ctx.__audios[0].paused, false);
});

test('a music failure explains itself in the Music tab', async () => {
  const h = await playerWith({ music: { __fail: 500 } });
  h.$('musicSelect').value = 'on';
  h.run('updateMusic()');
  h.timers.timeouts[h.timers.timeouts.length - 1].fn();
  await settle(); await settle();
  assert.match(h.$('musicState').textContent, /Could not render the music/);
  assert.match(h.$('musicState').className, /err/);
});

test('turning the music off clears its state and stops the sound', async () => {
  const h = await playerWith();
  h.$('musicSelect').value = 'on';
  h.run('togglePlay()');
  await settle(); await settle();
  h.$('musicSelect').value = 'off';
  h.run('updateMusic()');
  assert.equal(h.ctx.__audios[0].paused, true);
  assert.equal(h.$('musicState').hidden, true);
});


// ---------- a music track that drives the cuts ----------

const TRACK = { name: 'glitch.mp3', duration: 62, bpm: 128, n_beats: 130, n_hits: 410 };

async function trackPlayer(cuts = { ok: true, starts: [0, 0.2, 0.5, 0.6], audio_start: 1.5, total: 0.6, events: 80, bpm: 128 }, extra = {}) {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a'), mkPlate('b'), mkPlate('c')] };
  r['/api/track'] = (body) => (body && body.clear ? { ok: true, track: null } : body && body.name ? { ok: true, track: TRACK } : { ok: true, track: extra.noTrack ? null : TRACK });
  r['/api/track-cuts'] = cuts;
  r['/api/music'] = { ok: true };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('stageImg').style.display = 'block';
  h.run('loadTrack()');
  await settle(); await settle();
  return h;
}

test('the saved track is shown in the Music tab when the page opens', async () => {
  const h = await trackPlayer();
  assert.equal(h.$('trackName').textContent, 'glitch.mp3');
  assert.match(h.$('trackInfo').textContent, /128 BPM · 1:02 · 410 hits found/);
  assert.equal(h.$('trackClear').hidden, false);
});

test('choosing My track shows its controls, hides the synth ones, and the tempo stops driving the cuts', async () => {
  const h = await trackPlayer();
  h.$('musicSelect').value = 'on'; h.run('updateMusic()');
  assert.equal(h.$('synthBox').hidden, false); assert.equal(h.$('trackBox').hidden, true); assert.equal(h.$('bpmSlider').disabled, false);
  h.$('musicSelect').value = 'track'; h.run('updateMusic()');
  assert.equal(h.$('synthBox').hidden, true); assert.equal(h.$('trackBox').hidden, false);
  assert.equal(h.$('bpmSlider').disabled, true); assert.equal(h.$('speedVal').textContent, 'from the music');
  h.$('cutOnSelect').value = 'beats'; h.run('updateMusic()');
  assert.equal(h.$('sensRow').hidden, true);                                  // sensitivity only means something for hits
  assert.equal(h.$('multSelect').disabled, false);                            // beats use the multiple; hits do not
  h.$('cutOnSelect').value = 'hits'; h.run('updateMusic()');
  assert.equal(h.$('sensRow').hidden, false); assert.equal(h.$('multSelect').disabled, true);
});

test('uploading a track sends the file as it is with its name, then switches to it', async () => {
  const h = await trackPlayer(undefined, { noTrack: true });
  assert.equal(h.$('trackName').textContent, 'No track yet');
  const file = { name: 'my mix.wav', size: 3 };
  await h.run('uploadTrack({ name: "my mix.wav", size: 3 })');
  const call = h.calls.filter(c => c.url.startsWith('/api/track?')).pop();
  assert.equal(call.url, '/api/track?name=my%20mix.wav');
  assert.equal(h.$('musicSelect').value, 'track');
  assert.equal(h.$('trackName').textContent, 'glitch.mp3');
});

test('a track the server cannot use is explained and nothing changes', async () => {
  const r = baseRoutes();
  r['/api/track'] = { ok: false, error: 'Could not read that audio file' };
  const h = load({ routes: r });
  await settle(); await settle();
  await h.run('uploadTrack({ name: "x.mp3" })');
  assert.match(h.$('musicState').textContent, /Could not use that track: Could not read that audio file/);
  assert.match(h.$('musicState').className, /err/);
  assert.equal(h.$('musicSelect').value, '');
});

test('with a track the cuts come from the server: Play asks for them, then the picture changes on those times', async () => {
  const h = await trackPlayer();
  h.$('musicSelect').value = 'track'; h.$('cutOnSelect').value = 'hits'; h.$('sensRange').value = '40'; h.$('nudgeRange').value = '-20';
  h.run('framesPerCut = 3');                                                   // 100 ms per base cut
  h.run('updateMusic()');
  h.run('togglePlay()');
  await settle(); await settle(); await settle();
  const cuts = h.calls.find(c => c.url === '/api/track-cuts');
  assert.equal(cuts.body.cut_on, 'hits'); assert.equal(cuts.body.sensitivity, 0.4); assert.equal(cuts.body.nudge, -0.02);
  const music = h.calls.find(c => c.url === '/api/music');
  assert.equal(music.body.music, 'track');
  // the sound is the clock: cuts at 0, 0.2, 0.5 s -> images a, b, c
  const tick = h.timers.intervals[h.timers.intervals.length - 1].fn;
  const audio = h.ctx.__audios[0];
  for (const [t, img] of [[0.05, '/p/a'], [0.3, '/p/b'], [0.55, '/p/c'], [0.65, '/p/a']]) {   // 0.65 is past the end (0.6): wraps to the start
    audio.currentTime = t; tick();
    assert.equal(h.$('stageImg').src, img, `at ${t}s`);
  }
});

test('the info line reflects the uneven cuts of a track', async () => {
  const h = await trackPlayer();
  h.$('musicSelect').value = 'track'; h.run('framesPerCut = 3'); h.run('updateMusic()');
  await h.run('ensureTrackCuts()');
  h.run('drawInfo()');
  assert.equal(h.$('rhythmInfo').textContent, '3 images · 1 s · cuts 100 ms – 300 ms');
});

test('changing a track setting asks for new cuts (debounced) and a new sound', async () => {
  const h = await trackPlayer();
  h.$('musicSelect').value = 'track'; h.run('updateMusic()');
  h.timers.timeouts[h.timers.timeouts.length - 1].fn();
  await settle(); await settle(); await settle();
  const before = h.calls.filter(c => c.url === '/api/track-cuts').length;
  h.$('sensRange').value = '80'; h.run('updateMusic()');
  assert.equal(h.calls.filter(c => c.url === '/api/track-cuts').length, before);      // not yet: the slider may still be moving
  h.timers.timeouts[h.timers.timeouts.length - 1].fn();
  await settle(); await settle(); await settle();
  assert.equal(h.calls.filter(c => c.url === '/api/track-cuts').length, before + 1);
  assert.equal(h.calls.filter(c => c.url === '/api/music').length, 2);
});

test('track cuts the server refuses show a reason and Play falls back to the plain tempo', async () => {
  const h = await trackPlayer({ ok: false, error: 'Not enough hits or beats in that track to cut on.' });
  h.$('musicSelect').value = 'track'; h.run('updateMusic()');
  h.run('togglePlay()');
  await settle(); await settle(); await settle();
  assert.match(h.$('musicState').textContent, /Not enough hits/);
  assert.equal(h.ctx.__audios.length, 0);
  assert.equal(h.$('playBtn').textContent, '⏸ Pause');                              // the picture still plays on the tempo grid
});

test('removing the track returns to silence and forgets its cuts', async () => {
  const h = await trackPlayer();
  h.$('musicSelect').value = 'track'; h.run('updateMusic()');
  await h.run('clearTrack()');
  assert.equal(h.$('musicSelect').value, 'off');
  assert.equal(h.$('trackName').textContent, 'No track yet');
  assert.equal(h.$('bpmSlider').disabled, false);
});

test('export with a track sends the cut settings and says track', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a'), mkPlate('b')] };
  r['/api/track'] = { ok: true, track: TRACK };
  r['/api/export-video'] = { ok: true, images: 2, seconds: 2, video_url: '/outputs/x.mp4', filename: 'x.mp4' };
  const h = load({ routes: r });
  await settle(); await settle();
  await h.run('loadTrack()');
  h.$('musicSelect').value = 'track'; h.$('cutOnSelect').value = 'beats'; h.$('multSelect').value = '2'; h.$('sensRange').value = '30';
  await h.run('exportVideo()');
  const body = h.calls.find(c => c.url === '/api/export-video').body;
  assert.deepEqual([body.music, body.cut_on, body.multiple, body.sensitivity], ['track', 'beats', 2, 0.3]);
});
