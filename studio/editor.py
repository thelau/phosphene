"""
Orders the selection the way an offline editor would. Kimi writes the editing brief (hook, peak, landing, how much each kind of
cut matters); a deterministic search finds the order that best fits it, so the same input always gives the same edit.

The kinds of cut, strongest reason first:
  flip  - a clear dark <-> light change (the contrast cut that carries the rhythm)
  echo  - the shape at the centre (where the mark sits) repeats: a match cut
  hue   - the colour hands over (same family on both sides)
  cut   - nothing carries over (allowed, but not twice in a row)
Also: do not run three of one kind in a row, do not stay in one territory, no near-duplicates side by side,
and follow an energy arc: hook, settle, build, peak, land.

Where the mark is (roadmap 7, 2026-10-30): each image may say where its mark sits ({x, y, size} in % of the frame, and which mark),
or that it has none (an upload). Then the edit can move: small steps of the mark between cuts read as motion (move), steps that keep
one direction as a sweep (sweep), the end coming back to the project's place (land); two marks in one spot cut as a match (swap); the
uploads, which have no mark, are spread out (spread). These weigh nothing when every image is the main mark on target (as before).
A mark may also be turned (`rot`, degrees clockwise, 2026-10-31): a small turn between cuts reads as the mark spinning, steps that keep
turning one way as a continuous spin (turn), and the end lands upright with land. A Path batch's images follow their steps (path), and
a size that keeps growing or shrinking a little from cut to cut reads as a zoom (grow).
Two modes (the user, 2026-10-31): Look (the default) cuts on light, shape and colour as before, the motion terms weighing as above;
Motion cuts for the mark's movement first, its terms doubled and the look's damped.
"""

import io
import json
import math

from PIL import Image, ImageDraw, ImageFont

import features as F

DEFAULT_WEIGHTS = {"flip": 1.0, "echo": 1.0, "hue": 0.6, "variety": 0.8, "arc": 1.0}
MOVE_WEIGHTS = {"move": 0.6, "sweep": 0.4, "land": 0.5, "swap": 0.6, "spread": 0.8, "turn": 0.6, "path": 0.8, "grow": 0.5}   # used only when the set has what they weigh
LOOK_KEYS = ("flip", "echo", "hue", "variety")                          # what Motion mode damps
MOTION_KEYS = ("move", "sweep", "land", "turn", "path", "grow")         # and what it doubles


def mark_step(ma: dict | None, mb: dict | None) -> float | None:
    """How far the mark travels across a cut, in % of the frame (None when either image has no mark)."""
    if not ma or not mb:
        return None
    return math.hypot(mb["x"] - ma["x"], mb["y"] - ma["y"])


def move_score(d: float) -> float:
    """A visible step reads as motion; holding still is fine; a leap across the frame breaks it."""
    if d < 1:
        return 0.4
    if d <= 10:
        return 1.0
    if d <= 25:
        return 1.0 - (d - 10) / 15
    return -0.4 if d > 35 else 0.0


def turn_step(ma: dict | None, mb: dict | None) -> float | None:
    """How far the mark turns across a cut, degrees, the short way round (+ clockwise); None when either image has no mark."""
    if not ma or not mb:
        return None
    return ((mb.get("rot", 0) - ma.get("rot", 0) + 180) % 360) - 180


def turn_score(r: float) -> float:
    """A turn of 45-90 degrees reads as the mark spinning; holding its angle is fine; a half turn is a jolt."""
    r = abs(r)
    if r < 1:
        return 0.3
    if r <= 90:
        return 1.0
    return 0.2 if r < 180 else -0.3


def path_score(ma: dict | None, mb: dict | None) -> float:
    """The next step of the same Path batch reads as the mark travelling on; a step back is half that; anything else nothing."""
    pa, pb = (ma or {}).get("path"), (mb or {}).get("path")
    if not pa or not pb or pa.get("run") != pb.get("run"):
        return 0.0
    d = pb["i"] - pa["i"]
    return 1.0 if d == 1 else 0.5 if d == -1 else 0.0


def size_step(ma: dict | None, mb: dict | None) -> float | None:
    """How much the mark grows across a cut (log of the ratio of its sizes); None when either has no mark."""
    if not ma or not mb or not ma.get("size") or not mb.get("size"):
        return None
    return math.log(mb["size"] / ma["size"])


