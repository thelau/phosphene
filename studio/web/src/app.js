    let plates = [];
    let making = [];                                                         // titles the server is making now (/api/state)
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
    // what went wrong, in a few words: the status bar shows this, the full text stays in the log (npm run log, Settings › log)
    function plainError(raw) {
      const s = String((raw && raw.message) || raw || '');
      const who = /kimi|moonshot/i.test(s) ? 'Kimi' : /krea/i.test(s) ? 'Krea' : '';
      const it = who || 'The service';
      if (/did not answer/i.test(s)) return 'Phosphene\'s server did not answer: is it still running?';
      if (/timed out|timeout/i.test(s)) return `${it} took too long to answer: try again.`;
      if (/nodename nor servname|name or service not known|network is unreachable|could not be reached|urlopen error|failed to fetch|networkerror|load failed|connection (refused|reset|aborted)|no route to host|name resolution/i.test(s)) return 'No internet connection: check it, then try again.';
      if (/insufficient.?credits|out of credits/i.test(s)) return 'Krea is out of credits: add some at krea.ai.';
      if (/extra data|expecting value|unterminated string|invalid json|not valid json|could not parse/i.test(s)) return 'Kimi\'s answer could not be read: try again.';
      if (/content.?policy|moderation/i.test(s)) return 'Refused by Krea\'s moderation.';
      if (/\b401\b|unauthori[sz]ed|invalid.{0,12}key|incorrect api key/i.test(s)) return who === 'Krea' ? 'Krea needs you to sign in again: Settings › Connect Krea.' : 'Kimi refused the key: check it in Settings.';
      if (/\b429\b|rate.?limit|too many requests/i.test(s)) return `${it} is busy: try again in a minute.`;
      if (/\b5\d\d\b|bad gateway|service unavailable|overloaded/i.test(s)) return `${it} is having trouble: try again in a few minutes.`;
      const first = s.split(/ \| |\n/)[0];
      return first.length > 110 ? `${first.slice(0, 107)}…` : first;
    }
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
      making = data.making || [];
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

      const trashedCount = plates.filter(p => p.trashed).length;
      document.getElementById('trashCount').textContent = trashedCount;
      document.getElementById('selCount').textContent = plates.length - trashedCount;
      if (typeof drawInfo === 'function') drawInfo();
      refreshIdle();
      renderView();
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
        if (manual) setStatus(window.__TAURI__ ? 'Phosphene is restarting its engine. Try again in a moment.' : 'Could not reach the server. Is it running?');
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

    // the images in the edit: the shown ones (AI order's "best N" cut was removed on request: every image plays)
    function activePlates() { return inGroup(plates.filter(p => !p.trashed)); }

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
      for (const id of ['targetBtn', 'gridTargetBtn']) { const b = document.getElementById(id); if (!b.dataset.title) b.dataset.title = b.title; b.disabled = true; b.title = 'The mark target: make or import a project first'; }
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
      syncMarkSelect(p);
      const noMark = p.has_mark === false;                                    // a project of your own images, no mark yet
      document.body.classList.toggle('no-mark', noMark);
      img.hidden = noMark;
      for (const id of ['targetBtn', 'gridTargetBtn']) { const b = document.getElementById(id); if (!b.dataset.title) b.dataset.title = b.title; b.disabled = noMark; b.title = noMark ? 'This project has no mark yet' : b.dataset.title; }
      const centred = p.mark_x === 50 && p.mark_y === 50;
      document.getElementById('retLabel').textContent = `mark · ${centred ? 'centre' : `${p.mark_x}%, ${p.mark_y}%`} · ${p.mark_size}%`;
    }
    // a project with several marks: the generation row offers which one a batch uses (main, another, or a mix); a project with one: nothing
    function syncMarkSelect(p) {
      const sel = document.getElementById('markSelect'), marks = (p && p.marks) || [], cur = sel.value || 'main';
      document.body.classList.toggle('multi-mark', marks.length > 0);
      const opts = [['main', 'Main mark'], ...marks.map(m => [m.id, m.name]), ...(marks.length ? [['mix', 'Mix']] : [])];
      if (sel.options && [...sel.options].map(o => o.value).join('|') !== opts.map(o => o[0]).join('|')) {
        sel.innerHTML = opts.map(([v, t]) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`).join('');
      }
      sel.value = opts.some(o => o[0] === cur) ? cur : 'main';
      if (typeof renderPlace === 'function') renderPlace();
    }
    // the Mark menu: which of the project's marks (with several), where it goes, and Keep it as designed; one button, sections inside
    const POSITIONS = [['exact', 'On target', 'same spot and size in every image'], ['loose', 'Loose', 'a little off, a little bigger or smaller'], ['scattered', 'Scattered', 'anywhere, much bigger or smaller']];
    function markChoices() {
      const marks = (project && project.marks) || [];
      return marks.length ? [['main', 'Main mark', project.mark_url], ...marks.map(m => [m.id, m.name, m.url]), ['mix', 'Mix', null]] : [];
    }
    function renderPlace() {
      const t = document.getElementById('targetSelect').value || 'exact', mk = document.getElementById('markSelect').value || 'main';
      const keep = document.getElementById('keepCheck').checked, choices = markChoices(), mine = choices.find(c => c[0] === mk) || choices[0];
      const pos = (POSITIONS.find(p => p[0] === t) || POSITIONS[0])[1];
      const label = (c, p, k) => [c ? (c[0] === 'main' ? 'Main' : c[1]) : '', p, k ? 'As designed' : ''].filter(Boolean).join(' · ');
      const name = document.getElementById('placeName');
      name.textContent = label(mine, pos, keep);
      const thumb = document.getElementById('placeThumb'), mixIcon = document.getElementById('placeMix');
      thumb.hidden = !(mine && mine[2]);
      if (mine && mine[2] && thumb.getAttribute('src') !== mine[2]) { thumb.src = mine[2]; fitMarkTone(thumb); }   // as the top bar shows it: a dark mark as a light silhouette
      const pair = choices.filter(c => c[2]).slice(0, 2).map(c => c[2]);   // Mix shows two of your marks, as in its menu, so the button keeps its icon
      mixIcon.hidden = !(mine && !mine[2] && pair.length);
      if (!mixIcon.hidden && mixIcon.dataset.urls !== pair.join(' ')) {
        mixIcon.dataset.urls = pair.join(' ');
        mixIcon.innerHTML = pair.map(u => `<img class="pm-thumb" src="${escapeHtml(u)}" alt="" />`).join('');
        mixIcon.querySelectorAll('img').forEach(fitMarkTone);
      }
      name.style.minWidth = placeLabelWidth(name, (choices.length ? choices : [null]).flatMap(c => POSITIONS.flatMap(([, p]) => [label(c, p, false), label(c, p, true)]))) + 'px';   // as wide as its widest choice: the row never moves
      const m = document.getElementById('placeMenu');
      if (m.hidden) return;
      const check = '<svg class="tm-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>';
      const item = (list, v, inner, on) => `<div class="tm-item" role="menuitemradio" data-list="${list}" data-v="${escapeHtml(v)}" aria-selected="${on}" aria-checked="${on}">${inner}${check}</div>`;
      const img = url => `<img class="pm-thumb" src="${escapeHtml(url)}" alt="" />`;
      const mix = `<span class="pm-mix">${choices.filter(c => c[2]).slice(0, 2).map(c => img(c[2])).join('')}</span>`;
      m.innerHTML = (choices.length ? '<div class="tm-head"><span>Mark</span></div>' + choices.map(([v, name, url]) =>
          item('mark', v, `${url ? img(url) : mix}<span>${escapeHtml(name)}${v === 'mix' ? ' <span class="tm-sub">switches between your marks</span>' : ''}</span>`, v === mk)).join('') + '<div class="tm-sep"></div>' : '')
        + '<div class="tm-head"><span>Position</span></div>' + POSITIONS.map(([v, name, sub]) => item('position', v, `<span>${name} <span class="tm-sub">${sub}</span></span>`, v === t)).join('')
        + '<div class="tm-sep"></div>'
        + `<div class="tm-item pm-keep" role="menuitemcheckbox" data-list="keep" data-v="keep" aria-checked="${keep}"><span class="pm-box"></span><span>Keep it as designed <span class="tm-sub">same colours and lettering as your file</span></span></div>`;
      m.querySelectorAll('img.pm-thumb').forEach(fitMarkTone);
    }
    let placeCanvas = null;
    function placeLabelWidth(el, labels) {
      const cx = (placeCanvas || (placeCanvas = document.createElement('canvas'))).getContext && placeCanvas.getContext('2d');
      if (!cx) return 0;
      if (!placeCanvas.fontsAsked && document.fonts && document.fonts.ready) { placeCanvas.fontsAsked = true; document.fonts.ready.then(() => renderPlace()); }   // measured again in the bundled font once it has loaded
      cx.font = getComputedStyle(el).font || '600 14px sans-serif';
      return Math.min(300, Math.ceil(Math.max(0, ...labels.map(t => cx.measureText(t).width))));   // past 300 px (long mark names) it ends in …
    }
    function togglePlaceMenu(e, open) {
      if (e && e.stopPropagation) e.stopPropagation();
      const m = document.getElementById('placeMenu');
      open = open === undefined ? m.hidden : open;
      if (open && (generating || aiRunning)) return;
      m.hidden = !open;
      document.getElementById('placeBtn').setAttribute('aria-expanded', String(open));
      renderPlace();
    }
    function choosePlace(list, v) {
      if (list === 'keep') { const k = document.getElementById('keepCheck'); k.checked = !k.checked; }
      else setv(list === 'mark' ? 'markSelect' : 'targetSelect', v);
      saveSettings();
      renderPlace();                                                         // it stays open: a pick in each section
    }
    (() => {
      const m = document.getElementById('placeMenu');
      if (!m || !m.addEventListener) return;
      m.addEventListener('mousedown', e => e.preventDefault());
      m.addEventListener('click', e => { e.stopPropagation(); const it = e.target.closest('.tm-item'); if (it) choosePlace(it.dataset.list, it.dataset.v); });
      document.addEventListener('click', () => { if (!m.hidden) togglePlaceMenu(null, false); });
    })();
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
    // ---- the project form (New project…, Project settings…): the project (name, brand, colours) and its marks, every mark with the
    // same settings; a list on the left, one item's details in the middle, a 9:16 preview on the right. Nothing is saved until Save
    // (Cancel or Esc drops every change). A new project starts from its first mark: Kimi reads it and fills in the rest ----
    const PS_MAX = 9;
    let psTimer = 0, psSeq = 0;
    const psMark = key => projectForm && projectForm.marks.find(m => m.key === key);
    const psDefault = () => projectForm && (projectForm.marks.find(m => m.key === projectForm.def) || projectForm.marks[0]);
    function openProjectForm(kind) {
      closeProjectMenu();
      const edit = kind === 'edit' && project;
      if (isBusy()) { setStatus('Wait until the running job ends, then open the project settings.'); return; }   // also from the Mac menu (⌘N), which skips the greyed-out menu
      if (!edit && !kimiConfigured) {                                         // a new project starts from Kimi reading the mark: the key first
        openSettingsOn('kimiKeyInput');
        setStatus('Add your Kimi API key to create a project: Kimi reads your mark and fills in the project for you.');
        return;
      }
      const main = edit && project.has_mark !== false ? { key: 'main', id: 'main', name: project.mark_name || 'Main mark', size: project.mark_size, x: project.mark_x, y: project.mark_y,
        shape: project.mark_shape, noun: project.mark_noun, url: project.mark_url, ar: project.mark_ratio || 1, locked: !!project.fixed } : null;
      const extras = edit ? (project.marks || []).map(m => ({ key: m.id, id: m.id, name: m.name, size: m.size, x: m.x ?? project.mark_x, y: m.y ?? project.mark_y,
        shape: m.shape, noun: m.noun, url: m.url, ar: m.ratio || 1 })) : [];
      projectForm = { kind: edit ? 'edit' : 'new', name: edit ? project.name : '', brief: edit ? project.brief : '', palette: edit ? [...(project.palette || [])] : [],
        marks: main ? [main, ...extras] : [], def: main ? 'main' : null, sel: edit ? 'project' : null, fromKimi: false, typed: new Set(), noMark: !!(edit && !main) };
      document.getElementById('projectTitle').textContent = edit ? `${project.name} · Settings` : 'New project';
      document.getElementById('pfSave').textContent = edit ? 'Save' : 'Create project';
      document.getElementById('pfError').textContent = '';
      document.getElementById('projectModal').classList.add('open');
      renderPS();
    }
    function closeProjectForm() { clearInterval(psTimer); document.getElementById('projectModal').classList.remove('open'); projectForm = null; }   // also while Kimi reads: its answer is dropped
    function psReading() { return !!(projectForm && projectForm.marks.some(m => m.reading)); }
    function psFirstPending() { return projectForm.kind === 'new' && !projectForm.noMark && (!projectForm.marks.length || projectForm.marks[0].reading); }
    function renderPS() {
      if (!projectForm) return;
      const f = projectForm;
      document.getElementById('psSub').textContent = f.kind === 'new' && psFirstPending() ? 'Start with the main mark' : '';
      renderPSRail(); renderPSDetail(); renderPSPreview();
      psSyncSave();
    }
    function psSyncSave() {                                                   // Save / Create: once there is something to save
      const f = projectForm;
      if (f) document.getElementById('pfSave').disabled = psFirstPending() || psReading() || (f.kind === 'new' && f.noMark && !f.marks.length && !f.name.trim());
    }
    function psSecs(m) { return Math.round((Date.now() - m.readFrom) / 1000); }
    function renderPSRail() {
      const f = projectForm, pending = psFirstPending(), lock = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-label="Locked"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>';
      const swatches = f.palette.length ? `<span class="ps-swatches">${f.palette.map(c => `<i style="background:${escapeHtml(c)}"></i>`).join('')}</span>` : '';
      const projRow = `<button type="button" class="ps-row ps-proj${f.sel === 'project' ? ' on' : ''}" onclick="psSelect('project')"${pending ? ' disabled' : ''}>
          <b>${escapeHtml(f.name || (pending ? 'New project' : 'Untitled'))}</b>${pending ? '<span class="ps-wait">Filled in from the main mark</span>' : swatches}</button>`;
      const rows = f.marks.map(m => {
        const def = m.key === f.def, sub = m.reading ? `Kimi · ${psSecs(m)} s` : def ? `Default · ${+m.size}%` : `${+m.size}% · ${+m.x === 50 && +m.y === 50 ? 'centre' : `${+m.x} / ${+m.y}`}`;
        return `<button type="button" class="ps-row ps-mark${f.sel === m.key ? ' on' : ''}${m.reading ? ' reading' : ''}" onclick="psSelect(this.dataset.key)" data-key="${escapeHtml(m.key)}">
          <span class="ps-thumb"><img src="${escapeHtml(m.url)}" alt="" />${m.reading ? '<span class="spin"></span>' : ''}</span>
          <span class="ps-row-text"><b>${escapeHtml(m.reading ? 'Reading…' : m.name)}</b><small${m.reading ? ' class="kimi"' : ''}>${escapeHtml(sub)}</small></span>${m.locked ? lock : ''}</button>`;
      }).join('');
      document.getElementById('psRail').innerHTML = `<span class="ps-rail-head">Project</span>${projRow}<span class="ps-rail-head"><span>Marks</span><span>${f.marks.length || ''}</span></span>${rows}`
        + (!pending && f.marks.length < PS_MAX ? '<button type="button" class="ps-add" onclick="psPick(\'add\')">+ Add a mark</button>' : '');
    }
    function renderPSDetail() {
      const f = projectForm, d = document.getElementById('psDetail'), m = psMark(f.sel);
      if (f.kind === 'new' && !f.marks.length && !f.noMark) {                 // the first mark comes first (or none: your own images)
        d.innerHTML = `<div class="ps-drop" id="psDrop"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"></rect><circle cx="12" cy="12" r="3"></circle></svg>
          <b>Drop the main mark</b><span>PNG or SVG, ideally on a transparent background</span><button type="button" class="solid" onclick="psPick('new')">Choose file…</button>
          <button type="button" class="link-btn ps-nomark" onclick="psNoMark()">No mark, just my own images</button></div>`;
        const drop = document.getElementById('psDrop');
        if (drop && drop.addEventListener) {
          drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
          drop.addEventListener('dragleave', () => drop.classList.remove('over'));
          drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const file = e.dataTransfer && e.dataTransfer.files[0]; if (file) psFileChosen(file, 'new'); });
        }
        return;
      }
      if (f.sel === 'project') {
        const tag = t => f.fromKimi ? ` <span class="ps-tag">${t}</span>` : '';
        d.innerHTML = `<label class="ps-field"><span>Name</span><input type="text" id="psName" maxlength="60" value="${escapeHtml(f.name)}" oninput="psSetProject('name', this.value)" autocomplete="off" /></label>
          <label class="ps-field"><span>About${tag('From Kimi')}</span><input type="text" id="psBrief" maxlength="200" value="${escapeHtml(f.brief)}" oninput="psSetProject('brief', this.value)" placeholder="Who or what these films are for: a brand, a project, an event… e.g. Kestrel Air, the Hong Kong airline" autocomplete="off" /></label>
          <div class="ps-field"><span>Colours${tag('Suggested')}</span><div class="ps-colours">${f.palette.map((c, i) => `<span class="ps-chip"><i style="background:${escapeHtml(c)}"></i>${escapeHtml(c)}<button type="button" aria-label="Remove ${escapeHtml(c)}" onclick="psColour(${i})">×</button></span>`).join('')}
            <input type="text" id="psColourNew" class="ps-chip-add" maxlength="7" placeholder="+ #hex" aria-label="Add a colour" onkeydown="psColourKey(event, this)" onblur="psColourAdd(this)" autocomplete="off" /></div>
            <small>Kimi colours the scenes with these. Every mark shares them.</small></div>`;
        return;
      }
      if (!m) { d.innerHTML = ''; return; }
      if (m.reading) {
        const skel = (f.kind === 'new' && m === f.marks[0] ? ['Name', 'About', 'Its shape', 'Called'] : ['Name', 'Its shape', 'Called']);
        d.innerHTML = `<div class="ps-reading"><span class="ps-big-thumb"><img src="${escapeHtml(m.url)}" alt="The mark being read" /></span>
            <div><b><span class="spin"></span>Kimi is reading the mark <span class="ps-secs">${psSecs(m)} s</span></b>
            <span>${f.kind === 'new' && m === f.marks[0] ? 'It fills in the name, what it is about, the shape, the words and suggests colours.' : 'It fills in the name, the shape and the words. All stay editable.'}</span>
            <button type="button" class="link-btn" onclick="psCancelRead(this.dataset.key)" data-key="${escapeHtml(m.key)}">Cancel</button></div></div>`
          + skel.map(l => `<div class="ps-field"><span>${l}</span><i class="ps-skel"></i></div>`).join('');
        return;
      }
      const def = m.key === f.def, lockedAny = f.marks.some(x => x.locked), dis = m.locked ? ' disabled' : '';
      const slider = (label, key, min, max) => `<label class="ps-slider"><span>${label}</span><input type="range" min="${min}" max="${max}" step="0.5" value="${+m[key]}" oninput="psSetMark('${key}', +this.value)"${dis} /><b id="psv-${key}">${+m[key]}%</b></label>`;
      d.innerHTML = (m.locked ? `<div class="ps-locked"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>${escapeHtml(project ? project.name : '')}'s main mark is fixed: its image, size, place and words.</div>` : '')
        + `<div class="ps-mark-head"><div class="ps-big"><span class="ps-big-thumb"><img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.name)}" /></span>${m.locked ? '' : `<button type="button" class="link-btn" onclick="psPick('replace')">Replace…</button>`}</div>
          <div class="ps-mark-name"><label class="ps-field"><span>Name</span><input type="text" id="psMarkName" maxlength="30" value="${escapeHtml(m.name)}" oninput="psSetMark('name', this.value)" autocomplete="off"${dis} /></label>
          ${def ? '<span class="ps-default">★ Default mark</span>' : `<button type="button" class="ps-make-default" onclick="psMakeDefault()"${lockedAny ? ' disabled title="The main mark stays the default"' : ''}>Make default</button>`}</div></div>
        <div class="ps-group"><span class="ps-group-head">Place in the frame</span>${slider('Width', 'size', 4, 60)}${slider('Across', 'x', 10, 90)}${slider('Down', 'y', 10, 90)}</div>
        <div class="ps-group"><span class="ps-group-head">In the prompts <small>the words Kimi uses for this mark</small></span>
          <div class="ps-two"><label class="ps-field"><span>Its shape</span><input type="text" maxlength="80" value="${escapeHtml(m.shape || '')}" oninput="psSetMark('shape', this.value)" autocomplete="off"${dis} /></label>
          <label class="ps-field"><span>Called</span><input type="text" maxlength="40" value="${escapeHtml(m.noun || '')}" oninput="psSetMark('noun', this.value)" autocomplete="off"${dis} /></label></div></div>`
        + (!m.locked && !def ? '<div class="ps-remove"><button type="button" class="danger-outline" onclick="psRemove()">Remove mark</button><span>Its images stay in the project.</span></div>' : '');
    }
    // the preview: the selected mark (the default with the project selected) at its place and size with the logo target's dashed box;
    // the other marks as dashed boxes only (drawn over one another their images would pile up: most share one place)
    function renderPSPreview() {
      const f = projectForm, frame = document.getElementById('psFrame'), cap = document.getElementById('psCap');
      const focus = f.sel === 'project' ? psDefault() : psMark(f.sel);
      const cross = focus ? `<i class="ps-cross-v" style="left:${+focus.x}%"></i><i class="ps-cross-h" style="top:${+focus.y}%"></i>` : '<i class="ps-cross-v" style="left:50%"></i><i class="ps-cross-h" style="top:50%"></i>';   // the crosshair, as the mark target draws it
      frame.innerHTML = cross + f.marks.filter(m => !m.reading || m === focus).map(m => {
        const on = m === focus, style = `left:${+m.x}%;top:${+m.y}%;width:${+m.size}%;aspect-ratio:1 / ${m.ar || 1}`;
        return on ? `<span class="ps-pv on" style="${style}"><img src="${escapeHtml(m.url)}" alt="" />${m.reading ? '' : '<i></i>'}</span>` : `<span class="ps-pv other" style="${style}"></span>`;
      }).join('') + (f.marks.length ? '' : '<span class="ps-pv empty" style="left:50%;top:50%;width:18%;aspect-ratio:1"></span>');
      cap.textContent = !f.marks.length ? 'The mark appears here once it\'s read' : focus && focus.reading ? 'Placing it once Kimi has read it'
        : f.sel === 'project' ? 'The default mark, as every image will place it' : f.marks.length > 1 ? 'The selected mark; the others as boxes' : 'As every image will place it';
    }
    function psKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeProjectForm(); } }   // Esc: as Cancel
    function psNoMark() { projectForm.noMark = true; projectForm.sel = 'project'; renderPS(); const n = document.getElementById('psName'); if (n) n.focus(); }   // a project of your own images: named by hand
    function psSelect(key) { if (!projectForm) return; projectForm.sel = key; renderPS(); }
    function psSetProject(field, v) { projectForm[field] = v; projectForm.typed.add(field); renderPSRail(); psSyncSave(); }
    function psSetMark(field, v) {
      const m = psMark(projectForm.sel);
      if (!m || m.locked) return;
      m[field] = v;
      if (['size', 'x', 'y'].includes(field)) { const b = document.getElementById(`psv-${field}`); if (b) b.textContent = `${v}%`; renderPSPreview(); }
      else m.typed = (m.typed || new Set()).add(field);
      renderPSRail();
    }
    function psColour(i) { projectForm.palette.splice(i, 1); renderPS(); }
    function psColourAdd(input) {
      const add = (input.value.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || []).map(c => c.toUpperCase());
      if (!add.length) { input.value = ''; return; }
      projectForm.palette = [...new Set([...projectForm.palette, ...add])].slice(0, 8);
      renderPS();
      const next = document.getElementById('psColourNew'); if (next) next.focus();
    }
    function psColourKey(e, input) { if (e.key === 'Enter') { e.preventDefault(); psColourAdd(input); } }
    function psMakeDefault() { const m = psMark(projectForm.sel); if (m && !projectForm.marks.some(x => x.locked)) { projectForm.def = m.key; renderPS(); } }
    function psRemove() {
      const f = projectForm, m = psMark(f.sel);
      if (!m || m.locked || m.key === f.def) return;
      f.marks = f.marks.filter(x => x !== m);
      f.sel = 'project';
      renderPS();
    }
    // a file for the form: the first mark of a new project, another mark, or a new image for one
    let psFileFor = null;
    function psPick(forWhat) { psFileFor = forWhat; const i = document.getElementById('psFile'); i.value = ''; i.click(); }
    async function psFileChosen(file, forWhat = psFileFor) {
      if (!file || !projectForm) return;
      let png;
      try { png = await markToPng(file); }
      catch (err) { document.getElementById('pfError').textContent = err.message === 'empty' ? 'That image is empty: the mark needs to show on a transparent or plain background.' : 'That file could not be read as an image.'; return; }
      document.getElementById('pfError').textContent = '';
      const f = projectForm, ar = await new Promise(res => { const im = new Image(); im.onload = () => res(im.naturalHeight / im.naturalWidth || 1); im.onerror = () => res(1); im.src = png; });
      let m = forWhat === 'replace' ? psMark(f.sel) : null;
      if (m) { m.image = png; m.url = png; m.ar = ar; }                       // a new image for a mark: read again, never over what was typed
      else {
        const base = f.marks.length ? psDefault() : null;
        m = { key: `new-${++psSeq}`, id: null, name: '', size: base ? base.size : 18, x: base ? base.x : 50, y: base ? base.y : 50, shape: '', noun: '', url: png, image: png, ar, typed: new Set() };
        f.marks.push(m);
        if (f.marks.length === 1) { f.def = m.key; }
      }
      f.sel = m.key;
      psRead(m);
    }
    async function psRead(m) {
      const f = projectForm, first = f.kind === 'new' && m === f.marks[0];
      m.reading = true; m.readFrom = Date.now();
      clearInterval(psTimer);
      psTimer = setInterval(() => { if (!psReading()) { clearInterval(psTimer); return; } renderPSRail(); const s = document.querySelector('#psDetail .ps-secs'); const cur = psMark(projectForm.sel); if (s && cur && cur.reading) s.textContent = `${psSecs(cur)} s`; }, 1000);
      renderPS();
      let r = null;
      try { r = await (await fetch('/api/describe-mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mark: m.image }) })).json(); } catch (e) {}
      if (projectForm !== f || !f.marks.includes(m) || !m.reading) return;    // closed, removed or cancelled meanwhile: the answer is dropped
      m.reading = false;
      const typed = m.typed || new Set(), cap = s => s ? s.replace(/^./, c => c.toUpperCase()) : '';
      if (r && r.ok) {
        if (!typed.has('shape') && r.shape) m.shape = r.shape;
        if (!typed.has('noun') && r.noun) m.noun = r.noun;
        if (!typed.has('name') && !m.name) m.name = cap(r.noun) || 'Mark';
        if (first) {                                                          // the first mark of a new project: the project too
          if (!f.typed.has('name') && r.name) f.name = r.name;
          if (!f.typed.has('brief') && r.brand) f.brief = r.brand;
          if (!f.palette.length) f.palette = [...new Set([...(r.colours || []), ...(r.suggested || [])])].slice(0, 8);
          f.fromKimi = true;
          f.sel = 'project';
        }
      } else {
        if (!m.name) m.name = 'Mark';
        document.getElementById('pfError').textContent = (r && (r.error || r.note)) || 'Kimi could not read the mark: fill in its words yourself.';
      }
      renderPS();
    }
    function psCancelRead(key) {
      const f = projectForm, m = psMark(key);
      if (!m) return;
      if (m.id) { m.reading = false; renderPS(); return; }                    // a replaced image: kept, its words as they were
      f.marks = f.marks.filter(x => x !== m);                                 // a new mark: dropped
      if (f.def === m.key) f.def = f.marks[0] ? f.marks[0].key : 'main';
      f.sel = f.marks.length ? 'project' : null;
      renderPS();
    }
    // an image file as the mark: drawn into a PNG (an SVG too), at most 1600 px, trimmed to the mark as the server does
    async function markToPng(file) {
      const url = URL.createObjectURL(file);
      try {
        const im = new Image(); im.src = url; await im.decode();
        let w = im.naturalWidth || 1024, h = im.naturalHeight || 1024;
        const k = file.type === 'image/svg+xml' ? 1600 / Math.max(w, h) : Math.min(1, 1600 / Math.max(w, h));
        w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        let c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        const px = c.getContext('2d').getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) throw new Error('empty');
        if (x1 - x0 + 1 < w || y1 - y0 + 1 < h) {
          const t = document.createElement('canvas'); t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
          t.getContext('2d').drawImage(c, -x0, -y0); c = t;
        }
        return c.toDataURL('image/png');
      } finally { URL.revokeObjectURL(url); }
    }
    async function saveProject() {
      const f = projectForm;
      if (!f) return;
      const err = document.getElementById('pfError');
      if (isBusy()) { err.textContent = 'Wait until the running job ends (images, an AI order or an export), then save.'; return; }
      if (psFirstPending() || psReading()) return;
      if (!f.marks.length) {                                                  // no mark (yet): the project and its own images
        if (!f.name.trim()) { err.textContent = 'Give the project a name.'; return; }
        const body = f.kind === 'new' ? { action: 'create', no_mark: true, name: f.name, brief: f.brief, palette: f.palette } : { action: 'update', slug: project.slug, name: f.name, brief: f.brief, palette: f.palette, marks: [] };
        if (body.action === 'create') cover(`Making ${body.name}…`);
        const r = await projectsCall(body);
        if (r.ok) { reopen(r.project && r.project.name); return; }
        cover(null); err.textContent = r.error || 'Could not save the project.'; return;
      }
      const def = psDefault(), others = f.marks.filter(m => m !== def);
      const fields = m => ({ name: m.name, size: +m.size, x: +m.x, y: +m.y, shape: m.shape || '', noun: m.noun || '' });
      const body = { action: f.kind === 'new' ? 'create' : 'update', slug: project && f.kind === 'edit' ? project.slug : undefined, name: f.name, brief: f.brief, palette: f.palette,
        mark_name: def.name, mark_size: +def.size, mark_x: +def.x, mark_y: +def.y, mark_shape: def.shape || '', mark_noun: def.noun || '',
        ...(def.image ? { mark: def.image } : {}),
        marks: others.map(m => ({ ...(m.id && m.id !== 'main' ? { id: m.id } : {}), ...fields(m), ...(m.image ? { image: m.image } : {}) })) };
      if (f.kind === 'edit' && def.key !== 'main' && f.marks.some(m => m.key === 'main')) {   // another mark made default: its changes go with the list, then it swaps in
        const main = f.marks.find(m => m.key === 'main');
        const rest = f.marks.filter(m => m !== main);
        Object.assign(body, { mark_name: main.name, mark_size: +main.size, mark_x: +main.x, mark_y: +main.y, mark_shape: main.shape || '', mark_noun: main.noun || '', default_index: rest.indexOf(def) });
        delete body.mark; if (main.image) body.mark = main.image;
        body.marks = rest.map(m => ({ ...(m.id ? { id: m.id } : {}), ...fields(m), ...(m.image ? { image: m.image } : {}) }));
      }
      document.getElementById('pfSave').disabled = true;
      if (body.action === 'create') cover(`Making ${body.name}…`);
      try {
        const r = await projectsCall(body);
        if (r.ok) { reopen(r.project && r.project.name); return; }
        cover(null);
        err.textContent = r.error || 'Could not save the project.';
      } catch (e) { cover(null); err.textContent = `Could not save the project: ${e.message}`; }
      finally { document.getElementById('pfSave').disabled = psFirstPending() || psReading(); }
    }
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
      } catch (e) { cover(null); setStatus(`Could not import: ${plainError(e)}`); }
    }
    async function importProject(file) {
      if (!file) return;
      if (isBusy()) { setStatus('Wait until the running job ends, then import.'); return; }
      cover(`Importing ${file.name} (${Math.round(file.size / 1e6)} MB)…`);
      try {
        const r = await (await fetch('/api/project-import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file })).json();
        if (!r.ok) throw new Error(r.error || 'it was not imported');
        reopen(r.project && r.project.name);
      } catch (e) { cover(null); setStatus(`Could not import: ${plainError(e)}`); }
      finally { document.getElementById('pfImport').value = ''; }
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
    // how each image was made, for the automatic groups Mark, Position and Source (an upload has no mark and no position)
    const POSITION_NAMES = { exact: 'On target', loose: 'Loose', scattered: 'Scattered' };
    const MADE_BY = {
      mark: p => (p.uploaded ? null : p.mark || 'main'),
      pos: p => (p.uploaded ? null : ['loose', 'scattered'].includes(p.placement && p.placement.kind) ? p.placement.kind : 'exact'),   // Angled's few images read as on target
      src: p => (p.uploaded ? 'uploaded' : 'generated'),
    };
    // the members of a group key ('all', 'g:<id>', 'look:<tag>', 'world:<name>', 'mark:<id>', 'pos:<kind>', 'src:<kind>'), or null when there is no such group
    function groupMembers(key) {
      if (key === 'all') return 'all';
      const shown = plates.filter(p => !p.trashed);
      if (key.startsWith('g:')) { const g = groups.find(x => x.id === key.slice(2)); return g ? new Set(g.files) : null; }
      if (key.startsWith('look:')) { const set = new Set(shown.filter(p => (p.look || []).includes(key.slice(5))).map(p => p.filename)); return set.size ? set : null; }
      if (key.startsWith('world:')) { const set = new Set(shown.filter(p => p.world === key.slice(6)).map(p => p.filename)); return set.size ? set : null; }
      const by = MADE_BY[key.slice(0, key.indexOf(':'))];
      if (by) { const v = key.slice(key.indexOf(':') + 1), set = new Set(shown.filter(p => by(p) === v).map(p => p.filename)); return set.size ? set : null; }
      return null;
    }
    // what a group shows: All and the automatic groups in the one order of the selection; one of your groups in its OWN order
    function inGroup(list) {
      const own = ownGroup();
      if (own) { const by = new Map(list.map(p => [p.filename, p])); return own.files.map(f => by.get(f)).filter(Boolean); }
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
      // Mark, Position and Source: each only when the selection holds two kinds or more (one mark only: nothing to choose between)
      const marks = new Map(markChoices().filter(c => c[0] !== 'mix').map(c => [c[0], c]));
      const names = { mark: v => (marks.get(v) || [v, v === 'main' ? 'Main mark' : v])[1], pos: v => POSITION_NAMES[v], src: v => (v === 'uploaded' ? 'Uploaded' : 'Generated') };
      const order = { mark: [...marks.keys()], pos: Object.keys(POSITION_NAMES), src: ['generated', 'uploaded'] };
      Object.entries(MADE_BY).forEach(([kind, by]) => {
        const n = {};
        shown.forEach(p => { const v = by(p); if (v) n[v] = (n[v] || 0) + 1; });
        const kinds = Object.keys(n).sort((a, b) => ((order[kind].indexOf(a) + 1) || 99) - ((order[kind].indexOf(b) + 1) || 99));
        if (kinds.length >= 2) kinds.forEach(v => auto.push({ key: `${kind}:${v}`, name: names[kind](v), n: n[v], img: kind === 'mark' && marks.get(v) ? marks.get(v)[2] : null }));
      });
      return { chips, auto };
    }
    // Curate's group row: All and your own groups as chips (those that do not fit behind "+N more", never the chosen one), then on
    // the right the automatic groups in two menus, Look and Territory (a chosen one shows in its button: "Look: Warm ×")
    const AUTO_MENUS = [['look', 'Look'], ['terr', 'Territory'], ['mark', 'Mark'], ['pos', 'Position'], ['src', 'Source']];
    const AUTO_TIPS = { look: 'Automatic groups by look', terr: 'Automatic groups, one per territory with 6+ images', mark: 'Automatic groups: the images made with each of your marks',
      pos: 'Automatic groups: On target, Loose, Scattered', src: 'Automatic groups: the images made here and the ones you added' };
    const LOOK_SWATCH = { warm: '#C8743A', cold: '#4C7BD1', mono: '#8A877C', dark: '#1A1A1A', bright: '#F3EFD9' };
    function autoKinds() {
      const { auto } = groupChips();
      const of = prefix => auto.filter(c => c.key.startsWith(prefix));
      return { look: of('look:'), terr: of('world:'), mark: of('mark:'), pos: of('pos:'), src: of('src:') };
    }
    function renderGroups() {
      const bar = document.getElementById('groupBar');
      document.getElementById('groupRow').hidden = showTrash;
      const { chips, auto } = groupChips();
      const menu = '<button type="button" class="chip-more" id="groupMenuBtn" onclick="openGroupMenu(event, \'edit\')" title="Rename or delete this group" aria-label="Rename or delete this group"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></button>';
      const chip = c => `<button type="button" class="chip${c.key === currentGroup ? ' on' : ''}${c.own ? ' own' : ''}" data-key="${escapeHtml(c.key)}" onclick="setGroup(this.dataset.key)">${escapeHtml(c.name)} <span>${c.n}</span></button>${c.own && c.key === currentGroup ? menu : ''}`;   // your group's menu sits right after its chip
      document.getElementById('groupAll').innerHTML = chip(chips[0]);
      const own = chips.slice(1);
      bar.innerHTML = own.map(chip).join('') + '<button type="button" class="chip chip-overflow" id="moreChip" onclick="openGroupMenu(event, \'more\')" aria-haspopup="menu" hidden></button>';
      const kinds = autoKinds(), hasAuto = Object.values(kinds).some(l => l.length);
      document.getElementById('autoSep').hidden = !hasAuto;
      document.getElementById('ownSep').hidden = document.getElementById('ownLabel').hidden = !own.length;
      const autoBtn = (kind, list, label) => {
        if (!list.length) return '';
        const on = list.find(c => c.key === currentGroup);
        const caret = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>';
        const tip = AUTO_TIPS[kind];
        return on
          ? `<span class="auto-btn on"><button type="button" class="auto-main" id="auto-${kind}" onclick="openGroupMenu(event, '${kind}')" aria-haspopup="menu" title="${tip}">${label}: ${escapeHtml(on.name)} <span>${on.n}</span></button><button type="button" class="auto-x" onclick="setGroup('all')" aria-label="Clear ${label}"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></span>`
          : `<span class="auto-btn"><button type="button" class="auto-main" id="auto-${kind}" onclick="openGroupMenu(event, '${kind}')" aria-haspopup="menu" title="${tip}">${label} <span>${list.length}</span>${caret}</button></span>`;
      };
      const am = hasAuto ? '<span class="auto-label">Auto</span>' + AUTO_MENUS.map(([kind, label]) => autoBtn(kind, kinds[kind], label)).join('') : '';
      const amEl = document.getElementById('autoMenus');
      if (amEl.innerHTML !== am) amEl.innerHTML = am;
      fitChips();                                                            // after the Auto menus: the room left for your groups
      document.getElementById('removeFromGroupBtn').hidden = !ownGroup();
      // the same choice in Film, as a dropdown above the film strip: your groups, then Look, then Territory
      const fg = document.getElementById('filmGroup');
      const opt = c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.name)} (${c.n})</option>`;
      fg.innerHTML = chips.map(opt).join('') + AUTO_MENUS.map(([kind, label]) => (kinds[kind].length ? `<optgroup label="${label}">${kinds[kind].map(opt).join('')}</optgroup>` : '')).join('');
      fg.value = currentGroup;
      syncSelects();
      document.getElementById('miniTitle').textContent = currentGroup === 'all' ? 'Film' : (chips.concat(auto).find(c => c.key === currentGroup) || { name: 'Film' }).name;
    }
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
    function clearPicks() { if (showTrash) trashSel = new Set(); else pickSel = new Set(); closeGroupMenu(); syncSelection(); }
    // one floating bar for what is picked: in the Selection, groups and the Trash; in the Trash, Restore and Delete
    function updatePickBar() {
      const n = showTrash ? trashSel.size : pickSel.size, bar = document.getElementById('pickBar');
      bar.hidden = !n || mode !== 'curate';
      bar.classList.toggle('in-trash', showTrash);
      document.getElementById('pickCount').textContent = `${n} picked`;
      document.getElementById('pickTrashBtn').disabled = aiRunning;
      document.body.classList.toggle('picking', !showTrash && n > 0);       // every card shows its circle while picking
    }
    // the picked images to the Trash in one go; one undo step puts them all back where they were
    async function trashPicked() {
      if (blockedByAi() || !pickSel.size) return;
      const files = [...pickSel], before = plates.filter(p => !p.trashed).map(p => p.filename), n = files.length;
      const post = (filename, trashed) => fetch('/api/trash', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify({ filename, trashed }) });
      const out = async () => { for (const f of files) await post(f, true); await loadState(); };
      const back = async () => {
        if (blockedByAi()) return;
        for (const f of files) await post(f, false);
        await loadState();
        const now = new Set(plates.filter(p => !p.trashed).map(p => p.filename)), order = before.filter(f => now.has(f));
        await fetch('/api/reorder', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify({ order: order.concat([...now].filter(f => !order.includes(f))) }) });
        await loadState();
      };
      pickSel = new Set(); closeGroupMenu();
      await out();
      syncSelection();
      const step = pushStep({ label: `Trash ${n} image${n === 1 ? '' : 's'}`, undo: back, redo: out });
      setStatus(`${n} image${n === 1 ? '' : 's'} moved to Trash`, { label: 'Undo', run: () => undoStep(step) });
    }
    // the chips that fit, in order, the chosen one always among them; the rest behind "+N more"
    function fitChips() {
      const bar = document.getElementById('groupBar'), more = document.getElementById('moreChip');
      if (!bar.querySelectorAll || !more) return;
      const items = [...bar.children].filter(el => el !== more);
      items.forEach(el => el.classList.remove('out'));
      more.hidden = true;
      const avail = bar.clientWidth;
      if (!avail) return;                                                    // not laid out (hidden): fitted when shown
      const gap = 6, w = el => el.offsetWidth + gap;
      if (items.reduce((a, el) => a + w(el), 0) <= avail + gap) return;
      const keep = new Set(items.filter(el => el.classList.contains('on') || el.id === 'groupMenuBtn'));
      let used = 96 + [...keep].reduce((a, el) => a + w(el), 0);           // room for "+N more" and the chosen one
      const hidden = [];
      items.forEach(el => { if (keep.has(el)) return; if (used + w(el) <= avail) used += w(el); else { el.classList.add('out'); hidden.push(el); } });
      more.hidden = !hidden.length;
      more.innerHTML = `+${hidden.length} more <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>`;
    }
    addEventListener('resize', () => { if (mode === 'curate') fitChips(); });
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
      const pick = c => `<button type="button" class="gm-item${c.key === currentGroup ? ' on' : ''}" data-key="${escapeHtml(c.key)}" onclick="closeGroupMenu(); setGroup(this.dataset.key)">${c.sw ? `<i class="sw" style="background:${c.sw}"></i>` : ''}${c.img ? `<img class="pm-thumb" src="${escapeHtml(c.img)}" alt="" />` : ''}<span>${escapeHtml(c.name)}</span><span class="gm-n">${c.n}</span></button>`;
      const kinds = autoKinds();
      const hiddenOwn = [...document.querySelectorAll('#groupBar .chip.out')].map(el => groupChips().chips.find(c => c.key === el.dataset.key)).filter(Boolean);
      m.innerHTML = mode === 'add'
        ? `<button type="button" class="gm-item" id="gmNewBtn" onclick="showNewGroupForm(event)"><span class="gm-plus">＋</span> New group…</button>`
          + (groups.length ? '<div class="gm-sep"></div>' + groups.map(g => `<button type="button" class="gm-item" data-id="${g.id}" onclick="addToGroup(this.dataset.id)"><span>${escapeHtml(g.name)}</span><span class="gm-n">${g.files.length}</span></button>`).join('') : '')
        : mode === 'edit'
          ? `<form class="gm-new" onsubmit="event.preventDefault(); renameGroup(this.elements.name.value)"><input name="name" id="groupNameInput" type="text" maxlength="40" value="${escapeHtml(own ? own.name : '')}" autocomplete="off" /><button type="submit">Rename</button></form>`
            + `<button type="button" class="gm-item danger-text" onclick="deleteGroup()">Delete group</button>`
        : mode === 'more' ? hiddenOwn.map(pick).join('')
        : mode === 'look' ? '<div class="gm-title">Auto · Look</div>' + kinds.look.map(c => pick({ ...c, sw: LOOK_SWATCH[c.key.slice(5)] })).join('')
        : mode === 'terr' ? '<div class="gm-title">Auto · Territory</div>' + kinds.terr.map(pick).join('') + '<div class="gm-note">One group for every territory with 6 or more images. Smaller ones join once they grow.</div>'
        : `<div class="gm-title">Auto · ${(AUTO_MENUS.find(a => a[0] === mode) || [, ''])[1]}</div>` + (kinds[mode] || []).map(pick).join('');
      m.querySelectorAll('img.pm-thumb').forEach(fitMarkTone);                // marks as the top bar shows them
      const anchorEl = document.getElementById(mode in kinds ? `auto-${mode}` : { add: 'addToGroupBtn', edit: 'groupMenuBtn', more: 'moreChip' }[mode]);
      if (!anchorEl) return;
      const anchor = anchorEl.getBoundingClientRect();
      m.hidden = false;
      document.querySelectorAll('#autoMenus [aria-haspopup]').forEach(b => b.setAttribute('aria-expanded', String(b === anchorEl)));
      if (mode === 'add') m.style.top = `${anchor.top - m.offsetHeight - 8}px`;                    // the pick bar is at the bottom: the menu opens upward
      else m.style.top = `${anchor.bottom + 6}px`;
      const left = anchor.left;
      m.style.left = `${Math.max(8, Math.min(left, innerWidth - m.offsetWidth - 8))}px`;
      if (mode === 'add' && !groups.length) showNewGroupForm();
      if (mode === 'edit') { const i = document.getElementById('groupNameInput'); if (i && i.focus) i.focus(); if (i && i.select) i.select(); }
    }
    // "New group…" becomes its name field, in place (the menu stays open: the click must not reach the click-outside rule)
    function showNewGroupForm(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      const b = document.getElementById('gmNewBtn');
      if (!b) return;
      b.outerHTML = `<form class="gm-new" onsubmit="event.preventDefault(); newGroup(this.elements.name.value)"><input name="name" id="groupNameInput" type="text" maxlength="40" placeholder="New group…" autocomplete="off" /><button type="submit">Add</button></form>`;
      const m = document.getElementById('groupMenu'), a = document.getElementById('addToGroupBtn').getBoundingClientRect();
      m.style.top = `${a.top - m.offsetHeight - 8}px`;                      // taller now: still above the pick bar
      const i = document.getElementById('groupNameInput'); if (i && i.focus) i.focus();
    }
    function closeGroupMenu() {
      const m = document.getElementById('groupMenu'); if (m) m.hidden = true; groupMenuFor = null;
      document.querySelectorAll('#autoMenus [aria-haspopup]').forEach(b => b.setAttribute('aria-expanded', 'false'));
    }
    document.addEventListener('click', e => { if (!(e.target.closest && e.target.closest('#groupMenu, #addToGroupBtn, #groupMenuBtn, #moreChip, #auto-look, #auto-terr'))) closeGroupMenu(); });
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
      const own = ownGroup();                                                 // one of your groups: its own order, nothing else moves
      const before = own ? { group: own.id, files: [...own.files] } : { order: plates.filter(p => !p.trashed).map(p => p.filename) };   // for Undo
      const body = {
        direction: document.getElementById('aiDirection').value.trim(),
        ...(currentGroup === 'all' ? {} : { files: activePlates().map(p => p.filename) }),   // an automatic group: its images change places among themselves in All
        ...(own ? { group: own.id } : {}),
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
            const g = before.group && groups.find(x => x.id === before.group);
            const after = before.group ? { group: before.group, files: g ? [...g.files] : before.files } : { order: plates.filter(p => !p.trashed).map(p => p.filename) };
            const put = o => (o.group ? groupsCall({ action: 'reorder', id: o.group, files: o.files }) : restoreOrder(o));
            const step = pushStep({ label: 'AI re-order', undo: () => put(before), redo: () => put(after) });
            setStatus('The AI re-ordered your images.', { label: 'Undo', run: () => undoStep(step) });
            break;
          }
          prog.slots = steps.map((_, i) => (i < job.step ? 'ok' : i === job.step ? 'run' : 'wait'));
          prog.note = `${job.stage}${job.note ? ' · ' + job.note : ''}`;
          progRender();
        }
      } catch (e) {
        progStop(`AI order failed: ${plainError(e)}`);
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
      const n = activePlates().length, shown = showTrash ? visiblePlates().length : n;   // the images shown: All, the group, or the Trash
      const dl = document.getElementById('downloadBtn');
      dl.disabled = !shown || downloading;
      dl.title = shown ? `Download the ${shown} image${shown === 1 ? '' : 's'} shown, full size, in their order (a zip)` : 'No images to download';
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
      const list = showTrash ? visiblePlates() : activePlates();
      if (!list.length || downloading) return;
      downloading = true; renderSequences();
      setStatus(`Packing ${list.length} images…`);
      try {
        const label = showTrash ? 'Trash' : currentGroup === 'all' ? 'All' : (groupChips().chips.concat(groupChips().auto).find(c => c.key === currentGroup) || { name: 'Group' }).name;
        const r = await (await fetch('/api/download-zip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files: list.map(p => p.filename), label }) })).json();
        if (!r.ok) throw new Error(r.error || 'the zip was not made');
        const a = document.createElement('a'); a.href = r.url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
        setStatus(`Downloading ${r.filename} (${Math.round(r.bytes / 1e6)} MB).`);
      } catch (e) {
        setStatus(`Could not download: ${plainError(e)}`);
      } finally { downloading = false; renderSequences(); }
    }
    async function seqCall(payload) {
      const res = await (await fetch('/api/sequence', { method: 'POST', headers: forProject({'Content-Type': 'application/json'}), body: JSON.stringify(payload) })).json();
      if (!res.ok) { setStatus(res.error || 'Could not do that.'); return false; }
      await loadState();
      return true;
    }
    // Undo / Redo of an AI re-order: the order and its best-N cut as they were
    function restoreOrder(o) { return seqCall({ action: 'restore', order: o.order }); }

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
      const n = trashSel.size;
      document.getElementById('trashBar').hidden = document.getElementById('trashLead').hidden = !(showTrash && trashed.length);
      document.getElementById('trashSelCount').textContent = 'Pick images to restore or delete';   // what to do with them: the floating bar
      document.getElementById('trashDelSel').disabled = aiRunning || exporting || !n;
      document.getElementById('trashRestoreSel').disabled = aiRunning || !n;
      document.getElementById('trashRestoreSel').textContent = 'Restore';     // the count is beside it, in the bar
      document.getElementById('trashDelSel').textContent = 'Delete…';
      document.getElementById('trashSelAll').textContent = n && n === trashed.length ? 'Clear selection' : 'Select all';
      document.getElementById('trashEmpty').textContent = 'Empty trash…';
      document.getElementById('trashEmpty').title = `Delete all ${trashed.length} images in the Trash for good`;
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
      const items = [];
      visible.forEach(p => {
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
    // an image with its own placement (a Loose batch): the logo target draws its box there (the project's otherwise)
    function placeVars(pl) { return pl ? `--mark-x:${pl.x}%;--mark-y:${pl.y}%;--mark-w:${pl.size}%${pl.ar ? `;--mark-ar:${pl.ar}` : ''}` : ''; }   // (box: also another mark's shape)
    // why this image's mark is not on target: its batch asked for it (Loose / Scattered), and where
    function targetTip(pl) { return `${pl.kind === 'scattered' ? 'Scattered' : 'Loose'}: made with the mark at ${pl.x}% across, ${pl.y}% down, ${pl.size}% wide (on purpose: its batch asked for it)`; }
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
             onclick="cardClick(event, '${p.filename}')"
             ondblclick="openViewer(event, '${p.filename}')">
          <div class="card-thumb"${p.box || p.placement ? ` style="${placeVars(p.box || p.placement)}"` : ''}>
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
              <div class="prompt-overlay-text">${promptInfoHtml(p)}</div>
              <div class="prompt-overlay-meta"><button class="po-copy" onclick="copyPromptText(event, '${p.filename}')">Copy prompt</button></div>
            </div>
          </div>
          <div class="card-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
          <div class="card-meta">
            ${p.uploaded ? '<span class="card-model-badge uploaded" title="One of your own images: it is not checked for the mark">Uploaded</span>' : `<span class="card-model-badge">${escapeHtml(formatModelShort(p.model))}</span>`}
            ${p.as_designed ? '<span class="card-model-badge designed" title="Kept exactly as designed: its colours, lettering and details">As designed</span>' : ''}
            ${p.mark_name ? `<span class="card-model-badge mark" title="Made with ${escapeHtml(p.mark_name)}, one of the project's marks">${escapeHtml(p.mark_name)}</span>` : ''}
            ${p.placement && p.placement.kind !== 'exact' ? `<span class="card-model-badge target" title="${escapeHtml(targetTip(p.placement))}">${p.placement.kind === 'scattered' ? 'Scattered' : 'Loose'}</span>` : ''}
            ${p.trash_reason ? `<span class="card-model-badge warn" title="${escapeHtml(!p.qa_passed && (p.qa_issues || []).length && p.trash_reason === 'Mark check' ? p.qa_issues.join(', ') : p.trash_reason)}">${escapeHtml(p.trash_reason.slice(0, 40))}</span>` : ''}
            ${!p.qa_passed ? (p.trash_reason === 'Mark check' ? '' : `<span class="card-model-badge warn" title="${escapeHtml((p.qa_issues || []).join(', '))}">QA flagged</span>`) : p.qa_doubt ? `<span class="card-model-badge doubt" title="${escapeHtml(p.qa_doubt)}">Check the mark</span>` : ''}
          </div>
        </div>`;
    }
    function promptInfoHtml(p) {
      return `${p.world ? `<b class="po-world">${escapeHtml(p.world)}</b>` : ''}${p.idea ? `<i class="po-idea">${escapeHtml(p.idea)}</i>` : ''}<span class="po-prompt">${escapeHtml(p.prompt || p.title)}</span>${!p.qa_passed && (p.qa_issues || []).length ? `<span class="po-check po-qa">Mark check: ${escapeHtml(p.qa_issues.join('; '))}</span>` : p.qa_doubt ? `<span class="po-check po-doubt">Mark check: ${escapeHtml(p.qa_doubt)}</span>` : ''}`;
    }
    function gridHintText() { return aiRunning && !showTrash ? 'Locked while the AI orders' : ''; }   // (which order a group shows needs no words: as Photos' albums)   // dragging needs no hint
    // the images still being made, at the end of the selection while a batch runs
    // (in a group, only those that will belong to it: a territory's own; your groups and the looks get images only once they are made)
    function pendingCards() {
      if (!generating || prog.stage !== 'render') return [];
      const made = { world: prog.worlds, mark: prog.marks, pos: prog.positions, src: prog.slots.map(() => 'generated') }, kind = currentGroup.slice(0, currentGroup.indexOf(':'));
      const belongs = i => currentGroup === 'all' || (kind in made && (made[kind] || [])[i] === currentGroup.slice(kind.length + 1));
      return prog.slots.map((st, i) => ((st === 'wait' || st === 'run') && belongs(i)
        ? `<div class="card pending-card" aria-hidden="true"><div class="card-thumb"><div class="pending-ring"></div><span class="pending-label">${st === 'run' ? 'Rendering' : 'Queued'}</span><div class="pending-bar ${st}"><i></i></div></div><div class="card-title">${escapeHtml(prog.titles[i] || '')}</div><div class="card-meta"><span class="card-model-badge">generating…</span></div></div>`
        : '')).filter(Boolean);
    }
    function refreshPending() { if (generating) renderGrid(); }          // only the placeholders change, so only they are touched
    // thumbnail size in Curate: five steps (as Photos: steps, not a continuous range, so the grid stays tidy); a pinch steps through them
    const THUMB_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
    function setThumbSize(v) {
      if (!THUMB_SIZES.includes(v)) v = 'M';
      const i = THUMB_SIZES.indexOf(v);
      document.getElementById('thumbSizeVal').value = v;
      document.getElementById('grid').dataset.size = v;
      const r = document.getElementById('thumbRange');
      if (String(r.value) !== String(i)) r.value = i;
      r.setAttribute('aria-valuetext', ['Small', 'Medium', 'Large', 'Extra large', 'Largest'][i]);
      document.getElementById('thumbName').textContent = v;
      const ticks = document.querySelectorAll('.size-track i');
      if (ticks.forEach) ticks.forEach((t, k) => t.classList.toggle('lit', k <= i));          // the steps up to the size, lighter
      saveSettings();
    }
    function setThumbSizeAt(i) { setThumbSize(THUMB_SIZES[Math.round(+i)] || 'M'); }
    function stepThumbSize(d) {
      const i = THUMB_SIZES.indexOf(document.getElementById('thumbSizeVal').value);
      const j = Math.max(0, Math.min(THUMB_SIZES.length - 1, i + d));
      if (j !== i) setThumbSize(THUMB_SIZES[j]);
    }
    // the trackpad's pinch on the grid: WebKit (Safari, the Mac app) sends gesture events, Chrome a wheel with Ctrl; a step per
    // clear spread or squeeze, as far as the pinch goes
    let pinchAcc = 0, gestureAt = 1, gesturing = false;
    function onGridWheel(e) {
      if (!e.ctrlKey) return;
      e.preventDefault();                                                    // never the page's own zoom
      if (gesturing) return;
      pinchAcc -= e.deltaY;
      if (Math.abs(pinchAcc) >= 40) { stepThumbSize(Math.sign(pinchAcc)); pinchAcc = 0; }
    }
    function onGridGesture(e) {
      e.preventDefault();
      if (e.type === 'gesturestart') { gesturing = true; gestureAt = 1; return; }
      if (e.type === 'gestureend') { gesturing = false; return; }
      const r = e.scale / gestureAt;
      if (r > 1.3 || r < 0.77) { stepThumbSize(r > 1 ? 1 : -1); gestureAt = e.scale; }
    }
    (() => {
      const g = document.getElementById('grid');
      if (!g.addEventListener) return;
      g.addEventListener('wheel', onGridWheel, { passive: false });
      for (const t of ['gesturestart', 'gesturechange', 'gestureend']) g.addEventListener(t, onGridGesture, { passive: false });
    })();
    // the image viewer: a double-click on a card shows it as large as the window allows, ← → the next ones of what the grid shows
    // (the group, or the Trash), Esc, Space or a click closes it. Nothing else in it: trashing stays on the cards
    let viewerAt = -1;
    const viewerOpen = () => document.getElementById('viewer').hidden === false;
    function openViewer(e, filename) {
      if (e && e.target && e.target.closest && e.target.closest('button, .prompt-overlay')) return;   // a double-click on a card's own buttons
      viewerAt = visiblePlates().findIndex(p => p.filename === filename);
      if (viewerAt < 0) return;
      document.getElementById('viewer').hidden = false;
      showViewer();
    }
    function showViewer() {
      const list = visiblePlates();
      if (!list.length) { closeViewer(); return; }
      viewerAt = (viewerAt + list.length) % list.length;
      const p = list[viewerAt];
      document.getElementById('viewerImg').src = p.url;
      document.getElementById('viewerFrame').setAttribute('style', placeVars(p.box || p.placement));   // the mark target (T) as on its card
      document.getElementById('viewerTitle').textContent = p.title || '';
      document.getElementById('viewerCount').textContent = `${viewerAt + 1} / ${list.length}`;
      document.getElementById('viewerTrashBtn').hidden = !!p.trashed;            // in the Trash: Info only
      const info = document.getElementById('viewerInfo');
      if (!info.hidden) info.innerHTML = promptInfoHtml(p) + `<button type="button" class="po-copy" onclick="copyPromptText(event, '${p.filename}')">Copy prompt</button>`;
      for (const d of [1, -1]) { const q = list[(viewerAt + d + list.length) % list.length]; if (q && window.Image) new Image().src = q.url; }   // the next ones ready
    }
    function viewerStep(d) { viewerAt += d; showViewer(); }
    function closeViewer() { document.getElementById('viewer').hidden = true; viewerAt = -1; }
    // the card's Info and Trash in the viewer (the user's ask: check or delete while looking); Info stays open from image to image
    function toggleViewerInfo() {
      const info = document.getElementById('viewerInfo');
      info.hidden = !info.hidden;
      document.getElementById('viewerInfoBtn').setAttribute('aria-pressed', String(!info.hidden));
      showViewer();
    }
    async function viewerTrash() {
      const p = visiblePlates()[viewerAt];
      if (!p || p.trashed) return;
      await setTrash({ stopPropagation() {} }, p.filename, true);           // the same as the card's: one undo step, the toast
      if (viewerOpen()) showViewer();                                       // the next image takes its place
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
      document.querySelectorAll('.prompt-overlay.open').forEach(o => {     // one open at a time: opening this one closes any other
        if (o === el) return;
        o.classList.remove('open');
        const c = o.closest && o.closest('.card'); if (c) c.classList.remove('info-open');
      });
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
      const own = ownGroup();
      if (own) {                                                             // one of your groups: its own order only
        const before = [...own.files], list = before.filter(f => f !== dragged);
        list.splice(list.indexOf(target) + (before.indexOf(dragged) < before.indexOf(target) ? 1 : 0), 0, dragged);
        const put = files => () => groupsCall({ action: 'reorder', id: own.id, files });
        await put(list)();
        const p = plates.find(x => x.filename === dragged);
        pushStep({ label: `Move “${p ? p.title : dragged}” in “${own.name}”`, undo: put(before), redo: put(list) });
        return;
      }
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
      else fitChips();                                                       // measured once the row can be seen
      updatePickBar();
    }
    // Tab switches the mode and Space plays, except while typing in a field (Tab still moves between fields there)
    function typingIn(t) {
      if (!t || !t.tagName) return false;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true;
      return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type);
    }
    // Keys (none while typing in a field): Tab mode · Space play · ← → one image · 0 / Home back to the start · Delete trash the image on screen (Film)
    // · F full screen · T the logo target · R Random (video and sound) · S Random sound · Cmd/Ctrl+Z undo
    // Keys, in three groups (the keys panel shows the same three). A key is universal when it means the same thing in both
    // tabs; otherwise it belongs to the tab whose content it acts on, and does nothing in the other (free there for its own use).
    //   everywhere  Tab, Space (the one player; in Curate it opens the preview), T, ?, ⌘Z / ⇧⌘Z (one history), Esc
    //   Film        ← →, 0 / Home, F, R, S, ⌘S, Delete on a selected speed change: the film's playhead and settings
    //   Curate      ⌘A (and ⌘ / ⇧ click, double-click, pinch, on the grid): the images. Delete trashes nothing (by hand only)
    // The image viewer is modal: while open it has the keys (← →, Esc or Space closes).
    const FILM_KEYS = {
      ArrowRight: () => stepImage(1), ArrowLeft: () => stepImage(-1),
      0: () => { flash('restartBtn'); toStart(); }, Home: () => { flash('restartBtn'); toStart(); },
      f: toggleFullscreen, r: () => { flash('randomAllBtn'); randomAll(); },
      s: () => { flash('randomBtn'); if (!musicOn()) setv('musicSelect', 'on'); randomMusic(); },
    };
    function onKey(e) {
      if (typingIn(e.target) || document.getElementById('confirmModal').classList.contains('open')) return;
      const cmd = e.metaKey || e.ctrlKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 'Backspace' || key === 'Delete') e.preventDefault();      // WebKit (the Mac app) must not take Backspace for "go back"
      if (viewerOpen()) {
        if (cmd) return;
        e.preventDefault();
        if (key === 'ArrowRight' || key === 'ArrowLeft') viewerStep(key === 'ArrowRight' ? 1 : -1);
        else if (key === 'Escape' || key === ' ') closeViewer();
        else if (key === 't') toggleReticle();                               // the mark target: a universal key, seen on the image too
        return;
      }
      // everywhere
      if (e.ctrlKey && e.altKey && (key === 'l' || e.code === 'KeyL')) { e.preventDefault(); toggleTasteBar(); return; }   // dev: the taste bar
      if (cmd && !e.altKey && key === 'z') { e.preventDefault(); if (e.shiftKey) redoLast(); else undoLast(); return; }
      if (cmd && key === 's') { e.preventDefault(); if (mode === 'film') { flash('editSaveBtn'); snapshotEdit(); } return; }   // Film's snapshot; never the browser's Save Page
      if (cmd && key === 'a' && mode === 'curate' && !showTrash) { e.preventDefault(); pickAll(); return; }
      if (cmd || e.altKey) return;
      if (e.repeat && ['Tab', 'f', 't', 'r', 's'].includes(key)) { e.preventDefault(); return; }   // a held key acts once
      if (e.target && e.target.type === 'range' && key.startsWith('Arrow')) return;               // a slider with focus keeps its arrows
      if (key === 'Tab') { e.preventDefault(); if (e.target && e.target.blur) e.target.blur(); setMode(mode === 'film' ? 'curate' : 'film'); return; }
      if (key === ' ') { e.preventDefault(); if (mode === 'curate' && !miniOpen) toggleMini(true); togglePlay(); return; }
      if (key === 't') { e.preventDefault(); flash(mode === 'film' ? 'targetBtn' : 'gridTargetBtn'); toggleReticle(); return; }
      if (key === '?') { e.preventDefault(); toggleKeys(); return; }
      if (key === 'Escape') { document.getElementById('keysPanel').hidden = true; if (pickSel.size || trashSel.size) clearPicks(); if (rsSel) { rsSel = null; renderRhythmStrip(); } return; }
      // the tab's own
      if (mode === 'film') {
        if ((key === 'Delete' || key === 'Backspace') && rsSel) { removeChange(); return; }      // a selected point of the change: the change goes (never an image)
        if (FILM_KEYS[key]) { e.preventDefault(); FILM_KEYS[key](); }
      }
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
      document.querySelectorAll('select:not(.seg-src):not(.src-only)').forEach(sel => {
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
      const repeat = Math.max(1, parseInt(document.getElementById('repeatSelect').value, 10) || 1);   // the images go round this many times
      const nCuts = nPlates * repeat * (paired ? 2 : 1);                    // (planAt wraps the image index round the list)
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
        pulse: unit('pulseRange'), low: unit('lowRange'), bright: unit('brightRange'), width: unit('widthRange'), space: unit('spaceRange'), room: parseInt(document.getElementById('roomSelect').value, 10) || 0, power: unit('powerRange'),
        pitch: unit('pitchRange'), chord: parseInt(document.getElementById('chordSelect').value, 10) || 0, prog: parseInt(document.getElementById('progSelect').value, 10) || 0, mode: parseInt(document.getElementById('modeSelect').value, 10) || 0, pad: unit('padRange'), padTone: parseInt(document.getElementById('padToneSelect').value, 10) || 0, tape: unit('tapeRange'), bass: unit('bassRange'), bassPattern: parseInt(document.getElementById('bassPatternSelect').value, 10) || 0, bassRate: parseInt(document.getElementById('bassRateSelect').value, 10) || 0, arrange: parseInt(document.getElementById('arrangeSelect').value, 10) || 0, progEvery: parseInt(document.getElementById('progEverySelect').value, 10) || 0, movement: unit('movementRange'), echo: unit('echoRange'),
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
    function warmSound() {                                                    // even with the sound off: the first Random turns it on, and making the audio context then froze the page ~115 ms
      if (warmed || !droneLive.warm) return;
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
    // Wash supports the drone, it never carries it (the user: too much, too often, 2026-10-30): at most 30 in Random and in every Type
    const RANDOM_RANGES = { pulse: [30, 90], low: [65, 100], power: [30, 90], space: [5, 85], bright: [0, 55], width: [30, 100], pitch: [0, 100], movement: [15, 85], echo: [0, 55], wash: [0, 30], ring: [0, 45], shimmer: [0, 45], choir: [25, 55], industrial: [20, 50], hit: [30, 70], arp: [20, 45] };
    // Characters: kinds of film, modelled on the references, each a set of tighter ranges for the rhythm, the look and the sound (all inside RANDOM_RANGES).
    // Random rolls inside the chosen one ("Any": a different one each time); the rules below then make the parts agree.
    const CHARACTERS = {
      landing: { name: 'Landing',                                          // Ecwora / Soiltone: fast hold, then a slow landing, grey inverted copies
        rhythm: { mode: 'variable', start: [60, 120], end: [450, 900], ramp: [8, 16], at: 'end', mult: ['1', '1', '2'] },
        look: { invert: ['mono', 'mono', 'off'], zoom: ['out', 'out', 'in', 'off'], amount: [0.4, 2] },
        sound: { pulse: [40, 75], low: [75, 100], power: [40, 80], space: [50, 85], bright: [0, 35], width: [50, 100], pitch: [0, 45], movement: [20, 60], echo: [0, 35], wash: [8, 30], ring: [0, 25], shimmer: [0, 25], hit: [30, 60], arp: [0, 35],
          chord: ['0', '0', '2'], subWave: ['0', '1'], padWave: ['0', '2'], hitType: ['0', '0', '1'], hitOn: ['3', '2'], dyn: ['2', '3'], mood: ['2', '1', '0', '3'], layer: { choir: [25, 50], odds: 0.3 }, shape: { pad: 0.5, tape: 0.25, bass: 0.4, arrange: ['3', '3', '1'] } } },
      pulse: { name: 'Pulse',                                              // Helione / Moverunion: a steady tempo, cut 2 or 4 to the beat
        rhythm: { mode: 'flat', bpm: [118, 150], mult: ['1', '2', '2', '4'] },
        look: { invert: ['off', 'mono'], zoom: ['out', 'out', 'in', 'off'], amount: [0.4, 2] },
        sound: { pulse: [65, 90], low: [70, 100], power: [50, 90], space: [5, 35], bright: [10, 45], width: [30, 80], pitch: [20, 70], movement: [30, 70], echo: [0, 20], wash: [0, 25], ring: [0, 20], shimmer: [0, 20], hit: [40, 70], arp: [0, 30],
          chord: ['0', '1', '3'], subWave: ['0', '1'], padWave: ['0', '1'], hitType: ['2', '2', '1'], hitOn: ['1', '0'], dyn: ['0'], mood: ['0', '0', '1', '6', '7'], layer: { industrial: [20, 45], odds: 0.25 }, shape: { pad: 0.25, tape: 0.2, bass: 0.8, arrange: ['2', '2', '0'] } } },
      build: { name: 'Build',                                              // slow to fast, the notes rising with it
        rhythm: { mode: 'variable', start: [500, 900], end: [60, 110], ramp: [10, 20], at: 'start', mult: ['1', '2'] },
        look: { invert: ['off', 'colour', 'mono'], zoom: ['in', 'in', 'out', 'off'], amount: [0.6, 3] },
        sound: { pulse: [45, 80], low: [65, 95], power: [45, 85], space: [30, 65], bright: [20, 50], width: [40, 90], pitch: [30, 80], movement: [40, 85], echo: [0, 30], wash: [0, 30], ring: [0, 30], shimmer: [15, 40], hit: [35, 65], arp: [25, 45],
          chord: ['2', '3', '1'], subWave: ['0', '1', '2'], padWave: ['0', '3'], hitType: ['3', '0', '4'], hitOn: ['3', '2'], dyn: ['1'], mood: ['0', '1', '5', '7'], layer: { choir: [25, 45], odds: 0.3 }, shape: { pad: 0.4, tape: 0.2, bass: 0.6, arrange: ['3', '1'] } } },
      float: { name: 'Float',                                              // slow and wide: a big room, wash, no hits
        rhythm: { mode: 'flat', bpm: [50, 80], mult: ['1', '2'] },
        look: { invert: ['off'], zoom: ['in', 'out'], amount: [0.5, 2.5], trail: [10, 30] },
        sound: { pulse: [30, 45], low: [65, 90], power: [30, 55], space: [65, 85], bright: [0, 30], width: [70, 100], pitch: [0, 60], movement: [15, 45], echo: [15, 50], wash: [8, 30], ring: [0, 20], shimmer: [0, 30], hit: [30, 50], arp: [20, 35],
          chord: ['1', '3', '0'], subWave: ['0'], padWave: ['2', '2', '0'], hitType: ['0'], hitOn: ['0'], dyn: ['0', '2'], mood: ['2', '3'], layer: { choir: [30, 55], odds: 0.5 }, shape: { pad: 0.6, tape: 0.4, bass: 0.2, arrange: ['1', '0'] } } },
      machine: { name: 'Machine',                                          // very fast cuts, metal and a square sub
        rhythm: { mode: 'flat', bpm: [150, 200], mult: ['2', '3', '4', '4'] },
        look: { invert: ['colour', 'mono'], zoom: ['off', 'in', 'out'], amount: [0.3, 1.2] },
        sound: { pulse: [70, 90], low: [75, 100], power: [60, 90], space: [5, 30], bright: [25, 55], width: [30, 70], pitch: [30, 90], movement: [50, 85], echo: [0, 15], wash: [0, 15], ring: [20, 45], shimmer: [0, 20], hit: [45, 70], arp: [0, 30],
          chord: ['0', '1'], subWave: ['2', '2', '1', '3'], padWave: ['1', '3'], hitType: ['3', '3', '4'], hitOn: ['3', '1'], dyn: ['0', '3'], mood: ['0', '1', '6', '7'], layer: { industrial: [25, 50], odds: 0.4 }, shape: { pad: 0.2, tape: 0.2, bass: 0.8, arrange: ['2', '1'] } } },
      drift: { name: 'Drift',                                              // unhurried and changing slowly, no hits: a long breath of images
        rhythm: { mode: 'variable', start: [250, 450], end: [500, 900], ramp: [10, 20], at: ['end', 'start'], mult: ['1', '1', '2'] },
        look: { invert: ['off'], zoom: ['in', 'out'], amount: [0.8, 3], trail: [15, 35] },
        sound: { pulse: [30, 50], low: [70, 95], power: [30, 60], space: [55, 85], bright: [0, 30], width: [60, 100], pitch: [0, 50], movement: [15, 40], echo: [10, 45], wash: [8, 30], ring: [0, 15], shimmer: [10, 35], hit: [30, 45], arp: [0, 30],
          chord: ['1', '3', '2'], subWave: ['0'], padWave: ['2', '0'], hitType: ['0'], hitOn: ['0'], dyn: ['0', '2'], mood: ['2', '4', '3'], layer: { choir: [25, 50], odds: 0.5 }, shape: { pad: 0.6, tape: 0.4, bass: 0.2, arrange: ['1', '0'] } } },
      strobe: { name: 'Strobe',                                            // colour-inverted flashes on a mid tempo, dark bursts on the accents
        rhythm: { mode: 'flat', bpm: [100, 140], mult: ['2', '3', '4'] },
        look: { invert: ['colour', 'colour', 'mono'], zoom: ['in', 'off'], amount: [0.5, 2] },
        sound: { pulse: [70, 90], low: [70, 100], power: [55, 90], space: [5, 35], bright: [20, 50], width: [30, 70], pitch: [20, 70], movement: [40, 80], echo: [0, 15], wash: [0, 20], ring: [0, 30], shimmer: [0, 25], hit: [45, 70], arp: [0, 30],
          chord: ['0', '2'], subWave: ['0', '1', '3'], padWave: ['1', '3'], hitType: ['4', '2'], hitOn: ['3', '1'], dyn: ['0'], mood: ['0', '1', '6', '7'], layer: { industrial: [20, 40], odds: 0.25 }, shape: { pad: 0.2, tape: 0.2, bass: 0.7, arrange: ['2'] } } },
      breath: { name: 'Breath',                                            // a calm pulse, a slow zoom, an arpeggio carrying it
        rhythm: { mode: 'flat', bpm: [70, 100], mult: ['1', '2'] },
        look: { invert: ['off', 'mono'], zoom: ['out', 'out', 'in'], amount: [0.8, 3] },
        sound: { pulse: [40, 70], low: [70, 95], power: [35, 65], space: [40, 75], bright: [10, 40], width: [50, 90], pitch: [10, 60], movement: [20, 55], echo: [0, 35], wash: [0, 30], ring: [0, 20], shimmer: [0, 30], hit: [30, 55], arp: [25, 45],
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
    const NOT_UNDONE = ['targetSelect', 'markSelect', 'keepCheck', 'batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput', 'soundGroupVal', 'thumbSizeVal', 'characterSelect', 'bpmLock'];
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
      if (o && 'chordSelect' in o && !('modeSelect' in o)) o.modeSelect = '0';   // a sound saved before modes: the natural minor it was made in
      if (o && 'chordSelect' in o && !('roomSelect' in o)) o.roomSelect = '0';   // and before rooms: the measured room
      if (o && 'chordSelect' in o && !('padToneSelect' in o)) o.padToneSelect = '0';   // and the pad's tone: warm
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
      setv('subWaveSelect', r < 0.45 ? 0 : r < 0.65 ? 1 : r < 0.85 ? 2 : 3);
      choice('padWaveSelect', 4); choice('chordSelect', 4); rollMode(); rollRoom();
      setv('choirRange', 0); setv('industrialRange', 0);
      const slow = rhythmCutsPerSecond() <= 3, roll = Math.random();                                   // a layer now and then, never both: the drone is the sound
      if (roll < (slow ? 0.3 : 0.1)) setv('choirRange', rint(RANDOM_RANGES.choir));                  // voices want room: mostly on slower cuts
      else if (roll < (slow ? 0.35 : 0.3)) setv('industrialRange', rint(RANDOM_RANGES.industrial));  // metal wants speed
      setv('arpMoodSelect', Math.random() < 0.3 ? 0 : 1 + Math.floor(Math.random() * 7));          // the first arpeggio (Pluck) most often, then the moods alike
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
      { const r = Math.random(); setv('padToneSelect', r < 0.5 ? 0 : r < 0.75 ? 1 : 2); }   // the pad's tone: warm half the time
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
      rollChanges(); rollShape(c); rollMode(); rollRoom();
      setv('seedVal', 1 + Math.floor(Math.random() * 99999));
    }
    // the mode: the natural minor most often (the measured sound), the others for variety
    // the kind of room: as measured most often; slow cuts lean to the hall and the bloom, fast ones to the booth (a long tail blurs a strobe)
    function rollRoom() {
      const rate = rhythmCutsPerSecond(), r = Math.random();
      setv('roomSelect', rate > 5 ? (r < 0.5 ? 0 : 1) : rate < 2.5 ? (r < 0.35 ? 0 : r < 0.45 ? 1 : r < 0.75 ? 2 : 3) : (r < 0.4 ? 0 : r < 0.6 ? 1 : r < 0.8 ? 2 : 3));
    }
    function rollMode() { const r = Math.random(); setv('modeSelect', r < 0.4 ? 0 : r < 0.6 ? 1 : r < 0.8 ? 2 : 3); }
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

    // the lanes, the paused frame and the export's line follow the settings (the length shows in the ruler)
    function drawInfo() {
      const n = activePlates().length;
      renderRhythmStrip();
      if (!isPlaying) drawFrame();                                         // paused: the time and the length follow the new settings at once
      if (!n) return;
      const starts = timelineFor(n);
      const sec = c => c / 30;
      const cuts = starts.length - 1;
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
      const paired = ['mono', 'colour'].includes(document.getElementById('invertSelect').value), round = n * (paired ? 2 : 1);
      const loops = [];                                                     // where the images start round again (Repeat)
      for (let k = round; k < pic.length - 1; k += round) loops.push(X(pic[k]));
      const beats = r.audio.slice(0, -1).map(t => X(t * 30)).filter(x => x < 1000).slice(0, 2000);
      const sec = total / 30, step = sec <= 3 ? 0.5 : sec <= 8 ? 1 : sec <= 20 ? 2 : sec <= 60 ? 5 : 10;
      const axis = [];
      for (let t = 0; t <= sec + 1e-6; t += step) axis.push({ left: (t / sec) * 100, text: `${+t.toFixed(1)} s` });
      return { total, ticks: pic.slice(0, -1).map(X), curve, points, band, handle, linear, beats, axis, mult, flatY: yOfMs(60000 / bpm), tAt, base, nBase, nMusic, loops };
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
      el('rsLoops').innerHTML = m.loops.map(x => `<i style="left:${x / 10}%"></i>`).join('');
      el('rsAxis').innerHTML = m.axis.map((a, i) => `<span style="left:${a.left}%"${i === 0 ? ' class="first"' : ''}>${a.text}</span>`).join('');
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
      repeatField: {
        label: 'Repeat',
        values: () => [...document.getElementById('repeatSelect').options].map(o => o.value),
        get: () => document.getElementById('repeatSelect').value,
        set: v => { setv('repeatSelect', String(v)); updateTempo(); },
        parse: t => { const n = parseInt(t.replace(/[×x\s]/g, ''), 10); return Number.isFinite(n) ? n : null; },
      },
      countField: {                                                           // how many images a batch makes: any number, 1 to 20
        label: 'Images',
        get: () => Math.min(20, Math.max(1, parseInt(document.getElementById('batchCountSelect').value, 10) || 4)),
        drag: (v0, dy, fine) => v0 - dy / (fine ? 24 : 12),
        step: (v, d, big) => v + d * (big ? 4 : 1),
        text: v => String(Math.round(v)),
        parse: t => { const n = parseInt(String(t).replace(/[×x\s]/g, ''), 10); return Number.isFinite(n) ? n : null; },
        set: v => { setv('batchCountSelect', String(Math.min(20, Math.max(1, Math.round(v))))); showCount(); },
        commit: () => { saveSettings(); renderTerrMenu(); },              // a generation setting: no undo step (as the territory)
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
        if (n !== null) { f.set(f.values ? vfNearest(f, n) : n); if (f.commit) f.commit(); else commitSettings(f.label === 'Tempo' ? 'the tempo' : 'the Multiple'); }
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
        const up = () => { if (!drag) return; const moved = drag.moved; drag = null; el.classList.remove('dragging'); if (moved) { if (f.commit) f.commit(); else commitSettings(f.label === 'Tempo' ? 'the tempo' : 'the Multiple'); } };
        el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        el.addEventListener('dblclick', () => vfType(el));
        el.addEventListener('keydown', e => {
          if (el.classList.contains('typing') || el.getAttribute('aria-disabled') === 'true') return;
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); vfStep(id, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); if (f.commit) f.commit(); }
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
    let shownBox = null;
    function drawFrame() {
      const active = activePlates();
      const stageImg = document.getElementById('stageImg');
      if (!active.length) { markFilmstrip(-1); return; }
      const fx = fxSettings();
      const tl = timelineFor(active.length);
      const plan = planAt(cutPos, active.length, fx.invert, tl);
      currentIdx = plan.plate;
      const url = active[plan.plate].preview || active[plan.plate].url;
      const box = placeVars(active[plan.plate].box || active[plan.plate].placement);
      if (box !== shownBox) { shownBox = box; document.querySelector('#reticle .reticle-circle').style.cssText = box; }   // this image's own box
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
    const PERSISTED = ['repeatSelect', 'rhythmSelect', 'changeFrom', 'changeTo', 'endMsRange', 'curveVal', 'bpmInput', 'followCuts', 'multSelect', 'musicSelect', 'pulseRange', 'lowRange', 'powerRange', 'spaceRange', 'brightRange', 'widthRange', 'pitchRange', 'chordSelect', 'modeSelect', 'roomSelect', 'progSelect', 'progEverySelect', 'padRange', 'padToneSelect', 'tapeRange',  'movementRange', 'echoRange', 'washRange', 'ringRange', 'shimmerRange', 'choirRange', 'industrialRange', 'subWaveSelect', 'padWaveSelect', 'hitTypeSelect', 'hitRange', 'hitOnSelect', 'arpRange', 'arpMoodSelect', 'arpStepsSelect', 'arpRateSelect', 'bassRange', 'bassPatternSelect', 'bassRateSelect', 'arrangeSelect', 'dynSelect', 'seedVal', 'soundGroupVal', 'characterSelect', 'thumbSizeVal', 'bpmLock', 'invertSelect', 'zoomSelect', 'zoomAmt', 'trailRange', 'batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput', 'targetSelect', 'markSelect', 'keepCheck'];
    // Each project keeps its own film (rhythm, look, sound, Type, territory) on this computer (localStorage `studioFilm:<slug>`); the
    // rest is the same everywhere (`studioSettings`: card size, image model, batch size, the Sound tab). Opening a project brings its
    // film back; one never opened here (new, imported) gets a Random of its own instead of the last project's. The settings saved
    // before this was per project become those of the first project opened after it.
    const GLOBAL_SETTINGS = ['batchCountSelect', 'modelSelect', 'soundGroupVal', 'thumbSizeVal'];
    const FILM_SETTINGS = PERSISTED.filter(id => !GLOBAL_SETTINGS.includes(id));
    const filmKey = slug => `studioFilm:${slug}`;
    let filmSlug = null, legacyFilm = null;
    try { filmSlug = localStorage.getItem('studioProject') || null; } catch (e) {}
    // the territory used last, read now: the page saves its settings before the territories arrive, which blanked it
    let savedWorld = '';
    try { savedWorld = JSON.parse(localStorage.getItem(`studioFilm:${filmSlug}`) || '{}').worldSelect || ''; } catch (e) {}
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
      const rep = document.getElementById('repeatSelect').value || '1';
      document.getElementById('repeatVal').textContent = `×${rep}`;
      document.getElementById('repeatField').setAttribute('aria-valuetext', `the images ${rep === '1' ? 'once' : `${rep} times`}`);
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

    // the tabs, the group row and the grid, always together (Selection or Trash)
    function renderView() {
      document.getElementById('tabSelection').className = showTrash ? '' : 'on';
      document.getElementById('tabTrash').className = showTrash ? 'on' : '';
      renderSequences();
      renderGroups();
      renderGrid();
    }
    function setTrashView(on) {
      showTrash = on;
      trashSel = new Set(); pickSel = new Set();
      renderView();                                                          // at once, from what the page has: a slow server (mid-batch) left the tab and the grid disagreeing
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
      if (v === '') {                                                        // only until the territories have loaded
        input.placeholder = 'e.g. wet apparel, warm light';
        say = 'Choose a territory';
      } else if (v === '__custom__') {
        input.placeholder = 'what is it? e.g. fog, clouds, rain, lightning, or paste a whole brief';
        say = 'Describe your own: a few words or a whole brief. It becomes a territory that keeps your words as written: every batch of it follows them.';
      } else if (v === '__sampler__') {
        input.placeholder = 'e.g. dark, daylight, rain (every territory follows it)';   // a light, mood or weather works anywhere; a subject would fight most territories
        say = 'Sampler: one image from each of as many territories as images, the ones you have tried least first.';
      } else if (v === '__wildcard__') {
        input.placeholder = 'a hint for Kimi, if you like';
        say = 'Surprise me: Kimi invents a territory we don\'t cover yet.';
      } else {
        const opt = sel.selectedOptions[0];
        const eg = opt && opt.dataset.examples;                                   // the territory's own subjects: what typed here changes
        input.placeholder = `focus inside ${v}${eg ? `, e.g. ${eg}` : ''}`;
        say = opt && opt.dataset.prompt ? `${v}, in your words: ${opt.dataset.prompt}` : `${v}: ${(opt && opt.dataset.brief) || ''}`;
      }
      sel.title = say;
      document.getElementById('terrBtn').title = say;
      renderGen();
    }

    // ---- the generation row: Territory (all Generate needs) → Refine (optional; Describe, required, for a custom territory) → count → Generate ----
    const ICON_WORLD = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#EC540C" stroke-width="2"><rect x="7" y="3" width="10" height="18" rx="2"></rect><circle cx="12" cy="12" r="2" fill="#EC540C" stroke="none"></circle></svg>';
    const ICON_PLUS = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>';
    const ICON_SAMPLER = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1.5"></rect><rect x="13" y="4" width="7" height="7" rx="1.5"></rect><rect x="4" y="13" width="7" height="7" rx="1.5"></rect><rect x="13" y="13" width="7" height="7" rx="1.5"></rect></svg>';
    const ICON_SPARK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"></path></svg>';
    let refineEditing = false;
    function namedWorlds() { return [...document.getElementById('worldSelect').options].filter(o => o.value && !o.value.startsWith('__')); }
    function showCount() {
      const n = VFIELDS.countField.get(), el = document.getElementById('countField');
      document.getElementById('countVal').textContent = `×${n}`;
      el.setAttribute('aria-valuenow', String(n)); el.setAttribute('aria-valuetext', `${n} image${n === 1 ? '' : 's'}`);
    }
    function renderGen() {
      showCount();
      renderPlace();
      const v = document.getElementById('worldSelect').value, custom = v === '__custom__';
      const opt = document.getElementById('worldSelect').selectedOptions[0];
      const [icon, name] = v === '' ? ['', 'Choose a territory'] : custom ? [ICON_PLUS, 'Describe your own'] : v === '__wildcard__' ? [ICON_SPARK, 'Surprise me'] : v === '__sampler__' ? [ICON_SAMPLER, 'Sampler'] : [ICON_WORLD, v];   // just the name (the counts are in the list)
      const ic = document.getElementById('terrIcon');
      if (ic.dataset.v !== v) { ic.innerHTML = icon; ic.dataset.v = v; }
      document.getElementById('terrName').textContent = name;
      const input = document.getElementById('directionInput'), text = input.value.trim();
      const r = document.getElementById('refine');
      r.dataset.state = custom || refineEditing ? 'edit' : text ? 'set' : 'empty';
      r.classList.toggle('required', custom);
      r.classList.toggle('has-text', !!input.value);
      document.getElementById('refineLabel').textContent = custom ? 'Describe' : 'Refine';
      document.getElementById('refineReq').hidden = !custom;
      input.setAttribute('aria-required', String(custom));
      document.getElementById('refineKey').textContent = 'Refine:';
      document.getElementById('refineShown').textContent = text;
      const g = document.getElementById('generateBtn');
      if (!generating) {
        g.classList.remove('running');
        const noMark = !!(project && project.has_mark === false);
        document.getElementById('genLabel').textContent = noMark ? 'Add a mark' : 'Generate';   // images are made around a mark: a project of your own images first needs one
        g.disabled = aiRunning || (custom && !text && !noMark);
        g.title = noMark ? 'This project has no mark yet: add one to generate images around it' : custom && !text ? 'Describe your territory first' : '';   // a tooltip only to say why it is off
      }
      document.getElementById('genHint').hidden = !(project && !plates.length && !generating);   // a new project, until its first batch
    }
    function editRefine() {
      if (generating || aiRunning) return;
      refineEditing = true; renderGen();
      const input = document.getElementById('directionInput');
      input.focus(); input.select && input.select();
    }
    function clearRefine() {
      const input = document.getElementById('directionInput');
      input.value = ''; saveSettings();
      refineEditing = document.activeElement === input; renderGen();
    }
    (() => {
      const input = document.getElementById('directionInput');
      if (!input.addEventListener) return;
      const r = document.getElementById('refine');
      const fit = () => {                                                       // grows with the text, then scrolls
        input.style.height = 'auto'; input.style.height = `${Math.min(280, input.scrollHeight)}px`;
        r.classList.toggle('tall', input.scrollHeight > 26);                     // past one line it drops below the row
      };
      input.addEventListener('input', () => { renderGen(); if (r.classList.contains('open')) fit(); });
      input.addEventListener('focus', () => { refineEditing = true; renderGen(); r.classList.add('open'); fit(); });
      input.addEventListener('blur', () => { refineEditing = false; r.classList.remove('open', 'tall'); input.style.height = ''; input.scrollTop = 0; renderGen(); });
      input.addEventListener('keydown', e => {
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); input.blur(); }   // ⇧↩ for a new line in a brief
      });
    })();
    // the running batch shows on the button itself: "Generating" and a spinner (the footer has the detail; Stop stays there: one control)
    function genRunningLabel() {
      const g = document.getElementById('generateBtn');
      if (!generating) { renderGen(); return; }
      g.classList.add('running');
      document.getElementById('genLabel').textContent = 'Generating';
    }

    // the territory list, one column: Describe your own and Surprise me, then the territories (kept of made); ↑ ↓ and ↩. There is
    // no Mix it up any more (it picked one territory per batch for you: the user would rather pick it)
    // (no search: Custom and Unexpected batches add a territory each, ~30-40 over a project's life)
    let terrActive = 0;
    function terrOptions() {
      const all = [...document.getElementById('worldSelect').options];
      return { worlds: namedWorlds(), custom: all.find(o => o.value === '__custom__'), wild: all.find(o => o.value === '__wildcard__'), sampler: all.find(o => o.value === '__sampler__') };
    }
    function renderTerrMenu() {
      const m = document.getElementById('terrMenu');
      const cur = document.getElementById('worldSelect').value;
      const { worlds, custom, wild, sampler } = terrOptions();
      const item = (v, inner, cls = '', tip = '') => `<div class="tm-item ${cls}" role="option" data-v="${escapeHtml(v)}" aria-selected="${v === cur}"${tip ? ` title="${escapeHtml(tip)}"` : ''}>${inner}</div>`;
      const check = '<svg class="tm-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>';
      // one column: the two ways to a new territory first, then the territories (new ones join at the end)
      let html = '';
      if (custom) html += item('__custom__', `${ICON_PLUS}<span>Describe your own <span class="tm-sub">in your own words</span></span>${check}`);
      if (wild) html += item('__wildcard__', `${ICON_SPARK}<span>Surprise me <span class="tm-sub">Kimi invents a territory</span></span>${check}`);
      const n = Math.min(parseInt(document.getElementById('batchCountSelect').value, 10) || 4, worlds.length);   // the count picks how many territories
      const which = `${n} image${n === 1 ? '' : 's'} from your least tried territories`;   // one each; not random: least tried first
      if (sampler && worlds.length > 1) html += item('__sampler__', `${ICON_SAMPLER}<span>Sampler <span class="tm-sub">${which}</span></span>${check}`);
      if (custom || wild || sampler) html += '<div class="tm-sep"></div>';
      if (worlds.length) {
        // where each comes from, on the right: CORE (built in), INVENTED (Surprise me), CUSTOM (Describe your own); the ones never made a little dimmer
        const row = o => item(o.value, `<span class="tm-name">${escapeHtml(o.value)}</span><span class="tm-origin">${escapeHtml(o.dataset.origin || 'core')}</span>${check}`, 'tm-world' + (+o.dataset.n ? '' : ' unmade'), o.dataset.prompt || o.dataset.brief);   // hover: your brief, or the territory's
        // grouped by where they come from (core, then yours, then Kimi's), a line between the groups
        const order = ['core', 'custom', 'invented'], by = k => worlds.filter(o => (o.dataset.origin || 'core') === k);
        html += '<div class="tm-head"><span>Territories</span></div>' + order.map(by).filter(g => g.length).map(g => g.map(row).join('')).join('<div class="tm-sep"></div>');
      }
      let list = m.querySelector('.tm-list');
      if (!list) {
        m.innerHTML = '<div class="tm-list"></div><div class="tm-more" aria-hidden="true">More below <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg></div>';
        m.tabIndex = -1;
        list = m.querySelector('.tm-list');
        m.addEventListener('scroll', terrMore, { passive: true });
        m.addEventListener('keydown', terrKey);
        list.addEventListener('mousedown', e => e.preventDefault());
        list.addEventListener('click', e => { const it = e.target.closest('.tm-item'); if (it) chooseTerr(it.dataset.v); });
        list.addEventListener('mousemove', e => { const it = e.target.closest('.tm-item'); if (it) { terrActive = [...list.querySelectorAll('.tm-item')].indexOf(it); markTerr(); } });
      }
      list.innerHTML = html;
      markTerr();
      terrMore();
    }
    // "More below" at the foot while the list has more to scroll to (macOS hides scrollbars until you scroll)
    function terrMore() {
      const m = document.getElementById('terrMenu');
      if (m.scrollHeight === undefined) return;
      m.classList.toggle('more', m.scrollTop + m.clientHeight < m.scrollHeight - 4);
    }
    function markTerr() {
      const items = [...document.querySelectorAll('#terrMenu .tm-item')];
      terrActive = Math.max(0, Math.min(items.length - 1, terrActive));
      items.forEach((it, i) => it.classList.toggle('active', i === terrActive));
      if (items[terrActive] && items[terrActive].scrollIntoView) items[terrActive].scrollIntoView({ block: 'nearest' });
    }
    function toggleTerrMenu(e, open) {
      if (e && e.stopPropagation) e.stopPropagation();
      const m = document.getElementById('terrMenu');
      open = open === undefined ? m.hidden : open;
      if (open && (generating || aiRunning)) return;
      m.hidden = !open;
      const btn = document.getElementById('terrBtn');
      btn.setAttribute('aria-expanded', String(open));
      if (!open) return;
      renderTerrMenu();
      terrMore();              // one column (scrolls past what fits: a project's territories grow)
      const items = [...m.querySelectorAll('.tm-item')];
      terrActive = Math.max(0, items.findIndex(it => it.getAttribute('aria-selected') === 'true'));
      markTerr();
      if (m.focus) m.focus();                                                // ↑ ↓ ↩ and Esc work at once
    }
    function terrKey(e) {
      const items = [...document.querySelectorAll('#terrMenu .tm-item')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); terrActive += e.key === 'ArrowDown' ? 1 : -1; markTerr(); }
      else if (e.key === 'Enter') { e.preventDefault(); const it = items[terrActive]; if (it) chooseTerr(it.dataset.v); }
      else if (e.key === 'Escape') { e.preventDefault(); toggleTerrMenu(null, false); document.getElementById('terrBtn').focus(); }
    }
    function chooseTerr(v) {
      const sel = document.getElementById('worldSelect');
      toggleTerrMenu(null, false);
      if (sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event('change')); }
      if (v === '__custom__') { editRefine(); return; }                     // its description comes first
      document.getElementById('terrBtn').focus();
    }
    document.addEventListener('click', e => { const m = document.getElementById('terrMenu'); if (!m.hidden && !(e.target.closest && e.target.closest('#terrMenu, #terrBtn'))) toggleTerrMenu(null, false); });

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
          o.dataset.prompt = w.prompt || '';                                       // Describe your own: your words, as written
          o.dataset.kept = w.kept; o.dataset.n = w.n; o.dataset.wild = w.wildcard ? '1' : ''; o.dataset.origin = w.origin || (w.wildcard ? 'invented' : 'core');
          o.textContent = w.name;
          sel.appendChild(o);
        });
        sel.value = cur || savedWorld;
        savedWorld = '';
        if (!sel.value) sel.value = (namedWorlds()[0] || { value: '__custom__' }).value;   // never Mix it up (gone): the one used last, else the first
        updateDirectionHint();
        syncSelects();
      } catch (e) {}
    }

    // ---- live generation progress (lives in the status strip) ----
    const prog = { t0: 0, timer: null, slots: [], titles: [], world: '', stage: '', note: '', total: 0, summary: '' };
    function fmtElapsed(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
    function progRender() {
      refreshPending();
      if (generating) genRunningLabel();
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
      prog.t0 = Date.now(); prog.slots = []; prog.titles = []; prog.worlds = []; prog.marks = []; prog.positions = []; prog.why = []; prog.world = ''; prog.stage = 'invent';
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
      ['worldSelect', 'directionInput', 'targetSelect', 'markSelect', 'placeBtn', 'batchCountSelect', 'modelSelect', 'generateBtn', 'terrBtn', 'refineOpen', 'refineSet', 'refineClear'].forEach(id => { document.getElementById(id).disabled = lockGen; });
      document.getElementById('countField').setAttribute('aria-disabled', String(!!lockGen));
      genRunningLabel();
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
    // ---- your own images: chosen (Add images) or dropped on the grid; each drawn here into the film's frame (1080 x 1920, centred: the
    // page reads every format the browser does, HEIC in the Mac app) and added to the project, uploaded, never checked for the mark ----
    let uploading = false;
    const UPLOADABLE = /\.(jpe?g|png|webp|gif|heic|heif|tiff?|bmp|avif)$/i;
    async function frameImage(file) {
      const url = URL.createObjectURL(file);
      try {
        const im = new Image(); im.src = url; await im.decode();
        const W = 1080, H = 1920, k = Math.max(W / im.naturalWidth, H / im.naturalHeight), w = im.naturalWidth * k, h = im.naturalHeight * k;
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        c.getContext('2d').drawImage(im, (W - w) / 2, (H - h) / 2, w, h);   // covers the frame, centred
        return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('not drawn'))), 'image/jpeg', 0.92));
      } catch (e) { throw new Error('could not be read as an image'); }
      finally { URL.revokeObjectURL(url); }
    }
    async function uploadImages(fileList) {
      const files = [...(fileList || [])].filter(f => /^image\//.test(f.type) || UPLOADABLE.test(f.name));
      if (!files.length) return;
      if (!project) { setStatus('Make or open a project first, then add images to it.'); return; }
      if (aiRunning || uploading) { setStatus(aiRunning ? 'Wait until the AI order ends.' : 'Images are being added: wait a moment.'); return; }
      uploading = true; applyLocks();
      let added = 0;
      const failed = [];
      try {
        for (const [i, f] of files.entries()) {
          setStatus(`Adding ${i + 1} of ${files.length}: ${f.name}…`);
          try {
            const blob = await frameImage(f);
            const r = await (await fetch(`/api/upload-image?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: forProject({ 'Content-Type': 'image/jpeg' }), body: blob })).json();
            if (!r.ok) throw new Error(r.error || 'it was not added');
            added++;
          } catch (e) { failed.push(`${f.name}: ${e.message}`); }
        }
      } finally { uploading = false; applyLocks(); }
      await loadState();
      setStatus(`${added} image${added === 1 ? '' : 's'} added${failed.length ? ` · ${failed.length} could not be added (${failed.slice(0, 2).join('; ')})` : ''}`);
    }
    // files dragged over the window (a card dragged inside the grid carries none): a dim and a tray that says what a drop does; a drop
    // anywhere adds them, at the end of the Selection, from the Trash too. A depth count, so passing over child elements never flickers
    (() => {
      const zone = document.getElementById('dropZone');
      if (!zone || !window.addEventListener) return;
      const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
      const inForm = () => document.getElementById('projectModal').classList.contains('open');   // the project form takes its own drops (a mark)
      let depth = 0, hideTimer = null;
      const show = e => {
        clearTimeout(hideTimer);
        const n = e.dataTransfer.items ? [...e.dataTransfer.items].filter(it => it.kind === 'file').length : 0;
        document.getElementById('dropTitle').textContent = n ? `Add ${n} image${n === 1 ? '' : 's'} to ${project.name}` : `Add images to ${project.name}`;
        const bar = document.querySelector('.topbar'), st = document.getElementById('statusText');
        zone.style.setProperty('--dim-top', `${bar ? bar.getBoundingClientRect().bottom : 56}px`);
        const stTop = st && st.offsetHeight ? st.getBoundingClientRect().top : innerHeight;      // the batch's status bar showing: 12 px above it
        zone.style.setProperty('--tray-b', `${stTop < innerHeight ? innerHeight - stTop + 12 : 28}px`);
        zone.hidden = false;
        void zone.offsetWidth;                                               // laid out first, so the tray rises from 12 px lower
        zone.classList.add('on');
      };
      const hide = () => {
        depth = 0;
        zone.classList.remove('on');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { if (!zone.classList.contains('on')) zone.hidden = true; }, 160);   // after the tray has sunk back
      };
      addEventListener('dragenter', e => { if (!hasFiles(e) || inForm()) return; e.preventDefault(); if (depth++ === 0 && project) show(e); });
      addEventListener('dragleave', e => { if (!hasFiles(e) || inForm()) return; depth = Math.max(0, depth - 1); if (!depth) hide(); });
      addEventListener('dragover', e => { if (!hasFiles(e) || inForm()) return; e.preventDefault(); e.dataTransfer.dropEffect = project ? 'copy' : 'none'; });
      addEventListener('drop', e => {
        if (!hasFiles(e) || inForm()) return;
        e.preventDefault(); hide();                                          // never the browser opening the file instead
        uploadImages(e.dataTransfer.files);
      });
    })();
    const isBusy = () => generating || aiRunning || exporting || purging || uploading;
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
      prog.world = new Set(ideas.map(i => i.world)).size > 1 ? 'Sampler' : (ideas[0] && ideas[0].world) || '';   // the Sampler: many territories
      prog.slots = ideas.map(() => 'wait');
      prog.titles = ideas.map(i => i.title);
      prog.worlds = ideas.map(i => i.world || prog.world);
      prog.marks = ideas.map(i => i.mark || 'main'); prog.positions = ideas.map(i => (i.placement && i.placement.kind) || 'exact');
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
              body: JSON.stringify({ title: item.title, prompt: item.prompt, guide: item.guide || 'dark', world: item.world, idea: item.idea, target: item.target || 'exact', placement: item.placement || null, mark: item.mark || null, keep: !!item.keep, model })
            });
            genData = await genRes.json();
          } catch (e) {
            genData = { ok: false, offline: true, error: 'The app did not answer' };   // the page lost its own server, or the network
          }
          if (!genData.offline || genData.project_changed) break;
          // Krea answers the connection check but this image keeps failing as if offline (a gateway error, a timeout): after 3
          // rounds it fails on its own (Retry covers it) instead of being sent again until Stop, a new paid job each time
          if (++rounds >= 3) { genData = { ...genData, offline: false }; break; }
          prog.slots[idx] = 'wait';
          await waitForConnection();
          if (batchStop) return;
        }
        if (genData.project_changed) { batchStop = true; prog.slots[idx] = 'wait'; return; }
        if (genData.duplicate) { prog.slots[idx] = 'ok'; prog.why[idx] = 'already being made: it arrives by itself'; left.delete(idx); keep(); progRender(); return; }
        if (genData.needs_auth) { authFailed = true; prog.slots[idx] = 'err'; prog.why[idx] = 'Krea login needed: Settings › Connect Krea'; return; }
        if (!genData.ok) {
          // a moderation refusal is not a failure to retry: nothing was made (and nothing goes to the Trash), its bar is grey
          prog.slots[idx] = genData.code === 'content_policy' ? 'blocked' : 'err';
          prog.why[idx] = genData.code === 'content_policy' ? genData.error : plainError(genData.error || 'Generation failed');   // the server's own words there are plain
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
          if (genData.qa_issues && genData.qa_issues.length) prog.why[idx] = `Mark check: ${genData.qa_issues[0]}`;
          prog.note = `“${item.title}” failed the mark check → Trash`;
        }
        progRender();
        await loadState();
      };
      const queue = ideas.map((item, idx) => [item, idx]);                  // 3 in parallel
      await Promise.all([0, 1, 2].map(async () => {
        while (queue.length) {
          const [item, idx] = queue.shift();
          try { await runOne(item, idx); } catch (e) { prog.slots[idx] = 'err'; prog.why[idx] = plainError(e); left.delete(idx); failedItems.push(item); keep(); }
        }
      }));
      loadWorlds();
      // the summary stays one short line (the status bar is one line): counts only; each bar's hover gives its image's reason,
      // the summary's own hover the reasons together
      const failed = prog.slots.filter(x => x === 'err').length, blocked = prog.slots.filter(x => x === 'blocked').length, notMade = left.size;
      const parts = [`${added} added`];
      if (trashedByQa) parts.push(`${trashedByQa} to Trash by the mark check`);
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
      const made = new Set([...plates.map(p => p.title), ...making]);       // made meanwhile, or being made now (a reload let them go on on the server): not again
      items = items.filter(it => !made.has(it.title));
      if (!items.length) { savePending([], model); batchActions([]); setStatus('Those images were made after all.'); return; }
      if (!ensureKreaReady()) return;
      setGenerating(true);
      progStart(items.length);
      try { await runBatch(items, model); } catch (e) { progStop(plainError(e)); } finally { setGenerating(false); }
    }
    // opening the page: a batch left unfinished (Stop, a reload, a quit, a crash) is offered again
    function offerPending() {
      const p = readPending();
      if (!p || generating) return;
      const made = new Set([...plates.map(x => x.title), ...making]);       // being made now on the server: not offered again
      const items = p.items.filter(it => !made.has(it.title));
      if (!items.length) { savePending([], p.model); return; }
      document.getElementById('statusText').dataset.idle = '';
      prog.stage = 'render'; prog.world = items[0].world || 'Unfinished batch'; prog.slots = items.map(() => 'wait'); prog.titles = items.map(i => i.title); prog.worlds = items.map(i => i.world || prog.world); prog.marks = items.map(i => i.mark || 'main'); prog.positions = items.map(i => (i.placement && i.placement.kind) || 'exact'); prog.why = items.map(() => '');
      prog.total = items.length; prog.summary = `${items.length} image${items.length === 1 ? '' : 's'} of the last batch ${items.length === 1 ? 'wasn\'t' : 'weren\'t'} made`;
      batchActions([
        { label: 'Resume', run: () => retryBatch(items, p.model) },
        { label: 'Discard', run: () => { savePending([], p.model); batchActions([]); prog.summary = ''; document.getElementById('statusText').dataset.idle = '1'; refreshIdle(); } },
      ]);
    }
    async function generateImages() {
      if (blockedByAi()) return;
      if (!project) { setStatus('Make a project or import one first: the project menu, at the top.'); openProjectMenu(); return; }
      if (project.has_mark === false) { openProjectForm('edit'); return; }   // no mark yet: Project settings, where + Add a mark is
      if (!ensureKimiReady() || !ensureKreaReady()) return;

      const model = document.getElementById('modelSelect').value;
      const kimiModel = document.getElementById('kimiModelSelect').value;
      const count = parseInt(document.getElementById('batchCountSelect').value, 10) || 4;
      const worldChoice = document.getElementById('worldSelect').value;
      if (!worldChoice) { setStatus('Choose a territory first.'); toggleTerrMenu(null, true); return; }   // the territories have not loaded yet
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
          body: JSON.stringify({ count, pair: false, kimi_model: kimiModel, world: worldChoice, direction, target: document.getElementById('targetSelect').value || 'exact', mark: document.getElementById('markSelect').value || 'main', keep: document.getElementById('keepCheck').checked })
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
        const target = document.getElementById('targetSelect').value || 'exact', keep = document.getElementById('keepCheck').checked;   // each image keeps the batch's choices and the place its scene was written for (a Resume too)
        await runBatch(invData.ideas.map(i => ({ ...i, target, keep })), model);
        if (worldChoice === '__custom__' && invData.world) {                     // your territory exists now: the next batch carries on in it
          await loadWorlds();
          const sel = document.getElementById('worldSelect');
          if ([...sel.options].some(o => o.value === invData.world)) {
            sel.value = invData.world;
            document.getElementById('directionInput').value = '';
            saveSettings(); updateDirectionHint(); syncSelects();
          }
        }
      } catch (e) {
        progStop(plainError(e));
      } finally {
        setGenerating(false);
      }
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
        document.getElementById('updateMsg').textContent = `Phosphene ${u.version} is ready`;
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
    setInterval(() => { if (!pendingUpdate) checkForUpdate(); }, 30 * 60 * 1000);   // an app left open still hears of a new version (it asked only at launch)
    // ---- dev only: a taste log. Like / Dislike marks the sound (and film) playing now with every setting; Copy puts them all on the
    // clipboard as JSON for the agent to tune Random on (the user's ask, 2026-10-30: "it will go once we're done"). Shown in the development
    // window (Vite, port 5173); ⌃⌥L turns it on or off anywhere (remembered). Kept in this browser only (studioTaste), never sent.
    const TASTE_KEY = 'studioTaste';
    const tasteLog = () => { try { return JSON.parse(localStorage.getItem(TASTE_KEY) || '[]'); } catch (e) { return []; } };
    function tasteShown() { try { const f = localStorage.getItem('studioTasteBar'); return f ? f === '1' : location.port === '5173'; } catch (e) { return location.port === '5173'; } }
    function syncTasteBar() { const b = document.getElementById('tasteBar'); if (!b) return; b.hidden = !tasteShown(); document.getElementById('tasteCopyBtn').textContent = `Copy ${tasteLog().length}`; }
    function toggleTasteBar() { try { localStorage.setItem('studioTasteBar', tasteShown() ? '0' : '1'); } catch (e) {} syncTasteBar(); }
    function tasteMark(verdict) {
      const noteEl = document.getElementById('tasteNote'), log = tasteLog();
      const film = Object.fromEntries(FILM_SETTINGS.map(id => { const el = document.getElementById(id); return [id, el ? (el.type === 'checkbox' ? el.checked : el.value) : null]; }));
      const r = rhythmFor(activePlates().length);
      log.push({
        n: log.length + 1, at: new Date().toISOString(), verdict, note: noteEl.value.trim(),
        project: project ? project.name : null, group: currentGroup, images: activePlates().length,
        playing: isPlaying, type: document.getElementById('characterSelect').value,
        cutsPerSecond: +rhythmCutsPerSecond().toFixed(2), seconds: r && r.end ? +(r.end / 30).toFixed(1) : null,
        sound: musicOn() ? synthParams() : null,                             // what the engine plays, exactly (seed included: it can be played again)
        settings: film,                                                     // the controls as set (to reapply), sound, rhythm and look
      });
      try { localStorage.setItem(TASTE_KEY, JSON.stringify(log.slice(-500))); } catch (e) {}
      noteEl.value = '';
      syncTasteBar();
      setStatus(`${verdict === 'like' ? 'Liked' : 'Disliked'} · ${log.length} marked. Copy when you're done.`);
    }
    async function tasteCopy() {
      const log = tasteLog();
      if (!log.length) { setStatus('Nothing marked yet: Like or Dislike a sound while it plays.'); return; }
      const text = JSON.stringify({ what: 'Phosphene taste log', marks: log }, null, 1);
      try { await navigator.clipboard.writeText(text); setStatus(`${log.length} marks copied as JSON: paste them to the agent.`); }
      catch (e) {                                                          // no clipboard here: the text, selected, to copy by hand (⌘C)
        const done = askConfirm('Copy the marks', '', 'Done'), ta = document.createElement('textarea');
        ta.readOnly = true; ta.value = text; ta.style.cssText = 'width:100%;height:240px;font:11px var(--mono, monospace)';
        document.getElementById('confirmBody').appendChild(ta); ta.focus(); ta.select();
        await done;
      }
    }
    async function tasteClear() {
      if (!tasteLog().length) return;
      if (!(await askConfirm('Clear the marks?', `${tasteLog().length} marks go. Copy them first if you haven't.`, 'Clear'))) return;
      try { localStorage.removeItem(TASTE_KEY); } catch (e) {}
      syncTasteBar();
    }
    syncTasteBar();
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
      // the film as it is now: everything the export sends is read here, once. Changes made while it renders (the sound switched off,
      // the tempo, the group) go into the next export, never half into this one (the end used to read them again: a silent film, or
      // the sound of the export before)
      const film = {
        bpm: bpmValue(),
        multiple: parseFloat(document.getElementById('multSelect').value),
        invert_mode: document.getElementById('invertSelect').value,
        rhythm: rhythmMode(),
        ...(changeParams() ? { end_ms: changeParams().end_ms } : {}),   // the change's end speed, for the file's name
        music: musicOn() ? 'synth' : 'off',
        zoom_mode: document.getElementById('zoomSelect').value,
        zoom_amount: parseFloat(document.getElementById('zoomAmt').value) || 0,
        trail: (parseFloat(document.getElementById('trailRange').value) || 0) / 100,
        ...(currentGroup === 'all' ? {} : { files: activePlates().map(p => p.filename) }),   // a group: just its images
        ...(editOf(currentEdit) ? { edit: editOf(currentEdit).name } : {}),   // the file is named after the edit
      };
      const filmSec = rhythmFor(activePlates().length).end / 30;
      try {
        if (film.music === 'synth') {                      // the same WebAudio drone as the preview, rendered offline and sent along
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
          body: JSON.stringify({ ...film, frames })                         // drawn here: the server only encodes them
        });
        const data = await res.json();
        if (data.ok) {
          const link = document.getElementById('downloadLink');
          link.href = data.video_url;
          link.setAttribute('download', data.filename || 'Demo.mp4');
          document.getElementById('exportFile').textContent = data.filename || 'MP4';
          link.click();                                                  // the file saves itself (to Downloads)
          ok = true;
          noteExportRate(filmSec, (performance.now() - t0) / 1000);
          drawInfo();
          setStatus(`Export ready, downloading: ${data.images} images, ${data.seconds}s.`);
        } else {
          setStatus(`Export failed: ${data.error || 'unknown error'}`);
        }
      } catch (e) {
        setStatus(`Export failed: ${plainError(e)}`);
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
    ['batchCountSelect', 'modelSelect', 'worldSelect', 'directionInput', 'targetSelect'].forEach(id => document.getElementById(id).addEventListener('change', saveSettings));
    document.getElementById('worldSelect').addEventListener('change', () => { document.getElementById('directionInput').value = ''; saveSettings(); updateDirectionHint(); });
    loadWorlds();
    (async () => {
      const slow = setTimeout(() => { document.getElementById('loaderMsg').textContent = 'Still loading (checking new images)…'; }, 4000);
      try {
        await loadState();
        if (!history.length) { clearTimeout(settleTimer); settled = settingsSnap(); }   // the library fitted the sliders to it: not a change of yours
      } catch (e) {
        document.getElementById('loaderMsg').textContent = window.__TAURI__ ? 'Starting Phosphene…' : 'Could not reach the server. Is it running? Retrying…';   // in the app the server is its own engine, not a place to reach
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
          if (window.__reloadWhenIdle && !isBusy()) location.reload();          // a page update held during the job (devguard.js)
          libraryMoved(v.state);
        } catch (e) {}  // server restarting: try again next tick
      }, 1500);
    })();
  

// Inline handlers in the markup (onclick=...) need these on window now that the code is an ES module.
Object.assign(window, {
  installUpdate,
  isBusy, setStatus,
  exportProject, importProject, importProjectPath, chooseProjectFile, closeProjectMenu, saveSettings, deleteProject,
  downloadShown, setThumbSizeAt, openViewer, closeViewer, viewerStep, toggleTerrMenu, editRefine, clearRefine, closeGroupMenu, showNewGroupForm,
  openProjectMenu, switchProject, openProjectForm, closeProjectForm, saveProject, psKey, psSelect, psSetProject, psSetMark, psColour, psColourAdd, psColourKey, psMakeDefault, psRemove, psPick, psFileChosen, psCancelRead,
  removeChange,
  startAiOrder,
  toggleAiPanel,
  cardClick,
  confirmAnswer,
  deleteSelected,
  emptyTrash,
  selectAllTrash,
  toggleViewerInfo,
  viewerTrash,
  copyPromptText,
  tasteMark,
  tasteCopy,
  tasteClear,
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
  psNoMark,
  uploadImages,
  frameImage,
  togglePlaceMenu,
  trashPicked,
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
