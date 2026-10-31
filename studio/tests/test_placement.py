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


def draws(srv, kind, n=300):
    rng = random.Random(7)
    return [placement.choose(kind, demo(srv), rng) for _ in range(n)]


def inside_the_frame(srv, got):
    ratio = placement._ratio(demo(srv))
    for pl in got:
        h = pl["size"] * ratio * 1080 / 1920
        assert pl["x"] - pl["size"] / 2 >= placement.MARGIN - 0.1 and pl["x"] + pl["size"] / 2 <= 100 - placement.MARGIN + 0.1
        assert pl["y"] - h / 2 >= placement.MARGIN - 0.1 and pl["y"] + h / 2 <= 100 - placement.MARGIN + 0.1


def away(pl, hx=50, hy=50):
    return max(abs(pl["x"] - hx), abs(pl["y"] - hy))


def test_loose_is_near_the_target_but_never_on_it(srv):
    got = draws(srv, "loose")
    inside_the_frame(srv, got)
    for pl in got:
        assert pl["kind"] == "loose" and 0.5 - 0.1 <= away(pl) <= 2 + 0.1, pl
        f = pl["size"] / 18
        assert 0.9 - 0.01 <= f <= 0.96 + 0.01 or 1.04 - 0.01 <= f <= 1.1 + 0.01, f"a touch smaller or bigger: {pl}"
    assert len({pl["x"] < 50 for pl in got}) == 2 and len({pl["y"] < 50 for pl in got}) == 2, "on every side"
    assert placement.clean(got[0]) == got[0]


def test_scattered_is_away_from_the_target_and_all_over(srv):
    got = draws(srv, "scattered")
    inside_the_frame(srv, got)
    for pl in got:
        assert pl["kind"] == "scattered" and away(pl) >= 8 - 0.1, pl
        f = pl["size"] / 18
        assert 0.6 - 0.01 <= f <= 0.85 + 0.01 or 1.2 - 0.01 <= f <= 1.6 + 0.01, pl
    xs, ys = [pl["x"] for pl in got], [pl["y"] for pl in got]
    assert min(xs) < 20 and max(xs) > 80 and min(ys) < 20 and max(ys) > 80, "to the corners"
    assert placement.clean(got[0]) == got[0]


def test_loose_follows_a_project_whose_mark_is_off_centre(srv):
    p = {**demo(srv), "mark_x": 25.0, "mark_y": 80.0}
    rng = random.Random(3)
    for _ in range(100):
        pl = placement.choose("loose", p, rng)
        assert 0.5 - 0.1 <= away(pl, 25, 80) <= 2 + 0.1, pl


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


# ---- the mark turned (2026-10-31): flat in the frame, the angles ticked in the Mark menu taking turns ----

def ell(srv, tmp_path, monkeypatch):
    """A project whose mark is an L (wide, lopsided: any turn shows), as the open one."""
    from PIL import ImageDraw
    f = tmp_path / "ell.png"
    im = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 90, 299), fill=(20, 20, 20, 255))
    d.rectangle((0, 210, 399, 299), fill=(20, 20, 20, 255))
    im.save(f)
    p = {**demo(srv), "mark_file": f, "qa": None, "mark_size": 24.0, "mark_x": 50.0, "mark_y": 50.0, "marks": []}
    p.pop("demo", None)
    monkeypatch.setattr(srv, "PROJECT", p)
    monkeypatch.setattr(placement, "GUIDE_DIR", tmp_path / "guides")
    return p


def test_an_angle_is_one_of_the_menus_and_kept_with_the_image(srv):
    assert [projects.clean_rot(v) for v in (45, "90", -135, 180, -180, 540, 30, "x", None)] == [45, 90, -135, 180, 180, 180, 0, 0, 0]
    assert placement.choose("exact", demo(srv), rot=90) == {"kind": "exact", "x": 50.0, "y": 50.0, "size": demo(srv)["mark_size"], "rot": 90}, "on target, turned: kept"
    assert placement.clean({"kind": "exact", "x": 50, "y": 50, "size": 50, "rot": -45}) == {"kind": "exact", "x": 50.0, "y": 50.0, "size": 50.0, "rot": -45}, "the project's own size, up to 60%"
    assert placement.clean({"kind": "exact", "x": 50, "y": 50, "size": 18, "rot": 0}) is None, "upright on target: nothing to keep, as before"
    assert placement.clean({"kind": "loose", "x": 30, "y": 40, "size": 20, "rot": 33}) == {"kind": "loose", "x": 30.0, "y": 40.0, "size": 20.0}, "an angle not offered: upright"


def test_a_turned_mark_is_its_file_turned_and_keeps_its_own_size(srv, tmp_path, monkeypatch):
    p = ell(srv, tmp_path, monkeypatch)
    t = projects.rotated(p, 90)
    a = projects.mark_alpha(Image.open(t["mark_file"]))
    assert a.height > a.width, "the wide L stands tall"
    assert abs(t["mark_size"] - 24 * 300 / 400) < 0.3, "its box is as wide as the mark was tall: the mark keeps its size"
    assert projects.rotated(p, 0) is p and projects.rotated(p, 90)["mark_file"] == t["mark_file"], "upright: as it was; turned once, kept"
    g = Image.open(placement.guide(p, placement.choose("exact", p, rot=90))["files"]["dark"]).convert("L")
    left, top, right, bottom = g.point(lambda v: 255 if v > 128 else 0).getbbox()
    assert bottom - top > right - left, "the guide Krea draws from shows it turned"
    assert abs((left + right) / 2 - 540) < 8 and abs((top + bottom) / 2 - 960) < 8, "at its place"


