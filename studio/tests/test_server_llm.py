"""Kimi-facing logic with a fake LLM: JSON parsing, world invention/matching, batch writing, critic hook."""

import json
import time

import pytest

import chapters

NEW_WORLD = {
    "name": "Harbor & Signal", "brief": "Ports at dusk.", "palette": "navy and cream",
    "applications": [f"subject {i}" for i in range(10)], "marks": [f"mark {i}" for i in range(5)],
}


WORDS = [
    "basalt monolith glacier lantern", "velvet harbor copper ribbon", "marble thunder orchid circuit", "saffron tundra mirror kiln",
    "ember glacier needle quartz", "linen reservoir comet scaffold", "ceramic aurora piston meadow", "obsidian tapestry falcon prism",
    "amber gravel lighthouse origami", "cobalt dune trumpet lattice",
]


def shots(n, prefix="Shot"):
    return [{"title": f"{prefix} {i}", "idea": f"idea {i}", "guide": "dark" if i % 2 == 0 else "light",
             "prompt": f"{WORDS[i]} scene"} for i in range(n)]


# ---------- parse_llm_json ----------

@pytest.mark.parametrize("text,opener,expected", [
    ('{"a": 1}', "{", {"a": 1}),
    ('Sure! {"a": 1} hope that helps', "{", {"a": 1}),
    ('{"a": 1} {"b": 2}', "{", {"a": 1}),                      # the "Extra data" bug
    ('```json\n[1, 2]\n```\nand also [3]', "[", [1, 2]),
    ('prefix [ {"x": [1,2]} , {"y": 2} ] tail', "[", [{"x": [1, 2]}, {"y": 2}]),
    ('{"nested": {"k": "}"}}', "{", {"nested": {"k": "}"}}),   # braces inside strings
])
def test_parse_llm_json(srv, text, opener, expected):
    assert srv.parse_llm_json(text, opener) == expected


def test_parse_llm_json_errors(srv):
    with pytest.raises(RuntimeError):
        srv.parse_llm_json("no json at all", "{")
    with pytest.raises(json_error()):
        srv.parse_llm_json("{broken", "{")


def json_error():
    return json.JSONDecodeError


# ---------- invent_world ----------

def test_invent_world_saves_and_flags_wildcard(srv, monkeypatch):
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "ok " + json.dumps(NEW_WORLD) + " trailing")
    st = {}
    w = srv.invent_world(st, "k", "kimi-k3", "harbour")
    assert w["name"] == "Harbor & Signal" and w["wildcard"] is True and w["weight"] == 1.0
    assert st["custom_worlds"][0]["name"] == "Harbor & Signal"
    assert "Harbor & Signal" in [x["name"] for x in chapters.all_worlds(st)]


def test_invent_world_replaces_same_name_instead_of_duplicating(srv, monkeypatch):
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: json.dumps(NEW_WORLD))
    st = {}
    srv.invent_world(st, "k", "m")
    srv.invent_world(st, "k", "m")
    assert len(st["custom_worlds"]) == 1


def test_invent_world_rejects_incomplete_worlds(srv, monkeypatch):
    bad = {k: v for k, v in NEW_WORLD.items() if k != "marks"}
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: json.dumps(bad))
    with pytest.raises(RuntimeError, match="marks"):
        srv.invent_world({}, "k", "m")


def test_invent_world_prompt_includes_direction_and_known_names(srv, monkeypatch):
    seen = {}
    monkeypatch.setattr(srv, "call_kimi_llm", lambda prompt, **k: seen.setdefault("p", prompt) and json.dumps(NEW_WORLD))
    srv.invent_world({}, "k", "m", "deep sea glow")
    assert "deep sea glow" in seen["p"] and "Editorial Print" in seen["p"]


# ---------- match_world ----------

def test_match_world_exact_name_case_insensitive(srv, monkeypatch):
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: ' "fashion & apparel" \n')
    assert srv.match_world({}, "k", "m", "wet apparel")["name"] == "Fashion & Apparel"


