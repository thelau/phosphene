"""
Which image is on screen at which moment, and how it is treated: shared by the export and mirrored by the page's preview
(studio/web/src/app.js: planAt / zoomScale). Measured from the references:
  - soiltone-inspo.mp4: every scene is followed by an inverted, greyscale copy of itself, same hold (2-3 frames at 30fps);
    inverted frames match invert(frame) almost exactly (mse < 1).
  - Moverunion clip: each ~5-frame cut slowly zooms OUT about the centre, only ~0.15-0.45% over the cut.
"""

import bisect
import math

from PIL import Image, ImageChops, ImageOps

INVERT_MODES = ("off", "mono", "colour")
ZOOM_MODES = ("off", "out", "in")


def timeline(n_plates: int, invert_mode: str = "off") -> list[float]:
    """Flat: where each cut starts (in base cuts) for one pass over every image."""
    return [float(i) for i in range(n_plates * (2 if invert_mode in ("mono", "colour") else 1) + 1)]


VARIABLE_MS = (50.0, 1500.0)     # the shortest and longest cut a variable run may use
VARIABLE_RAMP = (2, 200)         # how many cuts the change may take
FPS = 30


def variable_timeline(n_cuts: int, start_ms: float, end_ms: float, ramp: int = 12, at: str = "end") -> list[float]:
    """Variable speed as in the references (Ecwora, Soiltone: the cuts hold one speed, then ease into another over their last ~12 cuts).
    Where each cut starts, in frames (use it with frames_per_cut = 1). at="end": the first cuts are start_ms long, then the change
    runs over the last `ramp` cuts and the last one is end_ms. at="start": the first cut is start_ms, the change runs over the first
    `ramp` cuts, and the rest hold end_ms. The change is geometric (each cut a constant ratio of the one before), which is how the
    references slow down. ramp longer than the run = the change takes the whole run; start == end is a flat run."""
    lo, hi = VARIABLE_MS
    a, b = (min(hi, max(lo, float(v))) for v in (start_ms, end_ms))
    n_ramp = max(1, min(n_cuts, int(min(VARIABLE_RAMP[1], max(VARIABLE_RAMP[0], int(ramp))))))
    starts = [0.0]
    for i in range(n_cuts):
        if at == "start":
            u = min(1.0, i / (n_ramp - 1)) if n_ramp > 1 else 1.0     # the first cut is start_ms, the n_ramp-th is end_ms
        else:
            j = i - (n_cuts - n_ramp)                 # 0.. along the ramp at the end
            u = 0.0 if j < 0 else (j + 1) / n_ramp    # the last cut is end_ms
        ms = math.exp(math.log(a) + (math.log(b) - math.log(a)) * u)
        starts.append(starts[-1] + max(1.0, ms * FPS / 1000.0))
    return starts


def flat_base(n_base: int, bpm: float) -> list[float]:
    """The beat grid in frames: one base cut per beat."""
    beat = 60.0 * FPS / max(1.0, float(bpm))
    return [i * beat for i in range(n_base + 1)]


def subdivide(base: list[float], multiple: float, n_cuts: int) -> list[float]:
    """The picture's cut starts (frames) from a base timeline (a beat grid, or a variable run): `multiple` cuts per base cut (0.5 = one
    cut every two base cuts), each at position k / multiple along the base cuts, linear inside one. A cut is never shorter than a frame."""
    m = max(0.05, float(multiple))
    n_base = len(base) - 1
    out = []
    for k in range(n_cuts + 1):
        x = min(k / m, float(n_base))
        i = min(int(x), n_base - 1)
        v = base[i] + (base[i + 1] - base[i]) * (x - i) if n_base >= 1 else 0.0
        out.append(v if not out else max(v, out[-1] + 1.0))
    return out


def rhythm_timeline(n_cuts: int, bpm: float, multiple: float, variable: tuple | None = None) -> tuple[list[float], list[float]]:
    """(picture cut starts, base starts) in frames for n_cuts picture cuts. The base is what the music follows: the beat grid at `bpm`, or
    the variable run (start_ms, end_ms, ramp, at); the picture cuts at `multiple` per base cut, and only the picture feels the multiple."""
    m = max(0.05, float(multiple))
    n_base = max(1, math.ceil(n_cuts / m - 1e-9))
    base = variable_timeline(n_base, *variable) if variable else flat_base(n_base, bpm)
    return subdivide(base, m, n_cuts), base


def cut_at(starts: list[float], t: float) -> tuple[int, float]:
    """(cut index, progress 0..1 inside it) at position t; t wraps around the sequence."""
    total = starts[-1]
    t = t % total if total > 0 else 0.0
    i = min(max(bisect.bisect_right(starts, t) - 1, 0), len(starts) - 2)
    span = starts[i + 1] - starts[i]
    return i, (t - starts[i]) / span if span > 0 else 0.0


def frame_plan(frame: int, frames_per_cut: float, n_plates: int, invert_mode: str = "off", starts: list | None = None) -> dict:
    """What frame number `frame` shows. With invert on, every plate takes two cuts: normal, then inverted."""
    cut_pos = (frame + 0.5) / frames_per_cut
    return plan_at(cut_pos, n_plates, invert_mode, starts)


