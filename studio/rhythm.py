"""
Cut timelines. Flat is the plain tempo grid (every cut the same length, as in Helione and Moverunion). Music-driven cuts follow a track
(see beats.py): either its hits (the transients: the way to follow glitch / IDM, where there is no steady grid) or its beat grid.
Times are seconds from the start of the clip; `cut_at` finds the cut at a time, wrapping around the sequence.
"""
import bisect

MIN_GAP = 0.066          # two cuts are never closer than 2 frames at 30 fps
MODES = ("hits", "beats")


def cut_at(starts: list[float], t: float) -> tuple[int, float]:
    """(cut index, progress 0..1 inside it) at time t; t wraps around the sequence."""
    total = starts[-1]
    t = t % total if total > 0 else 0.0
    i = min(max(bisect.bisect_right(starts, t) - 1, 0), len(starts) - 2)
    span = starts[i + 1] - starts[i]
    return i, (t - starts[i]) / span if span > 0 else 0.0


def select_hits(hits: list, sensitivity: float, min_gap: float = MIN_GAP) -> list[float]:
    """Times of the strongest hits. sensitivity 0..1: 0 keeps the top 10% of them, 1 keeps all; none closer than min_gap
    (the stronger one wins)."""
    if not hits:
        return []
    sensitivity = min(1.0, max(0.0, sensitivity))
    keep = max(1, int(round(len(hits) * (0.1 + 0.9 * sensitivity))))
    strongest = sorted(hits, key=lambda h: -h[1])[:keep]
    chosen: list[float] = []
    for t, _ in strongest:                                    # strongest first: a weak hit next to a strong one is dropped
        i = bisect.bisect_left(chosen, t)
        if (i > 0 and t - chosen[i - 1] < min_gap) or (i < len(chosen) and chosen[i] - t < min_gap):
            continue
        chosen.insert(i, t)
    return chosen


def beat_time(beats: list[float], position: float) -> float:
    """Seconds at a position measured in beats (0 = the first beat); past the end it carries on at the last interval."""
    n = len(beats)
    if n == 1:
        return beats[0] + position * 0.5
    i = int(position)
    if i >= n - 1:
        return beats[-1] + (position - (n - 1)) * (beats[-1] - beats[-2])
    return beats[i] + (position - i) * (beats[i + 1] - beats[i])


def beat_events(beats: list[float], multiple: float, duration: float) -> list[float]:
    """Cut times on the beat grid: `multiple` cuts per beat (0.5 = every other beat, 4 = four per beat)."""
    if len(beats) < 2 or multiple <= 0:
        return []
    out, k = [], 0
    while True:
        t = beat_time(beats, k / multiple)
        if t > duration:
            return out
        out.append(t)
        k += 1


def track_cuts(analysis: dict, n_cuts: int, mode: str = "hits", multiple: float = 1.0, sensitivity: float = 0.5, nudge: float = 0.0) -> dict:
    """Where the n_cuts cuts of the clip fall so that they land on the track.
    The picture starts on the first event; the sound starts there too (nudge > 0: the sound starts later, so the pictures come earlier
    than their hits; < 0: the other way, as far as the start of the file allows). When the track is shorter than the clip it loops.
    Returns {starts (n_cuts + 1 seconds, the last is the end of the clip), audio_start, total, events}."""
    duration = float(analysis["duration"])
    if mode == "beats":
        events = beat_events(analysis.get("beats", []), multiple, duration)
    else:
        events = select_hits(analysis.get("hits", []), sensitivity)
    if len(events) < 2:
        raise ValueError("Not enough hits or beats in that track to cut on.")
    audio_start = max(0.0, min(events[0] + nudge, duration - 0.5))
    rel = [e - events[0] for e in events]
    loop = max(duration - audio_start, rel[-1] + MIN_GAP)
    starts, j = [], 0
    while len(starts) < n_cuts + 1:
        starts.extend(r + j * loop for r in rel)
        j += 1
    return {"starts": starts[:n_cuts + 1], "audio_start": audio_start, "total": starts[n_cuts], "events": len(events), "loop": loop}
