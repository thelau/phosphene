#!/usr/bin/env python3
"""
Minimal Match-Cut Curation & Generation Server
- Uses Kimi (Kimi K3 / Kimi K2.7) via API key to generate fresh, non-repeating scene prompts and per-card variations.
- Uses Krea MCP OAuth (`https://api.krea.ai/mcp`) to generate 9:16 center-locked plates.
- Persists model name and full prompt per image, exposed in `/api/state` for the card badge & `(i)` prompt overlay.
- Per-card "Twin" (`POST /api/make-twin`, image edit into the opposite tonal world) and drag-and-drop reordering (`POST /api/reorder`); twins stay glued after their original.
"""

import io
import json
import os
import random
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image

import chapters
import critic
import diversity
import taste

from krea_mcp_client import (
    generate_plate_via_krea_mcp,
    get_krea_oauth_token,
)
from qa_engine import (
    PLATES_DIR,
    ROOT_DIR,
    TARGET_H,
    TARGET_W,
    evaluate_plate_qa,
)

STUDIO_DIR = Path(__file__).resolve().parent
REJECTED_DIR = ROOT_DIR / "assets" / "ai-plates-rejected"
OUTPUTS_DIR = ROOT_DIR / "outputs"
MUSIC_BPM = 136.0
CURATION_FILE = STUDIO_DIR / "curation_state.json"
SECRETS_FILE = STUDIO_DIR / ".secrets.json"  # gitignored; holds kimi_api_key

PLATES_DIR.mkdir(parents=True, exist_ok=True)
REJECTED_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

QA_CACHE_FILE = STUDIO_DIR / "qa_cache.json"
try:
    QA_CACHE = json.loads(QA_CACHE_FILE.read_text()) if QA_CACHE_FILE.exists() else {}
except Exception:
    QA_CACHE = {}


def get_cached_qa(path: Path) -> dict:
    key = f"{path.name}:{int(path.stat().st_mtime)}"
    if key not in QA_CACHE:
        QA_CACHE[key] = evaluate_plate_qa(path)
        try:
            QA_CACHE_FILE.write_text(json.dumps(QA_CACHE, indent=2))
        except Exception:
            pass
    return QA_CACHE[key]

DEFAULT_TITLES = {
    "01_glass_card.jpg": "Frosted Glass Pass",
    "02_black_hoodie.jpg": "Matte-Black Hoodie",
    "03_white_hoodie.jpg": "Warm-Cream Hoodie",
    "04_sculpture_badge.jpg": "3D Chrome & Glass Sculpture",
    "05_dark_ui_crop.jpg": "Dark OLED UI ('Orchestrate')",
    "06_light_ui_crop.jpg": "Light Display UI ('Orchestrate')",
    "07_techwear_portrait.jpg": "Techwear Collar Portrait",
    "08_floating_iphone_3d.jpg": "Floating 3D iPhone UI",
    "09_tinted_acrylic_slab.jpg": "Cast Orange/Pink Acrylic Slab",
    "10_concrete_sunbeam.jpg": "Brutalist Concrete Sunbeam",
    "11_concrete_double.jpg": "Concrete Double Carving",
    "12_led_matrix.jpg": "RGB LED Matrix Display",
    "13_tear_strip_box.jpg": "Isometric Tear-Strip Box",
    "14_archive_folder.jpg": "Japanese Archive Folder",
    "15_times_square_billboard.jpg": "Times Square 3D LED Billboard",
    "20_neon_glass_tube_sign.jpg": "Neon Glass Tube Sign",
    "21_asphalt_crosswalk_stencil.jpg": "Asphalt Crosswalk Stencil",
    "24_phosphor_broadcast_crt_tel.jpg": "Phosphor Broadcast CRT Telemetry",
    "26_ancient_moss_trunk_carving.jpg": "Ancient Moss Trunk Carving",
    "28_ar_hud_glass_console.jpg": "AR HUD Glass Console",
    "29_shibuya_rain_curve.jpg": "Shibuya Rain 3D Curve",
    "30_electric_blue_command_pale.jpg": "Electric-Blue Command Palette UI",
    "31_neon_drench_transit_lightb.jpg": "Neon Drench Transit Lightbox",
    "32_interlace_telemetry_wall.jpg": "Interlace Telemetry Wall",
    "33_dotonbori_rain_curve.jpg": "Dotonbori Rain 3D Curve",
    "34_ochre_sandstone_monolith.jpg": "Ochre Sandstone Monolith",
}

