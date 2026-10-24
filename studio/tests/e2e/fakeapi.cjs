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
    sequences: [{ id: 's1', name: 'Manual 1', kind: 'manual', order: plates.map(p => p.filename), summary: null }],
    active: 's1',
    counter: { manual: 1, ai: 0 },
    delays: { purge: 0, generate: 0, invent: 0, export: 0 },
    calls: [],
    genCount: 0,
  };
}

// the same rules as studio/sequences.py, in a few lines
const seqOf = (st, id) => st.sequences.find(s => s.id === id);
const activeSeq = st => seqOf(st, st.active);
function addSeq(st, kind, order, { name, summary = null, parent = null } = {}) {
  st.counter[kind] = (st.counter[kind] || 0) + (name ? 0 : 1);
  const seq = { id: `s${st.sequences.length + 1 + Math.floor(Math.random() * 1e6)}`, name: name || `${kind === 'ai' ? 'AI' : 'Manual'} ${st.counter[kind]}`, kind, order: [...new Set(order)], summary, parent };
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

    if (url.pathname.startsWith('/assets/ai-plates/')) {
      const name = decodeURIComponent(url.pathname.split('/').pop()).replace(/\.svg$/, '');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg(name));
    }
    switch (url.pathname) {
      case '/api/state': {
        const visible = new Set(state.plates.filter(p => !p.trashed).map(p => p.filename));
        return send({ plates: orderedPlates(state), sequences: state.sequences.map(q => ({ id: q.id, name: q.name, kind: q.kind, count: q.order.filter(n => visible.has(n)).length, summary: q.summary, parent: q.parent })), active_sequence: state.active, krea_connected: true, kimi_configured: true, kimi_key_masked: 'sk-abc••••xyz', kimi_model: 'kimi-k3', critic_enabled: false, critic_autotrash: false });
      }
      case '/api/worlds':
        return send({ ok: true, worlds: [{ name: 'Editorial Print', brief: 'Swiss grid.', n: 7, kept: 3, wildcard: false }, { name: 'Matter & Elements', brief: 'Fluids and fire.', n: 10, kept: 2, wildcard: false }] });
      case '/api/version': return send({ boot: 'fake', html: 0 });
      case '/api/stats': return send({ ok: true, models: {} });
      case '/api/save-settings': case '/api/krea-auth': return send({ ok: true });
      case '/api/reorder': {
        const seq = activeSeq(state);
        let order = [...new Set(body.order || [])];
        order = order.concat(seq.order.filter(n => !order.includes(n)));
        if (seq.kind === 'ai') {
          state.counter.manual += 1;
          const f = addSeq(state, 'manual', order, { name: `Manual ${state.counter.manual} (from ${seq.name})`, parent: seq.id });
          return send({ ok: true, forked: { id: f.id, name: f.name } });
        }
        seq.order = order;
        return send({ ok: true, forked: null });
      }
      case '/api/sequence': {
        const seq = seqOf(state, body.id);
        if (!seq) return send({ ok: false, error: 'unknown order' }, 400);
        if (body.action === 'activate') state.active = seq.id;
        else if (body.action === 'rename' && (body.name || '').trim()) seq.name = body.name.trim();
        else if (body.action === 'duplicate') { addSeq(state, 'manual', seq.order, { name: `${seq.name} copy`, parent: seq.id }); }
        else if (body.action === 'delete') {
          if (state.sequences.length <= 1) return send({ ok: false, error: 'Could not do that (the last order cannot be deleted).' }, 400);
          state.sequences = state.sequences.filter(q => q.id !== seq.id);
          if (state.active === seq.id) state.active = state.sequences[0].id;
        } else return send({ ok: false, error: 'bad action' }, 400);
        return send({ ok: true });
      }
      case '/api/trash': {
        const p = state.plates.find(x => x.filename === body.filename);
        if (p) { p.trashed = !!body.trashed; p.trashed_at = body.trashed ? Date.now() : null; }
        if (p && !body.trashed) for (const q of state.sequences) q.order = q.order.filter(n => n !== p.filename).concat(p.filename);   // restored: end of every order
        return send({ ok: true });
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
      default:
        res.writeHead(404); return res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })));
}

module.exports = { start, makeState, addSeq, orderedPlates };
