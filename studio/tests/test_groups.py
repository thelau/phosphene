"""Your groups: named views of the selection (studio/groups.py)."""

import groups as G


def test_create_add_remove_rename_delete_and_restore():
    st = {}
    r = G.act(st, {"action": "create", "name": "  Night   chrome ", "files": ["a", "b", "a"]})
    assert r["ok"] and r["group"]["name"] == "Night chrome" and r["group"]["files"] == ["a", "b"]
    gid = r["group"]["id"]
    assert not G.act(st, {"action": "create", "name": "night CHROME"})["ok"], "names are unique, whatever the case"
    assert not G.act(st, {"action": "create", "name": "   "})["ok"]
    assert G.act(st, {"action": "add", "id": gid, "files": ["b", "c"]})["ok"]
    assert G.find(st, gid)["files"] == ["a", "b", "c"], "an image is in a group once"
    assert G.act(st, {"action": "remove", "id": gid, "files": ["a"]})["ok"]
    assert G.find(st, gid)["files"] == ["b", "c"]
    assert G.act(st, {"action": "rename", "id": gid, "name": "Chrome"})["ok"] and G.find(st, gid)["name"] == "Chrome"
    gone = G.act(st, {"action": "delete", "id": gid})
    assert gone["ok"] and not G.find(st, gid)
    assert G.act(st, {"action": "restore", "group": gone["group"]})["ok"]
    assert G.find(st, gid)["files"] == ["b", "c"], "the undo of a delete brings back the same group"
    assert not G.act(st, {"action": "add", "id": "nope", "files": ["x"]})["ok"]
    assert not G.act(st, {"action": "explode"})["ok"]


def test_public_only_lists_files_that_still_exist():
    st = {"groups": [{"id": "g1", "name": "A", "files": ["a", "gone", "b"]}]}
    assert G.public(st, {"a", "b"}) == [{"id": "g1", "name": "A", "files": ["a", "b"]}]


def test_looks_for_the_automatic_groups():
    import features as F
    assert F.look(None) == []
    assert F.look({"hue": 20, "sat": 0.5, "lum": 0.2}) == ["warm", "dark"]
    assert F.look({"hue": 210, "sat": 0.4, "lum": 0.8}) == ["cold", "bright"]
    assert F.look({"hue": None, "sat": 0.02, "lum": 0.5}) == ["mono"]
    assert F.look({"hue": 110, "sat": 0.4, "lum": 0.5}) == [], "a green in the middle is neither"
