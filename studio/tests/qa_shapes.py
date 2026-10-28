"""
Invented marks and scenes for the logo check's regression set (no brand, no network, nothing stored: everything is drawn here).

Marks, in three families: letters (a letter, a monogram, a wordmark), geometric (ring, holed triangle, star, chevron, notched
square), complex (interlocking rings, a flower, a dot grid with one dot missing). Each is drawn black on transparent, as a user's
mark.png, and has a size and place, as a project does.

Scenes: the mark drawn into a 1080 x 1920 image the way a generated image can show it, each with what the check must say:
  never trashed   flat, light on dark, embossed (only its edges), faint ink on texture, a little off its place, and the hard ones
                  the user kept in real images: dark on dark (a steel plate), lit from one side, a busy texture, a shadow across
                  it, shading inside it
  trashed         much too small (0.6x), much too big (1.8x), moved away, missing
  flagged         a little small or big (0.8x, 1.25x), another shape in its place: trashed or noted, never a clean pass
"""

import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = Path(__file__).resolve().parents[1] / "web" / "src" / "fonts" / "schibsted-grotesk.woff2"
S = 600                                         # marks are drawn at this size, then trimmed


def _canvas(w=S, h=S):
    return Image.new("L", (w, h), 0)


def _text(txt: str, weight: str = "Black") -> Image.Image:
    f = ImageFont.truetype(str(FONT), 400)
    f.set_variation_by_name(weight)
    l, t, r, b = f.getbbox(txt)
    m = _canvas(r - l + 40, b - t + 40)
    ImageDraw.Draw(m).text((20 - l, 20 - t), txt, font=f, fill=255)
    return m


def ring():
    m = _canvas(); d = ImageDraw.Draw(m)
    d.ellipse((0, 0, S - 1, S - 1), fill=255); d.ellipse((170, 170, S - 171, S - 171), fill=0)
    return m


def holed_triangle():
    m = _canvas(S, 520); d = ImageDraw.Draw(m)
    d.polygon([(S / 2, 0), (S, 520), (0, 520)], fill=255)
    d.polygon([(S / 2, 250), (390, 430), (210, 430)], fill=0)
    return m


def star():
    import math
    m = _canvas(); pts = []
    for i in range(10):
        r = 300 if i % 2 == 0 else 125
        a = -math.pi / 2 + i * math.pi / 5
        pts.append((300 + r * math.cos(a), 300 + r * math.sin(a)))
    ImageDraw.Draw(m).polygon(pts, fill=255)
    return m


def chevron():
    m = _canvas(S, 360)
    ImageDraw.Draw(m).polygon([(0, 0), (150, 0), (300, 200), (450, 0), (600, 0), (300, 360)], fill=255)
    return m


def notched_square():
    m = _canvas(); d = ImageDraw.Draw(m)
    d.rectangle((0, 0, S - 1, S - 1), fill=255); d.rectangle((330, 0, S, 270), fill=0)
    return m


def three_rings():
    m = _canvas(S, 300); d = ImageDraw.Draw(m)
    for x in (0, 150, 300):
        d.ellipse((x, 0, x + 300, 300), outline=255, width=46)
    return m


def flower():
    import math
    m = _canvas(); d = ImageDraw.Draw(m)
    for i in range(6):
        a = i * math.pi / 3
        cx, cy = 300 + 165 * math.cos(a), 300 + 165 * math.sin(a)
        d.ellipse((cx - 120, cy - 120, cx + 120, cy + 120), fill=255)
    d.ellipse((235, 235, 365, 365), fill=0)
    return m


def dot_grid():
    m = _canvas(); d = ImageDraw.Draw(m)
    for i in range(3):
        for j in range(3):
            if (i, j) != (2, 0):
                d.ellipse((i * 210, j * 210, i * 210 + 180, j * 210 + 180), fill=255)
    return m


def letter():
    return _text("R")


def monogram():
    return _text("AK")


def wordmark():
    return _text("VOLT", "Bold")


# name -> (draw, size % of the width, across %, down %): sizes from small to half the frame, one mark off the centre
MARKS = {
    "letter": (letter, 22, 50, 50),
    "monogram": (monogram, 30, 50, 50),
    "wordmark": (wordmark, 40, 50, 50),
    "ring": (ring, 30, 50, 50),
    "holed_triangle": (holed_triangle, 35, 50, 50),
    "star": (star, 22, 50, 50),
    "chevron": (chevron, 26, 50, 42),
    "notched_square": (notched_square, 20, 50, 50),
    "three_rings": (three_rings, 45, 50, 50),
    "flower": (flower, 26, 50, 50),
    "dot_grid": (dot_grid, 24, 50, 50),
}

# scene -> what the check must say: "keep" (never trashed), "trash", "flag" (trashed or noted)
SCENES = {
    "flat": "keep", "light_on_dark": "keep", "embossed": "keep", "faint_on_texture": "keep", "off_a_little": "keep",
    "dark_on_dark": "keep", "lit_from_one_side": "keep", "busy_texture": "keep", "shadow_across": "keep", "shaded_material": "keep",
    "small_0.8": "flag", "big_1.25": "flag", "other_shape": "flag",
    "small_0.6": "trash", "big_1.8": "trash", "moved_away": "trash", "missing": "trash",
}


