// Loads the <script> of studio/index.html into a vm with a tiny DOM, fake fetch and recorded timers.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class El {
  constructor(id) {
    this.id = id; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.style = {}; this.dataset = {};
    this.disabled = false; this.placeholder = ''; this.title = ''; this.className = ''; this.checked = false;
    this.options = /Select$/.test(id) ? [] : undefined; this.listeners = {}; this.scrollTop = 0; this.children = [];
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  fire(ev) { (this.listeners[ev] || []).forEach(fn => fn({ target: this })); }
  focus() {} remove() {} click() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  appendChild(c) { (this.options ||= []).push(c); return c; }
  get selectedOptions() { return (this.options || []).filter(o => o.value === this.value).slice(0, 1); }
}

const WEB = (...p) => path.join(__dirname, '..', '..', 'web', ...p);

function load({ routes = {}, storage = {} } = {}) {
  const els = {};
  const calls = [];
  const timers = { intervals: [], timeouts: [] };
  const document = {
    getElementById: id => (els[id] ||= Object.assign(new El(id), id === 'statusText' ? { dataset: { idle: '1' }, textContent: 'Ready' } : {})),
    createElement: () => new El('new'),
    querySelectorAll: () => [],
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
    requestAnimationFrame: fn => fn(),
    CSS: { escape: s => s },
    Promise, JSON, Math, Date, parseInt, parseFloat, Number, String, Array, Object, Set, Map, Error,
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, body });
      const route = routes[url];
      if (!route) throw new Error(`no route for ${url}`);
      const out = typeof route === 'function' ? await route(body, calls) : route;
      return { ok: true, status: 200, json: async () => out };
    },
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
