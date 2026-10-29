// A long session, to see the page stays light: memory, page elements, listeners and sound contexts must not keep growing.
// Not in the normal run (minutes long): SOAK=1 node --test studio/tests/e2e/soak.e2e.test.cjs (SOAK_MIN=10 for ten minutes).
const { test, assert, register, fresh, film, curate, skip, api, page, consoleErrors, tempo } = require('./harness.cjs');
register();

const MINUTES = parseFloat(process.env.SOAK_MIN || '3');
const soakSkip = skip || (process.env.SOAK ? false : 'set SOAK=1 to run the soak test');

test(`soak: ${MINUTES} min of playing, switching, Random, sound changes, picking and the viewer, on 150 images`, { skip: soakSkip, timeout: (MINUTES + 3) * 60000 }, async () => {
  const ctx = await fresh({ width: 1512, height: 945, setup: st => {
    for (let i = 0; i < 147; i++) { const f = `q${i}`; st.plates.push({ ...st.plates[0], filename: f, title: `Plate ${f}`, url: `/assets/ai-plates/${f}.svg` }); st.sequences[0].order.push(f); }
  } });
  const cdp = await ctx.newCDPSession(ctx.pages()[0]);
  await cdp.send('Performance.enable');
  const sample = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    const contexts = await page.evaluate(() => (window.__soakContexts || 0));
    const sound = await page.evaluate(() => { const b = document.getElementById('playBtn'); return b ? b.getAttribute('aria-label') : '?'; });
    return { heapMB: +(m.JSHeapUsedSize / 1e6).toFixed(1), nodes: m.Nodes, listeners: m.JSEventListeners, contexts, reloads, playing: sound === 'Pause' };
  };
  let reloads = 0;
  ctx.pages()[0].on('framenavigated', f => { if (f === ctx.pages()[0].mainFrame()) reloads++; });
  await page.evaluate(() => {                                      // count the sound contexts open (each swap makes one; the old ones must close)
    const A = window.AudioContext; let open = 0;
    window.AudioContext = class extends A { constructor(...a) { super(...a); open++; window.__soakContexts = open; this.addEventListener('statechange', () => { if (this.state === 'closed') { open--; window.__soakContexts = open; } }); } };
  });
  await film();
  await page.evaluate(() => { const s = document.getElementById('musicSelect'); s.value = 'on'; s.dispatchEvent(new Event('change')); });
  await page.click('#playBtn');
  const rows = [];
  const t0 = Date.now(), end = t0 + MINUTES * 60000;
  let round = 0;
  rows.push({ t: 0, ...(await sample()) });
  while (Date.now() < end) {
    round++;
    await page.keyboard.press('r');                                 // Random: a new rhythm, look and sound
    await page.waitForTimeout(1500);
    await page.keyboard.press('s');                                 // Random sound
    await page.waitForTimeout(1500);
    await tempo(80 + (round * 37) % 400);
    await page.waitForTimeout(1000);
    await curate();                                                 // Curate, the mini preview playing
    await page.waitForTimeout(800);
    const cards = page.locator('.card');
    await cards.nth(round % 20).click({ position: { x: 60, y: 80 }, modifiers: ['Meta'] });
    await cards.nth((round + 3) % 20).click({ position: { x: 60, y: 80 }, modifiers: ['Meta'] });
    await page.keyboard.press('Escape');
    await cards.nth(round % 10).dblclick({ position: { x: 60, y: 80 } });   // the viewer, a few steps, closed
    for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await film();
    await page.waitForTimeout(1500);
    if (Date.now() - t0 > rows.length * 20000) rows.push({ t: Math.round((Date.now() - t0) / 1000), ...(await sample()) });
  }
  rows.push({ t: Math.round((Date.now() - t0) / 1000), ...(await sample()) });
  console.log(`soak: ${round} rounds in ${MINUTES} min`);
  console.table(rows);
  const mid = rows[Math.floor(rows.length / 2)], last = rows[rows.length - 1];
  // after warm-up (the first half), the second half must be flat: allowances cover the GC's noise and caches filling up to their caps
  assert.ok(last.heapMB < mid.heapMB * 1.25 + 5, `memory keeps growing: ${mid.heapMB} MB at ${mid.t}s, ${last.heapMB} MB at ${last.t}s`);
  assert.ok(last.nodes < mid.nodes * 1.15 + 200, `page elements keep growing: ${mid.nodes} → ${last.nodes}`);
  assert.ok(last.listeners < mid.listeners * 1.15 + 50, `listeners keep growing: ${mid.listeners} → ${last.listeners}`);
  assert.equal(reloads, 0, 'the page never reloaded (a reload would reset memory and hide a leak)');
  assert.ok(last.contexts >= 1 && last.contexts <= 3, `sound contexts open: ${last.contexts} (one playing, never piling up)`);
  assert.deepEqual(consoleErrors.filter(e => !/favicon/.test(e)), []);
  await ctx.close();
});
