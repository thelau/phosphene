"""
Synthesized music that follows the cut timeline exactly (no samples, no network): a kick on every cut, a hat between longer
cuts, a bass note every fourth cut, a low pad that swells, and a deep boom on the final hold. The same timeline drives
the picture, so any tempo, multiple or tempo curve stays in sync. Pure Python (no numpy), mono 16-bit WAV.
"""
import io
import math
import random
import wave
from array import array

RATE = 32000
BASS_NOTES = (55.0, 65.41, 73.42, 82.41, 98.0)  # A1 minor pentatonic-ish
PAD = (110.0, 164.81, 220.0)
TAU = 2 * math.pi


def _add_kick(buf, i0, gain, length, f_end=45.0, f_drop=110.0, decay=14.0, sweep=30.0):
    n = min(int(length * RATE), len(buf) - i0)
    for k in range(max(0, n)):
        t = k / RATE
        phase = TAU * (f_end * t + f_drop * (1 - math.exp(-sweep * t)) / sweep)
        buf[i0 + k] += gain * math.exp(-t * decay) * math.sin(phase)


def _add_hat(buf, i0, gain, rng):
    n = min(int(0.045 * RATE), len(buf) - i0)
    prev = 0.0
    for k in range(max(0, n)):
        x = rng.uniform(-1, 1)
        buf[i0 + k] += gain * math.exp(-k / RATE / 0.011) * (x - prev)  # differencing = a crude high-pass
        prev = x


def _add_bass(buf, i0, freq, length, gain):
    n = min(int(length * RATE), len(buf) - i0)
    for k in range(max(0, n)):
        t = k / RATE
        env = min(1.0, t / 0.006) * math.exp(-t * 2.6)
        buf[i0 + k] += gain * env * (math.sin(TAU * freq * t) + 0.3 * math.sin(TAU * 2 * freq * t))


def render(starts_sec: list[float], paired: bool = False, seed: int = 7) -> bytes:
    """starts_sec: where each cut starts in seconds, the last entry is the end. Returns a WAV file."""
    total = starts_sec[-1]
    n = max(1, int(total * RATE))
    buf = array("f", bytes(4 * n))
    rng = random.Random(seed)
    n_cuts = len(starts_sec) - 1
    last = n_cuts - 1 if not paired else n_cuts - 2  # the final image's first cut: where the landing starts

    # pad: a low chord that swells through the sequence and falls away over the last second
    for k in range(n):
        t = k / RATE
        swell = 0.45 + 0.55 * (t / total if total else 0)
        tail = min(1.0, max(0.0, (total - t) / 1.0))
        trem = 0.85 + 0.15 * math.sin(TAU * 0.4 * t)
        buf[k] += 0.05 * swell * tail * trem * (math.sin(TAU * PAD[0] * t) + 0.7 * math.sin(TAU * PAD[1] * t) + 0.5 * math.sin(TAU * PAD[2] * t))

    bass_cuts = [i for i in range(n_cuts) if i % 4 == 0 and i < last]
    for j, i in enumerate(bass_cuts):
        end = starts_sec[bass_cuts[j + 1]] if j + 1 < len(bass_cuts) else starts_sec[last]
        _add_bass(buf, int(starts_sec[i] * RATE), rng.choice(BASS_NOTES), min(1.2, end - starts_sec[i]), 0.22)

    for i in range(n_cuts):
        t0 = starts_sec[i]
        dur = starts_sec[i + 1] - t0
        if i == last:  # the landing: one deep boom and a long bass note under the final hold
            _add_kick(buf, int(t0 * RATE), 1.0, min(1.8, total - t0), f_end=38.0, f_drop=70.0, decay=2.2, sweep=20.0)
            _add_bass(buf, int(t0 * RATE), BASS_NOTES[0], min(2.5, total - t0), 0.3)
            continue
        if i > last:  # the inverted copy of the final image: no new hit, the boom keeps ringing
            continue
        accent = 0.55 if paired and i % 2 == 1 else 0.9
        _add_kick(buf, int(t0 * RATE), accent, min(0.22, dur * 0.95 if dur > 0.12 else 0.12))
        if dur >= 0.18:
            _add_hat(buf, int((t0 + dur / 2) * RATE), 0.16 if accent > 0.6 else 0.1, rng)

    peak = max(max(buf), -min(buf)) or 1.0
    scale = 0.9 / peak
    fade = min(n, int(0.08 * RATE))
    pcm = array("h", bytes(2 * n))
    for k in range(n):
        v = buf[k] * scale
        if k >= n - fade:
            v *= (n - k) / fade
        pcm[k] = int(max(-1.0, min(1.0, v)) * 32767)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return out.getvalue()
