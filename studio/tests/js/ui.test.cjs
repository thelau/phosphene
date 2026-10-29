const test = require('node:test');
const assert = require('node:assert/strict');
const { load, WEB } = require('./harness.cjs');
const fs = require('fs');

const baseRoutes = () => ({
  '/api/state': { plates: [], krea_connected: true, kimi_configured: true, project: { slug: 'demo', name: 'Demo', mark_size: 18, mark_x: 50, mark_y: 50, mark_url: '/m', round: true, fixed: true } },
  '/api/worlds': { worlds: [{ name: 'Editorial Print', brief: 'Swiss grid.', examples: ['poster', 'open magazine spread'], n: 21, kept: 2, wildcard: false }, { name: 'Harbor & Signal', brief: 'Ports.', n: 0, kept: 0, wildcard: true }] },
});
const settle = () => new Promise(r => setImmediate(r));
// what the page saved: the shared settings and the open project's film (films are per project, `studioFilm:<slug>`)
const savedOf = store => ({ ...JSON.parse(store.studioSettings || '{}'), ...JSON.parse(store['studioFilm:demo'] || '{}') });
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

test('the tempo and Multiple fields show their values (BPM and the music cut in ms) and persist', () => {
  const { run, $, store } = load({ routes: baseRoutes() });
  $('bpmInput').value = '120'; $('multSelect').value = '2';
  run('updateTempo()');
  assert.equal($('tempoVal').textContent, '120 BPM'); assert.equal($('tempoMs').textContent, '500 ms');
  assert.equal($('multVal').textContent, '×2');
  assert.match($('tempoField')['aria-valuetext'], /^120 BPM, 500 ms a music cut$/);
  const saved = savedOf(store);
  assert.equal(saved.bpmInput, '120'); assert.equal(saved.multSelect, '2');
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
  assert.match($('directionInput').placeholder, /^e\.g\. wet apparel/);
  $('worldSelect').value = '__wildcard__';
  run('updateDirectionHint()');
  assert.match($('directionInput').placeholder, /a hint for Kimi/i);
  $('worldSelect').value = '__custom__';
  run('updateDirectionHint()');
  assert.match($('directionInput').placeholder, /what is it\?/);
  assert.equal($('refineLabel').textContent, 'Describe', 'a custom territory is described, not refined');
  assert.equal($('refineReq').hidden, false, 'and its description is required');
  assert.equal($('generateBtn').disabled, true, 'Generate waits for it');
  $('worldSelect').value = 'Editorial Print';
  run('updateDirectionHint()');
  assert.match($('directionInput').placeholder, /focus inside Editorial Print, e\.g\. poster, open magazine spread/, 'the territory\'s own subjects');
  assert.equal($('terrName').textContent, 'Editorial Print');
  assert.equal($('terrName').textContent, 'Editorial Print', 'just the name on the button (the counts are in the list)');
  assert.doesNotMatch($('directionInput').placeholder, /fog|rain|lightning/);
});

