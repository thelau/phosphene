"""Real-browser tests (Playwright driving Brave/Chrome against Vite + a fake API). Slower than the rest, ~25s."""

import shutil
import subprocess
from pathlib import Path

import pytest

E2E = Path(__file__).resolve().parent / "e2e" / "ui.e2e.test.cjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_browser_flows():
    r = subprocess.run(["node", "--test", str(E2E)], capture_output=True, text=True, timeout=240)
    assert r.returncode == 0, r.stdout[-6000:] + r.stderr[-2000:]
