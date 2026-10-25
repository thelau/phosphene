"""
Cut timeline: when each cut starts. Mirrored by `cutStarts` in studio/web/src/app.js (tests share vectors).

Units are "base cuts": 1.0 is one hold at the tempo chosen in the player (BPM x multiple). Flat is exactly the old behaviour
(every cut 1.0). The curves lengthen or shorten the cuts along the sequence, the way Ecwora and Soiltone do:
  land  - steady, then the cuts ease out into a long final hold
  burst - steady, a fast burst, then the cuts ease out into a long final hold
With invert on, an image and its inverted copy always share one length.
"""

RHYTHMS = ("flat", "land", "burst")
LAST_HOLD = 1.5  # the final image is held this much longer than the curve says


def _smooth(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def factor(rhythm: str, u: float) -> float:
    """Length of a cut (1.0 = base) at position u (0 = first image, 1 = last)."""
    if rhythm == "land":
        return 1 + 2 * _smooth((u - 0.7) / 0.3)
    if rhythm == "burst":
        if u < 0.75:
            return 1 - 0.5 * _smooth((u - 0.30) / 0.10)
        return 0.5 + 2.5 * _smooth((u - 0.75) / 0.25)
    return 1.0


def cut_starts(n_cuts: int, rhythm: str = "flat", paired: bool = False, min_len: float = 0.0) -> list[float]:
    """n_cuts + 1 numbers: where each cut starts, the last one is where the sequence ends. min_len keeps a cut at least one frame."""
    if rhythm not in RHYTHMS or rhythm == "flat":
        return [float(i) for i in range(n_cuts + 1)]
    n_img = max(1, n_cuts // 2 if paired else n_cuts)
    starts, t = [0.0], 0.0
    for i in range(n_cuts):
        img = i // 2 if paired else i
        u = img / (n_img - 1) if n_img > 1 else 1.0
        f = factor(rhythm, u)
        if img == n_img - 1:
            f *= LAST_HOLD
        t += max(min_len, f)
        starts.append(t)
    return starts


def cut_at(starts: list[float], t: float) -> tuple[int, float]:
    """(cut index, progress 0..1 inside it) at time t (base-cut units); t wraps around the sequence."""
    total = starts[-1]
    t = t % total if total > 0 else 0.0
    lo, hi = 0, len(starts) - 2
    while lo < hi:  # last cut whose start <= t
        mid = (lo + hi + 1) // 2
        if starts[mid] <= t:
            lo = mid
        else:
            hi = mid - 1
    span = starts[lo + 1] - starts[lo]
    return lo, (t - starts[lo]) / span if span > 0 else 0.0
