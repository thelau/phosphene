import json

import critic


def llm_returning(data):
    return lambda *a, **k: "```json\n" + json.dumps(data) + "\n```"


def ok(path, **over):
    d = {"hero": 8, "craft": 8, "idea": 8, "mark": 8, "design": 8, "reason": "strong"}
    d.update(over)
    return critic.review_plate(path, llm_returning(d), "k", "m")


def test_keep_when_mean_high_and_mark_ok(tmp_path, make_plate):
    r = ok(make_plate(tmp_path / "a.jpg"))
    assert r["verdict"] == "keep" and r["mean"] == 8.0
    assert set(r["scores"]) == {"hero", "craft", "idea", "mark", "design"}


def test_trash_when_mean_below_threshold(tmp_path, make_plate):
    r = ok(make_plate(tmp_path / "a.jpg"), hero=5, craft=5, idea=5, mark=5, design=5)
    assert r["mean"] == 5.0 and r["verdict"] == "trash"


def test_keep_at_exactly_threshold(tmp_path, make_plate):
    r = ok(make_plate(tmp_path / "a.jpg"), hero=6, craft=6, idea=6, mark=6, design=6)
    assert r["verdict"] == "keep"


def test_weak_mark_disqualifies_even_with_high_mean(tmp_path, make_plate):
    r = ok(make_plate(tmp_path / "a.jpg"), hero=10, craft=10, idea=10, mark=3, design=10)
    assert r["mean"] >= critic.KEEP_AT and r["verdict"] == "trash"


def test_missing_scores_count_as_zero_and_reason_is_trimmed(tmp_path, make_plate):
    r = critic.review_plate(make_plate(tmp_path / "a.jpg"), llm_returning({"hero": 9, "reason": "x" * 400}), "k", "m")
    assert r["scores"]["mark"] == 0.0 and r["verdict"] == "trash" and len(r["reason"]) == 120


def test_llm_receives_a_jpeg(tmp_path, make_plate):
    seen = {}

    def llm(prompt, key, model, images=None, system=None):
        seen["img"] = images[0]
        return json.dumps({"hero": 7, "craft": 7, "idea": 7, "mark": 7, "design": 7})
    critic.review_plate(make_plate(tmp_path / "a.jpg"), llm, "k", "m")
    assert seen["img"][:2] == b"\xff\xd8"
