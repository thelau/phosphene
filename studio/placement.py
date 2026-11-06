"""Where each image's mark goes: the target a batch asks for.

On target (the default) is the project's own place and size, as always: no placement is stored. Loose and Scattered give every
image its own place and size, chosen here (Loose drifts around the project's place, Scattered goes anywhere in the frame), drawn into that image's guide for Krea, named in its prompt and kept with the image, so the logo
check and the logo target know exactly where its mark should be."""

import hashlib
import math
import random
import tempfile
from pathlib import Path

from PIL import Image

import projects

KINDS = ("exact", "loose", "scattered", "path")
# Path (2026-10-31): a batch's images at even steps along a shape through the project's place, so an edit can play the mark travelling.
# Each shape maps t (0 to 1 along it) to a point of a unit figure centred on (0, 0), before it is turned to its direction and scaled to its
# length; another shape (an arc, a circle, a broken line) is one more entry here, everything else reads `path` as it is.
PATHS = {
    "line": lambda t: (t - 0.5, 0.0),
}
PATH_DIRS = (0, 90, 45, -45)          # degrees clockwise from left-to-right: across, down, down-right, up-right
PATH_LENS = (20, 40, 70)              # % of the frame: short, medium, long
PATH_ANCHORS = ("through", "lands", "leaves")   # where the target sits on it: its middle, its last step (the motion lands home), its first
LEVELS = {                    # per level, bands that never overlap, so each reads as itself (never as On target):
    # how far from the project's place (% of the frame, the larger of across and down; None: as far as the frame goes),
    # and its size, times the project's (one of two bands: smaller or bigger, never about the same)
    "loose": {"away": (0.5, 2.0), "size": ((0.9, 0.96), (1.04, 1.1))},   # as the reference films: a breath off, felt across cuts more than seen
    "scattered": {"away": (8.0, None), "size": ((0.6, 0.85), (1.2, 1.6))},
}
SIZE_PCT = (6.0, 45.0)        # never smaller or bigger than this share of the width
MARGIN = 6.0                  # % of the frame kept clear between the mark's box and the frame's edge
GUIDE_DIR = Path(tempfile.gettempdir()) / "phosphene-guides"


def _ratio(project: dict) -> float:
    a = projects.mark_alpha(Image.open(project["mark_file"]))
    return a.height / a.width


def clean_path(path) -> dict | None:
    """A path's settings, checked: {shape, dir, len, i, n, run} (step i of n of one batch, `run`), or None."""
    if not isinstance(path, dict) or path.get("shape") not in PATHS:
        return None
    try:
        d, ln, i, n = int(path.get("dir", 0)), int(path.get("len", 40)), int(path.get("i", 0)), int(path.get("n", 1))
    except (TypeError, ValueError):
        return None
    if d not in PATH_DIRS or ln not in PATH_LENS or not (1 <= n <= 200 and 0 <= i < n):
        return None
    anchor = path.get("anchor") if path.get("anchor") in PATH_ANCHORS else "through"
    return {"shape": path["shape"], "dir": d, "len": ln, "i": i, "n": n, "run": str(path.get("run") or "")[:16],
            **({"anchor": anchor} if anchor != "through" else {}),     # through, as every path before anchors: nothing added
            **({"fit": 1} if path.get("fit") else {})}                  # its reach scaled to the room (see path_place); runs from before keep theirs


def path_place(project: dict, path: dict, size: float, ratio: float) -> tuple[float, float]:
    """Where step i of n of a path puts the mark: along its shape through the project's place, its length shrunk if an end would leave
    the frame (the box kept clear of the edges)."""
    t = path["i"] / max(1, path["n"] - 1) if path["n"] > 1 else 0.5
    shape, anchor = PATHS[path["shape"]], path.get("anchor", "through")
    o = shape({"lands": 1.0, "leaves": 0.0}.get(anchor, 0.5))                  # the point of the shape that sits on the target
    u, v = (lambda q: (q[0] - o[0], q[1] - o[1]))(shape(t))
    a = math.radians(path["dir"])
    dx, dy = u * math.cos(a) - v * math.sin(a), u * math.sin(a) + v * math.cos(a)    # its reach: % of the frame along each axis (70% down: 70% of the height)
    hx, hy = project["mark_x"], project["mark_y"]
    hw, hh = size / 2, size * ratio * projects.FRAME_W / projects.FRAME_H / 2
    most = 100.0
    for e in (shape(0.0)[0] - o[0], shape(1.0)[0] - o[0]):     # the longest it can be with both ends inside the frame
        ex, ey = e * math.cos(a), e * math.sin(a)
        for c, h, d in ((hx, hw, ex), (hy, hh, ey)):
            if abs(d) > 1e-9:
                most = max(0.0, min(most, ((100 - MARGIN - h - c) if d > 0 else (c - MARGIN - h)) / abs(d)))
    ln = float(path["len"])
    # when the room is under the longest reach, the reaches share it: 70% goes as far as the frame allows, 40% and 20% in proportion
    # (cut to the room alone, a path that lands or leaves had 40% and 70% the same, across often all three: the user, 2026-10-31);
    # with room, nothing changes (70% down through the target: 70% of the height). A run from before keeps how it was placed.
    ln = ln * min(1.0, most / max(PATH_LENS)) if path.get("fit") else min(ln, most)
    return round(hx + dx * ln, 1), round(hy + dy * ln, 1)


