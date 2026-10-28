import json
import random

import pytest
from PIL import Image, ImageDraw

import editor as E
import features as F
import sequences as sq


def img(path, bg, shape=None, shape_color=(255, 255, 255), size=(108, 192)):
    im = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(im)
    if shape == "circle":
        d.ellipse((38, 74, 70, 118), outline=shape_color, width=5)
    elif shape == "bar":
        d.rectangle((20, 90, 88, 100), fill=shape_color)
    im.save(path, "JPEG", quality=95)
    return path


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(F, "CACHE_FILE", tmp_path / "f.json")
    monkeypatch.setattr(F, "_CACHE", {})
    monkeypatch.setattr(F, "_DIRTY", False)


# ---------- measurements ----------

def test_features_dark_vs_light_and_saturation(tmp_path):
    dark = F.measure(img(tmp_path / "d.jpg", (10, 10, 12)))
    light = F.measure(img(tmp_path / "l.jpg", (240, 240, 238)))
    red = F.measure(img(tmp_path / "r.jpg", (220, 20, 20)))
    assert dark["lum"] < 0.1 and light["lum"] > 0.9
    assert red["sat"] > 0.7 and dark["sat"] < 0.3
    assert dark["hue"] is None or dark["sat"] < 0.3


def test_features_hue_is_found_for_coloured_images_and_not_for_grey(tmp_path):
    blue = F.measure(img(tmp_path / "b.jpg", (20, 40, 230)))
    grey = F.measure(img(tmp_path / "g.jpg", (128, 128, 128)))
    assert 200 < blue["hue"] < 270
    assert grey["hue"] is None


def test_features_edges_and_contrast_grow_with_detail(tmp_path):
    flat = F.measure(img(tmp_path / "f.jpg", (90, 90, 90)))
    busy = img(tmp_path / "b.jpg", (0, 0, 0))
    im = Image.open(busy)
    d = ImageDraw.Draw(im)
    for x in range(0, 108, 6):
        d.line((x, 0, x, 192), fill=(255, 255, 255))
    im.save(busy, "JPEG", quality=95)
    b = F.measure(busy)
    assert b["edges"] > flat["edges"] + 0.2 and b["contrast"] > flat["contrast"] + 0.3


def test_hue_gap_wraps_and_handles_missing():
    assert F.hue_gap(350, 10) == 20 and F.hue_gap(0, 180) == 180 and F.hue_gap(None, 10) == 90.0


def test_shape_echo_matches_same_shape_even_when_inverted(tmp_path):
    a = F.measure(img(tmp_path / "a.jpg", (10, 10, 10), "circle"))
    b = F.measure(img(tmp_path / "b.jpg", (245, 245, 245), "circle", (0, 0, 0)))     # same circle, dark on light
    c = F.measure(img(tmp_path / "c.jpg", (10, 10, 10), "bar"))
    assert F.shape_echo(a, b) > 0.8
    assert F.shape_echo(a, b) > F.shape_echo(a, c)


def test_features_are_cached_by_name_and_size(tmp_path):
    p = img(tmp_path / "a.jpg", (30, 30, 30))
    first = F.get(p)
    assert F.get(p) is first
    assert F._DIRTY is True
    F.save_cache()
    assert F.CACHE_FILE.exists() and F._DIRTY is False
    F.save_cache()                                       # nothing new: no rewrite needed


# ---------- kinds of cut ----------

def fake(lum=0.5, hue=None, centre=None, sat=0.5, contrast=0.5, edges=0.5):
    rnd = random.Random(int(lum * 1000) + (0 if hue is None else int(hue)))
    c = centre or [rnd.uniform(-1.5, 1.5) for _ in range(144)]
    return {"lum": lum, "hue": hue, "contrast": contrast, "sat": sat, "edges": edges, "centre": c}


def norm(v):
    m = sum(v) / len(v)
    sd = (sum((x - m) ** 2 for x in v) / len(v)) ** 0.5
    return [(x - m) / sd for x in v]


