#!/usr/bin/env python3
"""
Demo Match-Cut Studio — Automated Logo QA & Diegetic Vector Lock Engine
Performs strict self-QA on generated 9:16 plates to catch:
  1. Distorted / symmetricized inner orbital curves
  2. "Logo-in-logo" concentric double rings outside the 18% center mark
  3. Wrong logo scale (too large / too small) or off-center drift
"""

import json
import math
import os
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter, ImageOps, ImageStat

ROOT_DIR = Path(__file__).resolve().parent.parent
LOGO_CREAM_PATH = ROOT_DIR / "demo-info" / "design-system" / "logo-cream.png"
PLATES_DIR = ROOT_DIR / "assets" / "ai-plates"

TARGET_W = 1080
TARGET_H = 1920
CENTER_X = 540
CENTER_Y = 960
LOGO_DIAM = 190  # 17.6% of 1080px width


def load_clean_orbital_mask(size: int = LOGO_DIAM) -> Image.Image:
    """
    Loads the authentic Demo circular orbital logo alpha mask,
    removing the small TM mark in top-right (x>405, y<68 on 480x480)
    and cropping tightly to the 438x438 globe centered at (239, 239).
    """
    im = Image.open(LOGO_CREAM_PATH).convert("RGBA")
    alpha = im.split()[3]
    # Mask out TM in top-right
    draw = ImageDraw.Draw(alpha)
    draw.rectangle([405, 0, 480, 68], fill=0)
    # Crop globe bounding box (20, 20, 458, 458) -> 438x438
    globe = alpha.crop((20, 20, 458, 458))
    return globe.resize((size, size), Image.Resampling.LANCZOS)


def make_symmetric_impostor_mask(size: int = LOGO_DIAM) -> Image.Image:
    """
    Creates a symmetricized concentric-ring version of the mask by averaging
    the mask with its 180-degree rotated and mirrored copies.
    If a generated logo correlates higher with this symmetric impostor than with
    the true asymmetric Demo mask, the AI distorted the inner orbital curves.
    """
    true_mask = load_clean_orbital_mask(size)
    rot180 = true_mask.rotate(180)
    flip_h = ImageOps.mirror(true_mask)
    flip_v = ImageOps.flip(true_mask)
    b1 = Image.blend(true_mask, rot180, 0.5)
    b2 = Image.blend(flip_h, flip_v, 0.5)
    return Image.blend(b1, b2, 0.5)


class MarkSpec:
    """What the logo check looks for: the mark as a mask at a given width (`mask(w)`, its height in proportion), the width it
    should have, and its centre in the 1080 x 1920 frame. DEMO is its orbital mask at 190 px, at (540, 960)."""

    def __init__(self, mask, width: int, center: tuple, impostor=None, size_pct: float = 18):
        self.mask, self.width, self.center, self.size_pct = mask, width, center, size_pct
        self.impostor = impostor or (lambda w: _symmetric(mask(w)))


def _symmetric(m: Image.Image) -> Image.Image:
    b1 = Image.blend(m, m.rotate(180), 0.5)
    b2 = Image.blend(ImageOps.mirror(m), ImageOps.flip(m), 0.5)
    return Image.blend(b1, b2, 0.5)


DEMO_MARK = MarkSpec(load_clean_orbital_mask, LOGO_DIAM, (CENTER_X, CENTER_Y), make_symmetric_impostor_mask, 18)
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


def normalized_corr(patch_l: Image.Image, ref_l: Image.Image) -> float:
    """Computes Pearson correlation coefficient between two grayscale PIL images of identical size."""
    p_bytes = patch_l.tobytes()
    r_bytes = ref_l.tobytes()
    n = len(p_bytes)
    if n == 0:
        return 0.0
    mean_p = sum(p_bytes) / n
    mean_r = sum(r_bytes) / n
    num = 0.0
    den_p = 0.0
    den_r = 0.0
    for pv, rv in zip(p_bytes, r_bytes):
        dp = pv - mean_p
        dr = rv - mean_r
        num += dp * dr
        den_p += dp * dp
        den_r += dr * dr
    if den_p <= 1e-6 or den_r <= 1e-6:
        return 0.0
    return num / math.sqrt(den_p * den_r)


