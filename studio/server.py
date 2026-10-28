#!/usr/bin/env python3
"""
Minimal Match-Cut Curation & Generation Server
- Uses Kimi (Kimi K3 / Kimi K2.7) via API key to generate fresh, non-repeating scene prompts and per-card variations.
- Uses Krea MCP OAuth (`https://api.krea.ai/mcp`) to generate 9:16 center-locked plates.
- Persists model name and full prompt per image, exposed in `/api/state` for the card badge & `(i)` prompt overlay.
- Drag-and-drop reordering (`POST /api/reorder`); restoring from trash puts an image at the end of the order.
"""

import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import socket
import urllib.error
import uuid
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

from PIL import Image

import chapters
import critic
import editor
import gen_log
import groups
import edits
import features
import sequences
import diversity
import places
import projects
import qa_engine
import taste

from krea_mcp_client import (
    finish_login as krea_finish_login,
    forget_login as krea_forget_login,
    generate_plate_via_krea_mcp,
    get_krea_oauth_token,
    start_login as krea_start_login,
)
from qa_engine import (
    DEMO_MARK,
    PLATES_DIR,
    ROOT_DIR,
    TARGET_H,
    TARGET_W,
    evaluate_plate_qa,
    mark_spec,
)

STUDIO_DIR = Path(__file__).resolve().parent
THUMBS_DIR = STUDIO_DIR / ".thumbs"   # resized copies for the grid and the preview (gitignored)
THUMB_WIDTHS = (360, 540)
EXPORT_DIR = places.SUPPORT_DIR / ".export"  # the drone and the frames the page made for the next export, zips (gitignored)
WEB_DIST = places.WEB_DIST              # built page (npm run build, or inside the Mac app); in dev Vite serves it instead
OUTPUTS_DIR = places.OUTPUTS_DIR
CURATION_FILE = STUDIO_DIR / "curation_state.json"
SECRETS_FILE = places.SUPPORT_DIR / ".secrets.json"  # gitignored; holds kimi_api_key

if not places.APP:                                                          # in the app this would be inside Phosphene.app (read-only from a DMG)
    PLATES_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)


def find_tool(name: str) -> str:
    """A command line tool wherever it is installed (PATH first; Homebrew's places when the server was started without them)."""
    if name == "ffmpeg" and places.FFMPEG:
        return places.FFMPEG
    return shutil.which(name) or next((p for p in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}") if Path(p).exists()), name)


FFMPEG = find_tool("ffmpeg")

QA_CACHE_FILE = STUDIO_DIR / "qa_cache.json"
try:
    QA_CACHE = json.loads(QA_CACHE_FILE.read_text()) if QA_CACHE_FILE.exists() else {}
except Exception:
    QA_CACHE = {}

# ---- the project the server works on (projects.py): its plates, curation, caches, mark and words ----
def _first_project():
    # DEMO, whose places the paths above are: importing the server (bench, the tests) never pairs DEMO's plates with another
    # project's mark; the server's start opens the project open last time (open_first_project)
    try:
        return projects.load(projects.DEFAULT)
    except Exception:                                                        # the app before its first launch copied the sample in
        return None


PROJECT: dict = _first_project()


def apply_project(p: dict) -> None:
    """Point every path at project `p` (on start and when the page switches). Nothing may be running: the caller checks busy()."""
    global PROJECT, PLATES_DIR, CURATION_FILE, QA_CACHE_FILE, QA_CACHE, THUMBS_DIR
    with STATE_LOCK:                                                         # no load/save of the state straddles the switch
        PROJECT, PLATES_DIR, CURATION_FILE, QA_CACHE_FILE, THUMBS_DIR = p, p["plates_dir"], p["state_file"], p["qa_cache_file"], p["thumbs_dir"]
    PLATES_DIR.mkdir(parents=True, exist_ok=True)
    try:
        QA_CACHE = json.loads(QA_CACHE_FILE.read_text()) if QA_CACHE_FILE.exists() else {}
    except Exception:
        QA_CACHE = {}
    features.use_cache(p["features_file"])
    if p.get("qa") == "demo-tuned":                                       # DEMO's logo check reads its orbital mark from the project
        qa_engine.LOGO_CREAM_PATH = p["mark_file"]


def apply_no_project() -> None:
    """No project yet (a new user, or every project moved away): an empty library in the support folder, so the page can show its
    first screen (New project, Import project) and everything that needs a project says so (NEEDS_PROJECT)."""
    global PROJECT, PLATES_DIR, CURATION_FILE, QA_CACHE_FILE, QA_CACHE, THUMBS_DIR
    base = places.SUPPORT_DIR / ".no-project"
    PROJECT, PLATES_DIR, CURATION_FILE, QA_CACHE_FILE, QA_CACHE, THUMBS_DIR = None, base / "plates", base / "state.json", base / ".qa_cache.json", {}, base / ".thumbs"
    PLATES_DIR.mkdir(parents=True, exist_ok=True)


def imported_opens(handler, p: dict) -> bool:
    """An imported project opens, unless a job started while it was copied (seconds): it stays in the menu and the job's project
    stays open (a switch then would put that job's images in the new project). False: the answer is sent."""
    with STATE_LOCK:
        if not busy():
            apply_project(projects.set_active(p["slug"]))
            return True
    handler.send_json({"ok": False, "busy": True, "error": f"{p['name']} was imported. Something started meanwhile: open it from the project menu when it ends."}, 409)
    return False


def open_first_project() -> None:
    """On start: the project open last time; one that cannot be read (a damaged project.json) is passed over for the next; none
    at all, the empty library and the page's first screen. A damaged project never stops the app from starting."""
    for slug in [projects.active_slug()] + [p["slug"] for p in projects.all_projects()]:
        try:
            if slug:
                apply_project(projects.load(slug))
                return
        except Exception as e:
            print(f"[PROJECTS] {slug} could not be opened ({e}): trying another", flush=True)
    apply_no_project()


NEEDS_PROJECT = {"/api/generate-image", "/api/invent-prompts", "/api/order-ai", "/api/export-video", "/api/download-zip", "/api/reorder", "/api/trash", "/api/purge", "/api/groups", "/api/edits", "/api/sequence"}


def is_demo() -> bool:
    return bool(PROJECT) and PROJECT.get("qa") == "demo-tuned"


def current_mark():
    """What the logo check looks for in this project: DEMO's orbital mask, or the project's own mark at its size and place."""
    return DEMO_MARK if is_demo() else mark_spec(PROJECT["mark_file"], PROJECT["mark_size"], PROJECT["mark_x"], PROJECT["mark_y"])


def current_guide():
    """The guide image Krea draws from: None for DEMO (its originals, one pre-uploaded), else this project's, uploaded once and cached."""
    original = PROJECT["guides"]["dark"] == ROOT_DIR / "assets" / "logo-guides" / "guide_dark_1080x1920.png"
    return None if is_demo() and original else {"files": PROJECT["guides"], "cache": PROJECT["guide_cache_file"]}


def mark_words(p: dict | None = None) -> dict:
    """The words the prompts use for the mark, its size and its place. DEMO: exactly the words it has always had."""
    p = p or PROJECT
    size, x, y = p["mark_size"], p["mark_x"], p["mark_y"]
    centred = abs(x - 50) < 0.01 and abs(y - 50) < 0.01
    return {
        "shape": p["mark_shape"], "noun": p["mark_noun"], "size": f"{size:g}",
        "where": "EXACT DEAD-CENTER (50% horizontal, 50% vertical)" if centred else f"EXACT POINT {x:g}% from the left and {y:g}% from the top",
        "at": "exact dead-center (50%, 50%)" if centred else f"exact point ({x:g}% across, {y:g}% down)",
        "short": "dead-center" if centred else f"the point {x:g}% across and {y:g}% down",
    }


def _plate_key(path: Path) -> str:
    # size, not mtime: git checkouts rewrite mtimes and used to invalidate every cached result. Another project's mark: the check's
    # version too (2: fitted at other sizes and by its outline), so results from an older check are measured again; DEMO's keys stay
    # and the mark's size and place: changed in Project settings, every image is measured again against the new ones
    return f"{path.name}:{path.stat().st_size}" + ("" if is_demo() else f":{qa_engine.OWN_CHECK_VERSION}:{PROJECT['mark_size']:g}:{PROJECT['mark_x']:g}:{PROJECT['mark_y']:g}")


QA_LOCK = threading.Lock()
_QA_LAST_FLUSH = 0.0


def _flush_qa_cache() -> None:
    tmp = QA_CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(QA_CACHE))
    os.replace(tmp, QA_CACHE_FILE)  # atomic: a reader never sees a half-written file


def get_cached_qa(path: Path) -> dict:
    key = _plate_key(path)
    if key in QA_CACHE:
        return QA_CACHE[key]
    with QA_LOCK:  # each plate is evaluated once, even when several requests ask at the same time
        if key not in QA_CACHE:
            _remember_qa(key, evaluate_plate_qa(path, current_mark()))
        return QA_CACHE[key]


def _remember_qa(key: str, result: dict, now: bool = False) -> None:
    """A logo check's result, kept and written to disk (at most every 5 s: not a full rewrite per plate; now: a new image, written
    at once, seconds apart at most, so a quit right after a batch loses none). Under QA_LOCK."""
    global _QA_LAST_FLUSH
    QA_CACHE[key] = result
    if now or time.time() - _QA_LAST_FLUSH > 5:
        _QA_LAST_FLUSH = time.time()
        try:
            _flush_qa_cache()
        except Exception:
            pass





def check_new_image(path: Path) -> dict:
    """The logo check on an image not yet among the plates (its result is cached under its final name by the caller)."""
    return evaluate_plate_qa(path, current_mark())


def apply_critic(filename: str) -> None:
    """Score a plate with the Kimi critic. Advisory unless critic_autotrash is on (then low scores go to Trash with the reason)."""
    started_in = PROJECT["slug"] if PROJECT else None
    st = load_state()
    if not st.get("critic_enabled", True) or not st.get("kimi_api_key"):
        return
    try:
        r = critic.review_plate(PLATES_DIR / filename, call_kimi_llm, st["kimi_api_key"], st.get("kimi_model", "kimi-k3"), mark=None if is_demo() else f"small {PROJECT['mark_noun']} sits at {mark_words()['short']}")
    except Exception as e:
        print(f"[CRITIC] {filename}: {str(e)[:120]}", flush=True)
        return
    with STATE_LOCK:                                   # the review took seconds: the state as it is now, and only in the project it was made for
        if not PROJECT or PROJECT["slug"] != started_in:
            return
        st = load_state()
        st.setdefault("critic", {})[filename] = {"mean": r["mean"], "reason": r["reason"], "scores": r["scores"]}
        if st.get("critic_autotrash") and r["verdict"] == "trash" and filename not in st.get("trashed", []):
            st["trashed"] = sorted(set(st.get("trashed", [])) | {filename})
            st.setdefault("trashed_at", {})[filename] = time.time()
            st["critic_failed"] = sorted(set(st.get("critic_failed", [])) | {filename})
        save_state(st)
    print(f"[CRITIC] {filename} {r['mean']} {r['verdict']} - {r['reason']}", flush=True)


