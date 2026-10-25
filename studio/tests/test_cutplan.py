import io

import pytest
from PIL import Image

import cutplan
import server

# Shared with tests/js/ui.test.cjs: the page's preview must give the same answers.
PLAN_VECTORS = [
    # cutPos, n, invert, -> cut, plate, inverted
    (0.0, 3, "off", 0, 0, False),
    (1.2, 3, "off", 1, 1, False),
    (3.9, 3, "off", 3, 0, False),
    (0.0, 3, "mono", 0, 0, False),
    (1.0, 3, "mono", 1, 0, True),
    (2.5, 3, "colour", 2, 1, False),
    (3.5, 3, "colour", 3, 1, True),
    (6.0, 3, "mono", 6, 0, False),            # 3 plates x 2 cuts = wraps after 6 cuts
]
ZOOM_VECTORS = [
    # mode, amount%, zoom progress, -> scale
    ("off", 5, 0.5, 1.0),
    ("out", 1, 0.0, 1.01),
    ("out", 1, 1.0, 1.0),
    ("in", 1, 0.0, 1.0),
    ("in", 1, 1.0, 1.01),
    ("out", 0.6, 0.5, 1.003),
]


@pytest.mark.parametrize("pos,n,inv,cut,plate,flipped", PLAN_VECTORS)
def test_plan_at(pos, n, inv, cut, plate, flipped):
    r = cutplan.plan_at(pos, n, inv)
    assert (r["cut"], r["plate"], r["inverted"]) == (cut, plate, flipped)
    assert 0 <= r["p"] < 1


@pytest.mark.parametrize("mode,amt,zp,expected", ZOOM_VECTORS)
def test_zoom_scale(mode, amt, zp, expected):
    assert cutplan.zoom_scale(mode, amt, zp) == pytest.approx(expected)


def test_zoom_restarts_on_the_inverted_copy():
    """Chosen on purpose (continuous zoom across the pair was tried and rejected)."""
    a = cutplan.plan_at(0.9999, 3, "colour")
    b = cutplan.plan_at(1.0, 3, "colour")
    assert a["inverted"] is False and b["inverted"] is True
    assert cutplan.zoom_scale("out", 2, b["p"]) > cutplan.zoom_scale("out", 2, a["p"])


def test_frame_plan_uses_frame_centres():
    # 7.5 frames per cut: frame 7 is still cut 0 (7.5/7.5 = 1.0 -> cut 1 starts at the 8th frame)
    assert cutplan.frame_plan(6, 7.5, 3)["cut"] == 0
    assert cutplan.frame_plan(7, 7.5, 3)["cut"] == 1
    assert cutplan.frame_plan(7, 7.5, 3)["plate"] == 1


def test_every_zoom_scale_keeps_the_frame_covered():
    for mode in cutplan.ZOOM_MODES:
        for i in range(11):
            assert cutplan.zoom_scale(mode, 6, i / 10) >= 1.0


def test_zoomed_crops_the_centre_and_keeps_size():
    im = Image.new("RGB", (100, 200), (0, 0, 255))
    im.paste((255, 0, 0), (40, 90, 60, 110))          # red centre square
    out = cutplan.zoomed(im, 2.0)
    assert out.size == im.size
    assert out.getpixel((50, 100)) == (255, 0, 0)
    assert out.getpixel((33, 100)) == (255, 0, 0)     # the red square now covers 2x the area
    assert out.getpixel((5, 5)) == (0, 0, 255)
    assert cutplan.zoomed(im, 1.0) is im


def test_inverted_modes():
    im = Image.new("RGB", (4, 4), (200, 50, 10))
    colour = cutplan.inverted(im, "colour").getpixel((0, 0))
    assert colour == (55, 205, 245)
    r, g, b = cutplan.inverted(im, "mono").getpixel((0, 0))
    assert r == g == b                                # greyscale first, then inverted


def test_inverted_is_an_involution_for_colour():
    im = Image.new("RGB", (4, 4), (12, 99, 180))
    assert cutplan.inverted(cutplan.inverted(im, "colour"), "colour").getpixel((1, 1)) == (12, 99, 180)


# ---------- export frames ----------

@pytest.fixture
def three_plates(tmp_path):
    files = []
    for i, c in enumerate([(250, 20, 20), (20, 250, 20), (20, 20, 250)]):
        p = tmp_path / f"p{i}.jpg"
        Image.new("RGB", (54, 96), c).save(p, "JPEG", quality=100)
        files.append(p)
    return files


def frame(tmp, i):
    return Image.open(tmp / f"f_{i:04d}.jpg").convert("RGB").resize((1, 1)).getpixel((0, 0))


