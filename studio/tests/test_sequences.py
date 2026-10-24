import pytest

import sequences as sq


def st_with(order=("a", "b", "c", "d")):
    return sq.ensure({"order": list(order)})


def test_ensure_migrates_the_old_order_into_manual_1():
    st = st_with()
    assert len(st["sequences"]) == 1 and "order" not in st
    s = sq.active(st)
    assert (s["name"], s["kind"], s["order"]) == ("Manual 1", "manual", ["a", "b", "c", "d"])


def test_ensure_is_idempotent_and_repairs_a_missing_active_id():
    st = st_with()
    before = [dict(s) for s in st["sequences"]]
    sq.ensure(st)
    assert [s["id"] for s in st["sequences"]] == [s["id"] for s in before]
    st["active_sequence"] = "gone"
    sq.ensure(st)
    assert st["active_sequence"] == st["sequences"][0]["id"]


def test_ids_and_names_are_unique_and_counted_per_kind():
    st = st_with()
    ai = sq.add(st, "ai", ["d", "c", "b", "a"], summary="hook, build, land")
    m2 = sq.add(st, "manual", ["a"])
    ai2 = sq.add(st, "ai", ["a"])
    assert [s["name"] for s in st["sequences"]] == ["Manual 1", "AI 1", "Manual 2", "AI 2"]
    assert len({s["id"] for s in st["sequences"]}) == 4
    assert st["active_sequence"] == ai2["id"] and ai["summary"] == "hook, build, land"
    assert m2["kind"] == "manual"


def test_add_without_activating_keeps_the_current_one():
    st = st_with()
    first = st["active_sequence"]
    sq.add(st, "ai", ["a"], activate=False)
    assert st["active_sequence"] == first


def test_manual_reorder_updates_in_place():
    st = st_with()
    forked = sq.reorder_active(st, ["d", "c", "b", "a"])
    assert forked is None and len(st["sequences"]) == 1
    assert sq.get_order(st) == ["d", "c", "b", "a"]


def test_dragging_in_an_ai_sequence_forks_a_manual_copy_and_leaves_the_ai_one_alone():
    st = st_with()
    ai = sq.add(st, "ai", ["b", "a", "d", "c"])
    forked = sq.reorder_active(st, ["a", "b", "d", "c"])
    assert forked["kind"] == "manual" and forked["name"] == "Manual 2 (from AI 1)" and forked["parent"] == ai["id"]
    assert sq.find(st, ai["id"])["order"] == ["b", "a", "d", "c"]           # untouched
    assert st["active_sequence"] == forked["id"]
    assert sq.get_order(st) == ["a", "b", "d", "c"]
    again = sq.reorder_active(st, ["b", "a", "d", "c"])                      # now manual: edited in place, no second fork
    assert again is None and len(st["sequences"]) == 3


def test_reorder_never_loses_images_the_client_did_not_send():
    st = st_with()
    sq.reorder_active(st, ["c", "a"])
    assert sq.get_order(st) == ["c", "a", "b", "d"]
    sq.reorder_active(st, ["a", "a", "b"])                                  # duplicates ignored
    assert sq.get_order(st) == ["a", "b", "c", "d"]


def test_switching_keeps_both_orders_exactly():
    st = st_with()
    manual = st["active_sequence"]
    sq.reorder_active(st, ["d", "c", "b", "a"])
    ai = sq.add(st, "ai", ["b", "d", "a", "c"])
    assert sq.get_order(st) == ["b", "d", "a", "c"]
    assert sq.activate(st, manual) and sq.get_order(st) == ["d", "c", "b", "a"]
    assert sq.activate(st, ai["id"]) and sq.get_order(st) == ["b", "d", "a", "c"]
    assert sq.activate(st, "nope") is False and st["active_sequence"] == ai["id"]


def test_rename_duplicate_delete():
    st = st_with()
    sid = st["active_sequence"]
    assert sq.rename(st, sid, "  Opening cut  ") and sq.active(st)["name"] == "Opening cut"
    assert sq.rename(st, sid, "   ") is False and sq.rename(st, "nope", "x") is False
    copy = sq.duplicate(st, sid)
    assert copy["name"] == "Opening cut copy" and copy["kind"] == "manual" and copy["order"] == sq.find(st, sid)["order"]
    assert st["active_sequence"] == copy["id"]
    assert sq.delete(st, copy["id"]) and st["active_sequence"] == sid
    assert sq.delete(st, sid) is False                                     # the last one stays
    assert sq.duplicate(st, "nope") is None


def test_duplicate_is_independent_of_the_original():
    st = st_with()
    sid = st["active_sequence"]
    copy = sq.duplicate(st, sid)
    sq.reorder_active(st, ["d", "c", "b", "a"])
    assert sq.find(st, sid)["order"] == ["a", "b", "c", "d"] and copy["order"] == ["d", "c", "b", "a"]


def test_new_images_are_appended_to_every_sequence_once():
    st = st_with()
    sq.add(st, "ai", ["d", "c", "b", "a"])
    sq.append_everywhere(st, "z")
    sq.append_everywhere(st, "z")
    assert all(s["order"][-1] == "z" and s["order"].count("z") == 1 for s in st["sequences"])


def test_restored_images_go_to_the_end_of_every_sequence():
    st = st_with()
    sq.add(st, "ai", ["c", "a", "d", "b"])
    sq.move_to_end_everywhere(st, ["a"], universe=["a", "b", "c", "d", "e"])
    orders = {s["name"]: s["order"] for s in st["sequences"]}
    assert orders["Manual 1"] == ["b", "c", "d", "e", "a"]                  # unseen "e" is added first, restored "a" last
    assert orders["AI 1"] == ["c", "d", "b", "e", "a"]


def test_restoring_several_images_keeps_their_relative_order():
    st = st_with(["a", "b", "c", "d", "e"])
    sq.move_to_end_everywhere(st, ["b", "d"], universe="abcde")
    assert sq.get_order(st) == ["a", "c", "e", "b", "d"]


def test_purged_images_leave_every_sequence():
    st = st_with()
    sq.add(st, "ai", ["d", "c", "b", "a"])
    sq.remove_everywhere(st, ["b", "c"])
    assert [s["order"] for s in st["sequences"]] == [["a", "d"], ["d", "a"]]


def test_public_view_counts_only_visible_images():
    st = st_with()
    sq.add(st, "ai", ["d", "c", "b", "a"], summary="x")
    view = sq.public(st, visible={"a", "b"})
    assert [(v["name"], v["kind"], v["count"]) for v in view] == [("Manual 1", "manual", 2), ("AI 1", "ai", 2)]
    assert view[1]["summary"] == "x"


def test_legacy_state_without_sequences_still_reorders():
    st = {"order": ["a", "b"]}
    assert sq.get_order(st) == ["a", "b"]
    sq.reorder_active(st, ["b", "a"])
    assert st["order"] == ["b", "a"]
    sq.append_everywhere(st, "c")
    assert st["order"] == ["b", "a", "c"]