def plan_at(cut_pos: float, n_plates: int, invert_mode: str = "off", starts: list | None = None) -> dict:
    if starts:  # cuts of different lengths
        cut, p = cut_at(starts, cut_pos)
    else:
        cut = int(cut_pos // 1)
        p = cut_pos - cut
    paired = invert_mode in ("mono", "colour")
    plate = (cut // 2 if paired else cut) % n_plates
    return {"cut": cut, "p": p, "plate": plate, "inverted": paired and cut % 2 == 1}


def zoom_scale(mode: str, amount_pct: float, p: float) -> float:
    """Scale about the centre (>= 1, so the frame stays covered). out: starts large and settles; in: the reverse.
    p is the progress through the cut; with invert on, the inverted copy is a cut of its own and zooms again (kept on purpose)."""
    a = amount_pct / 100.0
    if mode == "out":
        return 1 + a * (1 - p)
    if mode == "in":
        return 1 + a * p
    return 1.0


TRAIL_FRAMES = 4          # how long the previous image lingers after a cut
TRAIL_MAX = 0.6

# Chord colour: with the chord changes on, each chord brings a brand colour (the home chord none), switching on the cut where the chord
# changes. Two looks, both exact formulas so the page matches the export:
# - Invert off, the grade: the darks lift to a deep shade of the colour, highlights and the logo untouched. out = max(picture, GRADE[colour])
#   per channel (the page: an overlay of that shade, mix-blend-mode lighten).
# - Invert on, the twin: the inverted copy becomes a duotone, the chord's colour in its lights and oxblood or ink in its darks; the original
#   stays as it is, the home chord's twin the plain inverted copy. out = colour + (shadow - colour) * L, L the original's luma (601), so the
#   twin's lights are the original's darks (the page: an SVG filter per colour, #duo-xxxxxx in index.html, the same numbers).
CHORD_TINTS = {-2: "#5D8FF4", 5: "#5D8FF4", -4: "#EC540C", 3: "#EC540C", -5: "#F64570"}
GRADE = {"#5D8FF4": "#253962", "#EC540C": "#5E2205", "#F64570": "#621C2D"}      # each colour at 40%
DUO_SHADOW = {"#5D8FF4": "#1A1A1A", "#EC540C": "#381313", "#F64570": "#381313"}  # blue over ink, the warm ones over oxblood


def graded(img, colour: str):
    """Invert off: the picture with its darks lifted to the chord's shade."""
    return ImageChops.lighter(img, Image.new("RGB", img.size, GRADE[colour]))


def duotone(img, colour: str):
    """Invert on: the inverted twin in the chord's colour (from the original, not the inverted copy: the same picture)."""
    return ImageOps.colorize(img.convert("L"), black=colour, white=DUO_SHADOW[colour])


def clean_tints(value) -> list:
    """[[start second, "#rrggbb" or None], ...] from the page, checked: numbers in order, known colours only, at most 4000."""
    out = []
    if not isinstance(value, list):
        return out
    known = set(CHORD_TINTS.values())
    for item in value[:4000]:
        try:
            t, c = float(item[0]), item[1]
        except (TypeError, ValueError, IndexError):
            continue
        if math.isfinite(t) and (c is None or c in known) and (not out or t >= out[-1][0]):
            out.append([t, c])
    return out


def tint_at(tints: list, t: float):
    """The colour at clip second t from [[start second, colour or None], ...] in order."""
    colour = None
    for start, c in tints or []:
        if start <= t + 1e-9:
            colour = c
        else:
            break
    return colour


def trail_alpha(frames_since_cut: float, amount: float) -> float:
    """Trail: after a cut the previous image lingers on top, fading out over TRAIL_FRAMES frames (whole frames, as in the export).
    amount 0..0.6 is its opacity on the first frame of the cut; 0 = off. Mirrored by trailAlpha in the page (shared vectors)."""
    a = max(0.0, min(TRAIL_MAX, float(amount or 0)))
    k = int(frames_since_cut // 1)
    if a <= 0 or k < 0 or k >= TRAIL_FRAMES:
        return 0.0
    return a * (1 - k / TRAIL_FRAMES)


def cut_plate(cut: int, n_plates: int, invert_mode: str = "off") -> tuple[int, bool]:
    """Which plate, and whether inverted, a given cut shows."""
    paired = invert_mode in ("mono", "colour")
    return ((cut // 2 if paired else cut) % n_plates, paired and cut % 2 == 1)


def zoomed(img: Image.Image, scale: float) -> Image.Image:
    """Crop the centre 1/scale of the image and scale it back up to full size (one resample)."""
    if scale <= 1.0005:
        return img
    w, h = img.size
    cw, ch = w / scale, h / scale
    return img.resize((w, h), Image.Resampling.BILINEAR, box=((w - cw) / 2, (h - ch) / 2, (w + cw) / 2, (h + ch) / 2))


def inverted(img: Image.Image, invert_mode: str) -> Image.Image:
    base = img.convert("L").convert("RGB") if invert_mode == "mono" else img
    return ImageOps.invert(base)


def export_length(n_plates: int, frames_per_cut: float, invert_mode: str = "off", starts: list | None = None) -> tuple[int, int]:
    """(number of cuts, number of frames) so every image is shown once; with invert on each image takes two cuts."""
    n_cuts = n_plates * (2 if invert_mode in ("mono", "colour") else 1)
    total = starts[-1] if starts else n_cuts
    return n_cuts, max(n_cuts, int(total * frames_per_cut))