def test_the_logo_check_measures_a_turned_mark_turned(srv, tmp_path, monkeypatch):
    """The turned guide as the image: it passes cleanly measured turned; measured upright it is doubted (the check trashes only the
    clearly wrong: a quarter turn of an L still overlaps it) or, at 45°, trashed."""
    p = ell(srv, tmp_path, monkeypatch)
    for rot in (90, 45):
        pl = placement.choose("exact", p, rot=rot)
        img = placement.guide(p, pl)["files"]["dark"]
        turned, upright = srv.check_new_image(img, pl), srv.check_new_image(img)
        assert turned["qa_passed"] and not turned["qa_doubt"], rot
        assert not upright["qa_passed"] or upright["qa_doubt"], f"{rot}: upright, the check knows the difference"
    assert srv._plate_key(img, pl) != srv._plate_key(img, {**pl, "rot": -90}), "each angle measured on its own"


def test_the_prompt_says_the_mark_is_turned_and_only_then(srv, tmp_path, monkeypatch):
    p = ell(srv, tmp_path, monkeypatch)
    turned = srv.build_full_prompt("a wall", placement.as_project(p, placement.choose("exact", p, rot=-45)))
    assert "TURNED 45° anticlockwise" in turned and "never seen in perspective" in turned
    assert "TURNED" not in srv.build_full_prompt("a wall", p)
    assert "upside down" in srv.build_full_prompt("a wall", placement.as_project(p, placement.choose("exact", p, rot=180)), keep=True)


def test_ticked_angles_take_turns_evenly(srv):
    assert srv.rot_set("0,90,-45,33,x") == [0, 90, -45] and srv.rot_set(None) == [0] and srv.rot_set([180, -180]) == [180]
    deck = srv.RotDeck("0,45,90,135")
    got = deck.peek(20)
    assert sorted(got.count(r) for r in (0, 45, 90, 135)) == [5, 5, 5, 5]


def test_a_size_is_one_of_the_menus_and_kept_with_the_image(srv):
    size = demo(srv)["mark_size"]
    assert [projects.clean_scale(v) for v in (0.6, "1.25", 1.6, 1.3, None, "x")] == [0.6, 1.25, 1.6, 1.0, 1.0, 1.0]
    assert placement.choose("exact", demo(srv), scale=1.25) == {"kind": "exact", "x": 50.0, "y": 50.0, "size": round(size * 1.25, 1), "scale": 1.25}
    assert placement.choose("exact", demo(srv), scale=1) is None, "its own size on target: as before"
    pl = placement.clean({"kind": "exact", "x": 50, "y": 50, "size": 28.8, "scale": 1.6, "rot": 90})
    assert pl == {"kind": "exact", "x": 50.0, "y": 50.0, "size": 28.8, "rot": 90, "scale": 1.6}
    assert "scale" not in placement.clean({"kind": "loose", "x": 30, "y": 40, "size": 20, "scale": 1.6}), "Loose chooses its own size"
    assert srv.scale_set("0.8,1,7,1.25") == [0.8, 1.0, 1.25] and srv.scale_set(None) == [1.0]


def test_older_placements_and_images_read_as_they_always_did(srv):
    """Past projects: placements from before angles and sizes, and images with none, mean what they meant."""
    old = {"kind": "loose", "x": 30.0, "y": 40.0, "size": 20.0}
    assert placement.clean(old) == old and placement.as_project(demo(srv), old)["mark_file"] == demo(srv)["mark_file"]
    assert placement.clean({"kind": "exact", "x": 50, "y": 50, "size": 18, "angle": 30}) is None, "Angled's few: on target, as before"


def test_a_path_puts_a_batchs_images_at_even_steps_along_a_line_through_the_target(srv):
    p = demo(srv)
    steps = [placement.choose("path", p, path={"shape": "line", "dir": 0, "len": 40, "i": i, "n": 5}) for i in range(5)]
    xs = [s["x"] for s in steps]
    assert xs == sorted(xs) and abs(xs[0] - 30) < 0.2 and abs(xs[-1] - 70) < 0.2 and abs(xs[2] - 50) < 0.2, xs
    assert all(s["y"] == 50 and s["kind"] == "path" and s["size"] == p["mark_size"] for s in steps), "across: the same height and size"
    down = [placement.choose("path", p, path={"shape": "line", "dir": 90, "len": 70, "i": i, "n": 3}) for i in range(3)]
    assert down[0]["x"] == 50 and down[0]["y"] < 50 < down[2]["y"], "down the frame"
    long = [placement.choose("path", p, scale=1.6, path={"shape": "line", "dir": 0, "len": 70, "i": i, "n": 2}) for i in range(2)]
    half = long[0]["size"] / 2
    assert long[0]["x"] - half >= placement.MARGIN - 0.2 and long[1]["x"] + half <= 100 - placement.MARGIN + 0.2, "shrunk so both ends stay inside"
    assert placement.clean(steps[1]) == steps[1], "kept with the image as it is"
    assert placement.clean({**steps[1], "path": {"shape": "spiral"}}) is None and placement.clean({**steps[1], "path": None}) is None


def test_path_steps_go_in_order_across_chunks_and_fill_dropped_scenes(srv):
    steps = srv.PathSteps({"shape": "line", "dir": 45, "len": 20}, 6)
    first = steps.peek(4)
    assert [s["i"] for s in first] == [0, 1, 2, 3] and all(s["n"] == 6 and s["run"] for s in first)
    steps.take(first[0]); steps.take(first[2])                          # a chunk kept two of its scenes
    assert [s["i"] for s in steps.peek(3)] == [1, 3, 4], "the next chunk fills the step a dropped scene left"
    assert srv.PathSteps(None, 4).peek(2) == [None, None] and srv.path_for("exact", {"shape": "line"}) is None
