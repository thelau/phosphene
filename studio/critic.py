"""
AI critic (Kimi vision): scores a plate like a design-studio creative director before it reaches the grid.
Rejections go to Trash with a visible reason (never a hidden bin); restoring one tells us the critic was wrong.
"""

import io
import json

from PIL import Image

SYSTEM = (
    "You are a ruthless but fair creative director at a world-class design studio (Pentagram level), reviewing frames for a film. "
    "Output raw JSON only, no markdown."
)

RUBRIC = (
    "Review this 9:16 frame for a film whose small circular orbital mark sits at the dead center. Score each 0-10:\n"
    "- hero: one clear hero subject, restrained composition, confident negative space (10 = a single bold idea; 0 = clutter or collage)\n"
    "- craft: photoreal / render quality, believable materials and light, no AI artifacts, warped text or melted detail\n"
    "- idea: the mark emerges from the scene in a smart, physical, original way (10 = memorable concept; 0 = logo pasted on a generic thing)\n"
    "- mark: the mark is bold, high-contrast and clearly legible at phone size in a 4-frame cut (0 if missing, thin, or lost in texture)\n"
    "- design: palette discipline (max ~3 colors), type/grid rigor if any text, would sit well in a Pentagram identity reel\n"
    "Return {\"hero\":n,\"craft\":n,\"idea\":n,\"mark\":n,\"design\":n,\"reason\":\"<=14 words naming the single biggest weakness, or the strength if great\"}."
)

KEEP_AT = 6.0  # mean score needed to stay in the grid (calibrated against the director's own keep/trash decisions)


def _jpeg(path, size=(540, 960)) -> bytes:
    b = io.BytesIO()
    Image.open(path).convert("RGB").resize(size).save(b, "JPEG", quality=85)
    return b.getvalue()


def review_plate(path, call_llm, api_key: str, model: str, mark: str | None = None) -> dict:
    """call_llm = server.call_kimi_llm. Returns scores, mean, verdict and reason. `mark`: how another project's mark sits (DEMO: None)."""
    rubric = RUBRIC.replace("small circular orbital mark sits at the dead center", mark) if mark else RUBRIC
    out = call_llm(rubric, api_key, model, images=[_jpeg(path)], system=SYSTEM)
    s, e = out.find("{"), out.rfind("}")
    data = json.loads(out[s : e + 1])
    keys = ("hero", "craft", "idea", "mark", "design")
    scores = {k: float(data.get(k, 0)) for k in keys}
    mean = round(sum(scores.values()) / len(keys), 2)
    # a weak mark alone is disqualifying: the whole film depends on it reading
    verdict = "keep" if mean >= KEEP_AT and scores["mark"] >= 4 else "trash"
    return {"scores": scores, "mean": mean, "verdict": verdict, "reason": str(data.get("reason", ""))[:120]}