DEFAULT_PROMPTS = {
    "01_glass_card.jpg": "Silhouetted hand holding up a small rectangular transparent frosted glass access pass against a grainy blurred aura of burnt orange (#EC540C), hot pink (#F64570), and electric blue (#5D8FF4), with the warm-cream (#FEFFE7) circular orbital logo etched inside the glass at dead-center",
    "02_black_hoodie.jpg": "Tight studio macro shot of a heavyweight matte-black cotton hoodie chest with hood drawstrings and burnt-orange (#EC540C) metal aglet tips, with the warm-cream (#FEFFE7) circular orbital logo screen-printed on the black cotton weave at dead-center",
    "03_white_hoodie.jpg": "Tight studio macro shot of a heavyweight warm-cream (#FEFFE7) cotton hoodie chest with matte-black metal aglet tips, with the matte-black (#1A1A1A) circular orbital logo screen-printed on the cotton fleece at dead-center",
    "04_sculpture_badge.jpg": "Macro 3D studio render of architectural blocks made of brushed silver chrome and translucent burnt-orange (#EC540C) glass, with a matte-black rounded-square badge at dead-center containing the glowing warm-cream (#FEFFE7) circular orbital logo",
    "05_dark_ui_crop.jpg": "Tight macro crop of a sleek dark-mode software interface on an OLED display (#1A1A1A) with subtle burnt-orange (#EC540C) and hot-pink (#F64570) glow, bold cropped white typography above, and the glowing burnt-orange circular orbital logo at dead-center",
    "06_light_ui_crop.jpg": "Tight macro crop of a sleek light-mode software interface on a high-DPI display in warm cream (#FEFFE7) with bold cropped black typography above, and the vibrant burnt-orange (#EC540C) circular orbital logo at dead-center",
    "07_techwear_portrait.jpg": "High-fashion futuristic studio portrait of a model in dark glossy techwear with a high collar and tinted glasses under electric-blue (#5D8FF4) rim light against a burnt-orange (#EC540C) backdrop, with the luminous warm-cream (#FEFFE7) circular orbital logo on the high collar at dead-center",
    "08_floating_iphone_3d.jpg": "Floating 3D iPhone tilted in perspective in front of a matte-black and chrome sculptural object against an electric-blue (#5D8FF4) and burnt-orange (#EC540C) studio backdrop, with the glowing warm-cream (#FEFFE7) circular orbital logo on the angled glass screen at dead-center",
    "09_tinted_acrylic_slab.jpg": "Isometric studio macro photo of a thick polished slab of translucent burnt-orange (#EC540C) and hot-pink (#F64570) cast acrylic resting on concrete with glowing caustic edge reflections, with the white circular orbital logo laser-etched at dead-center",
    "10_concrete_sunbeam.jpg": "Architectural macro photograph of a dark brutalist board-formed concrete wall grazed by a diagonal beam of warm golden-orange sunlight, with the circular orbital logo debossed and painted in warm cream (#FEFFE7) at dead-center",
    "12_led_matrix.jpg": "Extreme macro shot of a dark industrial RGB LED dot-matrix display (#1A1A1A) with visible pixel grid, lit up in glowing burnt-orange (#EC540C) LED dots forming the circular orbital logo at dead-center",
    "15_times_square_billboard.jpg": "Cinematic night street-level photograph looking up at a massive curved 3D LED billboard wrapped around a skyscraper corner in rainy Times Square with wet asphalt reflections, displaying a grainy aura of burnt orange (#EC540C), hot pink (#F64570), and electric blue (#5D8FF4) with the glowing warm-cream (#FEFFE7) circular orbital logo at dead-center",
}

DEFAULT_MODELS = {
    "01_glass_card.jpg": "google/nano-banana-2",
    "02_black_hoodie.jpg": "google/nano-banana-2",
    "03_white_hoodie.jpg": "google/nano-banana-2",
    "04_sculpture_badge.jpg": "google/nano-banana-2",
    "05_dark_ui_crop.jpg": "google/nano-banana-2",
    "06_light_ui_crop.jpg": "google/nano-banana-2",
    "07_techwear_portrait.jpg": "google/nano-banana-2",
    "08_floating_iphone_3d.jpg": "google/nano-banana-2",
    "09_tinted_acrylic_slab.jpg": "google/nano-banana-2",
    "10_concrete_sunbeam.jpg": "google/nano-banana-2",
    "11_concrete_double.jpg": "google/nano-banana-2",
    "12_led_matrix.jpg": "google/nano-banana-2",
    "13_tear_strip_box.jpg": "google/nano-banana-2",
    "14_archive_folder.jpg": "google/nano-banana-2",
    "15_times_square_billboard.jpg": "google/nano-banana-pro",
    "20_neon_glass_tube_sign.jpg": "google/nano-banana-pro",
    "21_asphalt_crosswalk_stencil.jpg": "google/nano-banana-pro",
    "24_phosphor_broadcast_crt_tel.jpg": "bytedance/seedream-5-pro",
    "26_ancient_moss_trunk_carving.jpg": "bytedance/seedream-5-pro",
    "28_ar_hud_glass_console.jpg": "krea/krea-3",
    "29_shibuya_rain_curve.jpg": "krea/krea-3",
    "30_electric_blue_command_pale.jpg": "krea/krea-3",
    "31_neon_drench_transit_lightb.jpg": "krea/krea-3",
    "32_interlace_telemetry_wall.jpg": "krea/krea-3",
    "33_dotonbori_rain_curve.jpg": "krea/krea-3",
    "34_ochre_sandstone_monolith.jpg": "krea/krea-3",
}

