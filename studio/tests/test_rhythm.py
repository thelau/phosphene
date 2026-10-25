import pytest

import cutplan
import rhythm

# Shared with tests/js/ui.test.cjs: the page's timeline must give the same answers.
RHYTHM_VECTORS = [
    # n_cuts, rhythm, paired, starts[min(7, n)], total
    (10, "decel", False, 7.974487, 25.772028),
    (10, "accel", False, 22.772028, 25.772028),
    (10, "accel", True, 30.0747, 33.0747),
    (20, "decel", True, 7.002568, 51.544056),
    (1, "accel", False, 1.4, 1.4),
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


def lengths(starts):
    return [b - a for a, b in zip(starts, starts[1:])]


def test_decelerating_is_steady_then_slows_and_ends_on_the_longest_hold():
    d = lengths(rhythm.cut_starts(100, "decel"))
    assert all(x == 1.0 for x in d[:30]) and d[60] > 1.2
    assert all(y >= x - 1e-9 for x, y in zip(d, d[1:])) and d[-1] == max(d) and d[-2] > 6      # the references: the last cuts are 7-11x the first


def test_accelerating_is_the_same_curve_backwards():
    dec, acc = lengths(rhythm.cut_starts(100, "decel")), lengths(rhythm.cut_starts(100, "accel"))
    assert acc[0] == max(acc) and all(y <= x + 1e-9 for x, y in zip(acc, acc[1:]))
    assert all(x == 1.0 for x in acc[-30:])                                                        # it ends steady, at the tempo you set
    assert acc[1:] == pytest.approx(dec[:-1][::-1])                                                # only the held first/last image differs


def test_old_names_and_unknown_names_are_flat():
    for old in ("burst", "land", "long", "sideways"):
        assert rhythm.cut_starts(5, old) == [0, 1, 2, 3, 4, 5]


def test_an_image_and_its_inverted_copy_share_one_length():
    s = rhythm.cut_starts(40, "decel", paired=True)
    d = [b - a for a, b in zip(s, s[1:])]
    assert all(d[i] == pytest.approx(d[i + 1]) for i in range(0, 40, 2))


def test_min_len_keeps_every_cut_at_least_one_frame():
    s = rhythm.cut_starts(100, "decel", min_len=1.5)
    assert min(b - a for a, b in zip(s, s[1:])) >= 1.5 - 1e-9


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
    starts = cutplan.timeline(10, 4.0, "off", "decel")
    n_cuts, frames = cutplan.export_length(10, 4.0, "off", starts)
    assert n_cuts == 10 and frames == int(starts[-1] * 4.0) and frames > 40
    plates = {cutplan.frame_plan(f, 4.0, 10, "off", starts)["plate"] for f in range(frames)}
    assert plates == set(range(10))
    # the last frame is on the last image: the curve ends on its long hold
    assert cutplan.frame_plan(frames - 1, 4.0, 10, "off", starts)["plate"] == 9
