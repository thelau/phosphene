"""
Learn from curation history: which plates were approved, kept, rejected or trashed,
and which models / prompts they came from.

Signals (weights): approved +2, kept (not trashed, no decision) +0.5, trashed -1, rejected -2.
Plates auto-trashed by logo QA are indistinguishable from manual trash, so they count as trash.
"""

import random
import re

WEIGHTS = {"approved": 2.0, "kept": 0.5, "trashed": -1.0, "rejected": -2.0}

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


def plate_status(st: dict, filename: str) -> str:
    decision = st.get("decisions", {}).get(filename)
    if decision in ("approved", "rejected"):
        return decision
    if filename in st.get("trashed", []):
        return "trashed"
    return "kept"


def model_stats(st: dict) -> dict:
    """Per model: counts per status, n, and a smoothed mean score in [-2, 2]."""
    stats = {m: {"n": 0, "approved": 0, "kept": 0, "trashed": 0, "rejected": 0} for m in CANDIDATE_MODELS}
    for filename, model in st.get("models", {}).items():
        s = stats.setdefault(model, {"n": 0, "approved": 0, "kept": 0, "trashed": 0, "rejected": 0})
        s["n"] += 1
        s[plate_status(st, filename)] += 1
    for s in stats.values():
        total = sum(WEIGHTS[k] * s[k] for k in WEIGHTS)
        s["score"] = round(total / (s["n"] + 3), 3)  # +3 pseudo-observations at 0 shrinks small samples
        s["keep_rate"] = round((s["approved"] + s["kept"]) / s["n"], 3) if s["n"] else None
    return stats


def pick_model(st: dict, explore: float = 0.35) -> str:
    """Epsilon-greedy over smoothed score; exploration favors under-sampled models."""
    stats = model_stats(st)
    if random.random() < explore:
        weights = [1.0 / (1 + stats[m]["n"]) for m in CANDIDATE_MODELS]
        return random.choices(CANDIDATE_MODELS, weights=weights, k=1)[0]
    return max(CANDIDATE_MODELS, key=lambda m: stats[m]["score"])


def taste_brief(st: dict, titles: dict, prompts: dict, k_pos: int = 6, k_neg: int = 14) -> dict:
    """Titles/prompts of what worked and what to steer away from."""
    pos, neg = [], []
    for filename in prompts:
        status = plate_status(st, filename)
        entry = (titles.get(filename, filename), prompts[filename])
        if status == "approved":
            pos.insert(0, entry)
        elif status == "kept":
            pos.append(entry)
        else:
            neg.append((status, entry[0]))
    neg.sort(key=lambda x: 0 if x[0] == "rejected" else 1)
    return {"liked": pos[:k_pos], "disliked": [t for _, t in neg[:k_neg]]}


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
