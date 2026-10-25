"""
Finds what to cut on in a music track (numpy; ffmpeg decodes any format).
  hits  - the transients (peaks of the onset curve), with their strength: the way to follow glitch / IDM, where there is no steady grid
  beats - a tracked beat grid (tempo from the onset curve's autocorrelation, then dynamic programming as in Ellis 2007): for regular music
Times are seconds from the start of the file.
"""
import subprocess

import numpy as np

SR = 22050
N_FFT = 1024
HOP = 256            # 11.6 ms: fine enough to place a cut within a frame of video at 30 fps
FFMPEG = "/opt/homebrew/bin/ffmpeg"
MAX_SECONDS = 600


def decode(path: str) -> np.ndarray:
    """Mono float32 at SR, first MAX_SECONDS."""
    p = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-vn", "-t", str(MAX_SECONDS), "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
                       capture_output=True)
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError("Could not read that audio file: " + p.stderr.decode("utf-8", "replace")[-200:])
    return np.frombuffer(p.stdout, dtype="<f4").astype(np.float32)


MIN_STRENGTH = 0.06  # relative to the loud end of the track
FLUX_FLOOR = 6.0     # raw spectral flux below this is noise (silence measures ~2, a hit in a quiet passage 20+)


def onset_curve(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(normalised, raw, loudness): spectral flux of the log spectrum. The normalised one is set against its own surroundings
    (about 0 = nothing, 3+ = a clear hit) and finds the peaks; the raw one separates music from noise; the loudness curve is the
    same flux without the log, so a loud hit rates higher than a quiet one."""
    if len(x) < N_FFT * 2:
        return np.zeros(1), np.zeros(1), np.zeros(1)
    n = 1 + (len(x) - N_FFT) // HOP
    frames = np.lib.stride_tricks.as_strided(x, shape=(n, N_FFT), strides=(x.strides[0] * HOP, x.strides[0]))
    mag = np.abs(np.fft.rfft(frames * np.hanning(N_FFT).astype(np.float32), axis=1))[:, : int(6000 / (SR / N_FFT))]
    spec = np.log1p(30.0 * mag)
    flux = np.maximum(spec[1:] - spec[:-1], 0).sum(axis=1)
    lin = np.concatenate([[0.0], np.maximum(mag[1:] - mag[:-1], 0).sum(axis=1)])
    lin = np.convolve(lin, [0.25, 0.5, 0.25], mode="same")
    flux = np.concatenate([[0.0], flux])
    flux = np.convolve(flux, [0.25, 0.5, 0.25], mode="same")
    w = int(0.6 * SR / HOP)
    k = np.ones(w) / w
    mean = np.convolve(flux, k, mode="same")
    std = np.sqrt(np.maximum(np.convolve((flux - mean) ** 2, k, mode="same"), 1e-9))
    return (flux - mean) / (std + 1e-3 * (flux.max() + 1e-9)), flux, lin


def _t(frame) -> float:
    return (np.asarray(frame) * HOP + N_FFT / 2) / SR


def hits(curve: np.ndarray, raw: np.ndarray, loud: np.ndarray, floor: float = 0.6) -> list[tuple[float, float]]:
    """(time, strength) of every local peak of the onset curve above `floor`, a hit at least 40 ms from a stronger one.
    Strength is the loudness of the rise against the track's loud end (1.0 = as strong as its strongest hits), not the local contrast."""
    side = int(0.04 * SR / HOP)
    top = float(np.percentile(loud, 99.5)) or 1.0
    peaks = [i for i in range(side, len(curve) - side)
             if curve[i] > floor and raw[i] >= FLUX_FLOOR and curve[i] == curve[i - side:i + side + 1].max()]
    out = [(float(_t(i)), float(loud[i] / top)) for i in peaks]
    return [h for h in out if h[1] >= MIN_STRENGTH]       # the faint echoes of a hit's own decay are not hits


def tempo(curve: np.ndarray) -> float:
    """BPM from the autocorrelation of the onset curve, weighted towards 120."""
    fps = SR / HOP
    c = np.maximum(curve, 0)
    c = c - c.mean()
    n = len(c)
    size = 1 << int(np.ceil(np.log2(2 * n)))
    ac = np.fft.irfft(np.abs(np.fft.rfft(c, size)) ** 2, size)[:n]
    best, best_score = 120.0, -1.0
    for bpm in np.arange(70.0, 200.0, 0.25):
        lag = fps * 60.0 / bpm
        i = int(lag)
        if i + 1 >= n:
            break
        v = ac[i] * (1 - (lag - i)) + ac[i + 1] * (lag - i)
        v += 0.5 * ac[min(n - 1, int(2 * lag))] + 0.25 * ac[min(n - 1, int(4 * lag))]      # the beat repeats at 2 and 4 periods
        v *= np.exp(-0.5 * (np.log2(bpm / 120.0) / 0.9) ** 2)
        if v > best_score:
            best, best_score = float(bpm), v
    return best


def track_beats(curve: np.ndarray, bpm: float) -> list[float]:
    """Dynamic programming beat tracker: each beat lands on a strong onset about one period after the last."""
    fps = SR / HOP
    period = fps * 60.0 / bpm
    c = np.maximum(curve, 0)
    n = len(c)
    if n < 4 * period:
        return []
    lags = np.arange(int(round(period * 0.6)), int(round(period * 1.6)) + 1)
    penalty = -100.0 * np.log(lags / period) ** 2
    score = c.copy()
    prev = np.full(n, -1, dtype=int)
    for t in range(n):
        lo = t - lags[-1]
        if lo < 0 and t < lags[0]:
            continue
        idx = t - lags
        ok = idx >= 0
        if not ok.any():
            continue
        cand = score[idx[ok]] + penalty[ok]
        j = int(cand.argmax())
        if cand[j] > 0:
            score[t] = c[t] + cand[j]
            prev[t] = idx[ok][j]
    t = int(np.argmax(score[max(0, n - int(2 * period)):]) + max(0, n - int(2 * period)))
    out = []
    while t >= 0:
        out.append(t)
        t = prev[t]
    out.reverse()
    return [float(_t(i)) for i in out]


def analyse(path: str) -> dict:
    x = decode(path)
    curve, raw, loud = onset_curve(x)
    bpm = tempo(curve)
    beats = track_beats(curve, bpm)
    if len(beats) > 4:                                   # the tempo the tracker actually followed (a fit over all beats, not one gap)
        bpm = float(60.0 / np.polyfit(np.arange(len(beats)), beats, 1)[0])
    return {"duration": round(len(x) / SR, 3), "bpm": round(bpm, 2), "beats": [round(b, 4) for b in beats],
            "hits": [[round(t, 4), round(s, 2)] for t, s in hits(curve, raw, loud)]}
