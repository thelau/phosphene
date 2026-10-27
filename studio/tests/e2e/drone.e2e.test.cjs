// The live and the offline sound engine (studio/web/src/drone.js) in a real browser: levels, swaps, scheduling, and extreme inputs.
const { test, assert, register, fresh, page, consoleErrors, skip, api, film, choose, tempo, mult, change, noChange } = require('./harness.cjs');
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

async function spectra(variants) {
  return page.evaluate(async ([BASE, variants]) => {
    const starts = Array.from({ length: 21 }, (_, i) => i * 0.25), out = [];
    for (const v of variants) {
      const r = await window.Drone.renderExport({ ...BASE, pitch: 0.5, ...v }, starts);
      const n = 1 << 16, re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < n; i++) re[i] = (r.left[i] + r.right[i]) / 2 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
      for (let len = 2; len <= n; len <<= 1) { const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = i + k + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const q = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = q; } } }
      const b = { sub: 0, mid: 0, upper: 0, high: 0 }; let tot = 0, cw = 0, cp = 0;
      for (let k = 1; k < n / 2; k++) { const f = (k * 44100) / n, pw = re[k] ** 2 + im[k] ** 2; tot += pw; if (f < 80) b.sub += pw; else if (f >= 150 && f < 700) b.mid += pw; else if (f >= 700 && f < 2000) b.upper += pw; else if (f >= 2000) b.high += pw; if (f >= 120 && f < 2000) { cw += f * pw; cp += pw; } if (f >= 8000) b.air = (b.air || 0) + pw; }
      let s = 0, mx = 0, bad = false; for (let i = 0; i < r.left.length; i++) { const a = r.left[i], c = r.right[i]; if (!Number.isFinite(a) || !Number.isFinite(c)) bad = true; s += a * a + c * c; mx = Math.max(mx, Math.abs(a), Math.abs(c)); }
      out.push({ rms: Math.sqrt(s / (2 * r.left.length)), peak: mx, bad, sub: b.sub / tot, mid: b.mid / tot, upper: b.upper / tot, high: b.high / tot, air: (b.air || 0) / tot, cent: cw / cp });
    }
    return out;
  }, [BASE, variants]);
}

test('Tape grows gently: barely on is barely there (no clipped peaks), 30 a touch, 100 the full warmth', { skip }, async () => {
  const ctx = await fresh();
  const amounts = [0, 0.011, 0.1, 0.3, 0.6, 1];
  const rows = await page.evaluate(async ([BASE, amounts]) => {
    const starts = Array.from({ length: 21 }, (_, i) => i * 0.25), n = 1 << 16;
    const bands = async t => {                                                // power in third-octave bands, 40 Hz to 16 kHz, in dB
      const r = await window.Drone.renderExport({ ...BASE, pitch: 0.5, arp: 0.4, arpRate: 1, tape: t }, starts);
      const re = new Float64Array(n), im = new Float64Array(n);
      for (let i = 0; i < n; i++) re[i] = (r.left[i + 22050] + r.right[i + 22050]) / 2 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) [re[i], re[j]] = [re[j], re[i]]; }
      for (let len = 2; len <= n; len <<= 1) { const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = i + k + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const q = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = q; } } }
      const out = [];
      for (let f = 40; f < 16000; f *= Math.pow(2, 1 / 3)) { let p = 1e-20; for (let k = Math.ceil((f * n) / 44100); k < (f * Math.pow(2, 1 / 3) * n) / 44100; k++) p += re[k] ** 2 + im[k] ** 2; out.push(10 * Math.log10(p)); }
      return out;
    };
    const plain = await bands(0), out = [];
    { const b = await bands(0.011); console.log(JSON.stringify(b.map((v, i) => [Math.round(40 * Math.pow(2, i / 3)), +(v - plain[i]).toFixed(1), +plain[i].toFixed(0)]))); }
    for (const t of amounts) { const b = await bands(t); out.push(b.reduce((a, v, i) => a + Math.abs(v - plain[i]), 0) / b.length); }   // mean change per band, dB
    return out;
  }, [BASE, amounts]);
  const [off, barely, ten, thirty, sixty, full] = rows;
  assert.ok(off < 0.01 && barely < 0.1 * full, `off is off, barely on is barely there: ${off.toFixed(2)}, ${barely.toFixed(2)}`);
  assert.ok(ten < thirty && thirty < sixty && sixty < full, `it grows with the slider: ${rows.map(x => x.toFixed(2))}`);
  assert.ok(ten < 0.12 * full, `10 is a touch: ${ten.toFixed(2)} of ${full.toFixed(2)} dB`);
  assert.ok(thirty < 0.3 * full, `30 is moderate: ${thirty.toFixed(2)} of ${full.toFixed(2)} dB`);
  await ctx.close();
});

