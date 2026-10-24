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


def test_known_bad_filenames_are_rejected(tmp_path):
    p = plate_with_logo(tmp_path / "11_concrete_double.jpg")
    r = qa.evaluate_plate_qa(p)
    assert not r["qa_passed"] and "Rejected artifact plate" in r["issues"]


def test_result_shape(tmp_path):
    r = qa.evaluate_plate_qa(plate_with_logo(tmp_path / "ok.jpg"))
    for key in ("filename", "qa_passed", "qa_score", "center_corr", "core_asymmetry", "outer_ring_corr", "detected_diam_px", "polarity", "issues"):
        assert key in r
    assert 0 <= r["qa_score"] <= 100
