"""dev runner, bench status parsing, bench job, repair helper."""

import io
import json
import time

import pytest
from PIL import Image

import bench
import bench_status
import dev
import diegetic_engine as de


# ---------- bench_status ----------

def test_bench_status_parsing(tmp_path, monkeypatch):
    log = tmp_path / "l.log"
    monkeypatch.setattr(bench_status, "LOG", log)
    assert "inventing scenes" in bench_status.status()                       # no log yet
    log.write_text("[KIMI] titles: ['a']\n")
    assert "1 batches ready" in bench_status.status()
    log.write_text("[BENCH] 4 images, 3 workers\n[BENCH] 10_a.jpg m qa=PASS score=80\n[BENCH] 11_b.jpg m qa=FAIL score=10\n[BENCH] FAIL m x: boom\n")
    assert bench_status.status() == "3/4 images (2 made, 1 errors, 1 logo-fail)"
    log.write_text(log.read_text() + "[BENCH] 12_c.jpg m qa=PASS score=70\n[BENCH] done\n")
    assert bench_status.status().endswith("DONE")


# ---------- dev runner ----------

def test_dev_snapshot_tracks_py_files_but_not_itself(tmp_path, monkeypatch):
    (tmp_path / "a.py").write_text("x")
    (tmp_path / "dev.py").write_text("x")
    (tmp_path / "notes.txt").write_text("x")
    monkeypatch.setattr(dev, "HERE", tmp_path)
    snap = dev.snapshot()
    assert {p.name for p in snap} == {"a.py"}
    time.sleep(0.01)
    (tmp_path / "a.py").write_text("changed")
    import os
    os.utime(tmp_path / "a.py", (time.time() + 5, time.time() + 5))
    assert dev.snapshot() != snap


# ---------- bench.run_one (fake Krea) ----------

def png(color):
    b = io.BytesIO()
    Image.new("RGB", (60, 100), color).save(b, "PNG")
    return b.getvalue()


@pytest.fixture
def bench_env(srv, monkeypatch):
    monkeypatch.setattr(bench, "PLATES_DIR", srv.PLATES_DIR)
    monkeypatch.setattr(srv, "REJECTED_DIR", srv.PLATES_DIR.parent / "rej")
    srv.REJECTED_DIR.mkdir()
    monkeypatch.setattr(srv, "apply_critic", lambda f: None)
    monkeypatch.setattr(bench.server, "apply_critic", lambda f: None)
    return srv


def test_bench_run_one_saves_plate_and_state(bench_env, monkeypatch):
    srv = bench_env
    monkeypatch.setattr(bench, "generate_plate_via_krea_mcp", lambda **kw: png((10, 10, 10)))
    monkeypatch.setattr(srv, "get_cached_qa", lambda p: {"qa_passed": True, "qa_score": 90})
    bench.run_one(("Cool Shot", "raw prompt", "dark", "google/nano-banana-2.1", "Editorial Print", "an idea"))
    files = list(srv.PLATES_DIR.glob("*.jpg"))
    assert len(files) == 1 and files[0].name.startswith("16_")
    st = srv.load_state()
    f = files[0].name
    assert st["titles"][f] == "[bench] Cool Shot" and st["worlds"][f] == "Editorial Print" and st["ideas"][f] == "an idea"
    assert st["models"][f] == "google/nano-banana-2.1" and f not in st["trashed"] and st["order"][-1] == f


def test_bench_run_one_trashes_logo_failures(bench_env, monkeypatch):
    srv = bench_env
    monkeypatch.setattr(bench, "generate_plate_via_krea_mcp", lambda **kw: png((10, 10, 10)))
    monkeypatch.setattr(srv, "get_cached_qa", lambda p: {"qa_passed": False, "qa_score": 5})
    bench.run_one(("Bad", "raw", "light", "google/nano-banana-pro", None, None))
    st = srv.load_state()
    f = next(srv.PLATES_DIR.glob("*.jpg")).name
    assert f in st["trashed"] and f in st["qa_failed"] and f in st["trashed_at"] and f not in st.get("worlds", {})


def test_bench_run_one_numbers_are_sequential_and_survive_krea_errors(bench_env, monkeypatch, capsys):
    srv = bench_env
    monkeypatch.setattr(srv, "get_cached_qa", lambda p: {"qa_passed": True, "qa_score": 90})
    monkeypatch.setattr(bench, "generate_plate_via_krea_mcp", lambda **kw: png((10, 10, 10)))
    bench.run_one(("One", "r", "dark", "m/x", None, None))
    bench.run_one(("Two", "r", "dark", "m/x", None, None))
    assert sorted(p.name[:2] for p in srv.PLATES_DIR.glob("*.jpg")) == ["16", "17"]

    def boom(**kw):
        raise RuntimeError("krea down")
    monkeypatch.setattr(bench, "generate_plate_via_krea_mcp", boom)
    bench.run_one(("Three", "r", "dark", "m/x", None, None))          # must not raise
    assert len(list(srv.PLATES_DIR.glob("*.jpg"))) == 2
    assert "[BENCH] FAIL" in capsys.readouterr().out


def test_bench_runway_prompt_is_capped_and_mentions_mark():
    p = bench.runway_prompt("x" * 5000)
    assert len(p) <= 1000 and p.endswith("no extra rings.")


def test_bench_runway_prompt_short_input_kept():
    assert bench.runway_prompt("short").startswith("short")


# ---------- repair helper ----------

def test_heal_circular_patch_copies_clean_texture_over_target():
    im = Image.new("RGB", (400, 400), (0, 0, 255))
    from PIL import ImageDraw
    ImageDraw.Draw(im).ellipse((140, 140, 260, 260), fill=(255, 0, 0))     # the thing to heal at (200,200)
    out = de.heal_circular_patch(im, 200, 200, 60, sample_dx=0, sample_dy=-130)   # clean blue patch from above
    assert out.getpixel((200, 200)) == (0, 0, 255)
    assert im.getpixel((200, 200)) == (255, 0, 0)                           # original untouched
    assert out.size == im.size
