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
        "name": raw.get("name") or slug,
        "mark_file": (ROOT_DIR / mark) if "/" in mark else base / mark,
        "mark_size": float(raw.get("mark_size", 18)),          # % of the frame's width
        "mark_x": float(raw.get("mark_x", 50)),                # % from the left
        "mark_y": float(raw.get("mark_y", 50)),                # % from the top
        "mark_shape": raw.get("mark_shape") or "logo mark",    # what the prompts call its shape ("circular orbital logo")
        "mark_noun": raw.get("mark_noun") or "mark",           # and the mark itself ("circular mark")
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
    }
    return p


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
    return {"slug": p["slug"], "name": p["name"], "mark_size": p["mark_size"], "mark_x": p["mark_x"], "mark_y": p["mark_y"],
            "mark_shape": p["mark_shape"], "mark_noun": p["mark_noun"], "brief": p["brief"], "palette": p["palette"],
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
    try:
        folder.mkdir(parents=True)
        img.convert("RGBA").save(folder / "mark.png", "PNG")
        _write(slug, raw)
        (folder / "plates").mkdir()
        p = load(slug)
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
    if mark_png is not None or any(raw.get(k) != v for k, v in before.items()):
        if raw.get("qa") != "demo-tuned":           # DEMO's guides are its originals
            make_guides(p)
        p["guide_cache_file"].unlink(missing_ok=True)
    return p


# ---- the brand in the words: DEMO's colours in the worlds and colour ideas become this project's ----
DEMO_COLOUR = re.compile(r"(?:(?:warm |burnt |electric[- ]|hot |deep )?(?:cream|orange|blue|pink|oxblood|ink)\s*)?\(?(#EC540C|#F64570|#5D8FF4|#381313|#1A1A1A|#FEFFE7)\)?", re.I)


def rebrand(text: str, p: dict) -> str:
    """DEMO's brand colours named in a world or a colour idea, as this project's (by position in the palette). DEMO: unchanged."""
    if p.get("qa") == "demo-tuned" or p["slug"] == DEFAULT:
        return text
    pal = p["palette"]
    if not pal:
        return DEMO_COLOUR.sub("one brand colour", text)
    return DEMO_COLOUR.sub(lambda m: f"brand colour {pal[DEMO_PALETTE.index(m.group(1).upper()) % len(pal)]}", text)


# ---- a project as one file, NAME.phosphene: its folder zipped (mark, guides, curation, images), to send to someone or keep. An open
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
        z.write(p["mark_file"], f"{top}/mark.png")
        for kind, f in p["guides"].items():
            if f.is_file():
                z.write(f, f"{top}/guide_{kind}.png")
        for img in sorted(p["plates_dir"].glob("*.jpg")):
            z.write(img, f"{top}/plates/{img.name}")
    return f"{re.sub(r'[^A-Za-z0-9 ._-]+', '', p['name']).strip() or 'Project'}.phosphene"


def import_zip(path: Path) -> dict:
    """A project file made by export_zip, as a new project (a new folder; nothing existing is replaced). Only the files a
    project has are taken, and none outside its folder."""
    import zipfile
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise ValueError("That is not a project file (a .phosphene file made by Export project).")
    with z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        tops = {n.split("/", 1)[0] for n in names}
        if len(tops) != 1 or f"{next(iter(tops))}/project.json" not in names:
            raise ValueError("That zip is not a project: it has no project.json.")
        top = next(iter(tops))
        raw = json.loads(z.read(f"{top}/project.json"))
        if not isinstance(raw, dict) or not raw.get("name"):
            raise ValueError("That project file has no name.")
        if int(raw.get("format", 1)) > PROJECT_FORMAT:
            raise ValueError("That project was made by a newer Phosphene: update the app (it offers it when it opens), then open it again.")
        raw.pop("paths", None)
        raw["mark"] = "mark.png"
        base = slugify(raw["name"])
        slug, n = base, 2
        while (PROJECTS_DIR / slug).exists():
            slug, n = f"{base[:36]}-{n}", n + 1
        folder = PROJECTS_DIR / slug
        try:
            (folder / "plates").mkdir(parents=True)
            for n_ in names:
                rel = n_[len(top) + 1:]
                ok = rel in EXPORT_NAMES[1:] or (rel.startswith("plates/") and rel.count("/") == 1 and rel.lower().endswith(".jpg") and not rel.split("/")[1].startswith("."))
                if ok:
                    with z.open(n_) as src, open(folder / rel, "wb") as dst:
                        shutil.copyfileobj(src, dst, 1 << 20)
            if not (folder / "mark.png").is_file():
                raise ValueError("That project file has no mark.")
            raw["imported"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            _write(slug, raw)
            p = load(slug)
            if not all(f.is_file() for f in p["guides"].values()):
                make_guides(p)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
    return p


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
