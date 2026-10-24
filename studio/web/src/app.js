    let plates = [];
    let showTrash = false;
    let isPlaying = false;
    let currentIdx = 0;
    let framesPerCut = 7.5;
    let timer = null;
    let draggedFilename = null;
    let kimiConfigured = false;
    let saveTimer = null;

    // Bottom status bar = generation progress only ("Ready" otherwise). Everything else is a short toast.
    function idleText() { return 'Ready'; }
    let toastTimer = null;
    function setStatus(msg) {
      const t = document.getElementById('toast');
      clearTimeout(toastTimer);
      if (!msg) { t.textContent = ''; t.classList.remove('show'); return; }
      t.textContent = msg;
      t.classList.add('show');
      toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
    }
    function refreshIdle() {
      const el = document.getElementById('statusText');
      if (el.dataset.idle === '1' && !prog.timer) el.textContent = idleText();
    }

    function toggleSettings(forceOpen = null) {
      loadModelStats();
      const pop = document.getElementById('settingsPopover');
      if (forceOpen === true) pop.classList.add('open');
      else if (forceOpen === false) pop.classList.remove('open');
      else pop.classList.toggle('open');
    }

    document.addEventListener('click', (e) => {
      const pop = document.getElementById('settingsPopover');
      const btn = document.getElementById('settingsBtn');
      if (!pop.contains(e.target) && !btn.contains(e.target)) {
        pop.classList.remove('open');
      }
    });

    async function saveKimiSettings() {
      const keyInput = document.getElementById('kimiKeyInput').value.trim();
      const modelVal = document.getElementById('kimiModelSelect').value;
      const payload = { kimi_model: modelVal };
      if (keyInput && !keyInput.includes('••••')) {
        payload.kimi_api_key = keyInput;
      }
      const res = await fetch('/api/save-settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      document.getElementById('criticOn').checked = data.critic_enabled !== false;
      document.getElementById('criticTrash').checked = Boolean(data.critic_autotrash);
      kimiConfigured = Boolean(data.kimi_configured);
      updateKimiIndicator();
      if (kimiConfigured) setStatus('Kimi API key saved.');
    }

    function saveKimiSettingsDebounced() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveKimiSettings, 450);
    }

    function updateKimiIndicator() {
      const dot = document.getElementById('kimiDot');
      const lbl = document.getElementById('kimiStatusLabel');
      dot.className = 'dot' + (kimiConfigured ? '' : ' off');
      lbl.textContent = kimiConfigured ? 'Ready' : 'Needs Key';
    }

    function formatModelShort(modelStr) {
      if (!modelStr) return 'nano-banana-2';
      return modelStr.includes('/') ? modelStr.split('/')[1] : modelStr;
    }

    async function loadState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      plates = data.plates || [];

      const kreaDot = document.getElementById('kreaDot');
      const kreaLbl = document.getElementById('kreaStatusLabel');
      kreaDot.className = 'dot' + (data.krea_connected ? '' : ' off');
      kreaLbl.textContent = data.krea_connected ? 'Connected' : 'Disconnected';

      kimiConfigured = Boolean(data.kimi_configured);
      updateKimiIndicator();
      const keyInput = document.getElementById('kimiKeyInput');
      if (data.kimi_key_masked && !keyInput.value) {
        keyInput.placeholder = `Saved (${data.kimi_key_masked})`;
      }
      if (data.kimi_model) {
        document.getElementById('kimiModelSelect').value = data.kimi_model;
      }

      const trashedCount = plates.filter(p => p.trashed).length;
      document.getElementById('trashCount').textContent = trashedCount;
      document.getElementById('selCount').textContent = plates.length - trashedCount;
      refreshIdle();
      document.getElementById('tabSelection').className = showTrash ? '' : 'on';
      document.getElementById('tabTrash').className = showTrash ? 'on' : '';
      document.getElementById('twinAllBtn').style.display = showTrash ? 'none' : '';

      renderGrid();
      restartLoop();
      lastSig = plateSig(plates);
    }

    // Auto-refresh: pick up new/trashed/paired plates without a manual reload.
    let lastSig = null;
    const plateSig = list => list.map(p => `${p.filename}|${p.trashed ? 1 : 0}|${p.twin_of || ''}`).join(',');

    async function pollState() {
      if (document.hidden || draggedFilename || twinRunning || document.querySelector('.prompt-overlay.open')) return;
      try {
        const data = await (await fetch('/api/state')).json();
        const next = data.plates || [];
        const sig = plateSig(next);
        if (lastSig === null) { lastSig = sig; return; }
        if (sig === lastSig) return;
        const known = new Set(plates.map(p => p.filename));
        const added = next.filter(p => !known.has(p.filename) && !p.trashed).length;
        const grid = document.getElementById('grid');
        const top = grid.scrollTop;
        await loadState();
        grid.scrollTop = top;
        if (added && !prog.timer) setStatus(`+${added} new image${added === 1 ? '' : 's'}`);
      } catch (e) {}
    }

    function activePlates() {
      return plates.filter(p => !p.trashed);
    }

    function renderGrid() {
      const grid = document.getElementById('grid');
      const num = p => parseInt(p.filename, 10) || 0;
      const visible = showTrash
        // newest trashed first; plates trashed before timestamps existed fall back to creation number
        ? plates.filter(p => p.trashed).sort((a, b) => (b.trashed_at || 0) - (a.trashed_at || 0) || num(b) - num(a))
        : plates.filter(p => !p.trashed);

      grid.innerHTML = visible.map((p, i) => `
        <div class="card"
             id="card-${CSS.escape(p.filename)}"
             draggable="${!showTrash}"
             data-filename="${p.filename}"
             ondragstart="onDragStart(event, '${p.filename}')"
             ondragover="onDragOver(event)"
             ondragleave="onDragLeave(event)"
             ondrop="onDrop(event, '${p.filename}')"
             ondragend="onDragEnd(event)"
             onclick="previewPlate('${p.filename}')">
          <div class="card-thumb">
            <img src="${p.url}" loading="lazy" />
            <button class="info-btn" title="View prompt & model" onclick="togglePromptOverlay(event, '${p.filename}')">i</button>
            <div class="card-actions">
              ${p.trashed
                ? `<button class="action-btn" onclick="setTrash(event, '${p.filename}', false)">↩️ Restore</button>`
                : `${p.twin_of || p.has_twin ? '' : `<button class="action-btn more-btn" title="Re-render this exact image in the opposite tonal world (dark↔light)" onclick="makeTwin(event, '${p.filename}')">🌗 Dark↔light</button>`}
                   <button class="action-btn trash-btn" title="Move to trash" onclick="setTrash(event, '${p.filename}', true)">🗑️</button>`
              }
            </div>
            <div class="prompt-overlay" id="overlay-${CSS.escape(p.filename)}" onclick="togglePromptOverlay(event, '${p.filename}')">
              <div class="prompt-overlay-text">${p.world ? `<b>${escapeHtml(p.world)}</b><br>` : ''}${p.idea ? `<i>${escapeHtml(p.idea)}</i><br><br>` : ''}${escapeHtml(p.prompt || p.title)}${p.critic ? `<br><br>AI critic ${p.critic.mean}: ${escapeHtml(p.critic.reason)}` : ''}</div>
              <div class="prompt-overlay-meta">
                <span>Model: <strong>${escapeHtml(p.model || 'google/nano-banana-2')}</strong></span>
                <button style="padding:2px 7px;font-size:10px;" onclick="copyPromptText(event, ${JSON.stringify(p.prompt || p.title)})">Copy</button>
              </div>
            </div>
            <div class="card-footer">
              <div class="card-title-row">#${String(i + 1).padStart(2, '0')} · ${escapeHtml(p.title)}</div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
                <span class="card-model-badge">${escapeHtml(formatModelShort(p.model))}</span>
                ${pairBadge(p, visible)}
                ${p.critic ? `<span class="card-model-badge" title="${escapeHtml(p.critic.reason)}">AI ${p.critic.mean}</span>` : ''}
                ${p.trash_reason ? `<span class="card-model-badge" style="background:rgba(244,63,94,0.22);border-color:rgba(244,63,94,0.5);color:#fda4af;" title="${escapeHtml(p.trash_reason)}">${escapeHtml(p.trash_reason.slice(0, 40))}</span>` : ''}
                ${!p.qa_passed ? `<span class="card-model-badge" style="background:rgba(244,63,94,0.22);border-color:rgba(244,63,94,0.5);color:#fda4af;" title="${escapeHtml((p.qa_issues || []).join(', '))}">QA Flagged</span>` : ''}
              </div>
            </div>
          </div>
        </div>
      `).join('');
    }

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function togglePromptOverlay(e, filename) {
      e.stopPropagation();
      const el = document.getElementById(`overlay-${CSS.escape(filename)}`);
      if (el) el.classList.toggle('open');
    }

    function copyPromptText(e, text) {
      e.stopPropagation();
      navigator.clipboard.writeText(text || '');
      setStatus('Prompt copied to clipboard.');
    }

    /* Drag and drop reordering */
    function onDragStart(e, filename) {
      draggedFilename = filename;
      e.currentTarget.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    }
    function onDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drag-over');
    }
    function onDragLeave(e) {
      e.currentTarget.classList.remove('drag-over');
    }
    async function onDrop(e, targetFilename) {
      e.preventDefault();
      e.currentTarget.classList.remove('drag-over');
      if (!draggedFilename || draggedFilename === targetFilename) return;

      const root = f => (plates.find(p => p.filename === f) || {}).twin_of || f;
      const dragged = root(draggedFilename);
      const target = root(targetFilename);
      if (dragged === target) return;
      const fromIdx = plates.findIndex(p => p.filename === dragged);
      const toIdx = plates.findIndex(p => p.filename === target);
      if (fromIdx === -1 || toIdx === -1) return;

      const [moved] = plates.splice(fromIdx, 1);
      plates.splice(toIdx, 0, moved);

      await fetch('/api/reorder', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ order: plates.map(p => p.filename) })
      });
      await loadState();  // server re-attaches each twin right after its original
    }
    function onDragEnd(e) {
      e.currentTarget.classList.remove('dragging');
      document.querySelectorAll('.card.drag-over').forEach(el => el.classList.remove('drag-over'));
      draggedFilename = null;
    }

    function previewPlate(filename) {
      const stageVideo = document.getElementById('stageVideo');
      const stageImg = document.getElementById('stageImg');
      stageVideo.pause();
      stageVideo.style.display = 'none';
      stageImg.style.display = 'block';
      clearFx();
      const p = plates.find(x => x.filename === filename);
      if (p) {
        stageImg.src = p.url;
        if (p.trashed && isPlaying) {
          isPlaying = false;
          document.getElementById('playBtn').textContent = '▶ Play';
        }
      }
    }

    // ---- what is on screen when (mirrored in studio/cutplan.py; tests keep the two in step) ----
    // A "cut" is one hold of framesPerCut frames. With invert on, every image takes two cuts: normal, then inverted.
    function planAt(cutPos, nPlates, invertMode) {
      const cut = Math.floor(cutPos);
      const p = cutPos - cut;
      const paired = invertMode === 'mono' || invertMode === 'colour';
      return { cut, p, plate: (paired ? Math.floor(cut / 2) : cut) % nPlates, inverted: paired && cut % 2 === 1 };
    }
    function zoomScale(mode, amountPct, cut, p) {
      const a = amountPct / 100;
      if (mode === 'out') return 1 + a * (1 - p);
      if (mode === 'in') return 1 + a * p;
      if (mode === 'alternate') return cut % 2 === 0 ? 1 + a * (1 - p) : 1 + a * p;
      return 1;
    }
    function fxSettings() {
      return {
        invert: document.getElementById('invertSelect').value,
        zoom: document.getElementById('zoomSelect').value,
        amount: parseFloat(document.getElementById('zoomAmt').value) || 0,
      };
    }
    function clearFx() {
      const img = document.getElementById('stageImg');
      img.style.transform = '';
      img.style.filter = '';
    }
    function applyFx(plan, fx) {
      const img = document.getElementById('stageImg');
      const s = zoomScale(fx.zoom, fx.amount, plan.cut, plan.p);
      img.style.transform = s > 1.0005 ? `scale(${s.toFixed(5)})` : '';
      img.style.filter = plan.inverted ? (fx.invert === 'mono' ? 'invert(1) grayscale(1)' : 'invert(1)') : '';
    }
    function updateFx() {
      saveSettings();
      document.getElementById('zoomAmtVal').textContent = `${parseFloat(document.getElementById('zoomAmt').value).toFixed(1)}%`;
      document.getElementById('zoomAmt').disabled = document.getElementById('zoomSelect').value === 'off';
      if (!isPlaying) clearFx();
    }

    let cutPos = 0;
    let lastTick = 0;
    function restartLoop() {
      if (timer) clearInterval(timer);
      lastTick = performance.now();
      timer = setInterval(() => {
        const now = performance.now();
        const dt = now - lastTick;
        lastTick = now;
        if (!isPlaying) return;
        const active = activePlates();
        const stageImg = document.getElementById('stageImg');
        if (!active.length || stageImg.style.display === 'none') return;
        const cutMs = Math.max(16, (framesPerCut / 30) * 1000);
        cutPos += dt / cutMs;
        const fx = fxSettings();
        const plan = planAt(cutPos, active.length, fx.invert);
        currentIdx = plan.plate;
        const url = active[plan.plate].url;
        if (stageImg.getAttribute('src') !== url) stageImg.src = url;
        applyFx(plan, fx);
      }, 16);
    }

    function togglePlay() {
      const stageVideo = document.getElementById('stageVideo');
      const stageImg = document.getElementById('stageImg');
      stageVideo.pause();
      stageVideo.style.display = 'none';
      stageImg.style.display = 'block';
      isPlaying = !isPlaying;
      if (isPlaying) { cutPos = 0; lastTick = performance.now(); } else { clearFx(); }
      document.getElementById('playBtn').textContent = isPlaying ? '⏸ Pause' : '▶ Play';
    }

    function toggleReticle() {
      document.getElementById('reticle').classList.toggle('visible');
    }

    // Remember tempo & generation settings across reloads (per-browser convenience only).
    const PERSISTED = ['bpmSlider', 'multSelect', 'invertSelect', 'zoomSelect', 'zoomAmt', 'batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput'];
    function restoreSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem('studioSettings') || '{}');
        PERSISTED.forEach(id => {
          const el = document.getElementById(id);
          if (el && saved[id] !== undefined && [...(el.options || [{ value: saved[id] }])].some(o => o.value === saved[id] || el.type === 'range')) {
            el.value = saved[id];
          }
        });
      } catch (e) {}
    }
    function saveSettings() {
      try {
        const out = {};
        PERSISTED.forEach(id => { out[id] = document.getElementById(id).value; });
        localStorage.setItem('studioSettings', JSON.stringify(out));
      } catch (e) {}
    }

    function updateTempo() {
      saveSettings();
      const bpm = parseInt(document.getElementById('bpmSlider').value, 10);
      const mult = parseFloat(document.getElementById('multSelect').value);
      framesPerCut = Math.max(1, (30 * 60) / (bpm * mult));
      document.getElementById('bpmVal').textContent = `${bpm} BPM`;
      document.getElementById('speedVal').textContent = `${framesPerCut.toFixed(1)}f`;
      restartLoop();
    }

    function setTrashView(on) {
      showTrash = on;
      loadState();
    }

    async function setTrash(e, filename, trashed) {
      e.stopPropagation();
      await fetch('/api/trash', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ filename, trashed })
      });
      await loadState();
    }

    function ensureKimiReady() {
      const typedKey = document.getElementById('kimiKeyInput').value.trim();
      if (!kimiConfigured && !typedKey) {
        toggleSettings(true);
        document.getElementById('kimiKeyInput').focus();
        setStatus('Paste your Kimi API key in ⚙️ Settings first.');
        return false;
      }
      return true;
    }

    function pairBadge(p, visible) {
      const partner = p.twin_of || (plates.find(q => q.twin_of === p.filename) || {}).filename;
      if (!partner) return '';
      const n = visible.findIndex(q => q.filename === partner);
      const label = p.twin_of ? `◐ twin of #${String(n + 1).padStart(2, '0')}` : `◐ has twin #${String(n + 1).padStart(2, '0')}`;
      return `<span class="card-model-badge pair-badge" title="Click to jump to its pair" onclick="event.stopPropagation(); flashPlate('${partner}')">${n === -1 ? '◐ paired' : label}</span>`;
    }

    function flashPlate(filename) {
      const el = document.querySelector(`.card[data-filename="${filename}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }

    async function makeTwin(e, filename) {
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      setStatus('Making twin (~40s)...');
      let res;
      try {
        res = await (await fetch('/api/make-twin', {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename })
        })).json();
      } finally {
        await loadState();
      }
      if (res.needs_auth) setStatus('Approve Krea OAuth in browser, then try again.');
      else if (!res.ok) setStatus(`Twin failed: ${res.error}`);
      else if (res.qa_passed) { setStatus(`Twin added right after the original (${res.target}).`); flashPlate(res.filename); }
      else setStatus('Twin failed the logo check and is in Trash — try again or skip.');
    }

    let twinSel = new Set();
    let twinRunning = false;
    let twinStop = false;
    let twinFirst = null;

    function twinCandidates() {
      return plates.filter(p => !p.trashed && !p.twin_of && !p.has_twin);
    }

    function openTwinDialog() {
      twinRunning = false; twinStop = false; twinFirst = null;
      const cands = twinCandidates();
      twinSel = new Set(cands.map(p => p.filename));
      document.getElementById('twinModal').classList.add('open');
      document.getElementById('twinStartBtn').style.display = '';
      document.getElementById('twinStartBtn').textContent = 'Make twins';
      document.getElementById('twinCancelBtn').textContent = 'Cancel';
      renderTwinList();
    }

    function closeTwinDialog() {
      if (twinRunning) { twinStop = true; setStatus('Stopping after the current image...'); return; }
      document.getElementById('twinModal').classList.remove('open');
    }

    function twinSelectAll() {
      if (twinRunning) return;
      const cands = twinCandidates();
      twinSel = twinSel.size === cands.length ? new Set() : new Set(cands.map(p => p.filename));
      renderTwinList();
    }

    function toggleTwinSel(f) {
      if (twinRunning) return;
      twinSel.has(f) ? twinSel.delete(f) : twinSel.add(f);
      renderTwinList();
    }

    function renderTwinList() {
      const cands = twinCandidates();
      document.getElementById('twinList').innerHTML = cands.length ? cands.map(p => `
        <div class="twin-row ${twinSel.has(p.filename) ? '' : 'off'}" id="trow-${CSS.escape(p.filename)}" onclick="toggleTwinSel('${p.filename}')">
          <input type="checkbox" ${twinSel.has(p.filename) ? 'checked' : ''} style="padding:0" />
          <img src="${p.url}" />
          <div class="meta"><div class="t">${escapeHtml(p.title)}</div><div class="s">${p.tone} → ${p.tone === 'dark' ? 'light' : 'dark'}</div></div>
        </div>`).join('') : '<p style="color:var(--muted);font-size:12px;padding:12px 0">Every image in the grid already has a twin (or is a twin).</p>';
      const n = twinSel.size;
      document.getElementById('twinSummary').textContent = `${n} selected · ${n} image${n === 1 ? '' : 's'} · ~${Math.ceil(n * 40 / 60)} min`;
      document.getElementById('twinStartBtn').disabled = n === 0;
    }

    function setTwinRow(f, cls, text, thumb) {
      const row = document.getElementById('trow-' + CSS.escape(f));
      if (!row) return;
      row.classList.remove('ok', 'bad');
      if (cls) row.classList.add(cls);
      row.querySelector('.s').textContent = text;
      if (thumb) {
        const im = document.createElement('img');
        im.src = thumb; im.style.marginLeft = 'auto';
        row.appendChild(im);
      }
    }

    async function startTwins() {
      const todo = twinCandidates().filter(p => twinSel.has(p.filename));
      if (!todo.length) return;
      twinRunning = true; twinStop = false;
      document.getElementById('twinStartBtn').style.display = 'none';
      document.getElementById('twinCancelBtn').textContent = 'Stop';
      document.querySelectorAll('#twinList .twin-row').forEach(r => { if (r.classList.contains('off')) r.style.display = 'none'; });
      let ok = 0, failed = 0;
      for (let i = 0; i < todo.length; i++) {
        if (twinStop) break;
        const p = todo[i];
        document.getElementById('twinSummary').textContent = `Working ${i + 1}/${todo.length}…`;
        setTwinRow(p.filename, '', 'rendering…');
        try {
          const res = await (await fetch('/api/make-twin', {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename: p.filename })
          })).json();
          if (res.needs_auth) { setTwinRow(p.filename, 'bad', 'Krea login needed'); break; }
          if (res.ok && res.qa_passed) { ok++; twinFirst = twinFirst || res.filename; setTwinRow(p.filename, 'ok', `✓ ${res.target} twin`, `/assets/ai-plates/${res.filename}`); }
          else { failed++; setTwinRow(p.filename, 'bad', res.ok ? '✗ failed logo check (in Trash)' : `✗ ${(res.error || 'error').slice(0, 40)}`); }
        } catch (e) { failed++; setTwinRow(p.filename, 'bad', '✗ network error'); }
      }
      twinRunning = false;
      document.getElementById('twinSummary').textContent = `Done: ${ok} twin${ok === 1 ? '' : 's'} added${failed ? `, ${failed} failed` : ''}${twinStop ? ' (stopped)' : ''}. They sit right after their originals.`;
      const start = document.getElementById('twinStartBtn');
      start.style.display = ''; start.disabled = false;
      start.textContent = ok ? 'Show in grid' : 'Close';
      start.onclick = () => { document.getElementById('twinModal').classList.remove('open'); start.onclick = startTwins; if (twinFirst) flashPlate(twinFirst); };
      document.getElementById('twinCancelBtn').textContent = 'Close';
      await loadState();
    }

    function updateDirectionHint() {
      const sel = document.getElementById('worldSelect');
      const v = sel.value;
      const input = document.getElementById('directionInput');
      let say;
      if (v === '') {
        input.placeholder = 'Optional: what do you want? e.g. wet apparel, warm light';
        say = 'Mix it up: we pick the territory, mostly ones whose images you keep, sometimes ones you haven\'t tried, sometimes a brand-new one. Type a direction and we match it to the closest territory.';
      } else if (v === '__custom__') {
        input.placeholder = 'Describe your territory (required), e.g. fog, clouds, vapor, rain, lightning';
        say = 'Custom territory: describe it and every image will be about that. A look and palette are invented for it.';
      } else if (v === '__wildcard__') {
        input.placeholder = 'Optional: hint for the new territory';
        say = 'New territory: Kimi invents a fresh area we don\'t cover yet.';
      } else {
        input.placeholder = `Optional: focus inside ${v}, e.g. fog, rain, lightning (every image follows it)`;
        const opt = sel.selectedOptions[0];
        say = `${v}: ${(opt && opt.dataset.brief) || ''}`;
      }
      sel.title = say;
    }

    async function loadWorlds() {
      try {
        const data = await (await fetch('/api/worlds')).json();
        const sel = document.getElementById('worldSelect');
        const cur = sel.value;
        sel.querySelectorAll('option.w').forEach(o => o.remove());
        data.worlds.forEach(w => {
          const o = document.createElement('option');
          o.className = 'w';
          o.value = w.name;
          o.dataset.brief = w.brief || '';
          o.textContent = `${w.wildcard ? '✨ ' : ''}${w.name} (${w.kept} of ${w.n} kept)`;
          sel.appendChild(o);
        });
        sel.value = cur || (JSON.parse(localStorage.getItem('studioSettings') || '{}').worldSelect || '');
        updateDirectionHint();
      } catch (e) {}
    }

    // ---- live generation progress (lives in the status strip) ----
    const prog = { t0: 0, timer: null, slots: [], titles: [], world: '', stage: '', note: '', total: 0, summary: '' };
    function fmtElapsed(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    function progRender() {
      const el = document.getElementById('statusText');
      const done = prog.slots.filter(x => x === 'ok' || x === 'trash' || x === 'err').length;
      const running = prog.slots.filter(x => x === 'run').length;
      const dots = prog.slots.map((st, i) => `<i class="slot ${st}" title="${escapeHtml(prog.titles[i] || '')}"></i>`).join('');
      const bar = prog.stage === 'invent' ? '<span class="slots indeterminate"><i></i></span>' : `<span class="slots">${dots}</span>`;
      const count = prog.stage === 'invent' ? '' : `<b>${done}/${prog.total}</b>`;
      el.innerHTML = `<div class="prog">
        <span class="prog-world">${escapeHtml(prog.world || 'New batch')}</span>${bar}${count}
        <span class="prog-note">${escapeHtml(prog.summary || prog.note)}</span>
        ${prog.timer ? `<span class="prog-time">${fmtElapsed(Date.now() - prog.t0)}${running ? ` · ${running} rendering` : ''}</span>` : ''}
      </div>`;
    }
    function progStart(count) {
      prog.t0 = Date.now(); prog.slots = []; prog.titles = []; prog.world = ''; prog.stage = 'invent';
      prog.total = count; prog.summary = ''; prog.note = `Choosing a territory and writing ${count} scenes…`;
      document.getElementById('statusText').dataset.idle = '';
      clearInterval(prog.timer); prog.timer = setInterval(progRender, 1000); progRender();
    }
    function progStop(summary) { clearInterval(prog.timer); prog.timer = null; prog.summary = summary; progRender(); }
    function setGenerating(on) {
      ['worldSelect', 'directionInput', 'batchCountSelect', 'modelSelect', 'generateBtn'].forEach(id => { document.getElementById(id).disabled = on; });
    }

    async function generateImages() {
      if (!ensureKimiReady()) return;

      const model = document.getElementById('modelSelect').value;
      const kimiModel = document.getElementById('kimiModelSelect').value;
      const count = parseInt(document.getElementById('batchCountSelect').value, 10) || 4;
      const worldChoice = document.getElementById('worldSelect').value;
      const direction = document.getElementById('directionInput').value.trim();
      if (worldChoice === '__custom__' && !direction) {
        setStatus('Describe your custom territory first, e.g. fog, clouds, rain, lightning.');
        document.getElementById('directionInput').focus();
        return;
      }
      setGenerating(true);
      progStart(count);
      let ran = false;

      try {
        const invRes = await fetch('/api/invent-prompts', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ count, pair: false, kimi_model: kimiModel, world: worldChoice, direction })
        });
        const invData = await invRes.json();
        if (invData.needs_kimi_key) {
          progStop('');
          setStatus('');
          ensureKimiReady();
          return;
        }
        if (!invData.ok || !invData.ideas) {
          throw new Error(invData.error || 'Prompt generation failed');
        }

        const ideas = invData.ideas;
        ran = true;
        let added = 0;
        let trashedByQa = 0;
        let lastRejectReason = '';
        let authFailed = false;
        prog.stage = 'render';
        prog.total = ideas.length;
        prog.world = (ideas[0] && ideas[0].world) || '';
        prog.slots = ideas.map(() => 'wait');
        prog.titles = ideas.map(i => i.title);
        prog.note = `${formatModelShort(model)} · 3 at a time`;
        progRender();

        const runOne = async (item, idx) => {
          if (authFailed) { prog.slots[idx] = 'err'; return; }
          prog.slots[idx] = 'run';
          prog.note = `Rendering “${item.title}”`;
          progRender();
          const genRes = await fetch('/api/generate-image', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              title: item.title, prompt: item.prompt, guide: item.guide || 'dark',
              world: item.world, idea: item.idea, model
            })
          });
          const genData = await genRes.json();
          if (genData.needs_auth) { authFailed = true; prog.slots[idx] = 'err'; lastRejectReason = 'Krea login needed'; return; }
          if (!genData.ok) { prog.slots[idx] = 'err'; lastRejectReason = genData.error || 'Generation failed'; return; }
          if (genData.qa_passed) {
            added++;
            prog.slots[idx] = 'ok';
            prog.note = `Added “${item.title}”`;
          } else {
            trashedByQa++;
            prog.slots[idx] = 'trash';
            if (genData.qa_issues && genData.qa_issues.length) lastRejectReason = genData.qa_issues[0];
            prog.note = `“${item.title}” failed the logo check → Trash`;
          }
          progRender();
          await loadState();
        };
        // 3 in parallel
        const queue = ideas.map((item, idx) => [item, idx]);
        await Promise.all([0, 1, 2].map(async () => {
          while (queue.length) {
            const [item, idx] = queue.shift();
            try { await runOne(item, idx); } catch (e) { prog.slots[idx] = 'err'; lastRejectReason = e.message; }
          }
        }));
        loadWorlds();
        const failed = prog.slots.filter(x => x === 'err').length;
        const parts = [`${added} added`];
        if (trashedByQa) parts.push(`${trashedByQa} in Trash (${lastRejectReason})`);
        if (failed) parts.push(`${failed} failed (${lastRejectReason})`);
        progStop(`Done — ${parts.join(', ')}`);
      } catch (e) {
        progStop(`Error: ${e.message}`);
      } finally {
        setGenerating(false);
        if (ran) {  // the direction was for this batch only
          document.getElementById('directionInput').value = '';
          saveSettings();
        }
      }
    }

    async function saveCritic() {
      await fetch('/api/save-settings', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ critic_enabled: document.getElementById('criticOn').checked, critic_autotrash: document.getElementById('criticTrash').checked })
      });
    }

    async function loadModelStats() {
      try {
        const data = await (await fetch('/api/stats')).json();
        const rows = Object.entries(data.models)
          .filter(([, s]) => s.n > 0)
          .sort((a, b) => b[1].score - a[1].score)
          .map(([m, s]) => `${formatModelShort(m)}: ${s.n} gen · kept ${s.kept} · 🗑 ${s.trashed} · QA✗ ${s.qa_failed}`);
        document.getElementById('modelStats').innerHTML = rows.map(escapeHtml).join('<br>') || 'No data yet';
      } catch (e) {}
    }

    async function reconnectKrea() {
      await fetch('/api/krea-auth', { method: 'POST', body: '{}' });
      setStatus('Opened browser for Krea MCP OAuth...');
    }

    async function exportVideo() {
      const btn = document.getElementById('exportBtn');
      btn.disabled = true;
      btn.textContent = 'Rendering...';
      try {
        const res = await fetch('/api/export-video', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            bpm: parseInt(document.getElementById('bpmSlider').value, 10),
            multiple: parseFloat(document.getElementById('multSelect').value),
            invert_mode: document.getElementById('invertSelect').value,
            zoom_mode: document.getElementById('zoomSelect').value,
            zoom_amount: parseFloat(document.getElementById('zoomAmt').value) || 0,
            total_seconds: 10
          })
        });
        const data = await res.json();
        if (data.ok) {
          const stageImg = document.getElementById('stageImg');
          const stageVideo = document.getElementById('stageVideo');
          stageImg.style.display = 'none';
          stageVideo.style.display = 'block';
          stageVideo.src = data.video_url;
          stageVideo.play();
          setStatus('Exported MP4.');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Export MP4';
      }
    }

    restoreSettings();
    updateFx();
    updateTempo();
    ['batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput'].forEach(id => document.getElementById(id).addEventListener('change', saveSettings));
    document.getElementById('worldSelect').addEventListener('change', () => { document.getElementById('directionInput').value = ''; saveSettings(); updateDirectionHint(); });
    loadWorlds();
    (async () => {
      const slow = setTimeout(() => { document.getElementById('loaderMsg').textContent = 'Still loading (checking new images)…'; }, 4000);
      try {
        await loadState();
      } catch (e) {
        document.getElementById('loaderMsg').textContent = 'Could not reach the server. Is it running? Retrying…';
        setTimeout(() => location.reload(), 3000);
        return;
      } finally {
        clearTimeout(slow);
      }
      const l = document.getElementById('loader');
      l.classList.add('done');
      setTimeout(() => l.remove(), 400);
    })();
    setInterval(pollState, 5000);

    // Live reload: the server's boot id changes on restart, html changes when index.html is edited.
    (() => {
      let seen = null;
      setInterval(async () => {
        try {
          const v = await (await fetch('/api/version', { cache: 'no-store' })).json();
          const sig = v.boot + ':' + v.html;
          if (seen && sig !== seen) location.reload();
          seen = sig;
        } catch (e) {}  // server restarting: try again next tick
      }, 1500);
    })();
  

// Inline handlers in the markup (onclick=...) need these on window now that the code is an ES module.
Object.assign(window, {
  closeTwinDialog,
  copyPromptText,
  exportVideo,
  flashPlate,
  generateImages,
  makeTwin,
  onDragEnd,
  onDragLeave,
  onDragOver,
  onDragStart,
  onDrop,
  openTwinDialog,
  previewPlate,
  reconnectKrea,
  saveCritic,
  saveKimiSettings,
  saveKimiSettingsDebounced,
  setTrash,
  setTrashView,
  startTwins,
  togglePlay,
  togglePromptOverlay,
  toggleReticle,
  toggleSettings,
  toggleTwinSel,
  twinSelectAll,
  updateTempo,
  updateFx,
});