test('Choir and Industrial over the drone: the same level, still sub-heavy, each audible (measured, not heard)', { skip }, async () => {
  const ctx = await fresh();
  const rows = await spectra([{}, { choir: 0.5 }, { industrial: 0.5 }]);
  const [drone, choir, industrial] = rows;
  for (const [i, m] of rows.entries()) {
    assert.ok(!m.bad && Math.abs(m.rms - 0.17) < 0.01 && m.peak <= 0.97, `layer ${i}: level ${m.rms.toFixed(3)}, peak ${m.peak.toFixed(2)}`);
    assert.ok(m.sub > 0.4 && m.high < 0.01, `layer ${i}: still sub-heavy and dark (${m.sub.toFixed(2)} below 80 Hz, ${m.high.toFixed(4)} above 2 kHz)`);
  }
  assert.ok(choir.mid > drone.mid * 1.2, `the choir sings in the mids: ${choir.mid.toFixed(3)} vs ${drone.mid.toFixed(3)}`);
  assert.ok(industrial.upper > drone.upper * 3, `industrial adds metal: ${industrial.upper.toFixed(4)} vs ${drone.upper.toFixed(4)}`);
  await ctx.close();
});

test('arpeggio moods: one instrument (Pluck\'s patch) played differently; each renders level and dark (measured, not heard)', { skip }, async () => {
  const ctx = await fresh();
  const arp = { arp: 0.45, arpRate: 1, arpSteps: 2, chord: 1 };
  const rows = await spectra([0, 1, 2, 3, 4, 5].map(m => ({ ...arp, arpMood: m })));
  console.log('moods: ' + JSON.stringify(rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +(+v).toFixed(4)])))));
  for (const [i, m] of rows.entries()) {
    assert.ok(!m.bad && Math.abs(m.rms - 0.17) < 0.01 && m.peak <= 0.97, `mood ${i}: level ${m.rms.toFixed(3)}, peak ${m.peak.toFixed(2)}`);
    assert.ok(m.sub > 0.35 && m.high < 0.01, `mood ${i}: still a sub-heavy, dark drone (${m.sub.toFixed(2)} below 80 Hz, ${m.high.toFixed(4)} above 2 kHz)`);
  }
  const pluck = rows[0];                                                           // one instrument (the modular patch), played differently: close to Pluck's balance
  for (const [i, m] of rows.entries()) assert.ok(Math.abs(m.sub - pluck.sub) < 0.1 && Math.abs(m.mid - pluck.mid) < 0.1, `mood ${i} stays the same instrument as Pluck: sub ${m.sub.toFixed(2)} vs ${pluck.sub.toFixed(2)}, mid ${m.mid.toFixed(2)} vs ${pluck.mid.toFixed(2)}`);
  await ctx.close();
});