def grow_score(g: float) -> float:
    """A small change of size reads as a zoom (5-40%); the same size is fine; a jump is a jolt."""
    g = abs(g)
    if g < 0.03:
        return 0.3
    return 1.0 if g <= 0.35 else 0.2 if g <= 0.7 else -0.3


def move_words(ma: dict | None, mb: dict | None) -> str:
    d, r = mark_step(ma, mb), turn_step(ma, mb)
    said = []
    if d is not None and d >= 1:
        dx, dy = mb["x"] - ma["x"], mb["y"] - ma["y"]
        way = ("right" if dx > 0 else "left") if abs(dx) >= abs(dy) else ("down" if dy > 0 else "up")
        said.append(f"the mark moves {way} {d:.0f}%")
    if path_score(ma, mb) == 1.0:
        said.insert(0, f"step {mb['path']['i'] + 1} of its path")
    if r is not None and abs(r) >= 1:
        said.append(f"it turns {abs(r):.0f}° {'clockwise' if r > 0 else 'anticlockwise'}" if said else f"the mark turns {abs(r):.0f}° {'clockwise' if r > 0 else 'anticlockwise'}")
    return ", ".join(said)
FLIP_AT = 0.30        # brightness change that counts as a flip
ECHO_AT = 0.55        # centre similarity that counts as an echo
HUE_NEAR = 28.0       # degrees


def cut_kind(fa: dict, fb: dict) -> str:
    if abs(fa["lum"] - fb["lum"]) >= FLIP_AT:
        return "flip"
    if F.shape_echo(fa, fb) >= ECHO_AT:
        return "echo"
    if fa["hue"] is not None and fb["hue"] is not None and F.hue_gap(fa["hue"], fb["hue"]) <= HUE_NEAR:
        return "hue"
    return "cut"


def cut_score(fa: dict, fb: dict, wa: str | None, wb: str | None, w: dict) -> float:
    flip = min(1.0, abs(fa["lum"] - fb["lum"]) / 0.6)
    echo = F.shape_echo(fa, fb)
    hue = 1.0 - F.hue_gap(fa["hue"], fb["hue"]) / 180 if fa["hue"] is not None and fb["hue"] is not None else 0.4
    s = w["flip"] * flip + w["echo"] * echo + w["hue"] * 0.6 * hue
    if wa and wa == wb:
        s -= w["variety"] * 0.5
    twin = abs(fa["lum"] - fb["lum"]) < 0.04 and F.hue_gap(fa["hue"], fb["hue"]) < 14 and echo > 0.92 and abs(fa["edges"] - fb["edges"]) < 0.06
    if twin:
        s -= 1.5                                           # looks like the same picture twice
    return s


def energy_target(t: float) -> float:
    """Where the energy should be at position t in 0..1: hook, settle, build, peak, land."""
    pts = [(0.0, 0.85), (0.14, 0.5), (0.45, 0.65), (0.72, 0.95), (1.0, 0.6)]
    for (t0, e0), (t1, e1) in zip(pts, pts[1:]):
        if t <= t1:
            return e0 + (e1 - e0) * (t - t0) / (t1 - t0)
    return pts[-1][1]


def _vector(f: dict) -> list:
    h = f["hue"]
    return [f["lum"], f["contrast"], f["sat"], f["edges"], 0.0 if h is None else math.cos(math.radians(h)) * f["sat"], 0.0 if h is None else math.sin(math.radians(h)) * f["sat"]]


def pick_subset(items: list, n: int, forced: list) -> list:
    """The n most different images, always including `forced` (indices). Farthest-point sampling, deterministic."""
    chosen = list(dict.fromkeys(forced))[:n]
    vecs = [_vector(it["f"]) for it in items]
    dist = lambda a, b: sum((x - y) ** 2 for x, y in zip(vecs[a], vecs[b]))
    if not chosen:
        chosen = [max(range(len(items)), key=lambda i: F.impact(items[i]["f"]))]
    while len(chosen) < min(n, len(items)):
        best = max((i for i in range(len(items)) if i not in chosen), key=lambda i: (min(dist(i, c) for c in chosen), F.impact(items[i]["f"]), -i))
        chosen.append(best)
    return chosen


