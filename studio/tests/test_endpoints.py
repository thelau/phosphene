"""
The real HTTP server on a random port, with state, plates and secrets in a temp folder and fake Krea / Kimi.
Not exhaustive: it exists so a deleted or broken endpoint (it happened once) fails a test instead of the user's afternoon.
"""

import http.client
import io
import json
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
    monkeypatch.setattr(srv.subprocess, "Popen", lambda *a, **k: None)
    monkeypatch.setattr(srv, "TARGET_W", 54)
    monkeypatch.setattr(srv, "TARGET_H", 96)
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

    def call(method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
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
POST_ENDPOINTS = ["/api/save-settings", "/api/reorder", "/api/sequence", "/api/trash", "/api/purge", "/api/invent-prompts", "/api/generate-image", "/api/order-ai", "/api/export-video"]


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
