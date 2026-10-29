"""Where each image's mark goes: On target (the project's place) or Loose (its own place and size, kept with the image)."""

import random

from PIL import Image

import placement
import projects


def demo(srv):
    return srv.PROJECT


def test_on_target_has_no_placement(srv):
    assert placement.choose("exact", demo(srv)) is None
    assert placement.as_project(demo(srv), None) is demo(srv)


def test_loose_places_stay_inside_the_frame_and_vary(srv):
    p, rng = demo(srv), random.Random(7)
    ratio = placement._ratio(p)
    got = [placement.choose("loose", p, rng) for _ in range(300)]
    for pl in got:
        assert pl["kind"] == "loose"
        assert p["mark_size"] * 0.6 - 0.1 <= pl["size"] <= p["mark_size"] * 1.6 + 0.1
        h = pl["size"] * ratio * 1080 / 1920
        assert pl["x"] - pl["size"] / 2 >= placement.MARGIN - 0.1 and pl["x"] + pl["size"] / 2 <= 100 - placement.MARGIN + 0.1
        assert pl["y"] - h / 2 >= placement.MARGIN - 0.1 and pl["y"] + h / 2 <= 100 - placement.MARGIN + 0.1
    xs, ys, sizes = ([pl[k] for pl in got] for k in ("x", "y", "size"))
    assert max(xs) - min(xs) > 40 and max(ys) - min(ys) > 50 and max(sizes) - min(sizes) > 12, "spread over the frame, small and large"
    assert placement.clean(got[0]) == got[0]


def test_a_placement_from_outside_is_checked(srv):
    assert placement.clean({"kind": "loose", "x": 30, "y": 40, "size": 20}) == {"kind": "loose", "x": 30.0, "y": 40.0, "size": 20.0}
    for bad in (None, "x", {"kind": "exact", "x": 1, "y": 1, "size": 18}, {"kind": "loose", "x": 130, "y": 40, "size": 20},
                {"kind": "loose", "x": 30, "y": 40, "size": 90}, {"kind": "loose", "x": "a", "y": 40, "size": 20}, {"kind": "free"}):
        assert placement.clean(bad) is None, bad


def test_the_guide_draws_the_mark_at_its_placement(srv, tmp_path, monkeypatch):
    monkeypatch.setattr(placement, "GUIDE_DIR", tmp_path / "guides")
    pl = {"kind": "loose", "x": 30.0, "y": 70.0, "size": 25.0}
    g = placement.guide(demo(srv), pl)
    dark = Image.open(g["files"]["dark"]).convert("L")
    left, top, right, bottom = dark.point(lambda v: 255 if v > 128 else 0).getbbox()
    assert abs((left + right) / 2 - 1080 * 0.30) < 6 and abs((top + bottom) / 2 - 1920 * 0.70) < 6, "centred where it was placed"
    assert abs((right - left) - 1080 * 0.25) < 8, "at its size"
    assert Image.open(g["files"]["light"]).getpixel((5, 5)) != dark.getpixel((5, 5)), "a light one too"
    assert placement.guide(demo(srv), pl) == g, "drawn once"


def test_a_received_project_keeps_only_sound_placements(tmp_path):
    import json
    f = tmp_path / "state.json"
    f.write_text(json.dumps({"placements": {"a.jpg": {"kind": "loose", "x": 30, "y": 40, "size": 20}, "../x.jpg": {"kind": "loose", "x": 30, "y": 40, "size": 20},
                                            "b.jpg": {"kind": "loose", "x": 300}}}))
    projects._clean_state(f)
    assert json.loads(f.read_text())["placements"] == {"a.jpg": {"kind": "loose", "x": 30.0, "y": 40.0, "size": 20.0}}


def test_the_logo_check_measures_a_loose_image_where_its_mark_was_placed(srv, tmp_path, monkeypatch):
    """The guide itself as the image (the mark exactly where it was placed): it passes there, and fails measured on target."""
    monkeypatch.setattr(placement, "GUIDE_DIR", tmp_path / "guides")
    pl = {"kind": "loose", "x": 32.0, "y": 64.0, "size": 22.0}
    img = placement.guide(demo(srv), pl)["files"]["dark"]
    assert srv.check_new_image(img, pl)["qa_passed"], "where it was placed"
    assert not srv.check_new_image(img)["qa_passed"], "not at the centre: the check knows the difference"
