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

  function makeRoom(ctx, seedN, i, roomSeconds) {
    const conv = ctx.createConvolver(); conv.normalize = false;
    const data = cachedData(ctx.sampleRate, `room|${seedN}|${i}|${roomSeconds}`, () => roomData(ctx.sampleRate, mulberry32(seedN + 7919 * (i + 1)), roomSeconds));
    const b = ctx.createBuffer(1, data.length, ctx.sampleRate); b.copyToChannel(data, 0); conv.buffer = b;
    return conv;
  }

  // Buffers that take a while to make (seconds of noise, the room) are made once per context and seed, not at every rebuild of the sound.
  // The sample data of the room and the noise loops, made once per sample rate and shared by every context (the live one, and each short
  // offline render that measures the level): making them is the slow part, wrapping them in a buffer is a copy.
  const dataCache = new Map();
  function cachedData(rate, key, make) {
    const k = `${rate}|${key}`;
    if (!dataCache.has(k)) { dataCache.set(k, make()); if (dataCache.size > 24) dataCache.delete(dataCache.keys().next().value); }
    return dataCache.get(k);
  }
  const bufferCache = new WeakMap();
  function cached(ctx, key, make) {
    let m = bufferCache.get(ctx); if (!m) bufferCache.set(ctx, m = new Map());
    if (!m.has(key)) { m.set(key, make()); if (m.size > 60) m.delete(m.keys().next().value); }
    return m.get(key);
  }
  function noiseLoop(ctx, seed, name, seconds, shape) {
    const data = cachedData(ctx.sampleRate, `noise|${name}|${seed}|${seconds}`, () => {
      const rand = mulberry32((seed * 2654435761 + name.length * 97 + name.charCodeAt(0)) >>> 0);
      const n = Math.floor(seconds * ctx.sampleRate), x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = gauss(rand);
      shape(x, ctx.sampleRate);
      return normalise(x);
    });
    const buf = cached(ctx, `buf|${name}|${seed}|${seconds}`, () => { const b = ctx.createBuffer(1, data.length, ctx.sampleRate); b.copyToChannel(data, 0); return b; });   // one AudioBuffer per context
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  // a dark room: decaying noise, low-passed, after a short pre-delay
  function roomData(rate, rand, seconds) {
    const n = Math.floor(seconds * rate), pre = Math.floor(0.025 * rate);
    const ir = new Float32Array(n);
    for (let i = 0; i < n; i++) ir[i] = gauss(rand) * Math.exp(-(i / rate) * (6.9 / seconds));
    onePole(ir, 900, rate, 2);
    let e = 0; for (let i = 0; i < n; i++) e += ir[i] * ir[i];
    for (let i = 0; i < n; i++) ir[i] /= Math.sqrt(e) + 1e-9;                  // unit energy
    const out = new Float32Array(pre + n);
    out.set(ir, pre);
    return out;
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

  // Cut times from anywhere: only finite numbers, in order, from the first one, at least a short clip long. A clip with nothing to cut on gets one cut.
  function cleanStarts(starts) {
    const v = (Array.isArray(starts) ? starts : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return [0, 0.1];
    if (v.length === 1) v.push(v[0] + 0.1);
    if (v[v.length - 1] - v[0] < 0.05) v[v.length - 1] = v[0] + 0.05;
    return v;
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
  // An oscillator that starts part-way through the clip has to start at the phase it would have reached by then. Otherwise every oscillator of a
  // new sound begins at phase 0 together: a burst of loud, in-phase sound, and a clash with the sound it replaces, at every swap.
  const PHASE_HARMONICS = 48;
  function phasedWave(ctx, type, cycles) {
    const th = 2 * Math.PI * (cycles - Math.floor(cycles)), real = new Float32Array(PHASE_HARMONICS + 1), imag = new Float32Array(PHASE_HARMONICS + 1);
    if (type === 'sine') { real[1] = Math.sin(th); imag[1] = Math.cos(th); }
    else for (let k = 1; k <= PHASE_HARMONICS; k++) { const a = ((k % 2 ? 2 : -2) / (Math.PI * k)); real[k] = a * Math.sin(k * th); imag[k] = a * Math.cos(k * th); }   // sawtooth
    return ctx.createPeriodicWave(real, imag);
  }
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
    const seedN = (Number.isFinite(+p.seed) ? +p.seed : 7) >>> 0;
    const rand = mulberry32(seedN);
    starts = cleanStarts(starts);
    const total = opts.total || starts[starts.length - 1];
    const offset = opts.offset || 0;
    const t0 = opts.t0 !== undefined ? opts.t0 : ctx.currentTime - offset;
    const at = s => t0 + s;                                               // clip second -> context time
    const nCuts = starts.length - 1;
    const land = opts.landing === false ? Infinity : (Number.isFinite(+p.landAt) ? +p.landAt : starts[Math.max(0, nCuts - (p.paired ? 2 : 1))]);   // where the last image begins
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
    const sends = [];
    const links = [];                                                      // connections to unplug when this sound is retired (a shared room outlives it)
    const keep = n => { nodes.push(n); return n; };
    const gain = (v, to) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    const osc = (type, freq, to, inPhase = false) => {
      const o = keep(ctx.createOscillator()); o.type = type; o.frequency.value = freq;
      if (inPhase && offset > 0 && type === 'sine') o.setPeriodicWave(phasedWave(ctx, type, freq * offset));     // in phase with where the clip is (only the sub: it is coherent between the old sound and the new one; the rest is not worth a wave each)
      if (to) o.connect(to); return o;
    };
    const lfo = (rate, depth, param) => { const o = osc('sine', rate); const g = gain(depth, param); o.connect(g); return o; };
    const shaper = (curve, to) => { const s = ctx.createWaveShaper(); s.curve = curve; if (to) s.connect(to); return s; };
    const lowpass = (fc, to) => { const a = ctx.createBiquadFilter(); a.type = 'lowpass'; a.frequency.value = fc; a.Q.value = 0.707; const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = fc; b.Q.value = 0.707; a.connect(b); if (to) b.connect(to); return [a, b]; };

    // automation helpers; each skips what is already in the past when playing from an offset
    const sampled = (param, fn) => {                                       // a curve sampled 50 times a second
      const from = Math.min(offset, total), span = Math.max(0.04, total - from), n = Math.max(2, Math.ceil(span * 50));
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) c[i] = fn(from + (span * i) / (n - 1));
      param.setValueCurveAtTime(c, at(from), span);
    };
    const landed = t => smooth((t - land) / 1.2);                           // 0 -> 1 over the last hold
    // Everything that happens at a cut is scheduled just ahead of the sound (advance), not for the whole clip at once: a long, fast clip
    // would otherwise put thousands of events and nodes in the graph before the first note plays.
    const perCut = [];                                                       // (cut index, context time) handlers, run in order
    let cursor = 0;
    { const c = cutAtTime(starts, offset); cursor = starts[c] >= offset - 0.001 ? c : c + 1; }
    const advance = to => {
      while (cursor < nCuts && starts[cursor] <= to) { const i = cursor++; for (const h of perCut) h(i, at(starts[i])); }
    };
    const pump = (param, depth, decay) => {                                // dips and comes back on every cut
      const c = cutAtTime(starts, offset), tau = offset - starts[c];
      param.setValueAtTime(1 - depth * (1 - Math.exp(-tau / decay)), at(offset));
      param.setTargetAtTime(1 - depth, at(offset), decay);
      perCut.push((i, t) => { param.setValueAtTime(1, t); param.setTargetAtTime(1 - depth, t, decay); });
    };
    const tickEnv = (param, decay) => {                                    // a short click at every cut
      const c = cutAtTime(starts, offset), tau = offset - starts[c];
      param.setValueAtTime(Math.exp(-tau / decay), at(offset));
      param.setTargetAtTime(0, at(offset), decay);
      perCut.push((i, t) => { param.setValueAtTime(1, t); param.setTargetAtTime(0, t, decay); });
    };

    // ---- the sub: shared by both sides ----
    const subBus = gain(1);
    {
      const base = (0.3 + 0.8 * low) * (1 + 0.6 * power);
      const level = gain(base * 0.9);                                      // a slow tremolo around it
      lfo(0.5, base * 0.1, level.gain);
      for (const [mult, g] of [[1, 1], [2, 0.3]]) {
        const o = osc(SUB_WAVES[subWave], f0 * mult, undefined, true);
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
      const rumble = noiseLoop(ctx, seedN, 'rumble', 4, (x, r) => onePole(x, 110, r, 2));
      keep(rumble);
      rumble.connect(gain(0.10 * low, subBus));
    }

    // ---- shared sources for the mid body ----
    const ratios = chord.ratios, lfoGains = [0.2, 0.8, 1.0, 0.6];
    const sides = [];
    const air = noiseLoop(ctx, seedN, 'air', 4, (x, r) => { onePole(x, 1400, r, 2); const lowpassed = x.slice(); onePole(lowpassed, 250, r, 2); for (let i = 0; i < x.length; i++) x[i] -= lowpassed[i]; });
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
        const w = noiseLoop(ctx, seedN, 'wash' + side, 4, (x, r) => onePole(x, 2500, r, 1)); keep(w);
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
    const roomSeconds = Math.round(2.4 + 3.6 * space), wet = 0.05 + 0.5 * space;    // the room's length in whole-second steps, so it can be reused while a slider moves
    const mix = [gain(1), gain(1)];
    sides.forEach((br, i) => {
      br.connect(mix[i]);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 140; hp.Q.value = 0.707;
      // the room is a convolver, and loading its impulse response is the costliest step of a rebuild: the live preview passes in a shared one
      const conv = opts.room ? opts.room(i, seedN, roomSeconds) : makeRoom(ctx, seedN, i, roomSeconds);
      const wetG = gain(wet, mix[i]);
      const send = gain(opts.live ? 0 : 1);                                // this sound's feed into the room: it fades with the crossfade, or the room would hear old and new at full level
      sends.push(send);
      br.connect(hp); hp.connect(send); send.connect(conv); conv.connect(wetG);
      links.push([send, conv], [conv, wetG]);
      if (echo > 0.01) {                                                   // a dark feedback echo, a different time each side
        const avg = total / Math.max(1, nCuts);
        const dl = ctx.createDelay(2); dl.delayTime.value = Math.min(0.75, Math.max(0.18, avg * 3)) * (i ? 1.33 : 1);
        const fb = gain(0.3 + 0.3 * echo), dark = ctx.createBiquadFilter(); dark.type = 'lowpass'; dark.frequency.value = 900;
        const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 140; hp2.Q.value = 0.707;
        br.connect(hp2); hp2.connect(dl); dl.connect(dark); dark.connect(fb); fb.connect(dl); dark.connect(gain(0.7 * echo, mix[i]));
      }
    });
    // ---- hits: a percussive impact on some of the cuts. Fixed voices (made once), retriggered by automation: no node per hit ----
    const hitBus = gain(1);
    sides.forEach(br => hitBus.connect(gain(0.9, br)));
    const accents = Array.from({ length: 8 }, () => rand() < 0.4);       // an irregular pattern for "accents"
    accents[0] = true;
    // an envelope on a gain: a fast rise to peak, then an exponential fall (setTarget is open-ended, so the next hit simply takes over)
    const strike = (g, t, peak, decay) => { g.gain.setTargetAtTime(peak, t, 0.0015); g.gain.setTargetAtTime(0, t + 0.012, decay / 3); };
    const voiceOsc = (type, to) => { const o = osc(type, 100); const g = gain(0, to); o.connect(g); return [o, g]; };
    const voiceNoise = (secs, filterType, fc, q, to) => {
      const n = ctx.createBufferSource(); n.buffer = knockNoise(ctx, secs); n.loop = true; keep(n);
      const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = fc; f.Q.value = q;
      const g = gain(0, to); n.connect(f); f.connect(g); return g;
    };
    if (hitType > 0 && hitAmt > 0.01) {
      const a = hitAmt;
      let fire;
      if (hitType === 1) {                                                // thud: a sub that drops onto the root
        const [o, g] = voiceOsc('sine', hitBus);
        fire = t => { o.frequency.setValueAtTime(f0 * 3.2, t); o.frequency.setTargetAtTime(f0, t, 0.035); strike(g, t, 1.1 * a, 0.32); };
      } else if (hitType === 2) {                                         // knock: a short low tone and a dull click
        const [o, g] = voiceOsc('triangle', hitBus), click = voiceNoise(0.5, 'lowpass', 700, 0.7, hitBus);
        fire = t => { o.frequency.setValueAtTime(f0 * 5, t); o.frequency.setTargetAtTime(f0 * 2.2, t, 0.02); strike(g, t, 0.75 * a, 0.14); strike(click, t, 0.5 * a, 0.04); };
      } else if (hitType === 3) {                                         // metal: inharmonic partials ringing out
        const parts = [[1, 1, 0.42], [2.76, 0.6, 0.26], [5.4, 0.35, 0.16]].map(([r, g0, d]) => { const [o, g] = voiceOsc('sine', hitBus); o.frequency.value = f0 * 5 * r; return [g, 0.4 * g0, d]; });
        fire = t => { for (const [g, peak, d] of parts) strike(g, t, peak * a, d); };
      } else {                                                            // noise burst: a dark, short snare
        const g = voiceNoise(1, 'bandpass', 420, 0.8, hitBus);
        fire = t => strike(g, t, 1.3 * a, 0.16);
      }
      perCut.push((i, t) => {
        const on = hitOn === 0 ? true : hitOn === 1 ? i % 2 === 0 : hitOn === 2 ? i % 4 === 0 : accents[i % 8];
        if (on) fire(t);
      });
    }

    // ---- arpeggio: a short pattern of plucked notes that repeats, stepping with the cuts. One voice (two detuned saws), its pitch automated ----
    if (arpAmt > 0.01) {
      const degrees = [];                                                // the notes it may use: the chord's tones over two octaves, kept dark
      for (const r of chord.ratios) for (const oct of [0.5, 1]) { const f = f0 * r * oct; if (f > 100 && f < 700) degrees.push(f); }
      degrees.sort((x, y) => x - y);
      const pattern = [];
      let cur = Math.floor(rand() * degrees.length);
      for (let k = 0; k < arpSteps; k++) { pattern.push(degrees[cur]); cur = Math.max(0, Math.min(degrees.length - 1, cur + [-2, -1, 1, 2, 3][Math.floor(rand() * 5)])); }
      const arpBus = [gain(1), gain(1)];
      arpBus.forEach((b, i) => b.connect(sides[i]));
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2; lp.frequency.value = 1900;
      const env = gain(0);
      const voices = [-0.004, 0.004].map(det => { const o = osc('sawtooth', 200); o.connect(lp); return [o, det]; });
      lp.connect(env);
      env.connect(gain(0.6, arpBus[0])); env.connect(gain(0.6, arpBus[1]));
      const per = ARP_PER_CUT[arpRate];
      const stepsIn = n => (per < 1 ? Math.ceil(n / 2) : n * per);       // steps played in the first n cuts: keeps the pattern in phase when playing from an offset
      let step = stepsIn(cursor);
      perCut.push((i, tc) => {
        const len = starts[i + 1] - starts[i];
        const n = per < 1 ? (i % 2 === 0 ? 1 : 0) : per;
        for (let k = 0; k < n; k++, step++) {
          const t = tc + (per < 1 ? 0 : (len * k) / n);
          const stepLen = per < 1 ? len * 2 : len / n, decay = Math.min(0.5, Math.max(0.05, stepLen * 0.9)), f = pattern[step % arpSteps];
          for (const [o, det] of voices) o.frequency.setValueAtTime(f * (1 + det), t);
          lp.frequency.setValueAtTime(1900, t); lp.frequency.setTargetAtTime(420, t + 0.003, decay / 3);
          strike(env, t, 2.2 * arpAmt, decay);
        }
      });
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

    for (const n of nodes) n.start(opts.startAt || 0);                      // live: all together, at the moment the sound is meant to begin
    if (opts.live) advance(offset + (opts.lookahead || 0.8)); else advance(Infinity);     // live: the rest is scheduled as the sound plays (Live.tick)
    const fade = (to, when, dur) => { for (const g of sends) { g.gain.cancelScheduledValues(when); g.gain.setValueAtTime(g.gain.value, when); g.gain.linearRampToValueAtTime(to, when + dur); } };
    return { advance, fade, stop: when => { for (const n of nodes) { try { n.stop(when); } catch (e) {} } }, dispose: () => { for (const [a, b] of links) { try { a.disconnect(b); } catch (e) {} } } };
  }

  function rmsOf(buf) {
    let s = 0, n = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) s += d[i] * d[i]; n += d.length; }
    return Math.sqrt(s / n);
  }

  // How loud the graph is at these settings, from a short offline render (so the live preview matches the export level).
  const levelCache = new Map();
  const cutSignature = starts => { const head = []; for (const t of starts) { head.push(Math.round(t * 1000)); if (t > 4) break; } return head.join(','); };   // the cuts of the window the level is measured on: faster cuts pump differently
  const levelKey = (p, starts) => JSON.stringify([cutSignature(starts || []), p.pulse, p.low, p.bright, p.width, p.space, p.power, p.seed, p.paired, p.pitch, p.chord, p.echo, p.movement, p.wash, p.ring, p.shimmer, p.subWave, p.padWave, p.hitType, p.hit, p.hitOn, p.arp, p.arpSteps, p.arpRate]);
  async function level(p, starts) {
    starts = cleanStarts(starts);
    const key = levelKey(p, starts);
    if (levelCache.has(key)) return levelCache.get(key);
    const rate = 22050, secs = Math.min(3, starts[starts.length - 1]);
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
    starts = cleanStarts(starts);
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

  // Is the new sound the same as the one playing, apart from where the clip ends (and where its landing falls)? Then there is nothing to rebuild:
  // the running sound already has every cut the shorter clip needs (a longer clip would need cuts it does not have).
  function onlyTheEndMoved(inst, params, starts) {
    const a = inst.starts, b = starts;
    if (b[b.length - 1] > a[a.length - 1] + 1e-9) return false;
    const strip = p => { const q = Object.assign({}, p); delete q.landAt; return JSON.stringify(q); };
    if (strip(inst.params) !== strip(params)) return false;
    for (let i = 0; i < b.length - 1; i++) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
    return true;
  }

  // The live preview: plays the drone from an offset, is the player's clock, and swaps in new settings in ~40 ms with a crossfade.
  // Cheap by design: notes and hits are scheduled a short way ahead (not for the whole clip), settings changes are coalesced into one swap
  // every ~120 ms however fast a slider moves, and the exact loudness is worked out in the background (the old level carries on meanwhile).
  class Live {
    constructor() { this.ctx = null; this.inst = null; this.params = null; this.starts = null; this.t0 = 0; this.total = 0; this.timer = null; this.playing = false; this.holding = 0; this.cal = 1; this.pending = null; this.swapAt = 0; this.calTimer = null; this.ticker = null; this.rooms = new Map(); this.buildMs = 20; }
    get playingNow() { return this.playing; }
    pos() { return this.playing && !this.holding ? (((this.ctx.currentTime - this.t0) % this.total) + this.total) % this.total : 0; }
    _context() {
      if (!this.ctx) { const C = window.AudioContext || window.webkitAudioContext; this.ctx = new C({ latencyHint: 'interactive' }); }
      return this.ctx;
    }
    // Builds a new sound and schedules it to begin a moment from now (the time the build takes plus a margin), so that everything in it, its
    // automation, its fade-in and the old sound's fade-out, is timed from the instant it really starts. Returns when that is.
    _spawn(offset) {
      const ctx = this.ctx;
      offset = Number.isFinite(offset) ? ((offset % this.total) + this.total) % this.total : 0;      // any number is a position in the clip: it wraps; nonsense is the start
      const startAt = ctx.currentTime + Math.min(0.15, (this.buildMs || 20) / 1000 + 0.015);
      const out = ctx.createGain();                                         // crossfade + calibrated level + glue
      out.gain.setValueAtTime(0, startAt);
      out.gain.linearRampToValueAtTime(1, startAt + 0.04);
      const level = ctx.createGain(); level.gain.value = this.cal;
      const glue = ctx.createWaveShaper(); const n = 4097, c = new Float32Array(n), th = Math.tanh(1.1);
      for (let i = 0; i < n; i++) c[i] = Math.tanh(1.1 * 2 * ((i / (n - 1)) * 2 - 1)) / th / 2;
      glue.curve = c;
      const pre = ctx.createGain(); pre.gain.value = 0.5;                  // the shaper sees -2..2
      level.connect(pre); pre.connect(glue); glue.connect(out); out.connect(ctx.destination);
      const room = (i, seedN, seconds) => {                                 // one room per setting, kept between swaps: its tail carries on through them
        const key = `${seedN}|${i}|${seconds}`;
        if (!this.rooms.has(key)) { this.rooms.set(key, makeRoom(ctx, seedN, i, seconds)); if (this.rooms.size > 8) this.rooms.delete(this.rooms.keys().next().value); }
        return this.rooms.get(key);
      };
      const t = performance.now();
      const graph = build(ctx, level, this.params, this.starts, { offset, t0: startAt - offset, startAt, live: true, room });
      this.buildMs = Math.max(this.buildMs * 0.7, performance.now() - t);   // how long a build takes here, for the next lead
      graph.fade(1, startAt, 0.04);
      this.t0 = startAt - offset;
      this.inst = { graph, out, level, params: this.params, starts: this.starts };
      clearInterval(this.ticker);                                           // keep scheduling the next ~0.8 s of cuts, hits and notes
      this.ticker = setInterval(() => { if (this.inst && this.inst.graph === graph) graph.advance(ctx.currentTime - this.t0 + 0.8); }, 90);
      const loopIn = (this.total - offset) * 1000 - Math.max(0, (startAt - ctx.currentTime) * 1000);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.playing) this._swap(Math.max(0, this.ctx.currentTime - (this.t0 + this.total))); }, Math.max(0, loopIn));
      return startAt;
    }
    _retire(inst, at) {
      if (!inst) return;
      const now = this.ctx.currentTime, when = Math.max(now, at || now);
      try { inst.out.gain.cancelAndHoldAtTime(when); } catch (e) { inst.out.gain.cancelScheduledValues(when); inst.out.gain.setValueAtTime(inst.out.gain.value, when); }
      inst.out.gain.linearRampToValueAtTime(0, when + 0.04);
      inst.graph.fade(0, when, 0.04);
      inst.graph.stop(when + 0.07);
      setTimeout(() => { try { inst.out.disconnect(); } catch (e) {} inst.graph.dispose(); }, Math.max(250, (when - now) * 1000 + 250));
    }
    _swap(offset) { const old = this.inst; const startAt = this._spawn(offset); this._retire(old, startAt); this.swapAt = performance.now(); }
    async play(params, starts, offset = 0) {
      const ctx = this._context();
      if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) {} }
      starts = cleanStarts(starts);
      this.params = params; this.starts = starts; this.total = starts[starts.length - 1];
      this.cal = await level(params, starts);
      this.playing = true;
      const old = this.inst;
      const startAt = this._spawn(offset % this.total);
      if (old) this._retire(old, startAt);
    }
    // new settings or a new timeline: carry on from where the picture is (getOffset gives seconds on the new timeline, asked when the swap happens).
    // Calls that arrive while one is waiting are merged, and swaps are at least ~120 ms apart, so dragging a slider does not rebuild the sound 60 times a second.
    update(params, starts, getOffset) {
      if (!this.playing) return Promise.resolve();
      starts = cleanStarts(starts);
      if (this.inst && !this.pending && onlyTheEndMoved(this.inst, params, starts)) {                 // e.g. the picture's Multiple: the music is the same, only the clip got shorter
        this.params = params; this.starts = starts; this.total = starts[starts.length - 1];
        const pos = this.pos(), ctx = this.ctx;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { if (this.playing) this._swap(Math.max(0, ctx.currentTime - (this.t0 + this.total))); }, Math.max(0, (this.total - pos) * 1000));
        return Promise.resolve();
      }
      this.params = params; this.starts = starts; this.total = starts[starts.length - 1];
      this.holding = Math.max(this.holding, 1);                            // until the swap the old sound's position means nothing on the new timeline
      if (this.pending) { this.pending.getOffset = getOffset; return this.pending.promise; }
      const wait = Math.max(0, 120 - (performance.now() - this.swapAt));
      const job = { getOffset };
      job.promise = new Promise(resolve => {
        setTimeout(() => {
          this.pending = null;
          this.holding = 0;
          if (this.playing) {
            const k = levelKey(this.params, this.starts);
            if (levelCache.has(k)) this.cal = levelCache.get(k);
            this._swap(Math.max(0, Math.min(job.getOffset(), this.total - 0.01)));
            this._recalibrate();
          }
          resolve();
        }, wait);
      });
      this.pending = job;
      return job.promise;
    }
    // back to the start of the clip now (the settings are unchanged, so update() would rightly skip it)
    restart(params, starts) {
      if (!this.playing) return;
      if (params && starts) { starts = cleanStarts(starts); this.params = params; this.starts = starts; this.total = starts[starts.length - 1]; }
      this.pending = null; this.holding = 0;
      this._swap(0);
    }
    // the exact level for the current settings, worked out off the swap path; the running sound eases to it
    _recalibrate() {
      clearTimeout(this.calTimer);
      this.calTimer = setTimeout(() => (window.requestIdleCallback ? window.requestIdleCallback(go, { timeout: 1500 }) : go()), 350);   // when the page has a quiet moment
      const go = async () => {
        if (!this.playing || !this.inst) return;
        const p = this.params, st = this.starts, g = await level(p, st);
        if (!this.playing || !this.inst || p !== this.params) return;
        this.cal = g;
        this.inst.level.gain.setTargetAtTime(g, this.ctx.currentTime, 0.15);
      };
    }
    stop() {
      this.playing = false;
      this.pending = null; this.holding = 0;
      clearTimeout(this.timer); clearTimeout(this.calTimer); clearInterval(this.ticker);
      if (this.inst) { this._retire(this.inst); this.inst = null; }
    }
  }

  window.Drone = { build, level, renderExport, toWav, Live, TARGET_RMS, CHORDS, rootHz };
})();
