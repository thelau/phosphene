// Shared by the browser test files. Each file gets its own fake API, its own Vite and its own browser, so files can run in parallel.
// Vite serves the page, a fake API stands in for the Python server, headless Chromium drives it.
// Set E2E_SHOTS=/some/dir to save screenshots. Set BROWSER_PATH to pick a browser (Brave / Chrome / Chromium).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { start, makeState, addAi } = require('./fakeapi.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SHOTS = process.env.E2E_SHOTS;

// Playwright's chrome-headless-shell first: a bare headless build, so no app opens (Brave or Chrome show a Dock icon even headless)
function headlessShells() {
  const dir = path.join(require('os').homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(d => d.startsWith('chromium_headless_shell-')).sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10))
    .flatMap(d => ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-mac'].map(sub => path.join(dir, d, sub, 'chrome-headless-shell')));
}
function findBrowser() {
  const c = [process.env.BROWSER_PATH, ...headlessShells(), '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  return c.find(p => fs.existsSync(p));
}
const browserPath = findBrowser();

const api = {};                 // filled in by register(): { state, url, close }
const env = { page: null, browser: null, vite: null, port: 0 };
const consoleErrors = [];       // one list, cleared in place by every fresh()
// `page` always points at the page of the current test
const page = new Proxy({}, { get: (_, k) => { const v = env.page[k]; return typeof v === 'function' ? v.bind(env.page) : v; } });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

async function waitForUrl(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${url}`);
}
const shot = async name => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };
const text = sel => page.locator(sel).first().innerText();

function register() {
  test.before(async () => {
    Object.assign(api, await start());
    env.port = await freePort();
    env.vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'studio/web', '--port', String(env.port), '--strictPort'], { cwd: ROOT, env: { ...process.env, API_URL: api.url }, stdio: 'ignore' });
    await waitForUrl(`http://localhost:${env.port}/`);
    env.browser = await chromium.launch({ executablePath: browserPath, headless: true });
  });
  test.after(async () => {
    await env.browser?.close();
    env.vite?.kill();
    await api.close?.();
  });
}

async function fresh(opts = {}) {
  const fresh_state = makeState();
  Object.assign(api.state, { plates: fresh_state.plates, sequences: fresh_state.sequences, active: fresh_state.active });
  if (opts.setup) opts.setup(api.state);
  api.state.delays = { purge: 0, generate: 0, invent: 0, export: 0, ai: 600, ...opts.delays };
  api.state.jobs = [];
  api.state.boot = 'fake'; api.state.failGen = opts.failGen || null; api.state.genAttempts = 0;
  api.state.aiFail = opts.aiFail || null;
  api.state.genCount = 0;
  api.state.calls.length = 0;
  const ctx = await env.browser.newContext({ viewport: { width: opts.width || 1500, height: opts.height || 900 } });
  env.page = await ctx.newPage();
  consoleErrors.length = 0;
  env.page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text() + ' ' + (m.location().url || '')); });
  env.page.on('pageerror', e => consoleErrors.push(String(e)));
  await env.page.goto(`http://localhost:${env.port}/`);
  await env.page.waitForSelector('#loader', { state: 'detached' });
  if (!opts.empty) await env.page.waitForSelector('.card');
  return ctx;
}

const skip = browserPath ? false : 'no Chromium-based browser found (set BROWSER_PATH)';

const names = async () => page.locator('.card').evaluateAll(els => els.map(e => e.dataset.filename));
const seg = async () => page.locator('#orderSeg button').evaluateAll(els => els.map(e => ({ text: e.textContent.trim(), on: e.classList.contains('on') })));
const enabled = async sel => { await page.waitForFunction(q => !document.querySelector(q).disabled, sel); };      // unlocking follows the status text by a moment
const clickSeg = async label => { await page.locator('#orderSeg button', { hasText: label }).click(); };
// the two modes, and the segmented controls that stand in for the Speed / Change at / Invert / Zoom / Source selects
const film = async () => { await page.click('#modeFilm'); await page.waitForSelector('#viewFilm', { state: 'visible' }); };
const curate = async () => { await page.click('#modeCurate'); await page.waitForSelector('#viewCurate', { state: 'visible' }); };
const choose = async (id, value) => { await page.click(`.segctl[data-for="${id}"] button[data-value="${value}"]`); };
const aiSetup = (summary = 'Hook on k2, lands on k1.') => st => { st.sequences[0].order = ['k3', 'k1', 'k2', 't1', 't2', 't3', 't4']; addAi(st, ['k2', 'k3', 'k1'], { summary }); st.active = 's1'; };

module.exports = { test, assert, register, fresh, shot, text, names, seg, enabled, clickSeg, aiSetup, film, curate, choose, skip, api, page, consoleErrors, addAi, makeState };