def world_examples(w: dict, n: int = 2) -> list[str]:
    """What to type to focus a territory, for its field's placeholder: two of its own subjects, without the article."""
    out = []
    for a in w.get("applications") or []:
        if not isinstance(a, str):                                 # a world Kimi invented or a project brought: one odd entry hid every world
            continue
        a = re.sub(r"^(a|an|the) ", "", a)
        a = re.split(r" (?:with|in|on|against|at|of|for|from|to|and|under|over|inside|by|off|lit|half|\w+ing|\w+ed)\b", a)[0]
        a = " ".join(a.split()[:3])                                # short, as someone would type it: "puffer jacket collar"
        last = a.split()[-1] if a else ""
        if last and last not in ("a", "an", "the", "seen", "stack", "pair", "set", "row", "black", "white", "cream", "grey") and not last.endswith("'s") and a not in out:
            out.append(a)
        if len(out) == n:
            break
    return out


def build_full_prompt(raw_prompt: str, project: dict | None = None) -> str:
    m = mark_words(project)
    return (
        f"{raw_prompt}. 9:16 vertical frame. "
        f"At the {m['where']} of the 9:16 frame at ~{m['size']}% frame width "
        f"(matching the exact {m['shape']} SHAPE and position of the reference guide image) is the SINGLE {m['noun']}, "
        f"physically integrated into the scene's exact perspective, lighting, and medium (whether 3D extruded sculpture, CAD wireframe, isometric object, nature formation, UI, or apparel — never a flat 2D sticker pasted over an unrelated angle, and no extra outer rings)."
    )


def _read_secret_key() -> str:
    try:
        return json.loads(SECRETS_FILE.read_text()).get("kimi_api_key", "")
    except Exception:
        return ""


STATE_LOCK = threading.RLock()
BOOT_ID = str(time.time())


def state_signature() -> str:
    """A cheap fingerprint of the library: it changes when the curation file is written or a plate is added or removed.
    The page polls it instead of downloading the whole state, and only fetches /api/state when it moves."""
    parts = []
    for p in (CURATION_FILE, PLATES_DIR):
        try:
            parts.append(str(p.stat().st_mtime_ns))
        except OSError:
            parts.append("0")
    return ":".join(parts)


def load_state() -> dict:
    st = _load_state_raw()
    st["kimi_api_key"] = _read_secret_key() or st.get("kimi_api_key", "") or os.environ.get("KIMI_API_KEY", os.environ.get("MOONSHOT_API_KEY", ""))
    return st


def _load_state_raw() -> dict:
    if CURATION_FILE.exists():
        st = None
        for attempt in range(3):                       # writes are atomic now; a read that still fails is retried before anything else
            try:
                st = json.loads(CURATION_FILE.read_text())
                break
            except Exception:
                time.sleep(0.05)
        if not isinstance(st, dict):
            # damaged for real: set aside, never written over (it held the whole curation: trash, order, groups, snapshots)
            keep = CURATION_FILE.with_name(f"{CURATION_FILE.stem}.damaged-{time.strftime('%Y%m%d-%H%M%S')}{CURATION_FILE.suffix}")
            try:
                os.replace(CURATION_FILE, keep)
                print(f"[STATE] {CURATION_FILE.name} could not be read: kept as {keep.name}, starting a new one", flush=True)
            except OSError:
                pass
        try:
            if not isinstance(st, dict):
                raise ValueError("no state")
            st.setdefault("trashed", [])
            st.setdefault("titles", {})
            st.setdefault("prompts", {})
            st.setdefault("models", {})
            st.setdefault("history", [])
            st.setdefault("order", [])
            st.setdefault("kimi_api_key", os.environ.get("KIMI_API_KEY", os.environ.get("MOONSHOT_API_KEY", "")))
            st.setdefault("kimi_model", "kimi-k3")
            sequences.ensure(st)
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
    sequences.ensure(state)
    _write_atomic(CURATION_FILE, json.dumps(state, indent=2))
    return state


