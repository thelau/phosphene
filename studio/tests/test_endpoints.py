"""
The real HTTP server on a random port, with state, plates and secrets in a temp folder and fake Krea / Kimi.
Not exhaustive: it exists so a deleted or broken endpoint (it happened once) fails a test instead of the user's afternoon.
"""

import http.client
import io
import json
import subprocess
import threading

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
    monkeypatch.setattr(srv, "get_cached_qa", lambda p: {"qa_passed": True, "qa_score": 90, "issues": [], "center_corr": 0.9, "core_asymmetry": 0.2})
    monkeypatch.setattr(srv, "apply_critic", lambda f: None)
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
    # Jobs live in a module-level dict: never let one test's background job leak into the next. By default a started job finishes instantly.
    srv.AI_JOBS.clear()
    real_job = srv.run_ai_order_job
    monkeypatch.setattr(srv, "run_ai_order_job", lambda job_id, *a, **k: srv.AI_JOBS[job_id].update(done=True, step=4, stage="Done"))
    st = srv.load_state()
    st["kimi_api_key"] = "sk-test"
    srv.save_state(st)
    httpd = srv.QuietServer(("127.0.0.1", 0), srv.StudioHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]

    def call(method, path, body=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
        if raw is not None:        # a file sent as it is (the music track)
            c.request(method, path, body=raw, headers={"Content-Type": "application/octet-stream"})
        else:
            c.request(method, path, body=json.dumps(body or {}) if method == "POST" else None, headers={"Content-Type": "application/json"})
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
    assert status == 200 and b"Match-Cut Studio" in (data if isinstance(data, bytes) else b"")


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


def test_a_logo_check_failure_is_recorded(live, srv, monkeypatch):
    monkeypatch.setattr(srv, "get_cached_qa", lambda p: {"qa_passed": False, "qa_score": 12, "issues": ["Low center logo fidelity"], "center_corr": 0.1, "core_asymmetry": 0.0})
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
    assert status == 500 and res["code"] == "content_policy" and "moderation rejected" in res["error"] and "even after" not in res["error"]
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
    assert status == 500 and "even after the prompt was softened" in res["error"] and len(calls) == 2
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
    assert status == 500 and res["code"] == "content_policy" and len(calls) == 1 and "even after" not in res["error"]


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
