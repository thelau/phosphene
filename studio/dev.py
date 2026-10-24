"""
Dev runner: restarts server.py when any studio/*.py changes. The page reloads itself
(it polls /api/version, which changes on every restart and whenever index.html is edited).

    python3 studio/dev.py
"""

import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import autosync

HERE = Path(__file__).resolve().parent


def snapshot() -> dict:
    return {p: p.stat().st_mtime for p in HERE.glob("*.py") if p.name != "dev.py"}


def start() -> subprocess.Popen:
    return subprocess.Popen([sys.executable, str(HERE / "server.py")], cwd=str(HERE))


def main() -> None:
    threading.Thread(target=autosync.loop, daemon=True).start()
    proc, seen = start(), snapshot()
    print("[dev] watching studio/*.py, syncing to GitHub every 2 min (Ctrl-C to stop)", flush=True)
    try:
        while True:
            time.sleep(0.7)
            now = snapshot()
            if now != seen:
                changed = [p.name for p in now if now[p] != seen.get(p)]
                print(f"[dev] {', '.join(changed)} changed -> restarting", flush=True)
                proc.send_signal(signal.SIGINT)
                try:
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                time.sleep(0.3)
                proc, seen = start(), now
    except KeyboardInterrupt:
        proc.send_signal(signal.SIGINT)


if __name__ == "__main__":
    main()