def test_cut_kinds():
    assert E.cut_kind(fake(0.1), fake(0.8)) == "flip"
    same_shape = norm([1.0 if i % 7 == 0 else -0.2 for i in range(144)])
    assert E.cut_kind(fake(0.5, centre=same_shape), fake(0.55, centre=same_shape)) == "echo"
    other = norm([(-1) ** i * 0.9 + (i % 5) for i in range(144)])
    assert E.cut_kind(fake(0.5, 30, other), fake(0.52, 40, norm([(-1) ** (i // 2) * 0.9 + (i % 3) for i in range(144)]))) in ("hue", "echo")
    assert E.cut_kind(fake(0.5, 30, other), fake(0.52, 200, norm([((i * 7) % 5) - 2 + (i % 11) * 0.3 for i in range(144)]))) == "cut"


def test_describe_cut_reads_like_an_editor():
    assert E.describe_cut(fake(0.1), fake(0.9), "flip") == "dark → light flip"
    assert E.describe_cut(fake(0.9), fake(0.1), "flip") == "light → dark flip"
    assert "colour hand-off (orange → orange)" == E.describe_cut(fake(0.5, 30), fake(0.5, 32), "hue")
    assert E.describe_cut(fake(), fake(), "cut") == "fresh angle"
    assert E.hue_name(None) == "neutral" and E.hue_name(250) == "blue" and E.hue_name(355) == "red"


def test_energy_arc_hooks_dips_peaks_and_lands():
    assert E.energy_target(0) > E.energy_target(0.14)                       # hook then settle
    assert E.energy_target(0.72) == max(E.energy_target(t / 100) for t in range(101))
    assert E.energy_target(1.0) < E.energy_target(0.72)                      # lands lower than the peak


# ---------- ordering ----------

def lib(n=14, seed=3):
    rnd = random.Random(seed)
    items = []
    for i in range(n):
        items.append({"name": f"{i:02d}.jpg", "world": f"W{i % 3}", "f": fake(lum=rnd.random(), hue=rnd.choice([None, 20, 90, 210, 300]), sat=rnd.random(),
                                                                          contrast=rnd.random(), edges=rnd.random(), centre=[rnd.uniform(-2, 2) for _ in range(144)])})
    return items


def test_order_uses_every_image_exactly_once():
    items = lib(30)
    r = E.order_images(items)
    assert sorted(r["names"]) == sorted(it["name"] for it in items) and r["left_out"] == []
    assert len(r["cuts"]) == len(r["names"]) - 1
    assert all(c["from"] == a and c["to"] == b for c, a, b in zip(r["cuts"], r["names"], r["names"][1:]))


def test_order_is_deterministic():
    items = lib(30)
    assert E.order_images(items)["names"] == E.order_images(items)["names"]


def test_the_briefs_opener_and_closer_are_used():
    items = lib(20)
    r = E.order_images(items, {"opener": "07.jpg", "closer": "13.jpg"})
    assert r["names"][0] == "07.jpg" and r["names"][-1] == "13.jpg"


def test_unknown_opener_or_closer_names_are_ignored():
    items = lib(10)
    r = E.order_images(items, {"opener": "nope.jpg", "closer": "nada.jpg"})
    assert len(r["names"]) == 10 and r["names"][0] != "nope.jpg"


def test_without_a_brief_the_strongest_image_opens():
    items = lib(20)
    best = max(items, key=lambda it: F.impact(it["f"]))["name"]
    assert E.order_images(items)["names"][0] == best


def test_dark_light_alternation_is_favoured_over_random_order():
    items = lib(30)
    r = E.order_images(items)
    flips_ordered = sum(c["kind"] == "flip" for c in r["cuts"])
    shuffled = items[:]
    random.Random(1).shuffle(shuffled)
    flips_random = sum(E.cut_kind(a["f"], b["f"]) == "flip" for a, b in zip(shuffled, shuffled[1:]))
    assert flips_ordered > flips_random


def test_same_territory_does_not_sit_together_when_it_can_be_avoided():
    items = lib(24)
    for it in items:
        it["f"]["lum"] = 0.5                                     # take brightness out so territory is what decides
    r = E.order_images(items, {"weights": {"variety": 2, "flip": 0, "echo": 0, "hue": 0}})
    world = {it["name"]: it["world"] for it in items}
    same = sum(world[a] == world[b] for a, b in zip(r["names"], r["names"][1:]))
    assert same <= 2


def test_best_n_picks_a_diverse_subset_with_the_opener_and_closer_and_lists_the_rest():
    items = lib(30)
    r = E.order_images(items, {"opener": "03.jpg", "closer": "20.jpg"}, length=10)
    assert len(r["names"]) == 10 and len(r["left_out"]) == 20
    assert r["names"][0] == "03.jpg" and r["names"][-1] == "20.jpg"
    assert set(r["names"]) | set(r["left_out"]) == {it["name"] for it in items}
    assert not set(r["names"]) & set(r["left_out"])


def test_subset_is_more_varied_than_the_first_n():
    items = lib(30)
    picked = E.pick_subset(items, 8, [0])
    spread = lambda idx: sum(abs(items[a]["f"]["lum"] - items[b]["f"]["lum"]) for a in idx for b in idx)
    assert spread(picked) > spread(list(range(8))) * 0.9


def test_tiny_inputs_do_not_crash():
    assert E.order_images([])["names"] == []
    one = E.order_images(lib(1))
    assert one["names"] == ["00.jpg"] and one["cuts"] == []
    two = E.order_images(lib(2))
    assert sorted(two["names"]) == ["00.jpg", "01.jpg"] and len(two["cuts"]) == 1


def test_peaks_from_the_brief_land_in_the_build():
    items = lib(40)
    r = E.order_images(items, {"peaks": ["10.jpg", "20.jpg", "30.jpg"]})
    pos = {n: i / (len(r["names"]) - 1) for i, n in enumerate(r["names"])}
    assert sum(0.4 <= pos[p] <= 0.95 for p in ("10.jpg", "20.jpg", "30.jpg")) >= 2


def test_no_image_is_followed_by_a_twin_of_itself_when_alternatives_exist():
    items = lib(12)
    items[1]["f"] = dict(items[0]["f"])                               # a duplicate
    r = E.order_images(items)
    a, b = r["names"].index("00.jpg"), r["names"].index("01.jpg")
    assert abs(a - b) != 1


def test_summary_mentions_opener_closer_and_counts():
    items = lib(10)
    r = E.order_images(items)
    text = E.summarize({}, r, "A slow build.")
    assert text.startswith("A slow build.") and r["names"][0] in text and r["names"][-1] in text and "flips" in text
    assert E.summarize({}, {"names": [], "cuts": []}) == ""


# ---------- the brief from Kimi ----------

def test_contact_sheet_is_a_numbered_jpeg(tmp_path):
    paths = [img(tmp_path / f"{i}.jpg", (i * 20, 20, 20)) for i in range(5)]
    data = E.contact_sheet(paths, cols=3)
    assert data[:2] == b"\xff\xd8"
    from io import BytesIO
    assert Image.open(BytesIO(data)).size[0] == 3 * max(70, min(150, 1800 // 3))


def test_ask_brief_parses_noisy_replies_and_sends_the_sheet():
    seen = {}

    def llm(ask, key, model, images=None, system=None):
        seen.update(ask=ask, images=images, system=system)
        return "Sure!\n```json\n" + json.dumps({"opener": 3, "closer": 9, "peaks": [4, 5], "weights": {"flip": 1.5}, "summary": "Hook then build."}) + "\n```"
    out = E.ask_brief(llm, "k", "m", b"JPEG", 12, "end on the container", 6)
    assert out["opener"] == 3
    assert "end on the container" in seen["ask"] and "best 6" in seen["ask"] and seen["images"] == [b"JPEG"] and "offline editor" in seen["system"]


def test_brief_numbers_become_names_and_bad_values_are_dropped():
    names = [f"{i}.jpg" for i in range(5)]
    out = E.brief_to_names({"opener": 1, "closer": 99, "peaks": [2, "x", -1, 3], "weights": {"flip": 5, "echo": "no", "bogus": 1}, "summary": "s"}, names)
    assert out["opener"] == "1.jpg" and out["closer"] is None and out["peaks"] == ["2.jpg", "3.jpg"]
    assert out["weights"] == {"flip": 2.0} and out["summary"] == "s"
    assert E.brief_to_names({}, names)["peaks"] == []


# ---------- the server job pieces ----------

def build_state(srv, make_plate, n=8):
    for i in range(n):
        make_plate(srv.PLATES_DIR / f"{20 + i}_p{i}.jpg", (i * 30, 40, 220 - i * 25))
    st = srv.load_state()
    st["worlds"] = {f"{20 + i}_p{i}.jpg": f"W{i % 2}" for i in range(n)}
    return st


def test_build_ai_order_uses_the_brief_and_reports_progress(srv, make_plate):
    st = build_state(srv, make_plate)
    steps = []

    def llm(ask, key, model, images=None, system=None):
        return json.dumps({"opener": 2, "closer": 5, "peaks": [3], "weights": {"flip": 1.2}, "summary": "Hook, build, land."})
    built = srv.build_ai_order(st, llm, "k", "m", None, "", lambda step, note="": steps.append(step))
    r = built["result"]
    assert r["names"][0] == "22_p2.jpg" and r["names"][-1] == "25_p5.jpg" and len(r["names"]) == 8
    assert built["summary"].startswith("Hook, build, land.")
    assert steps == [0, 1, 2, 3]


def test_build_ai_order_survives_a_kimi_failure(srv, make_plate):
    st = build_state(srv, make_plate)

    def llm(*a, **k):
        raise RuntimeError("timeout")
    built = srv.build_ai_order(st, llm, "k", "m")
    assert len(built["result"]["names"]) == 8 and built["summary"].startswith("Kimi was unavailable")


def test_build_ai_order_ignores_trashed_images_and_needs_two(srv, make_plate):
    st = build_state(srv, make_plate, n=4)
    st["trashed"] = ["20_p0.jpg", "21_p1.jpg", "22_p2.jpg"]
    with pytest.raises(RuntimeError, match="at least two"):
        srv.build_ai_order(st, lambda *a, **k: "{}", "k", "m")
    st["trashed"] = ["20_p0.jpg"]
    built = srv.build_ai_order(st, lambda *a, **k: "{}", "k", "m")
    assert "20_p0.jpg" not in built["result"]["names"]


def test_add_ai_sequence_keeps_the_manual_order_and_trashed_slots(srv, make_plate):
    st = build_state(srv, make_plate)
    manual = st["active_sequence"]
    st["trashed"] = ["27_p7.jpg"]
    sq.reorder_active(st, [f"{20 + i}_p{i}.jpg" for i in range(8)])
    built = srv.build_ai_order(st, lambda *a, **k: "{}", "k", "m")
    seq = srv.add_ai_sequence(st, built)
    assert seq["kind"] == "ai" and st["active_sequence"] == seq["id"] and seq["cut_off"] is None
    assert seq["order"][:7] == built["result"]["names"] and seq["order"][-1] == "27_p7.jpg"       # trashed keeps a slot at the end
    assert sq.find(st, manual)["order"] == [f"{20 + i}_p{i}.jpg" for i in range(8)]                   # the manual order is untouched
    assert len(seq["cuts"]) == 6 and seq["original"] == seq["order"]


def test_redoing_the_ai_replaces_the_ai_order_only(srv, make_plate):
    st = build_state(srv, make_plate)
    first = srv.add_ai_sequence(st, srv.build_ai_order(st, lambda *a, **k: "{}", "k", "m"))
    again = srv.add_ai_sequence(st, srv.build_ai_order(st, lambda *a, **k: "{}", "k", "m", 3))
    assert [s["kind"] for s in st["sequences"]] == ["manual", "ai"] and st["sequences"][1]["id"] == again["id"] != first["id"]
    assert again["cut_off"] == 3


def test_best_n_marks_the_cut_off_and_the_export_follows_it(srv, make_plate):
    st = build_state(srv, make_plate, n=10)
    built = srv.build_ai_order(st, lambda *a, **k: "{}", "k", "m", 4)
    seq = srv.add_ai_sequence(st, built)
    assert seq["cut_off"] == 4 and len(seq["order"]) == 10
    shown = [p for p in srv.ordered_plate_files(st) if p.name not in set(st["trashed"])]
    edit = sq.edit_files(shown, st)
    assert [p.name for p in edit] == seq["order"][:4]
    assert len(shown) == 10


def test_dragging_in_an_ai_best_n_edit_keeps_the_cut_off_and_can_be_reset(srv, make_plate):
    st = build_state(srv, make_plate, n=10)
    seq = srv.add_ai_sequence(st, srv.build_ai_order(st, lambda *a, **k: "{}", "k", "m", 4))
    original = list(seq["order"])
    sq.reorder_active(st, list(reversed(seq["order"])))
    assert seq["cut_off"] == 4 and seq["order"] != original and sq.is_edited(seq)
    sq.reset_ai(st)
    assert seq["order"] == original


# ---------- the lock while the AI works ----------

def test_the_server_refuses_changes_while_an_ai_order_runs(srv):
    assert not srv.ai_busy()
    srv.AI_JOBS["j1"] = {"done": False}
    try:
        assert srv.ai_busy()
        for path in ("/api/trash", "/api/reorder", "/api/purge", "/api/sequence", "/api/generate-image", "/api/invent-prompts", "/api/export-video"):
            assert path in srv.LOCKED_DURING_AI
        for path in ("/api/save-settings", "/api/order-ai", "/api/krea-auth"):
            assert path not in srv.LOCKED_DURING_AI
    finally:
        srv.AI_JOBS["j1"]["done"] = True
    assert not srv.ai_busy()
    srv.AI_JOBS.clear()


def test_public_sequences_expose_the_cut_off(srv):
    st = srv.load_state()
    sq.add_ai(st, ["a", "b", "c"], cut_off=2)
    assert sq.public(st)[-1]["cut_off"] == 2


def test_summary_is_cut_at_a_word_never_mid_word():
    long = "Open on the human face to hook instantly, settle through quiet geometric marks, then build via hard dark/light flips and centre-matched echoes into neon and cosmic swirl peaks before landing on the aerial crack burst that closes the film in silence."
    out = E.tidy(long, 120)
    assert out.endswith("…") and len(out) <= 121 and not out[:-1].endswith(" ")
    assert long.startswith(out[:-1])
    assert E.tidy("Short and sweet.") == "Short and sweet."
    assert E.tidy("  ") is None and E.tidy(None) is None
    assert E.tidy("a   b\n c") == "a b c"


def test_the_ai_order_of_one_of_your_groups_is_its_own_and_moves_nothing_else(srv):
    import sequences
    st = {"groups": [{"id": "g1", "name": "Night", "files": ["b", "d", "e"]}], "sequences": []}
    sequences.add_ai(st, ["a", "b", "c", "d", "e"])
    before = sequences.get_order(st)
    assert before == ["a", "b", "c", "d", "e"]
    built = {"result": {"names": ["e", "b"], "left_out": ["d"], "cuts": []}, "summary": "opens on e"}
    seq = srv.set_group_order(st, built, "g1")
    assert st["groups"][0]["files"] == ["e", "b", "d"] and seq["summary"] == "opens on e"
    assert sequences.get_order(st) == before, "All's order does not move"
