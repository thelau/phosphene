    let plates = [];
    let showTrash = false;
    let isPlaying = false;
    let currentIdx = 0;
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

    // Settings opened by the page itself (Generate or New project without the key or the sign-in), on the field to fill: the click
    // that asked for it must not close it again on its way up
    let settingsOpenedAt = -1;
    function openSettingsOn(id) {
      toggleSettings(true);
      settingsOpenedAt = performance.now();                                  // a click made before this instant is the one that asked
      const el = document.getElementById(id);
      if (el) el.focus();
    }
    document.addEventListener('click', (e) => {
      const pop = document.getElementById('settingsPopover');
      const btn = document.getElementById('settingsBtn');
      if (e.timeStamp > settingsOpenedAt && !pop.contains(e.target) && !btn.contains(e.target)) {
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
      if (data.kimi_key_status === 'refused') {                               // not kept: the key before (if any) stays
        document.getElementById('kimiKeyInput').value = '';
        const lbl = document.getElementById('kimiStatusLabel'), dot = document.getElementById('kimiDot');
        dot.className = 'dot off'; lbl.textContent = 'Key refused';
        setStatus(data.error || 'Kimi refused that key.');
        return;
      }
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

    // a job's requests say which project they are for: the server refuses them if another project was opened meanwhile
    const forProject = (h = {}) => (project ? { ...h, 'X-Phosphene-Project': project.slug } : h);
    let stateCalls = 0, kreaConnected = false;
    async function loadState() {
      const call = ++stateCalls;
      const res = await fetch('/api/state');
      const data = await res.json();
      if (call !== stateCalls) return;                                       // a newer request is on its way: an older answer must not win
      const lengthBefore = activePlates().length;
      if (project && (!data.project || data.project.slug !== project.slug)) {   // another window (or a file opened from Finder) changed the project: show that one
        reopen(data.project ? data.project.name : '');
        return;
      }
      if (data.project) showProject(data.project);
      showNoProject(data);
      plates = data.plates || [];
      sequences = data.sequences || [];
      groups = data.groups || [];
      editsList = data.edits || [];
      if (data.project) useProjectFilm(data.project.slug);                  // each project its own film and sound
      if (currentEdit && !editsList.some(x => x.id === currentEdit)) setCurrentEdit(null);   // deleted elsewhere
      renderEditBar();
      if (!groupMembers(currentGroup)) currentGroup = 'all';                // a group that is gone (deleted, emptied by the library)
      activeSeq = data.active_sequence || null;

      const kreaDot = document.getElementById('kreaDot');
      const kreaLbl = document.getElementById('kreaStatusLabel');
      kreaDot.className = 'dot' + (data.krea_connected ? '' : ' off');
      kreaLbl.textContent = data.krea_connected ? 'Connected' : 'Disconnected';
      kreaConnected = Boolean(data.krea_connected);
      document.getElementById('kreaConnectBtn').hidden = kreaConnected;     // one button: Connect Krea, or once connected Sign out of Krea
      document.getElementById('kreaSignOutBtn').hidden = !kreaConnected;

      kimiConfigured = Boolean(data.kimi_configured);
      updateKimiIndicator();
      const keyInput = document.getElementById('kimiKeyInput');
      if (data.kimi_key_masked && !keyInput.value) {
        keyInput.placeholder = `Saved (${data.kimi_key_masked})`;
      }
      if (data.kimi_model) {
        document.getElementById('kimiModelSelect').value = data.kimi_model;
      }
      document.getElementById('criticOn').checked = data.critic_enabled !== false;      // as the server has them (they showed unticked until a save)
      document.getElementById('criticTrash').checked = Boolean(data.critic_autotrash);

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
    // the snapshot open, per project (snapshots are a project's own)
    const editKey = () => `studioEdit:${filmSlug || ''}`;
    function setCurrentEdit(id) { currentEdit = id; try { if (id) localStorage.setItem(editKey(), id); else localStorage.removeItem(editKey()); } catch (e) {} }
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
      const res = await (await fetch('/api/edits', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify(payload) })).json();
      if (!res.ok) { setStatus(res.error || 'Could not do that.'); return null; }
      await loadState();
      return res;
    }
    // ---- projects: one per brand mark (projects.py); the server works on one at a time, switching reloads the page ----
    let project = null, projectForm = null;
    // no project yet (a new user): the first screen; the header says so; the menu still offers New project and Import
    function showNoProject(data) {                                          // no project yet (a first launch of the app): the usual page, empty; the project menu offers New project and Import
      if (data.project) return;
      project = null;
      document.getElementById('projectName').textContent = 'No project';
      document.getElementById('projectMark').removeAttribute('src');
      document.body.classList.add('no-project');                             // no mark yet: no logo target to show
      for (const id of ['targetBtn', 'gridTargetBtn']) { const b = document.getElementById(id); if (!b.dataset.title) b.dataset.title = b.title; b.disabled = true; b.title = 'The logo target: make or import a project first'; }
    }
    // a dark mark (Nike's black swoosh) is lost on the dark top bar and menu: there it shows as a light silhouette, as on the dark guide;
    // a light or colourful mark stays as it is. Measured once per image from its opaque pixels
    const markTones = new Map();
    function fitMarkTone(img) {
      const apply = () => {
        const url = img.getAttribute('src');
        if (!url) return;
        if (!markTones.has(url)) {
          try {
            const c = document.createElement('canvas'), n = 48; c.width = n; c.height = n;
            const x = c.getContext('2d'); x.drawImage(img, 0, 0, n, n);
            const d = x.getImageData(0, 0, n, n).data;
            let sum = 0, w = 0;
            for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; if (a < 0.1) continue; sum += a * (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; w += a; }
            markTones.set(url, w ? sum / w : 1);
          } catch (e) { markTones.set(url, 1); }
        }
        img.classList.toggle('mark-dark', markTones.get(url) < 0.3);
      };
      if (img.complete && img.naturalWidth) apply(); else img.addEventListener('load', apply, { once: true });
    }
    function showProject(p) {
      project = p;
      document.body.classList.remove('no-project');
      for (const id of ['targetBtn', 'gridTargetBtn']) { const b = document.getElementById(id); b.disabled = false; if (b.dataset.title) b.title = b.dataset.title; }
      const img = document.getElementById('projectMark');
      if (img.getAttribute('src') !== p.mark_url) img.src = p.mark_url;
      fitMarkTone(img);
      document.getElementById('projectName').textContent = p.name;
      const r = document.documentElement.style;                               // the logo target: the mark's size, place and shape
      if (r && r.setProperty) {
        r.setProperty('--mark-w', `${p.mark_size}%`); r.setProperty('--mark-x', `${p.mark_x}%`); r.setProperty('--mark-y', `${p.mark_y}%`);
        r.setProperty('--mark-ar', String(p.mark_ratio || 1)); r.setProperty('--mark-r', '2px');   // always the mark's box (a round mark fits its square): the user's call
      }
      const centred = p.mark_x === 50 && p.mark_y === 50;
      document.getElementById('retLabel').textContent = `logo · ${centred ? 'centre' : `${p.mark_x}%, ${p.mark_y}%`} · ${p.mark_size}%`;
    }
    async function openProjectMenu(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      const m = document.getElementById('projectMenu'), btn = document.getElementById('projectBtn');
      if (!m.hidden) { closeProjectMenu(); return; }
      let list = [];
      try { list = (await (await fetch('/api/projects')).json()).projects || []; } catch (err) { list = project ? [project] : []; }
      // while images are made (or an AI order, an export, a purge runs) the project stays: the page drives that work, a switch would cut it
      const busy = isBusy(), off = busy ? ' disabled' : '';
      const why = generating ? 'Images are being made' : aiRunning ? 'The AI is ordering' : exporting ? 'A film is being exported' : 'Images are being deleted';
      m.innerHTML = (busy ? `<p class="gm-note">${why}: other projects wait until it ends.</p>` : '')
        + list.map(x => { const here = project && x.slug === project.slug; return `<button type="button" class="gm-item${here ? ' on' : ''}" data-slug="${escapeHtml(x.slug)}" onclick="switchProject(this.dataset.slug)"${here ? '' : off}><img src="${escapeHtml(x.mark_url)}" alt="" />${escapeHtml(x.name)}</button>`; }).join('')
        + (list.length ? '<hr>' : '') + `<button type="button" class="gm-item" onclick="openProjectForm('new')"${off}>New project…</button>`
        + (project ? `<button type="button" class="gm-item" onclick="openProjectForm('edit')"${off}>Project settings…</button>` : '')
        + '<hr>' + (project ? '<button type="button" class="gm-item" onclick="exportProject()" title="This project as one file (.phos): its mark, settings, images, groups and snapshots, to send or keep">Export project…</button>' : '')
        + `<button type="button" class="gm-item" onclick="closeProjectMenu(); chooseProjectFile()" title="Open a .phos file someone exported: it comes in as a new project"${off}>Import project…</button>`
        + (project ? `<hr><button type="button" class="gm-item danger-text" onclick="deleteProject()" title="This project's folder goes to the Trash: it can be put back until the Trash is emptied"${off}>Delete project…</button>` : '');
      m.querySelectorAll('img').forEach(fitMarkTone);
      const a = btn.getBoundingClientRect();
      m.hidden = false; btn.setAttribute('aria-expanded', 'true');
      m.style.top = `${a.bottom + 6}px`; m.style.left = `${Math.max(8, a.left)}px`;
    }
    function closeProjectMenu() { const m = document.getElementById('projectMenu'); if (m) m.hidden = true; const b = document.getElementById('projectBtn'); if (b) b.setAttribute('aria-expanded', 'false'); }
    document.addEventListener('click', e => { if (!(e.target.closest && (e.target.closest('#projectMenu') || e.target.closest('#projectBtn')))) closeProjectMenu(); });
    // opening another project reloads the page: a cover says what is happening until it is back, and the loader then names it
    function cover(msg) {
      const c = document.getElementById('cover');
      if (!msg) { c.hidden = true; return; }
      document.getElementById('coverMsg').textContent = msg; c.hidden = false;
    }
    function reopen(name) {
      try { sessionStorage.setItem('studioOpening', name || ''); } catch (e) {}
      location.reload();
    }
    try { const n = sessionStorage.getItem('studioOpening'); if (n) { document.getElementById('loaderMsg').textContent = `Opening ${n}…`; sessionStorage.removeItem('studioOpening'); } } catch (e) {}
    async function projectsCall(body) {
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return res.json();
    }
    async function switchProject(slug) {
      closeProjectMenu();
      if (project && slug === project.slug) return;
      if (isBusy()) { setStatus('Wait until the running job ends, then switch project.'); return; }
      const name = (document.querySelector(`#projectMenu [data-slug="${CSS.escape(slug)}"]`) || {}).textContent || 'the project';
      cover(`Opening ${name}…`);
      const r = await projectsCall({ action: 'switch', slug });
      if (r.ok) reopen(r.project && r.project.name); else { cover(null); setStatus(r.error || 'Could not switch project.'); }
    }
    // the form: a new project, or this one's settings; the mark is drawn into a PNG here (an SVG too), at most 1600 px
    function openProjectForm(kind) {
      closeProjectMenu();
      const edit = kind === 'edit' && project;
      if (isBusy()) { setStatus('Wait until the running job ends, then open the project settings.'); return; }   // also from the Mac menu (⌘N), which skips the greyed-out menu
      if (!edit && !kimiConfigured) {                                         // a new project starts from Kimi reading the mark: the key first
        openSettingsOn('kimiKeyInput');
        setStatus('Add your Kimi API key to create a project: Kimi reads your mark and fills in the project for you.');
        return;
      }
      projectForm = { kind: edit ? 'edit' : 'new', mark: null, markUrl: edit ? project.mark_url : null, typed: new Set() };
      const set = (id, v) => { document.getElementById(id).value = v; };
      set('pfName', edit ? project.name : ''); set('pfSize', edit ? project.mark_size : 18); set('pfX', edit ? project.mark_x : 50); set('pfY', edit ? project.mark_y : 50);
      set('pfShape', edit ? project.mark_shape : ''); set('pfNoun', edit ? project.mark_noun : ''); set('pfBrief', edit ? project.brief : ''); set('pfPalette', edit ? (project.palette || []).join(' ') : '');
      document.getElementById('pfMark').value = '';
      const locked = !!(edit && project.fixed);                                  // DEMO: name, brand and colours change; its mark, place and words stay
      document.getElementById('pfLocked').hidden = !locked;
      formStage(edit ? 'ready' : 'pick');
      document.getElementById('projectTitle').textContent = edit ? `${project.name}: settings` : 'New project';
      document.getElementById('pfSave').textContent = edit ? 'Save' : 'Create project';
      document.getElementById('pfError').textContent = '';
      document.getElementById('projectModal').classList.add('open');
      drawProjectPreview();
      document.getElementById(edit ? 'pfName' : 'pfMark').focus();
    }
    // a new project: the mark first; while Kimi reads it nothing else can be used; then everything it filled in can be changed
    const PF_FIELDS = ['pfName', 'pfSize', 'pfX', 'pfY', 'pfShape', 'pfNoun', 'pfBrief', 'pfPalette'];
    let readingTimer = 0;
    function formStage(stage) {
      clearInterval(readingTimer);
      const locked = !!(projectForm && projectForm.kind === 'edit' && project && project.fixed);
      for (const id of PF_FIELDS) document.getElementById(id).disabled = stage !== 'ready' || (locked && ['pfSize', 'pfX', 'pfY', 'pfShape', 'pfNoun'].includes(id));
      document.getElementById('pfMark').disabled = stage === 'reading' || locked;
      document.getElementById('pfSave').disabled = stage !== 'ready';
      const note = document.getElementById('pfKimi');
      if (stage === 'pick') { note.hidden = false; note.textContent = 'Choose the mark: Kimi reads it and fills in the rest.'; }
      else if (stage === 'reading') {
        const t0 = Date.now();
        note.hidden = false;
        note.innerHTML = '<span class="spin"></span><span>Kimi is reading the mark…</span><span class="t" id="pfReadT">0 s · usually 10 to 40 s</span>';
        readingTimer = setInterval(() => { const t = document.getElementById('pfReadT'); if (t) t.textContent = `${Math.round((Date.now() - t0) / 1000)} s · usually 10 to 40 s`; }, 1000);
      } else if (projectForm && projectForm.kind === 'edit') note.hidden = true;
    }
    function closeProjectForm() { clearInterval(readingTimer); document.getElementById('projectModal').classList.remove('open'); projectForm = null; }   // also while Kimi reads: its answer is dropped
    async function readProjectMark(file) {
      if (!file || !projectForm) return;
      const url = URL.createObjectURL(file);
      try {
        const im = new Image(); im.src = url; await im.decode();
        let w = im.naturalWidth || 1024, h = im.naturalHeight || 1024;
        const k = file.type === 'image/svg+xml' ? 1600 / Math.max(w, h) : Math.min(1, 1600 / Math.max(w, h));
        w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        let c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        const px = c.getContext('2d').getImageData(0, 0, w, h).data;           // trimmed to the mark, as the server does: its size is the mark's
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) throw new Error('empty');
        if (x1 - x0 + 1 < w || y1 - y0 + 1 < h) {
          const t = document.createElement('canvas'); t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
          t.getContext('2d').drawImage(c, -x0, -y0); c = t;
        }
        projectForm.mark = c.toDataURL('image/png'); projectForm.markUrl = projectForm.mark;
        document.getElementById('pfError').textContent = '';
        describeMark(projectForm.mark);
      } catch (err) {
        document.getElementById('pfError').textContent = err.message === 'empty' ? 'That image is empty: the mark needs to show on a transparent or plain background.' : 'That file could not be read as an image.';
      } finally { URL.revokeObjectURL(url); }
      drawProjectPreview();
    }
    function drawProjectPreview() {
      const v = id => parseFloat(document.getElementById(id).value);
      const size = v('pfSize'), x = v('pfX'), y = v('pfY');
      document.getElementById('pfSizeVal').textContent = `${size}%`; document.getElementById('pfXVal').textContent = `${x}%`; document.getElementById('pfYVal').textContent = `${y}%`;
      const box = document.getElementById('pfPreview'), img = document.getElementById('pfPreviewMark');
      box.style.setProperty('--pf-x', `${x}%`); box.style.setProperty('--pf-y', `${y}%`);
      if (projectForm && projectForm.markUrl) { if (img.getAttribute('src') !== projectForm.markUrl) img.src = projectForm.markUrl; } else img.removeAttribute('src');
      img.style.left = `${x}%`; img.style.top = `${y}%`; img.style.width = `${size}%`;
      const cols = document.getElementById('pfPalette').value.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [];
      document.getElementById('pfSwatches').innerHTML = cols.slice(0, 8).map(c => `<i style="background:${c}"></i>`).join('');
    }
    // a mark just chosen: its own colours, and Kimi's words for it with colours to go with them; never over what was typed by hand
    async function describeMark(mark) {
      const note = document.getElementById('pfKimi');
      formStage('reading');
      let r = null;
      try { r = await (await fetch('/api/describe-mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mark }) })).json(); } catch (e) {}
      if (!projectForm || projectForm.mark !== mark) return;                    // closed, or another mark chosen meanwhile
      formStage('ready');
      if (!r || !r.ok) { note.textContent = (r && r.error) || 'The mark could not be read: fill in the fields yourself.'; return; }
      const fill = (id, v) => { if (v && !projectForm.typed.has(id)) document.getElementById(id).value = v; };
      fill('pfName', r.name); fill('pfBrief', r.brand); fill('pfShape', r.shape); fill('pfNoun', r.noun);
      fill('pfPalette', [...(r.colours || []), ...(r.suggested || [])].join(' '));
      note.textContent = r.shape ? 'Kimi filled this in from the mark: check it and change anything.' : (r.note || 'The mark\'s own colours are filled in.');
      drawProjectPreview();
      document.getElementById('pfName').focus();
    }
    for (const id of ['pfName', 'pfBrief', 'pfShape', 'pfNoun', 'pfPalette']) { const el = document.getElementById(id); if (el && el.addEventListener) el.addEventListener('input', () => projectForm && projectForm.typed.add(id)); }
    // a project as one file (mark, settings, images, groups, snapshots), and back
    async function exportProject() {
      closeProjectMenu();
      setStatus(`Packing ${project ? project.name : 'the project'}…`);
      try {
        const r = await (await fetch('/api/project-export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: project && project.slug }) })).json();
        if (!r.ok) throw new Error(r.error || 'it was not made');
        const a = document.createElement('a'); a.href = r.url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
        setStatus(`Downloading ${r.filename} (${Math.round(r.bytes / 1e6)} MB): send it; a double-click (or Import project) opens it as it is.`);
      } catch (e) { setStatus(`Could not export the project: ${e.message}`); }
    }
    // Import project…: in the Mac app the macOS file dialog (WebKit there opens no window for a hidden file field) and the file is
    // imported from where it is, as a double-click does (nothing uploaded through the page); in a browser the page's file field
    async function chooseProjectFile() {
      if (TAURI && TAURI.event) {                                             // the app opens its file dialog and imports, as ⌘O does
        try { await TAURI.event.emit('open-project-file'); } catch (e) { setStatus(`Could not open the file dialog: ${(e && e.message) || e}`); }
        return;
      }
      document.getElementById('pfImport').click();
    }
    // Delete project…: asked first; its folder goes to the macOS Trash (recoverable until emptied), then another project opens
    async function deleteProject() {
      closeProjectMenu();
      if (!project) return;
      if (isBusy()) { setStatus('Wait until the running job ends, then delete.'); return; }
      const n = plates.length, name = project.name;
      if (!(await askConfirm(`Delete ${name}?`, `Its ${n} image${n === 1 ? '' : 's'}, groups and snapshots go to the Trash, with its mark and settings. You can put the folder back from the Trash until you empty it; Export project… first keeps a copy.`, 'Delete'))) return;
      cover(`Deleting ${name}…`);
      try {
        const r = await projectsCall({ action: 'delete', slug: project.slug });
        if (!r.ok) throw new Error(r.error || 'it was not deleted');
        reopen(r.project ? r.project.name : '');
      } catch (e) { cover(null); setStatus(`Could not delete ${name}: ${e.message}`); }
    }
    async function importProjectPath(path) {
      if (isBusy()) { setStatus('Wait until the running job ends, then import.'); return; }
      cover(`Importing ${path.split('/').pop()}…`);
      try {
        const r = await (await fetch('/api/project-import-path', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })).json();
        if (!r.ok) throw new Error(r.error || 'it was not imported');
        reopen(r.project && r.project.name);
      } catch (e) { cover(null); setStatus(`Could not import: ${e.message}`); }
    }
    async function importProject(file) {
      if (!file) return;
      if (isBusy()) { setStatus('Wait until the running job ends, then import.'); return; }
      cover(`Importing ${file.name} (${Math.round(file.size / 1e6)} MB)…`);
      try {
        const r = await (await fetch('/api/project-import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file })).json();
        if (!r.ok) throw new Error(r.error || 'it was not imported');
        reopen(r.project && r.project.name);
      } catch (e) { cover(null); setStatus(`Could not import: ${e.message}`); }
      finally { document.getElementById('pfImport').value = ''; }
    }
    async function saveProject() {
      if (!projectForm) return;
      if (isBusy()) { document.getElementById('pfError').textContent = 'Wait until the running job ends (images, an AI order or an export), then save.'; return; }
      const val = id => document.getElementById(id).value;
      const err = document.getElementById('pfError');
      if (projectForm.kind === 'new' && !projectForm.mark) { err.textContent = 'Choose the mark: a PNG or SVG with a transparent background works best.'; return; }
      const body = projectForm.kind === 'edit' && project.fixed ? { action: 'update', slug: project.slug, name: val('pfName'), brief: val('pfBrief'), palette: val('pfPalette').match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [] } : { action: projectForm.kind === 'new' ? 'create' : 'update', slug: project && project.slug, name: val('pfName'),
        mark_size: +val('pfSize'), mark_x: +val('pfX'), mark_y: +val('pfY'), mark_shape: val('pfShape'), mark_noun: val('pfNoun'), brief: val('pfBrief'),
        palette: val('pfPalette').match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || [], ...(projectForm.mark ? { mark: projectForm.mark } : {}) };
      document.getElementById('pfSave').disabled = true;
      if (body.action === 'create') cover(`Making ${body.name}…`);
      try {
        const r = await projectsCall(body);
        if (r.ok) { reopen(r.project && r.project.name); return; }
        cover(null);
        err.textContent = r.error || 'Could not save the project.';
      } catch (e) { err.textContent = `Could not save the project: ${e.message}`; }
      finally { document.getElementById('pfSave').disabled = false; }
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
      renderGroups(); renderGrid(); renderFilmstrip(); renderEditBar(); renderSequences();
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
      const res = await (await fetch('/api/groups', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify(payload) })).json();
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
      const start = await (await fetch('/api/order-ai', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify(body) })).json();
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
      const dl = document.getElementById('downloadBtn'), n = activePlates().length;   // the Selection only (All or the group), not the Trash
      dl.hidden = showTrash; dl.disabled = !n || downloading;
      dl.title = n ? `Download the ${n} image${n === 1 ? '' : 's'} shown, full size, in their order (a zip)` : 'No images to download';
      syncAiBtn();
      for (const id of ['playBtn', 'fsPlayBtn', 'miniPlayBtn']) document.getElementById(id).disabled = !n;
      if (!n && isPlaying) togglePlay();                                     // the last image went (trashed, another group): stop
    }
    function syncAiBtn() {                                                   // nothing to order under two images
      const b = document.getElementById('aiBtn'), few = activePlates().length < 2;
      b.disabled = aiRunning || generating || few;
      b.title = few ? 'AI re-order needs at least two images' : 'Let the AI rearrange your order (⌘Z puts it back)';
    }
    // the images shown in Curate (All or the chosen group, in their order), full size, in one zip; the browser saves it
    let downloading = false;
    async function downloadShown() {
      const list = activePlates();
      if (showTrash || !list.length || downloading) return;
      downloading = true; renderSequences();
      setStatus(`Packing ${list.length} images…`);
      try {
        const label = currentGroup === 'all' ? 'All' : (groupChips().chips.concat(groupChips().auto).find(c => c.key === currentGroup) || { name: 'Group' }).name;
        const r = await (await fetch('/api/download-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: list.map(p => p.filename), label }) })).json();
        if (!r.ok) throw new Error(r.error || 'the zip was not made');
        const a = document.createElement('a'); a.href = r.url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
        setStatus(`Downloading ${r.filename} (${Math.round(r.bytes / 1e6)} MB).`);
      } catch (e) {
        setStatus(`Could not download: ${e.message}`);
      } finally { downloading = false; renderSequences(); }
    }
    async function seqCall(payload) {
      const res = await (await fetch('/api/sequence', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify(payload) })).json();
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
      document.getElementById('trashDelSel').disabled = aiRunning || exporting || trashSel.size === 0;
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
      if (exporting) { setStatus('Wait until the export ends: it reads the images as it goes.'); return; }   // emptied mid-export, the film failed partway
      if (!(await askConfirm(title, body, yesLabel))) return;
      const btns = ['trashDelSel', 'trashEmpty', 'trashSelAll'].map(id => document.getElementById(id));
      btns.forEach(b => { b.disabled = true; });
      const count = payload.all ? plates.filter(p => p.trashed).length : payload.filenames.length;
      purging = true;
      showBusy(`Deleting ${count} image${count === 1 ? '' : 's'}…`);
      try {
        const res = await (await fetch('/api/purge', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify(payload) })).json();
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
      empty.textContent = showTrash ? 'The Trash is empty.' : project ? 'No images yet. Choose a territory and press Generate.' : 'No images yet';
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
              <div class="prompt-overlay-text">${p.world ? `<b class="po-world">${escapeHtml(p.world)}</b>` : ''}${p.idea ? `<i class="po-idea">${escapeHtml(p.idea)}</i>` : ''}<span class="po-prompt">${escapeHtml(p.prompt || p.title)}</span>${p.critic ? `<span class="po-critic">AI critic ${p.critic.mean}: ${escapeHtml(p.critic.reason)}</span>` : ''}${!p.qa_passed && (p.qa_issues || []).length ? `<span class="po-critic po-qa">Logo check: ${escapeHtml(p.qa_issues.join('; '))}</span>` : p.qa_doubt ? `<span class="po-critic po-doubt">Logo check: ${escapeHtml(p.qa_doubt)}</span>` : ''}</div>
              <div class="prompt-overlay-meta"><button class="po-copy" onclick="copyPromptText(event, '${p.filename}')">Copy prompt</button></div>
            </div>
          </div>
          <div class="card-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
          <div class="card-meta">
            <span class="card-model-badge">${escapeHtml(formatModelShort(p.model))}</span>
            ${p.critic ? `<span class="card-model-badge" title="${escapeHtml(p.critic.reason)}">AI ${p.critic.mean}</span>` : ''}
            ${p.trash_reason ? `<span class="card-model-badge warn" title="${escapeHtml(!p.qa_passed && (p.qa_issues || []).length && p.trash_reason === 'Logo check' ? p.qa_issues.join(', ') : p.trash_reason)}">${escapeHtml(p.trash_reason.slice(0, 40))}</span>` : ''}
            ${!p.qa_passed ? (p.trash_reason === 'Logo check' ? '' : `<span class="card-model-badge warn" title="${escapeHtml((p.qa_issues || []).join(', '))}">QA flagged</span>`) : p.qa_doubt ? `<span class="card-model-badge doubt" title="${escapeHtml(p.qa_doubt)}">Check the mark</span>` : ''}
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
      if (!['S', 'M', 'L', 'XL'].includes(v)) v = 'M';
      document.getElementById('thumbSizeVal').value = v;
      document.getElementById('grid').dataset.size = v;
      for (const k of ['S', 'M', 'L', 'XL']) document.getElementById(`thumb${k}`).setAttribute('aria-pressed', String(k === v));
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
      const set = trashed => async () => { for (const filename of files) await fetch('/api/trash', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify({ filename, trashed }) }); await loadState(); };
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
        await fetch('/api/reorder', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify({ order }) });
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
      paintGl();
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
      else if ((e.key === 'Delete' || e.key === 'Backspace') && mode === 'film' && rsSel) { e.preventDefault(); removeChange(); }   // a selected point of the change: the change goes (never an image)
      else if (e.key === 'Backspace' || e.key === 'Delete') e.preventDefault();       // nothing else: and WebKit (the Mac app) must not take Backspace for "go back"
      else if (e.key === 'Escape') { document.getElementById('keysPanel').hidden = true; if (pickSel.size) clearPicks(); if (rsSel) { rsSel = null; renderRhythmStrip(); } }
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
      await fetch('/api/trash', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify({ filename, trashed: true }) });
      await loadState();
    }
    // back from the Trash, at the place it had in the order it was trashed from (if that order is still the one shown; else at the end, as a restore does)
    async function untrash(filename, where) {
      if (blockedByAi()) return;
      await fetch('/api/trash', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify({ filename, trashed: false }) });
      await loadState();
      if (where && where.index >= 0) {
        const order = plates.filter(x => !x.trashed && x.filename !== filename).map(x => x.filename);
        order.splice(Math.min(where.index, order.length), 0, filename);
        await fetch('/api/reorder', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify({ order }) });
        await loadState();
      }
    }

    // ---- what is on screen when: the preview and the export plan every frame with these ----
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
      if (!(total > 0)) t = 0;
      else if (t < 0 || t >= total) t = ((t % total) + total) % total;   // only outside the loop: (t + total) % total read a cut's own start back a hair early (the image before showed)
      let lo = 0, hi = starts.length - 2;
      while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (starts[mid] <= t) lo = mid; else hi = mid - 1; }
      const span = starts[lo + 1] - starts[lo];
      return [lo, span > 0 ? (t - starts[lo]) / span : 0];
    }
    // ---- the rhythm: one tempo, and at most one change of speed, both set on the timeline ----
    // The tempo is the music's cut length (60000 / BPM ms) and the speed until a change. A change runs from the tempo at `from` to end_ms at
    // `to` (both a share of the film's music cuts, so a point stays on its image while the speeds move), eased by `curve` (0: an even,
    // geometric change, each cut a constant ratio of the one before, as the references slow down; 1: it waits and then changes sharply).
    const BPM_RANGE = [40, 1200], MS_RANGE = [50, 1500];                     // the same span both ways: 1500 to 50 ms
    const clampMs = ms => Math.min(MS_RANGE[1], Math.max(MS_RANGE[0], ms));
    function rhythmMode() { return document.getElementById('rhythmSelect').value === 'variable' ? 'variable' : 'flat'; }
    function changeParams() {
      if (rhythmMode() !== 'variable') return null;
      const num = (id, d) => { const v = parseFloat(document.getElementById(id).value); return Number.isFinite(v) ? v : d; };
      const from = Math.min(0.98, Math.max(0, num('changeFrom', 0.6))), to = Math.min(1, Math.max(from + 0.02, num('changeTo', 1)));
      return { from, to, end_ms: Math.round(clampMs(num('endMsRange', 600))), curve: Math.min(1, Math.max(0, num('curveVal', 0))) };
    }
    const easeChange = (u, curve) => Math.pow(Math.min(1, Math.max(0, u)), 1 + 4 * curve);
    // the music cut length (ms) at a point of the film, x a share of its music cuts
    function msAtShare(x, bpm, change) {
      const start = 60000 / bpm;
      if (!change || x <= change.from) return start;
      if (x >= change.to) return change.end_ms;
      const e = easeChange((x - change.from) / (change.to - change.from), change.curve);
      return Math.exp(Math.log(start) + (Math.log(change.end_ms) - Math.log(start)) * e);
    }
    // the music's cut length at a moment of the film (frames), for this change: the share of the music cuts reached by then, then its speed
    function msAtFrame(t, nBase, nMusic, bpm, change, base) {
      base = base || baseStarts(nBase, bpm, change, nMusic);
      let i = 0;
      while (i < nBase - 1 && base[i + 1] <= t) i++;
      const frac = Math.max(0, Math.min(1, (t - base[i]) / Math.max(1e-9, base[i + 1] - base[i])));
      return msAtShare((i + frac) / nMusic, bpm, change);
    }
    // where each music cut starts, in frames: every cut the tempo, or the change, cut i taken at its middle. Shares count the music cuts
    // the film holds (nMusic: with a Multiple the last one can run past the film's end)
    function baseStarts(nBase, bpm, change, nMusic = nBase) {
      if (!change) return Array.from({ length: nBase + 1 }, (_, i) => (i * 1800) / bpm);
      const starts = [0];
      for (let i = 0; i < nBase; i++) starts.push(starts[i] + Math.max(1, (msAtShare((i + 0.5) / nMusic, bpm, change) * 30) / 1000));
      return starts;
    }
    // Two timelines, both in frames (30 per second). The BASE is what the music follows: the beat grid (Flat) or the variable run.
    // The PICTURE cuts `multiple` times per base cut, and only the picture feels the multiple (the music follows the base).
    function subdivideStarts(base, multiple, nCuts) {
      const m = Math.max(0.05, multiple), nBase = base.length - 1, out = [];
      for (let k = 0; k <= nCuts; k++) {
        const x = Math.min(k / m, nBase), i = Math.min(Math.floor(x), nBase - 1);
        const v = nBase >= 1 ? base[i] + (base[i + 1] - base[i]) * (x - i) : 0;
        out.push(out.length ? Math.max(v, out[out.length - 1] + 1) : v);
      }
      return out;
    }
    // the tempo is 40 to 1200 BPM (1500 to 50 ms a music cut); a stored or odd value is kept inside that
    function bpmValue() { const v = parseFloat(document.getElementById('bpmInput').value); return Number.isFinite(v) ? Math.min(BPM_RANGE[1], Math.max(BPM_RANGE[0], v)) : 120; }
    function followCuts() { return !!document.getElementById('followCuts').checked; }
    let timelineCache = { key: '', value: null };
    function rhythmFor(nPlates) {
      const invert = document.getElementById('invertSelect').value;
      const paired = invert === 'mono' || invert === 'colour';
      const nCuts = nPlates * (paired ? 2 : 1);
      const mult = parseFloat(document.getElementById('multSelect').value) || 1;
      const bpm = bpmValue();
      const follow = followCuts();
      const ch = changeParams();
      const key = `${nCuts}|${paired}|${mult}|${bpm}|${ch ? `${ch.from}|${ch.to}|${ch.end_ms}|${ch.curve}` : 'flat'}|${follow}`;
      if (timelineCache.key !== key) {
        const nBase = Math.max(1, Math.ceil(nCuts / Math.max(0.05, mult) - 1e-9));
        const nMusic = nCuts / Math.max(0.05, mult), base = baseStarts(nBase, bpm, ch, nMusic);
        const pic = subdivideStarts(base, mult, nCuts), end = pic[nCuts];
        // the music's cuts: the base cuts that fall inside the clip, or (if the user asks) every picture cut
        const audio = follow ? pic.map(f => f / 30) : base.filter(f => f < end - 1e-6).concat([end]).map(f => f / 30);
        if (audio.length < 2) audio.push(audio[0] + 0.1);                                       // no images: still a valid (empty) clip
        timelineCache = { key, value: { pic, audio, base, nBase, nMusic, end, landAt: pic[Math.max(0, nCuts - (paired ? 2 : 1))] / 30 } };
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
    let EXPORT_DONE_MS = 4000;
    function setExportState(state) { document.getElementById('exportDock').dataset.state = state; }
    function setMusicState(kind, text) {
      const el = document.getElementById('musicState');
      el.textContent = text || 'Exporting…';
      el.className = kind === 'err' ? 'err' : '';
    }
    function fmtDuration(sec) { return sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}` : `${Math.round(sec)} s`; }
    let musicWasOn = null;
    function updateMusic() {
      const on = musicOn();
      if (on && musicWasOn === false && !droneLive.playing) droneLive.fresh();   // Source Off then on: a brand-new sound connection (the reset when the sound is lost)
      musicWasOn = on;
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
      return out;
    }
    function settingsChanged() {
      if (applyingHistory || settled === null) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => commitSettings(), 700);
    }
    function changeName(before, after) {
      let ids = Object.keys(after).filter(id => after[id] !== before[id]);
      if (ids.some(id => ['rhythmSelect', 'changeFrom', 'changeTo', 'endMsRange', 'curveVal'].includes(id))) return 'the change of speed';
      if (ids.length === 1 && ids[0] === 'bpmInput') return 'the tempo';
      if (ids.length === 1 && ids[0] === 'multSelect') return 'the Multiple';
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
      snap = migrateRhythm({ ...snap });
      for (const [id, v] of Object.entries(snap)) { const el = document.getElementById(id); if (el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } }
      updateTempo(); updateRhythm(); updateFx(); updateMusic();
      settled = settingsSnap();
    }
    const rememberForUndo = () => commitSettings();                          // a Random starts: what came before is its own step
    function undoRandom() { return undoLast(); }                              // the Undo button
    // how many music cuts the film has (the change's positions are shares of them)
    function baseCount(mult) {
      const paired = ['mono', 'colour'].includes(document.getElementById('invertSelect').value);
      const m = parseFloat(mult ?? document.getElementById('multSelect').value) || 1;
      return Math.max(1, (activePlates().length * (paired ? 2 : 1)) / Math.max(0.05, m));
    }
    // a change as the Types and Random describe it (a start and an end length, over `ramp` music cuts at the end or the start) on the timeline
    function setChange(startMs, endMs, ramp, at, curve) {
      const share = Math.min(1, ramp / Math.max(ramp + 1, baseCount()));
      setv('rhythmSelect', 'variable');
      setv('bpmInput', Math.round(Math.min(BPM_RANGE[1], Math.max(BPM_RANGE[0], 60000 / startMs))));
      setv('endMsRange', Math.round(clampMs(endMs) / 10) * 10);
      setv('changeFrom', at === 'start' ? 0 : +(1 - share).toFixed(4)); setv('changeTo', at === 'start' ? +share.toFixed(4) : 1);
      setv('curveVal', curve);
    }
    // the tempo lock: Random keeps the tempo and adds no change (the tempo is the change's start); the Multiple still rolls
    function applyRhythm(r) {
      setv('multSelect', rpick(r.mult));
      if (document.getElementById('bpmLock').checked) { setv('rhythmSelect', 'flat'); return; }
      if (r.mode === 'flat') { setv('rhythmSelect', 'flat'); setv('bpmInput', rint(r.bpm)); }
      else setChange(rint(r.start), rint(r.end), rint(r.ramp), Array.isArray(r.at) ? rpick(r.at) : r.at, rpick([0, 0, 0.15, 0.3]));
    }
    // settings from before the timeline (Flat / Variable with Start, End, Change over and Change at): the same film on the timeline
    function migrateRhythm(o) {
      if (!o || !('startMsRange' in o || 'rampRange' in o || 'atSelect' in o)) return o;
      if (o.rhythmSelect === 'variable') {
        const start = parseFloat(o.startMsRange) || 100, ramp = parseInt(o.rampRange, 10) || 12, n = baseCount(o.multSelect) || 60;
        const share = Math.min(1, ramp / Math.max(ramp + 1, activePlates().length ? n : 60));
        o.bpmInput = String(Math.round(Math.min(BPM_RANGE[1], Math.max(BPM_RANGE[0], 60000 / start))));
        o.changeFrom = String(o.atSelect === 'start' ? 0 : +(1 - share).toFixed(4)); o.changeTo = String(o.atSelect === 'start' ? +share.toFixed(4) : 1);
        o.curveVal = '0';
      }
      delete o.startMsRange; delete o.rampRange; delete o.atSelect;
      return o;
    }
    function applyLook(l) { setv('invertSelect', rpick(l.invert)); setv('zoomSelect', rpick(l.zoom)); setv('zoomAmt', (l.amount[0] + Math.random() * (l.amount[1] - l.amount[0])).toFixed(1)); setv('trailRange', l.trail ? rint(l.trail) : 0); }
    function refreshVideo(quiet) { updateTempo(); updateRhythm(); updateFx(); if (!quiet) { saveSettings(); musicChanged(); } }
    // a random rhythm: a tempo (Flat) or a run that speeds up or slows down (Variable), and the Multiple
    function randomRhythm(quiet) {
      if (quiet !== true) rememberForUndo();
      if (Math.random() < 0.55) applyRhythm({ mode: 'flat', bpm: [60, 200], mult: ['0.5', '1', '1', '2', '2', '3', '4'] });   // a steady tempo
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
      const ch = changeParams();
      if (ch) return (1000 / ((60000 / bpmValue() + ch.end_ms) / 2)) * follow;
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
      const rate = rhythmCutsPerSecond();
      const sh = c ? c.shape : { bass: 0.5, pad: 0.4, tape: 0.3, arrange: ['0', '1', '1', '2', '2', '3'] };
      setv('bassRange', Math.random() < sh.bass ? rint([35, 65]) : 0);
      setv('bassPatternSelect', Math.floor(Math.random() * 4));
      setv('bassRateSelect', rate > 4 ? 0 : rate > 2 ? Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 2));   // fast cuts: a note a cut
      setv('arrangeSelect', rpick(sh.arrange));
      setv('padRange', Math.random() < sh.pad ? rint([20, 45]) : 0);
      setv('tapeRange', Math.random() < sh.tape ? rint([15, 45]) : 0);
      if (Math.random() < 0.15) setv('arpRateSelect', 4 + Math.floor(Math.random() * 2));   // now and then a polyrhythm
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
    function drawInfo() {
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
      const pace = changeParams() && Math.abs(lens[0] - lens[lens.length - 1]) > 0.002 ? `${f(lens[0]).replace(' ms', '')}→${f(lens[lens.length - 1])}` : hi > lo * 1.05 ? `${f(lo)} – ${f(hi)}` : f(lo);
      info.textContent = `${n} images · ${fmtDuration(sec(starts[cuts]))} · pictures ${pace}`;   // the one place that counts in pictures
      if (info.parentNode) info.parentNode.title = info.textContent;              // the whole line on hover, when it is cut short
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
    // ---- the timeline: the whole film in time, from the same timeline the player and the export use ----
    // Lanes: a tick per picture cut (click to jump), the speed (the music's cut length on a log scale, 50 ms at the top: higher is faster;
    // the tempo before any change; one change at most, its Start and End dragged anywhere, its curve shaped by the handle), the music's
    // cuts as blue dots, a seconds ruler (click to jump). Only the line itself takes a click in the speed lane, so a jump never edits.
    const SPEED_GRID = [100, 250, 500, 1000];                               // ms (600, 240, 120 and 60 BPM)
    const yOfMs = ms => ((Math.log(clampMs(ms)) - Math.log(MS_RANGE[0])) / (Math.log(MS_RANGE[1]) - Math.log(MS_RANGE[0]))) * 100;
    const msOfY = pct => Math.exp(Math.log(MS_RANGE[0]) + Math.max(0, Math.min(1, pct / 100)) * (Math.log(MS_RANGE[1]) - Math.log(MS_RANGE[0])));
    let rsSel = null;                                                        // the selected point: 'start', 'end' or null
    let rsDrag = null, curvePinX = null;   // curvePinX: where across the lane (0-1) the curve handle was grabbed, while it is dragged                                                       // what is being dragged: 'start', 'end', 'curve' or null
    function rhythmStripModel(n) {
      if (!n) return null;
      const r = rhythmFor(n), pic = r.pic, base = r.base, nBase = r.nBase, nMusic = r.nMusic, total = pic[pic.length - 1];
      const X = f => Math.min(1000, (f / total) * 1000);
      const lens = pic.slice(1).map((v, i) => v - pic[i]);
      const bpm = bpmValue(), ch = changeParams(), mult = parseFloat(document.getElementById('multSelect').value) || 1;
      const tAt = share => { const x = Math.max(0, Math.min(1, share)) * nMusic, i = Math.min(nBase - 1, Math.floor(x)); return Math.min(total, base[i] + (x - i) * (base[i + 1] - base[i])); };
      const curve = [];                                                     // the speed itself, through the points (the ticks show where the cuts fall)
      for (let k = 0; k <= 200; k++) { const share = k / 200; curve.push([X(tAt(share)), yOfMs(msAtShare(share, bpm, ch))]); }
      const picMs = ms => Math.round(Math.max(1000 / 30, ms / mult));       // what the picture does: with a Multiple, its cuts are shorter
      let points = [], band = null, handle = null, linear = null;
      if (ch) {
        const s0 = 60000 / bpm, xs = X(tAt(ch.from)), xe = X(tAt(ch.to)), mid = ch.from + (ch.to - ch.from) / 2;
        points = [
          { id: 'start', name: 'Start', x: xs, y: yOfMs(s0), ms: Math.round(s0), pic: picMs(s0), sec: tAt(ch.from) / 30 },
          { id: 'end', name: 'End', x: xe, y: yOfMs(ch.end_ms), ms: ch.end_ms, pic: picMs(ch.end_ms), sec: tAt(ch.to) / 30 },
        ];
        band = { left: xs / 10, width: Math.max(0, xe - xs) / 10 };
        const ht = rsDrag === 'curve' && curvePinX != null ? curvePinX * total : (tAt(ch.from) + tAt(ch.to)) / 2;   // the change's visual middle; while shaped, where it was grabbed
        handle = { x: X(ht), y: yOfMs(msAtFrame(ht, nBase, nMusic, bpm, ch, base)), curve: ch.curve, t: ht };
        linear = [xs, points[0].y, xe, points[1].y];
      }
      const beats = r.audio.slice(0, -1).map(t => X(t * 30)).filter(x => x < 1000).slice(0, 2000);
      const sec = total / 30, step = sec <= 3 ? 0.5 : sec <= 8 ? 1 : sec <= 20 ? 2 : sec <= 60 ? 5 : 10;
      const axis = [];
      for (let t = 0; t <= sec + 1e-6; t += step) axis.push({ left: (t / sec) * 100, text: `${+t.toFixed(1)} s` });
      return { total, ticks: pic.slice(0, -1).map(X), curve, points, band, handle, linear, beats, axis, mult, flatY: yOfMs(60000 / bpm), oneFrame: Math.min(...lens) <= 1.0001, tAt, base, nBase, nMusic };
    }
    let rsModel = null;
    function renderRhythmStrip() {
      const m = rsModel = rhythmStripModel(activePlates().length);
      const el = id => document.getElementById(id);
      el('rhythmStrip').hidden = !m;
      if (!m) return;
      const f = x => x.toFixed(1);
      el('rsTicks').setAttribute('d', m.ticks.map(x => `M${f(x)} 4V22`).join(''));
      const pts = m.curve.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
      el('rsCurve').setAttribute('points', pts);
      el('rsArea').setAttribute('points', `0,100 ${pts} 1000,100`);
      el('rsBeats').setAttribute('d', m.beats.map(x => `M${f(x)} 7h0.01`).join(''));
      if (!el('rsGridLines').childElementCount) {                            // the grid never changes: drawn once
        el('rsGridLines').innerHTML = SPEED_GRID.map((ms, i) => `<i style="top:${yOfMs(ms)}%"></i><span style="top:${yOfMs(ms)}%">${Math.round(60000 / ms)}${i ? '' : ' BPM'}</span>`).join('');
        el('rsMsLabels').innerHTML = '<b>Speed</b>' + SPEED_GRID.map(ms => `<i style="top:${yOfMs(ms)}%">${ms} ms</i>`).join('');
      }
      el('rsBand').hidden = !m.band;
      if (m.band) { el('rsBand').style.left = `${m.band.left}%`; el('rsBand').style.width = `${m.band.width}%`; }
      for (const [id, lab, k] of [['rsStart', 'rsStartL', 0], ['rsEnd', 'rsEndL', 1]]) {
        const p = m.points[k], dot = el(id), l = el(lab);
        dot.hidden = l.hidden = !p;
        if (!p) continue;
        dot.style.left = l.style.left = `${p.x / 10}%`;
        dot.style.top = l.style.top = `${p.y}%`;
        dot.classList.toggle('sel', rsSel === p.id);
        l.textContent = `${p.name} ${p.ms} ms`;                              // the music's cut only: the picture's (with a Multiple) was noise here
        l.className = `rs-plabel${(k === 1 ? p.x > 700 : p.x > 850) ? ' left' : ''}${p.y < 30 ? ' below' : ''}`;
        l.hidden = rsDrag === p.id;                                            // the tooltip says it while dragging
      }
      const selP = m.points.find(p => p.id === rsSel);
      el('rsRemove').hidden = !selP || !!rsDrag;
      if (selP) { el('rsRemove').style.left = `clamp(10px, ${selP.x / 10}%, calc(100% - 10px))`; el('rsRemove').style.top = `${selP.y}%`; el('rsRemove').classList.toggle('below', selP.y < 40); }   // above the point (below near the top): never off the end
      el('rsCurveHandle').hidden = !m.handle;
      if (m.handle) { el('rsCurveHandle').style.left = `${m.handle.x / 10}%`; el('rsCurveHandle').style.top = `${m.handle.y}%`; el('rsCurveHandle').classList.toggle('dragging', rsDrag === 'curve'); }
      const lin = el('rsLinear');
      lin.toggleAttribute('hidden', !(m.linear && rsDrag === 'curve'));         // an SVG element: the attribute, it has no .hidden
      if (m.linear) { lin.setAttribute('x1', f(m.linear[0])); lin.setAttribute('y1', f(m.linear[1])); lin.setAttribute('x2', f(m.linear[2])); lin.setAttribute('y2', f(m.linear[3])); }
      el('rsAxis').innerHTML = m.axis.map((a, i) => `<span style="left:${a.left}%"${i === 0 ? ' class="first"' : ''}>${a.text}</span>`).join('');
      el('rsFast').textContent = m.oneFrame ? 'fastest cut = 1 frame at 30 fps' : '';
      showDragTip();
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
    // a time on the timeline (0..1 of the film) as a share of the music's cuts: where a point dropped there sits
    function shareAt(u) {
      const m = rsModel;
      if (!m) return 0;
      const t = Math.max(0, Math.min(1, u)) * m.total, b = m.base;
      let lo = 0, hi = m.nBase - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid] <= t) lo = mid; else hi = mid - 1; }
      return Math.min(1, (lo + Math.min(1, (t - b[lo]) / Math.max(1e-9, b[lo + 1] - b[lo]))) / m.nMusic);
    }
    const laneBox = () => document.getElementById('rsSpeed').getBoundingClientRect();
    // the speed lane: near the line (no change yet) a click adds one; anywhere else a click only clears the selection
    let rsHoverU = null;
    function rsLaneMove(e) {
      if (rsDrag || !rsModel) return;
      const b = laneBox(), u = (e.clientX - b.left) / b.width, yPx = e.clientY - b.top;
      const near = !changeParams() && u >= 0 && u <= 1 && Math.abs(yPx - (rsModel.flatY / 100) * b.height) < 10;
      rsHoverU = near ? u : null;
      const hv = document.getElementById('rsHover');
      hv.hidden = !near;
      document.getElementById('rsSpeed').classList.toggle('can-add', near);
      if (!near) return;
      const x = `${u * 100}%`, y = `${rsModel.flatY}%`;
      hv.querySelector('i').style.left = x;
      const dot = hv.querySelector('.rs-hover-dot'), tip = hv.querySelector('.rs-hover-tip');
      dot.style.left = tip.style.left = x; dot.style.top = tip.style.top = y;
      tip.classList.toggle('above', rsModel.flatY > 50);
    }
    function rsLaneLeave() { if (rsDrag) return; rsHoverU = null; document.getElementById('rsHover').hidden = true; document.getElementById('rsSpeed').classList.remove('can-add'); }
    function rsLaneClick(e) {
      if (dragJustEnded || e.target.closest('.rs-point, .rs-curve, .rs-x')) return;   // the click that ends a drag is not a click
      if (rsHoverU !== null && !changeParams()) { addChange(shareAt(rsHoverU)); rsLaneLeave(); return; }
      if (rsSel) { rsSel = null; renderRhythmStrip(); }
    }
    function addChange(share) {
      const from = Math.max(0, Math.min(0.85, share)), start = 60000 / bpmValue();
      setv('rhythmSelect', 'variable'); setv('changeFrom', +from.toFixed(4)); setv('changeTo', +Math.min(1, from + 0.22).toFixed(4));
      setv('endMsRange', Math.round(clampMs(start * 2))); setv('curveVal', 0.3);
      rsSel = 'end';
      updateRhythm();
      commitSettings('Add a change of speed');
    }
    function removeChange(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      if (!changeParams()) return;
      setv('rhythmSelect', 'flat');
      rsSel = null;
      updateRhythm();
      commitSettings('Remove the change of speed');
    }
    // dragging a point: sideways sets where it sits, up or down its speed (Start's speed is the tempo); the curve handle: up or down
    let dragJustEnded = false;
    function rsPointDown(which, e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      rsDrag = which; rsSel = which === 'curve' ? rsSel : which; rsLaneLeave();
      curvePinX = which === 'curve' && rsModel && rsModel.handle ? rsModel.handle.x / 1000 : null;   // the handle stays at this spot while it is dragged
      if (e.currentTarget.setPointerCapture && e.pointerId !== undefined) e.currentTarget.setPointerCapture(e.pointerId);
      renderRhythmStrip();
    }
    function rsPointMove(e) {
      if (!rsDrag) return;
      const b = laneBox(), u = (e.clientX - b.left) / b.width, pct = ((e.clientY - b.top) / b.height) * 100;
      const ch = changeParams();
      if (!ch) return;
      if (rsDrag === 'curve') {
        // the curve that passes through the pointer where the handle was grabbed: bending it changes how long each cut lasts (the film
        // gets longer or shorter, the lane rescales), so it is solved at that spot of the lane (the handle used to slide from under the pointer)
        const bpm = bpmValue(), s0 = Math.log(60000 / bpm), s1 = Math.log(ch.end_ms), m = rsModel;
        if (Math.abs(s1 - s0) < 1e-6 || !m || curvePinX == null) return;
        const want = Math.abs(Math.log(msOfY(pct)) - s0);                      // how far from the Start's speed, at that spot
        const away = c => {                                                    // falls as the change waits more
          const cc = { ...ch, curve: c }, base = baseStarts(m.nBase, bpm, cc, m.nMusic);
          return Math.abs(Math.log(msAtFrame(curvePinX * base[m.nBase], m.nBase, m.nMusic, bpm, cc, base)) - s0);
        };
        let lo = 0, hi = 1;
        if (want >= away(0)) hi = 0; else if (want <= away(1)) lo = 1;
        else for (let k = 0; k < 18; k++) { const c = (lo + hi) / 2; if (away(c) > want) lo = c; else hi = c; }
        setv('curveVal', +((lo + hi) / 2).toFixed(3));
      } else {
        const share = shareAt(u), ms = Math.round(clampMs(msOfY(pct)));
        if (rsDrag === 'start') { setv('changeFrom', +Math.max(0, Math.min(ch.to - 0.02, share)).toFixed(4)); setv('bpmInput', Math.round(Math.min(BPM_RANGE[1], Math.max(BPM_RANGE[0], 60000 / ms)))); }
        else { setv('changeTo', +Math.min(1, Math.max(ch.from + 0.02, share)).toFixed(4)); setv('endMsRange', ms); }
      }
      updateRhythm();
    }
    function rsPointUp() {
      if (!rsDrag) return;
      const what = rsDrag;
      rsDrag = null; curvePinX = null; dragJustEnded = true; setTimeout(() => { dragJustEnded = false; }, 0);
      renderRhythmStrip();
      commitSettings(what === 'curve' ? 'the curve of the change' : `the change's ${what === 'start' ? 'Start' : 'End'}`);
    }
    function showDragTip() {
      const tip = document.getElementById('rsTip'), g = document.getElementById('rsGuides'), m = rsModel;
      const p = m && rsDrag && rsDrag !== 'curve' ? m.points.find(q => q.id === rsDrag) : null;
      const h = m && rsDrag === 'curve' ? m.handle : null;
      tip.hidden = !(p || h); g.hidden = !p;
      if (p) {
        tip.innerHTML = `<b>${p.name} · ${p.sec.toFixed(1)} s</b><span>${p.ms} ms · ${Math.round(60000 / p.ms)} BPM</span>${m.mult !== 1 ? `<span class="pic">pictures ${p.pic} ms</span>` : ''}`;
        tip.style.left = `${p.x / 10}%`; tip.style.top = `${p.y}%`; tip.classList.toggle('left', p.x > 700);
        g.querySelector('.gx').style.cssText = `top:${p.y}%;width:${p.x / 10}%`;
        g.querySelector('.gy').style.cssText = `left:${p.x / 10}%;top:${p.y}%`;
      } else if (h) {
        tip.innerHTML = `<b>Curve · ${h.curve < 0.01 ? 'even' : `${Math.round(h.curve * 100)}%`}</b>`;
        tip.style.left = `${h.x / 10}%`; tip.style.top = `${h.y}%`; tip.classList.toggle('left', h.x > 700);
      }
    }
    (() => {
      const lane = document.getElementById('rsSpeed');
      if (!lane || !lane.addEventListener) return;
      lane.addEventListener('pointermove', rsLaneMove);
      lane.addEventListener('pointerleave', rsLaneLeave);
      lane.addEventListener('click', rsLaneClick);
      for (const [id, which] of [['rsStart', 'start'], ['rsEnd', 'end'], ['rsCurveHandle', 'curve']]) {
        const d = document.getElementById(id);
        d.addEventListener('pointerdown', e => rsPointDown(which, e));
        d.addEventListener('pointermove', rsPointMove);
        d.addEventListener('pointerup', rsPointUp);
        d.addEventListener('pointercancel', rsPointUp);
        if (which !== 'curve') d.addEventListener('focus', () => { rsSel = which; renderRhythmStrip(); });
      }
    })();
    // a click on the cut ticks or the ruler puts the playhead there
    function rhythmStripClick(e) {
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
    // ---- the tempo and the Multiple: values you drag up or down (Shift: finer), double-click (or Enter) to type, arrows to step ----
    const VFIELDS = {
      tempoField: {
        label: 'Tempo',
        get: () => bpmValue(),
        drag: (v0, dy, fine) => v0 * Math.exp(-dy * (fine ? 0.0012 : 0.004)),
        step: (v, d, big) => v + d * (big ? 10 : 1),
        text: v => String(Math.round(v)),
        parse: t => { const ms = /ms\s*$/i.test(t), x = parseFloat(t.replace(',', '.')); return Number.isFinite(x) && x > 0 ? (ms ? 60000 / x : x) : null; },   // "441 ms" works too
        set: v => { setv('bpmInput', Math.round(Math.min(BPM_RANGE[1], Math.max(BPM_RANGE[0], v)))); updateTempo(); },
      },
      multField: {
        label: 'Multiple',
        values: () => [...document.getElementById('multSelect').options].map(o => o.value),
        get: () => document.getElementById('multSelect').value,
        set: v => { setv('multSelect', v); updateTempo(); },
        parse: t => { const x = t.replace(/[×x\s]/g, ''); const map = { '¼': 0.25, '½': 0.5, '1⅓': 4 / 3, '1/4': 0.25, '1/2': 0.5, '4/3': 4 / 3 }; const n = map[x] ?? parseFloat(x); return Number.isFinite(n) ? n : null; },
      },
    };
    function vfNearest(f, v) { const vals = f.values(); let best = 0; vals.forEach((x, i) => { if (Math.abs(+x - v) < Math.abs(+vals[best] - v)) best = i; }); return vals[best]; }
    function vfStep(id, d, big) {
      const f = VFIELDS[id];
      if (f.values) { const vals = f.values(), i = vals.indexOf(f.get()); f.set(vals[Math.max(0, Math.min(vals.length - 1, i + d))]); }
      else f.set(f.step(f.get(), d, big));
    }
    function vfType(el) {
      const f = VFIELDS[el.id], val = el.querySelector('.vf-val');
      if (el.classList.contains('typing')) return;
      el.classList.add('typing');
      const input = document.createElement('input');
      input.className = 'vf-input'; input.setAttribute('aria-label', f.label);
      input.value = f.values ? val.textContent.replace('×', '') : f.text(f.get());
      val.hidden = true; val.after(input); input.focus(); input.select();
      let done = false;
      const finish = ok => {
        if (done) return; done = true;
        const n = ok ? f.parse(input.value) : null;
        input.remove(); val.hidden = false; el.classList.remove('typing');
        if (n !== null) { f.set(f.values ? vfNearest(f, n) : n); commitSettings(f.label === 'Tempo' ? 'the tempo' : 'the Multiple'); }
        el.focus();
      };
      input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('pointerdown', e => e.stopPropagation());
    }
    (() => {
      for (const id of Object.keys(VFIELDS)) {
        const el = document.getElementById(id), f = VFIELDS[id];
        if (!el || !el.addEventListener) continue;
        let drag = null;
        el.addEventListener('pointerdown', e => {
          if (e.button !== 0 || el.classList.contains('typing')) return;
          e.preventDefault(); el.focus();
          drag = { y0: e.clientY, v0: f.values ? f.values().indexOf(f.get()) : f.get(), moved: false };
          if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
        });
        el.addEventListener('pointermove', e => {
          if (!drag) return;
          const dy = e.clientY - drag.y0;
          if (Math.abs(dy) < 2 && !drag.moved) return;
          drag.moved = true; el.classList.add('dragging');
          if (f.values) { const vals = f.values(); f.set(vals[Math.max(0, Math.min(vals.length - 1, drag.v0 + Math.round(-dy / (e.shiftKey ? 28 : 14))))]); }
          else f.set(f.drag(drag.v0, dy, e.shiftKey));
        });
        const up = () => { if (!drag) return; const moved = drag.moved; drag = null; el.classList.remove('dragging'); if (moved) commitSettings(f.label === 'Tempo' ? 'the tempo' : 'the Multiple'); };
        el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        el.addEventListener('dblclick', () => vfType(el));
        el.addEventListener('keydown', e => {
          if (el.classList.contains('typing')) return;
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); vfStep(id, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); }
          else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); vfType(el); }
        });
      }
    })();
    // ---- while the drone plays it is the player's clock ----
    const droneLive = new window.Drone.Live();
    droneLive.onRevived = () => { if (isPlaying) droneLive.seek(cutPos / 30); };   // WebKit stopped the sound and it came back: from where the picture is
    droneLive.onRenew = () => { if (isPlaying && musicOn()) startMusic(cutPos / 30); };   // back from the background: a fresh sound, from where the picture is
    // the sound's clock stopped (WebKit lost the output): a fresh sound first; stopped again soon after, a reload (the one cure seen
    // to work), which plays on from the same place (studioResume)
    let lastStallFix = 0;
    droneLive.onStall = () => {
      if (!isPlaying || !musicOn()) return;
      // never a reload while a job runs (a batch's images in flight, an export): a fresh sound again, and the reload waits
      if (Date.now() - lastStallFix > 20000 || isBusy()) { lastStallFix = Date.now(); droneLive.renew(); return; }
      try { sessionStorage.setItem('studioResume', JSON.stringify({ pos: cutPos, mode })); } catch (e) {}
      location.reload();
    };
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
    // Trail: after a cut the previous image lingers on top for 4 whole frames, fading (the preview and the export alike)
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
        glLook.ghost = { url: g.src, invert: paired && prev % 2 === 1 ? fx.invert : 'off', scale: s };
      }
      glLook.alpha = alpha;
      const o = alpha > 0 ? alpha.toFixed(3) : '0';
      if (o !== ghostOpacity) { ghostOpacity = o; g.style.opacity = o; }
    }
    function clearFx() {
      const img = document.getElementById('stageImg');
      img.style.transform = '';
      img.style.filter = '';
      document.getElementById('stageGhost').style.opacity = '0'; ghostOpacity = '0'; ghostCut = -1;
      glLook = { cur: { invert: 'off', scale: 1 }, ghost: null, alpha: 0 };
    }
    function applyFx(plan, fx) {
      const img = document.getElementById('stageImg');
      const s = zoomScale(fx.zoom, fx.amount, plan.p);
      img.style.transform = s > 1.0005 ? `scale(${s.toFixed(5)})` : '';
      img.style.filter = plan.inverted ? (fx.invert === 'mono' ? 'invert(1) grayscale(1)' : 'invert(1)') : '';
      glLook.cur = { invert: plan.inverted ? fx.invert : 'off', scale: s };
    }
    // ---- the picture on the GPU (render.js, the same renderer as the export): with WebGL2 the stage draws on #stageCanvas from the
    // look applyFx / drawTrail / clearFx set (the CSS above then only drives hidden images); without it, the CSS is what shows ----
    let glStage = null, glLook = { cur: { invert: 'off', scale: 1 }, ghost: null, alpha: 0 };
    function initGl() {
      const c = document.getElementById('stageCanvas');
      try { glStage = c && window.Render ? window.Render.create(c) : null; } catch (e) { glStage = null; }
      document.body.classList.toggle('gl', !!glStage);
      if (!glStage) return;
      for (const id of ['stageImg', 'stageGhost']) document.getElementById(id).addEventListener('load', () => paintGl());
      if (typeof ResizeObserver === 'function') new ResizeObserver(() => paintGl()).observe(c);
      document.addEventListener('fullscreenchange', () => paintGl());
    }
    const decoded = (url, el) => ready.get(url) || (el.getAttribute('src') && el.complete && el.naturalWidth ? el : null);   // a decoded image to upload, never one still arriving
    function paintGl() {
      if (!glStage) return;
      const c = glStage.canvas, img = document.getElementById('stageImg'), g = document.getElementById('stageGhost');
      const url = img.getAttribute('src'), src = url && decoded(url, img);
      if (!src) return;                                                     // its load event paints it
      const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      const h = Math.max(16, Math.min(1920, Math.round(Math.min(r.height, (r.width * 16) / 9) * dpr))), w = Math.round((h * 9) / 16);   // 9:16, the screen's pixels, at most the export's
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const gUrl = glLook.ghost && glLook.alpha > 0 ? g.getAttribute('src') : null, gSrc = gUrl && decoded(gUrl, g);
      glStage.draw({ cur: { key: url, img: src, ...glLook.cur }, ghost: gSrc ? { key: gUrl, img: gSrc, invert: glLook.ghost.invert, scale: glLook.ghost.scale, alpha: glLook.alpha } : null });
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
      paintGl();
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
      if (!isPlaying && !activePlates().length) return;                      // nothing to play: no film, no sound
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
    const PERSISTED = ['rhythmSelect', 'changeFrom', 'changeTo', 'endMsRange', 'curveVal', 'bpmInput', 'followCuts', 'multSelect', 'musicSelect', 'pulseRange', 'lowRange', 'powerRange', 'spaceRange', 'brightRange', 'widthRange', 'pitchRange', 'chordSelect', 'progSelect', 'progEverySelect', 'padRange', 'tapeRange',  'movementRange', 'echoRange', 'washRange', 'ringRange', 'shimmerRange', 'choirRange', 'industrialRange', 'subWaveSelect', 'padWaveSelect', 'hitTypeSelect', 'hitRange', 'hitOnSelect', 'arpRange', 'arpMoodSelect', 'arpStepsSelect', 'arpRateSelect', 'bassRange', 'bassPatternSelect', 'bassRateSelect', 'arrangeSelect', 'dynSelect', 'seedVal', 'soundGroupVal', 'characterSelect', 'thumbSizeVal', 'bpmLock', 'invertSelect', 'zoomSelect', 'zoomAmt', 'trailRange', 'batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput'];
    // Each project keeps its own film (rhythm, look, sound, Type, territory) on this computer (localStorage `studioFilm:<slug>`); the
    // rest is the same everywhere (`studioSettings`: card size, image model, batch size, the Sound tab). Opening a project brings its
    // film back; one never opened here (new, imported) gets a Random of its own instead of the last project's. The settings saved
    // before this was per project become those of the first project opened after it.
    const GLOBAL_SETTINGS = ['batchCountSelect', 'modelSelect', 'soundGroupVal', 'thumbSizeVal'];
    const FILM_SETTINGS = PERSISTED.filter(id => !GLOBAL_SETTINGS.includes(id));
    const filmKey = slug => `studioFilm:${slug}`;
    let filmSlug = null, legacyFilm = null;
    try { filmSlug = localStorage.getItem('studioProject') || null; } catch (e) {}
    function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
    function putSettings(saved, ids) {
      saved = migrateRhythm({ ...saved });
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el || saved[id] === undefined) return;
        if (el.type === 'checkbox') el.checked = saved[id] === true;
        else if ([...(el.options || [{ value: saved[id] }])].some(o => o.value === saved[id] || el.type === 'range')) el.value = saved[id];
      });
    }
    function restoreSettings() {
      try {
        const glob = readJson('studioSettings') || {};
        if (FILM_SETTINGS.some(id => id in glob)) legacyFilm = glob;      // saved before films were per project
        putSettings(glob, GLOBAL_SETTINGS);
        const film = (filmSlug && readJson(filmKey(filmSlug))) || legacyFilm;
        if (film) putSettings(film, FILM_SETTINGS);
        currentEdit = localStorage.getItem(editKey()) || null;
      } catch (e) {}
    }
    function saveSettings() {
      try {
        const out = {}, film = {};
        PERSISTED.forEach(id => { const el = document.getElementById(id); (GLOBAL_SETTINGS.includes(id) ? out : film)[id] = el.type === 'checkbox' ? el.checked : el.value; });
        if (filmSlug) localStorage.setItem(filmKey(filmSlug), JSON.stringify(film));
        else Object.assign(out, film);                                       // no project yet: kept with the rest, the first project opened takes them
        localStorage.setItem('studioSettings', JSON.stringify(out));
      } catch (e) {}
      settingsChanged();
      renderEditBar();
    }
    // the project the server has open: its film in the controls (only when it is another than the one they hold)
    function useProjectFilm(slug) {
      if (!slug || slug === filmSlug) return;
      filmSlug = slug;
      try { localStorage.setItem('studioProject', slug); currentEdit = localStorage.getItem(editKey()) || null; } catch (e) { currentEdit = null; }
      const saved = readJson(filmKey(slug));
      if (saved) {
        applyingHistory = true;
        try { putSettings(saved, FILM_SETTINGS); updateTempo(); updateRhythm(); updateFx(); updateMusic(); syncSegs(); syncSelects(); updateDirectionHint(); } finally { applyingHistory = false; }
      } else if (legacyFilm) {
        legacyFilm = null;                                                   // the settings from before: this project's now (they are in the controls)
      } else {
        randomAll();                                                         // never opened here: a film of its own
      }
      history.length = 0; future.length = 0; settled = settingsSnap(); showUndo();   // Undo never goes back into another project's film
      saveSettings();
      if (isPlaying) musicChanged();
    }

    // the timeline's two values: the tempo (BPM and its music cut in ms) and the Multiple
    function showRhythm() {
      const bpm = bpmValue(), sel = document.getElementById('multSelect');
      document.getElementById('tempoVal').textContent = `${Math.round(bpm)} BPM`;
      document.getElementById('tempoMs').textContent = `${Math.round(60000 / bpm)} ms`;
      const opt = [...(sel.options || [])].find(o => o.value === sel.value);
      document.getElementById('multVal').textContent = opt ? opt.textContent : `×${sel.value}`;
      document.getElementById('tempoField').setAttribute('aria-valuetext', `${Math.round(bpm)} BPM, ${Math.round(60000 / bpm)} ms a music cut`);
      document.getElementById('multField').setAttribute('aria-valuetext', `${opt ? opt.textContent : sel.value} picture cuts a music cut`);
    }
    // a change of speed added, moved or removed
    function updateRhythm() {
      showRhythm();
      saveSettings();
      restartLoop();
      musicChanged();
    }
    function updateTempo() {
      showRhythm();
      saveSettings();
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
        headers: forProject({'Content-Type': 'application/json'}),
        body: JSON.stringify({ filename, trashed })
      });
      await loadState();
      const p = plates.find(x => x.filename === filename);
      if (trashed && p) offerUndoTrash(p, where);
      if (!trashed && p) pushStep({ label: `Restore “${p.title}”`, undo: () => trashFile(filename), redo: async () => { await fetch('/api/trash', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify({ filename, trashed: false }) }); await loadState(); } });
    }


    function ensureKreaReady() {                                           // images need the Krea sign-in: without it, Settings opens on it
      if (kreaConnected) return true;
      openSettingsOn('kreaConnectBtn');
      setStatus('Connect Krea first: images are made with your Krea account\'s credits.');
      return false;
    }
    function ensureKimiReady() {
      const typedKey = document.getElementById('kimiKeyInput').value.trim();
      if (!kimiConfigured && !typedKey) {
        openSettingsOn('kimiKeyInput');
        setStatus('Add your Kimi API key first: Kimi writes the image ideas.');
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
        const opt = sel.selectedOptions[0];
        const eg = opt && opt.dataset.examples;                                   // the territory's own subjects: what typed here changes
        input.placeholder = `Optional: focus inside ${v}${eg ? `, e.g. ${eg}` : ''} (every image follows it)`;
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
          o.dataset.examples = (w.examples || []).join(', ');
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
      const done = prog.slots.filter(x => x === 'ok' || x === 'trash' || x === 'err' || x === 'blocked').length;
      const running = prog.slots.filter(x => x === 'run').length;
      const dots = prog.slots.map((st, i) => `<i class="slot ${st}" title="${escapeHtml((prog.titles[i] || '') + (prog.why && prog.why[i] ? ' — ' + prog.why[i] : ''))}"></i>`).join('');
      const bar = prog.stage === 'invent' ? '<span class="slots indeterminate"><i></i></span>' : `<span class="slots">${dots}</span>`;
      const count = prog.stage === 'invent' ? '' : `<b>${done}/${prog.total}</b>`;
      el.innerHTML = `<div class="prog">
        <span class="prog-world">${escapeHtml(prog.world || 'New batch')}</span>${bar}${count}
        <span class="prog-note"${prog.summary && prog.detail ? ` title="${escapeHtml(prog.detail)}"` : ''}>${escapeHtml(prog.summary || prog.note)}</span>
        ${(prog.actions || []).map((x, i) => `<button type="button" class="small-btn prog-act" data-act="${i}">${escapeHtml(x.label)}</button>`).join('')}
        ${prog.timer ? `<span class="prog-time">${fmtElapsed(Date.now() - prog.t0)}${running ? ` · ${running} ${prog.world === 'AI order' ? 'working' : 'rendering'}` : ''}</span>` : ''}
      </div>`;
    }
    function progStart(count) {
      prog.t0 = Date.now(); prog.slots = []; prog.titles = []; prog.why = []; prog.world = ''; prog.stage = 'invent';
      prog.total = count; prog.summary = ''; prog.detail = ''; prog.note = `Choosing a territory and writing ${count} scenes…`;
      document.getElementById('statusText').dataset.idle = '';
      clearInterval(prog.timer); prog.timer = setInterval(progRender, 1000); progRender();
    }
    document.addEventListener('click', e => {                                 // the status bar's own buttons (Stop, Retry, Resume, Discard)
      const b = e.target.closest && e.target.closest('.prog-act');
      if (b && prog.actions && prog.actions[+b.dataset.act]) prog.actions[+b.dataset.act].run();
    });
    function progStop(summary) { clearInterval(prog.timer); prog.timer = null; prog.summary = summary; progRender(); }
    // Two busy states keep the app consistent:
    //  - generating images: new images may arrive, so the AI cannot order yet
    //  - the AI ordering: it works from a snapshot of the selection, so nothing may change the selection until it is done
    let generating = false;
    let aiRunning = false;
    // while a batch or an export runs, the server holds it as busy for the whole job, gaps included (no project switch from another
    // window or the Mac menu, no dev restart between two images); renewed every 10 s, it lapses by itself if the page goes away
    let leased = false;
    function syncLease() {
      const on = generating || exporting;
      if (!on && !leased) return;
      leased = on;
      fetch('/api/busy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ for: on ? 30 : 0 }) }).catch(() => {});
    }
    setInterval(() => { if (generating || exporting) syncLease(); }, 10000);
    let toldBusy = null;                                                     // null: the first look always tells the app (a reload mid-job left it thinking a job runs)
    function applyLocks() {
      syncLease();
      const T = window.__TAURI__;                                            // (not TAURI: declared further down, and this runs early)
      if (T && T.event && isBusy() !== toldBusy) { toldBusy = isBusy(); T.event.emit('page-busy', toldBusy).catch(() => {}); }   // the Mac app asks before quitting mid-job
      const lockGen = generating || aiRunning;
      ['worldSelect', 'directionInput', 'batchCountSelect', 'modelSelect', 'generateBtn'].forEach(id => { document.getElementById(id).disabled = lockGen; });
      syncAiBtn();
      document.getElementById('exportBtn').disabled = aiRunning || !activePlates().length;
      ['trashSelAll', 'trashEmpty'].forEach(id => { document.getElementById(id).disabled = aiRunning || exporting; });
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

    // ---- a batch of images: Kimi's scenes, made 3 at a time. Built to survive the real world:
    //  - the connection or Krea is lost: the batch pauses ("Connection lost: waiting…") and carries on by itself when it is back
    //  - no Krea credits: it stops (nothing else would work)
    //  - an image fails on its own: the rest carry on; at the end "Retry N" makes them again, with the same scenes (no Kimi)
    //  - Stop, a reload, a quit or a crash: what was not made is kept on this computer (studioPending:<slug>), and the status bar
    //    offers "N images weren't made · Resume · Discard" the next time
    let batchStop = false, pausedWait = null, stopWake = () => {};
    const pendingKey = () => `studioPending:${filmSlug || ''}`;
    function savePending(items, model) {
      try { if (items.length) localStorage.setItem(pendingKey(), JSON.stringify({ items, model, at: Date.now() })); else localStorage.removeItem(pendingKey()); } catch (e) {}
    }
    function readPending() { try { const p = JSON.parse(localStorage.getItem(pendingKey()) || 'null'); return p && Array.isArray(p.items) && p.items.length ? p : null; } catch (e) { return null; } }
    const pause = ms => (ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
    let NET_POLL_MS = 5000;
    function waitForConnection() {                                          // one wait shared by the three workers
      if (!pausedWait) pausedWait = (async () => {
        prog.note = 'Connection lost: waiting to carry on…'; progRender();
        while (!batchStop) {
          await Promise.race([pause(NET_POLL_MS), new Promise(r => { stopWake = r; })]);   // Stop does not wait out the pause
          try { if ((await (await fetch('/api/net', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).online) break; } catch (e) {}
        }
        prog.note = batchStop ? 'Stopping…' : 'Back online: carrying on'; progRender();
      })().finally(() => { pausedWait = null; });
      return pausedWait;
    }
    function batchActions(list) { prog.actions = list; progRender(); }
    async function runBatch(ideas, model) {
      batchStop = false;
      let added = 0, trashedByQa = 0, authFailed = false, creditsOut = false;
      const failedItems = [], left = new Map(ideas.map((it, i) => [i, it]));
      prog.stage = 'render';
      prog.total = ideas.length;
      prog.world = (ideas[0] && ideas[0].world) || '';
      prog.slots = ideas.map(() => 'wait');
      prog.titles = ideas.map(i => i.title);
      prog.why = ideas.map(() => '');
      prog.note = `${formatModelShort(model)} · 3 at a time`;
      const keep = () => savePending([...failedItems, ...left.values()], model);
      keep();
      batchActions([{ label: 'Stop', run: () => { batchStop = true; stopWake(); prog.note = 'Stopping after the images in progress…'; batchActions([]); } }]);
      const runOne = async (item, idx) => {
        if (authFailed || creditsOut || batchStop) { prog.slots[idx] = 'wait'; return; }
        let genData, rounds = 0;
        for (;;) {
          prog.slots[idx] = 'run';
          prog.note = `Rendering “${item.title}”`;
          progRender();
          try {
            const genRes = await fetch('/api/generate-image', {
              method: 'POST',
              headers: forProject({'Content-Type': 'application/json'}),
              body: JSON.stringify({ title: item.title, prompt: item.prompt, guide: item.guide || 'dark', world: item.world, idea: item.idea, model })
            });
            genData = await genRes.json();
          } catch (e) {
            genData = { ok: false, offline: true, error: 'The app did not answer' };   // the page lost its own server, or the network
          }
          if (!genData.offline || genData.project_changed) break;
          // Krea answers the connection check but this image keeps failing as if offline (a gateway error, a timeout): after 3
          // rounds it fails on its own (Retry covers it) instead of being sent again until Stop, a new paid job each time
          if (++rounds >= 3) { genData = { ...genData, offline: false, error: `Krea kept failing (${genData.error || 'no answer'}): Retry later` }; break; }
          prog.slots[idx] = 'wait';
          await waitForConnection();
          if (batchStop) return;
        }
        if (genData.project_changed) { batchStop = true; prog.slots[idx] = 'wait'; return; }
        if (genData.needs_auth) { authFailed = true; prog.slots[idx] = 'err'; prog.why[idx] = 'Krea login needed: Settings › Connect Krea'; return; }
        if (!genData.ok) {
          // a moderation refusal is not a failure to retry: nothing was made (and nothing goes to the Trash), its bar is grey
          prog.slots[idx] = genData.code === 'content_policy' ? 'blocked' : 'err'; prog.why[idx] = genData.error || 'Generation failed';
          if (genData.stop) creditsOut = true;
          left.delete(idx);
          if (genData.retryable !== false) failedItems.push(item);
          keep();
          return;
        }
        left.delete(idx); keep();
        if (genData.qa_passed) {
          added++;
          prog.slots[idx] = 'ok';
          prog.note = `Added “${item.title}”`;
        } else {
          trashedByQa++;
          prog.slots[idx] = 'trash';
          if (genData.qa_issues && genData.qa_issues.length) prog.why[idx] = `Logo check: ${genData.qa_issues[0]}`;
          prog.note = `“${item.title}” failed the logo check → Trash`;
        }
        progRender();
        await loadState();
      };
      const queue = ideas.map((item, idx) => [item, idx]);                  // 3 in parallel
      await Promise.all([0, 1, 2].map(async () => {
        while (queue.length) {
          const [item, idx] = queue.shift();
          try { await runOne(item, idx); } catch (e) { prog.slots[idx] = 'err'; prog.why[idx] = e.message; left.delete(idx); failedItems.push(item); keep(); }
        }
      }));
      loadWorlds();
      // the summary stays one short line (the status bar is one line): counts only; each bar's hover gives its image's reason,
      // the summary's own hover the reasons together
      const failed = prog.slots.filter(x => x === 'err').length, blocked = prog.slots.filter(x => x === 'blocked').length, notMade = left.size;
      const parts = [`${added} added`];
      if (trashedByQa) parts.push(`${trashedByQa} to Trash by the logo check`);
      if (blocked) parts.push(`${blocked} refused by Krea's moderation`);
      if (failed) parts.push(`${failed} failed`);
      if (authFailed) parts.push('sign in to Krea: Settings › Connect Krea');
      if (creditsOut) parts.push('Krea is out of credits: add some at krea.ai, then Retry');
      if (notMade) parts.push(`${notMade} not made`);
      prog.detail = prog.titles.map((t, i) => (prog.why[i] ? `${t}: ${prog.why[i]}` : '')).filter(Boolean).join('\n');
      progStop(`${batchStop && notMade ? 'Stopped' : 'Done'} · ${parts.join(' · ')}`);
      const again = [...failedItems, ...left.values()];
      batchActions(again.length ? [
        { label: `Retry ${again.length}`, run: () => retryBatch(again, model) },
        { label: 'Discard', run: () => { savePending([], model); batchActions([]); } },
      ] : []);
    }
    async function retryBatch(items, model) {
      if (isBusy()) { setStatus('Wait until the running job ends.'); return; }
      const made = new Set(plates.map(p => p.title));                       // made meanwhile (a reload let one finish on the server): not again
      items = items.filter(it => !made.has(it.title));
      if (!items.length) { savePending([], model); batchActions([]); setStatus('Those images were made after all.'); return; }
      if (!ensureKreaReady()) return;
      setGenerating(true);
      progStart(items.length);
      try { await runBatch(items, model); } catch (e) { progStop(`Error: ${e.message}`); } finally { setGenerating(false); }
    }
    // opening the page: a batch left unfinished (Stop, a reload, a quit, a crash) is offered again
    function offerPending() {
      const p = readPending();
      if (!p || generating) return;
      const made = new Set(plates.map(x => x.title));
      const items = p.items.filter(it => !made.has(it.title));
      if (!items.length) { savePending([], p.model); return; }
      document.getElementById('statusText').dataset.idle = '';
      prog.stage = 'render'; prog.world = items[0].world || 'Unfinished batch'; prog.slots = items.map(() => 'wait'); prog.titles = items.map(i => i.title); prog.why = items.map(() => '');
      prog.total = items.length; prog.summary = `${items.length} image${items.length === 1 ? '' : 's'} of the last batch ${items.length === 1 ? 'wasn\'t' : 'weren\'t'} made`;
      batchActions([
        { label: 'Resume', run: () => retryBatch(items, p.model) },
        { label: 'Discard', run: () => { savePending([], p.model); batchActions([]); prog.summary = ''; document.getElementById('statusText').dataset.idle = '1'; refreshIdle(); } },
      ]);
    }
    async function generateImages() {
      if (blockedByAi()) return;
      if (!project) { setStatus('Make a project or import one first: the project menu, at the top.'); openProjectMenu(); return; }
      if (!ensureKimiReady() || !ensureKreaReady()) return;

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
          headers: forProject({'Content-Type': 'application/json'}),
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

        ran = true;
        await runBatch(invData.ideas, model);
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

    // Krea: sign in from here (MCP OAuth). The sign-in page opens in a new tab; Krea sends it back to the app, and the page
    // learns it is connected from the state it polls
    async function reconnectKrea() {
      const tab = TAURI ? null : window.open('', '_blank');                      // opened now, on the click: a popup blocker lets it through (the app opens the browser)
      try {
        const r = await (await fetch('/api/krea-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        if (!r.ok) throw new Error(r.error || 'Krea did not answer');
        if (TAURI) await TAURI.opener.openUrl(r.url);                            // the Mac app: Krea's sign-in in the usual browser, it comes back here
        else if (tab) tab.location.href = r.url; else location.href = r.url;
        setStatus('Sign in to Krea in the new tab, then come back here.');
        const until = Date.now() + 5 * 60 * 1000;
        const check = async () => { await loadState(); if (!kreaConnected && Date.now() < until) setTimeout(check, 3000); else if (kreaConnected) setStatus('Krea is connected.'); };
        setTimeout(check, 3000);
      } catch (e) {
        if (tab) tab.close();
        setStatus(`Could not start the Krea sign-in: ${(e && e.message) || e}`);   // the app's own errors are plain text, not Error
      }
    }
    // first run (or a missing sign-in): what is still needed before images can be made; hidden by hand once everything is there
    // ---- the Mac app: updates. On opening it asks GitHub for a newer version; one click installs it and restarts ----
    const TAURI = window.__TAURI__ || null;
    if (TAURI && document.body) document.body.classList.add('app');
    async function syncFullscreen() {                                       // full screen hides the window's buttons: the top bar takes back their room
      try { document.body.classList.toggle('fullscreen', await TAURI.window.getCurrentWindow().isFullscreen()); } catch (e) {}
    }
    if (TAURI && TAURI.window) {                                          // asked again once macOS's full-screen animation is over: during it the window still says full screen
      syncFullscreen();
      let fsTimer = 0;
      window.addEventListener('resize', () => { syncFullscreen(); clearTimeout(fsTimer); fsTimer = setTimeout(syncFullscreen, 800); });
    }
    let pendingUpdate = null;
    async function checkForUpdate() {
      if (!TAURI || !TAURI.updater || location.port === '5173') return;          // not while developing
      try {
        const u = await TAURI.updater.check();
        if (!u) return;
        pendingUpdate = u;
        document.getElementById('updateMsg').textContent = `Phosphene ${u.version} is ready.`;
        document.getElementById('updateBar').hidden = false;
      } catch (e) { /* offline, or GitHub unreachable: try again next time */ }
    }
    async function installUpdate() {
      if (!pendingUpdate) return;
      if (isBusy()) { setStatus('Wait until the running job ends, then update.'); return; }
      const btn = document.getElementById('updateBtn');
      btn.disabled = true; btn.textContent = 'Updating…';
      try { await pendingUpdate.downloadAndInstall(); await TAURI.process.relaunch(); }
      catch (e) { btn.disabled = false; btn.textContent = 'Restart to update'; setStatus(`The update did not install: ${e.message || e}`); }
    }
    setTimeout(checkForUpdate, 4000);
    async function signOutKrea() {
      await fetch('/api/krea-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
      await loadState();
      setStatus('Signed out of Krea on this computer.');
    }

    // The export's frames, rendered here by the stage's own renderer (render.js) at 1080 x 1920 from the full-size plates, frame by frame as
    // planAt plans them (frame f shows the clip at f + 0.5), and sent to the server, which only encodes them. A frame that is the same
    // as the one before (a plain cut held) is sent as a reference, not drawn again. Without WebGL2 there is no export (it says so).
    async function exportFrames(progress) {
      const canvas = document.createElement('canvas');
      canvas.width = 1080; canvas.height = 1920;
      const r = window.Render && window.Render.create(canvas, { keep: true, textures: 4 });
      if (!r) throw new Error('this browser cannot draw the frames (WebGL2 is off)');
      const active = activePlates(), fx = fxSettings(), tl = timelineFor(active.length), n = active.length;
      const paired = fx.invert === 'mono' || fx.invert === 'colour', nCuts = n * (paired ? 2 : 1);
      const total = Math.max(nCuts, Math.floor(tl[tl.length - 1] + 1e-9));     // every image once, never fewer frames than cuts
      const full = new Map();                                               // plate -> full-size image, the last few
      const load = async i => {
        const p = active[i];
        if (full.has(p.url)) return full.get(p.url);
        const im = await window.Render.loadImage(p.url);
        full.set(p.url, im); while (full.size > 4) full.delete(full.keys().next().value);
        return im;
      };
      const shown = cut => ({ plate: (paired ? Math.floor(cut / 2) : cut) % n, invert: paired && cut % 2 === 1 ? fx.invert : 'off' });
      const post = (query, body) => fetch(`/api/export-frame?${query}`, { method: 'POST', headers: forProject({ 'Content-Type': 'image/jpeg' }), body: body || '' })
        .then(res => res.json()).then(d => { if (!d.ok) throw new Error(d.error || 'a frame was not accepted'); });
      const inFlight = new Set();
      const track = async job => { inFlight.add(job); job.then(() => inFlight.delete(job), () => {}); if (inFlight.size >= 6) await Promise.race(inFlight); };
      let lastKey = '', lastSent = -1, lastJob = null, runFrom = -1;     // a run of frames the same as lastSent, sent as one request
      const flush = async upto => {
        if (runFrom < 0) return;
        const [k, a] = [lastSent, runFrom]; runFrom = -1;
        await track(lastJob.then(() => post(`i=${a}&same=${k}&to=${upto}`)));   // after the frame it points at has arrived
      };
      for (let f = 0; f < total; f++) {
        const plan = planAt(f + 0.5, n, fx.invert, tl), cur = shown(plan.cut);
        const scale = zoomScale(fx.zoom, fx.amount, plan.p), alpha = plan.cut > 0 ? trailAlpha(f + 0.5 - tl[plan.cut], fx.trail) : 0;
        const prev = alpha > 0 ? shown(plan.cut - 1) : null, prevScale = zoomScale(fx.zoom, fx.amount, 1);
        const key = JSON.stringify([cur, scale > 1.0005 ? scale : 1, prev, alpha]);
        if (key === lastKey && f > 0) { if (runFrom < 0) runFrom = f; continue; }
        await flush(f);
        const curImg = await load(cur.plate), prevImg = prev ? await load(prev.plate) : null;
        r.draw({ cur: { key: active[cur.plate].url, img: curImg, invert: cur.invert, scale }, ghost: prev ? { key: active[prev.plate].url, img: prevImg, invert: prev.invert, scale: prevScale, alpha } : null });
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
        const job = post(`i=${f}`, blob); lastKey = key; lastSent = f; lastJob = job;
        if (f === 0) await job;                                             // the first frame starts a new set on the server
        else await track(job);
        if (progress) progress(f, total);
      }
      await flush(total);
      await Promise.all(inFlight);
      r.forget();
      return total;
    }

    async function exportVideo() {
      if (blockedByAi()) return;
      if (exporting) return;
      exporting = true; applyLocks();
      const t0 = performance.now();
      setExportState('busy');
      setMusicState('busy', 'Exporting…');
      let ok = false;
      try {
        if (musicOn()) {                                   // the same WebAudio drone as the preview, rendered offline and sent along
          setMusicState('busy', 'Preparing the sound…');
          const wav = window.Drone.toWav(await window.Drone.renderExport(synthParams(), synthStartsSec()));
          const up = await fetch('/api/export-audio', { method: 'POST', headers: forProject({ 'Content-Type': 'application/octet-stream' }), body: wav });
          const sent = await up.json();
          if (!sent.ok) throw new Error(sent.error || 'the sound was not accepted');
        }
        const frames = await exportFrames((f, total) => setMusicState('busy', `Rendering frames ${f} / ${total}…`));
        setMusicState('busy', 'Encoding…');
        const res = await fetch('/api/export-video', {
          method: 'POST',
          headers: forProject({'Content-Type': 'application/json'}),
          body: JSON.stringify({
            bpm: bpmValue(),
            multiple: parseFloat(document.getElementById('multSelect').value),
            invert_mode: document.getElementById('invertSelect').value,
            rhythm: rhythmMode(),
            ...(changeParams() ? { end_ms: changeParams().end_ms } : {}),   // the change's end speed, for the file's name
            music: musicOn() ? 'synth' : 'off',
            zoom_mode: document.getElementById('zoomSelect').value,
            zoom_amount: parseFloat(document.getElementById('zoomAmt').value) || 0,
            trail: (parseFloat(document.getElementById('trailRange').value) || 0) / 100,
            frames,                                                          // drawn here: the server only encodes them
            ...(currentGroup === 'all' ? {} : { files: activePlates().map(p => p.filename) }),   // a group: just its images
            ...(editOf(currentEdit) ? { edit: editOf(currentEdit).name } : {}),   // the file is named after the edit
          })
        });
        const data = await res.json();
        if (data.ok) {
          const link = document.getElementById('downloadLink');
          link.href = data.video_url;
          link.setAttribute('download', data.filename || 'Demo.mp4');
          document.getElementById('exportFile').textContent = data.filename || 'MP4';
          link.click();                                                  // the file saves itself (to Downloads)
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
        exporting = false; applyLocks();
        setExportState(ok ? 'ready' : 'idle');
        // "Downloaded" for a moment, then the Export button again: any change (a setting, a snapshot, a project) makes another film,
        // not the same one "again" (the user found Export again / Download again confusing)
        if (ok) setTimeout(() => { if (document.getElementById('exportDock').dataset.state === 'ready') setExportState('idle'); }, EXPORT_DONE_MS);
      }
    }

    restoreSettings();
    initGl();
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
      offerPending();                                                        // a batch left unfinished last time: Resume or Discard
      if (TAURI && TAURI.event) TAURI.event.emit('page-ready').catch(() => {});   // the Mac app: files opened while the page was loading come now
      try {                                                                  // back from a reload that mended the sound: playing on, from there
        const resume = JSON.parse(sessionStorage.getItem('studioResume') || 'null');
        sessionStorage.removeItem('studioResume');
        if (resume && activePlates().length) { setMode(resume.mode || 'film'); cutPos = +resume.pos || 0; lastTick = performance.now(); if (!isPlaying) togglePlay(); }
      } catch (e) {}
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
  installUpdate,
  exportProject, importProject, importProjectPath, chooseProjectFile, closeProjectMenu, saveSettings, deleteProject,
  downloadShown,
  openProjectMenu, switchProject, openProjectForm, closeProjectForm, readProjectMark, drawProjectPreview, saveProject,
  removeChange,
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
  signOutKrea,
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
