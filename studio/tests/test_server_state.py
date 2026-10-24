"""State, secrets, ordering, tone, QA cache."""

import json
import os
import threading
import time

import pytest
from PIL import Image


# ---------- secrets & state ----------

def test_save_state_never_writes_the_key_into_curation_file(srv):
    srv.save_state({"trashed": [], "kimi_api_key": "sk-secret"})
    assert "sk-secret" not in srv.CURATION_FILE.read_text()
    assert json.loads(srv.SECRETS_FILE.read_text())["kimi_api_key"] == "sk-secret"
    assert oct(srv.SECRETS_FILE.stat().st_mode & 0o777) == "0o600"


def test_load_state_reads_key_from_secrets(srv):
    srv.SECRETS_FILE.write_text(json.dumps({"kimi_api_key": "sk-abc"}))
    assert srv.load_state()["kimi_api_key"] == "sk-abc"


def test_load_state_env_fallback(srv, monkeypatch):
    monkeypatch.setenv("MOONSHOT_API_KEY", "sk-env")
    assert srv.load_state()["kimi_api_key"] == "sk-env"


def test_secrets_win_over_env(srv, monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "sk-env")
    srv.SECRETS_FILE.write_text(json.dumps({"kimi_api_key": "sk-file"}))
    assert srv.load_state()["kimi_api_key"] == "sk-file"


def test_load_state_defaults_when_missing(srv):
    st = srv.load_state()
    for k in ("trashed", "titles", "prompts", "models", "history", "order"):
        assert st[k] in ([], {})
    assert st["kimi_model"] == "kimi-k3"
    assert srv.CURATION_FILE.exists()


def test_load_state_recovers_from_corrupt_file(srv):
    srv.CURATION_FILE.write_text("{not json")
    assert srv.load_state()["trashed"] == []


def test_load_state_fills_missing_keys(srv):
    srv.CURATION_FILE.write_text(json.dumps({"trashed": ["a"]}))
    st = srv.load_state()
    assert st["trashed"] == ["a"] and st["order"] == [] and st["history"] == []


def test_state_roundtrip_preserves_extra_keys(srv):
    st = srv.load_state()
    st["twin_of"] = {"b": "a"}
    st["custom_worlds"] = [{"name": "X"}]
    srv.save_state(st)
    again = srv.load_state()
    assert again["twin_of"] == {"b": "a"} and again["custom_worlds"][0]["name"] == "X"


# ---------- prompt wrapper (position wording must never be softened) ----------

def test_build_full_prompt_keeps_exact_position_wording(srv):
    p = srv.build_full_prompt("A glass cube")
    assert p.startswith("A glass cube")
    for needle in ("EXACT DEAD-CENTER", "50% horizontal, 50% vertical", "~18% frame width", "SINGLE circular mark", "no extra outer rings", "9:16"):
        assert needle in p


# ---------- twins & ordering ----------

def test_glue_twins_moves_twin_right_after_original(srv):
    assert srv.glue_twins(["a", "x", "b", "a2"], {"a2": "a"}) == ["a", "a2", "x", "b"]


def test_glue_twins_multiple_twins_sorted(srv):
    assert srv.glue_twins(["a", "t2", "t1"], {"t1": "a", "t2": "a"}) == ["a", "t1", "t2"]


def test_glue_twins_ignores_missing_pairs_and_keeps_everyone(srv):
    out = srv.glue_twins(["a", "b"], {"ghost": "a", "b": "gone"})
    assert out == ["a", "b"]


def test_glue_twins_no_duplicates_and_idempotent(srv):
    order = ["a", "b", "b2", "c"]
    once = srv.glue_twins(order, {"b2": "b"})
    assert once == order and srv.glue_twins(once, {"b2": "b"}) == once
    assert len(set(once)) == len(once)


def test_ordered_plate_files_respects_order_then_appends_new(srv, make_plate):
    for n in ("1_a.jpg", "2_b.jpg", "3_c.jpg"):
        make_plate(srv.PLATES_DIR / n)
    st = {"order": ["3_c.jpg", "gone.jpg", "1_a.jpg"], "twin_of": {}}
    assert [p.name for p in srv.ordered_plate_files(st)] == ["3_c.jpg", "1_a.jpg", "2_b.jpg"]


def test_ordered_plate_files_applies_twin_glue(srv, make_plate):
    for n in ("1_a.jpg", "2_b.jpg", "3_a_twin.jpg"):
        make_plate(srv.PLATES_DIR / n)
    st = {"order": ["1_a.jpg", "2_b.jpg", "3_a_twin.jpg"], "twin_of": {"3_a_twin.jpg": "1_a.jpg"}}
    assert [p.name for p in srv.ordered_plate_files(st)] == ["1_a.jpg", "3_a_twin.jpg", "2_b.jpg"]


# ---------- tone ----------

