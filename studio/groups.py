"""
Your groups of images (stored in the curation state as st["groups"]): named sets of the selection that the film can play on its own.
A group is a view, not a copy: an image can be in several groups, and trashing an image takes it out everywhere it shows. Each of
your groups has its OWN order (its files list, in order): dragging or the AI ordering inside it changes only it; new images join at
its end. All and the automatic groups share the one order of the selection. The automatic groups (warm, cold, mono, dark, bright, territories) are worked out in the page from
each image's look and territory; only the ones you make are stored here.
"""

import time

MAX_NAME = 40


def _clean_name(name) -> str:
    return " ".join(str(name or "").split())[:MAX_NAME]


def _files(value) -> list:
    return list(dict.fromkeys(str(f) for f in value)) if isinstance(value, list) else []


def find(st: dict, gid: str) -> dict | None:
    return next((g for g in st.get("groups", []) if g.get("id") == gid), None)


def public(st: dict, existing: set) -> list:
    """The groups for the page: their files that still exist, in the stored order."""
    return [{"id": g["id"], "name": g["name"], "files": [f for f in g.get("files", []) if f in existing]} for g in st.get("groups", [])]


def act(st: dict, body: dict) -> dict:
    """create {name, files} · add {id, files} · remove {id, files} · reorder {id, files} · rename {id, name} · delete {id} ·
    restore {group} (undo of a delete)."""
    groups = st.setdefault("groups", [])
    action = body.get("action")
    if action == "create":
        name = _clean_name(body.get("name"))
        if not name:
            return {"ok": False, "error": "A group needs a name."}
        if any(g["name"].lower() == name.lower() for g in groups):
            return {"ok": False, "error": f"There is already a group called “{name}”."}
        g = {"id": f"g{int(time.time() * 1000)}", "name": name, "files": _files(body.get("files"))}
        groups.append(g)
        return {"ok": True, "group": g}
    if action == "restore":                                   # the undo of a delete: the same group back
        g = body.get("group") or {}
        if not g.get("id") or find(st, g["id"]):
            return {"ok": False, "error": "Could not bring the group back."}
        groups.append({"id": str(g["id"]), "name": _clean_name(g.get("name")) or "Group", "files": _files(g.get("files"))})
        return {"ok": True}
    g = find(st, body.get("id", ""))
    if not g:
        return {"ok": False, "error": "That group is gone."}
    if action == "add":
        have = set(g["files"])
        g["files"] += [f for f in _files(body.get("files")) if f not in have]
        return {"ok": True}
    if action == "remove":
        out = set(_files(body.get("files")))
        g["files"] = [f for f in g["files"] if f not in out]
        return {"ok": True}
    if action == "reorder":                                   # its own order: the files given first, in that order, then any not given
        want = [f for f in _files(body.get("files")) if f in g["files"]]
        g["files"] = want + [f for f in g["files"] if f not in want]
        return {"ok": True}
    if action == "rename":
        name = _clean_name(body.get("name"))
        if not name:
            return {"ok": False, "error": "A group needs a name."}
        if any(o is not g and o["name"].lower() == name.lower() for o in groups):
            return {"ok": False, "error": f"There is already a group called “{name}”."}
        g["name"] = name
        return {"ok": True}
    if action == "delete":
        groups.remove(g)
        return {"ok": True, "group": g}
    return {"ok": False, "error": "Unknown action."}