test('Phase: the second loop is the same notes, a note longer, so the two only meet again after A × (A + 1) steps', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(() => {
    const a = [1, 2, 3, 4, 5], b = window.Drone.phaseLoop(a);
    const pairs = new Set(); let again = 0;
    for (let k = 1; k <= 60 && !again; k++) if (k % a.length === 0 && k % b.length === 0) again = k;
    for (let k = 0; k < 30; k++) pairs.add(`${a[k % a.length]}-${b[k % b.length]}`);
    return { b, again, pairs: pairs.size, same: [...b].sort().join() === [...a, a[2]].sort().join() };
  });
  assert.equal(r.b.length, 6); assert.ok(r.same, `the same notes: ${r.b}`);
  assert.equal(r.again, 30, 'in step again after 5 × 6 steps');
  assert.ok(r.pairs >= 12, `on the way, many different intervals between the two: ${r.pairs}`);
  await ctx.close();
});
test('chord changes: the bass moves to the next degree on time (Descend: down a tone after 4 cuts), and the level holds', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async BASE => {
    const starts = Array.from({ length: 25 }, (_, i) => i * 0.25);                 // 4 cuts a second: a chord a second
    const x = await window.Drone.renderExport({ ...BASE, pitch: 0.5, chord: 1, prog: 1, progEvery: 1, pulse: 0, movement: 0 }, starts);
    const peak = (a, b) => {                                                         // the strongest frequency between 30 and 90 Hz in [a, b] s
      const sr = 44100, i0 = Math.round(a * sr), i1 = Math.round(b * sr); let best = 0, bf = 0;
      for (let f = 30; f <= 90; f += 0.25) {
        const w = (2 * Math.PI * f) / sr; let re = 0, im = 0;
        for (let i = i0; i < i1; i += 2) { const v = x.left[i] + x.right[i]; re += v * Math.cos(w * i); im += v * Math.sin(w * i); }
        const m = re * re + im * im; if (m > best) { best = m; bf = f; }
      }
      return bf;
    };
    let rms = 0; for (let i = 0; i < x.left.length; i++) rms += x.left[i] ** 2; rms = Math.sqrt(rms / x.left.length);
    return { first: peak(0.25, 0.95), second: peak(1.25, 1.95), third: peak(2.25, 2.95), rms };
  }, BASE);
  const st = (a, b) => 12 * Math.log2(b / a);
  assert.ok(Math.abs(st(r.first, r.second) + 2) < 0.6, `i to VII: down a tone (${r.first} Hz to ${r.second} Hz)`);
  assert.ok(Math.abs(st(r.first, r.third) + 4) < 0.6, `then VI: down a major third (${r.third} Hz)`);
  assert.ok(Math.abs(r.rms - 0.17) < 0.02, `the level holds: ${r.rms}`);
  await ctx.close();
});

test('bassline and arrangement: the bass is heard and the drone stays heavy; Build-up starts sparse and fills in, Sections switch', { skip }, async () => {
  const ctx = await fresh();
  const rows = await spectra([{}, { bass: 0.6, bassPattern: 2, bassRate: 1 }]);
  const [plain, bass] = rows;
  assert.ok(Math.abs(bass.rms - 0.17) < 0.01 && bass.high < 0.01 && bass.sub > 0.35, `the bass keeps it level and dark: ${JSON.stringify(bass)}`);
  assert.ok(bass.mid > plain.mid * 1.1, `the bass is heard: mid ${bass.mid.toFixed(3)} vs ${plain.mid.toFixed(3)}`);
  const r = await page.evaluate(async BASE => {
    const starts = Array.from({ length: 81 }, (_, i) => i * 0.125);               // 10 s, 8 cuts a second
    const busy = (x, a, b) => { let e = 0; const i0 = Math.round(a * 44100), i1 = Math.round(b * 44100); for (let i = i0 + 1; i < i1; i++) { const d = x.left[i] - x.left[i - 1]; e += d * d; } return e / (i1 - i0); };   // energy of the changes: the notes, not the sub
    const p = { ...BASE, pitch: 0.5, arp: 0.45, arpRate: 1, bass: 0.6, bassRate: 1, hitType: 1, hit: 0.6, hitOn: 0 };
    const off = await window.Drone.renderExport({ ...p, arrange: 0 }, starts), build = await window.Drone.renderExport({ ...p, arrange: 1 }, starts);
    // Sections, the bassline alone: the same film with and without it (the bass draws no random numbers, so the rest is identical), scaled to fit
    const sec = await window.Drone.renderExport({ ...p, arrange: 2 }, starts), secNoBass = await window.Drone.renderExport({ ...p, arrange: 2, bass: 0 }, starts);
    let num = 0, den = 0; for (let i = 0; i < sec.left.length; i++) { num += sec.left[i] * secNoBass.left[i]; den += secNoBass.left[i] ** 2; }
    const k = num / den, bassOnly = (a, b) => { let e = 0; for (let i = Math.round(a * 44100); i < Math.round(b * 44100); i++) e += (sec.left[i] - k * secNoBass.left[i]) ** 2; return e; };
    return { offEarly: busy(off, 0.1, 0.8), offMid: busy(off, 6, 7.5), buildEarly: busy(build, 0.1, 0.8), buildMid: busy(build, 6, 7.5),
      bassSparse: bassOnly(0.2, 0.9), bassFull: bassOnly(1.2, 1.9) };              // section 1: the arpeggio only; section 2: everything
  }, BASE);
  assert.ok(r.buildEarly / r.buildMid < 0.65 * (r.offEarly / r.offMid), `Build-up: sparse at first, full later (${(r.buildEarly / r.buildMid).toFixed(2)} vs all at once ${(r.offEarly / r.offMid).toFixed(2)})`);
  assert.ok(r.bassFull > 20 * r.bassSparse, `Sections: the bassline sits out the sparse section and plays in the full one (${r.bassSparse.toExponential(1)} vs ${r.bassFull.toExponential(1)})`);
  await ctx.close();
});

