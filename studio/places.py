"""
Where things live. Run from the repository (npm run dev), everything stays where it always was: projects in projects/, this
machine's files (keys, the Krea sign-in, the log, caches, exports) in studio/ and outputs/. The Mac app sets:
  PHOSPHENE_HOME     the projects, one folder each: ~/Documents/Phosphene (visible in Finder, backed up, never touched by updates)
  PHOSPHENE_SUPPORT  this machine's files: ~/Library/Application Support/Phosphene
  PHOSPHENE_WEB      the built page inside the app
  PHOSPHENE_FFMPEG   the ffmpeg inside the app
"""

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
STUDIO_DIR = ROOT_DIR / "studio"


def _env(name: str) -> Path | None:
    v = os.environ.get(name)
    return Path(v).expanduser() if v else None


APP = bool(os.environ.get("PHOSPHENE_HOME"))                       # running inside the Mac app
PROJECTS_DIR = _env("PHOSPHENE_HOME") or ROOT_DIR / "projects"
SUPPORT_DIR = _env("PHOSPHENE_SUPPORT") or STUDIO_DIR
WEB_DIST = _env("PHOSPHENE_WEB") or STUDIO_DIR / "web" / "dist"
OUTPUTS_DIR = (SUPPORT_DIR / "outputs") if APP else ROOT_DIR / "outputs"
FFMPEG = os.environ.get("PHOSPHENE_FFMPEG") or None

for d in (PROJECTS_DIR, SUPPORT_DIR):
    d.mkdir(parents=True, exist_ok=True)