def write_mark(name: str, folder: Path) -> Path:
    """The mark as a user's mark.png: black on transparent, trimmed."""
    m = MARKS[name][0]()
    m = m.crop(m.getbbox())
    rgba = Image.new("RGBA", m.size, (12, 12, 12, 0))
    rgba.putalpha(m)
    path = folder / f"{name}.png"
    rgba.save(path)
    return path


def _texture(seed: int, base: tuple, amount: int = 28) -> Image.Image:
    rnd = random.Random(seed)
    small = Image.new("RGB", (108, 192))
    small.putdata([tuple(max(0, min(255, c + rnd.randint(-amount, amount))) for c in base) for _ in range(108 * 192)])
    return small.resize((1080, 1920), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(3))


def write_scene(spec, scene: str, path: Path, seed: int = 0) -> Path:
    """spec: qa_engine.mark_spec of the mark. Draws the scene and saves it as a generated image would be (JPEG)."""
    scale = {"small_0.8": 0.8, "big_1.25": 1.25, "small_0.6": 0.6, "big_1.8": 1.8}.get(scene, 1.0)
    m = spec.mask(max(8, int(round(spec.width * scale))))
    cx, cy = spec.center
    if scene == "off_a_little":
        cx, cy = cx + 10, cy - 8
    if scene == "moved_away":
        cy += 520
    at = (cx - m.width // 2, cy - m.height // 2)
    paper = (228, 222, 210)
    if scene == "light_on_dark":
        im = Image.new("RGB", (1080, 1920), (24, 24, 30))
        im.paste(Image.new("RGB", m.size, (240, 236, 225)), at, m)
    elif scene == "embossed":                    # the paper's own colour: a light edge and a dark one show
        im = Image.new("RGB", (1080, 1920), paper)
        edge = m.filter(ImageFilter.FIND_EDGES)
        im.paste(Image.new("RGB", m.size, (250, 246, 236)), (at[0] - 2, at[1] - 2), edge)
        im.paste(Image.new("RGB", m.size, (175, 168, 155)), (at[0] + 2, at[1] + 2), edge)
    elif scene == "dark_on_dark":               # a dark mark on a dark plate: only a few levels apart, under grain
        im = _texture(seed, (34, 33, 36), 14)
        im.paste(Image.new("RGB", m.size, (16, 15, 17)), at, m)
    elif scene == "lit_from_one_side":          # a hard light falling off across the frame, the mark in mid ink
        ramp = Image.linear_gradient("L").rotate(90, expand=True).resize((1080, 1920))
        im = Image.merge("RGB", [ramp.point(lambda v: 40 + v * 0.8)] * 3)
        im.paste(Image.new("RGB", m.size, (70, 66, 60)), at, m.point(lambda v: v * 0.8))
    elif scene == "busy_texture":
        im = _texture(seed, (150, 140, 128), 70)
        im.paste(Image.new("RGB", m.size, (30, 28, 26)), at, m)
    elif scene == "shadow_across":              # a band of shadow over a third of the mark
        im = Image.new("RGB", (1080, 1920), paper)
        im.paste(Image.new("RGB", m.size, (26, 24, 22)), at, m)
        band = Image.new("L", (1080, 1920), 0)
        ImageDraw.Draw(band).polygon([(0, cy - 40), (1080, cy - 140), (1080, cy - 140 + m.height // 3), (0, cy - 40 + m.height // 3)], fill=150)
        im.paste(Image.new("RGB", (1080, 1920), (60, 56, 52)), (0, 0), band.filter(ImageFilter.GaussianBlur(12)))
    elif scene == "shaded_material":            # a cast object: light on one edge, dark on the other, a highlight
        im = Image.new("RGB", (1080, 1920), (190, 184, 172))
        shade = Image.linear_gradient("L").resize(m.size).point(lambda v: 40 + v * 0.55)
        im.paste(Image.merge("RGB", [shade] * 3), at, m)
        hl = m.filter(ImageFilter.FIND_EDGES).filter(ImageFilter.GaussianBlur(2))
        im.paste(Image.new("RGB", m.size, (235, 230, 220)), (at[0] - 3, at[1] - 3), hl)
    elif scene == "other_shape":                # a plain disc of the mark's size where the mark should be
        im = Image.new("RGB", (1080, 1920), paper)
        disc = Image.new("L", m.size, 0)
        r = min(m.size) // 2
        ImageDraw.Draw(disc).ellipse((m.width // 2 - r, m.height // 2 - r, m.width // 2 + r, m.height // 2 + r), fill=255)
        im.paste(Image.new("RGB", m.size, (26, 24, 22)), at, disc)
    elif scene == "faint_on_texture":
        im = _texture(seed, (120, 110, 100))
        im.paste(Image.new("RGB", m.size, (60, 52, 46)), at, m.point(lambda v: v * 0.75))
    else:
        im = _texture(seed, paper) if scene == "missing" else Image.new("RGB", (1080, 1920), paper)
        if scene != "missing":
            im.paste(Image.new("RGB", m.size, (26, 24, 22)), at, m)
    im.save(path, "JPEG", quality=92)
    return path