def choose(kind: str, project: dict, rng: random.Random | None = None, rot=0, scale=1, path: dict | None = None) -> dict | None:
    """A placement for one image: None on target; for Loose or Scattered, a place and size inside its level's reach (its box clear of
    the frame's edges). rot: the mark turned that many degrees clockwise; scale: on target, its size times this (Loose and Scattered
    choose their own sizes). On target, turned or resized: the project's place, kept with the image."""
    rot, scale = projects.clean_rot(rot), projects.clean_scale(scale)
    path = clean_path(path) if kind == "path" else None
    if path:                                                                    # a step along a path: its place, the size as on target
        size = round(project["mark_size"] * scale, 1)
        turned = projects.rotated({**project, "mark_size": size}, rot)
        x, y = path_place(project, path, turned["mark_size"], _ratio(turned))
        return {"kind": "path", "x": x, "y": y, "size": size, **({"rot": rot} if rot else {}), **({"scale": scale} if scale != 1 else {}), "path": path}
    level = LEVELS.get(kind)
    if not level:
        if not rot and scale == 1:
            return None
        return {"kind": "exact", "x": project["mark_x"], "y": project["mark_y"], "size": round(project["mark_size"] * scale, 1),
                **({"rot": rot} if rot else {}), **({"scale": scale} if scale != 1 else {})}
    rng = rng or random.Random()
    turned = projects.rotated(project, rot)                                     # a turned mark's box is wider or taller
    grow, ratio = turned["mark_size"] / project["mark_size"], _ratio(turned)
    hx, hy = project["mark_x"], project["mark_y"]
    near, far = level["away"]
    for _ in range(400):                                                        # drawn until it falls in its band (a few tries)
        size = min(SIZE_PCT[1], max(SIZE_PCT[0], project["mark_size"] * rng.uniform(*rng.choice(level["size"]))))
        hw, hh = size * grow / 2, size * grow * ratio * projects.FRAME_W / projects.FRAME_H / 2   # half its box, in % of the width / height
        reach = far if far is not None else 100.0
        x = rng.uniform(max(hw + MARGIN, hx - reach), min(100 - hw - MARGIN, hx + reach))
        y = rng.uniform(max(hh + MARGIN, hy - reach), min(100 - hh - MARGIN, hy + reach))
        if near <= max(abs(x - hx), abs(y - hy)) <= reach:
            break
    return {"kind": kind, "x": round(x, 1), "y": round(y, 1), "size": round(size, 1), **({"rot": rot} if rot else {})}


def clean(pl) -> dict | None:
    """A placement from the page or a received project, checked: numbers inside the frame, or None. On target it is kept only for a
    turned mark (its angle, `rot`, degrees clockwise) or a resized one (`scale`, times the mark's size)."""
    if not isinstance(pl, dict) or pl.get("kind") not in KINDS:
        return None
    rot, scale = projects.clean_rot(pl.get("rot")), projects.clean_scale(pl.get("scale"))
    held = pl.get("held") == 1                                                 # the size it was made at, kept when its frame's size changed
    if pl["kind"] == "exact" and not rot and scale == 1 and not held:
        return None
    path = clean_path(pl.get("path")) if pl["kind"] == "path" else None
    if pl["kind"] == "path" and not path:
        return None
    try:
        x, y, size = (float(pl[k]) for k in ("x", "y", "size"))
    except (KeyError, TypeError, ValueError):
        return None
    lo, hi = (2.4, 96.0) if pl["kind"] in ("exact", "path") else SIZE_PCT   # on target or a path: the project's own size (up to 60%), times 0.6 to 1.6
    if not (0 < x < 100 and 0 < y < 100 and lo <= size <= hi):
        return None
    return {"kind": pl["kind"], "x": round(x, 1), "y": round(y, 1), "size": round(size, 1), **({"rot": rot} if rot else {}),
            **({"scale": scale} if scale != 1 and pl["kind"] in ("exact", "path") else {}), **({"path": path} if path else {}), **({"held": 1} if held else {})}


def as_project(project: dict, pl: dict | None) -> dict:
    """The project as this image sees it: its mark at the placement's size and place (the project itself on target)."""
    if not pl:
        return project
    seen = {**project, "mark_size": pl["size"], "mark_x": pl["x"], "mark_y": pl["y"]}
    return projects.rotated(seen, pl["rot"]) if pl.get("rot") else seen         # turned: the mark's file turned, its box's width


def guide(project: dict, pl: dict, keep: bool = False) -> dict:
    """This placement's guide images (dark and light), drawn once into a temporary folder; the `guide` the Krea client uploads.
    keep (Keep it as designed): the mark's own artwork, its colours and details, instead of its silhouette."""
    key = hashlib.sha1(f"{project['mark_file']}:{Path(project['mark_file']).stat().st_mtime}:{pl['x']}:{pl['y']}:{pl['size']}:{pl.get('rot', 0)}:{keep}".encode()).hexdigest()[:16]
    files = {kind: GUIDE_DIR / f"{key}-{kind}.png" for kind in ("dark", "light")}
    if not all(f.exists() for f in files.values()):
        GUIDE_DIR.mkdir(parents=True, exist_ok=True)
        seen = {**as_project(project, pl), "guides": files}
        if keep:
            art = projects.mark_artwork(seen)
            left, top, w, h = projects.mark_box(seen)
            art = art.resize((w, h), Image.Resampling.LANCZOS)
            for kind, bg in {"dark": projects.GUIDE_DARK, "light": projects.GUIDE_LIGHT}.items():
                frame = Image.new("RGB", (projects.FRAME_W, projects.FRAME_H), bg)
                frame.paste(art, (left, top), art)
                frame.save(files[kind], "PNG")
        else:
            projects.make_guides(seen)
    return {"files": files, "cache": GUIDE_DIR / f"{key}-urls.json"}
