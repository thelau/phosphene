import json
import time
import urllib.error

import pytest

import krea_mcp_client as k

IMAGE_MODELS = [
    "google/nano-banana-pro", "google/nano-banana-2.1", "google/nano-banana-2", "openai/gpt-image-2.5-flare",
    "openai/gpt-image-2.5-sunburst", "openai/gpt-image-2", "bytedance/seedream-5-pro", "ideogram/ideogram-4.5",
    "luma/uni-1", "meta/muse-image", "runway/gen-4-image", "krea/krea-3",
]
GUIDE = "https://x/guide.png"


@pytest.mark.parametrize("model", IMAGE_MODELS)
def test_every_model_payload_has_prompt_and_guide(model):
    p = k.build_model_input(model, "a prompt", GUIDE)
    assert p["prompt"] == "a prompt"
    assert GUIDE in json.dumps(p)


@pytest.mark.parametrize("model", ["google/nano-banana-pro", "google/nano-banana-2.1", "openai/gpt-image-2", "krea/krea-3", "meta/muse-image"])
def test_portrait_models_use_9_16(model):
    assert k.build_model_input(model, "p", GUIDE)["aspect_ratio"] == "9:16"


@pytest.mark.parametrize("model", ["bytedance/seedream-5-pro", "luma/uni-1", "runway/gen-4-image"])
def test_dimension_models_are_portrait_1080x1920(model):
    p = k.build_model_input(model, "p", GUIDE)
    assert (p["width"], p["height"]) == (1080, 1920)


def test_nano_banana_payload_exact():
    assert k.build_model_input("google/nano-banana-2.1", "p", GUIDE) == {
        "prompt": "p", "image_urls": [GUIDE], "aspect_ratio": "9:16", "resolution": "2K"}


def test_prompt_truncation_limits():
    long = "x" * 9000
    assert len(k.build_model_input("luma/uni-1", long, GUIDE)["prompt"]) == 6000
    assert len(k.build_model_input("runway/gen-4-image", long, GUIDE)["prompt"]) == 1000
    assert len(k.build_model_input("google/nano-banana-pro", long, GUIDE)["prompt"]) == 9000


def test_unknown_model_falls_back_to_nano_banana_shape():
    assert k.build_model_input("some/new-model", "p", GUIDE)["image_urls"] == [GUIDE]


# ---------- result parsing ----------

def test_extract_urls_structured_result():
    res = {"result": {"structuredContent": {"job_id": "j1", "result": {"urls": ["u1"]}}}}
    assert k.extract_urls_from_mcp_result(res) == (["u1"], "j1")


def test_extract_urls_from_text_block_and_top_level_urls():
    res = {"result": {"content": [{"type": "text", "text": json.dumps({"id": "j2", "urls": ["u2"]})}]}}
    assert k.extract_urls_from_mcp_result(res) == (["u2"], "j2")


def test_extract_urls_output_list_and_empty():
    assert k.extract_urls_from_mcp_result({"result": {"structuredContent": {"output": ["u3"]}}})[0] == ["u3"]
    assert k.extract_urls_from_mcp_result({}) == ([], "")
    assert k.extract_urls_from_mcp_result({"result": {"content": [{"type": "text", "text": "not json"}]}}) == ([], "")


# ---------- auth file ----------

def write_auth(path, **tokens):
    path.write_text(json.dumps({"krea": {"tokens": tokens, "clientInfo": {"clientId": "c"}}}))


def test_token_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(k, "MCP_AUTH_FILE", tmp_path / "none.json")
    assert k.get_krea_oauth_token() == {"connected": False, "token": None}


def test_token_valid(tmp_path, monkeypatch):
    f = tmp_path / "a.json"
    write_auth(f, accessToken="T", expiresAt=time.time() + 3600)
    monkeypatch.setattr(k, "MCP_AUTH_FILE", f)
    t = k.get_krea_oauth_token()
    assert t["connected"] and t["token"] == "T" and not t["expired"]


def test_token_refreshes_when_close_to_expiry(tmp_path, monkeypatch):
    f = tmp_path / "a.json"
    write_auth(f, accessToken="OLD", expiresAt=time.time() + 10)
    monkeypatch.setattr(k, "MCP_AUTH_FILE", f)

    def fake_refresh():
        write_auth(f, accessToken="NEW", expiresAt=time.time() + 3600)
        return True
    monkeypatch.setattr(k, "refresh_krea_oauth_token", fake_refresh)
    assert k.get_krea_oauth_token()["token"] == "NEW"


