"""
Dev runner: restarts server.py when any studio/*.py changes, and when it dies (killed or crashed). The page reloads itself
(it polls /api/version, which changes on every restart and whenever the built page changes).

    python3 studio/dev.py
"""

import os
import signal
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CRASH_WINDOW = 3.0  # an exit sooner than this after start is a crash loop: wait for the next edit instead of respawning


def snapshot() -> dict:
    return {p: p.stat().st_mtime for p in HERE.glob("*.py") if p.name != "dev.py"}


def server_python() -> str:
    """The repo's .venv Python when there is one (it has Pillow), otherwise the Python that runs this script."""
    venv = HERE.parent / ".venv" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


def start() -> subprocess.Popen:
    return subprocess.Popen([server_python(), str(HERE / "server.py")], cwd=str(HERE))


def server_busy() -> bool:
    """True while a generation, AI order or export is running on the server (restarting now would lose it and its Krea credits)."""
    port = os.environ.get("PORT", "8765")
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/busy", timeout=4) as r:
            return bool(json.loads(r.read()).get("busy"))
    except Exception as e:
        # not running (refused): nothing to lose. Any other failure (a slow answer while it works hard): busy, so wait; a restart
        # then cut a batch off (the user's log: three images in flight, "socket hang up")
        return not isinstance(getattr(e, "reason", e), ConnectionRefusedError)


def wait_until_idle(max_wait: float = 900.0, poll: float = 1.5) -> None:
    """Hold a restart until the server has been idle for two checks in a row (or max_wait passed)."""
    t0, said = time.time(), False
    idle = 0
    while idle < 2 and time.time() - t0 < max_wait:
        if server_busy():
            idle = 0
            if not said:
                print("[dev] files changed, but a generation / AI order is running: restarting when it finishes", flush=True)
                said = True
        else:
            idle += 1
        if idle < 2:
            time.sleep(poll)


def respawn_now(uptime: float) -> bool:
    """Server exited on its own: bring it back unless it died right after starting (e.g. a syntax error)."""
    return uptime >= CRASH_WINDOW


def main() -> None:
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))  # npm / concurrently stop us with SIGTERM
    proc, seen = start(), snapshot()
    started, waiting_for_edit = time.time(), False
    print("[dev] watching studio/*.py (Ctrl-C to stop)", flush=True)
    try:
        while True:
            time.sleep(0.7)
            if proc.poll() is not None and not waiting_for_edit:
                code = proc.returncode
                if respawn_now(time.time() - started):
                    print(f"[dev] server exited ({code}) -> restarting", flush=True)
                    proc, started = start(), time.time()
                else:
                    print(f"[dev] server crashed on start ({code}); waiting for a file change", flush=True)
                    waiting_for_edit = True
            now = snapshot()
            if now != seen:
                while True:  # wait until the files stop changing: several saves in a row mean one restart
                    time.sleep(0.6)
                    again = snapshot()
                    if again == now:
                        break
                    now = again
                changed = [p.name for p in now if now[p] != seen.get(p)]
                if proc.poll() is None:
                    wait_until_idle()
                    now = snapshot()
                print(f"[dev] {', '.join(changed)} changed -> restarting", flush=True)
                if proc.poll() is None:
                    proc.send_signal(signal.SIGINT)
                    try:
                        proc.wait(5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                time.sleep(0.3)
                proc, seen = start(), now
                started, waiting_for_edit = time.time(), False
    except KeyboardInterrupt:
        if proc.poll() is None:
            proc.send_signal(signal.SIGINT)
            try:
                proc.wait(5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()
