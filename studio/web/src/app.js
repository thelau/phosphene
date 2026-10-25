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
      if (typeof drawRhythm === 'function') drawRhythm();
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
      if (ok && isPlaying) { cutPos = 0; lastTick = performance.now(); currentIdx = 0; if (musicAudio && !musicAudio.paused) musicAudio.currentTime = 0; }   // the player follows: start the other order from its first image
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
    // A "cut" is one hold of framesPerCut frames. With invert on, every image takes two cuts: normal, then inverted.
    function planAt(cutPos, nPlates, invertMode, starts) {
      let cut = Math.floor(cutPos);
      let p = cutPos - cut;
      if (starts) [cut, p] = cutAt(starts, cutPos);
      const paired = invertMode === 'mono' || invertMode === 'colour';
      return { cut, p, plate: (paired ? Math.floor(cut / 2) : cut) % nPlates, inverted: paired && cut % 2 === 1 };
    }
    // ---- the cut timeline (mirrored in studio/rhythm.py): where each cut starts, in base cuts ----
    const CURVES = { land: [0.30, 8.0, 2.2], long: [0.10, 12.0, 1.7] };   // slowing starts at, grows to, shape
    function rhythmFactor(rhythm, u) {
      const c = CURVES[rhythm];
      if (c && u > c[0]) return Math.pow(c[1], Math.pow((u - c[0]) / (1 - c[0]), c[2]));
      return 1;
    }
    function cutStarts(nCuts, rhythm, paired, minLen = 0) {
      const out = [0];
      if (!CURVES[rhythm]) { for (let i = 1; i <= nCuts; i++) out.push(i); return out; }
      const nImg = Math.max(1, paired ? Math.floor(nCuts / 2) : nCuts);
      let t = 0;
      for (let i = 0; i < nCuts; i++) {
        const img = paired ? Math.floor(i / 2) : i;
        let f = rhythmFactor(rhythm, nImg > 1 ? img / (nImg - 1) : 1);
        if (img === nImg - 1) f *= 1.4;
        t += Math.max(minLen, f);
        out.push(t);
      }
      return out;
    }
    function cutAt(starts, t) {
      const total = starts[starts.length - 1];
      t = total > 0 ? ((t % total) + total) % total : 0;
      let lo = 0, hi = starts.length - 2;
      while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (starts[mid] <= t) lo = mid; else hi = mid - 1; }
      const span = starts[lo + 1] - starts[lo];
      return [lo, span > 0 ? (t - starts[lo]) / span : 0];
    }
    let timelineCache = { key: '', starts: null };
    function timelineFor(nPlates) {
      const invert = document.getElementById('invertSelect').value;
      const rhythm = document.getElementById('rhythmSelect').value;
      const key = `${nPlates}|${invert}|${rhythm}|${framesPerCut}`;
      if (timelineCache.key !== key) {
        const paired = invert === 'mono' || invert === 'colour';
        timelineCache = { key, starts: cutStarts(nPlates * (paired ? 2 : 1), rhythm, paired, 1 / framesPerCut) };
      }
      return timelineCache.starts;
    }

    // ---- synthesized music: rendered by the server for exactly this timeline; while it plays it is the player's clock ----
    function musicOn() { const v = document.getElementById('musicSelect').value; return !!v && v !== 'off'; }
    function musicParams() {
      const unit = id => (parseInt(document.getElementById(id).value, 10) || 0) / 100;
      return {
        bpm: parseInt(document.getElementById('bpmSlider').value, 10),
        multiple: parseFloat(document.getElementById('multSelect').value),
        invert_mode: document.getElementById('invertSelect').value,
        rhythm: document.getElementById('rhythmSelect').value,
        style: musicOn() ? document.getElementById('musicSelect').value : 'soil',
        pulse: unit('pulseRange'), low: unit('lowRange'), bright: unit('brightRange'), width: unit('widthRange'),
        seed: parseInt(document.getElementById('seedVal').value, 10) || 7
      };
    }
    const STYLE_HINTS = {
      soil: 'A wide, dark drone around 54 Hz with a tonal mid cluster, as in Soiltone and Ecwora (they share this track). The bed breathes with every cut.',
      swell: 'A pure mono 43 Hz sub with a bass swell every ~1.7 s and two bright bursts, as in Helione.',
      bass: 'A pulsing mono bass line that changes note on every cut, as in Moverunion.'
    };
    function setMusicState(kind, text) {
      const el = document.getElementById('musicState');
      el.hidden = !text;
      el.textContent = text || '';
      el.className = `music-state ${kind || ''}`;
    }
    function updateMusic() {
      const on = musicOn();
      for (const k of ['pulse', 'low', 'bright', 'width']) {
        const el = document.getElementById(`${k}Range`);
        document.getElementById(`${k}Val`).textContent = el.value;
        el.disabled = !on;
      }
      document.getElementById('seedBtn').disabled = !on;
      document.getElementById('styleHint').textContent = on ? (STYLE_HINTS[document.getElementById('musicSelect').value] || '') : 'No music: the preview and the export stay silent.';
      document.getElementById('seedNum').textContent = document.getElementById('seedVal').value;
      saveSettings();
      musicChanged();
    }
    function newVariation() {
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
    // the cut-length curve of the whole sequence (taller = a longer hold), only for the curves; and how long the result runs
    function drawRhythm() {
      const n = activePlates().length;
      const graph = document.getElementById('rhythmGraph');
      const line = document.getElementById('rhythmLine');
      const info = document.getElementById('rhythmInfo');
      const curved = !!CURVES[document.getElementById('rhythmSelect').value];
      graph.style.display = curved && n ? '' : 'none';   // (the hidden attribute does nothing on an SVG element)
      if (!n) { line.setAttribute('points', ''); info.textContent = ''; return; }
      const starts = timelineFor(n);
      const cuts = starts.length - 1;
      const lens = starts.slice(1).map((s, i) => s - starts[i]);
      const top = Math.max(...lens);
      const pts = [];
      const step = Math.max(1, Math.floor(cuts / 200));
      for (let i = 0; i < cuts; i += step) pts.push(`${((i / cuts) * 200).toFixed(1)},${(34 - (lens[i] / top) * 32).toFixed(1)}`);
      pts.push(`200,${(34 - (lens[cuts - 1] / top) * 32).toFixed(1)}`);
      line.setAttribute('points', pts.join(' '));
      const sec = c => (c * framesPerCut) / 30;
      const total = sec(starts[cuts]);
      const f = v => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(1)} s`);
      info.textContent = `${n} images · ${total >= 60 ? `${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')}` : `${total.toFixed(0)} s`} · cuts ${f(sec(lens[0]))}${top > lens[0] * 1.05 ? ` → ${f(sec(top))}` : ''}`;
    }
    function moveRhythmHead(starts) {
      const total = starts[starts.length - 1];
      const x = total > 0 ? ((((cutPos % total) + total) % total) / total) * 200 : 0;
      const h = document.getElementById('rhythmHead');
      h.setAttribute('x1', x.toFixed(1)); h.setAttribute('x2', x.toFixed(1));
    }

    // ---- synthesized music: rendered by the server for exactly this timeline; while it plays it is the player's clock ----
    let musicAudio = null, musicKey = '', musicPending = false, musicTimer = null, musicRender = 0;
    function musicKeyNow() { return JSON.stringify(musicParams()) + '|' + activePlates().length; }
    function stopMusic() {
      if (musicAudio) { try { musicAudio.pause(); } catch (e) {} }
      musicPending = false;
      document.getElementById('playBtn').textContent = isPlaying ? '⏸ Pause' : '▶ Play';
    }
    // makes sure the track for the current settings is rendered (a few seconds); true when it is ready
    async function ensureMusic() {
      const key = musicKeyNow();
      if (musicAudio && key === musicKey) return true;
      const mine = ++musicRender;
      setMusicState('busy', 'Rendering the music…');
      try {
        const res = await fetch('/api/music', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(musicParams()) });
        if (!res.ok) {
          let why = `HTTP ${res.status}`;
          try { why = (await res.json()).error || why; } catch (e) {}
          throw new Error(why);
        }
        const url = URL.createObjectURL(await res.blob());
        if (mine !== musicRender) return false;                             // the settings changed while rendering: a newer render is on its way
        if (musicAudio) URL.revokeObjectURL(musicAudio.src);
        musicAudio = new Audio(url);
        musicAudio.loop = true;
        musicKey = key;
        setMusicState('', 'Music ready');
        return true;
      } catch (e) {
        if (mine === musicRender) { musicAudio = null; musicKey = ''; setMusicState('err', `Could not render the music: ${e.message}`); setStatus(`Could not render the music: ${e.message}`); }
        return false;
      }
    }
    async function startMusic() {
      const btn = document.getElementById('playBtn');
      if (!musicAudio || musicKey !== musicKeyNow()) {
        musicPending = true;
        btn.textContent = '♪ Rendering…';
        const ok = await ensureMusic();
        musicPending = false;
        btn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
        if (!ok || !isPlaying || !musicOn() || musicKey !== musicKeyNow()) return;
      }
      cutPos = 0;
      lastTick = performance.now();
      musicAudio.currentTime = 0;
      try { await musicAudio.play(); } catch (e) { setStatus('The browser blocked the audio. Press Play again.'); }
    }
    // tempo, multiple, invert, rhythm or any music setting changed: the track no longer matches. Render the new one in the
    // background (so Play is instant), and restart it if the preview is playing.
    function musicChanged() {
      stopMusic();
      clearTimeout(musicTimer);
      if (!musicOn()) { musicRender++; setMusicState('', ''); return; }
      musicTimer = setTimeout(() => (isPlaying ? startMusic() : ensureMusic()), isPlaying ? 350 : 700);
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
      drawRhythm();
      musicChanged();   // invert changes the cuts, so the track must follow
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
        const cutMs = Math.max(16, (framesPerCut / 30) * 1000);
        if (musicAudio && !musicAudio.paused && musicOn()) cutPos = (musicAudio.currentTime * 1000) / cutMs;   // the track is the clock
        else cutPos += dt / cutMs;
        const fx = fxSettings();
        const tl = timelineFor(active.length);
        const plan = planAt(cutPos, active.length, fx.invert, tl);
        moveRhythmHead(tl);
        currentIdx = plan.plate;
        const url = active[plan.plate].preview || active[plan.plate].url;
        if (stageImg.getAttribute('src') !== url) stageImg.src = url;
        applyFx(plan, fx);
      }, 16);
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
    const PERSISTED = ['bpmSlider', 'multSelect', 'rhythmSelect', 'musicSelect', 'pulseRange', 'lowRange', 'brightRange', 'widthRange', 'seedVal', 'fxTabVal', 'invertSelect', 'zoomSelect', 'zoomAmt', 'batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput'];
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
      drawRhythm();
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
        const res = await fetch('/api/export-video', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            bpm: parseInt(document.getElementById('bpmSlider').value, 10),
            multiple: parseFloat(document.getElementById('multSelect').value),
            invert_mode: document.getElementById('invertSelect').value,
            rhythm: document.getElementById('rhythmSelect').value,
            music: musicOn() ? 'synth' : 'off',
            ...musicParams(),
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
          setStatus(`Export ready: ${data.images} images, ${data.seconds}s. The preview is unchanged.`);
        } else {
          setStatus(`Export failed: ${data.error || 'unknown error'}`);
        }
      } catch (e) {
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
  newVariation,
  showFxTab,
  togglePromptOverlay,
  toggleReticle,
  toggleSettings,
  updateTempo,
  updateFx,
});
