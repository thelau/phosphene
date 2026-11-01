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


def test_each_of_your_groups_keeps_its_own_order():
    st = {}
    gid = G.act(st, {"action": "create", "name": "Night", "files": ["a", "b", "c"]})["group"]["id"]
    assert G.act(st, {"action": "reorder", "id": gid, "files": ["c", "a", "b"]})["ok"]
    assert G.find(st, gid)["files"] == ["c", "a", "b"], "its own order"
    assert G.act(st, {"action": "reorder", "id": gid, "files": ["b", "zzz"]})["ok"]
    assert G.find(st, gid)["files"] == ["b", "c", "a"], "only its own images; the ones not given keep their order after"
    G.act(st, {"action": "add", "id": gid, "files": ["d"]})
    assert G.find(st, gid)["files"][-1] == "d", "new images join at its end"


def test_a_smart_group_holds_a_rule_not_files_and_only_its_choices_change():
    import groups
    st = {}
    res = groups.act(st, {"action": "create", "name": "Turned", "rule": {"rot": ["90", "-90"], "bogus": ["x"], "pos": []}})
    g = res["group"]
    assert g["rule"] == {"rot": ["90", "-90"]} and g["files"] == []
    assert groups.act(st, {"action": "create", "name": "Empty", "rule": {"pos": []}})["ok"] is False, "at least one choice"
    assert groups.act(st, {"action": "add", "id": g["id"], "files": ["a.jpg"]})["ok"] is False, "it fills itself"
    assert groups.act(st, {"action": "rule", "id": g["id"], "rule": {"size": ["1.25"]}})["ok"] and st["groups"][0]["rule"] == {"size": ["1.25"]}
    assert groups.public(st, set())[0]["rule"] == {"size": ["1.25"]}
    deleted = groups.act(st, {"action": "delete", "id": g["id"]})["group"]
    assert groups.act(st, {"action": "restore", "group": deleted})["ok"] and st["groups"][0]["rule"] == {"size": ["1.25"]}, "undo brings its rule back"
    manual = groups.act(st, {"action": "create", "name": "Mine", "files": ["a.jpg"]})["group"]
    assert "rule" not in manual and groups.public(st, {"a.jpg"})[1]["files"] == ["a.jpg"], "manual groups as before"


def test_skip_is_per_group_key_and_play_brings_it_back():
    """Skip (Claude Design, 2026-11-01): an image left out of one group's film plays in the others; Play undoes it; nothing else moves."""
    st = {"groups": [{"id": "g1", "name": "Mine", "files": ["a", "b"]}]}
    assert G.act(st, {"action": "skip", "key": "all", "files": ["a", "b"]})["ok"]
    assert G.act(st, {"action": "skip", "key": "look:dark", "files": ["c"]})["ok"]
    assert G.act(st, {"action": "skip", "key": "all", "files": ["a"]})["ok"], "again: no duplicate"
    assert st["skips"] == {"all": ["a", "b"], "look:dark": ["c"]}
    assert G.act(st, {"action": "skip", "key": "all", "files": ["a"], "skip": False})["ok"]
    assert st["skips"] == {"all": ["b"], "look:dark": ["c"]} and st["groups"][0]["files"] == ["a", "b"], "Play: back; the group untouched"
    G.act(st, {"action": "skip", "key": "all", "files": ["b"], "skip": False}); G.act(st, {"action": "skip", "key": "look:dark", "files": ["c"], "skip": False})
    assert "skips" not in st, "nothing skipped: nothing stored"
    assert not G.act(st, {"action": "skip", "key": "", "files": ["a"]})["ok"] and not G.act(st, {"action": "skip", "key": "x" * 400, "files": ["a"]})["ok"]
    G.act(st, {"action": "skip", "key": "g:g1", "files": ["../etc/passwd", "a"]})
    assert st["skips"] == {"g:g1": ["a"]}, "names only, never a path"


def test_clean_skips_keeps_sound_entries_only():
    assert G.clean_skips({"all": ["a", "a", "../x", ".hidden", 3], "": ["b"], "look:dark": [], "g:1": "nope", "x" * 301: ["c"]}) == {"all": ["a", "3"]}
    assert G.clean_skips(None) == {} and G.clean_skips(["all"]) == {}