def test_plate_tone_dark_and_light(srv, make_plate):
    assert srv.plate_tone(make_plate(srv.PLATES_DIR / "d.jpg", (10, 10, 10))) == "dark"
    assert srv.plate_tone(make_plate(srv.PLATES_DIR / "l.jpg", (240, 240, 240))) == "light"


def test_plate_tone_threshold(srv, make_plate):
    assert srv.plate_tone(make_plate(srv.PLATES_DIR / "m1.jpg", (100, 100, 100))) == "dark"
    assert srv.plate_tone(make_plate(srv.PLATES_DIR / "m2.jpg", (125, 125, 125))) == "light"


def test_cached_tone_survives_mtime_changes(srv, make_plate, monkeypatch):
    p = make_plate(srv.PLATES_DIR / "x.jpg", (10, 10, 10))
    calls = []
    real = srv.plate_tone
    monkeypatch.setattr(srv, "plate_tone", lambda path: calls.append(1) or real(path))
    assert srv.cached_tone(p) == "dark"
    os.utime(p, (1, 1))          # what a git checkout does
    assert srv.cached_tone(p) == "dark"
    assert len(calls) == 1


# ---------- QA cache ----------

def test_plate_key_uses_size_not_mtime(srv, make_plate):
    p = make_plate(srv.PLATES_DIR / "a.jpg")
    k1 = srv._plate_key(p)
    os.utime(p, (123, 123))
    assert srv._plate_key(p) == k1 == f"a.jpg:{p.stat().st_size}"


def test_migrate_qa_cache_rekeys_old_mtime_entries(srv, make_plate, monkeypatch):
    p = make_plate(srv.PLATES_DIR / "a.jpg")
    monkeypatch.setattr(srv, "REJECTED_DIR", srv.PLATES_DIR.parent / "rej")
    srv.QA_CACHE["a.jpg:1792745756"] = {"qa_passed": True}
    srv.QA_CACHE["gone.jpg:1792745756"] = {"qa_passed": False}
    srv._migrate_qa_cache()
    assert srv.QA_CACHE[f"a.jpg:{p.stat().st_size}"] == {"qa_passed": True}
    assert not any(k.startswith("gone.jpg:") and k != "gone.jpg:1792745756" for k in srv.QA_CACHE)


def test_get_cached_qa_evaluates_once_and_writes_atomically(srv, make_plate, monkeypatch):
    p = make_plate(srv.PLATES_DIR / "a.jpg")
    calls = []
    monkeypatch.setattr(srv, "evaluate_plate_qa", lambda path: calls.append(1) or {"qa_passed": True, "qa_score": 99})
    monkeypatch.setattr(srv, "_QA_LAST_FLUSH", 0.0)
    assert srv.get_cached_qa(p)["qa_score"] == 99
    assert srv.get_cached_qa(p)["qa_score"] == 99
    assert len(calls) == 1
    assert json.loads(srv.QA_CACHE_FILE.read_text())                      # valid JSON on disk
    assert not srv.QA_CACHE_FILE.with_suffix(".tmp").exists()             # no half-written temp left behind


def test_get_cached_qa_concurrent_requests_evaluate_once(srv, make_plate, monkeypatch):
    p = make_plate(srv.PLATES_DIR / "a.jpg")
    calls = []

    def slow(path):
        calls.append(1)
        time.sleep(0.15)
        return {"qa_passed": True}

    monkeypatch.setattr(srv, "evaluate_plate_qa", slow)
    threads = [threading.Thread(target=srv.get_cached_qa, args=(p,)) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(calls) == 1


def test_get_cached_qa_flush_is_throttled(srv, make_plate, monkeypatch):
    monkeypatch.setattr(srv, "evaluate_plate_qa", lambda path: {"qa_passed": True})
    flushes = []
    monkeypatch.setattr(srv, "_flush_qa_cache", lambda: flushes.append(1))
    monkeypatch.setattr(srv, "_QA_LAST_FLUSH", 0.0)
    for i in range(5):
        srv.get_cached_qa(make_plate(srv.PLATES_DIR / f"{i}.jpg", (i, i, i)))
    assert len(flushes) == 1


# ---------- restoring from trash ----------

def test_moved_to_end_puts_restored_images_last_and_keeps_the_rest(srv):
    assert srv.moved_to_end(["a", "b", "c", "d"], {"b"}) == ["a", "c", "d", "b"]


def test_moved_to_end_keeps_original_before_its_twin(srv):
    out = srv.moved_to_end(["t", "a", "x", "y"], {"t", "a"})        # twin happened to sit before its original
    assert out[:2] == ["x", "y"] and set(out[2:]) == {"t", "a"}
    assert srv.moved_to_end(["a", "a2", "x"], {"a", "a2"}) == ["x", "a", "a2"]


def test_moved_to_end_handles_names_missing_from_the_order(srv):
    assert srv.moved_to_end(["a", "b"], {"zzz"}) == ["a", "b", "zzz"]
    assert srv.moved_to_end([], {"a"}) == ["a"]