def evaluate_plate_qa(image_path: Path, mark: MarkSpec | None = None) -> dict:
    """
    Evaluates a 9:16 plate for the project's mark (DEMO by default: its orbital mask, 190 px at the dead centre):
      - Asymmetry & shape fidelity against ground-truth logo-cream.png
      - Detection of 'logo-in-logo' outer rings or oversized logo scale
      - Center lock accuracy at (50%, 50%)
    """
    im = Image.open(image_path).convert("RGB")
    im_std = im.resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)
    gray = im_std.convert("L")
    if mark is not None and mark is not DEMO_MARK:
        return _check_project_mark(image_path, im, gray, mark)

    # 1. Multi-scale search around dead-center (540, 960) for best match to true mask
    best_corr = -1.0
    best_sym_corr = -1.0
    mark = mark or DEMO_MARK
    W = mark.width
    best_diam = W
    best_polarity = "light_on_dark"

    # Check luminance, RGB channels, color-difference channels, and edge magnitude
    # so logos of ANY color (orange, pink, blue, black, oxblood, cream, chrome, or carved relief) pass QA based on SHAPE.
    r_ch, g_ch, b_ch = im_std.split()
    warm_ch = ImageChops.subtract(r_ch, ImageChops.multiply(b_ch, Image.new("L", im_std.size, 128)))
    cool_ch = ImageChops.subtract(b_ch, ImageChops.multiply(r_ch, Image.new("L", im_std.size, 128)))
    pink_ch = ImageChops.subtract(r_ch, ImageChops.multiply(g_ch, Image.new("L", im_std.size, 128)))
    edge_ch = gray.filter(ImageFilter.FIND_EDGES)

    channels = (
        ("luma", gray),
        ("warm", warm_ch),
        ("cool", cool_ch),
        ("edge", edge_ch),
    )
    best_ch_img = gray

    for diam in [int(round(W * d / LOGO_DIAM)) for d in (176, 190, 215, 250, 290)]:   # a little smaller to half as big again
        true_m = mark.mask(diam)
        sym_m = mark.impostor(diam)
        box = _box(mark.center, true_m)

        for ch_name, ch_img in channels:
            patch = ch_img.crop(box)
            c_pos = normalized_corr(patch, true_m)
            c_neg = -c_pos
            s_pos = normalized_corr(patch, sym_m)
            s_neg = -s_pos

            if c_pos > best_corr:
                best_corr = c_pos
                best_sym_corr = s_pos
                best_diam = diam
                best_polarity = f"light_on_dark ({ch_name})"
                best_ch_img = ch_img
            if c_neg > best_corr:
                best_corr = c_neg
                best_sym_corr = s_neg
                best_diam = diam
                best_polarity = f"dark_on_light ({ch_name})"
                best_ch_img = ch_img

    # 2. Check asymmetry preservation: true Demo mask has a distinct diagonal swoosh
    # Compare correlation inside the inner core (r < 68px) where the asymmetric swoosh lives
    true_full = mark.mask(best_diam)
    sym_full = mark.impostor(best_diam)
    core_w, core_h = int(true_full.width * 0.68), int(true_full.height * 0.68)
    c_x, c_y = (true_full.width - core_w) // 2, (true_full.height - core_h) // 2
    true_core = true_full.crop((c_x, c_y, c_x + core_w, c_y + core_h))
    sym_core = sym_full.crop((c_x, c_y, c_x + core_w, c_y + core_h))

    core_patch = best_ch_img.crop(_box(mark.center, true_core))

    sign = 1.0 if best_polarity.startswith("light") else -1.0
    core_true_corr = sign * normalized_corr(core_patch, true_core)
    core_sym_corr = sign * normalized_corr(core_patch, sym_core)
    asymmetry_advantage = core_true_corr - core_sym_corr

    # 3. Check for oversized logo (>40% width) or "logo-in-logo" outer concentric ring
    outer_max_corr = 0.0
    outer_best_diam = 0
    for big_diam in [int(round(W * d / LOGO_DIAM)) for d in (420, 480, 540, 600)]:
        big_m = mark.mask(big_diam)
        b_box = _box(mark.center, big_m)
        b_patch = gray.crop(b_box)
        b_corr = abs(normalized_corr(b_patch, big_m))
        b_warm_corr = abs(normalized_corr(warm_ch.crop(b_box), big_m))
        m_corr = max(b_corr, b_warm_corr)
        if m_corr > outer_max_corr:
            outer_max_corr = m_corr
            outer_best_diam = big_diam

    issues = []
    # Allow slightly angled 3D perspective logos, CAD wireframes, and nature reliefs
    if best_corr < 0.14:
        if outer_max_corr > 0.38:
            issues.append(f"Wrong logo scale (~{int(outer_best_diam / TARGET_W * 100)}% width instead of {mark.size_pct:g}%)")
        else:
            issues.append(f"Low center logo fidelity (corr={best_corr:.2f})")

    if outer_max_corr > 0.40 and best_corr < 0.22:
        issues.append(f"Oversized outer ring (d={outer_best_diam}px, corr={outer_max_corr:.2f})")

    qa_score = max(0, min(100, int(round(
        (min(best_corr, 0.70) / 0.70) * 80
        + 20
        - (40 if issues else 0)
    ))))

    passed = len(issues) == 0 and qa_score >= 55

    return {
        "filename": image_path.name,
        "width": im.width,
        "height": im.height,
        "qa_passed": passed,
        "qa_score": qa_score,
        "center_corr": round(best_corr, 3),
        "core_asymmetry": round(asymmetry_advantage, 3),
        "outer_ring_corr": round(outer_max_corr, 3),
        "detected_diam_px": best_diam,
        "polarity": best_polarity,
        "issues": issues,
    }


