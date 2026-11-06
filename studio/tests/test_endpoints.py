"""
The real HTTP server on a random port, with state, plates and secrets in a temp folder and fake Krea / Kimi.
Not exhaustive: it exists so a deleted or broken endpoint (it happened once) fails a test instead of the user's afternoon.
"""

import http.client
import io
import json
import subprocess
import threading
import time

import pytest
from PIL import Image

import sequences
from server import find_tool as srv_tool


@pytest.fixture
def live(srv, monkeypatch):
    png = io.BytesIO()
    Image.new("RGB", (64, 112), (30, 90, 200)).save(png, "PNG")
    calls = {"krea": [], "kimi": []}
    monkeypatch.setattr(srv, "get_krea_oauth_token", lambda: {"connected": True, "expired": False, "token": "t"})
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", lambda **kw: calls["krea"].append(kw) or png.getvalue())
    monkeypatch.setattr(srv, "check_new_image", lambda p, pl=None, mark_id=None: {"qa_passed": True, "qa_score": 90, "issues": [], "center_corr": 0.9, "core_asymmetry": 0.2})
    real_popen = srv.subprocess.Popen                                  # only the browser-login helper is faked, ffmpeg etc. stay real
    monkeypatch.setattr(srv.subprocess, "Popen", lambda cmd, *a, **k: None if "opencode" in str(cmd) else real_popen(cmd, *a, **k))
    monkeypatch.setattr(srv, "TARGET_W", 54)
    monkeypatch.setattr(srv, "TARGET_H", 96)
    monkeypatch.setattr(srv, "OUTPUTS_DIR", srv.PLATES_DIR.parent / "outputs")
    (srv.PLATES_DIR.parent / "outputs").mkdir(exist_ok=True)
    monkeypatch.setattr(srv.features, "CACHE_FILE", srv.PLATES_DIR.parent / "feat.json")
    monkeypatch.setattr(srv.features, "_CACHE", {})
    shots = [{"title": f"Shot {i}", "subject": f"subject {i}", "idea": "an idea", "guide": "dark" if i % 2 == 0 else "light", "prompt": f"{w} scene"}
             for i, w in enumerate(["basalt monolith glacier", "velvet harbor copper", "marble thunder orchid", "saffron tundra mirror", "ember glacier needle", "linen reservoir comet"])]

    def fake_kimi(prompt, **k):
        calls["kimi"].append(prompt)
        return json.dumps(shots)
    monkeypatch.setattr(srv, "call_kimi_llm", fake_kimi)
    monkeypatch.setattr(srv, "check_kimi_key", lambda key, timeout=8: "refused" if "bad" in key else "ok")   # no network: a key with "bad" in it is refused
    # Jobs live in a module-level dict: never let one test's background job leak into the next. By default a started job finishes instantly.
    srv.AI_JOBS.clear()
    real_job = srv.run_ai_order_job
    monkeypatch.setattr(srv, "run_ai_order_job", lambda job_id, *a, **k: srv.AI_JOBS[job_id].update(done=True, step=4, stage="Done"))
    st = srv.load_state()
    st["kimi_api_key"] = "sk-test"
    srv.save_state(st)
    httpd = srv.QuietServer(("127.0.0.1", 0), srv.StudioHandler)
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True).start()   # the default 0.5 s made every test wait at its end
    port = httpd.server_address[1]

    def call(method, path, body=None, raw=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
        if raw is not None:        # a file sent as it is (the music track)
            c.request(method, path, body=raw, headers={"Content-Type": "application/octet-stream"})
        else:
            c.request(method, path, body=json.dumps(body or {}) if method == "POST" else None, headers={"Content-Type": "application/json", **(headers or {})})
        r = c.getresponse()
        raw = r.read()
        try:
            data = json.loads(raw)
        except Exception:
            data = raw
        c.close()
        return r.status, data
    call.calls = calls
    call.real_job = real_job
    call.port = port
    yield call
    httpd.shutdown()
    httpd.server_close()
    srv.AI_JOBS.clear()


GET_ENDPOINTS = ["/api/state", "/api/worlds", "/api/stats", "/api/version", "/api/projects"]
POST_ENDPOINTS = ["/api/save-settings", "/api/reorder", "/api/sequence", "/api/trash", "/api/purge", "/api/invent-prompts", "/api/generate-image", "/api/order-ai", "/api/export-video", "/api/export-audio", "/api/export-frame", "/api/groups", "/api/edits", "/api/projects"]


@pytest.mark.parametrize("path", GET_ENDPOINTS)
def test_every_get_endpoint_exists_and_answers_json(live, path):
    status, data = live("GET", path)
    assert status == 200 and isinstance(data, dict), (path, status)


@pytest.mark.parametrize("path", POST_ENDPOINTS)
def test_every_post_endpoint_exists(live, path):
    status, data = live("POST", path, {})
    assert status != 404 and isinstance(data, dict), (path, status, data)


def test_the_page_or_a_pointer_to_it_is_served_at_the_root(live):
    status, data = live("GET", "/")
    page = data if isinstance(data, bytes) else b""
    assert status == 200 and (b"Match-Cut Studio" in page or b"<title>Phosphene" in page), "the built page when there is one, else a pointer to it"


def test_generate_trash_restore_delete_through_the_real_server(live, srv):
    # 1. Kimi writes the scenes
    status, data = live("POST", "/api/invent-prompts", {"count": 3, "world": "Editorial Print"})
    assert status == 200 and data["ok"] and len(data["ideas"]) == 3 and data["ideas"][0]["world"] == "Editorial Print"

    # 2. each scene is rendered by (fake) Krea and saved as a plate
    names = []
    for idea in data["ideas"]:
        status, res = live("POST", "/api/generate-image", {"title": idea["title"], "prompt": idea["prompt"], "guide": idea["guide"], "world": idea["world"], "idea": idea["idea"], "model": "google/nano-banana-2.1"})
        assert status == 200 and res["ok"] and res["qa_passed"], res
        names.append(res["filename"])
    assert len(set(names)) == 3 and all((srv.PLATES_DIR / n).exists() for n in names)
    assert all("dead-center" in k["prompt"].lower() or "DEAD-CENTER" in k["prompt"] for k in live.calls["krea"])      # the logo wording was added
    assert [k["model"] for k in live.calls["krea"]] == ["google/nano-banana-2.1"] * 3

    # 3. they show up, in order, in both orders, with their metadata
    _, state = live("GET", "/api/state")
    shown = [p["filename"] for p in state["plates"]]
    assert shown == names
    assert state["plates"][0]["world"] == "Editorial Print" and state["plates"][0]["model"] == "google/nano-banana-2.1"
    assert [s["kind"] for s in state["sequences"]] == ["manual"] and state["sequences"][0]["count"] == 3

    # 4. trash one, restore it: it comes back at the end
    assert live("POST", "/api/trash", {"filename": names[0], "trashed": True})[1]["ok"]
    _, state = live("GET", "/api/state")
    assert [p["filename"] for p in state["plates"] if p["trashed"]] == [names[0]]
    live("POST", "/api/trash", {"filename": names[0], "trashed": False})
    _, state = live("GET", "/api/state")
    assert [p["filename"] for p in state["plates"] if not p["trashed"]] == [names[1], names[2], names[0]]

    # 5. reorder, then delete for good (only trashed images can be deleted)
    live("POST", "/api/reorder", {"order": [names[2], names[1], names[0]]})
    _, state = live("GET", "/api/state")
    assert [p["filename"] for p in state["plates"]] == [names[2], names[1], names[0]]
    status, res = live("POST", "/api/purge", {"filenames": [names[1]]})
    assert res["deleted"] == 0 and (srv.PLATES_DIR / names[1]).exists()                      # a kept image is never deleted
    live("POST", "/api/trash", {"filename": names[1], "trashed": True})
    status, res = live("POST", "/api/purge", {"filenames": [names[1]]})
    assert res["deleted"] == 1 and not (srv.PLATES_DIR / names[1]).exists()
    _, state = live("GET", "/api/state")
    assert names[1] not in [p["filename"] for p in state["plates"]]


def test_ai_order_job_runs_through_the_real_server_and_locks_changes_meanwhile(live, srv, monkeypatch):
    import time
    for i in range(6):
        status, res = live("POST", "/api/generate-image", {"title": f"T{i}", "prompt": f"p{i}", "guide": "dark", "model": "google/nano-banana-2.1"})
        assert res["ok"]
    gate = threading.Event()
    real = srv.build_ai_order

    def slow(*a, **k):
        gate.wait(5)
        return real(*a, **k)
    monkeypatch.setattr(srv, "build_ai_order", slow)
    monkeypatch.setattr(srv, "run_ai_order_job", live.real_job)                             # this test wants the real background job
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "{}")
    status, start = live("POST", "/api/order-ai", {"length": None})
    assert status == 200 and start["ok"] and len(start["steps"]) == 4
    try:
        status, res = live("POST", "/api/trash", {"filename": "x", "trashed": True})
        assert status == 409 and res["busy"]                                                  # selection is locked while the AI works
        assert live("POST", "/api/generate-image", {"title": "x", "prompt": "x"})[0] == 409
        assert live("POST", "/api/order-ai", {})[0] == 409                                    # and only one job at a time
    finally:
        gate.set()
    for _ in range(100):
        _, job = live("GET", f"/api/order-ai-status?job={start['job']}")
        if job.get("done"):
            break
        time.sleep(0.1)
    assert job["done"] and not job.get("error") and job["sequence"]["name"] == "AI"
    _, state = live("GET", "/api/state")
    assert [(s["kind"], s["count"]) for s in state["sequences"]] == [("manual", 6), ("ai", 6)]
    assert state["active_sequence"] == [s["id"] for s in state["sequences"] if s["kind"] == "ai"][0]
    assert live("POST", "/api/trash", {"filename": state["plates"][0]["filename"], "trashed": True})[0] == 200    # unlocked again

    # switch back to Manual, convert AI -> Manual, reset
    ai_id = state["active_sequence"]
    manual_id = [s["id"] for s in state["sequences"] if s["kind"] == "manual"][0]
    assert live("POST", "/api/sequence", {"action": "activate", "id": manual_id})[1]["ok"]
    assert live("POST", "/api/sequence", {"action": "activate", "id": ai_id})[1]["ok"]
    assert live("POST", "/api/sequence", {"action": "make_manual"})[1]["ok"]
    assert live("POST", "/api/sequence", {"action": "nonsense"})[0] == 400


# ---------- retries, failure logs and the busy flag ----------

def test_generate_with_retry_recovers_from_transient_errors(srv, monkeypatch):
    attempts, waits, logs = [], [], []

    def flaky(**kw):
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("Krea 429 too many requests")
        return b"IMG"
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", flaky)
    out = srv.generate_with_retry(sleep=waits.append, log=lambda *a, **k: logs.append(a[0]), prompt="p", model="m")
    assert out == b"IMG" and len(attempts) == 3 and waits == [3.0, 8.0]
    assert len(logs) == 2 and "429" in logs[0] and "retrying" in logs[0]


def test_generate_with_retry_gives_up_after_three_and_raises_the_last_error(srv, monkeypatch):
    def always(**kw):
        raise RuntimeError("boom")
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", always)
    with pytest.raises(RuntimeError, match="boom"):
        srv.generate_with_retry(sleep=lambda s: None, log=lambda *a, **k: None, prompt="p")


@pytest.mark.parametrize("message", ["Krea MCP is not connected.", "HTTP Error 401: Unauthorized", "HTTP Error 403: Forbidden"])
def test_generate_with_retry_does_not_retry_login_problems(srv, monkeypatch, message):
    calls = []

    def denied(**kw):
        calls.append(1)
        raise RuntimeError(message)
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", denied)
    with pytest.raises(RuntimeError):
        srv.generate_with_retry(sleep=lambda s: None, log=lambda *a, **k: None, prompt="p")
    assert len(calls) == 1


