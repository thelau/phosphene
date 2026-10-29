"""Where each image's mark goes: the target a batch asks for.

On target (the default) is the project's own place and size, as always: no placement is stored. Loose gives every image its own
place and size, chosen here, drawn into that image's guide for Krea, named in its prompt and kept with the image, so the logo
check and the logo target know exactly where its mark should be."""

import hashlib
import random
import tempfile
from pathlib import Path

from PIL import Image

import projects

KINDS = ("exact", "loose")
LOOSE_SIZE = (0.6, 1.6)       # times the project's size
SIZE_PCT = (6.0, 45.0)        # never smaller or bigger than this share of the width
MARGIN = 6.0                  # % of the frame kept clear between the mark's box and the frame's edge
GUIDE_DIR = Path(tempfile.gettempdir()) / "phosphene-guides"


def _ratio(project: dict) -> float:
    a = projects.mark_alpha(Image.open(project["mark_file"]))
    return a.height / a.width


def choose(kind: str, project: dict, rng: random.Random | None = None) -> dict | None:
    """A placement for one image: None on target; for Loose, a place and size inside the frame (its box clear of the edges)."""
    if kind != "loose":
        return None
    rng = rng or random.Random()
    lo, hi = LOOSE_SIZE
    size = min(SIZE_PCT[1], max(SIZE_PCT[0], project["mark_size"] * rng.uniform(lo, hi)))
    h_pct = size * _ratio(project) * projects.FRAME_W / projects.FRAME_H        # its height, in % of the frame's height
    x = rng.uniform(size / 2 + MARGIN, 100 - size / 2 - MARGIN)
    y = rng.uniform(h_pct / 2 + MARGIN, 100 - h_pct / 2 - MARGIN)
    return {"kind": "loose", "x": round(x, 1), "y": round(y, 1), "size": round(size, 1)}


def clean(pl) -> dict | None:
    """A placement from the page or a received project, checked: numbers inside the frame, or None."""
    if not isinstance(pl, dict) or pl.get("kind") not in KINDS or pl["kind"] == "exact":
        return None
    try:
        x, y, size = (float(pl[k]) for k in ("x", "y", "size"))
    except (KeyError, TypeError, ValueError):
        return None
    if not (0 < x < 100 and 0 < y < 100 and SIZE_PCT[0] <= size <= SIZE_PCT[1]):
        return None
    return {"kind": pl["kind"], "x": round(x, 1), "y": round(y, 1), "size": round(size, 1)}


def as_project(project: dict, pl: dict | None) -> dict:
    """The project as this image sees it: its mark at the placement's size and place (the project itself on target)."""
    if not pl:
        return project
    return {**project, "mark_size": pl["size"], "mark_x": pl["x"], "mark_y": pl["y"]}


def guide(project: dict, pl: dict) -> dict:
    """This placement's guide images (dark and light), drawn once into a temporary folder; the `guide` the Krea client uploads."""
    key = hashlib.sha1(f"{project['mark_file']}:{Path(project['mark_file']).stat().st_mtime}:{pl['x']}:{pl['y']}:{pl['size']}".encode()).hexdigest()[:16]
    files = {kind: GUIDE_DIR / f"{key}-{kind}.png" for kind in ("dark", "light")}
    if not all(f.exists() for f in files.values()):
        GUIDE_DIR.mkdir(parents=True, exist_ok=True)
        projects.make_guides({**as_project(project, pl), "guides": files})
    return {"files": files, "cache": GUIDE_DIR / f"{key}-urls.json"}
