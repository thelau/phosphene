"""Kimi-facing logic with a fake LLM: JSON parsing, world invention/matching, batch writing."""

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
    out = srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=7, world="Editorial Print")      # 7 fresh ones exist: the copy is left out
    assert shots(8)[0]["prompt"] not in [o["prompt"] for o in out] and len(out) == 7


def test_ask_kimi_direction_with_named_world_is_injected(srv, fake_llm):
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Fashion & Apparel", direction="wet, warm")
    assert "DIRECTOR'S DIRECTION" in fake_llm[0] and "wet, warm" in fake_llm[0]


def test_ask_kimi_direction_replaces_the_worlds_random_subjects(srv, fake_llm):
    w = next(w for w in chapters.WORLDS if w["name"] == "Nature & Light")
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=3, world="Nature & Light", direction="fog, clouds, lightning")
    p = fake_llm[0]
    assert "HARD REQUIREMENT" in p and "fog, clouds, lightning" in p
    assert "invent a DIFFERENT concrete subject" in p
    assert "NOT a menu" not in p                                           # no territory flavour list when the director chose
    assert not any(f"subject = {a} " in p for a in w["applications"])


def test_a_refinement_sets_the_light_too_not_only_the_subject(srv, fake_llm):
    # "dark busy megalopolis streets at night" came back half pale: every other shot was asked to be LIGHT, and each had a random light (overcast daylight...)
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=4, world="Out-of-Home & City", direction="dark busy megalopolis streets at night")
    p = fake_llm[-1]
    assert "if it says night, every shot is at night" in p and "they win over this alternation" in p
    assert "optional inspiration: camera" in p and "optional inspiration: light" not in p
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Out-of-Home & City")
    assert "they win over this alternation" not in fake_llm[-1] and "vary subject, framing and light" in fake_llm[-1]   # no direction: as before


def test_describe_your_own_keeps_your_words_and_every_batch_follows_them(srv, monkeypatch):
    brief = "Night markets in Taipei.\nSteam, neon reflected in wet tarmac, hands at work.\nNever a face; never daylight."
    seen = []
    def llm(prompt, **k):
        seen.append(prompt)
        return json.dumps(NEW_WORLD) if "Invent ONE new creative world" in prompt else json.dumps(shots(8))
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    st = srv.load_state()
    srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=4, world="__custom__", direction=brief)
    w = next(x for x in st["custom_worlds"] if x["name"] == "Harbor & Signal")
    assert w["origin"] == "custom" and w["prompt"] == brief                   # kept as written, newlines and all
    first = seen[1]
    assert first.count(brief) == 1 and "THE DIRECTOR'S BRIEF" in first        # the first batch reads it once, as the brief
    assert "HARD REQUIREMENT" not in first
    srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=4, world="Harbor & Signal")
    assert brief in seen[-1] and "THE DIRECTOR'S BRIEF" in seen[-1]            # and every later batch of it too
    srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=4, world="Harbor & Signal", direction="only the fruit stalls")
    assert brief in seen[-1] and "only the fruit stalls" in seen[-1]          # a refinement narrows it, the brief stays
    seen.clear()
    srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=4, world="Editorial Print")
    assert "THE DIRECTOR'S BRIEF" not in seen[0]                              # a built-in territory has none


def test_a_loose_batch_tells_kimi_where_each_shots_mark_goes(srv, fake_llm):
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=4, world="Editorial Print", target="loose")
    p = fake_llm[-1]
    assert "each shot at its own place and size" in p and "dead-center position" not in p
    assert all(o["placement"] and o["placement"]["kind"] == "loose" for o in out)
    for o in out:                                                            # the place each scene was written for travels with it
        pl = o["placement"]
        assert f"the mark: the {srv.frame_area(pl['x'], pl['y'])}, exact point ({pl['x']:g}% across, {pl['y']:g}% down), ~{pl['size']:g}% frame width" in p
    exact = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Editorial Print")
    assert all(o["placement"] is None for o in exact) and "the mark: exact point" not in fake_llm[-1] and "dead-center position" in fake_llm[-1]


def test_a_big_mark_asks_kimi_for_subjects_that_can_carry_it(srv, fake_llm, monkeypatch):
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Editorial Print")
    assert "one small" in fake_llm[-1] and "the mark is big" not in fake_llm[-1]       # a mark at 18%: "one small"
    monkeypatch.setitem(srv.PROJECT, "mark_size", 50.0)                                # Halo's ring: half the frame's width
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Editorial Print")
    assert "one large" in fake_llm[-1] and "one small" not in fake_llm[-1]
    assert "never a small object" in fake_llm[-1]


