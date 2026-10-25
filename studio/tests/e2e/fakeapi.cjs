// A stand-in for studio/server.py: same JSON shapes, in-memory state, adjustable delays. Used by the browser tests.
const http = require('http');

function makeState() {
  const plate = (filename, trashed, i) => ({
    filename, url: `/assets/ai-plates/${filename}.svg`, title: `Plate ${filename}`, prompt: `prompt ${filename}`, model: 'google/nano-banana-2.1',
    trashed, trashed_at: trashed ? 1000 + i : null, trash_reason: null, critic: null, world: 'Editorial Print', idea: 'an idea',
    qa_passed: true, qa_score: 90, qa_issues: [],
  });
  const plates = [plate('k1', false, 0), plate('k2', false, 1), plate('k3', false, 2), plate('t1', true, 1), plate('t2', true, 2), plate('t3', true, 3), plate('t4', true, 4)];
  return {
    plates,
    sequences: [{ id: 's1', name: 'Manual', kind: 'manual', order: plates.map(p => p.filename), summary: null }],
    active: 's1',
    delays: { purge: 0, generate: 0, invent: 0, export: 0, ai: 600 },
    boot: 'fake',
    failGen: null,
    genAttempts: 0,
    jobs: [],
    aiFail: null,
    calls: [],
    genCount: 0,
  };
}

// the same rules as studio/sequences.py: one Manual order, at most one AI order (redo replaces it), both editable in place
const seqOf = (st, id) => st.sequences.find(s => s.id === id);
const activeSeq = st => seqOf(st, st.active);
let seqCounter = 100;
function addAi(st, order, { summary = null, cut_off = null } = {}) {
  st.sequences = st.sequences.filter(q => q.kind !== 'ai');
  const seq = { id: `s${++seqCounter}`, name: 'AI', kind: 'ai', order: [...new Set(order)], original: [...new Set(order)], summary, cut_off };
  st.sequences.push(seq); st.active = seq.id; return seq;
}
function orderedPlates(st) {
  const order = activeSeq(st).order, by = Object.fromEntries(st.plates.map(p => [p.filename, p]));
  const names = [...order.filter(n => by[n]), ...st.plates.map(p => p.filename).filter(n => !order.includes(n))];
  return names.map(n => by[n]);
}

