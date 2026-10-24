import random

import pytest

import chapters


def test_worlds_are_well_formed():
    names = [w["name"] for w in chapters.WORLDS]
    assert len(names) == len(set(names))
    for w in chapters.WORLDS:
        assert w["weight"] > 0
        assert len(w["applications"]) >= 8, w["name"]
        assert len(w["marks"]) >= 4, w["name"]
        assert w["brief"] and w["palette"]


def test_pick_world_by_name_and_fallback():
    assert chapters.pick_world(name="Editorial Print")["name"] == "Editorial Print"
    assert chapters.pick_world(name="Nope")["name"] in {w["name"] for w in chapters.WORLDS}


def test_pick_world_avoids_recent():
    recent = [w["name"] for w in chapters.WORLDS[:4]]
    random.seed(3)
    for _ in range(100):
        assert chapters.pick_world(recent)["name"] not in recent


def mk_world(name):
    return {"name": name, "brief": "b", "palette": "p", "applications": ["a"] * 10, "marks": ["m"] * 5, "weight": 1.0}


def test_world_stats_counts_and_rate():
    st = {"worlds": {"1": "W", "2": "W", "3": "W", "4": "W"}, "trashed": ["3", "4"], "qa_failed": ["4"]}
    s = chapters.world_stats(st)["W"]
    assert (s["n"], s["kept"], s["qa"]) == (4, 2, 1)
    assert s["rate"] == pytest.approx((2 + 1) / (4 - 0.5 + 6))


def test_world_stats_empty():
    assert chapters.world_stats({}) == {}


def test_all_worlds_includes_custom_and_ignores_duplicates():
    st = {"custom_worlds": [mk_world("New One"), mk_world("Editorial Print")]}
    names = [w["name"] for w in chapters.all_worlds(st)]
    assert "New One" in names
    assert names.count("Editorial Print") == 1


def test_custom_world_retired_after_six_with_no_keeps():
    worlds = {f"f{i}": "Flop" for i in range(6)}
    st = {"custom_worlds": [mk_world("Flop")], "worlds": worlds, "trashed": list(worlds)}
    assert "Flop" not in [w["name"] for w in chapters.all_worlds(st)]


def test_custom_world_kept_if_any_keep_or_too_few_samples():
    worlds = {f"f{i}": "Flop" for i in range(6)}
    st = {"custom_worlds": [mk_world("Flop")], "worlds": worlds, "trashed": list(worlds)[:5]}
    assert "Flop" in [w["name"] for w in chapters.all_worlds(st)]
    few = {"custom_worlds": [mk_world("Flop")], "worlds": {"a": "Flop"}, "trashed": ["a"]}
    assert "Flop" in [w["name"] for w in chapters.all_worlds(few)]


def test_choose_world_named_and_wildcard():
    assert chapters.choose_world({}, "Matter & Elements")["name"] == "Matter & Elements"
    assert chapters.choose_world({}, "__wildcard__") is None


def test_choose_world_surprise_mix():
    random.seed(7)
    picks = [chapters.choose_world({}, "") for _ in range(2000)]
    wild = sum(p is None for p in picks) / len(picks)
    assert 0.15 < wild < 0.25
    assert len({p["name"] for p in picks if p}) >= 12     # not an echo chamber


def test_choose_world_skips_last_three_worlds():
    recent = [w["name"] for w in chapters.WORLDS[:3]]
    random.seed(5)
    for _ in range(300):
        w = chapters.choose_world({"recent_worlds": recent}, "")
        assert w is None or w["name"] not in recent


def test_choose_world_exploits_high_keep_rate():
    worlds = {f"a{i}": "Matter & Elements" for i in range(40)}
    st = {"worlds": worlds, "trashed": []}   # 40/40 kept
    random.seed(9)
    picks = [chapters.choose_world(st, "") for _ in range(1500)]
    counts = {}
    for p in picks:
        if p:
            counts[p["name"]] = counts.get(p["name"], 0) + 1
    assert max(counts, key=counts.get) == "Matter & Elements"
