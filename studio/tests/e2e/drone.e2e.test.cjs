// The live and the offline sound engine (studio/web/src/drone.js) in a real browser: levels, swaps, scheduling, and extreme inputs.
const { test, assert, register, fresh, page, consoleErrors, skip, api, film, choose } = require('./harness.cjs');
register();

const BASE = { pulse: 0.65, low: 0.93, bright: 0.3, width: 0.6, space: 0.6, power: 0.6, seed: 7 };

// A few helpers that live in the page: a tap on everything sent to the speakers, and plain statistics.
const TAP = () => {
  window.__tap = (() => {
    const orig = AudioNode.prototype.connect; let ctx = null; const blocks = [];
    AudioNode.prototype.connect = function (dst, ...a) { if (ctx && dst === ctx.destination && window.__sp) orig.call(this, window.__sp); return orig.call(this, dst, ...a); };
    return {
      attach(c, master) { ctx = c; const sp = c.createScriptProcessor(1024, 2, 2); window.__sp = sp; if (master) orig.call(master, sp);   // the live sound reaches the speakers through its master gain
        sp.onaudioprocess = e => { const d = e.inputBuffer.getChannelData(0); let s = 0, pk = 0; for (const v of d) { if (!Number.isFinite(v)) pk = Infinity; s += v * v; pk = Math.max(pk, Math.abs(v)); } blocks.push([Math.sqrt(s / d.length), pk]); }; sp.connect(c.destination); },
      mark() { return blocks.length; },
      since(n) { const seg = blocks.slice(n); const ms = seg.reduce((x, b) => x + b[0] ** 2, 0) / Math.max(1, seg.length); return { rms: Math.sqrt(ms), peak: Math.max(0, ...seg.map(b => b[1])), n: seg.length }; }
    };
  })();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('swapping the live sound does not make it louder or add spikes (the level stays within a few dB while settings move)', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async ({ BASE, TAP }) => {
    new Function(`(${TAP})()`)();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = new window.Drone.Live(); window.__tap.attach(L._context(), L.master);
    const starts = Array.from({ length: 200 }, (_, i) => i / 3);
    const measure = async (switching) => {
      await L.play(BASE, starts, 0);
      let stop = false, k = 0;
      const spam = switching ? (async () => { while (!stop) { L.update({ ...BASE, pulse: 0.65 + 0.001 * (k++ % 2) }, starts, () => L.pos()); await sleep(140); } })() : null;
      await sleep(1200);
      const n = window.__tap.mark(); await sleep(2500); const m = window.__tap.since(n);
      stop = true; if (spam) await spam;
      L.stop(); await sleep(500); return m;
    };
    const steady = await measure(false), moving = await measure(true);
    return { steady, moving };
  }, { BASE, TAP: TAP.toString() });
  assert.ok(r.moving.rms > r.steady.rms * 0.75 && r.moving.rms < r.steady.rms * 1.25, `level while switching ${r.moving.rms} vs steady ${r.steady.rms}`);
  assert.ok(r.moving.peak < r.steady.peak * 1.3, `no spikes at swaps: peak ${r.moving.peak} vs ${r.steady.peak}`);
  await ctx.close();
});

test('restart jumps the playing sound back to the start of the clip, even though its settings did not change', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async ({ BASE }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = new window.Drone.Live();
    const starts = Array.from({ length: 200 }, (_, i) => i / 3);
    await L.play(BASE, starts, 5);
    await sleep(600);
    const before = L.pos();
    L.restart();
    const right = [];                                                               // just after: the new sound has not begun yet
    for (let i = 0; i < 20; i++) { right.push(L.pos()); await sleep(2); }
    await sleep(260);
    const after = L.pos();
    window.__right = right;
    L.stop();
    return { before, after, right: window.__right };
  }, { BASE });
  assert.ok(r.right.every(p => p < 0.3), `never the end of the clip just after a restart (it flashed the last frame): ${r.right.map(p => p.toFixed(2))}`);
  assert.ok(r.before > 5.4, `it was running (${r.before})`);
  assert.ok(r.after < 0.8, `restart is back near the start (${r.after})`);
  await ctx.close();
});