def order_images(items: list, brief: dict | None = None, length: int | None = None, beam: int = 24) -> dict:
    """
    items: [{"name", "f": features, "world"}]. brief: {opener, closer, peaks, weights} (names).
    Returns {"names": [...], "cuts": [{from, to, kind, reason}], "left_out": [...]} - `names` is the edit, `left_out` the rest.
    """
    brief = brief or {}
    if not items:
        return {"names": [], "cuts": [], "left_out": []}
    marks = [it.get("mark") for it in items]
    home = brief.get("home") or {"x": 50.0, "y": 50.0}                 # the project's place: where the edit lands
    places = {(round(m["x"], 1), round(m["y"], 1)) for m in marks if m}
    has = {"move": len(places) > 1, "sweep": len(places) > 1, "land": len(places) > 1,
           "swap": len({m.get("id") for m in marks if m}) > 1, "spread": any(m is None for m in marks) and any(marks),
           "turn": len({m.get("rot", 0) for m in marks if m}) > 1, "path": any((m or {}).get("path") for m in marks),
           "grow": len({round(m["size"], 1) for m in marks if m}) > 1}
    w = {**DEFAULT_WEIGHTS, **{k: v if has[k] else 0.0 for k, v in MOVE_WEIGHTS.items()}}
    w.update({k: float(v) for k, v in (brief.get("weights") or {}).items() if k in DEFAULT_WEIGHTS or (k in MOVE_WEIGHTS and has[k])})
    if brief.get("mode") == "motion":                                      # Motion: the mark's movement first, the look after
        w.update({k: w[k] * 0.35 for k in LOOK_KEYS})
        w.update({k: w[k] * 2.0 for k in MOTION_KEYS})
    index = {it["name"]: i for i, it in enumerate(items)}
    near_home = lambda i: marks[i] is not None and math.hypot(marks[i]["x"] - home["x"], marks[i]["y"] - home["y"]) < 1 and not marks[i].get("rot")
    by_impact = sorted(range(len(items)), key=lambda i: (-F.impact(items[i]["f"]), i))
    first, last = index.get(brief.get("opener")), index.get(brief.get("closer"))
    if brief.get("mode") == "motion" and has["path"]:                      # Motion with a Path: it opens on its first step, ends on its last
        runs: dict = {}
        for i, m in enumerate(marks):
            if m and m.get("path"):
                runs.setdefault(m["path"].get("run"), []).append(i)
        walk = sorted(max(runs.values(), key=len), key=lambda i: marks[i]["path"]["i"])
        if first is None:
            first = walk[0]
        if last is None and walk[-1] != first:
            last = walk[-1]
    if first is None:
        first = by_impact[0]
    if (last is None or last == first) and w["land"] > 0:                   # it lands: on the project's place
        last = next((i for i in by_impact if i != first and near_home(i)), None)
    if last is None or last == first:
        last = next((i for i in by_impact if i != first), None) if len(items) > 1 else None
    peaks = [index[n] for n in brief.get("peaks", []) if n in index and index[n] not in (first, last)][:4]

    pool = list(range(len(items)))
    if length and length < len(items):
        pool = pick_subset(items, max(2, length), [i for i in (first, last, *peaks) if i is not None])
    in_pool = set(pool)
    inner = [i for i in pool if i not in (first, last)]
    n = len(pool)

    fs = [it["f"] for it in items]
    worlds = [it.get("world") for it in items]
    base = {}
    kinds = {}
    for i in pool:
        for j in pool:
            if i != j:
                base[i, j] = cut_score(fs[i], fs[j], worlds[i], worlds[j], w)
                kinds[i, j] = cut_kind(fs[i], fs[j])
                d = mark_step(marks[i], marks[j])
                if d is not None:
                    base[i, j] += w["move"] * 0.6 * move_score(d)
                    if marks[i].get("id") != marks[j].get("id") and d < 3:
                        base[i, j] += w["swap"] * 0.6                    # another mark in the same spot: a match cut
                    if w["turn"]:
                        base[i, j] += w["turn"] * 0.6 * turn_score(turn_step(marks[i], marks[j]))
                    if w["path"]:
                        base[i, j] += w["path"] * 1.2 * path_score(marks[i], marks[j])   # the next step of its path
                    if w["grow"]:
                        base[i, j] += w["grow"] * 0.5 * grow_score(size_step(marks[i], marks[j]))
                elif marks[i] is None and marks[j] is None and (w["spread"] > 0):
                    base[i, j] -= w["spread"] * 0.6                      # two uploads side by side

    # beam search: state = (score, sequence, remaining set)
    ups_total = sum(1 for i in pool if marks[i] is None) if w["spread"] else 0   # the uploads, spread along the film: due by each point
    states = [(0.0, [first], frozenset(inner))]
    for step in range(1, n - (1 if last is not None else 0)):
        t = step / max(1, n - 1)
        target = energy_target(t)
        nxt = {}
        for score, seq, rest in states:
            prev = seq[-1]
            cands = sorted(rest, key=lambda j: (-base[prev, j], j))[:14]
            for j in cands:
                s = score + base[prev, j] + w["arc"] * (1 - abs(F.impact(fs[j]) - target)) * 0.8
                k = kinds[prev, j]
                if len(seq) >= 3 and kinds[seq[-2], seq[-1]] == k and kinds[seq[-3], seq[-2]] == k:
                    s -= 1.0                                    # three of a kind in a row
                elif len(seq) >= 3 and k != kinds[seq[-2], seq[-1]] and k != kinds[seq[-3], seq[-2]]:
                    s += 0.25                                   # a change of kind keeps the rhythm alive
                if k == "cut" and len(seq) >= 2 and kinds[seq[-2], seq[-1]] == "cut":
                    s -= 0.25                                   # two unmotivated cuts in a row
                if j in peaks and 0.55 <= t <= 0.88:
                    s += 0.4                                    # peaks belong near the top of the build
                if w["sweep"] and len(seq) >= 2 and marks[seq[-2]] and marks[prev] and marks[j]:
                    ax, ay = marks[prev]["x"] - marks[seq[-2]]["x"], marks[prev]["y"] - marks[seq[-2]]["y"]
                    bx, by = marks[j]["x"] - marks[prev]["x"], marks[j]["y"] - marks[prev]["y"]
                    na, nb = math.hypot(ax, ay), math.hypot(bx, by)
                    if na > 1 and nb > 1:
                        s += w["sweep"] * 0.6 * max(0.0, (ax * bx + ay * by) / (na * nb))   # the same way again: a sweep
                if w["grow"] and len(seq) >= 2 and marks[seq[-2]] and marks[prev] and marks[j]:
                    ga, gb = size_step(marks[seq[-2]], marks[prev]), size_step(marks[prev], marks[j])
                    if abs(ga) >= 0.03 and abs(gb) >= 0.03 and ga * gb > 0:
                        s += w["grow"] * 0.5                    # still growing (or shrinking): a zoom
                if w["turn"] and len(seq) >= 2 and marks[seq[-2]] and marks[prev] and marks[j]:
                    ra, rb = turn_step(marks[seq[-2]], marks[prev]), turn_step(marks[prev], marks[j])
                    if abs(ra) >= 1 and abs(rb) >= 1 and ra * rb > 0:
                        s += w["turn"] * 0.5                    # still turning the same way: a spin
                if ups_total:
                    placed = sum(1 for x in seq if marks[x] is None) + (marks[j] is None)
                    s -= w["spread"] * 0.5 * max(0.0, abs(placed - ups_total * (step + 1) / n) - 1)   # behind or ahead of an even spread
                if w["land"] and t >= 0.8 and marks[j]:
                    s += w["land"] * 0.6 * (1 - min(1.0, math.hypot(marks[j]["x"] - home["x"], marks[j]["y"] - home["y"]) / 20))   # coming home
                    s -= w["land"] * 0.3 * min(1.0, abs(marks[j].get("rot", 0)) / 90)        # and upright
                key = (frozenset(rest - {j}), j)
                if key not in nxt or nxt[key][0] < s:
                    nxt[key] = (s, seq + [j], rest - {j})
        states = sorted(nxt.values(), key=lambda s: (-s[0], s[1]))[:beam]
    if last is not None and last != first:
        states = sorted(((s + base[seq[-1], last], seq + [last], rest) for s, seq, rest in states), key=lambda s: (-s[0], s[1]))
    best = states[0][1]
    names = [items[i]["name"] for i in best]
    cuts = [{"from": items[a]["name"], "to": items[b]["name"], "kind": kinds[a, b],
             "reason": " · ".join(x for x in (describe_cut(fs[a], fs[b], kinds[a, b]), move_words(marks[a], marks[b])) if x)} for a, b in zip(best, best[1:])]
    left_out = [it["name"] for i, it in enumerate(items) if i not in in_pool]
    return {"names": names, "cuts": cuts, "left_out": left_out}


