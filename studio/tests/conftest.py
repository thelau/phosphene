"""Shared fixtures. Nothing here touches the real state, plates, secrets or network."""

import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gen_log  # noqa: E402
import server  # noqa: E402  (imports the real module, then every test redirects its paths to tmp)


@pytest.fixture
def srv(tmp_path, monkeypatch):
    """server.py with state, secrets, plates and QA cache redirected into tmp_path."""
    plates = tmp_path / "plates"
    plates.mkdir()
    monkeypatch.setattr(server, "CURATION_FILE", tmp_path / "curation_state.json")
    monkeypatch.setattr(server, "SECRETS_FILE", tmp_path / ".secrets.json")
    monkeypatch.setattr(server, "QA_CACHE_FILE", tmp_path / "qa_cache.json")
    monkeypatch.setattr(gen_log, "LOG_FILE", tmp_path / "generation_log.jsonl")        # tests never write the real log
    monkeypatch.setattr(server, "QA_CACHE", {})
    monkeypatch.setattr(server, "PLATES_DIR", plates)
    for var in ("KIMI_API_KEY", "MOONSHOT_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    return server


@pytest.fixture
def make_plate():
    def _make(path: Path, color=(20, 20, 20), size=(54, 96)) -> Path:
        Image.new("RGB", size, color).save(path, "JPEG")
        return path
    return _make