test('a change that only moves the end of the clip (the picture Multiple) does not rebuild the music; a longer clip does', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async (BASE) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = new window.Drone.Live(); L._context();
    let swaps = 0; const orig = L._swap.bind(L); L._swap = o => { swaps++; orig(o); };
    const beats = n => Array.from({ length: n + 1 }, (_, i) => i / 3);
    await L.play({ ...BASE, landAt: 20 }, beats(60), 0);
    await sleep(300);
    const out = {};
    await L.update({ ...BASE, landAt: 5 }, beats(15), () => L.pos());           // a shorter clip, the same beats, another landing
    out.shorterSwaps = swaps; out.total = L.total;
    await L.update({ ...BASE, landAt: 30 }, beats(90), () => L.pos());           // a longer clip needs beats it does not have
    await sleep(200); out.longerSwaps = swaps;
    await L.update({ ...BASE, low: 0.2 }, beats(90), () => L.pos());             // a real change
    await sleep(300); out.changedSwaps = swaps;
    out.playing = L.playing; L.stop(); return out;
  }, BASE);
  assert.equal(r.shorterSwaps, 0); assert.equal(r.total, 5);
  assert.equal(r.longerSwaps, 1); assert.equal(r.changedSwaps, 2); assert.equal(r.playing, true);
  await ctx.close();
});

test('dragging a slider is coalesced: dozens of updates a second become a handful of swaps, and the last settings win', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async (BASE) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = new window.Drone.Live(); L._context();
    const seen = []; const orig = L._swap.bind(L); L._swap = o => { seen.push(JSON.stringify(L.params.low)); orig(o); };
    const starts = Array.from({ length: 100 }, (_, i) => i / 3);
    await L.play(BASE, starts, 0);
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) { L.update({ ...BASE, low: i / 100 }, starts, () => L.pos()); await sleep(16); }
    await sleep(400);
    const out = { swaps: seen.length, secs: (performance.now() - t0) / 1000, last: L.params.low, lastSwap: seen[seen.length - 1] };
    L.stop(); return out;
  }, BASE);
  assert.ok(r.swaps >= 1 && r.swaps <= Math.ceil(r.secs * 9) + 1, `${r.swaps} swaps in ${r.secs.toFixed(1)} s`);
  assert.equal(r.last, 0.59); assert.equal(r.lastSwap, '0.59');
  await ctx.close();
});

test('stopping while an update is waiting leaves nothing playing, and play / stop in a rush is harmless', { skip }, async () => {
  const ctx = await fresh();
  const errors = [];
  const r = await page.evaluate(async (BASE) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = new window.Drone.Live(); L._context();
    const starts = Array.from({ length: 50 }, (_, i) => i / 3);
    let swaps = 0; const orig = L._swap.bind(L); L._swap = o => { swaps++; orig(o); };
    await L.play(BASE, starts, 0);
    L.update({ ...BASE, low: 0.1 }, starts, () => L.pos()); L.stop();           // stopped with a swap pending
    await sleep(400);
    const afterStop = { swaps, playing: L.playing, inst: !!L.inst, holding: L.holding };
    for (let i = 0; i < 15; i++) { L.play(BASE, starts, i * 0.1); if (i % 3 === 0) L.stop(); await sleep(7); }
    await L.play(BASE, starts, 1); await sleep(300);
    const out = { afterStop, playing: L.playing, pos: L.pos() }; L.stop(); return out;
  }, BASE);
  assert.deepEqual(r.afterStop, { swaps: 0, playing: false, inst: false, holding: 0 });
  assert.equal(r.playing, true); assert.ok(r.pos >= 1 && r.pos < 2, `position ${r.pos}`);
  assert.deepEqual(consoleErrors.splice(0), errors);
  await ctx.close();
});

