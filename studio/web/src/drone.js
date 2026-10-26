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

  // a short burst of white noise for the knock and noise hits
  const noiseCache = new WeakMap();
  function knockNoise(ctx, seconds = 0.12) {
    const key = ctx.sampleRate + ':' + seconds;
    let m = noiseCache.get(ctx); if (!m) noiseCache.set(ctx, m = new Map());
    if (!m.has(key)) {
      const r = mulberry32(99), n = Math.floor(seconds * ctx.sampleRate), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = gauss(r);
      m.set(key, b);
    }
    return m.get(key);
  }

  function cutAtTime(starts, t) {
    let lo = 0, hi = starts.length - 2;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // chords: the tonal cluster over the sub (ratios of the root) and the pad's partials; 0 is the measured Soiltone/Ecwora cluster
  const CHORDS = [
    { name: 'dark cluster', ratios: [4.0, 7.2, 9.2, 9.6], pad: [2, 3, 4] },
    { name: 'open fifth', ratios: [4.0, 6.0, 8.0, 12.0], pad: [2, 3, 4] },
    { name: 'minor', ratios: [4.0, 4.8, 6.0, 7.2], pad: [2, 3, 4] },
    { name: 'suspended', ratios: [4.0, 4.5, 6.0, 9.0], pad: [2, 3, 5] }
  ];
  const SUB_WAVES = ['sine', 'triangle', 'square'];           // the sub; the square is softened (a low-pass) before it saturates
  const PAD_WAVES = ['sawtooth', 'square', 'triangle', 'pulse'];     // the pad's oscillators; pulse is a narrow 25% pulse
  // gain that evens out how loud each pad wave is next to the saw
  const PAD_TRIM = [1.0, 0.7, 1.3, 0.85];
  function pulseWave(ctx, duty) {
    const n = 64, real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) { const a = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty); real[k] = a * Math.cos(k * Math.PI * duty); imag[k] = a * Math.sin(k * Math.PI * duty); }
    return ctx.createPeriodicWave(real, imag);
  }
  const ARP_STEPS = [4, 6, 8, 16];
  const ARP_PER_CUT = [0.5, 1, 2, 4];                                  // arpeggio notes per cut
  const rootHz = pitch => 38 * Math.pow(2, 0.9 * pitch);                // 38..71 Hz

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
    const f0 = Number.isFinite(+p.pitch) && p.pitch !== null && p.pitch !== undefined ? rootHz(clamp01(p.pitch)) : 51 + 6 * rand();
    const chord = CHORDS[Math.max(0, Math.min(CHORDS.length - 1, Math.round(+p.chord || 0)))];
    const echo = clamp01(p.echo === undefined ? 0 : p.echo);
    const wash = clamp01(p.wash || 0), ring = clamp01(p.ring || 0), shimmer = clamp01(p.shimmer || 0);
    const pick = (v, n) => Math.max(0, Math.min(n - 1, Math.round(+v || 0)));
    const hitType = pick(p.hitType, 5), hitAmt = clamp01(p.hit || 0), hitOn = pick(p.hitOn, 4);
    const arpAmt = clamp01(p.arp || 0), arpSteps = ARP_STEPS[pick(p.arpSteps, ARP_STEPS.length)], arpRate = pick(p.arpRate, 4);
    const dynamics = opts.dynamics === false ? 0 : pick(p.dynamics, 4);
    const subWave = Math.max(0, Math.min(SUB_WAVES.length - 1, Math.round(+p.subWave || 0)));
    const padWave = Math.max(0, Math.min(PAD_WAVES.length - 1, Math.round(+p.padWave || 0)));
    const move = Math.pow(2, 2 * (clamp01(p.movement === undefined ? 0.5 : p.movement) - 0.5));   // 0.5 = as measured; 1 = twice as fast
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
        const o = osc(SUB_WAVES[subWave], f0 * mult);
        lfo(0.13, f0 * mult * 0.012, o.frequency);
        if (subWave === 2) { const [l1] = lowpass(260, level); const og = gain(g * 0.8, l1); o.connect(og); }   // a square is soft: only its low harmonics
        else { const og = gain(g, level); o.connect(og); }
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
    const ratios = chord.ratios, lfoGains = [0.2, 0.8, 1.0, 0.6];
    const sides = [];
    const air = noiseLoop(ctx, rand, 4, (x, r) => { onePole(x, 1400, r, 2); const lowpassed = x.slice(); onePole(lowpassed, 250, r, 2); for (let i = 0; i < x.length; i++) x[i] -= lowpassed[i]; });
    keep(air);
    const lfoRates = ratios.map(() => (0.15 + 0.55 * rand()) * move);
    const driftPhase = TAU * rand();
    const mixAt = t => Math.min(1, Math.max(0, 0.5 * (t / total) + 0.35 * (0.5 + 0.5 * Math.sin(TAU * 0.07 * move * t + driftPhase))));
    const spread = 0.003 + 0.006 * power;
    const breath = [];

    for (const side of [-1, 1]) {
      const det = 1 + side * 0.0045;
      const body = gain(opts.noBody ? 0 : 0.6 * 0.25);                                        // 0.6 body scale, then 1/4 for the shaper
      // unison pad: dark and open copies, crossfaded over time
      const padBus = gain(1);
      for (const [k, g] of [[chord.pad[0], 1.0], [chord.pad[1], 0.6], [chord.pad[2], 0.4]]) {
        for (const [v, vg] of [[-1, 0.6 * power], [0, 1.0], [1, 0.6 * power]]) {
          if (vg > 0.01) {
            const o = osc(PAD_WAVES[padWave] === 'pulse' ? 'sine' : PAD_WAVES[padWave], f0 * k * det * (1 + v * spread), gain(g * vg * PAD_TRIM[padWave], padBus));
            if (PAD_WAVES[padWave] === 'pulse') o.setPeriodicWave(pulseWave(ctx, 0.25));
          }
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
      // texture layers (all off by default)
      if (wash > 0.01) {                                                   // a slow wash of filtered noise, its centre drifting
        const w = noiseLoop(ctx, rand, 4, (x, r) => onePole(x, 2500, r, 1)); keep(w);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 550; bp.Q.value = 0.9;
        lfo((0.04 + 0.05 * rand()) * move, 380, bp.frequency);
        w.connect(bp); bp.connect(gain(1.1 * wash, body));
      }
      if (ring > 0.01) {                                                   // a metallic ring: inharmonic partials, each breathing on its own
        [[1, 1.0], [2.76, 0.6], [5.4, 0.35]].forEach(([r, g], i) => {
          const o = osc('sine', f0 * 6 * r * (1 + side * 0.003));
          const og = gain(0.5 * g * ring * 0.7, body); o.connect(og);
          lfo((0.08 + 0.2 * rand()) * move, 0.5 * g * ring * 0.3, og.gain);
        });
      }
      if (shimmer > 0.01) {                                                // octave partials of the cluster, trembling fast and beating between the sides
        [8, 12, 16].forEach((r, i) => {
          const o = osc('sine', f0 * r * (1 + side * 0.006));
          const og = gain(0.14 * shimmer * (1 - 0.2 * i) * 0.5, body); o.connect(og);
          lfo((3.5 + 3 * rand()) * move, 0.14 * shimmer * (1 - 0.2 * i) * 0.5, og.gain);
        });
      }
      // the pump, the landing, then the heavy saturation
      const pg = gain(1); pump(pg.gain, 0.8 * pulse, 0.07);
      const lg = gain(1); sampled(lg.gain, t => 1 - 0.35 * landed(t));
      const k = 1 + 1.5 * power;
      const sat = shaper(tanhCurve(k, 1));
      body.connect(pg); pg.connect(lg); lg.connect(sat);
      const sum = gain(1);
      sat.connect(sum); subBus.connect(sum);
      const br = gain(1); sum.connect(br);
      lfo(0.11 * move, 0.07, br.gain);
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
      if (echo > 0.01) {                                                   // a dark feedback echo, a different time each side
        const avg = total / Math.max(1, nCuts);
        const dl = ctx.createDelay(2); dl.delayTime.value = Math.min(0.75, Math.max(0.18, avg * 3)) * (i ? 1.33 : 1);
        const fb = gain(0.3 + 0.3 * echo), dark = ctx.createBiquadFilter(); dark.type = 'lowpass'; dark.frequency.value = 900;
        const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 140; hp2.Q.value = 0.707;
        br.connect(hp2); hp2.connect(dl); dl.connect(dark); dark.connect(fb); fb.connect(dl); dark.connect(gain(0.7 * echo, mix[i]));
      }
    });
    // ---- hits: a percussive impact on some of the cuts ----
    const hitBus = gain(1);
    sides.forEach(br => hitBus.connect(gain(0.9, br)));
    const accents = Array.from({ length: 8 }, () => rand() < 0.4);       // an irregular pattern for "accents"
    accents[0] = true;
    if (hitType > 0 && hitAmt > 0.01) {
      for (let i = 0; i < nCuts; i++) {
        const on = hitOn === 0 ? true : hitOn === 1 ? i % 2 === 0 : hitOn === 2 ? i % 4 === 0 : accents[i % 8];
        if (!on || starts[i] < offset - 0.001) continue;
        const t = at(starts[i]), a = hitAmt, env = (g, peak, decay, delay = 0) => {
          g.gain.setValueAtTime(0, t + delay); g.gain.linearRampToValueAtTime(peak, t + delay + 0.004); g.gain.setTargetAtTime(0, t + delay + 0.004, decay / 3);
        };
        const tone = (type, f1, f2, drop, peak, decay, to) => {
          const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + drop);
          const g = ctx.createGain(); env(g, peak, decay); o.connect(g); g.connect(to); o.start(t); o.stop(t + decay * 1.6 + 0.05);
        };
        if (hitType === 1) tone('sine', f0 * 3.2, f0, 0.11, 1.1 * a, 0.32, hitBus);                       // thud: a sub that drops onto the root
        else if (hitType === 2) {                                                                        // knock: a short low tone and a dull click
          tone('triangle', f0 * 5, f0 * 2.2, 0.05, 0.75 * a, 0.14, hitBus);
          const n = ctx.createBufferSource(); n.buffer = knockNoise(ctx); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
          const g = ctx.createGain(); env(g, 0.5 * a, 0.04); n.connect(lp); lp.connect(g); g.connect(hitBus); n.start(t); n.stop(t + 0.12);
        } else if (hitType === 3) {                                                                      // metal: inharmonic partials ringing out
          [[1, 1, 0.42], [2.76, 0.6, 0.26], [5.4, 0.35, 0.16]].forEach(([r, g0, d]) => tone('sine', f0 * 5 * r, f0 * 5 * r, 0.01, 0.4 * a * g0, d, hitBus));
        } else {                                                                                         // noise burst: a dark, short snare
          const n = ctx.createBufferSource(); n.buffer = knockNoise(ctx, 0.3); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.8;
          const g = ctx.createGain(); env(g, 1.3 * a, 0.16); n.connect(bp); bp.connect(g); g.connect(hitBus); n.start(t); n.stop(t + 0.35);
        }
      }
    }

    // ---- arpeggio: a short pattern of plucked notes that repeats, one step per beat of the cuts ----
    if (arpAmt > 0.01) {
      const degrees = [];                                                // the notes it may use: the chord's tones over two octaves, kept dark
      for (const r of chord.ratios) for (const oct of [0.5, 1]) { const f = f0 * r * oct; if (f > 100 && f < 700) degrees.push(f); }
      degrees.sort((x, y) => x - y);
      const pattern = [];
      let cur = Math.floor(rand() * degrees.length);
      for (let k = 0; k < arpSteps; k++) { pattern.push(degrees[cur]); cur = Math.max(0, Math.min(degrees.length - 1, cur + [-2, -1, 1, 2, 3][Math.floor(rand() * 5)])); }
      const arpBus = [gain(1), gain(1)];
      arpBus.forEach((b, i) => b.connect(sides[i]));
      const per = ARP_PER_CUT[arpRate];
      let step = 0;
      for (let i = 0; i < nCuts; i++) {
        const n = per < 1 ? (i % 2 === 0 ? 1 : 0) : per, len = starts[i + 1] - starts[i];
        for (let k = 0; k < n; k++, step++) {
          const ts = starts[i] + (per < 1 ? 0 : (len * k) / n);
          if (ts < offset - 0.001) continue;
          const stepLen = per < 1 ? len * 2 : len / n, decay = Math.min(0.5, Math.max(0.07, stepLen * 0.9)), t = at(ts), f = pattern[step % arpSteps];
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2;
          lp.frequency.setValueAtTime(1900, t); lp.frequency.exponentialRampToValueAtTime(420, t + decay);
          const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(2.2 * arpAmt, t + 0.004); g.gain.setTargetAtTime(0, t + 0.004, decay / 3);
          lp.connect(g);
          for (const det of [-0.004, 0.004]) {                           // two detuned saws
            const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * (1 + det); o.connect(lp); o.start(t); o.stop(t + decay * 1.6 + 0.05);
          }
          g.connect(gain(0.85, arpBus[step % 2])); g.connect(gain(0.35, arpBus[(step + 1) % 2]));   // the note sits to one side, alternating
        }
      }
    }

    // stereo width: mid/side
    const w = 0.25 + 0.9 * width;
    const merger = ctx.createChannelMerger(2);
    const cross = (a, b, ch) => { const g1 = gain((1 + w) / 2); const g2 = gain((1 - w) / 2); mix[a].connect(g1); mix[b].connect(g2); g1.connect(merger, 0, ch); g2.connect(merger, 0, ch); };
    cross(0, 1, 0); cross(1, 0, 1);
    // dynamics: the whole sound swells, fades, or follows how fast the cuts are (faster = louder)
    const dyn = ctx.createGain();
    if (dynamics) {
      const lens = starts.slice(1).map((v, i) => v - starts[i]);
      const lo = Math.min(...lens), hi = Math.max(...lens);
      const lenAt = t => lens[Math.min(lens.length - 1, cutAtTime(starts, t))];
      sampled(dyn.gain, t => {
        const u = Math.min(1, t / total);
        if (dynamics === 1) return 0.3 + 0.7 * Math.pow(u, 1.4);                                   // build up
        if (dynamics === 2) return 1 - 0.7 * Math.pow(u, 1.2);                                     // fade out
        return hi > lo * 1.05 ? 0.35 + 0.65 * (Math.log(hi / lenAt(t)) / Math.log(hi / lo)) : 1;   // follow the speed
      });
    }
    merger.connect(dyn);
    if (opts.tap === 'sub') subBus.connect(dest); else if (opts.tap === 'dry') { mix[0].connect(dest); } else dyn.connect(dest);

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
    const key = JSON.stringify([p.pulse, p.low, p.bright, p.width, p.space, p.power, p.seed, p.paired, p.pitch, p.chord, p.echo, p.movement, p.wash, p.ring, p.shimmer, p.subWave, p.padWave, p.hitType, p.hit, p.hitOn, p.arp, p.arpSteps, p.arpRate]);
    if (levelCache.has(key)) return levelCache.get(key);
    const rate = 22050, secs = Math.min(4, starts[starts.length - 1]);
    const trimmed = starts.filter(s => s < secs); trimmed.push(secs);
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.floor(secs * rate)), rate);
    build(ctx, ctx.destination, p, trimmed, { offset: 0, t0: 0, total: starts[starts.length - 1], landing: false, dynamics: false });
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

  window.Drone = { build, level, renderExport, toWav, Live, TARGET_RMS, CHORDS, rootHz };
})();
