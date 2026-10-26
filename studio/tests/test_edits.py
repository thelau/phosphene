import edits


def test_create_update_rename_delete_restore():
    st = {}
    r = edits.act(st, {"action": "create", "name": "  Night   strobe ", "group": "g:1", "settings": {"bpmInput": "140", "followCuts": True}})
    assert r["ok"] and r["edit"]["name"] == "Night strobe" and r["edit"]["group"] == "g:1"
    eid = r["edit"]["id"]
    assert not edits.act(st, {"action": "create", "name": "night STROBE"})["ok"], "names are unique, whatever the case"
    assert not edits.act(st, {"action": "create", "name": "  "})["ok"]
    assert edits.act(st, {"action": "update", "id": eid, "group": "all", "settings": {"bpmInput": "90"}})["ok"]
    assert edits.public(st) == [{"id": eid, "name": "Night strobe", "group": "all", "settings": {"bpmInput": "90"}}]
    assert edits.act(st, {"action": "rename", "id": eid, "name": "Slow"})["ok"]
    gone = edits.act(st, {"action": "delete", "id": eid})
    assert gone["ok"] and edits.public(st) == []
    assert edits.act(st, {"action": "restore", "edit": gone["edit"]})["ok"]
    assert edits.public(st)[0]["name"] == "Slow"
    assert not edits.act(st, {"action": "update", "id": "nope"})["ok"]


def test_settings_keep_only_plain_values():
    st = {}
    r = edits.act(st, {"action": "create", "name": "x", "settings": {"a": "1", "b": 2, "c": True, "d": {"nested": 1}, "e": [1], "k" * 50: "long key"}})
    assert r["edit"]["settings"] == {"a": "1", "b": 2, "c": True}
    assert edits.act(st, {"action": "create", "name": "y", "settings": "not a dict"})["edit"]["settings"] == {}