test('the level is worked out for the cut pattern too: slower and faster cuts do not share a gain', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async (BASE) => {
    const grid = (step, n) => Array.from({ length: n + 1 }, (_, i) => i * step);
    const heavy = { ...BASE, pulse: 1, power: 0.9 };
    return { slow: await window.Drone.level(heavy, grid(0.8, 20)), fast: await window.Drone.level(heavy, grid(0.1, 160)), slowAgain: await window.Drone.level(heavy, grid(0.8, 20)) };
  }, BASE);
  assert.ok(Math.abs(r.slow - r.fast) > 0.002, `slow ${r.slow} fast ${r.fast}`);
  assert.equal(r.slow, r.slowAgain);
  await ctx.close();
});

test('extreme clips: one cut, a one-frame cut, nothing to cut on, a very long fast run, odd settings, odd offsets', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async (BASE) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const all = { ...BASE, echo: 0.5, wash: 0.5, ring: 0.5, shimmer: 0.5, hitType: 3, hit: 0.9, hitOn: 0, arp: 0.9, arpSteps: 3, arpRate: 3, dynamics: 3, subWave: 2, padWave: 3, chord: 3, pitch: 1, movement: 1 };
    const check = r => { let bad = 0, peak = 0; for (const d of [r.left, r.right]) for (const v of d) { if (!Number.isFinite(v)) bad++; peak = Math.max(peak, Math.abs(v)); } return { len: r.left.length, bad, peak }; };
    const out = {};
    out.oneCut = check(await window.Drone.renderExport(all, [0, 1]));
    out.oneFrame = check(await window.Drone.renderExport(all, [0, 1 / 30]));
    out.nothing = check(await window.Drone.renderExport(all, [0]));                          // no cuts at all
    out.empty = check(await window.Drone.renderExport(all, []));
    out.flatOut = check(await window.Drone.renderExport(all, [0, 0, 0.5]));                  // a zero-length cut
    const fast = Array.from({ length: 601 }, (_, i) => i / 30);                                // 600 one-frame cuts, every layer on
    const t = performance.now(); out.fast = check(await window.Drone.renderExport(all, fast)); out.fastMs = performance.now() - t;
    out.junk = check(await window.Drone.renderExport({ pulse: NaN, low: 'x', bright: -5, width: 99, space: undefined, power: null, seed: 'abc', hitType: 99, hit: 7, arpSteps: -3, arpRate: 1e9, dynamics: 'q', chord: -1, pitch: 5 }, [0, 0.2, 0.4, 0.6]));
    out.hugeSeed = check(await window.Drone.renderExport({ ...BASE, seed: 4294967295 * 7 }, [0, 0.3, 0.6]));
    const L = new window.Drone.Live(); L._context();
    const starts = Array.from({ length: 41 }, (_, i) => i / 3);
    const live = {};
    for (const off of [0, 3, 13.33, 13.34, 99, -5, 1e9, NaN]) {
      try { await L.play(all, starts, off); live[off] = L.pos(); } catch (e) { live[off] = 'ERR ' + e.message; }
      L.stop();
    }
    await L.play(all, [0], 0); await sleep(100); live.single = L.playing; L.stop();
    await L.play(all, fast, 5); await sleep(300); live.fastPlaying = L.playing; L.stop();
    out.live = live; return out;
  }, BASE);
  for (const k of ['oneCut', 'oneFrame', 'nothing', 'empty', 'flatOut', 'fast', 'junk', 'hugeSeed']) {
    assert.equal(r[k].bad, 0, `${k}: no NaN or Infinity`); assert.ok(r[k].len > 0, `${k}: has sound`); assert.ok(r[k].peak <= 0.97 + 1e-6, `${k}: peak ${r[k].peak}`);
  }
  assert.ok(r.oneCut.len === 44100, 'a one second clip is one second'); assert.ok(r.fast.len === 20 * 44100, `a 20 s clip: ${r.fast.len}`);
  assert.ok(r.fastMs < 20000, `600 fast cuts with every layer render in ${Math.round(r.fastMs)} ms`);
  for (const [off, pos] of Object.entries(r.live)) if (!['single', 'fastPlaying'].includes(off)) assert.ok(typeof pos === 'number' && pos >= 0 && pos < 13.34 + 1e-6, `play from ${off}: position ${pos}`);
  assert.equal(r.live.single, true); assert.equal(r.live.fastPlaying, true);
  await ctx.close();
});

