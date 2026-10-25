"""
Synthesized music for the cut timeline (numpy; stereo 16-bit WAV at 44.1 kHz). It is modelled on what was measured in the reference
clips, not on a drum kit:
  - all four are a dark, continuous sub-bass bed (43-54 Hz carries 65-90% of the energy), almost nothing above 2 kHz, dense (crest factor ~3.9);
  - the cuts do not trigger kicks: the bed breathes with them (a soft pump on every cut, which slows down when the cuts slow down);
  - Soiltone/Ecwora share one wide-stereo drone with a tonal mid cluster; the end of the clip is a landing: the sub gives way and the bed rings out.
Only that drone is built (the Helione sub-swell and Moverunion bass-line styles were tried and dropped).
Settings are 0..1: pulse (how much the bed follows the cuts), low (sub level), bright (how far the tone opens up), width (stereo spread),
space (size of the room: reverb length and amount), power (thicker, heavier: unison pad and saturation). `seed` makes the variation.
"""
import io
import wave

import numpy as np

RATE = 44100
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


def _reverb(x: np.ndarray, seconds: float, rng, damp: float = 900.0, predelay: float = 0.025) -> np.ndarray:
    """A dark room: convolution with decaying, low-passed noise (after a short pre-delay)."""
    n = int(seconds * RATE)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / RATE * (6.9 / seconds))
    ir = _lowpass(ir, damp, 2.0)
    ir /= np.sqrt((ir ** 2).sum()) + 1e-9
    ir = np.concatenate([np.zeros(int(predelay * RATE)), ir])
    size = 1 << int(np.ceil(np.log2(len(x) + len(ir))))
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


def render(starts_sec: list[float], paired: bool = False, pulse: float = 0.5, low: float = 0.7, bright: float = 0.3,
           width: float = 0.6, space: float = 0.6, power: float = 0.6, seed: int = 7) -> bytes:
    """starts_sec: where each cut starts, in seconds; the last entry is the end. Returns a stereo WAV file."""
    pulse, low, bright, width, space, power = (float(min(1.0, max(0.0, v))) for v in (pulse, low, bright, width, space, power))
    rng = np.random.default_rng(seed)
    tl = _Timeline(starts_sec)
    land = float(tl.starts[max(0, tl.n_cuts - (2 if paired else 1))])         # where the last image begins
    landing = _smooth((tl.t - land) / 1.2)                                     # 0 -> 1 over the last hold
    L, R = _drone(tl, rng, pulse, low, bright, power, landing)

    # room: the send skips the sub (a pure low tone through random noise would swing in level from one seed to the next)
    seconds, wet = 2.4 + 3.6 * space, 0.05 + 0.5 * space
    L = L + wet * _reverb(_highpass(L, 140.0), seconds, rng)
    R = R + wet * _reverb(_highpass(R, 140.0), seconds, rng)
    L, R = _stereo(L, R, 0.25 + 0.9 * width)

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


def _drone(tl, rng, pulse, low, bright, power, landing):
    """Soiltone / Ecwora: a ~54 Hz sub, a unison saw pad, a tonal mid cluster, a little air; wide, breathing, heavy."""
    t, u = tl.t, tl.u
    f0 = 51.0 + 6.0 * rng.random()
    sub = _sub(tl, f0, 1.0) * (0.9 + 0.1 * np.sin(TAU * 0.5 * t)) * (0.3 + 0.8 * low) * (1.0 + 0.6 * power)
    sub = np.tanh((1.0 + 2.0 * power) * sub) / np.tanh(1.0 + 2.0 * power)        # saturation adds the harmonics that make it feel big
    sub *= _pump(tl, 0.25 * pulse, 0.15) * (1 - 0.6 * landing)
    rumble = _lowpass(rng.standard_normal(tl.n), 110.0, 2.0)
    rumble /= rumble.std() + 1e-9
    sub = sub + 0.10 * low * rumble
    lfos = [(g, 0.75 + 0.25 * np.sin(TAU * rng.uniform(0.15, 0.7) * t + rng.uniform(0, TAU))) for g in (0.2, 0.8, 1.0, 0.6)]
    ratios = (4.0, 7.2, 9.2, 9.6)                                                 # ~215, 387, 495, 516 Hz at f0 = 54
    air = _band(rng.standard_normal(tl.n), 250.0, 1400.0)
    air /= air.std() + 1e-9
    drift = 0.5 + 0.5 * np.sin(TAU * 0.07 * t + rng.uniform(0, TAU))              # the pad's tone slowly opens and closes
    breath = 1 + 0.07 * np.sin(TAU * 0.11 * t)
    spread = 0.003 + 0.006 * power                                               # unison detune
    out = []
    for side in (-1, 1):                                                         # detuned L/R = width
        det = 1 + side * 0.0045
        pad = np.zeros(tl.n)
        for k, g in ((2, 1.0), (3, 0.6), (4, 0.4)):
            for v, vg in ((-1, 0.6 * power), (0, 1.0), (1, 0.6 * power)):
                if vg > 0.01:
                    pad += g * vg * _osc(np.full(tl.n, f0 * k * det * (1 + v * spread)), "saw")
        cluster = np.zeros(tl.n)
        for r, (g, lfo) in zip(ratios, lfos):
            cluster += g * lfo * _osc(np.full(tl.n, f0 * r * det * (1 + 0.002 * side)))
        fc = 260.0 + 1400.0 * bright
        dark, open_ = _lowpass(pad, fc, 3.0), _lowpass(pad, fc * 2.6, 3.0)
        mix = np.clip(0.5 * u + 0.35 * drift, 0.0, 1.0)
        pad = dark * (1 - mix) + open_ * mix
        tick = sum(_osc(np.full(tl.n, f0 * r * (1 + 0.003 * side))) for r in (7.2, 9.2)) * np.exp(-tl.tau / 0.03)
        body = 0.2 * pad / (1.0 + 0.8 * power) + (0.34 + 0.2 * bright) * cluster + (0.2 + 0.5 * pulse) * 0.9 * tick + 0.05 * bright * air
        body = 0.6 * body * _pump(tl, 0.8 * pulse, 0.07) * (1 - 0.35 * landing)
        body = np.tanh((1.0 + 1.5 * power) * body)                                # heavier, denser
        out.append((sub + body) * breath)
    return out[0], out[1]
