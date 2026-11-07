"""dev runner, bench status parsing, bench job, repair helper."""

import io
import json
import time

import pytest
from PIL import Image

import bench
import sequences
import bench_status
import dev


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


def test_dev_respawns_after_a_normal_run_but_not_a_crash_loop():
    assert dev.respawn_now(60.0) is True            # killed or died after running a while: bring it back
    assert dev.respawn_now(0.4) is False            # died right after starting: wait for an edit


def test_dev_restarts_a_killed_server_and_survives_a_crash_loop(tmp_path, monkeypatch):
    """Drive dev.main() with fake processes: killed after a long run -> respawned; instant crash -> not respawned until an edit."""
    class P:
        def __init__(self, dead_after):
            self.dead_after, self.returncode, self.n = dead_after, None, 0

        def poll(self):
            self.n += 1
            if self.dead_after is not None and self.n > self.dead_after:
                self.returncode = -15
            return self.returncode

        def send_signal(self, s): pass
        def wait(self, t): pass
        def kill(self): pass

    procs = [P(1), P(0), P(None)]          # 1st dies after a long run, 2nd crashes instantly, 3rd is fine
    started = []
    monkeypatch.setattr(dev, "start", lambda: started.append(1) or procs[len(started) - 1])
    monkeypatch.setattr(dev, "snapshot", lambda: {})
    now = [0.0]
    monkeypatch.setattr(dev.time, "time", lambda: now[0])
    ticks = []

    def fake_sleep(s):
        ticks.append(1)
        if len(ticks) == 1:
            now[0] = 100.0                  # the first server has been up for a long time when it dies
        if len(ticks) > 6:
            raise KeyboardInterrupt
    monkeypatch.setattr(dev.time, "sleep", fake_sleep)
    dev.main()
    assert len(started) == 2                # initial start + one respawn; the instant crash is not retried in a loop


def test_dev_restarts_once_for_several_quick_saves(monkeypatch):
    """Three files saved one after another (an edit session) must cause a single restart, not three."""
    from pathlib import Path as P_
    a, b, c = P_("a.py"), P_("b.py"), P_("c.py")
    snaps = iter([{}, {a: 1}, {a: 1, b: 2}, {a: 1, b: 2, c: 3}, {a: 1, b: 2, c: 3}])
    last = {}

    def snapshot():
        nonlocal last
        last = next(snaps, last)
        return last

    class P:
        returncode = None
        def poll(self): return None
        def send_signal(self, s): pass
        def wait(self, t): pass
        def kill(self): pass

    started = []
    monkeypatch.setattr(dev, "start", lambda: started.append(1) or P())
    monkeypatch.setattr(dev, "snapshot", snapshot)
    monkeypatch.setattr(dev, "server_busy", lambda: False)
    ticks = []

    def fake_sleep(s):
        ticks.append(1)
        if len(ticks) > 12:
            raise KeyboardInterrupt
    monkeypatch.setattr(dev.time, "sleep", fake_sleep)
    dev.main()
    assert len(started) == 2                 # the first start + exactly one restart


# ---------- bench.run_one (fake Krea) ----------

def png(color):
    b = io.BytesIO()
    Image.new("RGB", (60, 100), color).save(b, "PNG")
    return b.getvalue()


@pytest.fixture
def bench_env(srv, monkeypatch):
    return srv                                       # bench writes into the open project's plates (srv's, in tmp)


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
    assert st["models"][f] == "google/nano-banana-2.1" and f not in st["trashed"] and sequences.get_order(st)[-1] == f


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


# ---------- export naming ----------

def test_export_filename_is_descriptive_and_unique_per_second(srv):
    import time as _t
    ts = _t.mktime((2026, 10, 25, 9, 30, 5, 0, 0, -1))
    assert srv.export_filename(136, 4, ts) == "Demo-136bpm-x4-20261025-093005.mp4"
    assert srv.export_filename(136.4, 1.3333333, ts) == "Demo-136bpm-x1.33-20261025-093005.mp4"
    assert srv.export_filename(120, 2, ts, "mono", "out") == "Demo-120bpm-x2-invert-zoomout-20261025-093005.mp4"
    assert srv.export_filename(120, 2, ts, edit="Night · fast strobe!") == "Night-fast-strobe-120bpm-x2-20261025-093005.mp4"   # an edit's name first, made safe
    assert srv.export_filename(120, 2, ts, "off", "off").count("-invert") == 0
    assert srv.export_filename(120, 2, ts) != srv.export_filename(120, 2, ts + 1)