const COLORS = ['#c44', '#4a6', '#46c', '#ca4', '#a4c', '#4cc', '#888'];
const svg = name => {
  const c = COLORS[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="270" height="480" viewBox="0 0 270 480"><rect width="270" height="480" fill="${c}"/><circle cx="135" cy="240" r="24" fill="none" stroke="#fff" stroke-width="5"/><text x="135" y="320" fill="#fff" font-size="22" text-anchor="middle">${name}</text></svg>`;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function start(state = makeState()) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { body = {}; }
    }
    const send = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname.startsWith('/api/')) state.calls.push({ path: url.pathname, body });
    const LOCKED = ['/api/trash', '/api/reorder', '/api/purge', '/api/sequence', '/api/generate-image', '/api/invent-prompts', '/api/export-video'];
    if (LOCKED.includes(url.pathname) && state.jobs.some(j => !j.done)) return send({ ok: false, busy: true, error: 'The AI is ordering your selection. Wait until it finishes.' }, 409);

    if (url.pathname.startsWith('/assets/ai-plates/')) {
      const name = decodeURIComponent(url.pathname.split('/').pop()).replace(/\.svg$/, '');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg(name));
    }
    switch (url.pathname) {
      case '/api/state': {
        const visible = new Set(state.plates.filter(p => !p.trashed).map(p => p.filename));
        return send({ plates: orderedPlates(state), sequences: state.sequences.map(q => ({ id: q.id, name: q.name, kind: q.kind, count: q.order.filter(n => visible.has(n)).length, summary: q.summary, cut_off: q.cut_off || null, edited: q.kind === 'ai' && JSON.stringify(q.order) !== JSON.stringify(q.original) })), active_sequence: state.active, krea_connected: true, kimi_configured: true, kimi_key_masked: 'sk-abc••••xyz', kimi_model: 'kimi-k3', critic_enabled: false, critic_autotrash: false });
      }
      case '/api/worlds':
        return send({ ok: true, worlds: [{ name: 'Editorial Print', brief: 'Swiss grid.', n: 7, kept: 3, wildcard: false }, { name: 'Matter & Elements', brief: 'Fluids and fire.', n: 10, kept: 2, wildcard: false }] });
      case '/api/version': return send({ boot: state.boot || 'fake', html: 0 });
      case '/api/stats': return send({ ok: true, models: {} });
      case '/api/save-settings': case '/api/krea-auth': return send({ ok: true });
      case '/api/reorder': {
        const seq = activeSeq(state);
        let order = [...new Set(body.order || [])];
        seq.order = order.concat(seq.order.filter(n => !order.includes(n)));
        return send({ ok: true });
      }
      case '/api/sequence': {
        if (body.action === 'activate' && seqOf(state, body.id)) { state.active = body.id; return send({ ok: true }); }
        if (body.action === 'reset') { const ai = state.sequences.find(q => q.kind === 'ai'); if (ai) { ai.order = [...ai.original]; return send({ ok: true }); } }
        if (body.action === 'make_manual') { const ai = state.sequences.find(q => q.kind === 'ai'); const m = state.sequences.find(q => q.kind === 'manual'); if (ai && m) { m.order = [...ai.order]; m.cut_off = ai.cut_off; state.active = m.id; return send({ ok: true }); } }
        if (body.action === 'include_all') { const a = activeSeq(state); if (a && a.cut_off) { a.cut_off = null; return send({ ok: true }); } }
        return send({ ok: false, error: 'Could not do that.' }, 400);
      }
      case '/api/trash': {
        const p = state.plates.find(x => x.filename === body.filename);
        if (p) { p.trashed = !!body.trashed; p.trashed_at = body.trashed ? Date.now() : null; }
        if (p && !body.trashed) for (const q of state.sequences) q.order = q.order.filter(n => n !== p.filename).concat(p.filename);   // restored: end of every order
        return send({ ok: true });
      }
      case '/api/order-ai': {
        const shown = orderedPlates(state).filter(p => !p.trashed).map(p => p.filename);
        if (shown.length < 2) return send({ ok: false, error: 'Need at least two images' }, 400);
        const id = `job${state.jobs.length + 1}`;
        const job = { done: false, step: 0, steps: 4, stage: 'Reading the images', note: `${shown.length} images`, body };
        state.jobs.push(job);
        const names = ['Reading the images', 'Writing the edit brief', 'Cutting the edit', 'Reviewing the cuts'];
        (async () => {
          for (let i = 0; i < 4; i++) { job.step = i; job.stage = names[i]; await sleep(state.delays.ai / 4); }
          if (state.aiFail) { job.done = true; job.error = state.aiFail; return; }
          let order = shown.slice().reverse();
          const rest = state.plates.map(p => p.filename).filter(n => !order.includes(n));
          const n = body.length && body.length < order.length ? body.length : null;
          const seq = addAi(state, [...order, ...rest], { summary: `Opens on ${order[0]}, lands on ${order[order.length - 1]}.`, cut_off: n });
          job.done = true; job.step = 4; job.stage = 'Done'; job.sequence = { id: seq.id, name: seq.name, summary: seq.summary };
        })();
        return send({ ok: true, job: id, steps: names });
      }
      case '/api/order-ai-status': {
        const job = state.jobs[Number((url.searchParams.get('job') || '').replace('job', '')) - 1];
        return job ? send({ ok: true, ...job, body: undefined }) : send({ ok: false, error: 'unknown job' });
      }
      case '/api/purge': {
        await sleep(state.delays.purge);
        const gone = new Set(body.all ? state.plates.filter(p => p.trashed).map(p => p.filename) : (body.filenames || []).filter(f => (state.plates.find(p => p.filename === f) || {}).trashed));
        state.plates = state.plates.filter(p => !gone.has(p.filename));
        for (const q of state.sequences) q.order = q.order.filter(n => !gone.has(n));
        return send({ ok: true, deleted: gone.size, freed_mb: gone.size * 1.5 });
      }
      case '/api/invent-prompts': {
        await sleep(state.delays.invent);
        const n = body.count || 4;
        return send({ ok: true, ideas: Array.from({ length: n }, (_, i) => ({ title: `Fog ${i + 1}`, prompt: `fog scene ${i}`, guide: i % 2 ? 'light' : 'dark', world: body.world && !body.world.startsWith('__') ? body.world : 'Fog & Vapor', idea: 'idea', subject: `fog ${i}` })) });
      }
      case '/api/generate-image': {
        await sleep(state.delays.generate);
        state.genAttempts = (state.genAttempts || 0) + 1;
        if (state.failGen && state.failGen(state.genAttempts, body)) return send({ ok: false, error: `Krea 429: too many requests (${body.title})` }, 500);
        const name = `g${++state.genCount}`;
        for (const q of state.sequences) q.order.push(name);
        state.plates.push({ filename: name, url: `/assets/ai-plates/${name}.svg`, title: body.title, prompt: body.prompt, model: body.model, trashed: false, qa_passed: true, qa_score: 90, qa_issues: [], world: body.world });
        return send({ ok: true, qa_passed: true, trashed: false, filename: name, title: body.title });
      }
      case '/api/export-video': {
        await sleep(state.delays.export);
        const n = state.plates.filter(p => !p.trashed).length;
        return send({ ok: true, video_url: '/outputs/Demo-test.mp4', filename: 'Demo-test.mp4', images: n, seconds: n * 0.5, cuts: n });
      }
      case '/api/track': {
        if (req.method === 'POST' && url.searchParams.get('name')) state.track = { name: url.searchParams.get('name'), duration: 30, bpm: 126, n_beats: 60, n_hits: 210 };
        else if (req.method === 'POST' && body.clear) state.track = null;
        return send({ ok: true, track: state.track || null });
      }
      case '/api/track-cuts': {    // an uneven rhythm: 0.2 s, 0.3 s, 0.1 s, 0.4 s ...
        const n = state.plates.filter(p => !p.trashed).length * (['mono', 'colour'].includes(body.invert_mode) ? 2 : 1);
        const gaps = [0.2, 0.3, 0.1, 0.4];
        const starts = [0];
        for (let i = 0; i < n; i++) starts.push(+(starts[i] + gaps[i % 4]).toFixed(3));
        return send({ ok: true, starts, audio_start: 0.5, total: starts[n], events: 60, bpm: 126 });
      }
      case '/api/music': {   // a valid 2 s silent WAV (8 kHz, mono, 16-bit)
        const n = 16000, buf = Buffer.alloc(44 + n * 2);
        buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
        buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length }); return res.end(buf);
      }
      default:
        res.writeHead(404); return res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })));
}

module.exports = { start, makeState, addAi, orderedPlates };
