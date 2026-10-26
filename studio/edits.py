"""
Your edits of the curation (stored in the curation state as st["edits"]): named ways of cutting the same selection, to switch between in Film.
An edit keeps which group it plays and every Film setting (rhythm, look, sound, the Type); it never keeps images or an order, so it follows
the curation as it changes (images added, trashed or reordered show up in every edit).
"""

import time

MAX_NAME = 40
MAX_SETTINGS = 120


def _clean_name(name) -> str:
    return " ".join(str(name or "").split())[:MAX_NAME]


def _settings(value) -> dict:
    """Plain values only (the page's control ids to strings, numbers or booleans), and not too many of them."""
    if not isinstance(value, dict):
        return {}
    out = {}
    for k, v in list(value.items())[:MAX_SETTINGS]:
        if isinstance(v, (str, int, float, bool)) and len(str(k)) <= 40:
            out[str(k)] = v if not isinstance(v, str) else v[:200]
    return out


def find(st: dict, eid: str) -> dict | None:
    return next((e for e in st.get("edits", []) if e.get("id") == eid), None)


def public(st: dict) -> list:
    return [{"id": e["id"], "name": e["name"], "group": e.get("group", "all"), "settings": e.get("settings", {})} for e in st.get("edits", [])]


def act(st: dict, body: dict) -> dict:
    """create {name, group, settings} · update {id, group, settings} · rename {id, name} · delete {id} · restore {edit} (undo of a delete)."""
    edits = st.setdefault("edits", [])
    action = body.get("action")
    if action == "create":
        name = _clean_name(body.get("name"))
        if not name:
            return {"ok": False, "error": "An edit needs a name."}
        if any(e["name"].lower() == name.lower() for e in edits):
            return {"ok": False, "error": f"There is already an edit called “{name}”."}
        e = {"id": f"e{int(time.time() * 1000)}", "name": name, "group": str(body.get("group") or "all")[:80], "settings": _settings(body.get("settings"))}
        edits.append(e)
        return {"ok": True, "edit": e}
    if action == "restore":
        e = body.get("edit") or {}
        if not e.get("id") or find(st, e["id"]):
            return {"ok": False, "error": "Could not bring the edit back."}
        edits.append({"id": str(e["id"]), "name": _clean_name(e.get("name")) or "Edit", "group": str(e.get("group") or "all")[:80], "settings": _settings(e.get("settings"))})
        return {"ok": True}
    e = find(st, body.get("id", ""))
    if not e:
        return {"ok": False, "error": "That edit is gone."}
    if action == "update":
        e["group"] = str(body.get("group") or "all")[:80]
        e["settings"] = _settings(body.get("settings"))
        return {"ok": True}
    if action == "rename":
        name = _clean_name(body.get("name"))
        if not name:
            return {"ok": False, "error": "An edit needs a name."}
        if any(o is not e and o["name"].lower() == name.lower() for o in edits):
            return {"ok": False, "error": f"There is already an edit called “{name}”."}
        e["name"] = name
        return {"ok": True}
    if action == "delete":
        edits.remove(e)
        return {"ok": True, "edit": e}
    return {"ok": False, "error": "Unknown action."}
