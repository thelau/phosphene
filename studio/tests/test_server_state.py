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
    for k in ("trashed", "titles", "prompts", "models", "history"):
        assert st[k] in ([], {})
    assert [q["kind"] for q in st["sequences"]] == ["manual"] and st["active_sequence"] == st["sequences"][0]["id"]
    assert st["kimi_model"] == "kimi-k3"
    assert srv.CURATION_FILE.exists()


def test_load_state_recovers_from_corrupt_file(srv):
    srv.CURATION_FILE.write_text("{not json")
    assert srv.load_state()["trashed"] == []


def test_load_state_fills_missing_keys(srv):
    srv.CURATION_FILE.write_text(json.dumps({"trashed": ["a"]}))
    st = srv.load_state()
    assert st["trashed"] == ["a"] and st["history"] == [] and len(st["sequences"]) == 1


def test_state_roundtrip_preserves_extra_keys(srv):
    st = srv.load_state()
    st["history_demo"] = ["b", "a"]
    st["custom_worlds"] = [{"name": "X"}]
    srv.save_state(st)
    again = srv.load_state()
    assert again["history_demo"] == ["b", "a"] and again["custom_worlds"][0]["name"] == "X"


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
    st = {"order": ["3_c.jpg", "gone.jpg", "1_a.jpg"]}   # a save without sequences still works (legacy order)
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


def test_get_cached_qa_evaluates_once_and_writes_atomically(srv, make_plate, monkeypatch):
    p = make_plate(srv.PLATES_DIR / "a.jpg")
    calls = []
    monkeypatch.setattr(srv, "evaluate_plate_qa", lambda path, mark=None: calls.append(1) or {"qa_passed": True, "qa_score": 99})
    monkeypatch.setattr(srv, "_QA_LAST_FLUSH", 0.0)
    assert srv.get_cached_qa(p)["qa_score"] == 99
    assert srv.get_cached_qa(p)["qa_score"] == 99
    assert len(calls) == 1
    assert json.loads(srv.QA_CACHE_FILE.read_text())                      # valid JSON on disk
    assert not srv.QA_CACHE_FILE.with_suffix(".tmp").exists()             # no half-written temp left behind


