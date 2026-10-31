"""
Projects: one per brand mark. A project is a folder under projects/ with a project.json: the mark (an image, its size and place
in the frame), the words the prompts use for it, the brand (one line for the quality bar), its palette, and where its plates,
curation, caches and guide images live. New projects keep everything inside their folder (gitignored, so they stay on this
machine); Demo ("demo") is committed and points at the files it has always used, so nothing of it moved.

The server works on one project at a time (the active one, remembered in studio/.local.json, gitignored): `apply` points its
paths at that project. A project's settings never change DEMO's numbers: DEMO is 18% wide at (50%, 50%), and its logo check keeps
its own orbital mask (qa_engine).
"""

import io
import json
import re
import shutil
import time
from pathlib import Path

from PIL import Image, ImageChops

import places

ROOT_DIR = Path(__file__).resolve().parent.parent
STUDIO_DIR = ROOT_DIR / "studio"
PROJECTS_DIR = places.PROJECTS_DIR                 # the repo's projects/, or ~/Documents/Phosphene in the Mac app
LOCAL_FILE = places.SUPPORT_DIR / ".local.json"          # this machine's choices: which project is open (gitignored)
DEFAULT = "demo"
FRAME_W, FRAME_H = 1080, 1920
GUIDE_DARK, GUIDE_LIGHT = "#141416", "#FEFFE7"    # the guide images: the mark in cream on near-black, and in ink on cream
DEMO_PALETTE = ["#EC540C", "#F64570", "#5D8FF4", "#381313", "#1A1A1A", "#FEFFE7"]
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
MARK_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,29}$")   # an extra mark's id: its file is mark-<id>.png in the project's folder
MAX_MARKS = 8                                      # extra marks besides the main one that a project can hold (read and kept: older projects)
ADD_MARKS = 5                                      # extra marks a project can be given (2026-10-31: 6 in all; the Mark menu's row and a batch
                                                   # of 20 sharing them, 3+ each, stay readable). A project made before with more keeps them


def _project_file(slug: str) -> Path:
    return PROJECTS_DIR / slug / "project.json"


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")[:40].strip("-")
    return s or "project"


def clean_hex(c) -> str | None:
    s = str(c or "").strip().upper()
    if re.fullmatch(r"#[0-9A-F]{3}", s):
        s = "#" + "".join(ch * 2 for ch in s[1:])
    return s if re.fullmatch(r"#[0-9A-F]{6}", s) else None


def load(slug: str) -> dict:
    """The project with every path resolved (absolute). Raises FileNotFoundError for an unknown slug."""
    if not SLUG.match(slug or ""):
        raise FileNotFoundError(slug)
    raw = json.loads(_project_file(slug).read_text())
    base = PROJECTS_DIR / slug
    paths = raw.get("paths") or {}
    at = lambda key, default: (ROOT_DIR / paths[key]) if key in paths else base / default   # DEMO: its old places, from the repo root
    mark = raw.get("mark") or "mark.png"
    p = {
        "slug": slug,
        "name": str(raw.get("name") or slug)[:60],
        "mark_file": (ROOT_DIR / mark) if "/" in mark else base / mark,
        "mark_size": float(raw.get("mark_size", 18)),          # % of the frame's width
        "mark_x": float(raw.get("mark_x", 50)),                # % from the left
        "mark_y": float(raw.get("mark_y", 50)),                # % from the top
        "mark_shape": raw.get("mark_shape") or "logo mark",    # what the prompts call its shape ("circular orbital logo")
        "mark_noun": raw.get("mark_noun") or "mark",           # and the mark itself ("circular mark")
        "mark_name": str(raw.get("mark_name") or "Main mark")[:30],   # its name in the list of marks
        "brief": raw.get("brief") or raw.get("name") or slug,  # who it is for, one line, in the quality bar
        "palette": [c for c in (clean_hex(x) for x in raw.get("palette") or []) if c],
        "qa": raw.get("qa") or "mark",                         # "demo-tuned": DEMO's own logo check
        "plates_dir": at("plates", "plates"),
        "state_file": at("state", "state.json"),
        "qa_cache_file": at("qa_cache", ".qa_cache.json"),
        "thumbs_dir": at("thumbs", ".thumbs"),
        "features_file": at("features", ".features_cache.json"),
        "guide_cache_file": at("guide_cache", ".krea_guides.json"),
        "guides": {k: at(f"guide_{k}", f"guide_{k}.png") for k in ("dark", "light")},
        "created": raw.get("created"),
        "own": {k: raw.get(k) or "" for k in ("brief", "mark_shape", "mark_noun")},
        "has_mark": False,                                     # set below: a project of your own images may have none yet   # as set (empty when not): the form shows these, never the fallbacks
    }
    # other marks besides the main one (a brand's symbol, wordmark, badge...): each its own image, name, size and words, at the main
    # mark's place. A project from before (no "marks") has none, and an older Phosphene reading this file sees only the main mark
    p["has_mark"] = Path(p["mark_file"]).is_file()
    p["marks"] = []
    for m in raw.get("marks") or [] if p["has_mark"] else []:     # (other marks come after a main one)
        if not isinstance(m, dict) or not MARK_ID.match(str(m.get("id") or "")) or m["id"] == "main" or len(p["marks"]) >= MAX_MARKS:
            continue
        try:
            size = min(60.0, max(4.0, float(m.get("size", p["mark_size"]))))
        except (TypeError, ValueError):
            size = p["mark_size"]
        at = lambda k, d: min(90.0, max(10.0, float(m[k]))) if isinstance(m.get(k), (int, float)) else d   # its own place (the default's, before)
        p["marks"].append({"id": m["id"], "name": str(m.get("name") or m["id"])[:30], "mark_file": base / f"mark-{m['id']}.png", "mark_size": size,
                           "mark_x": at("x", p["mark_x"]), "mark_y": at("y", p["mark_y"]),
                           "mark_shape": str(m.get("shape") or "logo mark")[:80], "mark_noun": str(m.get("noun") or "mark")[:40],
                           # Demo's orbital mark when another mark is its default: its tuned check, words and lock go with it
                           "qa": "demo-tuned" if m.get("qa") == "demo-tuned" and p["qa"] != "demo-tuned" else "mark"})
    p["demo"] = p["qa"] == "demo-tuned" or any(m["qa"] == "demo-tuned" for m in p["marks"])   # Demo, whichever mark leads
    return p


