#!/usr/bin/env python3
"""
Model x scene benchmark: Kimi writes shots for the chosen worlds, each is generated on every model, and the results are added
to the library (QA failures go to Trash, like in the UI). Judge them in the UI: keep = like, trash = dislike.

usage: python3 bench.py --worlds 3 [--per-world 4] [--world-names "A,B"] [--models a,b] [--workers 3] [--dry-run]
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

DEFAULT_BENCH_MODELS = [
    "google/nano-banana-2.1",
    "google/nano-banana-pro",
]

lock = threading.Lock()


def runway_prompt(raw: str) -> str:
    return (raw[:620] + ". 9:16. The single circular mark of the guide image at exact dead-center, ~18% width, integrated into the scene, no extra rings.")[:1000]


def run_one(job):
    title, raw, guide, model, world, idea = job
    full = runway_prompt(raw) if model.startswith("runway/") else server.build_full_prompt(raw)
    try:
        img_bytes = generate_plate_via_krea_mcp(prompt=full, guide_type=guide, model=model)
    except Exception as e:
        print(f"[BENCH] FAIL {model} {title}: {str(e)[:160]}", flush=True)
        return
    im = Image.open(io.BytesIO(img_bytes)).convert("RGB").resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)
    with lock:  # allocate the number and save atomically; state is re-read right before writing
        n = server.next_plate_number(server.load_state())
        slug = "".join(c if c.isalnum() else "_" for c in f"{title}_{model.split('/')[-1]}".lower()).strip("_")[:26]
        filename = f"{n:02d}_{slug}.jpg"
        path = PLATES_DIR / filename
        im.save(path, quality=95)
        qa = server.get_cached_qa(path)
        st = server.load_state()
        st.setdefault("titles", {})[filename] = f"[bench] {title}"
        st.setdefault("prompts", {})[filename] = raw
        st.setdefault("models", {})[filename] = model
        if world:
            st.setdefault("worlds", {})[filename] = world
        if idea:
            st.setdefault("ideas", {})[filename] = idea
        if not qa["qa_passed"]:
            st["trashed"] = sorted(set(st.get("trashed", [])) | {filename})
            st["qa_failed"] = sorted(set(st.get("qa_failed", [])) | {filename})
            st.setdefault("trashed_at", {})[filename] = __import__("time").time()
        order = [p.name for p in server.ordered_plate_files(st)]
        st["order"] = [f for f in order if f != filename] + [filename]
        server.save_state(st)
    server.apply_critic(filename)
    print(f"[BENCH] {filename} {model} qa={'PASS' if qa['qa_passed'] else 'FAIL'} score={qa['qa_score']}", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(DEFAULT_BENCH_MODELS))
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--worlds", type=int, default=0, help="number of creative worlds; each yields --per-world Kimi-invented shots (taste-aware)")
    ap.add_argument("--per-world", type=int, default=4)
    ap.add_argument("--world-names", default="", help="comma-separated explicit worlds (repeat a name for more batches of it)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if not (a.worlds or a.world_names):
        ap.error("pass --worlds N or --world-names")
    jobs = []
    ideas = []
    batches = [n.strip() for n in a.world_names.split(",") if n.strip()] or [None] * a.worlds
    for wname in batches:
        st = server.load_state()
        ideas += server.ask_kimi_for_prompts(st, st["kimi_api_key"], st.get("kimi_model", "kimi-k3"), count=a.per_world, world=wname)
        server.save_state(st)
    scenes = [{"title": i["title"], "dark": i["prompt"], "guide": i.get("guide", "dark"), "world": i["world"], "idea": i["idea"]} for i in ideas]
    for sc in scenes:  # scene-major so a partial run still has every model covered per scene
        for m in a.models.split(","):
            jobs.append((sc["title"], sc["dark"], sc.get("guide", "dark"), m, sc.get("world"), sc.get("idea")))
    if a.limit:
        jobs = jobs[: a.limit]
    print(f"[BENCH] {len(jobs)} images, {a.workers} workers", flush=True)
    if a.dry_run:
        raise SystemExit
    with ThreadPoolExecutor(a.workers) as ex:
        list(ex.map(run_one, jobs))
    print("[BENCH] done", flush=True)
