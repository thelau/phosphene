"""
The logo check's regression set: 11 invented marks (letters, geometric, complex) x 17 scenes, each with what the check must say
(qa_shapes.py). ~85 s on 12 cores, so it runs only when what it measures changed: qa_engine.py, the shapes, or how a mark is read
(projects.py); after a pass the fingerprint is kept in studio/tests/.qa_shapes_passed (gitignored). QA_SHAPES=1 runs it anyway.
"""

import hashlib
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
STAMP = HERE / ".qa_shapes_passed"
# what the check gets wrong today, with what it says: the test fails if one changes (fixed: take it out of here; worse: a regression)
KNOWN = {
    # a solid square looks like a smaller square from almost anywhere inside it: a little off its place, a smaller one fits better
    ("notched_square", "off_a_little"): "trash",
    ("notched_square", "big_1.8"): "note",
    ("notched_square", "shaded_material"): "trash",
    # a plain disc of the mark's size passes for a round mark (a ring, a flower): seen for real on Halo (a black disc, trashed by hand)
    ("ring", "other_shape"): "pass",
    ("flower", "other_shape"): "pass",
}
# Its limit: synthetic scenes stay easier than generated images (the hard ones here fit 0.7-0.98, the real ones the user kept
# 0.3-0.6), so it catches the check breaking on sizes, places and shapes, not drifting at the subtle end: that needs real images


def _fingerprint() -> str:
    h = hashlib.sha256()
    for f in (HERE.parent / "qa_engine.py", HERE.parent / "projects.py", HERE / "qa_shapes.py", Path(__file__)):
        h.update(f.read_bytes())
    return h.hexdigest()


def _one(job):
    sys.path[:0] = [str(HERE.parent), str(HERE)]
    import qa_engine as q
    import qa_shapes as s
    name, scene, folder = job
    _, size, x, y = s.MARKS[name]
    spec = q.mark_spec(Path(folder) / f"{name}.png", size, x, y)
    r = q.evaluate_plate_qa(s.write_scene(spec, scene, Path(folder) / f"{name}__{scene}.jpg", seed=len(name)), spec)
    return name, scene, "trash" if not r["qa_passed"] else "note" if r["qa_doubt"] else "pass", (r["issues"] or [r["qa_doubt"]])[0]


def test_the_check_on_invented_marks_says_what_it_must(tmp_path):
    fp = _fingerprint()
    if not os.environ.get("QA_SHAPES") and STAMP.exists() and STAMP.read_text() == fp:
        pytest.skip("the logo check has not changed since the last pass")
    import qa_shapes as s
    for name in s.MARKS:
        s.write_mark(name, tmp_path)
    with ProcessPoolExecutor() as pool:
        got = list(pool.map(_one, [(n, sc, str(tmp_path)) for n in s.MARKS for sc in s.SCENES]))
    wrong = []
    for name, scene, verdict, why in got:
        want = s.SCENES[scene]
        if (name, scene) in KNOWN:
            ok = verdict == KNOWN[(name, scene)]
            want = f"known: {KNOWN[(name, scene)]}"
        else:
            ok = verdict != "trash" if want == "keep" else verdict == "trash" if want == "trash" else verdict != "pass"
        if not ok:
            wrong.append(f"{name} / {scene}: wants {want}, the check says {verdict} ({why})")
    assert not wrong, "\n".join(wrong)
    STAMP.write_text(fp)
