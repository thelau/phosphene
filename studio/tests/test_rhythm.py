import pytest

import cutplan
import rhythm


def test_cut_at_finds_the_cut_and_wraps():
    s = [0, 1, 3, 4.5]
    assert rhythm.cut_at(s, 0.0) == (0, 0.0)
    assert rhythm.cut_at(s, 2.0) == (1, 0.5)
    assert rhythm.cut_at(s, 4.4)[0] == 2
    assert rhythm.cut_at(s, 4.5 + 1.5) == (1, 0.25)   # wraps around the sequence


def test_flat_timeline_is_one_base_cut_each_and_invert_doubles_it():
    assert cutplan.timeline(3) == [0, 1, 2, 3]
    assert cutplan.timeline(3, "mono") == [0, 1, 2, 3, 4, 5, 6]


def test_plan_at_with_a_timeline_agrees_with_the_plain_plan_when_flat():
    flat = cutplan.timeline(4)
    for pos in (0.0, 0.4, 1.0, 2.7, 3.99):
        a = cutplan.plan_at(pos, 4)
        b = cutplan.plan_at(pos, 4, "off", flat)
        assert (a["cut"], a["plate"]) == (b["cut"], b["plate"]) and a["p"] == pytest.approx(b["p"])


def test_music_driven_cuts_become_frame_positions_and_every_image_still_shows_once():
    starts_sec = [0.0, 0.2, 0.5, 0.6, 1.4]                       # four uneven cuts: 0.2, 0.3, 0.1, 0.8 s
    starts = cutplan.timeline_from_seconds(starts_sec)
    assert starts == pytest.approx([0, 6, 15, 18, 42])
    n_cuts, frames = cutplan.export_length(4, 1.0, "off", starts)
    assert (n_cuts, frames) == (4, 42)
    plates = [cutplan.frame_plan(f, 1.0, 4, "off", starts)["plate"] for f in range(frames)]
    assert plates[:6] == [0] * 6 and plates[6:15] == [1] * 9 and plates[15:18] == [2] * 3 and plates[18:] == [3] * 24
    assert cutplan.frame_plan(0, 1.0, 4, "off", starts)["p"] == pytest.approx(0.5 / 6)


# ---------- following a track ----------

def test_select_hits_keeps_the_strongest_and_never_two_within_the_minimum_gap():
    hits = [[1.0, 5.0], [1.03, 9.0], [2.0, 1.0], [3.0, 4.0], [4.0, 3.0]]
    assert rhythm.select_hits(hits, 1.0) == [1.03, 2.0, 3.0, 4.0]          # 1.0 lost to the stronger hit 30 ms away
    assert rhythm.select_hits(hits, 0.0) == [1.03]                         # the top 10% (at least one)
    assert rhythm.select_hits(hits, 0.5) == [1.03, 3.0]                    # the strongest three, minus the one next to a stronger hit
    assert rhythm.select_hits([], 0.5) == []


def test_more_sensitivity_never_gives_fewer_cuts():
    import random
    rng = random.Random(3)
    hits = [[i * 0.15 + rng.random() * 0.05, rng.random() * 10] for i in range(200)]
    counts = [len(rhythm.select_hits(hits, s / 10)) for s in range(11)]
    assert counts == sorted(counts) and counts[0] < counts[-1]


def test_beat_time_interpolates_and_carries_on_past_the_end():
    beats = [1.0, 1.5, 2.1]
    assert rhythm.beat_time(beats, 0) == 1.0
    assert rhythm.beat_time(beats, 0.5) == pytest.approx(1.25)
    assert rhythm.beat_time(beats, 1.5) == pytest.approx(1.8)
    assert rhythm.beat_time(beats, 4) == pytest.approx(2.1 + 2 * 0.6)       # the last interval continues


def test_beat_events_follow_the_beats_not_a_rigid_grid_and_the_multiple_divides_them():
    beats = [0.0, 0.5, 1.1, 1.6]                                             # a drifting tempo
    assert rhythm.beat_events(beats, 1.0, 1.6) == pytest.approx([0.0, 0.5, 1.1, 1.6])
    assert rhythm.beat_events(beats, 2.0, 1.6) == pytest.approx([0.0, 0.25, 0.5, 0.8, 1.1, 1.35, 1.6])
    assert rhythm.beat_events(beats, 0.5, 1.6) == pytest.approx([0.0, 1.1])
    assert rhythm.beat_events([1.0], 1.0, 5.0) == []