def test_token_corrupt_file(tmp_path, monkeypatch):
    f = tmp_path / "a.json"
    f.write_text("{oops")
    monkeypatch.setattr(k, "MCP_AUTH_FILE", f)
    t = k.get_krea_oauth_token()
    assert t["connected"] is False and "error" in t


def test_refresh_needs_refresh_token_and_client_id(tmp_path, monkeypatch):
    f = tmp_path / "a.json"
    f.write_text(json.dumps({"krea": {"tokens": {"accessToken": "x"}}}))
    monkeypatch.setattr(k, "MCP_AUTH_FILE", f)
    assert k.refresh_krea_oauth_token() is False
    monkeypatch.setattr(k, "MCP_AUTH_FILE", tmp_path / "none.json")
    assert k.refresh_krea_oauth_token() is False


def test_refresh_success_rewrites_tokens(tmp_path, monkeypatch):
    f = tmp_path / "a.json"
    write_auth(f, accessToken="OLD", refreshToken="R", expiresAt=1)
    monkeypatch.setattr(k, "MCP_AUTH_FILE", f)

    class P:
        stdout = json.dumps({"access_token": "NEW", "refresh_token": "R2", "expires_in": 100})
    monkeypatch.setattr(k.subprocess, "run", lambda *a, **kw: P())
    assert k.refresh_krea_oauth_token() is True
    t = json.loads(f.read_text())["krea"]["tokens"]
    assert t["accessToken"] == "NEW" and t["refreshToken"] == "R2" and t["expiresAt"] > time.time()


def test_refresh_failure_response(tmp_path, monkeypatch):
    f = tmp_path / "a.json"
    write_auth(f, accessToken="OLD", refreshToken="R", expiresAt=1)
    monkeypatch.setattr(k, "MCP_AUTH_FILE", f)

    class P:
        stdout = json.dumps({"error": "invalid_grant"})
    monkeypatch.setattr(k.subprocess, "run", lambda *a, **kw: P())
    assert k.refresh_krea_oauth_token() is False


# ---------- rpc ----------

class FakeResp:
    def __init__(self, body, sid="S1"):
        self._b, self.headers = body.encode(), {"Mcp-Session-Id": sid}

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def connected(monkeypatch):
    monkeypatch.setattr(k, "get_krea_oauth_token", lambda: {"connected": True, "token": "T"})


def test_mcp_rpc_plain_json_and_session(connected, monkeypatch):
    seen = {}

    def urlopen(req, timeout=0):
        seen["h"] = dict(req.header_items())
        seen["body"] = json.loads(req.data)
        return FakeResp(json.dumps({"result": {"ok": 1}}))
    monkeypatch.setattr(k.urllib.request, "urlopen", urlopen)
    res, sid = k.mcp_rpc("tools/list", {"a": 1}, session_id="S0")
    assert res == {"result": {"ok": 1}} and sid == "S1"
    assert seen["body"]["method"] == "tools/list" and seen["body"]["params"] == {"a": 1}
    assert seen["h"]["Authorization"] == "Bearer T" and seen["h"]["Mcp-session-id"] == "S0"


def test_mcp_rpc_parses_sse_last_json(connected, monkeypatch):
    sse = 'event: message\ndata: {"n": 1}\n\nevent: message\ndata: {"n": 2}\n'
    monkeypatch.setattr(k.urllib.request, "urlopen", lambda req, timeout=0: FakeResp(sse))
    assert k.mcp_rpc("x")[0] == {"n": 2}


def test_mcp_rpc_not_connected(monkeypatch):
    monkeypatch.setattr(k, "get_krea_oauth_token", lambda: {"connected": False})
    with pytest.raises(RuntimeError, match="not connected"):
        k.mcp_rpc("x")


