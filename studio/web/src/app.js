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
    // a toast can carry one action (e.g. Undo after trashing the image on screen)
    function setStatus(msg, action) {
      const t = document.getElementById('toast');
      clearTimeout(toastTimer);
      if (!msg) { t.textContent = ''; t.classList.remove('show'); return; }
      t.textContent = msg;
      if (action) {
        const b = document.createElement('button');
        b.textContent = action.label;
        b.onclick = () => { t.classList.remove('show'); action.run(); };
        t.appendChild(b);
      }
      t.classList.add('show');
      toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 4000);
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
      sequences = data.sequences || [];
      activeSeq = data.active_sequence || null;

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
      if (typeof drawInfo === 'function') drawInfo();
      refreshIdle();
      document.getElementById('tabSelection').className = showTrash ? '' : 'on';
      document.getElementById('tabTrash').className = showTrash ? 'on' : '';

      renderSequences();
      renderGrid();
      renderFilmstrip();
      restartLoop();
      if (!isPlaying) drawFrame();
      lastSig = plateSig(plates);
    }

    // Auto-refresh: pick up new/trashed plates without a manual reload.
    let lastSig = null;
    const plateSig = list => list.map(p => `${p.filename}|${p.trashed ? 1 : 0}`).join(',');

    async function pollState() {
      if (document.hidden || draggedFilename || document.querySelector('.prompt-overlay.open')) return;
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

    // the images in the edit: the shown ones, cut at the active order's cut_off when the AI picked "best N"
    function activeCutOff() {
      const cur = sequences.find(s => s.id === activeSeq);
      return cur && cur.cut_off ? cur.cut_off : null;
    }
    function activePlates() {
      const shown = plates.filter(p => !p.trashed);
      const n = activeCutOff();
      return n ? shown.slice(0, n) : shown;
    }

    function visiblePlates() {
      const num = p => parseInt(p.filename, 10) || 0;
      return showTrash
        // newest trashed first; plates trashed before timestamps existed fall back to creation number
        ? plates.filter(p => p.trashed).sort((a, b) => (b.trashed_at || 0) - (a.trashed_at || 0) || num(b) - num(a))
        : plates.filter(p => !p.trashed);
    }

    // ---- trash: select, delete selected, empty ----
    // ---- AI order ----
    function toggleAiPanel(e) {
      if (e) e.stopPropagation();
      const panel = document.getElementById('aiPanel');
      panel.hidden = !panel.hidden;
    }
    document.addEventListener('click', () => { const p = document.getElementById('aiPanel'); if (p) p.hidden = true; });

    async function startAiOrder() {
      if (generating) { setStatus('Wait for image generation to finish before ordering with AI.'); return; }
      if (aiRunning) return;
      if (!ensureKimiReady()) return;
      const shown = plates.filter(p => !p.trashed).length;
      if (shown < 2) { setStatus('Keep at least two images before ordering.'); return; }
      const existing = sequences.find(s => s.kind === 'ai');
      if (existing) {  // redoing replaces the AI order, so always ask first
        document.getElementById('aiPanel').hidden = true;
        const lost = existing.edited ? ' This also drops the changes you made to it.' : '';
        if (!(await askConfirm('Replace the current AI order?', `Redoing makes a fresh AI order and replaces the one you have.${lost} Your Manual order is not touched.`, 'Redo with AI'))) return;
      }
      const body = {
        length: parseInt(document.getElementById('aiLength').value, 10) || null,
        direction: document.getElementById('aiDirection').value.trim(),
      };
      document.getElementById('aiPanel').hidden = true;
      const start = await (await fetch('/api/order-ai', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) })).json();
      if (start.needs_kimi_key) { ensureKimiReady(); return; }
      if (!start.ok) { setStatus(start.error || 'Could not start the AI order.'); return; }
      const steps = start.steps || [];
      aiRunning = true;
      applyLocks();
      renderSequences();
      document.getElementById('statusText').dataset.idle = '';
      Object.assign(prog, { t0: Date.now(), stage: 'render', world: 'AI order', total: steps.length, titles: steps, why: [], slots: steps.map((_, i) => (i === 0 ? 'run' : 'wait')), summary: '', note: steps[0] || '' });
      clearInterval(prog.timer); prog.timer = setInterval(progRender, 1000); progRender();
      try {
        for (;;) {
          await new Promise(r => setTimeout(r, 700));
          const job = await (await fetch(`/api/order-ai-status?job=${encodeURIComponent(start.job)}`)).json();
          if (!job.ok && job.error) throw new Error(job.error);
          if (job.done) {
            if (job.error) throw new Error(job.error);
            prog.slots = steps.map(() => 'ok');
            progStop(`Done — ${job.sequence.name}: ${job.sequence.summary}`);
            await loadState();
            break;
          }
          prog.slots = steps.map((_, i) => (i < job.step ? 'ok' : i === job.step ? 'run' : 'wait'));
          prog.note = `${job.stage}${job.note ? ' · ' + job.note : ''}`;
          progRender();
        }
      } catch (e) {
        progStop(`AI order failed: ${e.message}`);
      } finally {
        aiRunning = false;
        renderSequences();
        applyLocks();
      }
    }

    // ---- the two orders of the selection: Manual (yours) and AI ----
    let sequences = [];
    let activeSeq = null;
    function renderSequences() {
      const seg = document.getElementById('orderSeg');
      const label = q => (q.cut_off && q.cut_off < q.count ? `${q.cut_off} of ${q.count}` : q.count);
      const manual = sequences.find(q => q.kind === 'manual');
      const ai = sequences.find(q => q.kind === 'ai');
      seg.innerHTML = [manual, ai].filter(Boolean).map(q =>
        `<button data-seq="${q.id}" class="${q.id === activeSeq ? 'on' : ''}" onclick="switchSequence('${q.id}')" ${aiRunning ? 'disabled' : ''}>${q.kind === 'ai' ? '✨ AI' : '✋ Manual'} (${label(q)})</button>`).join('');
      const cur = sequences.find(q => q.id === activeSeq);
      const summary = cur && cur.kind === 'ai' && cur.summary ? cur.summary : '';
      document.getElementById('seqSummary').textContent = summary;
      document.getElementById('aiNote').hidden = !(cur && cur.kind === 'ai') || showTrash;
      document.getElementById('makeManual').disabled = aiRunning;
      document.getElementById('resetAi').hidden = !(cur && cur.kind === 'ai' && cur.edited);
      document.getElementById('aiBtn').textContent = ai ? '↻ Redo with AI…' : '✨ Order with AI…';
      document.getElementById('seqBox').hidden = showTrash;
    }
    async function seqCall(payload) {
      const res = await (await fetch('/api/sequence', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) })).json();
      if (!res.ok) { setStatus(res.error || 'Could not do that.'); return false; }
      await loadState();
      return true;
    }
    async function switchSequence(id) {
      if (blockedByAi() || id === activeSeq) return;
      const ok = await seqCall({ action: 'activate', id });
      if (ok && isPlaying) { cutPos = 0; lastTick = performance.now(); currentIdx = 0; if (droneLive.playing) droneLive.restart(synthParams(), synthStartsSec()); }   // the player follows: start the other order from its first image
      return ok;
    }
    function resetAi() { return blockedByAi() ? undefined : seqCall({ action: 'reset' }); }
    async function makeManual() {
      if (blockedByAi()) return;
      if (!(await askConfirm('Replace your Manual order?', "Your current Manual order is replaced by a copy of this AI order, including any changes you made to it. The AI order stays as it is. This can't be undone.", 'Replace Manual'))) return;
      if (await seqCall({ action: 'make_manual' })) setStatus('Your Manual order is now a copy of the AI order.');
    }
    function includeAll() { return blockedByAi() ? undefined : seqCall({ action: 'include_all' }); }

    let trashSel = new Set();
    let lastSel = null;
    function cardClick(e, filename) {
      if (!showTrash) { previewPlate(filename); return; }
      const list = visiblePlates().map(p => p.filename);
      if (e.shiftKey && lastSel && list.includes(lastSel)) {
        const [a, b] = [list.indexOf(lastSel), list.indexOf(filename)].sort((x, y) => x - y);
        list.slice(a, b + 1).forEach(f => trashSel.add(f));
      } else if (trashSel.has(filename)) {
        trashSel.delete(filename);
      } else {
        trashSel.add(filename);
      }
      lastSel = filename;
      syncSelection();
    }
    function syncSelection() {
      document.querySelectorAll('.card[data-filename]').forEach(el => el.classList.toggle('sel', trashSel.has(el.dataset.filename)));
      updateTrashBar();
    }
    function updateTrashBar() {
      const trashed = plates.filter(p => p.trashed).map(p => p.filename);
      trashSel = new Set([...trashSel].filter(f => trashed.includes(f)));
      document.getElementById('trashBar').hidden = !(showTrash && trashed.length);
      document.getElementById('trashSelCount').textContent = `${trashSel.size} selected`;
      document.getElementById('trashDelSel').disabled = aiRunning || trashSel.size === 0;
      document.getElementById('trashDelSel').textContent = trashSel.size ? `Delete ${trashSel.size} selected…` : 'Delete selected…';
      document.getElementById('trashSelAll').textContent = trashSel.size && trashSel.size === trashed.length ? 'Clear selection' : 'Select all';
      document.getElementById('trashEmpty').textContent = `Empty trash (${trashed.length})…`;
    }
    function selectAllTrash() {
      const all = plates.filter(p => p.trashed).map(p => p.filename);
      trashSel = trashSel.size === all.length ? new Set() : new Set(all);
      syncSelection();
    }

    let confirmResolve = null;
    function askConfirm(title, body, yesLabel) {
      document.getElementById('confirmTitle').textContent = title;
      document.getElementById('confirmBody').textContent = body;
      document.getElementById('confirmYes').textContent = yesLabel;
      document.getElementById('confirmModal').classList.add('open');
      return new Promise(res => { confirmResolve = res; });
    }
    function confirmAnswer(yes) {
      document.getElementById('confirmModal').classList.remove('open');
      if (confirmResolve) confirmResolve(yes);
      confirmResolve = null;
    }
    function showBusy(msg) { document.getElementById('busyMsg').textContent = msg; document.getElementById('busy').hidden = false; }
    function hideBusy() { document.getElementById('busy').hidden = true; }
    const KEEPS_LEARNING = 'The images are removed from disk for good. Your keep/trash history stays, so suggestions keep learning from them.';
    async function purge(payload, title, body, yesLabel) {
      if (blockedByAi()) return;
      if (!(await askConfirm(title, body, yesLabel))) return;
      const btns = ['trashDelSel', 'trashEmpty', 'trashSelAll'].map(id => document.getElementById(id));
      btns.forEach(b => { b.disabled = true; });
      const count = payload.all ? plates.filter(p => p.trashed).length : payload.filenames.length;
      purging = true;
      showBusy(`Deleting ${count} image${count === 1 ? '' : 's'}…`);
      try {
        const res = await (await fetch('/api/purge', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) })).json();
        if (!res.ok) throw new Error(res.error || 'delete failed');
        trashSel = new Set();
        setStatus(`Deleted ${res.deleted} image${res.deleted === 1 ? '' : 's'} (${res.freed_mb} MB freed).`);
        await loadState();
      } catch (e) {
        setStatus(`Delete failed: ${e.message}`);
      } finally {
        purging = false;
        hideBusy();
        btns.forEach(b => { b.disabled = false; });
        updateTrashBar();
      }
    }
    function deleteSelected() {
      const n = trashSel.size;
      if (!n) return;
      return purge({ filenames: [...trashSel] }, `Delete ${n} image${n === 1 ? '' : 's'} permanently?`, `This can't be undone. ${KEEPS_LEARNING}`, `Delete ${n}`);
    }
    function emptyTrash() {
      const n = plates.filter(p => p.trashed).length;
      if (!n) return;
      return purge({ all: true }, `Empty the trash (${n} images)?`, `Every image in the trash is deleted permanently. This can't be undone. ${KEEPS_LEARNING}`, `Delete all ${n}`);
    }

    function renderGrid() {
      const grid = document.getElementById('grid');
      const visible = visiblePlates();

      const cutOff = showTrash ? null : activeCutOff();
      grid.innerHTML = visible.map((p, i) => `${cutOff && i === cutOff && i < visible.length ? `<div class="edit-divider">left out of this edit (${visible.length - cutOff}) <button onclick="includeAll()">Include them all</button></div>` : ''}
        <div class="card"
             id="card-${CSS.escape(p.filename)}"
             draggable="${!showTrash}"
             data-filename="${p.filename}"
             ondragstart="onDragStart(event, '${p.filename}')"
             ondragover="onDragOver(event)"
             ondragleave="onDragLeave(event)"
             ondrop="onDrop(event, '${p.filename}')"
             ondragend="onDragEnd(event)"
             onclick="cardClick(event, '${p.filename}')">
          <div class="card-thumb">
            <img src="${p.thumb || p.url}" loading="lazy" decoding="async" />
            <button class="info-btn" title="View prompt & model" onclick="togglePromptOverlay(event, '${p.filename}')">i</button>
            <div class="card-actions">
              ${p.trashed
                ? `<button class="action-btn" onclick="setTrash(event, '${p.filename}', false)">↩️ Restore</button>`
                : `<button class="action-btn trash-btn" title="Move to trash" onclick="setTrash(event, '${p.filename}', true)">🗑️</button>`
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

                ${p.critic ? `<span class="card-model-badge" title="${escapeHtml(p.critic.reason)}">AI ${p.critic.mean}</span>` : ''}
                ${p.trash_reason ? `<span class="card-model-badge" style="background:rgba(244,63,94,0.22);border-color:rgba(244,63,94,0.5);color:#fda4af;" title="${escapeHtml(p.trash_reason)}">${escapeHtml(p.trash_reason.slice(0, 40))}</span>` : ''}
                ${!p.qa_passed ? `<span class="card-model-badge" style="background:rgba(244,63,94,0.22);border-color:rgba(244,63,94,0.5);color:#fda4af;" title="${escapeHtml((p.qa_issues || []).join(', '))}">QA Flagged</span>` : ''}
              </div>
            </div>
          </div>
        </div>
      `).join('');
      syncSelection();
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
      if (aiRunning) { e.preventDefault(); return; }
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
      if (aiRunning || !draggedFilename || draggedFilename === targetFilename) return;

      const dragged = draggedFilename;
      const target = targetFilename;
      const fromIdx = plates.findIndex(p => p.filename === dragged);
      const toIdx = plates.findIndex(p => p.filename === target);
      if (fromIdx === -1 || toIdx === -1) return;

      const [moved] = plates.splice(fromIdx, 1);
      plates.splice(toIdx, 0, moved);

      const res = await (await fetch('/api/reorder', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ order: plates.map(p => p.filename) })
      })).json();
      await loadState();
    }
    function onDragEnd(e) {
      e.currentTarget.classList.remove('dragging');
      document.querySelectorAll('.card.drag-over').forEach(el => el.classList.remove('drag-over'));
      draggedFilename = null;
    }

    // clicking an image in Curate puts the film's playhead on it (an image left out of the edit is only shown)
    function previewPlate(filename) {
      const i = activePlates().findIndex(x => x.filename === filename);
      if (i >= 0) { jumpToPlate(i); return; }
      const stageImg = document.getElementById('stageImg');
      stageImg.style.display = 'block';
      clearFx();
      const p = plates.find(x => x.filename === filename);
      if (p) stageImg.src = p.preview || p.url;
    }

    // ---- the two modes: Curate (the images) and Film (the result); switching keeps everything ----
    let mode = 'curate';
    function setMode(m) {
      mode = m === 'film' ? 'film' : 'curate';
      document.body.dataset.mode = mode;
      document.getElementById('modeCurate').setAttribute('aria-pressed', String(mode === 'curate'));
      document.getElementById('modeFilm').setAttribute('aria-pressed', String(mode === 'film'));
      try { localStorage.setItem('studioMode', mode); } catch (e) {}
      if (mode === 'film') scrollFilmstripTo(currentIdx);
    }
    // Tab switches the mode and Space plays, except while typing in a field (Tab still moves between fields there)
    function typingIn(t) {
      if (!t || !t.tagName) return false;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
      return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type);
    }
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (typingIn(e.target) || document.getElementById('confirmModal').classList.contains('open')) return;
      if (e.key === 'Tab') { e.preventDefault(); if (e.target && e.target.blur) e.target.blur(); setMode(mode === 'film' ? 'curate' : 'film'); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    }
    document.addEventListener('keydown', onKey);
    // a button clicked with the mouse gives its focus back, so Space plays instead of pressing it again
    document.addEventListener('click', e => { const b = e.target && e.target.closest && e.target.closest('button'); if (b && e.detail > 0) b.blur(); }, true);

    // ---- segmented controls: buttons drawn from a hidden <select>, which stays the source of truth (saved, read, tested) ----
    function buildSegs() {
      document.querySelectorAll('select.seg-src').forEach(sel => {
        const box = document.createElement('div');
        box.className = 'segctl'; box.setAttribute('role', 'group'); box.dataset.for = sel.id; box.title = sel.title;
        [...sel.options].forEach(o => {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = o.textContent; b.dataset.value = o.value;
          b.onclick = () => { if (sel.value === o.value) return; sel.value = o.value; sel.dispatchEvent(new Event('change')); syncSegs(); };
          box.appendChild(b);
        });
        sel.after(box);
      });
      syncSegs();
    }
    function syncSegs() {
      document.querySelectorAll('.segctl').forEach(box => {
        const sel = document.getElementById(box.dataset.for);
        box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === sel.value)));
      });
    }
    // the orange part of a slider, up to its thumb
    function paintRanges() {
      document.querySelectorAll('input[type="range"]').forEach(el => {
        const lo = parseFloat(el.min) || 0, hi = parseFloat(el.max) || 100;
        el.style.setProperty('--fill', `${hi > lo ? ((parseFloat(el.value) - lo) / (hi - lo)) * 100 : 0}%`);
      });
    }
    document.addEventListener('input', e => { if (e.target && e.target.type === 'range') paintRanges(); });

    // ---- the film strip: the edit in order; click to jump ----
    function renderFilmstrip() {
      const strip = document.getElementById('filmstrip');
      const active = activePlates();
      strip.innerHTML = active.map((p, i) => `<button type="button" data-i="${i}" title="${i + 1} · ${escapeHtml(p.title)}" aria-label="Jump to image ${i + 1}" style="background-image:url('${(p.thumb || p.url || '').replace(/'/g, '%27')}')"></button>`).join('');
      shownIdx = -1;
      const n = active.length, cut = activeCutOff();
      document.getElementById('selNote').textContent = n ? `${n} in the ${cut ? 'edit' : 'selection'}` : '';
      document.getElementById('filmHint').textContent = n ? `${n} images in film order · click to jump` : '';
    }
    function filmstripClick(e) {
      const b = e.target && e.target.closest ? e.target.closest('button[data-i]') : null;
      if (b) jumpToPlate(parseInt(b.dataset.i, 10));
    }
    let shownIdx = -1;
    function markFilmstrip(i) {
      if (i === shownIdx) return;
      const strip = document.getElementById('filmstrip');
      const kids = strip.children || [];
      if (kids[shownIdx]) kids[shownIdx].classList.remove('cur');
      if (kids[i]) kids[i].classList.add('cur');
      shownIdx = i;
      const p = activePlates()[i];
      document.getElementById('curTitle').textContent = p ? `${i + 1} · ${p.title}` : '';
      if (mode === 'film') scrollFilmstripTo(i);
    }
    function scrollFilmstripTo(i) {
      const strip = document.getElementById('filmstrip');
      const el = (strip.children || [])[i];
      if (!el || !strip.clientWidth) return;
      const x = el.offsetLeft, w = strip.clientWidth;
      if (x < strip.scrollLeft + 65 || x > strip.scrollLeft + w - 40) strip.scrollLeft = Math.max(0, x - 65 - w / 3);
    }
    function jumpToPlate(i) {
      const active = activePlates();
      if (!active.length) return;
      i = Math.max(0, Math.min(active.length - 1, i | 0));
      const paired = ['mono', 'colour'].includes(document.getElementById('invertSelect').value);
      cutPos = timelineFor(active.length)[i * (paired ? 2 : 1)];
      lastTick = performance.now();
      if (isPlaying && droneLive.playing) droneLive.seek(cutPos / 30);
      drawFrame();
    }
    // the image on screen goes to the Trash; the toast's Undo puts it back where it was
    async function trashCurrent() {
      if (blockedByAi()) return;
      const p = activePlates()[currentIdx];
      if (!p) return;
      const order = plates.filter(x => !x.trashed).map(x => x.filename);
      await fetch('/api/trash', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename: p.filename, trashed: true }) });
      await loadState();
      setStatus(`“${p.title}” moved to Trash`, { label: 'Undo', run: () => untrash(p.filename, order) });
    }
    async function untrash(filename, order) {
      if (blockedByAi()) return;
      await fetch('/api/trash', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename, trashed: false }) });
      await fetch('/api/reorder', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ order }) });
      await loadState();
    }

    // ---- what is on screen when (mirrored in studio/cutplan.py; tests keep the two in step) ----
    // A "cut" is one hold of the picture. With invert on, every image takes two cuts: normal, then inverted.
    function planAt(cutPos, nPlates, invertMode, starts) {
      let cut = Math.floor(cutPos);
      let p = cutPos - cut;
      if (starts) [cut, p] = cutAt(starts, cutPos);
      const paired = invertMode === 'mono' || invertMode === 'colour';
      return { cut, p, plate: (paired ? Math.floor(cut / 2) : cut) % nPlates, inverted: paired && cut % 2 === 1 };
    }
    // ---- the cut timeline: where each cut starts (every cut is one base cut) ----
    function cutAt(starts, t) {
      const total = starts[starts.length - 1];
      t = total > 0 ? ((t % total) + total) % total : 0;
      let lo = 0, hi = starts.length - 2;
      while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (starts[mid] <= t) lo = mid; else hi = mid - 1; }
      const span = starts[lo + 1] - starts[lo];
      return [lo, span > 0 ? (t - starts[lo]) / span : 0];
    }
    function rhythmMode() { return document.getElementById('rhythmSelect').value === 'variable' ? 'variable' : 'flat'; }
    function variableParams() {
      return {
        start_ms: parseInt(document.getElementById('startMsRange').value, 10) || 100,
        end_ms: parseInt(document.getElementById('endMsRange').value, 10) || 600,
        ramp: parseInt(document.getElementById('rampRange').value, 10) || 12,
        at: document.getElementById('atSelect').value === 'start' ? 'start' : 'end'
      };
    }
    // Variable speed: where each cut starts, in frames (mirrors cutplan.variable_timeline: hold one speed, then change geometrically over `ramp` cuts)
    function variableStarts(nCuts, startMs, endMs, ramp, at) {
      const clamp = v => Math.min(1500, Math.max(50, v));
      const a = Math.log(clamp(startMs)), b = Math.log(clamp(endMs));
      const nRamp = Math.max(1, Math.min(nCuts, Math.min(200, Math.max(2, Math.trunc(ramp)))));
      const starts = [0];
      for (let i = 0; i < nCuts; i++) {
        let u;
        if (at === 'start') u = nRamp > 1 ? Math.min(1, i / (nRamp - 1)) : 1;
        else { const j = i - (nCuts - nRamp); u = j < 0 ? 0 : (j + 1) / nRamp; }
        starts.push(starts[i] + Math.max(1, (Math.exp(a + (b - a) * u) * 30) / 1000));
      }
      return starts;
    }
    // Two timelines, both in frames (30 per second). The BASE is what the music follows: the beat grid (Flat) or the variable run.
    // The PICTURE cuts `multiple` times per base cut, and only the picture feels the multiple (mirrors cutplan.rhythm_timeline).
    function subdivideStarts(base, multiple, nCuts) {
      const m = Math.max(0.05, multiple), nBase = base.length - 1, out = [];
      for (let k = 0; k <= nCuts; k++) {
        const x = Math.min(k / m, nBase), i = Math.min(Math.floor(x), nBase - 1);
        const v = nBase >= 1 ? base[i] + (base[i + 1] - base[i]) * (x - i) : 0;
        out.push(out.length ? Math.max(v, out[out.length - 1] + 1) : v);
      }
      return out;
    }
    // the tempo slider is 1 to 500 BPM; a stored or odd value is kept inside that
    function bpmValue() { const v = parseFloat(document.getElementById('bpmInput').value); return Number.isFinite(v) ? Math.min(500, Math.max(1, v)) : 120; }
    function followCuts() { return !!document.getElementById('followCuts').checked; }
    let timelineCache = { key: '', value: null };
    function rhythmFor(nPlates) {
      const invert = document.getElementById('invertSelect').value;
      const paired = invert === 'mono' || invert === 'colour';
      const nCuts = nPlates * (paired ? 2 : 1);
      const mult = parseFloat(document.getElementById('multSelect').value) || 1;
      const bpm = bpmValue();
      const follow = followCuts();
      const v = rhythmMode() === 'variable' ? variableParams() : null;
      const key = `${nCuts}|${mult}|${v ? `${v.start_ms}|${v.end_ms}|${v.ramp}|${v.at}` : `flat|${bpm}`}|${follow}`;
      if (timelineCache.key !== key) {
        const nBase = Math.max(1, Math.ceil(nCuts / Math.max(0.05, mult) - 1e-9));
        const base = v ? variableStarts(nBase, v.start_ms, v.end_ms, v.ramp, v.at) : Array.from({ length: nBase + 1 }, (_, i) => (i * 1800) / bpm);
        const pic = subdivideStarts(base, mult, nCuts), end = pic[nCuts];
        // the music's cuts: the base cuts that fall inside the clip, or (if the user asks) every picture cut
        const audio = follow ? pic.map(f => f / 30) : base.filter(f => f < end - 1e-6).concat([end]).map(f => f / 30);
        if (audio.length < 2) audio.push(audio[0] + 0.1);                                       // no images: still a valid (empty) clip
        timelineCache = { key, value: { pic, audio, base, end, landAt: pic[Math.max(0, nCuts - (paired ? 2 : 1))] / 30 } };
      }
      return timelineCache.value;
    }
    function timelineFor(nPlates) { return rhythmFor(nPlates).pic; }

    // ---- music: the synthesized drone (WebAudio, see drone.js) ----
    function musicOn() { return document.getElementById('musicSelect').value === 'on'; }
    function unit(id) { return (parseInt(document.getElementById(id).value, 10) || 0) / 100; }
    // the drone is made in the page (WebAudio): its settings, and where each cut starts in seconds
    function synthParams() {
      const paired = ['mono', 'colour'].includes(document.getElementById('invertSelect').value);
      return {
        pulse: unit('pulseRange'), low: unit('lowRange'), bright: unit('brightRange'), width: unit('widthRange'), space: unit('spaceRange'), power: unit('powerRange'),
        pitch: unit('pitchRange'), chord: parseInt(document.getElementById('chordSelect').value, 10) || 0, movement: unit('movementRange'), echo: unit('echoRange'),
        wash: unit('washRange'), ring: unit('ringRange'), shimmer: unit('shimmerRange'),
        hitType: parseInt(document.getElementById('hitTypeSelect').value, 10) || 0, hit: unit('hitRange'), hitOn: parseInt(document.getElementById('hitOnSelect').value, 10) || 0,
        arp: unit('arpRange'), arpSteps: parseInt(document.getElementById('arpStepsSelect').value, 10) || 0, arpRate: parseInt(document.getElementById('arpRateSelect').value, 10) || 0,
        dynamics: parseInt(document.getElementById('dynSelect').value, 10) || 0,
        subWave: parseInt(document.getElementById('subWaveSelect').value, 10) || 0, padWave: parseInt(document.getElementById('padWaveSelect').value, 10) || 0,
        seed: parseInt(document.getElementById('seedVal').value, 10) || 7, paired,
        landAt: activePlates().length ? rhythmFor(activePlates().length).landAt : undefined
      };
    }
    function synthStartsSec() { return rhythmFor(activePlates().length).audio; }
    // the export panel: idle (the button), busy (a bar with what is happening), ready (downloaded, with a link to get it again)
    function setExportState(state) { document.getElementById('exportDock').dataset.state = state; }
    function setMusicState(kind, text) {
      const el = document.getElementById('musicState');
      el.textContent = text || 'Rendering on the server…';
      el.className = kind === 'err' ? 'err' : '';
    }
    function fmtDuration(sec) { return sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : `${Math.round(sec)} s`; }
    function updateMusic() {
      const on = musicOn();
      document.getElementById('synthBox').hidden = !on;
      document.getElementById('soundOffNote').hidden = on;
      document.getElementById('soundBtn').setAttribute('aria-pressed', String(on));
      document.getElementById('soundLabel').textContent = on ? 'Sound on' : 'Sound off';
      for (const k of ['pulse', 'low', 'bright', 'width', 'space', 'power', 'pitch', 'movement', 'echo', 'wash', 'ring', 'shimmer', 'hit', 'arp']) document.getElementById(`${k}Val`).textContent = document.getElementById(`${k}Range`).value;
      syncSegs(); paintRanges();
      saveSettings();
      musicChanged();
    }
    // the transport's sound button: the same switch as Source
    function toggleSound() {
      document.getElementById('musicSelect').value = musicOn() ? 'off' : 'on';
      updateMusic();
    }
    // the four groups of sound settings, one shown at a time
    const SOUND_GROUPS = ['bed', 'tone', 'texture', 'notes'];
    function showSoundGroup(g) {
      if (!SOUND_GROUPS.includes(g)) g = 'bed';
      for (const k of SOUND_GROUPS) {
        const id = k[0].toUpperCase() + k.slice(1);
        document.getElementById(`group${id}`).hidden = k !== g;
        document.getElementById(`soundTab${id}`).setAttribute('aria-selected', String(k === g));
      }
      document.getElementById('soundGroupVal').value = g;
      saveSettings();
    }

    // ---- Random ----
    // a random sound within what works: every setting is drawn from a range that stays a dark, heavy drone (the ranges are the taste)
    const RANDOM_RANGES = { pulse: [30, 90], low: [65, 100], power: [30, 90], space: [5, 85], bright: [0, 55], width: [30, 100], pitch: [0, 100], movement: [15, 85], echo: [0, 55], wash: [0, 55], ring: [0, 45], shimmer: [0, 45], hit: [30, 70], arp: [20, 45] };
    // Characters: kinds of film, modelled on the references, each a set of tighter ranges for the rhythm, the look and the sound (all inside RANDOM_RANGES).
    // Random rolls inside the chosen one ("Any": a different one each time); the rules below then make the parts agree.
    const CHARACTERS = {
      landing: { name: 'Landing',                                          // Ecwora / Soiltone: fast hold, then a slow landing, grey inverted copies
        rhythm: { mode: 'variable', start: [60, 120], end: [450, 900], ramp: [8, 16], at: 'end', mult: ['1', '1', '2'] },
        look: { invert: ['mono', 'mono', 'off'], zoom: ['out', 'off'], amount: [0.3, 1.2] },
        sound: { pulse: [40, 75], low: [75, 100], power: [40, 80], space: [50, 85], bright: [0, 35], width: [50, 100], pitch: [0, 45], movement: [20, 60], echo: [0, 35], wash: [15, 55], ring: [0, 25], shimmer: [0, 25], hit: [30, 60], arp: [0, 35],
          chord: ['0', '0', '2'], subWave: ['0', '1'], padWave: ['0', '2'], hitType: ['0', '0', '1'], hitOn: ['3', '2'], dyn: ['2', '3'] } },
      pulse: { name: 'Pulse',                                              // Helione / Moverunion: a steady tempo, cut 2 or 4 to the beat
        rhythm: { mode: 'flat', bpm: [118, 150], mult: ['2', '4', '4'] },
        look: { invert: ['off', 'mono'], zoom: ['out', 'out', 'off'], amount: [0.2, 0.8] },
        sound: { pulse: [65, 90], low: [70, 100], power: [50, 90], space: [5, 35], bright: [10, 45], width: [30, 80], pitch: [20, 70], movement: [30, 70], echo: [0, 20], wash: [0, 25], ring: [0, 20], shimmer: [0, 20], hit: [40, 70], arp: [0, 30],
          chord: ['0', '1', '3'], subWave: ['0', '1'], padWave: ['0', '1'], hitType: ['2', '2', '1'], hitOn: ['1', '0'], dyn: ['0'] } },
      build: { name: 'Build',                                              // slow to fast, the notes rising with it
        rhythm: { mode: 'variable', start: [500, 900], end: [60, 110], ramp: [10, 20], at: 'start', mult: ['1', '2'] },
        look: { invert: ['off', 'colour', 'mono'], zoom: ['in', 'in', 'off'], amount: [0.4, 1.6] },
        sound: { pulse: [45, 80], low: [65, 95], power: [45, 85], space: [30, 65], bright: [20, 50], width: [40, 90], pitch: [30, 80], movement: [40, 85], echo: [0, 30], wash: [0, 30], ring: [0, 30], shimmer: [15, 40], hit: [35, 65], arp: [25, 45],
          chord: ['2', '3', '1'], subWave: ['0', '1', '2'], padWave: ['0', '3'], hitType: ['3', '0', '4'], hitOn: ['3', '2'], dyn: ['1'] } },
      float: { name: 'Float',                                              // slow and wide: a big room, wash, no hits
        rhythm: { mode: 'flat', bpm: [50, 80], mult: ['1', '2'] },
        look: { invert: ['off'], zoom: ['in', 'out'], amount: [0.3, 1.0] },
        sound: { pulse: [30, 45], low: [65, 90], power: [30, 55], space: [65, 85], bright: [0, 30], width: [70, 100], pitch: [0, 60], movement: [15, 45], echo: [15, 50], wash: [25, 55], ring: [0, 20], shimmer: [0, 30], hit: [30, 50], arp: [20, 35],
          chord: ['1', '3', '0'], subWave: ['0'], padWave: ['2', '2', '0'], hitType: ['0'], hitOn: ['0'], dyn: ['0', '2'] } },
      machine: { name: 'Machine',                                          // very fast cuts, metal and a square sub
        rhythm: { mode: 'flat', bpm: [150, 200], mult: ['4', '6', '8'] },
        look: { invert: ['colour', 'mono'], zoom: ['off'], amount: [0.2, 0.6] },
        sound: { pulse: [70, 90], low: [75, 100], power: [60, 90], space: [5, 30], bright: [25, 55], width: [30, 70], pitch: [30, 90], movement: [50, 85], echo: [0, 15], wash: [0, 15], ring: [20, 45], shimmer: [0, 20], hit: [45, 70], arp: [0, 30],
          chord: ['0', '1'], subWave: ['2', '2', '1'], padWave: ['1', '3'], hitType: ['3', '3', '4'], hitOn: ['3', '1'], dyn: ['0', '3'] } },
    };
    const rint = ([lo, hi]) => Math.round(lo + Math.random() * (hi - lo));
    const rpick = list => list[Math.floor(Math.random() * list.length)];
    const setv = (id, v) => { document.getElementById(id).value = String(v); };
    const getn = id => parseFloat(document.getElementById(id).value) || 0;
    // one step back from the last random (rhythm, look, sound or all): the values of every persisted control, restored as they were
    let randomBefore = null;
    const NOT_UNDONE = ['batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput', 'soundGroupVal', 'characterSelect'];
    const rememberForUndo = () => {
      randomBefore = {};
      PERSISTED.filter(id => !NOT_UNDONE.includes(id)).forEach(id => { const el = document.getElementById(id); if (el) randomBefore[id] = el.type === 'checkbox' ? el.checked : el.value; });
      document.getElementById('undoRandomBtn').disabled = false;
    };
    function undoRandom() {
      if (!randomBefore) return;
      for (const [id, v] of Object.entries(randomBefore)) { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } }
      randomBefore = null; document.getElementById('undoRandomBtn').disabled = true;
      updateTempo(); updateRhythm(); updateFx(); updateMusic();
    }
    function applyRhythm(r) {
      setv('rhythmSelect', r.mode);
      if (r.mode === 'flat') setv('bpmInput', rint(r.bpm));
      else { setv('startMsRange', Math.round(rint(r.start) / 10) * 10); setv('endMsRange', Math.round(rint(r.end) / 10) * 10); setv('rampRange', rint(r.ramp)); setv('atSelect', r.at); }
      setv('multSelect', rpick(r.mult));
    }
    function applyLook(l) { setv('invertSelect', rpick(l.invert)); setv('zoomSelect', rpick(l.zoom)); setv('zoomAmt', (l.amount[0] + Math.random() * (l.amount[1] - l.amount[0])).toFixed(1)); }
    function refreshVideo(quiet) { updateTempo(); updateRhythm(); updateFx(); if (!quiet) { saveSettings(); musicChanged(); } }
    // a random rhythm: a tempo (Flat) or a run that speeds up or slows down (Variable), and the Multiple
    function randomRhythm(quiet) {
      if (quiet !== true) rememberForUndo();
      if (Math.random() < 0.55) applyRhythm({ mode: 'flat', bpm: [60, 200], mult: ['0.5', '1', '1', '2', '3', '4', '4', '6'] });
      else {
        const slowing = Math.random() < 0.5;
        applyRhythm({ mode: 'variable', start: slowing ? [60, 200] : [300, 900], end: slowing ? [300, 900] : [60, 200], ramp: [6, 20], at: Math.random() < 0.7 ? 'end' : 'start', mult: ['1', '1', '2', '3', '4'] });
      }
      document.getElementById('followCuts').checked = Math.random() < 0.15;
      refreshVideo(quiet === true);
    }
    // a random look: invert and zoom
    function randomLook(quiet) {
      if (quiet !== true) rememberForUndo();
      applyLook({ invert: ['off', 'off', 'mono', 'colour'], zoom: ['off', 'out', 'out', 'in'], amount: [0.2, 1.8] });
      refreshVideo(quiet === true);
    }
    // the Video half of Random: rhythm and look
    function randomVideo(quiet) {
      if (quiet !== true) rememberForUndo();
      randomRhythm(true); randomLook(true);
      if (quiet !== true) { saveSettings(); musicChanged(); }
    }
    // how many cuts a second the music hears (flat: the tempo, or every picture cut when the check is on; variable: the mean of the two ends)
    function rhythmCutsPerSecond() {
      const follow = document.getElementById('followCuts').checked ? (parseFloat(document.getElementById('multSelect').value) || 1) : 1;
      if (rhythmMode() === 'variable') return (1000 / ((parseFloat(document.getElementById('startMsRange').value) + parseFloat(document.getElementById('endMsRange').value)) / 2)) * follow;
      return (bpmValue() / 60) * follow;
    }
    // the sound matched to the speed: fast cuts get a slow arpeggio, sparse hits and a drier room; slow cuts get busier notes, every-cut hits and a big room
    function matchSoundToSpeed() {
      const rate = rhythmCutsPerSecond();
      if (rate >= 4) {
        if (getn('arpRateSelect') > 1) setv('arpRateSelect', Math.floor(Math.random() * 2));
        if (getn('hitOnSelect') === 0) setv('hitOnSelect', 1 + Math.floor(Math.random() * 3));
        setv('spaceRange', Math.min(50, getn('spaceRange'))); setv('echoRange', Math.min(20, getn('echoRange')));
      } else if (rate <= 1.5) {
        if (getn('arpRateSelect') < 2) setv('arpRateSelect', 2 + Math.floor(Math.random() * 2));
        setv('hitOnSelect', 0);
        setv('spaceRange', Math.max(40, getn('spaceRange')));
      }
    }
    // rules so the parts of a sound agree, whatever drew them
    function soundRules() {
      const rate = rhythmCutsPerSecond();
      if (getn('arpRange') < 20) setv('arpRange', 0);                                           // a faint arpeggio is noise: on properly, or off
      if (rate > 2 && getn('hitTypeSelect') > 0 && getn('hitOnSelect') === 0 && getn('arpRange') > 0 && getn('arpRateSelect') === 3) setv('arpRateSelect', 1);   // hits on every fast cut and 4 notes a cut fight
      if (getn('dynSelect') === 3 && rhythmMode() !== 'variable') setv('dynSelect', 0);          // a flat speed has nothing to follow
      if (getn('brightRange') > 45) { setv('ringRange', Math.min(20, getn('ringRange'))); setv('shimmerRange', Math.min(20, getn('shimmerRange'))); }   // bright plus metal is harsh
      if (rate > 6) setv('echoRange', 0);                                                        // an echo smears very fast cuts
      // keep the weight in the sub: a square sub, a high root, the metal ring and metal hits all move energy up and away from it
      if (getn('subWaveSelect') === 2 && (getn('pitchRange') > 60 || getn('lowRange') < 80)) setv('subWaveSelect', 0);
      if (getn('pitchRange') > 60) { setv('ringRange', Math.min(20, getn('ringRange'))); setv('brightRange', Math.min(40, getn('brightRange'))); }
      if (getn('hitTypeSelect') === 3) setv('ringRange', Math.min(25, getn('ringRange')));
      const tex = ['echoRange', 'washRange', 'ringRange', 'shimmerRange'].filter(id => getn(id) > 0).sort((a, b) => getn(b) - getn(a));
      tex.slice(2).forEach(id => setv(id, 0));                                                   // two textures at most
    }
    function randomMusic(quiet) {
      if (quiet !== true) rememberForUndo();
      for (const [k, range] of Object.entries(RANDOM_RANGES)) setv(`${k}Range`, rint(range));
      for (const k of ['echo', 'wash', 'ring', 'shimmer']) if (Math.random() < 0.5) setv(`${k}Range`, 0);   // flavours, not the rule: often none
      const r = Math.random();
      const choice = (id, n) => setv(id, Math.floor(Math.random() * n));
      choice('hitTypeSelect', 5); choice('hitOnSelect', 4); choice('arpStepsSelect', 4); choice('arpRateSelect', 4); choice('dynSelect', 4);
      if (Math.random() < 0.5) setv('dynSelect', 0);                                             // an arc over the whole clip is a bigger decision than a sound: steady half the time
      if (getn('hitTypeSelect') === 0 || Math.random() < 0.25) setv('hitTypeSelect', 0);         // hits and arpeggios come and go
      if (Math.random() < 0.55) setv('arpRange', 0);
      setv('subWaveSelect', r < 0.5 ? 0 : r < 0.75 ? 1 : 2);
      choice('padWaveSelect', 4); choice('chordSelect', 4);
      setv('seedVal', 1 + Math.floor(Math.random() * 99999));
      soundRules();
      if (quiet !== true) updateMusic();
    }
    function applySound(c) {
      for (const k of Object.keys(RANDOM_RANGES)) setv(`${k}Range`, rint(c[k]));
      for (const k of ['echo', 'wash', 'ring', 'shimmer']) if (c[k][0] === 0 && Math.random() < 0.4) setv(`${k}Range`, 0);
      setv('chordSelect', rpick(c.chord)); setv('subWaveSelect', rpick(c.subWave)); setv('padWaveSelect', rpick(c.padWave));
      setv('hitTypeSelect', rpick(c.hitType)); setv('hitOnSelect', rpick(c.hitOn)); setv('dynSelect', rpick(c.dyn));
      setv('arpStepsSelect', Math.floor(Math.random() * 4)); setv('arpRateSelect', Math.floor(Math.random() * 4));
      setv('seedVal', 1 + Math.floor(Math.random() * 99999));
    }
    // everything at once, inside the character, the sound matched to the speed
    function randomAll() {
      rememberForUndo();
      const chosen = document.getElementById('characterSelect').value;
      const key = CHARACTERS[chosen] ? chosen : rpick(Object.keys(CHARACTERS));
      const c = CHARACTERS[key];
      setv('musicSelect', 'on');
      applyRhythm(c.rhythm); applyLook(c.look);
      document.getElementById('followCuts').checked = false;
      applySound(c.sound);
      matchSoundToSpeed();
      soundRules();
      refreshVideo(true);
      updateMusic();
      if (!CHARACTERS[chosen]) setStatus(`Random · ${c.name}`);
      return key;
    }
    // choosing a character rolls inside it at once
    function pickCharacter() {
      saveSettings();
      if (CHARACTERS[document.getElementById('characterSelect').value]) randomAll();
    }
    // how many images, how long the result runs, and how long the cuts are
    // the "Change over" slider can take at most every cut of the selection, so its range follows the images (and the invert pairs)
    function syncRampRange() {
      const invert = document.getElementById('invertSelect').value;
      const mult = parseFloat(document.getElementById('multSelect').value) || 1;
      const nCuts = Math.max(1, Math.ceil((activePlates().length * (invert === 'mono' || invert === 'colour' ? 2 : 1)) / Math.max(0.05, mult) - 1e-9));    // base cuts: what the change runs over
      const el = document.getElementById('rampRange');
      el.max = String(Math.max(2, nCuts));
      if ((parseInt(el.value, 10) || 0) > Math.max(2, nCuts)) el.value = el.max;
      const ramp = parseInt(el.value, 10) || 12;
      document.getElementById('rampVal').textContent = ramp >= nCuts && nCuts > 2 ? `all ${nCuts}` : `${ramp} cuts`;
    }
    function drawInfo() {
      syncRampRange();
      const n = activePlates().length;
      const info = document.getElementById('rhythmInfo');
      renderRhythmStrip();
      if (!isPlaying) drawFrame();                                         // paused: the time and the length follow the new settings at once
      if (!n) { info.textContent = ''; return; }
      const starts = timelineFor(n);
      const cuts = starts.length - 1;
      const sec = c => c / 30;
      const lens = starts.slice(1).map((v, i) => sec(v - starts[i]));
      const f = v => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(1)} s`);
      const lo = Math.min(...lens), hi = Math.max(...lens);
      const v = variableParams();
      const whole = v.ramp >= Math.ceil(cuts / (parseFloat(document.getElementById('multSelect').value) || 1) - 1e-9);
      const pace = rhythmMode() === 'variable' ? (v.start_ms === v.end_ms ? f(lens[0]) : whole ? `${f(lens[0])} → ${f(lens[lens.length - 1])}` : v.at === 'start' ? `${f(lens[0])} → ${f(lens[lens.length - 1])} over the first ${v.ramp}` : `${f(lens[0])}, then ${f(lens[lens.length - 1])} over the last ${v.ramp}`) : hi > lo * 1.05 ? `${f(lo)} – ${f(hi)}` : f(lo);
      info.textContent = `${n} images · ${fmtDuration(sec(starts[cuts]))} · cuts ${pace}`;
      document.getElementById('exportMeta').textContent = `1080 × 1920 · ${fmtDuration(sec(starts[cuts]))} · ${musicOn() ? 'sound included' : 'silent'}`;
    }

    // ---- the rhythm strip: the whole film as one line, drawn in time from the same timeline the player and the export use ----
    // x runs 0..1000 over the clip; the speed line is high where the cuts are short (fast) and low where they are long
    function rhythmStripModel(n) {
      if (!n) return null;
      const r = rhythmFor(n), pic = r.pic, total = pic[pic.length - 1];
      const X = f => (f / total) * 1000;
      const lens = pic.slice(1).map((v, i) => v - pic[i]);
      const lo = Math.min(...lens), hi = Math.max(...lens);
      const flat = hi - lo < 0.5;
      const Y = len => (flat ? 14 : 40 - ((hi - len) / (hi - lo)) * 30);      // 48 tall: fastest at 10, slowest at 40
      const curve = [[0, Y(lens[0])]].concat(lens.map((len, i) => [X(pic[i] + len / 2), Y(len)]), [[1000, Y(lens[lens.length - 1])]]);
      const variable = rhythmMode() === 'variable';
      const v = variableParams();
      let band = null, handles = [];
      if (variable && v.start_ms !== v.end_ms) {
        const nBase = r.base.length - 1, ramp = Math.max(1, Math.min(nBase, Math.min(200, Math.max(2, v.ramp))));
        const yOfMs = ms => Y(Math.max(1, (ms * 30) / 1000 / (parseFloat(document.getElementById('multSelect').value) || 1)));
        if (v.at === 'end') {
          const from = Math.min(r.base[nBase - ramp], total);
          band = { left: X(from) / 10, width: 100 - X(from) / 10, label: `Landing · ${ramp} cuts` };
          handles = [{ left: band.left, top: yOfMs(v.start_ms), label: `Start ${v.start_ms} ms`, side: 'left' }, { left: 100, top: yOfMs(v.end_ms), label: `End ${v.end_ms} ms`, side: 'left' }];
        } else {
          const to = Math.min(r.base[Math.min(nBase, ramp)], total);
          band = { left: 0, width: X(to) / 10, label: `Build-up · ${ramp} cuts` };
          handles = [{ left: 0, top: yOfMs(v.start_ms), label: `Start ${v.start_ms} ms`, side: 'right' }, { left: band.width, top: yOfMs(v.end_ms), label: `End ${v.end_ms} ms`, side: 'right' }];
        }
      }
      const beats = r.audio.slice(0, -1).map(t => X(t * 30)).filter(x => x < 1000).slice(0, 2000);
      const sec = total / 30, step = sec <= 3 ? 0.5 : sec <= 8 ? 1 : sec <= 20 ? 2 : sec <= 60 ? 5 : 10;
      const axis = [];
      for (let t = 0; t <= sec + 1e-6; t += step) axis.push({ left: (t / sec) * 100, text: `${+t.toFixed(1)} s` });
      const beatText = followCuts() ? 'Music on every picture cut'
        : variable ? `Music on the run · ${r.audio.length - 1} cuts` : `Music on the beat · ${Math.round(bpmValue())} BPM`;
      return { total, ticks: pic.slice(0, -1).map(X), curve, band, handles, beats, axis, beatText, oneFrame: lo <= 1.0001 };
    }
    function renderRhythmStrip() {
      const m = rhythmStripModel(activePlates().length);
      const el = id => document.getElementById(id);
      el('rhythmStrip').hidden = !m;
      if (!m) return;
      const f = x => x.toFixed(1);
      el('rsTicks').setAttribute('d', m.ticks.map(x => `M${f(x)} 5V21`).join(''));
      const pts = m.curve.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
      el('rsCurve').setAttribute('points', pts);
      el('rsArea').setAttribute('points', `0,48 ${pts} 1000,48`);
      el('rsBeats').setAttribute('d', m.beats.map(x => `M${f(x)} 7h0.01`).join(''));
      el('rsBand').hidden = !m.band;
      if (m.band) { el('rsBand').style.left = `${m.band.left}%`; el('rsBand').style.width = `${m.band.width}%`; el('rsBandLabel').textContent = m.band.label; }
      for (const k of [0, 1]) {
        const h = m.handles[k], dot = el(`rsH${k}`), lab = el(`rsH${k}L`);
        dot.hidden = lab.hidden = !h;
        if (!h) continue;
        dot.style.left = lab.style.left = `${h.left}%`;
        dot.style.top = lab.style.top = `${(h.top / 48) * 100}%`;
        lab.textContent = h.label;
        lab.className = `rs-hlabel ${h.left < 25 ? 'right' : 'left'}`;                    // near the left edge the label reads to the right, so it stays inside
      }
      el('rsAxis').innerHTML = m.axis.map((a, i) => `<span style="left:${a.left}%"${i === 0 ? ' class="first"' : ''}>${a.text}</span>`).join('');
      el('rsBeatText').textContent = m.beatText;
      el('rsFast').textContent = m.oneFrame ? 'fastest cut = 1 frame at 30 fps' : '';
      shownHead = -1;
      movePlayhead();
    }
    // the playhead follows the picture; only its position changes while playing
    let shownHead = -1;
    function movePlayhead() {
      const n = activePlates().length;
      if (!n) return;
      const total = timelineFor(n).at(-1);
      const pct = Math.round(((((cutPos % total) + total) % total) / total) * 10000) / 100;
      if (pct === shownHead) return;
      shownHead = pct;
      document.getElementById('rsPlayhead').style.left = `${pct}%`;
    }
    // a click on the strip puts the playhead there
    function rhythmStripClick(e) {
      const body = document.getElementById('rsBody');
      const n = activePlates().length;
      if (!n || !body.getBoundingClientRect) return;
      const b = body.getBoundingClientRect();
      const u = Math.max(0, Math.min(0.9999, (e.clientX - b.left) / b.width));
      cutPos = u * timelineFor(n).at(-1);
      lastTick = performance.now();
      if (isPlaying && droneLive.playing) droneLive.seek(cutPos / 30);
      drawFrame();
    }
    // ---- while the drone plays it is the player's clock ----
    const droneLive = new window.Drone.Live();
    function stopMusic() {
      droneLive.stop();
      setPlayLabel();
    }
    let musicPending = false;
    async function startMusic(fromSec = 0) {
      musicPending = true;                                                   // the drone is built live: only its level takes a blink
      try { await droneLive.play(synthParams(), synthStartsSec(), fromSec); } catch (e) { setStatus(`Could not play the music: ${e.message}`); }
      musicPending = false;
      cutPos = fromSec * 30;
      lastTick = performance.now();
    }
    // tempo, multiple, invert or any music setting changed: the drone swaps in the new sound at once, from where the picture is
    function musicChanged() {
      drawInfo();
      if (!isPlaying) return;
      if (!musicOn()) { droneLive.stop(); return; }
      if (droneLive.playing) {
        droneLive.update(synthParams(), synthStartsSec(), () => cutPos / 30);
      } else startMusic(cutPos / 30);
    }
    function zoomScale(mode, amountPct, p) {
      const a = amountPct / 100;
      if (mode === 'out') return 1 + a * (1 - p);
      if (mode === 'in') return 1 + a * p;
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
      const s = zoomScale(fx.zoom, fx.amount, plan.p);
      img.style.transform = s > 1.0005 ? `scale(${s.toFixed(5)})` : '';
      img.style.filter = plan.inverted ? (fx.invert === 'mono' ? 'invert(1) grayscale(1)' : 'invert(1)') : '';
    }
    function updateFx() {
      saveSettings();
      document.getElementById('zoomAmtVal').textContent = `${parseFloat(document.getElementById('zoomAmt').value).toFixed(1)}%`;
      const zoomOff = document.getElementById('zoomSelect').value === 'off';
      document.getElementById('zoomAmt').disabled = zoomOff;
      document.getElementById('zoomAmtRow').classList.toggle('dim', zoomOff);
      syncSegs(); paintRanges();
      if (!isPlaying) clearFx();
      musicChanged();   // invert changes the cuts, so the sound must follow
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
        if (!activePlates().length || document.getElementById('stageImg').style.display === 'none') return;
        if (musicPending) return;
        if (musicOn() && droneLive.playing && !droneLive.holding) cutPos = droneLive.pos() * 30;           // the drone is the clock (positions are in frames)
        else cutPos += (dt * 30) / 1000;
        drawFrame();
      }, 16);
    }
    // the picture at cutPos: the stage image, its effects (while playing), the film strip mark and the time
    let shownTime = '';
    function drawFrame() {
      const active = activePlates();
      const stageImg = document.getElementById('stageImg');
      if (!active.length) { markFilmstrip(-1); return; }
      const fx = fxSettings();
      const tl = timelineFor(active.length);
      const plan = planAt(cutPos, active.length, fx.invert, tl);
      currentIdx = plan.plate;
      const url = active[plan.plate].preview || active[plan.plate].url;
      if (stageImg.getAttribute('src') !== url) stageImg.src = url;
      if (isPlaying) applyFx(plan, fx); else clearFx();
      markFilmstrip(plan.plate);
      movePlayhead();
      const total = tl[tl.length - 1], t = ((cutPos % total) + total) % total;
      const clock = f => { const s = f / 30; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
      const txt = `${clock(t)}|${clock(total)}|${plan.cut + 1}|${tl.length - 1}`;
      if (txt !== shownTime) {
        shownTime = txt;
        document.getElementById('timecode').innerHTML = `${clock(t)} <span>/ ${clock(total)} · cut ${plan.cut + 1} / ${tl.length - 1}</span>`;
      }
    }

    // start again from the first image and the start of the sound (with a long slow run, this skips the wait)
    function restartPlay() {
      if (!isPlaying) { cutPos = 0; togglePlay(); return; }
      cutPos = 0; lastTick = performance.now(); currentIdx = 0;
      if (droneLive.playing) droneLive.restart(synthParams(), synthStartsSec());
    }
    function setPlayLabel() {
      const b = document.getElementById('playBtn');
      b.textContent = isPlaying ? 'Pause' : 'Play';
      b.setAttribute('aria-label', b.textContent);
      b.classList.toggle('playing', isPlaying);
    }
    // play carries on from where the playhead is (Restart goes back to the start)
    function togglePlay() {
      const stageImg = document.getElementById('stageImg');
      stageImg.style.display = 'block';
      isPlaying = !isPlaying;
      lastTick = performance.now();
      if (!isPlaying) { clearFx(); drawFrame(); }
      setPlayLabel();
      if (!isPlaying) stopMusic();
      else if (musicOn()) startMusic(cutPos / 30);
    }

    function toggleReticle() {
      const on = document.getElementById('reticle').classList.toggle('visible');
      document.getElementById('targetBtn').setAttribute('aria-pressed', String(on));
    }

    // Remember tempo & generation settings across reloads (per-browser convenience only).
    const PERSISTED = ['rhythmSelect', 'startMsRange', 'endMsRange', 'rampRange', 'atSelect', 'bpmInput', 'followCuts', 'multSelect', 'musicSelect', 'pulseRange', 'lowRange', 'powerRange', 'spaceRange', 'brightRange', 'widthRange', 'pitchRange', 'chordSelect', 'movementRange', 'echoRange', 'washRange', 'ringRange', 'shimmerRange', 'subWaveSelect', 'padWaveSelect', 'hitTypeSelect', 'hitRange', 'hitOnSelect', 'arpRange', 'arpStepsSelect', 'arpRateSelect', 'dynSelect', 'seedVal', 'soundGroupVal', 'characterSelect', 'invertSelect', 'zoomSelect', 'zoomAmt', 'batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput'];
    function restoreSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem('studioSettings') || '{}');
        PERSISTED.forEach(id => {
          const el = document.getElementById(id);
          if (!el || saved[id] === undefined) return;
          if (el.type === 'checkbox') el.checked = saved[id] === true;
          else if ([...(el.options || [{ value: saved[id] }])].some(o => o.value === saved[id] || el.type === 'range')) el.value = saved[id];
        });
      } catch (e) {}
    }
    function saveSettings() {
      try {
        const out = {};
        PERSISTED.forEach(id => { const el = document.getElementById(id); out[id] = el.type === 'checkbox' ? el.checked : el.value; });
        localStorage.setItem('studioSettings', JSON.stringify(out));
      } catch (e) {}
    }

    // the frames a picture cut lasts, next to the Multiple: one number (Flat) or from start to end (Variable)
    function showSpeed() {
      const mult = parseFloat(document.getElementById('multSelect').value) || 1;
      const f = ms => Math.max(1, (ms * 30) / 1000 / mult);
      const fmt = x => (x < 10 ? x.toFixed(1).replace(/\.0$/, '') : String(Math.round(x)));
      const v = variableParams();
      document.getElementById('speedVal').textContent = rhythmMode() === 'variable' ? `${fmt(f(v.start_ms))}→${fmt(f(v.end_ms))}f` : `${framesPerCut.toFixed(1)}f`;
    }
    // flat or variable speed: which controls show, and the cuts follow
    function updateRhythm() {
      syncRampRange();
      const variable = rhythmMode() === 'variable';
      document.getElementById('flatBox').hidden = variable;
      document.getElementById('varBox').hidden = !variable;
      showSpeed();
      const v = variableParams();
      document.getElementById('startMsVal').textContent = `${v.start_ms} ms`;
      document.getElementById('endMsVal').textContent = `${v.end_ms} ms`;
      syncSegs(); paintRanges();
      saveSettings();
      restartLoop();
      musicChanged();
    }
    function updateTempo() {
      saveSettings();
      const bpm = bpmValue();
      document.getElementById('bpmVal').textContent = `${Math.round(bpm)} BPM`;
      const mult = parseFloat(document.getElementById('multSelect').value);
      framesPerCut = Math.max(1, (30 * 60) / (bpm * mult));
      showSpeed();
      syncSegs(); paintRanges();
      restartLoop();
      musicChanged();
    }

    function setTrashView(on) {
      showTrash = on;
      trashSel = new Set();
      return loadState();
    }

    async function setTrash(e, filename, trashed) {
      if (blockedByAi(e)) return;
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
      const dots = prog.slots.map((st, i) => `<i class="slot ${st}" title="${escapeHtml((prog.titles[i] || '') + (prog.why && prog.why[i] ? ' — ' + prog.why[i] : ''))}"></i>`).join('');
      const bar = prog.stage === 'invent' ? '<span class="slots indeterminate"><i></i></span>' : `<span class="slots">${dots}</span>`;
      const count = prog.stage === 'invent' ? '' : `<b>${done}/${prog.total}</b>`;
      el.innerHTML = `<div class="prog">
        <span class="prog-world">${escapeHtml(prog.world || 'New batch')}</span>${bar}${count}
        <span class="prog-note">${escapeHtml(prog.summary || prog.note)}</span>
        ${prog.timer ? `<span class="prog-time">${fmtElapsed(Date.now() - prog.t0)}${running ? ` · ${running} rendering` : ''}</span>` : ''}
      </div>`;
    }
    function progStart(count) {
      prog.t0 = Date.now(); prog.slots = []; prog.titles = []; prog.why = []; prog.world = ''; prog.stage = 'invent';
      prog.total = count; prog.summary = ''; prog.note = `Choosing a territory and writing ${count} scenes…`;
      document.getElementById('statusText').dataset.idle = '';
      clearInterval(prog.timer); prog.timer = setInterval(progRender, 1000); progRender();
    }
    function progStop(summary) { clearInterval(prog.timer); prog.timer = null; prog.summary = summary; progRender(); }
    // Two busy states keep the app consistent:
    //  - generating images: new images may arrive, so the AI cannot order yet
    //  - the AI ordering: it works from a snapshot of the selection, so nothing may change the selection until it is done
    let generating = false;
    let aiRunning = false;
    function applyLocks() {
      const lockGen = generating || aiRunning;
      ['worldSelect', 'directionInput', 'batchCountSelect', 'modelSelect', 'generateBtn'].forEach(id => { document.getElementById(id).disabled = lockGen; });
      document.getElementById('aiBtn').disabled = lockGen;
      document.getElementById('exportBtn').disabled = aiRunning;
      ['trashSelAll', 'trashEmpty', 'resetAi'].forEach(id => { document.getElementById(id).disabled = aiRunning; });
      document.querySelectorAll('#orderSeg button').forEach(b => { b.disabled = aiRunning; });
      document.body.classList.toggle('ai-running', aiRunning);
      updateTrashBar();
    }
    function setGenerating(on) { generating = on; applyLocks(); }
    let exporting = false;
    let purging = false;
    const isBusy = () => generating || aiRunning || exporting || purging;
    // a manual or automatic reload in the middle of a batch would lose the images still waiting to be generated
    window.addEventListener('beforeunload', e => { if (isBusy()) { e.preventDefault(); e.returnValue = ''; } });
    function blockedByAi(e) {
      if (!aiRunning) return false;
      if (e && e.stopPropagation) e.stopPropagation();
      setStatus('The AI is ordering your selection. Wait until it finishes.');
      return true;
    }

    async function generateImages() {
      if (blockedByAi()) return;
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
        const reasons = [];
        let authFailed = false;
        prog.stage = 'render';
        prog.total = ideas.length;
        prog.world = (ideas[0] && ideas[0].world) || '';
        prog.slots = ideas.map(() => 'wait');
        prog.titles = ideas.map(i => i.title);
        prog.why = ideas.map(() => '');
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
          if (genData.needs_auth) { authFailed = true; prog.slots[idx] = 'err'; lastRejectReason = 'Krea login needed'; prog.why[idx] = lastRejectReason; reasons.push(lastRejectReason); return; }
          if (!genData.ok) { prog.slots[idx] = 'err'; lastRejectReason = genData.error || 'Generation failed'; prog.why[idx] = lastRejectReason; reasons.push(lastRejectReason); return; }
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
            try { await runOne(item, idx); } catch (e) { prog.slots[idx] = 'err'; lastRejectReason = e.message; prog.why[idx] = e.message; reasons.push(e.message); }
          }
        }));
        loadWorlds();
        const failed = prog.slots.filter(x => x === 'err').length;
        const parts = [`${added} added`];
        if (trashedByQa) parts.push(`${trashedByQa} in Trash (${lastRejectReason})`);
        if (failed) {
          const distinct = [...new Set(reasons.map(r => String(r).slice(0, 90)))].slice(0, 2);
          parts.push(`${failed} failed (${distinct.join(' · ') || lastRejectReason}) — hover the red bars for each reason`);
        }
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
      if (blockedByAi()) return;
      if (exporting) return;
      exporting = true;
      setExportState('busy');
      setMusicState('busy', 'Rendering on the server…');
      let ok = false;
      try {
        if (musicOn()) {                                   // the same WebAudio drone as the preview, rendered offline and sent along
          setMusicState('busy', 'Preparing the sound…');
          const wav = window.Drone.toWav(await window.Drone.renderExport(synthParams(), synthStartsSec()));
          const up = await fetch('/api/export-audio', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wav });
          const sent = await up.json();
          if (!sent.ok) throw new Error(sent.error || 'the sound was not accepted');
          setMusicState('busy', 'Rendering on the server…');
        }
        const res = await fetch('/api/export-video', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            bpm: bpmValue(),
            multiple: parseFloat(document.getElementById('multSelect').value),
            invert_mode: document.getElementById('invertSelect').value,
            rhythm: rhythmMode(),
            ...variableParams(),
            music: musicOn() ? 'synth' : 'off',
            zoom_mode: document.getElementById('zoomSelect').value,
            zoom_amount: parseFloat(document.getElementById('zoomAmt').value) || 0
          })
        });
        const data = await res.json();
        if (data.ok) {
          const link = document.getElementById('downloadLink');
          link.href = data.video_url;
          link.setAttribute('download', data.filename || 'Demo.mp4');
          link.hidden = false;
          document.getElementById('exportFile').textContent = data.filename || 'MP4';
          link.click();                                                  // the file saves itself; the link stays as a way to get it again
          ok = true;
          setStatus(`Export ready, downloading: ${data.images} images, ${data.seconds}s.`);
        } else {
          setStatus(`Export failed: ${data.error || 'unknown error'}`);
        }
      } catch (e) {
        setStatus(`Export failed: ${e.message}`);
      } finally {
        exporting = false;
        setExportState(ok ? 'ready' : 'idle');
      }
    }

    restoreSettings();
    buildSegs();
    updateFx();
    updateTempo();
    updateRhythm();
    updateMusic();
    showSoundGroup(document.getElementById('soundGroupVal').value);
    setPlayLabel();
    try { setMode(localStorage.getItem('studioMode') || 'curate'); } catch (e) { setMode('curate'); }
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
          if (seen && sig !== seen) {
            if (isBusy()) setStatus('The server restarted. Your running job continues; the page will reload when it ends.');
            else location.reload();
          }
          if (seen === null || !isBusy()) seen = sig;   // while busy keep the old signature so the reload still happens afterwards
        } catch (e) {}  // server restarting: try again next tick
      }, 1500);
    })();
  

// Inline handlers in the markup (onclick=...) need these on window now that the code is an ES module.
Object.assign(window, {
  includeAll,
  makeManual,
  resetAi,
  startAiOrder,
  toggleAiPanel,
  switchSequence,
  cardClick,
  confirmAnswer,
  deleteSelected,
  emptyTrash,
  selectAllTrash,
  copyPromptText,
  exportVideo,
  generateImages,
  onDragEnd,
  onDragLeave,
  onDragOver,
  onDragStart,
  onDrop,
  previewPlate,
  reconnectKrea,
  saveCritic,
  saveKimiSettings,
  saveKimiSettingsDebounced,
  setTrash,
  setTrashView,
  togglePlay,
  updateMusic,
  randomMusic,
  randomVideo,
  randomAll,
  undoRandom,
  showSoundGroup,
  toggleSound,
  setMode,
  randomRhythm,
  randomLook,
  pickCharacter,
  filmstripClick,
  rhythmStripClick,
  trashCurrent,
  togglePromptOverlay,
  toggleReticle,
  toggleSettings,
  updateTempo,
  updateRhythm,
  restartPlay,
  updateFx,
});