def test_match_world_new_unknown_or_error_returns_none(srv, monkeypatch):
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "NEW")
    assert srv.match_world({}, "k", "m", "x") is None
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "Totally Made Up")
    assert srv.match_world({}, "k", "m", "x") is None

    def boom(*a, **k):
        raise RuntimeError("network")
    monkeypatch.setattr(srv, "call_kimi_llm", boom)
    assert srv.match_world({}, "k", "m", "x") is None


def test_match_world_can_pick_a_custom_world(srv, monkeypatch):
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "Harbor & Signal")
    assert srv.match_world({"custom_worlds": [NEW_WORLD]}, "k", "m", "boats")["name"] == "Harbor & Signal"


# ---------- ask_kimi_for_prompts ----------

@pytest.fixture
def fake_llm(srv, monkeypatch):
    calls = []

    def llm(prompt, **k):
        calls.append(prompt)
        return json.dumps(shots(8))
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    return calls


def test_ask_kimi_trims_to_count_and_tags_world(srv, fake_llm):
    st = srv.load_state()
    out = srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=4, world="Editorial Print")
    assert len(out) == 4
    assert all(o["world"] == "Editorial Print" and o["prompt"] and o["title"] for o in out)
    assert st["recent_worlds"][-1] == "Editorial Print"
    assert "WORLD: Editorial Print" in fake_llm[0]


def test_ask_kimi_drops_near_duplicates_of_past_prompts(srv, fake_llm, monkeypatch):
    st = srv.load_state()
    st["prompts"]["old.jpg"] = shots(8)[0]["prompt"]
    out = srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=8, world="Editorial Print")
    assert shots(8)[0]["prompt"] not in [o["prompt"] for o in out]


def test_ask_kimi_direction_with_named_world_is_injected(srv, fake_llm):
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Fashion & Apparel", direction="wet, warm")
    assert "DIRECTOR'S DIRECTION" in fake_llm[0] and "wet, warm" in fake_llm[0]


def test_ask_kimi_direction_replaces_the_worlds_random_subjects(srv, fake_llm):
    w = chapters.pick_world(name="Nature & Light")
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=3, world="Nature & Light", direction="fog, clouds, lightning")
    p = fake_llm[0]
    assert "HARD REQUIREMENT" in p and "fog, clouds, lightning" in p
    assert "invent a DIFFERENT concrete subject" in p
    assert not any(f"subject = {a} " in p for a in w["applications"])      # no random world subjects when the director chose


def test_ask_kimi_without_direction_uses_the_worlds_subjects(srv, fake_llm):
    w = chapters.pick_world(name="Nature & Light")
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=3, world="Nature & Light")
    p = fake_llm[0]
    assert "HARD REQUIREMENT" not in p and "invent a DIFFERENT" not in p
    assert any(f"subject = {a} " in p for a in w["applications"])


def test_ask_kimi_custom_territory_invents_from_the_text(srv, monkeypatch):
    seen = []

    def llm(prompt, **k):
        seen.append(prompt)
        return json.dumps(NEW_WORLD) if "Invent ONE new creative world" in prompt else json.dumps(shots(6))
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="__custom__", direction="fog and rain")
    assert out[0]["world"] == "Harbor & Signal"
    assert "fog and rain" in seen[0] and not any("Which of these territories" in s for s in seen)


def test_ask_kimi_without_direction_has_no_direction_block(srv, fake_llm):
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Fashion & Apparel")
    assert "DIRECTOR'S DIRECTION" not in fake_llm[0]


def test_ask_kimi_direction_routes_to_matched_world(srv, monkeypatch):
    seq = []

    def llm(prompt, **k):
        seq.append(prompt)
        return "Fashion & Apparel" if "Which of these territories" in prompt else json.dumps(shots(6))
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=3, direction="wet apparel")
    assert out[0]["world"] == "Fashion & Apparel"
    assert not any("Invent ONE new creative world" in s for s in seq)