def apply_critic(filename: str) -> None:
    """Score a plate with the Kimi critic. Advisory unless critic_autotrash is on (then low scores go to Trash with the reason)."""
    st = load_state()
    if not st.get("critic_enabled", True) or not st.get("kimi_api_key"):
        return
    try:
        r = critic.review_plate(PLATES_DIR / filename, call_kimi_llm, st["kimi_api_key"], st.get("kimi_model", "kimi-k3"))
    except Exception as e:
        print(f"[CRITIC] {filename}: {str(e)[:120]}", flush=True)
        return
    st = load_state()
    st.setdefault("critic", {})[filename] = {"mean": r["mean"], "reason": r["reason"], "scores": r["scores"]}
    if st.get("critic_autotrash") and r["verdict"] == "trash" and filename not in st.get("trashed", []):
        st["trashed"] = sorted(set(st.get("trashed", [])) | {filename})
        st.setdefault("trashed_at", {})[filename] = time.time()
        st["critic_failed"] = sorted(set(st.get("critic_failed", [])) | {filename})
    save_state(st)
    print(f"[CRITIC] {filename} {r['mean']} {r['verdict']} - {r['reason']}", flush=True)


def build_full_prompt(raw_prompt: str) -> str:
    return (
        f"{raw_prompt}. 9:16 vertical frame. "
        f"At the EXACT DEAD-CENTER (50% horizontal, 50% vertical) of the 9:16 frame at ~18% frame width "
        f"(matching the exact circular orbital logo SHAPE and position of the reference guide image) is the SINGLE circular mark, "
        f"physically integrated into the scene's exact perspective, lighting, and medium (whether 3D extruded sculpture, CAD wireframe, isometric object, nature formation, UI, or apparel — never a flat 2D sticker pasted over an unrelated angle, and no extra outer rings)."
    )


def _read_secret_key() -> str:
    try:
        return json.loads(SECRETS_FILE.read_text()).get("kimi_api_key", "")
    except Exception:
        return ""


STATE_LOCK = threading.RLock()
BOOT_ID = str(time.time())


def load_state() -> dict:
    st = _load_state_raw()
    st["kimi_api_key"] = _read_secret_key() or st.get("kimi_api_key", "") or os.environ.get("KIMI_API_KEY", os.environ.get("MOONSHOT_API_KEY", ""))
    return st


def _load_state_raw() -> dict:
    if CURATION_FILE.exists():
        try:
            st = json.loads(CURATION_FILE.read_text())
            st.setdefault("trashed", [])
            st.setdefault("titles", {})
            st.setdefault("prompts", {})
            st.setdefault("models", {})
            st.setdefault("history", [])
            st.setdefault("order", [])
            st.setdefault("kimi_api_key", os.environ.get("KIMI_API_KEY", os.environ.get("MOONSHOT_API_KEY", "")))
            st.setdefault("kimi_model", "kimi-k3")
            return st
        except Exception:
            pass
    state = {
        "trashed": [],
        "titles": {},
        "prompts": {},
        "models": {},
        "history": [],
        "order": [],
        "kimi_api_key": os.environ.get("KIMI_API_KEY", os.environ.get("MOONSHOT_API_KEY", "")),
        "kimi_model": "kimi-k3",
    }
    CURATION_FILE.write_text(json.dumps(state, indent=2))
    return state


def save_state(state: dict) -> None:
    state = dict(state)
    key = state.pop("kimi_api_key", "")
    if key:
        SECRETS_FILE.write_text(json.dumps({"kimi_api_key": key}))
        SECRETS_FILE.chmod(0o600)
    CURATION_FILE.write_text(json.dumps(state, indent=2))


TWIN_MODEL = "google/nano-banana-pro"

TWIN_PROMPTS = {
    "light": (
        "Re-render this exact image as its LIGHT twin. Keep the identical composition, camera angle, subject, object shapes and the single circular mark "
        "at dead-center with the same size and treatment. Transform the whole palette into a bright high-key, near-monochrome world (white, pale grey, silver, "
        "soft diffused light, at most one restrained accent color). Same materials and level of detail; only the tonal world changes."
    ),
    "dark": (
        "Re-render this exact image as its DARK twin. Keep the identical composition, camera angle, subject, object shapes and the single circular mark "
        "at dead-center with the same size and treatment. Transform the whole palette into a deep low-key world (ink black, saturated electric blue or violet accent, "
        "dramatic directional light, crisp specular edges). Same materials and level of detail; only the tonal world changes."
    ),
}


def plate_tone(path: Path) -> str:
    from PIL import ImageStat
    lum = ImageStat.Stat(Image.open(path).convert("L").resize((64, 114))).mean[0]
    return "dark" if lum < 110 else "light"


_TONE_CACHE: dict = {}


def cached_tone(path: Path) -> str:
    key = (path.name, int(path.stat().st_mtime))
    if key not in _TONE_CACHE:
        _TONE_CACHE[key] = plate_tone(path)
    return _TONE_CACHE[key]


def glue_twins(order: list[str], twin_of: dict) -> list[str]:
    """Every twin sits directly after its original, whatever order was saved."""
    present = set(order)
    twins_of = {}
    for twin, orig in twin_of.items():
        if twin in present and orig in present:
            twins_of.setdefault(orig, []).append(twin)
    glued = {t for ts in twins_of.values() for t in ts}
    out = []
    for f in order:
        if f in glued:
            continue
        out.append(f)
        out.extend(sorted(twins_of.get(f, [])))
    return out


