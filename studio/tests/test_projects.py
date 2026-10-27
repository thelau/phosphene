"""Projects: one per brand mark. A new project keeps its mark, guides, plates and curation in its own folder; DEMO stays as it was."""

import io

import pytest
from PIL import Image, ImageDraw

import projects
import qa_engine


def star_png(size=(200, 120), fill=(240, 60, 20, 255)) -> bytes:
    """A wide, lopsided mark on a transparent background (a wordmark-like shape, not a circle)."""
    im = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle((10, 30, 120, 90), fill=fill)
    d.polygon([(130, 10), (190, 60), (130, 110)], fill=fill)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def pdir(tmp_path, monkeypatch):
    monkeypatch.setattr(projects, "PROJECTS_DIR", tmp_path / "projects")
    monkeypatch.setattr(projects, "LOCAL_FILE", tmp_path / ".local.json")
    import shutil
    from pathlib import Path
    shutil.copytree(Path(projects.__file__).resolve().parent.parent / "projects" / "demo", tmp_path / "projects" / "demo")
    return tmp_path / "projects"


def test_cos_is_a_project_with_its_old_places(pdir):
    p = projects.load("demo")
    assert p["name"] == "Demo" and p["mark_size"] == 18 and (p["mark_x"], p["mark_y"]) == (50, 50)
    assert p["plates_dir"] == projects.ROOT_DIR / "assets" / "ai-plates" and p["state_file"] == projects.ROOT_DIR / "studio" / "curation_state.json"
    assert p["mark_file"].is_file() and p["guides"]["dark"].is_file()
    assert projects.active_slug() == "demo", "the default, before anything was chosen"
    assert [x["slug"] for x in projects.all_projects()] == ["demo"]