def with_mark(p: dict, mark_id: str | None) -> dict:
    """The project as an image made with one of its marks sees it: that mark's image, size, place and words (the general logo check;
    Demo's orbital mark keeps its own wherever it sits). The main mark, or one that is gone: the project itself."""
    m = next((m for m in p.get("marks") or [] if m["id"] == mark_id), None)
    if not m:
        return p
    return {**p, "mark_file": m["mark_file"], "mark_size": m["mark_size"], "mark_x": m["mark_x"], "mark_y": m["mark_y"], "mark_shape": m["mark_shape"], "mark_noun": m["mark_noun"],
            "qa": m["qa"], "mark_id": m["id"], "mark_name": m["name"]}


_RATIO: dict = {}


def mark_ratio(p: dict) -> float:
    """Height / width of the mark as drawn (trimmed); 1 for DEMO's round mark. Cached while the file is unchanged."""
    if p.get("qa") == "demo-tuned":
        return 1.0
    try:
        key = (str(p["mark_file"]), p["mark_file"].stat().st_mtime)
        if key not in _RATIO:
            a = mark_alpha(Image.open(p["mark_file"]))
            _RATIO[key] = round(a.height / a.width, 4)
        return _RATIO[key]
    except Exception:
        return 1.0


def public(p: dict) -> dict:
    """What the page needs to know about a project."""
    mtime = int(p["mark_file"].stat().st_mtime) if p["mark_file"].exists() else 0
    marks = [{"id": m["id"], "name": m["name"], "size": m["mark_size"], "x": m["mark_x"], "y": m["mark_y"], "shape": m["mark_shape"], "noun": m["mark_noun"], "ratio": mark_ratio(with_mark(p, m["id"])), "fixed": m["qa"] == "demo-tuned",
              "url": f"/api/project-mark?p={p['slug']}&m={m['id']}&t={int(m['mark_file'].stat().st_mtime) if m['mark_file'].exists() else 0}"} for m in p.get("marks") or []]
    return {"slug": p["slug"], "marks": marks, "mark_name": p["mark_name"], "has_mark": p.get("has_mark", True), "name": p["name"], "mark_size": p["mark_size"], "mark_x": p["mark_x"], "mark_y": p["mark_y"],
            "mark_shape": p["own"]["mark_shape"], "mark_noun": p["own"]["mark_noun"], "brief": p["own"]["brief"], "palette": p["palette"],
            "mark_ratio": mark_ratio(p), "round": p.get("qa") == "demo-tuned", "fixed": p.get("qa") == "demo-tuned",
            "mark_url": f"/api/project-mark?p={p['slug']}&t={mtime}"}


def all_projects() -> list[dict]:
    out = []
    for f in sorted(PROJECTS_DIR.glob("*/project.json")):
        try:
            out.append(load(f.parent.name))
        except Exception:
            continue
    return sorted(out, key=lambda p: (p["slug"] != DEFAULT, p["name"].lower()))


def active_slug() -> str:
    """The project open last time; else Demo; else the first there is (None when there are none)."""
    try:
        slug = json.loads(LOCAL_FILE.read_text()).get("project") or DEFAULT
    except Exception:
        slug = DEFAULT
    if _project_file(slug).exists():
        return slug
    if _project_file(DEFAULT).exists():
        return DEFAULT
    first = all_projects()
    return first[0]["slug"] if first else None


TRASH_DIR = Path.home() / ".Trash"                    # macOS's Trash: a deleted project can be put back until it is emptied


def trash(slug: str) -> Path:
    """Delete project…: its whole folder goes to the Trash (images, groups, snapshots, mark), recoverable until the Trash is
    emptied. Refused for a project whose files live outside its folder (the repository's Demo: its plates are committed)."""
    p = load(slug)
    folder = (PROJECTS_DIR / slug).resolve()
    for key in ("plates_dir", "state_file", "mark_file"):
        if folder not in Path(p[key]).resolve().parents:
            raise ValueError(f"{p['name']} keeps its files outside its folder (the repository's own project): it cannot be deleted here.")
    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[/:]+", "-", p["name"]).strip() or slug
    dest, k = TRASH_DIR / f"{stem} (Phosphene project)", 2
    while dest.exists():
        dest, k = TRASH_DIR / f"{stem} (Phosphene project) {k}", k + 1
    shutil.move(str(folder), str(dest))
    try:
        local = json.loads(LOCAL_FILE.read_text())
        if local.get("project") == slug:
            local.pop("project")
            LOCAL_FILE.write_text(json.dumps(local, indent=2))
    except Exception:
        pass
    return dest


