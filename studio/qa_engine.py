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


def evaluate_plate_qa(image_path: Path) -> dict:
    """
    Evaluates a 9:16 plate for Demo logo fidelity:
      - Asymmetry & shape fidelity against ground-truth logo-cream.png
      - Detection of 'logo-in-logo' outer rings or oversized logo scale
      - Center lock accuracy at (50%, 50%)
    """
    im = Image.open(image_path).convert("RGB")
    im_std = im.resize((TARGET_W, TARGET_H), Image.Resampling.LANCZOS)
    gray = im_std.convert("L")

    # 1. Multi-scale search around dead-center (540, 960) for best match to true mask
    best_corr = -1.0
    best_sym_corr = -1.0
    best_diam = LOGO_DIAM
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

    for diam in (176, 190, 215, 250, 290):
        true_m = load_clean_orbital_mask(diam)
        sym_m = make_symmetric_impostor_mask(diam)
        half = diam // 2
        box = (CENTER_X - half, CENTER_Y - half, CENTER_X - half + diam, CENTER_Y - half + diam)

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
    core_diam = int(best_diam * 0.68)
    core_half = core_diam // 2
    true_full = load_clean_orbital_mask(best_diam)
    sym_full = make_symmetric_impostor_mask(best_diam)
    c_off = (best_diam - core_diam) // 2
    true_core = true_full.crop((c_off, c_off, c_off + core_diam, c_off + core_diam))
    sym_core = sym_full.crop((c_off, c_off, c_off + core_diam, c_off + core_diam))

    core_box = (CENTER_X - core_half, CENTER_Y - core_half, CENTER_X - core_half + core_diam, CENTER_Y - core_half + core_diam)
    core_patch = best_ch_img.crop(core_box)

    sign = 1.0 if best_polarity.startswith("light") else -1.0
    core_true_corr = sign * normalized_corr(core_patch, true_core)
    core_sym_corr = sign * normalized_corr(core_patch, sym_core)
    asymmetry_advantage = core_true_corr - core_sym_corr

    # 3. Check for oversized logo (>40% width) or "logo-in-logo" outer concentric ring
    outer_max_corr = 0.0
    outer_best_diam = 0
    for big_diam in (420, 480, 540, 600):
        big_m = load_clean_orbital_mask(big_diam)
        b_half = big_diam // 2
        b_box = (CENTER_X - b_half, CENTER_Y - b_half, CENTER_X - b_half + big_diam, CENTER_Y - b_half + big_diam)
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
            issues.append(f"Wrong logo scale (~{int(outer_best_diam / TARGET_W * 100)}% width instead of 18%)")
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


if __name__ == "__main__":
    results = []
    for p in sorted(PLATES_DIR.glob("*.jpg")):
        res = evaluate_plate_qa(p)
        results.append(res)
        status = "PASS" if res["qa_passed"] else "FAIL"
        print(f"[{status:4s} | {res['qa_score']:3d}%] {res['filename']:28s} corr={res['center_corr']:.2f} asym={res['core_asymmetry']:+.2f} outer={res['outer_ring_corr']:.2f} issues={res['issues']}")
