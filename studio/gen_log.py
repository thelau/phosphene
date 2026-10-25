"""
A written record of what the server did: one JSON line per event in studio/generation_log.jsonl.

  server_start   the server (re)started                       -> shows restarts that cut a job short
  batch          Kimi wrote the scenes for a batch             -> asked / returned / dropped duplicates, titles
  image_start    one image was sent to Krea                    -> a start with no matching "image" = interrupted
  image          the result: ok / failed, seconds, every retry, logo QA, file name
  ai_order       an AI order finished or failed
  export         a video export finished or failed
  purge          images deleted from the trash

Read it with:  python3 studio/gen_log.py            (summary + the last 30 events)
               python3 studio/gen_log.py --failures (only what went wrong)
               python3 studio/gen_log.py -n 100
"""

import argparse
import json
import threading
import time
from pathlib import Path

LOG_FILE = Path(__file__).resolve().parent / "generation_log.jsonl"
MAX_BYTES = 5_000_000          # past this the file is rotated to .1 (one older file is kept)
_LOCK = threading.Lock()


def record(event: str, **fields) -> None:
    """Append one event. Never raises: logging must not be able to break a generation."""
    line = {"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "t": round(time.time(), 3), "event": event, **fields}
    try:
        with _LOCK:
            if LOG_FILE.exists() and LOG_FILE.stat().st_size > MAX_BYTES:
                LOG_FILE.replace(LOG_FILE.with_suffix(".jsonl.1"))
            with LOG_FILE.open("a") as f:
                f.write(json.dumps(line, ensure_ascii=False) + "\n")
    except Exception:
        pass


def read(n: int | None = 100) -> list:
    """The last n events, oldest first (all of them when n is None)."""
    try:
        lines = LOG_FILE.read_text().splitlines()
    except FileNotFoundError:
        return []
    out = []
    for raw in lines[-n:] if n else lines:
        try:
            out.append(json.loads(raw))
        except ValueError:
            continue
    return out


def interrupted(events: list) -> list:
    """image_start events whose result never arrived although the server restarted afterwards."""
    done = {e.get("id") for e in events if e["event"] == "image"}
    out = []
    for i, e in enumerate(events):
        if e["event"] == "image_start" and e.get("id") not in done and any(x["event"] == "server_start" for x in events[i + 1:]):
            out.append(e)
    return out


def summarize(events: list) -> dict:
    images = [e for e in events if e["event"] == "image"]
    ok = [e for e in images if e.get("ok")]
    secs = [e["seconds"] for e in ok if isinstance(e.get("seconds"), (int, float))]
    return {
        "images": len(images), "ok": len(ok), "failed": len(images) - len(ok),
        "logo_check_failed": sum(1 for e in ok if e.get("qa_passed") is False),
        "retried": sum(1 for e in images if len(e.get("attempts") or []) > 1),
        "interrupted": len(interrupted(events)),
        "moderated": sum(1 for e in images if e.get("error_code") == "content_policy"),
        "softened_ok": sum(1 for e in ok if e.get("softened")),
        "avg_seconds": round(sum(secs) / len(secs), 1) if secs else None,
        "restarts": sum(1 for e in events if e["event"] == "server_start"),
    }


def describe(e: dict) -> str:
    ev = e["event"]
    head = f"{e['ts']}  {ev:<11}"
    if ev == "server_start":
        return f"{head} server started (port {e.get('port')})"
    if ev == "batch":
        if not e.get("ok", True):
            return f"{head} FAILED  {e.get('error', '')[:120]}"
        return (f"{head} {e.get('world')}: asked {e.get('asked')}, Kimi wrote {e.get('from_kimi')}, "
                f"{e.get('dropped_duplicates', 0)} near-duplicates dropped, {e.get('returned')} sent to Krea ({e.get('seconds')}s)"
                + (f"  direction: {e['direction']!r}" if e.get("direction") else ""))
    if ev == "image_start":
        return f"{head} {e.get('title')} -> {e.get('model')} ({e.get('guide')})"
    if ev == "image":
        tries = e.get("attempts") or []
        retry = f", {len(tries)} attempts" if len(tries) > 1 else ""
        if e.get("ok"):
            qa = "logo check passed" if e.get("qa_passed") else f"LOGO CHECK FAILED -> trash ({'; '.join(e.get('qa_issues') or [])[:80]})"
            soft = "  [prompt softened after a moderation rejection]" if e.get("softened") else ""
            return f"{head} OK     {e.get('filename')} {e.get('seconds')}s{retry}  {qa} ({e.get('qa_score')}%)  [{e.get('world') or '-'}]{soft}"
        why = "REJECTED BY KREA MODERATION" if e.get("error_code") == "content_policy" else str(e.get("error"))[:150]
        return f"{head} FAILED {e.get('title')} after {e.get('seconds')}s{retry}: {why}"
    if ev == "ai_order":
        if e.get("ok"):
            return f"{head} {e.get('images')} images in {e.get('seconds')}s{'' if e.get('kimi_ok', True) else '  (Kimi unavailable: measurements only)'}  {str(e.get('summary'))[:100]}"
        return f"{head} FAILED  {e.get('error')}"
    if ev == "export":
        return f"{head} " + (f"{e.get('filename')} ({e.get('images')} images, {e.get('seconds')}s)" if e.get("ok") else f"FAILED  {e.get('error')}")
    if ev == "purge":
        return f"{head} deleted {e.get('deleted')} images ({e.get('freed_mb')} MB)"
    return f"{head} {json.dumps({k: v for k, v in e.items() if k not in ('ts', 't', 'event')})[:160]}"


def main() -> None:
    ap = argparse.ArgumentParser(description="Show what the server did")
    ap.add_argument("-n", type=int, default=30, help="how many recent events")
    ap.add_argument("--failures", action="store_true", help="only failures, logo-check failures and interrupted images")
    a = ap.parse_args()
    events = read(None)
    if not events:
        print(f"No log yet ({LOG_FILE}). It is written while the server runs.")
        return
    s = summarize(events)
    print(f"{len(events)} events since {events[0]['ts']}:  {s['images']} images ({s['ok']} ok, {s['failed']} failed, {s['logo_check_failed']} failed the logo check, "
          f"{s['retried']} needed retries, {s['moderated']} rejected by Krea moderation, {s['interrupted']} interrupted by a restart), average {s['avg_seconds']}s, {s['restarts']} server starts\n")
    lost = {e.get("id") for e in interrupted(events)}
    shown = events
    if a.failures:
        shown = [e for e in events if (e["event"] == "image" and (not e.get("ok") or e.get("qa_passed") is False))
                 or (e["event"] == "image_start" and e.get("id") in lost) or (e["event"] in ("batch", "ai_order", "export") and e.get("ok") is False)]
    for e in shown[-a.n:]:
        print(describe(e) + ("   <-- INTERRUPTED (server restarted before the result)" if e["event"] == "image_start" and e.get("id") in lost else ""))


if __name__ == "__main__":
    main()
