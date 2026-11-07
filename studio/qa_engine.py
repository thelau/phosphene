#!/usr/bin/env python3
"""
Phosphene's mark check: is the project's mark in a generated 9:16 image, at its place and its size?
The mark is fitted at its own size and at sizes around it (flat either way round, or its outline for an emboss); a mark that fits
sharply at exactly its size passes, one that is missing or clearly another size is trashed, the doubtful are flagged for the user.
"""

import math
from operator import mul
from pathlib import Path
from PIL import Image, ImageFilter

import places

ROOT_DIR = Path(__file__).resolve().parent.parent
PLATES_DIR = places.SUPPORT_DIR / ".no-project" / "plates"     # until a project is open (the server points it at the project's)

TARGET_W = 1080
TARGET_H = 1920


class MarkSpec:
    """What the mark check looks for: the mark as a mask at a given width (`mask(w)`, its height in proportion), the width it
    should have, and its centre in the 1080 x 1920 frame."""

    def __init__(self, mask, width: int, center: tuple, size_pct: float = 18):
        self.mask, self.width, self.center, self.size_pct = mask, width, center, size_pct


_SPECS: dict = {}


def mark_spec(mark_file: Path, size_pct: float, x_pct: float = 50, y_pct: float = 50) -> MarkSpec:
    """A project's mark as the logo check sees it (cached while the file is unchanged)."""
    from projects import mark_alpha
    key = (str(mark_file), Path(mark_file).stat().st_mtime, size_pct, x_pct, y_pct)
    if key not in _SPECS:
        alpha = mark_alpha(Image.open(mark_file))
        ratio = alpha.height / alpha.width
        sized: dict = {}
        def mask(w: int, alpha=alpha, ratio=ratio, sized=sized) -> Image.Image:
            if w not in sized:
                sized[w] = alpha.resize((w, max(1, int(round(w * ratio)))), Image.Resampling.LANCZOS)
            return sized[w]
        _SPECS.clear()
        _SPECS[key] = MarkSpec(mask, int(round(TARGET_W * size_pct / 100)), (int(round(TARGET_W * x_pct / 100)), int(round(TARGET_H * y_pct / 100))), size_pct=size_pct)
    return _SPECS[key]


def _box(center: tuple, m: Image.Image) -> tuple:
    cx, cy = center
    return (cx - m.width // 2, cy - m.height // 2, cx - m.width // 2 + m.width, cy - m.height // 2 + m.height)


def corr_ref(ref_l: Image.Image) -> tuple:
    """A reference made ready once for normalized_corr (its pixels and sums), when it is compared at many places."""
    r = ref_l.tobytes()
    return r, sum(r), sum(map(mul, r, r))


def normalized_corr(patch_l: Image.Image, ref_l) -> float:
    """Computes Pearson correlation coefficient between two grayscale PIL images of identical size (ref_l: an image or corr_ref's)."""
    p = patch_l.tobytes()
    r, sr, srr = ref_l if isinstance(ref_l, tuple) else corr_ref(ref_l)
    n = len(p)
    if n == 0:
        return 0.0
    # whole-number sums made in C (sum / map): the same coefficient as a pixel-by-pixel loop, ~10x faster; a mark half the frame
    # wide, measured at 15 sizes, took ~37 s an image the old way
    sp = sum(p)
    num = sum(map(mul, p, r)) - sp * sr / n
    den_p = sum(map(mul, p, p)) - sp * sp / n
    den_r = srr - sr * sr / n
    if den_p <= 1e-6 or den_r <= 1e-6:
        return 0.0
    return num / math.sqrt(den_p * den_r)


def evaluate_plate_qa(image_path: Path, mark: MarkSpec) -> dict:
    """Checks a 9:16 image for the project's mark (`mark_spec`: its file, size and place)."""
    im = Image.open(image_path).convert("RGB")
    gray = im.resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS).convert("L")
    return _check_project_mark(image_path, im, gray, mark)


