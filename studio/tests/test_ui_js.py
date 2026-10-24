"""Runs the page's JavaScript tests (node:test, no browser) as part of the pytest run."""

import shutil
import subprocess
from pathlib import Path

import pytest

JS_DIR = Path(__file__).resolve().parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_page_javascript():
    r = subprocess.run(["node", "--test", str(JS_DIR / "ui.test.js")], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]
