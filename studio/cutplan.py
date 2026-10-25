"""
Which image is on screen at which moment, and how it is treated: shared by the export and mirrored by the page's preview
(studio/web/src/app.js: planAt / zoomScale). Measured from the references:
  - soiltone-inspo.mp4: every scene is followed by an inverted, greyscale copy of itself, same hold (2-3 frames at 30fps);
    inverted frames match invert(frame) almost exactly (mse < 1).
  - Moverunion clip: each ~5-frame cut slowly zooms OUT about the centre, only ~0.15-0.45% over the cut.
"""

from PIL import Image, ImageOps

INVERT_MODES = ("off", "mono", "colour")
ZOOM_MODES = ("off", "out", "in")


def frame_plan(frame: int, frames_per_cut: float, n_plates: int, invert_mode: str = "off") -> dict:
    """What frame number `frame` shows. With invert on, every plate takes two cuts: normal, then inverted."""
    cut_pos = (frame + 0.5) / frames_per_cut
    return plan_at(cut_pos, n_plates, invert_mode)


def plan_at(cut_pos: float, n_plates: int, invert_mode: str = "off") -> dict:
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


def export_length(n_plates: int, frames_per_cut: float, invert_mode: str = "off") -> tuple[int, int]:
    """(number of cuts, number of frames) so every image is shown once; with invert on each image takes two cuts."""
    n_cuts = n_plates * (2 if invert_mode in ("mono", "colour") else 1)
    return n_cuts, max(n_cuts, int(n_cuts * frames_per_cut))