def ordered_plate_files(st: dict) -> list[Path]:
    all_files = {p.name: p for p in sorted(PLATES_DIR.glob("*.jpg"))}
    order = st.get("order", [])
    result = []
    seen = set()
    for fname in order:
        if fname in all_files:
            result.append(all_files[fname])
            seen.add(fname)
    for fname, p in sorted(all_files.items()):
        if fname not in seen:
            result.append(p)
    names = glue_twins([p.name for p in result], st.get("twin_of", {}))
    by_name = {p.name: p for p in result}
    result = [by_name[n] for n in names]
    return result


def call_kimi_llm(prompt: str, api_key: str, preferred_model: str = "kimi-k3", images: list | None = None, system: str | None = None) -> str:
    """Calls Kimi API (Moonshot .ai, .cn, or Kimi Coding) with automatic model/endpoint fallback."""
    key = (api_key or "").strip()
    if not key:
        raise RuntimeError("NEEDS_KIMI_KEY: Please enter your Kimi API key in ⚙️ Settings.")

    if key.startswith("sk-kimi-"):
        endpoints = [
            "https://api.kimi.com/coding/v1/chat/completions",
            "https://api.moonshot.ai/v1/chat/completions",
            "https://api.moonshot.cn/v1/chat/completions",
        ]
    else:
        endpoints = [
            "https://api.moonshot.ai/v1/chat/completions",
            "https://api.moonshot.cn/v1/chat/completions",
            "https://api.kimi.com/coding/v1/chat/completions",
        ]

    models_to_try = []
    for m in [preferred_model, "kimi-k3", "kimi-k2.7-code", "kimi-k2.5", "kimi-k2-turbo-preview", "moonshot-v1-8k"]:
        if m and m not in models_to_try:
            models_to_try.append(m)

    user_content = prompt
    if images:  # JPEG bytes -> OpenAI-style multimodal content
        import base64
        user_content = [{"type": "text", "text": prompt}] + [
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b).decode()}} for b in images
        ]

    last_err = None
    for ep in endpoints:
        for model in models_to_try:
            payload = {
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": system or "You are a senior film director for a high-fashion match-cut brand film. Output raw valid JSON only, with no markdown code fences.",
                    },
                    {"role": "user", "content": user_content},
                ],
            }
            if model == "kimi-k3":
                payload["reasoning_effort"] = "low"
            req = urllib.request.Request(
                ep,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                    "User-Agent": "KimiCLI/1.0",
                },
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    return data["choices"][0]["message"]["content"].strip()
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8", errors="replace")
                last_err = f"HTTP {e.code} ({model} @ {ep.split('/')[2]}): {err_body[:180]}"
                if e.code == 401:
                    continue
                if e.code in (400, 404):
                    continue
            except Exception as e:
                last_err = str(e)
                continue

    raise RuntimeError(f"Kimi API call failed ({last_err})")


QUALITY_BAR = (
    "QUALITY BAR: this is for Demo, a creative toolkit for creatives at an agency group, and it must look like a top design studio's identity reel "
    "(Pentagram-level): one idea per frame, one hero subject, restrained composition with confident negative space, a disciplined palette (max 3 colors), "
    "believable tactile materials, photoreal studio/CGI craft, razor-sharp edges. The mark may be subtle or bold, but it is deliberate, "
    "physically part of the scene, and never lost. If any type appears it is intentional, rigorous grotesk typography (huge crop or tiny micro-type), never gibberish; "
    "otherwise no text. No collage, no clutter, no stock-photo look, no generic neon trope."
)


def invent_world(st: dict, api_key: str, kimi_model: str, direction: str = "") -> dict:
    """Wildcard: Kimi authors a brand-new world in the same format as chapters.WORLDS."""
    known = ", ".join(w["name"] for w in chapters.all_worlds(st))
    ref = chapters.WORLDS[0]
    steer = f"The director asked for: \"{direction}\". Build the world around that." if direction else "Pick a discipline or phenomenon NOT covered by the existing worlds."
    out = call_kimi_llm(
        f"Invent ONE new creative world for a 9:16 match-cut film where a small circular mark sits at dead-center in every shot. {steer}\n"
        f"Existing worlds (do not repeat): {known}.\n"
        f"It must be authored like a design-studio identity (Pentagram quality): one idea, a restrained palette (max 3 colors), a rigorous visual language, a dark and a light register. "
        f"Return ONLY raw JSON (no fences) with keys: name (2-4 words, 'X & Y' style ok), brief (2 sentences), palette (one sentence, may use #EC540C #F64570 #5D8FF4 #381313 #1A1A1A #FEFFE7), "
        f"applications (10 concrete photographable subjects), marks (5 ways the mark physically emerges from the scene). Example format: {json.dumps({k: ref[k] for k in ('name', 'brief', 'palette', 'marks')})[:400]}",
        api_key=api_key, preferred_model=kimi_model,
    )
    w = json.loads(out[out.find("{"): out.rfind("}") + 1])
    for k in ("name", "brief", "palette", "applications", "marks"):
        if not w.get(k):
            raise RuntimeError(f"invented world missing '{k}'")
    w["weight"] = 1.0
    w["wildcard"] = True
    st.setdefault("custom_worlds", [])
    st["custom_worlds"] = [x for x in st["custom_worlds"] if x["name"] != w["name"]] + [w]
    print(f"[KIMI] invented world '{w['name']}'", flush=True)
    return w