def test_get_cached_qa_concurrent_requests_evaluate_once(srv, make_plate, monkeypatch):
    p = make_plate(srv.PLATES_DIR / "a.jpg")
    calls = []

    def slow(path, mark=None):
        calls.append(1)
        time.sleep(0.15)
        return {"qa_passed": True}

    monkeypatch.setattr(srv, "evaluate_plate_qa", slow)
    threads = [threading.Thread(target=srv.get_cached_qa, args=(p,)) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(calls) == 1


def test_get_cached_qa_flush_is_throttled(srv, make_plate, monkeypatch):
    monkeypatch.setattr(srv, "evaluate_plate_qa", lambda path, mark=None: {"qa_passed": True})
    flushes = []
    monkeypatch.setattr(srv, "_flush_qa_cache", lambda: flushes.append(1))
    monkeypatch.setattr(srv, "_QA_LAST_FLUSH", 0.0)
    for i in range(5):
        srv.get_cached_qa(make_plate(srv.PLATES_DIR / f"{i}.jpg", (i, i, i)))
    assert len(flushes) == 1


# ---------- restoring from trash ----------

# ---------- purging the trash ----------

def prepared(srv, make_plate, names=("20_a.jpg", "21_b.jpg", "22_c.jpg")):
    for n in names:
        make_plate(srv.PLATES_DIR / n)
    st = {"trashed": ["20_a.jpg", "21_b.jpg"], "order": list(names), "titles": {n: n for n in names},
          "prompts": {n: "p" for n in names}, "models": {n: "google/nano-banana-2.1" for n in names},
          "worlds": {n: "W" for n in names}, "qa_failed": ["21_b.jpg"]}
    srv.QA_CACHE.update({f"{n}:{(srv.PLATES_DIR / n).stat().st_size}": {"qa_passed": True} for n in names})
    return st


def test_purge_deletes_only_trashed_files_and_reports_size(srv, make_plate):
    st = prepared(srv, make_plate)
    deleted, freed = srv.purge_plates(st, ["20_a.jpg", "22_c.jpg", "nope.jpg"])      # 22_c is kept: must survive
    assert deleted == 1 and freed > 0
    assert not (srv.PLATES_DIR / "20_a.jpg").exists()
    assert (srv.PLATES_DIR / "22_c.jpg").exists() and (srv.PLATES_DIR / "21_b.jpg").exists()


def test_purge_keeps_the_learning_record_but_drops_order_and_qa_cache(srv, make_plate):
    st = prepared(srv, make_plate)
    srv.purge_plates(st, ["20_a.jpg", "21_b.jpg"])
    for key in ("titles", "prompts", "models", "worlds"):
        assert "20_a.jpg" in st[key]                        # taste and territory scores still see it
    assert "20_a.jpg" in st["trashed"] and "21_b.jpg" in st["qa_failed"]
    assert st["purged"] == ["20_a.jpg", "21_b.jpg"]
    assert st["order"] == ["22_c.jpg"]                      # legacy order list is cleaned too
    assert not any(k.startswith(("20_a.jpg:", "21_b.jpg:")) for k in srv.QA_CACHE)
    assert any(k.startswith("22_c.jpg:") for k in srv.QA_CACHE)


def test_purged_plates_still_count_for_model_and_world_scores(srv, make_plate):
    import chapters, taste
    st = prepared(srv, make_plate)
    st["worlds"] = {"20_a.jpg": "Matter & Elements", "21_b.jpg": "Matter & Elements", "22_c.jpg": "Matter & Elements"}
    before_models, before_worlds = taste.model_stats(st)["google/nano-banana-2.1"], chapters.world_stats(st)["Matter & Elements"]
    srv.purge_plates(st, ["20_a.jpg", "21_b.jpg"])
    assert taste.model_stats(st)["google/nano-banana-2.1"] == before_models
    assert chapters.world_stats(st)["Matter & Elements"] == before_worlds


def test_purge_nothing_and_twice_are_safe(srv, make_plate):
    st = prepared(srv, make_plate)
    assert srv.purge_plates(st, []) == (0, 0)
    srv.purge_plates(st, ["20_a.jpg"])
    assert srv.purge_plates(st, ["20_a.jpg"]) == (0, 0)
    assert st["purged"] == ["20_a.jpg"]


def test_next_plate_number_never_reuses_a_purged_number(srv, make_plate):
    st = prepared(srv, make_plate, names=("30_a.jpg", "31_b.jpg", "32_c.jpg"))
    st["trashed"] = ["32_c.jpg"]
    assert srv.next_plate_number(st) == 33
    srv.purge_plates(st, ["32_c.jpg"])                    # the highest-numbered file is gone from disk...
    assert not (srv.PLATES_DIR / "32_c.jpg").exists()
    assert srv.next_plate_number(st) == 33                # ...but its number is still taken
    for f in srv.PLATES_DIR.glob("*.jpg"):
        f.unlink()
    assert srv.next_plate_number({}) == 16               # an empty library starts at 16


# ---------- sequences wired into the server ----------

def test_ordered_plate_files_follows_the_active_sequence(srv, make_plate):
    import sequences
    for n in ("1_a.jpg", "2_b.jpg", "3_c.jpg"):
        make_plate(srv.PLATES_DIR / n)
    st = srv.load_state()
    manual = st["active_sequence"]
    sequences.reorder_active(st, ["3_c.jpg", "1_a.jpg", "2_b.jpg"])
    ai = sequences.add_ai(st, ["2_b.jpg", "3_c.jpg", "1_a.jpg"])
    assert [p.name for p in srv.ordered_plate_files(st)] == ["2_b.jpg", "3_c.jpg", "1_a.jpg"]
    sequences.activate(st, manual)
    assert [p.name for p in srv.ordered_plate_files(st)] == ["3_c.jpg", "1_a.jpg", "2_b.jpg"]


def test_sequences_survive_save_and_load(srv):
    import sequences
    st = srv.load_state()
    sequences.add_ai(st, ["x", "y"], summary="s")
    srv.save_state(st)
    again = srv.load_state()
    assert [s["name"] for s in again["sequences"]] == ["Manual", "AI"] and again["active_sequence"] == st["active_sequence"]
    assert again["sequences"][1]["original"] == ["x", "y"]
    assert "order" not in again


def test_purge_removes_images_from_every_sequence(srv, make_plate):
    import sequences
    for n in ("20_a.jpg", "21_b.jpg"):
        make_plate(srv.PLATES_DIR / n)
    st = srv.load_state()
    st["trashed"] = ["20_a.jpg"]
    sequences.reorder_active(st, ["20_a.jpg", "21_b.jpg"])
    sequences.add_ai(st, ["21_b.jpg", "20_a.jpg"])
    srv.purge_plates(st, ["20_a.jpg"])
    assert all("20_a.jpg" not in s["order"] for s in st["sequences"])


def test_plate_key_of_another_mark_follows_its_size_and_place(srv, make_plate, monkeypatch):
    """Changed in Project settings, the mark's size or place: every image is measured again against the new ones (DEMO's keys stay)."""
    p = make_plate(srv.PLATES_DIR / "a.jpg")
    monkeypatch.setattr(srv, "is_demo", lambda: False)
    monkeypatch.setattr(srv, "PROJECT", {**srv.PROJECT, "mark_size": 18.0, "mark_x": 50.0, "mark_y": 50.0})
    k18 = srv._plate_key(p)
    srv.PROJECT["mark_size"] = 24.0
    assert srv._plate_key(p) != k18


def test_a_damaged_state_file_is_set_aside_never_written_over(srv):
    """It held the whole curation: a read that fails must not replace it with an empty one (the audit's worst finding)."""
    srv.CURATION_FILE.write_text('{"trashed": ["a.jpg"], "order": ["b.jpg"], "groups": [{"id": "g"')   # cut off mid-write
    st = srv.load_state()
    assert st["trashed"] == []
    kept = list(srv.CURATION_FILE.parent.glob(f"{srv.CURATION_FILE.stem}.damaged-*"))
    assert len(kept) == 1 and '"order": ["b.jpg"]' in kept[0].read_text(), "the damaged file is kept, whole, beside it"


def test_saving_and_reading_the_curation_at_once_never_loses_it(srv):
    """Parallel image saves, polling and trash clicks: a reader never sees half a file, so never starts the curation over."""
    import threading
    srv.save_state({"trashed": ["keep.jpg"], "order": [f"{i}.jpg" for i in range(3000)], "titles": {f"{i}.jpg": "t" * 40 for i in range(3000)}})
    bad, stop = [], threading.Event()
    def writer():
        while not stop.is_set():
            st = srv.load_state(); st["order"] = list(reversed(st["order"])); srv.save_state(st)
    def reader():
        for _ in range(150):
            if srv.load_state()["trashed"] != ["keep.jpg"]:
                bad.append(1)
    ws = [threading.Thread(target=writer) for _ in range(2)]; rs = [threading.Thread(target=reader) for _ in range(3)]
    for t in ws + rs: t.start()
    for t in rs: t.join()
    stop.set()
    for t in ws: t.join()
    assert bad == [] and not list(srv.CURATION_FILE.parent.glob("*.damaged-*")), "never read half-written, never reset"
