# AGENTS.md

Demo 9:16 match-cut film project. Every shot places the circular orbital logo at exact dead-center (50%, 50%), 18% of frame width, in a different material/scene.

## Layout
- `studio/server.py` — the API server (port 8765, `PORT` env to change): JSON API, plates and exported video. It also serves the built page from `studio/web/dist` if `npm run build` was run.
- `studio/web/` — the frontend (Vite, vanilla JS): `index.html` (markup), `src/app.js`, `src/style.css`, `vite.config.js` (proxies `/api`, `/assets`, `/outputs` to :8765). Inline `onclick=` handlers need the function exported at the bottom of `app.js` (a test checks this).
- `studio/krea_mcp_client.py` — Krea image generation over MCP (`https://api.krea.ai/mcp`). OAuth token is read from `~/.local/share/opencode/mcp-auth.json`.
- `studio/qa_engine.py` — logo QA on generated plates (needs `demo-info/design-system/logo-cream.png`). `demo-info/` also holds the design-system PDFs and the playbook: reference, not read by code.
- `studio/chapters.py` (territories), `diversity.py` (random axes), `taste.py` (learning from kept/trashed), `critic.py` (optional AI scoring, off by default), `cutplan.py` (preview/export frame plan, invert, zoom), `web/src/drone.js` (the synthesized drone, WebAudio), `sequences.py` (Manual/AI orders), `editor.py` + `features.py` (AI ordering), `bench.py` (scripted generation runs, optional).
- `studio/gen_log.py` — the written record of what the server did (`studio/generation_log.jsonl`, gitignored, rotates at 5 MB): server starts, Kimi batches, every image (all retries, logo check, seconds), AI orders, exports, deletions. Read it with `npm run log` (or `python3 studio/gen_log.py --failures`), or `GET /api/log`. An `image_start` with no result followed by a `server_start` means a restart cut the image short.
- `studio/curation_state.json` — approvals, trash, order, titles, prompts, per-plate model. Committed on purpose: it is the selection history.
- `assets/ai-plates/` — generated plates (committed). `outputs/*.mp4` is gitignored.

## Run
```fish
npm install        # once
npm run dev        # API with auto-restart (studio/dev.py) + Vite with hot reload -> http://localhost:5173
```
Separately: `npm run api` (backend only, restarts when `studio/*.py` changes, the page reloads itself) and `npm run web` (Vite only). `npm run build` writes `studio/web/dist` and the backend then serves the page at :8765. Needs Python 3 with Pillow (`pip3 install -r requirements.txt`), ffmpeg at `/opt/homebrew/bin/ffmpeg`, Node 20+. The user runs these themselves; do not start or kill their server unless asked. Do not restart the API mid-generation.

## Secrets
- The Kimi API key lives in `studio/.secrets.json` (gitignored) or `KIMI_API_KEY` / `MOONSHOT_API_KEY`. Never write it into `curation_state.json` or any committed file.

## Conventions
- Prompts must keep the logo at dead-center, 18% width, with no extra rings or duplicate logos.
- Brand palette: orange #EC540C, pink #F64570, blue #5D8FF4, oxblood #381313, ink #1A1A1A, cream #FEFFE7.
- Default image model is `google/nano-banana-pro`; other Krea models are built in `build_model_input`.
- Use `AGENTS.md` for agent instructions; do not add a `CLAUDE.md`.

## Roadmap
Done:
1. Taste loop (`studio/taste.py`): kept = liked, trashed = disliked (logo-QA auto-trash is tracked separately in `qa_failed`), liked/disliked brief injected into prompt generation, per-model scorecard in Settings, "Auto" model that exploits/explores by score. Added Ideogram 4.5, Luma UNI-1, Meta Muse, Runway Gen-4 (all take the logo guide image).
2. Diversity (`studio/diversity.py`): no fixed categories; each shot is a random combo of subject/material/setting/light/camera/logo/palette, recent values avoided, near-duplicate prompts dropped (Jaccard novelty).
3. Tempo: BPM slider + cuts-per-beat multiple in preview and export.

4. Player effects (`studio/cutplan.py`, mirrored by `planAt`/`zoomScale` in `studio/web/src/app.js`; tests share vectors): Invert (every image followed by an inverted grey/colour copy, as in Soiltone) and Zoom (slow in/out inside each cut, as in Moverunion: measured ~0.15-0.45% zoom OUT over a 5-frame cut). Both apply to preview and export.

5. Orders (`studio/sequences.py`): exactly two orders of the selection, **Manual** (always there) and **AI** (made by Order with AI; redoing replaces it, after a confirmation). Both are editable by dragging; the AI order remembers its original so "↺ Back to the AI's order" resets it. Switching loses nothing; the player follows the switch. Restored/new images go to the end of both. While the AI orders, the server (409) and the page lock everything that changes the selection, and ordering cannot start while images generate. "Use as my Manual order…" (with confirmation) copies the AI order, cut included, over Manual and keeps the AI order; the divider's "Include them all" clears a best-N cut. AI ordering (`studio/editor.py` + `studio/features.py`): Kimi (vision, contact sheet) writes the edit brief (opener, closer, peaks, weights), a deterministic beam search orders by cut kind (flip / shape echo / colour hand-off), no three of a kind in a row, territory variety, an energy arc; "Best N" sets `cut_off` (preview and export use only the first N; the rest sit below a "left out" divider). Runs as a background job (`/api/order-ai`, `/api/order-ai-status`).

