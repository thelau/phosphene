import pytest

import sequences as sq


def st_with(order=("a", "b", "c", "d")):
    return sq.ensure({"order": list(order)})


def with_ai(st, order=("d", "c", "b", "a"), **kw):
    return sq.add_ai(st, list(order), **kw)


def test_ensure_migrates_the_old_order_into_the_manual_order():
    st = st_with()
    assert len(st["sequences"]) == 1 and "order" not in st
    s = sq.active(st)
    assert (s["name"], s["kind"], s["order"]) == ("Manual", "manual", ["a", "b", "c", "d"])


def test_ensure_is_idempotent_and_repairs_a_missing_active_id():
    st = st_with()
    ids = [s["id"] for s in st["sequences"]]
    sq.ensure(st)
    assert [s["id"] for s in st["sequences"]] == ids
    st["active_sequence"] = "gone"
    sq.ensure(st)
    assert st["active_sequence"] == ids[0]


def test_an_old_save_with_many_orders_is_reduced_to_one_manual_and_the_latest_ai():
    st = {"sequences": [
        {"id": "s1", "name": "Manual 1", "kind": "manual", "order": ["a", "b"]},
        {"id": "s2", "name": "AI 1", "kind": "ai", "order": ["b", "a"]},
        {"id": "s3", "name": "Manual 2 (from AI 1)", "kind": "manual", "order": ["a"]},
        {"id": "s4", "name": "AI 2", "kind": "ai", "order": ["a", "b"]},
    ], "active_sequence": "s3"}
    sq.ensure(st)
    assert [(s["id"], s["name"], s["kind"]) for s in st["sequences"]] == [("s1", "Manual", "manual"), ("s4", "AI", "ai")]
    assert st["active_sequence"] == "s1"                                  # the active one was dropped: back to Manual
    assert st["sequences"][1]["original"] == ["a", "b"]


def test_there_is_always_exactly_one_manual_and_at_most_one_ai():
    st = st_with()
    first = with_ai(st, summary="one")
    second = with_ai(st, ["a", "b", "c", "d"], summary="two")
    assert [s["kind"] for s in st["sequences"]] == ["manual", "ai"]
    assert st["sequences"][1]["id"] == second["id"] and second["summary"] == "two" and first["id"] != second["id"]
    assert st["active_sequence"] == second["id"]
    assert sq.manual(st)["order"] == ["a", "b", "c", "d"]                 # redoing the AI never touches Manual


def test_dragging_edits_the_order_you_are_looking_at_in_place():
    st = st_with()
    sq.reorder_active(st, ["d", "c", "b", "a"])
    assert sq.get_order(st) == ["d", "c", "b", "a"] and len(st["sequences"]) == 1
    ai = with_ai(st, ["b", "d", "a", "c"])
    sq.reorder_active(st, ["a", "b", "c", "d"])
    assert sq.find(st, ai["id"])["order"] == ["a", "b", "c", "d"] and len(st["sequences"]) == 2
    assert sq.manual(st)["order"] == ["d", "c", "b", "a"]                 # the other order is untouched


def test_editing_the_ai_order_does_not_lose_the_original_and_reset_restores_it():
    st = st_with()
    ai = with_ai(st, ["b", "d", "a", "c"])
    assert sq.is_edited(ai) is False
    sq.reorder_active(st, ["c", "a", "d", "b"])
    assert sq.is_edited(ai) is True and ai["original"] == ["b", "d", "a", "c"]
    assert sq.reset_ai(st) is True
    assert ai["order"] == ["b", "d", "a", "c"] and sq.is_edited(ai) is False
    assert sq.reset_ai(st_with()) is False                                # no AI order: nothing to reset


def test_reorder_never_loses_images_the_client_did_not_send():
    st = st_with()
    sq.reorder_active(st, ["c", "a"])
    assert sq.get_order(st) == ["c", "a", "b", "d"]
    sq.reorder_active(st, ["a", "a", "b"])
    assert sq.get_order(st) == ["a", "b", "c", "d"]


def test_switching_keeps_both_orders_exactly():
    st = st_with()
    manual = st["active_sequence"]
    sq.reorder_active(st, ["d", "c", "b", "a"])
    ai = with_ai(st, ["b", "d", "a", "c"])
    assert sq.get_order(st) == ["b", "d", "a", "c"]
    assert sq.activate(st, manual) and sq.get_order(st) == ["d", "c", "b", "a"]
    assert sq.activate(st, ai["id"]) and sq.get_order(st) == ["b", "d", "a", "c"]
    assert sq.activate(st, "nope") is False and st["active_sequence"] == ai["id"]


def test_new_images_are_appended_to_both_orders_and_to_the_ai_original():
    st = st_with()
    ai = with_ai(st)
    sq.append_everywhere(st, "z")
    sq.append_everywhere(st, "z")
    assert all(s["order"][-1] == "z" and s["order"].count("z") == 1 for s in st["sequences"])
    assert ai["original"][-1] == "z"                                       # so "back to the AI's order" still contains it


def test_restored_images_go_to_the_end_of_both_orders():
    st = st_with()
    ai = with_ai(st, ["c", "a", "d", "b"])
    sq.move_to_end_everywhere(st, ["a"], universe=["a", "b", "c", "d", "e"])
    assert sq.manual(st)["order"] == ["b", "c", "d", "e", "a"]            # unseen "e" is added first, restored "a" last
    assert ai["order"] == ["c", "d", "b", "e", "a"]
    assert ai["original"][-1] == "a"                                       # resetting the AI keeps the restored image last too


def test_restoring_several_images_keeps_their_relative_order():
    st = st_with(["a", "b", "c", "d", "e"])
    sq.move_to_end_everywhere(st, ["b", "d"], universe="abcde")
    assert sq.get_order(st) == ["a", "c", "e", "b", "d"]


def test_purged_images_leave_both_orders_and_the_original():
    st = st_with()
    ai = with_ai(st)
    sq.remove_everywhere(st, ["b", "c"])
    assert sq.manual(st)["order"] == ["a", "d"] and ai["order"] == ["d", "a"] and ai["original"] == ["d", "a"]


def test_public_view_counts_visible_images_and_flags_edits():
    st = st_with()
    ai = with_ai(st, summary="x", cut_off=2)
    view = sq.public(st, visible={"a", "b"})
    assert [(v["name"], v["kind"], v["count"]) for v in view] == [("Manual", "manual", 2), ("AI", "ai", 2)]
    assert view[1]["summary"] == "x" and view[1]["cut_off"] == 2 and view[1]["edited"] is False
    sq.reorder_active(st, ["c", "d", "a", "b"])
    assert sq.public(st)[1]["edited"] is True


def test_edit_files_cuts_at_cut_off():
    st = st_with()
    assert sq.edit_files(["a", "b", "c"], st) == ["a", "b", "c"]
    with_ai(st, cut_off=2)
    assert sq.edit_files(["a", "b", "c"], st) == ["a", "b"]


def test_legacy_state_without_sequences_still_reorders():
    st = {"order": ["a", "b"]}
    assert sq.get_order(st) == ["a", "b"]
    sq.reorder_active(st, ["b", "a"])
    assert st["order"] == ["b", "a"]
    sq.append_everywhere(st, "c")
    assert st["order"] == ["b", "a", "c"]
