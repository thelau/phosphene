#!/usr/bin/env python3
"""
Direct Streamable-HTTP MCP Client for https://api.krea.ai/mcp
- Signs in to Krea itself, as an MCP client does (OAuth 2.1: dynamic client registration, PKCE, a redirect back to this app's
  /api/krea-callback). The client and its tokens are kept in studio/.krea_auth.json (gitignored: each machine signs in once).
- Refreshes the access token with the refresh token when it is about to expire, or after a 401.
- Formats model-specific input payloads (`openai/gpt-image-2.5-flare`, `openai/gpt-image-2.5-sunburst`,
  `openai/gpt-image-2`, `google/nano-banana-pro`, `google/nano-banana-2.1`, `krea/krea-3`, `bytedance/seedream-5-pro`).
"""

import base64
import hashlib
import json
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

AUTH_FILE = Path(__file__).resolve().parent / ".krea_auth.json"
KREA_MCP_URL = "https://api.krea.ai/mcp"
KREA_AUTHORIZE_URL = "https://www.krea.ai/auth/v1/oauth/authorize"     # from https://www.krea.ai/.well-known/oauth-authorization-server
KREA_TOKEN_URL = "https://www.krea.ai/auth/v1/oauth/token"
KREA_REGISTER_URL = "https://www.krea.ai/auth/v1/oauth/clients/register"
ROOT_DIR = Path(__file__).resolve().parent.parent
GUIDE_CACHE_FILE = Path(__file__).resolve().parent / "krea_guide_urls.json"

PREUPLOADED_DARK = "https://app-uploads.krea.ai/abe41024-3231-495a-9044-e48d99c94a02/1792760523391-a0895499-4248-4797-b22c-a19852d69a2a-guide_dark_1080x1920.png"


def _read_auth() -> dict:
    try:
        return json.loads(AUTH_FILE.read_text())
    except FileNotFoundError:
        return {}


def _write_auth(data: dict) -> None:
    tmp = AUTH_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.chmod(0o600)                                  # tokens: readable by this user only
    tmp.replace(AUTH_FILE)


def _post(url: str, fields: dict, as_json: bool = False) -> dict:
    data = json.dumps(fields).encode() if as_json else urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json" if as_json else "application/x-www-form-urlencoded", "Accept": "application/json", "User-Agent": "Phosphene"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode() or "{}") | {"_status": e.code}
        except Exception:
            return {"error": f"http_{e.code}", "_status": e.code}