6. Cuts and music (`studio/web/src/drone.js`, mirrored in the page by `cutAt`/`planAt`). The Video tab's **Speed** is **Flat** (every cut the same length from Tempo and Multiple, as in Helione and Moverunion) or **Variable** (as in the references: Ecwora holds 3-frame cuts for ~45% of the clip, then eases to ~21 frames over its last ~12 cuts; Soiltone the same. Start length, End length, **Change over** N cuts (its slider range is the number of cuts of the selection, so it follows added and removed images and invert pairs) and **Change at** the end (a landing, default) or the start (a build-up). The change is geometric, each cut a constant ratio of the one before; `cutplan.variable_timeline` / `variableStarts` (shared vectors), 50-1500 ms at 30 fps, timeline in frames with frames_per_cut = 1; export body `rhythm: "variable", start_ms, end_ms, ramp, at`; file name `-var100to600ms-`). The landing lasts the same however many images there are. Flat is the special case start == end. The drone's pump and clicks follow whatever cut times the page has, so the sound speeds up and slows down with the picture. The Music tab's **Source** is Off or **Synthesized** (`drone.js`, WebAudio, no server): one stereo drone modelled on measurements of the reference clips (they are not drum tracks but a continuous dark sub-bass bed: 43-54 Hz carries 65-90% of the energy, almost nothing above 2 kHz; the Soiltone/Ecwora one is ~54 Hz sub, unison saw pad, tonal 215-516 Hz cluster, wide, in a reverb room). Settings 0-100, all on the panel: Pulse (the bed pumps on each cut), Low end, Power (unison + saturation), Space (room), Bright, Width, Pitch (root 38-71 Hz), Chord (dark cluster = the measured one, open fifth, minor, suspended), Movement (LFO speed), Echo (dark feedback echo timed to the cuts). **Random sound** (`randomMusic`, ranges in `RANDOM_RANGES`) draws every setting inside ranges that keep it a dark, heavy drone; an e2e test renders random draws through the real engine and checks they stay sub-heavy and level. The drone plays live in the page: sliders and tempo changes swap the sound in ~40 ms from where the picture is (no render, no spinner). The export renders the same graph offline in the page (`OfflineAudioContext`, ~0.5 s), leveled and glued, and uploads the WAV (`POST /api/export-audio`, kept in `studio/.export/`) just before `/api/export-video` with `music: "synth"`; ffmpeg muxes it as AAC. Preview and export are one engine; an e2e test measures the offline render against the reference numbers (sub 40-65 Hz, >60% below 80 Hz, <2% above 2 kHz, RMS 0.17). The sound has not been judged by ear by the agent. A user's own track was built (hit/note/beat analysis with numpy, cuts on the music) and removed on purpose: the user mixes a silent export with their track in a video editor. Zoom stays per cut (a continuous zoom across an image and its inverted copy was tried and rejected). Plates are also served resized (`/api/thumb?f=&w=360|540`, cached in `studio/.thumbs/`, gitignored): the grid and the preview use them, not the full-size files.

Quality reference: `inspiration/soiltone-inspo.mp4` — 8s, ~48 cuts, each scene shown as a color/mono twin pair, one hero subject, logo crisp at dead-center. Quality bar lives in `QUALITY_BAR` in `server.py`.

Caveat: the 223 plates trashed before `qa_failed` existed can't be told apart (manual vs QA), so older model scores are noisy.

## Git
History was rewritten on 2026-10-25 to drop deleted plates and legacy assets (`.git` 744 MB -> 100 MB; all plates are Git LFS). A full backup of the old `.git` is in `~/Downloads/old-git-backup-20261025`. On a new machine: `git lfs install && git clone <repo>` (or `git lfs pull` after cloning) to get the images.
Agents commit and push to `origin` after every change they make (not on a timer). Plates under `assets/ai-plates/*.jpg` go through Git LFS (`.gitattributes`). Never commit `studio/.secrets.json`.

## Tests
```fish
python3 -m venv --system-site-packages .venv; .venv/bin/pip install -r requirements-dev.txt   # once
.venv/bin/python -m pytest studio/tests -q
```
~280 tests, ~35s (~16s without the browser ones: `pytest studio/tests --ignore=studio/tests/test_e2e.py`), no network, no Krea credits, never touches the real state or plates (fixtures redirect paths to a temp dir). Covers taste, worlds, diversity, state/secrets, ordering, QA cache, Kimi parsing and batch writing (fake LLM), critic, Krea client (fake HTTP), logo QA on synthetic plates, bench, dev runner, and the page's JavaScript (`studio/tests/js/*.cjs`, `npm test`, run through node with a fake DOM and fake server, including the full Generate flow). `studio/tests/e2e/*.e2e.test.cjs` (4 files, run in parallel, each with its own Vite and fake API via `harness.cjs`) drive the real page in headless Brave/Chrome (Playwright, `playwright-core`) against Vite plus a fake API (`fakeapi.cjs`): layout, trash select/delete with loader, generate progress and locking, player effects, export link. Set `E2E_SHOTS=/dir` to save screenshots, `BROWSER_PATH` to choose a browser. The real HTTP endpoints are deliberately not tested. Run the tests before committing; add a test with every bug fix. `test_endpoints.py` starts the real server on a random port (temp state, fake Krea/Kimi) so a deleted or broken route fails a test. A long job (generation, AI order, export) marks the server busy (`/api/busy`): `dev.py` waits for idle before restarting, the page does not reload under a running job and asks before being closed. `test_build_full_prompt_keeps_exact_position_wording` guards the logo position text.
