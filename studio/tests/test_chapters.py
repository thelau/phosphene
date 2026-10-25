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


def test_choose_world_named_wildcard_and_custom():
    assert chapters.choose_world({}, "Matter & Elements")["name"] == "Matter & Elements"
    assert chapters.choose_world({}, "__wildcard__") is None
    assert chapters.choose_world({}, "__custom__") is None


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


def fashion():
    return next(w for w in chapters.WORLDS if w["name"] == "Fashion & Apparel")


def test_fashion_marks_must_contrast_with_the_cloth():
    w = fashion()
    assert "LEGIBILITY RULE" in w["brief"] and "contrast" in w["brief"] and "phone size" in w["brief"]
    assert not any("tone-on-tone" in m.lower() for m in w["marks"])           # that treatment made the mark vanish (6 of 8 failed the logo check)
    assert any("contrast" in m or "raking light" in m for m in w["marks"])
    assert len(w["marks"]) >= 5 and len(w["applications"]) >= 8


def test_the_rule_reaches_kimi_in_the_prompt_for_this_territory(monkeypatch):
    import json
    import server
    seen = []
    monkeypatch.setattr(server, "call_kimi_llm", lambda prompt, **k: seen.append(prompt) or json.dumps([
        {"title": f"T{i}", "idea": "i", "guide": "dark", "prompt": " ".join("".join(chr(97 + ((i * 11 + j) // 26 ** q) % 26) for q in range(4)) for j in range(6))} for i in range(4)]))
    server.ask_kimi_for_prompts({"titles": {}, "prompts": {}}, "k", "m", count=2, world="Fashion & Apparel")
    assert "LEGIBILITY RULE" in seen[0] and "it disappears" in seen[0]