def start_login(redirect_uri: str) -> str:
    """The Krea sign-in page to open: registers this app as a client the first time (or when its address changed), and keeps
    what is needed to finish the sign-in (the PKCE verifier, under a random state) until Krea sends the browser back."""
    auth = _read_auth()
    if not auth.get("client_id") or auth.get("redirect_uri") != redirect_uri:
        reg = _post(KREA_REGISTER_URL, {"client_name": "Phosphene", "redirect_uris": [redirect_uri], "grant_types": ["authorization_code", "refresh_token"],
                                        "response_types": ["code"], "token_endpoint_auth_method": "none", "scope": "profile email"}, as_json=True)
        if not reg.get("client_id"):
            raise RuntimeError(f"Krea did not register the app: {reg.get('error_description') or reg.get('error') or reg}")
        auth = {"client_id": reg["client_id"], "redirect_uri": redirect_uri}
    verifier = secrets.token_urlsafe(64)
    state = secrets.token_urlsafe(24)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    auth["pending"] = {"state": state, "verifier": verifier, "at": time.time()}
    _write_auth(auth)
    return KREA_AUTHORIZE_URL + "?" + urllib.parse.urlencode({
        "response_type": "code", "client_id": auth["client_id"], "redirect_uri": redirect_uri, "scope": "profile email",
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256", "resource": KREA_MCP_URL})


def _keep_tokens(auth: dict, resp: dict) -> dict:
    auth["access_token"] = resp["access_token"]
    if resp.get("refresh_token"):
        auth["refresh_token"] = resp["refresh_token"]
    auth["expires_at"] = time.time() + float(resp.get("expires_in", 3600))
    return auth


def finish_login(code: str, state: str) -> None:
    """Krea sent the browser back: trade the code for tokens. Raises if the sign-in is not the one this app started."""
    auth = _read_auth()
    pending = auth.get("pending") or {}
    if not code or not state or state != pending.get("state") or time.time() - pending.get("at", 0) > 900:
        raise RuntimeError("This sign-in was not started here, or took longer than 15 minutes. Connect again from Settings.")
    resp = _post(KREA_TOKEN_URL, {"grant_type": "authorization_code", "code": code, "redirect_uri": auth["redirect_uri"],
                                  "client_id": auth["client_id"], "code_verifier": pending["verifier"], "resource": KREA_MCP_URL})
    if "access_token" not in resp:
        raise RuntimeError(f"Krea refused the sign-in: {resp.get('error_description') or resp.get('error') or resp}")
    auth.pop("pending", None)
    _write_auth(_keep_tokens(auth, resp))
    print("[KREA MCP] Signed in.", flush=True)


def forget_login() -> None:
    """Sign out on this machine (the registered client stays, so the next sign-in is quicker)."""
    auth = _read_auth()
    for k in ("access_token", "refresh_token", "expires_at", "pending"):
        auth.pop(k, None)
    if auth:
        _write_auth(auth)


def refresh_krea_oauth_token() -> bool:
    """A new access token from the refresh token. False if there is none or Krea refuses it (then: sign in again)."""
    try:
        auth = _read_auth()
        if not auth.get("refresh_token") or not auth.get("client_id"):
            return False
        resp = _post(KREA_TOKEN_URL, {"grant_type": "refresh_token", "refresh_token": auth["refresh_token"], "client_id": auth["client_id"], "resource": KREA_MCP_URL})
        if "access_token" not in resp:
            return False
        _write_auth(_keep_tokens(auth, resp))
        print("[KREA MCP] OAuth access token refreshed automatically.", flush=True)
        return True
    except Exception as e:
        print(f"[KREA MCP] Token refresh failed: {e}", flush=True)
        return False


def get_krea_oauth_token() -> dict:
    try:
        auth = _read_auth()
        token, expires_at = auth.get("access_token"), float(auth.get("expires_at", 0) or 0)
        if token and expires_at and time.time() > (expires_at - 120) and refresh_krea_oauth_token():
            auth = _read_auth()
            token, expires_at = auth.get("access_token"), float(auth.get("expires_at", 0) or 0)
        if not token:
            return {"connected": False, "token": None}
        return {"connected": True, "token": token, "expires_at": expires_at, "expired": time.time() > expires_at if expires_at else False}
    except Exception as e:
        return {"connected": False, "token": None, "error": str(e)}


def mcp_rpc(method: str, params: dict = None, session_id: str = None, timeout: int = 180) -> tuple[dict, str]:
    auth = get_krea_oauth_token()
    if not auth.get("connected"):
        raise RuntimeError("Krea MCP is not connected.")

    payload = {
        "jsonrpc": "2.0",
        "id": int(time.time() * 1000) % 1000000,
        "method": method,
    }
    if params is not None:
        payload["params"] = params

    headers = {
        "Authorization": f"Bearer {auth['token']}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id

    req = urllib.request.Request(
        KREA_MCP_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            new_sid = resp.headers.get("Mcp-Session-Id") or session_id
            raw = resp.read().decode("utf-8", errors="replace").strip()
    except urllib.error.HTTPError as e:
        if e.code == 401 and refresh_krea_oauth_token():
            auth = get_krea_oauth_token()
            headers["Authorization"] = f"Bearer {auth['token']}"
            req = urllib.request.Request(
                KREA_MCP_URL,
                data=json.dumps(payload).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                new_sid = resp.headers.get("Mcp-Session-Id") or session_id
                raw = resp.read().decode("utf-8", errors="replace").strip()
        else:
            raise

    if raw.startswith("{"):
        return json.loads(raw), new_sid
    last_json = {}
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            chunk = line[5:].strip()
            if chunk.startswith("{"):
                last_json = json.loads(chunk)
    return last_json, new_sid


def init_mcp_session() -> str:
    res, sid = mcp_rpc(
        "initialize",
        {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "Demo-studio", "version": "1.0.0"},
        },
    )
    return sid


def call_krea_mcp_tool(name: str, arguments: dict, sid: str = None, timeout: int = 180) -> dict:
    if not sid:
        sid = init_mcp_session()
    res, _ = mcp_rpc("tools/call", {"name": name, "arguments": arguments}, session_id=sid, timeout=timeout)
    return res


def upload_file_to_krea_mcp(file_path: Path, sid: str = None) -> str:
    if not sid:
        sid = init_mcp_session()
    up_res = call_krea_mcp_tool("get_upload_url", {}, sid=sid)
    presigned_url = up_res.get("result", {}).get("content", [{}])[0].get("text", "").strip()
    if not presigned_url.startswith("http"):
        raise RuntimeError(f"Failed to get upload URL from Krea MCP: {up_res}")

    proc = subprocess.run(
        ["/usr/bin/curl", "-s", "-F", f"file=@{file_path}", presigned_url],
        capture_output=True,
        text=True,
        timeout=60,
    )
    out = proc.stdout.strip()
    if out.startswith("http"):
        return out
    try:
        data = json.loads(out)
        return data.get("image_url") or data.get("url") or data.get("asset_url")
    except Exception:
        raise RuntimeError(f"Unexpected upload response: {out}")


def get_or_upload_guide_url(guide_type: str = "dark", sid: str = None, guide: dict | None = None) -> str:
    """The guide image's Krea URL. `guide` (another project): {"files": {"dark": path, "light": path}, "cache": path}, uploaded once
    and remembered in its cache (a guide made again after the mark changed is forgotten there). None: Demo's own."""
    if guide:
        cache_file, f = Path(guide["cache"]), Path(guide["files"]["light" if guide_type == "light" else "dark"])
        try:
            cache = json.loads(cache_file.read_text()) if cache_file.exists() else {}
        except Exception:
            cache = {}
        key = f"{guide_type}:{f.stat().st_mtime}"
        if not (cache.get(key) or {}).get("url"):
            cache = {key: {"url": upload_file_to_krea_mcp(f, sid=sid), "ts": time.time()}} | {k: v for k, v in cache.items() if not k.startswith(guide_type + ":")}
            cache_file.write_text(json.dumps(cache, indent=2))
        return cache[key]["url"]
    if guide_type == "dark":
        return PREUPLOADED_DARK
    cache = {}
    if GUIDE_CACHE_FILE.exists():
        try:
            cache = json.loads(GUIDE_CACHE_FILE.read_text())
        except Exception:
            cache = {}

    entry = cache.get(guide_type)
    if entry and entry.get("url"):
        return entry["url"]

    guide_file = (
        ROOT_DIR / "assets" / "logo-guides" / "guide_light_1080x1920.png"
        if guide_type == "light"
        else ROOT_DIR / "assets" / "logo-guides" / "guide_dark_1080x1920.png"
    )
    url = upload_file_to_krea_mcp(guide_file, sid=sid)
    cache[guide_type] = {"url": url, "ts": time.time()}
    GUIDE_CACHE_FILE.write_text(json.dumps(cache, indent=2))
    return url


class KreaError(RuntimeError):
    """A Krea job that failed. `retryable` is False for rejections that will never succeed with the same prompt."""

    def __init__(self, message: str, code: str | None = None, retryable: bool = True, job_id: str | None = None):
        super().__init__(message)
        self.code, self.retryable, self.job_id = code, retryable, job_id


# Krea / provider rejections that a retry of the same request cannot fix
NON_RETRYABLE_CODES = {"content_policy", "invalid_input", "invalid_request", "insufficient_credits", "unauthorized", "forbidden"}
FAILED_STATES = {"failed", "error", "errored", "canceled", "cancelled"}


def job_state(res: dict) -> dict:
    """{'status', 'code', 'message', 'job_id'} from a generate_image or get_job reply (any field may be None)."""
    result_obj = res.get("result", {})
    structured = result_obj.get("structuredContent") or {}
    if not structured:
        for c in result_obj.get("content", []):
            if c.get("type") == "text":
                try:
                    structured = json.loads(c.get("text", ""))
                except Exception:
                    structured = {}
                break
    job = structured.get("job") if isinstance(structured.get("job"), dict) else structured
    err = job.get("error") if isinstance(job.get("error"), dict) else {}
    status = job.get("status")
    code = err.get("code")
    message = err.get("message") or (job.get("message") if isinstance(job.get("message"), str) else None) or (job.get("error") if isinstance(job.get("error"), str) else None)
    if isinstance(status, (int, float)) and not isinstance(status, bool):
        # a number is an HTTP-like status (an error reply), not a job state: 4xx/5xx is a failure with its own code
        if status >= 400:
            code = code or {401: "unauthorized", 402: "insufficient_credits", 403: "forbidden"}.get(int(status), f"http_{int(status)}")
            status = "failed"
            message = message or f"Krea answered {int(job.get('status'))}: {str(structured)[:200]}"
        else:
            status = None
    status = status.lower() if isinstance(status, str) else None
    return {"status": status or None, "code": code, "message": message,
            "job_id": structured.get("job_id") or job.get("job_id")}


def raise_if_failed(res: dict, model: str) -> None:
    st = job_state(res)
    if st["status"] in FAILED_STATES:
        code = st["code"] or st["status"]
        raise KreaError(f"Krea job failed ({code}): {st['message'] or 'no message'}", code=code, retryable=code not in NON_RETRYABLE_CODES, job_id=st["job_id"])


def extract_urls_from_mcp_result(res: dict) -> tuple[list[str], str]:
    result_obj = res.get("result", {})
    structured = result_obj.get("structuredContent") or {}
    text_blocks = [c.get("text", "") for c in result_obj.get("content", []) if c.get("type") == "text"]
    if not structured and text_blocks:
        try:
            structured = json.loads(text_blocks[0])
        except Exception:
            pass
    job_id = structured.get("job_id") or structured.get("id") or ""
    urls = (structured.get("result") or {}).get("urls") or structured.get("urls") or []
    if not urls and isinstance(structured.get("output"), list):
        urls = structured["output"]
    return urls, job_id


def build_model_input(model: str, prompt: str, guide_url: str) -> dict:
    """Builds the exact schema-validated input payload for each Krea MCP image model."""
    if model in ("openai/gpt-image-2.5-flare", "openai/gpt-image-2.5-sunburst"):
        return {
            "prompt": prompt,
            "image_urls": [guide_url],
            "aspect_ratio": "9:16",
            "resolution": "2K",
            "quality": "high",
        }
    if model == "openai/gpt-image-2":
        return {
            "prompt": prompt,
            "image_urls": [guide_url],
            "aspect_ratio": "9:16",
            "quality": "high",
        }
    if model == "bytedance/seedream-5-pro":
        return {
            "prompt": prompt,
            "width": 1080,
            "height": 1920,
            "style_images": [{"url": guide_url, "strength": 1.0}],
        }
    if model == "ideogram/ideogram-4.5":
        return {
            "prompt": prompt,
            "image_urls": [guide_url],
            "aspect_ratio": "9:16",
            "resolution": "2K",
            "quality": "high",
        }
    if model in ("luma/uni-1",):
        return {
            "prompt": prompt[:6000],
            "width": 1080,
            "height": 1920,
            "mode": "max",
            "style_images": [{"url": guide_url, "strength": 1.0}],
        }
    if model == "meta/muse-image":
        return {
            "prompt": prompt,
            "aspect_ratio": "9:16",
            "style_images": [{"url": guide_url, "strength": 1.0}],
        }
    if model == "runway/gen-4-image":
        return {
            "prompt": prompt[:1000],
            "width": 1080,
            "height": 1920,
            "reference_images": [{"url": guide_url, "tag": "logoguide"}],
        }
    if model == "krea/krea-3":
        return {
            "prompt": prompt,
            "image_urls": [guide_url],
            "aspect_ratio": "9:16",
            "resolution": "2K",
            "thinking_mode": "fast",
        }
    # Default: google/nano-banana-pro, google/nano-banana-2.1, google/nano-banana-2
    return {
        "prompt": prompt,
        "image_urls": [guide_url],
        "aspect_ratio": "9:16",
        "resolution": "2K",
    }


def generate_plate_via_krea_mcp(
    prompt: str,
    guide_type: str = "dark",
    model: str = "google/nano-banana-pro",
    guide: dict | None = None,
) -> bytes:
    """
    Generates a 9:16 image via Krea MCP using the project's guide image (the mark at its size and place; Demo's by default)
    and returns the raw image bytes.
    """
    sid = init_mcp_session()
    guide_url = get_or_upload_guide_url(guide_type=guide_type, sid=sid, guide=guide)
    input_payload = build_model_input(model=model, prompt=prompt, guide_url=guide_url)

    print(f"[KREA MCP] Calling generate_image model={model} guide={guide_type}", flush=True)
    res = call_krea_mcp_tool(
        "generate_image",
        {
            "model": model,
            "input": input_payload,
            "sync": True,
            "timeoutSeconds": 180,
        },
        sid=sid,
        timeout=200,
    )

    urls, job_id = extract_urls_from_mcp_result(res)
    if not urls:
        raise_if_failed(res, model)                       # a job that already failed (e.g. moderation) is reported now, not polled
    if not urls and job_id:
        for _ in range(45):
            time.sleep(2)
            j_res = call_krea_mcp_tool("get_job", {"jobId": job_id}, sid=sid)
            urls, _ = extract_urls_from_mcp_result(j_res)
            if urls:
                break
            raise_if_failed(j_res, model)                 # stop polling the moment Krea says the job failed
        else:
            # still running after ~90s: do not submit it again (that would pay twice); the job id is in the message and the log
            raise KreaError(f"Krea job {job_id} still not finished after 90s ({model})", code="timeout", retryable=False, job_id=job_id)

    if not urls:
        raise KreaError(f"No image URL returned from Krea MCP ({model}): {str(res)[:300]}", code="no_url", retryable=True, job_id=job_id or None)

    img_req = urllib.request.Request(urls[0], headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(img_req, timeout=60) as img_resp:
        return img_resp.read()
