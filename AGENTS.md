# AGENTS.md

Demo 9:16 match-cut film project. Every shot places the circular orbital logo at exact dead-center (50%, 50%), 18% of frame width, in a different material/scene.

## Layout
- `studio/server.py` — the API server (port 8765, `PORT` env to change): JSON API, plates and exported video. It also serves the built page from `studio/web/dist` if `npm run build` was run.
- `studio/web/` — the frontend (Vite, vanilla JS): `index.html` (markup), `src/app.js`, `src/style.css`, `vite.config.js` (proxies `/api`, `/assets`, `/outputs` to :8765). Inline `onclick=` handlers need the function exported at the bottom of `app.js` (a test checks this).
- `studio/krea_mcp_client.py` — Krea image generation over MCP (`https://api.krea.ai/mcp`). OAuth token is read from `~/.local/share/opencode/mcp-auth.json`.
- `studio/qa_engine.py` — logo QA on generated plates (needs `demo-info/design-system/logo-cream.png`). `demo-info/` also holds the design-system PDFs and the playbook: reference, not read by code.
- `studio/chapters.py` (territories), `diversity.py` (random axes), `taste.py` (learning from kept/trashed), `critic.py` (optional AI scoring, off by default), `cutplan.py` (preview/export frame plan, invert, zoom), `sequences.py` (Manual/AI orders), `editor.py` + `features.py` (AI ordering), `bench.py` (scripted generation runs, optional).
- `studio/gen_log.py` — the written record of what the server did (`studio/generation_log.jsonl`, gitignored, rotates at 5 MB): server starts, Kimi batches, every image (all retries, logo check, seconds), AI orders, exports, deletions. Read it with `npm run log` (or `python3 studio/gen_log.py --failures`), or `GET /api/log`. An `image_start` with no result followed by a `server_start` means a restart cut the image short.
- `studio/curation_state.json` — approvals, trash, order, titles, prompts, per-plate model. Committed on purpose: it is the selection history.
- `assets/ai-plates/` — generated plates (committed). `outputs/*.mp4` is gitignored.

## Run
```fish
npm install        # once
npm run dev        # API with auto-restart (studio/dev.py) + Vite with hot reload -> http://localhost:5173
```
Separately: `npm run api` (backend only, restarts when `studio/*.py` changes, the page reloads itself) and `npm run web` (Vite only). `npm run build` writes `studio/web/dist` and the backend then serves the page at :8765. Needs Python 3 with Pillow, ffmpeg at `/opt/homebrew/bin/ffmpeg`, Node 20+. The user runs these themselves; do not start or kill their server unless asked. Do not restart the API mid-generation.

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
3. Tempo: BPM slider + cuts-per-beat multiple in preview and export; music is time-stretched from 136 BPM.

4. Player effects (`studio/cutplan.py`, mirrored by `planAt`/`zoomScale` in `studio/web/src/app.js`; tests share vectors): Invert (every image followed by an inverted grey/colour copy, as in Soiltone) and Zoom (slow in/out inside each cut, as in Moverunion: measured ~0.15-0.45% zoom OUT over a 5-frame cut). Both apply to preview and export.

5. Orders (`studio/sequences.py`): exactly two orders of the selection, **Manual** (always there) and **AI** (made by Order with AI; redoing replaces it, after a confirmation). Both are editable by dragging; the AI order remembers its original so "↺ Back to the AI's order" resets it. Switching loses nothing; the player follows the switch. Restored/new images go to the end of both. While the AI orders, the server (409) and the page lock everything that changes the selection, and ordering cannot start while images generate. "Use as my Manual order…" (with confirmation) copies the AI order, cut included, over Manual and keeps the AI order; the divider's "Include them all" clears a best-N cut. AI ordering (`studio/editor.py` + `studio/features.py`): Kimi (vision, contact sheet) writes the edit brief (opener, closer, peaks, weights), a deterministic beam search orders by cut kind (flip / shape echo / colour hand-off), no three of a kind in a row, territory variety, an energy arc; "Best N" sets `cut_off` (preview and export use only the first N; the rest sit below a "left out" divider). Runs as a background job (`/api/order-ai`, `/api/order-ai-status`).

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
