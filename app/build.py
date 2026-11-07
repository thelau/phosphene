#!/usr/bin/env python3
"""
Everything the Mac app carries, gathered in app/build/resources (what Tauri bundles into Phosphene.app/Contents/Resources):
  server/    studio/server.py frozen with PyInstaller (Python, Pillow and the studio's modules: nothing to install)
  web/       the built page (npm run build)
  bin/ffmpeg a self-contained ffmpeg (from imageio-ffmpeg: only macOS's own frameworks), for the MP4 export
  (licenses/ comes straight from app/licenses, in tauri.conf.json: it exists without a build, so app:live runs)
  No project: the app is the tool, projects are documents (a project travels as a .phos file: Export project / Import)

Run: .venv/bin/python app/build.py   (then: cd app && npx tauri build)
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
BUILD = APP / "build"
OUT = BUILD / "resources"
PY = ROOT / ".venv" / "bin" / "python"


def step(msg: str) -> None:
    print(f"\n== {msg}", flush=True)


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    step("The page (vite build)")
    subprocess.run(["npm", "run", "build"], cwd=ROOT, check=True)
    shutil.copytree(ROOT / "studio" / "web" / "dist", OUT / "web")

    step("The server (PyInstaller)")
    subprocess.run([str(PY), "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir", "--name", "phosphene-server",
                    "--paths", str(ROOT / "studio"), "--distpath", str(BUILD / "pyi-dist"), "--workpath", str(BUILD / "pyi-work"),
                    "--specpath", str(BUILD), "--log-level", "WARN", str(ROOT / "studio" / "server.py")], check=True)
    shutil.copytree(BUILD / "pyi-dist" / "phosphene-server", OUT / "server", symlinks=True)

    step("ffmpeg")
    ff = subprocess.run([str(PY), "-c", "import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())"], capture_output=True, text=True, check=True).stdout.strip()
    (OUT / "bin").mkdir()
    shutil.copy2(ff, OUT / "bin" / "ffmpeg")

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    print(f"   everything the app carries: {size:.0f} MB (no project: projects travel as .phos files)")


if __name__ == "__main__":
    main()
