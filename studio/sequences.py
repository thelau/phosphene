"""
The two orders of the selection: "Manual" (always there, yours) and "AI" (made by Order with AI; running it again replaces it).

  state["sequences"]        [{id, name, kind: "manual" | "ai", order: [filenames], original (AI only), summary, cut_off, cuts, created_at}]
  state["active_sequence"]  id of the one the grid, the player and the export use

Rules:
  - Both can be edited by dragging. The AI order remembers what it was when it was made, so it can be reset.
  - A restored image goes to the end of BOTH orders; a new image is added to the end of both.
  - Trashed images keep their slot (they are simply not shown), except when restored (end of the order).
  - A state without sequences (old saves, tests) still works through the legacy `order` list; an old save with many orders is
    reduced to its first Manual and its latest AI.
"""

import time


def _make(st: dict, kind: str, order: list, **extra) -> dict:
    ids = {s["id"] for s in st.get("sequences", [])}
    n = max(st.get("seq_next", 1), len(ids) + 1)         # ids are never reused, so a stale page cannot hit the wrong order
    while f"s{n}" in ids:
        n += 1
    st["seq_next"] = n + 1
    order = list(dict.fromkeys(order))
    seq = {"id": f"s{n}", "name": "Manual" if kind == "manual" else "AI", "kind": kind, "order": order, "summary": None,
           "created_at": time.time(), "cut_off": None, "cuts": []}
    if kind == "ai":
        seq["original"] = list(order)
    seq.update(extra)
    return seq


def ensure(st: dict) -> dict:
    """Migrate an old save (single `order`, or many orders) into one Manual and at most one AI, and make sure one is active."""
    seqs = st.get("sequences") or []
    manual = next((s for s in seqs if s["kind"] == "manual"), None)
    ai = next((s for s in reversed(seqs) if s["kind"] == "ai"), None)
    if manual is None:
        manual = _make(st, "manual", list(st.get("order", [])))
    manual["name"] = "Manual"
    keep = [manual] + ([ai] if ai else [])
    if ai:
        ai["name"] = "AI"
        ai.setdefault("original", list(ai["order"]))
    st["sequences"] = keep
    st.pop("order", None)
    if st.get("active_sequence") not in {s["id"] for s in keep}:
        st["active_sequence"] = manual["id"]
    return st


def manual(st: dict) -> dict | None:
    return next((s for s in st.get("sequences", []) if s["kind"] == "manual"), None)


def ai(st: dict) -> dict | None:
    return next((s for s in st.get("sequences", []) if s["kind"] == "ai"), None)


def add_ai(st: dict, order: list, summary: str | None = None, cut_off: int | None = None, cuts: list | None = None) -> dict:
    """Make (or replace) THE AI order and switch to it. The Manual order is not touched."""
    st["sequences"] = [s for s in st.get("sequences", []) if s["kind"] != "ai"]
    seq = _make(st, "ai", order, summary=summary, cut_off=cut_off, cuts=cuts or [])
    st["sequences"].append(seq)
    st["active_sequence"] = seq["id"]
    return seq


def find(st: dict, seq_id: str) -> dict | None:
    return next((s for s in st.get("sequences", []) if s["id"] == seq_id), None)


def active(st: dict) -> dict | None:
    return find(st, st.get("active_sequence", ""))


def get_order(st: dict) -> list:
    seq = active(st)
    return list(seq["order"]) if seq else list(st.get("order", []))


def reorder_active(st: dict, new_order: list) -> None:
    """The user dragged something: the order they are looking at changes (Manual or AI)."""
    order = list(dict.fromkeys(str(x) for x in new_order))
    seq = active(st)
    if seq is None:
        st["order"] = order
        return
    seq["order"] = order + [n for n in seq["order"] if n not in set(order)]      # never lose an image the client did not send


def activate(st: dict, seq_id: str) -> bool:
    if not find(st, seq_id):
        return False
    st["active_sequence"] = seq_id
    return True


def reset_ai(st: dict) -> bool:
    """Put the AI order back to how the AI made it (undo the user's drags)."""
    seq = ai(st)
    if not seq:
        return False
    seq["order"] = list(seq.get("original", seq["order"]))
    return True


def make_manual(st: dict) -> bool:
    """Replace the Manual order with a copy of the AI order as it is now (including your drags and its best-N cut). The AI order stays."""
    a, m = ai(st), manual(st)
    if not a or not m:
        return False
    m["order"] = list(a["order"])
    m["cut_off"] = a.get("cut_off")
    st["active_sequence"] = m["id"]
    return True


def restore(st: dict, order: list, cut_off) -> bool:
    """Undo / redo of an AI re-order: put back an order the user had (and its best-N cut) on the order shown."""
    seq = active(st)
    if seq is None or not isinstance(order, list):
        return False
    reorder_active(st, order)
    try:
        n = int(cut_off) if cut_off else None
    except (TypeError, ValueError):
        n = None
    seq["cut_off"] = n if n and 0 < n < len(seq["order"]) else None
    return True


def include_all(st: dict) -> bool:
    """Put every image back in the edit of the order you are looking at (clears a best-N cut)."""
    seq = active(st)
    if not seq or not seq.get("cut_off"):
        return False
    seq["cut_off"] = None
    return True


def is_edited(seq: dict) -> bool:
    return seq["kind"] == "ai" and seq["order"] != seq.get("original", seq["order"])


def _each_order(st: dict):
    """Yield (container, key) for every order list, including the legacy one."""
    for s in st.get("sequences", []):
        yield s, "order"
        if "original" in s:
            yield s, "original"
    if "order" in st:
        yield st, "order"


def append_everywhere(st: dict, filename: str) -> None:
    for box, key in _each_order(st):
        if filename not in box[key]:
            box[key] = box[key] + [filename]


def remove_everywhere(st: dict, names) -> None:
    gone = set(names)
    for box, key in _each_order(st):
        box[key] = [n for n in box[key] if n not in gone]


def move_to_end_everywhere(st: dict, names, universe=()) -> None:
    """Restored images go to the end of every order (original order of `names` kept). `universe` = every plate that exists,
    so images missing from an order are appended first (by name) and the restored ones end up last."""
    moving = list(dict.fromkeys(names))
    for box, key in _each_order(st):
        if key == "original":
            continue
        base = [n for n in box[key] if n not in set(moving)]
        base += [n for n in sorted(universe) if n not in set(base) and n not in set(moving)]
        pos = {n: i for i, n in enumerate(box[key])}
        box[key] = base + sorted(moving, key=lambda n: (n not in pos, pos.get(n, 0)))
    for s in st.get("sequences", []):                      # the AI's original keeps the same newcomers at the end
        if "original" in s:
            s["original"] = [n for n in s["original"] if n not in set(moving)] + [n for n in moving if n in s["order"]]


def public(st: dict, visible: set | None = None) -> list:
    """What the page needs: id, kind, name, how many images it shows, whether the AI order was edited, and the AI summary."""
    out = []
    for s in st.get("sequences", []):
        count = len([n for n in s["order"] if visible is None or n in visible])
        out.append({"id": s["id"], "name": s["name"], "kind": s["kind"], "count": count, "summary": s.get("summary"),
                    "cut_off": s.get("cut_off"), "edited": is_edited(s)})
    return out


def edit_files(files: list, st: dict) -> list:
    """The images that are in the edit: the shown (not trashed) ones, cut at the active order's cut_off if it has one."""
    seq = active(st)
    n = seq.get("cut_off") if seq else None
    return files[:n] if n else files