ANALYSIS = {"duration": 10.0, "bpm": 120.0, "beats": [0.5 + 0.5 * i for i in range(19)],
            "hits": [[2.0, 5.0], [2.3, 4.0], [2.31, 1.0], [3.0, 6.0], [5.5, 3.0], [9.0, 2.0]]}


def test_track_cuts_start_on_the_first_event_and_sound_starts_there_too():
    r = rhythm.track_cuts(ANALYSIS, 3, "hits", sensitivity=1.0)
    assert r["starts"] == pytest.approx([0.0, 0.3, 1.0, 3.5]) and r["audio_start"] == 2.0 and r["total"] == pytest.approx(3.5)


def test_nudge_moves_the_sound_start_and_keeps_the_picture_times():
    base = rhythm.track_cuts(ANALYSIS, 3, "hits", sensitivity=1.0)
    later = rhythm.track_cuts(ANALYSIS, 3, "hits", sensitivity=1.0, nudge=0.1)
    earlier = rhythm.track_cuts(ANALYSIS, 3, "hits", sensitivity=1.0, nudge=-0.1)
    assert later["starts"] == base["starts"] and later["audio_start"] == pytest.approx(2.1) and earlier["audio_start"] == pytest.approx(1.9)
    assert rhythm.track_cuts({**ANALYSIS, "hits": [[0.02, 5.0], [0.5, 4.0]]}, 1, "hits", sensitivity=1.0, nudge=-0.3)["audio_start"] == 0.0   # never before the file


def test_a_track_shorter_than_the_clip_loops_and_the_pictures_keep_landing_on_hits():
    r = rhythm.track_cuts(ANALYSIS, 12, "hits", sensitivity=1.0)
    assert len(r["starts"]) == 13 and r["starts"] == sorted(r["starts"]) and len(set(r["starts"])) == 13
    first_loop = r["starts"][:5]                                           # five events fit in the track
    second_loop = r["starts"][5:10]
    assert [b - a for a, b in zip(second_loop, second_loop[1:])] == pytest.approx([b - a for a, b in zip(first_loop, first_loop[1:])])
    assert second_loop[0] - first_loop[0] == pytest.approx(r["loop"]) and r["loop"] == pytest.approx(10.0 - 2.0)    # one pass of the sound, from its start to the end of the file


def test_beat_mode_uses_the_beat_grid_and_the_multiple():
    r = rhythm.track_cuts(ANALYSIS, 4, "beats", multiple=2.0)
    assert r["starts"] == pytest.approx([0.0, 0.25, 0.5, 0.75, 1.0]) and r["audio_start"] == 0.5


def test_a_track_with_nothing_to_cut_on_is_refused():
    with pytest.raises(ValueError, match="Not enough"):
        rhythm.track_cuts({**ANALYSIS, "hits": [[1.0, 1.0]]}, 3, "hits")
    with pytest.raises(ValueError, match="Not enough"):
        rhythm.track_cuts({**ANALYSIS, "beats": []}, 3, "beats")


def test_notes_mode_cuts_on_pitch_changes_and_only_the_clearly_percussive_hits():
    analysis = {**ANALYSIS, "notes": [[1.0, 0.6], [1.5, 0.9], [2.4, 0.5]], "hits": [[1.2, 0.9], [1.7, 0.2], [2.9, 0.4]]}
    r = rhythm.track_cuts(analysis, 4, "notes", sensitivity=1.0)
    # events: 1.0 and 1.5 and 2.4 (notes), 1.2 and 2.9 (hits above 0.35); the weak hit at 1.7 is left out
    assert r["events"] == 5 and r["audio_start"] == 1.0
    assert r["starts"] == pytest.approx([0.0, 0.2, 0.5, 1.4, 1.9])


def test_notes_mode_asks_for_the_track_again_when_it_was_loaded_without_notes():
    with pytest.raises(ValueError, match="choose it again"):
        rhythm.track_cuts(ANALYSIS, 3, "notes")