def test_a_failed_image_is_logged_and_reported(live, srv, monkeypatch, capsys):
    def broken(**kw):
        raise RuntimeError("Krea said no")
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", broken)
    monkeypatch.setattr(srv.time, "sleep", lambda s: None)
    status, res = live("POST", "/api/generate-image", {"title": "Lost One", "prompt": "p", "guide": "light", "model": "google/nano-banana-2.1"})
    assert status == 500 and not res["ok"] and "Krea said no" in res["error"]
    out = capsys.readouterr().out
    assert "[GENERATE] FAILED 'Lost One'" in out and "Krea said no" in out


def test_busy_flag_follows_running_generation_and_ai_jobs(live, srv):
    assert live("GET", "/api/busy")[1] == {"ok": True, "busy": False}
    with srv.inflight():
        assert live("GET", "/api/busy")[1]["busy"] is True
        with srv.inflight():
            assert srv.busy()
        assert srv.busy()
    assert live("GET", "/api/busy")[1]["busy"] is False
    srv.AI_JOBS["j"] = {"done": False}
    assert live("GET", "/api/busy")[1]["busy"] is True
    srv.AI_JOBS.clear()


# ---------- the written record ----------

import gen_log


def test_a_generation_leaves_a_batch_record_and_an_image_record(live, srv, capsys):
    live("POST", "/api/invent-prompts", {"count": 3, "world": "Fashion & Apparel", "direction": "wet"})
    _, ideas = live("POST", "/api/invent-prompts", {"count": 3, "world": "Fashion & Apparel"})
    status, res = live("POST", "/api/generate-image", {"title": ideas["ideas"][0]["title"], "prompt": "p", "guide": "light", "world": "Fashion & Apparel", "model": "google/nano-banana-2.1"})
    assert res["ok"]
    events = gen_log.read(None)
    kinds = [e["event"] for e in events]
    assert kinds == ["batch", "batch", "image_start", "image"]
    batch = events[0]
    assert batch["ok"] and batch["asked"] == 3 and batch["world"] == "Fashion & Apparel" and batch["direction"] == "wet" and batch["returned"] == 3
    assert batch["titles"] == ["Shot 0", "Shot 1", "Shot 2"] and "seconds" in batch and batch["from_kimi"] == 6
    start, done = events[2], events[3]
    assert start["id"] == done["id"] and done["ok"] and done["filename"] == res["filename"] and done["model"] == "google/nano-banana-2.1"
    assert done["attempts"] == [{"n": 1, "ok": True, "seconds": done["attempts"][0]["seconds"]}] and done["qa_passed"] is True and done["qa_score"] == 90
    assert f"[GENERATE] OK {res['filename']}" in capsys.readouterr().out


def test_a_failed_generation_is_written_down_with_every_attempt(live, srv, monkeypatch):
    def broken(**kw):
        raise RuntimeError("Krea 429: slow down")
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", broken)
    monkeypatch.setattr(srv.time, "sleep", lambda s: None)
    status, res = live("POST", "/api/generate-image", {"title": "Lost One", "prompt": "p", "guide": "dark", "world": "W", "model": "google/nano-banana-2.1"})
    assert status == 500
    done = [e for e in gen_log.read(None) if e["event"] == "image"][0]
    assert done["ok"] is False and "429" in done["error"] and done["title"] == "Lost One"
    assert [a["n"] for a in done["attempts"]] == [1, 2, 3] and all(not a["ok"] for a in done["attempts"])
    assert gen_log.summarize(gen_log.read(None))["failed"] == 1


def test_a_retry_that_works_is_recorded_as_one_ok_image_with_two_attempts(live, srv, monkeypatch):
    real, n = srv.generate_plate_via_krea_mcp, []

    def flaky(**kw):
        n.append(1)
        if len(n) == 1:
            raise RuntimeError("timeout")
        return real(**kw)
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", flaky)
    monkeypatch.setattr(srv.time, "sleep", lambda s: None)
    assert live("POST", "/api/generate-image", {"title": "Second Time", "prompt": "p", "model": "m"})[1]["ok"]
    done = [e for e in gen_log.read(None) if e["event"] == "image"][0]
    assert done["ok"] and [a["ok"] for a in done["attempts"]] == [False, True] and gen_log.summarize(gen_log.read(None))["retried"] == 1


def test_every_image_is_made_with_the_one_model_whatever_the_request_says(live, srv, monkeypatch):
    # a batch saved before the menu went still carries its old choice; Resume sends nothing, but nothing may bring a model back
    real, asked = srv.generate_plate_via_krea_mcp, []
    def spy(**kw):
        asked.append(kw["model"])
        return real(**kw)
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", spy)
    for title, extra in (("Old Choice", {"model": "openai/gpt-image-2"}), ("Old Auto", {"model": "auto"}), ("No Choice", {})):
        assert live("POST", "/api/generate-image", {"title": title, "prompt": "p", **extra})[1]["ok"]
    assert asked == ["google/nano-banana-2.1"] * 3
    assert set(srv.load_state()["models"].values()) == {"google/nano-banana-2.1"}


def test_an_image_already_being_made_is_not_made_twice_and_the_page_is_told(live, srv, monkeypatch):
    # the page reloaded mid-batch; Resume asked again for the images still being made, and each came out twice
    started, release = threading.Event(), threading.Event()
    real = srv.generate_plate_via_krea_mcp
    def slow(**kw):
        started.set(); release.wait(10)
        return real(**kw)
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", slow)
    first = threading.Thread(target=live, args=("POST", "/api/generate-image", {"title": "Glyph on the Column", "prompt": "p", "model": "m"}))
    first.start()
    assert started.wait(10)
    try:
        assert live("GET", "/api/state")[1]["making"] == ["Glyph on the Column"], "the page knows it is being made"
        status, res = live("POST", "/api/generate-image", {"title": "Glyph on the Column", "prompt": "p", "model": "m"})
        assert status == 409 and res["duplicate"], res
    finally:
        release.set(); first.join(10)
    assert live("GET", "/api/state")[1]["making"] == []
    assert len(list(srv.PLATES_DIR.glob("*.jpg"))) == 1, "made once"


def test_trash_and_restore_answer_at_once_while_a_new_image_is_checked(live, srv, monkeypatch):
    # the logo check takes ~2.5 s an image on a project's own mark: it ran holding the curation's lock, so a Trash or Restore click
    # during a batch waited for every image being checked (the user saw the buttons do nothing)
    first = live("POST", "/api/generate-image", {"title": "Already Here", "prompt": "p", "model": "m"})[1]["filename"]
    checking, release = threading.Event(), threading.Event()

    def slow_check(p, pl=None, mark_id=None):
        checking.set()
        release.wait(10)
        return {"qa_passed": True, "qa_score": 90, "issues": [], "center_corr": 0.9, "core_asymmetry": 0.2}
    monkeypatch.setattr(srv, "check_new_image", slow_check)
    gen = threading.Thread(target=live, args=("POST", "/api/generate-image", {"title": "Being Checked", "prompt": "p", "model": "m"}))
    gen.start()
    assert checking.wait(10)
    try:
        t0 = time.time()
        assert live("POST", "/api/trash", {"filename": first, "trashed": True})[1]["ok"]
        assert live("POST", "/api/trash", {"filename": first, "trashed": False})[1]["ok"]
        assert time.time() - t0 < 2, "the clicks waited for the logo check"
        assert not any("Being Checked" in t for t in srv.load_state().get("titles", {}).values()), "not among the images before it is checked"
    finally:
        release.set()
        gen.join(10)
    names = [p.name for p in srv.PLATES_DIR.glob("*.jpg")]
    assert len(names) == 2 and not list(srv.PLATES_DIR.glob(".*.part"))
    new = next(n for n in names if n != first)
    assert srv.get_cached_qa(srv.PLATES_DIR / new)["filename"] == new          # the check's result is kept under the image's own name


def test_a_logo_check_failure_is_recorded(live, srv, monkeypatch):
    monkeypatch.setattr(srv, "check_new_image", lambda p, pl=None, mark_id=None: {"qa_passed": False, "qa_score": 12, "issues": ["Low center logo fidelity"], "center_corr": 0.1, "core_asymmetry": 0.0})
    assert live("POST", "/api/generate-image", {"title": "Bad Logo", "prompt": "p", "model": "m"})[1]["trashed"] is True
    done = [e for e in gen_log.read(None) if e["event"] == "image"][0]
    assert done["ok"] and done["qa_passed"] is False and done["qa_issues"] == ["Low center logo fidelity"]
    assert "LOGO CHECK FAILED" in gen_log.describe(done)


def test_a_missing_krea_login_is_written_down(live, srv, monkeypatch):
    monkeypatch.setattr(srv, "get_krea_oauth_token", lambda: {"connected": False})
    assert live("POST", "/api/generate-image", {"title": "No Login", "prompt": "p"})[1]["needs_auth"] is True
    done = gen_log.read(None)[-1]
    assert done["event"] == "image" and done["ok"] is False and done["needs_auth"] is True


def test_a_failed_batch_is_written_down(live, srv, monkeypatch):
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "no json here")
    status, res = live("POST", "/api/invent-prompts", {"count": 4, "world": "Editorial Print"})
    assert status == 500
    ev = gen_log.read(None)[-1]
    assert ev["event"] == "batch" and ev["ok"] is False and ev["asked"] == 4 and ev["error"]


def test_purge_ai_order_and_export_are_recorded_and_the_log_is_readable_over_http(live, srv):
    for i in range(3):
        live("POST", "/api/generate-image", {"title": f"T{i}", "prompt": "p", "model": "m"})
    names = [p["filename"] for p in live("GET", "/api/state")[1]["plates"]]
    live("POST", "/api/trash", {"filename": names[0], "trashed": True})
    live("POST", "/api/purge", {"filenames": [names[0]]})
    status, ex = _export(live, {"bpm": 120, "multiple": 2})
    assert status == 200 and ex["ok"] and ex["images"] == 2 and ex["filename"].endswith(".mp4") and (srv.OUTPUTS_DIR / ex["filename"]).exists()
    kinds = [e["event"] for e in gen_log.read(None)]
    assert kinds.count("image") == 3 and "purge" in kinds and "export" in kinds
    status, data = live("GET", "/api/log?n=5")
    assert status == 200 and data["ok"] and len(data["events"]) == 5 and len(data["lines"]) == 5
    assert data["summary"]["images"] == 3 and data["summary"]["ok"] == 3
    assert any("deleted 1 images" in l for l in data["lines"]) or any("export" in l for l in data["lines"])


def test_a_failing_export_answers_with_a_json_error_and_a_log_line(live, srv, monkeypatch):
    live("POST", "/api/generate-image", {"title": "One", "prompt": "p", "model": "m"})
    monkeypatch.setattr(srv.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("ffmpeg exploded")))
    status, res = _export(live, {"bpm": 120, "multiple": 1})
    assert status == 500 and res["ok"] is False and "ffmpeg exploded" in res["error"]
    ev = gen_log.read(None)[-1]
    assert ev["event"] == "export" and ev["ok"] is False and "ffmpeg" in ev["error"]
    assert not srv.busy()                                   # the busy flag is released even when it failed


def test_the_ai_order_is_recorded(live, srv, monkeypatch):
    import time as _t
    for i in range(4):
        live("POST", "/api/generate-image", {"title": f"A{i}", "prompt": "p", "model": "m"})
    monkeypatch.setattr(srv, "run_ai_order_job", live.real_job)
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "sorry, no brief today")       # Kimi answers, but not with a usable brief
    start = live("POST", "/api/order-ai", {"length": None, "direction": "start soft"})[1]
    for _ in range(100):
        if live("GET", f"/api/order-ai-status?job={start['job']}")[1].get("done"):
            break
        _t.sleep(0.1)
    ev = [e for e in gen_log.read(None) if e["event"] == "ai_order"][0]
    assert ev["ok"] and ev["images"] == 4 and ev["direction"] == "start soft" and ev["kimi_ok"] is False


