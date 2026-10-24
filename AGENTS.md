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
1. Feed approved/rejected/trashed history back into prompt generation; track per-model approval rate; try more Krea models.
2. More prompt diversity (rotate material/setting/lighting/camera axes, reject near-duplicates of past prompts).
3. Tempo (BPM) selector for export, in addition to the frames-per-cut multiple.