test('every hit type, every hit pattern, every arpeggio shape and every wave: finite, dark, and at the right level', { skip }, async () => {
  const ctx = await fresh();
  const rows = await page.evaluate(async (BASE) => {
    const starts = Array.from({ length: 16 }, (_, i) => i * 0.1);            // 100 ms cuts
    const out = [];
    const stat = async (extra, name) => {
      const r = await window.Drone.renderExport({ ...BASE, ...extra }, starts);
      let s = 0, mx = 0, bad = 0; for (const d of [r.left, r.right]) for (const v of d) { if (!Number.isFinite(v)) bad++; s += v * v; mx = Math.max(mx, Math.abs(v)); }
      const rms = Math.sqrt(s / (2 * r.left.length));
      // share of energy above 2 kHz, from first differences (a crude high-pass that is plenty to spot a harsh sound)
      let hi = 0, tot = 0; for (let i = 3; i < r.left.length; i++) { const d = r.left[i] - 3 * r.left[i - 1] + 3 * r.left[i - 2] - r.left[i - 3]; hi += d * d; tot += r.left[i] * r.left[i]; }
      out.push({ name, bad, rms, mx, hiShare: hi / Math.max(tot, 1e-12) });
    };
    for (const hitType of [1, 2, 3, 4]) for (const hitOn of [0, 3]) await stat({ hitType, hit: 1, hitOn }, `hit ${hitType}/${hitOn}`);
    for (const [arpSteps, arpRate] of [[0, 0], [1, 1], [2, 2], [3, 3]]) await stat({ arp: 1, arpSteps, arpRate }, `arp ${arpSteps}/${arpRate}`);
    for (const [subWave, padWave] of [[0, 0], [1, 1], [2, 2], [0, 3], [2, 1]]) await stat({ subWave, padWave }, `wave ${subWave}/${padWave}`);
    for (const chord of [0, 1, 2, 3]) await stat({ chord, arp: 0.6, hitType: 1, hit: 0.7, ring: 0.5, shimmer: 0.5, wash: 0.5 }, `chord ${chord}`);
    for (const dynamics of [0, 1, 2, 3]) await stat({ dynamics }, `dynamics ${dynamics}`);
    const plain = out.find(o => o.name === 'wave 0/0');
    return { out, plainHi: plain.hiShare };
  }, BASE);
  for (const o of rows.out) {
    assert.equal(o.bad, 0, `${o.name}: finite`);
    assert.ok(Math.abs(o.rms - 0.17) < 0.012, `${o.name}: level ${o.rms}`);
    assert.ok(o.mx <= 0.97 + 1e-6, `${o.name}: peak ${o.mx}`);
    assert.ok(o.hiShare < 0.05, `${o.name}: not harsh (${o.hiShare})`);
  }
  await ctx.close();
});

test('no room seed boosts the lows: with a big room the sub still carries the sound, whatever the seed', { skip }, async () => {
  const ctx = await fresh();
  const lows = await page.evaluate(async BASE => {
    const starts = Array.from({ length: 21 }, (_, i) => i * 0.2), out = [];
    for (const seed of [69792, 7, 1234, 22456, 50312, 94730, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 99999, 31337]) {
      const r = await window.Drone.renderExport({ ...BASE, space: 0.85, pitch: 0.7, seed }, starts);
      const n = 1 << 16, re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < n; i++) re[i] = (r.left[i] + r.right[i]) / 2 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
      for (let len = 2; len <= n; len <<= 1) { const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = i + k + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const q = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = q; } } }
      let tot = 0, low = 0;
      for (let k = 1; k < n / 2; k++) { const f = (k * 44100) / n, pw = re[k] ** 2 + im[k] ** 2; tot += pw; if (f < 80) low += pw; }
      out.push([seed, low / tot]);
    }
    return out;
  }, BASE);
  for (const [seed, low] of lows) assert.ok(low > 0.4, `seed ${seed}: ${low.toFixed(3)} of the energy below 80 Hz`);   // seed 69792 measured 0.14 before the room lost its low end
  await ctx.close();
});