def ask_kimi_for_prompts(st: dict, api_key: str, kimi_model: str, count: int = 4, pair: bool = False, world: str | None = None, direction: str = "") -> list[dict]:
    """One authored creative world per batch (shots cohere), idea-first, steered by taste, near-duplicates dropped."""
    titles = {**DEFAULT_TITLES, **st.get("titles", {})}
    prompts = {**DEFAULT_PROMPTS, **st.get("prompts", {})}
    brief = taste.taste_brief(st, titles, prompts)
    ban_str = ", ".join(list(dict.fromkeys(list(titles.values()) + st.get("history", [])))[-80:])

    w = chapters.choose_world(st, world or "")
    if w is None or (direction and not world):
        w = invent_world(st, api_key, kimi_model, direction)  # wildcard, or a typed direction with no fixed world

    n_ask = count + 2  # over-ask so near-duplicates can be dropped
    apps = random.sample(w["applications"], k=min(n_ask, len(w["applications"])))
    while len(apps) < n_ask:
        apps.append(random.choice(w["applications"]))
    shots = diversity.sample_shots(n_ask, st.get("recent_axes"))
    shot_lines = "\n".join(
        f"Shot {i + 1}: subject = {apps[i]} | optional inspiration (use only what serves the idea, ignore the rest): texture {sh['texture']}, light {sh['lighting']}, camera {sh['camera']}"
        for i, sh in enumerate(shots)
    )
    liked = "\n".join(f"- {t}: {p[:200]}" for t, p in brief["liked"]) or "(none yet)"
    disliked = ", ".join(brief["disliked"]) or "(none yet)"
    llm_prompt = (
        f"Return ONLY a raw JSON array (no markdown fences) of {n_ask} objects with keys \"title\", \"idea\", \"guide\" ('dark' or 'light' = whether the frame is mostly dark or mostly light) and \"prompt\". "
        f"They are shots for a 9:16 vertical match-cut film where one small circular mark sits at the exact dead-center (50%, 50%) at 18% frame width.\n\n"
        f"WORLD: {w['name']}. {w['brief']}\n"
        + (f"DIRECTOR'S DIRECTION for this batch (follow it, but keep the quality bar and rules below): {direction}\n" if direction else "")
        + f"Palette for this whole batch: {w['palette']}. Every shot lives inside this world and palette so the cut sequence coheres; "
        f"vary subject, framing and light, not the world.\n\n"
        f"For each shot first write \"idea\": ONE line on how the mark physically emerges from the scene (inspirations: {'; '.join(w['marks'])}; or something better). "
        f"Reject gimmicks like 'logo on a thing'. Then write \"prompt\" from that idea.\n\n"
        f"Alternate registers: odd-numbered shots are DARK register (mostly black or deep tones, luminous emitted light, \"guide\":\"dark\"); even-numbered shots are LIGHT register (mostly bone or pale tones, soft light, \"guide\":\"light\"). "
        f"Each register uses the world's palette for that register.\n\nShots:\n{shot_lines}\n\n{QUALITY_BAR}\n\n"
        f"TASTE (learned from what the director kept):\nLiked:\n{liked}\nSteer away from the feel of: {disliked}\n\n"
        f"RULES:\n"
        f"1. The mark is physically part of the scene (same perspective, light, material). Never a flat sticker, no outer rings, exactly one mark.\n"
        f"2. Each prompt: 2-4 sentences, concrete visual language, name lens/light/material, end by stating the mark's treatment and dead-center position.\n"
        f"3. All shots must look clearly different from each other and from these past scenes: [{ban_str}]."
    )
    print(f"[KIMI] world='{w['name']}' requesting {n_ask} prompts using {kimi_model}...", flush=True)
    out = call_kimi_llm(llm_prompt, api_key=api_key, preferred_model=kimi_model)
    s_idx, e_idx = out.find("["), out.rfind("]")
    if s_idx == -1 or e_idx == -1:
        raise RuntimeError("Kimi did not return a valid JSON array of prompts")
    ideas = json.loads(out[s_idx : e_idx + 1])

    past = list(prompts.values())
    kept = []
    for idea in ideas:
        p = idea.get("prompt", "")
        nov = taste.novelty(p, past)
        if nov < 0.45:
            print(f"[DIVERSITY] dropped near-duplicate '{idea.get('title')}' (novelty={nov:.2f})", flush=True)
            continue
        past.append(p)
        kept.append(idea)
    kept = kept[:count] or ideas[:count]

    flat = [{"title": i.get("title", "Untitled"), "guide": i.get("guide", "dark"), "prompt": i["prompt"], "idea": i.get("idea", ""), "world": w["name"]} for i in kept]

    st.setdefault("recent_worlds", []).append(w["name"])
    st["recent_worlds"] = st["recent_worlds"][-8:]
    recent = st.setdefault("recent_axes", {})
    for sh in shots[: len(kept)]:
        for axis, val in sh.items():
            recent.setdefault(axis, []).append(val)
            recent[axis] = recent[axis][-12:]
    print(f"[KIMI] titles: {[x['title'] for x in flat]}", flush=True)
    return flat


class StudioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def log_message(self, format, *args):
        pass

    def send_json(self, data: dict, status: int = 200):
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html", "/studio", "/studio/"):
            html_bytes = (STUDIO_DIR / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html_bytes)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(html_bytes)
            return

        if parsed.path == "/api/stats":
            self.send_json({"ok": True, "models": taste.model_stats(load_state())})
            return

        if parsed.path == "/api/version":
            try:
                html_mtime = (STUDIO_DIR / "index.html").stat().st_mtime
            except OSError:
                html_mtime = 0
            self.send_json({"boot": BOOT_ID, "html": html_mtime})
            return

        if parsed.path == "/api/worlds":
            st = load_state()
            stats = chapters.world_stats(st)
            self.send_json({"ok": True, "worlds": [
                {"name": w["name"], "n": stats.get(w["name"], {}).get("n", 0), "kept": stats.get(w["name"], {}).get("kept", 0), "wildcard": bool(w.get("wildcard"))}
                for w in chapters.all_worlds(st)
            ]})
            return

        if parsed.path == "/api/state":
            st = load_state()
            trashed_set = set(st.get("trashed", []))
            titles = {**DEFAULT_TITLES, **st.get("titles", {})}
            prompts = {**DEFAULT_PROMPTS, **st.get("prompts", {})}
            models = {**DEFAULT_MODELS, **st.get("models", {})}
            auth = get_krea_oauth_token()

            plates = []
            for p in ordered_plate_files(st):
                qa = get_cached_qa(p)
                plates.append({
                    "filename": p.name,
                    "url": f"/assets/ai-plates/{p.name}?t={int(p.stat().st_mtime)}",
                    "title": titles.get(p.name, p.stem.split("_", 1)[-1].replace("_", " ").title()),
                    "prompt": prompts.get(p.name, titles.get(p.name, "")),
                    "model": models.get(p.name, "google/nano-banana-pro"),
                    "trashed": p.name in trashed_set,
                    "trashed_at": st.get("trashed_at", {}).get(p.name),
                    "trash_reason": (
                        "Logo check" if p.name in st.get("qa_failed", []) and p.name in trashed_set
                        else ("AI critic: " + st.get("critic", {}).get(p.name, {}).get("reason", "") if p.name in st.get("critic_failed", []) and p.name in trashed_set else None)
                    ),
                    "critic": st.get("critic", {}).get(p.name),
                    "world": st.get("worlds", {}).get(p.name),
                    "idea": st.get("ideas", {}).get(p.name),
                    "tone": cached_tone(p),
                    "twin_of": st.get("twin_of", {}).get(p.name),
                    "has_twin": p.name in st.get("twin_of", {}).values(),
                    "qa_passed": qa["qa_passed"],
                    "qa_score": qa["qa_score"],
                    "qa_issues": qa.get("issues", []),
                })

            kimi_key = st.get("kimi_api_key", "")
            self.send_json({
                "plates": plates,
                "krea_connected": bool(auth.get("connected") and not auth.get("expired")),
                "kimi_configured": bool(kimi_key),
                "kimi_key_masked": (kimi_key[:6] + "••••••••" + kimi_key[-4:]) if len(kimi_key) > 10 else "",
                "kimi_model": st.get("kimi_model", "kimi-k3"),
                "critic_enabled": st.get("critic_enabled", True),
                "critic_autotrash": st.get("critic_autotrash", False),
            })
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}

        if parsed.path == "/api/krea-auth":
            subprocess.Popen(["/opt/homebrew/bin/opencode", "mcp", "auth", "krea"], cwd=str(ROOT_DIR))
            self.send_json({"ok": True})
            return

        if parsed.path == "/api/save-settings":
            st = load_state()
            if "kimi_api_key" in body and body["kimi_api_key"].strip():
                st["kimi_api_key"] = body["kimi_api_key"].strip()
            if "kimi_model" in body and body["kimi_model"].strip():
                st["kimi_model"] = body["kimi_model"].strip()
            for flag in ("critic_enabled", "critic_autotrash"):
                if flag in body:
                    st[flag] = bool(body[flag])
            save_state(st)
            self.send_json({"ok": True, "kimi_configured": bool(st.get("kimi_api_key"))})
            return

        if parsed.path == "/api/reorder":
            new_order = body.get("order", [])
            if isinstance(new_order, list):
                st = load_state()
                st["order"] = [str(x) for x in new_order]
                save_state(st)
            self.send_json({"ok": True})
            return

        if parsed.path == "/api/invent-prompts":
            st = load_state()
            kimi_key = body.get("kimi_api_key") or st.get("kimi_api_key", "")
            kimi_model = body.get("kimi_model") or st.get("kimi_model", "kimi-k3")
            if not kimi_key:
                self.send_json({"ok": False, "needs_kimi_key": True, "error": "Enter your Kimi API key in ⚙️ Settings first"}, 400)
                return
            try:
                ideas = ask_kimi_for_prompts(
                    st,
                    api_key=kimi_key,
                    kimi_model=kimi_model,
                    count=int(body.get("count", 4)),
                    pair=False,
                    world=body.get("world") or None,
                    direction=(body.get("direction") or "").strip()[:300],
                )
                for idea in ideas:
                    t = idea.get("title", "")
                    if t and t not in st["history"]:
                        st["history"].append(t)
                save_state(st)
                self.send_json({"ok": True, "ideas": ideas})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return

        if parsed.path == "/api/generate-image":
            auth = get_krea_oauth_token()
            if not auth.get("connected") or auth.get("expired"):
                subprocess.Popen(["/opt/homebrew/bin/opencode", "mcp", "auth", "krea"], cwd=str(ROOT_DIR))
                self.send_json({"ok": False, "needs_auth": True, "error": "Approve Krea MCP OAuth in browser first"})
                return

            title = body.get("title", "Outdoor Plate").strip()
            raw_prompt = body.get("prompt", "").strip()
            guide_type = body.get("guide", "dark")
            model = body.get("model", "google/nano-banana-pro")
            if model == "auto":
                model = taste.pick_model(load_state())
                print(f"[TASTE] auto-picked model {model}", flush=True)
            after_filename = body.get("after_filename")

            full_prompt = build_full_prompt(raw_prompt)
            try:
                img_bytes = generate_plate_via_krea_mcp(prompt=full_prompt, guide_type=guide_type, model=model)
                im = Image.open(io.BytesIO(img_bytes)).convert("RGB").resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)

                with STATE_LOCK:
                    existing_nums = [
                        int(p.name.split("_", 1)[0])
                        for p in list(PLATES_DIR.glob("*.jpg")) + list(REJECTED_DIR.glob("*.jpg"))
                        if p.name.split("_", 1)[0].isdigit()
                    ]
                    next_num = max(existing_nums, default=15) + 1
                    slug = "".join(c if c.isalnum() else "_" for c in title.lower()).strip("_")[:26] or "plate"
                    while "__" in slug:
                        slug = slug.replace("__", "_")
                    filename = f"{next_num:02d}_{slug}.jpg"
                    save_path = PLATES_DIR / filename
                    im.save(save_path, quality=95)

                    qa = get_cached_qa(save_path)
                    print(
                        f"[QA] {filename} ({model}) -> passed={qa['qa_passed']} score={qa['qa_score']}% "
                        f"corr={qa['center_corr']} asym={qa['core_asymmetry']} issues={qa['issues']}",
                        flush=True,
                    )

                    st = load_state()
                    st.setdefault("titles", {})[filename] = title
                    st.setdefault("prompts", {})[filename] = raw_prompt
                    st.setdefault("models", {})[filename] = model
                    if body.get("world"):
                        st.setdefault("worlds", {})[filename] = body["world"]
                    if body.get("idea"):
                        st.setdefault("ideas", {})[filename] = body["idea"]
                    if title not in st.setdefault("history", []):
                        st["history"].append(title)

                    # If Logo QA flags the image, send it to Trash instead of deleting/hiding it!
                    if not qa["qa_passed"]:
                        trashed_list = set(st.get("trashed", []))
                        trashed_list.add(filename)
                        st["trashed"] = sorted(trashed_list)
                        st.setdefault("trashed_at", {})[filename] = time.time()
                        st["qa_failed"] = sorted(set(st.get("qa_failed", [])) | {filename})

                    cur_order = [p.name for p in ordered_plate_files(st)]
                    if filename in cur_order:
                        cur_order.remove(filename)
                    if after_filename and after_filename in cur_order:
                        idx = cur_order.index(after_filename) + 1
                        cur_order.insert(idx, filename)
                    else:
                        cur_order.append(filename)
                    st["order"] = cur_order
                    save_state(st)
                threading.Thread(target=apply_critic, args=(filename,), daemon=True).start()

                self.send_json({
                    "ok": True,
                    "qa_passed": qa["qa_passed"],
                    "trashed": not qa["qa_passed"],
                    "filename": filename,
                    "title": title,
                    "model": model,
                    "qa_issues": qa.get("issues", []),
                })
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return

        if parsed.path == "/api/make-twin":
            auth = get_krea_oauth_token()
            if not auth.get("connected") or auth.get("expired"):
                self.send_json({"ok": False, "needs_auth": True, "error": "Approve Krea MCP OAuth in browser first"})
                return
            src_name = body.get("filename", "")
            src = PLATES_DIR / src_name
            st = load_state()
            if not src.exists():
                self.send_json({"ok": False, "error": "Unknown plate"}, 404)
                return
            if src_name in st.get("twin_of", {}) or src_name in st.get("twin_of", {}).values():
                self.send_json({"ok": False, "error": "Already has a twin"}, 400)
                return
            model = body.get("model") or TWIN_MODEL
            target = "light" if plate_tone(src) == "dark" else "dark"
            try:
                img_bytes = generate_plate_via_krea_mcp(prompt=TWIN_PROMPTS[target], guide_type=target, model=model, source_image=src)
                im = Image.open(io.BytesIO(img_bytes)).convert("RGB").resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)
                existing_nums = [
                    int(p.name.split("_", 1)[0])
                    for p in list(PLATES_DIR.glob("*.jpg")) + list(REJECTED_DIR.glob("*.jpg"))
                    if p.name.split("_", 1)[0].isdigit()
                ]
                filename = f"{max(existing_nums, default=15) + 1:02d}_twin_of_{src.stem.split('_', 1)[-1]}"[:40] + ".jpg"
                save_path = PLATES_DIR / filename
                im.save(save_path, quality=95)
                qa = get_cached_qa(save_path)

                st = load_state()
                titles = {**DEFAULT_TITLES, **st.get("titles", {})}
                st.setdefault("titles", {})[filename] = f"{titles.get(src_name, src.stem)} (twin)"
                st.setdefault("prompts", {})[filename] = TWIN_PROMPTS[target]
                st.setdefault("models", {})[filename] = model
                st.setdefault("twin_of", {})[filename] = src_name
                if not qa["qa_passed"]:
                    st["trashed"] = sorted(set(st.get("trashed", [])) | {filename})
                    st.setdefault("trashed_at", {})[filename] = time.time()
                    st["qa_failed"] = sorted(set(st.get("qa_failed", [])) | {filename})
                save_state(st)
                print(f"[TWIN] {src_name} -> {filename} ({target}, {model}) qa={qa['qa_passed']}", flush=True)
                self.send_json({"ok": True, "filename": filename, "qa_passed": qa["qa_passed"], "target": target})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)
            return

        if parsed.path == "/api/trash":
            filename = body.get("filename")
            trashed = bool(body.get("trashed", True))
            st = load_state()
            cur = set(st.get("trashed", []))
            twin_of = st.get("twin_of", {})
            group = {filename} | {t for t, o in twin_of.items() if o == filename}  # trashing an original takes its twins along
            if trashed:
                cur |= group
                now = time.time()
                for f in group:
                    st.setdefault("trashed_at", {})[f] = now
            else:
                cur -= group
                for f in group:
                    st.get("trashed_at", {}).pop(f, None)
            st["trashed"] = sorted(cur)
            save_state(st)
            self.send_json({"ok": True})
            return

        if parsed.path == "/api/export-video":
            bpm = float(body.get("bpm", 136.0))
            multiple = float(body.get("multiple", 1.0))  # cuts per beat: 0.5 = every 2 beats, 4 = 4 cuts/beat
            total_seconds = float(body.get("total_seconds", 10.0))
            st = load_state()
            trashed_set = set(st.get("trashed", []))
            active_files = [p for p in ordered_plate_files(st) if p.name not in trashed_set]
            if not active_files:
                self.send_json({"ok": False, "error": "No active plates"}, 400)
                return

            fps = 30
            frames_per_cut = max(1.0, fps * 60.0 / (bpm * multiple))
            total_frames = int(total_seconds * fps)
            tmp_dir = ROOT_DIR / "outputs" / "_tmp_export_frames"
            if tmp_dir.exists():
                shutil.rmtree(tmp_dir)
            tmp_dir.mkdir(parents=True, exist_ok=True)

            # Encode each plate once, then write the same bytes for every frame it covers.
            encoded = []
            for p in active_files:
                buf = io.BytesIO()
                Image.open(p).convert("RGB").resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS).save(buf, "JPEG", quality=92)
                encoded.append(buf.getvalue())
            for f_idx in range(total_frames):
                plate_idx = int(f_idx / frames_per_cut) % len(encoded)
                (tmp_dir / f"f_{f_idx:04d}.jpg").write_bytes(encoded[plate_idx])

            out_mp4 = OUTPUTS_DIR / "Demo-curated-matchcut.mp4"
            audio_files = list((ROOT_DIR / "music").glob("*.mp3")) + list((ROOT_DIR / "music").glob("*.wav"))
            cmd = ["/opt/homebrew/bin/ffmpeg", "-y", "-framerate", str(fps), "-i", str(tmp_dir / "f_%04d.jpg")]
            if audio_files:
                # Track is 136 BPM; stretch it so the music follows the chosen tempo.
                ratio = max(0.5, min(2.0, bpm / MUSIC_BPM))
                cmd += ["-i", str(audio_files[0]), "-af", f"atempo={ratio:.4f}", "-shortest"]
            cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-t", str(total_seconds), str(out_mp4)]
            subprocess.run(cmd, check=True, capture_output=True)
            shutil.rmtree(tmp_dir, ignore_errors=True)
            self.send_json({"ok": True, "video_url": f"/outputs/Demo-curated-matchcut.mp4?t={int(time.time())}", "frames_per_cut": round(frames_per_cut, 2)})
            return

        self.send_json({"ok": False, "error": "Unknown endpoint"}, 404)


class QuietServer(ThreadingHTTPServer):
    """A browser that reloads or navigates away mid-response is normal; don't dump a traceback for it."""

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8765"))
    server = QuietServer(("127.0.0.1", port), StudioHandler)
    print(f"Studio running at http://localhost:{port}")
    server.serve_forever()