def test_kimi_unreachable_stops_at_once_and_says_offline(srv, monkeypatch):
    # offline, every model on every endpoint was tried in turn (six failures, one long message) before the page heard
    import urllib.error
    tried = []
    def no_network(req, timeout=None):
        tried.append(req.full_url)
        raise urllib.error.URLError("[Errno 8] nodename nor servname provided, or not known")
    monkeypatch.setattr(srv.urllib.request, "urlopen", no_network)
    with pytest.raises(srv.KimiOffline, match="could not be reached"):
        srv.call_kimi_llm("p", "sk-test")
    assert len(tried) == 1


def test_krea_refusing_is_not_a_lost_connection_and_out_of_credits_can_be_retried(live, srv, monkeypatch):
    # an HTTPError is a URLError too: every Krea refusal (401, 403, 404) read as "offline", and the page resubmitted it forever
    import urllib.error
    import krea_mcp_client as kc
    monkeypatch.setattr(srv.time, "sleep", lambda s: None)
    errors = [urllib.error.HTTPError("https://api.krea.ai/mcp", 403, "Forbidden", {}, None),
              urllib.error.HTTPError("https://api.krea.ai/mcp", 401, "Unauthorized", {}, None),
              urllib.error.HTTPError("https://api.krea.ai/mcp", 502, "Bad Gateway", {}, None),
              kc.KreaError("Krea: insufficient credits", code="insufficient_credits", retryable=False)]
    res = []
    for i, err in enumerate(errors):
        monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", lambda err=err, **kw: (_ for _ in ()).throw(err))
        res.append(live("POST", "/api/generate-image", {"title": f"T{i}", "prompt": "p", "model": "m"})[1])
    assert not res[0]["offline"] and not res[0]["needs_auth"] and res[0]["retryable"], "403: Krea said no, the image fails on its own"
    assert not res[1]["offline"] and res[1]["needs_auth"], "401: the sign-in was refused"
    assert res[2]["offline"], "502: Krea is unreachable, the batch waits"
    assert res[3]["stop"] and res[3]["retryable"], "out of credits: the batch stops and the image waits for Retry"


def test_a_new_images_logo_check_is_written_to_disk_at_once(live, srv, monkeypatch):
    # kept only in memory, every image of a session was measured again after a restart (~2.5 s each, before the page opened)
    name = live("POST", "/api/generate-image", {"title": "Saved Check", "prompt": "p", "model": "m"})[1]["filename"]
    assert any(k.startswith(name + ":") for k in json.loads(srv.QA_CACHE_FILE.read_text()))


def test_a_moderation_rejection_is_not_retried_explained_and_written_down(live, srv, monkeypatch):
    import krea_mcp_client as kc
    calls = []

    def moderated(**kw):
        calls.append(1)
        raise kc.KreaError("Krea job failed (content_policy): rejected", code="content_policy", retryable=False, job_id="J-42")
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", moderated)
    monkeypatch.setattr(srv.time, "sleep", lambda s: pytest.fail("no waiting for a rejection"))
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("Kimi is down")))     # no rewrite possible
    status, res = live("POST", "/api/generate-image", {"title": "Neon Roundel", "prompt": "a neon tube roundel on a signboard", "guide": "dark", "model": "m"})
    assert status == 500 and res["code"] == "content_policy" and "moderation" in res["error"] and "softened" not in res["error"]
    assert len(calls) == 1                                                       # one attempt, not three
    ev = gen_log.read(None)[-1]
    assert ev["error_code"] == "content_policy" and ev["krea_job"] == "J-42" and ev["prompt"] == "a neon tube roundel on a signboard"
    assert len(ev["attempts"]) == 1 and ev["attempts"][0]["code"] == "content_policy"
    assert "REJECTED BY KREA MODERATION" in gen_log.describe(ev)
    assert gen_log.summarize(gen_log.read(None))["moderated"] == 1


def test_a_moderation_rejection_gets_one_retry_with_a_softened_prompt_that_can_succeed(live, srv, monkeypatch):
    import krea_mcp_client as kc
    seen = []
    real = srv.generate_plate_via_krea_mcp

    def picky(**kw):
        seen.append(kw["prompt"])
        if "Shibuya" in kw["prompt"]:
            raise kc.KreaError("Krea job failed (content_policy): rejected", code="content_policy", retryable=False, job_id="J1")
        return real(**kw)
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", picky)
    asked = []
    monkeypatch.setattr(srv, "call_kimi_llm", lambda prompt, **k: asked.append(prompt) or "A neon-lit rooftop gantry at night with a bold glowing circular mark at the exact dead-center of the frame, cinematic wide shot.")
    status, res = live("POST", "/api/generate-image", {"title": "Shibuya Gantry", "prompt": "Shibuya Crossing rooftop with the Nike swoosh sign and a circular mark at dead-center", "guide": "dark", "model": "m"})
    assert status == 200 and res["ok"] and res["softened"] is True
    assert len(seen) == 2 and "Shibuya" in seen[0] and "Shibuya" not in seen[1]                 # the second try used the neutral wording
    assert "moderation" in asked[0] and "Shibuya Crossing rooftop" in asked[0]                  # Kimi was shown the refused prompt
    st = srv.load_state()
    assert "neon-lit rooftop gantry" in st["prompts"][res["filename"]]                          # the plate remembers the wording that worked
    ev = [e for e in gen_log.read(None) if e["event"] == "image"][0]
    assert ev["ok"] and ev["softened"] is True and [a.get("softened") for a in ev["attempts"]] == [None, True]
    assert "softened" in gen_log.describe(ev) and gen_log.summarize(gen_log.read(None))["softened_ok"] == 1


def test_if_the_softened_prompt_is_refused_too_the_image_is_reported_as_moderated(live, srv, monkeypatch):
    import krea_mcp_client as kc
    calls = []

    def refuse(**kw):
        calls.append(1)
        raise kc.KreaError("rejected", code="content_policy", retryable=False, job_id="J")
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", refuse)
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "A perfectly neutral rewritten prompt that is long enough to be accepted as a rewrite.")
    status, res = live("POST", "/api/generate-image", {"title": "Still Refused", "prompt": "original wording of the prompt", "model": "m"})
    assert status == 500 and "also with a softened prompt" in res["error"] and len(calls) == 2
    ev = gen_log.read(None)[-1]
    assert ev["softened"] is True and ev["error_code"] == "content_policy"


def test_without_a_kimi_key_or_a_usable_rewrite_a_rejection_is_just_reported(live, srv, monkeypatch):
    import krea_mcp_client as kc
    calls = []

    def refuse(**kw):
        calls.append(1)
        raise kc.KreaError("rejected", code="content_policy", retryable=False)
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", refuse)
    monkeypatch.setattr(srv, "call_kimi_llm", lambda *a, **k: "original wording of the prompt")        # Kimi returns it unchanged: nothing to retry with
    status, res = live("POST", "/api/generate-image", {"title": "Same", "prompt": "original wording of the prompt", "model": "m"})
    assert status == 500 and res["code"] == "content_policy" and len(calls) == 1 and "softened" not in res["error"]


def test_soften_prompt_refuses_empty_or_failed_rewrites(srv):
    assert srv.soften_prompt("abc", "k", "m", call_llm=lambda *a, **k: "short") is None
    assert srv.soften_prompt("x" * 60, "k", "m", call_llm=lambda *a, **k: "x" * 60) is None
    assert srv.soften_prompt("x", "k", "m", call_llm=lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))) is None
    assert srv.soften_prompt("x", "k", "m", call_llm=lambda *a, **k: '"' + "a neutral rewrite " * 4 + '"') == ("a neutral rewrite " * 4).strip()


