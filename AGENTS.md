# AGENTS.md

Demo 9:16 match-cut film project. Every shot places the circular orbital logo at exact dead-center (50%, 50%), 18% of frame width, in a different material/scene.

## Layout
- `render.py` — original headless PIL + ffmpeg renderer (30s, 136 BPM, beat-locked to `music/warehouse-tension.mp3`).
- `studio/server.py` — the only server (port 8765, `PORT` env to change). Serves `studio/index.html` and the JSON API. No separate frontend server.
- `studio/krea_mcp_client.py` — Krea image generation over MCP (`https://api.krea.ai/mcp`). OAuth token is read from `~/.local/share/opencode/mcp-auth.json`.
- `studio/qa_engine.py` — logo QA on generated plates. `studio/diegetic_engine.py` — repairs failed plates.
- `studio/prompts.json` — seed prompts. `studio/curation_state.json` — approvals, trash, order, titles, prompts, per-plate model. Committed on purpose: it is the selection history.
- `assets/ai-plates/` — generated plates (committed). `outputs/*.mp4` is gitignored.

## Run
```fish
cd studio
/opt/homebrew/bin/python3 server.py   # then open http://localhost:8765
```
Needs Pillow and ffmpeg at `/opt/homebrew/bin/ffmpeg`. The user runs the server themselves; do not start or kill it unless asked.

## Secrets
- The Kimi API key lives in `studio/.secrets.json` (gitignored) or `KIMI_API_KEY` / `MOONSHOT_API_KEY`. Never write it into `curation_state.json` or any committed file.

## Conventions
- Prompts must keep the logo at dead-center, 18% width, with no extra rings or duplicate logos.
- Brand palette: orange #EC540C, pink #F64570, blue #5D8FF4, oxblood #381313, ink #1A1A1A, cream #FEFFE7.
- Default image model is `google/nano-banana-pro`; other Krea models are built in `build_model_input`.
- Use `AGENTS.md` for agent instructions; do not add a `CLAUDE.md`.

## Roadmap
Done:
1. Taste loop (`studio/taste.py`): ❤ approve button, liked/disliked brief injected into prompt generation, per-model scorecard in Settings, "Auto" model that exploits/explores by score. Added Ideogram 4.5, Luma UNI-1, Meta Muse, Runway Gen-4 (all take the logo guide image).
2. Diversity (`studio/diversity.py`): no fixed categories; each shot is a random combo of subject/material/setting/light/camera/logo/palette, recent values avoided, near-duplicate prompts dropped (Jaccard novelty).
3. Tempo: BPM slider + cuts-per-beat multiple in preview and export; music is time-stretched from 136 BPM.

Quality reference: `inspiration/soiltone-inspo.mp4` — 8s, ~48 cuts, each scene shown as a color/mono twin pair, one hero subject, logo crisp at dead-center. "Pairs" generates the twin. Quality bar lives in `QUALITY_BAR` in `server.py`.

Caveat: trashed = manual trash OR logo-QA auto-trash; most trash so far is QA failures, so model scores mostly reflect logo-lock reliability until you approve more plates.

## Twins
- No "Pairs" at generation. Each kept card has a 🌗 Twin button (and "Twin all kept"): `/api/make-twin` edits the plate itself (nano-banana-pro) into the opposite tone and stores `twin_of[twin] = original` in `curation_state.json`.
- Order: `glue_twins()` keeps every twin directly after its original, so dragging/reordering moves pairs together. Trashing an original trashes its twins.
- Audio/tempo-curve work (synth vs. uploaded track, accelerate/decelerate cut curve measured from the reference) is planned after image quality.
