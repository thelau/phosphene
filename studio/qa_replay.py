"""
The logo check replayed on the user's own curation: every image of every project (not DEMO: its check is fixed), measured again with
the check as it is now, against what the user did with it. The regression test for any change to the check (qa_engine.py).

  kept           in the selection                        the check should pass it (a "Check the mark" note is fine)
  restored       the check trashed it, the user put it back   the check was wrong
  you trashed    trashed by hand (maybe for taste)        the check passing it is a miss, not an error
  left           the check trashed it and it stayed       taken as agreed

Run:  .venv/bin/python studio/qa_replay.py                      the disagreements and the counts
      .venv/bin/python studio/qa_replay.py --save before.json   also keep every verdict
      .venv/bin/python studio/qa_replay.py --against before.json   then, after a change: what it changed
      --home DIR   the projects' folder (default: the Mac app's, ~/Documents/Phosphene)
"""

import argparse
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _measure(job: tuple) -> tuple:
    import qa_engine
    key, image, mark_file, size, x, y = job
    r = qa_engine.evaluate_plate_qa(Path(image), qa_engine.mark_spec(Path(mark_file), size, x, y))
    verdict = "trash" if not r["qa_passed"] else "note" if r.get("qa_doubt") else "pass"
    return key, verdict, (r["issues"] or [r.get("qa_doubt") or ""])[0]


def jobs(home: Path) -> tuple[list, dict]:
    import projects
    projects.PROJECTS_DIR = home
    todo, judged = [], {}
    for f in sorted(home.glob("*/project.json")):
        p = projects.load(f.parent.name)
        if p.get("demo") or not p["state_file"].exists():
            continue
        st = json.loads(p["state_file"].read_text())
        trashed, by_check = set(st.get("trashed", [])), set(st.get("qa_failed", []))
        by_critic = set(st.get("critic_failed", []))
        for img in sorted(p["plates_dir"].glob("*.jpg")):
            n = img.name
            if n in trashed and n in by_critic and n not in by_check:
                continue                                                  # the AI critic's call, not the user's
            judged[f"{p['slug']}/{n}"] = ("left" if n in trashed else "restored") if n in by_check else "you trashed" if n in trashed else "kept"
            q = projects.with_mark(p, st.get("marks_used", {}).get(n))      # as it was made: its mark, its own place (Loose / Scattered)
            pl = st.get("placements", {}).get(n) or {}
            todo.append((f"{p['slug']}/{n}", str(img), str(q["mark_file"]), pl.get("size", q["mark_size"]), pl.get("x", q["mark_x"]), pl.get("y", q["mark_y"])))
    return todo, judged


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--home", type=Path, default=Path(os.environ.get("PHOSPHENE_HOME") or Path.home() / "Documents" / "Phosphene"))
    ap.add_argument("--save", type=Path)
    ap.add_argument("--against", type=Path)
    a = ap.parse_args()
    todo, judged = jobs(a.home)
    print(f"{len(todo)} images in {len({k.split('/')[0] for k in judged})} projects ({a.home})…", flush=True)
    with ProcessPoolExecutor() as pool:
        got = {k: (v, why) for k, v, why in pool.map(_measure, todo)}
    wrong = [(k, judged[k], *got[k]) for k in got if judged[k] in ("kept", "restored") and got[k][0] == "trash"]
    missed = [(k, judged[k], *got[k]) for k in got if judged[k] in ("you trashed", "left") and got[k][0] == "pass"]
    agree = len(got) - len(wrong) - len(missed)
    for title, rows in (("Trashed by the check, kept by you", wrong), ("Passed by the check, in your Trash (maybe for taste)", missed)):
        print(f"\n{title}: {len(rows)}")
        for k, j, v, why in sorted(rows):
            print(f"  {k:52s} {j:12s} {why}")
    print(f"\nAgree on {agree} of {len(got)} (a note on an image you trashed counts as agreeing)")
    if a.against:
        before = json.loads(a.against.read_text())
        changed = sorted(k for k in got if k in before and before[k] != got[k][0])
        print(f"\nChanged since {a.against.name}: {len(changed)}")
        for k in changed:
            print(f"  {k:52s} {judged[k]:12s} {before[k]} -> {got[k][0]}  {got[k][1]}")
    if a.save:
        a.save.write_text(json.dumps({k: v for k, (v, _) in got.items()}, indent=1, sort_keys=True))
        print(f"\nSaved to {a.save}")


if __name__ == "__main__":
    main()