def test_ask_kimi_without_direction_makes_kimi_invent_the_subjects(srv, fake_llm):
    w = next(w for w in chapters.WORLDS if w["name"] == "Packaging & Product")
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=8, world="Packaging & Product")
    p = fake_llm[0]
    assert "HARD REQUIREMENT" not in p
    assert p.count("invent a fresh, specific object or scene") == 10          # every shot asks for its own invented subject
    assert not any(f"subject = {a} " in p for a in w["applications"])        # the hand-written list is no longer assigned
    assert "NOT a menu" in p
    shown = [a for a in w["applications"] if a in p]
    assert 1 <= len(shown) <= 5                                              # only a few as flavour, never the whole list


def test_ask_kimi_remembers_subjects_and_tells_kimi_to_avoid_them_next_time(srv, monkeypatch):
    seen = []
    batch = [{"title": f"T{i}", "subject": f"Subject number {i}", "idea": "i", "guide": "dark", "prompt": f"{WORDS[i]} scene"} for i in range(6)]
    monkeypatch.setattr(srv, "call_kimi_llm", lambda prompt, **k: seen.append(prompt) or json.dumps(batch))
    st = srv.load_state()
    out = srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=4, world="Packaging & Product")
    assert out[0]["subject"] == "Subject number 0"
    assert "Subject number 0" in st["recent_subjects"]["Packaging & Product"]
    assert "Subjects already used here recently" not in seen[0]
    srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=4, world="Packaging & Product")
    assert "Subjects already used here recently" in seen[1] and "Subject number 0" in seen[1]


def test_recent_subjects_memory_is_capped_per_territory(srv, monkeypatch):
    batch = [{"title": f"T{i}", "subject": f"S{i}", "idea": "i", "guide": "dark", "prompt": f"{WORDS[i]} scene"} for i in range(6)]
    monkeypatch.setattr(srv, "call_kimi_llm", lambda prompt, **k: json.dumps(batch))
    st = srv.load_state()
    st["recent_subjects"] = {"Packaging & Product": [f"old{i}" for i in range(80)]}
    srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=4, world="Packaging & Product")
    mem = st["recent_subjects"]["Packaging & Product"]
    assert len(mem) == 60 and mem[-1].startswith("S")


def test_ask_kimi_without_direction_has_no_direction_block(srv, fake_llm):
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="Fashion & Apparel")
    assert "DIRECTOR'S DIRECTION" not in fake_llm[0]


def test_ask_kimi_custom_territory_invents_from_the_text(srv, monkeypatch):
    seen = []

    def llm(prompt, **k):
        seen.append(prompt)
        return json.dumps(NEW_WORLD) if "Invent ONE new creative world" in prompt else json.dumps(shots(6))
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=2, world="__custom__", direction="fog and rain")
    assert out[0]["world"] == "Harbor & Signal"
    assert "fog and rain" in seen[0] and not any("Which of these territories" in s for s in seen)


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


def test_call_kimi_llm_requires_key(srv):
    with pytest.raises(RuntimeError, match="NEEDS_KIMI_KEY"):
        srv.call_kimi_llm("hi", api_key="  ")


def test_the_batch_size_you_ask_for_is_respected_even_when_near_duplicates_are_dropped(srv, monkeypatch):
    # 10 asked of Kimi, 4 of them near-copies of past prompts: the 8 requested must still come back
    st = srv.load_state()
    batch = [{"title": f"T{i}", "subject": f"s{i}", "idea": "i", "guide": "dark", "prompt": f"{WORDS[i]} scene"} for i in range(10)]
    for i in range(4):
        st["prompts"][f"old{i}.jpg"] = batch[i]["prompt"]
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: json.dumps(batch))
    out = srv.ask_kimi_for_prompts(st, "k", "kimi-k3", count=8, world="Editorial Print")
    assert len(out) == 8
    assert {o["title"] for o in out} >= {f"T{i}" for i in range(4, 10)}                  # the fresh ones come first


def test_fewer_ideas_than_asked_from_kimi_gives_what_there_is(srv, monkeypatch):
    batch = [{"title": f"T{i}", "idea": "i", "guide": "dark", "prompt": f"{WORDS[i]} scene"} for i in range(3)]
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: json.dumps(batch))
    assert len(srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=8, world="Editorial Print")) == 3


# ---------- you get the number you asked for ----------

