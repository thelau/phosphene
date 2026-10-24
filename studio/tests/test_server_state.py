"""State, secrets, ordering, QA cache."""

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
    st["order"] = ["b", "a"]
    st["custom_worlds"] = [{"name": "X"}]
    srv.save_state(st)
    again = srv.load_state()
    assert again["order"] == ["b", "a"] and again["custom_worlds"][0]["name"] == "X"


# ---------- prompt wrapper (position wording must never be softened) ----------

def test_build_full_prompt_keeps_exact_position_wording(srv):
    p = srv.build_full_prompt("A glass cube")
    assert p.startswith("A glass cube")
    for needle in ("EXACT DEAD-CENTER", "50% horizontal, 50% vertical", "~18% frame width", "SINGLE circular mark", "no extra outer rings", "9:16"):
        assert needle in p


# ---------- ordering ----------

def test_ordered_plate_files_respects_order_then_appends_new(srv, make_plate):
    for n in ("1_a.jpg", "2_b.jpg", "3_c.jpg"):
        make_plate(srv.PLATES_DIR / n)
    st = {"order": ["3_c.jpg", "gone.jpg", "1_a.jpg"]}
    assert [p.name for p in srv.ordered_plate_files(st)] == ["3_c.jpg", "1_a.jpg", "2_b.jpg"]


def test_ordered_plate_files_without_any_saved_order_is_by_name(srv, make_plate):
    for n in ("2_b.jpg", "1_a.jpg"):
        make_plate(srv.PLATES_DIR / n)
    assert [p.name for p in srv.ordered_plate_files({})] == ["1_a.jpg", "2_b.jpg"]


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


def test_moved_to_end_keeps_the_relative_order_of_several_restored_images(srv):
    assert srv.moved_to_end(["c", "a", "x", "b"], {"a", "b", "c"}) == ["x", "c", "a", "b"]


def test_moved_to_end_handles_names_missing_from_the_order(srv):
    assert srv.moved_to_end(["a", "b"], {"zzz"}) == ["a", "b", "zzz"]
    assert srv.moved_to_end([], {"a"}) == ["a"]