def _write_atomic(f: Path, text: str) -> None:
    """Written whole or not at all: a reader (another request, the next start after a quit mid-save) never sees half a file."""
    tmp = f.with_name(f".{f.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(text)
    os.replace(tmp, f)


def save_state(state: dict) -> None:
    state = dict(state)
    key = state.pop("kimi_api_key", "")
    if key:
        SECRETS_FILE.write_text(json.dumps({"kimi_api_key": key}))
        SECRETS_FILE.chmod(0o600)
    _write_atomic(CURATION_FILE, json.dumps(state, indent=2))


def ordered_plate_files(st: dict) -> list[Path]:
    all_files = {p.name: p for p in sorted(PLATES_DIR.glob("*.jpg"))}
    order = sequences.get_order(st)
    result = []
    seen = set()
    for fname in order:
        if fname in all_files:
            result.append(all_files[fname])
            seen.add(fname)
    for fname, p in sorted(all_files.items()):
        if fname not in seen:
            result.append(p)
    return result


KIMI_TIMEOUT = 150  # seconds per attempt


KIMI_ENDPOINT: dict = {}     # key -> the endpoint that took it (found by check_kimi_key or a call): tried first, so a key is not sent round the others


def kimi_endpoints(key: str) -> list[str]:
    """Moonshot .ai, .cn and Kimi Coding, in the order to try for this key: the one that took it before first."""
    if key.startswith("sk-kimi-"):
        endpoints = ["https://api.kimi.com/coding/v1/chat/completions", "https://api.moonshot.ai/v1/chat/completions", "https://api.moonshot.cn/v1/chat/completions"]
    else:
        endpoints = ["https://api.moonshot.ai/v1/chat/completions", "https://api.moonshot.cn/v1/chat/completions", "https://api.kimi.com/coding/v1/chat/completions"]
    known = KIMI_ENDPOINT.get(key)
    return [known] + [e for e in endpoints if e != known] if known in endpoints else endpoints


def check_kimi_key(key: str, timeout: float = 8) -> str:
    """'ok' (an endpoint lists its models for it: remembered), 'refused' (every endpoint says 401/403) or 'unknown' (no answer)."""
    refused = 0
    eps = kimi_endpoints(key)
    for ep in eps:
        req = urllib.request.Request(ep.replace("/chat/completions", "/models"), headers={"Authorization": f"Bearer {key}", "User-Agent": "KimiCLI/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout):
                KIMI_ENDPOINT[key] = ep
                return "ok"
        except urllib.error.HTTPError as e:
            refused += e.code in (401, 403)
        except Exception:
            pass
    return "refused" if refused == len(eps) else "unknown"


class KimiOffline(RuntimeError):
    """Kimi could not be reached at all: no network, or its address does not answer."""


def call_kimi_llm(prompt: str, api_key: str, preferred_model: str = "kimi-k3", images: list | None = None, system: str | None = None,
                  timeout: float | None = None, attempts: int = 2) -> str:
    """Calls Kimi API (Moonshot .ai, .cn, or Kimi Coding) with automatic model/endpoint fallback."""
    key = (api_key or "").strip()
    if not key:
        raise RuntimeError("NEEDS_KIMI_KEY: Please enter your Kimi API key in ⚙️ Settings.")

    endpoints = kimi_endpoints(key)

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

    errors: list = []
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
            for attempt in range(1, attempts + 1):  # a timeout is retried once on the same model: writing 10 scenes can take over a minute
                try:
                    with urllib.request.urlopen(req, timeout=timeout or KIMI_TIMEOUT) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                        KIMI_ENDPOINT[key] = ep
                        return data["choices"][0]["message"]["content"].strip()
                except urllib.error.HTTPError as e:
                    err_body = e.read().decode("utf-8", errors="replace")
                    errors.append(f"HTTP {e.code} ({model} @ {ep.split('/')[2]}): {err_body[:180]}")
                    break
                except Exception as e:
                    errors.append(f"{ep.split('/')[2]} ({model}): {e}")
                    if isinstance(e, urllib.error.URLError) and "timed out" not in str(e):
                        # no network (the name does not resolve, nothing answers): every other model and endpoint fails the same way
                        raise KimiOffline(f"Kimi could not be reached ({getattr(e, 'reason', e)})")
                    if "timed out" not in str(e) or attempt == attempts:
                        break
            if errors and (errors[-1].startswith("HTTP 401") or "timed out" in errors[-1]):
                break  # the key is refused here, or the endpoint is too slow: another model will not change that

    # Every attempt, not just the last: a key that only fits the first endpoint fails with 401 on the others,
    # which used to hide what really went wrong on the endpoint that matters.
    raise RuntimeError("Kimi API call failed (" + " | ".join(errors[:6]) + ")")


def quality_bar() -> str:
    return QUALITY_BAR.replace("Demo, a creative toolkit for creatives at an agency group", PROJECT["brief"], 1)


QUALITY_BAR = (
    "QUALITY BAR: this is for Demo, a creative toolkit for creatives at an agency group, and it must look like a top design studio's identity reel "
    "(Pentagram-level): one idea per frame, one hero subject, restrained composition with confident negative space, a disciplined palette (max 3 colors), "
    "believable tactile materials, photoreal studio/CGI craft, razor-sharp edges. The mark may be subtle or bold, but it is deliberate, "
    "physically part of the scene, and never lost. If any type appears it is intentional, rigorous grotesk typography (huge crop or tiny micro-type), never gibberish; "
    "otherwise no text. No collage, no clutter, no stock-photo look, no generic neon trope."
)


def parse_llm_json(out: str, opener: str):
    """First JSON value starting at `opener` ('{' or '['); ignores trailing text, fences or a second value."""
    i = out.find(opener)
    if i == -1:
        raise RuntimeError(f"Kimi did not return JSON ({out[:120]!r})")
    value, _ = json.JSONDecoder().raw_decode(out[i:])
    return value


def invent_world(st: dict, api_key: str, kimi_model: str, direction: str = "") -> dict:
    """Wildcard: Kimi authors a brand-new world in the same format as chapters.WORLDS."""
    known = ", ".join(w["name"] for w in chapters.all_worlds(st))
    ref = chapters.WORLDS[0]
    steer = f"The director asked for: \"{direction}\". Build the world around that." if direction else "Pick a discipline or phenomenon NOT covered by the existing worlds."
    out = call_kimi_llm(projects.rebrand(
        f"Invent ONE new creative world for a 9:16 match-cut film where a small {mark_words()['noun']} sits at {mark_words()['short']} in every shot. {steer}\n"
        f"Existing worlds (do not repeat): {known}.\n"
        f"It must be authored like a design-studio identity (Pentagram quality): one idea, a restrained palette (max 3 colors), a rigorous visual language, a dark and a light register. "
        f"Return ONLY raw JSON (no fences) with keys: name (2-4 words, 'X & Y' style ok), brief (2 sentences), palette (one sentence, may use {' '.join(PROJECT['palette']) or 'the brand colours'}), "
        f"applications (10 concrete photographable subjects), marks (5 ways the mark physically emerges from the scene). Example format: {json.dumps({k: ref[k] for k in ('name', 'brief', 'palette', 'marks')})[:400]}", PROJECT),
        api_key=api_key, preferred_model=kimi_model,
    )
    w = parse_llm_json(out, "{")
    for k in ("name", "brief", "palette", "applications", "marks"):
        if not w.get(k):
            raise RuntimeError(f"invented world missing '{k}'")
    w["weight"] = 1.0
    w["wildcard"] = True
    st.setdefault("custom_worlds", [])
    st["custom_worlds"] = [x for x in st["custom_worlds"] if x["name"] != w["name"]] + [w]
    print(f"[KIMI] invented world '{w['name']}'", flush=True)
    return w


def match_world(st: dict, api_key: str, kimi_model: str, direction: str) -> dict | None:
    """Route a typed direction to the closest existing world, or None if nothing fits (caller invents one)."""
    worlds = chapters.all_worlds(st)
    listing = "\n".join(f"- {w['name']}: {w['brief'][:140]}" for w in worlds)
    try:
        out = call_kimi_llm(
            f"A creative director wants images about: \"{direction}\".\nWhich of these territories fits best?\n{listing}\n"
            f"Reply with ONLY the exact territory name, or NEW if none is a genuinely good fit.",
            api_key=api_key, preferred_model=kimi_model,
        ).strip().strip('"').strip()
    except Exception:
        return None
    for w in worlds:
        if w["name"].lower() == out.lower():
            print(f"[KIMI] direction '{direction}' -> '{w['name']}'", flush=True)
            return w
    return None


def _ask_chunk(st: dict, api_key: str, kimi_model: str, w: dict, count: int, direction: str, batch: list) -> tuple[list, dict]:
    """One Kimi request for up to `count` scenes in territory `w`; `batch` = scenes already collected for this batch (never repeated)."""
    titles = st.get("titles", {})
    prompts = st.get("prompts", {})
    brief = taste.taste_brief(st, titles, prompts)
    ban_str = ", ".join(list(dict.fromkeys(list(titles.values()) + st.get("history", []) + [b["title"] for b in batch]))[-80:])

    n_ask = count + 2  # a little spare: some scenes come back as near-copies of past images and are dropped
    shots = diversity.sample_shots(n_ask, st.get("recent_axes"))
    seen_subjects = st.get("recent_subjects", {}).get(w["name"], [])[-60:]
    avoid_block = ""
    if direction:
        # the director's words choose the subjects; the territory only supplies look, palette and how the mark emerges
        shot_lines = "\n".join(
            f"Shot {i + 1}: subject = invent a DIFFERENT concrete subject that is a clear instance of the direction \"{direction}\" | optional inspiration: light {sh['lighting']}, camera {sh['camera']}"
            for i, sh in enumerate(shots)
        )
    else:
        # Kimi invents fresh subjects for this territory on the spot; the hand-written list only shows the flavour
        flavour = random.sample(w["applications"], k=min(5, len(w["applications"])))
        shot_lines = "\n".join(
            f"Shot {i + 1}: subject = invent a fresh, specific object or scene that belongs to this territory | optional inspiration (use only what serves the idea, ignore the rest): texture {sh['texture']}, light {sh['lighting']}, camera {sh['camera']}"
            for i, sh in enumerate(shots)
        )
        avoid_block = (
            f"SUBJECTS: every shot needs its own new subject invented for this territory. These examples only show the flavour of the territory, they are NOT a menu, never reuse them or their close variants: {'; '.join(flavour)}.\n"
            + (f"Subjects already used here recently (never repeat these or close variants): {'; '.join(seen_subjects)}.\n" if seen_subjects else "")
            + "Reach for subjects a design studio would actually photograph, not the first obvious thing for the territory.\n\n"
        )
    liked = "\n".join(f"- {t}: {p[:200]}" for t, p in brief["liked"]) or "(none yet)"
    disliked = ", ".join(brief["disliked"]) or "(none yet)"
    mw = mark_words()
    llm_prompt = (
        f"Return ONLY a raw JSON array (no markdown fences) of {n_ask} objects with keys \"title\", \"subject\" (the shot's main subject in 2-6 words), \"idea\", \"guide\" ('dark' or 'light' = whether the frame is mostly dark or mostly light) and \"prompt\". "
        f"They are shots for a 9:16 vertical match-cut film where one small {mw['noun']} sits at the {mw['at']} at {mw['size']}% frame width.\n\n"
        f"WORLD: {w['name']}. {w['brief']}\n"
        + (f"DIRECTOR'S DIRECTION (a HARD REQUIREMENT): \"{direction}\". Every shot's central subject must plainly be this; nothing in a shot may belong to a different subject area "
           f"(for example if the direction is weather, do not show plants, sand or webs). The world below only supplies the palette, finish and how the mark emerges.\n" if direction else "")
        + f"Palette for this whole batch: {w['palette']}. Every shot lives inside this world and palette so the cut sequence coheres; "
        f"vary subject, framing and light, not the world.\n\n"
        f"For each shot first write \"idea\": ONE line on how the mark physically emerges from the scene (inspirations: {'; '.join(w['marks'])}; or something better). "
        f"Reject gimmicks like 'logo on a thing'. Then write \"prompt\" from that idea.\n\n"
        f"Alternate registers: odd-numbered shots are DARK register (mostly black or deep tones, luminous emitted light, \"guide\":\"dark\"); even-numbered shots are LIGHT register (mostly bone or pale tones, soft light, \"guide\":\"light\"). "
        f"Each register uses the world's palette for that register.\n\n{avoid_block}Shots:\n{shot_lines}\n\n{quality_bar()}\n\n"
        f"TASTE (learned from what the director kept):\nLiked:\n{liked}\nSteer away from the feel of: {disliked}\n\n"
        f"RULES:\n"
        f"1. The mark is physically part of the scene (same perspective, light, material). Never a flat sticker, no outer rings, exactly one mark.\n"
        f"2. Each prompt: 2-4 sentences, concrete visual language, name lens/light/material, end by stating the mark's treatment and dead-center position.\n"
        f"3. All shots must look clearly different from each other and from these past scenes: [{ban_str}]."
    )
    print(f"[KIMI] world='{w['name']}': asking Kimi for {n_ask} scenes ({count} wanted + {n_ask - count} spare in case some are near-duplicates), model {kimi_model}...", flush=True)
    llm_prompt = projects.rebrand(llm_prompt, PROJECT)                       # another brand: DEMO's colours in the worlds become its own
    out = call_kimi_llm(llm_prompt, api_key=api_key, preferred_model=kimi_model)
    s_idx, e_idx = out.find("["), out.rfind("]")
    if s_idx == -1 or e_idx == -1:
        raise RuntimeError("Kimi did not return a valid JSON array of prompts")
    ideas = parse_llm_json(out, "[")

    past = list(prompts.values()) + [b["prompt"] for b in batch]
    kept, dropped = [], []
    for idea in ideas:
        p = idea.get("prompt", "")
        nov = taste.novelty(p, past)
        if nov < 0.45:
            same_batch = taste.novelty(p, [b["prompt"] for b in batch] + [k.get("prompt", "") for k in kept])
            print(f"[DIVERSITY] near-duplicate '{idea.get('title')}' (novelty={nov:.2f})", flush=True)
            dropped.append((nov, idea, same_batch))
            continue
        past.append(p)
        kept.append(idea)
    fresh = len(kept)
    if len(kept) < count:  # the batch size you asked for is respected: top up with the least-similar of the dropped ones
        # (copies of a past image are acceptable stand-ins; copies of something already in THIS batch are not)
        spare = sorted((d for d in dropped if d[2] >= 0.25), key=lambda x: -x[0])
        kept += [idea for _, idea, _ in spare[: count - len(kept)]]
    kept = kept[:count]
    info = {"asked_kimi": n_ask, "from_kimi": len(ideas), "dropped_duplicates": len(dropped), "topped_up": max(0, len(kept) - fresh)}

    flat = [{"title": i.get("title", "Untitled"), "guide": i.get("guide", "dark"), "prompt": i["prompt"], "idea": i.get("idea", ""), "world": w["name"], "subject": str(i.get("subject", "")).strip()} for i in kept]

    used = st.setdefault("recent_subjects", {}).setdefault(w["name"], [])
    used.extend(x["subject"] for x in flat if x["subject"])
    st["recent_subjects"][w["name"]] = used[-60:]
    st.setdefault("recent_worlds", []).append(w["name"])
    st["recent_worlds"] = st["recent_worlds"][-8:]
    recent = st.setdefault("recent_axes", {})
    for sh in shots[: len(kept)]:
        for axis, val in sh.items():
            recent.setdefault(axis, []).append(val)
            recent[axis] = recent[axis][-12:]
    print(f"[KIMI] sending {len(flat)} scenes to Krea: {[x['title'] for x in flat]}", flush=True)
    return flat, info


def ask_kimi_for_prompts(st: dict, api_key: str, kimi_model: str, count: int = 4, world: str | None = None, direction: str = "", stats: dict | None = None) -> list[dict]:
    """
    One authored territory per batch (shots cohere), idea-first, steered by taste, near-duplicates dropped.
    Returns exactly `count` scenes whenever Kimi can supply them: large batches are asked in chunks of up to 10,
    and a short answer is followed up with a request for just the missing ones.
    """
    w = chapters.choose_world(st, world or "")
    if direction and not world:
        w = match_world(st, api_key, kimi_model, direction) or invent_world(st, api_key, kimi_model, direction)
    elif w is None:
        w = invent_world(st, api_key, kimi_model, direction)

    out: list = []
    totals = {"asked_kimi": 0, "from_kimi": 0, "dropped_duplicates": 0, "topped_up": 0, "kimi_calls": 0}
    for _ in range(4):                                    # chunks plus at most a couple of follow-ups
        need = count - len(out)
        if need <= 0:
            break
        try:
            got, info = _ask_chunk(st, api_key, kimi_model, w, min(need, 10), direction, out)
        except Exception:
            if not out:
                raise                                      # nothing at all: let the caller report it
            print("[KIMI] a follow-up request failed; sending what we have", flush=True)
            break
        totals["kimi_calls"] += 1
        for k, v in info.items():
            totals[k] += v
        if not got:
            break
        out += got
    if len(out) < count:
        print(f"[KIMI] only {len(out)} of the {count} scenes you asked for could be written", flush=True)
    if stats is not None:
        stats.update(world=w["name"], returned=len(out), wanted=count, **totals)
    return out[:count]


AI_JOBS: dict = {}
AI_STEPS = ["Reading the images", "Writing the edit brief", "Cutting the edit", "Reviewing the cuts"]


def build_ai_order(st: dict, call_llm, api_key: str, model: str, length: int | None = None, direction: str = "",
                   progress=lambda step, note="": None, only: set | None = None) -> dict:
    """Works out an AI edit of the images currently shown (does not touch the state). Kimi writes the brief; editor.py cuts the order.
    `only`: the images of a group: just those are ordered (and they keep the places the group has in the order)."""
    trashed = set(st.get("trashed", []))
    files = [p for p in ordered_plate_files(st) if p.name not in trashed and (only is None or p.name in only)]
    if len(files) < 2:
        raise RuntimeError("Need at least two images in the selection to make an edit.")
    progress(0, f"{len(files)} images")
    world = st.get("worlds", {})
    items = [{"name": p.name, "f": features.get(p), "world": world.get(p.name)} for p in files]
    features.save_cache()
    progress(1, "looking at the contact sheet")
    note, brief_ok = "", True
    try:
        sheet = editor.contact_sheet(files)
        brief = editor.brief_to_names(editor.ask_brief(call_llm, api_key, model, sheet, len(files), direction, length), [p.name for p in files])
    except Exception as e:                      # Kimi is optional here: the edit still works from the measurements alone
        print(f"[EDIT] brief failed, using measurements only: {e!r}", flush=True)
        brief, note, brief_ok = {}, "Kimi was unavailable, so this edit uses measurements only. ", False
    progress(2, "choosing the order")
    result = editor.order_images(items, brief, length)
    progress(3, "writing the summary")
    titles = st.get("titles", {})
    return {"result": result, "summary": note + editor.summarize(titles, result, brief.get("summary")), "brief_ok": brief_ok, "images": len(files)}


_MEASURING = {"on": False}


def measure_in_background() -> None:
    """Measures the plates not measured yet (once, in a thread), so their looks show in the automatic groups at the next refresh."""
    if _MEASURING["on"]:
        return
    missing = [p for p in PLATES_DIR.glob("*.jpg") if features.peek(p) is None]
    if not missing:
        return
    _MEASURING["on"] = True

    def run():
        try:
            for p in missing:
                try:
                    features.get(p)
                except Exception:
                    pass
            features.save_cache()
        finally:
            _MEASURING["on"] = False
    threading.Thread(target=run, daemon=True).start()


_INFLIGHT = {"n": 0}
_INFLIGHT_LOCK = threading.Lock()


class inflight:
    """Marks 'a long job is running' so the dev runner and the page know not to restart / reload underneath it."""
    def __enter__(self):
        with _INFLIGHT_LOCK:
            _INFLIGHT["n"] += 1

    def __exit__(self, *a):
        with _INFLIGHT_LOCK:
            _INFLIGHT["n"] -= 1


# the page's long jobs (a batch of images, an export) have gaps between their requests (Kimi writing, the next image, the frames):
# while one runs the page keeps a lease (POST /api/busy {"for": s}, renewed every 10 s), so busy() holds for the whole job: no
# project switch, no dev restart in a gap. It lapses by itself if the page goes away.
_LEASE = {"until": 0.0}


def busy() -> bool:
    return _INFLIGHT["n"] > 0 or ai_busy() or time.time() < _LEASE["until"]


def generate_with_retry(attempts: int = 3, pause=(3.0, 8.0), sleep=None, log=print, trace: list | None = None, **kw) -> bytes:
    """One Krea image, retried on transient errors (rate limits, timeouts, empty replies). Never retries a missing login."""
    last = None
    for i in range(attempts):
        t0 = time.time()
        try:
            data = generate_plate_via_krea_mcp(**kw)
            if trace is not None:
                trace.append({"n": i + 1, "ok": True, "seconds": round(time.time() - t0, 1)})
            return data
        except Exception as e:
            last = e
            text = str(e)
            if trace is not None:
                trace.append({"n": i + 1, "ok": False, "seconds": round(time.time() - t0, 1), "error": text[:300], "code": getattr(e, "code", None)})
            if not getattr(e, "retryable", True) or "not connected" in text.lower() or "401" in text or "403" in text:
                break                                   # moderation rejections, a job still running, a missing login: retrying cannot help
            if i < attempts - 1:
                wait = pause[min(i, len(pause) - 1)]
                log(f"[GENERATE] attempt {i + 1}/{attempts} failed ({kw.get('model')}): {text[:200]} - retrying in {wait:.0f}s", flush=True)
                (sleep or time.sleep)(wait)
    raise last


SOFTEN_ASK = (
    "An image model's content moderation rejected the prompt below without saying why. Rewrite it so the same composition, subject type and mood survive, "
    "but anything a moderation system could object to is removed or made generic: real place names and landmarks, brand names and trademarks, named people, "
    "readable text or slogans on signs, political or religious symbols, violence, weapons, drugs, nudity, anything involving children. "
    "Keep the sentence about the single circular mark at the exact dead-center untouched. Return ONLY the rewritten prompt, no commentary.\n\nPROMPT:\n"
)


def soften_ask() -> str:
    return SOFTEN_ASK if is_demo() else SOFTEN_ASK.replace("single circular mark at the exact dead-center", f"single {PROJECT['mark_noun']} and where it sits")


def soften_prompt(raw_prompt: str, api_key: str, model: str, call_llm=None) -> str | None:
    """A more neutral wording of a prompt that moderation refused, or None if Kimi cannot provide one."""
    try:
        out = (call_llm or call_kimi_llm)(soften_ask() + raw_prompt, api_key=api_key, preferred_model=model).strip().strip('"').strip()
    except Exception as e:
        print(f"[GENERATE] could not soften the prompt: {e!r}", flush=True)
        return None
    return out if len(out) > 40 and out != raw_prompt else None


def ai_busy() -> bool:
    return any(not j.get("done") for j in AI_JOBS.values())


# While the AI is ordering, nothing that changes the selection may run (the order is computed from a snapshot of it).
LOCKED_DURING_AI = {"/api/trash", "/api/reorder", "/api/purge", "/api/sequence", "/api/generate-image", "/api/invent-prompts", "/api/export-video"}


def add_ai_sequence(st: dict, built: dict) -> dict:
    """Adds the finished edit to the CURRENT state (so reorders made while it was working are kept) and switches to it."""
    result = built["result"]
    taken = set(result["names"]) | set(result["left_out"])
    rest = [n for n in sequences.get_order(st) if n not in taken]
    return sequences.add_ai(st, result["names"] + result["left_out"] + rest, summary=built["summary"],
                            cut_off=len(result["names"]) if result["left_out"] else None, cuts=result["cuts"])


def add_group_order(st: dict, built: dict, only: set) -> dict:
    """A group re-ordered by the AI: its images change places among themselves; everything else stays where it is."""
    new = iter(built["result"]["names"] + built["result"]["left_out"])
    merged = [next(new, n) if n in only else n for n in sequences.get_order(st)]
    return sequences.add_ai(st, merged, summary=built["summary"], cut_off=None, cuts=built["result"]["cuts"])


def run_ai_order_job(job_id: str, length, direction: str, only: set | None = None) -> None:
    job = AI_JOBS[job_id]
    t_job = time.time()
    try:
        st = load_state()
        key, model = st.get("kimi_api_key", ""), st.get("kimi_model", "kimi-k3")

        def progress(step, note=""):
            job.update(step=step, stage=AI_STEPS[step], note=note)
        built = build_ai_order(st, call_kimi_llm, key, model, None if only else length, direction, progress, only)
        with STATE_LOCK:
            fresh = load_state()
            seq = add_group_order(fresh, built, only) if only else add_ai_sequence(fresh, built)
            save_state(fresh)
        job.update(done=True, step=len(AI_STEPS), stage="Done", sequence={"id": seq["id"], "name": seq["name"], "summary": seq["summary"]})
        gen_log.record("ai_order", ok=True, images=built["images"], length=length, direction=direction, kimi_ok=built["brief_ok"], summary=seq["summary"], seconds=round(time.time() - t_job, 1))
    except Exception as e:
        print(f"[EDIT] failed: {e!r}", flush=True)
        job.update(done=True, error=str(e))
        gen_log.record("ai_order", ok=False, length=length, direction=direction, error=str(e)[:300], seconds=round(time.time() - t_job, 1))


def next_plate_number(st: dict) -> int:
    """Next free plate number. Counts purged plates too (their records stay in the state), so numbers are never reused."""
    names = [p.name for p in PLATES_DIR.glob("*.jpg")]
    for key in ("titles", "prompts", "models"):
        names += list(st.get(key, {}))
    names += list(st.get("purged", []))
    nums = [int(n.split("_", 1)[0]) for n in names if n.split("_", 1)[0].isdigit()]
    return max(nums, default=15) + 1


def plate_name(n) -> str | None:
    """A plate's file name as it may be used in a path: a bare name, nothing that climbs out of the plates folder (a project file
    from someone else, or a request, could carry '../../x' or '/Users/...': it must never reach a delete). None if it is not one."""
    n = str(n or "")
    return n if n and n == Path(n).name and not n.startswith(".") and "\\" not in n and "/" not in n else None


def purge_plates(st: dict, requested) -> tuple[int, int]:
    """Permanently delete trashed plates (never a kept one). Files and QA results go; the keep/trash record stays
    so taste and territory scores keep learning from them. Returns (files deleted, bytes freed)."""
    trashed = set(st.get("trashed", []))
    names = [n for n in requested if n in trashed and plate_name(n)]       # never a path: only files in this project's plates folder
    freed = deleted = 0
    for n in names:
        f = PLATES_DIR / n
        if f.is_file():
            freed += f.stat().st_size
            f.unlink()
            deleted += 1
        for w in THUMB_WIDTHS:
            (THUMBS_DIR / str(w) / n).unlink(missing_ok=True)
        for key in [k for k in QA_CACHE if k.rpartition(":")[0] == n]:
            QA_CACHE.pop(key, None)
    st["purged"] = sorted(set(st.get("purged", [])) | set(names))
    sequences.remove_everywhere(st, names)
    return deleted, freed


EXPORT_AUDIO_MAX_BYTES = 80 * 1024 * 1024


EXPORT_FRAME_MAX_BYTES = 16 * 1024 * 1024
EXPORT_FRAMES_MAX = 200000                 # about 1 h 50 at 30 fps


DESCRIBE_MARK = (
    "This is a brand's mark (logo), shown on grey. It will sit at the same place in every shot of a film of AI images, physically part of each "
    "scene. Describe it for an image model. Return ONLY raw JSON: {\"name\": \"the brand's name if you recognise the mark or can read it, else a short "
    "fitting project name\", \"brand\": \"one line on who the brand is, e.g. Nike, a global sportswear brand (empty if unknown)\", \"shape\": \"2-6 words naming its shape and kind, e.g. circular orbital logo, "
    "angular monogram, horizontal wordmark\", \"noun\": \"1-3 words to call it in a sentence, e.g. circular mark, monogram, wordmark\", "
    "\"palette\": [\"2 or 3 hex colours that would suit a brand with this mark, besides its own\"]}"
)


def describe_mark(img, api_key: str, model: str) -> dict:
    """Kimi's words for a mark (its shape, what to call it) and colours to go with it."""
    tile = Image.new("RGB", (512, 512), (128, 128, 128))
    m = img.convert("RGBA")
    m.thumbnail((400, 400))
    tile.paste(m, ((512 - m.width) // 2, (512 - m.height) // 2), m)
    buf = io.BytesIO(); tile.save(buf, "JPEG", quality=90)
    data = parse_llm_json(call_kimi_llm(DESCRIBE_MARK, api_key, model, images=[buf.getvalue()], timeout=60, attempts=1), "{")
    clean = lambda v, n: re.sub(r"\s+", " ", str(v or "")).strip()[:n]
    return {"name": clean(data.get("name"), 60), "brand": clean(data.get("brand"), 200), "shape": clean(data.get("shape"), 80), "noun": clean(data.get("noun"), 40),
            "suggested": [c for c in (projects.clean_hex(x) for x in (data.get("palette") or [])[:3]) if c]}


def zips_folder() -> Path:
    """Where downloads wait to be fetched (once); any left unfetched for an hour are cleared."""
    folder = EXPORT_DIR / "zips"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.zip"):
        if time.time() - old.stat().st_mtime > 3600:
            old.unlink(missing_ok=True)
    return folder


def build_download_zip(files: list[str], label: str) -> tuple[Path, str]:
    """The full-size images shown in Curate, numbered in their order, in one zip (stored as they are: JPEGs do not compress).
    Kept in studio/.export/zips until fetched once (older ones are cleared). Returns (file, download name)."""
    import zipfile
    names = [f for f in files if f and "/" not in f and "\\" not in f and not f.startswith(".") and (PLATES_DIR / f).is_file()]
    if not names:
        raise ValueError("No images to download.")
    folder = zips_folder()
    head = re.sub(r"[^A-Za-z0-9]+", "-", f"{PROJECT['name']} {label}").strip("-")[:60] or "Phosphene"
    name = f"{head}-{len(names)}-images-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    out = folder / f"{uuid.uuid4().hex}.zip"
    width = max(3, len(str(len(names))))
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as z:
        for i, f in enumerate(names, 1):
            z.write(PLATES_DIR / f, f"{name[:-4]}/{i:0{width}d}-{f}")
    return out, name


def export_frames_dir() -> Path:
    """The export's frames, drawn by the page (render.js, WebGL2: the preview's renderer) and sent one by one before it asks for the video."""
    return EXPORT_DIR / "frames"


def export_audio_file() -> Path:
    """The drone rendered by the page (WebAudio) for the next export: the page sends it just before it asks for the video."""
    return EXPORT_DIR / "export-music.wav"


def export_filename(bpm: float, multiple: float, ts: float, invert_mode: str = "off", zoom_mode: str = "off", music: str = "off", variable: tuple | None = None, edit: str = "") -> str:
    """Unique, descriptive name per export so nothing is overwritten: Phosphene-136bpm-x4-invert-zoomout-20261025-093005.mp4,
    or the edit's name first: Night-strobe-136bpm-x4-20261025-093005.mp4"""
    mult = f"{multiple:.2f}".rstrip("0").rstrip(".")
    fx = ("-invert" if invert_mode in ("mono", "colour") else "") + (f"-zoom{zoom_mode}" if zoom_mode != "off" else "")
    fx += "-music" if music == "synth" else ""
    pace = f"var{int(round(variable[0]))}to{int(round(variable[1]))}ms" if variable else f"{int(round(bpm))}bpm-x{mult}"
    head = re.sub(r"[^A-Za-z0-9]+", "-", edit or (PROJECT or {}).get("name", "")).strip("-")[:40] or "Phosphene"   # the edit, else the project
    return f"{head}-{pace}{fx}-{time.strftime('%Y%m%d-%H%M%S', time.localtime(ts))}.mp4"


EXPORT_NAME = re.compile(r"(^Demo-|-\d{8}-\d{6}\.mp4$)")   # what the studio wrote (older ones began with Demo-), not files of yours


def prune_exports(folder: Path, keep: int = 12) -> None:
    """Keep the newest `keep` exported videos."""
    files = sorted((p for p in folder.glob("*.mp4") if EXPORT_NAME.search(p.name)), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in files[keep:]:
        old.unlink(missing_ok=True)


def thumb_file(name: str, width: int) -> Path | None:
    """A resized copy of one plate, made on first request and kept. None when the name or width is not valid."""
    if width not in THUMB_WIDTHS or not name or "/" in name or "\\" in name or name.startswith("."):
        return None
    src = PLATES_DIR / name
    if not src.is_file():
        return None
    out = THUMBS_DIR / str(width) / name
    if not out.exists() or out.stat().st_mtime < src.stat().st_mtime:
        out.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((width, width * 4), Image.Resampling.LANCZOS)
            tmp = out.with_suffix(".tmp")
            im.save(tmp, "JPEG", quality=84)
        tmp.replace(out)
    return out


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

    def from_this_computer(self, command: bool) -> bool:
        """Only requests to this computer by its own name (a website that points its domain at 127.0.0.1, DNS rebinding, is refused),
        and commands (POST) only from the app's own page (another site's page cannot drive the server: empty the trash, switch
        project, read the key). Clients that send no Origin (the app shell, curl, the tests) are local by construction."""
        local = ("localhost", "127.0.0.1", "::1")
        host = urlparse(f"http://{self.headers.get('Host') or ''}").hostname
        origin = self.headers.get("Origin")
        ok = host in local and (not command or not origin or urlparse(origin).hostname in local)
        if not ok:
            self.send_json({"ok": False, "error": "Not from this computer."}, 403)
        return ok

    def do_GET(self):
        parsed = urlparse(self.path)
        if not self.from_this_computer(command=False):
            return
        if parsed.path == "/api/thumb":
            q = parse_qs(parsed.query)
            try:
                f = thumb_file((q.get("f") or [""])[0], int((q.get("w") or ["0"])[0]))
            except Exception:
                f = None
            if f is None:
                self.send_json({"ok": False, "error": "No such image"}, 404)
                return
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")   # a plate's file name never changes content
            self.end_headers()
            self.wfile.write(data)
            return
        if parsed.path.startswith("/static/") and (WEB_DIST / parsed.path.lstrip("/")).is_file() and (WEB_DIST / parsed.path.lstrip("/")).resolve().is_relative_to(WEB_DIST.resolve()):
            f = WEB_DIST / parsed.path.lstrip("/")
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", {".js": "text/javascript", ".css": "text/css"}.get(f.suffix, "application/octet-stream"))
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(data)
            return

        if parsed.path in ("/", "/index.html", "/studio", "/studio/"):
            index = WEB_DIST / "index.html"
            if index.exists():
                html_bytes = index.read_bytes()
            else:
                html_bytes = (
                    "<!doctype html><meta charset=utf-8><title>Match-Cut Studio</title>"
                    "<body style='font:15px system-ui;background:#0b0b0d;color:#ddd;padding:40px;line-height:1.6'>"
                    "<h2>The API is running.</h2><p>Open the app at <a style='color:#ec540c' href='http://localhost:5173'>http://localhost:5173</a> "
                    "(started by <code>npm run dev</code>), or run <code>npm run build</code> to serve it from here.</p>"
                ).encode()
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
                html_mtime = (WEB_DIST / "index.html").stat().st_mtime
            except OSError:
                html_mtime = 0
            self.send_json({"boot": BOOT_ID, "html": html_mtime, "state": state_signature()})
            return

        if parsed.path == "/api/log":
            try:
                n = max(1, min(500, int(parse_qs(parsed.query).get("n", ["50"])[0])))
            except ValueError:
                n = 50
            events = gen_log.read(None)
            self.send_json({"ok": True, "summary": gen_log.summarize(events), "events": events[-n:], "lines": [gen_log.describe(e) for e in events[-n:]]})
            return

        if parsed.path == "/api/projects":
            self.send_json({"ok": True, "active": PROJECT["slug"] if PROJECT else None, "projects": [projects.public(p) for p in projects.all_projects()]})
            return

        if parsed.path in ("/api/plate", "/api/project-mark"):                 # a full-size plate of this project, or a project's mark
            q = parse_qs(parsed.query)
            try:
                if parsed.path == "/api/plate":
                    name = (q.get("f") or [""])[0]
                    f = PLATES_DIR / name if name and "/" not in name and "\\" not in name and not name.startswith(".") else None
                else:
                    f = projects.load((q.get("p") or [PROJECT["slug"] if PROJECT else ""])[0])["mark_file"]
            except Exception:
                f = None
            if f is None or not f.is_file():
                self.send_json({"ok": False, "error": "No such image"}, 404)
                return
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png" if f.suffix.lower() == ".png" else "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable" if parsed.path == "/api/plate" else "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return

        if parsed.path == "/api/krea-callback":                                  # Krea sends the browser back here after the sign-in
            q = parse_qs(parsed.query)
            try:
                if q.get("error"):
                    raise RuntimeError((q.get("error_description") or q["error"])[0])
                krea_finish_login((q.get("code") or [""])[0], (q.get("state") or [""])[0])
                title, text = "Krea is connected", "You can close this tab and go back to Phosphene."
            except Exception as e:
                title, text = "Krea is not connected", str(e)[:300]
            gen_log.record("krea_login", ok=title == "Krea is connected", error=None if title == "Krea is connected" else text)
            html_bytes = (f"<!doctype html><meta charset=utf-8><title>{title}</title><body style='font:15px system-ui;background:#121110;color:#FEFFE7;padding:48px;line-height:1.6'>"
                          f"<h2 style='margin:0 0 8px'>{title}</h2><p style='color:#A8A390'>{text.replace('<', '&lt;')}</p>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html_bytes)))
            self.end_headers()
            self.wfile.write(html_bytes)
            return

        if parsed.path == "/api/download-zip":                                  # a zip made by POST /api/download-zip, fetched once
            q = parse_qs(parsed.query)
            zid, name = (q.get("id") or [""])[0], (q.get("name") or ["Phosphene.zip"])[0]
            f = EXPORT_DIR / "zips" / f"{zid}.zip"
            if not re.fullmatch(r"[0-9a-f]{32}", zid) or not f.is_file():
                self.send_json({"ok": False, "error": "That download has expired. Press Download again."}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(f.stat().st_size))
            self.send_header("Content-Disposition", f"attachment; filename=\"{re.sub(r'[^A-Za-z0-9._-]', '-', name)}\"")
            self.end_headers()
            with f.open("rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1 << 20)
            f.unlink(missing_ok=True)
            return

        if parsed.path == "/api/busy":
            self.send_json({"ok": True, "busy": busy()})
            return

        if parsed.path == "/api/order-ai-status":
            job = AI_JOBS.get(parse_qs(parsed.query).get("job", [""])[0])
            self.send_json({"ok": bool(job), **(job or {"error": "unknown job"})})
            return

        if parsed.path == "/api/worlds":
            st = load_state()
            stats = chapters.world_stats(st)
            self.send_json({"ok": True, "worlds": [
                {"name": w["name"], "brief": w["brief"], "examples": world_examples(w), "n": stats.get(w["name"], {}).get("n", 0), "kept": stats.get(w["name"], {}).get("kept", 0), "wildcard": bool(w.get("wildcard"))}
                for w in chapters.all_worlds(st)
                if not w.get("wildcard") or stats.get(w["name"], {}).get("n", 0) > 0  # invented worlds only list once they have images
            ]})
            return

        if parsed.path == "/api/state":
            measure_in_background()                # the automatic groups need every image measured once
            sig = state_signature()          # taken first: a change made while this is built shows up at the next poll
            st = load_state()
            trashed_set = set(st.get("trashed", []))
            titles = st.get("titles", {})
            prompts = st.get("prompts", {})
            models = st.get("models", {})
            auth = get_krea_oauth_token()

            plates = []
            for p in ordered_plate_files(st):
                qa = get_cached_qa(p)
                plates.append({
                    "filename": p.name,
                    "url": f"/api/plate?f={quote(p.name)}&t={int(p.stat().st_mtime)}",   # the project's own folder
                    "thumb": f"/api/thumb?f={quote(p.name)}&w=360",       # the grid: 134 full-size plates would be over 1 GB decoded
                    "preview": f"/api/thumb?f={quote(p.name)}&w=540",     # the player: the stage is ~250 px wide
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
                    "look": features.look(features.peek(p)),
                    "idea": st.get("ideas", {}).get(p.name),
                    "qa_passed": qa["qa_passed"],
                    "qa_score": qa["qa_score"],
                    "qa_issues": qa.get("issues", []),
                    "qa_doubt": qa.get("qa_doubt", ""),
                })

            kimi_key = st.get("kimi_api_key", "")
            self.send_json({
                "state_sig": sig,
                "project": projects.public(PROJECT) if PROJECT else None,     # None: no project yet, the page shows its first screen
                "plates": plates,
                "krea_connected": bool(auth.get("connected") and not auth.get("expired")),
                "kimi_configured": bool(kimi_key),
                "kimi_key_masked": (kimi_key[:6] + "••••••••" + kimi_key[-4:]) if len(kimi_key) > 10 else "",
                "kimi_model": st.get("kimi_model", "kimi-k3"),
                "critic_enabled": st.get("critic_enabled", True),
                "critic_autotrash": st.get("critic_autotrash", False),
                "sequences": sequences.public(st, {p["filename"] for p in plates if not p["trashed"]}),
                "groups": groups.public(st, {p["filename"] for p in plates}),
                "edits": edits.public(st),
                "active_sequence": st.get("active_sequence"),
            })
            return

        path = parsed.path
        if path.startswith("/outputs/"):
            # an exported film (in the app: Application Support/Phosphene/outputs). A bare .mp4 name only, from that folder: the static
            # fallback below serves only /assets/, and the films were left out of it (the download saved a 35-byte "Not found")
            name = unquote(path[len("/outputs/"):])
            f = OUTPUTS_DIR / name
            if "/" in name or "\\" in name or name.startswith(".") or not name.lower().endswith(".mp4") or not f.is_file():
                self.send_json({"ok": False, "error": "Not found"}, 404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(f.stat().st_size))
            self.send_header("Content-Disposition", f"attachment; filename=\"{name}\"")
            self.end_headers()
            with open(f, "rb") as src:
                shutil.copyfileobj(src, self.wfile, 1 << 20)
            return
        if not path.startswith("/assets/") or any(seg.startswith(".") for seg in path.split("/")):   # only the old plate URLs; never studio/.secrets.json
            self.send_json({"ok": False, "error": "Not found"}, 404)
            return
        return super().do_GET()

    def send_wav(self, raw: bytes):
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        if not self.from_this_computer(command=True):
            self.rfile.read(max(0, min(length, 1 << 20)))
            return
        # the page says which project a job's request is for: another one open meanwhile (a second window, a file opened from
        # Finder), the request is refused, so images, frames or a curation never land in the wrong project
        meant = self.headers.get("X-Phosphene-Project")
        if meant and not (PROJECT and PROJECT["slug"] == meant):
            left = max(0, length)
            while left > 0:
                left -= len(self.rfile.read(min(left, 1 << 20)) or b"x" * left)
            self.send_json({"ok": False, "project_changed": True, "error": "Another project was opened meanwhile: this was for the one before. Reload the page."}, 409)
            return
        if parsed.path == "/api/export-audio":
            # the synthesized sound, rendered in the page (the same WebAudio graph as the preview), kept until the export uses it
            if length <= 44 or length > EXPORT_AUDIO_MAX_BYTES:
                self.rfile.read(min(max(length, 0), EXPORT_AUDIO_MAX_BYTES))
                self.send_json({"ok": False, "error": "That sound is empty or too large."}, 413)
                return
            raw = self.rfile.read(length)
            if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
                self.send_json({"ok": False, "error": "That is not a WAV file."}, 400)
                return
            EXPORT_DIR.mkdir(parents=True, exist_ok=True)
            export_audio_file().write_bytes(raw)
            self.send_json({"ok": True, "bytes": len(raw)})
            return
        if parsed.path == "/api/export-frame":
            # one frame of the export, a JPEG from the page; ?same=k: the same picture as frame k (a held cut), with &to=j for frames i..j-1
            # at once; they are hard links, so a long held film takes no room. Frame 0 starts a new set.
            raw = self.rfile.read(min(max(length, 0), EXPORT_FRAME_MAX_BYTES + 1))
            q = parse_qs(parsed.query)
            try:
                i = int(q.get("i", [""])[0])
                same = int(q["same"][0]) if "same" in q else None
                to = int(q["to"][0]) if "to" in q else i + 1
            except ValueError:
                self.send_json({"ok": False, "error": "Which frame?"}, 400)
                return
            if not 0 <= i < to <= EXPORT_FRAMES_MAX or (same is not None and not 0 <= same < i) or (same is None and to != i + 1):
                self.send_json({"ok": False, "error": "That frame is out of range."}, 400)
                return
            frames = export_frames_dir()
            if i == 0:
                shutil.rmtree(frames, ignore_errors=True)
            frames.mkdir(parents=True, exist_ok=True)
            dest = frames / f"f_{i:05d}.jpg"
            if same is not None:
                src = frames / f"f_{same:05d}.jpg"
                if not src.exists():
                    self.send_json({"ok": False, "error": f"Frame {same} has not arrived."}, 400)
                    return
                for f in range(i, to):
                    link = frames / f"f_{f:05d}.jpg"
                    link.unlink(missing_ok=True)
                    try:
                        os.link(src, link)
                    except OSError:
                        shutil.copyfile(src, link)
            elif length > EXPORT_FRAME_MAX_BYTES or raw[:2] != b"\xff\xd8":
                self.send_json({"ok": False, "error": "That is not a JPEG frame."}, 400)
                return
            else:
                dest.write_bytes(raw)
            self.send_json({"ok": True})
            return
        if parsed.path == "/api/project-import":
            # a project file (Export project's zip) as a new project, then open it; the zip comes as it is and is written to disk first
            if busy():
                self.rfile.read(max(0, length))
                self.send_json({"ok": False, "busy": True, "error": "Something is running (images, an AI order or an export). Wait until it ends."}, 409)
                return
            EXPORT_DIR.mkdir(parents=True, exist_ok=True)
            tmp = EXPORT_DIR / f"import-{uuid.uuid4().hex}.zip"
            try:
                with tmp.open("wb") as fh:
                    left = length
                    while left > 0:
                        chunk = self.rfile.read(min(left, 1 << 20))
                        if not chunk:
                            break
                        fh.write(chunk); left -= len(chunk)
                p = projects.import_zip(tmp)
                if not imported_opens(self, p):
                    return
            except ValueError as e:
                self.send_json({"ok": False, "error": str(e)}, 400)
                return
            finally:
                tmp.unlink(missing_ok=True)
            gen_log.record("project", action="import", project=PROJECT["slug"])
            self.send_json({"ok": True, "active": PROJECT["slug"], "project": projects.public(PROJECT), "projects": [projects.public(x) for x in projects.all_projects()]})
            return
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}
        if PROJECT is None and parsed.path in NEEDS_PROJECT:
            self.send_json({"ok": False, "no_project": True, "error": "Make a project or import one first (the project menu, top left)."}, 409)
            return
        if parsed.path == "/api/project-import-path":
            # the Mac app: a .phos file double-clicked in Finder (or dropped on the Dock icon), imported from where it is
            f = Path(str(body.get("path") or ""))
            if f.suffix.lower() not in (".phos", ".phosphene", ".zip") or not f.is_file():
                self.send_json({"ok": False, "error": "That is not a project file."}, 400)
                return
            if busy():
                self.send_json({"ok": False, "busy": True, "error": "Something is running. Wait until it ends, then open the file again."}, 409)
                return
            try:
                p = projects.import_zip(f)
                if not imported_opens(self, p):
                    return
            except ValueError as e:
                self.send_json({"ok": False, "error": str(e)}, 400)
                return
            gen_log.record("project", action="import", project=PROJECT["slug"], file=f.name)
            self.send_json({"ok": True, "active": PROJECT["slug"], "project": projects.public(PROJECT)})
            return
        if parsed.path in LOCKED_DURING_AI and ai_busy():
            self.send_json({"ok": False, "busy": True, "error": "The AI is ordering your selection. Wait until it finishes."}, 409)
            return

        if parsed.path == "/api/projects":
            # switch to a project, make one (the mark comes as a PNG data URL: the page turns an SVG into one), or change one
            action = body.get("action")
            mark = None
            if body.get("mark"):
                try:
                    import base64
                    mark = base64.b64decode(str(body["mark"]).split(",", 1)[-1], validate=False)
                except Exception:
                    self.send_json({"ok": False, "error": "The mark did not arrive as an image."}, 400)
                    return
            touches_active = action in ("switch", "create", "delete") or (action == "update" and PROJECT and body.get("slug") == PROJECT["slug"])
            if touches_active and busy():
                self.send_json({"ok": False, "busy": True, "error": "Something is running (images, an AI order or an export). Wait until it ends."}, 409)
                return
            try:
                if action == "switch":
                    apply_project(projects.set_active(str(body.get("slug") or "")))
                elif action == "create":
                    p = projects.create(body, mark or b"")
                    apply_project(projects.set_active(p["slug"]))
                elif action == "update":
                    p = projects.update(str(body.get("slug") or ""), body, mark)
                    if PROJECT and p["slug"] == PROJECT["slug"]:
                        apply_project(p)
                elif action == "delete":                    # to the Trash; the open one gone, the next project opens (or none)
                    slug = str(body.get("slug") or "")
                    was_open = bool(PROJECT and PROJECT["slug"] == slug)
                    with STATE_LOCK:
                        projects.trash(slug)
                    if was_open:
                        open_first_project()
                else:
                    self.send_json({"ok": False, "error": "Unknown action."}, 400)
                    return
            except FileNotFoundError:
                self.send_json({"ok": False, "error": "There is no such project."}, 404)
                return
            except ValueError as e:
                self.send_json({"ok": False, "error": str(e)}, 400)
                return
            gen_log.record("project", action=action, project=PROJECT["slug"] if PROJECT else None)
            self.send_json({"ok": True, "active": PROJECT["slug"] if PROJECT else None, "project": projects.public(PROJECT) if PROJECT else None, "projects": [projects.public(p) for p in projects.all_projects()]})
            return

        if parsed.path == "/api/download-zip":
            try:
                f, name = build_download_zip([str(x) for x in (body.get("files") or [])][:5000], str(body.get("label") or "All"))
            except ValueError as e:
                self.send_json({"ok": False, "error": str(e)}, 400)
                return
            self.send_json({"ok": True, "url": f"/api/download-zip?id={f.stem}&name={quote(name)}", "filename": name, "bytes": f.stat().st_size})
            return

        if parsed.path == "/api/project-export":
            # a project as one file (its folder zipped, images included), downloaded once like the image zip
            try:
                out = zips_folder() / f"{uuid.uuid4().hex}.zip"
                if not (body.get("slug") or PROJECT):
                    raise FileNotFoundError("none")
                with STATE_LOCK:                               # its curation as one moment (an image being saved waits, or waits for it)
                    name = projects.export_zip(str(body.get("slug") or PROJECT["slug"]), out)
            except FileNotFoundError:
                self.send_json({"ok": False, "error": "There is no such project."}, 404)
                return
            self.send_json({"ok": True, "url": f"/api/download-zip?id={out.stem}&name={quote(name)}", "filename": name, "bytes": out.stat().st_size})
            return

        if parsed.path == "/api/describe-mark":
            # a mark just chosen in the form: its own colours (from its pixels) and, with a Kimi key, the words for it and colours to go with it
            try:
                import base64
                img = Image.open(io.BytesIO(base64.b64decode(str(body.get("mark") or "").split(",", 1)[-1])))
                img.load()
                alpha = projects.mark_alpha(img)
            except Exception:
                self.send_json({"ok": False, "error": "That is not an image of a mark."}, 400)
                return
            out = {"ok": True, "colours": projects.mark_colours(img)}
            st = load_state()
            if st.get("kimi_api_key"):
                try:
                    out.update(describe_mark(img, st["kimi_api_key"], st.get("kimi_model", "kimi-k3")))
                except Exception as e:
                    out["note"] = f"Kimi could not describe it ({str(e)[:120]}): fill in the words yourself."
            else:
                out["note"] = "With a Kimi key (Settings), Kimi suggests the words for the mark."
            self.send_json(out)
            return

        if parsed.path == "/api/krea-auth":
            # sign in to Krea from this app (MCP OAuth): the page opens the URL; Krea sends the browser back to /api/krea-callback
            if body.get("action") == "logout":
                krea_forget_login()
                self.send_json({"ok": True})
                return
            try:
                url = krea_start_login(f"http://localhost:{self.server.server_address[1]}/api/krea-callback")
            except Exception as e:
                self.send_json({"ok": False, "error": f"Could not reach Krea: {str(e)[:200]}"}, 502)
                return
            self.send_json({"ok": True, "url": url})
            return

        if parsed.path == "/api/net":
            # is Krea reachable from here? The batch pauses on a lost connection and asks this until it is back
            try:
                urllib.request.urlopen(urllib.request.Request("https://api.krea.ai/", method="HEAD"), timeout=6)
                ok = True
            except urllib.error.HTTPError:
                ok = True                                          # it answered (any status): reachable
            except Exception:
                ok = False
            self.send_json({"ok": True, "online": ok})
            return

        if parsed.path == "/api/busy":
            # the page's lease while a batch or an export runs (see _LEASE): {"for": seconds}, 0 ends it
            _LEASE["until"] = time.time() + max(0.0, min(60.0, float(body.get("for") or 0)))
            self.send_json({"ok": True, "busy": busy()})
            return

        if parsed.path == "/api/save-settings":
            status = None
            if "kimi_api_key" in body and body["kimi_api_key"].strip():
                status = check_kimi_key(body["kimi_api_key"].strip())   # a refused key is not kept: the one before stays (checked before the state is read: it takes seconds)
                if status == "refused":
                    self.send_json({"ok": False, "kimi_key_status": "refused", "kimi_configured": bool(load_state().get("kimi_api_key")),
                                    "error": "Kimi refused that key. Copy the API key (it starts with sk-) from platform.moonshot.ai or kimi.com."})
                    return
            with STATE_LOCK:                                   # read, change, write as one: nothing saved meanwhile is lost
                st = load_state()
                if status:
                    st["kimi_api_key"] = body["kimi_api_key"].strip()
                if "kimi_model" in body and body["kimi_model"].strip():
                    st["kimi_model"] = body["kimi_model"].strip()
                for flag in ("critic_enabled", "critic_autotrash"):
                    if flag in body:
                        st[flag] = bool(body[flag])
                save_state(st)
            self.send_json({"ok": True, "kimi_configured": bool(st.get("kimi_api_key")), "kimi_key_status": status})
            return

        if parsed.path == "/api/reorder":
            new_order = body.get("order", [])
            if isinstance(new_order, list):
                with STATE_LOCK:
                    st = load_state()
                    sequences.reorder_active(st, new_order)
                    save_state(st)
            self.send_json({"ok": True})
            return

        if parsed.path == "/api/order-ai":
            st = load_state()
            if not st.get("kimi_api_key"):
                self.send_json({"ok": False, "needs_kimi_key": True, "error": "Enter your Kimi API key in Settings first"}, 400)
                return
            if any(not j.get("done") for j in AI_JOBS.values()):
                self.send_json({"ok": False, "error": "An AI order is already running."}, 409)
                return
            try:
                length = int(body.get("length") or 0) or None
            except (TypeError, ValueError):
                length = None
            job_id = f"job{int(time.time() * 1000)}"
            AI_JOBS[job_id] = {"done": False, "step": 0, "steps": len(AI_STEPS), "stage": AI_STEPS[0], "note": ""}
            only = set(str(f) for f in body["files"]) if isinstance(body.get("files"), list) and body["files"] else None
            threading.Thread(target=run_ai_order_job, args=(job_id, length, str(body.get("direction", ""))[:300], only), daemon=True).start()
            self.send_json({"ok": True, "job": job_id, "steps": AI_STEPS})
            return

        if parsed.path == "/api/groups":
            with STATE_LOCK:
                st = load_state()
                res = groups.act(st, body)
                if res.get("ok"):
                    save_state(st)
            self.send_json(res, 200 if res.get("ok") else 400)
            return

        if parsed.path == "/api/edits":
            with STATE_LOCK:
                st = load_state()
                res = edits.act(st, body)
                if res.get("ok"):
                    save_state(st)
            self.send_json(res, 200 if res.get("ok") else 400)
            return

        if parsed.path == "/api/sequence":
            with STATE_LOCK:
                st = load_state()
                action = body.get("action")
                handlers = {
                    "activate": lambda: sequences.activate(st, body.get("id", "")),
                    "reset": lambda: sequences.reset_ai(st),
                    "make_manual": lambda: sequences.make_manual(st),
                    "include_all": lambda: sequences.include_all(st),
                    "restore": lambda: sequences.restore(st, body.get("order"), body.get("cut_off")),
                }
                ok = handlers[action]() if action in handlers else False
                if ok:
                    save_state(st)
            self.send_json({"ok": ok} if ok else {"ok": False, "error": "Could not do that."}, 200 if ok else 400)
            return

        if parsed.path == "/api/invent-prompts":
            started_in = PROJECT["slug"] if PROJECT else None
            st = load_state()
            before = json.loads(json.dumps(st))                 # what writing the scenes changes is merged back below, nothing else
            kimi_key = body.get("kimi_api_key") or st.get("kimi_api_key", "")
            kimi_model = body.get("kimi_model") or st.get("kimi_model", "kimi-k3")
            if not kimi_key:
                self.send_json({"ok": False, "needs_kimi_key": True, "error": "Enter your Kimi API key in ⚙️ Settings first"}, 400)
                return
            stats, t_batch = {}, time.time()
            direction = (body.get("direction") or "").strip()[:300]
            try:
                ideas = ask_kimi_for_prompts(
                    st,
                    api_key=kimi_key,
                    kimi_model=kimi_model,
                    count=int(body.get("count", 4)),
                    world=body.get("world") or None,
                    direction=direction,
                    stats=stats,
                )
                with STATE_LOCK:                               # Kimi took seconds: what changed meanwhile stays; only its titles are added,
                    if PROJECT and PROJECT["slug"] == started_in:   # and never into another project opened meanwhile
                        now = load_state()
                        for idea in ideas:
                            t = idea.get("title", "")
                            if t and t not in now.setdefault("history", []):
                                now["history"].append(t)
                        # and whatever this step itself changed: a territory Kimi invented (custom_worlds), the memory that keeps
                        # batches from repeating (recent_subjects / _worlds / _axes). Merging only the titles lost them all.
                        for k, v in st.items():
                            if k in ("history", "kimi_api_key") or v == before.get(k):
                                continue
                            if k == "custom_worlds":
                                mine = {w.get("name"): w for w in v}
                                now[k] = [w for w in now.get(k, []) if w.get("name") not in mine] + v
                            else:
                                now[k] = v
                        save_state(now)
                gen_log.record("batch", ok=True, asked=int(body.get("count", 4)), territory_choice=body.get("world") or "mix", direction=direction, kimi_model=kimi_model,
                               seconds=round(time.time() - t_batch, 1), titles=[i.get("title") for i in ideas], **stats)
                self.send_json({"ok": True, "ideas": ideas})
            except Exception as e:
                print(f"[KIMI] invent-prompts failed: {e!r}", flush=True)
                gen_log.record("batch", ok=False, asked=int(body.get("count", 4)), territory_choice=body.get("world") or "mix", direction=direction,
                               seconds=round(time.time() - t_batch, 1), error=str(e)[:300])
                self.send_json({"ok": False, "error": str(e), "offline": isinstance(e, KimiOffline)}, 500)
            return

        if parsed.path == "/api/generate-image":
            auth = get_krea_oauth_token()
            if not auth.get("connected") or auth.get("expired"):
                gen_log.record("image", ok=False, title=body.get("title"), model=body.get("model"), seconds=0, error="Krea login needed", needs_auth=True)
                self.send_json({"ok": False, "needs_auth": True, "error": "Connect Krea first (Settings › Connect Krea)."})
                return

            title = body.get("title", "Outdoor Plate").strip()
            raw_prompt = body.get("prompt", "").strip()
            guide_type = body.get("guide", "dark")
            guide_kw = {"guide": current_guide()} if current_guide() else {}   # another project: its own guide image
            model = body.get("model", "google/nano-banana-pro")
            if model == "auto":
                model = taste.pick_model(load_state())
                print(f"[TASTE] auto-picked model {model}", flush=True)
            after_filename = body.get("after_filename")

            full_prompt = build_full_prompt(raw_prompt)
            t_start = time.time()
            job_id = uuid.uuid4().hex[:8]
            trace: list = []
            gen_log.record("image_start", id=job_id, title=title, model=model, guide=guide_type, world=body.get("world"))
            softened = None
            try:
                with inflight():
                    try:
                        img_bytes = generate_with_retry(prompt=full_prompt, guide_type=guide_type, model=model, trace=trace, **guide_kw)
                    except Exception as refused:
                        key = load_state().get("kimi_api_key", "")
                        if getattr(refused, "code", None) != "content_policy" or not key:
                            raise
                        # moderation said no: one more try with a more neutral wording (the rejected job costs nothing to try again)
                        softened = soften_prompt(raw_prompt, key, load_state().get("kimi_model", "kimi-k3"))
                        if not softened:
                            raise
                        print(f"[GENERATE] moderation rejected '{title}': retrying once with a softened prompt", flush=True)
                        img_bytes = generate_with_retry(attempts=1, prompt=build_full_prompt(softened), guide_type=guide_type, model=model, trace=trace, **guide_kw)
                        trace[-1]["softened"] = True
                        raw_prompt = softened
                im = Image.open(io.BytesIO(img_bytes)).convert("RGB").resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)

                # whole before it appears (an export, a thumbnail never reads half an image), and checked before it appears, outside the
                # lock: the logo check takes ~2.5 s an image on a project's own mark, and trash / restore clicks waited for it
                tmp_img = PLATES_DIR / f".new-{uuid.uuid4().hex}.jpg.part"
                im.save(tmp_img, "JPEG", quality=95)
                try:
                    qa = check_new_image(tmp_img)
                except BaseException:
                    tmp_img.unlink(missing_ok=True)
                    raise
                with STATE_LOCK:
                    next_num = next_plate_number(load_state())
                    slug = "".join(c if c.isalnum() else "_" for c in title.lower()).strip("_")[:26] or "plate"
                    while "__" in slug:
                        slug = slug.replace("__", "_")
                    filename = f"{next_num:02d}_{slug}.jpg"
                    save_path = tmp_img.parent / filename
                    os.replace(tmp_img, save_path)
                    qa = {**qa, "filename": filename}
                    with QA_LOCK:
                        _remember_qa(_plate_key(save_path), qa, now=True)
                    print(
                        f"[QA] {filename} ({model}) -> passed={qa['qa_passed']} score={qa['qa_score']}% "
                        f"corr={qa['center_corr']} asym={qa['core_asymmetry']} issues={qa['issues']}",
                        flush=True,
                    )

                    with STATE_LOCK:                           # read, change, write as one (parallel images, trash clicks, the critic)
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

                        sequences.append_everywhere(st, filename)
                        save_state(st)
                threading.Thread(target=apply_critic, args=(filename,), daemon=True).start()
                took = round(time.time() - t_start, 1)
                gen_log.record("image", id=job_id, ok=True, title=title, filename=filename, model=model, guide=guide_type, world=body.get("world"), seconds=took,
                               attempts=trace, qa_passed=qa["qa_passed"], qa_score=qa["qa_score"], qa_issues=qa.get("issues", []), softened=bool(softened))
                print(f"[GENERATE] OK {filename} ({model}) {took}s, attempt {len(trace)}/3" + ("  (prompt softened after a moderation rejection)" if softened else "") + ("" if qa["qa_passed"] else "  LOGO CHECK FAILED -> trash"), flush=True)

                self.send_json({
                    "ok": True,
                    "qa_passed": qa["qa_passed"],
                    "trashed": not qa["qa_passed"],
                    "filename": filename,
                    "title": title,
                    "model": model,
                    "qa_issues": qa.get("issues", []),
                    "qa_doubt": qa.get("qa_doubt", ""),
                    "softened": bool(softened),
                })
            except Exception as e:
                print(f"[GENERATE] FAILED '{title}' ({model}, guide={guide_type}) after {time.time() - t_start:.0f}s: {str(e)[:300]}", flush=True)
                code = getattr(e, "code", None)
                message = ("Refused by Krea's moderation" + (", also with a softened prompt" if softened else "") if code == "content_policy" else str(e))
                gen_log.record("image", id=job_id, ok=False, title=title, model=model, guide=guide_type, world=body.get("world"), seconds=round(time.time() - t_start, 1),
                               attempts=trace, error=str(e)[:500], error_code=code, krea_job=getattr(e, "job_id", None), prompt=raw_prompt[:700], softened=bool(softened))
                # what the page does next: a lost connection or Krea down pauses the batch until it is back; no credits stops it;
                # anything else is this image's own failure (Retry them, at the end)
                # (an HTTPError is a URLError too, but Krea answered: only its gateway codes mean Krea is unreachable; a 401 / 403 / 404 is its refusal)
                gateway = ("http_502", "http_503", "http_504", "http_520", "http_522", "http_524")
                offline = code in gateway or (isinstance(e, urllib.error.HTTPError) and f"http_{e.code}" in gateway) \
                    or (isinstance(e, (urllib.error.URLError, TimeoutError, ConnectionError, socket.timeout)) and not isinstance(e, urllib.error.HTTPError)) \
                    or bool(re.search(r"timed out|connection (refused|reset|aborted)|network is unreachable|nodename nor servname|name or service not known|temporary failure in name resolution|no route to host|urlopen error", str(e), re.I))
                self.send_json({"ok": False, "error": message, "code": code, "offline": bool(offline), "stop": code == "insufficient_credits",
                                "needs_auth": isinstance(e, urllib.error.HTTPError) and e.code == 401,      # the sign-in was refused: Connect Krea again
                                "retryable": code == "insufficient_credits" or (bool(getattr(e, "retryable", True)) and code != "content_policy")}, 500)   # out of credits: Retry once topped up
            return

        if parsed.path == "/api/purge":
            with STATE_LOCK:
                st = load_state()
                wanted = list(st.get("trashed", [])) if body.get("all") else list(body.get("filenames", []))
                deleted, freed = purge_plates(st, wanted)
                save_state(st)
                try:
                    _flush_qa_cache()
                except Exception:
                    pass
            gen_log.record("purge", deleted=deleted, freed_mb=round(freed / 1e6, 1), all=bool(body.get("all")))
            self.send_json({"ok": True, "deleted": deleted, "freed_mb": round(freed / 1e6, 1)})
            return

        if parsed.path == "/api/trash":
            filename = plate_name(body.get("filename"))
            if not filename:
                self.send_json({"ok": False, "error": "No such image."}, 400)
                return
            trashed = bool(body.get("trashed", True))
            with STATE_LOCK:
                st = load_state()
                cur = set(st.get("trashed", []))
                group = {filename}
                if trashed:
                    cur |= group
                    now = time.time()
                    for f in group:
                        st.setdefault("trashed_at", {})[f] = now
                else:
                    cur -= group
                    for f in group:
                        st.get("trashed_at", {}).pop(f, None)
                    # a restored image joins the end of the order; it does not return to where it was
                    sequences.move_to_end_everywhere(st, sorted(group), universe=[p.name for p in PLATES_DIR.glob("*.jpg")])
                st["trashed"] = sorted(cur)
                save_state(st)
            self.send_json({"ok": True})
            return

        if parsed.path == "/api/export-video":
            def clamped(key, default, lo, hi):                          # a number from the request, kept inside what the page offers (and never 0: it divides)
                try:
                    v = float(body.get(key, default))
                except (TypeError, ValueError):
                    return default
                return min(hi, max(lo, v)) if v == v else default
            bpm = clamped("bpm", 136.0, 40.0, 1200.0)
            multiple = clamped("multiple", 1.0, 0.125, 16.0)            # picture cuts per beat: 0.5 = every 2 beats, 4 = 4 cuts/beat
            st = load_state()
            trashed_set = set(st.get("trashed", []))
            active_files = sequences.edit_files([p for p in ordered_plate_files(st) if p.name not in trashed_set], st)
            if isinstance(body.get("files"), list) and body["files"]:          # a group: just its images, in the order
                wanted = set(str(f) for f in body["files"])
                active_files = [p for p in ordered_plate_files(st) if p.name not in trashed_set and p.name in wanted]
            if not active_files:
                self.send_json({"ok": False, "error": "No active plates"}, 400)
                return

            t_export = time.time()
            try:
                with inflight():
                    fps = 30
                    tmp_dir = OUTPUTS_DIR / "_tmp_export_frames"
                    if tmp_dir.exists():
                        shutil.rmtree(tmp_dir)
                    tmp_dir.mkdir(parents=True, exist_ok=True)

                    invert_mode = body.get("invert_mode", "off") if body.get("invert_mode") in ("off", "mono", "colour") else "off"
                    zoom_mode = body.get("zoom_mode", "off") if body.get("zoom_mode") in ("off", "out", "in") else "off"
                    music_mode = "synth" if body.get("music") == "synth" else "off"
                    variable = None
                    if body.get("rhythm") == "variable":                   # a change of speed on the timeline: from the tempo to an end length, for the name
                        try:
                            variable = (60000.0 / bpm, min(1500.0, max(50.0, float(body.get("end_ms")))))
                        except (TypeError, ValueError):
                            variable = None
                    # the page plans the film (its timeline is the one the preview plays and the music follows) and draws every frame;
                    # the server checks they all arrived and encodes them
                    try:
                        total_frames = int(body.get("frames") or 0)
                    except (TypeError, ValueError):
                        total_frames = 0
                    n_cuts = len(active_files) * (2 if invert_mode in ("mono", "colour") else 1)
                    if total_frames > EXPORT_FRAMES_MAX:
                        raise ValueError(f"The film is {total_frames} frames, more than {EXPORT_FRAMES_MAX} ({EXPORT_FRAMES_MAX // 1800} minutes at 30 fps). Make it shorter.")
                    sent = export_frames_dir()
                    missing = next((f for f in range(total_frames) if not (sent / f"f_{f:05d}.jpg").exists()), None)
                    if total_frames < 1 or missing is not None:
                        raise ValueError("The frames did not all arrive" + (f" (frame {missing} is missing)" if total_frames else "") + ". Press Export again.")
                    frames_in = sent / "f_%05d.jpg"

                    out_mp4 = OUTPUTS_DIR / export_filename(bpm, multiple, time.time(), invert_mode, zoom_mode, music_mode, variable, str(body.get("edit") or ""))
                    # cut length follows the tempo, multiple, rhythm and effects chosen in the player; music only when asked for
                    cmd = [FFMPEG, "-y", "-framerate", str(fps), "-i", str(frames_in)]
                    if music_mode != "off":
                        if export_audio_file().exists():
                            wav = export_audio_file().read_bytes()
                        else:
                            raise ValueError("The synthesized sound did not arrive. Press Export again.")
                        (tmp_dir / "music.wav").write_bytes(wav)
                        cmd += ["-i", str(tmp_dir / "music.wav"), "-c:a", "aac", "-b:a", "192k", "-shortest"]
                    else:
                        cmd += ["-an"]
                    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", str(out_mp4)]
                    subprocess.run(cmd, check=True, capture_output=True)
                    export_audio_file().unlink(missing_ok=True)           # the next export gets its own sound
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    shutil.rmtree(export_frames_dir(), ignore_errors=True)   # the next export draws its own
                    prune_exports(OUTPUTS_DIR, keep=12)
                    self.send_json({"ok": True, "video_url": f"/outputs/{out_mp4.name}", "filename": out_mp4.name,
                                    "images": len(active_files), "cuts": n_cuts, "seconds": round(total_frames / fps, 1), "music": music_mode != "off", "music_mode": music_mode})
                gen_log.record("export", ok=True, music=music_mode, filename=out_mp4.name, images=len(active_files), seconds=round(total_frames / fps, 1), took=round(time.time() - t_export, 1))
            except Exception as e:
                print(f"[EXPORT] FAILED: {str(e)[:300]}", flush=True)
                gen_log.record("export", ok=False, images=len(active_files), error=str(e)[:300], took=round(time.time() - t_export, 1))
                self.send_json({"ok": False, "error": f"Export failed: {str(e)[:200]}"}, 500)
            return

        self.send_json({"ok": False, "error": "Unknown endpoint"}, 404)


class QuietServer(ThreadingHTTPServer):
    """A browser that reloads or navigates away mid-response is normal; don't dump a traceback for it."""

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    if os.environ.get("PHOSPHENE_EXAMPLES"):                                 # the Mac app's first launch: Demo, the sample, copied in once
        projects.seed_examples(Path(os.environ["PHOSPHENE_EXAMPLES"]))
    open_first_project()
    if places.APP:                                                           # the Mac app quit (even forced): the server goes too
        parent = os.getppid()
        def watch_app():
            while os.getppid() == parent:
                time.sleep(2)
            os._exit(0)
        threading.Thread(target=watch_app, daemon=True).start()
    port = int(os.environ.get("PORT", "8765"))
    server = QuietServer(("127.0.0.1", port), StudioHandler)
    print(f"Studio running at http://localhost:{port} · project: {PROJECT['name'] if PROJECT else 'none yet'}")
    gen_log.record("server_start", boot=BOOT_ID, port=port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # Ctrl-C, or dev.py restarting us: exit quietly
        pass
    finally:
        server.server_close()
