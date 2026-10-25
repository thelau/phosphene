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


GET_ENDPOINTS = ["/api/state", "/api/worlds", "/api/stats", "/api/version"]
POST_ENDPOINTS = ["/api/save-settings", "/api/reorder", "/api/sequence", "/api/trash", "/api/purge", "/api/invent-prompts", "/api/generate-image", "/api/order-ai", "/api/export-video", "/api/music", "/api/track", "/api/track-cuts"]


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
    status, ex = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2})
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
    status, res = live("POST", "/api/export-video", {"bpm": 120, "multiple": 1})
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
    out = subprocess.run(["/opt/homebrew/bin/ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    return [x["codec_type"] for x in data["streams"]], float(data["format"]["duration"])


def _three_plates(live):
    for i in range(3):
        live("POST", "/api/generate-image", {"title": f"M{i}", "prompt": "p", "model": "m"})


def test_music_endpoint_answers_a_wav_as_long_as_the_picture_will_be(live):
    import io
    import wave
    _three_plates(live)
    status, wav = live("POST", "/api/music", {"bpm": 120, "multiple": 2})
    assert status == 200 and wav[:4] == b"RIFF"
    with wave.open(io.BytesIO(wav)) as w:
        assert w.getnframes() / w.getframerate() == pytest.approx(3 * 7.5 / 30, abs=0.01)    # 3 images x 7.5 frames at 30fps


def test_export_with_music_has_an_audio_track_and_without_it_does_not(live, srv):
    _three_plates(live)
    status, plain = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2})
    assert status == 200 and _streams(srv.OUTPUTS_DIR / plain["filename"])[0] == ["video"] and "music" not in plain["filename"]
    status, withm = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2, "music": "synth"})
    assert status == 200 and withm["music"] is True and withm["music_mode"] == "synth" and "music" in withm["filename"]
    kinds, seconds = _streams(srv.OUTPUTS_DIR / withm["filename"])
    assert sorted(kinds) == ["audio", "video"]
    assert gen_log.read(None)[-1]["music"] == "synth"


# ---------- a music track that drives the cuts ----------

def _click_track_bytes(bpm=120, seconds=12, lead=0.5, fmt="wav", tmp_path=None):
    import numpy as np
    import beats as beats_mod
    sr = 44100
    t = np.arange(int(0.25 * sr)) / sr
    k = np.sin(2 * np.pi * (50 * t + 90 * (1 - np.exp(-40 * t)) / 40)) * np.exp(-t * 18)
    x = np.zeros(int(seconds * sr))
    for hit in np.arange(lead, seconds - 0.3, 60 / bpm):
        i = int(hit * sr)
        x[i:i + len(k)] += k[:len(x) - i]
    x = x / np.abs(x).max() * 0.8 + 0.01 * np.random.default_rng(0).standard_normal(len(x))
    path = tmp_path / "t.wav"
    import wave
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((x * 32767).astype("<i2").tobytes())
    if fmt == "mp3":
        out = tmp_path / "t.mp3"
        subprocess.run([beats_mod.FFMPEG, "-v", "error", "-y", "-i", str(path), "-b:a", "128k", str(out)], check=True)
        path = out
    return path.read_bytes()


def test_uploading_a_track_analyses_it_and_it_is_remembered(live, srv, tmp_path):
    assert live("GET", "/api/track")[1] == {"ok": True, "track": None}
    status, res = live("POST", "/api/track?name=My%20Track.mp3", raw=_click_track_bytes(tmp_path=tmp_path, fmt="mp3"))
    assert status == 200 and res["ok"] and res["track"]["name"] == "My Track.mp3"
    assert res["track"]["bpm"] == pytest.approx(120, rel=0.02) and res["track"]["n_hits"] >= 15 and res["track"]["duration"] == pytest.approx(12, abs=0.2)
    assert live("GET", "/api/track")[1]["track"]["name"] == "My Track.mp3"
    assert gen_log.read(None)[-1]["event"] == "track"
    assert live("POST", "/api/track", {"clear": True})[1]["track"] is None and live("GET", "/api/track")[1]["track"] is None


def test_a_bad_upload_is_refused_with_a_reason_and_keeps_the_previous_track(live, srv, tmp_path):
    live("POST", "/api/track?name=good.wav", raw=_click_track_bytes(tmp_path=tmp_path))
    status, res = live("POST", "/api/track?name=bad.mp3", raw=b"this is not music at all")
    assert status == 400 and "Could not read" in res["error"]
    assert live("GET", "/api/track")[1]["track"]["name"] == "good.wav"
    status, res = live("POST", "/api/track?name=empty.mp3", raw=b"")
    assert status == 413


def test_track_cuts_land_on_the_hits_and_follow_the_settings(live, tmp_path):
    _three_plates(live)
    live("POST", "/api/track?name=t.wav", raw=_click_track_bytes(tmp_path=tmp_path))
    status, res = live("POST", "/api/track-cuts", {"cut_on": "hits", "sensitivity": 1.0})
    assert status == 200 and res["ok"] and len(res["starts"]) == 4 and res["starts"][0] == 0.0
    gaps = [b - a for a, b in zip(res["starts"], res["starts"][1:])]
    assert all(g == pytest.approx(0.5, abs=0.05) for g in gaps)                 # a 120 BPM click: a cut every half second
    assert res["audio_start"] == pytest.approx(0.5, abs=0.05)                    # the sound starts on its first hit
    _, inv = live("POST", "/api/track-cuts", {"cut_on": "hits", "sensitivity": 1.0, "invert_mode": "mono"})
    assert len(inv["starts"]) == 7                                               # every image takes two cuts
    _, nudged = live("POST", "/api/track-cuts", {"cut_on": "hits", "sensitivity": 1.0, "nudge": 0.1})
    assert nudged["audio_start"] == pytest.approx(res["audio_start"] + 0.1) and nudged["starts"] == res["starts"]
    _, beats_ = live("POST", "/api/track-cuts", {"cut_on": "beats", "multiple": 2.0})
    assert [b - a for a, b in zip(beats_["starts"], beats_["starts"][1:])] == pytest.approx([0.25] * 3, abs=0.05)


