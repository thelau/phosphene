"""
What the ordering engine can measure about an image, cheaply (Pillow only): brightness, contrast, colour, how busy it is, the hue it
is built on, and a tiny fingerprint of the centre (where the mark sits) for shape echoes. Cached by file name + size.
"""

import json
import math
from pathlib import Path

from PIL import Image, ImageFilter, ImageOps, ImageStat

CACHE_FILE = Path(__file__).resolve().parent / ".features_cache.json"
_CACHE: dict | None = None
_DIRTY = False


def _load_cache() -> dict:
    global _CACHE
    if _CACHE is None:
        try:
            _CACHE = json.loads(CACHE_FILE.read_text())
        except Exception:
            _CACHE = {}
    return _CACHE


def save_cache() -> None:
    global _DIRTY
    if _CACHE is not None and _DIRTY:
        _DIRTY = False
        try:
            tmp = CACHE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(_CACHE))
            tmp.replace(CACHE_FILE)
        except Exception:
            pass


def measure(path: Path) -> dict:
    """lum 0..1, contrast 0..1, sat 0..1, hue 0..360 (None if grey), edges 0..1, centre fingerprint (144 numbers)."""
    im = Image.open(path).convert("RGB")
    small = im.resize((54, 96), Image.Resampling.BILINEAR)
    grey = small.convert("L")
    lum = ImageStat.Stat(grey).mean[0] / 255
    contrast = min(1.0, ImageStat.Stat(grey).stddev[0] / 90)
    hsv = small.convert("HSV")
    sat_sum = x = y = 0.0
    n = 0
    for h, s, v in zip(*[iter(hsv.tobytes())] * 3):
        n += 1
        sat_sum += s
        if s > 64 and v > 50:                       # only colours that are really there decide the hue
            w = s / 255
            x += w * math.cos(h / 255 * 2 * math.pi)
            y += w * math.sin(h / 255 * 2 * math.pi)
    sat = sat_sum / n / 255 if n else 0.0
    hue = (math.degrees(math.atan2(y, x)) % 360) if math.hypot(x, y) > n * 0.03 else None
    edges = min(1.0, ImageStat.Stat(grey.filter(ImageFilter.FIND_EDGES)).mean[0] / 40)
    w, h = im.size
    box = (int(w * 0.3), int(h * 0.38), int(w * 0.7), int(h * 0.62))   # the area around the dead-centre mark
    centre = ImageOps.autocontrast(im.crop(box).convert("L").resize((12, 12), Image.Resampling.BILINEAR))
    px = list(centre.tobytes())
    mean = sum(px) / len(px)
    sd = math.sqrt(sum((p - mean) ** 2 for p in px) / len(px)) or 1.0
    return {"lum": round(lum, 4), "contrast": round(contrast, 4), "sat": round(sat, 4), "hue": None if hue is None else round(hue, 1),
            "edges": round(edges, 4), "centre": [round((p - mean) / sd, 3) for p in px]}


def get(path: Path) -> dict:
    cache = _load_cache()
    key = f"{path.name}:{path.stat().st_size}"
    if key not in cache:
        global _DIRTY
        cache[key] = measure(path)
        _DIRTY = True
    return cache[key]


def peek(path: Path) -> dict | None:
    """The measurements if they are already cached (never measures: the state must answer fast)."""
    try:
        return _load_cache().get(f"{path.name}:{path.stat().st_size}")
    except OSError:
        return None


def look(f: dict | None) -> list:
    """Plain words for how an image looks, for the automatic groups: warm / cold / mono, and dark / bright."""
    if not f:
        return []
    tags = []
    hue, sat, lum = f.get("hue"), f.get("sat", 0), f.get("lum", 0.5)
    if hue is None or sat < 0.12:
        tags.append("mono")
    elif hue < 70 or hue >= 300:
        tags.append("warm")
    elif 150 <= hue < 270:
        tags.append("cold")
    if lum < 0.33:
        tags.append("dark")
    elif lum > 0.62:
        tags.append("bright")
    return tags


def hue_gap(a, b) -> float:
    """Degrees apart on the colour wheel (0..180). 90 when either side has no real colour."""
    if a is None or b is None:
        return 90.0
    d = abs(a - b) % 360
    return min(d, 360 - d)


def shape_echo(a: dict, b: dict) -> float:
    """0..1: how alike the two centres look (a light-on-dark and a dark-on-light version of one shape count as alike)."""
    pa, pb = a["centre"], b["centre"]
    corr = sum(x * y for x, y in zip(pa, pb)) / len(pa)
    return max(0.0, min(1.0, abs(corr)))


def impact(f: dict) -> float:
    """How strong the image is as a hook or a peak."""
    return 0.4 * f["contrast"] + 0.3 * f["sat"] + 0.3 * f["edges"]