test('pad, acid and tape: the pad voices each chord in the key (VI gets its major third), Acid and Tape keep the level, Tape darkens the top', { skip }, async () => {
  const ctx = await fresh();
  const voiced = await page.evaluate(() => [0, -2, -4, -5, 3, 5].map(d => window.Drone.padChord(d)));
  assert.deepEqual(voiced, [[0, 7, 10, 15], [-2, 5, 8, 14], [-4, 3, 7, 12], [-5, 2, 5, 10], [3, 10, 14, 19], [5, 12, 15, 20]], 'i m7, VII 7, VI maj7, v m7, III maj7, iv m7: all in the key');
  const r = await page.evaluate(async BASE => {
    const sr = 44100, starts = Array.from({ length: 25 }, (_, i) => i * 0.25);     // Descend, a chord a second: i, VII, VI, v
    const at = (x, f, a, b) => { const w = (2 * Math.PI * f) / sr; let re = 0, im = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) { const v = x.left[i] + x.right[i]; re += v * Math.cos(w * i); im += v * Math.sin(w * i); } return re * re + im * im; };
    const p = { ...BASE, pitch: 0.5, chord: 1, prog: 1, progEvery: 1, movement: 0 };
    const withPad = await window.Drone.renderExport({ ...p, pad: 1 }, starts), noPad = await window.Drone.renderExport({ ...p, pad: 0 }, starts);
    const T = 38 * Math.pow(2, 0.9 * 0.5) * 4;                                       // the tonic, two octaves over the root
    // on VI (2-3 s) the chord's third is the tonic (voiced an octave up, 2T): the pad brings it; a semitone under it (a minor third on VI) it does not
    const gainAt = f => at(withPad, f, 2.2, 2.9) / at(noPad, f, 2.2, 2.9);
    const level = x => { let s2 = 0; for (let i = 0; i < x.left.length; i++) s2 += x.left[i] ** 2; return Math.sqrt(s2 / x.left.length); };
    const acid = await window.Drone.renderExport({ ...BASE, arp: 0.5, arpMood: 6, arpRate: 1 }, starts);
    const taped = await window.Drone.renderExport({ ...BASE, arp: 0.4, arpRate: 1, tape: 0.8 }, starts);
    return { third: gainAt(2 * T), flat: gainAt(2 * T * Math.pow(2, -1 / 12)), padLevel: level(withPad), acidLevel: level(acid), tapeLevel: level(taped) };
  }, BASE);
  assert.ok(r.third > 2 * r.flat && r.third > 1.5, `on VI the pad sounds the major third (×${r.third.toFixed(1)}), not the minor (×${r.flat.toFixed(1)})`);
  for (const k of ['padLevel', 'acidLevel', 'tapeLevel']) assert.ok(Math.abs(r[k] - 0.17) < 0.015, `${k}: ${r[k].toFixed(3)}`);
  const [plain, taped, fullPad, padTape] = await spectra([{ arp: 0.4, arpRate: 1 }, { arp: 0.4, arpRate: 1, tape: 0.8 }, { pad: 1 }, { pad: 1, tape: 1 }]);
  for (const [name, m] of [['the pad at 100', fullPad], ['the pad at 100 under full tape', padTape]])   // never a takeover: the drone's sub stays on top
    assert.ok(m.sub > 0.5 && m.mid < 0.45 && m.peak <= 0.97, `${name} stays under the drone: ${JSON.stringify(m)}`);
  assert.ok(taped.air < plain.air * 0.7, `tape darkens the very top (above 8 kHz): ${taped.air.toExponential(2)} vs ${plain.air.toExponential(2)}`);
  assert.ok(taped.sub > 0.35 && taped.high < 0.02, `and stays a heavy drone: ${JSON.stringify(taped)}`);
  await ctx.close();
});

