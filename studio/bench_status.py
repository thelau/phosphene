#!/usr/bin/env python3
"""Progress of the latest generation run: python3 studio/bench_status.py  (add -w to refresh every 5s)"""
import re
import sys
import time
from pathlib import Path

LOG = Path(__file__).resolve().parent / ".bench_latest.log"


def status() -> str:
    t = LOG.read_text() if LOG.exists() else ""
    total = re.findall(r"\[BENCH\] (\d+) images", t)
    done = len(re.findall(r"\[BENCH\] \d+_", t))
    err = len(re.findall(r"\[BENCH\] FAIL", t))
    logo = len(re.findall(r"qa=FAIL", t))
    if not total:
        return f"inventing scenes... ({len(re.findall(r'titles:', t))} batches ready)"
    n = int(total[0])
    finished = "[BENCH] done" in t
    return f"{done + err}/{n} images ({done} made, {err} errors, {logo} logo-fail)" + ("  DONE" if finished else "")


if __name__ == "__main__":
    while True:
        print(status(), flush=True)
        if "-w" not in sys.argv or "DONE" in status():
            break
        time.sleep(5)