# ---- a project's own mark (any shape): fitted at its size and at other sizes, as a flat mark and by its outline ----
# What the DEMO check (tuned on its orbital mark) missed on another mark, seen on Nike's swoosh: a mark drawn twice too big still covers
# the target with mark-like strokes and passed; an embossed one (cream on cream: only its edges show) failed. So the fit is measured
# at 0.85-1.15x its size and at 1.45-2.6x: a mark that fits better bigger is too big; and by its outline too (edges against the mark's
# edges), which is what an emboss, a deboss or a carving shows.
OWN_CHECK_VERSION = 2       # in the QA cache's keys: a new version measures the images again
OWN_FIT_MIN = 0.42          # the best fit at its size, a little off its place included: under this, the mark is not there
OWN_SIZES = (0.85, 0.93, 1.0, 1.08, 1.15)
OWN_BIG = (1.45, 1.8, 2.2, 2.6)
OWN_SHIFT = (-24, -12, 0, 12, 24)


def _outline(m: Image.Image) -> Image.Image:
    return m.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.5))


def _fit(gray: Image.Image, edges: Image.Image, mark: MarkSpec, scale: float) -> tuple[float, str]:
    """How well the mark at this scale matches around its place: the best of the flat mark (either way round) and its outline."""
    m = mark.mask(max(8, int(round(mark.width * scale))))
    o = _outline(m)
    best, how = -1.0, "flat"
    for dx in OWN_SHIFT:
        for dy in OWN_SHIFT:
            c = (mark.center[0] + dx, mark.center[1] + dy)
            flat = abs(normalized_corr(gray.crop(_box(c, m)), m))
            edge = normalized_corr(edges.crop(_box(c, o)), o)
            if flat > best:
                best, how = flat, "flat"
            if edge > best:
                best, how = edge, "outline"
    return best, how


def _check_project_mark(image_path: Path, im: Image.Image, gray: Image.Image, mark: MarkSpec) -> dict:
    edges = gray.filter(ImageFilter.GaussianBlur(1)).filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(1.5))
    right = max((_fit(gray, edges, mark, s) + (s,) for s in OWN_SIZES), key=lambda t: t[0])
    big = max((_fit(gray, edges, mark, s) + (s,) for s in OWN_BIG), key=lambda t: t[0])
    issues = []
    if big[0] > right[0]:
        issues.append(f"The mark is too big (it fits best at about {big[2]:g}x its size)")
    elif right[0] < OWN_FIT_MIN:
        issues.append(f"The mark is not clearly at its place and size (fit {right[0]:.2f})")
    score = max(0, min(100, int(round(min(right[0], 0.8) / 0.8 * 100)) - (40 if issues else 0)))
    return {
        "filename": image_path.name, "width": im.width, "height": im.height,
        "qa_passed": not issues, "qa_score": score,
        "center_corr": round(right[0], 3), "core_asymmetry": 0.0, "outer_ring_corr": round(big[0], 3),
        "detected_diam_px": int(round(mark.width * (big[2] if big[0] > right[0] else right[2]))),
        "polarity": right[1], "issues": issues,
    }


if __name__ == "__main__":
    results = []
    for p in sorted(PLATES_DIR.glob("*.jpg")):
        res = evaluate_plate_qa(p)
        results.append(res)
        status = "PASS" if res["qa_passed"] else "FAIL"
        print(f"[{status:4s} | {res['qa_score']:3d}%] {res['filename']:28s} corr={res['center_corr']:.2f} asym={res['core_asymmetry']:+.2f} outer={res['outer_ring_corr']:.2f} issues={res['issues']}")