def set_active(slug: str) -> dict:
    p = load(slug)                                    # raises if unknown
    try:
        local = json.loads(LOCAL_FILE.read_text())
    except Exception:
        local = {}
    local["project"] = slug
    LOCAL_FILE.write_text(json.dumps(local, indent=2))
    return p


def mark_alpha(img: Image.Image) -> Image.Image:
    """The mark as a mask (L, 255 = mark), trimmed to its bounds. A transparent image: its alpha. An opaque one: whatever differs
    from the colour of its corners (a dark mark on white, or a light one on black)."""
    im = img.convert("RGBA")
    a = im.split()[3]
    if a.getextrema()[0] > 250:                       # no transparency: the corners are the background
        rgb = im.convert("RGB")
        w, h = rgb.size
        corners = [rgb.getpixel(xy) for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
        bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
        d = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
        a = d.point(lambda v: 255 if v > 40 else int(v * 255 / 40))
    box = a.getbbox()
    if not box:
        raise ValueError("The mark is empty: use an image with the mark on a transparent or plain background.")
    return a.crop(box)


def mark_box(p: dict, width_px: float | None = None) -> tuple[int, int, int, int]:
    """(left, top, width, height) of the mark in a 1080 x 1920 frame at the project's size and place."""
    a = mark_alpha(Image.open(p["mark_file"]))
    w = int(round(width_px if width_px else FRAME_W * p["mark_size"] / 100))
    h = max(1, int(round(w * a.height / a.width)))
    cx, cy = int(round(FRAME_W * p["mark_x"] / 100)), int(round(FRAME_H * p["mark_y"] / 100))
    return cx - w // 2, cy - h // 2, w, h


def mark_artwork(p: dict) -> Image.Image:
    """The mark as designed (its own colours and details, RGBA), trimmed to it: what Keep it as designed shows Krea."""
    img = Image.open(p["mark_file"]).convert("RGBA")
    a = img.split()[3]
    if a.getextrema()[0] > 250:                       # opaque: its background taken out as mark_alpha does
        img.putalpha(_opaque_alpha(img))
    box = img.split()[3].getbbox()
    return img.crop(box) if box else img


def _opaque_alpha(img: Image.Image) -> Image.Image:
    rgb = img.convert("RGB")
    w, h = rgb.size
    corners = [rgb.getpixel(xy) for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    d = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    return d.point(lambda v: 255 if v > 40 else int(v * 255 / 40))


ROTATIONS = (0, 45, 90, 135, 180, -45, -90, -135)   # the angles the Mark menu offers, degrees clockwise


def clean_rot(v) -> int:
    """An angle in degrees clockwise, as one of ROTATIONS (180 for -180), or 0 for anything else."""
    try:
        r = int(round(float(v)))
    except (TypeError, ValueError):
        return 0
    r = ((r + 180) % 360) - 180 or 0
    r = 180 if r == -180 else r
    return r if r in ROTATIONS else 0


SCALES = (0.6, 0.8, 1.0, 1.25, 1.6)                 # the sizes the Mark menu offers, times the mark's own


def clean_scale(v) -> float:
    """A size as one of SCALES, or 1 for anything else."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 1.0
    return next((s for s in SCALES if abs(s - f) < 1e-6), 1.0)


def rotated(p: dict, rot) -> dict:
    """The project as an image with its mark turned `rot` degrees clockwise sees it: the mark's file turned (cut out of its background
    first, so the corners a turn opens are empty), and its size the width of the turned mark's box, so the mark itself keeps its size.
    Everything downstream reads the file as any mark: the guide, the artwork, the logo check. Kept in a temporary folder."""
    import hashlib
    import tempfile
    rot = clean_rot(rot)
    if not rot:
        return p
    src = Path(p["mark_file"])
    key = hashlib.sha1(f"{src}:{src.stat().st_mtime}:{rot}".encode()).hexdigest()[:16]
    out = Path(tempfile.gettempdir()) / "phosphene-rotated" / f"{key}.png"
    if not out.exists():
        img = Image.open(src).convert("RGBA")
        if img.split()[3].getextrema()[0] > 250:      # opaque: its background taken out as mark_alpha does
            img.putalpha(_opaque_alpha(img))
        box = img.split()[3].getbbox()
        img = (img.crop(box) if box else img).rotate(-rot, resample=Image.Resampling.BICUBIC, expand=True)   # PIL turns anticlockwise
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.with_suffix(f".{time.time_ns()}.tmp")
        img.save(tmp, "PNG")
        tmp.replace(out)
    grow = mark_alpha(Image.open(out)).width / mark_alpha(Image.open(src)).width
    return {**p, "mark_file": out, "mark_size": round(p["mark_size"] * grow, 2), "mark_rot": rot}


def make_guides(p: dict) -> None:
    """The two guide images Krea draws from: the mark in cream on near-black (dark) and in ink on cream (light), at its size and place."""
    a = mark_alpha(Image.open(p["mark_file"]))
    left, top, w, h = mark_box(p)
    m = a.resize((w, h), Image.Resampling.LANCZOS)
    for kind, (bg, fg) in {"dark": (GUIDE_DARK, GUIDE_LIGHT), "light": (GUIDE_LIGHT, GUIDE_DARK)}.items():
        frame = Image.new("RGB", (FRAME_W, FRAME_H), bg)
        frame.paste(Image.new("RGB", (w, h), fg), (left, top), m)
        p["guides"][kind].parent.mkdir(parents=True, exist_ok=True)
        frame.save(p["guides"][kind], "PNG")


def _write(slug: str, raw: dict) -> None:
    f = _project_file(slug)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(raw, indent=2) + "\n")
    tmp.replace(f)


def _fields(body: dict, raw: dict) -> dict:
    """The editable fields from a request, checked, onto `raw`."""
    num = lambda k, lo, hi: min(hi, max(lo, float(body[k]))) if k in body and body[k] not in (None, "") else None
    if "name" in body:
        name = str(body["name"]).strip()[:60]
        if not name:
            raise ValueError("A project needs a name.")
        raw["name"] = name
    for k, lo, hi in (("mark_size", 4, 60), ("mark_x", 10, 90), ("mark_y", 10, 90)):
        try:
            v = num(k, lo, hi)
        except (TypeError, ValueError):
            raise ValueError(f"{k} must be a number.")
        if v is not None:
            raw[k] = round(v, 1)
    if "mark_name" in body:                           # the main mark's name in the list of marks
        raw["mark_name"] = re.sub(r"\s+", " ", str(body["mark_name"] or "")).strip()[:30] or None
    for k in ("mark_shape", "mark_noun", "brief"):
        if k in body:
            raw[k] = re.sub(r"\s+", " ", str(body[k] or "")).strip()[:200] or None
    if "palette" in body:
        raw["palette"] = [c for c in (clean_hex(x) for x in (body["palette"] or [])[:8]) if c]
    return raw


def create(body: dict, mark_png: bytes) -> dict:
    """A new project from the form: its folder, project.json, the mark and its two guides. Returns the loaded project."""
    name = str(body.get("name") or "").strip()
    if not name:
        raise ValueError("A project needs a name.")
    base = slugify(name)
    slug, n = base, 2
    while (PROJECTS_DIR / slug).exists():
        slug, n = f"{base[:36]}-{n}", n + 1
    img = None
    if mark_png or not body.get("no_mark"):           # a project of your own images can start with no mark (one comes later)
        try:
            img = Image.open(io.BytesIO(mark_png))
            img.load()
            mark_alpha(img)
        except ValueError:
            raise
        except Exception:
            raise ValueError("The mark must be a PNG or JPEG image.")
    raw = _fields({**body, "name": name}, {"v": 1, "created": time.strftime("%Y-%m-%dT%H:%M:%S")})   # v: the project file's format, for later changes
    raw.setdefault("mark_size", 18.0); raw.setdefault("mark_x", 50.0); raw.setdefault("mark_y", 50.0)
    folder = PROJECTS_DIR / slug
    folder.mkdir(parents=True)                        # raises if another request just took the name: then nothing of theirs is removed
    try:
        if img is not None:
            img.convert("RGBA").save(folder / "mark.png", "PNG")
        _write(slug, raw)
        (folder / "plates").mkdir(exist_ok=True)
        p = load(slug)
        if img is not None:
            make_guides(p)
    except Exception:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    return p


def update(slug: str, body: dict, mark_png: bytes | None = None) -> dict:
    """Change a project's settings (and its mark). The guides are made again and Krea's copies forgotten when the mark moves."""
    raw = json.loads(_project_file(slug).read_text())
    if raw.get("qa") == "demo-tuned":                 # DEMO: its mark, size, place and the words of its fixed prompt sentence stay
        body = {k: v for k, v in body.items() if k in ("name", "brief", "palette")}
    before = {k: raw.get(k) for k in ("mark_size", "mark_x", "mark_y")}
    raw = _fields(body, raw)
    p = load(slug)
    if mark_png is not None:
        if raw.get("qa") == "demo-tuned":
            raise ValueError("Demo keeps its own mark: make a new project to use another one.")
        img = Image.open(io.BytesIO(mark_png)); img.load(); mark_alpha(img)
        img.convert("RGBA").save(p["mark_file"], "PNG")
    _write(slug, raw)
    p = load(slug)
    if p["has_mark"] and (mark_png is not None or any(raw.get(k) != v for k, v in before.items())):
        if raw.get("qa") != "demo-tuned":           # DEMO's guides are its originals
            make_guides(p)
        p["guide_cache_file"].unlink(missing_ok=True)
    return p


def _mark_image(mark_png: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(mark_png))
        img.load()
    except Exception:
        raise ValueError("The mark must be a PNG or JPEG image.")
    mark_alpha(img)                                   # raises if it is empty
    return img


def add_mark(slug: str, body: dict, mark_png: bytes) -> dict:
    """Another mark for this project (at the main mark's place, its own size and words). Returns the project."""
    raw = json.loads(_project_file(slug).read_text())               # (Demo too: its main mark, words and check stay as they are)
    marks = [m for m in raw.get("marks") or [] if isinstance(m, dict)]
    if len(marks) >= ADD_MARKS:
        raise ValueError(f"A project holds up to {ADD_MARKS + 1} marks.")
    img = _mark_image(mark_png)
    name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()[:30] or f"Mark {len(marks) + 2}"
    base, mid, n = slugify(name)[:26] or "mark", None, 2
    taken = {str(m.get("id")) for m in marks} | {"main"}
    mid = base
    while mid in taken:
        mid, n = f"{base}-{n}", n + 1
    img.convert("RGBA").save(PROJECTS_DIR / slug / f"mark-{mid}.png", "PNG")
    marks.append(_mark_fields(body, {"id": mid, "name": name, "size": float(raw.get("mark_size", 18)), "x": float(raw.get("mark_x", 50)), "y": float(raw.get("mark_y", 50))}))
    raw["marks"] = marks
    _write(slug, raw)
    return load(slug)


def _mark_fields(body: dict, m: dict) -> dict:
    if "name" in body:
        m["name"] = re.sub(r"\s+", " ", str(body["name"] or "")).strip()[:30] or m.get("name") or m["id"]
    if body.get("size") not in (None, ""):
        try:
            m["size"] = round(min(60.0, max(4.0, float(body["size"]))), 1)
        except (TypeError, ValueError):
            raise ValueError("A mark's size must be a number.")
    for k in ("x", "y"):                               # its own place, as a % of the frame (kept inside it)
        if body.get(k) not in (None, ""):
            try:
                m[k] = round(min(90.0, max(10.0, float(body[k]))), 1)
            except (TypeError, ValueError):
                raise ValueError("A mark's place must be a number.")
    for k in ("shape", "noun"):
        if k in body:
            m[k] = re.sub(r"\s+", " ", str(body[k] or "")).strip()[:80 if k == "shape" else 40] or None
    return m


def save_marks(slug: str, marks: list, images: dict) -> dict:
    """The project's other marks as the settings form holds them, in one go: those listed stay (changed as listed, a new image if one
    came), those without an id are added (`images` holds each new or replaced image, by its place in the list), the rest go."""
    raw = json.loads(_project_file(slug).read_text())
    have = {str(m.get("id")): m for m in raw.get("marks") or [] if isinstance(m, dict)}
    out, taken = [], {"main"} | set(have)
    for i, item in enumerate(marks[:MAX_MARKS]):
        if not isinstance(item, dict):
            continue
        mid = str(item.get("id") or "")
        if mid in have and have[mid].get("qa") == "demo-tuned":    # Demo's orbital mark: as it is (its size, place, words and image are fixed)
            taken.add(mid); out.append(dict(have[mid]))
            continue
        if mid in have:
            m = _mark_fields(item, dict(have[mid]))
        else:                                          # a new one: its image is required, and room for it
            if i not in images or len(out) >= ADD_MARKS:
                continue
            name = re.sub(r"\s+", " ", str(item.get("name") or "")).strip()[:30] or f"Mark {len(out) + 2}"
            base, mid, n = slugify(name)[:26] or "mark", None, 2
            mid = base
            while mid in taken:
                mid, n = f"{base}-{n}", n + 1
            m = _mark_fields(item, {"id": mid, "name": name, "size": float(raw.get("mark_size", 18)), "x": float(raw.get("mark_x", 50)), "y": float(raw.get("mark_y", 50))})
        taken.add(mid)
        if i in images:
            _mark_image(images[i]).convert("RGBA").save(PROJECTS_DIR / slug / f"mark-{mid}.png", "PNG")
        out.append(m)
    out += [dict(m) for k, m in have.items() if m.get("qa") == "demo-tuned" and k not in {x["id"] for x in out}][:max(0, MAX_MARKS - len(out))]   # never removed
    for gone in set(have) - {m["id"] for m in out}:
        if MARK_ID.match(gone):
            (PROJECTS_DIR / slug / f"mark-{gone}.png").unlink(missing_ok=True)
    if out:
        raw["marks"] = out
    elif raw.get("marks"):                             # none left (an empty list from before stays as it is: nothing to write)
        raw.pop("marks")
    _write(slug, raw)
    return load(slug)


def make_default(slug: str, mark_id: str) -> str:
    """Another of its marks becomes the default: it takes the main slot (the one every part of the app reads first) and the old
    default takes its place in the list, under its id. Returns that id: the images made with either one are told apart by it
    (the caller swaps them in the curation). Demo too: its orbital mark takes its tuned check, words and lock with it."""
    raw = json.loads(_project_file(slug).read_text())
    marks = [m for m in raw.get("marks") or [] if isinstance(m, dict)]
    m = next((x for x in marks if x.get("id") == mark_id), None)
    if not m or not MARK_ID.match(mark_id):
        raise FileNotFoundError(mark_id)
    p = load(slug)
    folder = PROJECTS_DIR / slug
    main_file, other = p["mark_file"], folder / f"mark-{mark_id}.png"
    if folder.resolve() not in main_file.resolve().parents:
        if raw.get("qa") != "demo-tuned":
            raise ValueError("This project's main mark lives outside its folder: it stays the default.")
        shutil.copy2(main_file, folder / "mark.png")   # the repository's Demo: its orbital mark copied in, the original never moved
        raw["mark"], main_file = "mark.png", folder / "mark.png"
    paths = dict(raw.get("paths") or {})              # the guides a new default gets are drawn in the folder, never over the repository's originals
    for k in ("guide_dark", "guide_light", "guide_cache"):
        if k in paths and folder.resolve() not in (ROOT_DIR / paths[k]).resolve().parents:
            paths.pop(k)
    if paths:
        raw["paths"] = paths
    else:
        raw.pop("paths", None)
    tmp = folder / ".swap.png"
    shutil.move(str(main_file), str(tmp)); shutil.move(str(other), str(main_file)); shutil.move(str(tmp), str(other))
    old = {"id": mark_id, "name": raw.get("mark_name") or "Main mark", "size": raw.get("mark_size", 18), "x": raw.get("mark_x", 50),
           "y": raw.get("mark_y", 50), "shape": raw.get("mark_shape"), "noun": raw.get("mark_noun"),
           **({"qa": "demo-tuned"} if raw.get("qa") == "demo-tuned" else {})}
    raw["qa"] = "demo-tuned" if m.get("qa") == "demo-tuned" else "mark"
    raw.update({"mark_name": m.get("name"), "mark_size": m.get("size", raw.get("mark_size", 18)), "mark_x": m.get("x", raw.get("mark_x", 50)),
                "mark_y": m.get("y", raw.get("mark_y", 50)), "mark_shape": m.get("shape"), "mark_noun": m.get("noun")})
    raw["marks"] = [old if x is m else x for x in marks]
    _write(slug, raw)
    q = load(slug)
    make_guides(q)
    q["guide_cache_file"].unlink(missing_ok=True)
    return mark_id


def swap_marks_used(state: dict, mark_id: str, plates) -> dict:
    """After make_default: the images made with the new default were recorded under its id (now the old default's); the images with
    no record were the old default's. Swapped, so every image keeps the mark it was made with."""
    used = dict(state.get("marks_used") or {})
    swapped = {n: v for n, v in used.items() if v != mark_id}
    for n in plates:
        if n not in used:
            swapped[n] = mark_id
    state["marks_used"] = swapped
    return state


def edit_mark(slug: str, mark_id: str, body: dict) -> dict:
    raw = json.loads(_project_file(slug).read_text())
    marks = [m for m in raw.get("marks") or [] if isinstance(m, dict)]
    m = next((m for m in marks if m.get("id") == mark_id), None)
    if not m:
        raise FileNotFoundError(mark_id)
    if m.get("qa") == "demo-tuned":
        raise ValueError("Demo's orbital mark keeps its size, place and words.")
    _mark_fields(body, m)
    raw["marks"] = marks
    _write(slug, raw)
    return load(slug)


def remove_mark(slug: str, mark_id: str) -> dict:
    """The mark leaves the project (its images stay; they read as made with the main mark from then on)."""
    raw = json.loads(_project_file(slug).read_text())
    marks = [m for m in raw.get("marks") or [] if isinstance(m, dict)]
    if not any(m.get("id") == mark_id for m in marks):
        raise FileNotFoundError(mark_id)
    if any(m.get("id") == mark_id and m.get("qa") == "demo-tuned" for m in marks):
        raise ValueError("Demo's orbital mark stays in the project.")
    raw["marks"] = [m for m in marks if m.get("id") != mark_id]
    _write(slug, raw)
    if MARK_ID.match(mark_id):
        (PROJECTS_DIR / slug / f"mark-{mark_id}.png").unlink(missing_ok=True)
    return load(slug)


# ---- the brand in the words: DEMO's colours in the worlds and colour ideas become this project's ----
DEMO_COLOUR = re.compile(r"(?:(?:warm |burnt |electric[- ]|hot |deep )?(?:cream|orange|blue|pink|oxblood|ink)\s*)?\(?(#EC540C|#F64570|#5D8FF4|#381313|#1A1A1A|#FEFFE7)\)?", re.I)


def rebrand(text: str, p: dict) -> str:
    """DEMO's brand colours named in a world or a colour idea, as this project's (by position in the palette). DEMO: unchanged."""
    if p.get("demo") or p.get("qa") == "demo-tuned" or p["slug"] == DEFAULT:
        return text
    pal = p["palette"]
    if not pal:
        return DEMO_COLOUR.sub("one brand colour", text)
    return DEMO_COLOUR.sub(lambda m: f"brand colour {pal[DEMO_PALETTE.index(m.group(1).upper()) % len(pal)]}", text)


# ---- a project as one file, NAME.phos (.phosphene before 2026-10-27, still opened): its folder zipped (mark, guides, curation, images), to send to someone or keep. An open
# format on purpose: renamed .zip it is JSON and the original images, so nothing is ever locked in. "format" is its version ----
PROJECT_FORMAT = 1
EXPORT_NAMES = ("project.json", "mark.png", "guide_dark.png", "guide_light.png", "state.json")


def export_zip(slug: str, out: Path) -> str:
    """Writes the project to `out` as a zip with one folder: project.json (with no paths: everything inside), the mark, the
    guides, the curation (groups, snapshots, order, titles, the trash) and every image, so it opens as it was. Caches stay out.
    Returns the file name to save it as."""
    import zipfile
    p = load(slug)
    raw = json.loads(_project_file(slug).read_text())
    raw.pop("paths", None)
    raw["mark"] = "mark.png"
    raw["format"] = PROJECT_FORMAT
    try:
        state = json.loads(p["state_file"].read_text())
    except Exception:
        state = {}
    for secret in ("kimi_api_key",):                    # never in a file that travels
        state.pop(secret, None)
    top = slugify(p["name"])
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED) as z:
        z.writestr(f"{top}/project.json", json.dumps(raw, indent=2) + "\n")
        z.writestr(f"{top}/state.json", json.dumps(state, indent=1))
        if p["has_mark"]:
            z.write(p["mark_file"], f"{top}/mark.png")
        for m in p.get("marks") or []:                      # the other marks
            if m["mark_file"].is_file():
                z.write(m["mark_file"], f"{top}/mark-{m['id']}.png")
        for kind, f in p["guides"].items():
            if f.is_file():
                z.write(f, f"{top}/guide_{kind}.png")
        plates = sorted(p["plates_dir"].glob("*.jpg"))
        for img in plates:
            z.write(img, f"{top}/plates/{img.name}")
        names = {img.name for img in plates}
        for f, arc in ((p["qa_cache_file"], "qa.json"), (p["features_file"], "features.json")):   # the logo check and the looks, measured: an import opens at once
            try:
                cache = json.loads(Path(f).read_text())
                z.writestr(f"{top}/{arc}", json.dumps({k: v for k, v in cache.items() if isinstance(v, dict) and k.split(":", 1)[0] in names}))
            except Exception:
                pass
    return f"{re.sub(r'[^A-Za-z0-9 ._-]+', '', p['name']).strip() or 'Project'}.phos"


def import_zip(path: Path) -> dict:
    """A project file made by export_zip, as a new project (a new folder; nothing existing is replaced). Only the files a
    project has are taken, and none outside its folder."""
    import zipfile
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise ValueError("That is not a project file (a .phos file made by Export project).")
    with z:
        names = [n for n in z.namelist() if not n.endswith("/") and not n.startswith("__MACOSX/") and not Path(n).name.startswith(".")]   # Finder's Compress adds __MACOSX/ and ._ files
        tops = {n.split("/", 1)[0] for n in names}
        if len(tops) != 1 or f"{next(iter(tops))}/project.json" not in names:
            raise ValueError("That zip is not a project: it has no project.json.")
        top = next(iter(tops))
        try:
            raw = json.loads(z.read(f"{top}/project.json"))
        except Exception:
            raise ValueError("That project file is damaged (its project.json cannot be read).")
        if not isinstance(raw, dict) or not raw.get("name"):
            raise ValueError("That project file has no name.")
        if int(raw.get("format", 1)) > PROJECT_FORMAT:
            raise ValueError("That project was made by a newer Phosphene: update the app (it offers it when it opens), then open it again.")
        try:                                          # the fields as create / update take them: numbers in their ranges, words, colours
            raw = _fields({k: raw[k] for k in ("name", "mark_size", "mark_x", "mark_y", "mark_shape", "mark_noun", "mark_name", "brief", "palette") if k in raw},
                          {"v": 1, "qa": raw.get("qa") if raw.get("qa") == "demo-tuned" else "mark",
                           **({"created": str(raw["created"])[:30]} if raw.get("created") else {})})
        except (TypeError, ValueError, AttributeError):
            raise ValueError("That project file is damaged (its settings cannot be read).")
        raw.setdefault("mark_size", 18.0); raw.setdefault("mark_x", 50.0); raw.setdefault("mark_y", 50.0)
        raw["mark"] = "mark.png"
        extra = []
        for m in (json.loads(z.read(f"{top}/project.json")).get("marks") or [])[:MAX_MARKS]:   # the other marks, checked as add_mark checks them
            if isinstance(m, dict) and MARK_ID.match(str(m.get("id") or "")) and m["id"] != "main" and f"{top}/mark-{m['id']}.png" in names:
                try:
                    extra.append(_mark_fields({k: m[k] for k in ("name", "size", "x", "y", "shape", "noun") if k in m}, {"id": m["id"], "name": m["id"], "size": raw["mark_size"],
                                                                                                                        **({"qa": "demo-tuned"} if m.get("qa") == "demo-tuned" and raw.get("qa") != "demo-tuned" and not any(x.get("qa") for x in extra) else {})}))
                except ValueError:
                    pass
        if extra:
            raw["marks"] = extra
        taken = {q["name"] for q in all_projects()}                    # the same name as a project here: "Nike 2", as Finder numbers a copy
        if raw["name"] in taken:
            stem, k = re.sub(r" \d+$", "", raw["name"])[:56], 2
            while f"{stem} {k}" in taken:
                k += 1
            raw["name"] = f"{stem} {k}"
        base = slugify(raw["name"])
        slug, n = base, 2
        while (PROJECTS_DIR / slug).exists():
            slug, n = f"{base[:36]}-{n}", n + 1
        folder = PROJECTS_DIR / slug
        folder.mkdir(parents=True)                    # raises if another import just took the name: then nothing of theirs is removed
        try:
            (folder / "plates").mkdir()
            for n_ in names:
                rel = n_[len(top) + 1:]
                ok = rel in EXPORT_NAMES[1:] or any(rel == f"mark-{m['id']}.png" for m in extra) or (rel.startswith("plates/") and rel.count("/") == 1 and rel.lower().endswith(".jpg") and not rel.split("/")[1].startswith("."))
                if ok:
                    with z.open(n_) as src, open(folder / rel, "wb") as dst:
                        shutil.copyfileobj(src, dst, 1 << 20)

            _clean_state(folder / "state.json")
            _write(slug, raw)
            q = load(slug)
            plates = {f.name for f in (folder / "plates").glob("*.jpg")}
            for arc, dest in (("qa.json", q["qa_cache_file"]), ("features.json", q["features_file"])):
                if f"{top}/{arc}" in names:
                    try:
                        cache = json.loads(z.read(f"{top}/{arc}"))
                        keep = {k: v for k, v in cache.items() if isinstance(k, str) and isinstance(v, dict) and _bare(k.split(":", 1)[0]) and k.split(":", 1)[0] in plates}
                        Path(dest).write_text(json.dumps(keep))
                    except Exception:
                        pass                                    # measured again, as before
            raw["imported"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            _write(slug, raw)
            p = load(slug)
            if p["has_mark"] and not all(f.is_file() for f in p["guides"].values()):
                make_guides(p)
        except ValueError:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        except Exception as e:                        # a damaged zip (CRC), an unknown compression: say so, leave nothing behind
            shutil.rmtree(folder, ignore_errors=True)
            raise ValueError(f"That project file is damaged ({type(e).__name__}).")
    return p


def _bare(n) -> bool:
    n = str(n or "")
    return bool(n) and n == Path(n).name and not n.startswith(".") and "\\" not in n


def _clean_state(f: Path) -> None:
    """A curation from someone else's file: every image name in it must be a bare file name (no '../', no '/Users/...'), or a
    later Empty trash could reach outside the project. Anything else is dropped."""
    if not f.is_file():
        return
    try:
        st = json.loads(f.read_text())
    except Exception:
        f.unlink()
        return
    if not isinstance(st, dict):
        f.unlink()
        return
    st.pop("kimi_api_key", None)                    # someone else's key never comes in (it would be used, and saved as this machine's)
    for key in ("trashed", "order", "purged", "qa_failed", "critic_failed"):
        if isinstance(st.get(key), list):
            st[key] = [n for n in st[key] if isinstance(n, str) and _bare(n)]   # a number or a list there stopped the library from loading
    if isinstance(st.get("history"), list):
        st["history"] = [t for t in st["history"] if isinstance(t, str)]
    for key in ("trashed_at", "titles", "prompts", "models", "worlds", "ideas", "critic"):
        if isinstance(st.get(key), dict):
            st[key] = {k: v for k, v in st[key].items() if _bare(k)}
    for seq in st.get("sequences") or []:
        if isinstance(seq, dict):
            for key in ("order", "original"):
                if isinstance(seq.get(key), list):
                    seq[key] = [n for n in seq[key] if isinstance(n, str) and _bare(n)]
    for g in st.get("groups") or []:
        if isinstance(g, dict) and isinstance(g.get("files"), list):
            g["files"] = [n for n in g["files"] if isinstance(n, str) and _bare(n)]
        if isinstance(g, dict) and "rule" in g:                 # a smart group: its rule checked, or it reads as a manual one
            import groups as _groups
            g["rule"] = _groups.clean_rule(g["rule"])
            if not g["rule"]:
                del g["rule"]
    if isinstance(st.get("uploads"), list):           # the user's own images (no mark check)
        st["uploads"] = [n for n in st["uploads"] if isinstance(n, str) and _bare(n)]
    if isinstance(st.get("as_designed"), list):        # images made with Keep it as designed
        st["as_designed"] = [n for n in st["as_designed"] if isinstance(n, str) and _bare(n)]
    if isinstance(st.get("marks_used"), dict):        # which images were made with another of the project's marks
        st["marks_used"] = {k: v for k, v in st["marks_used"].items() if _bare(k) and isinstance(v, str) and MARK_ID.match(v)}
    elif "marks_used" in st:
        del st["marks_used"]
    if isinstance(st.get("placements"), dict):
        import placement                            # (it imports this module)
        st["placements"] = {k: c for k, v in st["placements"].items() if _bare(k) and (c := placement.clean(v))}
    elif "placements" in st:
        del st["placements"]
    f.write_text(json.dumps(st, indent=1))


def seed_examples(examples: Path) -> list[str]:
    """First launch of the app: the projects that come with it (Demo, the sample) are copied in, once. A project folder
    that exists is never touched, and one deleted later does not come back, unless no project is left at all."""
    marker = places.SUPPORT_DIR / ".examples_copied"
    if not examples or not Path(examples).is_dir():
        return []
    if marker.exists() and all_projects():             # copied before, and there are projects: leave things as they are
        return []                                       # (with none left at all, the sample comes back: the app always opens on something)
    added = []
    for src in sorted(Path(examples).iterdir()):
        if (src / "project.json").is_file() and not (PROJECTS_DIR / src.name).exists():
            shutil.copytree(src, PROJECTS_DIR / src.name)
            added.append(src.name)
    marker.write_text(json.dumps({"copied": added, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}))
    return added


def mark_colours(img: Image.Image, n: int = 4) -> list[str]:
    """The mark's own colours (its visible pixels), most used first, near-duplicates merged."""
    im = img.convert("RGBA")
    im.thumbnail((200, 200))
    raw = im.tobytes()
    px = [tuple(raw[i:i + 3]) for i in range(0, len(raw), 4) if raw[i + 3] > 200]
    if not px:
        return []
    q = Image.new("RGB", (len(px), 1)); q.putdata(px)
    pal = q.quantize(colors=8, method=Image.Quantize.MEDIANCUT)
    counts = sorted(pal.getcolors() or [], reverse=True)
    colours = pal.getpalette()
    out: list[tuple] = []
    for count, idx in counts:
        c = tuple(colours[idx * 3: idx * 3 + 3])
        if count < len(px) * 0.04 or any(sum((a - b) ** 2 for a, b in zip(c, o)) < 40 ** 2 for o in out):
            continue
        out.append(c)
    return ["#%02X%02X%02X" % c for c in out[:n]]