def hue_name(h) -> str:
    if h is None:
        return "neutral"
    for top, name in ((15, "red"), (45, "orange"), (70, "yellow"), (160, "green"), (200, "cyan"), (255, "blue"), (290, "violet"), (335, "pink"), (361, "red")):
        if h < top:
            return name
    return "red"


def describe_cut(fa: dict, fb: dict, kind: str) -> str:
    tone = lambda f: "dark" if f["lum"] < 0.42 else ("light" if f["lum"] > 0.58 else "mid")
    if kind == "flip":
        return f"{tone(fa)} → {tone(fb)} flip"
    if kind == "echo":
        return f"shape echo at the centre ({F.shape_echo(fa, fb):.2f})"
    if kind == "hue":
        return f"colour hand-off ({hue_name(fa['hue'])} → {hue_name(fb['hue'])})"
    return "fresh angle"


def summarize(titles: dict, result: dict, brief_summary: str | None = None) -> str:
    names, cuts = result["names"], result["cuts"]
    if not names:
        return ""
    count = {k: sum(1 for c in cuts if c["kind"] == k) for k in ("flip", "echo", "hue", "cut")}
    moves = sum(1 for c in cuts if "the mark moves" in c.get("reason", ""))
    line = (f"Opens on “{titles.get(names[0], names[0])}”, lands on “{titles.get(names[-1], names[-1])}”: {count['flip']} flips, {count['echo']} shape echoes, {count['hue']} colour hand-offs"
            + (f", the mark moving in {moves} cuts" if moves else "") + ".")
    return f"{brief_summary.strip()} {line}" if brief_summary else line


