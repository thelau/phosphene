"""
Your groups of images (stored in the curation state as st["groups"]): named sets of the selection that the film can play on its own.
A group is a view, not a copy: an image can be in several groups, and trashing an image takes it out everywhere it shows. Each of
your groups has its OWN order (its files list, in order): dragging or the AI ordering inside it changes only it; new images join at
its end. All and the automatic groups share the one order of the selection. The automatic groups (warm, cold, mono, dark, bright, territories) are worked out in the page from
each image's look and territory; only the ones you make are stored here.

Two kinds of yours (the user, 2026-10-31: All | Auto | Smart | Manual): a manual group holds the images you put in it (`files`); a
smart group holds a rule (`rule`: {kind: [values]} over how each image was made: mark, pos, rot, size, src) and fills itself in the
page with the images that match: within a kind any of its values, across kinds all of them. It has no files and no order of its own
(it plays in the one order, as the automatic groups do); adding, removing and reordering are for manual groups only.
"""

import time

MAX_NAME = 40


def _clean_name(name) -> str:
    return " ".join(str(name or "").split())[:MAX_NAME]


def _files(value) -> list:
    return list(dict.fromkeys(str(f) for f in value)) if isinstance(value, list) else []


RULE_KINDS = ("mark", "pos", "rot", "size", "src", "run")   # run: one Path run (Made with › Path)


def clean_rule(rule) -> dict | None:
    """A smart group's rule, checked: known kinds, each a short list of short text values; None when nothing is left."""
    if not isinstance(rule, dict):
        return None
    out = {}
    for k in RULE_KINDS:
        vals = rule.get(k)
        if isinstance(vals, list):
            vals = list(dict.fromkeys(str(v)[:40] for v in vals if isinstance(v, (str, int, float))))[:20]
            if vals:
                out[k] = vals
    return out or None


MAX_KEY = 300


def clean_key(key) -> str:
    """A group's key, as the page names the group shown ('all', 'g:<id>', 'look:dark', 'world:<name>', a Made with filter): short text."""
    key = str(key or "") if isinstance(key, (str, int)) else ""
    return key if 0 < len(key) <= MAX_KEY and key.isprintable() else ""


def clean_skips(value) -> dict:
    """Skipped images, per group key: {key: [file names]} (an image skipped in one group plays in the others)."""
    out = {}
    for k, v in (value.items() if isinstance(value, dict) else []):
        k = clean_key(k)
        files = [f for f in _files(v) if f and "/" not in f and "\\" not in f and not f.startswith(".")]
        if k and files:
            out[k] = files
    return out


def skips_for(st: dict, existing: set) -> dict:
    """The skips for the page: per group key, the images that still exist; a key left with none is not listed."""
    out = {k: [f for f in v if f in existing] for k, v in clean_skips(st.get("skips")).items()}
    return {k: v for k, v in out.items() if v}


def skip(st: dict, body: dict) -> dict:
    """skip {key, files, skip: true | false}: leave images out of that group's film, or play them again. They keep their place."""
    key = clean_key(body.get("key"))
    if not key:
        return {"ok": False, "error": "Which group?"}
    files = [f for f in _files(body.get("files")) if f and "/" not in f]
    skips = st.setdefault("skips", {})
    now = skips.get(key, [])
    now = now + [f for f in files if f not in now] if body.get("skip", True) is not False else [f for f in now if f not in files]
    if now:
        skips[key] = now
    else:
        skips.pop(key, None)
    if not skips:
        st.pop("skips", None)
    return {"ok": True}


def find(st: dict, gid: str) -> dict | None:
    return next((g for g in st.get("groups", []) if g.get("id") == gid), None)


def public(st: dict, existing: set) -> list:
    """The groups for the page: their files that still exist, in the stored order."""
    return [{"id": g["id"], "name": g["name"], "files": [f for f in g.get("files", []) if f in existing], **({"rule": g["rule"]} if g.get("rule") else {})}
            for g in st.get("groups", [])]


def act(st: dict, body: dict) -> dict:
    """create {name, files} or {name, rule} (a smart group) · add {id, files} · remove {id, files} · reorder {id, files} · rename {id, name} ·
    delete {id} · restore {group} (undo of a delete) · skip {key, files, skip} (any group shown, by its key)."""
    action = body.get("action")
    if action == "skip":                                      # Skip / Play: per group, All and the automatic ones too
        return skip(st, body)
    groups = st.setdefault("groups", [])
    if action == "create":
        name = _clean_name(body.get("name"))
        if not name:
            return {"ok": False, "error": "A group needs a name."}
        if any(g["name"].lower() == name.lower() for g in groups):
            return {"ok": False, "error": f"There is already a group called “{name}”."}
        rule = clean_rule(body.get("rule"))
        if "rule" in body and not rule:
            return {"ok": False, "error": "A smart group needs at least one choice."}
        g = {"id": f"g{int(time.time() * 1000)}", "name": name, "files": [] if rule else _files(body.get("files")), **({"rule": rule} if rule else {})}
        groups.append(g)
        return {"ok": True, "group": g}
    if action == "restore":                                   # the undo of a delete: the same group back
        g = body.get("group") or {}
        if not g.get("id") or find(st, g["id"]):
            return {"ok": False, "error": "Could not bring the group back."}
        rule = clean_rule(g.get("rule"))
        groups.append({"id": str(g["id"]), "name": _clean_name(g.get("name")) or "Group", "files": [] if rule else _files(g.get("files")), **({"rule": rule} if rule else {})})
        return {"ok": True}
    g = find(st, body.get("id", ""))
    if not g:
        return {"ok": False, "error": "That group is gone."}
    if action == "rule":                                      # a smart group's choices changed
        rule = clean_rule(body.get("rule"))
        if not g.get("rule") or not rule:
            return {"ok": False, "error": "A smart group needs at least one choice."}
        g["rule"] = rule
        return {"ok": True}
    if g.get("rule") and action in ("add", "remove", "reorder"):
        return {"ok": False, "error": "A smart group fills itself: change its choices instead."}
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