def _streams(path):
    out = subprocess.run([srv_tool("ffprobe"), "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    return [x["codec_type"] for x in data["streams"]], float(data["format"]["duration"])


def _three_plates(live):
    for i in range(3):
        live("POST", "/api/generate-image", {"title": f"M{i}", "prompt": "p", "model": "m"})


def _export(live, body, total: int = 45):
    """An export as the page makes it: the page plans the film and draws every frame (here one drawn, the rest pointing at it in one
    request, as a held cut does), then asks for the video with how many it sent."""
    jpg = io.BytesIO()
    Image.new("RGB", (108, 192), (30, 90, 200)).save(jpg, "JPEG")
    live("POST", "/api/export-frame?i=0", raw=jpg.getvalue())
    if total > 1:
        live("POST", f"/api/export-frame?i=1&same=0&to={total}", raw=b"")
    return live("POST", "/api/export-video", {**body, "frames": total})


def _silent_wav(seconds: float = 1.5) -> bytes:
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes(b"\x00\x00\x00\x00" * int(44100 * seconds))
    return buf.getvalue()


def test_export_with_music_has_an_audio_track_and_without_it_does_not(live, srv):
    _three_plates(live)
    status, plain = _export(live, {"bpm": 120, "multiple": 2})
    assert status == 200 and _streams(srv.OUTPUTS_DIR / plain["filename"])[0] == ["video"] and "music" not in plain["filename"]
    status, res = live("POST", "/api/export-audio", raw=_silent_wav())                  # the page renders the drone and sends it first
    assert status == 200 and res["ok"]
    status, withm = _export(live, {"bpm": 120, "multiple": 2, "music": "synth"})
    assert status == 200 and withm["music"] is True and withm["music_mode"] == "synth" and "music" in withm["filename"]
    kinds, seconds = _streams(srv.OUTPUTS_DIR / withm["filename"])
    assert sorted(kinds) == ["audio", "video"]
    assert gen_log.read(None)[-1]["music"] == "synth"
    status, again = _export(live, {"bpm": 120, "multiple": 2, "music": "synth"})   # the sound is used once
    assert status == 500 and "did not arrive" in again["error"]


def test_export_encodes_the_frames_the_page_drew(live, srv):
    """WebGL export: the page draws every frame (render.js) and sends them; the server only encodes. A frame can point at an earlier
    one (a held cut). Every frame up to the count must be there, a frame must be a JPEG, and the set is used once."""
    _three_plates(live)
    jpg = io.BytesIO()
    Image.new("RGB", (108, 192), (220, 30, 30)).save(jpg, "JPEG", quality=92)
    status, res = live("POST", "/api/export-frame?i=0", raw=jpg.getvalue())
    assert status == 200 and res["ok"]
    total = 40
    status, res = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2, "frames": total})
    assert status == 500 and "frame 1 is missing" in res["error"], "a frame short: it says which"
    for i in range(1, total):
        status, res = live("POST", f"/api/export-frame?i={i}&same={i - 1}", raw=b"")
        assert status == 200 and res["ok"], res
    status, res = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2, "frames": total})
    assert status == 200 and res["ok"], res
    out = srv.OUTPUTS_DIR / res["filename"]
    frame = subprocess.run([srv_tool("ffmpeg"), "-v", "error", "-i", str(out), "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           capture_output=True, check=True).stdout
    assert frame[0] > 180 and frame[2] < 70, f"the page's red frames, not the plates' blue: {list(frame)}"
    assert _streams(out)[1] == pytest.approx(total / 30, abs=0.05)
    status, film = live("GET", res["video_url"])                                  # what the page downloads: the film itself
    assert status == 200 and isinstance(film, bytes) and film == out.read_bytes(), "the download is the film (it was a 35-byte Not found)"
    assert film[4:8] == b"ftyp", "an MP4"
    assert live("GET", "/outputs/..%2Fstate.json")[0] == 404 and live("GET", "/outputs/.secret.mp4")[0] == 404, "films only, from their folder"
    assert not srv.export_frames_dir().exists(), "the frames are used once"
    assert live("POST", "/api/export-frame?i=0", raw=b"not a jpeg")[0] == 400
    assert live("POST", "/api/export-frame?i=3&same=5", raw=b"")[0] == 400
    assert live("POST", "/api/export-frame?i=x", raw=b"")[0] == 400


def test_export_audio_refuses_what_is_not_a_wav(live):
    assert live("POST", "/api/export-audio", raw=b"not audio at all, just some bytes that are long enough to pass the size check")[0] == 400
    assert live("POST", "/api/export-audio", raw=b"")[0] == 413


def test_the_track_endpoints_are_gone_the_music_is_synthesized_in_the_page(live):
    for path in ("/api/track", "/api/track-cuts", "/api/music"):
        assert live("POST", path, {})[0] == 404


def test_state_gives_every_plate_a_thumbnail_and_a_preview_url(live):
    _three_plates(live)
    plates = live("GET", "/api/state")[1]["plates"]
    assert all(p["thumb"].startswith("/api/thumb?f=") and p["thumb"].endswith("&w=360") and p["preview"].endswith("&w=540") for p in plates)


def test_thumbnails_are_small_cached_jpegs_and_bad_requests_are_refused(live, srv):
    _three_plates(live)
    p = live("GET", "/api/state")[1]["plates"][0]
    status, data = live("GET", p["thumb"])
    assert status == 200 and data[:3] == b"\xff\xd8\xff"
    im = Image.open(io.BytesIO(data))
    assert im.size[0] <= 360 and im.size[0] < im.size[1]                       # portrait, never bigger than asked
    assert (srv.THUMBS_DIR / "360" / p["filename"]).exists()                    # made once, kept
    assert live("GET", f"/api/thumb?f={p['filename']}&w=999")[0] == 404          # only the sizes the page uses
    assert live("GET", "/api/thumb?f=../curation_state.json&w=360")[0] == 404
    assert live("GET", "/api/thumb?f=nope.jpg&w=360")[0] == 404
    assert live("GET", "/api/thumb")[0] == 404


def test_purging_a_plate_removes_its_thumbnails(live, srv):
    _three_plates(live)
    p = live("GET", "/api/state")[1]["plates"][0]
    live("GET", p["thumb"]); live("GET", p["preview"])
    live("POST", "/api/trash", {"filename": p["filename"], "trashed": True})
    live("POST", "/api/purge", {"filenames": [p["filename"]]})
    assert not (srv.THUMBS_DIR / "360" / p["filename"]).exists() and not (srv.THUMBS_DIR / "540" / p["filename"]).exists()


def test_export_is_as_long_as_the_frames_the_page_drew_and_named_after_its_speeds(live, srv):
    """The page plans the film (the timeline); the video is its frames at 30 fps. A change of speed names the file from the tempo to the end."""
    _three_plates(live)
    status, res = _export(live, {"rhythm": "variable", "bpm": 100, "end_ms": 200}, total=54)
    assert status == 200 and "var600to200ms" in res["filename"] and "bpm" not in res["filename"]
    kinds, seconds = _streams(srv.OUTPUTS_DIR / res["filename"])
    assert kinds == ["video"] and seconds == pytest.approx(54 / 30, abs=0.05)
    status, flat = _export(live, {"rhythm": "flat", "bpm": 120, "multiple": 2})
    assert status == 200 and "120bpm-x2" in flat["filename"]
    status, odd = _export(live, {"rhythm": "variable", "bpm": "x", "end_ms": 99999})      # nonsense is clamped
    assert status == 200 and "var441to1500ms" in odd["filename"]
    status, none = live("POST", "/api/export-video", {"bpm": 120, "frames": 0})
    assert status == 500 and "did not all arrive" in none["error"]


@pytest.mark.parametrize("body", [
    {"bpm": 0, "multiple": 0}, {"bpm": -120, "multiple": -4}, {"bpm": "abc", "multiple": "x"}, {"bpm": 1e9, "multiple": 1e9}, {"bpm": float("nan")},
    {"bpm": 250, "multiple": 16}, {"bpm": 30, "multiple": 0.125}, {"bpm": None, "multiple": None},
    {"rhythm": "variable", "end_ms": 50, "multiple": 0}, {"rhythm": "variable", "end_ms": 1e12, "multiple": 16},
    {"rhythm": "variable", "end_ms": "x", "multiple": [1]}, {"rhythm": "variable", "end_ms": None},
    {"rhythm": "sideways", "bpm": 120}, {"rhythm": "variable", "invert_mode": "mono", "multiple": 0.25, "end_ms": 1500},
])
def test_export_survives_extreme_and_nonsense_settings(live, srv, body):
    _three_plates(live)
    status, res = _export(live, body)
    assert status == 200 and res["ok"], res
    assert (srv.OUTPUTS_DIR / res["filename"]).stat().st_size > 1000
    assert _streams(srv.OUTPUTS_DIR / res["filename"])[1] > 0


def test_export_with_one_plate_and_the_fastest_possible_rhythm(live, srv):
    live("POST", "/api/generate-image", {"title": "Solo", "prompt": "p", "model": "m"})
    status, res = _export(live, {"bpm": 300, "multiple": 16, "invert_mode": "mono"})
    assert status == 200 and _streams(srv.OUTPUTS_DIR / res["filename"])[0] == ["video"]


def test_version_carries_a_cheap_library_fingerprint_that_moves_when_the_library_changes(live):
    """The page polls /api/version and only downloads /api/state when "state" changes."""
    import time
    sig0 = live("GET", "/api/version")[1]["state"]
    assert sig0 == live("GET", "/api/version")[1]["state"], "nothing changed: the same fingerprint"
    time.sleep(0.01)
    status, res = live("POST", "/api/generate-image", {"title": "x", "prompt": "p", "guide": "dark", "model": "google/nano-banana-pro"})
    assert res["ok"]
    sig1 = live("GET", "/api/version")[1]["state"]
    assert sig1 != sig0, "a new plate moves it"
    assert sig1 == live("GET", "/api/version")[1]["state"]
    time.sleep(0.01)
    assert live("POST", "/api/trash", {"filename": res["filename"], "trashed": True})[1]["ok"]
    assert live("GET", "/api/version")[1]["state"] != sig1, "trashing writes the curation file: the fingerprint moves"


def test_groups_over_http_and_a_group_exports_alone(live, srv):
    """Groups: made, filled and shown in the state; an export of a group has just its images."""
    _three_plates(live)
    names = [p["filename"] for p in live("GET", "/api/state")[1]["plates"] if not p["trashed"]]
    status, res = live("POST", "/api/groups", {"action": "create", "name": "Two", "files": names[:2]})
    assert status == 200 and res["ok"]
    gid = res["group"]["id"]
    _, state = live("GET", "/api/state")
    assert state["groups"] == [{"id": gid, "name": "Two", "files": names[:2]}]
    assert all("look" in p for p in state["plates"])
    assert live("POST", "/api/groups", {"action": "create", "name": "two"})[0] == 400        # names are unique
    status, whole = _export(live, {"rhythm": "flat", "bpm": 120, "multiple": 2})
    status, part = _export(live, {"rhythm": "flat", "bpm": 120, "multiple": 2, "files": names[:2]})
    assert status == 200
    assert whole["images"] == len(names) and part["images"] == 2, (whole, part)
    assert live("POST", "/api/groups", {"action": "delete", "id": gid})[1]["ok"]
    assert live("GET", "/api/state")[1]["groups"] == []


def test_edits_over_http_and_an_edit_names_its_export(live, srv):
    """Edits: saved with the curation, shown in the state, and an export made from one starts with its name."""
    _three_plates(live)
    status, res = live("POST", "/api/edits", {"action": "create", "name": "Night strobe", "group": "look:dark", "settings": {"bpmInput": "140"}})
    assert status == 200 and res["ok"]
    eid = res["edit"]["id"]
    assert live("GET", "/api/state")[1]["edits"] == [{"id": eid, "name": "Night strobe", "group": "look:dark", "settings": {"bpmInput": "140"}}]
    assert live("POST", "/api/edits", {"action": "create", "name": "night strobe"})[0] == 400
    assert live("POST", "/api/edits", {"action": "update", "id": eid, "group": "all", "settings": {"bpmInput": "90"}})[1]["ok"]
    assert live("GET", "/api/state")[1]["edits"][0]["settings"] == {"bpmInput": "90"}
    status, out = _export(live, {"rhythm": "flat", "bpm": 120, "multiple": 2, "edit": "Night strobe"})
    assert status == 200 and out["filename"].startswith("Night-strobe-120bpm-x2-"), out
    assert live("POST", "/api/edits", {"action": "delete", "id": eid})[1]["ok"]
    assert live("GET", "/api/state")[1]["edits"] == []


def test_ai_reorder_of_a_group_moves_only_its_images_among_their_own_places(live, srv, monkeypatch):
    _three_plates(live)
    names = [p["filename"] for p in live("GET", "/api/state")[1]["plates"] if not p["trashed"]][:3]      # order: n0, n1, n2...
    built = {"result": {"names": [names[2], names[0]], "left_out": [], "cuts": []}, "summary": "s", "brief_ok": True, "images": 2}
    with srv.STATE_LOCK:
        st = srv.load_state()
        srv.add_group_order(st, built, {names[0], names[2]})
        srv.save_state(st)
    _, state = live("GET", "/api/state")
    assert [p["filename"] for p in state["plates"] if not p["trashed"]][:3] == [names[2], names[1], names[0]], "n1 kept its place; the group swapped"


def test_projects_over_http_a_new_brand_generates_into_its_own_folder_and_cos_comes_back(live, srv):
    """Make a project from a mark (sent as a PNG data URL), it becomes the open one, its images and curation are its own; the
    prompt names its mark, size and place; Krea gets its guide; switching back brings DEMO's library back."""
    import base64
    from test_projects import star_png
    _three_plates(live)
    demo_names = sorted(p["filename"] for p in live("GET", "/api/state")[1]["plates"])
    status, res = live("POST", "/api/projects", {"action": "create", "name": "Night Owl", "mark": "data:image/png;base64," + base64.b64encode(star_png()).decode(),
                                                  "mark_size": 24, "mark_x": 50, "mark_y": 40, "mark_shape": "owl wordmark", "mark_noun": "owl", "brief": "Night Owl, a late bar", "palette": ["#223344"]})
    assert status == 200 and res["active"] == "night-owl" and [p["slug"] for p in res["projects"]] == ["demo", "night-owl"]
    _, state = live("GET", "/api/state")
    assert state["project"]["name"] == "Night Owl" and state["plates"] == [], "a new project starts empty"
    status, mark = live("GET", "/api/project-mark?p=night-owl")
    assert status == 200 and mark[:4] == b"\x89PNG"
    live.calls["krea"].clear()
    status, g = live("POST", "/api/generate-image", {"title": "Owl one", "prompt": "a moonlit bar counter", "model": "m"})
    assert status == 200 and g.get("ok"), g
    kw = live.calls["krea"][-1]
    assert kw["guide"]["files"]["dark"] == srv.projects.PROJECTS_DIR / "night-owl" / "guide_dark.png", "its own guide"
    assert "At the EXACT POINT 50% from the left and 40% from the top of the 9:16 frame at ~24% frame width (matching the exact owl wordmark SHAPE" in kw["prompt"]
    assert "is the SINGLE owl," in kw["prompt"]
    files = [p["filename"] for p in live("GET", "/api/state")[1]["plates"]]
    assert len(files) == 1 and (srv.projects.PROJECTS_DIR / "night-owl" / "plates" / files[0]).is_file()
    status, img = live("GET", f"/api/plate?f={files[0]}")
    assert status == 200 and img[:2] == b"\xff\xd8"
    assert live("GET", "/api/plate?f=../state.json")[0] == 404
    status, res = live("POST", "/api/projects", {"action": "switch", "slug": "demo"})
    assert status == 200 and res["active"] == "demo"
    _, state = live("GET", "/api/state")
    assert state["project"]["name"] == "Demo" and sorted(p["filename"] for p in state["plates"]) == demo_names, "DEMO's library is back as it was"
    assert live("POST", "/api/projects", {"action": "switch", "slug": "nope"})[0] == 404
    assert live("POST", "/api/projects", {"action": "create", "name": "x", "mark": "data:image/png;base64,AAAA"})[0] == 400


def test_switching_projects_waits_while_something_runs(live, srv):
    from test_projects import star_png
    import base64
    live("POST", "/api/projects", {"action": "create", "name": "Owl", "mark": base64.b64encode(star_png()).decode()})
    with srv.inflight():
        status, res = live("POST", "/api/projects", {"action": "switch", "slug": "demo"})
    assert status == 409 and res["busy"]
    assert live("POST", "/api/projects", {"action": "switch", "slug": "demo"})[0] == 200



def test_krea_sign_in_over_http_opens_krea_and_the_callback_finishes_it(live, srv, monkeypatch):
    seen = {}
    monkeypatch.setattr(srv, "krea_start_login", lambda redirect: seen.setdefault("redirect", redirect) and "https://www.krea.ai/auth/v1/oauth/authorize?x=1")
    monkeypatch.setattr(srv, "krea_finish_login", lambda code, state: seen.update(code=code, state=state))
    status, res = live("POST", "/api/krea-auth", {})
    assert status == 200 and res["url"].startswith("https://www.krea.ai/") and seen["redirect"].endswith("/api/krea-callback")
    status, page = live("GET", "/api/krea-callback?code=C&state=S")
    assert status == 200 and b"Krea is connected" in page and (seen["code"], seen["state"]) == ("C", "S")
    status, page = live("GET", "/api/krea-callback?error=access_denied&error_description=The+user+said+no")
    assert b"Krea is not connected" in page and b"The user said no" in page
    def refuse(code, state):
        raise RuntimeError("This sign-in was not started here")
    monkeypatch.setattr(srv, "krea_finish_login", refuse)
    assert b"not started here" in live("GET", "/api/krea-callback?code=C&state=X")[1]
    gone = []
    monkeypatch.setattr(srv, "krea_forget_login", lambda: gone.append(1))
    assert live("POST", "/api/krea-auth", {"action": "logout"})[1]["ok"] and gone


def test_download_zip_has_the_images_shown_full_size_in_order_and_is_fetched_once(live, srv):
    import zipfile
    _three_plates(live)
    names = [p["filename"] for p in live("GET", "/api/state")[1]["plates"] if not p["trashed"]]
    pick = [names[2], names[0], "../curation_state.json", ".hidden", "nope.jpg"]
    status, res = live("POST", "/api/download-zip", {"files": pick, "label": "Warm · dark"})
    assert status == 200 and res["ok"] and res["filename"].startswith("Demo-Warm-dark-2-images-") and res["filename"].endswith(".zip")
    status, data = live("GET", res["url"])
    assert status == 200
    z = zipfile.ZipFile(io.BytesIO(data))
    folder = res["filename"][:-4]
    assert z.namelist() == [f"{folder}/001-{names[2]}", f"{folder}/002-{names[0]}"], "in the order shown; nothing outside the plates"
    assert z.read(f"{folder}/001-{names[2]}") == (srv.PLATES_DIR / names[2]).read_bytes(), "the full-size file as it is"
    assert live("GET", res["url"])[0] == 404, "fetched once"
    assert live("POST", "/api/download-zip", {"files": ["nope.jpg"]})[0] == 400
    assert live("GET", "/api/download-zip?id=../../x&name=a.zip")[0] == 404


def test_project_export_and_import_over_http_and_kimi_reads_a_mark(live, srv, monkeypatch):
    import base64, json as _json
    from test_projects import star_png
    _three_plates(live)
    status, res = live("POST", "/api/project-export", {})
    assert status == 200 and res["filename"] == "Demo.phos"
    status, data = live("GET", res["url"])
    assert status == 200 and data[:2] == b"PK"
    status, imp = live("POST", "/api/project-import", raw=data)
    assert status == 200 and imp["active"] == "Demo-2" and imp["project"]["name"] == "Demo 2", "a copy, opened, numbered (a Demo is already here)"
    _, state = live("GET", "/api/state")
    assert len([p for p in state["plates"] if not p["trashed"]]) == 3, "with its images"
    assert live("POST", "/api/project-import", raw=b"nope, not a zip at all")[0] == 400
    calls = []
    monkeypatch.setattr(srv, "call_kimi_llm", lambda prompt, *a, **k: calls.append(k.get("images")) or _json.dumps({"recognised": True, "name": "Arrowhead", "brand": "Arrowhead, a trail-running brand", "shape": "angular arrow mark", "noun": "arrow", "palette": ["#123456", "bad"], "palette_note": "Arrowhead's trail green"}))
    status, d = live("POST", "/api/describe-mark", {"mark": "data:image/png;base64," + base64.b64encode(star_png()).decode()})
    assert status == 200 and d["shape"] == "angular arrow mark" and d["noun"] == "arrow" and d["suggested"] == ["#123456"]
    assert d["palette_note"] == "Arrowhead's trail green", "why these colours"
    assert d["name"] == "Arrowhead" and d["brand"] == "Arrowhead, a trail-running brand", "Kimi names it and says who it is for"
    assert d["colours"] == ["#F03C14"] and calls and calls[0][0][:2] == b"\xff\xd8", "its own colour, and Kimi saw it as an image"
    assert live("POST", "/api/describe-mark", {"mark": "data:image/png;base64,AAAA"})[0] == 400
    # a lookalike (a striped sphere read as AT&T): unsure, so no brand line; the prompt asks for its shape exactly and a made-up name
    monkeypatch.setattr(srv, "call_kimi_llm", lambda prompt, *a, **k: calls.append(prompt) or _json.dumps({"recognised": False, "name": "Stripe Orb", "brand": "AT&T, a telecom company", "shape": "sphere of 9 horizontal black stripes", "noun": "striped sphere"}))
    _, d = live("POST", "/api/describe-mark", {"mark": "data:image/png;base64," + base64.b64encode(star_png()).decode()})
    assert (d["name"], d["brand"], d["shape"]) == ("Stripe Orb", "", "sphere of 9 horizontal black stripes"), "a resemblance is no brand"
    assert "A resemblance is not enough" in calls[-1] and "with counts" in calls[-1] and "the brand's own colour system" in calls[-1]
    monkeypatch.setattr(srv, "call_kimi_llm", lambda prompt, *a, **k: _json.dumps({"name": "Nike", "brand": "Nike, sportswear", "shape": "swoosh"}))
    assert live("POST", "/api/describe-mark", {"mark": "data:image/png;base64," + base64.b64encode(star_png()).decode()})[1]["brand"] == "", "not said sure: no brand"


def test_with_no_project_the_server_runs_says_so_and_a_double_clicked_file_opens(live, srv, tmp_path, monkeypatch):
    """A new user (the Mac app with an empty Documents/Phosphene): no project, an empty library, the page shows its first screen;
    what needs a project says so; a .phosphene file opened from Finder becomes the project."""
    _three_plates(live)
    status, res = live("POST", "/api/project-export", {})
    data = live("GET", res["url"])[1]
    f = tmp_path / "Demo.phosphene"; f.write_bytes(data)
    srv.apply_no_project()
    _, state = live("GET", "/api/state")
    assert state["project"] is None and state["plates"] == [], "no project: the first screen"
    assert live("GET", "/api/projects")[1]["active"] is None
    status, r = live("POST", "/api/generate-image", {"title": "x", "prompt": "p", "model": "m"})
    assert status == 409 and r["no_project"], "nothing that needs a project runs without one"
    assert live("POST", "/api/project-import-path", {"path": str(tmp_path / "nope.txt")})[0] == 400
    status, r = live("POST", "/api/project-import-path", {"path": str(f)})
    assert status == 200 and r["project"]["name"] == "Demo 2", "its folder is still here: the copy is numbered"
    assert len(live("GET", "/api/state")[1]["plates"]) == 3, "with its images"
    # from a review: a job that starts while a file is copied (seconds) keeps its project; the file is imported, not opened
    srv.apply_project(srv.projects.load(r["active"]))
    real = srv.projects.import_zip
    monkeypatch.setattr(srv.projects, "import_zip", lambda path: (srv._LEASE.update(until=srv.time.time() + 30), real(path))[1])
    try:
        status, r2 = live("POST", "/api/project-import-path", {"path": str(f)})
    finally:
        srv._LEASE["until"] = 0
    assert status == 409 and "Demo 3 was imported" in r2["error"] and srv.PROJECT["slug"] == r["active"]
    assert any(p["name"] == "Demo 3" for p in live("GET", "/api/projects")[1]["projects"])



def test_nothing_outside_the_plates_folder_is_ever_deleted_whatever_the_state_or_a_request_says(live, srv, tmp_path):
    """Review finding: a project file (or a request) listing '../../x' or '/Users/...' as trashed made Empty trash delete it."""
    _three_plates(live)
    outside = tmp_path / "thesis.pdf"; outside.write_text("precious")
    st = srv.load_state()
    st["trashed"] = st.get("trashed", []) + [str(outside), "../thesis.pdf", "../../thesis.pdf"]
    srv.save_state(st)
    srv.purge_plates(srv.load_state(), srv.load_state()["trashed"])
    status, res = live("POST", "/api/purge", {"all": True})
    assert outside.read_text() == "precious", "never deleted"
    assert live("POST", "/api/trash", {"filename": "../thesis.pdf", "trashed": True})[0] == 400
    assert live("POST", "/api/trash", {"filename": str(outside), "trashed": True})[0] == 400


def srv_port(live):
    return live.port


def test_only_this_computer_and_its_own_page_can_use_the_server(live, srv):
    """Review finding: any website could POST to the local server (empty the trash, switch project); a renamed domain pointing at
    127.0.0.1 could read it; the repo's key files were served."""
    import http.client, json as _json
    def raw(method, path, headers, body=None):
        c = http.client.HTTPConnection("127.0.0.1", srv_port(live), timeout=10)
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse(); data = r.read(); c.close()
        return r.status
    assert raw("POST", "/api/purge", {"Content-Type": "text/plain", "Origin": "https://evil.example"}, '{"all": true}') == 403
    assert raw("POST", "/api/purge", {"Content-Type": "application/json", "Origin": "http://localhost:5173"}, '{"filenames": []}') == 200
    assert raw("GET", "/api/state", {"Host": "evil.example:8765"}) == 403, "DNS rebinding"
    assert raw("GET", "/studio/.secrets.json", {}) == 404 and raw("GET", "/studio/.krea_auth.json", {}) == 404
    assert raw("GET", "/assets/../studio/.secrets.json", {}) in (403, 404)


def test_a_refused_kimi_key_is_not_kept(live, srv):
    """Kimi refuses it (every endpoint says 401): the key before stays and the page is told why; a good one is kept."""
    status, d = live("POST", "/api/save-settings", {"kimi_api_key": "depiano-bad-password"})
    assert status == 200 and d["ok"] is False and d["kimi_key_status"] == "refused" and "sk-" in d["error"]
    assert srv.load_state()["kimi_api_key"] == "sk-test"
    status, d = live("POST", "/api/save-settings", {"kimi_api_key": "sk-good"})
    assert d["ok"] and d["kimi_key_status"] == "ok" and srv.load_state()["kimi_api_key"] == "sk-good"


def test_kimi_endpoint_that_took_the_key_comes_first(srv, monkeypatch):
    monkeypatch.setattr(srv, "KIMI_ENDPOINT", {})
    assert srv.kimi_endpoints("sk-abc")[0].startswith("https://api.moonshot.ai")
    srv.KIMI_ENDPOINT["sk-abc"] = "https://api.kimi.com/coding/v1/chat/completions"
    eps = srv.kimi_endpoints("sk-abc")
    assert eps[0] == "https://api.kimi.com/coding/v1/chat/completions" and len(eps) == 3 and len(set(eps)) == 3


def test_delete_project_over_http_opens_the_next_and_waits_for_a_running_job(live, srv, tmp_path, monkeypatch):
    import base64
    from test_projects import star_png
    monkeypatch.setattr(srv.projects, "TRASH_DIR", tmp_path / "Trash")
    status, d = live("POST", "/api/projects", {"action": "create", "name": "Night Owl", "mark": "data:image/png;base64," + base64.b64encode(star_png()).decode()})
    assert status == 200 and d["active"] == "night-owl"
    monkeypatch.setattr(srv, "busy", lambda: True)
    assert live("POST", "/api/projects", {"action": "delete", "slug": "night-owl"})[0] == 409, "not while something runs"
    monkeypatch.setattr(srv, "busy", lambda: False)
    status, d = live("POST", "/api/projects", {"action": "delete", "slug": "night-owl"})
    assert status == 200 and d["active"] == "demo" and all(p["slug"] != "night-owl" for p in d["projects"]), "gone; the next one is open"
    assert (tmp_path / "Trash" / "Night Owl (Phosphene project)").is_dir()


def test_the_page_holds_the_server_busy_for_a_whole_job_and_it_lapses(live, srv, monkeypatch):
    """Between two images nothing is in flight: the page's lease keeps busy() true (no switch from elsewhere, no dev restart in a gap)."""
    assert live("GET", "/api/busy")[1]["busy"] is False
    assert live("POST", "/api/busy", {"for": 30})[1]["busy"] is True
    status, r = live("POST", "/api/projects", {"action": "switch", "slug": "demo"})
    assert status == 409 and r["busy"], "no project switch from another window or the Mac menu mid-job"
    assert live("POST", "/api/busy", {"for": 0})[1]["busy"] is False, "ended by the page"
    live("POST", "/api/busy", {"for": 999})
    assert srv._LEASE["until"] - srv.time.time() <= 60, "never held long: it lapses if the page goes away"
    live("POST", "/api/busy", {"for": 0})


def test_a_request_for_another_project_is_refused(live, srv):
    """A second window, or a file opened from Finder, changed the project: a job's request for the one before never lands in this one."""
    status, r = live("POST", "/api/trash", {"filename": "x.jpg", "trashed": True}, headers={"X-Phosphene-Project": "not-this-one"})
    assert status == 409 and r["project_changed"]
    status, r = live("POST", "/api/trash", {"filename": "nope.jpg", "trashed": True}, headers={"X-Phosphene-Project": "demo"})
    assert status != 409, "the open project's own requests go through"


def test_an_unexpected_territory_is_kept_and_listed_once_it_has_an_image(live, srv, monkeypatch):
    # since the merge above, the territory Kimi invented was dropped with the rest of what the step changed: its image was
    # tagged "Salt & Tide", which the territory list never showed
    import json as _json
    world = {"name": "Salt & Tide", "brief": "Harbours. Brine.", "palette": "grey and rust", "applications": ["tarred rope coil", "wiped porthole glass"] + [f"thing {i}" for i in range(8)], "marks": ["etched", "stamped", "cast", "woven", "lit"]}
    shots = [{"title": "Wiped Porthole Glass", "subject": "porthole", "idea": "i", "guide": "dark", "prompt": "a wiped porthole glass, harbour light"}]
    monkeypatch.setattr(srv, "call_kimi_llm", lambda prompt, **k: _json.dumps(world if "Invent ONE new creative world" in prompt else shots))
    status, res = live("POST", "/api/invent-prompts", {"count": 1, "world": "__wildcard__"})
    assert status == 200 and res["ideas"][0]["world"] == "Salt & Tide", res
    assert [w["name"] for w in srv.load_state().get("custom_worlds", [])] == ["Salt & Tide"], "the invented territory is saved"
    assert "Salt & Tide" not in [w["name"] for w in live("GET", "/api/worlds")[1]["worlds"]], "listed only once it has an image"
    live("POST", "/api/generate-image", {"title": "Wiped Porthole Glass", "prompt": "p", "model": "m", "world": "Salt & Tide"})
    listed = {w["name"]: w["origin"] for w in live("GET", "/api/worlds")[1]["worlds"]}
    assert listed["Salt & Tide"] == "invented" and listed["Editorial Print"] == "core", "where each comes from: Kimi's, built in"
    world["name"] = "Fog & Vapor"                                                   # Describe your own: yours
    brief = "Fog, clouds, rain. " + "Low cloud over wet stone, never a sunny sky. " * 40   # a whole brief, past the old 300 characters
    _, res = live("POST", "/api/invent-prompts", {"count": 1, "world": "__custom__", "direction": brief})
    assert res["world"] == "Fog & Vapor", "the page learns the territory it made, to carry on in it"
    live("POST", "/api/generate-image", {"title": "Fog Bank", "prompt": "p", "model": "m", "world": "Fog & Vapor"})
    mine = next(w for w in live("GET", "/api/worlds")[1]["worlds"] if w["name"] == "Fog & Vapor")
    assert mine["origin"] == "custom" and mine["prompt"] == brief.strip(), "your words, whole and as written"


def test_the_sampler_writes_one_scene_in_each_of_the_territories_tried_least(live, srv, monkeypatch):
    import json as _json
    import threading as _th
    asked, lock = [], _th.Lock()
    def kimi(prompt, **k):
        world = next(w["name"] for w in srv.chapters.WORLDS if w["name"] in prompt)
        with lock:
            asked.append(world)
        return _json.dumps([{"title": f"Shot in {world}", "subject": f"subject {world}", "idea": "i", "guide": "dark", "prompt": f"a {world} scene, unique {len(asked)}"}])
    monkeypatch.setattr(srv, "call_kimi_llm", kimi)
    st = srv.load_state()
    tried = srv.chapters.WORLDS[0]["name"]
    st.setdefault("worlds", {})["x.jpg"] = tried                                       # one territory already tried: it comes last
    srv.save_state(st)
    status, res = live("POST", "/api/invent-prompts", {"count": 4, "world": "__sampler__"})
    assert status == 200 and len(res["ideas"]) == 4, res
    worlds = [i["world"] for i in res["ideas"]]
    assert len(set(worlds)) == 4 and tried not in worlds, "four different territories, the least tried"
    st = srv.load_state()
    assert all(w in st.get("recent_subjects", {}) for w in worlds), "each one's memory kept, so later batches do not repeat it"


def test_kimi_writing_scenes_never_undoes_what_was_trashed_meanwhile_nor_writes_into_another_project(live, srv, monkeypatch):
    """invent-prompts used to save the state it read before Kimi's seconds-long call: a trash made meanwhile was undone."""
    import json as _json
    _three_plates(live)
    name = live("GET", "/api/state")[1]["plates"][0]["filename"]
    shots = [{"title": "Fresh Idea", "subject": "s", "idea": "i", "guide": "dark", "prompt": "basalt monolith glacier scene"}]
    def kimi_while_the_user_trashes(prompt, **k):
        live("POST", "/api/trash", {"filename": name, "trashed": True})          # done while Kimi writes
        return _json.dumps(shots)
    monkeypatch.setattr(srv, "call_kimi_llm", kimi_while_the_user_trashes)
    live("POST", "/api/invent-prompts", {"count": 1, "world": "Editorial Print"})
    st = srv.load_state()
    assert name in st["trashed"], "the trash made during the call is kept"
    assert "Fresh Idea" in st["history"], "and the new titles are added"
    assert st["recent_worlds"][-1] == "Editorial Print" and st.get("recent_axes"), "and the memory that keeps batches from repeating"


def test_a_loose_batch_gives_each_image_its_own_place_kept_with_it(live, srv, monkeypatch, tmp_path):
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    checked = []
    monkeypatch.setattr(srv, "check_new_image", lambda p, pl=None, mark_id=None: checked.append(pl) or {"qa_passed": True, "qa_score": 90, "issues": [], "center_corr": 0.9, "core_asymmetry": 0.2})
    _, on = live("POST", "/api/generate-image", {"title": "On Target", "prompt": "a basalt slab", "model": "m"})
    assert on["placement"] is None and checked[-1] is None
    assert "EXACT DEAD-CENTER" in live.calls["krea"][-1]["prompt"], "on target: the words it always had"
    _, res = live("POST", "/api/generate-image", {"title": "Loose One", "prompt": "a basalt slab", "model": "m", "target": "loose"})
    pl = res["placement"]
    assert pl["kind"] == "loose" and checked[-1] == pl, "the logo check measures it where it was placed"
    kw = live.calls["krea"][-1]
    assert f"EXACT POINT {pl['x']:g}% from the left and {pl['y']:g}% from the top" in kw["prompt"] and f"~{pl['size']:g}% frame width" in kw["prompt"]
    assert kw["guide"]["files"]["dark"].exists(), "its own guide, drawn at its place"
    assert srv.load_state()["placements"] == {res["filename"]: pl}
    plates = {p["filename"]: p for p in live("GET", "/api/state")[1]["plates"]}
    assert plates[res["filename"]]["placement"] == pl and plates[on["filename"]]["placement"] is None, "the page draws each image's own box"


def test_an_image_is_made_at_the_place_its_scene_was_written_for(live, srv, monkeypatch, tmp_path):
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    _, ideas = live("POST", "/api/invent-prompts", {"count": 2, "world": "Editorial Print", "target": "loose"})
    pl = ideas["ideas"][0]["placement"]
    assert pl["kind"] == "loose"
    _, res = live("POST", "/api/generate-image", {"title": "Placed", "prompt": "p", "model": "m", "target": "loose", "placement": pl})
    assert res["placement"] == pl and f"EXACT POINT {pl['x']:g}%" in live.calls["krea"][-1]["prompt"]
    _, bad = live("POST", "/api/generate-image", {"title": "Odd", "prompt": "p", "model": "m", "target": "loose", "placement": {"kind": "loose", "x": 500}})
    assert bad["placement"]["kind"] == "loose" and bad["placement"]["x"] < 100, "an odd one from outside: a fresh place instead"


def test_a_path_batch_walks_its_images_along_the_line_and_an_angled_size_batch_takes_turns(live, srv, monkeypatch, tmp_path):
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    _, ideas = live("POST", "/api/invent-prompts", {"count": 3, "world": "Editorial Print", "target": "path", "path": {"shape": "line", "dir": 0, "len": 40}})
    pls = [i["placement"] for i in ideas["ideas"]]
    assert [p["path"]["i"] for p in pls] == [0, 1, 2] and pls[0]["x"] < pls[1]["x"] < pls[2]["x"], "in order, left to right"
    assert len({p["path"]["run"] for p in pls}) == 1, "one batch, one run"
    assert "| the mark: " in live.calls["kimi"][-1], "Kimi is told where each shot's mark is"
    _, res = live("POST", "/api/generate-image", {"title": "Step", "prompt": "p", "model": "m", "target": "path", "placement": pls[2]})
    assert res["placement"] == pls[2] and srv.load_state()["placements"][res["filename"]] == pls[2]
    _, turned = live("POST", "/api/invent-prompts", {"count": 4, "world": "Editorial Print", "rot": "0,90", "scale": "1,1.25"})
    pls = [i["placement"] or {} for i in turned["ideas"]]
    assert sorted(p.get("rot", 0) for p in pls) == [0, 0, 90, 90] and sorted(p.get("scale", 1) for p in pls) == [1, 1, 1.25, 1.25]
    assert "| the mark turned 90° clockwise" in live.calls["kimi"][-1]


def test_a_path_run_knows_its_missing_steps_and_make_n_fills_just_those(live, srv, monkeypatch, tmp_path):
    """Claude Design's PathMissing: a run's steps not in the Selection (never made, or trashed) are made again at their own places,
    in the same run, with the turns they had; a run from before (no record) is read off its images."""
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    path = {"shape": "line", "dir": 90, "len": 40}
    _, made = live("POST", "/api/invent-prompts", {"count": 4, "world": "Editorial Print", "target": "path", "path": path, "rot": "0,90"})
    ideas = made["ideas"]
    run = ideas[0]["placement"]["path"]["run"]
    names = {}
    for k in (0, 1, 3):                                                  # step 2 never made (a failure nobody retried)
        _, res = live("POST", "/api/generate-image", {"title": ideas[k]["title"], "prompt": ideas[k]["prompt"], "model": "m", "target": "path", "placement": ideas[k]["placement"], "world": ideas[k]["world"]})
        names[k] = res["filename"]
    live("POST", "/api/trash", {"filename": names[3], "trashed": True})  # step 3 trashed
    _, st = live("GET", "/api/state")
    [r] = [r for r in st["path_runs"] if r["run"] == run]
    assert (r["n"], r["dir"], r["len"], r["world"]) == (4, 90, 40, "Editorial Print") and r["at"] > 0
    _, filled = live("POST", "/api/invent-prompts", {"fill": run})
    pls = [i["placement"] for i in filled["ideas"]]
    assert sorted(p["path"]["i"] for p in pls) == [2, 3] and {p["path"]["run"] for p in pls} == {run} and {p["path"]["n"] for p in pls} == {4}
    want = {i["placement"]["path"]["i"]: i["placement"] for i in ideas}
    assert all((p["x"], p["y"], p.get("rot", 0)) == (want[p["path"]["i"]]["x"], want[p["path"]["i"]]["y"], want[p["path"]["i"]].get("rot", 0)) for p in pls), "the same places and angles"
    assert all(i["world"] == "Editorial Print" for i in filled["ideas"]), "the run's own territory"
    live("POST", "/api/trash", {"filename": names[3], "trashed": False})   # restoring fills its step
    assert [p["path"]["i"] for p in [i["placement"] for i in live("POST", "/api/invent-prompts", {"fill": run})[1]["ideas"]]] == [2]
    st = srv.load_state(); st.pop("path_runs"); srv.save_state(st)          # a run from before: read off its images
    again = live("POST", "/api/invent-prompts", {"fill": run})[1]["ideas"]
    assert [(i["placement"]["path"]["i"], i["placement"].get("rot", 0)) for i in again] == [(2, want[2].get("rot", 0))]
    status, none = live("POST", "/api/invent-prompts", {"fill": "fff"})
    assert status == 400 and none["ok"] is False


def test_the_menus_strip_shows_the_places_a_scattered_batch_will_use(live, srv, monkeypatch, tmp_path):
    """Loose and Scattered: the server picks each image's place from the page's seed before Generate, the strip draws them, and the
    batch made with the same seed uses exactly those (the user: "is this exactly how they will be positioned?")."""
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    for target in ("scattered", "loose"):
        _, shown = live("GET", f"/api/placements?target={target}&mark=main&rot=0,90&n=4&seed=abc123")
        places = shown["places"]
        assert [p["i"] for p in places] == [0, 1, 2, 3] and all(p["kind"] == target for p in places)
        assert [p.get("rot", 0) for p in places] == [0, 0, 90, 90] or [p.get("rot", 0) for p in places] == [0, 90, 0, 90]
        _, again = live("GET", f"/api/placements?target={target}&mark=main&rot=0,90&n=6&seed=abc123")
        assert again["places"][:4] == places, "a bigger count keeps the first images' places"
        _, other = live("GET", f"/api/placements?target={target}&mark=main&rot=0,90&n=4&seed=zzz")
        assert other["places"] != places, "another seed, other places"
        _, made = live("POST", "/api/invent-prompts", {"count": 4, "world": "Editorial Print", "target": target, "rot": "0,90", "seed": "abc123"})
        got = [{k: i["placement"][k] for k in ("x", "y", "size")} for i in made["ideas"]]
        assert got == [{k: p[k] for k in ("x", "y", "size")} for p in places], "the batch is what the strip drew"
    _, sampled = live("POST", "/api/invent-prompts", {"count": 2, "world": "__sampler__", "target": "scattered", "seed": "abc123"})
    _, shown = live("GET", "/api/placements?target=scattered&mark=main&n=2&seed=abc123")
    assert sorted((i["placement"]["x"], i["placement"]["y"]) for i in sampled["ideas"]) == sorted((p["x"], p["y"]) for p in shown["places"]), "the Sampler too"
    _, none = live("GET", "/api/placements?target=scattered&n=4")
    assert none["places"] == [], "no seed: nothing to show"


def test_a_project_with_several_marks_makes_each_image_with_its_own(live, srv, monkeypatch, tmp_path):
    """Other marks besides the main one: a batch uses the main one, one chosen, or a Mix; each image remembers its mark, and its
    guide, prompt, logo check and box follow it. Images without one are the main mark's, as before."""
    import base64
    from test_projects import ring_png, star_png
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    url = lambda b: "data:image/png;base64," + base64.b64encode(b).decode()
    live("POST", "/api/projects", {"action": "create", "name": "Kestrel", "mark": url(star_png()), "mark_shape": "oval badge", "mark_noun": "badge"})
    status, res = live("POST", "/api/projects", {"action": "add_mark", "slug": "Kestrel", "name": "Bird", "mark": url(ring_png()), "size": 14, "shape": "a flying bird", "noun": "bird symbol"})
    assert status == 200 and [m["id"] for m in res["project"]["marks"]] == ["bird"], res
    assert live("GET", "/api/project-mark?p=Kestrel&m=bird")[0] == 200
    checked = []
    monkeypatch.setattr(srv, "check_new_image", lambda p, pl=None, mark_id=None: checked.append(mark_id) or {"qa_passed": True, "qa_score": 90, "issues": [], "center_corr": 0.9, "core_asymmetry": 0.2})
    _, main = live("POST", "/api/generate-image", {"title": "Main One", "prompt": "a tin", "model": "m"})
    assert main["mark"] is None and checked[-1] is None and "SINGLE badge" in live.calls["krea"][-1]["prompt"]
    _, bird = live("POST", "/api/generate-image", {"title": "Bird One", "prompt": "a tin", "model": "m", "mark": "bird"})
    kw = live.calls["krea"][-1]
    assert bird["mark"] == "bird" and checked[-1] == "bird", "the logo check measures the bird"
    assert "SINGLE bird symbol" in kw["prompt"] and "~14% frame width" in kw["prompt"], "the prompt names it, at its own size"
    assert kw["guide"]["files"]["dark"].exists(), "and its own guide"
    assert srv.load_state()["marks_used"] == {bird["filename"]: "bird"}
    plates = {p["filename"]: p for p in live("GET", "/api/state")[1]["plates"]}
    assert plates[bird["filename"]]["mark_name"] == "Bird" and plates[bird["filename"]]["box"]["size"] == 14
    assert plates[main["filename"]]["mark"] is None and plates[main["filename"]]["box"] is None, "a main-mark image: as before"
    _, ideas = live("POST", "/api/invent-prompts", {"count": 2, "world": "Editorial Print", "mark": "bird"})
    assert all(i["mark"] == "bird" for i in ideas["ideas"]) and "which mark: the bird symbol (a flying bird)" in live.calls["kimi"][-1]
    _, both = live("POST", "/api/invent-prompts", {"count": 2, "world": "Editorial Print", "mark": "main,bird"})
    assert sorted(str(i["mark"]) for i in both["ideas"]) == ["None", "bird"], "two marks ticked: they take turns"
    _, one = live("POST", "/api/invent-prompts", {"count": 2, "world": "Editorial Print"})
    assert all(i["mark"] is None for i in one["ideas"]) and "which mark:" not in live.calls["kimi"][-1], "the main mark: as before"
    live("POST", "/api/projects", {"action": "remove_mark", "slug": "Kestrel", "mark_id": "bird"})
    plates = {p["filename"]: p for p in live("GET", "/api/state")[1]["plates"]}
    assert plates[bird["filename"]]["mark"] is None, "a mark since removed: its images read as the main one's"


def test_keep_it_as_designed_shows_krea_the_marks_own_colours_and_asks_for_it_unchanged(live, srv, monkeypatch, tmp_path):
    import base64
    from PIL import Image
    from test_projects import star_png
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    live("POST", "/api/projects", {"action": "create", "name": "Badge", "mark": "data:image/png;base64," + base64.b64encode(star_png()).decode(), "mark_noun": "badge"})
    _, plain = live("POST", "/api/generate-image", {"title": "Plain", "prompt": "a wall", "model": "m"})
    assert "AS DESIGNED" not in live.calls["krea"][-1]["prompt"], "off by default"
    _, kept = live("POST", "/api/generate-image", {"title": "Kept", "prompt": "a wall", "model": "m", "keep": True})
    kw = live.calls["krea"][-1]
    assert kept["keep"] is True and "reproduced EXACTLY AS DESIGNED" in kw["prompt"] and "#F03C14" in kw["prompt"], "its own colours, named"
    g = Image.open(kw["guide"]["files"]["light"]).convert("RGB")
    assert (240, 60, 20) in {c for _, c in g.getcolors(1 << 20)}, "the guide shows the mark in its own orange, not a silhouette"
    plates = {p["filename"]: p for p in live("GET", "/api/state")[1]["plates"]}
    assert plates[kept["filename"]]["as_designed"] is True and plates[plain["filename"]]["as_designed"] is False
    live("POST", "/api/invent-prompts", {"count": 1, "world": "Editorial Print", "keep": True})
    assert "THE MARK IS KEPT EXACTLY AS DESIGNED" in live.calls["kimi"][-1]


def test_the_settings_form_over_http_saves_marks_and_make_default_measures_nothing_again(live, srv, monkeypatch, tmp_path):
    """What the form sends on Save: the project, the default mark, the others (a new one with its image), then Make default by its
    place in the list. Every image keeps its check result and the mark it was made with; nothing is measured again (on a big mark it
    took over 10 minutes)."""
    import base64
    from test_projects import ring_png, star_png
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    url = lambda b: "data:image/png;base64," + base64.b64encode(b).decode()
    live("POST", "/api/projects", {"action": "create", "name": "Halo", "mark": url(star_png()), "mark_noun": "ring"})
    _, img = live("POST", "/api/generate-image", {"title": "One", "prompt": "a wall", "model": "m"})
    pr = live("GET", "/api/state")[1]["project"]
    assert pr["brief"] == "" and pr["mark_shape"] == "", "the form shows what was set, not the fallbacks"
    base = {"action": "update", "slug": "halo", "name": "Halo", "brief": "", "palette": [], "mark_name": "Ring", "mark_size": 18, "mark_x": 50, "mark_y": 50, "mark_shape": "", "mark_noun": "ring"}
    _, r = live("POST", "/api/projects", {**base, "marks": [{"name": "Swoosh", "size": 22, "x": 50, "y": 70, "noun": "swoosh", "image": url(ring_png())}]})
    assert [(m["id"], m["y"]) for m in r["project"]["marks"]] == [("swoosh", 70.0)]
    assert srv.projects.load("halo")["own"]["brief"] == "", "an unset brand line stays unset"
    before = {p["filename"]: (p["qa_passed"], p["mark"]) for p in live("GET", "/api/state")[1]["plates"]}
    measured = []
    monkeypatch.setattr(srv, "evaluate_plate_qa", lambda *a, **k: measured.append(a) or {"qa_passed": False, "qa_score": 0, "issues": ["x"]})
    _, r = live("POST", "/api/projects", {**base, "marks": [{"id": "swoosh", "name": "Swoosh", "size": 22, "x": 50, "y": 70, "noun": "swoosh"}], "default_index": 0})
    assert r["project"]["mark_name"] == "Swoosh" and r["project"]["mark_y"] == 70
    after = {p["filename"]: (p["qa_passed"], p["mark"]) for p in live("GET", "/api/state")[1]["plates"]}
    assert measured == [], "the results carried over, nothing measured again"
    assert after[img["filename"]] == (before[img["filename"]][0], "swoosh"), "its check result, and it says it was made with the old default"


def test_an_uploaded_image_joins_the_project_framed_and_marked_as_uploaded_with_no_mark_check(live, srv):
    import io
    from PIL import Image
    buf = io.BytesIO(); Image.new("RGB", (3000, 2000), (200, 40, 40)).save(buf, "JPEG")   # a landscape photo: framed here if the page did not
    called = []
    srv.get_cached_qa, real = (lambda *a, **k: called.append(a) or {"qa_passed": False, "qa_score": 0, "issues": ["x"]}), srv.get_cached_qa
    try:
        status, r = live("POST", "/api/upload-image?name=IMG_0042.HEIC", raw=buf.getvalue())
        assert status == 200 and r["ok"] and r["title"] == "IMG_0042", r
        assert Image.open(srv.PLATES_DIR / r["filename"]).size == (srv.TARGET_W, srv.TARGET_H), "the film's frame"
        plate = next(p for p in live("GET", "/api/state")[1]["plates"] if p["filename"] == r["filename"])
        assert plate["uploaded"] is True and plate["qa_passed"] is True and plate["model"] is None and not plate["trashed"]
        assert not any(a and getattr(a[0], "name", "") == r["filename"] for a in called), "never measured for a mark"
        assert srv.load_state()["uploads"] == [r["filename"]]
        assert live("POST", "/api/upload-image?name=x.png", raw=b"not an image")[0] == 400
    finally:
        srv.get_cached_qa = real


def test_a_project_of_your_own_images_starts_with_no_mark_and_generates_once_one_is_added(live, srv, tmp_path):
    import base64, io
    from PIL import Image
    from test_projects import star_png
    status, r = live("POST", "/api/projects", {"action": "create", "name": "Moodboard", "no_mark": True, "brief": "Spring lookbook"})
    assert status == 200 and r["project"]["has_mark"] is False and r["project"]["marks"] == [], r
    buf = io.BytesIO(); Image.new("RGB", (1080, 1920), (30, 30, 30)).save(buf, "JPEG")
    assert live("POST", "/api/upload-image?name=look.jpg", raw=buf.getvalue())[1]["ok"]
    state = live("GET", "/api/state")[1]
    assert [p["uploaded"] for p in state["plates"]] == [True]
    status, gen = live("POST", "/api/invent-prompts", {"count": 2, "world": "Editorial Print"})
    assert status == 409 and gen["no_mark"], "nothing to generate around yet"
    assert live("POST", "/api/generate-image", {"title": "x", "prompt": "p", "model": "m"})[1]["no_mark"]
    out = tmp_path / "m.phos"
    srv.projects.export_zip("moodboard", out)                                     # travels without a mark, and comes back so
    back = srv.projects.import_zip(out)
    assert back["has_mark"] is False and len(list(back["plates_dir"].glob("*.jpg"))) == 1
    _, r = live("POST", "/api/projects", {"action": "update", "slug": "moodboard", "name": "Moodboard", "brief": "Spring lookbook", "palette": [],
                                          "mark": "data:image/png;base64," + base64.b64encode(star_png()).decode(), "mark_name": "Star", "mark_size": 20, "mark_x": 50, "mark_y": 50, "marks": []})
    assert r["project"]["has_mark"] is True and r["project"]["mark_name"] == "Star"
    assert srv.projects.load("moodboard")["guides"]["dark"].is_file(), "its guides, made with it"
    assert live("POST", "/api/invent-prompts", {"count": 1, "world": "Editorial Print"})[0] == 200, "now it generates"


def test_make_n_of_frames_writes_one_scene_for_each_listed_frame(live, srv, monkeypatch, tmp_path):
    """A frame short of images (Made with › Mark: Frames 10 · 10 · 6 · 10, Make 4): the listed marks, one scene each, in the row's
    territory; a Path in the row is made on target (they are no run's steps)."""
    import base64
    from test_projects import ring_png, star_png
    monkeypatch.setattr(srv.placement, "GUIDE_DIR", tmp_path / "guides")
    url = lambda b: "data:image/png;base64," + base64.b64encode(b).decode()
    live("POST", "/api/projects", {"action": "create", "name": "Sphere", "mark": url(star_png()), "mark_shape": "striped sphere", "mark_noun": "sphere"})
    live("POST", "/api/projects", {"action": "add_mark", "slug": "sphere", "name": "Frame 2", "mark": url(ring_png()), "size": 18, "id": "f2"})
    [f2] = [m["id"] for m in srv.PROJECT["marks"]]
    _, res = live("POST", "/api/invent-prompts", {"deal": f"{f2},{f2},main", "count": 9, "world": "Editorial Print", "target": "path", "path": {"shape": "line"}})
    assert res["ok"] and [i["mark"] for i in res["ideas"]] == [f2, f2, None], "as listed, the count from the list"
    assert all(not (i["placement"] or {}).get("path") for i in res["ideas"]) and not srv.load_state().get("path_runs"), "no run recorded"


def test_skip_per_group_through_the_server_and_in_the_state(live):
    """Skip and Play go through /api/groups and come back in /api/state per group key, only for images that exist."""
    for i in range(3):
        live("POST", "/api/generate-image", {"title": f"S{i}", "prompt": "p", "model": "m"})
    names = [p["filename"] for p in live("GET", "/api/state")[1]["plates"]]
    assert live("POST", "/api/groups", {"action": "skip", "key": "all", "files": [names[0], "gone.jpg"]})[0] == 200
    assert live("POST", "/api/groups", {"action": "skip", "key": "look:dark", "files": [names[1]]})[0] == 200
    st = live("GET", "/api/state")[1]
    assert st["skips"] == {"all": [names[0]], "look:dark": [names[1]]}
    assert [p["filename"] for p in st["plates"]] == names, "nothing moved, nothing trashed"
    live("POST", "/api/groups", {"action": "skip", "key": "all", "files": [names[0]], "skip": False})
    assert live("GET", "/api/state")[1]["skips"] == {"look:dark": [names[1]]}


def test_the_last_batch_is_remembered_across_reloads(live):
    """Curate's Last batch: the images of the latest batch (the page sends its id with each), kept by the server; a Retry of the same
    batch adds to it, the next batch replaces it; no id (an old page), nothing changes."""
    names = lambda: [p["filename"] for p in live("GET", "/api/state")[1]["plates"]]
    live("POST", "/api/generate-image", {"title": "A1", "prompt": "p", "model": "m", "batch": "b1"})
    live("POST", "/api/generate-image", {"title": "A2", "prompt": "p", "model": "m", "batch": "b1"})
    first = names()
    assert live("GET", "/api/state")[1]["last_batch"] == first
    live("POST", "/api/generate-image", {"title": "B1", "prompt": "p", "model": "m", "batch": "b2"})
    assert live("GET", "/api/state")[1]["last_batch"] == [n for n in names() if n not in first], "the next batch replaces it"
    before = live("GET", "/api/state")[1]["last_batch"]
    live("POST", "/api/generate-image", {"title": "C1", "prompt": "p", "model": "m"})
    live("POST", "/api/generate-image", {"title": "C2", "prompt": "p", "model": "m", "batch": "../x"})
    assert live("GET", "/api/state")[1]["last_batch"] == before, "no id, or a strange one: unchanged"


def test_generate_image_gives_a_dark_mark_the_light_guide_and_logs_it(live, srv, monkeypatch):
    seen = []
    real = srv.generate_plate_via_krea_mcp

    def spy(**kw):
        seen.append(kw.get("guide_type"))
        return real(**kw)
    monkeypatch.setattr(srv, "generate_plate_via_krea_mcp", spy)
    live("POST", "/api/generate-image", {"title": "Cream One", "prompt": "p", "guide": "dark", "model": "m"})
    assert seen[-1] == "dark", "Demo's cream mark: the guide its scene asked for"
    monkeypatch.setattr(srv.projects, "mark_tone", lambda path: 0.0)
    live("POST", "/api/generate-image", {"title": "Black One", "prompt": "p", "guide": "dark", "model": "m"})
    assert seen[-1] == "light", "a black mark: never drawn cream"
    assert [e for e in gen_log.read(None) if e.get("event") == "image_start"][-1]["guide"] == "light"



def _walk_project(live, srv, n=2):
    """A frames project, open, with `n` images on target of its second frame and one of its main frame."""
    import base64
    from test_projects import star_png
    png = "data:image/png;base64," + base64.b64encode(star_png()).decode()
    status, res = live("POST", "/api/projects", {"action": "create", "name": "Walk", "mark": png, "mark_size": 18, "frames": True, "marks": [{"name": "Two", "size": 18, "image": png}]})
    assert status == 200 and res["ok"], res
    p = res["project"]
    second = p["marks"][0]["id"]
    made = [live("POST", "/api/generate-image", {"title": f"T{i}", "prompt": "p", "guide": "dark", "mark": second})[1]["filename"] for i in range(n)]
    made.append(live("POST", "/api/generate-image", {"title": "Main", "prompt": "p", "guide": "dark"})[1]["filename"])
    return p, second, made


def test_changing_a_frames_size_keeps_the_images_already_made_at_theirs(live, srv):
    p, second, made = _walk_project(live, srv)
    before = {x["filename"]: x for x in live("GET", "/api/state")[1]["plates"]}
    measured = len(live.calls.get("qa", []))
    status, res = live("POST", "/api/projects", {"action": "update", "slug": p["slug"], "mark_size": 18, "marks": [{"id": second, "size": 10.5, "x": 48, "y": 50.3}]})
    assert status == 200 and res["ok"], res
    st = srv.load_state()
    assert st["placements"][made[0]] == {"kind": "exact", "x": 50.0, "y": 50.0, "size": 18.0, "held": 1}, "the frame moved: the image stays as made"
    assert made[2] not in st["placements"], "the main frame did not change"
    after = {x["filename"]: x for x in live("GET", "/api/state")[1]["plates"]}
    assert after[made[0]]["box"]["size"] == 18.0 and after[made[0]]["box"]["x"] == 50.0, "its target stays on it"
    assert after[made[0]]["qa_passed"] == before[made[0]]["qa_passed"]
    assert srv.get_cached_qa(srv.PLATES_DIR / made[0], st["placements"][made[0]], second) == srv.QA_CACHE[srv._plate_key(srv.PLATES_DIR / made[0], st["placements"][made[0]], second)], "carried, not measured again"
    new = live("POST", "/api/generate-image", {"title": "New", "prompt": "p", "guide": "dark", "mark": second})[1]["filename"]
    assert new not in srv.load_state().get("placements", {}), "a new image takes the new size"
    assert next(x for x in live("GET", "/api/state")[1]["plates"] if x["filename"] == new)["box"]["size"] == 10.5


def test_a_save_that_changes_no_size_holds_nothing(live, srv):
    p, second, made = _walk_project(live, srv)
    assert live("POST", "/api/projects", {"action": "update", "slug": p["slug"], "mark_size": 18, "name": "Walk 2", "marks": [{"id": second, "size": 18}]})[1]["ok"]
    assert not srv.load_state().get("placements")


def test_a_project_that_is_not_frames_works_as_before_when_a_size_changes(live, srv):
    p, second, made = _walk_project(live, srv)
    assert live("POST", "/api/projects", {"action": "update", "slug": p["slug"], "frames": False, "mark_size": 18, "marks": [{"id": second, "size": 30}]})[1]["ok"]
    assert not srv.load_state().get("placements"), "images read the mark's size, as ever"