test('the last music cut, cut short by the film\'s end, keeps the beat: no faster notes before the loop, none past the end', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(() => {
    const starts = [0, 0.5, 1, 1.5, 1.625];                                    // a flat film whose end falls a quarter into its last music cut
    return [4, 2, 1.5].map(per => starts.slice(0, -1).flatMap((_, i) => window.Drone.noteTimes(starts, i, per).map(([, t]) => +t.toFixed(4))));
  });
  for (const times of r) {
    const gaps = times.slice(1).map((t, i) => +(t - times[i]).toFixed(4));
    assert.ok(gaps.every(g => Math.abs(g - gaps[0]) < 1e-3), `even spacing to the very end: ${gaps}`);
    assert.ok(times.every(t => t < 1.625), `nothing past the end: ${times}`);
  }
  assert.deepEqual(r[0].slice(-2), [1.375, 1.5], '4 a cut: the last cut gets the one note that fits (at its start)');
  await ctx.close();
});

test('polyrhythm: 3 notes over 2 cuts, in phase from any cut', { skip }, async () => {
  const ctx = await fresh();
  const poly = await page.evaluate(() => [0, 1, 2, 3].map(i => window.Drone.notesIn(i, 1.5).map(([k, f]) => [k, +f.toFixed(3)])));
  assert.equal(JSON.stringify(poly), '[[[0,0],[1,0.667]],[[2,0.333]],[[3,0],[4,0.667]],[[5,0.333]]]', '3 against 2: notes at 0, 2/3, 4/3 cuts...');
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
  await change({ start: 50, end: 300, from: 0.7, to: 1 });
  await mult('4');
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
  await page.evaluate(() => { window.__perf.long.length = 0; window.__perf.frames.length = 0; });
  const lane = await page.locator('#rsSpeed').boundingBox(), end = await page.locator('#rsEnd').boundingBox();   // the timeline by hand: the change's End, then the tempo
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2); await page.mouse.down();
  for (let i = 0; i < 30; i++) { await page.mouse.move(lane.x + lane.width * (0.8 + 0.15 * Math.sin(i / 3)), lane.y + lane.height * (0.3 + 0.5 * ((i % 10) / 10))); await page.waitForTimeout(50); }
  await page.mouse.up();
  const tf = await page.locator('#tempoField').boundingBox();
  await page.mouse.move(tf.x + 40, tf.y + 15); await page.mouse.down();
  for (let i = 0; i < 30; i++) { await page.mouse.move(tf.x + 40, tf.y + 15 - 40 * Math.sin(i / 5)); await page.waitForTimeout(50); }
  await page.mouse.up();
  const timeline = await page.evaluate(() => ({ long: [...window.__perf.long], frames: [...window.__perf.frames] }));
  const stats = f => { const s = [...f].sort((a, b) => a - b); return { p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], n: s.length }; };
  const report = (name, m) => `${name}: ${m.long.length} long tasks (max ${Math.round(Math.max(0, ...m.long))} ms), frames p95 ${Math.round(stats(m.frames).p95)} ms max ${Math.round(stats(m.frames).max)} ms of ${m.frames.length}`;
  console.log(report('steady', steady)); console.log(report('dragging', dragging)); console.log(report('timeline', timeline));
  for (const [name, m] of [['steady', steady], ['dragging', dragging], ['timeline', timeline]]) {
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
  await tempo(450);
  await mult('4');                                    // 1 frame (33 ms) a cut: 2 refreshes at 60 Hz
  await page.click('#playBtn');
  await page.waitForTimeout(1500);                                                // the first build and level settle
  // measured twice, the better kept: a busy machine (another browser, a build) can drop a few refreshes once; a real stutter fails both
  const measure = () => page.evaluate(() => new Promise(res => {
    const img = document.getElementById('stageImg'), out = []; let last = null, n = 0, frames = 0;
    const loop = () => { const s = img.getAttribute('src'); if (s === last) n++; else { if (last !== null) out.push(n); last = s; n = 1; } if (++frames < 240) requestAnimationFrame(loop); else res(out.slice(1)); };
    requestAnimationFrame(loop);
  }));
  const share = r => r.filter(n => n === 2).length / Math.max(1, r.length);
  let runs = await measure();
  if (share(runs) <= 0.95) { const again = await measure(); if (share(again) > share(runs)) runs = again; }
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

test('the system stops the sound while it plays (WebKit does: another app, an output change, sleep): it comes back by itself, from where the picture is', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async ({ BASE }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = new window.Drone.Live();
    let revived = 0; L.onRevived = () => { revived++; };
    await L.play(BASE, Array.from({ length: 200 }, (_, i) => i / 3), 0);
    await sleep(300);
    await L.ctx.suspend();                                                         // as WebKit does by itself
    for (let i = 0; i < 40 && L.ctx.state !== 'running'; i++) await sleep(25);
    const state = L.ctx.state;
    await sleep(100);
    L.stop();
    return { state, revived };
  }, { BASE });
  assert.equal(r.state, 'running', 'the sound is asked back at once');
  assert.ok(r.revived >= 1, 'and the page is told, to put it back where the picture is');
  await ctx.close();
});