def test_export_frames_plain_cuts(srv, three_plates, tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "TARGET_W", 54)
    monkeypatch.setattr(srv, "TARGET_H", 96)
    out = tmp_path / "frames"
    out.mkdir()
    assert srv.write_export_frames(three_plates, out, 12, 4.0) == 12
    assert len(list(out.glob("f_*.jpg"))) == 12
    assert frame(out, 0)[0] > 200 and frame(out, 4)[1] > 200 and frame(out, 8)[2] > 200 and frame(out, 12 - 1)[2] > 200


def test_export_frames_with_invert_alternates_plate_and_negative(srv, three_plates, tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "TARGET_W", 54)
    monkeypatch.setattr(srv, "TARGET_H", 96)
    out = tmp_path / "frames"
    out.mkdir()
    srv.write_export_frames(three_plates, out, 16, 4.0, invert_mode="colour")
    r0, r1, r2 = frame(out, 0), frame(out, 4), frame(out, 8)
    assert r0[0] > 200 and r0[1] < 60                    # plate 0 red
    assert r1[0] < 60 and r1[1] > 200                    # its negative (cyan)
    assert r2[1] > 200 and r2[0] < 60                    # plate 1 green
    mono = tmp_path / "mono"
    mono.mkdir()
    srv.write_export_frames(three_plates, mono, 16, 4.0, invert_mode="mono")
    r, g, b = frame(mono, 4)
    assert abs(r - g) < 12 and abs(g - b) < 12           # grey negative


def test_export_frames_zoom_changes_every_frame_and_keeps_size(srv, tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "TARGET_W", 100)
    monkeypatch.setattr(srv, "TARGET_H", 200)
    p = tmp_path / "a.jpg"
    im = Image.new("RGB", (100, 200), (0, 0, 255))
    im.paste((255, 255, 255), (40, 80, 60, 120))
    im.save(p, "JPEG", quality=100)
    out = tmp_path / "frames"
    out.mkdir()
    srv.write_export_frames([p], out, 8, 8.0, zoom_mode="in", zoom_amount=40.0)
    sizes = {Image.open(out / f"f_{i:04d}.jpg").size for i in range(8)}
    assert sizes == {(100, 200)}
    def white_count(i):
        return sum(1 for px in Image.open(out / f"f_{i:04d}.jpg").convert("L").tobytes() if px > 200)
    counts = [white_count(i) for i in range(8)]
    assert counts[-1] > counts[0] * 1.3                  # the white square grows as we zoom in
    assert counts == sorted(counts)


# ---------- export length: every selected image, no fixed duration ----------

@pytest.mark.parametrize("n,fpc,inv,cuts,frames", [
    (10, 7.5, "off", 10, 75),
    (10, 7.5, "mono", 20, 150),                 # each image takes two cuts when inverted copies are on
    (116, 3.0, "colour", 232, 696),
    (1, 1.0, "off", 1, 1),
    (3, 0.5, "off", 3, 3),                      # never fewer frames than cuts
])
def test_export_length_covers_every_image(n, fpc, inv, cuts, frames):
    assert cutplan.export_length(n, fpc, inv) == (cuts, frames)


def test_every_image_appears_in_the_export_plan():
    n, fpc = 7, 4.5
    cuts, frames = cutplan.export_length(n, fpc, "off")
    shown = {cutplan.frame_plan(f, fpc, n, "off")["plate"] for f in range(frames)}
    assert shown == set(range(n))
    shown_inv = {(cutplan.frame_plan(f, fpc, n, "mono")["plate"], cutplan.frame_plan(f, fpc, n, "mono")["inverted"])
                 for f in range(cutplan.export_length(n, fpc, "mono")[1])}
    assert shown_inv == {(i, flag) for i in range(n) for flag in (False, True)}


def test_export_does_not_loop_back_to_the_first_image():
    n, fpc = 5, 7.5
    _, frames = cutplan.export_length(n, fpc, "off")
    plates = [cutplan.frame_plan(f, fpc, n, "off")["plate"] for f in range(frames)]
    assert plates[-1] == n - 1 and plates == sorted(plates)


def test_cut_at_finds_the_cut_and_wraps_around():
    starts = [0.0, 1.0, 3.0, 4.0]
    assert cutplan.cut_at(starts, 0.5) == (0, 0.5)
    assert cutplan.cut_at(starts, 2.0) == (1, 0.5)
    assert cutplan.cut_at(starts, 4.5) == (0, 0.5)                              # past the end: round again
    assert cutplan.plan_at(2.0, 3, "off", starts)["plate"] == 1