# ---- a project's own mark (any shape): how sharply it fits at exactly its size ----
# An overlap check tuned on one round mark was wrong on another mark, seen on Nike's swoosh: a mark drawn too big or too small still
# covers the target with mark-like strokes and passed; an embossed one (cream on cream: only its edges show) failed. What tells them
# apart, on the user's own keep / trash of 22 Nike images: a mark at its size fits SHARPLY at exactly 1.0x (clearly better than at 0.8x
# and 1.2x: +0.07 to +0.24 on every kept one), a mark of another size fits about as well at the sizes around it (+0.04 or less on every
# trashed one). The fit is the flat mark either way round, or its outline against the image's edges (what an emboss or a carving shows),
# a little off its place included.
OWN_CHECK_VERSION = 4       # in the QA cache's keys: a new version measures the images again
# Two outcomes, from the user's own keep / trash of Nike, a triangle, McDonald's and an airline's mark: on simple solid shapes no overlap
# measure tells "right size" from "a bit too big" for sure (a kept triangle and a trashed one scored the same), so only the clearly
# wrong is trashed by itself; the doubtful stays in the selection with a "Check the mark" note (qa_doubt) for the user to judge
OWN_ABSENT = 0.33           # the fit at its size under this: the mark is not there (trashed)
OWN_FIT_MIN = 0.42          # under this: doubtful
OWN_SHARP_MIN = 0.055       # fit at 1.0x minus the mean of 0.8x and 1.2x: under this, doubtful (another size fits as well)
OWN_FAINT = (0.2, 0.15)     # under OWN_ABSENT but a fit of 0.2+ that peaks sharply at its own size (0.15+ over 0.8x and 1.2x): a faint
                            # mark at the right size (a seam in mesh, a blind emboss), doubtful rather than trashed. On the 21 images
                            # trashed with a fit of 0.18-0.33 (2026-10-29): the two the user restored were the sharpest (0.18, 0.16); two
                            # others reach it (0.16, 0.15) and now wait for the user's eye; the rest stay trashed. The version is not
                            # raised: images measured before keep their result (re-measuring Halo's 50% marks takes many minutes)
OWN_AROUND = (0.8, 1.2)
OWN_SCALES = (0.6, 0.7, 0.78, 0.8, 0.85, 0.92, 1.0, 1.08, 1.16, 1.2, 1.25, 1.4, 1.6, 2.0, 2.5)
OWN_CLEAR = 0.04            # a size this much better than its own, 1.4x or more (or 0.7x or less): clearly the wrong size (trashed)
OWN_SHIFT = (-24, -12, 0, 12, 24)


def _outline(m: Image.Image) -> Image.Image:
    return m.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.5))


def _fit(gray: Image.Image, edges: Image.Image, mark: MarkSpec, scale: float) -> tuple[float, str]:
    """How well the mark at this scale matches around its place: the best of the flat mark (either way round) and its outline."""
    m = mark.mask(max(8, int(round(mark.width * scale))))
    o = _outline(m)
    mr, orf = corr_ref(m), corr_ref(o)
    best, how = -1.0, "flat"
    for dx in OWN_SHIFT:
        for dy in OWN_SHIFT:
            c = (mark.center[0] + dx, mark.center[1] + dy)
            flat = abs(normalized_corr(gray.crop(_box(c, m)), mr))
            edge = normalized_corr(edges.crop(_box(c, o)), orf)
            if flat > best:
                best, how = flat, "flat"
            if edge > best:
                best, how = edge, "outline"
    return best, how


def _check_project_mark(image_path: Path, im: Image.Image, gray: Image.Image, mark: MarkSpec) -> dict:
    edges = gray.filter(ImageFilter.GaussianBlur(1)).filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(1.5))
    fit = {sc: _fit(gray, edges, mark, sc) for sc in OWN_SCALES}
    at = fit[1.0][0]
    sharp = at - sum(fit[sc][0] for sc in OWN_AROUND) / len(OWN_AROUND)
    best = max(fit, key=lambda sc: fit[sc][0])
    gain = fit[best][0] - at
    issues, doubt = [], ""
    if at < OWN_ABSENT and at >= OWN_FAINT[0] and sharp >= OWN_FAINT[1]:
        doubt = f"Check the mark: it is faint, but sharpest at its own size (fit {at:.2f})"
    elif at < OWN_ABSENT:
        issues.append(f"The mark is not at its place and size (fit {at:.2f})")
    elif best >= 1.4 and gain > OWN_CLEAR:
        issues.append(f"The mark is too big: it fits best at about {best:g}x its size")
    elif best <= 0.7 and gain > OWN_CLEAR:
        issues.append(f"The mark is too small: it fits best at about {best:g}x its size")
    elif at < OWN_FIT_MIN:
        doubt = f"Check the mark: it is faint or partly there (fit {at:.2f})"
    elif best < 0.88 or best > 1.12:
        doubt = f"Check the mark's size: it fits a little better at about {best:g}x"
    elif sharp < OWN_SHARP_MIN:
        doubt = f"Check the mark's size: it fits about as well a fifth smaller or bigger (sharpness {sharp:.2f})"
    score = max(0, min(100, int(round(min(max(sharp, 0), 0.2) / 0.2 * 60 + min(at, 0.8) / 0.8 * 40)) - (30 if issues else 15 if doubt else 0)))
    return {
        "filename": image_path.name, "width": im.width, "height": im.height,
        "qa_passed": not issues, "qa_doubt": doubt, "qa_score": score,
        "center_corr": round(at, 3), "core_asymmetry": round(sharp, 3), "outer_ring_corr": round(fit[best][0], 3),
        "detected_diam_px": int(round(mark.width * best)), "polarity": fit[1.0][1], "issues": issues,
    }

