#!/usr/bin/env python3
"""
Model x scene benchmark: generates every scene (dark + light twin) on every model and adds the results
to the library (QA failures go to Trash, like in the UI). Judge them in the UI: keep = like, trash = dislike.

usage: python3 bench.py [--models a,b] [--workers 3] [--dry-run]
"""
import argparse
import io
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

import server
from krea_mcp_client import generate_plate_via_krea_mcp
from qa_engine import PLATES_DIR, TARGET_H, TARGET_W
from taste import CANDIDATE_MODELS

SCENES = [
    {
        "title": "Etched Glass Slab in Hand",
        "dark": "Macro studio photograph of a bare hand holding a thin transparent glass slab against a seamless saturated violet-blue backdrop, shallow depth of field, a crisp strip-light edge glowing along the slab. The mark is laser-etched into the glass and catches the light, razor sharp, premium product-render quality",
        "light": "The same composition and hand pose, now in a pale grey and silver monochrome world: a frosted translucent glass slab against a soft grey seamless backdrop, soft overhead softbox, the mark etched as a bright frosted line, almost no saturation",
    },
    {
        "title": "Mirror Chrome Monolith",
        "dark": "A towering extruded mirror-chrome monolith in an empty black gallery, straight-on symmetrical 50mm, a single hard flash with deep shadow, reflections of a distant skylight. The mark is extruded in 3D from the same chrome at the center of the face, razor-sharp bevel highlights",
        "light": "The same monolith and camera in a high-key white studio, now matte black rubber with soft-touch finish on a white sweep, the mark extruded in the same matte black, crisp soft shadows, minimal and graphic",
    },
    {
        "title": "Light Hole in Frozen Lake",
        "dark": "Top-down view of black glacial ice at blue hour with fine white fractures radiating outward, a warm amber glow rising from deep beneath the ice. The mark is a hole of light, a circular opening glowing from below, fractures bending around it, photoreal, cinematic",
        "light": "The same top-down composition in an overcast white snowfield: pale fractured ice and snow, almost white on white tonal, the mark appears as a soft blue-grey shadow shape pressed into the snow with delicate crystalline edges",
    },
    {
        "title": "Tone-on-Tone Heavy Hoodie",
        "dark": "Tight crop of a heavy ink-black cotton hoodie chest with the drawstrings hanging, soft side light revealing fabric grain, shallow depth of field. The mark is embroidered tone-on-tone in raised satin thread at the center with a single electric-blue (#5D8FF4) eyelet accent, premium fashion editorial",
        "light": "The same crop and lighting on a warm cream (#FEFFE7) heavy cotton hoodie with cream drawstrings, the mark embroidered tone-on-tone in raised satin thread, one burnt orange (#EC540C) eyelet accent",
    },
    {
        "title": "Backlit Perforated Facade",
        "dark": "Wide architectural night shot, perfectly vertical lines, of a perforated steel facade backlit from inside in deep oxblood (#381313) with hot pink (#F64570) glow, rows of tiny holes. The mark is formed by the arrangement of the glowing perforations at the center, crisp and legible",
        "light": "The same facade and framing in flat midday daylight: white perforated aluminium panels, the mark formed by the arrangement of slightly larger holes casting tiny sharp shadows, tonal white and pale grey",
    },
]

lock = threading.Lock()


def runway_prompt(raw: str) -> str:
    return (raw[:620] + ". 9:16. The single circular mark of the guide image at exact dead-center, ~18% width, integrated into the scene, no extra rings.")[:1000]


def run_one(job):
    title, raw, guide, model = job
    full = runway_prompt(raw) if model.startswith("runway/") else server.build_full_prompt(raw)
    try:
        img_bytes = generate_plate_via_krea_mcp(prompt=full, guide_type=guide, model=model)
    except Exception as e:
        print(f"[BENCH] FAIL {model} {title}: {str(e)[:160]}", flush=True)
        return
    im = Image.open(io.BytesIO(img_bytes)).convert("RGB").resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)
    with lock:  # allocate the number and save atomically; state is re-read right before writing
        nums = [int(p.name.split("_", 1)[0]) for p in list(PLATES_DIR.glob("*.jpg")) + list(server.REJECTED_DIR.glob("*.jpg")) if p.name.split("_", 1)[0].isdigit()]
        n = max(nums, default=15) + 1
        slug = "".join(c if c.isalnum() else "_" for c in f"{title}_{model.split('/')[-1]}".lower()).strip("_")[:26]
        filename = f"{n:02d}_{slug}.jpg"
        path = PLATES_DIR / filename
        im.save(path, quality=95)
        qa = server.get_cached_qa(path)
        st = server.load_state()
        st.setdefault("titles", {})[filename] = f"[bench] {title}"
        st.setdefault("prompts", {})[filename] = raw
        st.setdefault("models", {})[filename] = model
        if not qa["qa_passed"]:
            st["trashed"] = sorted(set(st.get("trashed", [])) | {filename})
            st["qa_failed"] = sorted(set(st.get("qa_failed", [])) | {filename})
        order = [p.name for p in server.ordered_plate_files(st)]
        st["order"] = [f for f in order if f != filename] + [filename]
        server.save_state(st)
    print(f"[BENCH] {filename} {model} qa={'PASS' if qa['qa_passed'] else 'FAIL'} score={qa['qa_score']}", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(CANDIDATE_MODELS))
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--random", type=int, default=0, help="use N Kimi-invented random-axis scenes (taste-aware) instead of the fixed SCENES")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    jobs = []
    scenes = SCENES
    if a.random:
        st = server.load_state()
        ideas = []
        while len(ideas) < a.random:
            ideas += server.ask_kimi_for_prompts(st, st["kimi_api_key"], st.get("kimi_model", "kimi-k3"), count=min(6, a.random - len(ideas)), pair=False)
            server.save_state(st)
        scenes = [{"title": i["title"], "dark": i["prompt"], "guide": i.get("guide", "dark"), "light": None} for i in ideas]
    for sc in scenes:  # scene-major so a partial run still has every model covered per scene
        for m in a.models.split(","):
            jobs.append((sc["title"], sc["dark"], sc.get("guide", "dark"), m))
            if sc["light"]:
                jobs.append((sc["title"] + " (twin)", sc["light"], "light", m))
    if a.limit:
        jobs = jobs[: a.limit]
    print(f"[BENCH] {len(jobs)} images, {a.workers} workers", flush=True)
    if a.dry_run:
        raise SystemExit
    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(run_one, jobs))
    print("[BENCH] done", flush=True)