test('review #5: "Follows the speed" on a flat speed changes nothing, even when the clip ends inside a cut', { skip }, async () => {
  const ctx = await fresh();
  const d = await page.evaluate(async BASE => {
    const starts = [0, 0.5, 1, 1.5, 2, 2.25];                                       // flat 0.5 s cuts, the last one cut short by the end of the clip
    const p = { ...BASE, chord: 2, hitType: 1, hit: 0.6, hitOn: 0, arp: 0.4, arpSteps: 2, arpRate: 1 };
    const a = await window.Drone.renderExport({ ...p, dynamics: 0 }, starts), b = await window.Drone.renderExport({ ...p, dynamics: 3 }, starts);
    let diff = 0, tot = 0;
    for (let i = 0; i < Math.floor(a.left.length * 0.85); i++) { diff += (a.left[i] - b.left[i]) ** 2; tot += a.left[i] ** 2; }
    return Math.sqrt(diff / tot);
  }, BASE);
  assert.ok(d < 0.02, `with nothing to follow it sounds the same as Off (difference ${d.toFixed(3)})`);
  await ctx.close();
});

test('the engine finds no console errors across all of this', { skip }, async () => {
  const ctx = await fresh();
  await page.evaluate(async (BASE) => {
    const L = new window.Drone.Live(); L._context();
    const starts = Array.from({ length: 30 }, (_, i) => i / 4);
    await L.play({ ...BASE, hitType: 2, hit: 0.5, arp: 0.5 }, starts, 0);
    await new Promise(r => setTimeout(r, 500)); L.stop();
  }, BASE);
  assert.deepEqual(consoleErrors.splice(0), []);
  await ctx.close();
});