def test_a_new_project_gets_its_folder_mark_and_guides_with_the_mark_at_its_size_and_place(pdir):
    p = projects.create({"name": "Night Owl", "mark_size": 30, "mark_x": 50, "mark_y": 40, "palette": ["#112233", "nope", "#abc"], "brief": "Night Owl, a bar"}, star_png())
    assert p["slug"] == "night-owl" and (pdir / "night-owl" / "mark.png").is_file() and p["plates_dir"] == pdir / "night-owl" / "plates"
    assert p["palette"] == ["#112233", "#AABBCC"], "bad colours dropped, short ones made long"
    left, top, w, h = projects.mark_box(p)
    assert w == 324 and abs(h - round(324 * 101 / 181)) <= 1, "30% of 1080, the mark's own proportions (trimmed to its shape)"
    assert (left + w // 2, top + h // 2) == (540, 768), "centred 40% down"
    dark = Image.open(p["guides"]["dark"]).convert("RGB")
    assert dark.size == (1080, 1920) and dark.getpixel((540, 1500)) == (0x14, 0x14, 0x16), "near-black around it"
    assert dark.getpixel((left + 30, top + h // 2)) == (0xFE, 0xFF, 0xE7), "the mark in cream"
    light = Image.open(p["guides"]["light"]).convert("RGB")
    assert light.getpixel((540, 1500)) == (0xFE, 0xFF, 0xE7) and light.getpixel((left + 30, top + h // 2)) == (0x14, 0x14, 0x16)
    assert projects.create({"name": "Night Owl"}, star_png())["slug"] == "night-owl-2", "names can repeat, folders cannot"
    with pytest.raises(ValueError):
        projects.create({"name": ""}, star_png())
    with pytest.raises(ValueError):
        projects.create({"name": "Blank"}, Image.new("RGBA", (10, 10)).tobytes())
    blank = io.BytesIO(); Image.new("RGBA", (40, 40), (0, 0, 0, 0)).save(blank, "PNG")
    with pytest.raises(ValueError, match="empty"):
        projects.create({"name": "Empty"}, blank.getvalue())
    assert not (pdir / "empty").exists() and not (pdir / "blank").exists(), "a refused project leaves nothing behind"


def test_an_opaque_mark_is_read_from_its_background(pdir):
    im = Image.new("RGB", (100, 100), "white")
    ImageDraw.Draw(im).ellipse((20, 30, 80, 70), fill="black")
    a = projects.mark_alpha(im)
    assert a.size == (61, 41), "trimmed to the dark shape on white"


def test_changing_the_size_remakes_the_guides_and_forgets_krea_copies_cos_keeps_its_mark(pdir):
    p = projects.create({"name": "Owl"}, star_png())
    p["guide_cache_file"].write_text('{"dark:1": {"url": "x"}}')
    before = p["guides"]["dark"].read_bytes()
    p = projects.update("owl", {"mark_size": 12, "brief": "  a   bar  "})
    assert p["mark_size"] == 12 and p["brief"] == "a bar"
    assert p["guides"]["dark"].read_bytes() != before and not p["guide_cache_file"].exists()
    assert projects.update("owl", {"mark_size": 999})["mark_size"] == 60, "kept inside what makes sense"
    with pytest.raises(ValueError):
        projects.update("demo", {}, star_png())
    demo = projects.update("demo", {"name": "DEMO", "brief": "Demo, a toolkit", "mark_size": 30, "mark_shape": "square", "palette": ["#111111"]})
    assert (demo["name"], demo["brief"], demo["palette"]) == ("DEMO", "Demo, a toolkit", ["#111111"])
    assert (demo["mark_size"], demo["mark_shape"]) == (18, "circular orbital logo"), "DEMO keeps its size and the words of its prompt sentence"
    with pytest.raises(FileNotFoundError):
        projects.load("../etc")


def test_switching_is_remembered_and_an_unknown_one_falls_back_to_cos(pdir):
    projects.create({"name": "Owl"}, star_png())
    projects.set_active("owl")
    assert projects.active_slug() == "owl"
    projects.LOCAL_FILE.write_text('{"project": "gone"}')
    assert projects.active_slug() == "demo"


def test_rebrand_turns_cos_colours_into_the_project_palette_and_leaves_cos_alone(pdir):
    demo = projects.load("demo")
    text = "warm cream (#FEFFE7) and burnt orange (#EC540C); oxblood #381313"
    assert projects.rebrand(text, demo) == text
    p = projects.create({"name": "Owl", "palette": ["#112233", "#445566"]}, star_png())
    assert projects.rebrand(text, p) == "brand colour #445566 and brand colour #112233; brand colour #445566"
    bare = projects.create({"name": "Bare"}, star_png())
    assert projects.rebrand(text, bare) == "one brand colour and one brand colour; one brand colour"


def test_the_logo_check_finds_a_projects_own_mark_where_it_should_be(pdir, tmp_path):
    p = projects.create({"name": "Owl", "mark_size": 25, "mark_y": 45}, star_png())
    spec = qa_engine.mark_spec(p["mark_file"], p["mark_size"], p["mark_x"], p["mark_y"])
    left, top, w, h = projects.mark_box(p)
    mark = projects.mark_alpha(Image.open(p["mark_file"])).resize((w, h))

    def plate(name, at):
        im = Image.new("RGB", (1080, 1920), (30, 40, 60))
        im.paste(Image.new("RGB", (w, h), (250, 240, 220)), at, mark)
        path = tmp_path / name
        im.save(path, "JPEG", quality=95)
        return path
    good = qa_engine.evaluate_plate_qa(plate("good.jpg", (left, top)), spec)
    assert good["qa_passed"] and good["center_corr"] > 0.6, good
    moved = qa_engine.evaluate_plate_qa(plate("moved.jpg", (left, top + 500)), spec)
    assert not moved["qa_passed"], moved
    as_demo = qa_engine.evaluate_plate_qa(tmp_path / "good.jpg")
    assert not as_demo["qa_passed"], "DEMO's check does not take another mark for its own"


def test_export_then_import_brings_the_project_back_as_it_was_and_never_carries_the_kimi_key(pdir, tmp_path):
    import json, zipfile
    p = projects.create({"name": "Night Owl", "mark_size": 22, "palette": ["#112233"]}, star_png())
    for i in range(3):
        Image.new("RGB", (54, 96), (i * 60, 20, 20)).save(p["plates_dir"] / f"{i:02d}_shot.jpg")
    state = {"order": ["02_shot.jpg", "00_shot.jpg", "01_shot.jpg"], "trashed": ["01_shot.jpg"], "groups": [{"id": "g1", "name": "Red", "files": ["02_shot.jpg"]}],
             "edits": [{"id": "e1", "name": "Feral Ember"}], "kimi_api_key": "sk-secret"}
    p["state_file"].write_text(json.dumps(state))
    (p["plates_dir"].parent / ".qa_cache.json").write_text(json.dumps({"00_shot.jpg:123:3:22:50:50": {"qa_passed": True}, "gone.jpg:9": {"qa_passed": False}}))
    out = tmp_path / "x.zip"
    assert projects.export_zip("night-owl", out) == "Night Owl.phos"
    names = zipfile.ZipFile(out).namelist()
    assert sorted(names) == sorted(["night-owl/project.json", "night-owl/state.json", "night-owl/mark.png", "night-owl/guide_dark.png", "night-owl/guide_light.png",
                                    "night-owl/plates/00_shot.jpg", "night-owl/plates/01_shot.jpg", "night-owl/plates/02_shot.jpg", "night-owl/qa.json"]), "everything it is, and the logo check measured (no looks measured yet here)"
    assert b"sk-secret" not in out.read_bytes(), "the key never travels"
    q = projects.import_zip(out)
    assert q["slug"] == "night-owl-2" and q["name"] == "Night Owl 2" and q["mark_size"] == 22 and q["palette"] == ["#112233"], "a new project, nothing replaced; numbered as Finder numbers a copy"
    assert json.loads(q["qa_cache_file"].read_text()) == {"00_shot.jpg:123:3:22:50:50": {"qa_passed": True}}, "the logo check comes along (for its images only): an import opens at once"
    assert projects.import_zip(out)["name"] == "Night Owl 3"
    got = json.loads(q["state_file"].read_text())
    assert (got["order"], got["trashed"], got["groups"], got["edits"]) == (state["order"], state["trashed"], state["groups"], state["edits"]), "as it was"
    assert sorted(f.name for f in q["plates_dir"].iterdir()) == ["00_shot.jpg", "01_shot.jpg", "02_shot.jpg"]
    demo_out = tmp_path / "demo.zip"
    projects.export_zip("demo", demo_out)
    raw = json.loads(zipfile.ZipFile(demo_out).read("Demo/project.json"))
    assert "Demo/mark.png" in zipfile.ZipFile(demo_out).namelist() and "paths" not in raw and raw["format"] == 1, "DEMO travels with its files inside, and says its format"
    newer = tmp_path / "newer.phosphene"
    with zipfile.ZipFile(out) as src, zipfile.ZipFile(newer, "w") as dst:
        for n in src.namelist():
            dst.writestr(n, json.dumps({**json.loads(src.read(n)), "format": 99}) if n.endswith("project.json") else src.read(n))
    with pytest.raises(ValueError, match="newer Phosphene"):
        projects.import_zip(newer)


def test_import_refuses_what_is_not_a_project_and_takes_nothing_outside_its_folder(pdir, tmp_path):
    import json, zipfile
    bad = tmp_path / "bad.zip"; bad.write_bytes(b"not a zip")
    with pytest.raises(ValueError, match="not a project file"):
        projects.import_zip(bad)
    nojson = tmp_path / "n.zip"
    with zipfile.ZipFile(nojson, "w") as z:
        z.writestr("x/readme.txt", "hi")
    with pytest.raises(ValueError, match="no project.json"):
        projects.import_zip(nojson)
    sly = tmp_path / "s.zip"
    with zipfile.ZipFile(sly, "w") as z:
        z.writestr("x/project.json", json.dumps({"name": "Sly"}))
        z.writestr("x/mark.png", star_png())
        z.writestr("x/../../escape.txt", "no")
        z.writestr("x/plates/../../evil.jpg", "no")
        z.writestr("x/run.sh", "no")
    p = projects.import_zip(sly)
    assert sorted(f.name for f in (pdir / "sly").iterdir()) == ["guide_dark.png", "guide_light.png", "mark.png", "plates", "project.json"], "only a project's files"
    assert not (tmp_path / "escape.txt").exists() and not (pdir / "evil.jpg").exists()


def test_the_sample_is_copied_in_once_and_never_over_a_project(pdir, tmp_path, monkeypatch):
    import shutil
    monkeypatch.setattr(projects.places, "SUPPORT_DIR", tmp_path)
    examples = tmp_path / "examples"
    shutil.copytree(pdir / "demo", examples / "Demo")
    shutil.rmtree(pdir / "demo")
    assert projects.seed_examples(examples) == ["Demo"]
    assert (pdir / "Demo" / "project.json").is_file() and projects.active_slug() == "Demo", "Demo opens when there is no demo"
    shutil.rmtree(pdir / "Demo")
    projects.create({"name": "Owl"}, star_png())
    assert projects.seed_examples(examples) == [], "deleted later: it does not come back"
    shutil.rmtree(pdir / "owl")
    assert projects.seed_examples(examples) == ["Demo"], "with no project left at all, the sample comes back"


def test_a_marks_own_colours(pdir):
    im = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    ImageDraw.Draw(im).rectangle((0, 0, 70, 100), fill=(236, 84, 12, 255))
    ImageDraw.Draw(im).rectangle((71, 0, 100, 100), fill=(20, 20, 30, 255))
    assert projects.mark_colours(im) == ["#EC540C", "#14141E"]


def test_an_imported_curation_cannot_point_outside_its_project_and_odd_files_still_import(pdir, tmp_path):
    """Review findings: names in a received state.json could reach outside the project; a numeric name broke the project list;
    a zip re-made with Finder's Compress (__MACOSX, ._ files) was refused; a damaged zip crashed the import."""
    import json, zipfile
    f = tmp_path / "x.phosphene"
    with zipfile.ZipFile(f, "w") as z:
        z.writestr("x/project.json", json.dumps({"name": 123}))
        z.writestr("x/mark.png", star_png())
        z.writestr("x/plates/a.jpg", b"\xff\xd8 jpeg")
        z.writestr("x/state.json", json.dumps({"trashed": ["a.jpg", "../../thesis.pdf", "/Users/me/x.pdf"], "order": ["a.jpg", "../b"],
                                                "groups": [{"id": "g", "name": "G", "files": ["a.jpg", "/etc/passwd"]}], "titles": {"../x": "t", "a.jpg": "A"}}))
        z.writestr("__MACOSX/x/._project.json", b"apple double")
        z.writestr("x/._mark.png", b"apple double")
    p = projects.import_zip(f)
    st = json.loads(p["state_file"].read_text())
    assert st["trashed"] == ["a.jpg"] and st["order"] == ["a.jpg"] and st["groups"][0]["files"] == ["a.jpg"] and list(st["titles"]) == ["a.jpg"]
    assert p["name"] == "123" and [x["name"] for x in projects.all_projects()][-1] == "123", "the list works"
    broken = tmp_path / "broken.phosphene"
    data = f.read_bytes()
    broken.write_bytes(data[:len(data) // 2])
    with pytest.raises(ValueError):
        projects.import_zip(broken)


def test_a_damaged_project_never_stops_the_server_from_starting(srv, tmp_path):
    import projects as P
    P.create({"name": "Owl"}, star_png())
    P.set_active("owl")
    (P.PROJECTS_DIR / "owl" / "project.json").write_text("{ not json")
    srv.open_first_project()
    assert srv.PROJECT and srv.PROJECT["slug"] == "demo", "the next project opens instead"
    (P.PROJECTS_DIR / "demo" / "project.json").write_text("{ also broken")
    srv.open_first_project()
    assert srv.PROJECT is None, "none readable: the first screen, not a crash"


def test_delete_project_moves_its_folder_to_the_trash_and_refuses_one_whose_files_live_elsewhere(pdir, tmp_path, monkeypatch):
    import json
    monkeypatch.setattr(projects, "TRASH_DIR", tmp_path / "Trash")
    p = projects.create({"name": "Night Owl"}, star_png())
    Image.new("RGB", (54, 96)).save(p["plates_dir"] / "00_shot.jpg")
    projects.set_active("night-owl")
    dest = projects.trash("night-owl")
    assert not (pdir / "night-owl").exists() and (dest / "plates" / "00_shot.jpg").is_file() and dest.name == "Night Owl (Phosphene project)", "in the Trash, whole"
    assert json.loads(projects.LOCAL_FILE.read_text()).get("project") is None, "no longer the open one"
    projects.create({"name": "Night Owl"}, star_png())
    assert projects.trash("night-owl").name == "Night Owl (Phosphene project) 2", "never over another"
    with pytest.raises(ValueError, match="outside its folder"):
        projects.trash("demo")                        # the repository's DEMO: its plates are committed, elsewhere