def test_notes_mode_finds_the_pitch_changes_of_a_bass_line(live, tmp_path):
    import wave
    import test_beats
    _three_plates(live)
    x, times = test_beats.legato_line([(36, 0.5), (43, 0.25), (41, 0.375), (36, 0.5), (46, 0.5), (43, 0.5), (41, 0.5), (36, 1.0)], 4.5)
    path = tmp_path / "bass.wav"
    test_beats.save(x, path)
    live("POST", "/api/track?name=bass.wav", raw=path.read_bytes())
    assert live("GET", "/api/track")[1]["track"]["n_notes"] >= 6
    res = live("POST", "/api/track-cuts", {"cut_on": "notes", "sensitivity": 1.0})[1]
    assert res["ok"] and [b - a for a, b in zip(res["starts"], res["starts"][1:])] == pytest.approx([0.5, 0.25, 0.375], abs=0.05)


def test_track_cuts_without_a_track_say_so(live):
    _three_plates(live)
    status, res = live("POST", "/api/track-cuts", {})
    assert status == 400 and "No music track" in res["error"]


def test_the_player_sound_for_a_track_is_as_long_as_the_cuts(live, tmp_path):
    import io
    import wave
    _three_plates(live)
    live("POST", "/api/track?name=t.wav", raw=_click_track_bytes(tmp_path=tmp_path))
    params = {"music": "track", "cut_on": "hits", "sensitivity": 1.0}
    cuts = live("POST", "/api/track-cuts", params)[1]
    status, wav = live("POST", "/api/music", params)
    assert status == 200 and wav[:4] == b"RIFF"
    with wave.open(io.BytesIO(wav)) as w:
        assert w.getnframes() / w.getframerate() == pytest.approx(cuts["total"], abs=0.05)


def test_a_clip_longer_than_the_track_loops_the_track(live, tmp_path):
    import io
    import wave
    for i in range(14):
        live("POST", "/api/generate-image", {"title": f"L{i}", "prompt": "p", "model": "m"})
    live("POST", "/api/track?name=short.wav", raw=_click_track_bytes(seconds=4, tmp_path=tmp_path))
    params = {"music": "track", "cut_on": "hits", "sensitivity": 1.0}
    cuts = live("POST", "/api/track-cuts", params)[1]
    assert cuts["total"] > 4.0                                                   # 14 cuts do not fit in 4 s of music
    with wave.open(io.BytesIO(live("POST", "/api/music", params)[1])) as w:
        assert w.getnframes() / w.getframerate() == pytest.approx(cuts["total"], abs=0.05)


def test_export_with_a_track_cuts_on_its_hits_and_carries_its_sound(live, srv, tmp_path):
    _three_plates(live)
    live("POST", "/api/track?name=t.wav", raw=_click_track_bytes(tmp_path=tmp_path))
    status, res = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2, "music": "track", "cut_on": "hits", "sensitivity": 1.0})
    assert status == 200 and res["music_mode"] == "track" and "track" in res["filename"]
    kinds, seconds = _streams(srv.OUTPUTS_DIR / res["filename"])
    assert sorted(kinds) == ["audio", "video"] and seconds == pytest.approx(1.5, abs=0.15)      # three cuts of half a second
    assert gen_log.read(None)[-1]["music"] == "track"


def test_export_with_a_track_but_no_track_fails_cleanly(live):
    _three_plates(live)
    status, res = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2, "music": "track"})
    assert status == 500 and "No music track" in res["error"]


def test_music_options_are_clamped_and_defaults_fill_the_gaps(srv):
    o = srv.music_options({"pulse": 9, "low": -3, "bright": "x", "width": 0.25, "seed": "12", "style": "swell"})
    assert o == {"pulse": 1.0, "low": 0.0, "bright": 0.3, "width": 0.25, "space": 0.6, "power": 0.6, "seed": 12}   # the old styles are gone: only the drone


def test_music_endpoint_uses_the_settings_and_the_seed(live):
    _three_plates(live)
    base = {"bpm": 120, "multiple": 2, "seed": 1}
    a = live("POST", "/api/music", base)[1]
    assert a == live("POST", "/api/music", base)[1]
    assert a != live("POST", "/api/music", {**base, "seed": 2})[1]
    assert a != live("POST", "/api/music", {**base, "space": 0.0})[1]
    assert a != live("POST", "/api/music", {**base, "power": 0.0})[1]


def test_music_says_how_to_fix_it_when_numpy_is_missing(live, monkeypatch):
    import sys
    _three_plates(live)
    monkeypatch.setitem(sys.modules, "synth", None)
    monkeypatch.setitem(sys.modules, "beats", None)
    status, res = live("POST", "/api/music", {"bpm": 120, "multiple": 2})
    assert status == 500 and "pip3 install numpy" in res["error"]
    status, res = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2})   # the picture alone still exports
    assert status == 200
    status, res = live("POST", "/api/export-video", {"bpm": 120, "multiple": 2, "music": "synth"})
    assert status == 500 and "pip3 install numpy" in res["error"]
    status, res = live("POST", "/api/track?name=t.mp3", raw=b"x" * 500)           # reading a track needs numpy too, and says so
    assert status == 500 and "pip3 install numpy" in res["error"]


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