def test_mcp_rpc_retries_once_after_401(connected, monkeypatch):
    calls = []

    def urlopen(req, timeout=0):
        calls.append(1)
        if len(calls) == 1:
            raise urllib.error.HTTPError("u", 401, "no", {}, None)
        return FakeResp(json.dumps({"ok": True}))
    monkeypatch.setattr(k.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(k, "refresh_krea_oauth_token", lambda: True)
    assert k.mcp_rpc("x")[0] == {"ok": True} and len(calls) == 2


def test_mcp_rpc_other_http_errors_propagate(connected, monkeypatch):
    def urlopen(req, timeout=0):
        raise urllib.error.HTTPError("u", 500, "boom", {}, None)
    monkeypatch.setattr(k.urllib.request, "urlopen", urlopen)
    with pytest.raises(urllib.error.HTTPError):
        k.mcp_rpc("x")


def test_init_session_returns_sid(monkeypatch):
    monkeypatch.setattr(k, "mcp_rpc", lambda *a, **kw: ({}, "SID"))
    assert k.init_mcp_session() == "SID"


def test_call_tool_inits_session_when_missing(monkeypatch):
    calls = []
    monkeypatch.setattr(k, "init_mcp_session", lambda: "NEW")
    monkeypatch.setattr(k, "mcp_rpc", lambda m, p=None, session_id=None, timeout=0: calls.append((m, p, session_id)) or ({"r": 1}, "x"))
    assert k.call_krea_mcp_tool("t", {"a": 1}) == {"r": 1}
    assert calls[0] == ("tools/call", {"name": "t", "arguments": {"a": 1}}, "NEW")


# ---------- uploads & guides ----------

def test_upload_returns_url_from_json_or_plain(tmp_path, monkeypatch):
    f = tmp_path / "x.png"
    f.write_bytes(b"x")
    monkeypatch.setattr(k, "call_krea_mcp_tool", lambda *a, **kw: {"result": {"content": [{"text": "https://up/1"}]}})

    class P:
        stdout = json.dumps({"image_url": "https://img/1"})
    monkeypatch.setattr(k.subprocess, "run", lambda *a, **kw: P())
    assert k.upload_file_to_krea_mcp(f, sid="S") == "https://img/1"
    P.stdout = "https://img/2"
    assert k.upload_file_to_krea_mcp(f, sid="S") == "https://img/2"


def test_upload_failures(tmp_path, monkeypatch):
    f = tmp_path / "x.png"
    f.write_bytes(b"x")
    monkeypatch.setattr(k, "call_krea_mcp_tool", lambda *a, **kw: {"result": {"content": [{"text": "nope"}]}})
    with pytest.raises(RuntimeError, match="upload URL"):
        k.upload_file_to_krea_mcp(f, sid="S")
    monkeypatch.setattr(k, "call_krea_mcp_tool", lambda *a, **kw: {"result": {"content": [{"text": "https://up/1"}]}})

    class P:
        stdout = "garbage"
    monkeypatch.setattr(k.subprocess, "run", lambda *a, **kw: P())
    with pytest.raises(RuntimeError, match="Unexpected upload"):
        k.upload_file_to_krea_mcp(f, sid="S")


def test_dark_guide_is_preuploaded_and_light_is_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(k, "GUIDE_CACHE_FILE", tmp_path / "g.json")
    assert k.get_or_upload_guide_url("dark") == k.PREUPLOADED_DARK
    ups = []
    monkeypatch.setattr(k, "upload_file_to_krea_mcp", lambda path, sid=None: ups.append(path) or "https://light/1")
    assert k.get_or_upload_guide_url("light") == "https://light/1"
    assert k.get_or_upload_guide_url("light") == "https://light/1"
    assert len(ups) == 1 and "guide_light" in str(ups[0])


# ---------- generate ----------

def png_bytes():
    import io
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (4, 4)).save(b, "PNG")
    return b.getvalue()


class ImgResp(FakeResp):
    def __init__(self):
        self._b = png_bytes()
        self.headers = {}


def test_generate_plate_happy_path_and_payload(monkeypatch):
    sent = {}
    monkeypatch.setattr(k, "init_mcp_session", lambda: "S")
    monkeypatch.setattr(k, "get_or_upload_guide_url", lambda guide_type="dark", sid=None: GUIDE)
    monkeypatch.setattr(k, "call_krea_mcp_tool", lambda name, args, sid=None, timeout=0: sent.update(name=name, args=args) or {"result": {"structuredContent": {"urls": ["https://i/1.png"]}}})
    monkeypatch.setattr(k.urllib.request, "urlopen", lambda req, timeout=0: ImgResp())
    out = k.generate_plate_via_krea_mcp("hello", "dark", "google/nano-banana-2.1")
    assert out == png_bytes()
    assert sent["name"] == "generate_image" and sent["args"]["model"] == "google/nano-banana-2.1"
    assert sent["args"]["input"]["prompt"] == "hello" and sent["args"]["sync"] is True


def test_generate_plate_polls_job_until_urls(monkeypatch):
    monkeypatch.setattr(k, "init_mcp_session", lambda: "S")
    monkeypatch.setattr(k, "get_or_upload_guide_url", lambda *a, **kw: GUIDE)
    monkeypatch.setattr(k.time, "sleep", lambda s: None)
    polls = []

    def tool(name, args, sid=None, timeout=0):
        if name == "generate_image":
            return {"result": {"structuredContent": {"job_id": "J"}}}
        polls.append(1)
        return {"result": {"structuredContent": {"urls": ["https://i/1.png"]}}} if len(polls) == 3 else {"result": {"structuredContent": {}}}
    monkeypatch.setattr(k, "call_krea_mcp_tool", tool)
    monkeypatch.setattr(k.urllib.request, "urlopen", lambda req, timeout=0: ImgResp())
    assert k.generate_plate_via_krea_mcp("p") == png_bytes() and len(polls) == 3


