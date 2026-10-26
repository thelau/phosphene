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
      restartLoop();
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

    function previewPlate(filename) {
      const stageImg = document.getElementById('stageImg');
      stageImg.style.display = 'block';
      clearFx();
      const p = plates.find(x => x.filename === filename);
      if (p) {
        stageImg.src = p.preview || p.url;
        if (p.trashed && isPlaying) {
          isPlaying = false;
          document.getElementById('playBtn').textContent = '▶ Play';
        }
      }
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
        timelineCache = { key, value: { pic, audio, end, landAt: pic[Math.max(0, nCuts - (paired ? 2 : 1))] / 30 } };
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
    function setMusicState(kind, text) {
      const el = document.getElementById('musicState');
      el.hidden = !text;
      el.textContent = text || '';
      el.className = `music-state ${kind === 'busy' ? 'working' : kind || ''}`;
    }
    function fmtDuration(sec) { return sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : `${Math.round(sec)} s`; }
    function updateMusic() {
      const on = musicOn();
      document.getElementById('synthBox').hidden = !on;
      for (const k of ['pulse', 'low', 'bright', 'width', 'space', 'power', 'pitch', 'movement', 'echo', 'wash', 'ring', 'shimmer', 'hit', 'arp']) document.getElementById(`${k}Val`).textContent = document.getElementById(`${k}Range`).value;
      saveSettings();
      musicChanged();
    }
    // a random sound within what works: every setting is drawn from a range that stays a dark, heavy drone (the ranges are the taste)
    const RANDOM_RANGES = { pulse: [30, 90], low: [65, 100], power: [30, 90], space: [5, 85], bright: [0, 55], width: [30, 100], pitch: [0, 100], movement: [15, 85], echo: [0, 55], wash: [0, 55], ring: [0, 45], shimmer: [0, 45], hit: [30, 70], arp: [20, 45] };
    function randomMusic() {
      const pick = ([lo, hi]) => Math.round(lo + Math.random() * (hi - lo));
      for (const [k, range] of Object.entries(RANDOM_RANGES)) document.getElementById(`${k}Range`).value = String(pick(range));
      for (const k of ['echo', 'wash', 'ring', 'shimmer']) if (Math.random() < 0.5) document.getElementById(`${k}Range`).value = '0';   // flavours, not the rule: often none
      const r = Math.random();
      const choice = (id, n) => { document.getElementById(id).value = String(Math.floor(Math.random() * n)); };
      choice('hitTypeSelect', 5); choice('hitOnSelect', 4); choice('arpStepsSelect', 4); choice('arpRateSelect', 4); choice('dynSelect', 4);
      if (Math.random() < 0.5) document.getElementById('dynSelect').value = '0';                   // an arc over the whole clip is a bigger decision than a sound: steady half the time
      if (document.getElementById('hitTypeSelect').value === '0' || Math.random() < 0.25) document.getElementById('hitTypeSelect').value = '0';   // hits and arpeggios come and go
      if (Math.random() < 0.55) document.getElementById('arpRange').value = '0';
      document.getElementById('subWaveSelect').value = r < 0.5 ? '0' : r < 0.75 ? '1' : '2';
      document.getElementById('padWaveSelect').value = String(Math.floor(Math.random() * 4));
      document.getElementById('chordSelect').value = String(Math.floor(Math.random() * 4));
      document.getElementById('seedVal').value = String(1 + Math.floor(Math.random() * 99999));
      updateMusic();
    }
    function showFxTab(which) {
      const music = which === 'music';
      document.getElementById('paneVideo').hidden = music;
      document.getElementById('paneMusic').hidden = !music;
      document.getElementById('tabVideo').classList.toggle('on', !music);
      document.getElementById('tabMusic').classList.toggle('on', music);
      document.getElementById('fxTabVal').value = music ? 'music' : 'video';
      saveSettings();
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
    }
    // ---- while the drone plays it is the player's clock ----
    const droneLive = new window.Drone.Live();
    function stopMusic() {
      droneLive.stop();
      document.getElementById('playBtn').textContent = isPlaying ? '⏸ Pause' : '▶ Play';
    }
    let musicPending = false;
    async function startMusic() {
      musicPending = true;                                                   // the drone is built live: only its level takes a blink
      try { await droneLive.play(synthParams(), synthStartsSec(), 0); } catch (e) { setStatus(`Could not play the music: ${e.message}`); }
      musicPending = false;
      cutPos = 0;
      lastTick = performance.now();
    }
    // tempo, multiple, invert or any music setting changed: the drone swaps in the new sound at once, from where the picture is
    function musicChanged() {
      drawInfo();
      if (!isPlaying) return;
      if (!musicOn()) { droneLive.stop(); return; }
      if (droneLive.playing) {
        droneLive.update(synthParams(), synthStartsSec(), () => cutPos / 30);
      } else startMusic();
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
      document.getElementById('zoomAmt').disabled = document.getElementById('zoomSelect').value === 'off';
      document.getElementById('zoomAmtRow').hidden = document.getElementById('zoomSelect').value === 'off';
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
        const active = activePlates();
        const stageImg = document.getElementById('stageImg');
        if (!active.length || stageImg.style.display === 'none') return;
        if (musicPending) return;
        if (musicOn() && droneLive.playing && !droneLive.holding) cutPos = droneLive.pos() * 30;           // the drone is the clock (positions are in frames)
        else cutPos += (dt * 30) / 1000;
        const fx = fxSettings();
        const tl = timelineFor(active.length);
        const plan = planAt(cutPos, active.length, fx.invert, tl);
        currentIdx = plan.plate;
        const url = active[plan.plate].preview || active[plan.plate].url;
        if (stageImg.getAttribute('src') !== url) stageImg.src = url;
        applyFx(plan, fx);
      }, 16);
    }

    // start again from the first image and the start of the sound (with a long slow run, this skips the wait)
    function restartPlay() {
      if (!isPlaying) { togglePlay(); return; }
      cutPos = 0; lastTick = performance.now(); currentIdx = 0;
      if (droneLive.playing) droneLive.restart(synthParams(), synthStartsSec());
    }
    function togglePlay() {
      const stageImg = document.getElementById('stageImg');
      stageImg.style.display = 'block';
      isPlaying = !isPlaying;
      if (isPlaying) { cutPos = 0; lastTick = performance.now(); } else { clearFx(); }
      document.getElementById('playBtn').textContent = isPlaying ? '⏸ Pause' : '▶ Play';
      if (!isPlaying) stopMusic();
      else if (musicOn()) startMusic();
    }

    function toggleReticle() {
      document.getElementById('reticle').classList.toggle('visible');
    }

    // Remember tempo & generation settings across reloads (per-browser convenience only).
    const PERSISTED = ['rhythmSelect', 'startMsRange', 'endMsRange', 'rampRange', 'atSelect', 'bpmInput', 'followCuts', 'multSelect', 'musicSelect', 'pulseRange', 'lowRange', 'powerRange', 'spaceRange', 'brightRange', 'widthRange', 'pitchRange', 'chordSelect', 'movementRange', 'echoRange', 'washRange', 'ringRange', 'shimmerRange', 'subWaveSelect', 'padWaveSelect', 'hitTypeSelect', 'hitRange', 'hitOnSelect', 'arpRange', 'arpStepsSelect', 'arpRateSelect', 'dynSelect', 'seedVal', 'fxTabVal', 'invertSelect', 'zoomSelect', 'zoomAmt', 'batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput'];
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

    // flat or variable speed: which controls show, and the cuts follow
    function updateRhythm() {
      syncRampRange();
      const variable = rhythmMode() === 'variable';
      document.getElementById('flatBox').hidden = variable;
      document.getElementById('varBox').hidden = !variable;
      document.getElementById('speedVal').textContent = variable ? '' : `${framesPerCut.toFixed(1)}f`;
      const v = variableParams();
      document.getElementById('startMsVal').textContent = `${v.start_ms} ms`;
      document.getElementById('endMsVal').textContent = `${v.end_ms} ms`;
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
      document.getElementById('speedVal').textContent = rhythmMode() === 'variable' ? '' : `${framesPerCut.toFixed(1)}f`;
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
      const btn = document.getElementById('exportBtn');
      btn.disabled = true;
      exporting = true;
      btn.textContent = 'Rendering...';
      try {
        if (musicOn()) {                                   // the same WebAudio drone as the preview, rendered offline and sent along
          setMusicState('busy', 'Preparing the sound…');
          const wav = window.Drone.toWav(await window.Drone.renderExport(synthParams(), synthStartsSec()));
          const up = await fetch('/api/export-audio', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wav });
          const sent = await up.json();
          if (!sent.ok) throw new Error(sent.error || 'the sound was not accepted');
          setMusicState('', '');
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
          link.textContent = `⬇ Download ${data.filename || 'MP4'}`;
          link.hidden = false;
          link.click();                                                  // the file saves itself; the link stays as a way to get it again
          setStatus(`Export ready, downloading: ${data.images} images, ${data.seconds}s.`);
        } else {
          setStatus(`Export failed: ${data.error || 'unknown error'}`);
        }
      } catch (e) {
        setMusicState('', '');
        setStatus(`Export failed: ${e.message}`);
      } finally {
        exporting = false;
        btn.disabled = false;
        btn.textContent = 'Export MP4';
      }
    }

    restoreSettings();
    updateFx();
    updateTempo();
    updateRhythm();
    updateMusic();
    showFxTab(document.getElementById('fxTabVal').value);
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
  showFxTab,
  togglePromptOverlay,
  toggleReticle,
  toggleSettings,
  updateTempo,
  updateRhythm,
  restartPlay,
  updateFx,
});
