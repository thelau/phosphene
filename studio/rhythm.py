"""
Cut timeline: when each cut starts. Mirrored by `cutStarts` in studio/web/src/app.js (tests share vectors).

Units are "base cuts": 1.0 is one hold at the tempo chosen in the player (BPM x multiple). Flat is exactly the old behaviour
(every cut 1.0). Measured on the reference clips (scene-change times):
  - Helione (every cut 4 frames) and Moverunion (every cut 5 frames) are perfectly flat.
  - Ecwora and Soiltone hold their first cut length for about a quarter of the cuts, then slow down smoothly and keep
    slowing: the last cuts are 7-11x longer than the first (Ecwora 0.10s -> 0.70s, Soiltone 0.07s -> 0.77s), and the clip ends on the longest.
So there are three rhythms:
  flat  - every cut the same length (Helione, Moverunion)
  decel - decelerating: steady for 30% of the images, then the cuts grow to 8x and the last image is held longest (Ecwora, Soiltone)
  accel - accelerating: the same curve played backwards, it opens on the longest hold and speeds up until it is steady
With invert on, an image and its inverted copy always share one length.
"""

RHYTHMS = ("flat", "accel", "decel")
EDGE_HOLD = 1.4  # the image on the slow end (the last for decel, the first for accel) is held this much longer (Soiltone: 0.56s -> 0.77s)
CURVE = (0.30, 8.0, 2.2)  # where the speed change starts (from the steady end), how long the slowest cut is, the curve's shape


def factor(rhythm: str, u: float) -> float:
    """Length of a cut (1.0 = base) at position u (0 = first image, 1 = last)."""
    if rhythm not in ("accel", "decel"):
        return 1.0
    if rhythm == "accel":
        u = 1.0 - u
    u0, top, power = CURVE
    return top ** (((u - u0) / (1 - u0)) ** power) if u > u0 else 1.0


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
        if img == (0 if rhythm == "accel" else n_img - 1):
            f *= EDGE_HOLD
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
