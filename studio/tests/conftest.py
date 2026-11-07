"""Shared fixtures. Nothing here touches the real state, plates, secrets or network."""

import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gen_log  # noqa: E402
import server  # noqa: E402  (imports the real module, then every test redirects its paths to tmp)


@pytest.fixture(scope="session")
def demo_home(tmp_path_factory):
    """The invented test project, made once: its mark and guides (drawing the guides takes a moment)."""
    import json
    home = tmp_path_factory.mktemp("demo-home")
    demo = home / "demo"
    demo.mkdir()
    demo_mark(demo / "mark.png")
    (demo / "project.json").write_text(json.dumps(DEMO))
    keep = server.projects.PROJECTS_DIR
    server.projects.PROJECTS_DIR = home
    try:
        server.projects.make_guides(server.projects.load("demo"))
    finally:
        server.projects.PROJECTS_DIR = keep
    return home


@pytest.fixture(autouse=True)
def demo_open(demo_home, monkeypatch):
    """Every test starts with the demo project open (the server opens nothing by itself on import)."""
    import copy
    keep = server.projects.PROJECTS_DIR
    server.projects.PROJECTS_DIR = demo_home
    try:
        p = server.projects.load("demo")
    finally:
        server.projects.PROJECTS_DIR = keep
    monkeypatch.setattr(server, "PROJECT", copy.deepcopy(p))


@pytest.fixture
def srv(tmp_path, monkeypatch, demo_home):
    """server.py with state, secrets, plates and QA cache redirected into tmp_path."""
    plates = tmp_path / "plates"
    plates.mkdir()
    monkeypatch.setattr(server, "CURATION_FILE", tmp_path / "curation_state.json")
    monkeypatch.setattr(server, "SECRETS_FILE", tmp_path / ".secrets.json")
    monkeypatch.setattr(server, "QA_CACHE_FILE", tmp_path / "qa_cache.json")
    monkeypatch.setattr(gen_log, "LOG_FILE", tmp_path / "generation_log.jsonl")        # tests never write the real log
    monkeypatch.setattr(server, "QA_CACHE", {})
    monkeypatch.setattr(server, "PLATES_DIR", plates)
    monkeypatch.setattr(server, "THUMBS_DIR", tmp_path / "thumbs")
    monkeypatch.setattr(server, "EXPORT_DIR", tmp_path / "export")
    monkeypatch.setattr(server.features, "CACHE_FILE", server.features.CACHE_FILE)
    monkeypatch.setattr(server.projects, "PROJECTS_DIR", tmp_path / "projects")      # projects made by a test live in tmp
    monkeypatch.setattr(server.projects, "LOCAL_FILE", tmp_path / ".local.json")
    import json, shutil
    demo = tmp_path / "projects" / "demo"                                             # the invented project, its library the test's
    shutil.copytree(demo_home / "demo", demo)
    raw = {**DEMO, "paths": {"plates": str(plates), "state": str(tmp_path / "curation_state.json"), "qa_cache": str(tmp_path / "qa_cache.json"),
                             "thumbs": str(tmp_path / "thumbs"), "features": str(tmp_path / "feat.json"), "guide_cache": str(tmp_path / "guides.json")}}
    (demo / "project.json").write_text(json.dumps(raw))
    monkeypatch.setattr(server, "PROJECT", server.projects.load("demo"))             # a test that switches project gets Demo back after
    for var in ("KIMI_API_KEY", "MOONSHOT_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    return server


DEMO = {"name": "Demo", "mark": "mark.png", "mark_size": 18, "mark_x": 50, "mark_y": 50, "mark_shape": "ring with a notch", "mark_noun": "ring",
        "brief": "Demo, a test project", "palette": ["#EC540C", "#F64570", "#5D8FF4", "#381313", "#1A1A1A", "#FEFFE7"]}


def demo_mark(path: Path, size: int = 480) -> Path:
    """The test project's mark: an invented ring with a notch and a dot (asymmetric, so a turned or mirrored one reads as wrong)."""
    from PIL import ImageDraw
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((20, 20, size - 20, size - 20), outline=(254, 255, 231, 255), width=size // 9)
    d.rectangle((size // 2 - size // 14, 0, size // 2 + size // 14, size // 5), fill=(0, 0, 0, 0))
    d.ellipse((size * 0.58, size * 0.58, size * 0.74, size * 0.74), fill=(254, 255, 231, 255))
    im.save(path)
    return path


@pytest.fixture
def make_plate():
    def _make(path: Path, color=(20, 20, 20), size=(54, 96)) -> Path:
        Image.new("RGB", size, color).save(path, "JPEG")
        return path
    return _make
