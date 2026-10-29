"""Logo QA on synthetic plates built from the real logo mask (no network, no generated plates)."""

import pytest
from PIL import Image

import qa_engine as qa


def plate_with_logo(path, bg=(25, 25, 30), fg=(250, 245, 230), diam=190, dx=0, dy=0):
    """1080x1920 plate with the true logo drawn at (centre + dx, dy)."""
    im = Image.new("RGB", (qa.TARGET_W, qa.TARGET_H), bg)
    mask = qa.load_clean_orbital_mask(diam)
    im.paste(Image.new("RGB", mask.size, fg), (qa.CENTER_X - diam // 2 + dx, qa.CENTER_Y - diam // 2 + dy), mask)
    im.save(path, "JPEG", quality=95)
    return path


def test_mask_sizes_and_symmetric_impostor_differs():
    m = qa.load_clean_orbital_mask(200)
    assert m.size == (200, 200) and m.getextrema()[1] > 200
    sym = qa.make_symmetric_impostor_mask(200)
    assert sym.size == (200, 200) and m.tobytes() != sym.tobytes()


def test_normalized_corr_identical_inverted_and_flat():
    a = Image.linear_gradient("L").resize((16, 16))
    inv = Image.eval(a, lambda v: 255 - v)
    flat = Image.new("L", (16, 16), 100)
    assert qa.normalized_corr(a, a) == pytest.approx(1.0)
    assert qa.normalized_corr(a, inv) == pytest.approx(-1.0)
    assert qa.normalized_corr(a, flat) == 0.0
    assert qa.normalized_corr(Image.new("L", (0, 0)), Image.new("L", (0, 0))) == 0.0


def test_true_logo_at_center_passes(tmp_path):
    r = qa.evaluate_plate_qa(plate_with_logo(tmp_path / "ok.jpg"))
    assert r["qa_passed"] and r["issues"] == [] and r["qa_score"] >= 55
    assert r["center_corr"] > 0.5 and (r["width"], r["height"]) == (1080, 1920)


def test_dark_logo_on_light_background_passes(tmp_path):
    r = qa.evaluate_plate_qa(plate_with_logo(tmp_path / "d.jpg", bg=(235, 230, 220), fg=(40, 20, 20)))
    assert r["qa_passed"] and r["polarity"].startswith("dark_on_light")


def test_coloured_logo_passes(tmp_path):
    assert qa.evaluate_plate_qa(plate_with_logo(tmp_path / "c.jpg", bg=(20, 20, 24), fg=(236, 84, 12)))["qa_passed"]


def test_empty_plate_fails(tmp_path):
    p = tmp_path / "blank.jpg"
    Image.new("RGB", (1080, 1920), (30, 30, 30)).save(p, "JPEG")
    r = qa.evaluate_plate_qa(p)
    assert not r["qa_passed"] and r["issues"]


def test_logo_off_center_fails(tmp_path):
    r = qa.evaluate_plate_qa(plate_with_logo(tmp_path / "off.jpg", dx=170, dy=-260))
    assert not r["qa_passed"]


def test_oversized_logo_is_flagged(tmp_path):
    r = qa.evaluate_plate_qa(plate_with_logo(tmp_path / "big.jpg", diam=540))
    assert not r["qa_passed"]


def test_non_standard_size_is_normalised(tmp_path):
    im = Image.open(plate_with_logo(tmp_path / "big.jpg")).resize((540, 960))
    p = tmp_path / "small.jpg"
    im.save(p, "JPEG", quality=95)
    assert qa.evaluate_plate_qa(p)["qa_passed"]


def test_result_shape(tmp_path):
    r = qa.evaluate_plate_qa(plate_with_logo(tmp_path / "ok.jpg"))
    for key in ("filename", "qa_passed", "qa_score", "center_corr", "core_asymmetry", "outer_ring_corr", "detected_diam_px", "polarity", "issues"):
        assert key in r
    assert 0 <= r["qa_score"] <= 100


# ---- a project's own mark (not DEMO): fitted at its size and bigger, flat and by its outline ----
def _swoosh(path):
    """A wide, asymmetric mark (a swoosh-like wedge) on transparency."""
    from PIL import ImageDraw
    m = Image.new("RGBA", (384, 134), (0, 0, 0, 0))
    ImageDraw.Draw(m).polygon([(0, 100), (30, 60), (60, 105), (384, 0), (90, 134), (10, 125)], fill=(17, 17, 17, 255))
    m.save(path)
    return path


def _plate_with_own_mark(path, mark_file, scale=1.0, bg=(230, 225, 215), fg=(20, 20, 20), emboss=False):
    from PIL import ImageFilter
    spec = qa.mark_spec(mark_file, 18)
    m = spec.mask(int(spec.width * scale))
    im = Image.new("RGB", (qa.TARGET_W, qa.TARGET_H), bg)
    x, y = spec.center[0] - m.width // 2, spec.center[1] - m.height // 2
    if emboss:                                   # the same colour as the paper: only a light and a dark edge show
        im.paste(Image.new("RGB", m.size, tuple(min(255, c + 25) for c in bg)), (x - 2, y - 2), m.filter(ImageFilter.FIND_EDGES))
        im.paste(Image.new("RGB", m.size, tuple(max(0, c - 40) for c in bg)), (x + 2, y + 2), m.filter(ImageFilter.FIND_EDGES))
    else:
        im.paste(Image.new("RGB", m.size, fg), (x, y), m)
    im.save(path, "JPEG", quality=95)
    return path, spec


def test_own_mark_at_its_size_passes_and_twice_too_big_fails(tmp_path):
    mark = _swoosh(tmp_path / "mark.png")
    ok, spec = _plate_with_own_mark(tmp_path / "ok.jpg", mark)
    r = qa.evaluate_plate_qa(ok, spec)
    assert r["qa_passed"], r
    big, spec = _plate_with_own_mark(tmp_path / "big.jpg", mark, scale=2.2)
    r = qa.evaluate_plate_qa(big, spec)
    assert not r["qa_passed"] and "too big" in r["issues"][0], "a mark drawn twice too big used to pass: it still covers the target"
    assert not r["qa_doubt"] and not qa.evaluate_plate_qa(ok, spec)["qa_doubt"], "at its size: no note"
    near, spec = _plate_with_own_mark(tmp_path / "near.jpg", mark, scale=1.3)
    r = qa.evaluate_plate_qa(near, spec)
    assert r["qa_passed"] and r["qa_doubt"].startswith("Check the mark"), "a third too big: kept, with a note for the user (the check cannot be sure on every shape)"
    small, spec = _plate_with_own_mark(tmp_path / "small.jpg", mark, scale=0.55)
    r = qa.evaluate_plate_qa(small, spec)
    assert not r["qa_passed"] or r["qa_doubt"], "clearly smaller: trashed, or at least noted"


def test_own_mark_embossed_passes_by_its_outline(tmp_path):
    mark = _swoosh(tmp_path / "mark.png")
    plate, spec = _plate_with_own_mark(tmp_path / "emboss.jpg", mark, emboss=True)
    r = qa.evaluate_plate_qa(plate, spec)
    assert r["qa_passed"] and r["polarity"] == "outline", r


def test_own_mark_missing_fails(tmp_path):
    mark = _swoosh(tmp_path / "mark.png")
    spec = qa.mark_spec(mark, 18)
    Image.new("RGB", (qa.TARGET_W, qa.TARGET_H), (230, 225, 215)).save(tmp_path / "empty.jpg", "JPEG")
    assert not qa.evaluate_plate_qa(tmp_path / "empty.jpg", spec)["qa_passed"]


def _check(job):
    """One logo check in a process of its own (the three below in parallel: one after another they took 26 s)."""
    image, mark, size = job
    return qa.evaluate_plate_qa(image, qa.mark_spec(mark, size))


def test_a_plain_triangle_at_its_size_is_never_trashed_and_one_much_too_big_is(tmp_path):
    """The user's triangle (47.5% wide): a right one was trashed (fit 0.41 under the old 0.42 bar). Now only the clearly wrong is."""
    from concurrent.futures import ProcessPoolExecutor
    from PIL import ImageDraw
    m = Image.new("RGBA", (300, 260), (0, 0, 0, 0))
    ImageDraw.Draw(m).polygon([(150, 0), (300, 260), (0, 260)], fill=(20, 20, 20, 255))
    m.save(tmp_path / "tri.png")
    jobs = []
    for size, scale, ink, name in ((47.5, 1.0, (30, 120, 160), "full"), (47.5, 1.0, (150, 190, 205), "faint"), (30, 2.0, (30, 120, 160), "big")):
        spec = qa.mark_spec(tmp_path / "tri.png", size)                   # faint halftone ink, or a full one; or twice too big
        tm = spec.mask(int(spec.width * scale))
        im = Image.new("RGB", (qa.TARGET_W, qa.TARGET_H), (225, 220, 210))
        im.paste(Image.new("RGB", tm.size, ink), (spec.center[0] - tm.width // 2, spec.center[1] - tm.height // 2), tm)
        im.save(tmp_path / f"{name}.jpg", quality=92)
        jobs.append((tmp_path / f"{name}.jpg", tmp_path / "tri.png", size))
    with ProcessPoolExecutor() as pool:
        full, faint, big = pool.map(_check, jobs)
    assert full["qa_passed"] and faint["qa_passed"], "at its size (full or faint ink): never trashed"
    assert not big["qa_passed"] or big["qa_doubt"], "twice too big: trashed or noted"


def test_a_faint_mark_sharpest_at_its_own_size_is_doubtful_not_trashed(tmp_path, monkeypatch):
    # Halo's "Construction Scrim Square": the frame as faint seams in dark mesh, fit 0.24 but sharply at its size; the user restored it
    mark = _swoosh(tmp_path / "mark.png")
    ok, spec = _plate_with_own_mark(tmp_path / "ok.jpg", mark)
    curve = lambda peak, around: (lambda g, e, m, sc: ((peak if sc == 1.0 else around), "outline"))
    monkeypatch.setattr(qa, "_fit", curve(0.24, 0.08))
    r = qa.evaluate_plate_qa(ok, spec)
    assert r["qa_passed"] and r["qa_doubt"].startswith("Check the mark: it is faint"), r
    monkeypatch.setattr(qa, "_fit", curve(0.24, 0.2))                       # as faint, but other sizes fit about as well: not there
    assert not qa.evaluate_plate_qa(ok, spec)["qa_passed"]
    monkeypatch.setattr(qa, "_fit", curve(0.15, 0.0))                       # too faint to say
    assert not qa.evaluate_plate_qa(ok, spec)["qa_passed"]
