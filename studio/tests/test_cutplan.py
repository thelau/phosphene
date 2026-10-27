
import pytest

import cutplan

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


VARIABLE_VECTORS = [      # (cuts, start ms, end ms, ramp, at) -> starts in frames; the same numbers are checked in ui.test.cjs
    (6, 100, 600, 3, "end", [0.0, 3.0, 6.0, 9.0, 14.451, 24.357, 42.357]),
    (6, 100, 600, 3, "start", [0.0, 3.0, 10.348, 28.348, 46.348, 64.348, 82.348]),
    (5, 200, 200, 12, "end", [0.0, 6.0, 12.0, 18.0, 24.0, 30.0]),
    (1, 300, 100, 12, "end", [0.0, 3.0]),
    (4, 400, 100, 99, "end", [0.0, 8.485, 14.485, 18.728, 21.728]),
]


@pytest.mark.parametrize("n,a,b,ramp,at,expected", VARIABLE_VECTORS)
def test_variable_timeline_vectors(n, a, b, ramp, at, expected):
    assert cutplan.variable_timeline(n, a, b, ramp, at) == pytest.approx(expected, abs=0.001)


def lengths(t):
    return [b - a for a, b in zip(t, t[1:])]


def test_variable_speed_holds_then_lands_like_ecwora():
    # the reference: 3-frame cuts, then the last ~12 cuts ease out to ~21 frames, each a constant ratio of the one before
    t = lengths(cutplan.variable_timeline(40, 100, 700, 12))
    assert t[:28] == pytest.approx([3.0] * 28)                         # the hold
    assert t[-1] == pytest.approx(21.0) and t == pytest.approx(sorted(t))
    ratios = [b / a for a, b in zip(t[27:], t[28:])]
    assert ratios == pytest.approx([ratios[0]] * len(ratios), rel=1e-6)    # geometric
    assert 1.1 < ratios[0] < 1.25                                      # the reference's ~1.15-1.2 per cut


def test_the_landing_takes_the_same_time_however_many_images_there_are():
    short, long = cutplan.variable_timeline(40, 100, 700, 12), cutplan.variable_timeline(200, 100, 700, 12)
    assert (long[-1] - long[-13]) == pytest.approx(short[-1] - short[-13])         # the last 12 cuts last the same
    assert (long[-1] - short[-1]) == pytest.approx(160 * 3.0)                      # the extra images are all at the start speed


def test_variable_speed_can_build_up_slow_down_or_stay_flat():
    fast = lengths(cutplan.variable_timeline(30, 500, 80, 8, "end"))
    assert fast[0] == pytest.approx(15.0) and fast[-1] == pytest.approx(2.4) and fast == pytest.approx(sorted(fast, reverse=True))
    build = lengths(cutplan.variable_timeline(30, 500, 80, 8, "start"))
    assert build[0] == pytest.approx(15.0) and build[-1] == pytest.approx(2.4) and build[7:] == pytest.approx([2.4] * 23)
    flat = cutplan.variable_timeline(5, 250, 250, 3)
    assert flat == pytest.approx([i * 7.5 for i in range(6)])            # start == end: a flat run of 240 cuts a minute


def test_variable_speed_never_goes_below_a_frame_or_outside_its_limits():
    t = lengths(cutplan.variable_timeline(4, 1, 99999, 4))
    assert min(t) >= 1.0 and t[-1] == pytest.approx(45.0)                  # 50 ms .. 1500 ms at 30 fps
    assert cutplan.variable_timeline(5, 100, 600, 1) == cutplan.variable_timeline(5, 100, 600, 2)     # at least 2 cuts of change


def test_the_multiple_only_changes_the_picture_cuts_not_the_base_the_music_follows():
    pic, base = cutplan.rhythm_timeline(8, 120, 4)                          # 120 BPM = a beat every 15 frames; 4 picture cuts per beat
    assert base == pytest.approx([0.0, 15.0, 30.0])                          # the music grid: two beats cover 8 cuts
    assert lengths(pic) == pytest.approx([3.75] * 8)
    pic1, base1 = cutplan.rhythm_timeline(8, 120, 1)
    assert lengths(pic1) == pytest.approx([15.0] * 8) and len(base1) == 9
    assert base1[:3] == pytest.approx(base)                                  # the beat grid is the same whatever the multiple
    slow, _ = cutplan.rhythm_timeline(3, 120, 0.5)                           # one cut every two beats
    assert lengths(slow) == pytest.approx([30.0] * 3)


def test_flat_pictures_match_the_old_frames_per_cut():
    pic, _ = cutplan.rhythm_timeline(10, 120, 2)
    assert lengths(pic) == pytest.approx([7.5] * 10)                          # 1800 / (120 * 2)
    pic, _ = cutplan.rhythm_timeline(5, 250, 9)                                 # never below one frame
    assert min(lengths(pic)) >= 1.0


