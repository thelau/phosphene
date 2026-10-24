#!/usr/bin/env python3
"""
Direct Streamable-HTTP MCP Client for https://api.krea.ai/mcp
- Uses the Krea MCP OAuth token (stored in ~/.local/share/opencode/mcp-auth.json)
- Automatically refreshes the accessToken via https://www.krea.ai/auth/v1/oauth/token
- Formats model-specific input payloads (`openai/gpt-image-2.5-flare`, `openai/gpt-image-2.5-sunburst`,
  `openai/gpt-image-2`, `google/nano-banana-pro`, `google/nano-banana-2.1`, `krea/krea-3`, `bytedance/seedream-5-pro`).
"""

import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

MCP_AUTH_FILE = Path.home() / ".local" / "share" / "opencode" / "mcp-auth.json"
KREA_MCP_URL = "https://api.krea.ai/mcp"
KREA_TOKEN_URL = "https://www.krea.ai/auth/v1/oauth/token"
ROOT_DIR = Path(__file__).resolve().parent.parent
GUIDE_CACHE_FILE = Path(__file__).resolve().parent / "krea_guide_urls.json"

PREUPLOADED_DARK = "https://app-uploads.krea.ai/abe41024-3231-495a-9044-e48d99c94a02/1792760523391-a0895499-4248-4797-b22c-a19852d69a2a-guide_dark_1080x1920.png"


def refresh_krea_oauth_token() -> bool:
    """Automatically refreshes the Krea MCP OAuth token using the stored refreshToken."""
    if not MCP_AUTH_FILE.exists():
        return False
    try:
        full = json.loads(MCP_AUTH_FILE.read_text())
        krea = full.get("krea", {})
        tokens = krea.get("tokens", {})
        refresh_token = tokens.get("refreshToken")
        client_id = (krea.get("clientInfo") or {}).get("clientId")
        if not refresh_token or not client_id:
            return False

        proc = subprocess.run(
            [
                "/usr/bin/curl",
                "-s",
                "-X",
                "POST",
                KREA_TOKEN_URL,
                "-d",
                f"grant_type=refresh_token&refresh_token={refresh_token}&client_id={client_id}",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        resp = json.loads(proc.stdout.strip())
        if "access_token" not in resp:
            return False

        tokens["accessToken"] = resp["access_token"]
        if "refresh_token" in resp:
            tokens["refreshToken"] = resp["refresh_token"]
        tokens["expiresAt"] = time.time() + float(resp.get("expires_in", 3600))
        krea["tokens"] = tokens
        full["krea"] = krea
        MCP_AUTH_FILE.write_text(json.dumps(full, indent=2))
        print("[KREA MCP] OAuth access token refreshed automatically.", flush=True)
        return True
    except Exception as e:
        print(f"[KREA MCP] Token refresh failed: {e}", flush=True)
        return False


def get_krea_oauth_token() -> dict:
    if not MCP_AUTH_FILE.exists():
        return {"connected": False, "token": None}
    try:
        data = json.loads(MCP_AUTH_FILE.read_text())
        krea = data.get("krea", {})
        tokens = krea.get("tokens", {})
        token = tokens.get("accessToken")
        expires_at = float(tokens.get("expiresAt", 0) or 0)

        if token and expires_at and time.time() > (expires_at - 120):
            if refresh_krea_oauth_token():
                data = json.loads(MCP_AUTH_FILE.read_text())
                tokens = data.get("krea", {}).get("tokens", {})
                token = tokens.get("accessToken")
                expires_at = float(tokens.get("expiresAt", 0) or 0)

        return {
            "connected": bool(token),
            "token": token,
            "expires_at": expires_at,
            "expired": time.time() > expires_at if expires_at else False,
        }
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


def get_or_upload_guide_url(guide_type: str = "dark", sid: str = None) -> str:
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
) -> bytes:
    """
    Generates a 9:16 image via Krea MCP using the center-locked Demo guide image and returns the raw image bytes.
    """
    sid = init_mcp_session()
    guide_url = get_or_upload_guide_url(guide_type=guide_type, sid=sid)
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
    if not urls and job_id:
        for _ in range(45):
            time.sleep(2)
            j_res = call_krea_mcp_tool("get_job", {"jobId": job_id}, sid=sid)
            urls, _ = extract_urls_from_mcp_result(j_res)
            if urls:
                break

    if not urls:
        raise RuntimeError(f"No image URL returned from Krea MCP ({model}): {res}")

    img_req = urllib.request.Request(urls[0], headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(img_req, timeout=60) as img_resp:
        return img_resp.read()