def test_generate_plate_raises_when_no_urls(monkeypatch):
    monkeypatch.setattr(k, "init_mcp_session", lambda: "S")
    monkeypatch.setattr(k, "get_or_upload_guide_url", lambda *a, **kw: GUIDE)
    monkeypatch.setattr(k, "call_krea_mcp_tool", lambda *a, **kw: {"result": {"structuredContent": {}}})
    with pytest.raises(RuntimeError, match="No image URL"):
        k.generate_plate_via_krea_mcp("p")


# ---------- failed jobs are reported at once, not polled ----------

def reply(structured):
    return {"result": {"structuredContent": structured}}


MODERATED = {"mode": "sync", "completed": False, "timedOut": False, "job_id": "J1",
             "job": {"status": "failed", "job_id": "J1", "error": {"code": "content_policy", "message": "An external provider's moderation systems rejected the generation."}}}


def test_job_state_reads_status_code_and_message():
    st = k.job_state(reply(MODERATED))
    assert (st["status"], st["code"], st["job_id"]) == ("failed", "content_policy", "J1") and "moderation" in st["message"]
    assert k.job_state(reply({"job_id": "J2", "job": {"status": "running"}}))["status"] == "running"
    assert k.job_state({})["status"] is None
    text_only = {"result": {"content": [{"type": "text", "text": json.dumps(MODERATED)}]}}
    assert k.job_state(text_only)["code"] == "content_policy"


def test_a_moderation_rejection_raises_at_once_and_is_not_retryable(monkeypatch):
    monkeypatch.setattr(k, "init_mcp_session", lambda: "S")
    monkeypatch.setattr(k, "get_or_upload_guide_url", lambda *a, **kw: GUIDE)
    monkeypatch.setattr(k.time, "sleep", lambda s: pytest.fail("must not poll a job that already failed"))
    monkeypatch.setattr(k, "call_krea_mcp_tool", lambda name, args, sid=None, timeout=0: reply(MODERATED))
    with pytest.raises(k.KreaError) as e:
        k.generate_plate_via_krea_mcp("p")
    assert e.value.code == "content_policy" and e.value.retryable is False and e.value.job_id == "J1" and "moderation" in str(e.value)


def test_a_job_that_fails_while_polling_stops_the_polling(monkeypatch):
    monkeypatch.setattr(k, "init_mcp_session", lambda: "S")
    monkeypatch.setattr(k, "get_or_upload_guide_url", lambda *a, **kw: GUIDE)
    monkeypatch.setattr(k.time, "sleep", lambda s: None)
    polls = []

    def tool(name, args, sid=None, timeout=0):
        if name == "generate_image":
            return reply({"job_id": "J9", "job": {"status": "running"}})
        polls.append(1)
        return reply({"job_id": "J9", "job": {"status": "running" if len(polls) < 3 else "failed", "error": {"code": "internal", "message": "boom"}}})
    monkeypatch.setattr(k, "call_krea_mcp_tool", tool)
    with pytest.raises(k.KreaError) as e:
        k.generate_plate_via_krea_mcp("p")
    assert len(polls) == 3 and e.value.code == "internal" and e.value.retryable is True


def test_a_job_still_running_after_90_seconds_is_not_submitted_again(monkeypatch):
    monkeypatch.setattr(k, "init_mcp_session", lambda: "S")
    monkeypatch.setattr(k, "get_or_upload_guide_url", lambda *a, **kw: GUIDE)
    monkeypatch.setattr(k.time, "sleep", lambda s: None)
    n = []
    monkeypatch.setattr(k, "call_krea_mcp_tool", lambda name, args, sid=None, timeout=0: n.append(name) or reply({"job_id": "J7", "job": {"status": "running"}}))
    with pytest.raises(k.KreaError) as e:
        k.generate_plate_via_krea_mcp("p")
    assert e.value.code == "timeout" and e.value.retryable is False and "J7" in str(e.value) and n.count("get_job") == 45


@pytest.mark.parametrize("code,retryable", [("content_policy", False), ("invalid_input", False), ("insufficient_credits", False), ("internal", True), ("rate_limited", True)])
def test_which_codes_are_worth_retrying(code, retryable):
    res = reply({"job_id": "J", "job": {"status": "failed", "error": {"code": code, "message": "m"}}})
    with pytest.raises(k.KreaError) as e:
        k.raise_if_failed(res, "m")
    assert e.value.retryable is retryable
