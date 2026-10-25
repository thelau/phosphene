import json
import threading

import pytest

import gen_log as G


@pytest.fixture(autouse=True)
def tmp_log(tmp_path, monkeypatch):
    monkeypatch.setattr(G, "LOG_FILE", tmp_path / "log.jsonl")


def test_record_writes_one_json_line_per_event_and_read_returns_them_in_order():
    G.record("server_start", port=8765)
    G.record("image", ok=True, title="Ünïcode — fine", seconds=12.5)
    lines = G.LOG_FILE.read_text().splitlines()
    assert len(lines) == 2 and all(json.loads(l)["event"] for l in lines)
    ev = G.read()
    assert [e["event"] for e in ev] == ["server_start", "image"] and ev[1]["title"] == "Ünïcode — fine"
    assert {"ts", "t"} <= set(ev[0])


def test_read_without_a_log_is_empty_and_skips_damaged_lines():
    assert G.read() == []
    G.LOG_FILE.write_text('{"event": "a", "ts": "x"}\nnot json at all\n{"event": "b", "ts": "y"}\n')
    assert [e["event"] for e in G.read()] == ["a", "b"]
    assert [e["event"] for e in G.read(1)] == ["b"]


def test_logging_can_never_break_a_generation(monkeypatch, tmp_path):
    monkeypatch.setattr(G, "LOG_FILE", tmp_path / "no" / "such" / "dir" / "log.jsonl")
    G.record("image", ok=True)                               # must not raise


def test_many_threads_write_whole_lines():
    ts = [threading.Thread(target=lambda i=i: [G.record("image", ok=True, n=i, pad="x" * 200) for _ in range(40)]) for i in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(G.read(None)) == 320


def test_the_file_rotates_instead_of_growing_forever(monkeypatch):
    monkeypatch.setattr(G, "MAX_BYTES", 2000)
    for i in range(60):
        G.record("image", ok=True, pad="y" * 100)
    assert G.LOG_FILE.with_suffix(".jsonl.1").exists() and G.LOG_FILE.stat().st_size < 4000


def img(i, ok=True, **kw):
    return {"event": "image", "ts": "t", "id": i, "ok": ok, "seconds": 20.0, "attempts": [{"n": 1}], **kw}


def test_summary_counts_ok_failed_logo_failures_retries_and_restarts():
    ev = [{"event": "server_start", "ts": "t"}, img("a"), img("b", ok=False, error="x"), img("c", qa_passed=False), img("d", attempts=[{"n": 1}, {"n": 2}]),
          {"event": "server_start", "ts": "t"}]
    s = G.summarize(ev)
    assert (s["images"], s["ok"], s["failed"], s["logo_check_failed"], s["retried"], s["restarts"]) == (4, 3, 1, 1, 1, 2)
    assert s["avg_seconds"] == 20.0


def test_an_image_whose_result_never_came_and_a_restart_followed_is_flagged_interrupted():
    start = lambda i: {"event": "image_start", "ts": "t", "id": i, "title": f"T{i}"}
    ev = [{"event": "server_start", "ts": "t"}, start("1"), start("2"), img("1"), {"event": "server_start", "ts": "t"}]
    lost = G.interrupted(ev)
    assert [e["id"] for e in lost] == ["2"] and G.summarize(ev)["interrupted"] == 1
    assert G.interrupted(ev[:4]) == []                       # no restart after it: it may simply still be running


def test_describe_lines_read_like_sentences():
    assert "server started" in G.describe({"event": "server_start", "ts": "T", "port": 8765})
    ok = G.describe(img("a", filename="865_x.jpg", world="Out-of-Home & City", qa_passed=True, qa_score=99))
    assert "OK" in ok and "865_x.jpg" in ok and "logo check passed" in ok and "Out-of-Home" in ok
    bad = G.describe(img("a", ok=False, title="Lost", error="Krea 429", attempts=[{"n": 1}, {"n": 2}, {"n": 3}]))
    assert "FAILED" in bad and "Lost" in bad and "Krea 429" in bad and "3 attempts" in bad
    q = G.describe(img("a", filename="1.jpg", qa_passed=False, qa_score=10, qa_issues=["Low center logo fidelity"]))
    assert "LOGO CHECK FAILED" in q and "trash" in q
    b = G.describe({"event": "batch", "ts": "T", "ok": True, "world": "Fashion", "asked": 8, "from_kimi": 8, "dropped_duplicates": 1, "returned": 8, "seconds": 9, "direction": "wet"})
    assert "Fashion" in b and "asked 8" in b and "1 near-duplicates dropped" in b and "wet" in b


def test_cli_prints_a_summary_and_can_show_only_failures(capsys, monkeypatch):
    G.record("server_start", port=1)
    G.record("image_start", id="1", title="Gone", model="m", guide="dark")
    G.record("image", id="2", ok=True, title="Fine", filename="1_fine.jpg", seconds=10, attempts=[{"n": 1}], qa_passed=True, qa_score=90)
    G.record("image", id="3", ok=False, title="Broken", seconds=5, attempts=[{"n": 1}], error="Krea down")
    G.record("server_start", port=1)
    monkeypatch.setattr("sys.argv", ["gen_log", "--failures"])
    G.main()
    out = capsys.readouterr().out
    assert "2 ok" not in out and "1 ok, 1 failed" in out and "1 interrupted" in out
    assert "Broken" in out and "Gone" in out and "INTERRUPTED" in out and "1_fine.jpg" not in out
    monkeypatch.setattr("sys.argv", ["gen_log"])
    G.main()
    assert "1_fine.jpg" in capsys.readouterr().out


def test_cli_with_no_log_says_so(capsys, monkeypatch):
    monkeypatch.setattr("sys.argv", ["gen_log"])
    G.main()
    assert "No log yet" in capsys.readouterr().out
