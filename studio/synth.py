"""
Synthesized music for the cut timeline (numpy; stereo 16-bit WAV at 44.1 kHz). It is modelled on what was measured in the reference
clips, not on a drum kit:
  - all four are a dark, continuous sub-bass bed (43-54 Hz carries 65-90% of the energy), almost nothing above 2 kHz, dense (crest factor ~3.9);
  - the cuts do not trigger kicks: the bed breathes with them (a soft pump on every cut, which slows down when the cuts slow down);
  - Soiltone/Ecwora share one wide-stereo drone with a tonal mid cluster, Helione is a pure mono 43 Hz sub with periodic bass swells and two
    bright noise bursts, Moverunion is a pulsing mono bass line (70-145 Hz) that changes note every cut;
  - the end of the clip is a landing: the sub gives way and the bed rings out.
Styles: "soil", "swell", "bass". Settings are 0..1: pulse (how much the bed follows the cuts), low (sub level), bright (how far the
tone opens up), width (stereo spread and room). `seed` makes the variation (root note, note order, burst positions).
"""
import io
import wave

import numpy as np

RATE = 44100
STYLES = ("soil", "swell", "bass")
TAU = 2 * np.pi
TARGET_RMS = 0.17


def _lowpass(x: np.ndarray, fc: float, slope: float = 4.0) -> np.ndarray:
    """Zero-phase low-pass through the FFT (a smooth roll-off, no ringing at the edges)."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / RATE)
    X *= 1.0 / (1.0 + (f / fc) ** (2 * slope))
    return np.fft.irfft(X, len(x))


def _highpass(x: np.ndarray, fc: float) -> np.ndarray:
    return x - _lowpass(x, fc, 1.0)


def _band(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return _highpass(_lowpass(x, hi, 2.0), lo)


def _smooth(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def _osc(freq: np.ndarray, shape: str = "sine") -> np.ndarray:
    phase = np.cumsum(freq) / RATE
    if shape == "saw":
        return 2.0 * (phase % 1.0) - 1.0
    return np.sin(TAU * phase)


def _reverb(x: np.ndarray, seconds: float, rng, damp: float = 900.0) -> np.ndarray:
    """A dark room: convolution with decaying, low-passed noise."""
    n = int(seconds * RATE)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / RATE * (6.9 / seconds))
    ir = _lowpass(ir, damp, 2.0)
    ir /= np.sqrt((ir ** 2).sum()) + 1e-9
    size = 1 << int(np.ceil(np.log2(len(x) + n)))
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:len(x)]


def _stereo(left: np.ndarray, right: np.ndarray, width: float) -> tuple[np.ndarray, np.ndarray]:
    mid, side = (left + right) / 2, (left - right) / 2
    return mid + side * width, mid - side * width


class _Timeline:
    def __init__(self, starts: list[float]):
        self.starts = np.asarray(starts, dtype=np.float64)
        self.total = float(self.starts[-1])
        self.n = max(1, int(round(self.total * RATE)))
        self.t = np.arange(self.n) / RATE
        self.cut = np.clip(np.searchsorted(self.starts, self.t, side="right") - 1, 0, len(self.starts) - 2)
        self.tau = self.t - self.starts[self.cut]                      # seconds since this cut began
        self.u = self.t / self.total if self.total else self.t
        self.n_cuts = len(self.starts) - 1


def _pump(tl: _Timeline, depth: float, decay: float = 0.11) -> np.ndarray:
    """Gain that dips and comes back on every cut: 1 at the cut start, settling to (1 - depth). Slower cuts = a slower pump."""
    return 1.0 - depth * (1.0 - np.exp(-tl.tau / decay))


def render(starts_sec: list[float], paired: bool = False, style: str = "soil", pulse: float = 0.5, low: float = 0.7,
           bright: float = 0.3, width: float = 0.6, seed: int = 7) -> bytes:
    """starts_sec: where each cut starts, in seconds; the last entry is the end. Returns a stereo WAV file."""
    style = style if style in STYLES else "soil"
    pulse, low, bright, width = (float(min(1.0, max(0.0, v))) for v in (pulse, low, bright, width))
    rng = np.random.default_rng(seed)
    tl = _Timeline(starts_sec)
    t, u = tl.t, tl.u
    land = float(tl.starts[max(0, tl.n_cuts - (2 if paired else 1))])         # where the last image begins
    landing = _smooth((t - land) / 1.2)                                        # 0 -> 1 over the last hold

    if style == "swell":
        L, R = _swell(tl, rng, pulse, low, bright, land, landing)
    elif style == "bass":
        L, R = _bass(tl, rng, pulse, low, bright, land, landing, paired)
    else:
        L, R = _soil(tl, rng, pulse, low, bright, land, landing)

    # room and spread
    room = 0.10 + 0.30 * width
    # the send skips the sub: a pure low tone through random noise would swing in level from one seed to the next
    L = L + room * _reverb(_highpass(L, 140.0), 2.4, rng)
    R = R + room * _reverb(_highpass(R, 140.0), 2.4, rng)
    spread = {"soil": 0.25 + 0.9 * width, "swell": 0.02 + 0.1 * width, "bass": 0.02 + 0.1 * width}[style]
    L, R = _stereo(L, R, spread)

    # glue: dense and level, like the references (crest factor ~3.9), then a short fade in and out
    out = np.stack([L, R])
    out *= TARGET_RMS / (np.sqrt((out ** 2).mean()) + 1e-9)
    out = np.tanh(out * 1.1) / np.tanh(1.1)
    out *= TARGET_RMS / (np.sqrt((out ** 2).mean()) + 1e-9)
    out = np.clip(out, -0.97, 0.97)
    fade_in, fade_out = min(tl.n, int(0.02 * RATE)), min(tl.n, int(0.12 * RATE))
    out[:, :fade_in] *= np.linspace(0, 1, fade_in)
    out[:, tl.n - fade_out:] *= np.linspace(1, 0, fade_out)
    pcm = (out.T * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _sub(tl, f0, level, wobble=0.012, second=0.3):
    f = f0 * (1 + wobble * np.sin(TAU * 0.13 * tl.t))
    return level * (_osc(f) + second * _osc(2 * f))


def _soil(tl, rng, pulse, low, bright, land, landing):
    """Soiltone / Ecwora: a ~54 Hz sub, a filtered saw pad, a tonal mid cluster, wide."""
    t, u = tl.t, tl.u
    f0 = 51.0 + 6.0 * rng.random()
    sub = _sub(tl, f0, 1.0) * (0.9 + 0.1 * np.sin(TAU * 0.5 * t)) * (0.3 + 0.8 * low)
    sub *= _pump(tl, 0.25 * pulse, 0.15) * (1 - 0.6 * landing)
    rumble = _lowpass(rng.standard_normal(tl.n), 110.0, 2.0) * 0.9
    rumble /= rumble.std() + 1e-9
    sub = sub + 0.10 * low * rumble
    lfos = [(g, 0.75 + 0.25 * np.sin(TAU * rng.uniform(0.15, 0.7) * t + rng.uniform(0, TAU))) for _, g in ((4.0, 0.2), (7.2, 0.8), (9.2, 1.0), (9.6, 0.6))]
    parts = []
    for side in (-1, 1):                                                       # detuned L/R pad = width
        det = 1 + side * 0.0045
        pad = sum(_osc(np.full(tl.n, f0 * k * det), "saw") * g for k, g in ((2, 1.0), (3, 0.6), (4, 0.4)))
        cluster = np.zeros(tl.n)
        for (ratio, _), (g, lfo) in zip(((4.0, 0), (7.2, 0), (9.2, 0), (9.6, 0)), lfos):   # ~215, 387, 495, 516 Hz at f0=54
            cluster += g * lfo * _osc(np.full(tl.n, f0 * ratio * det * (1 + 0.002 * side)))
        parts.append((pad, cluster))
    out = []
    for pad, cluster in parts:
        fc = 260.0 + 1400.0 * bright
        dark = _lowpass(pad, fc, 3.0)
        open_ = _lowpass(pad, fc * 2.6, 3.0)
        pad = dark * (1 - 0.5 * u) + open_ * 0.5 * u                          # the tone opens up a little as it goes
        tick = sum(_osc(np.full(tl.n, f0 * r * (1 + 0.003 * side)), "sine") for r in (7.2, 9.2)) * np.exp(-tl.tau / 0.03)
        body = (0.26 * pad + (0.34 + 0.2 * bright) * cluster + (0.2 + 0.5 * pulse) * 0.9 * tick) * _pump(tl, 0.8 * pulse, 0.07)
        body *= 1 - 0.35 * landing
        out.append(sub + body)
    return out[0], out[1]


def _swell(tl, rng, pulse, low, bright, land, landing):
    """Helione: a pure mono 43.65 Hz sub, bass swells every ~1.7 s, two bright bursts, a tiny tick on every cut."""
    t, u = tl.t, tl.u
    f0 = 43.65
    sub = np.tanh(4.0 * _sub(tl, f0, 0.8, wobble=0.004, second=0.12)) * (0.2 + 0.5 * low)
    bass = np.zeros(tl.n)
    when = rng.uniform(0.2, 0.8)
    while when < tl.total:
        env = np.exp(-0.5 * ((t - when) / 0.28) ** 2)
        drop = 110.0 - 40.0 * _smooth((t - when + 0.2) / 0.5)
        bass += env * _osc(drop)
        when += rng.uniform(1.5, 2.1)
    bass *= 0.55 * (0.3 + 0.7 * low)
    bursts = np.zeros(tl.n)
    for frac in (rng.uniform(0.30, 0.42), rng.uniform(0.80, 0.9)):
        w0 = frac * tl.total
        env = np.where(t >= w0, np.exp(-(t - w0) / 0.22), 0.0) * np.minimum(1.0, np.maximum(0.0, (t - w0) / 0.012 + 0.0))
        noise = _band(rng.standard_normal(tl.n), 1200.0, 5200.0)
        bursts += env * noise
    bursts *= 3.6 * (0.15 + 0.85 * bright)
    ticks = _band(rng.standard_normal(tl.n), 1500.0, 4500.0) * np.exp(-tl.tau / 0.02) * 0.25 * pulse
    body = (sub * _pump(tl, 0.15 * pulse, 0.2) + bass) * (1 - 0.65 * landing)
    mono = body + bursts + ticks
    return mono, mono * 1.0


def _bass(tl, rng, pulse, low, bright, land, landing, paired):
    """Moverunion: a pulsing mono bass line that changes note on every cut, over a quiet sub."""
    t = tl.t
    pool = np.array([97.0, 100.0, 113.0, 116.0, 145.0, 70.0, 73.0]) * (0.97 + 0.06 * rng.random())
    notes = np.empty(tl.n_cuts)
    cur = rng.integers(len(pool))
    for i in range(tl.n_cuts):
        if not (paired and i % 2 == 1) and rng.random() < 0.65:
            cur = rng.integers(len(pool))                                       # an image and its inverted copy share a note
        notes[i] = pool[cur]
    notes[-1] = pool[0] / 2 if tl.n_cuts else pool[0]                           # the landing sits on a low root
    f = notes[tl.cut]
    glide = np.minimum(1.0, tl.tau / 0.02)
    prev = notes[np.maximum(tl.cut - 1, 0)]
    f = prev + (f - prev) * glide
    saw = _lowpass(_osc(f, "saw"), 300.0 + 900.0 * bright, 3.0)
    note = 1.1 * saw + 0.35 * _osc(f / 2) + 0.4 * _osc(f)
    note *= _pump(tl, 0.55 * pulse + 0.1, 0.1) * (0.8 + 0.4 * low)
    sub = _sub(tl, 48.0, 0.12 * (0.3 + 0.7 * low))
    mono = (note + sub) * (1 - 0.5 * landing)
    return mono, mono * 1.0