test('the page stays responsive while playing a big sequence with every sound layer on, and while sliders are dragged', { skip }, async () => {
  const ctx = await fresh();
  for (let i = 0; i < 150; i++) {                                                  // 150 images
    const f = `p${i}`; api.state.plates.push({ ...api.state.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg` });
    api.state.sequences[0].order.push(f);
  }
  await page.reload();
  await page.waitForSelector('.card');
  await page.waitForFunction(() => document.querySelectorAll('.card').length >= 150);
  await film();
  await choose('musicSelect', 'on');
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
    for (const [id, v] of [['hitTypeSelect', '3'], ['hitRange', '70'], ['arpRange', '60'], ['arpRateSelect', '3'], ['arpStepsSelect', '3'], ['washRange', '50'], ['ringRange', '40'], ['shimmerRange', '40'], ['echoRange', '50'], ['dynSelect', '3'], ['spaceRange', '80'], ['powerRange', '90'], ['subWaveSelect', '2'], ['padWaveSelect', '3']]) set(id, v);
  });
  await choose('rhythmSelect', 'variable');
  await page.evaluate(() => { for (const [id, v] of [['startMsRange', '50'], ['endMsRange', '300'], ['rampRange', '40']]) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); } });
  await page.selectOption('#multSelect', '4');
  await choose('invertSelect', 'mono'); await choose('zoomSelect', 'out');
  await page.evaluate(() => {                                                     // measure on the page: long tasks, and how late the frames are
    window.__perf = { long: [], frames: [] };
    try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__perf.long.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch (e) {}
    let last = performance.now(); const loop = n => { window.__perf.frames.push(n - last); last = n; requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  });
  await page.click('#playBtn');
  await page.waitForFunction(() => document.getElementById('playBtn').textContent.includes('Pause'));
  await page.waitForTimeout(1500);                                                // settle: the first build and level are allowed to be slower
  await page.evaluate(() => { window.__perf.long.length = 0; window.__perf.frames.length = 0; });
  await page.waitForTimeout(3000);                                                // steady playing
  const steady = await page.evaluate(() => ({ long: [...window.__perf.long], frames: [...window.__perf.frames] }));
  await page.evaluate(() => { window.__perf.long.length = 0; window.__perf.frames.length = 0; });
  for (let i = 0; i < 60; i++) {                                                  // drag sliders, flip the multiple, for 3 s
    await page.evaluate(i => {
      const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); };
      set('lowRange', String(50 + (i % 40))); set('spaceRange', String(30 + (i % 60))); if (i % 15 === 0) set('multSelect', ['2', '4', '8', '3'][(i / 15) % 4]);
    }, i);
    await page.waitForTimeout(50);
  }
  const dragging = await page.evaluate(() => ({ long: [...window.__perf.long], frames: [...window.__perf.frames] }));
  const stats = f => { const s = [...f].sort((a, b) => a - b); return { p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], n: s.length }; };
  const report = (name, m) => `${name}: ${m.long.length} long tasks (max ${Math.round(Math.max(0, ...m.long))} ms), frames p95 ${Math.round(stats(m.frames).p95)} ms max ${Math.round(stats(m.frames).max)} ms of ${m.frames.length}`;
  console.log(report('steady', steady)); console.log(report('dragging', dragging));
  for (const [name, m] of [['steady', steady], ['dragging', dragging]]) {
    assert.ok(m.frames.length > 40, `${name}: frames were drawn`);
    assert.ok(Math.max(0, ...m.long) < 250, `${name}: no main-thread block over 250 ms (${report(name, m)})`);
    assert.ok(stats(m.frames).p95 < 60, `${name}: frames keep up (${report(name, m)})`);
    assert.ok(m.long.length <= (name === 'steady' ? 3 : 12), `${name}: few long tasks (${report(name, m)})`);
  }
  assert.deepEqual(consoleErrors.splice(0), []);
  await ctx.close();
});

test('at one frame a cut with the sound on, every cut lasts the same number of screen refreshes (no stutter)', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  for (let i = 0; i < 60; i++) { const f = `c${i}`; api.state.plates.push({ ...api.state.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg` }); api.state.sequences[0].order.push(f); }
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  await film();
  await choose('musicSelect', 'on');
  await page.fill('#bpmInput', '450'); await page.locator('#bpmInput').dispatchEvent('input');
  await page.selectOption('#multSelect', '4');                                    // 1 frame (33 ms) a cut: 2 refreshes at 60 Hz
  await page.click('#playBtn');
  await page.waitForTimeout(1500);                                                // the first build and level settle
  const runs = await page.evaluate(() => new Promise(res => {
    const img = document.getElementById('stageImg'), out = []; let last = null, n = 0, frames = 0;
    const loop = () => { const s = img.getAttribute('src'); if (s === last) n++; else { if (last !== null) out.push(n); last = s; n = 1; } if (++frames < 240) requestAnimationFrame(loop); else res(out.slice(1)); };
    requestAnimationFrame(loop);
  }));
  await page.click('#playBtn');
  const even = runs.filter(n => n === 2).length;
  console.log(`cadence: ${runs.length} cuts, ${even} of them 2 refreshes, others ${JSON.stringify(runs.filter(n => n !== 2))}`);
  assert.ok(runs.length > 80, 'it played');
  assert.ok(even / runs.length > 0.95, `${Math.round((100 * even) / runs.length)}% of the cuts last 2 refreshes`);
  await ctx.close();
});

test('the first Play does not freeze the page: the audio engine and the room are made while the page is idle', { skip }, async () => {
  const ctx = await fresh({ width: 1512, height: 945 });
  await film();
  await choose('musicSelect', 'on');
  await page.waitForTimeout(1500);                                                // idle time after choosing the sound
  await page.evaluate(() => { window.__long = []; new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] }); });
  await page.click('#playBtn');
  await page.waitForTimeout(800);
  const long = await page.evaluate(() => window.__long);
  console.log(`first play: long tasks ${JSON.stringify(long)}`);
  assert.ok(Math.max(0, ...long) < 120, `no long freeze on the first Play (${JSON.stringify(long)})`);
  await page.click('#playBtn');
  await ctx.close();
});
