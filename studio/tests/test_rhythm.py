import pytest

import cutplan
import rhythm

# Shared with tests/js/ui.test.cjs: the page's timeline must give the same answers.
RHYTHM_VECTORS = [
    # n_cuts, rhythm, paired, starts[min(7, n)], total
    (10, "land", False, 7.0, 15.213763),
    (10, "burst", False, 5.37037, 12.41358),
    (10, "burst", True, 5.5, 15.0),
    (20, "land", True, 7.0, 30.427526),
    (1, "burst", False, 4.5, 4.5),
    (6, "flat", False, 6.0, 6.0),
]


@pytest.mark.parametrize("n,r,paired,at7,total", RHYTHM_VECTORS)
def test_cut_starts_vectors(n, r, paired, at7, total):
    s = rhythm.cut_starts(n, r, paired)
    assert len(s) == n + 1 and s[0] == 0
    assert s[min(7, n)] == pytest.approx(at7, abs=1e-5) and s[-1] == pytest.approx(total, abs=1e-5)


def test_flat_is_exactly_the_old_uniform_cuts():
    assert rhythm.cut_starts(5, "flat") == [0, 1, 2, 3, 4, 5]
    assert rhythm.cut_starts(5, "nonsense") == [0, 1, 2, 3, 4, 5]


@pytest.mark.parametrize("r", ["land", "burst"])
def test_curves_end_on_the_longest_hold_and_never_go_backwards(r):
    s = rhythm.cut_starts(60, r)
    d = [b - a for a, b in zip(s, s[1:])]
    assert all(x > 0 for x in d) and d[-1] == max(d) and d[-1] > 2 * d[0]


def test_burst_is_faster_than_the_opening_and_land_is_not():
    b = rhythm.cut_starts(100, "burst")
    land = rhythm.cut_starts(100, "land")
    assert min(y - x for x, y in zip(b, b[1:])) == pytest.approx(0.5)
    assert min(y - x for x, y in zip(land, land[1:])) == pytest.approx(1.0)


def test_an_image_and_its_inverted_copy_share_one_length():
    s = rhythm.cut_starts(40, "burst", paired=True)
    d = [b - a for a, b in zip(s, s[1:])]
    assert all(d[i] == pytest.approx(d[i + 1]) for i in range(0, 40, 2))


def test_min_len_keeps_every_cut_at_least_one_frame():
    s = rhythm.cut_starts(100, "burst", min_len=0.8)
    assert min(b - a for a, b in zip(s, s[1:])) >= 0.8 - 1e-9


def test_cut_at_finds_the_cut_and_wraps():
    s = [0, 1, 3, 4.5]
    assert rhythm.cut_at(s, 0.0) == (0, 0.0)
    assert rhythm.cut_at(s, 2.0) == (1, 0.5)
    assert rhythm.cut_at(s, 4.4)[0] == 2
    assert rhythm.cut_at(s, 4.5 + 1.5) == (1, 0.25)   # wraps around the sequence


def test_plan_at_with_a_timeline_and_flat_agree_with_the_old_plan():
    flat = cutplan.timeline(4, 7.5)
    for pos in (0.0, 0.4, 1.0, 2.7, 3.99):
        a = cutplan.plan_at(pos, 4)
        b = cutplan.plan_at(pos, 4, "off", flat)
        assert (a["cut"], a["plate"]) == (b["cut"], b["plate"]) and a["p"] == pytest.approx(b["p"])


def test_export_length_follows_the_curve_and_still_shows_every_image_once():
    starts = cutplan.timeline(10, 4.0, "off", "land")
    n_cuts, frames = cutplan.export_length(10, 4.0, "off", starts)
    assert n_cuts == 10 and frames == int(starts[-1] * 4.0) and frames > 40
    plates = {cutplan.frame_plan(f, 4.0, 10, "off", starts)["plate"] for f in range(frames)}
    assert plates == set(range(10))
    # the last frame is on the last image: the curve ends on its long hold
    assert cutplan.frame_plan(frames - 1, 4.0, 10, "off", starts)["plate"] == 9
