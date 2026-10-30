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
  // a plain drive over -1..1 (Acid, tape): tanh(k x) / tanh(k), made once per k
  const satCache = new Map();
  function satCurve(k) {
    if (!satCache.has(k)) { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1)) / Math.tanh(k); satCache.set(k, c); }
    return satCache.get(k);
  }
  // the same drive over -4..4 for a signal scaled by 1/4 going in and by 4 coming out: loud peaks bend instead of clipping at 1 (tape)
  function wideSatCurve(k) {
    const key = `w${k}`;
    if (!satCache.has(key)) { const n = 4097, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.tanh(4 * k * ((i / (n - 1)) * 2 - 1)) / Math.tanh(k) / 4; satCache.set(key, c); }
    return satCache.get(key);
  }
  function tanhCurve(k, norm) {
    const n = 4097, c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = Math.tanh(k * 4 * ((i / (n - 1)) * 2 - 1)) / norm;
    return c;
  }

  // what happened to the live sound, in the console (Safari / the app: right-click › Inspect Element › Console), to see why it stopped
  function soundLog(...a) { try { console.info(`[sound ${new Date().toTimeString().slice(0, 8)}]`, ...a.filter(Boolean)); } catch (e) {} }

  // The kind of room (more variety in the same style, 2026-10-30): Space says how much, Room says what kind. Room is the measured one (as
  // before); Booth small and dry, a short dark slap; Hall huge and darker, a long tail after a gap; Bloom swells in instead of striking,
  // the reverb arriving after the note. All band-limited as before (no boom under 150 Hz, nothing bright), so the sub stays the sound.
  const ROOMS = [
    { name: 'Room', seconds: sp => 2.4 + 3.6 * sp, lo: 150, hi: 900, pre: 0.025, wet: 1 },
    { name: 'Booth', seconds: sp => 0.5 + 0.7 * sp, lo: 180, hi: 650, pre: 0.004, wet: 0.75 },
    { name: 'Hall', seconds: sp => 5 + 3 * sp, lo: 130, hi: 600, pre: 0.07, wet: 1.15 },
    { name: 'Bloom', seconds: sp => 3 + 3 * sp, lo: 150, hi: 800, pre: 0.02, wet: 1, swell: 0.45 },
  ];
  const ROOM_SEED = 7;                                                 // one room for every seed: a reverb's noise is not heard as different, and a new one per Random cost up to 100 ms
  const roomKind = p => ROOMS[Math.max(0, Math.min(ROOMS.length - 1, Math.round(+p.room || 0)))];
  const roomLength = (kind, space) => Math.max(0.5, Math.round(kind.seconds(space) * 2) / 2);   // in half-second steps, so it is reused while a slider moves
  function makeRoom(ctx, seedN, i, roomSeconds, kind = ROOMS[0]) {
    const conv = ctx.createConvolver(); conv.normalize = false;
    const data = cachedData(ctx.sampleRate, `room|${kind.name}|${i}|${roomSeconds}`, () => roomData(ctx.sampleRate, mulberry32(ROOM_SEED + 7919 * (i + 1)), roomSeconds, kind));
    const b = ctx.createBuffer(1, data.length, ctx.sampleRate); b.copyToChannel(data, 0); conv.buffer = b;
    return conv;
  }

  // The live sound's rooms are made in a worker: a long room (the Hall's 8 s) took 60-80 ms on the main thread, and dragging Space made a
  // new one every half second: the picture stalled (the user: everything must stay smooth). Until the exact room is ready the sound keeps the
  // nearest one it has. Exports (offline renders) still make theirs at once.
  let roomWorker = null, roomJob = 0;
  const roomWaiting = new Map();
  function roomInWorker(rate, seed, seconds, kind) {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return null;
    if (!roomWorker) {
      try {
        const src = `const TAU = ${TAU}; ${mulberry32}; ${gauss}; ${onePole}; const ROOMS = [{ pre: 0.025, hi: 900, lo: 150 }]; ${roomData};
          onmessage = e => { const { id, rate, seed, seconds, kind } = e.data; const d = roomData(rate, mulberry32(seed), seconds, kind); postMessage({ id, d }, [d.buffer]); };`;
        roomWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        roomWorker.onmessage = e => { const f = roomWaiting.get(e.data.id); roomWaiting.delete(e.data.id); if (f) f(e.data.d); };
      } catch (e) { roomWorker = false; }
    }
    if (!roomWorker) return null;
    return new Promise(res => { const id = ++roomJob; roomWaiting.set(id, res); roomWorker.postMessage({ id, rate, seed, seconds, kind: { pre: kind.pre, hi: kind.hi, lo: kind.lo, swell: kind.swell || 0 } }); });
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

  // a dark room: decaying noise, band-limited to 150-900 Hz, after a short pre-delay. Without the cut at the bottom, low-passed noise
  // drifts: for some seeds its sum is far from zero and the room becomes a strong boost around 100 Hz that swamps the sub
  function roomData(rate, rand, seconds, kind = ROOMS[0]) {
    const n = Math.floor(seconds * rate), pre = Math.floor(kind.pre * rate);
    const ir = new Float32Array(n);
    for (let i = 0; i < n; i++) ir[i] = gauss(rand) * Math.exp(-(i / rate) * (6.9 / seconds)) * (kind.swell ? 1 - Math.exp(-(i / rate) / kind.swell) : 1);   // Bloom: rises first
    onePole(ir, kind.hi, rate, 2);
    const low = ir.slice(); onePole(low, kind.lo, rate, 2);
    for (let i = 0; i < n; i++) ir[i] -= low[i];
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
  const SUB_WAVES = ['sine', 'triangle', 'square', 'sawtooth'];   // the sub; the square is softened (a low-pass) before it saturates; 'sawtooth' is the moving pulse (below)
  // the Pad's tone (2026-10-30, more variety on the same patch): Warm (as before: a slow low-pass), Glass (the saws through a wavefolder
  // before the filter: glassier harmonics, still dark), Hollow (a band-pass slowly sweeping instead of the low-pass: a vocal, hollow pad)
  const PAD_TONES = ['Warm', 'Glass', 'Hollow'];
  const foldCache = new Map();
  function foldCurve(k) {                                              // a wavefolder: past the edge the wave folds back instead of clipping
    if (!foldCache.has(k)) { const n = 4097, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.sin(Math.PI * k * ((i / (n - 1)) * 2 - 1)) / 1.2; foldCache.set(k, c); }
    return foldCache.get(k);
  }
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
  // Chord changes, in the minor key of the root: the bed (sub, pad, chord, choir, textures) moves to another degree every few cuts and comes
  // round again, while the arpeggio stays in the home key, a melody over a moving bass. Semitones from the root, all degrees of the natural
  // minor and within a fourth either way, so the drone stays heavy: Descend i-VII-VI-V (the Andalusian cadence), Lift i-III-iv-III,
  // Pendulum i-v, Wander a seeded walk over i, VII, III, v, iv, VI. With changes on, the chord sheds its third (minor plays suspended, the
  // dark cluster an open fifth): a third moved in parallel leaves the key and clashes with the melody; without it every chord stays in key.
  const PROGRESSIONS = [
    null,
    { name: 'Descend', steps: [0, -2, -4, -5] },
    { name: 'Lift', steps: [0, 3, 5, 3] },
    { name: 'Pendulum', steps: [0, -5] },
    { name: 'Wander', walk: [0, -2, 3, -5, 5, -4] },
  ];
  const PROG_EVERY = [2, 4, 8, 16];
  // Modes: the key the whole sound plays in (more variety in the same dark style, the user's ask, 2026-10-30). The natural minor as before;
  // Dorian (its major sixth: dark but warm), Phrygian (its flat second: the darkest), Harmonic minor (its raised seventh: tension). The pad's
  // chords and the arpeggio's notes take the mode's degrees (`inMode`), and each mode has its own chord changes: the bed moves in parallel
  // open fifths, so it only lands on degrees whose fifth is in the mode (in Dorian the VI's is not, in Phrygian the v's, in Harmonic minor the
  // VII's and III's), the progressions keep their shape (Descend steps down, Lift goes up and back, Pendulum swings between two)
  const MODES = [
    { name: 'Minor', scale: [0, 2, 3, 5, 7, 8, 10], steps: null },
    { name: 'Dorian', scale: [0, 2, 3, 5, 7, 9, 10], steps: { Descend: [0, -2, -7, -5], Lift: [0, 3, 5, 3], Pendulum: [0, -7], Wander: [0, -2, 3, -5, 5, 2] } },
    { name: 'Phrygian', scale: [0, 1, 3, 5, 7, 8, 10], steps: { Descend: [0, -2, -4, -2], Lift: [0, 1, 3, 1], Pendulum: [0, 1], Wander: [0, -2, 1, 3, 5, -4] } },
    { name: 'Harmonic minor', scale: [0, 2, 3, 5, 7, 8, 11], steps: { Descend: [0, -4, -7, -5], Lift: [0, 5, 7, 5], Pendulum: [0, -5], Wander: [0, -4, 5, -5, -7] } },
  ];
  function inMode(st, mode) {                                          // a degree of the natural minor (semitones over the tonic) as the same degree of the mode
    const o = Math.floor(st / 12), n = st - 12 * o, i = [0, 2, 3, 5, 7, 8, 10].indexOf(n);
    return i < 0 ? st : mode.scale[i] + 12 * o;                         // anything else (Dark's flat second) as it is
  }
  // The bassline: a sequencer on a plucked saw an octave over the sub (it follows the chord changes). Only root, fifth and octave, so it
  // stays in key on every chord; the rhythm comes from rests and accents. Four steps, 1 / 2 / 4 a cut.
  const BASS_PATTERNS = [
    { name: 'Pulse', notes: [0, 0, 0, 0], acc: [1, 0, 0.5, 0] },
    { name: 'Octave', notes: [0, 12, 0, 12], acc: [1, 0, 0.5, 0] },
    { name: 'Fifths', notes: [0, 7, 12, 7], acc: [1, 0, 0.5, 0] },
    { name: 'Gallop', notes: [0, null, 0, 0], acc: [1, 0, 0.4, 0.7] },
  ];
  const BASS_PER_CUT = [1, 2, 4];
  // Arrangement: the arpeggio, the bassline and the hits come and go over the film instead of all playing throughout (the bed stays).
  // Build-up: they enter one by one and the ending strips back; Sections: sparse and full by turns, every 8 of the music's cuts;
  // Follows the speed: fuller while the cuts are fast (a flat speed builds up instead).
  const ARRANGEMENTS = ['Off', 'Build-up', 'Sections', 'Follows the speed'];
  const SECTION_CUTS = 8;
  const SECTIONS = [{ arp: 1, bass: 0, hits: 0 }, { arp: 1, bass: 1, hits: 1 }, { arp: 0, bass: 1, hits: 0 }, { arp: 1, bass: 1, hits: 1 }];                                     // cuts per chord
  // Arpeggio moods. One instrument for all of them, the first arpeggio's patch (two detuned saws into a resonant low-pass that snaps shut on
  // each note: the modular sound), played differently, as a player turns the same patch: the notes (scale over the tonic, two octaves above
  // the root; register lo..hi times the tonic), the shape (Dark falls; Phase: two voices loop the same notes, one a note longer, so they drift
  // apart and back (Reich, Barbieri), one on each side;
  // Sweep keeps a short walk while the filter opens and
  // shuts over ~7 s, resonant (Barbieri's Ecstatic Computation); Mutate changes one
  // note each round (a Turing Machine); Accumulate plays 2 notes, then 3, ... up to the whole pattern, and starts over (an additive process)), how far the filter opens and shuts (`open`, `close`), its resonance (`q`) and how long a note rings (`sustain`).
  // Two voices take turns, so a note rings on under the next. Pluck keeps its own path (chord tones, a random walk).
  const ARP_MOODS = [
    { name: 'Pluck' },
    { name: 'Dark', scale: [0, 1, 3, 5, 7, 8], lo: 0.5, hi: 1.6, open: 1100, close: 240, q: 3, sustain: 1.6, gain: 1.0, voices: 1, shape: 'fall' },
    { name: 'Phase', scale: [0, 3, 7, 10], lo: 1, hi: 2.6, open: 1500, close: 380, q: 2.5, sustain: 1.2, gain: 0.7, voices: 2, shape: 'phase' },
    { name: 'Sweep', scale: [0, 3, 7, 10], lo: 1, hi: 2.2, open: 1600, close: 300, q: 6, sustain: 1.4, gain: 0.9, voices: 2, shape: 'walk', sweep: 7 },
    { name: 'Mutate', scale: [0, 2, 3, 7, 10], lo: 0.75, hi: 2.6, open: 1700, close: 400, q: 2.5, sustain: 1.2, gain: 1.0, voices: 2, shape: 'walk', mutate: true },
    { name: 'Accumulate', scale: [0, 3, 5, 7, 10], lo: 0.75, hi: 2.6, open: 1700, close: 400, q: 2.5, sustain: 1.2, gain: 1.0, voices: 2, shape: 'walk', accumulate: true },
    // Acid: the same saws, low, with a very resonant filter, some steps accented (the filter opens wider, louder), some sliding into the
    // next note, and saturation after the filter: the squelch of Maelstrom, Plant43, Kangding Ray
    { name: 'Acid', scale: [0, 3, 5, 7, 10], lo: 0.5, hi: 1.6, open: 2200, close: 170, q: 13, sustain: 1.0, gain: 0.7, voices: 1, shape: 'walk', acid: true },
    // Euclid: the same patch, its notes on a Euclidean rhythm (k hits spread as evenly as they go over n steps: 3 in 8, 5 in 12, 7 in 16...,
    // the off-kilter modular pulse of Barbieri or Ikeda; still the arpeggio's own steps, never a drum), each hit thrown to the other side
    // (ping-pong); the melody moves on only on hits (2026-10-30, more variety in the same style)
    { name: 'Euclid', scale: [0, 3, 5, 7, 10], lo: 0.75, hi: 2.6, open: 1800, close: 340, q: 4, sustain: 1.3, gain: 1.0, voices: 2, shape: 'walk', euclid: true },
  ];
  // Styles: whole ways of playing the same patch (2026-10-30; inspired by artists, never named after them). Drone: the measured dark bed
  // carries the sound, everything else under it (as before).
  const STYLES = [
    { name: 'Drone', bed: 1, arpGain: 1, arpUp: 1, arpOpen: 1, arpQ: 1, arpSustain: 1 },
    // 1 was Spiral (the sequence in front, an octave up, climbing through the scale every two rounds, the bed stepped back): 46 of 72 marks
    // liked under Any, 3 of 13 in Pulse and Machine, its arpeggio "can be loud", then "just kill SPIRAL" (the user, 2026-10-30); removed.
    // Its number stays, as the drone
    { name: 'Spiral (retired)', bed: 1, arpGain: 1, arpUp: 1, arpOpen: 1, arpQ: 1, arpSustain: 1 },
    // 2 was Tide (the bed swelling by itself, one note, no beat; from a reference the user sent): 10 of 28 marks liked, then "kill Tide"
    // (the user, 2026-10-30); removed. Its number stays, as the drone, like Signal's and Lyric's
    { name: 'Tide (retired)', bed: 1, arpGain: 1, arpUp: 1, arpOpen: 1, arpQ: 1, arpSustain: 1 },
    // 3 and 4 were Signal (sines, clicks, silence) and Lyric (a lead melody, a Major mode), built and judged on 2026-10-30: 0 of 30 marks
    // liked (the user: they "kill"); removed. Their numbers stay, so a sound or a mark saved with them opens, as the drone
    { name: 'Signal (retired)', bed: 1, arpGain: 1, arpUp: 1, arpOpen: 1, arpQ: 1, arpSustain: 1 },
    { name: 'Lyric (retired)', bed: 1, arpGain: 1, arpUp: 1, arpOpen: 1, arpQ: 1, arpSustain: 1 },
    // Hypnotic: sixteenths on the music cuts (a beat near 128 BPM at the film's usual cut, following the speed): a rolling bass on the
    // off-sixteenths whose filter drifts (Bassline) and a short sequence in 3, 5 or 7 against the bar through an echo, its filter sweeping over
    // ~40 s (Arpeggio); no bass in the intro or the break. No drums: a hat was "probably cringe", then the kick "not a good idea" (the user, 2026-10-30)
    { name: 'Hypnotic', bed: 0.75, arpGain: 1, arpUp: 1, arpOpen: 1, arpQ: 1, arpSustain: 1, grid: true, own: true },
    // Run (the user's ask, 2026-10-30: a running bass, in the spirit of an 80s film score): the bass never stops, sixteenths on the same warped grid
    // as Hypnotic's (it follows the speed), brassy (two saws and a square an octave under through a resonant low-pass that opens on the
    // accents and drifts over ~30 s), a short glide between notes, the chord changes under it; the pad swells like brass on each chord
    // (the filter opens and closes), in a big room. The Bassline pattern picks the run: Pulse steady, Octave jumping, Fifths walking, Gallop
    { name: 'Run', bed: 0.6, arpGain: 1, arpUp: 1, arpOpen: 1, arpQ: 1, arpSustain: 1, run: true, own: true },
  ];
  const EUCLID = [[3, 8], [5, 8], [5, 12], [7, 12], [5, 16], [7, 16], [9, 16]];
  const euclid = (k, n) => Array.from({ length: n }, (_, i) => Math.floor(((i + 1) * k) / n) > Math.floor((i * k) / n));   // Bresenham: k hits, evenly
  const euclidHit = (gate, k, step) => (gate[step % gate.length] ? Math.floor(step / gate.length) * k + gate.slice(0, step % gate.length).filter(Boolean).length : -1);   // which hit a step is, or -1: a rest
  const MOOD_DETUNE = 0.004, MOOD_ATTACK = 0.0015;                   // the first arpeggio's: two saws a hair apart, a pluck
  // the Pad voices its chords on the mode's degrees (in the natural minor: i m7, III maj7, iv m7, v m7, VI maj7, VII 7)
  function padChord(degree, mode = MODES[0]) {                        // semitones from the tonic, voiced root, fifth, seventh, third an octave up, in the mode
    const S = mode.scale, dn = ((degree % 12) + 12) % 12, idx = Math.max(0, S.indexOf(dn)), at = k => S[(idx + k) % 7] + 12 * Math.floor((idx + k) / 7) - dn + degree;
    return [at(0), at(4), at(6), at(2) + 12];
  }
  const RISE = 0.004, TICK_RISE = 0.002, ECHO_GLIDE = 0.08;           // ...and how fast an echo's time follows a new cut length                               // how fast the pump comes back up and the cut's tone starts (time constants, s)
  // tape: wow and flutter, saturation, a darker top, dust. The dust is a few sparse clicks, made once per sample rate
  const dustCache = new Map();
  function dustBuffer(ctx) {
    if (!dustCache.has(ctx.sampleRate)) {
      const r = mulberry32(5), n = Math.floor(3 * ctx.sampleRate), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) if (r() < 0.0004) { const a = (r() - 0.5) * 2; for (let j = 0; j < 12 && i + j < n; j++) d[i + j] += a * Math.exp(-j / 3); }
      dustCache.set(ctx.sampleRate, b);
    }
    return dustCache.get(ctx.sampleRate);
  }
  const moodNotes = (m, tonic, mode = MODES[0]) => {                  // every note of the mood's scale (in the mode) inside its register, low to high
    const out = [];
    for (let o = -2; o <= 3; o++) for (const st0 of m.scale) { const st = m.name === 'Dark' ? st0 : inMode(st0, mode); const f = tonic * Math.pow(2, (st + 12 * o) / 12); if (f >= tonic * m.lo && f <= tonic * m.hi) out.push(f); }
    return out.sort((a, b) => a - b);
  };
  const phaseLoop = a => [...a.slice(0, a.length >> 1), a[a.length >> 1], ...a.slice(a.length >> 1)];   // Phase's second loop: the same notes, one repeated, a step longer
  function moodPattern(shape, n, steps, rand) {                        // indices into the notes, `steps` long
    const top = n - 1, out = [];
    let c = shape === 'fall' ? top : Math.floor(rand() * n);
    for (let k = 0; k < steps; k++) {
      if (shape === 'fall') {                                          // down by a step, now and then two; from the top again at the bottom
        out.push(c); c -= rand() < 0.3 ? 2 : 1; if (c < 0) c = top - Math.floor(rand() * 2);
      } else {                                                         // walk (and Phase): a step or two each way
        out.push(c); c = Math.max(0, Math.min(top, c + [-2, -1, 1, 2][Math.floor(rand() * 4)]));
      }
    }
    return out;
  }

  const ARP_PER_CUT = [0.5, 1, 2, 4, 1.5, 0.75];                      // arpeggio notes per cut; 1.5 and 0.75 are 3 against 2 and 3 against 4: polyrhythms that drift against the picture
  // the notes falling in cut i at `per` notes a cut: note k sits at k / per cuts (so the pattern stays in phase from any offset)
  const notesIn = (i, per) => { const out = []; for (let k = Math.ceil(i * per - 1e-9); k < (i + 1) * per - 1e-9; k++) out.push([k, k / per - i]); return out; };
  // where the notes of cut i fall: [step, clip second, the length they are spread over]. The film's end cuts the last music cut
  // short: it keeps the length of the one before (it is never played faster) and the notes past the end are left out
  const cutNoteLen = (starts, i) => { const n = starts.length - 1, len = starts[i + 1] - starts[i]; return i === n - 1 && i > 0 ? Math.max(len, starts[i] - starts[i - 1]) : len; };
  const noteTimes = (starts, i, per) => { const len = cutNoteLen(starts, i), end = starts[starts.length - 1] - 0.002; return notesIn(i, per).map(([k, frac]) => [k, starts[i] + frac * len, len]).filter(([, t]) => t < end); };
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
    const chordIdx = Math.max(0, Math.min(CHORDS.length - 1, Math.round(+p.chord || 0)));
    const progOn = PROGRESSIONS[Math.max(0, Math.min(PROGRESSIONS.length - 1, Math.round(+p.prog || 0)))] !== null;
    const chord = CHORDS[progOn ? ({ 0: 1, 2: 3 }[chordIdx] ?? chordIdx) : chordIdx];   // with chord changes, no third (see PROGRESSIONS)
    const echo = clamp01(p.echo === undefined ? 0 : p.echo);
    let wash = clamp01(p.wash || 0), ring = clamp01(p.ring || 0), shimmer = clamp01(p.shimmer || 0);
    const pick = (v, n) => Math.max(0, Math.min(n - 1, Math.round(+v || 0)));
    const choir = clamp01(p.choir || 0), industrial = clamp01(p.industrial || 0);   // two layers mixed into the drone: low voices, and metal and noise
    const hitType = pick(p.hitType, 5), hitAmt = clamp01(p.hit || 0), hitOn = pick(p.hitOn, 4);
    const arpMood = ARP_MOODS[pick(p.arpMood, ARP_MOODS.length)], style = STYLES[pick(p.style, STYLES.length)];
    const arpAmt = clamp01(p.arp || 0), arpSteps = ARP_STEPS[pick(p.arpSteps, ARP_STEPS.length)], arpRate = pick(p.arpRate, ARP_PER_CUT.length);
    const dynamics = opts.dynamics === false ? 0 : pick(p.dynamics, 4);
    const prog = PROGRESSIONS[pick(p.prog, PROGRESSIONS.length)], progEvery = PROG_EVERY[pick(p.progEvery, PROG_EVERY.length)];
    const mode = MODES[pick(p.mode, MODES.length)], own = prog && mode.steps ? mode.steps[prog.name] : null;   // the mode's own chord changes
    const progSeq = !prog ? [0] : prog.steps ? own || prog.steps : (() => { const r = mulberry32(seedN + 31), walk = own || prog.walk, out = [0]; for (let k = 1; k < 8; k++) out.push(walk[1 + Math.floor(r() * (walk.length - 1))]); return out; })();
    const degreeAt = i => progSeq[Math.floor(i / progEvery) % progSeq.length];   // the chord at music cut i, in semitones from the root
    const padAmt = clamp01(p.pad || 0), tape = clamp01(p.tape || 0);
    const bassAmt = clamp01(p.bass || 0), bassPat = BASS_PATTERNS[pick(p.bassPattern, BASS_PATTERNS.length)], bassPer = BASS_PER_CUT[pick(p.bassRate, BASS_PER_CUT.length)];
    const arrange = pick(p.arrange, ARRANGEMENTS.length);
    const subWave = Math.max(0, Math.min(SUB_WAVES.length - 1, Math.round(+p.subWave || 0)));
    const padWave = Math.max(0, Math.min(PAD_WAVES.length - 1, Math.round(+p.padWave || 0)));
    const move = Math.pow(2, 2 * (clamp01(p.movement === undefined ? 0.5 : p.movement) - 0.5));   // 0.5 = as measured; 1 = twice as fast
    const nodes = [];                                                      // everything that must be stopped
    const sends = [];
    const links = [];                                                      // connections to unplug when this sound is retired (a shared room outlives it)
    const keep = n => { nodes.push(n); return n; };
    const gain = (v, to) => { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    const pitched = [];                                                    // every oscillator that plays a note (not the LFOs): what chord changes move
    const osc = (type, freq, to, inPhase = false) => {
      const o = keep(ctx.createOscillator()); o.type = type; o.frequency.value = freq; pitched.push(o);
      if (inPhase && offset > 0 && type === 'sine') o.setPeriodicWave(phasedWave(ctx, type, freq * offset));     // in phase with where the clip is (only the sub: it is coherent between the old sound and the new one; the rest is not worth a wave each)
      if (to) o.connect(to); return o;
    };
    const lfo = (rate, depth, param) => { const o = osc('sine', rate); pitched.pop(); const g = gain(depth, param); o.connect(g); return o; };
    const shaper = (curve, to) => { const s = ctx.createWaveShaper(); s.curve = curve; if (to) s.connect(to); return s; };
    const lowpass = (fc, to) => { const a = ctx.createBiquadFilter(); a.type = 'lowpass'; a.frequency.value = fc; a.Q.value = 0.707; const b = ctx.createBiquadFilter(); b.type = 'lowpass'; b.frequency.value = fc; b.Q.value = 0.707; a.connect(b); if (to) b.connect(to); return [a, b]; };

    // automation helpers; each skips what is already in the past when playing from an offset
    const sampled = (param, fn) => {                                       // a curve sampled 50 times a second, at most 600 points (they move over seconds: a
      const from = Math.min(offset, total), span = Math.max(0.04, total - from), n = Math.max(2, Math.min(600, Math.ceil(span * 50)));   // long film's thousands of points froze each swap)
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) c[i] = fn(from + (span * i) / (n - 1));
      param.setValueCurveAtTime(c, at(from), span);
    };
    // dynamics: an arc over the notes, not the volume. 0 = low, soft, long; 1 = high, bright, short; 0.5 = as written (what Off plays).
    // Rise climbs over the whole clip, Fall sinks over it, Follows the speed is high while the cuts are fast (a flat speed has nothing to follow).
    const arc = (() => {
      if (!dynamics) return () => 0.5;
      const lens = starts.slice(1).map((v, i) => v - starts[i]);
      const whole = lens.length > 2 ? lens.slice(0, -1) : lens;               // the last cut can be a stub (the clip ends inside it): it is not a speed
      const lo = Math.min(...whole), hi = Math.max(...whole);
      return t => {
        const u = Math.min(1, Math.max(0, t / total));
        if (dynamics === 1) return u;
        if (dynamics === 2) return 1 - u;
        return hi > lo * 1.05 ? Math.min(1, Math.max(0, Math.log(hi / lens[Math.min(lens.length - 1, cutAtTime(starts, t))]) / Math.log(hi / lo))) : 0.5;
      };
    })();
    const lift = (s, span) => Math.pow(2, (s - 0.5) * span);               // a pitch factor: span 1.2 = +-7 semitones at the extremes
    const landed = t => smooth((t - land) / 1.2);                           // 0 -> 1 over the last hold
    // Everything that happens at a cut is scheduled just ahead of the sound (advance), not for the whole clip at once: a long, fast clip
    // would otherwise put thousands of events and nodes in the graph before the first note plays.
    const perCut = [];                                                       // (cut index, context time) handlers, run in order
    let cursor = 0;
    { const c = cutAtTime(starts, offset); cursor = starts[c] >= offset - 0.001 ? c : c + 1; }
    const grids = [];                                                        // Hypnotic's clock: steps of its own, scheduled as the cuts are
    const advance = to => {
      while (cursor < nCuts && starts[cursor] <= to) { const i = cursor++; for (const h of perCut) h(i, at(starts[i])); }
      for (const g of grids) while (g.i < g.n && g.time(g.i) <= to) { const i = g.i++; g.fn(i, at(g.time(i))); }
    };
    // a grid of `per` steps a music cut, warped along the cuts: it speeds up and slows down with them, and every cut lands on a step
    // (Hypnotic's sixteenths; the user: the music must follow the curve of the speed). Step i sits at cut position i / per.
    const gridTime = per => i => { const u = i / per, c = Math.min(nCuts - 1, Math.floor(u + 1e-9)); return starts[c] + (u - c) * cutNoteLen(starts, c); };
    const addGrid = (per, fn) => {
      const time = gridTime(per), c = cutAtTime(starts, offset), len = cutNoteLen(starts, c);
      const from = Math.max(0, Math.ceil((c + (len > 0 ? (offset - starts[c]) / len : 0)) * per - 1e-9));
      let n = Math.ceil(nCuts * per - 1e-9); while (n > 0 && time(n - 1) >= total - 0.002) n--;   // the short last cut: nothing past the end
      grids.push({ time, fn, n, i: from });
    };
    const pump = (param, depth, decay) => {                                // dips and comes back on every cut
      const c = cutAtTime(starts, offset), tau = offset - starts[c];
      param.setValueAtTime(1 - depth * (1 - Math.exp(-tau / decay)), at(offset));
      param.setTargetAtTime(1 - depth, at(offset), decay);
      // back up in a few ms, never a jump: an instant step of a 50 Hz sine is a click, loud or not by where the wave happens to be (the user heard "tick tick tick here and there", 2026-10-30)
      perCut.push((i, t) => { param.setTargetAtTime(1, t, RISE); param.setTargetAtTime(1 - depth, t + 3 * RISE, decay); });
    };
    const tickEnv = (param, decay) => {                                    // a short click at every cut
      const c = cutAtTime(starts, offset), tau = offset - starts[c];
      param.setValueAtTime(Math.exp(-tau / decay), at(offset));
      param.setTargetAtTime(0, at(offset), decay);
      perCut.push((i, t) => { param.setTargetAtTime(1, t, TICK_RISE); param.setTargetAtTime(0, t + 3 * TICK_RISE, decay); });   // a tone that starts softly, not a step
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
        else if (subWave === 3) {                                          // Pulse: the saw minus itself a moment later is a pulse; that moment breathes (PWM), softened as the square
          const [l1] = lowpass(190, level), period = 1 / (f0 * mult), dl = ctx.createDelay(0.1); dl.delayTime.value = 0.5 * period;
          lfo(0.09, 0.14 * period, dl.delayTime);                          // the width breathes between about 36% and 64%: the fundamental stays strong
          o.connect(gain(g * 0.5, l1)); o.connect(dl); dl.connect(gain(-g * 0.5, l1));
        }
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
        if (dynamics) sampled(o.frequency, t => f0 * r * det * (1 + 0.002 * side) * lift(arc(t), 0.7));     // the cluster follows the arc by a few semitones
        const g = gain(lfoGains[i] * 0.75 * (0.34 + 0.2 * bright), body);
        lfo(lfoRates[i], lfoGains[i] * 0.25 * (0.34 + 0.2 * bright), g.gain);
        o.connect(g);
      });
      // a click on every cut
      const tickG = gain(0); tickEnv(tickG.gain, 0.03);
      const tickAmt = gain((0.2 + 0.5 * pulse) * 0.9, body);
      tickG.connect(tickAmt);
      for (const r of [7.2, 9.2]) osc('sine', f0 * r * (1 + 0.003 * side), tickG);
      air.connect(gain(0.05 * bright * (1 + 0.4 * industrial), body));
      if (choir > 0.01) {                                                  // low voices, under the drone: on two chord tones, through two vowel formants drifting between "ah" and "oh"
        const voices = gain(1);
        [chord.ratios[0], chord.ratios[2]].forEach((r, i) => {
          const f = (f0 * r / 2) * det, o = osc('sawtooth', f, voices);
          lfo(4.6 + 0.7 * i, f * 0.005, o.frequency);                     // a singer's vibrato
        });
        [[525, 125, 7, 1.0], [940, 140, 9, 0.55]].forEach(([c, d, q, g]) => {
          const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = c; bp.Q.value = q;
          voices.connect(bp); lfo((0.04 + 0.03 * rand()) * move, d, bp.frequency); bp.connect(gain(5 * g * choir, body));
        });
      }
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
      const k = (1 + 1.5 * power) * (1 + 0.6 * industrial);
      const sat = shaper(tanhCurve(k, 1));
      body.connect(pg); pg.connect(lg); lg.connect(sat);
      const sum = gain(style.bed);                                         // the style's bed: all of it in Drone, stepped back under Hypnotic's and Run's lines
      sat.connect(sum); subBus.connect(sum);
      const br = gain(1); sum.connect(br);
      lfo(0.11 * move, 0.07, br.gain);
      sides.push(br);
    }

    // ---- the room: the send skips the sub ----
    const kind = roomKind(p), roomSeconds = roomLength(kind, space), wet = (0.05 + 0.5 * space) * kind.wet * (style.wet ?? 1);
    const mix = [gain(1), gain(1)];
    sides.forEach((br, i) => {
      br.connect(mix[i]);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 140; hp.Q.value = 0.707;
      // the room is a convolver, and loading its impulse response is the costliest step of a rebuild: the live preview passes in a shared one
      // measuring the level (a 3 s offline render) takes a short room of the same energy (each is made to unit energy): the same reading,
      // without preparing an 8 s room on the main thread at every change
      const conv = opts.room ? opts.room(i, seedN, roomSeconds, kind) : makeRoom(ctx, seedN, i, opts.quickRoom ? Math.min(1.5, roomSeconds) : roomSeconds, kind);
      const wetG = gain(wet, mix[i]);
      const send = gain(opts.live ? 0 : 1);                                // this sound's feed into the room: it fades with the crossfade, or the room would hear old and new at full level
      sends.push(send);
      br.connect(hp); hp.connect(send); send.connect(conv); conv.connect(wetG);
      links.push([send, conv], [conv, wetG]);
      if (echo > 0.01) {                                                   // a dark feedback echo, a different time each side
        // three cuts long, a third more on the right; it follows the speed: each cut glides it to that cut's length (a variable film held the
        // average and drifted against the beat), slowly enough that the echoes do not bend in pitch
        const echoAt = c => Math.min(0.75, Math.max(0.18, cutNoteLen(starts, c) * 3)) * (i ? 1.33 : 1);
        const dl = ctx.createDelay(2); dl.delayTime.value = echoAt(Math.min(nCuts - 1, cutAtTime(starts, offset)));
        perCut.push((c, t) => dl.delayTime.setTargetAtTime(echoAt(c), t, ECHO_GLIDE));
        const fb = gain(0.3 + 0.3 * echo), dark = ctx.createBiquadFilter(); dark.type = 'lowpass'; dark.frequency.value = 900;
        const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 140; hp2.Q.value = 0.707;
        br.connect(hp2); hp2.connect(dl); dl.connect(dark); dark.connect(fb); fb.connect(dl); dark.connect(gain(0.7 * echo, mix[i]));
      }
    });
    // ---- hits: a percussive impact on some of the cuts. Fixed voices (made once), retriggered by automation: no node per hit ----
    // each layer the arrangement moves has its own level on the way to the sides
    const arr = { hits: gain(1), arp: [gain(1, sides[0]), gain(1, sides[1])], bass: [gain(1, sides[0]), gain(1, sides[1])] };
    const hitBus = gain(1, arr.hits);
    sides.forEach(br => arr.hits.connect(gain(0.9, br)));

    // ---- the bassline: before the hits, so the chord changes move it with the bed ----
    if (!style.own && bassAmt > 0.01) {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 5; lp.frequency.value = 200;
      const env = gain(0); lp.connect(env); env.connect(gain(0.55, arr.bass[0])); env.connect(gain(0.55, arr.bass[1]));
      const oscs = [['sawtooth', -0.003, 1], ['square', 0.003, 0.5]].map(([w, det, g]) => { const o = osc(w, f0 * 2); o.connect(gain(g, lp)); return [o, det]; });
      const L = bassPat.notes.length;
      perCut.push((i, tc) => {
        const len = cutNoteLen(starts, i), stepLen = len / bassPer;
        for (let k = 0; k < bassPer; k++) {
          const st = i * bassPer + k, note = bassPat.notes[st % L];
          if (note === null || starts[i] + k * stepLen >= starts[nCuts] - 0.002) continue;   // the short last cut: no squeeze, nothing past the end
          const t = tc + k * stepLen, s = arc(starts[i] + k * stepLen), accent = 0.65 + 0.35 * bassPat.acc[st % L];
          const f = f0 * 2 * Math.pow(2, note / 12), decay = Math.min(0.35, Math.max(0.06, stepLen * 0.8));
          for (const [o, det] of oscs) o.frequency.setValueAtTime(f * (1 + det), t);
          lp.frequency.setValueAtTime((500 + 1300 * accent) * lift(s, 0.8), t); lp.frequency.setTargetAtTime(140, t + 0.004, decay / 2.5);
          strike(env, t, 1.7 * bassAmt * accent, decay);
        }
      });
    }
    const accents = Array.from({ length: 8 }, () => rand() < 0.4);       // an irregular pattern for "accents"
    accents[0] = true;
    // an envelope on a gain: a fast rise to peak, then an exponential fall (setTarget is open-ended, so the next hit simply takes over)
    const strike = (g, t, peak, decay) => { g.gain.setTargetAtTime(peak, t, 0.0015); g.gain.setTargetAtTime(0, t + 0.012, decay / 3); };
    const bedVoices = pitched.length;                                      // what came before is the bed; hits and the arpeggio stay in the home key
    const voiceOsc = (type, to) => { const o = osc(type, 100); const g = gain(0, to); o.connect(g); return [o, g]; };
    const voiceNoise = (secs, filterType, fc, q, to) => {
      const n = ctx.createBufferSource(); n.buffer = knockNoise(ctx, secs); n.loop = true; keep(n);
      const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = fc; f.Q.value = q;
      const g = gain(0, to); n.connect(f); f.connect(g); g.__filter = f; return g;
    };
    if (hitType > 0 && hitAmt > 0.01) {
      const a = hitAmt;
      let fire;
      if (hitType === 1) {                                                // thud: a sub that drops onto the root
        const [o, g] = voiceOsc('sine', hitBus);
        fire = (t, s, k) => { o.frequency.setValueAtTime(f0 * 3.2 * lift(s, 1.2), t); o.frequency.setTargetAtTime(f0 * lift(s, 0.6), t, 0.035); strike(g, t, 1.1 * a, 0.32 * k); };
      } else if (hitType === 2) {                                         // knock: a short low tone and a dull click
        const [o, g] = voiceOsc('triangle', hitBus), click = voiceNoise(0.5, 'lowpass', 700, 0.7, hitBus);
        fire = (t, s, k) => { o.frequency.setValueAtTime(f0 * 5 * lift(s, 1.2), t); o.frequency.setTargetAtTime(f0 * 2.2 * lift(s, 1.2), t, 0.02); strike(g, t, 0.75 * a, 0.14 * k); strike(click, t, 0.5 * a, 0.04 * k); };
      } else if (hitType === 3) {                                         // metal: inharmonic partials ringing out
        const parts = [[1, 1, 0.42], [2.76, 0.6, 0.26], [5.4, 0.35, 0.16]].map(([r, g0, d]) => { const [o, g] = voiceOsc('sine', hitBus); o.frequency.value = f0 * 5 * r; return [o, g, 0.4 * g0, d, f0 * 5 * r]; });
        fire = (t, s, k) => { for (const [o, g, peak, d, f] of parts) { if (dynamics) o.frequency.setValueAtTime(f * lift(s, 1.2), t); strike(g, t, peak * a, d * k); } };
      } else {                                                            // noise burst: a dark, short snare
        const g = voiceNoise(1, 'bandpass', 420, 0.8, hitBus), f = g.__filter;
        fire = (t, s, k) => { f.frequency.setValueAtTime(420 * lift(s, 1.4), t); strike(g, t, 1.3 * a, 0.16 * k); };
      }
      perCut.push((i, t) => {
        const on = hitOn === 0 ? true : hitOn === 1 ? i % 2 === 0 : hitOn === 2 ? i % 4 === 0 : accents[i % 8];
        if (on) { const s = arc(starts[i]); fire(t, s, 1.5 - s); }
      });
    }

    // ---- Industrial: a burst of metal noise on every other cut ----
    if (industrial > 0.01) {
      const burst = voiceNoise(1, 'bandpass', 1100, 5, hitBus);
      perCut.push((i, t) => { if (i % 2 === 0) strike(burst, t, 1.8 * industrial, 0.09); });   // every other cut: a mechanical pulse, not a hiss
    }

    // ---- arpeggio: a short pattern of plucked notes that repeats, stepping with the cuts. One voice (two detuned saws), its pitch automated ----
    if (!style.own && arpAmt > 0.01 && arpMood.scale) {
      const notes = moodNotes(arpMood, f0 * 4 * style.arpUp, mode), m = arpMood;
      const phase = m.shape === 'phase';
      const loopA = phase ? Math.max(4, Math.min(8, arpSteps)) : arpSteps;
      const pattern = moodPattern(m.shape, notes.length, loopA, rand);   // indices into the notes
      const patternB = phase ? phaseLoop(pattern) : null;
      const N = notes.length;
      const noteOf = j => notes[Math.max(0, Math.min(N - 1, j))];
      const voices = Array.from({ length: m.voices }, (_, vi) => {          // fixed voices: no node per note
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = m.q * style.arpQ; lp.frequency.value = m.open * style.arpOpen;
        const env = gain(0);
        if (m.acid) lp.connect(shaper(satCurve(1.6), env)); else lp.connect(env);   // Acid: driven after the filter
        const pan = phase || m.euclid ? (vi ? [0.15, 1] : [1, 0.15]) : [1, 1];   // Phase: one loop leans left, the other right; Euclid: ping-pong
        const outs = [gain(0.6 * m.gain * style.arpGain * pan[0], arr.arp[0]), gain(0.6 * m.gain * style.arpGain * pan[1], arr.arp[1])];
        env.connect(outs[0]); env.connect(outs[1]);
        const oscs = [-MOOD_DETUNE, MOOD_DETUNE].map(det => { const o = osc('sawtooth', 200); o.connect(lp); return [o, det]; });
        return { lp, env, oscs, outs };
      });
      const L = pattern.length, mrand = mulberry32(seedN + 977);
      const accent = m.acid ? pattern.map(() => mrand() < 0.3) : null, slide = m.acid ? pattern.map(() => mrand() < 0.25) : null;   // fixed per step: a line, not noise
      const accPos = [];                                                  // Accumulate: 2 notes, then 3, ... then the whole pattern, over again
      if (m.accumulate) for (let k = Math.min(2, L); k <= L; k++) for (let j = 0; j < k; j++) accPos.push(j);
      let mutCycle = 0; const mutated = pattern.slice();                 // Mutate: the pattern as it stands this round; one note changes per round
      const mutateTo = cycle => { while (mutCycle < cycle) { mutated[Math.floor(mrand() * L)] = Math.floor(mrand() * notes.length); mutCycle++; } };
      const noteAt = st => noteOf(m.accumulate ? pattern[accPos[st % accPos.length]] : m.mutate ? (mutateTo(Math.floor(st / L)), mutated[st % L]) : pattern[st % L], st);
      const [ek, en] = EUCLID[Math.floor(mrand() * EUCLID.length)], gate = m.euclid ? euclid(ek, en) : null;
      const per = ARP_PER_CUT[arpRate];
      perCut.push((i, tc) => {
        for (const [step, at0, len] of noteTimes(starts, i, per)) {
          const t = tc + (at0 - starts[i]);
          const s = arc(at0);
          const stepLen = len / per;
          const decay = Math.min(1.6, Math.max(0.08, stepLen * 0.9 * m.sustain * style.arpSustain)) * (1.5 - s), f = noteAt(step) * lift(s, 1.2);
          const sw = m.sweep ? 0.15 + 0.85 * (0.5 - 0.5 * Math.cos((2 * Math.PI * at0) / m.sweep)) : 1;   // Sweep: how far the filter opens now
          const acc = accent ? (accent[step % L] ? 1.35 : 0.8) : 1, glide = slide && slide[step % L];
          const play = (v, fq, tt) => {
            for (const [o, det] of v.oscs) { if (glide) o.frequency.setTargetAtTime(fq * (1 + det), tt, 0.045); else o.frequency.setValueAtTime(fq * (1 + det), tt); }
            v.lp.frequency.setValueAtTime(Math.max(m.close * 1.2, m.open * style.arpOpen * sw * acc) * lift(s, 0.8), tt); v.lp.frequency.setTargetAtTime(m.close * lift(s, 1.2), tt + 0.003, decay / 3);
            strike(v.env, tt, 2.2 * arpAmt * (accent ? (acc > 1 ? 1.2 : 0.85) : 1), decay);
          };
          if (phase) { play(voices[0], f, t); play(voices[1], noteOf(patternB[step % patternB.length], step) * lift(s, 1.2), t); }   // both on every step, each round its own loop
          else if (gate) { const h = euclidHit(gate, ek, step); if (h >= 0) play(voices[h % 2], noteAt(h) * lift(s, 1.2), t); }   // a rest, or the next note, on the other side
          else play(voices[step % voices.length], f, t);
        }
      });
    } else if (!style.own && arpAmt > 0.01) {
      const degrees = [];                                                // the notes it may use: the chord's tones over two octaves, kept dark
      for (const r of chord.ratios) for (const oct of [0.5, 1]) { const f = f0 * r * oct; if (f > 100 && f < 700) degrees.push(f * style.arpUp); }
      degrees.sort((x, y) => x - y);
      const pattern = [];
      let cur = Math.floor(rand() * degrees.length);
      for (let k = 0; k < arpSteps; k++) { pattern.push(degrees[cur]); cur = Math.max(0, Math.min(degrees.length - 1, cur + [-2, -1, 1, 2, 3][Math.floor(rand() * 5)])); }
      const arpBus = [gain(1), gain(1)];
      arpBus.forEach((b, i) => b.connect(arr.arp[i]));
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2; lp.frequency.value = 1900;
      const env = gain(0);
      const voices = [-0.004, 0.004].map(det => { const o = osc('sawtooth', 200); o.connect(lp); return [o, det]; });
      lp.connect(env);
      env.connect(gain(0.6 * style.arpGain, arpBus[0])); env.connect(gain(0.6 * style.arpGain, arpBus[1]));
      const per = ARP_PER_CUT[arpRate];
      perCut.push((i, tc) => {
        for (const [step, at0, len] of noteTimes(starts, i, per)) {
          const t = tc + (at0 - starts[i]);
          const s = arc(at0);
          const stepLen = len / per, decay = Math.min(0.5, Math.max(0.05, stepLen * 0.9)) * (1.5 - s), f = pattern[step % arpSteps] * lift(s, 1.2);
          for (const [o, det] of voices) o.frequency.setValueAtTime(f * (1 + det), t);
          lp.frequency.setValueAtTime(1900 * lift(s, 0.8), t); lp.frequency.setTargetAtTime(420 * lift(s, 1.2), t + 0.003, decay / 3);
          strike(env, t, 2.2 * arpAmt, decay);
        }
      });
    }

    // ---- the pad: a warm analog chord (two detuned saws a note, chorus, a slow filter), voiced in the key on each chord of the changes ----
    if (padAmt > 0.01) {
      const T = f0 * 4, chordAt = i => padChord(degreeAt(i), mode);
      const first = chordAt(Math.min(cursor, Math.max(0, nCuts - 1)));
      const tone = Math.max(0, Math.min(PAD_TONES.length - 1, Math.round(+p.padTone || 0)));
      const lp = ctx.createBiquadFilter(); lp.type = tone === 2 ? 'bandpass' : 'lowpass'; lp.frequency.value = tone === 2 ? 650 : tone === 1 ? 1900 : 1100; lp.Q.value = tone === 2 ? 3.2 : 0.6;
      if (tone === 2) lfo(0.05, 300, lp.frequency); else lfo(0.06 * move, 320, lp.frequency);   // Hollow: the band drifts slowly up and down
      // Glass: each note on its own through a wavefolder (folding the whole chord at once made low difference tones: darker, not glassier),
      // from triangles, as a West Coast patch folds a soft wave into a bright one
      const into = n => (tone === 1 ? (() => { const g = gain(0.6); g.connect(shaper(foldCurve(3), lp)); return g; })() : lp);
      const body = gain(0.11 * padAmt * (tone === 2 ? 1.7 : tone === 1 ? 0.8 : 1) * (style.run ? 1.4 : 1)); lp.connect(body);   // under the drone, never over it (the user: no pad takeover)
      if (style.run && tone !== 2) {                                       // Run: the pad swells like brass on each chord (every 8 cuts without changes): the filter opens, then settles
        const base = lp.frequency.value, every = prog ? progEvery : 8;
        perCut.push((i, t) => { if (i % every) return; lp.frequency.setTargetAtTime(base * 2.2, t, 0.25); lp.frequency.setTargetAtTime(base * 0.8, t + 0.7, 1.1); });
      }
      sides.forEach((br, i) => {                                           // a chorus each side, a little apart: the Juno width
        const dl = ctx.createDelay(0.05); dl.delayTime.value = 0.012 + 0.004 * i;
        lfo(0.31 + 0.07 * i, 0.0028, dl.delayTime);
        body.connect(dl); dl.connect(gain(0.7, br)); body.connect(gain(0.5, br));
      });
      const voices = first.map(st => { const to = into(); return [-0.007, 0.007].map(det => { const o = osc(tone === 1 ? 'triangle' : 'sawtooth', T * Math.pow(2, st / 12) * (1 + det)); o.connect(to); return [o, det]; }); });
      perCut.push((i, t) => {
        if (!prog || i % progEvery) return;
        chordAt(i).forEach((st, n) => { for (const [o, det] of voices[n]) o.frequency.setTargetAtTime(T * Math.pow(2, st / 12) * (1 + det), t, 0.06); });
      });
    }

    // ---- Hypnotic: a rolling bass and a sequence on sixteenths that follow the cuts (see STYLES) ----
    // sixteenths on the music cuts for Hypnotic and Run: beats a music cut a power of two, so the film's usual cut (the median) makes a beat
    // near 128 BPM (90-180); then the beat follows the cuts. Too fast for every step: fewer (thin)
    const sixteenths = () => {
      const lens = starts.slice(1).map((v, i) => v - starts[i]), whole = lens.length > 2 ? lens.slice(0, -1) : lens;
      const med = whole.slice().sort((a, b) => a - b)[whole.length >> 1] || 0.47, per = 4 * Math.pow(2, Math.round(Math.log2(med / 0.469)));
      const stepAt = i => cutNoteLen(starts, Math.min(nCuts - 1, Math.floor(i / per + 1e-9))) / per;   // the sixteenth's length here
      return { per, stepAt, thin: (i, every) => { const sl = stepAt(i); return sl < every / 4 ? i % 4 === 0 : sl < every / 2 ? i % 2 === 0 : true; } };
    };
    if (style.grid) {
      const r = mulberry32(seedN + 5521), { per, thin } = sixteenths();
      // the bass plays all film long: it used to sit out an intro and a break (the user, 2026-10-30: parts that come and go "is weird")
      // each Random its own register, note lengths, echo and accents (the user: "a lot of repetition", 2026-10-31), its own stream so the
      // patterns above draw as before
      const v = mulberry32(seedN + 5557), seqUp = v() < 0.35 ? 0.5 : 1, bassDecay = 0.05 + 0.07 * v(), seqDecay = 0.07 + 0.12 * v(), echoFb = 0.25 + 0.22 * v();
      const accents = [k => (k % 4 === 2 ? 1 : 0.6), k => ([0, 3, 6].includes(k % 8) ? 1 : 0.55), k => ([2, 6, 10, 13].includes(k) ? 1 : 0.55)][Math.floor(v() * 3)];
      const sweep = (t, P, ph) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / P + ph);
      const ph1 = 2 * Math.PI * r(), ph2 = 2 * Math.PI * r(), P1 = 28 + 12 * r(), P2 = 36 + 20 * r();
      r(); const bassMask = Array.from({ length: 16 }, (_, k) => (k % 4 ? r() < 0.8 : false)), bassNote = Array.from({ length: 16 }, (_, k) => (k === 14 && r() < 0.5 ? 7 : k === 10 && r() < 0.3 ? 12 : 0));
      const seqL = [3, 5, 7][Math.floor(r() * 3)], seqMask = Array.from({ length: 16 }, () => r() < 0.75);
      const scale = []; for (const st of mode.scale) for (const o of [0, 12]) scale.push(st + o);
      const seqNotes = Array.from({ length: seqL }, () => scale[Math.floor(r() * 9)]);
      if (bassAmt > 0.01) {                                                // rolling: the off-sixteenths, the root, a fifth or octave now and then
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 5; lp.frequency.value = 250;
        const env = gain(0); lp.connect(env); for (const br of sides) env.connect(gain(0.5, br));
        const bo = [['sawtooth', -0.003, 1], ['square', 0.003, 0.4]].map(([w, det, g]) => { const o = osc(w, f0 * 2); o.connect(gain(g, lp)); return [o, det]; });
        const bt = gridTime(per);
        addGrid(per, (i, t) => {
          const k = i % 16, tt = bt(i); if (!bassMask[k] || !thin(i, 0.1)) return;
          const f = f0 * 2 * Math.pow(2, (bassNote[k] + degreeAt(Math.floor(i / per + 1e-9))) / 12);
          for (const [o, det] of bo) o.frequency.setValueAtTime(f * (1 + det), t);
          lp.frequency.setValueAtTime((260 + 900 * sweep(tt, P1, ph1)) * (0.75 + 0.35 * accents(k)), t); lp.frequency.setTargetAtTime(120, t + 0.004, 0.03);
          strike(env, t, 1.5 * bassAmt * (0.8 + 0.2 * accents(k)), bassDecay);
        });
      }
      if (arpAmt > 0.01) {                                                 // the sequence: 3, 5 or 7 notes against the bar, through an echo
        const T = f0 * 8 * seqUp, lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 5; lp.frequency.value = 800;   // an octave lower now and then
        const env = gain(0); lp.connect(env);
        const echoAt = c => Math.min(0.95, 3 * cutNoteLen(starts, c) / per);   // three sixteenths of the speed here, not of the usual one
        const dl = ctx.createDelay(1); dl.delayTime.value = echoAt(Math.min(nCuts - 1, cutAtTime(starts, offset))); const fb = gain(echoFb), dk = ctx.createBiquadFilter(); dk.type = 'lowpass'; dk.frequency.value = 2200;
        perCut.push((c, t) => dl.delayTime.setTargetAtTime(echoAt(c), t, ECHO_GLIDE));
        env.connect(dl); dl.connect(dk); dk.connect(fb); fb.connect(dl);
        sides.forEach((br, j) => { env.connect(gain(0.45, br)); dk.connect(gain(j ? 0.3 : 0.18, br)); });
        const so = [-0.004, 0.004].map(det => { const o = osc('sawtooth', T); o.connect(lp); return [o, det]; });
        const st2 = gridTime(per);
        addGrid(per, (i, t) => {
          if (!seqMask[i % 16] || !thin(i, 0.1)) return;
          const tt = st2(i), f = T * Math.pow(2, seqNotes[i % seqL] / 12);
          for (const [o, det] of so) o.frequency.setValueAtTime(f * (1 + det), t);
          lp.frequency.setValueAtTime(450 + 2000 * sweep(tt, P2, ph2), t); lp.frequency.setTargetAtTime(300, t + 0.003, 0.04);
          strike(env, t, 1.1 * arpAmt * (seqUp < 1 ? 1.25 : 1), seqDecay);
        });
      }
    }

    // ---- Run: the running bass, every sixteenth (see STYLES) ----
    if (style.run && bassAmt > 0.01) {
      const r = mulberry32(seedN + 6113), { per, stepAt, thin } = sixteenths(), rA = mulberry32(seedN + 6127)();
      // the Bassline pattern picks the run's family; the seed one of its three runs and where the accents fall (the user: "Run needs more
      // variety, it's pretty good but it feels a bit repetitive", 2026-10-30): the same loop all film long, only its notes and accents
      // differ from one Random to the next (never parts that come and go: "different parts in the loop is weird"). Root, fifth and
      // octave only, so it stays in key over every chord
      const RUNS = [
        [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, 7, 12, 12]],   // Pulse: steady
        [[0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 0, 12, 7, 12], [0, 12, 12, 0, 12, 12, 0, 12, 0, 12, 12, 0, 12, 12, 0, 12], [0, 0, 12, 0, 0, 12, 0, 12, 0, 0, 12, 0, 0, 12, 7, 12]],   // Octave: jumping
        [[0, 0, 7, 0, 12, 0, 7, 0, 0, 0, 7, 0, 12, 7, 5, 7], [0, 7, 12, 7, 0, 7, 12, 7, 0, 7, 12, 7, 12, 7, 5, 7], [12, 7, 5, 0, 12, 7, 5, 0, 12, 7, 5, 0, 12, 12, 7, 7]],   // Fifths: walking
        [[0, null, 0, 0, 12, null, 0, 0, 0, null, 0, 0, 7, null, 12, 0], [0, null, 0, 0, 0, null, 0, 0, 12, null, 12, 12, 7, null, 7, 7], [0, 0, null, 0, 0, null, 0, 0, 12, 0, null, 0, 7, null, 12, 0]],   // Gallop
      ];
      const fam = RUNS[Math.max(0, Math.min(RUNS.length - 1, Math.round(+p.bassPattern || 0)))], run = fam[Math.floor(r() * fam.length)];
      const ACCENTS = [k => (k % 4 === 0 ? 1 : k % 2 === 0 ? 0.55 : 0.35),                   // on the beat
        k => ([0, 3, 6].includes(k % 8) ? 1 : 0.4),                                          // 3-3-2: the off-kilter push of a sequencer run
        k => ([0, 3, 6, 9, 12].includes(k) ? 1 : 0.4)];                                      // 3-3-3-3-4 across the bar
      const acc = run.map((_, k) => ACCENTS[Math.floor(rA * ACCENTS.length)](k));
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6; lp.frequency.value = 300;
      const env = gain(0); lp.connect(env); for (const br of sides) env.connect(gain(0.5, br));
      const ro = [['sawtooth', -0.004, 1, 2], ['sawtooth', 0.004, 0.7, 2], ['square', 0, 0.45, 1]].map(([w, det, g, m]) => { const o = osc(w, f0 * m); o.connect(gain(g, lp)); return [o, det, m]; });
      const ph = 2 * Math.PI * r(), P = 26 + 14 * r(), drift = t => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / P + ph);
      const bt = gridTime(per);
      addGrid(per, (i, t) => {
        const k = i % 16, note = run[k]; if (note === null || !thin(i, 0.09)) return;
        const tt = bt(i), sl = stepAt(i), f = f0 * Math.pow(2, (note + degreeAt(Math.floor(i / per + 1e-9))) / 12);
        for (const [o, det, m] of ro) o.frequency.setTargetAtTime(f * m * (1 + det), t, 0.006);   // a short glide: the notes run into each other
        lp.frequency.setValueAtTime((280 + (500 + 1100 * drift(tt)) * acc[k]) * (0.8 + 0.5 * bright), t); lp.frequency.setTargetAtTime(160, t + 0.004, Math.max(0.03, sl * 0.6));
        strike(env, t, 2 * bassAmt * (0.7 + 0.3 * acc[k]), Math.max(0.06, Math.min(0.3, sl * 2)));   // up front and nearly legato: it runs (10% of the sound at first, ~20% now)
      });
    }

    // stereo width: mid/side
    const w = 0.25 + 0.9 * width;
    const merger = ctx.createChannelMerger(2);
    const cross = (a, b, ch) => { const g1 = gain((1 + w) / 2); const g2 = gain((1 - w) / 2); mix[a].connect(g1); mix[b].connect(g2); g1.connect(merger, 0, ch); g2.connect(merger, 0, ch); };
    cross(0, 1, 0); cross(1, 0, 1);
    const dyn = ctx.createGain();                                           // the volume is never touched by Dynamics: it shapes the notes (see arc)
    merger.connect(dyn);
    let out = dyn;
    if (tape > 0.01) {                                                      // tape: wow and flutter, saturation, a darker top, a little dust
      const t = Math.pow(tape, 1.6);                                        // a gentle start: 30 is a touch of it, 100 the full warmth
      const wow = ctx.createDelay(0.1); wow.delayTime.value = 0.012;
      lfo(0.55, 0.0018 * t, wow.delayTime); lfo(6.5, 0.00022 * t, wow.delayTime);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 14000 - 9500 * t; lp.Q.value = 0.5;
      const satOut = gain(4, lp), sat = gain(0.25, shaper(wideSatCurve(Math.round((0.05 + 1.55 * t) * 100) / 100), satOut));   // warmth, not drive, from straight up;
      dyn.connect(wow); wow.connect(sat);                                   // in at 1/4, out at 4: the drone peaks past 1 before it is levelled, and a curve over -1..1 clipped them
      const dust = ctx.createBufferSource(); dust.buffer = dustBuffer(ctx); dust.loop = true; keep(dust);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500; dust.connect(hp); hp.connect(gain(0.025 * t, lp));
      out = lp;
    }
    if (opts.tap === 'sub') subBus.connect(dest); else if (opts.tap === 'dry') { mix[0].connect(dest); } else out.connect(dest);

    // arrangement: the levels of the arpeggio, the bassline and the hits over the film
    if (arrange) {
      const ramp = (u, a, b) => Math.min(1, Math.max(0, (u - a) / (b - a)));
      const set = (layer, fn) => { for (const g of [].concat(arr[layer])) sampled(g.gain, fn); };
      if (arrange === 2) {                                                   // sections: switched on the music's cuts, a quick fade
        const lv = i => SECTIONS[Math.floor(i / SECTION_CUTS) % SECTIONS.length];
        const first = lv(Math.min(cursor, Math.max(0, nCuts - 1)));
        for (const layer of ['arp', 'bass', 'hits']) for (const g of [].concat(arr[layer])) g.gain.setValueAtTime(first[layer], at(offset));
        perCut.push((i, t) => { if (i % SECTION_CUTS === 0) for (const layer of ['arp', 'bass', 'hits']) for (const g of [].concat(arr[layer])) g.gain.setTargetAtTime(lv(i)[layer], t, 0.012); });
      } else {
        const lens = starts.slice(1).map((v, i) => v - starts[i]), whole = lens.length > 2 ? lens.slice(0, -1) : lens;
        const lo = Math.min(...whole), hi = Math.max(...whole), varies = hi > lo * 1.05;
        const speed = t => Math.min(1, Math.max(0, Math.log(hi / lens[Math.min(lens.length - 1, cutAtTime(starts, t))]) / Math.log(hi / lo)));
        if (arrange === 3 && varies) {                                       // follows the speed: fast = full
          set('arp', t => ramp(speed(t), 0.05, 0.25)); set('bass', t => ramp(speed(t), 0.35, 0.55)); set('hits', t => ramp(speed(t), 0.65, 0.85));
        } else {                                                             // build-up: in one by one, out for the ending
          set('arp', t => ramp(t / total, 0.1, 0.18));
          set('bass', t => ramp(t / total, 0.28, 0.34) * (1 - ramp(t / total, 0.88, 0.94)));
          set('hits', t => ramp(t / total, 0.45, 0.5) * (1 - ramp(t / total, 0.8, 0.86)));
        }
      }
    }
    // chord changes: one control signal (cents) into the bed's oscillators' detune, so it adds to whatever else moves the pitch;
    // a short glide at each change, as a modular's portamento
    if (prog) {
      const cents = i => 100 * degreeAt(i);
      const tr = keep(ctx.createConstantSource()); tr.offset.value = cents(Math.min(cursor, Math.max(0, nCuts - 1)));
      for (const o of pitched.slice(0, bedVoices)) { tr.connect(o.detune); links.push([tr, o.detune]); }
      perCut.push((i, t) => { if (i % progEvery === 0) tr.offset.setTargetAtTime(cents(i), t, 0.025); });
    }
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
  const levelKey = (p, starts) => JSON.stringify([cutSignature(starts || []), p.choir, p.industrial, p.pulse, p.low, p.bright, p.width, p.space, p.room, p.power, p.seed, p.paired, p.pitch, p.chord, p.echo, p.movement, p.wash, p.ring, p.shimmer, p.subWave, p.padWave, p.hitType, p.hit, p.hitOn, p.arp, p.arpSteps, p.arpRate, p.arpMood, p.style, p.prog, p.progEvery, p.mode, p.bass, p.bassPattern, p.bassRate, p.arrange, p.pad, p.padTone, p.tape]);
  async function level(p, starts) {
    starts = cleanStarts(starts);
    const key = levelKey(p, starts);
    if (levelCache.has(key)) return levelCache.get(key);
    const rate = 22050, secs = Math.min(3, starts[starts.length - 1]);
    const trimmed = starts.filter(s => s < secs); trimmed.push(secs);
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.floor(secs * rate)), rate);
    build(ctx, ctx.destination, p, trimmed, { offset: 0, t0: 0, total: starts[starts.length - 1], landing: false, dynamics: false, arc: false, quickRoom: true });   // the level of the full sound (Hypnotic's bass is out in its intro)
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
    constructor() { this.ctx = null; this.inst = null; this.params = null; this.starts = null; this.t0 = 0; this.total = 0; this.timer = null; this.playing = false; this.holding = 0; this.cal = 1; this.pending = null; this.swapAt = 0; this.calTimer = null; this.ticker = null; this.rooms = new Map(); this.buildMs = 20; this.master = null;
      this.renewOnReturn = false;   // a fresh sound on coming back to the window: off (it did not mend the lost output, which the app now prevents: background throttling off; it only added a gap)
    }
    get playingNow() { return this.playing; }
    // where the sound is in the clip. Just after a start, a restart or a seek the new sound has not begun yet (it starts a build's time
    // ahead): that moment is the start position, not a negative one that would wrap to the end of the clip (the last frame flashed)
    pos() {
      if (!this.playing || this.holding || !this.ctx) return 0;
      const p = Math.max(this.ctx.currentTime - this.t0, this.startOffset || 0);
      return ((p % this.total) + this.total) % this.total;
    }
    _context() {
      if (!this.ctx) {
        const C = window.AudioContext || window.webkitAudioContext; this.ctx = new C({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);   // every live sound goes out through here
        // WebKit (Safari, the Mac app) can stop a page's sound by itself ('interrupted' or 'suspended': another app's sound, an output
        // change, sleep) and never starts it again: the sound went silent while the picture played on. Asked back at once, and at
        // the next click or key (WebKit may want one), then put back where the picture is (onRevived)
        const born = this.ctx;
        this.ctx.onstatechange = () => { soundLog(`context ${born.state}`, this.playing ? 'while playing' : ''); if (this.ctx && this.playing && this.ctx.state !== 'running' && this.ctx.state !== 'closed') this._revive(); };
        if (typeof document !== 'undefined' && !this.listening) {
          this.listening = true;
          const again = () => { if (this.playing && this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') this._revive(); };
          document.addEventListener('pointerdown', again, true);
          document.addEventListener('keydown', again, true);
          // In the Mac app the sound could go silent once the window had been in the background (another app in front) while the
          // context still said 'running', so nothing above saw it. Back in front while playing: a new context, from where the picture is.
          const away = () => { if (this.playing) { this.wasAway = true; soundLog('window behind another'); } };
          const back = () => { if (this.wasAway && this.playing && this.renewOnReturn && (document.visibilityState !== 'hidden')) { this.wasAway = false; this.renew(); } };
          window.addEventListener('blur', away);
          document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? away() : back()));
          window.addEventListener('focus', back);
        }
      }
      return this.ctx;
    }
    // a fresh context and sound (the old one closed): the page plays it again from where the picture is (onRenew)
    renew() {
      soundLog('back in front: a fresh sound');
      this.fresh();
      if (this.onRenew) this.onRenew();
    }
    // stopped, its context closed: the next play makes a new one (also Sound › Source Off then on: the reset when the sound is lost)
    fresh() {
      const old = this.ctx;
      this.stop();
      this.ctx = null; this.master = null; this.inst = null; this.rooms = new Map();   // the rooms belong to the old context
      if (old && old.close) old.close().catch(() => {});
    }
    async _revive() {
      if (this.reviving || !this.ctx) return;
      this.reviving = true;
      soundLog('asking the sound back');
      try { await this.ctx.resume(); } catch (e) { soundLog('refused', e && e.message); }
      this.reviving = false;
      if (this.ctx.state === 'running' && this.playing && this.onRevived) this.onRevived();
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
      level.connect(pre); pre.connect(glue); glue.connect(out); out.connect(this.master);
      const room = (i, seedN, seconds, kind) => {                           // one room per setting, kept between swaps: its tail carries on through them
        const key = `${kind.name}|${i}|${seconds}`, put = conv => { this.rooms.set(key, conv); if (this.rooms.size > 12) this.rooms.delete(this.rooms.keys().next().value); return conv; };
        if (this.rooms.has(key)) return this.rooms.get(key);
        const dist = k => (k.startsWith(`${kind.name}|`) ? 0 : 100) + Math.abs(+k.split('|')[2] - seconds);   // the same kind first, else any room this side has
        const near = [...this.rooms.keys()].filter(k => k.split('|')[1] === String(i)).sort((a, b) => dist(a) - dist(b))[0];
        const later = near && roomInWorker(ctx.sampleRate, ROOM_SEED + 7919 * (i + 1), seconds, kind);
        if (!later) return put(makeRoom(ctx, seedN, i, seconds, kind));      // the first of its kind (or no worker): made now
        later.then(d => {                                                   // ready: the next swap (the slider's next move, or the next change) takes it
          if (this.ctx !== ctx || this.rooms.has(key)) return;
          const conv = ctx.createConvolver(); conv.normalize = false;
          const b = ctx.createBuffer(1, d.length, ctx.sampleRate); b.copyToChannel(d, 0); conv.buffer = b;
          put(conv);
          const p = this.params || {}, k = roomKind(p), sp = clamp01(p.space);           // still the room the settings ask for: swap it in
          if (this.playing && k.name === kind.name && roomLength(k, sp) === seconds) this.update(this.params, this.starts, () => this.pos());
        });
        return this.rooms.get(near);                                        // meanwhile the nearest room this sound already has
      };
      const t = performance.now();
      const graph = build(ctx, level, this.params, this.starts, { offset, t0: startAt - offset, startAt, live: true, room });
      this.buildMs = Math.max(this.buildMs * 0.7, performance.now() - t);   // how long a build takes here, for the next lead
      graph.fade(1, startAt, 0.04);
      this.t0 = startAt - offset;
      this.startOffset = ctx.currentTime < startAt ? offset : 0;           // until it begins, the sound is at its start offset
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
      soundLog(`play from ${(+offset).toFixed(1)} s`, `context ${ctx.state}`);
      const t0 = performance.now();
      this.cal = await level(params, starts);
      soundLog(`level measured in ${Math.round(performance.now() - t0)} ms`);
      this.playing = true;
      this._watch();
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
    // Make the costly parts before the first Play (call it when the page is idle): the audio context (it starts suspended until a
    // click), the noise and the reverb room for these settings. The first Play otherwise froze the page for 150-230 ms.
    warm(params) {
      const ctx = this._context();
      const p = params || {};
      const seedN = (Number.isFinite(+p.seed) ? +p.seed : 7) >>> 0;
      const space = Math.min(1, Math.max(0, Number.isFinite(+p.space) ? +p.space : 0.5));
      const kind = roomKind(p), seconds = roomLength(kind, space);
      for (const i of [0, 1]) {
        const key = `${kind.name}|${i}|${seconds}`;
        if (!this.rooms.has(key)) this.rooms.set(key, makeRoom(ctx, seedN, i, seconds, kind));
      }
      for (const [name, sec] of [['rumble', 4], ['air', 4]]) noiseLoop(ctx, seedN, name, sec, name === 'rumble' ? (x, r) => onePole(x, 110, r, 2) : (x, r) => { onePole(x, 1400, r, 2); const lp = x.slice(); onePole(lp, 250, r, 2); for (let i = 0; i < x.length; i++) x[i] -= lp[i]; });
    }
    // jump to a position in the clip (seconds), keeping the settings: the film strip and the rhythm strip use it
    seek(offset) {
      if (!this.playing) return;
      this.pending = null; this.holding = 0;
      this._swap(offset);
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
    // WebKit can lose the page's sound output while every context still says 'running' (seen in the Mac app: a clack, then silence,
    // new contexts silent too, only a reload helped). What shows it: the sound's clock stops moving. Checked every second while
    // the page is in front; two stopped seconds in a row tell the page (onStall), which makes a fresh sound, then reloads if needed
    _watch() {
      clearInterval(this.watchdog);
      let lastT = this.ctx.currentTime, lastW = performance.now(), stalls = 0, n = 0;
      this.watchdog = setInterval(() => {
        if (!this.playing || !this.ctx) { clearInterval(this.watchdog); return; }
        const t = this.ctx.currentTime, w = performance.now(), dt = t - lastT, dw = (w - lastW) / 1000;
        lastT = t; lastW = w;
        const front = typeof document === 'undefined' || document.visibilityState !== 'hidden';
        if (dw > 0.5 && dt < 0.1 * dw) {
          stalls++;
          soundLog(`the sound's clock stopped: ${dt.toFixed(2)} s in ${dw.toFixed(1)} s`, front ? '' : '(window hidden)');
          if (stalls >= 2 && front && this.onStall) { clearInterval(this.watchdog); this.onStall(); }
        } else {
          stalls = 0;
          if (++n % 15 === 0) soundLog(`clock fine: ${dt.toFixed(2)} s in ${dw.toFixed(1)} s`);
        }
      }, 1000);
    }
    stop() {
      clearInterval(this.watchdog);
      this.playing = false;
      this.pending = null; this.holding = 0;
      clearTimeout(this.timer); clearTimeout(this.calTimer); clearInterval(this.ticker);
      if (this.inst) { this._retire(this.inst); this.inst = null; }
    }
  }

  window.Drone = { build, level, renderExport, toWav, Live, TARGET_RMS, CHORDS, ARP_MOODS, padChord, inMode, MODES, notesIn, noteTimes, PROGRESSIONS, PROG_EVERY, BASS_PATTERNS, ARRANGEMENTS, phaseLoop, rootHz, EUCLID, euclid, euclidHit, ROOMS, roomData, PAD_TONES, STYLES };
})();
