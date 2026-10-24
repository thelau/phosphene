"""
Named orders ("sequences") of the selection. Pure functions over the saved state, so they are easy to test.

  state["sequences"]        [{id, name, kind: "manual" | "ai", order: [filenames], summary, parent, created_at}]
  state["active_sequence"]  id of the one the grid, the player and the export use

Rules:
  - Manual sequences are edited in place. AI sequences are frozen: dragging in one forks a new manual copy, so neither is lost.
  - A restored image goes to the end of EVERY sequence; a new image is added to the end of every sequence.
  - Trashed images keep their slot in a sequence (it is simply not shown), except when restored (end of the order).
  - A state without sequences (old saves, tests) still works through the legacy `order` list.
"""

import time


def _next_id(st: dict) -> str:
    ids = {s["id"] for s in st.get("sequences", [])}
    n = len(ids) + 1
    while f"s{n}" in ids:
        n += 1
    return f"s{n}"


def _label(st: dict, kind: str) -> str:
    counter = st.setdefault("seq_counter", {"manual": 0, "ai": 0})
    counter[kind] = counter.get(kind, 0) + 1
    return f"{'Manual' if kind == 'manual' else 'AI'} {counter[kind]}"


def ensure(st: dict) -> dict:
    """Migrate an old save (single `order`) into a first Manual sequence and make sure one is active."""
    if not st.get("sequences"):
        st["sequences"] = []
        add(st, "manual", list(st.get("order", [])), activate=True)
    st.pop("order", None)
    if st.get("active_sequence") not in {s["id"] for s in st["sequences"]}:
        st["active_sequence"] = st["sequences"][0]["id"]
    return st


def add(st: dict, kind: str, order: list, name: str | None = None, summary: str | None = None, parent: str | None = None, activate: bool = True,
        cut_off: int | None = None, cuts: list | None = None) -> dict:
    """cut_off = only the first N shown images are in the edit (preview and export); the rest are listed after a divider."""
    seq = {
        "id": _next_id(st), "name": name or _label(st, kind), "kind": kind, "order": list(dict.fromkeys(order)),
        "summary": summary, "parent": parent, "created_at": time.time(), "cut_off": cut_off, "cuts": cuts or [],
    }
    st.setdefault("sequences", []).append(seq)
    if activate or not st.get("active_sequence"):
        st["active_sequence"] = seq["id"]
    return seq


def find(st: dict, seq_id: str) -> dict | None:
    return next((s for s in st.get("sequences", []) if s["id"] == seq_id), None)


def active(st: dict) -> dict | None:
    return find(st, st.get("active_sequence", ""))


def get_order(st: dict) -> list:
    seq = active(st)
    return list(seq["order"]) if seq else list(st.get("order", []))


def set_order(st: dict, order: list) -> None:
    seq = active(st)
    if seq:
        seq["order"] = list(dict.fromkeys(order))
    else:
        st["order"] = list(order)


def reorder_active(st: dict, new_order: list) -> dict | None:
    """The user dragged something. Manual: update in place. AI: fork a manual copy and switch to it. Returns the fork or None."""
    seq = active(st)
    order = list(dict.fromkeys(str(x) for x in new_order))
    if seq is None:
        st["order"] = order
        return None
    order += [n for n in seq["order"] if n not in set(order)]            # never lose an image the client did not send
    if seq["kind"] == "ai":
        n = st.setdefault("seq_counter", {"manual": 0, "ai": 0})
        n["manual"] = n.get("manual", 0) + 1
        return add(st, "manual", order, name=f"Manual {n['manual']} (from {seq['name']})", parent=seq["id"], cut_off=seq.get("cut_off"))
    seq["order"] = order
    return None


def rename(st: dict, seq_id: str, name: str) -> bool:
    seq, name = find(st, seq_id), (name or "").strip()[:60]
    if not seq or not name:
        return False
    seq["name"] = name
    return True


def duplicate(st: dict, seq_id: str) -> dict | None:
    seq = find(st, seq_id)
    if not seq:
        return None
    return add(st, "manual", seq["order"], name=f"{seq['name']} copy", parent=seq["id"], cut_off=seq.get("cut_off"))


def delete(st: dict, seq_id: str) -> bool:
    """The last remaining sequence cannot be deleted."""
    if len(st.get("sequences", [])) <= 1 or not find(st, seq_id):
        return False
    st["sequences"] = [s for s in st["sequences"] if s["id"] != seq_id]
    if st.get("active_sequence") == seq_id:
        st["active_sequence"] = st["sequences"][0]["id"]
    return True


def activate(st: dict, seq_id: str) -> bool:
    if not find(st, seq_id):
        return False
    st["active_sequence"] = seq_id
    return True


def _each_order(st: dict):
    """Yield (container, key) for every order list, including the legacy one."""
    for s in st.get("sequences", []):
        yield s, "order"
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
        base = [n for n in box[key] if n not in set(moving)]
        base += [n for n in sorted(universe) if n not in set(base) and n not in set(moving)]
        pos = {n: i for i, n in enumerate(box[key])}
        box[key] = base + sorted(moving, key=lambda n: (n not in pos, pos.get(n, 0)))


def public(st: dict, visible: set | None = None) -> list:
    """What the page needs: id, name, kind, how many images it shows, and the AI summary."""
    out = []
    for s in st.get("sequences", []):
        count = len([n for n in s["order"] if visible is None or n in visible])
        out.append({"id": s["id"], "name": s["name"], "kind": s["kind"], "count": count, "summary": s.get("summary"), "parent": s.get("parent"), "cut_off": s.get("cut_off")})
    return out


def edit_files(files: list, st: dict) -> list:
    """The images that are in the edit: the shown (not trashed) ones, cut at the active order's cut_off if it has one."""
    seq = active(st)
    n = seq.get("cut_off") if seq else None
    return files[:n] if n else files