test('loadWorlds fills the territories with what was kept of what was made, and marks the ones Kimi invented', async () => {
  const { $, run } = load({ routes: baseRoutes() });
  await settle(); await settle();
  const ep = $('worldSelect').options.find(o => o.value === 'Editorial Print');
  assert.equal(ep.textContent, 'Editorial Print');
  assert.deepEqual([ep.dataset.kept, ep.dataset.n], [2, 21]);
  assert.equal($('worldSelect').options.find(o => o.value === 'Harbor & Signal').dataset.wild, '1');
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
  run(`progStop('Done · 2 added')`);
  assert.equal(run('prog.timer'), null);
  assert.match($('statusText').innerHTML, /Done · 2 added/);
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

test('generateImages: success path locks controls, reports progress, then unlocks; the refinement stays for the next batch', async () => {
  let observed = null;
  const h = load({ routes: genRoutes({ n: 4, gen: async () => { observed = observed || ['worldSelect', 'directionInput', 'batchCountSelect', 'generateBtn'].map(id => h.$(id).disabled); return { ok: true, qa_passed: true }; } }) });
  await settle(); await settle();
  h.$('directionInput').value = 'harbour fog';
  await runGenerate(h);
  assert.deepEqual(observed, [true, true, true, true]);                            // locked while running
  ['worldSelect', 'directionInput', 'batchCountSelect', 'generateBtn', 'modelSelect'].forEach(id => assert.equal(h.$(id).disabled, false, id));
  assert.equal(h.$('directionInput').value, 'harbour fog', 'it stays (shown as "Refine: harbour fog ×") until cleared');
  assert.equal(h.$('refine').dataset.state, 'set');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(prog.slots)')), ['ok', 'ok', 'ok', 'ok']);
  assert.match(h.$('statusText').innerHTML, /Done · 4 added/);
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
  assert.match(h.$('statusText').innerHTML, /Done · 2 added · 2 to Trash by the mark check/);
  assert.match(h.$('statusText').innerHTML, /title="[^"]*Mark check: Low center logo fidelity/);
});

test('generateImages: server errors on an image become err slots, batch continues', async () => {
  let i = 0;
  const h = load({ routes: genRoutes({ n: 3, gen: async () => (i++ === 1 ? { ok: false, error: 'Krea 500' } : { ok: true, qa_passed: true }) }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.equal(h.run('prog.slots').filter(s => s === 'err').length, 1);
  assert.match(h.$('statusText').innerHTML, /Done · 2 added · 1 failed</);
  assert.match(h.$('statusText').innerHTML, /title="[^"]*Krea is having trouble: try again in a few minutes/);
});

test('generateImages: a moderation refusal is its own grey bar and count, not a failure, not retried', async () => {
  let i = 0;
  const h = load({ routes: genRoutes({ n: 2, gen: async () => (i++ === 1 ? { ok: false, code: 'content_policy', retryable: false, error: "Refused by Krea's moderation, also with a softened prompt" } : { ok: true, qa_passed: true }) }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.deepEqual(h.run('prog.slots').slice().sort(), ['blocked', 'ok']);
  assert.match(h.$('statusText').innerHTML, /Done · 1 added · 1 refused by Krea's moderation</);
  assert.doesNotMatch(h.$('statusText').innerHTML, /failed|Retry/);
  assert.match(h.$('statusText').innerHTML, /class="slot blocked" title="[^"]*also with a softened prompt/);
});

test('generateImages: out of Krea credits stops the batch and keeps every image not made for Retry (the one that hit the limit too)', async () => {
  let n = 0;
  const h = load({ routes: genRoutes({ n: 4, gen: async () => (n++ < 1 ? { ok: true, qa_passed: true } : { ok: false, stop: true, code: 'insufficient_credits', retryable: true, error: 'Krea: insufficient credits' }) }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.match(h.$('statusText').innerHTML, /out of credits/);
  assert.ok(h.run("prog.actions.some(a => a.label === 'Retry 3')"), JSON.stringify(h.run('prog.actions.map(a => a.label)')));
  assert.equal(JSON.parse(h.store['studioPending:demo']).items.length, 3, 'kept for Resume too');
});

test('generateImages: Krea reachable but an image keeps failing as offline: after 3 rounds it fails on its own, for Retry (not sent again until Stop)', async () => {
  let calls = 0;
  const r = genRoutes({ n: 1, gen: async () => { calls++; return { ok: false, offline: true, code: 'http_502', error: 'Krea 502' }; } });
  r['/api/net'] = { ok: true, online: true };
  const h = load({ routes: r });
  await settle(); await settle();
  h.run('NET_POLL_MS = 0');
  h.$('batchCountSelect').value = '1';
  h.$('kimiKeyInput').value = 'sk-x';
  await h.run('generateImages()');
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(prog.slots)')), ['err']);
  assert.ok(h.run("prog.actions.some(a => a.label === 'Retry 1')"));
  assert.match(h.$('statusText').innerHTML, /Krea is having trouble: try again in a few minutes/);
});

test('in the Mac app the page says when it is ready (files opened from Finder while it loaded come then), and tells the app it is idle', async () => {
  const emitted = [];
  const h = load({ routes: baseRoutes(), globals: { __TAURI__: { event: { emit: async (name, payload) => { emitted.push([name, payload]); } } } } });
  await settle(); await settle();
  assert.ok(emitted.some(([n]) => n === 'page-ready'), JSON.stringify(emitted));
  h.run('applyLocks()');
  assert.ok(emitted.some(([n, p]) => n === 'page-busy' && p === false), 'a page loaded after a reload mid-job says it is idle');
});

test('the sound watchdog never reloads the page while a job runs (a fresh sound instead); idle, a second stall soon after still reloads', async () => {
  const h = load({ routes: baseRoutes() });
  await settle(); await settle();
  h.$('musicSelect').value = 'on';
  h.run('isPlaying = true; generating = true');
  h.run('droneLive.onStall(); droneLive.onStall()');
  assert.equal(h.run('__drone.renews'), 2);
  assert.ok(!h.run('window.__reloaded'), 'no reload mid-batch');
  h.run('generating = false; lastStallFix = 0');
  h.run('droneLive.onStall(); droneLive.onStall()');
  assert.equal(h.run('window.__reloaded'), true);
});

test('generateImages: the connection is lost (a request throws, or Krea is unreachable): the batch waits, then carries on by itself', async () => {
  let n = 0, net = 0;
  const r = genRoutes({ n: 2, gen: async () => { if (n++ < 2) throw new Error('socket hang up'); return { ok: true, qa_passed: true, filename: 'f.jpg' }; } });
  r['/api/net'] = async () => (++net < 2 ? { ok: true, online: false } : { ok: true, online: true });
  const h = load({ routes: r });
  await settle(); await settle();
  h.run('NET_POLL_MS = 0');
  await runGenerate(h);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(prog.slots)')), ['ok', 'ok'], 'nothing failed: it waited and carried on');
  assert.ok(net >= 2, 'it asked until Krea was reachable again');
  assert.equal(h.$('generateBtn').disabled, false);
  assert.equal(h.store['studioPending:demo'], undefined, 'nothing left to resume');
});

test('generateImages: Krea answers "unreachable" (offline): the same wait; Stop during it keeps the rest for Resume, offered after a reload', async () => {
  const r = genRoutes({ n: 4, gen: async () => ({ ok: false, offline: true, error: 'urlopen error' }) });
  r['/api/net'] = { ok: true, online: false };
  const h = load({ routes: r });
  await settle(); await settle();
  const run = runGenerate(h);
  for (let i = 0; i < 20 && !/Connection lost/.test(h.$('statusText').innerHTML); i++) await settle();
  assert.match(h.$('statusText').innerHTML, /Connection lost: waiting to carry on/);
  h.run("prog.actions.find(a => a.label === 'Stop').run()");
  await run;
  assert.match(h.$('statusText').innerHTML, /Stopped · 0 added · 4 not made/);
  const pending = JSON.parse(h.store['studioPending:demo']);
  assert.equal(pending.items.length, 4, 'kept on this computer');
  // the page opens again later: the batch is offered
  const again = load({ routes: genRoutes({ n: 4 }), storage: { ...h.store } });
  await settle(); await settle();
  again.run('offerPending()');
  assert.match(again.$('statusText').innerHTML, /4 images of the last batch weren't made/);
  assert.deepEqual(JSON.parse(again.run('JSON.stringify(prog.actions.map(a => a.label))')), ['Resume', 'Discard']);
  await again.run("prog.actions[0].run()");
  assert.deepEqual(JSON.parse(again.run('JSON.stringify(prog.slots)')), ['ok', 'ok', 'ok', 'ok'], 'Resume makes them, from the same scenes (Kimi is not asked again)');
  assert.equal(again.calls.filter(c => c.url === '/api/invent-prompts').length, 0);
  assert.equal(again.store['studioPending:demo'], undefined);
});

test('generateImages: an image that fails on its own is offered again (Retry N, same scenes); out of credits stops the batch', async () => {
  let n = 0;
  const h = load({ routes: genRoutes({ n: 3, gen: async () => (n++ === 1 ? { ok: false, error: 'No image URL returned', retryable: true } : { ok: true, qa_passed: true, filename: 'f.jpg' }) }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(prog.actions.map(a => a.label))')), ['Retry 1', 'Discard']);
  await h.run('prog.actions[0].run()');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(prog.slots)')), ['ok'], 'the failed one, made');
  const broke = load({ routes: genRoutes({ n: 6, gen: async () => ({ ok: false, error: 'out', stop: true, code: 'insufficient_credits' }) }) });
  await settle(); await settle();
  await runGenerate(broke);
  assert.ok(broke.calls.filter(c => c.url === '/api/generate-image').length <= 3, 'no credits: no more asked');
  assert.match(broke.$('statusText').innerHTML, /out of credits/);
});

test('generateImages: Krea login needed stops remaining renders', async () => {
  const h = load({ routes: genRoutes({ n: 6, gen: async () => ({ ok: false, needs_auth: true }) }) });
  await settle(); await settle();
  await runGenerate(h);
  assert.ok(h.calls.filter(c => c.url === '/api/generate-image').length <= 3);     // only the in-flight ones were sent
  assert.equal(h.run('prog.slots').some(s => s === 'ok'), false);
  assert.match(h.$('statusText').innerHTML, /Krea login needed/);
  assert.ok(h.run("prog.actions.some(a => /^Retry/.test(a.label))"), 'once signed in, Retry makes them');
});

test('generateImages: prompt-writing failure shows an error and unlocks', async () => {
  const r = baseRoutes();
  r['/api/invent-prompts'] = { ok: false, error: 'Extra data: line 1 column 798' };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('directionInput').value = 'keep me';
  await runGenerate(h);
  assert.match(h.$('statusText').innerHTML, /Kimi's answer could not be read: try again/);
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
  assert.match(h.$('toast').textContent, /Add your Kimi API key first/);
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

test('the target: On target by default; Loose goes with every image of the batch, and is locked while it runs', async () => {
  let locked = null;
  const r = genRoutes({ n: 2, gen: async () => { locked = locked ?? h.$('targetSelect').disabled; return { ok: true, qa_passed: true, filename: 'f.jpg' }; } });
  r['/api/invent-prompts'] = body => ({ ok: true, ideas: ideas(2).map((x, i) => ({ ...x, placement: body.target === 'loose' ? { kind: 'loose', x: 30 + i, y: 60, size: 20 } : null })) });
  const h = load({ routes: r });
  await settle(); await settle();
  await runGenerate(h);                                                             // nothing chosen: on target
  assert.deepEqual(h.calls.filter(c => c.url === '/api/generate-image').map(c => c.body.target), ['exact', 'exact']);
  h.$('targetSelect').value = 'loose';
  h.calls.length = 0;
  await runGenerate(h);
  assert.equal(h.calls.find(c => c.url === '/api/invent-prompts').body.target, 'loose', 'Kimi writes each scene knowing its place');
  assert.deepEqual(h.calls.filter(c => c.url === '/api/generate-image').map(c => c.body.placement.x), [30, 31], 'each image at the place its scene was written for');
  assert.deepEqual(h.calls.filter(c => c.url === '/api/generate-image').map(c => c.body.target), ['loose', 'loose']);
  assert.equal(locked, true, 'locked while the batch runs');
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

test('territories: Describe your own and Surprise me, no Mix it up; the one used last opens, else the first', async () => {
  const html = fs.readFileSync(WEB('index.html'), 'utf8');
  assert.doesNotMatch(html, /Mix it up/);
  const fresh = load({ routes: baseRoutes() });
  await settle(); await settle();
  assert.equal(fresh.$('worldSelect').value, 'Editorial Print', 'a project with nothing saved: the first territory');
  assert.equal(fresh.$('terrName').textContent, 'Editorial Print');
  const back = load({ routes: baseRoutes(), storage: { 'studioFilm:demo': JSON.stringify({ worldSelect: 'Harbor & Signal' }) } });
  await settle(); await settle();
  assert.equal(back.$('worldSelect').value, 'Harbor & Signal', 'the one used last in this project');
  const old = load({ routes: baseRoutes(), storage: { 'studioFilm:demo': JSON.stringify({ worldSelect: '' }) } });
  await settle(); await settle();
  assert.equal(old.$('worldSelect').value, 'Editorial Print', 'Mix it up saved before: the first territory instead');
  assert.match(html, /<option value="__custom__">Describe your own<\/option>/);
  assert.match(html, /<option value="__wildcard__">Surprise me/);
});

test('every inline handler in the markup and templates is exported on window', () => {
  const html = fs.readFileSync(WEB('index.html'), 'utf8');
  const app = fs.readFileSync(WEB('src', 'app.js'), 'utf8');
  const used = new Set();
  for (const m of (html + app).matchAll(/\bon[a-z]+="([^"]*)"/g)) {         // every call in a handler, not just one: "closeProjectMenu(); chooseProjectFile()" hid the first
    for (const c of m[1].matchAll(/(?<![\w.$'])([A-Za-z_]\w*)\(/g)) used.add(c[1]);
  }
  for (const n of ['event', 'if', 'setTimeout', 'String', 'Number', 'parseFloat', 'parseInt']) used.delete(n);
  // what the page really shares: the names in its Object.assign(window, {...}) (the node harness makes every function global, a
  // browser does not: a handler calling an unshared one fails only in the real page)
  const block = app.slice(app.lastIndexOf('Object.assign(window, {'));
  const shared = new Set([...block.slice(block.indexOf('{') + 1, block.indexOf('});')).matchAll(/([A-Za-z_]\w*)/g)].map(m => m[1]));
  for (const m of app.matchAll(/window\.([A-Za-z_]\w*)\s*=/g)) shared.add(m[1]);
  const builtins = new Set(['alert', 'confirm', 'history', 'location']);
  const missing = [...used].filter(n => !shared.has(n) && !builtins.has(n)).sort();
  assert.deepEqual(missing, []);
  assert.ok(used.size >= 20);
});

test('the page entry is a module with a stylesheet, and markup has no inline script or style blocks', () => {
  const html = fs.readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/src\/app.js">/);
  assert.match(html, /<link rel="stylesheet" href="\/src\/style.css"/);
  assert.doesNotMatch(html, /<style>/);
});

// ---------- cut plan, zoom and invert: fixed vectors (the old export had the same answers) ----------

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
  const saved = savedOf(store);
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

test('an export is the film as it was when Export was pressed: changes made while it renders go into the next one', async () => {
  const r = baseRoutes();
  r['/api/export-video'] = { ok: true, images: 3, seconds: 2, video_url: '/outputs/x.mp4', filename: 'x.mp4' };
  let h;
  r['/api/export-frame'] = () => {                                      // while the frames render, the user changes things
    h.$('bpmInput').value = '300'; h.$('musicSelect').value = 'on'; h.$('invertSelect').value = 'mono'; h.$('zoomSelect').value = 'in';
    return { ok: true };
  };
  h = load({ routes: r });
  await settle(); await settle();
  h.$('bpmInput').value = '136'; h.$('musicSelect').value = 'off'; h.$('invertSelect').value = 'off'; h.$('zoomSelect').value = 'off';
  await h.run('exportVideo()');
  const body = h.calls.find(c => c.url === '/api/export-video').body;
  assert.deepEqual([body.bpm, body.music, body.invert_mode, body.zoom_mode], [136, 'off', 'off', 'off'], 'as when Export was pressed');
  assert.equal(h.calls.filter(c => c.url === '/api/export-audio').length, 0, 'silent then: no sound sent, none taken from an earlier export');
});

test('export leaves the preview alone and downloads the file by itself (no Download again link shown)', async () => {
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
  assert.equal(typeof body.frames, 'number', 'the page says how many frames it drew (the browser tests check the drawing)');
  assert.equal(h.$('stageImg').src, '/p/a');
  assert.equal(h.$('stageImg').style.display, 'block');
  const link = h.$('downloadLink');
  assert.notEqual(link.hidden, false, 'never shown: the file saves itself');
  assert.equal(link.href, '/outputs/Demo-136bpm-x4-20261025-093005.mp4');
  assert.equal(link.download, 'Demo-136bpm-x4-20261025-093005.mp4');
  assert.equal(h.$('exportFile').textContent, 'Demo-136bpm-x4-20261025-093005.mp4');
  assert.match(h.$('toast').textContent, /12 images, 6s/);
  assert.equal(h.$('exportDock').dataset.state, 'ready');                 // "Downloaded" for a moment, then Export again: no Export again / Download again
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

test('the Trash: Empty trash at the top; what is picked gets Restore and Delete in the floating bar, as in the Selection', async () => {
  const h = await inTrash();
  assert.equal(h.$('trashBar').hidden, false);
  assert.equal(h.$('trashEmpty').textContent, 'Empty trash…');
  assert.match(h.$('trashEmpty').title, /all 4 images/);
  assert.equal(h.$('trashSelCount').textContent, 'Pick images to restore or delete');
  assert.equal(h.$('pickBar').hidden, true, 'nothing picked: no bar');
  h.run(`cardClick(${JSON.stringify(ev())}, '2_b')`);
  assert.equal(h.$('pickBar').hidden, false);
  assert.ok(h.$('pickBar').classList.contains('in-trash'), 'the Trash\'s actions in it');
  assert.equal(h.$('pickCount').textContent, '1 picked');
  assert.equal(h.$('trashDelSel').textContent, 'Delete…', 'the count is beside them, once');
  assert.equal(h.$('trashRestoreSel').textContent, 'Restore');
  h.run(`cardClick(${JSON.stringify(ev())}, '2_b')`);                  // click again deselects
  assert.equal(h.$('pickBar').hidden, true);
  h.run(`cardClick(${JSON.stringify(ev())}, '2_b')`);
  h.run('clearPicks()');                                                // × or Esc
  assert.equal(h.$('pickBar').hidden, true);
  await h.run('setTrashView(false)');
  assert.equal(h.$('trashBar').hidden, true);
});

test('the Selection: picked images go to the Trash in one go, and one undo puts them all back where they were', async () => {
  const h = load({ routes: trashRoutes({ '/api/state': { plates: [mkPlate('1_a', false), mkPlate('2_b', false), mkPlate('3_c', false), mkPlate('4_d', true)] },
                                          '/api/trash': { ok: true }, '/api/reorder': { ok: true } }) });
  await settle(); await settle();
  const live = h.run('JSON.stringify(plates.filter(p => !p.trashed).map(p => p.filename))');
  const two = JSON.parse(live).slice(0, 2);
  h.run(`pickSel = new Set(${JSON.stringify(two)}); syncSelection()`);
  assert.equal(h.$('pickBar').hidden, false);
  assert.ok(!h.$('pickBar').classList.contains('in-trash'));
  h.calls.length = 0;
  await h.run('trashPicked()');
  assert.deepEqual(h.calls.filter(c => c.url === '/api/trash').map(c => [c.body.filename, c.body.trashed]), two.map(f => [f, true]));
  assert.equal(h.$('pickBar').hidden, true, 'the picks are done with');
  assert.match(h.$('toast').textContent, /2 images moved to Trash/);
  h.calls.length = 0;
  await h.run('undoLast()');
  assert.deepEqual(h.calls.filter(c => c.url === '/api/trash').map(c => [c.body.filename, c.body.trashed]), two.map(f => [f, false]), 'one undo, both back');
  assert.deepEqual(h.calls.find(c => c.url === '/api/reorder').body.order.slice(0, 2), two, 'in their places');
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
  assert.deepEqual(JSON.parse(JSON.stringify(play.params)), { pulse: 0.4, low: 0.8, bright: 0.2, width: 0.9, space: 0.75, power: 0.55, pitch: 0.5, chord: 0, prog: 0, mode: 0, pad: 0, tape: 0, progEvery: 0, bass: 0, bassPattern: 0, bassRate: 0, arrange: 0, movement: 0.5, echo: 0, wash: 0, ring: 0, shimmer: 0, choir: 0, industrial: 0, hitType: 0, hit: 0, hitOn: 0, arp: 0, arpMood: 0, arpSteps: 0, arpRate: 0, dynamics: 0, subWave: 0, padWave: 0, seed: 42, paired: true, landAt: 0.4 });
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
  const saved = savedOf(h.store);
  assert.deepEqual([saved.musicSelect, saved.echoRange, saved.chordSelect], ['on', '30', '2']);
});

// ---------- the rhythm: one tempo, at most one change ----------

test('baseStarts: one speed is the beat grid; a change holds the tempo before `from`, eases to the end by `to` (the curve waits, then changes), then holds', () => {
  const h = load({ routes: baseRoutes() });
  const near = (a, b) => assert.ok(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.001), `${a} vs ${b}`);
  near(clean(h.run('baseStarts(4, 120, null)')), [0, 15, 30, 45, 60]);
  const lens = (ch, n = 10) => { const t = clean(h.run(`baseStarts(${n}, 120, ${JSON.stringify(ch)})`)); return t.slice(1).map((v, i) => v - t[i]); };
  const even = lens({ from: 0.5, to: 1, end_ms: 1000, curve: 0 });
  assert.ok(even.slice(0, 5).every(l => Math.abs(l - 15) < 1e-9), 'before the change: the tempo (500 ms, 15 frames)');
  assert.ok(even.slice(5).every((l, i, a) => i === 0 || l > a[i - 1]), 'then slower and slower');
  assert.ok(Math.abs(even[9] - (500 * Math.pow(2, 0.9) * 30) / 1000) < 1e-6, 'geometric: the last cut (at 90% of the change) is 500 × 2^0.9 ms');
  const sharp = lens({ from: 0.5, to: 1, end_ms: 1000, curve: 1 });
  assert.ok(sharp[7] < even[7], 'a curve waits longer before changing');
  const held = lens({ from: 0, to: 0.5, end_ms: 100, curve: 0 });
  assert.ok(held.slice(5).every(l => Math.abs(l - 3) < 1e-9), 'after the change: the end speed (100 ms, 3 frames)');
  const fastest = lens({ from: 0, to: 0.1, end_ms: 50, curve: 0 }, 4);
  assert.ok(fastest.every(l => l >= 1), 'never under a frame');
  assert.equal(h.run('msAtShare(0.3, 120, {from:0.5,to:1,end_ms:1000,curve:0})'), 500);
});

test('a change on the timeline drives the cuts in frames, the summary, the sound and the export', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a'), mkPlate('b'), mkPlate('c')] };
  r['/api/export-video'] = { ok: true, images: 3, seconds: 2, video_url: '/outputs/x.mp4', filename: 'x.mp4' };
  r['/api/export-audio'] = { ok: true, bytes: 44 };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('bpmInput').value = '600'; h.$('multSelect').value = '1';                       // the tempo, 100 ms: where the change starts
  h.$('rhythmSelect').value = 'variable'; h.$('changeFrom').value = '0.5'; h.$('changeTo').value = '1'; h.$('endMsRange').value = '600'; h.$('curveVal').value = '0';
  h.run('updateRhythm()');
  assert.deepEqual(clean(h.run('changeParams()')), { from: 0.5, to: 1, end_ms: 600, curve: 0 });
  const starts = clean(h.run('timelineFor(3)'));
  h.$('repeatSelect').value = '2'; h.run('updateTempo()');                          // Repeat ×2: the images go round twice, the film twice as long
  const twice = clean(h.run('timelineFor(3)'));
  assert.equal(twice.length - 1, 2 * (starts.length - 1));
  assert.equal(h.run("document.getElementById('repeatVal').textContent"), '×2');
  assert.equal(h.$('rsLoops').innerHTML.split('<i').length - 1, 1, 'one line where the images start round again');
  h.$('repeatSelect').value = '1'; h.run('updateTempo()');
  assert.equal(starts.length, 4); assert.equal(starts[1], 3);
  assert.ok(starts[3] - starts[2] > starts[2] - starts[1], 'slowing down at the end');
  h.$('musicSelect').value = 'on';
  await h.run('exportVideo()');
  const sent = h.ctx.__drone.exports[0].starts;
  assert.ok(Math.abs(sent[1] - 0.1) < 1e-9, 'the sound gets seconds, not frames');
  assert.ok(Math.abs(sent[sent.length - 1] - starts[3] / 30) < 1e-9);
  const body = h.calls.find(c => c.url === '/api/export-video').body;
  assert.deepEqual([body.rhythm, body.bpm, body.end_ms], ['variable', 600, 600]);
  h.run('removeChange()');
  assert.equal(h.$('rhythmSelect').value, 'flat');
  h.$('bpmInput').value = '120'; h.$('multSelect').value = '2'; h.run('updateTempo()');
  assert.equal(clean(h.run('timelineFor(3)')).join(), '0,7.5,15,22.5', 'one speed: 120 BPM ×2 = 7.5 frames a cut');
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

test('settings from before the timeline (Flat / Variable with Start, End, Change over, Change at) open as the same film, saved and in snapshots', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 40 }, (_, i) => mkPlate('p' + i)) };
  const old = { rhythmSelect: 'variable', startMsRange: '100', endMsRange: '700', rampRange: '10', atSelect: 'end', multSelect: '1', bpmInput: '20' };
  const h = load({ routes: r, storage: { studioSettings: JSON.stringify(old) } });
  await settle(); await settle();
  assert.equal(h.$('bpmInput').value, '600', 'Start 100 ms becomes the tempo');
  assert.equal(h.$('endMsRange').value, '700');
  assert.deepEqual([+h.$('changeFrom').value, +h.$('changeTo').value], [1 - 10 / 60, 1].map(v => +v.toFixed(4)), 'a landing over its last cuts (before the images load: 60 assumed)');
  const m = clean(h.run(`migrateRhythm(${JSON.stringify({ ...old, atSelect: 'start' })})`));
  assert.deepEqual([m.changeFrom, +m.changeTo], ['0', 0.25], 'a build-up: 10 of 40 music cuts at the start');
  assert.equal('rampRange' in m || 'startMsRange' in m || 'atSelect' in m, false, 'the old keys go');
  const flat = clean(h.run(`migrateRhythm(${JSON.stringify({ rhythmSelect: 'flat', bpmInput: '90', startMsRange: '100', rampRange: '3', atSelect: 'end' })})`));
  assert.deepEqual(flat, { rhythmSelect: 'flat', bpmInput: '90' });
  h.run(`applySnap(${JSON.stringify({ ...old, startMsRange: '200' })})`);         // a snapshot from before
  assert.equal(h.$('bpmInput').value, '300');
});

test('the multiple only changes the picture: the music keeps its cuts, with one speed or a change', async () => {
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
  h.$('rhythmSelect').value = 'variable'; h.$('bpmInput').value = '200'; h.$('changeFrom').value = '0'; h.$('changeTo').value = '1'; h.$('endMsRange').value = '300'; h.$('multSelect').value = '3'; h.run('updateRhythm(); updateTempo()');
  const v = JSON.parse(JSON.stringify(h.run('rhythmFor(8)')));
  assert.ok(Math.abs(v.pic[1] - 3) < 1e-9);                                                             // 300 ms base cut / 3
  assert.ok(Math.abs(v.audio[1] - 0.3) < 1e-9);
});

// ---------- extremes: the page's rhythm in every combination ----------

function clean(v) { return JSON.parse(JSON.stringify(v)); }

test('rhythmFor is a clean timeline for every tempo, multiple, invert mode and number of images, with one speed or a change', async () => {
  for (const nImages of [0, 1, 2, 9, 133, 500]) {
    const r = baseRoutes();
    r['/api/state'] = { plates: Array.from({ length: nImages }, (_, i) => mkPlate('p' + i)) };
    const h = load({ routes: r });
    await settle(); await settle();
    for (const variable of [false, true]) for (const invert of ['off', 'mono', 'colour']) for (const bpm of [40, 136, 250, 1200]) for (const mult of ['0.25', '1', '1.3333333', '4', '9']) {
      h.$('rhythmSelect').value = variable ? 'variable' : 'flat'; h.$('invertSelect').value = invert; h.$('bpmInput').value = String(bpm); h.$('multSelect').value = mult;
      h.$('changeFrom').value = bpm === 136 ? '0' : '0.4'; h.$('changeTo').value = bpm === 136 ? '0.3' : '1'; h.$('endMsRange').value = bpm === 250 ? '50' : '1500'; h.$('curveVal').value = bpm === 40 ? '1' : '0.3';
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
  assert.doesNotThrow(() => h.run('updateRhythm(); updateTempo(); updateMusic(); addChange(0.5); removeChange(); renderRhythmStrip()'));
});

test('extreme values on the timeline stay sane: positions, speeds and the curve are kept inside their ranges', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a')] };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('rhythmSelect').value = 'variable'; h.$('changeFrom').value = '5'; h.$('changeTo').value = '-1'; h.$('endMsRange').value = '99999'; h.$('curveVal').value = '9';
  h.run('updateRhythm()');
  assert.deepEqual(clean(h.run('changeParams()')), { from: 0.98, to: 1, end_ms: 1500, curve: 1 });
  for (const v of ['abc', '', 'NaN']) { h.$('changeFrom').value = v; h.$('endMsRange').value = v; assert.ok(Number.isFinite(h.run('changeParams()').from) && h.run('changeParams()').end_ms === 600, v); }
  h.$('bpmInput').value = '99999'; h.$('multSelect').value = '9'; h.run('updateTempo()');
  assert.equal(h.run('bpmValue()'), 1200);
  assert.ok(clean(h.run('timelineFor(1)')).every(Number.isFinite));
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

test('the tempo is 40 to 1200 BPM (1500 to 50 ms a music cut), and whatever it holds is kept inside that', () => {
  const { run, $, store } = load({ routes: baseRoutes() });
  $('multSelect').value = '1';
  for (const [typed, bpm] of [['0', 40], ['-50', 40], ['1200', 1200], ['9999', 1200], ['12.5', 40], ['', 120], ['abc', 120], ['  90 ', 90], ['1e2', 100], ['500', 500]]) {
    $('bpmInput').value = typed; run('updateTempo()');
    assert.equal(run('bpmValue()'), bpm, `value "${typed}"`);
    assert.equal($('tempoVal').textContent, `${Math.round(bpm)} BPM`);
    const t = JSON.parse(JSON.stringify(run('rhythmFor(3)')));
    assert.ok(t.pic.every(Number.isFinite) && t.audio.every(Number.isFinite), `value "${typed}"`);
  }
  assert.equal(savedOf(store).bpmInput, '500');
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
  assert.equal(savedOf(h.store).followCuts !== undefined, true);
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
      const ch = h.run('changeParams()'), s = 60000 / +h.$('bpmInput').value;
      assert.ok(s >= 55 && s <= 905 && ch.end_ms >= 60 && ch.end_ms <= 900, `a change ${s} → ${ch.end_ms}`);
      assert.ok(ch.from >= 0 && ch.to <= 1 && ch.to > ch.from && (ch.from === 0 || ch.to === 1), `at the start or the end: ${ch.from}–${ch.to}`);
      assert.ok([0, 0.15, 0.3].includes(ch.curve));
    }
    assert.ok(['off', 'mono', 'colour'].includes(h.$('invertSelect').value) && ['off', 'out', 'in'].includes(h.$('zoomSelect').value));
    const z = +h.$('zoomAmt').value; assert.ok(z >= 0.2 && z <= 3, `zoom ${z}`);
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
        const ch = h.run('changeParams()'), st = 60000 / +h.$('bpmInput').value, en = ch.end_ms;
        assert.ok(st >= c.rhythm.start[0] - 5 && st <= c.rhythm.start[1] + 5 && en >= c.rhythm.end[0] - 5 && en <= c.rhythm.end[1] + 5, `${key} ${st} → ${en}`);
        assert.ok([].concat(c.rhythm.at).includes(ch.from === 0 && ch.to < 1 ? 'start' : 'end'), `${key}: a ${c.rhythm.at} (${ch.from}–${ch.to})`);
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
  assert.equal(savedOf(h.store).choirRange, '40', 'remembered');
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
  const seen = [0, 0, 0, 0, 0, 0, 0, 0];
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
  assert.equal(savedOf(h.store).arpMoodSelect, '3', 'remembered');
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
  assert.equal(savedOf(h.store).progSelect, '1');
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

test('polyrhythm: Random picks one now and then', async () => {
  const h = await playerWith();
  let poly = 0;
  for (let i = 0; i < 200; i++) { h.run('randomAll()'); if (+h.$('arpRateSelect').value >= 4) poly++; }
  assert.ok(poly > 5 && poly < 80, `a polyrhythm now and then (${poly} of 200)`);
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
  const saved = savedOf(h.store);
  assert.equal(saved.followCuts, true);
  const again = load({ routes: baseRoutes(), storage: { ...h.store } });
  again.$('followCuts').type = 'checkbox';
  again.run('restoreSettings()');
  assert.equal(again.$('followCuts').checked, true);
});


test('the timeline is drawn from the real timeline: a tick per picture cut, the speed line on its log scale, the band, the points, the beats', async () => {
  const h = await playerWith();                                                  // 3 images, 120 BPM ×2
  const plain = o => JSON.parse(JSON.stringify(o));
  let m = plain(h.run('rhythmStripModel(3)'));
  const pic = plain(h.run('timelineFor(3)'));
  assert.equal(m.ticks.length, 3);
  assert.deepEqual(m.ticks.map(x => +x.toFixed(3)), pic.slice(0, -1).map(f => +((f / pic.at(-1)) * 1000).toFixed(3)));
  const y500 = h.run('yOfMs(500)');
  assert.ok(m.curve.every(([, y]) => Math.abs(y - y500) < 1e-9), 'one speed is a flat line at the tempo\'s height');
  assert.ok(Math.abs(h.run('yOfMs(50)')) < 1e-9 && Math.abs(h.run('yOfMs(1500)') - 100) < 1e-9, '50 ms at the top, 1500 at the bottom');
  assert.equal(m.band, null); assert.deepEqual(m.points, []); assert.equal(m.handle, null);
  assert.deepEqual(m.beats.map(Math.round), [0, 667], 'the music on its cuts: every second picture cut at ×2');
  h.$('followCuts').checked = true; h.run('updateTempo()');
  assert.equal(plain(h.run('rhythmStripModel(3)')).beats.length, 3, 'or on every picture cut');
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 24 }, (_, i) => mkPlate('p' + i)) };
  const v = load({ routes: r }); await settle(); await settle();
  v.$('bpmInput').value = '600'; v.$('rhythmSelect').value = 'variable'; v.$('changeFrom').value = '0.5'; v.$('changeTo').value = '1'; v.$('endMsRange').value = '600'; v.$('curveVal').value = '0'; v.$('multSelect').value = '1';
  v.run('updateTempo(); updateRhythm()');
  m = plain(v.run('rhythmStripModel(24)'));
  const ys = m.curve.map(([, y]) => y);                                         // the speed, sampled over the film
  assert.ok(ys.slice(0, 100).every(y => Math.abs(y - v.run('yOfMs(100)')) < 1e-9), 'the tempo holds until the change');
  for (let i = 102; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], 'then it slows down all the way');
  assert.ok(Math.abs(ys.at(-1) - v.run('yOfMs(600)')) < 1e-9, 'to the End speed');
  const k = m.curve.findIndex(([x]) => x >= m.handle.x), [xa, ya] = m.curve[k - 1], [xb, yb] = m.curve[k];
  assert.ok(Math.abs(m.handle.y - (ya + ((yb - ya) * (m.handle.x - xa)) / (xb - xa))) < 0.5, 'the curve handle sits on the line');
  const band = m.points.map(q => q.x);
  assert.ok(Math.abs(m.handle.x - (band[0] + band[1]) / 2) < 1e-6, 'at the middle of the change as drawn');
  const vpic = plain(v.run('timelineFor(24)'));
  assert.ok(Math.abs(m.band.left - (vpic[12] / vpic.at(-1)) * 100) < 1e-6 && Math.abs(m.band.left + m.band.width - 100) < 1e-6, 'the band runs from Start to End');
  assert.deepEqual(m.points.map(p => [p.name, p.ms]), [['Start', 100], ['End', 600]]);
  assert.ok(m.handle && m.handle.x > m.points[0].x && m.handle.x < m.points[1].x, 'the curve handle sits inside the change');
  assert.ok(Math.abs(v.run('shareAt(rsModel.points[1].x / 1000)') - 1) < 0.02 && Math.abs(v.run('shareAt(rsModel.points[0].x / 1000)') - 0.5) < 0.02, 'a point\'s place in time maps back to its share');
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
  h.run("setMode('curate')");
  key('ArrowRight'); key('0'); key('r');
  assert.equal(h.run('currentIdx'), 0, "the Film's keys do nothing in Curate (free there for its own use)");
  h.run("setMode('film')");
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
  const snap = () => ['rhythmSelect', 'bpmInput', 'changeFrom', 'multSelect', 'invertSelect', 'zoomSelect', 'pulseRange', 'chordSelect', 'seedVal', 'musicSelect'].map(id => h.$(id).value).join('|');
  const before = snap();
  h.run('randomAll()');
  assert.notEqual(snap(), before);
  key('z', { ctrlKey: true });
  assert.equal(snap(), before, 'Ctrl+Z undoes a Random');
  key('z', { metaKey: true });                                                     // nothing left: harmless
});


test('the Start and End labels give the music cut only, with or without a Multiple', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 24 }, (_, i) => mkPlate('p' + i)) };
  const h = load({ routes: r }); await settle(); await settle();
  h.$('bpmInput').value = '75'; h.$('rhythmSelect').value = 'variable'; h.$('changeFrom').value = '0'; h.$('changeTo').value = '0.5'; h.$('endMsRange').value = '110'; h.$('multSelect').value = '2';
  h.run('updateTempo(); updateRhythm()');
  assert.equal(h.$('rsStartL').textContent, 'Start 800 ms', 'no picture count on the point');
  assert.equal(h.$('rsEndL').textContent, 'End 110 ms');
  h.$('multSelect').value = '1'; h.run('updateTempo()');
  assert.equal(h.$('rsEndL').textContent, 'End 110 ms');
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
  assert.match(html, /id="countField" role="spinbutton"[^>]*aria-valuemin="1" aria-valuemax="20"/, 'the count: a number, 1 to 20');
  assert.deepEqual(opts('multSelect'), ['0.25=×¼', '0.5=×½', '1=×1', '1.3333333=×1⅓', '2=×2', '3=×3', '4=×4', '6=×6', '8=×8', '9=×9']);
  assert.deepEqual(opts('rhythmSelect'), ['flat=One speed', 'variable=A change']);
});

// ---- bugs found by the code review of the redesign (each test reproduces the reported steps) ----


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
  h.run("setMode('film')");
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
  assert.equal(h.run('history[0].label'), 'the tempo');
  const inv0 = h.$('invertSelect').value;
  h.$('invertSelect').value = 'mono'; h.run('updateFx()');
  // trashing: a step, after the settings change (which is committed first)
  await h.run("setTrash({ stopPropagation() {} }, 'b', true)");
  assert.deepEqual(JSON.parse(JSON.stringify(h.run('history.map(s => s.label)'))), ['the tempo', 'a setting', 'Trash “b”'], 'the invert, committed before the trash: in the order they happened');
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
  assert.equal(savedOf(h.store).bpmLock, true, 'remembered');
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
  const TRAIL_VECTORS = [[0.0, 0.4, 0.4], [0.9, 0.4, 0.4], [1.0, 0.4, 0.3], [3.5, 0.4, 0.1], [4.0, 0.4, 0.0], [-0.5, 0.4, 0.0], [0.0, 0.0, 0.0], [0.0, 5.0, 0.6]];   // the fade over 4 frames
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

test('Generate without Krea or Kimi opens Settings on what is missing; without a project, the project menu', async () => {
  const demo = { slug: 'demo', name: 'Demo', mark_size: 18, mark_x: 50, mark_y: 50, mark_url: '/m', round: true, fixed: true };
  const r = baseRoutes();
  r['/api/state'] = { plates: [], krea_connected: false, kimi_configured: true, project: demo };
  const h = load({ routes: r });
  await settle(); await settle();
  await h.run('generateImages()');
  assert.equal(h.$('settingsPopover').classList.contains('open'), true, 'Settings opens');
  assert.match(h.$('toast').textContent, /Connect Krea/);
  assert.equal(h.calls.some(c => c.url === '/api/invent-prompts'), false, 'nothing is asked of Kimi or Krea');
  h.run('toggleSettings(false); kimiConfigured = false');
  h.$('kimiKeyInput').value = '';
  await h.run('generateImages()');
  assert.equal(h.$('settingsPopover').classList.contains('open'), true);
  assert.match(h.$('toast').textContent, /Kimi API key/);
  h.run('toggleSettings(false); project = null');
  await h.run('generateImages()');
  assert.equal(h.$('settingsPopover').classList.contains('open'), false);
  assert.match(h.$('toast').textContent, /Make a project or import one first/);
});

test('no AI critic: no score on a card or in Info, no boxes in Settings (removed: its scores did not tell kept from trashed)', async () => {
  const h = load({ routes: baseRoutes() });
  await settle(); await settle();
  assert.doesNotMatch(require('fs').readFileSync(require('path').join(__dirname, '../../web/index.html'), 'utf8'), /critic/i, 'nothing about it in Settings');
  const html = h.run(`cardHtml(${JSON.stringify({ ...mkPlate('x.jpg'), qa_passed: true, critic: { mean: 6.8, reason: 'calm' } })})`);   // an older image still carries its score
  assert.doesNotMatch(html, /AI critic|AI 6\.8/);
});

test('AI re-order is off under two images and says why', async () => {
  const h = load({ routes: baseRoutes() });
  await settle(); await settle();
  assert.equal(h.$('aiBtn').disabled, true);
  assert.match(h.$('aiBtn').title, /at least two images/);
  h.run(`plates = [{ filename: 'a.jpg', trashed: false }, { filename: 'b.jpg', trashed: false }]; renderSequences()`);
  assert.equal(h.$('aiBtn').disabled, false);
});

test('New project needs the Kimi key: without it Settings opens on the key, not the form', async () => {
  const r = baseRoutes();
  r['/api/state'] = { ...r['/api/state'], kimi_configured: false };
  const h = load({ routes: r });
  await settle(); await settle();
  h.run("openProjectForm('new')");
  assert.equal(h.$('settingsPopover').classList.contains('open'), true);
  assert.match(h.$('toast').textContent, /Add your Kimi API key to create a project/);
  assert.equal(h.$('projectModal').classList.contains('open'), false, 'the form stays closed');
});

test('Krea in Settings: Connect Krea when signed out, only Sign out of Krea once connected', async () => {
  const r = baseRoutes();
  r['/api/state'] = { ...r['/api/state'], krea_connected: true };
  const h = load({ routes: r });
  await settle(); await settle();
  assert.equal(h.$('kreaConnectBtn').hidden, true);
  assert.equal(h.$('kreaSignOutBtn').hidden, false);
  r['/api/state'].krea_connected = false;
  await h.run('loadState()');
  assert.equal(h.$('kreaConnectBtn').hidden, false);
  assert.equal(h.$('kreaSignOutBtn').hidden, true);
});

test('a Kimi key that Kimi refuses: not kept, the field empties, Settings says Key refused and why', async () => {
  const r = baseRoutes();
  r['/api/save-settings'] = { ok: false, kimi_key_status: 'refused', kimi_configured: false, error: 'Kimi refused that key. Copy the API key (it starts with sk-) from platform.moonshot.ai or kimi.com.' };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('kimiKeyInput').value = 'depiano-studio';
  await h.run('saveKimiSettings()');
  assert.equal(h.$('kimiKeyInput').value, '');
  assert.equal(h.$('kimiStatusLabel').textContent, 'Key refused');
  assert.match(h.$('toast').textContent, /starts with sk-/);
});

test('Info on a card says why the mark check flagged it', async () => {
  const h = load({ routes: baseRoutes() });
  await settle(); await settle();
  const html = h.run(`cardHtml(${JSON.stringify({ ...mkPlate('x.jpg', true), qa_passed: false, qa_issues: ['The mark looks too big (it fits about as well at 1.5x)']})})`);
  assert.match(html, /Mark check: The mark looks too big \(it fits about as well at 1\.5x\)/);
  assert.doesNotMatch(h.run(`cardHtml(${JSON.stringify({ ...mkPlate('y.jpg'), qa_passed: true })})`), /Mark check:/);
});

test('the film strip and ← →: every image can be reached, at any tempo (a cut start read back a hair early showed the image before)', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: Array.from({ length: 19 }, (_, i) => mkPlate('p' + i)), krea_connected: true, kimi_configured: true };
  const h = load({ routes: r }); await settle(); await settle();
  const bad = [];
  for (const [bpm, mult, inv] of [[172, '2', 'mono'], [172, '1', 'off'], [97, '3', 'colour'], [133, '4', 'mono'], [61, '1', 'mono']]) {
    h.$('bpmInput').value = String(bpm); h.$('multSelect').value = mult; h.$('invertSelect').value = inv; h.$('followCuts').checked = true;
    h.run('updateTempo(); updateRhythm(); updateFx()');
    for (let i = 0; i < 19; i++) { h.run(`jumpToPlate(${i})`); const got = h.run('currentIdx'); if (got !== i) bad.push(`${bpm} x${mult} ${inv}: ${i} -> ${got}`); }
    h.run('jumpToPlate(0)');
    for (let i = 1; i < 19; i++) { h.run('stepImage(1)'); const got = h.run('currentIdx'); if (got !== i) { bad.push(`${bpm} x${mult} ${inv}: right to ${i} gave ${got}`); break; } }
  }
  assert.deepEqual(bad, []);
});

test('each project keeps its own film and sound; one never opened here gets its own Random; Undo never crosses projects', async () => {
  const demo = { slug: 'demo', name: 'Demo', mark_size: 18, mark_x: 50, mark_y: 50, mark_url: '/m', round: true, fixed: true };
  const nike = { ...cos, slug: 'nike', name: 'Nike', fixed: false };
  const plates = Array.from({ length: 12 }, (_, i) => mkPlate('p' + i));
  // on DEMO: a film is made, it is saved as DEMO's
  let r = baseRoutes(); r['/api/state'] = { plates, project: demo, krea_connected: true, kimi_configured: true };
  let h = load({ routes: r, storage: { studioProject: 'demo' } }); await settle(); await settle();
  h.$('bpmInput').value = '97'; h.$('echoRange').value = '31'; h.$('worldSelect').value = '';
  h.run('updateTempo(); updateMusic(); saveSettings()');
  const store = { ...h.store };
  assert.equal(JSON.parse(store['studioFilm:demo']).bpmInput, '97');
  assert.equal(JSON.parse(store.studioSettings).bpmInput, undefined, 'the shared settings hold no film');
  // the server opens Nike, never opened here: a Random of its own, not DEMO's film
  r = baseRoutes(); r['/api/state'] = { plates, project: nike, krea_connected: true, kimi_configured: true };
  h = load({ routes: r, storage: store }); await settle(); await settle();
  const nikeFilm = JSON.parse(h.store['studioFilm:nike']);
  assert.ok(nikeFilm.bpmInput !== '97' || nikeFilm.echoRange !== '31', 'its own Random');
  assert.equal(h.store.studioProject, 'nike');
  assert.equal(h.run('history.length'), 0, 'Undo does not go back to DEMO\'s film');
  h.$('bpmInput').value = '144'; h.run('updateTempo(); saveSettings()');
  // back on DEMO: DEMO's film as it was left
  r = baseRoutes(); r['/api/state'] = { plates, project: demo, krea_connected: true, kimi_configured: true };
  const h2 = load({ routes: r, storage: { ...h.store } }); await settle(); await settle();
  assert.equal(h2.$('bpmInput').value, '97'); assert.equal(h2.$('echoRange').value, '31');
  assert.equal(JSON.parse(h2.store['studioFilm:nike']).bpmInput, '144', 'and Nike keeps its own');
});

test('settings saved before films were per project become the first project\'s, not a Random', async () => {
  const r = baseRoutes();
  r['/api/state'] = { plates: [mkPlate('a'), mkPlate('b')], project: { slug: 'demo', name: 'Demo', mark_size: 18, mark_x: 50, mark_y: 50, mark_url: '/m' }, krea_connected: true, kimi_configured: true };
  const h = load({ routes: r, storage: { studioProject: undefined, studioSettings: JSON.stringify({ bpmInput: '88', echoRange: '12', thumbSizeVal: 'L' }) } });
  await settle(); await settle();
  assert.equal(h.$('bpmInput').value, '88'); assert.equal(h.$('echoRange').value, '12');
  assert.equal(JSON.parse(h.store['studioFilm:demo']).bpmInput, '88');
  assert.equal(JSON.parse(h.store.studioSettings).thumbSizeVal, 'L', 'the shared ones stay shared');
});

test('an image the mark check trashed has one badge, Mark check, with the reason on hover (not also QA flagged)', async () => {
  const h = load({ routes: baseRoutes() });
  await settle(); await settle();
  const html = h.run(`cardHtml(${JSON.stringify({ ...mkPlate('x.jpg'), trashed: true, trash_reason: 'Mark check', qa_passed: false, qa_issues: ['The mark is not at its place and size (fit 0.30)'] })})`);
  assert.match(html, /class="card-model-badge warn" title="The mark is not at its place and size \(fit 0\.30\)">Mark check</);
  assert.doesNotMatch(html, /QA flagged/);
});

test('a doubtful logo check stays in the selection with a "Check the mark" badge and its reason in Info', async () => {
  const h = load({ routes: baseRoutes() });
  await settle(); await settle();
  const html = h.run(`cardHtml(${JSON.stringify({ ...mkPlate('x.jpg'), qa_passed: true, qa_doubt: "Check the mark's size: it fits a little better at about 1.16x" })})`);
  assert.match(html, /class="card-model-badge doubt"[^>]*>Check the mark</);
  assert.match(html, /Mark check: Check the mark's size: it fits a little better at about 1\.16x/);
  assert.doesNotMatch(html, /QA flagged/);
});

test('errors in a few words: the offline Kimi error the user saw, Krea refusals, out of credits; anything else cut short', async () => {
  const h = load({ routes: baseRoutes() });
  await settle();
  const plain = raw => h.run(`plainError(${JSON.stringify(raw)})`);
  const seen = "Kimi API call failed (api.moonshot.ai (kimi-k3): <urlopen error [Errno 8] nodename nor servname provided, or not known> | api.moonshot.ai (kimi-k2.7-code): <urlopen error [Errno 8] nodename nor servname provided, or not known>)";
  assert.equal(plain(seen), 'No internet connection: check it, then try again.');
  assert.equal(plain('Kimi could not be reached (timed out)'), 'Kimi took too long to answer: try again.');
  assert.equal(plain('HTTP 401 (kimi-k3 @ api.moonshot.ai): Invalid Authentication'), 'Kimi refused the key: check it in Settings.');
  assert.equal(plain('Krea MCP: HTTP Error 401: Unauthorized'), 'Krea needs you to sign in again: Settings › Connect Krea.');
  assert.equal(plain('Krea: insufficient credits'), 'Krea is out of credits: add some at krea.ai.');
  assert.equal(plain('Krea 429: too many requests'), 'Krea is busy: try again in a minute.');
  assert.ok(plain('x'.repeat(300)).length <= 110);
});

test('Space in Curate plays and opens the floating preview if it was closed (so it is clear what plays)', async () => {
  const h = await playerWith();
  h.run("setMode('curate'); toggleMini(false)");
  h.ctx.onKey({ key: ' ', target: { tagName: 'BODY' }, preventDefault() {} });
  assert.equal(h.run('miniOpen'), true);
  assert.equal(h.run('isPlaying'), true);
});

test('the image viewer: a double-click opens what the grid shows, the arrows go round, Esc closes; the keys act on nothing behind it', async () => {
  const h = await playerWith();
  h.run("setMode('curate')");
  const n = h.run('visiblePlates().length');
  const second = h.run('visiblePlates()[1].filename');
  h.run(`openViewer(null, ${JSON.stringify(second)})`);
  assert.equal(h.$('viewer').hidden, false);
  assert.equal(h.$('viewerCount').textContent, `2 / ${n}`);
  const key = k => h.ctx.onKey({ key: k, target: { tagName: 'BODY' }, preventDefault() {} });
  key('ArrowLeft'); key('ArrowLeft');
  assert.equal(h.$('viewerCount').textContent, `${n} / ${n}`, 'round from the first to the last');
  key('t'); key('Tab');
  assert.equal(h.run('mode'), 'curate', 'nothing behind the viewer moves');
  key('Escape');
  assert.equal(h.$('viewer').hidden, true);
});

test('thumbnails: five sizes, a pinch steps through them and stops at either end, never the page zoom', async () => {
  const h = load({ routes: baseRoutes() });
  await settle(); await settle();
  h.run("setThumbSize('L')");
  let prevented = 0;
  const pinch = dy => h.run(`onGridWheel({ ctrlKey: true, deltaY: ${dy}, preventDefault() { globalThis.__p = (globalThis.__p || 0) + 1; } })`);
  pinch(-45); assert.equal(h.$('thumbSizeVal').value, 'XL');
  pinch(-45); pinch(-45); assert.equal(h.$('thumbSizeVal').value, 'XXL', 'stops at the largest');
  for (let i = 0; i < 6; i++) pinch(45);
  assert.equal(h.$('thumbSizeVal').value, 'S');
  h.run('onGridWheel({ ctrlKey: false, deltaY: 300, preventDefault() { throw new Error("a plain scroll is left alone"); } })');
  assert.equal(h.$('thumbSizeVal').value, 'S');
  h.run("onGridGesture({ type: 'gesturestart', preventDefault() {} }); onGridGesture({ type: 'gesturechange', scale: 1.4, preventDefault() {} }); onGridGesture({ type: 'gestureend', preventDefault() {} })");
  assert.equal(h.$('thumbSizeVal').value, 'M', "WebKit's pinch (the Mac app) steps too");
});

test('your groups keep their own order: shown and played in it; a drag or AI order there changes only the group; All and the automatic groups share one order', async () => {
  const r = baseRoutes();
  const P = (f, look) => ({ ...mkPlate(f), look });
  let state = { plates: [P('a', ['warm']), P('b', []), P('c', ['warm']), P('d', [])], groups: [{ id: 'g1', name: 'Night', files: ['d', 'a', 'c'] }], kimi_configured: true };
  r['/api/state'] = () => state;
  r['/api/groups'] = body => { if (body.action === 'reorder') state = { ...state, groups: [{ ...state.groups[0], files: body.files }] }; return { ok: true }; };
  r['/api/reorder'] = () => { throw new Error('All must not move'); };
  r['/api/order-ai'] = { ok: true, job: 'j1', steps: ['a'] };
  const h = load({ routes: r }); await settle(); await settle();
  h.run("setGroup('look:warm')");
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['a', 'c'], 'an automatic group: All\'s order');
  h.run("setGroup('g:g1')");
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['d', 'a', 'c'], 'your group: its own order');
  const drop = target => h.run(`onDrop({ preventDefault() {}, currentTarget: { classList: { remove() {} } } }, '${target}')`);
  h.run("draggedFilename = 'c'"); await drop('d'); await settle();
  assert.deepEqual(h.calls.filter(c => c.url === '/api/groups').pop().body, { action: 'reorder', id: 'g1', files: ['c', 'd', 'a'] });
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['c', 'd', 'a']);
  assert.equal(h.calls.filter(c => c.url === '/api/reorder').length, 0, 'All did not move');
  await h.run('undoLast()'); await settle();
  assert.deepEqual(h.run('activePlates().map(p => p.filename)'), ['d', 'a', 'c'], 'Undo puts the group back');
  h.ctx.setTimeout = () => 0;
  h.run('startAiOrder()'); await settle(); await settle();
  assert.equal(h.calls.find(c => c.url === '/api/order-ai').body.group, 'g1', 'AI order in your group: its own order');
});

test('the Sampler: asks for one image from each of N territories and names the batch Sampler', async () => {
  const r = genRoutes({ n: 4 });
  r['/api/invent-prompts'] = { ok: true, ideas: ['Editorial Print', 'Harbor & Signal', 'Fog', 'Sea'].map((w, i) => ({ title: `Idea ${i}`, prompt: `p${i}`, guide: 'dark', world: w })) };
  const h = load({ routes: r });
  await settle(); await settle();
  h.$('worldSelect').value = '__sampler__';
  h.run('renderGen()');
  assert.equal(h.$('terrName').textContent, 'Sampler');
  await runGenerate(h);
  assert.equal(h.calls.find(c => c.url === '/api/invent-prompts').body.world, '__sampler__');
  assert.equal(h.run('prog.world'), 'Sampler', 'the status bar names it, not the first territory');
});

test('after a reload mid-batch, Resume leaves out the images the server is still making, and a duplicate answer is not a failure', async () => {
  const r = genRoutes({ n: 2, gen: async () => ({ ok: false, duplicate: true, error: 'already being made' }) });
  r['/api/state'] = { ...r['/api/state'], making: ['Idea 0'] };
  const pending = JSON.stringify({ items: ['Idea 0', 'Idea 1'].map((title, i) => ({ title, prompt: `p${i}`, guide: 'dark', world: 'Fog' })), model: 'm', at: 1 });
  const h = load({ routes: r, storage: { 'studioPending:demo': pending } });
  await settle(); await settle();
  assert.match(h.$('statusText').innerHTML, /1 image of the last batch wasn't made/, 'the one still being made is not offered');
  await h.run("prog.actions.find(a => a.label === 'Resume').run()"); await settle(); await settle();
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(prog.slots)')), ['ok'], 'already being made: it arrives by itself');
  assert.doesNotMatch(h.$('statusText').innerHTML, /Retry/);
});
