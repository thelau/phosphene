// Loads the <script> of studio/index.html into a vm with a tiny DOM, fake fetch and recorded timers.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class El {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.style = {}; this.dataset = {};
    this.disabled = false; this.placeholder = ''; this.title = ''; this.className = ''; this.checked = false;
    this.options = /Select$/.test(id) ? [] : undefined; this.listeners = {}; this.scrollTop = 0; this.children = [];
    const set = (this._classes = new Set());
    this.classList = {
      add: c => { set.add(c); }, remove: c => { set.delete(c); }, contains: c => set.has(c),
      toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force; on ? set.add(c) : set.delete(c); return on; },
    };
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  fire(ev) { (this.listeners[ev] || []).forEach(fn => fn({ target: this })); }
  focus() {} remove() {} click() {}
  toBlob(cb) { cb({ size: 1, fakeJpeg: true }); }
  getAttribute(n) { return this[n] ?? null; }
  setAttribute(n, v) { this[n] = v; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  appendChild(c) { (this.options ||= []).push(c); return c; }
  get selectedOptions() { return (this.options || []).filter(o => o.value === this.value).slice(0, 1); }
}

const WEB = (...p) => path.join(__dirname, '..', '..', 'web', ...p);

function load({ routes = {}, storage = {} } = {}) {
  routes = { '/api/export-frame': { ok: true }, ...routes };              // the export's frames, drawn by the (fake) renderer
  const els = {};
  const calls = [];
  const timers = { intervals: [], timeouts: [] };
  const document = {
    getElementById: id => (els[id] ||= Object.assign(new El(id), id === 'statusText' ? { dataset: { idle: '1' }, textContent: 'Ready' } : {})),
    createElement: () => new El('new'),
    querySelectorAll: () => [],
    querySelector: () => null,
    hidden: false,
    addEventListener() {},
    body: new El('body'),
    documentElement: new El('html'),
  };
  const store = { ...storage };
  const ctx = {
    document, console,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    location: { reload() { ctx.__reloaded = true; } },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: (fn, ms) => { timers.intervals.push({ fn, ms }); return timers.intervals.length; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { timers.timeouts.push({ fn, ms }); return timers.timeouts.length; },
    clearTimeout: () => {},
    requestAnimationFrame: fn => { timers.intervals.push({ fn, ms: 16, raf: true }); return timers.intervals.length; },   // a frame runs when a test calls it
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    addEventListener(ev, fn) { (ctx.__listeners ||= {})[ev] = fn; },
    CSS: { escape: s => s },
    Promise, JSON, Math, Date, parseInt, parseFloat, Number, String, Array, Object, Set, Map, Error,
    fetch: async (url, opts = {}) => {
      let body = opts.body;
      try { body = opts.body ? JSON.parse(opts.body) : undefined; } catch (e) { /* a file upload: keep it as it is */ }
      calls.push({ url, body });
      const route = routes[url] ?? routes[url.split('?')[0]];
      if (!route) throw new Error(`no route for ${url}`);
      const out = typeof route === 'function' ? await route(body, calls) : route;
      if (out && out.__fail) return { ok: false, status: out.__fail, json: async () => ({}), blob: async () => ({}) };
      return { ok: true, status: 200, json: async () => out, blob: async () => ({ size: 1 }) };
    },
    URL: { createObjectURL: () => 'blob:music', revokeObjectURL() {} },
    Audio: class { constructor(src) { this.src = src; this.loop = false; this.paused = true; this.currentTime = 0; ctx.__audios.push(this); } async play() { this.paused = false; } pause() { this.paused = true; } },
    __audios: [],
    // the drone engine needs WebAudio, which node does not have: a fake that records what the page asks of it (drone.js is tested in the browser)
    __drone: { plays: [], updates: [], stops: 0, exports: [], position: 0 },
  };
  ctx.Drone = {
    Live: class {
      constructor() { this.playing = false; this.holding = 0; }
      async play(params, starts, offset) { this.playing = true; ctx.__drone.plays.push({ params, starts, offset }); }
      async update(params, starts, getOffset) { ctx.__drone.updates.push({ params, starts, offset: getOffset() }); }
      restart() { ctx.__drone.restarts = (ctx.__drone.restarts || 0) + 1; }
      seek(offset) { (ctx.__drone.seeks ||= []).push(offset); }
      stop() { this.playing = false; ctx.__drone.stops++; }
      pos() { return ctx.__drone.position; }
    },
    renderExport: async (params, starts) => { ctx.__drone.exports.push({ params, starts }); return { left: new Float32Array(1), right: new Float32Array(1), rate: 44100 }; },
    toWav: () => ({ size: 44, fakeWav: true }),
  };
  // the picture renderer needs WebGL2, which node does not have: the stage stays on CSS (no renderer for it), the export draws with a fake that counts
  ctx.__render = { draws: 0 };
  ctx.Render = {
    create: (canvas, opts) => (opts && opts.keep ? { draw() { ctx.__render.draws++; }, forget() {}, canvas } : null),
    loadImage: async url => ({ url, width: 1080, height: 1920 }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const script = fs.readFileSync(WEB('src', 'app.js'), 'utf8');
  vm.runInContext(script, ctx, { filename: 'app.js' });
  const $ = id => document.getElementById(id);
  const run = code => vm.runInContext(code, ctx);
  return { ctx, $, run, calls, timers, store, els };
}

module.exports = { load, El, WEB };