test('back to the window after another app was in front while playing: a fresh sound from where the picture is (the Mac app went silent, still "running")', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async ({ BASE }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = new window.Drone.Live(), starts = Array.from({ length: 200 }, (_, i) => i / 3);
    L.renewOnReturn = true;                                                       // on in WebKit by itself (the test runs in Chromium too)
    let renewed = 0; L.onRenew = () => { renewed++; L.play(BASE, starts, 4); };
    await L.play(BASE, starts, 0);
    await sleep(200);
    const first = L.ctx;
    window.dispatchEvent(new Event('blur')); await sleep(50); window.dispatchEvent(new Event('focus'));
    for (let i = 0; i < 60 && !(L.playing && L.ctx && L.ctx !== first && L.ctx.state === 'running'); i++) await sleep(25);
    const out = { renewed, fresh: L.ctx !== first, oldClosed: first.state, state: L.ctx && L.ctx.state, playing: L.playing, pos: L.pos() };
    window.dispatchEvent(new Event('focus'));                                       // focus without having been away: nothing
    await sleep(100); out.renewedAgain = renewed;
    L.stop();
    return out;
  }, { BASE });
  assert.equal(r.renewed, 1); assert.ok(r.fresh, 'a new context'); assert.equal(r.oldClosed, 'closed', 'the old one closed');
  assert.equal(r.state, 'running'); assert.ok(r.playing && r.pos >= 3.9, `playing again from the picture's place (${r.pos})`);
  assert.equal(r.renewedAgain, 1, 'only after being away');
  await ctx.close();
});

test('Sound › Source Off then Synthesized is a full reset: a new sound connection that plays from the picture\'s place', { skip }, async () => {
  const ctx = await fresh();
  await film();
  await choose('musicSelect', 'on');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('playBtn').classList.contains('playing'));
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => { window.__ctxSeen = []; const C = window.AudioContext; window.AudioContext = function (...a) { const c = new C(...a); window.__ctxSeen.push(c); return c; }; return true; });
  await choose('musicSelect', 'off');
  await choose('musicSelect', 'on');
  await page.waitForFunction(() => window.__ctxSeen.length === 1 && window.__ctxSeen[0].state === 'running', null, { timeout: 5000 });
  assert.ok(before);
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});

test('the sound\'s clock stops while the page is in front (WebKit lost the output, the context still "running"): the page is told; a reload plays on from the same place', { skip }, async () => {
  const ctx = await fresh();
  const r = await page.evaluate(async ({ BASE }) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const L = new window.Drone.Live();
    let stalled = 0; L.onStall = () => { stalled++; };
    await L.play(BASE, Array.from({ length: 200 }, (_, i) => i / 3), 0);
    await sleep(1300);
    const fine = stalled;
    const frozen = L.ctx.currentTime; Object.defineProperty(L.ctx, 'currentTime', { get: () => frozen, configurable: true });   // the clock stops
    await sleep(3300);
    L.stop();
    return { fine, stalled };
  }, { BASE });
  assert.equal(r.fine, 0, 'a moving clock is left alone');
  assert.equal(r.stalled, 1, 'two stopped seconds tell the page, once');
  // the page's cure, a reload, plays on from the same place
  await film();
  await page.evaluate(() => sessionStorage.setItem('studioResume', JSON.stringify({ pos: 30, mode: 'film' })));
  await page.reload(); await page.waitForSelector('#loader', { state: 'detached' });
  assert.equal(await page.evaluate(() => document.getElementById('playBtn').classList.contains('playing')), true, 'playing again after the reload');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('studioResume')), null, 'once');
  assert.deepEqual(consoleErrors, []);
  await ctx.close();
});
