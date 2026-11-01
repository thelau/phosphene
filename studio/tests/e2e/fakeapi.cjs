// A stand-in for studio/server.py: same JSON shapes, in-memory state, adjustable delays. Used by the browser tests.
const http = require('http');

function makeState() {
  const plate = (filename, trashed, i) => ({
    filename, url: `/assets/ai-plates/${filename}.svg`, title: `Plate ${filename}`, prompt: `prompt ${filename}`, model: 'google/nano-banana-2.1',
    trashed, trashed_at: trashed ? 1000 + i : null, trash_reason: null, world: 'Editorial Print', idea: 'an idea',
    qa_passed: true, qa_score: 90, qa_issues: [],
  });
  const plates = [plate('k1', false, 0), plate('k2', false, 1), plate('k3', false, 2), plate('t1', true, 1), plate('t2', true, 2), plate('t3', true, 3), plate('t4', true, 4)];
  const looks = { k1: ['cold'], k2: ['warm', 'bright'], k3: ['warm', 'dark'] };                // like the svg colours: blue, yellow, purple
  plates.forEach(p => { p.look = looks[p.filename] || []; });
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
    groups: [],
    edits: [],
    projects: [{ slug: 'demo', name: 'Demo', mark_size: 18, mark_x: 50, mark_y: 50, mark_shape: 'circular orbital logo', mark_noun: 'circular mark',
      brief: 'Demo, a creative toolkit for creatives at an agency group', palette: ['#EC540C'], mark_ratio: 1, round: true, fixed: true, mark_url: '/api/project-mark?p=demo' }],
    project: 'demo',
  };
}
const projectOf = st => st.projects.find(p => p.slug === st.project);