def test_prune_exports_keeps_newest_and_ignores_other_files(srv, tmp_path):
    import os, time as _t
    for i in range(5):
        f = tmp_path / f"Demo-120bpm-x1-20261020-10000{i}.mp4"
        f.write_bytes(b"x")
        os.utime(f, (_t.time() + i, _t.time() + i))
    for i, name in enumerate(["Phosphene-120bpm-x2-20261027-100000.mp4", "Night-strobe-120bpm-x2-20261027-100001.mp4"]):
        f = tmp_path / name                                                     # today's names, an edit's name first: the newest
        f.write_bytes(b"x")
        os.utime(f, (_t.time() + 10 + i, _t.time() + 10 + i))
    other = tmp_path / "keepme.mp4"
    other.write_bytes(b"x")
    srv.prune_exports(tmp_path, keep=3)
    assert sorted(p.name for p in tmp_path.glob("*.mp4")) == ["Demo-120bpm-x1-20261020-100004.mp4", "Night-strobe-120bpm-x2-20261027-100001.mp4", "Phosphene-120bpm-x2-20261027-100000.mp4", "keepme.mp4"]


def test_exports_have_no_audio_options_left(srv):
    import inspect
    src = inspect.getsource(srv)
    assert "atempo" not in src and "MUSIC_BPM" not in src and '"-an"' in src


# ---------- never restart under a running job ----------

def test_dev_waits_for_a_running_job_before_restarting(monkeypatch, capsys):
    states = iter([True, True, True, False, False])                  # busy for three checks, then idle twice
    monkeypatch.setattr(dev, "server_busy", lambda: next(states))
    slept = []
    monkeypatch.setattr(dev.time, "sleep", slept.append)
    dev.wait_until_idle(max_wait=60, poll=0.5)
    assert len(slept) == 4                                           # it kept waiting until two idle checks in a row
    assert capsys.readouterr().out.count("restarting when it finishes") == 1       # and said so once


def test_dev_does_not_wait_forever(monkeypatch):
    monkeypatch.setattr(dev, "server_busy", lambda: True)
    clock = [0.0]
    monkeypatch.setattr(dev.time, "time", lambda: clock[0])
    monkeypatch.setattr(dev.time, "sleep", lambda s: clock.__setitem__(0, clock[0] + 100))
    dev.wait_until_idle(max_wait=250, poll=1)
    assert clock[0] >= 250


def test_dev_treats_an_unreachable_server_as_idle(monkeypatch):
    monkeypatch.setenv("PORT", "1")                                  # nothing listens there
    assert dev.server_busy() is False


def test_dev_defers_the_restart_while_busy(monkeypatch):
    from pathlib import Path as P_
    snaps = iter([{}, {P_("a.py"): 1}, {P_("a.py"): 1}, {P_("a.py"): 1}])
    last = {}

    def snapshot():
        nonlocal last
        last = next(snaps, last)
        return last

    class Proc:
        returncode = None
        def poll(self): return None
        def send_signal(self, s): pass
        def wait(self, t): pass
        def kill(self): pass

    events = []
    monkeypatch.setattr(dev, "start", lambda: events.append("start") or Proc())
    monkeypatch.setattr(dev, "snapshot", snapshot)
    monkeypatch.setattr(dev, "wait_until_idle", lambda *a, **k: events.append("waited"))
    ticks = []

    def fake_sleep(s):
        ticks.append(1)
        if len(ticks) > 8:
            raise KeyboardInterrupt
    monkeypatch.setattr(dev.time, "sleep", fake_sleep)
    dev.main()
    assert events == ["start", "waited", "start"]                    # it waited for idle before the second start


def test_dev_starts_the_server_with_the_repo_venv_python_when_there_is_one(tmp_path, monkeypatch):
    """The venv has Pillow and pytest; the system Python may not."""
    fake_root = tmp_path / "repo"
    (fake_root / "studio").mkdir(parents=True)
    monkeypatch.setattr(dev, "HERE", fake_root / "studio")
    assert dev.server_python() == dev.sys.executable                       # no venv: the Python running dev.py
    (fake_root / ".venv" / "bin").mkdir(parents=True)
    (fake_root / ".venv" / "bin" / "python").write_text("")
    assert dev.server_python() == str(fake_root / ".venv" / "bin" / "python")
