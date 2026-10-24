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
"""

import io
import json
import math

from PIL import Image, ImageDraw, ImageFont

import features as F

DEFAULT_WEIGHTS = {"flip": 1.0, "echo": 1.0, "hue": 0.6, "variety": 0.8, "arc": 1.0}
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
    w = {**DEFAULT_WEIGHTS, **{k: float(v) for k, v in (brief.get("weights") or {}).items() if k in DEFAULT_WEIGHTS}}
    index = {it["name"]: i for i, it in enumerate(items)}
    if not items:
        return {"names": [], "cuts": [], "left_out": []}
    by_impact = sorted(range(len(items)), key=lambda i: (-F.impact(items[i]["f"]), i))
    first = index.get(brief.get("opener"))
    if first is None:
        first = by_impact[0]
    last = index.get(brief.get("closer"))
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

    # beam search: state = (score, sequence, remaining set)
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
                key = (frozenset(rest - {j}), j)
                if key not in nxt or nxt[key][0] < s:
                    nxt[key] = (s, seq + [j], rest - {j})
        states = sorted(nxt.values(), key=lambda s: (-s[0], s[1]))[:beam]
    if last is not None and last != first:
        states = sorted(((s + base[seq[-1], last], seq + [last], rest) for s, seq, rest in states), key=lambda s: (-s[0], s[1]))
    best = states[0][1]
    names = [items[i]["name"] for i in best]
    cuts = [{"from": items[a]["name"], "to": items[b]["name"], "kind": kinds[a, b], "reason": describe_cut(fs[a], fs[b], kinds[a, b])} for a, b in zip(best, best[1:])]
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
    line = f"Opens on “{titles.get(names[0], names[0])}”, lands on “{titles.get(names[-1], names[-1])}”: {count['flip']} flips, {count['echo']} shape echoes, {count['hue']} colour hand-offs."
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


def ask_brief(call_llm, api_key: str, model: str, sheet: bytes, count: int, direction: str = "", length: int | None = None) -> dict:
    """Returns {opener, closer, peaks, weights, summary} with image numbers (0-based), or raises."""
    ask = (
        f"The picture is a contact sheet of {count} frames numbered 0 to {count - 1}. Each frame has a small circular mark at its exact centre; "
        f"the film is a rapid sequence of hard cuts between them.\n"
        + (f"Director's note: {direction}\n" if direction else "")
        + (f"The edit must use only the best {length} frames.\n" if length else "")
        + "Write the editing brief. Return ONLY JSON: {\"opener\": n, \"closer\": n, \"peaks\": [up to 4 numbers], "
        "\"weights\": {\"flip\": 0-2, \"echo\": 0-2, \"hue\": 0-2, \"variety\": 0-2, \"arc\": 0-2}, \"summary\": \"one sentence, under 30 words, on the shape of the edit\"}.\n"
        "opener = the single strongest hook frame; closer = the frame that lands the film; peaks = the biggest moments for the top of the build. "
        "weights say how much this set needs each kind of cut: flip = dark/light contrast cuts, echo = shape matches at the centre, "
        "hue = colour hand-offs, variety = avoid neighbouring frames from the same kind of scene, arc = follow hook, settle, build, peak, land."
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
            if k in DEFAULT_WEIGHTS:
                weights[k] = max(0.0, min(2.0, float(v)))
        except (TypeError, ValueError):
            pass
    return {"opener": name(data.get("opener")), "closer": name(data.get("closer")),
            "peaks": [n for n in (name(v) for v in (data.get("peaks") or [])[:6]) if n], "weights": weights,
            "summary": tidy(data.get("summary"))}