# ---------- Kimi: the edit brief ----------

def contact_sheet(paths: list, cols: int = 12, max_width: int = 1800) -> bytes:
    """One picture with every image numbered (0-based), for Kimi to look at."""
    cell_w = max(70, min(150, max_width // cols))
    cell_h = int(cell_w * 16 / 9)
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), (16, 16, 18))
    font = ImageFont.load_default(size=max(12, cell_w // 7))
    draw = ImageDraw.Draw(sheet)
    for i, p in enumerate(paths):
        im = Image.open(p).convert("RGB").resize((cell_w - 2, cell_h - 2), Image.Resampling.BILINEAR)
        x, y = (i % cols) * cell_w, (i // cols) * cell_h
        sheet.paste(im, (x + 1, y + 1))
        draw.rectangle((x + 1, y + 1, x + 1 + cell_w // 3 + 4, y + 1 + cell_w // 6 + 4), fill=(0, 0, 0))
        draw.text((x + 4, y + 2), str(i), fill=(255, 255, 255), font=font)
    buf = io.BytesIO()
    sheet.save(buf, "JPEG", quality=82)
    return buf.getvalue()


BRIEF_SYSTEM = "You are a world-class offline editor cutting a fast 9:16 match-cut title sequence. Reply with raw JSON only."


def frames_note(marks: list, home: dict, names: dict | None = None) -> str:
    """For Kimi: where the mark is in the frames where it is not the main mark on the project's place (empty when it always is)."""
    names = names or {}
    lines = []
    for i, m in enumerate(marks):
        if m is None:
            lines.append(f"{i}: an uploaded photo, no mark")
        elif m.get("id") or m.get("rot") or math.hypot(m["x"] - home["x"], m["y"] - home["y"]) >= 1 or abs(m["size"] - home.get("size", m["size"])) >= 1:
            turned = f", turned {abs(m['rot'])}° {'clockwise' if m['rot'] > 0 else 'anticlockwise'}" if m.get("rot") else ""
            walk = f", step {m['path']['i'] + 1} of {m['path']['n']} of a path" if m.get("path") else ""
            lines.append(f"{i}: " + (f"the {names.get(m['id'], m['id'])} mark, " if m.get("id") else "") + f"at {m['x']:g}% across, {m['y']:g}% down, {m['size']:g}% wide{turned}{walk}")
    if not lines:
        return ""
    return ("Where the mark sits (and how far it is turned), for the frames where it is not the main mark upright at its usual place "
            f"({home['x']:g}% across, {home['y']:g}% down, {home.get('size', 18):g}% wide); every other frame has it there:\n" + "\n".join(lines) + "\n")


def ask_brief(call_llm, api_key: str, model: str, sheet: bytes, count: int, direction: str = "", length: int | None = None, where: str = "", mode: str = "look") -> dict:
    """Returns {opener, closer, peaks, weights, summary} with image numbers (0-based), or raises. `where`: frames_note()."""
    ask = (
        (f"The picture is a contact sheet of {count} frames numbered 0 to {count - 1}. Each frame has a small circular mark at its exact centre; "
         f"the film is a rapid sequence of hard cuts between them.\n" if not where else
         f"The picture is a contact sheet of {count} frames numbered 0 to {count - 1}; the film is a rapid sequence of hard cuts between them.\n{where}")
        + (f"Director's note: {direction}\n" if direction else "")
        + ("This edit is about MOTION: order the frames so the mark moves as one continuous movement (it follows its path steps, keeps "
           "spinning one way, grows or shrinks steadily, then lands); the look of each frame matters less.\n" if mode == "motion" else "")
        + (f"The edit must use only the best {length} frames.\n" if length else "")
        + "Write the editing brief. Return ONLY JSON: {\"opener\": n, \"closer\": n, \"peaks\": [up to 4 numbers], "
        "\"weights\": {\"flip\": 0-2, \"echo\": 0-2, \"hue\": 0-2, \"variety\": 0-2, \"arc\": 0-2}, \"summary\": \"one sentence, under 30 words, on the shape of the edit\"}.\n"
        "opener = the single strongest hook frame; closer = the frame that lands the film; peaks = the biggest moments for the top of the build. "
        "weights say how much this set needs each kind of cut: flip = dark/light contrast cuts, echo = shape matches at the centre, "
        "hue = colour hand-offs, variety = avoid neighbouring frames from the same kind of scene, arc = follow hook, settle, build, peak, land."
        + ("" if not where else " Because the mark moves between frames you may also weigh (0-2): move = small steps of the mark from cut to cut read as motion, "
           "sweep = keep those steps going one way, land = end with the mark back at its usual place, swap = cut between different marks in the same spot, "
           "spread = keep the uploaded photos apart, turn = small turns of the mark from cut to cut, kept going one way, read as the mark spinning, "
           "path = follow a path's steps in order, grow = small changes of the mark's size kept going one way, read as a zoom. "
           "Follow the director's note when it asks for a movement.")
    )
    out = call_llm(ask, api_key, model, images=[sheet], system=BRIEF_SYSTEM)
    i = out.find("{")
    data, _ = json.JSONDecoder().raw_decode(out[i:])
    return data


def tidy(text, limit: int = 240) -> str | None:
    """One clean sentence from Kimi: cut at a word boundary, never mid-word."""
    text = " ".join(str(text or "").split())
    if not text:
        return None
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:—- ")
    return cut + "…"


def brief_to_names(data: dict, names: list) -> dict:
    """Image numbers from Kimi -> file names; anything out of range or malformed is dropped."""
    def name(v):
        try:
            return names[int(v)] if 0 <= int(v) < len(names) else None
        except (TypeError, ValueError):
            return None
    weights = {}
    for k, v in (data.get("weights") or {}).items():
        try:
            if k in DEFAULT_WEIGHTS or k in MOVE_WEIGHTS:
                weights[k] = max(0.0, min(2.0, float(v)))
        except (TypeError, ValueError):
            pass
    return {"opener": name(data.get("opener")), "closer": name(data.get("closer")),
            "peaks": [n for n in (name(v) for v in (data.get("peaks") or [])[:6]) if n], "weights": weights,
            "summary": tidy(data.get("summary"))}