def test_variable_speed_with_a_multiple_subdivides_each_base_cut():
    var = (300.0, 300.0, 12, "end")                                           # flat 300 ms = 9 frames per base cut
    pic, base = cutplan.rhythm_timeline(6, 0, 3, var)
    assert lengths(base) == pytest.approx([9.0, 9.0]) and lengths(pic) == pytest.approx([3.0] * 6)
    accel, base = cutplan.rhythm_timeline(12, 0, 2, (500.0, 100.0, 12, "end"))
    bl = lengths(base)
    assert len(bl) == 6 and bl[0] > bl[-1]                                    # the base speeds up, and the picture cuts follow it at twice the rate
    assert accel[-1] == pytest.approx(base[6]) and lengths(accel)[0] == pytest.approx(bl[0] / 2, rel=0.01)


# ---------- extremes ----------

BPMS = [30, 60, 120, 136, 250, 500, 600]
MULTIPLES = [0.125, 0.25, 0.5, 1, 4 / 3, 2, 3, 4, 9, 16]
CUTS = [1, 2, 7, 40, 500]


@pytest.mark.parametrize("bpm", BPMS)
@pytest.mark.parametrize("multiple", MULTIPLES)
@pytest.mark.parametrize("n", CUTS)
def test_every_flat_rhythm_is_a_clean_increasing_timeline(bpm, multiple, n):
    pic, base = cutplan.rhythm_timeline(n, bpm, multiple)
    assert len(pic) == n + 1 and pic[0] == 0.0 and all(x == x and abs(x) != float("inf") for x in pic + base)
    assert all(b - a >= 1.0 - 1e-9 for a, b in zip(pic, pic[1:]))               # never a cut shorter than a frame
    assert all(b > a for a, b in zip(base, base[1:]))
    if 60 * 30 / bpm / multiple >= 1:                                            # when the picture cuts are at least a frame: the beat grid covers them
        assert base[-1] >= pic[-1] - 1e-6


@pytest.mark.parametrize("a,b,ramp,at", [(50, 1500, 2, "end"), (1500, 50, 200, "start"), (1, 1e9, 3, "end"), (float("nan"), 400, 5, "end"),
                                         (float("inf"), float("-inf"), 4, "start"), (300, 300, 0, "end"), (300, 100, -7, "start"), (100, 700, 10**9, "end"), (100, 700, 12, "sideways")])
@pytest.mark.parametrize("multiple", [0.25, 1, 4, 16])
@pytest.mark.parametrize("n", [1, 2, 9, 300])
def test_every_variable_rhythm_is_a_clean_increasing_timeline(a, b, ramp, at, multiple, n):
    pic, base = cutplan.rhythm_timeline(n, 120, multiple, (a, b, ramp, at))
    assert len(pic) == n + 1 and pic[0] == 0.0 and all(x == x and abs(x) != float("inf") for x in pic + base)
    assert all(y - x >= 1.0 - 1e-9 for x, y in zip(pic, pic[1:]))


def test_no_cuts_and_one_cut_do_not_break_the_timeline():
    pic, base = cutplan.rhythm_timeline(0, 120, 4)
    assert pic == [0.0] and len(base) >= 2
    pic, base = cutplan.rhythm_timeline(1, 120, 0.125)
    assert len(pic) == 2 and pic[1] >= 1.0
    assert cutplan.subdivide([0.0, 10.0], 3, 3) == pytest.approx([0.0, 3.333, 6.667, 10.0], abs=0.001)
    assert cutplan.subdivide([0.0, 10.0], 0, 2)[0] == 0.0                         # a multiple of 0 is not a division by zero


def test_a_huge_variable_run_stays_cheap_to_build():
    import time
    t = time.time()
    pic, _ = cutplan.rhythm_timeline(5000, 120, 16, (50, 1500, 200, "end"))
    assert len(pic) == 5001 and time.time() - t < 1.0


def test_the_music_grid_does_not_move_when_only_the_multiple_does():
    for bpm in BPMS:
        grids = [cutplan.rhythm_timeline(40, bpm, m)[1][:6] for m in (0.5, 1, 2, 4, 9)]
        assert all(g == pytest.approx(grids[0]) for g in grids)


TRAIL_VECTORS = [
    # frames since the cut, amount -> opacity of the previous image (shared with the page: trailAlpha)
    (0.0, 0.4, 0.4),
    (0.9, 0.4, 0.4),
    (1.0, 0.4, 0.3),
    (3.5, 0.4, 0.1),
    (4.0, 0.4, 0.0),
    (-0.5, 0.4, 0.0),
    (0.0, 0.0, 0.0),
    (0.0, 5.0, 0.6),          # clamped to the most it may be
]


@pytest.mark.parametrize("k,amount,expected", TRAIL_VECTORS)
def test_trail_alpha(k, amount, expected):
    assert cutplan.trail_alpha(k, amount) == pytest.approx(expected)


def test_cut_plate_follows_the_invert_pairs():
    assert cutplan.cut_plate(3, 3, "off") == (0, False)
    assert cutplan.cut_plate(3, 3, "mono") == (1, True)