def test_ask_kimi_direction_with_no_match_invents(srv, monkeypatch):
    def llm(prompt, **k):
        if "Which of these territories" in prompt:
            return "NEW"
        if "Invent ONE new creative world" in prompt:
            return json.dumps(NEW_WORLD)
        return json.dumps(shots(6))
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    st = srv.load_state()
    out = srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=3, direction="harbour fog")
    assert out[0]["world"] == "Harbor & Signal"
    assert st["custom_worlds"][0]["name"] == "Harbor & Signal"


def test_ask_kimi_wildcard_always_invents(srv, monkeypatch):
    def llm(prompt, **k):
        return json.dumps(NEW_WORLD) if "Invent ONE new creative world" in prompt else json.dumps(shots(6))
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="__wildcard__")
    assert out[0]["world"] == "Harbor & Signal"


def test_ask_kimi_rejects_non_array_reply(srv, monkeypatch):
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "sorry, no")
    with pytest.raises(RuntimeError):
        srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Editorial Print")


def test_ask_kimi_records_recent_axes_for_diversity(srv, fake_llm):
    st = srv.load_state()
    srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=2, world="Editorial Print")
    assert st["recent_axes"]["camera"]


# ---------- apply_critic ----------

def verdict(v="trash"):
    return {"mean": 3.0, "reason": "weak mark", "scores": {"mark": 2}, "verdict": v}


def test_apply_critic_scores_but_does_not_trash_by_default(srv, monkeypatch, make_plate):
    make_plate(srv.PLATES_DIR / "a.jpg")
    srv.save_state({**srv.load_state(), "kimi_api_key": "k"})
    monkeypatch.setattr(srv.critic, "review_plate", lambda *a, **k: verdict())
    srv.apply_critic("a.jpg")
    st = srv.load_state()
    assert st["critic"]["a.jpg"]["reason"] == "weak mark"
    assert "a.jpg" not in st["trashed"]


def test_apply_critic_autotrash_marks_critic_failed(srv, monkeypatch, make_plate):
    make_plate(srv.PLATES_DIR / "a.jpg")
    srv.save_state({**srv.load_state(), "kimi_api_key": "k", "critic_autotrash": True})
    monkeypatch.setattr(srv.critic, "review_plate", lambda *a, **k: verdict())
    srv.apply_critic("a.jpg")
    st = srv.load_state()
    assert "a.jpg" in st["trashed"] and "a.jpg" in st["critic_failed"] and "a.jpg" in st["trashed_at"]


def test_apply_critic_autotrash_keeps_good_plates(srv, monkeypatch, make_plate):
    make_plate(srv.PLATES_DIR / "a.jpg")
    srv.save_state({**srv.load_state(), "kimi_api_key": "k", "critic_autotrash": True})
    monkeypatch.setattr(srv.critic, "review_plate", lambda *a, **k: verdict("keep"))
    srv.apply_critic("a.jpg")
    assert "a.jpg" not in srv.load_state()["trashed"]


def test_apply_critic_disabled_or_keyless_does_nothing(srv, monkeypatch, make_plate):
    make_plate(srv.PLATES_DIR / "a.jpg")
    called = []
    monkeypatch.setattr(srv.critic, "review_plate", lambda *a, **k: called.append(1) or verdict())
    srv.apply_critic("a.jpg")                                    # no key
    srv.save_state({**srv.load_state(), "kimi_api_key": "k", "critic_enabled": False})
    srv.apply_critic("a.jpg")                                    # disabled
    assert not called


def test_apply_critic_swallows_llm_errors(srv, monkeypatch, make_plate):
    make_plate(srv.PLATES_DIR / "a.jpg")
    srv.save_state({**srv.load_state(), "kimi_api_key": "k"})

    def boom(*a, **k):
        raise RuntimeError("timeout")
    monkeypatch.setattr(srv.critic, "review_plate", boom)
    srv.apply_critic("a.jpg")                                    # must not raise
    assert "a.jpg" not in srv.load_state().get("critic", {})


# ---------- call_kimi_llm key handling ----------

def test_call_kimi_llm_requires_key(srv):
    with pytest.raises(RuntimeError, match="NEEDS_KIMI_KEY"):
        srv.call_kimi_llm("hi", api_key="  ")
