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

    let stateCalls = 0;
    async function loadState() {
      const call = ++stateCalls;
      const res = await fetch('/api/state');
      const data = await res.json();
      if (call !== stateCalls) return;                                       // a newer request is on its way: an older answer must not win
      const lengthBefore = activePlates().length;
      plates = data.plates || [];
      sequences = data.sequences || [];
      groups = data.groups || [];
      editsList = data.edits || [];
      if (currentEdit && !editsList.some(x => x.id === currentEdit)) setCurrentEdit(null);   // deleted elsewhere
      renderEditBar();
      if (!groupMembers(currentGroup)) currentGroup = 'all';                // a group that is gone (deleted, emptied by the library)
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
      renderGroups();
      renderGrid();
      renderFilmstrip();
      applyLocks();                                                          // nothing to export or trash when there are no images
      restartLoop();
      if (!isPlaying) drawFrame();
      if (data.state_sig) serverSig = data.state_sig;
      if (isPlaying && activePlates().length !== lengthBefore) musicChanged();   // trash, undo, a new image: the film is longer or shorter, the sound follows
    }

    // Refresh: the library and the film together (the two refresh buttons call the same thing, so they always agree).
    // By itself the page only asks the server for a cheap fingerprint (/api/version, every 1.5 s) and fetches the library when it moved,
    // at most every 15 s; the buttons fetch at once.
    let serverSig = null, lastAutoRefresh = 0, refreshing = false;
    async function refreshLibrary(manual) {
      if (refreshing) return;
      if (!manual && (document.hidden || draggedFilename || document.querySelector('.prompt-overlay.open'))) return;
      refreshing = true;
      ['refreshBtn', 'refreshFilmBtn'].forEach(id => document.getElementById(id).classList.add('spinning'));
      try {
        const known = new Set(plates.map(p => p.filename));
        const grid = document.getElementById('grid'), top = grid.scrollTop;
        await loadState();
        grid.scrollTop = top;
        const added = plates.filter(p => !known.has(p.filename) && !p.trashed).length;
        if (added && !prog.timer) setStatus(`+${added} new image${added === 1 ? '' : 's'}`);
        else if (manual) setStatus('Up to date.');
      } catch (e) {
        if (manual) setStatus('Could not reach the server. Is it running?');
      } finally {
        refreshing = false;
        ['refreshBtn', 'refreshFilmBtn'].forEach(id => document.getElementById(id).classList.remove('spinning'));
      }
    }
    function libraryMoved(sig) {
      if (!sig || serverSig === null || sig === serverSig || generating || aiRunning) return;     // a running job refreshes as it goes
      if (Date.now() - lastAutoRefresh < 15000) return;
      lastAutoRefresh = Date.now();
      refreshLibrary(false);
    }

    // the images in the edit: the shown ones, cut at the active order's cut_off when the AI picked "best N"
    function activeCutOff() {
      const cur = sequences.find(s => s.id === activeSeq);
      return cur && cur.cut_off ? cur.cut_off : null;
    }
    function activePlates() {
      const shown = inGroup(plates.filter(p => !p.trashed));
      const n = currentGroup === 'all' ? activeCutOff() : null;             // a best-N cut belongs to the whole selection
      return n ? shown.slice(0, n) : shown;
    }

    // ---- groups: All, yours (stored), and automatic ones from each image's look and territory. The grid and the film show the group chosen. ----
    let groups = [];
    // ---- edits: named ways of cutting this curation (Film only). An edit keeps the group it plays and every Film setting, never images or
    // an order, so it follows the curation. Stored on the server with the groups (/api/edits). ----
    let editsList = [], currentEdit = null;
    try { currentEdit = localStorage.getItem('studioEdit') || null; } catch (e) {}
    function setCurrentEdit(id) { currentEdit = id; try { if (id) localStorage.setItem('studioEdit', id); else localStorage.removeItem('studioEdit'); } catch (e) {} }
    const editOf = id => editsList.find(x => x.id === id) || null;
    function editSnap() { return { group: currentGroup, settings: { ...settingsSnap(), characterSelect: document.getElementById('characterSelect').value } }; }
    function editDirty() {
      const e = editOf(currentEdit);
      if (!e) return false;
      const now = editSnap();
      return e.group !== now.group || Object.keys(now.settings).some(k => k in e.settings && String(e.settings[k]) !== String(now.settings[k]));
    }
    function renderEditBar() {
      const e = editOf(currentEdit), name = document.getElementById('editName');
      if (!name) return;
      name.textContent = e ? e.name : editsList.length ? 'No snapshot selected' : 'No snapshot yet';
      name.classList.toggle('untitled', !e);
      document.getElementById('editDirty').hidden = !editDirty();
    }
    // a snapshot names itself, two words that still say something (rename it after): the first from the speed, the second from the group's look
    const NAME_PACE = {
      fast: ['Feral', 'Electric', 'Restless', 'Molten', 'Hyper', 'Frantic', 'Jittery', 'Wild', 'Voltage', 'Rapid'],
      mid: ['Lucid', 'Hollow', 'Neon', 'Static', 'Liquid', 'Lunar', 'Phantom', 'Silent', 'Mercury', 'Spectral'],
      slow: ['Velvet', 'Drowsy', 'Tidal', 'Hushed', 'Floating', 'Distant', 'Dreaming', 'Slow', 'Sunken', 'Gentle'],
    };
    const NAME_LOOK = {
      warm: ['Ember', 'Copper', 'Saffron', 'Magma', 'Rust', 'Amber'], cold: ['Cobalt', 'Glacier', 'Frost', 'Indigo', 'Tundra', 'Sapphire'],
      mono: ['Graphite', 'Ash', 'Chalk', 'Silver', 'Smoke', 'Pewter'], dark: ['Eclipse', 'Midnight', 'Abyss', 'Obsidian', 'Umbra', 'Nocturne'],
      bright: ['Halo', 'Flare', 'Daylight', 'Glare', 'Aurora', 'Solstice'],
      any: ['Orbit', 'Prism', 'Mirage', 'Signal', 'Lantern', 'Comet', 'Mantra', 'Nebula', 'Pulsar', 'Oracle', 'Monolith', 'Satellite'],
    };
    function autoEditName() {
      const rate = rhythmCutsPerSecond(), look = currentGroup.startsWith('look:') ? currentGroup.slice(5) : 'any';
      const first = NAME_PACE[rate > 4 ? 'fast' : rate < 1.5 ? 'slow' : 'mid'], second = NAME_LOOK[look] || NAME_LOOK.any;
      const taken = n => editsList.some(x => x.name.toLowerCase() === n.toLowerCase());
      for (let k = 0; k < 40; k++) { const n = `${rpick(first)} ${rpick(second)}`; if (!taken(n)) return n; }
      let n = `${rpick(first)} ${rpick(second)}`;
      for (let k = 2; taken(n); k++) n = `${n.replace(/ \d+$/, '')} ${k}`;
      return n;
    }
    async function editsCall(payload) {
      const res = await (await fetch('/api/edits', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) })).json();
      if (!res.ok) { setStatus(res.error || 'Could not do that.'); return null; }
      await loadState();
      return res;
    }
    function openEditMenu(e, form) {
      if (e && e.stopPropagation) e.stopPropagation();
      const m = document.getElementById('editMenu');
      if (!m.hidden && !form) { closeEditMenu(); return; }
      const cur = editOf(currentEdit);
      const groupName = key => { const all = groupChips(); const c = all.chips.concat(all.auto).find(x => x.key === key); return c ? c.name : 'All'; };
      m.innerHTML = (editsList.length ? '' : '<div class="em-empty">No snapshots yet. ＋ Snapshot (⌘S) keeps this film as it is now.</div>')
        + editsList.map(x => `<button type="button" class="gm-item${x.id === currentEdit ? ' on' : ''}" data-id="${x.id}" onclick="openEdit(this.dataset.id)">${escapeHtml(x.name)}<span class="em-group">${escapeHtml(groupName(x.group))}</span></button>`).join('')
        + (cur ? '<hr>' + (form === 'rename'
          ? `<form class="gm-new" onsubmit="event.preventDefault(); renameEdit(this.elements.name.value)"><input name="name" id="editNameInput" type="text" maxlength="40" value="${escapeHtml(cur.name)}" autocomplete="off" /><button type="submit">Rename</button></form>`
          : `<button type="button" class="gm-item" id="editReplaceBtn" onclick="replaceEdit()"${editDirty() ? '' : ' disabled title="Nothing changed since this snapshot"'}>Replace with the current film…</button>`
            + `<button type="button" class="gm-item" onclick="openEditMenu(event, 'rename')">Rename…</button>`
            + `<button type="button" class="gm-item danger-text" onclick="deleteEdit()">Delete</button>`) : '');
      const anchor = document.getElementById('editBtn').getBoundingClientRect();
      m.hidden = false;
      m.style.top = `${anchor.bottom + 6}px`;
      m.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - m.offsetWidth - 8))}px`;
      if (form) { const i = document.getElementById('editNameInput'); if (i && i.focus) i.focus(); if (i && i.select) i.select(); }
    }
    function closeEditMenu() { const m = document.getElementById('editMenu'); if (m) m.hidden = true; }
    document.addEventListener('click', e => { if (!(e.target.closest && (e.target.closest('#editMenu') || e.target.closest('#editBtn')))) closeEditMenu(); });
    // switching: the group and every setting at once, the film carries on; one undo step
    function applyEdit(state) {
      applySnap(state.settings);
      if (groupMembers(state.group)) setGroup(state.group); else setGroup('all');
      setCurrentEdit(state.id || null);
      syncSegs(); syncSelects(); saveSettings(); musicChanged(); renderEditBar();
    }
    function openEdit(id) {
      const e = editOf(id);
      closeEditMenu();
      if (!e) return;
      const before = { ...editSnap(), id: currentEdit }, after = { group: e.group, settings: { ...settingsSnap(), ...e.settings }, id };
      pushStep({ label: `Open “${e.name}”`, undo: () => applyEdit(before), redo: () => applyEdit(after) });
      applyEdit(after);
      setStatus(`“${e.name}”`);
    }
    // ＋ Snapshot / ⌘S: always a new edit, never over one; named for what it is
    async function snapshotEdit() {
      commitSettings();
      const res = await editsCall({ action: 'create', name: autoEditName(), ...editSnap() });
      if (!res) return;
      closeEditMenu();
      setCurrentEdit(res.edit.id); renderEditBar();
      const e = res.edit;
      const step = pushStep({ label: `Snapshot “${e.name}”`, undo: async () => { await editsCall({ action: 'delete', id: e.id }); setCurrentEdit(null); renderEditBar(); }, redo: async () => { await editsCall({ action: 'restore', edit: e }); setCurrentEdit(e.id); renderEditBar(); } });
      setStatus(`Snapshot “${e.name}”. Rename it from the menu.`, { label: 'Undo', run: () => undoStep(step) });
    }
    // replacing a snapshot overwrites it: asked first, and undoable
    async function replaceEdit() {
      const e = editOf(currentEdit);
      closeEditMenu();
      if (!e || !editDirty()) return;
      if (!(await askConfirm(`Replace “${e.name}”?`, 'The snapshot takes the film as it is now: its group and every setting. Undo (⌘Z) puts the old one back.', 'Replace'))) return;
      commitSettings();
      const before = { group: e.group, settings: e.settings }, after = editSnap();
      if (!await editsCall({ action: 'update', id: e.id, ...after })) return;
      pushStep({ label: `Replace “${e.name}”`, undo: () => editsCall({ action: 'update', id: e.id, ...before }).then(renderEditBar), redo: () => editsCall({ action: 'update', id: e.id, ...after }).then(renderEditBar) });
      renderEditBar();
      setStatus(`“${e.name}” replaced.`);
    }
    async function renameEdit(name) {
      const e = editOf(currentEdit);
      if (e && await editsCall({ action: 'rename', id: e.id, name })) { closeEditMenu(); renderEditBar(); }
    }
    async function deleteEdit() {
      const e = editOf(currentEdit);
      closeEditMenu();
      if (!e) return;
      if (!(await askConfirm(`Delete “${e.name}”?`, 'The snapshot goes; the film on screen and your images stay as they are. Undo (⌘Z) brings it back.', 'Delete'))) return;
      if (!await editsCall({ action: 'delete', id: e.id })) return;
      setCurrentEdit(null); renderEditBar();
      const step = pushStep({ label: `Delete “${e.name}”`, undo: async () => { await editsCall({ action: 'restore', edit: e }); setCurrentEdit(e.id); renderEditBar(); }, redo: async () => { await editsCall({ action: 'delete', id: e.id }); setCurrentEdit(null); renderEditBar(); } });
      setStatus(`“${e.name}” deleted.`, { label: 'Undo', run: () => undoStep(step) });
    }
    let currentGroup = (() => { try { return localStorage.getItem('studioGroup') || 'all'; } catch (e) { return 'all'; } })();
    const LOOKS = [['warm', 'Warm'], ['cold', 'Cold'], ['mono', 'Mono'], ['dark', 'Dark'], ['bright', 'Bright']];
    // the members of a group key ('all', 'g:<id>', 'look:<tag>', 'world:<name>'), or null when there is no such group
    function groupMembers(key) {
      if (key === 'all') return 'all';
      const shown = plates.filter(p => !p.trashed);
      if (key.startsWith('g:')) { const g = groups.find(x => x.id === key.slice(2)); return g ? new Set(g.files) : null; }
      if (key.startsWith('look:')) { const set = new Set(shown.filter(p => (p.look || []).includes(key.slice(5))).map(p => p.filename)); return set.size ? set : null; }
      if (key.startsWith('world:')) { const set = new Set(shown.filter(p => p.world === key.slice(6)).map(p => p.filename)); return set.size ? set : null; }
      return null;
    }
    function inGroup(list) {
      const m = groupMembers(currentGroup);
      return m === 'all' || !m ? list : list.filter(p => m.has(p.filename));
    }
    function ownGroup() { return currentGroup.startsWith('g:') ? groups.find(g => g.id === currentGroup.slice(2)) : null; }
    // the chips: All, your groups, then the automatic ones that have a few images (looks first, then territories)
    function groupChips() {
      const shown = plates.filter(p => !p.trashed), count = key => { const m = groupMembers(key); return m === 'all' ? shown.length : m ? [...m].filter(f => shown.some(p => p.filename === f)).length : 0; };
      const chips = [{ key: 'all', name: 'All', n: shown.length }];
      groups.forEach(g => chips.push({ key: `g:${g.id}`, name: g.name, n: count(`g:${g.id}`), own: true }));
      const auto = [];
      LOOKS.forEach(([tag, name]) => { const n = count(`look:${tag}`); if (n >= 2) auto.push({ key: `look:${tag}`, name, n }); });
      const worlds = {};
      shown.forEach(p => { if (p.world) worlds[p.world] = (worlds[p.world] || 0) + 1; });
      Object.entries(worlds).filter(([, n]) => n >= 6).sort((a, b) => b[1] - a[1]).forEach(([w, n]) => auto.push({ key: `world:${w}`, name: w, n }));
      return { chips, auto };
    }
    function renderGroups() {
      const bar = document.getElementById('groupBar');
      document.getElementById('groupRow').hidden = showTrash;
      const { chips, auto } = groupChips();
      const menu = '<button type="button" class="chip-more" id="groupMenuBtn" onclick="openGroupMenu(event, \'edit\')" title="Rename or delete this group" aria-label="Rename or delete this group"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></button>';
      const chip = c => `<button type="button" class="chip${c.key === currentGroup ? ' on' : ''}${c.own ? ' own' : ''}" data-key="${escapeHtml(c.key)}" onclick="setGroup(this.dataset.key)">${escapeHtml(c.name)} <span>${c.n}</span></button>${c.own && c.key === currentGroup ? menu : ''}`;   // your group's menu sits right after its chip
      bar.innerHTML = chips.map(chip).join('') + (auto.length ? '<i class="chip-sep"></i>' + auto.map(chip).join('') : '');
      const own = ownGroup();
      document.getElementById('removeFromGroupBtn').hidden = !own;
      // the same choice in Film, as a dropdown above the film strip
      const fg = document.getElementById('filmGroup');
      const opt = c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.name)} (${c.n})</option>`;
      fg.innerHTML = chips.map(opt).join('') + (auto.length ? `<optgroup label="Automatic">${auto.map(opt).join('')}</optgroup>` : '');
      fg.value = currentGroup;
      syncSelects();
      revealGroupChip();
      groupFade();
      document.getElementById('miniTitle').textContent = currentGroup === 'all' ? 'Film' : (chips.concat(auto).find(c => c.key === currentGroup) || { name: 'Film' }).name;
      const len = document.getElementById('aiLength');
      len.disabled = currentGroup !== 'all';                                 // best N is for the whole selection
      if (len.disabled) len.value = '';
    }
    // the chips scroll sideways (trackpad, Shift+wheel, or the wheel itself); a fade shows on the side that has more
    let shownGroup = null;
    function revealGroupChip() {                                             // a new choice (here, from Film, or on load): its chip into view, once the row can be seen
      const bar = document.getElementById('groupBar'), on = bar.querySelector && bar.querySelector('.chip.on');
      if (shownGroup === currentGroup || !on || !bar.clientWidth || !on.scrollIntoView) return;
      shownGroup = currentGroup;
      on.scrollIntoView({ block: 'nearest', inline: 'center' });            // centred: clear of the fades
      groupFade();
    }
    function groupFade() {
      const b = document.getElementById('groupBar');
      if (!b.classList || b.scrollWidth === undefined) return;
      b.classList.toggle('fade-l', b.scrollLeft > 1);
      b.classList.toggle('fade-r', b.scrollLeft + b.clientWidth < b.scrollWidth - 1);
    }
    (() => {
      const b = document.getElementById('groupBar');
      if (!b.addEventListener) return;
      b.addEventListener('scroll', groupFade, { passive: true });
      b.addEventListener('wheel', e => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && b.scrollWidth > b.clientWidth) { b.scrollLeft += e.deltaY; e.preventDefault(); }
      }, { passive: false });
      window.addEventListener('resize', groupFade);
    })();
    function setGroup(key) {
      if (!groupMembers(key)) key = 'all';
      if (key === currentGroup) return;
      currentGroup = key;
      try { localStorage.setItem('studioGroup', key); } catch (e) {}
      pickSel = new Set();
      renderGroups(); renderGrid(); renderFilmstrip(); renderEditBar();
      cutPos = 0; clockPos = null; currentIdx = 0;                           // a new film: from its first image
      if (isPlaying && droneLive.playing) droneLive.restart(synthParams(), synthStartsSec());
      musicChanged();
      if (!isPlaying) drawFrame();
    }

    // ---- picking cards (Cmd/Ctrl-click, Shift-click for a range, Cmd+A for all) to add them to a group or take them out ----
    let pickSel = new Set(), lastPick = null;
    function togglePick(e, filename) {
      const list = visiblePlates().map(p => p.filename);
      if (e.shiftKey && lastPick && list.includes(lastPick)) {
        const [a, b] = [list.indexOf(lastPick), list.indexOf(filename)].sort((x, y) => x - y);
        list.slice(a, b + 1).forEach(f => pickSel.add(f));
      } else if (pickSel.has(filename)) pickSel.delete(filename);
      else pickSel.add(filename);
      lastPick = filename;
      syncSelection();
    }
    function pickClick(e, filename) { e.stopPropagation(); togglePick(e, filename); }   // the circle on a card: picking without knowing ⌘-click
    function pickAll() { pickSel = new Set(visiblePlates().map(p => p.filename)); syncSelection(); }
    function clearPicks() { pickSel = new Set(); closeGroupMenu(); syncSelection(); }
    function updatePickBar() {
      const n = showTrash ? 0 : pickSel.size;
      document.getElementById('pickBar').hidden = !n;
      document.getElementById('pickCount').textContent = `${n} selected`;
      document.body.classList.toggle('picking', n > 0);                     // every card shows its circle while picking
      groupFade();                                                           // the bar takes width from the chips
    }
    async function groupsCall(payload) {
      const res = await (await fetch('/api/groups', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) })).json();
      if (!res.ok) { setStatus(res.error || 'Could not do that.'); return null; }
      await loadState();
      return res;
    }
    // the menu next to the picks (Add to group) and next to your group's chip (Rename, Delete): one popover, two uses
    let groupMenuFor = null;
    function openGroupMenu(e, mode) {
      if (e) e.stopPropagation();
      const m = document.getElementById('groupMenu');
      if (!m.hidden && groupMenuFor === mode) { closeGroupMenu(); return; }
      groupMenuFor = mode;
      const own = ownGroup();
      m.innerHTML = mode === 'add'
        ? groups.map(g => `<button type="button" class="gm-item" data-id="${g.id}" onclick="addToGroup(this.dataset.id)">${escapeHtml(g.name)}</button>`).join('')
          + `<form class="gm-new" onsubmit="event.preventDefault(); newGroup(this.elements.name.value)"><input name="name" id="groupNameInput" type="text" maxlength="40" placeholder="New group…" autocomplete="off" /><button type="submit">Add</button></form>`
        : `<form class="gm-new" onsubmit="event.preventDefault(); renameGroup(this.elements.name.value)"><input name="name" id="groupNameInput" type="text" maxlength="40" value="${escapeHtml(own ? own.name : '')}" autocomplete="off" /><button type="submit">Rename</button></form>`
          + `<button type="button" class="gm-item danger-text" onclick="deleteGroup()">Delete group</button>`;
      const anchor = document.getElementById(mode === 'add' ? 'addToGroupBtn' : 'groupMenuBtn').getBoundingClientRect();
      m.hidden = false;
      m.style.top = `${anchor.bottom + 6}px`;
      m.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - m.offsetWidth - 8))}px`;
      if (mode === 'add' && !groups.length || mode === 'edit') { const i = document.getElementById('groupNameInput'); if (i && i.focus) i.focus(); if (mode === 'edit' && i && i.select) i.select(); }
    }
    function closeGroupMenu() { const m = document.getElementById('groupMenu'); if (m) m.hidden = true; groupMenuFor = null; }
    document.addEventListener('click', e => { if (!(e.target.closest && (e.target.closest('#groupMenu') || e.target.closest('#addToGroupBtn') || e.target.closest('#groupMenuBtn')))) closeGroupMenu(); });
    async function addToGroup(id) {
      const g = groups.find(x => x.id === id), files = [...pickSel].filter(f => g && !g.files.includes(f));
      closeGroupMenu();
      if (!g) return;
      if (files.length && await groupsCall({ action: 'add', id, files })) {
        pushStep({ label: `Add to “${g.name}”`, undo: () => groupsCall({ action: 'remove', id, files }), redo: () => groupsCall({ action: 'add', id, files }) });
      }
      setStatus(`${pickSel.size} in “${g.name}”.`); clearPicks();
    }
    async function newGroup(name) {
      const files = [...pickSel];
      const res = await groupsCall({ action: 'create', name, files });
      if (!res) return;
      closeGroupMenu();
      const g = res.group;
      pushStep({ label: `New group “${g.name}”`, undo: () => groupsCall({ action: 'delete', id: g.id }), redo: () => groupsCall({ action: 'restore', group: g }) });
      clearPicks();
      setGroup(`g:${g.id}`);
    }
    async function removeFromGroup() {
      const g = ownGroup(), files = [...pickSel];
      if (!g || !files.length) return;
      if (await groupsCall({ action: 'remove', id: g.id, files })) pushStep({ label: `Remove from “${g.name}”`, undo: () => groupsCall({ action: 'add', id: g.id, files }), redo: () => groupsCall({ action: 'remove', id: g.id, files }) });
      clearPicks();
    }
    async function renameGroup(name) {
      const g = ownGroup(); if (!g) return;
      const old = g.name;
      if (await groupsCall({ action: 'rename', id: g.id, name })) { closeGroupMenu(); pushStep({ label: `Rename “${old}”`, undo: () => groupsCall({ action: 'rename', id: g.id, name: old }), redo: () => groupsCall({ action: 'rename', id: g.id, name }) }); }
    }
    async function deleteGroup() {
      const g = ownGroup(); if (!g) return;
      closeGroupMenu();
      const res = await groupsCall({ action: 'delete', id: g.id });
      if (!res) return;
      const kept = res.group || g;
      const step = pushStep({ label: `Delete “${g.name}”`, undo: () => groupsCall({ action: 'restore', group: kept }), redo: () => groupsCall({ action: 'delete', id: g.id }) });
      setGroup('all');
      setStatus(`Group “${g.name}” deleted (the images stay).`, { label: 'Undo', run: () => undoStep(step) });
    }

    function visiblePlates() {
      const num = p => parseInt(p.filename, 10) || 0;
      return showTrash
        // newest trashed first; plates trashed before timestamps existed fall back to creation number
        ? plates.filter(p => p.trashed).sort((a, b) => (b.trashed_at || 0) - (a.trashed_at || 0) || num(b) - num(a))
        : inGroup(plates.filter(p => !p.trashed));
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
      if (exporting) { setStatus('Wait for the export to finish before ordering with AI.'); return; }
      if (aiRunning) return;
      if (!ensureKimiReady()) return;
      const shown = plates.filter(p => !p.trashed).length;
      if (shown < 2) { setStatus('Keep at least two images before ordering.'); return; }
      const before = { order: plates.filter(p => !p.trashed).map(p => p.filename), cut_off: activeCutOff() };   // for Undo: the order as it was
      const body = {
        length: currentGroup === 'all' ? parseInt(document.getElementById('aiLength').value, 10) || null : null,
        direction: document.getElementById('aiDirection').value.trim(),
        ...(currentGroup === 'all' ? {} : { files: activePlates().map(p => p.filename) }),   // a group: its images change places among themselves
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
            progStop(`Done — AI re-order: ${job.sequence.summary}`);
            await loadState();
            const after = { order: plates.filter(p => !p.trashed).map(p => p.filename), cut_off: activeCutOff() };
            const step = pushStep({ label: 'AI re-order', undo: () => restoreOrder(before), redo: () => restoreOrder(after) });
            setStatus('The AI re-ordered your images.', { label: 'Undo', run: () => undoStep(step) });
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

    // ---- one order: yours, that the AI can rearrange on request (and Undo puts back) ----
    let sequences = [];
    let activeSeq = null;
    function renderSequences() {
      document.getElementById('seqBox').hidden = showTrash;
      document.getElementById('aiBtn').disabled = aiRunning || generating;
    }
    async function seqCall(payload) {
      const res = await (await fetch('/api/sequence', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) })).json();
      if (!res.ok) { setStatus(res.error || 'Could not do that.'); return false; }
      await loadState();
      return true;
    }
    // Undo / Redo of an AI re-order: the order and its best-N cut as they were
    function restoreOrder(o) { return seqCall({ action: 'restore', order: o.order, cut_off: o.cut_off }); }
    function includeAll() { return blockedByAi() ? undefined : seqCall({ action: 'include_all' }); }

    let trashSel = new Set();
    let lastSel = null;
    function cardClick(e, filename) {
      if (!showTrash) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || pickSel.size) { togglePick(e, filename); return; }   // picking: Cmd/Ctrl/Shift-click, then plain clicks add too
        previewPlate(filename); return;
      }
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
      const sel = showTrash ? trashSel : pickSel;
      document.querySelectorAll('.card[data-filename]').forEach(el => el.classList.toggle('sel', sel.has(el.dataset.filename)));
      updateTrashBar();
      updatePickBar();
    }
    function updateTrashBar() {
      const trashed = plates.filter(p => p.trashed).map(p => p.filename);
      trashSel = new Set([...trashSel].filter(f => trashed.includes(f)));
      document.getElementById('trashBar').hidden = !(showTrash && trashed.length);
      document.getElementById('trashSelCount').textContent = `${trashSel.size} selected`;
      document.getElementById('trashDelSel').disabled = aiRunning || trashSel.size === 0;
      document.getElementById('trashRestoreSel').disabled = aiRunning || trashSel.size === 0;
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

    // images that arrived since the page opened get a "New" mark
    let seenAtLoad = null;
    function renderGrid() {
      const grid = document.getElementById('grid');
      const visible = visiblePlates();
      if (seenAtLoad === null && plates.length) seenAtLoad = new Set(plates.map(p => p.filename));
      const cutOff = showTrash ? null : activeCutOff();
      const items = [];
      visible.forEach((p, i) => {
        if (cutOff && i === cutOff && i < visible.length) items.push(['divider', `<div class="edit-divider">left out of this edit (${visible.length - cutOff}) <button onclick="includeAll()">Include them all</button></div>`]);
        items.push([`card:${p.filename}`, cardHtml(p)]);
      });
      if (!showTrash) pendingCards().forEach((html, i) => items.push([`pending:${i}`, html]));
      if (gridView !== showTrash && grid.replaceChildren) {                  // switching Selection / Trash: put the other view's cards back instead of rebuilding them
        const keep = [...grid.children];
        grid.replaceChildren(...(viewCards.get(showTrash) || []));
        viewCards.set(gridView, keep);
      }
      gridView = showTrash;
      patchChildren(grid, items);
      const empty = document.getElementById('gridEmpty');
      empty.hidden = items.length > 0;
      empty.textContent = showTrash ? 'The Trash is empty.' : 'No images yet. Choose a territory and press Generate.';
      if (grid.querySelectorAll) grid.querySelectorAll('.card[data-filename]').forEach((el, i) => {   // the place in the order lives outside the markup, so a reorder only moves cards
        const num = el.querySelector('.card-num'), txt = String(i + 1).padStart(2, '0');
        if (num && num.textContent !== txt) num.textContent = txt;
        el.classList.toggle('out', !!(cutOff && i >= cutOff));
      });
      document.getElementById('gridHint').textContent = gridHintText();
      syncSelection();
    }
    // Only what changed is touched: a card whose markup is the same keeps its element (its image stays decoded, an open info panel stays open);
    // new ones are made, gone ones removed, moved ones moved. The keys are the file names.
    const shownHtml = new WeakMap();
    let gridView = false;
    const viewCards = new Map();                                             // the cards of the view not shown (Selection or Trash), kept for the way back
    function patchChildren(box, items) {
      if (!box.insertBefore || !box.children) { box.innerHTML = items.map(x => x[1]).join(''); return; }   // the test page has no real DOM
      const old = new Map([...box.children].map(el => [el.dataset.key, el]));
      const tpl = document.createElement('template');
      items.forEach(([key, html], i) => {
        let el = old.get(key);
        if (el && shownHtml.get(el) !== html) { el.remove(); el = null; }
        if (!el) { tpl.innerHTML = html.trim(); el = tpl.content.firstElementChild; el.dataset.key = key; shownHtml.set(el, html); }
        old.delete(key);
        if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
      });
      old.forEach(el => el.remove());
    }
    function cardHtml(p) {
      return `
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
            <img src="${p.thumb || p.url}" loading="lazy" decoding="async" alt="" />
            <span class="card-num"></span>
            ${!showTrash && seenAtLoad && !seenAtLoad.has(p.filename) ? '<span class="card-new">New</span>' : ''}
            ${showTrash ? '<span class="card-pick" aria-hidden="true"></span>' : `<button type="button" class="card-pick" title="Pick (⌘-click) to add to a group" aria-label="Pick ${escapeHtml(p.title)}" onclick="pickClick(event, '${p.filename}')"></button>`}
            <div class="card-actions">
              ${showTrash ? '' : '<span class="drag-handle" title="Drag to reorder" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></span><span class="grow"></span>'}
              <button class="action-btn info-btn" title="The prompt and the model" aria-label="Info for ${escapeHtml(p.title)}" onclick="togglePromptOverlay(event, '${p.filename}')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg></button>
              ${p.trashed
                ? `<button class="action-btn restore-btn" onclick="setTrash(event, '${p.filename}', false)">Restore</button>`
                : `<button class="action-btn trash-btn" title="Move to the Trash" aria-label="Move ${escapeHtml(p.title)} to the Trash" onclick="setTrash(event, '${p.filename}', true)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg></button>`
              }
            </div>
            <div class="prompt-overlay" id="overlay-${CSS.escape(p.filename)}" onclick="togglePromptOverlay(event, '${p.filename}')">
              <div class="prompt-overlay-text">${p.world ? `<b class="po-world">${escapeHtml(p.world)}</b>` : ''}${p.idea ? `<i class="po-idea">${escapeHtml(p.idea)}</i>` : ''}<span class="po-prompt">${escapeHtml(p.prompt || p.title)}</span>${p.critic ? `<span class="po-critic">AI critic ${p.critic.mean}: ${escapeHtml(p.critic.reason)}</span>` : ''}</div>
              <div class="prompt-overlay-meta"><button class="po-copy" onclick="copyPromptText(event, '${p.filename}')">Copy prompt</button></div>
            </div>
          </div>
          <div class="card-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
          <div class="card-meta">
            <span class="card-model-badge">${escapeHtml(formatModelShort(p.model))}</span>
            ${p.critic ? `<span class="card-model-badge" title="${escapeHtml(p.critic.reason)}">AI ${p.critic.mean}</span>` : ''}
            ${p.trash_reason ? `<span class="card-model-badge warn" title="${escapeHtml(p.trash_reason)}">${escapeHtml(p.trash_reason.slice(0, 40))}</span>` : ''}
            ${!p.qa_passed ? `<span class="card-model-badge warn" title="${escapeHtml((p.qa_issues || []).join(', '))}">QA flagged</span>` : ''}
          </div>
        </div>`;
    }
    function gridHintText() { return showTrash ? 'Trashed images stay restorable' : aiRunning ? 'Locked while the AI orders' : ''; }   // dragging needs no hint
    // the images still being made, at the end of the selection while a batch runs
    function pendingCards() {
      if (!generating || prog.stage !== 'render') return [];
      return prog.slots.map((st, i) => (st === 'wait' || st === 'run'
        ? `<div class="card pending-card" aria-hidden="true"><div class="card-thumb"><div class="pending-ring"></div><span class="pending-label">${st === 'run' ? 'Rendering' : 'Queued'}</span><div class="pending-bar ${st}"><i></i></div></div><div class="card-title">${escapeHtml(prog.titles[i] || '')}</div><div class="card-meta"><span class="card-model-badge">generating…</span></div></div>`
        : '')).filter(Boolean);
    }
    function refreshPending() { if (generating) renderGrid(); }          // only the placeholders change, so only they are touched
    // thumbnail size in Curate: S, M or L
    function setThumbSize(v) {
      if (!['S', 'M', 'L'].includes(v)) v = 'M';
      document.getElementById('thumbSizeVal').value = v;
      document.getElementById('grid').dataset.size = v;
      for (const k of ['S', 'M', 'L']) document.getElementById(`thumb${k}`).setAttribute('aria-pressed', String(k === v));
      saveSettings();
    }
    // the floating film preview in Curate: the same stage, moved here, so there is one player and one sound
    let miniOpen = true;
    function toggleMini(open) {
      miniOpen = open;
      document.getElementById('miniPlayer').hidden = !open;
      document.getElementById('miniPill').hidden = open;
      try { localStorage.setItem('studioMini', open ? '1' : '0'); } catch (e) {}
    }
    // trashed images go back to the selection, in one go
    async function restoreSelected() {
      if (blockedByAi() || !trashSel.size) return;
      const files = [...trashSel];
      const set = trashed => async () => { for (const filename of files) await fetch('/api/trash', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename, trashed }) }); await loadState(); };
      await set(false)();
      trashSel = new Set();
      pushStep({ label: `Restore ${files.length} image${files.length === 1 ? '' : 's'}`, undo: set(true), redo: set(false) });
      setStatus(`${files.length} image${files.length === 1 ? '' : 's'} back in the selection.`);
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
      if (!el) return;
      const open = el.classList.toggle('open');
      const card = el.closest ? el.closest('.card') : null;
      if (card) card.classList.toggle('info-open', open);                   // the number and the buttons step back while it is open
    }

    // the prompt is looked up by file name: written into the onclick attribute, its own quotes broke the handler
    function copyPromptText(e, filename) {
      e.stopPropagation();
      const p = plates.find(x => x.filename === filename);
      const text = p ? p.prompt || p.title || '' : String(filename || '');
      Promise.resolve(navigator.clipboard && navigator.clipboard.writeText(text)).then(() => setStatus('Prompt copied.'), () => setStatus('Could not copy: the browser refused the clipboard.'));
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

      const before = plates.map(p => p.filename);
      const [moved] = plates.splice(fromIdx, 1);
      plates.splice(toIdx, 0, moved);
      const after = plates.map(p => p.filename);
      const reorder = order => async () => {
        await fetch('/api/reorder', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ order }) });
        await loadState();
      };
      await reorder(after)();
      pushStep({ label: `Move “${moved.title}”`, undo: reorder(before), redo: reorder(after) });
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
      const stage = document.getElementById('stage'), host = document.getElementById(mode === 'film' ? 'stageHome' : 'stageMini');
      if (stage.parentNode !== host && host.appendChild) host.appendChild(stage);
      if (mode === 'film') scrollFilmstripTo(currentIdx);
      else revealGroupChip();
    }
    // Tab switches the mode and Space plays, except while typing in a field (Tab still moves between fields there)
    function typingIn(t) {
      if (!t || !t.tagName) return false;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
      return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type);
    }
    // Keys (none while typing in a field): Tab mode · Space play · ← → one image · 0 / Home back to the start · Delete trash the image on screen (Film)
    // · F full screen · T the logo target · R Random (video and sound) · S Random sound · Cmd/Ctrl+Z undo
    function onKey(e) {
      if (typingIn(e.target) || document.getElementById('confirmModal').classList.contains('open')) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redoLast(); else undoLast(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A') && mode === 'curate' && !showTrash) { e.preventDefault(); pickAll(); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (mode === 'film') { flash('editSaveBtn'); snapshotEdit(); } return; }   // a new snapshot (never the browser's Save Page)
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat && ['Tab', 'f', 'F', 't', 'T', 'r', 'R', 's', 'S'].includes(e.key)) { e.preventDefault(); return; }   // a held key acts once
      if (e.target && e.target.type === 'range' && e.key.startsWith('Arrow')) return;             // a slider with focus keeps its arrows
      if (e.key === 'Tab') { e.preventDefault(); if (e.target && e.target.blur) e.target.blur(); setMode(mode === 'film' ? 'curate' : 'film'); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stepImage(e.key === 'ArrowRight' ? 1 : -1); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFullscreen(); }
      else if (e.key === '0' || e.key === 'Home') { e.preventDefault(); flash('restartBtn'); toStart(); }
      else if (e.key === '?') { e.preventDefault(); toggleKeys(); }
      else if (e.key === 'Escape') { document.getElementById('keysPanel').hidden = true; if (pickSel.size) clearPicks(); }
      else if (e.key === 't' || e.key === 'T') { e.preventDefault(); flash(mode === 'film' ? 'targetBtn' : 'gridTargetBtn'); toggleReticle(); }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); flash('randomAllBtn'); randomAll(); }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); flash('randomBtn'); if (!musicOn()) { setv('musicSelect', 'on'); } randomMusic(); }
    }
    // a key shows which button it pressed: the button flashes as if clicked
    function flash(id) {
      const b = document.getElementById(id);
      b.classList.remove('flash');
      void b.offsetWidth;                                                    // restart the animation when pressed again quickly
      b.classList.add('flash');
      setTimeout(() => b.classList.remove('flash'), 400);
    }
    // back to the first image and the start of the sound; playing or not, it keeps playing or stays paused
    function toStart() {
      cutPos = 0; lastTick = performance.now(); clockPos = null;
      if (isPlaying && droneLive.playing) droneLive.restart(synthParams(), synthStartsSec());
      drawFrame();
    }
    // in full screen the controls show while the mouse moves and fade after 2 s of stillness
    let fsIdleTimer = null;
    function fsWake() {
      const st = document.getElementById('stage');
      st.classList.remove('idle');
      clearTimeout(fsIdleTimer);
      fsIdleTimer = setTimeout(() => st.classList.add('idle'), 2000);
    }
    document.getElementById('stage').addEventListener('mousemove', fsWake);
    document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement) fsWake(); else document.getElementById('stage').classList.remove('idle'); });
    // the list of keys: ? or the hint in the header; Esc or a click elsewhere closes it
    function toggleKeys(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      const p = document.getElementById('keysPanel');
      p.hidden = !p.hidden;
    }
    document.addEventListener('click', () => { document.getElementById('keysPanel').hidden = true; });
    // one image back or forward (wraps), playing or not
    function stepImage(d) {
      const n = activePlates().length;
      if (n) jumpToPlate((currentIdx + d + n) % n);
    }
    // the preview fills the screen; F or Esc leaves
    function toggleFullscreen() {
      const stage = document.getElementById('stage');
      if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); return; }
      if (mode === 'curate' && !miniOpen) return;                          // the stage is hidden: nothing to show
      if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
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
      syncSelects();
      document.querySelectorAll('.segctl').forEach(box => {
        const sel = document.getElementById(box.dataset.for);
        box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === sel.value)));
      });
    }
    // ---- Dropdowns in the app's style. The real <select> stays, invisible, on top of its face: it keeps the value (saved, read,
    // tested), the focus and the keyboard. A click or Enter opens our menu instead of the system's; it opens downward, or upward
    // when there is more room above. ----
    function enhanceSelects() {
      document.querySelectorAll('select:not(.seg-src)').forEach(sel => {
        if (sel.parentElement && sel.parentElement.classList.contains('csel')) return;
        const box = document.createElement('span'); box.className = 'csel'; box.dataset.for = sel.id;
        const face = document.createElement('span'); face.className = 'csel-face'; face.setAttribute('aria-hidden', 'true');
        sel.before(box); box.append(face, sel);
        sel.addEventListener('mousedown', e => { e.preventDefault(); sel.focus(); if (menuFor === sel) closeMenu(); else openMenu(sel); });
        sel.addEventListener('keydown', e => menuKey(e, sel));
        sel.addEventListener('change', syncSelects);
      });
      syncSelects();
    }
    function syncSelects() {
      document.querySelectorAll('.csel').forEach(box => {
        const sel = box.querySelector('select'), o = sel.options[sel.selectedIndex];
        const face = box.firstElementChild, t = o ? o.textContent.trim() : '';
        if (face.textContent !== t) face.textContent = t;
        box.classList.toggle('disabled', sel.disabled);
      });
    }
    let menuFor = null, menuActive = -1;
    function cselMenu() {
      let m = document.getElementById('cselMenu');
      if (m) return m;
      m = document.createElement('div'); m.id = 'cselMenu'; m.className = 'csel-menu'; m.setAttribute('role', 'listbox'); m.hidden = true;
      m.addEventListener('mousedown', e => e.preventDefault());               // the select keeps the focus
      m.addEventListener('click', e => { const it = e.target.closest('.csel-item'); if (it && !it.classList.contains('off')) pickOption(+it.dataset.i); });
      m.addEventListener('mousemove', e => { const it = e.target.closest('.csel-item'); if (it && +it.dataset.i !== menuActive) { menuActive = +it.dataset.i; markActive(false); } });
      document.body.appendChild(m);
      return m;
    }
    function openMenu(sel) {
      if (sel.disabled) return;
      const m = cselMenu();
      m.innerHTML = '';
      let group = null;
      [...sel.options].forEach((o, i) => {
        const g = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null;
        if (g && g !== group) { group = g; const h = document.createElement('div'); h.className = 'csel-group'; h.textContent = g; m.appendChild(h); }
        const it = document.createElement('div');
        it.className = 'csel-item' + (o.disabled ? ' off' : ''); it.setAttribute('role', 'option'); it.dataset.i = i; it.textContent = o.textContent.trim();
        if (i === sel.selectedIndex) it.setAttribute('aria-selected', 'true');
        m.appendChild(it);
      });
      menuFor = sel; menuActive = sel.selectedIndex;
      m.hidden = false;
      const r = sel.parentElement.getBoundingClientRect();
      m.style.minWidth = `${r.width}px`;
      const below = innerHeight - r.bottom - 10, above = r.top - 10, want = Math.min(m.scrollHeight, 360);
      const down = below >= want || below >= above;
      m.style.maxHeight = `${Math.max(120, Math.min(360, down ? below : above))}px`;
      m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8))}px`;
      if (down) { m.style.top = `${r.bottom + 4}px`; m.style.bottom = ''; } else { m.style.bottom = `${innerHeight - r.top + 4}px`; m.style.top = ''; }
      m.dataset.side = down ? 'down' : 'up';
      sel.parentElement.classList.add('open');
      markActive(true);
    }
    // closing the menu also lets go of the dropdown's focus: the keys (Space, R, S…) work again straight after a pick
    function closeMenu() {
      const m = document.getElementById('cselMenu');
      if (m) m.hidden = true;
      const sel = menuFor;
      menuFor = null;
      if (sel && sel.parentElement) sel.parentElement.classList.remove('open');
      if (sel && sel.blur) sel.blur();
    }
    function pickOption(i) {
      const sel = menuFor;
      if (!sel) return;
      closeMenu();
      if (sel.selectedIndex !== i && sel.options[i] && !sel.options[i].disabled) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      syncSelects();
    }
    function markActive(scroll) {
      const m = document.getElementById('cselMenu');
      m.querySelectorAll('.csel-item').forEach(it => it.classList.toggle('active', +it.dataset.i === menuActive));
      const a = m.querySelector('.csel-item.active');
      if (a && scroll) a.scrollIntoView({ block: 'nearest' });
    }
    function menuKey(e, sel) {
      if (menuFor !== sel) {
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); openMenu(sel); }
        return;
      }
      const n = sel.options.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        let i = menuActive;
        for (let k = 0; k < n; k++) { i = (i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; if (!sel.options[i].disabled) break; }
        menuActive = i; markActive(true);
      } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickOption(menuActive); }
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
      else if (e.key === 'Tab') closeMenu();
      else if (e.key.length === 1) {                                         // a letter jumps to the next option starting with it
        e.preventDefault();
        const k = e.key.toLowerCase(), opts = [...sel.options];
        for (let s2 = 1; s2 <= n; s2++) { const j = (menuActive + s2) % n; if (!opts[j].disabled && opts[j].textContent.trim().toLowerCase().startsWith(k)) { menuActive = j; markActive(true); break; } }
      }
    }
    document.addEventListener('mousedown', e => { if (menuFor && !(e.target.closest && (e.target.closest('#cselMenu') || e.target === menuFor))) closeMenu(); }, true);
    window.addEventListener('resize', closeMenu);
    // only a scroll that moves the dropdown itself closes its menu (the film strip scrolls by itself while playing)
    document.addEventListener('scroll', e => { if (menuFor && (e.target === document || (e.target.contains && e.target.contains(menuFor)))) closeMenu(); }, true);

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
      strip.innerHTML = active.map((p, i) => `<button type="button" data-i="${i}" title="${i + 1} · ${escapeHtml(p.title)}" aria-label="Jump to image ${i + 1}"><img src="${escapeHtml(p.thumb || p.url || '')}" loading="lazy" decoding="async" alt=""></button>`).join('');   // lazy: 400 thumbnails must not compete with the stage's images
      shownIdx = -1;
      const n = active.length, cut = activeCutOff();
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
      if (mode === 'film') scrollFilmstripTo(i);
    }
    // the strip's buttons have fixed sizes, so where one sits is arithmetic: no layout is forced on every cut
    let stripWidth = 0;
    window.addEventListener('resize', () => { stripWidth = 0; });
    function scrollFilmstripTo(i) {
      const strip = document.getElementById('filmstrip');
      if (i < 0 || !(strip.children || [])[i]) return;
      if (!stripWidth) stripWidth = strip.clientWidth;
      if (!stripWidth) return;
      const x = 68 + i * 30, w = stripWidth;                                  // 65 px padding + 3, then 27 px buttons with 3 px gaps
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
      clockPos = null;
      drawFrame();
    }
    function offerUndoTrash(p, where) {
      const step = pushStep({ label: `Trash “${p.title}”`, undo: () => untrash(p.filename, where), redo: () => trashFile(p.filename) });
      setStatus(`“${p.title}” moved to Trash`, { label: 'Undo', run: () => undoStep(step) });
    }
    // the toast's Undo: this step, wherever it now is in the history
    function undoStep(step) {
      const i = history.indexOf(step);
      if (i < 0) return;
      if (i === history.length - 1) { undoLast(); return; }
      history.splice(i, 1); showUndo();
      step.undo();
    }
    async function trashFile(filename) {
      await fetch('/api/trash', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename, trashed: true }) });
      await loadState();
    }
    // back from the Trash, at the place it had in the order it was trashed from (if that order is still the one shown; else at the end, as a restore does)
    async function untrash(filename, where) {
      if (blockedByAi()) return;
      await fetch('/api/trash', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename, trashed: false }) });
      await loadState();
      if (where && where.index >= 0) {
        const order = plates.filter(x => !x.trashed && x.filename !== filename).map(x => x.filename);
        order.splice(Math.min(where.index, order.length), 0, filename);
        await fetch('/api/reorder', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ order }) });
        await loadState();
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
      const key = `${nCuts}|${paired}|${mult}|${v ? `${v.start_ms}|${v.end_ms}|${v.ramp}|${v.at}` : `flat|${bpm}`}|${follow}`;
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
        pitch: unit('pitchRange'), chord: parseInt(document.getElementById('chordSelect').value, 10) || 0, prog: parseInt(document.getElementById('progSelect').value, 10) || 0, pad: unit('padRange'), tape: unit('tapeRange'), bass: unit('bassRange'), bassPattern: parseInt(document.getElementById('bassPatternSelect').value, 10) || 0, bassRate: parseInt(document.getElementById('bassRateSelect').value, 10) || 0, arrange: parseInt(document.getElementById('arrangeSelect').value, 10) || 0, progEvery: parseInt(document.getElementById('progEverySelect').value, 10) || 0, movement: unit('movementRange'), echo: unit('echoRange'),
        wash: unit('washRange'), ring: unit('ringRange'), shimmer: unit('shimmerRange'), choir: unit('choirRange'), industrial: unit('industrialRange'),
        hitType: parseInt(document.getElementById('hitTypeSelect').value, 10) || 0, hit: unit('hitRange'), hitOn: parseInt(document.getElementById('hitOnSelect').value, 10) || 0,
        arp: unit('arpRange'), arpMood: parseInt(document.getElementById('arpMoodSelect').value, 10) || 0, arpSteps: parseInt(document.getElementById('arpStepsSelect').value, 10) || 0, arpRate: parseInt(document.getElementById('arpRateSelect').value, 10) || 0,
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
      if (on) warmSound();
      document.getElementById('soundOffNote').hidden = on;
      for (const k of ['pulse', 'low', 'bright', 'width', 'space', 'power', 'pitch', 'movement', 'echo', 'wash', 'ring', 'shimmer', 'choir', 'industrial', 'hit', 'arp', 'bass', 'pad', 'tape']) document.getElementById(`${k}Val`).textContent = document.getElementById(`${k}Range`).value;
      syncSegs(); paintRanges();
      saveSettings();
      musicChanged();
    }
    // the sound engine's costly parts are made while the page is idle, so the first Play does not freeze it
    let warmed = false;
    function warmSound() {
      if (warmed || !musicOn() || !droneLive.warm) return;
      warmed = true;
      const idle = window.requestIdleCallback || (f => setTimeout(f, 300));
      idle(() => { try { droneLive.warm(synthParams()); } catch (e) {} }, { timeout: 2000 });
    }
    // the four groups of sound settings, one shown at a time: the same switch as Source
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
    const LAYERS = ['choir', 'industrial'];                                // layers over the drone: rare, one at a time, with room around them
    const RANDOM_RANGES = { pulse: [30, 90], low: [65, 100], power: [30, 90], space: [5, 85], bright: [0, 55], width: [30, 100], pitch: [0, 100], movement: [15, 85], echo: [0, 55], wash: [0, 55], ring: [0, 45], shimmer: [0, 45], choir: [25, 55], industrial: [20, 50], hit: [30, 70], arp: [20, 45] };
    // Characters: kinds of film, modelled on the references, each a set of tighter ranges for the rhythm, the look and the sound (all inside RANDOM_RANGES).
    // Random rolls inside the chosen one ("Any": a different one each time); the rules below then make the parts agree.
    const CHARACTERS = {
      landing: { name: 'Landing',                                          // Ecwora / Soiltone: fast hold, then a slow landing, grey inverted copies
        rhythm: { mode: 'variable', start: [60, 120], end: [450, 900], ramp: [8, 16], at: 'end', mult: ['1', '1', '2'] },
        look: { invert: ['mono', 'mono', 'off'], zoom: ['out', 'out', 'in', 'off'], amount: [0.4, 2] },
        sound: { pulse: [40, 75], low: [75, 100], power: [40, 80], space: [50, 85], bright: [0, 35], width: [50, 100], pitch: [0, 45], movement: [20, 60], echo: [0, 35], wash: [15, 55], ring: [0, 25], shimmer: [0, 25], hit: [30, 60], arp: [0, 35],
          chord: ['0', '0', '2'], subWave: ['0', '1'], padWave: ['0', '2'], hitType: ['0', '0', '1'], hitOn: ['3', '2'], dyn: ['2', '3'], mood: ['2', '1', '0', '3'], layer: { choir: [25, 50], odds: 0.3 }, shape: { pad: 0.5, tape: 0.25, bass: 0.4, arrange: ['3', '3', '1'] } } },
      pulse: { name: 'Pulse',                                              // Helione / Moverunion: a steady tempo, cut 2 or 4 to the beat
        rhythm: { mode: 'flat', bpm: [118, 150], mult: ['1', '2', '2', '4'] },
        look: { invert: ['off', 'mono'], zoom: ['out', 'out', 'in', 'off'], amount: [0.4, 2] },
        sound: { pulse: [65, 90], low: [70, 100], power: [50, 90], space: [5, 35], bright: [10, 45], width: [30, 80], pitch: [20, 70], movement: [30, 70], echo: [0, 20], wash: [0, 25], ring: [0, 20], shimmer: [0, 20], hit: [40, 70], arp: [0, 30],
          chord: ['0', '1', '3'], subWave: ['0', '1'], padWave: ['0', '1'], hitType: ['2', '2', '1'], hitOn: ['1', '0'], dyn: ['0'], mood: ['0', '0', '1', '6'], layer: { industrial: [20, 45], odds: 0.25 }, shape: { pad: 0.25, tape: 0.2, bass: 0.8, arrange: ['2', '2', '0'] } } },
      build: { name: 'Build',                                              // slow to fast, the notes rising with it
        rhythm: { mode: 'variable', start: [500, 900], end: [60, 110], ramp: [10, 20], at: 'start', mult: ['1', '2'] },
        look: { invert: ['off', 'colour', 'mono'], zoom: ['in', 'in', 'out', 'off'], amount: [0.6, 3] },
        sound: { pulse: [45, 80], low: [65, 95], power: [45, 85], space: [30, 65], bright: [20, 50], width: [40, 90], pitch: [30, 80], movement: [40, 85], echo: [0, 30], wash: [0, 30], ring: [0, 30], shimmer: [15, 40], hit: [35, 65], arp: [25, 45],
          chord: ['2', '3', '1'], subWave: ['0', '1', '2'], padWave: ['0', '3'], hitType: ['3', '0', '4'], hitOn: ['3', '2'], dyn: ['1'], mood: ['0', '1', '5'], layer: { choir: [25, 45], odds: 0.3 }, shape: { pad: 0.4, tape: 0.2, bass: 0.6, arrange: ['3', '1'] } } },
      float: { name: 'Float',                                              // slow and wide: a big room, wash, no hits
        rhythm: { mode: 'flat', bpm: [50, 80], mult: ['1', '2'] },
        look: { invert: ['off'], zoom: ['in', 'out'], amount: [0.5, 2.5], trail: [10, 30] },
        sound: { pulse: [30, 45], low: [65, 90], power: [30, 55], space: [65, 85], bright: [0, 30], width: [70, 100], pitch: [0, 60], movement: [15, 45], echo: [15, 50], wash: [25, 55], ring: [0, 20], shimmer: [0, 30], hit: [30, 50], arp: [20, 35],
          chord: ['1', '3', '0'], subWave: ['0'], padWave: ['2', '2', '0'], hitType: ['0'], hitOn: ['0'], dyn: ['0', '2'], mood: ['2', '3'], layer: { choir: [30, 55], odds: 0.5 }, shape: { pad: 0.6, tape: 0.4, bass: 0.2, arrange: ['1', '0'] } } },
      machine: { name: 'Machine',                                          // very fast cuts, metal and a square sub
        rhythm: { mode: 'flat', bpm: [150, 200], mult: ['2', '3', '4', '4'] },
        look: { invert: ['colour', 'mono'], zoom: ['off', 'in', 'out'], amount: [0.3, 1.2] },
        sound: { pulse: [70, 90], low: [75, 100], power: [60, 90], space: [5, 30], bright: [25, 55], width: [30, 70], pitch: [30, 90], movement: [50, 85], echo: [0, 15], wash: [0, 15], ring: [20, 45], shimmer: [0, 20], hit: [45, 70], arp: [0, 30],
          chord: ['0', '1'], subWave: ['2', '2', '1'], padWave: ['1', '3'], hitType: ['3', '3', '4'], hitOn: ['3', '1'], dyn: ['0', '3'], mood: ['0', '1', '6'], layer: { industrial: [25, 50], odds: 0.4 }, shape: { pad: 0.2, tape: 0.2, bass: 0.8, arrange: ['2', '1'] } } },
      drift: { name: 'Drift',                                              // unhurried and changing slowly, no hits: a long breath of images
        rhythm: { mode: 'variable', start: [250, 450], end: [500, 900], ramp: [10, 20], at: ['end', 'start'], mult: ['1', '1', '2'] },
        look: { invert: ['off'], zoom: ['in', 'out'], amount: [0.8, 3], trail: [15, 35] },
        sound: { pulse: [30, 50], low: [70, 95], power: [30, 60], space: [55, 85], bright: [0, 30], width: [60, 100], pitch: [0, 50], movement: [15, 40], echo: [10, 45], wash: [20, 55], ring: [0, 15], shimmer: [10, 35], hit: [30, 45], arp: [0, 30],
          chord: ['1', '3', '2'], subWave: ['0'], padWave: ['2', '0'], hitType: ['0'], hitOn: ['0'], dyn: ['0', '2'], mood: ['2', '4', '3'], layer: { choir: [25, 50], odds: 0.5 }, shape: { pad: 0.6, tape: 0.4, bass: 0.2, arrange: ['1', '0'] } } },
      strobe: { name: 'Strobe',                                            // colour-inverted flashes on a mid tempo, dark bursts on the accents
        rhythm: { mode: 'flat', bpm: [100, 140], mult: ['2', '3', '4'] },
        look: { invert: ['colour', 'colour', 'mono'], zoom: ['in', 'off'], amount: [0.5, 2] },
        sound: { pulse: [70, 90], low: [70, 100], power: [55, 90], space: [5, 35], bright: [20, 50], width: [30, 70], pitch: [20, 70], movement: [40, 80], echo: [0, 15], wash: [0, 20], ring: [0, 30], shimmer: [0, 25], hit: [45, 70], arp: [0, 30],
          chord: ['0', '2'], subWave: ['0', '1'], padWave: ['1', '3'], hitType: ['4', '2'], hitOn: ['3', '1'], dyn: ['0'], mood: ['0', '1', '6'], layer: { industrial: [20, 40], odds: 0.25 }, shape: { pad: 0.2, tape: 0.2, bass: 0.7, arrange: ['2'] } } },
      breath: { name: 'Breath',                                            // a calm pulse, a slow zoom, an arpeggio carrying it
        rhythm: { mode: 'flat', bpm: [70, 100], mult: ['1', '2'] },
        look: { invert: ['off', 'mono'], zoom: ['out', 'out', 'in'], amount: [0.8, 3] },
        sound: { pulse: [40, 70], low: [70, 95], power: [35, 65], space: [40, 75], bright: [10, 40], width: [50, 90], pitch: [10, 60], movement: [20, 55], echo: [0, 35], wash: [0, 40], ring: [0, 20], shimmer: [0, 30], hit: [30, 55], arp: [25, 45],
          chord: ['2', '3', '1'], subWave: ['0', '1'], padWave: ['2', '0'], hitType: ['0', '1'], hitOn: ['2', '3'], dyn: ['0', '1'], mood: ['2', '4'], layer: { choir: [25, 45], odds: 0.5 }, shape: { pad: 0.6, tape: 0.35, bass: 0.3, arrange: ['1', '0'] } } },
    };
    const rint = ([lo, hi]) => Math.round(lo + Math.random() * (hi - lo));
    const rpick = list => list[Math.floor(Math.random() * list.length)];
    const setv = (id, v) => { document.getElementById(id).value = String(v); };
    const getn = id => parseFloat(document.getElementById(id).value) || 0;
    // ---- Undo / Redo: one history for the whole app (Cmd+Z, Cmd+Shift+Z, the Undo button) ----
    // Steps: a settings change (one slider drag, one Random = one step), trashing and restoring, a drag in the grid.
    // Not in it: permanent deletes and generation (they say so when you start them), the mode and the views.
    const history = [], future = [];
    let applyingHistory = false;
    const NOT_UNDONE = ['batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput', 'soundGroupVal', 'thumbSizeVal', 'characterSelect', 'bpmLock'];
    function pushStep(step) { if (!step.settings) commitSettings(); history.push(step); if (history.length > 100) history.shift(); future.length = 0; showUndo(); return step; }
    function showUndo() {
      const b = document.getElementById('undoRandomBtn');
      b.disabled = !history.length;
      b.title = history.length ? `Undo ${history[history.length - 1].label} (⌘Z)` : 'Nothing to undo';
    }
    async function undoLast() {
      if (blockedByAi()) return;
      commitSettings();
      const step = history.pop();
      if (!step) { setStatus('Nothing to undo.'); return; }
      applyingHistory = true;
      try { await step.undo(); } finally { applyingHistory = false; }
      future.push(step); showUndo();
      setStatus(`Undone: ${step.label}. ⌘⇧Z to redo.`);
    }
    async function redoLast() {
      if (blockedByAi()) return;
      commitSettings();
      const step = future.pop();
      if (!step) { setStatus('Nothing to redo.'); return; }
      applyingHistory = true;
      try { await step.redo(); } finally { applyingHistory = false; }
      history.push(step); showUndo();
      setStatus(`Redone: ${step.label}.`);
    }
    // settings: a change is one step once it settles (a slider dragged for a while is one step, not fifty)
    let settled = null, settleTimer = null;
    function settingsSnap() {
      const out = {};
      PERSISTED.filter(id => !NOT_UNDONE.includes(id)).forEach(id => { const el = document.getElementById(id); out[id] = el.type === 'checkbox' ? el.checked : el.value; });
      if (rampWanted !== null) out.rampRange = String(rampWanted);            // what was asked for: the library growing or shrinking is not a change of yours
      return out;
    }
    function settingsChanged() {
      if (applyingHistory || settled === null) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => commitSettings(), 700);
    }
    function changeName(before, after) {
      let ids = Object.keys(after).filter(id => after[id] !== before[id]);
      if (ids.length > 1) ids = ids.filter(id => id !== 'rampRange');         // Change over follows the cut count: it is not what was changed
      if (ids.length !== 1) return 'the settings';
      const el = document.getElementById(ids[0]), row = el.closest ? el.closest('.row, .check-line') : null;
      const lbl = row && row.querySelector ? row.querySelector('.lbl, span') : null;
      return lbl && lbl.textContent ? lbl.textContent.trim() : 'a setting';
    }
    function commitSettings(label) {
      clearTimeout(settleTimer);
      if (settled === null) return;
      const now = settingsSnap(), before = settled;
      if (JSON.stringify(now) === JSON.stringify(before)) return;
      settled = now;
      pushStep({ settings: true, label: label || changeName(before, now), undo: () => applySnap(before), redo: () => applySnap(now) });
    }
    function applySnap(snap) {
      for (const [id, v] of Object.entries(snap)) { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } }
      updateTempo(); updateRhythm(); updateFx(); updateMusic();
      settled = settingsSnap();
    }
    const rememberForUndo = () => commitSettings();                          // a Random starts: what came before is its own step
    function undoRandom() { return undoLast(); }                              // the Undo button
    // the tempo lock: Random keeps the tempo, and a Flat speed (a tempo means nothing to a variable run); the Multiple still rolls
    function applyRhythm(r) {
      if (document.getElementById('bpmLock').checked) { setv('rhythmSelect', 'flat'); setv('multSelect', rpick(r.mult)); return; }
      setv('rhythmSelect', r.mode);
      if (r.mode === 'flat') setv('bpmInput', rint(r.bpm));
      else { setv('startMsRange', Math.round(rint(r.start) / 10) * 10); setv('endMsRange', Math.round(rint(r.end) / 10) * 10); setv('rampRange', rint(r.ramp)); setv('atSelect', Array.isArray(r.at) ? rpick(r.at) : r.at); }
      setv('multSelect', rpick(r.mult));
    }
    function applyLook(l) { setv('invertSelect', rpick(l.invert)); setv('zoomSelect', rpick(l.zoom)); setv('zoomAmt', (l.amount[0] + Math.random() * (l.amount[1] - l.amount[0])).toFixed(1)); setv('trailRange', l.trail ? rint(l.trail) : 0); }
    function refreshVideo(quiet) { updateTempo(); updateRhythm(); updateFx(); if (!quiet) { saveSettings(); musicChanged(); } }
    // a random rhythm: a tempo (Flat) or a run that speeds up or slows down (Variable), and the Multiple
    function randomRhythm(quiet) {
      if (quiet !== true) rememberForUndo();
      if (Math.random() < 0.55) applyRhythm({ mode: 'flat', bpm: [60, 200], mult: ['0.5', '1', '1', '2', '2', '3', '4'] });
      else {
        const slowing = Math.random() < 0.5;
        applyRhythm({ mode: 'variable', start: slowing ? [60, 200] : [300, 900], end: slowing ? [300, 900] : [60, 200], ramp: [6, 20], at: Math.random() < 0.7 ? 'end' : 'start', mult: ['1', '1', '2', '2', '3'] });
      }
      document.getElementById('followCuts').checked = Math.random() < 0.15;
      refreshVideo(quiet === true);
      if (quiet !== true) commitSettings('Random rhythm');
    }
    // a random look: invert and zoom
    function randomLook(quiet) {
      if (quiet !== true) rememberForUndo();
      applyLook({ invert: ['off', 'off', 'mono', 'colour'], zoom: ['off', 'out', 'out', 'in'], amount: [0.3, 3] });
      setv('trailRange', Math.random() < 0.25 ? rint([15, 40]) : 0);         // a trail now and then, never strong
      refreshVideo(quiet === true);
      if (quiet !== true) commitSettings('Random look');
    }
    // the Video half of Random: rhythm and look
    function randomVideo(quiet) {
      if (quiet !== true) rememberForUndo();
      randomRhythm(true); randomLook(true);
      if (quiet !== true) { saveSettings(); musicChanged(); commitSettings('Random video'); }
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
      if (getn('choirRange') > 0 && getn('industrialRange') > 0) setv('industrialRange', 0);    // one layer at a time
      if (rate > 5) setv('choirRange', 0);                                                       // voices over a strobe are a cacophony
      if (getn('choirRange') > 0 || getn('industrialRange') > 0) {                              // a layer needs room: one texture, and no clutter on the cuts
        tex.slice(1).forEach(id => setv(id, 0));
        if (getn('choirRange') > 0) {                                                            // voices and a busy arpeggio fight: a soft mood, a few notes
          setv('arpRange', Math.min(30, getn('arpRange'))); if (getn('arpRange') < 20) setv('arpRange', 0);
          if ([0, 1, 6].includes(getn('arpMoodSelect'))) setv('arpMoodSelect', 2 + Math.floor(Math.random() * 3));   // not Pluck, Dark or Acid: Phase, Sweep or Mutate
          setv('padRange', Math.min(35, getn('padRange')));                                     // voices and a full pad share the mids
        }
        if (getn('industrialRange') > 0) { setv('hitTypeSelect', 0); setv('ringRange', Math.min(20, getn('ringRange'))); }   // its bursts are the hits
      }
      if (getn('arrangeSelect') === 3 && rhythmMode() !== 'variable') setv('arrangeSelect', 1);   // a flat speed has nothing to follow
      if (getn('arrangeSelect')) {                                                                 // an arrangement needs at least two layers to move
        const layers = () => [getn('arpRange'), getn('bassRange'), getn('hitTypeSelect')].filter(Boolean).length;
        if (layers() < 2 && !getn('bassRange')) setv('bassRange', rint([35, 55]));
        if (layers() < 2 && !getn('arpRange')) setv('arpRange', getn('choirRange') ? rint([20, 30]) : rint([25, 40]));   // softly under the choir
      }
      if (rate > 5) setv('bassRateSelect', 0);                                                    // fast cuts: a bass note a cut, not a buzz
      if (getn('padRange') && getn('tapeRange')) {                                               // a pad under tape: both stay low, or it smears into a wall
        if (Math.random() < 0.6) setv('tapeRange', 0); else { setv('padRange', Math.min(30, getn('padRange'))); setv('tapeRange', Math.min(25, getn('tapeRange'))); }
      }
      if ([2, 6].includes(getn('arpMoodSelect')) && rate > 2.5) setv('arpRateSelect', Math.min(1, getn('arpRateSelect')));   // Phase wants time to drift, Acid room to slide
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
      setv('choirRange', 0); setv('industrialRange', 0);
      const slow = rhythmCutsPerSecond() <= 3, roll = Math.random();                                   // a layer now and then, never both: the drone is the sound
      if (roll < (slow ? 0.3 : 0.1)) setv('choirRange', rint(RANDOM_RANGES.choir));                  // voices want room: mostly on slower cuts
      else if (roll < (slow ? 0.35 : 0.3)) setv('industrialRange', rint(RANDOM_RANGES.industrial));  // metal wants speed
      setv('arpMoodSelect', Math.random() < 0.3 ? 0 : 1 + Math.floor(Math.random() * 6));          // the first arpeggio (Pluck) most often, then the moods alike
      rollChanges(); rollShape(null);
      setv('seedVal', 1 + Math.floor(Math.random() * 99999));
      soundRules();
      if (quiet !== true) { updateMusic(); commitSettings('Random sound'); }
    }
    // chord changes now and then (a third of the time), each chord lasting 1 to 4 seconds of this film's music: the harmonic pace varies too
    function rollChanges() {
      if (Math.random() >= 0.35) { setv('progSelect', 0); return; }
      setv('progSelect', 1 + Math.floor(Math.random() * 4));
      const want = rhythmCutsPerSecond() * (1 + 3 * Math.random()), every = [2, 4, 8, 16];
      setv('progEverySelect', every.reduce((b, n, i) => (Math.abs(n - want) < Math.abs(every[b] - want) ? i : b), 0));
    }
    // the bassline and the arrangement: a type says how likely a bassline is and which arrangements suit it; Any draws them freely
    function rollShape(c) {
      const sh = c ? c.shape : { bass: 0.5, pad: 0.4, tape: 0.3, arrange: ['0', '1', '1', '2', '2', '3'] };
      const rate = rhythmCutsPerSecond();
      setv('bassRange', Math.random() < sh.bass ? rint([35, 65]) : 0);
      setv('bassPatternSelect', Math.floor(Math.random() * 4));
      setv('bassRateSelect', rate > 4 ? 0 : rate > 2 ? Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 2));   // fast cuts: a note a cut
      setv('arrangeSelect', rpick(sh.arrange));
      setv('padRange', Math.random() < sh.pad ? rint([20, 45]) : 0);
      setv('tapeRange', Math.random() < sh.tape ? rint([15, 45]) : 0);
    }
    function applySound(c) {
      for (const k of Object.keys(RANDOM_RANGES)) if (!LAYERS.includes(k)) setv(`${k}Range`, rint(c[k]));
      for (const k of LAYERS) setv(`${k}Range`, c.layer[k] && Math.random() < c.layer.odds ? rint(c.layer[k]) : 0);   // the type's layer, now and then (more often in the slow, open types)
      setv('arpMoodSelect', rpick(c.mood));
      for (const k of ['echo', 'wash', 'ring', 'shimmer']) if (c[k][0] === 0 && Math.random() < 0.4) setv(`${k}Range`, 0);
      setv('chordSelect', rpick(c.chord)); setv('subWaveSelect', rpick(c.subWave)); setv('padWaveSelect', rpick(c.padWave));
      setv('hitTypeSelect', rpick(c.hitType)); setv('hitOnSelect', rpick(c.hitOn)); setv('dynSelect', rpick(c.dyn));
      setv('arpStepsSelect', Math.floor(Math.random() * 4)); setv('arpRateSelect', Math.floor(Math.random() * 4));
      rollChanges(); rollShape(c);
      setv('seedVal', 1 + Math.floor(Math.random() * 99999));
    }
    // everything at once, inside the character, the sound matched to the speed
    // Type: what Random may make. Any: anything inside the safe ranges. A type (Landing, Pulse, ...): only that kind of film.
    // Random rolls everything again inside the type; choosing a type rolls at once.
    function rollCharacter(key) {
      rememberForUndo();
      cutPos = 0; clockPos = null; lastTick = performance.now();             // the new film starts at its first image: set before the new timeline draws, or the old position shows a stray frame of the new one
      const c = CHARACTERS[key];
      setv('musicSelect', 'on');
      if (c) { applyRhythm(c.rhythm); applyLook(c.look); applySound(c.sound); }
      else { randomRhythm(true); randomLook(true); randomMusic(true); }
      document.getElementById('followCuts').checked = Math.random() < 0.2;               // now and then the music takes every picture cut
      matchSoundToSpeed();
      soundRules();
      refreshVideo(true);
      updateMusic();
      commitSettings('Random');
      toStart();                                                             // a new film: from its first image
      return c ? key : 'any';
    }
    function randomAll() { return rollCharacter(document.getElementById('characterSelect').value); }
    function pickCharacter() { saveSettings(); randomAll(); }

    // how many images, how long the result runs, and how long the cuts are
    // the "Change over" slider can take at most every cut of the selection, so its range follows the images (and the invert pairs)
    // The slider shows at most the cuts there are, but remembers what was asked for: with more cuts again (a Multiple undone, the images
    // loaded after a reload) it goes back to it. A value it did not write itself (a hand, Random, Undo, a drag) is the new request.
    let rampWanted = null, rampShown = null;
    function syncRampRange() {
      const invert = document.getElementById('invertSelect').value;
      const mult = parseFloat(document.getElementById('multSelect').value) || 1;
      const nCuts = Math.max(1, Math.ceil((activePlates().length * (invert === 'mono' || invert === 'colour' ? 2 : 1)) / Math.max(0.05, mult) - 1e-9));    // base cuts: what the change runs over
      const el = document.getElementById('rampRange');
      const v = parseInt(el.value, 10) || 12;
      if (rampWanted === null || v !== rampShown) rampWanted = v;
      if (plates.length) {                                                   // before the library has loaded there is nothing to clamp to
        el.max = String(Math.max(2, nCuts));
        rampShown = Math.max(2, Math.min(rampWanted, Math.max(2, nCuts)));
        el.value = String(rampShown);
      }
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
      const est = exportEstimate(sec(starts[cuts]));
      document.getElementById('exportMeta').textContent = `1080 × 1920 · ${fmtDuration(sec(starts[cuts]))} · ${musicOn() ? 'sound included' : 'silent'}${est ? ` · about ${est} to make` : ''}`;
    }

    // How long an export takes, learned from the last ones on this computer: seconds of waiting per second of film (median of the last 5)
    function exportRates() { try { return JSON.parse(localStorage.getItem('studioExportRates') || '[]').filter(Number.isFinite); } catch (e) { return []; } }
    function noteExportRate(filmSec, tookSec) {
      if (!(filmSec > 0) || !(tookSec > 0)) return;
      try { localStorage.setItem('studioExportRates', JSON.stringify(exportRates().concat([tookSec / filmSec]).slice(-5))); } catch (e) {}
    }
    function exportEstimate(filmSec) {
      const r = exportRates().sort((a, b) => a - b);
      if (!r.length || !(filmSec > 0)) return '';
      const t = Math.max(1, Math.round(r[Math.floor(r.length / 2)] * filmSec));
      return t < 60 ? `${t} s` : `${Math.round(t / 60)} min`;
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
        const mult = parseFloat(document.getElementById('multSelect').value) || 1;
        const yOfMs = ms => Y(Math.max(1, (ms * 30) / 1000 / mult));
        const picMs = ms => Math.round(Math.max(1000 / 30, ms / mult));     // what the picture does: with a Multiple, its cuts are shorter than the run's
        if (v.at === 'end') {
          const from = Math.min(r.base[nBase - ramp], total);
          band = { left: X(from) / 10, width: 100 - X(from) / 10, label: `Landing · ${ramp} cuts` };
          handles = [{ left: band.left, top: yOfMs(v.start_ms), label: `Start ${picMs(v.start_ms)} ms`, inner: true }, { left: 100, top: yOfMs(v.end_ms), label: `End ${picMs(v.end_ms)} ms` }];
        } else {
          const to = Math.min(r.base[Math.min(nBase, ramp)], total);
          band = { left: 0, width: X(to) / 10, label: `Build-up · ${ramp} cuts` };
          handles = [{ left: 0, top: yOfMs(v.start_ms), label: `Start ${picMs(v.start_ms)} ms` }, { left: band.width, top: yOfMs(v.end_ms), label: `End ${picMs(v.end_ms)} ms`, inner: true }];
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
        dot.classList.toggle('inner', !!h.inner);                               // the point where the change begins or ends: drag it sideways
        dot.title = h.inner ? 'Drag sideways: how many cuts the change takes' : '';
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
    // Dragging the inner point (where a landing begins, where a build-up ends) sets Change over: it snaps to the nearest cut of the run
    // The change itself moves the film's length, so the point is placed by trying every Change over and keeping the one whose point lands nearest
    let rampTable = null;                                                    // during a drag: where the point lands for each Change over, worked out once
    function rampAt(u) {
      const n = activePlates().length;
      if (!n) return null;
      if (rampTable && rampTable.length) {
        let best = rampTable[0];
        for (const row of rampTable) if (Math.abs(row.pos - u) < Math.abs(best.pos - u)) best = row;
        return best.k;
      }
      const paired = ['mono', 'colour'].includes(document.getElementById('invertSelect').value);
      const nCuts = n * (paired ? 2 : 1), mult = parseFloat(document.getElementById('multSelect').value) || 1;
      const nBase = Math.max(1, Math.ceil(nCuts / Math.max(0.05, mult) - 1e-9));
      const v = variableParams(), target = Math.max(0, Math.min(1, u));
      let best = null, bestD = Infinity;
      const table = [];
      for (let k = 2; k <= Math.max(2, Math.min(nBase, 200)); k++) {              // the change never takes more than 200 cuts
        const base = variableStarts(nBase, v.start_ms, v.end_ms, k, v.at), total = subdivideStarts(base, mult, nCuts)[nCuts];
        const at = v.at === 'end' ? base[Math.max(0, nBase - k)] : base[Math.min(nBase, k)];
        const pos = Math.min(at, total) / total;
        table.push({ k, pos });
        const d = Math.abs(pos - target);
        if (d < bestD - 1e-9) { bestD = d; best = k; }
      }
      rampAt.lastTable = table;
      return v.ramp > 200 && best === 200 ? v.ramp : Math.max(2, Math.min(nBase, best));
    }
    let draggingPoint = false, dragEndedAt = 0;
    function pointDown(e) {
      if (!e.currentTarget.classList.contains('inner')) return;
      e.preventDefault(); e.stopPropagation();
      draggingPoint = true;
      rampTable = null; rampAt(0); rampTable = rampAt.lastTable;              // one pass now; the moves only look it up
      if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
    }
    function pointMove(e) {
      if (!draggingPoint) return;
      const b = document.getElementById('rsBody').getBoundingClientRect();
      const ramp = rampAt((e.clientX - b.left) / b.width);
      const el = document.getElementById('rampRange');
      if (ramp !== null && String(ramp) !== el.value) { el.value = String(ramp); updateRhythm(); }
    }
    function pointUp() { if (draggingPoint) { draggingPoint = false; rampTable = null; dragEndedAt = Date.now(); } }
    ['rsH0', 'rsH1'].forEach(id => {
      const d = document.getElementById(id);
      d.addEventListener('pointerdown', pointDown);
      d.addEventListener('pointermove', pointMove);
      d.addEventListener('pointerup', pointUp);
      d.addEventListener('pointercancel', pointUp);
    });
    // a click on the strip puts the playhead there
    function rhythmStripClick(e) {
      if (draggingPoint || Date.now() - dragEndedAt < 300) return;             // the end of a drag is not a click
      const body = document.getElementById('rsBody');
      const n = activePlates().length;
      if (!n || !body.getBoundingClientRect) return;
      const b = body.getBoundingClientRect();
      const u = Math.max(0, Math.min(0.9999, (e.clientX - b.left) / b.width));
      cutPos = u * timelineFor(n).at(-1);
      lastTick = performance.now(); clockPos = null;
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
        trail: (parseFloat(document.getElementById('trailRange').value) || 0) / 100,
      };
    }
    // Trail: after a cut the previous image lingers on top for 4 whole frames, fading (mirrors cutplan.trail_alpha; shared vectors)
    const TRAIL_FRAMES = 4;
    function trailAlpha(framesSinceCut, amount) {
      const a = Math.max(0, Math.min(0.6, amount || 0)), k = Math.floor(framesSinceCut);
      return a <= 0 || k < 0 || k >= TRAIL_FRAMES ? 0 : a * (1 - k / TRAIL_FRAMES);
    }
    let ghostCut = -1, ghostOpacity = '';
    function drawTrail(plan, fx, tl, active) {
      const g = document.getElementById('stageGhost');
      const alpha = isPlaying && plan.cut > 0 ? trailAlpha(cutPos - tl[plan.cut], fx.trail) : 0;
      if (alpha > 0 && ghostCut !== plan.cut) {                               // a new cut: the previous one, as it ended, goes on top
        ghostCut = plan.cut;
        const paired = fx.invert === 'mono' || fx.invert === 'colour', prev = plan.cut - 1;
        const pp = active[(paired ? Math.floor(prev / 2) : prev) % active.length];
        g.src = pp.preview || pp.url;
        g.style.filter = paired && prev % 2 === 1 ? (fx.invert === 'mono' ? 'invert(1) grayscale(1)' : 'invert(1)') : '';
        const s = zoomScale(fx.zoom, fx.amount, 1);
        g.style.transform = s > 1.0005 ? `scale(${s.toFixed(5)})` : '';
      }
      const o = alpha > 0 ? alpha.toFixed(3) : '0';
      if (o !== ghostOpacity) { ghostOpacity = o; g.style.opacity = o; }
    }
    function clearFx() {
      const img = document.getElementById('stageImg');
      img.style.transform = '';
      img.style.filter = '';
      document.getElementById('stageGhost').style.opacity = '0'; ghostOpacity = '0'; ghostCut = -1;
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
      const trail = parseInt(document.getElementById('trailRange').value, 10) || 0;
      document.getElementById('trailVal').textContent = trail ? `${trail}%` : 'Off';
      syncSegs(); paintRanges();
      if (!isPlaying) clearFx();
      musicChanged();   // invert changes the cuts, so the sound must follow
    }

    let cutPos = 0;
    let lastTick = 0;
    // The picture is drawn once per screen refresh (requestAnimationFrame), on a smooth clock: the audio clock moves in steps
    // (it advances a buffer at a time), so the picture follows a steady clock that is gently pulled toward the audio and snaps to it
    // only after a jump (a seek, a swap). Each cut then lasts the same number of refreshes; on a timer, about 1 in 5 of the
    // one-frame cuts lasted 1 or 3 refreshes instead of 2.
    let clockPos = null, clockAt = 0;
    function smoothAudioPos(now) {
      const audio = droneLive.pos(), total = droneLive.total || 0;
      if (clockPos === null) { clockPos = audio; clockAt = now; return audio; }
      let pos = clockPos + (now - clockAt) / 1000;
      let d = audio - pos;
      if (total > 0) d = ((((d + total / 2) % total) + total) % total) - total / 2;   // across the loop point
      pos = Math.abs(d) > 0.08 ? audio : pos + d * 0.08;
      clockPos = total > 0 ? ((pos % total) + total) % total : pos;
      clockAt = now;
      return clockPos;
    }
    function frameTick(ts) {
      const now = Number.isFinite(ts) ? ts : performance.now();              // the frame's own time: steadier than reading the clock inside it
      const dt = now - lastTick;
      lastTick = now;
      if (!isPlaying) { clockPos = null; return; }
      if (!activePlates().length || document.getElementById('stageImg').style.display === 'none') return;
      if (musicPending) return;
      if (musicOn() && droneLive.playing && !droneLive.holding) cutPos = Math.round(smoothAudioPos(now) * 60) / 2;   // the drone is the clock, in 60 Hz steps: a one-frame cut is two refreshes, every time
      else { clockPos = null; cutPos += (Math.min(dt, 250) * 30) / 1000; }
      drawFrame();
    }
    function restartLoop() {
      if (timer) cancelAnimationFrame(timer);
      lastTick = performance.now();
      const loop = ts => { frameTick(ts); timer = requestAnimationFrame(loop); };
      timer = requestAnimationFrame(loop);
    }
    // ---- images decoded ahead of the playhead: while playing, the stage only switches to an image that is ready to paint,
    // so a fast cut never shows an empty or half-drawn frame (it holds the last one instead, and catches up at the next cut) ----
    const ready = new Map();                                                // url -> Image, decoded (most recent last)
    const loading = new Map();                                              // url -> Image, decoding
    let lateFrames = 0;
    function preload(url) {
      if (!url || ready.has(url) || loading.has(url) || failed.has(url) || typeof Image !== 'function') return;
      const im = new Image();
      im.decoding = 'async';
      im.fetchPriority = 'high';                                              // ahead of the film strip's thumbnails
      im.src = url;
      loading.set(url, im);
      const done = () => { loading.delete(url); ready.set(url, im); while (ready.size > 48) ready.delete(ready.keys().next().value); };   // ~2 MB each once decoded: about the look-ahead, no more
      (im.decode ? im.decode() : Promise.resolve()).then(done, () => { loading.delete(url); failed.add(url); });
    }
    const failed = new Set();                                               // an image that would not load is not asked for again (and not waited for)
    function isReady(url) { return typeof Image !== 'function' || ready.has(url) || failed.has(url); }
    // the next images in film order, as many as the next 2 seconds hold (at least 8, at most 40)
    function preloadAhead(fromPlate) {
      const active = activePlates();
      if (!active.length) return;
      const tl = timelineFor(active.length), cuts = tl.length - 1;
      const perPlate = cuts / active.length, cutFrames = tl[cuts] / Math.max(1, cuts);
      const n = Math.max(8, Math.min(40, Math.ceil(60 / Math.max(1, cutFrames * perPlate))));
      for (let k = 0; k < Math.min(n, active.length); k++) { const p = active[(fromPlate + k) % active.length]; preload(p.preview || p.url); }
    }
    // the picture at cutPos: the stage image, its effects (while playing), the film strip mark and the time
    let shownTime = '';
    let aheadFrom = -1;
    function drawFrame() {
      const active = activePlates();
      const stageImg = document.getElementById('stageImg');
      if (!active.length) { markFilmstrip(-1); return; }
      const fx = fxSettings();
      const tl = timelineFor(active.length);
      const plan = planAt(cutPos, active.length, fx.invert, tl);
      currentIdx = plan.plate;
      const url = active[plan.plate].preview || active[plan.plate].url;
      if (plan.plate !== aheadFrom) { aheadFrom = plan.plate; preloadAhead(plan.plate); }
      let held = false;
      if (stageImg.getAttribute('src') !== url) {
        if (!isPlaying || isReady(url)) stageImg.src = url;   // paused or jumping: show it whatever it takes
        else { held = true; lateFrames++; preload(url); }                  // playing: hold the last frame until this one can paint
      }
      if (!isPlaying) clearFx(); else if (!held) applyFx(plan, fx);        // a held frame keeps its own look
      if (!held) drawTrail(plan, fx, tl, active);
      markFilmstrip(plan.plate);
      movePlayhead();
      const total = tl[tl.length - 1], t = ((cutPos % total) + total) % total;
      const clock = f => { const s = f / 30; return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
      const txt = `${clock(t)}|${clock(total)}|${plan.cut + 1}|${tl.length - 1}`;
      if (txt !== shownTime) {
        shownTime = txt;
        document.getElementById('timecode').innerHTML = `${clock(t)} <span>/ ${clock(total)} · cut ${plan.cut + 1} / ${tl.length - 1}</span>`;
        document.getElementById('miniCount').textContent = `${plan.plate + 1}/${active.length}`;
        document.getElementById('fsTime').textContent = `${clock(t)} / ${clock(total)}`;
      }
    }

    // start again from the first image and the start of the sound (with a long slow run, this skips the wait)
    function restartPlay() {
      if (!isPlaying) { cutPos = 0; togglePlay(); return; }
      cutPos = 0; lastTick = performance.now(); currentIdx = 0; clockPos = null;
      if (droneLive.playing) droneLive.restart(synthParams(), synthStartsSec());
    }
    function setPlayLabel() {
      const b = document.getElementById('playBtn');
      b.textContent = isPlaying ? 'Pause' : 'Play';
      b.setAttribute('aria-label', b.textContent);
      b.classList.toggle('playing', isPlaying);
      const f = document.getElementById('fsPlayBtn');
      f.textContent = b.textContent; f.setAttribute('aria-label', b.textContent); f.classList.toggle('playing', isPlaying);
      const m = document.getElementById('miniPlayBtn');
      m.textContent = b.textContent; m.setAttribute('aria-label', b.textContent); m.classList.toggle('playing', isPlaying);
    }
    // play carries on from where the playhead is (Restart goes back to the start)
    function togglePlay() {
      const stageImg = document.getElementById('stageImg');
      stageImg.style.display = 'block';
      isPlaying = !isPlaying;
      lastTick = performance.now();
      if (!isPlaying) { clearFx(); drawFrame(); }
      setPlayLabel();
      if (isPlaying) preloadAhead(currentIdx);                            // start decoding before the first cut is due
      if (!isPlaying) stopMusic();
      else if (musicOn()) startMusic(cutPos / 30);
    }

    // the logo target (dead-center, 18% of the width): one switch for the Film's preview and every card in Curate, remembered
    function toggleReticle(force) {
      const on = document.getElementById('reticle').classList.toggle('visible', force === undefined ? undefined : !!force);
      document.body.classList.toggle('target-on', on);
      for (const id of ['targetBtn', 'gridTargetBtn']) document.getElementById(id).setAttribute('aria-pressed', String(on));
      try { localStorage.setItem('studioTarget', on ? '1' : '0'); } catch (e) {}
    }
    try { if (localStorage.getItem('studioTarget') === '1') toggleReticle(true); } catch (e) {}

    // Remember tempo & generation settings across reloads (per-browser convenience only).
    const PERSISTED = ['rhythmSelect', 'startMsRange', 'endMsRange', 'rampRange', 'atSelect', 'bpmInput', 'followCuts', 'multSelect', 'musicSelect', 'pulseRange', 'lowRange', 'powerRange', 'spaceRange', 'brightRange', 'widthRange', 'pitchRange', 'chordSelect', 'progSelect', 'progEverySelect', 'padRange', 'tapeRange', 'movementRange', 'echoRange', 'washRange', 'ringRange', 'shimmerRange', 'choirRange', 'industrialRange', 'subWaveSelect', 'padWaveSelect', 'hitTypeSelect', 'hitRange', 'hitOnSelect', 'arpRange', 'arpMoodSelect', 'arpStepsSelect', 'arpRateSelect', 'bassRange', 'bassPatternSelect', 'bassRateSelect', 'arrangeSelect', 'dynSelect', 'seedVal', 'soundGroupVal', 'characterSelect', 'thumbSizeVal', 'bpmLock', 'invertSelect', 'zoomSelect', 'zoomAmt', 'trailRange', 'batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput'];
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
        if (rampWanted !== null) out.rampRange = String(rampWanted);          // what was asked for, not what fits today
        localStorage.setItem('studioSettings', JSON.stringify(out));
      } catch (e) {}
      settingsChanged();
      renderEditBar();
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
      trashSel = new Set(); pickSel = new Set();
      return loadState();
    }

    async function setTrash(e, filename, trashed) {
      if (blockedByAi(e)) return;
      e.stopPropagation();
      const where = { seq: activeSeq, index: plates.filter(x => !x.trashed).findIndex(x => x.filename === filename) };
      await fetch('/api/trash', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ filename, trashed })
      });
      await loadState();
      const p = plates.find(x => x.filename === filename);
      if (trashed && p) offerUndoTrash(p, where);
      if (!trashed && p) pushStep({ label: `Restore “${p.title}”`, undo: () => trashFile(filename), redo: async () => { await fetch('/api/trash', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ filename, trashed: false }) }); await loadState(); } });
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
        syncSelects();
      } catch (e) {}
    }

    // ---- live generation progress (lives in the status strip) ----
    const prog = { t0: 0, timer: null, slots: [], titles: [], world: '', stage: '', note: '', total: 0, summary: '' };
    function fmtElapsed(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    function progRender() {
      refreshPending();
      const el = document.getElementById('statusText');
      const done = prog.slots.filter(x => x === 'ok' || x === 'trash' || x === 'err').length;
      const running = prog.slots.filter(x => x === 'run').length;
      const dots = prog.slots.map((st, i) => `<i class="slot ${st}" title="${escapeHtml((prog.titles[i] || '') + (prog.why && prog.why[i] ? ' — ' + prog.why[i] : ''))}"></i>`).join('');
      const bar = prog.stage === 'invent' ? '<span class="slots indeterminate"><i></i></span>' : `<span class="slots">${dots}</span>`;
      const count = prog.stage === 'invent' ? '' : `<b>${done}/${prog.total}</b>`;
      el.innerHTML = `<div class="prog">
        <span class="prog-world">${escapeHtml(prog.world || 'New batch')}</span>${bar}${count}
        <span class="prog-note">${escapeHtml(prog.summary || prog.note)}</span>
        ${prog.timer ? `<span class="prog-time">${fmtElapsed(Date.now() - prog.t0)}${running ? ` · ${running} ${prog.world === 'AI order' ? 'working' : 'rendering'}` : ''}</span>` : ''}
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
      document.getElementById('exportBtn').disabled = aiRunning || !activePlates().length;
      ['trashSelAll', 'trashEmpty'].forEach(id => { document.getElementById(id).disabled = aiRunning; });
      document.body.classList.toggle('ai-running', aiRunning);
      syncSelects();
      document.getElementById('aiLock').hidden = !aiRunning;
      document.getElementById('gridHint').textContent = gridHintText();
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
      const t0 = performance.now();
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
            zoom_amount: parseFloat(document.getElementById('zoomAmt').value) || 0,
            trail: (parseFloat(document.getElementById('trailRange').value) || 0) / 100,
            ...(currentGroup === 'all' ? {} : { files: activePlates().map(p => p.filename) }),   // a group: just its images
            ...(editOf(currentEdit) ? { edit: editOf(currentEdit).name } : {}),   // the file is named after the edit
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
          noteExportRate(rhythmFor(activePlates().length).end / 30, (performance.now() - t0) / 1000);
          drawInfo();
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
    enhanceSelects();
    updateFx();
    updateTempo();
    updateRhythm();
    updateMusic();
    showSoundGroup(document.getElementById('soundGroupVal').value);
    setPlayLabel();
    try { setMode(localStorage.getItem('studioMode') || 'curate'); } catch (e) { setMode('curate'); }
    try { toggleMini(localStorage.getItem('studioMini') !== '0'); } catch (e) { toggleMini(true); }
    setThumbSize(document.getElementById('thumbSizeVal').value);
    settled = settingsSnap(); showUndo();                                    // the history starts here
    ['batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput'].forEach(id => document.getElementById(id).addEventListener('change', saveSettings));
    document.getElementById('worldSelect').addEventListener('change', () => { document.getElementById('directionInput').value = ''; saveSettings(); updateDirectionHint(); });
    loadWorlds();
    (async () => {
      const slow = setTimeout(() => { document.getElementById('loaderMsg').textContent = 'Still loading (checking new images)…'; }, 4000);
      try {
        await loadState();
        if (!history.length) { clearTimeout(settleTimer); settled = settingsSnap(); }   // the library fitted the sliders to it: not a change of yours
      } catch (e) {
        document.getElementById('loaderMsg').textContent = 'Could not reach the server. Is it running? Retrying…';
        setTimeout(() => location.reload(), 3000);
        return;
      } finally {
        clearTimeout(slow);
      }
      warmSound();
      const l = document.getElementById('loader');
      l.classList.add('done');
      setTimeout(() => l.remove(), 400);
    })();

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
          libraryMoved(v.state);
        } catch (e) {}  // server restarting: try again next tick
      }, 1500);
    })();
  

// Inline handlers in the markup (onclick=...) need these on window now that the code is an ES module.
Object.assign(window, {
  includeAll,
  startAiOrder,
  toggleAiPanel,
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
  undoLast,
  redoLast,
  showSoundGroup,
  setMode,
  randomRhythm,
  randomLook,
  pickCharacter,
  filmstripClick,
  rhythmStripClick,
  setThumbSize,
  refreshLibrary,
  setGroup,
  openEditMenu,
  openEdit,
  snapshotEdit,
  replaceEdit,
  renameEdit,
  deleteEdit,
  openGroupMenu,
  addToGroup,
  newGroup,
  removeFromGroup,
  renameGroup,
  deleteGroup,
  clearPicks,
  pickClick,
  toggleFullscreen,
  toggleKeys,
  stageStats: () => ({ lateFrames, ready: ready.size }),
  toggleMini,
  restoreSelected,
  togglePromptOverlay,
  toggleReticle,
  toggleSettings,
  updateTempo,
  updateRhythm,
  restartPlay,
  updateFx,
});
