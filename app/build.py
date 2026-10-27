#!/usr/bin/env python3
"""
Everything the Mac app carries, gathered in app/build/resources (what Tauri bundles into Phosphene.app/Contents/Resources):
  server/    studio/server.py frozen with PyInstaller (Python, Pillow and the studio's modules: nothing to install)
  web/       the built page (npm run build)
  bin/ffmpeg a self-contained ffmpeg (from imageio-ffmpeg: only macOS's own frameworks), for the MP4 export
  examples/  Demo, the sample project: its mark, guides, curation and the images it keeps (the Trash stays out, to keep
             the download small; --with-trash puts it in), copied into ~/Documents/Phosphene on first launch

Run: .venv/bin/python app/build.py   (then: cd app && npx tauri build)
"""

import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
BUILD = APP / "build"
OUT = BUILD / "resources"
PY = ROOT / ".venv" / "bin" / "python"


def step(msg: str) -> None:
    print(f"\n== {msg}", flush=True)


def main(with_trash: bool = False) -> None:
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

    step("Demo, the sample project")
    sys.path.insert(0, str(ROOT / "studio"))
    import projects
    tmp = BUILD / "demo.zip"
    projects.export_zip("demo", tmp)
    examples = OUT / "examples"
    with zipfile.ZipFile(tmp) as z:
        z.extractall(examples)
    tmp.unlink()
    folder = examples / "Demo"
    state = json.loads((folder / "state.json").read_text())
    if not with_trash:
        trashed = set(state.get("trashed", []))
        for f in trashed:
            (folder / "plates" / f).unlink(missing_ok=True)
        state["trashed"], state["trashed_at"] = [], {}
        for key in ("qa_failed", "critic_failed"):
            state[key] = []
        for key in ("order",):
            if isinstance(state.get(key), list):
                state[key] = [f for f in state[key] if f not in trashed]
        for seq in state.get("sequences", []) or []:
            if isinstance(seq, dict) and isinstance(seq.get("order"), list):
                seq["order"] = [f for f in seq["order"] if f not in trashed]
        (folder / "state.json").write_text(json.dumps(state, indent=1))
    n = len(list((folder / "plates").glob("*.jpg")))
    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
    print(f"   {n} images; everything the app carries: {size:.0f} MB")


if __name__ == "__main__":
    main(with_trash="--with-trash" in sys.argv)