def tok(n):
    """A distinct letters-only word per number (the duplicate filter only looks at letters)."""
    return "".join(chr(97 + (n // 26 ** k) % 26) for k in range(4))


def unique_scenes(start, n):
    return [{"title": f"Scene {start + i}", "subject": f"s{start + i}", "idea": "i", "guide": "dark" if i % 2 == 0 else "light",
             "prompt": " ".join(tok((start + i) * 11 + j) for j in range(6))} for i in range(n)]


def scripted_kimi(srv, monkeypatch, answers):
    """Kimi answers with the next scripted list each time it is asked for scenes."""
    asked, it = [], iter(answers)

    def llm(prompt, **k):
        asked.append(prompt)
        try:
            return json.dumps(next(it))
        except StopIteration:
            return json.dumps([])
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    return asked


def test_a_short_answer_from_kimi_is_followed_up_for_just_the_missing_scenes(srv, monkeypatch):
    asked = scripted_kimi(srv, monkeypatch, [unique_scenes(0, 6), unique_scenes(100, 4)])           # asked for 10, only 6 written
    stats = {}
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=8, world="Fashion & Apparel", stats=stats)
    assert len(out) == 8 and len({o["title"] for o in out}) == 8
    assert len(asked) == 2 and " of 4 objects" in asked[1]                                           # the follow-up asks for the missing 2 (+2 spare)
    assert "Scene 0" in asked[1]                                                                      # and is told what already exists
    assert stats["wanted"] == 8 and stats["returned"] == 8 and stats["kimi_calls"] == 2


def test_big_batches_are_asked_in_chunks_of_at_most_ten(srv, monkeypatch):
    asked = scripted_kimi(srv, monkeypatch, [unique_scenes(0, 12), unique_scenes(200, 12)])
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=20, world="Fashion & Apparel")
    assert len(out) == 20 and len({o["title"] for o in out}) == 20
    assert len(asked) == 2 and "12 objects" in asked[0] and "12 objects" in asked[1]                  # 10 + 2 spare, twice
    assert all(o["world"] == "Fashion & Apparel" for o in out)


def test_a_batch_of_exactly_ten_or_fewer_is_one_request(srv, monkeypatch):
    asked = scripted_kimi(srv, monkeypatch, [unique_scenes(0, 10)])
    assert len(srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=8, world="Fashion & Apparel")) == 8
    assert len(asked) == 1 and "10 objects" in asked[0]


def test_kimi_repeating_itself_does_not_loop_forever_or_duplicate_scenes(srv, monkeypatch):
    same = unique_scenes(0, 3)
    asked = scripted_kimi(srv, monkeypatch, [same] * 10)
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=8, world="Fashion & Apparel")
    assert len(out) == 3 and len({o["title"] for o in out}) == 3                                      # what exists, once each
    assert len(asked) <= 4


def test_a_failing_follow_up_still_returns_what_was_written(srv, monkeypatch):
    calls = []

    def llm(prompt, **k):
        calls.append(1)
        if len(calls) == 1:
            return json.dumps(unique_scenes(0, 5))
        raise RuntimeError("Kimi timed out")
    monkeypatch.setattr(srv, "call_kimi_llm", llm)
    assert len(srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=8, world="Fashion & Apparel")) == 5


def test_a_failing_first_request_is_reported_not_swallowed(srv, monkeypatch):
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "no json")
    with pytest.raises(RuntimeError):
        srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=4, world="Fashion & Apparel")


def test_topping_up_never_adds_a_copy_of_a_scene_already_in_the_batch(srv, monkeypatch):
    dup = unique_scenes(0, 1)
    asked = scripted_kimi(srv, monkeypatch, [dup + [dict(dup[0], title="Same again")] + unique_scenes(50, 2)])
    out = srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=4, world="Fashion & Apparel")
    assert "Same again" not in [o["title"] for o in out] and len(out) == 3


def test_the_log_line_explains_the_spare_scenes(srv, monkeypatch, capsys):
    scripted_kimi(srv, monkeypatch, [unique_scenes(0, 10)])
    srv.ask_kimi_for_prompts(srv.load_state(), "k", "kimi-k3", count=8, world="Fashion & Apparel")
    out = capsys.readouterr().out
    assert "asking Kimi for 10 scenes (8 wanted + 2 spare in case some are near-duplicates)" in out and "sending 8 scenes to Krea" in out


def test_kimi_error_keeps_the_first_endpoints_failure(srv, monkeypatch):
    """The first endpoint times out; the others answer 401. The message must still say what happened first."""
    import io
    import urllib.error

    def fake_open(req, timeout=0):
        if "moonshot.ai" in req.full_url:
            raise TimeoutError("read timed out")
        raise urllib.error.HTTPError(req.full_url, 401, "no", {}, io.BytesIO(b'{"error":"invalid key"}'))

    monkeypatch.setattr(srv.urllib.request, "urlopen", fake_open)
    with pytest.raises(RuntimeError) as e:
        srv.call_kimi_llm("hi", "sk-abc")
    assert "read timed out" in str(e.value) and "HTTP 401" in str(e.value)


def test_kimi_timeout_is_retried_once_on_the_same_model(srv, monkeypatch):
    import io
    calls = []

    class Resp(io.BytesIO):
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_open(req, timeout=0):
        calls.append((json.loads(req.data)["model"], timeout))
        if len(calls) == 1:
            raise TimeoutError("The read operation timed out")
        return Resp(json.dumps({"choices": [{"message": {"content": " done "}}]}).encode())

    monkeypatch.setattr(srv.urllib.request, "urlopen", fake_open)
    assert srv.call_kimi_llm("hi", "sk-abc") == "done"
    assert [m for m, _ in calls] == ["kimi-k3", "kimi-k3"] and calls[0][1] >= 120
