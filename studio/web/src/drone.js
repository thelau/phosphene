// The synthesized drone, in WebAudio: the same graph plays live in the preview (sliders are instant) and renders offline for the export,
// so what you hear is what you export. It is the browser version of the measured drone (see AGENTS.md): a ~54 Hz sub with saturation,
// a unison saw pad, a tonal 215-516 Hz cluster, a little air, a pump on every cut, a landing on the last image, in a reverb room.
// Settings are 0..1: pulse, low, bright, width, space, power; seed makes the variation. Cut starts are in seconds, the last one is the end.
(() => {
  const TAU = Math.PI * 2;
  const TARGET_RMS = 0.17;
  const EXPORT_RATE = 44100;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rand) { return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(TAU * rand()); }
  function smooth(x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }
  function clamp01(v) { v = Number(v); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }

  function onePole(x, fc, rate, passes) {
    const a = 1 - Math.exp(-TAU * fc / rate);
    for (let p = 0; p < passes; p++) { let y = 0; for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; } }
    return x;
  }
  function normalise(x) {
    let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const k = 1 / (Math.sqrt(s / x.length) + 1e-9);
    for (let i = 0; i < x.length; i++) x[i] *= k;
    return x;
  }
  function bufferOf(ctx, data) { const b = ctx.createBuffer(1, data.length, ctx.sampleRate); b.getChannelData(0).set(data); return b; }

  // soft saturation curve: y = tanh(k * 4x) / norm, for an input scaled by 1/4 (so values up to 4 are kept, not clipped by the shaper)
  function tanhCurve(k, norm) {
    const n = 4097, c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = Math.tanh(k * 4 * ((i / (n - 1)) * 2 - 1)) / norm;
    return c;
  }

  function noiseLoop(ctx, rand, seconds, shape) {
    const n = Math.floor(seconds * ctx.sampleRate), x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = gauss(rand);
    shape(x, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = bufferOf(ctx, normalise(x));
    src.loop = true;
    return src;
  }

  // a dark room: decaying noise, low-passed, after a short pre-delay
  function roomBuffer(ctx, rand, seconds) {
    const rate = ctx.sampleRate, n = Math.floor(seconds * rate), pre = Math.floor(0.025 * rate);
    const ir = new Float32Array(n);
    for (let i = 0; i < n; i++) ir[i] = gauss(rand) * Math.exp(-(i / rate) * (6.9 / seconds));
    onePole(ir, 900, rate, 2);
    let e = 0; for (let i = 0; i < n; i++) e += ir[i] * ir[i];
    for (let i = 0; i < n; i++) ir[i] /= Math.sqrt(e) + 1e-9;                  // unit energy
    const out = new Float32Array(pre + n);
    out.set(ir, pre);
    const b = ctx.createBuffer(1, out.length, rate);
    b.getChannelData(0).set(out);
    return b;
  }

  function cutAtTime(starts, t) {
    let lo = 0, hi = starts.length - 2;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // Builds the drone into ctx and connects it to `dest` (stereo, before the final glue).
  // opts: offset (seconds into the clip where playing starts), t0 (context time of clip second 0), total (clip length, default starts end),
  // landing (the sub gives way on the last image), seed.
  function build(ctx, dest, p, starts, opts = {}) {
    const pulse = clamp01(p.pulse), low = clamp01(p.low), bright = clamp01(p.bright), width = clamp01(p.width), space = clamp01(p.space), power = clamp01(p.power);
    const rand = mulberry32(Number.isFinite(+p.seed) ? +p.seed : 7);
    const total = opts.total || starts[starts.length - 1];
    const offset = opts.offset || 0;
    const t0 = opts.t0 !== undefined ? opts.t0 : ctx.currentTime - offset;
    const at = s => t0 + s;                                               // clip second -> context time
    const nCuts = starts.length - 1;
    const land = opts.landing === false ? Infinity : starts[Math.max(0, nCuts - (p.paired ? 2 : 1))];
    const f0 = 51 + 6 * rand();
    const nodes = [];                                                      // everything that must be stopped
    const keep = n => { nodes.push(n); return n; };
    const gain = (v, to) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    const osc = (type, freq, to) => { const o = keep(ctx.createOscillator()); o.type = type; o.frequency.value = freq; if (to) o.connect(to); return o; };
    const lfo = (rate, depth, param) => { const o = osc('sine', rate); const g = gain(depth, param); o.connect(g); return o; };
    const shaper = (curve, to) => { const s = ctx.createWaveShaper(); s.curve = curve; s.oversample = '2x'; if (to) s.connect(to); return s; };
    const lowpass = (fc, to) => { const a = ctx.createBiquadFilter(); a.type = 'lowpass'; a.frequency.value = fc; a.Q.value = 0.707; const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = fc; b.Q.value = 0.707; a.connect(b); if (to) b.connect(to); return [a, b]; };

    // automation helpers; each skips what is already in the past when playing from an offset
    const sampled = (param, fn) => {                                       // a curve sampled 50 times a second
      const from = Math.min(offset, total), span = Math.max(0.04, total - from), n = Math.max(2, Math.ceil(span * 50));
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) c[i] = fn(from + (span * i) / (n - 1));
      param.setValueCurveAtTime(c, at(from), span);
    };
    const landed = t => smooth((t - land) / 1.2);                           // 0 -> 1 over the last hold
    const pump = (param, depth, decay) => {                                // dips and comes back on every cut
      const c = cutAtTime(starts, offset), tau = offset - starts[c];
      param.setValueAtTime(1 - depth * (1 - Math.exp(-tau / decay)), at(offset));
      param.setTargetAtTime(1 - depth, at(offset), decay);
      for (let i = c + 1; i < nCuts; i++) { param.setValueAtTime(1, at(starts[i])); param.setTargetAtTime(1 - depth, at(starts[i]), decay); }
    };
    const tickEnv = (param, decay) => {                                    // a short click at every cut
      const c = cutAtTime(starts, offset), tau = offset - starts[c];
      param.setValueAtTime(Math.exp(-tau / decay), at(offset));
      param.setTargetAtTime(0, at(offset), decay);
      for (let i = c + 1; i < nCuts; i++) { param.setValueAtTime(1, at(starts[i])); param.setTargetAtTime(0, at(starts[i]), decay); }
    };

    // ---- the sub: shared by both sides ----
    const subBus = gain(1);
    {
      const base = (0.3 + 0.8 * low) * (1 + 0.6 * power);
      const level = gain(base * 0.9);                                      // a slow tremolo around it
      lfo(0.5, base * 0.1, level.gain);
      for (const [mult, g] of [[1, 1], [2, 0.3]]) {
        const o = osc('sine', f0 * mult);
        lfo(0.13, f0 * mult * 0.012, o.frequency);
        const og = gain(g, level); o.connect(og);
      }
      const pre = gain(0.25);
      level.connect(pre);
      const k = 1 + 2 * power;
      const sat = shaper(tanhCurve(k, Math.tanh(k)));
      pre.connect(sat);
      const pg = gain(1); pump(pg.gain, 0.25 * pulse, 0.15);
      const lg = gain(1); sampled(lg.gain, t => 1 - 0.6 * landed(t));
      sat.connect(pg); pg.connect(lg); lg.connect(subBus);
      const rumble = noiseLoop(ctx, rand, 4, (x, r) => onePole(x, 110, r, 2));
      keep(rumble);
      rumble.connect(gain(0.10 * low, subBus));
    }

    // ---- shared sources for the mid body ----
    const ratios = [4.0, 7.2, 9.2, 9.6], lfoGains = [0.2, 0.8, 1.0, 0.6];
    const sides = [];
    const air = noiseLoop(ctx, rand, 4, (x, r) => { onePole(x, 1400, r, 2); const lowpassed = x.slice(); onePole(lowpassed, 250, r, 2); for (let i = 0; i < x.length; i++) x[i] -= lowpassed[i]; });
    keep(air);
    const lfoRates = ratios.map(() => 0.15 + 0.55 * rand());
    const driftPhase = TAU * rand();
    const mixAt = t => Math.min(1, Math.max(0, 0.5 * (t / total) + 0.35 * (0.5 + 0.5 * Math.sin(TAU * 0.07 * t + driftPhase))));
    const spread = 0.003 + 0.006 * power;
    const breath = [];

    for (const side of [-1, 1]) {
      const det = 1 + side * 0.0045;
      const body = gain(opts.noBody ? 0 : 0.6 * 0.25);                                        // 0.6 body scale, then 1/4 for the shaper
      // unison pad: dark and open copies, crossfaded over time
      const padBus = gain(1);
      for (const [k, g] of [[2, 1.0], [3, 0.6], [4, 0.4]]) {
        for (const [v, vg] of [[-1, 0.6 * power], [0, 1.0], [1, 0.6 * power]]) {
          if (vg > 0.01) osc('sawtooth', f0 * k * det * (1 + v * spread), gain(g * vg, padBus));
        }
      }
      const fc = 260 + 1400 * bright;
      const dark = gain(1), open = gain(1);
      const [d1] = lowpass(fc, dark), [o1] = lowpass(fc * 2.6, open);
      padBus.connect(d1); padBus.connect(o1);
      sampled(dark.gain, t => 1 - mixAt(t)); sampled(open.gain, t => mixAt(t));
      const padOut = gain(0.2 / (1 + 0.8 * power), body);
      dark.connect(padOut); open.connect(padOut);
      // tonal cluster
      ratios.forEach((r, i) => {
        const o = osc('sine', f0 * r * det * (1 + 0.002 * side));
        const g = gain(lfoGains[i] * 0.75 * (0.34 + 0.2 * bright), body);
        lfo(lfoRates[i], lfoGains[i] * 0.25 * (0.34 + 0.2 * bright), g.gain);
        o.connect(g);
      });
      // a click on every cut
      const tickG = gain(0); tickEnv(tickG.gain, 0.03);
      const tickAmt = gain((0.2 + 0.5 * pulse) * 0.9, body);
      tickG.connect(tickAmt);
      for (const r of [7.2, 9.2]) osc('sine', f0 * r * (1 + 0.003 * side), tickG);
      air.connect(gain(0.05 * bright, body));
      // the pump, the landing, then the heavy saturation
      const pg = gain(1); pump(pg.gain, 0.8 * pulse, 0.07);
      const lg = gain(1); sampled(lg.gain, t => 1 - 0.35 * landed(t));
      const k = 1 + 1.5 * power;
      const sat = shaper(tanhCurve(k, 1));
      body.connect(pg); pg.connect(lg); lg.connect(sat);
      const sum = gain(1);
      sat.connect(sum); subBus.connect(sum);
      const br = gain(1); sum.connect(br);
      lfo(0.11, 0.07, br.gain);
      sides.push(br);
    }

    // ---- the room: the send skips the sub ----
    const seconds = 2.4 + 3.6 * space, wet = 0.05 + 0.5 * space;
    const mix = [gain(1), gain(1)];
    sides.forEach((br, i) => {
      br.connect(mix[i]);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 140; hp.Q.value = 0.707;
      const conv = ctx.createConvolver(); conv.normalize = false; conv.buffer = roomBuffer(ctx, rand, seconds);
      br.connect(hp); hp.connect(conv); conv.connect(gain(wet, mix[i]));
    });
    // stereo width: mid/side
    const w = 0.25 + 0.9 * width;
    const merger = ctx.createChannelMerger(2);
    const cross = (a, b, ch) => { const g1 = gain((1 + w) / 2); const g2 = gain((1 - w) / 2); mix[a].connect(g1); mix[b].connect(g2); g1.connect(merger, 0, ch); g2.connect(merger, 0, ch); };
    cross(0, 1, 0); cross(1, 0, 1);
    if (opts.tap === 'sub') subBus.connect(dest); else if (opts.tap === 'dry') { mix[0].connect(dest); } else merger.connect(dest);

    for (const n of nodes) n.start();
    return { stop: when => { for (const n of nodes) { try { n.stop(when); } catch (e) {} } } };
  }

  function rmsOf(buf) {
    let s = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) s += d[i] * d[i]; n += d.length; }
    return Math.sqrt(s / n);
  }

  // How loud the graph is at these settings, from a short offline render (so the live preview matches the export level).
  const levelCache = new Map();
  async function level(p, starts) {
    const key = JSON.stringify([p.pulse, p.low, p.bright, p.width, p.space, p.power, p.seed, p.paired]);
    if (levelCache.has(key)) return levelCache.get(key);
    const rate = 22050, secs = Math.min(4, starts[starts.length - 1]);
    const trimmed = starts.filter(s => s < secs); trimmed.push(secs);
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.floor(secs * rate)), rate);
    build(ctx, ctx.destination, p, trimmed, { offset: 0, t0: 0, total: starts[starts.length - 1], landing: false });
    const g = TARGET_RMS / (rmsOf(await ctx.startRendering()) + 1e-9);
    levelCache.set(key, g);
    if (levelCache.size > 40) levelCache.delete(levelCache.keys().next().value);
    return g;
  }

  // The export: the whole clip rendered offline at 44.1 kHz, levelled and glued like the live one. Returns {left, right, rate, seconds} (float, -1..1).
  async function renderExport(p, starts) {
    const total = starts[starts.length - 1], n = Math.max(1, Math.round(total * EXPORT_RATE));
    const ctx = new OfflineAudioContext(2, n, EXPORT_RATE);
    build(ctx, ctx.destination, p, starts, { offset: 0, t0: 0 });
    const buf = await ctx.startRendering();
    const ch = [buf.getChannelData(0), buf.getChannelData(1)];
    const norm = () => { let s = 0; for (const d of ch) for (let i = 0; i < n; i++) s += d[i] * d[i]; const k = TARGET_RMS / (Math.sqrt(s / (2 * n)) + 1e-9); for (const d of ch) for (let i = 0; i < n; i++) d[i] *= k; };
    norm();
    const t = Math.tanh(1.1);
    for (const d of ch) for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] * 1.1) / t;
    norm();
    const fin = Math.min(n, Math.floor(0.02 * EXPORT_RATE)), fout = Math.min(n, Math.floor(0.12 * EXPORT_RATE));
    for (const d of ch) {
      for (let i = 0; i < n; i++) d[i] = Math.max(-0.97, Math.min(0.97, d[i]));
      for (let i = 0; i < fin; i++) d[i] *= i / fin;
      for (let i = 0; i < fout; i++) d[n - 1 - i] *= i / fout;
    }
    return { left: ch[0], right: ch[1], rate: EXPORT_RATE, seconds: total };
  }

  function toWav({ left, right, rate }) {
    const n = left.length, out = new DataView(new ArrayBuffer(44 + n * 4));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * 4, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true); out.setUint32(24, rate, true);
    out.setUint32(28, rate * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      out.setInt16(44 + i * 4, Math.round(left[i] * 32767), true);
      out.setInt16(46 + i * 4, Math.round(right[i] * 32767), true);
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  // The live preview: plays the drone from an offset, is the player's clock, and swaps in new settings in ~40 ms with a crossfade.
  class Live {
    constructor() { this.ctx = null; this.inst = null; this.params = null; this.starts = null; this.t0 = 0; this.total = 0; this.timer = null; this.playing = false; this.holding = 0; this.cal = 1; }
    get playingNow() { return this.playing; }
    pos() { return this.playing && !this.holding ? (((this.ctx.currentTime - this.t0) % this.total) + this.total) % this.total : 0; }
    _context() {
      if (!this.ctx) { const C = window.AudioContext || window.webkitAudioContext; this.ctx = new C({ latencyHint: 'interactive' }); }
      return this.ctx;
    }
    _spawn(offset) {
      const ctx = this.ctx, now = ctx.currentTime;
      const out = ctx.createGain();                                         // crossfade + calibrated level + glue
      out.gain.setValueAtTime(0, now);
      out.gain.linearRampToValueAtTime(1, now + 0.04);
      const level = ctx.createGain(); level.gain.value = this.cal;
      const glue = ctx.createWaveShaper(); const n = 4097, c = new Float32Array(n), th = Math.tanh(1.1);
      for (let i = 0; i < n; i++) c[i] = Math.tanh(1.1 * 2 * ((i / (n - 1)) * 2 - 1)) / th / 2;
      glue.curve = c;
      const pre = ctx.createGain(); pre.gain.value = 0.5;                  // the shaper sees -2..2
      level.connect(pre); pre.connect(glue); glue.connect(out); out.connect(ctx.destination);
      const graph = build(ctx, level, this.params, this.starts, { offset, t0: now - offset });
      this.t0 = now - offset;
      this.inst = { graph, out, level };
      const loopIn = (this.total - offset) * 1000;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.playing) this._swap(Math.max(0, this.ctx.currentTime - (this.t0 + this.total))); }, Math.max(0, loopIn));
    }
    _retire(inst) {
      if (!inst) return;
      const now = this.ctx.currentTime;
      inst.out.gain.cancelScheduledValues(now);
      inst.out.gain.setValueAtTime(inst.out.gain.value, now);
      inst.out.gain.linearRampToValueAtTime(0, now + 0.04);
      inst.graph.stop(now + 0.06);
      setTimeout(() => { try { inst.out.disconnect(); } catch (e) {} }, 400);
    }
    _swap(offset) { const old = this.inst; this._spawn(offset); this._retire(old); }
    async play(params, starts, offset = 0) {
      const ctx = this._context();
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
      this.params = params; this.starts = starts; this.total = starts[starts.length - 1];
      this.cal = await level(params, starts);
      this.playing = true;
      if (this.inst) this._retire(this.inst);
      this._spawn(offset % this.total);
    }
    // new settings or a new timeline: carry on from where the picture is (getOffset gives seconds on the new timeline, asked when the swap happens)
    async update(params, starts, getOffset) {
      if (!this.playing) return;
      this.params = params; this.starts = starts; this.total = starts[starts.length - 1];
      this.holding++;                                                       // until the swap the old sound's position means nothing on the new timeline
      try {
        const cal = await level(params, starts);
        if (!this.playing) return;
        this.cal = cal;
        this._swap(Math.max(0, Math.min(getOffset(), this.total - 0.01)));
      } finally { this.holding--; }
    }
    stop() {
      this.playing = false;
      clearTimeout(this.timer);
      if (this.inst) { this._retire(this.inst); this.inst = null; }
    }
  }

  window.Drone = { build, level, renderExport, toWav, Live, TARGET_RMS };
})();