// the same rules as studio/sequences.py: one Manual order, at most one AI order (redo replaces it), both editable in place
const seqOf = (st, id) => st.sequences.find(s => s.id === id);
const activeSeq = st => seqOf(st, st.active);
let seqCounter = 100;
function addAi(st, order, { summary = null, cut_off = null } = {}) {
  st.sequences = st.sequences.filter(q => q.kind !== 'ai');
  const seq = { id: `s${++seqCounter}`, name: 'AI', kind: 'ai', order: [...new Set(order)], original: [...new Set(order)], summary, cut_off };
  st.sequences.push(seq); st.active = seq.id; return seq;
}
const librarySig = state => `${state.plates.length}:${state.plates.filter(p => p.trashed).length}:${state.sequences[0].order.join(',')}`;
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
      req.raw = Buffer.concat(chunks);
      try { body = JSON.parse(req.raw.toString() || '{}'); } catch { body = {}; }
    }
    const send = (obj, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname.startsWith('/api/')) state.calls.push({ path: url.pathname, body, query: url.search });
    const LOCKED = ['/api/trash', '/api/reorder', '/api/purge', '/api/sequence', '/api/generate-image', '/api/invent-prompts', '/api/export-video'];
    if (LOCKED.includes(url.pathname) && state.jobs.some(j => !j.done)) return send({ ok: false, busy: true, error: 'The AI is ordering your selection. Wait until it finishes.' }, 409);

    if (url.pathname.startsWith('/assets/ai-plates/')) {
      const name = decodeURIComponent(url.pathname.split('/').pop()).replace(/\.svg$/, '');
      const send = () => { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' }); res.end(svg(name)); };
      const d = (state.delays && state.delays.image) || 0;                      // a real plate takes a while to arrive and decode
      return d ? setTimeout(send, d / 2 + Math.random() * d) : send();
    }
    switch (url.pathname) {
      case '/api/state': {
        const visible = new Set(state.plates.filter(p => !p.trashed).map(p => p.filename));
        return send({ state_sig: librarySig(state), plates: orderedPlates(state), sequences: state.sequences.map(q => ({ id: q.id, name: q.name, kind: q.kind, count: q.order.filter(n => visible.has(n)).length, summary: q.summary, cut_off: q.cut_off || null, edited: q.kind === 'ai' && JSON.stringify(q.order) !== JSON.stringify(q.original) })), active_sequence: state.active, groups: (state.groups || []).map(g => ({ ...g, files: g.files.filter(f => state.plates.some(p => p.filename === f)) })), edits: state.edits || [], path_runs: state.pathRuns || [], project: projectOf(state), krea_connected: true, kimi_configured: state.kimiConfigured !== false, kimi_key_masked: 'sk-abc••••xyz', kimi_model: 'kimi-k3' });
      }
      case '/api/projects': {    // the projects (projects.py): list, switch, make one (the mark arrives as a PNG data URL), change one
        if (req.method === 'GET') return send({ ok: true, active: state.project, projects: state.projects });
        if (body.action === 'switch') { if (!state.projects.some(p => p.slug === body.slug)) return send({ ok: false, error: 'There is no such project.' }, 404); state.project = body.slug; }
        else if (body.action === 'create') {
          if (!String(body.name || '').trim()) return send({ ok: false, error: 'A project needs a name.' }, 400);
          if (!body.no_mark && !/^data:image\/png;base64,/.test(body.mark || '')) return send({ ok: false, error: 'The mark must be a PNG or JPEG image.' }, 400);
          const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          state.projects.push({ slug, name: body.name, mark_name: body.mark_name, mark_size: body.mark_size, mark_x: body.mark_x, mark_y: body.mark_y, mark_shape: body.mark_shape, mark_noun: body.mark_noun, brief: body.brief, palette: body.palette, mark_ratio: 0.5, round: false, fixed: false, mark_url: `/api/project-mark?p=${slug}`, has_mark: !body.no_mark,
            marks: (body.marks || []).map((m, i) => ({ id: `m${i + 1}`, name: m.name, size: m.size, x: m.x, y: m.y, shape: m.shape, noun: m.noun, ratio: 1, url: `/api/project-mark?p=${slug}&m=m${i + 1}` })) });
          state.project = slug; state.markSent = body.mark;
          state.plates = []; state.sequences[0].order = [];                    // a new project starts empty
        } else if (body.action === 'delete') {
          state.deleted = body.slug; state.projects = state.projects.filter(p => p.slug !== body.slug);
          state.project = state.projects.length ? state.projects[0].slug : null; state.plates = []; state.sequences[0].order = [];
        } else if (body.action === 'add_mark' || body.action === 'edit_mark' || body.action === 'remove_mark') {   // the project's other marks
          const p = projectOf(state), marks = p.marks || (p.marks = []);
          if (body.action === 'add_mark') { const id = String(body.name || 'mark').toLowerCase().replace(/[^a-z0-9]+/g, '-'); marks.push({ id, name: body.name, size: p.mark_size || 18, shape: body.shape, noun: body.noun, ratio: 1, url: `/api/project-mark?p=${p.slug}&m=${id}` }); state.markAdded = body; }
          else if (body.action === 'edit_mark') Object.assign(marks.find(m => m.id === body.mark_id), body.name !== undefined ? { name: body.name } : {}, body.size !== undefined ? { size: body.size } : {});
          else p.marks = marks.filter(m => m.id !== body.mark_id);
        } else if (body.action === 'update') {
          const p = projectOf(state);
          Object.assign(p, { name: body.name, brief: body.brief, palette: body.palette, frames: body.frames === true }, p.fixed ? {} : { mark_name: body.mark_name, mark_size: body.mark_size, mark_x: body.mark_x, mark_y: body.mark_y });
          if (Array.isArray(body.marks)) p.marks = body.marks.map((m, i) => ({ id: m.id || `n${i + 1}`, name: m.name, size: m.size, x: m.x, y: m.y, shape: m.shape, noun: m.noun, ratio: 1, url: m.image || `/api/project-mark?p=${p.slug}&m=${m.id}` }));
        }
        return send({ ok: true, active: state.project, project: projectOf(state), projects: state.projects });
      }
      case '/api/describe-mark': if (state.describeFails) return void send({ ok: false, error: 'Kimi could not read it' });
        return void setTimeout(() => send({ ok: true, colours: ['#F0A020'], name: 'Owl Bar', brand: 'Owl Bar, a bar', shape: 'horizontal bar mark', noun: 'bar', suggested: ['#1A1A1A', '#C9A227'], palette_note: 'Night bar mood: ink and brass' }), state.delays.describe || 0);
      case '/api/project-export': return send({ ok: true, url: '/api/download-zip?id=0123456789abcdef0123456789abcdef&name=p.zip', filename: 'Demo-project.zip', bytes: 9e7 });
      case '/api/project-import': {
        if (!req.raw.length || req.raw[0] !== 0x50) return send({ ok: false, error: 'That is not a project file (a .zip made by Export project).' }, 400);
        state.projects.push({ ...state.projects[0], slug: 'imported', name: 'Imported', fixed: false, round: false }); state.project = 'imported';
        return send({ ok: true, active: 'imported', project: projectOf(state), projects: state.projects });
      }
      case '/api/download-zip':
        if (req.method === 'POST') { state.zipAsked = body; return send({ ok: true, url: '/api/download-zip?id=0123456789abcdef0123456789abcdef&name=x.zip', filename: 'x.zip', bytes: 2e6 }); }
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="x.zip"' }); return res.end('PK');
      case '/api/project-mark':
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
        return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="16" fill="none" stroke="${state.markColour || '#FEFFE7'}" stroke-width="4"/></svg>`);
      case '/api/worlds':
        return send({ ok: true, worlds: [{ name: 'Editorial Print', brief: 'Swiss grid.', n: 7, kept: 3, wildcard: false }, { name: 'Matter & Elements', brief: 'Fluids and fire.', n: 10, kept: 2, wildcard: false, origin: 'core' }, ...(state.moreWorlds || [])] });
      case '/api/version': return send({ boot: state.boot || 'fake', html: 0, state: librarySig(state) });   // the library's fingerprint, as the server's state_sig
      case '/api/net': return send({ ok: true, online: state.online !== false });
      case '/api/busy': if (req.method === 'POST') state.lease = body.for; return send({ ok: true, busy: !!body.for });
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
        if (body.action === 'restore' && Array.isArray(body.order)) { const a = activeSeq(state); a.order = [...body.order, ...a.order.filter(n => !body.order.includes(n))]; a.cut_off = body.cut_off || null; return send({ ok: true }); }
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
      case '/api/placements': {                 // Loose / Scattered: each image's place from the seed (the server's is placement.choose)
        const q = url.searchParams, seed = q.get('seed') || '', n = +q.get('n') || 1;
        const h = k => { let x = [...`${seed}:${k}`].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0, 2166136261); x ^= x >>> 15; return Math.imul(x, 2246822519) >>> 0; };
        return send({ ok: true, places: seed ? Array.from({ length: n }, (_, i) => ({ i, mark: 'main', kind: q.get('target'), x: 12 + h(i) % 76, y: 12 + h(i + 50) % 76, size: 10 + h(i + 99) % 20 })) : [] });
      }
      case '/api/invent-prompts': {
        await sleep(state.delays.invent);
        if (body.fill) {                         // Make N: the run's missing steps (the server's run_fill), in the same run
          const r = (state.pathRuns || []).find(x => x.run === body.fill), have = new Set(state.plates.filter(p => !p.trashed && p.placement && p.placement.path && p.placement.path.run === body.fill).map(p => p.placement.path.i));
          const steps = r ? Array.from({ length: r.n }, (_, i) => i).filter(i => !have.has(i)) : [];
          if (!steps.length) return send({ ok: false, error: 'That path has all its steps.' }, 400);
          return send({ ok: true, keep: false, ideas: steps.map(i => ({ title: `Step ${i + 1}`, prompt: `step ${i}`, guide: 'dark', world: r.world, idea: 'idea', subject: `step ${i}`, placement: { kind: 'path', x: 50, y: 20 + i * 10, size: 18, path: { shape: 'line', dir: r.dir, len: r.len, i, n: r.n, run: r.run } } })) });
        }
        const n = body.count || 4;
        if (body.world === '__custom__' && !(state.moreWorlds || []).some(w => w.name === 'Fog & Vapor'))   // Describe your own: a territory of yours, your words kept
          (state.moreWorlds || (state.moreWorlds = [])).push({ name: 'Fog & Vapor', brief: 'Weather.', n: 4, kept: 4, wildcard: true, origin: 'custom', prompt: body.direction });
        const run = body.target === 'path' ? `f${(state.runCount = (state.runCount || 0) + 1)}` : null, pa = body.path || {};
        if (run) (state.pathRuns || (state.pathRuns = [])).push({ run, n, shape: 'line', dir: pa.dir || 0, len: pa.len || 40, at: Date.now() / 1000, world: 'Fog & Vapor' });   // the server records a new run
        return send({ ok: true, world: body.world && !body.world.startsWith('__') ? body.world : 'Fog & Vapor', ideas: Array.from({ length: n }, (_, i) => ({ title: `Fog ${i + 1}`, prompt: `fog scene ${i}`, guide: i % 2 ? 'light' : 'dark', world: body.world && !body.world.startsWith('__') ? body.world : 'Fog & Vapor', idea: 'idea', subject: `fog ${i}`,
          placement: run ? { kind: 'path', x: 50, y: 20 + i * 5, size: 18, path: { shape: 'line', dir: pa.dir || 0, len: pa.len || 40, i, n, run } } : null })) });
      }
      case '/api/upload-image': {               // your own image: the page sends it framed (a JPEG); it joins the end, uploaded
        const name = `u${(state.uploads = (state.uploads || 0) + 1)}`;
        state.uploadedBytes = (state.uploadedBytes || []).concat(req.raw.length);
        for (const q of state.sequences) q.order.push(name);
        state.plates.push({ filename: name, url: `/assets/ai-plates/${name}.svg`, title: decodeURIComponent(new URL(req.url, 'http://x').searchParams.get('name') || '').replace(/\.[a-z]+$/i, ''), prompt: '', model: null, trashed: false, qa_passed: true, qa_issues: [], uploaded: true });
        return send({ ok: true, filename: name });
      }
      case '/api/generate-image': {
        await sleep(state.delays.generate);
        state.genAttempts = (state.genAttempts || 0) + 1;
        if (state.failGen && state.failGen(state.genAttempts, body)) return send({ ok: false, error: `Krea 429: too many requests (${body.title})` }, 500);
        const name = `g${++state.genCount}`, qaOut = !!(state.qaFail && state.qaFail(state.genAttempts, body));   // qaFail: the mark check trashes it
        for (const q of state.sequences) q.order.push(name);
        state.plates.push({ filename: name, url: `/assets/ai-plates/${name}.svg`, title: body.title, prompt: body.prompt, model: body.model, trashed: qaOut, trash_reason: qaOut ? 'Mark check' : null, qa_passed: true, qa_score: 90, qa_issues: [], world: body.world, placement: body.placement || null, box: body.placement ? { x: body.placement.x, y: body.placement.y, size: body.placement.size, ar: 1, rot: body.placement.rot || 0 } : null });
        return send({ ok: true, qa_passed: !qaOut, trashed: qaOut, qa_issues: qaOut ? ['The mark is not at its place and size'] : [], filename: name, title: body.title });
      }
      case '/api/edits': {                     // the same rules as studio/edits.py
        const es = state.edits || (state.edits = []);
        const e = es.find(x => x.id === body.id);
        const name = String(body.name || '').trim();
        if (body.action === 'create') { if (!name || es.some(x => x.name.toLowerCase() === name.toLowerCase())) return send({ ok: false, error: name ? `There is already an edit called “${name}”.` : 'An edit needs a name.' }, 400); const ne = { id: `e${es.length + 1}${Date.now() % 1000}`, name, group: body.group || 'all', settings: body.settings || {} }; es.push(ne); return send({ ok: true, edit: ne }); }
        if (body.action === 'restore') { es.push({ ...body.edit }); return send({ ok: true }); }
        if (!e) return send({ ok: false, error: 'That edit is gone.' }, 400);
        if (body.action === 'update') { e.group = body.group || 'all'; e.settings = body.settings || {}; return send({ ok: true }); }
        if (body.action === 'rename') { if (!name) return send({ ok: false, error: 'An edit needs a name.' }, 400); e.name = name; return send({ ok: true }); }
        if (body.action === 'delete') { state.edits = es.filter(x => x !== e); return send({ ok: true, edit: e }); }
        return send({ ok: false, error: 'Unknown action.' }, 400);
      }
      case '/api/groups': {                    // the same rules as studio/groups.py
        const gs = state.groups || (state.groups = []);
        const g = gs.find(x => x.id === body.id);
        const name = String(body.name || '').trim();
        if (body.action === 'create') { if (!name || gs.some(x => x.name.toLowerCase() === name.toLowerCase())) return send({ ok: false, error: name ? `There is already a group called “${name}”.` : 'A group needs a name.' }, 400); const ng = { id: `g${gs.length + 1}${Date.now() % 1000}`, name, files: body.rule ? [] : [...new Set(body.files || [])], ...(body.rule ? { rule: body.rule } : {}) }; gs.push(ng); return send({ ok: true, group: ng }); }
        if (body.action === 'restore') { gs.push({ ...body.group }); return send({ ok: true }); }
        if (!g) return send({ ok: false, error: 'That group is gone.' }, 400);
        if (body.action === 'rule') { if (!g.rule || !body.rule || !Object.keys(body.rule).length) return send({ ok: false, error: 'A smart group needs at least one choice.' }, 400); g.rule = body.rule; return send({ ok: true }); }
        if (g.rule && ['add', 'remove', 'reorder'].includes(body.action)) return send({ ok: false, error: 'A smart group fills itself: change its choices instead.' }, 400);
        if (body.action === 'add') { g.files = [...new Set([...g.files, ...(body.files || [])])]; return send({ ok: true }); }
        if (body.action === 'remove') { g.files = g.files.filter(f => !(body.files || []).includes(f)); return send({ ok: true }); }
        if (body.action === 'reorder') { const want = (body.files || []).filter(f => g.files.includes(f)); g.files = [...want, ...g.files.filter(f => !want.includes(f))]; return send({ ok: true }); }
        if (body.action === 'rename') { if (!name) return send({ ok: false, error: 'A group needs a name.' }, 400); g.name = name; return send({ ok: true }); }
        if (body.action === 'delete') { state.groups = gs.filter(x => x !== g); return send({ ok: true, group: g }); }
        return send({ ok: false, error: 'Unknown action.' }, 400);
      }
      case '/api/export-video': {
        await sleep(state.delays.export);
        const n = Array.isArray(body.files) && body.files.length ? body.files.length : state.plates.filter(p => !p.trashed).length;
        return send({ ok: true, video_url: '/outputs/Demo-test.mp4', filename: 'Demo-test.mp4', images: n, seconds: n * 0.5, cuts: n });
      }
      case '/api/export-frame': {    // a frame drawn by the page's renderer: kept so a test can look at it
        const i = +url.searchParams.get('i'), same = url.searchParams.get('same');
        if (i === 0) state.frames = [];
        const to = +(url.searchParams.get('to') || i + 1);
        for (let f = i; f < to; f++) state.frames[f] = same === null ? req.raw : state.frames[+same];
        (state.frameRequests ||= []).push(url.search);
        return send({ ok: true });
      }
      case '/api/export-audio': {    // the drone rendered in the page: keep what arrived so a test can look at it
        state.exportAudio = req.raw;
        return send({ ok: true, bytes: req.raw.length });
      }
      default:
        res.writeHead(404); return res.end('not found');
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) })));
}

module.exports = { start, makeState, addAi, orderedPlates };
