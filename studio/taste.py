"""
Learn from curation history: which plates were approved, kept, rejected or trashed,
and which models / prompts they came from.

Signals: kept (in the grid) = liked, trashed = disliked / doesn't work. Plates the logo QA auto-trashed
(state["qa_failed"], and still in trash) say the model can't lock the logo, which is a weaker negative and
no taste signal for prompts. Restoring a plate from trash makes it "kept".
"""

import re

WEIGHTS = {"kept": 1.0, "trashed": -1.0, "qa_failed": -0.5, "critic_failed": -0.25}

# Models that accept a reference image (the center-locked logo guide). Order is the UI order.
CANDIDATE_MODELS = [
    "google/nano-banana-pro",
    "google/nano-banana-2.1",
    "openai/gpt-image-2.5-flare",
    "openai/gpt-image-2.5-sunburst",
    "krea/krea-3",
    "bytedance/seedream-5-pro",
    "ideogram/ideogram-4.5",
    "luma/uni-1",
    "meta/muse-image",
    "runway/gen-4-image",
]

# The one model the app makes images with: nobody picks one (2026-11-06). On Demo, the one project that tried them all, 2.1 kept 18%,
# Pro 10% and the others 3%, and at 2K it costs 44 Krea units an image against Pro's 111.
IMAGE_MODEL = "google/nano-banana-2.1"


def plate_status(st: dict, filename: str) -> str:
    if filename in st.get("trashed", []):
        if filename in st.get("qa_failed", []):
            return "qa_failed"
        if filename in st.get("critic_failed", []):
            return "critic_failed"
        return "trashed"
    return "kept"


def model_stats(st: dict) -> dict:
    """Per model: counts per status, n, and a smoothed mean score in [-2, 2]."""
    stats = {m: {"n": 0, "kept": 0, "trashed": 0, "qa_failed": 0, "critic_failed": 0} for m in CANDIDATE_MODELS}
    for filename, model in st.get("models", {}).items():
        s = stats.setdefault(model, {"n": 0, "kept": 0, "trashed": 0, "qa_failed": 0, "critic_failed": 0})
        s["n"] += 1
        s[plate_status(st, filename)] += 1
    for s in stats.values():
        total = sum(WEIGHTS[k] * s[k] for k in WEIGHTS)
        s["score"] = round(total / (s["n"] + 3), 3)  # +3 pseudo-observations at 0 shrinks small samples
        s["keep_rate"] = round(s["kept"] / s["n"], 3) if s["n"] else None
    return stats


def taste_brief(st: dict, titles: dict, prompts: dict, k_pos: int = 6, k_neg: int = 14) -> dict:
    """Titles/prompts of what worked and what to steer away from."""
    pos, neg = [], []
    for filename in prompts:
        status = plate_status(st, filename)
        entry = (titles.get(filename, filename), prompts[filename])
        if status == "kept":
            pos.append(entry)
        elif status == "trashed":
            neg.append(entry[0])
    # newest first: recent taste matters most
    return {"liked": pos[-k_pos:][::-1], "disliked": neg[-k_neg:][::-1]}


_STOP = set(
    "the a an of and in on at with to for by from its it is as into over under "
    "Demo circular orbital logo frame center dead exact width vertical".split()
)


def _tokens(text: str) -> set:
    return {w for w in re.findall(r"[a-z]{3,}", text.lower()) if w not in _STOP}


def novelty(prompt: str, past_prompts: list) -> float:
    """1 - max Jaccard similarity to any past prompt. 1.0 = totally new."""
    t = _tokens(prompt)
    if not t:
        return 0.0
    best = 0.0
    for p in past_prompts:
        pt = _tokens(p)
        if pt:
            best = max(best, len(t & pt) / len(t | pt))
    return 1.0 - best
