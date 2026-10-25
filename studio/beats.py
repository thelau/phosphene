"""
Finds what to cut on in a music track (numpy; ffmpeg decodes any format).
  hits  - the transients (peaks of the onset curve), with their strength: the way to follow glitch / IDM, where there is no steady grid
  notes - where the pitch changes (a bass line, an arpeggio, a sequencer), found by following the fundamental: for music whose notes
          have soft attacks and so barely register as transients
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


PITCH_FRAME = 1536          # 70 ms: at least two periods of a 40 Hz bass
PITCH_MIN_HZ, PITCH_MAX_HZ = 40.0, 600.0


def pitch_track(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(midi, confidence) per frame (hop HOP): the strongest periodicity of the sound between 40 and 600 Hz, by autocorrelation
    (corrected for its natural fall-off, which would otherwise favour high octaves). Confidence 0 where nothing pitched is playing."""
    if len(x) < PITCH_FRAME * 2:
        return np.zeros(1), np.zeros(1)
    n = 1 + (len(x) - PITCH_FRAME) // HOP
    frames = np.lib.stride_tricks.as_strided(x, shape=(n, PITCH_FRAME), strides=(x.strides[0] * HOP, x.strides[0])).astype(np.float64)
    frames = (frames - frames.mean(axis=1, keepdims=True)) * np.hanning(PITCH_FRAME)
    size = 4096
    spec = np.fft.rfft(frames, size, axis=1)
    r = np.fft.irfft(np.abs(spec) ** 2, size, axis=1)
    lo, hi = int(SR / PITCH_MAX_HZ), int(SR / PITCH_MIN_HZ)
    r0 = r[:, 0] + 1e-12
    norm = r[:, lo - 1:hi + 2] / r0[:, None]
    lags = np.arange(lo - 1, hi + 2)
    # the window is a hann: undo its triangular-ish fall-off of the autocorrelation
    win_ac = np.fft.irfft(np.abs(np.fft.rfft(np.hanning(PITCH_FRAME), size)) ** 2, size)
    norm = norm / (win_ac[lags] / win_ac[0])[None, :]
    peaks = (norm[:, 1:-1] > norm[:, :-2]) & (norm[:, 1:-1] >= norm[:, 2:])
    score = np.where(peaks, norm[:, 1:-1], -1.0)
    best = score.max(axis=1)
    midi = np.zeros(n)
    conf = np.zeros(n)
    loud = np.sqrt(r0 / PITCH_FRAME)
    gate = loud > 0.02 * (np.percentile(loud, 95) + 1e-9)
    for i in range(n):
        if best[i] < 0.55 or not gate[i]:
            continue
        cand = np.flatnonzero(score[i] >= 0.9 * best[i])      # the shortest lag that is nearly as strong as the best: not a sub-harmonic
        j = cand[0]
        a, b, c = norm[i, j], norm[i, j + 1], norm[i, j + 2]
        shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
        lag = lags[j + 1] + float(np.clip(shift, -1, 1))
        midi[i] = 69 + 12 * np.log2((SR / lag) / 440.0)
        conf[i] = best[i]
    return midi, conf


def note_changes(midi: np.ndarray, conf: np.ndarray, min_jump: float = 0.7, hold: int = 3) -> list[tuple[float, float]]:
    """(time, strength) of every change of note: the pitch moving by at least min_jump semitones and staying there for `hold`
    frames, or a pitched sound starting after silence. Strength grows with the size of the jump."""
    voiced = conf > 0
    out: list[tuple[float, float]] = []
    cur = None
    i, n = 0, len(midi)
    while i < n:
        if not voiced[i]:
            if cur is not None and not voiced[i:i + hold].any():
                cur = None                                    # silence ends the note
            i += 1
            continue
        if cur is None:
            seg = midi[i:i + hold]
            if len(seg) == hold and voiced[i:i + hold].all() and np.ptp(seg) < min_jump:
                cur = float(np.median(seg))
                out.append((float(_t(i)), 0.5))
                i += hold
                continue
            i += 1
            continue
        if abs(midi[i] - cur) >= min_jump:
            seg = midi[i:i + hold]
            if len(seg) == hold and voiced[i:i + hold].all() and np.ptp(seg) < min_jump and abs(float(np.median(seg)) - cur) >= min_jump:
                out.append((float(_t(i)), float(min(1.0, 0.25 + abs(float(np.median(seg)) - cur) / 12.0))))
                cur = float(np.median(seg))
                i += hold
                continue
        else:
            cur = 0.9 * cur + 0.1 * float(midi[i])            # follow slow drift (vibrato, detune) without calling it a new note
        i += 1
    return out


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
    midi, conf = pitch_track(x)
    return {"duration": round(len(x) / SR, 3), "bpm": round(bpm, 2), "beats": [round(b, 4) for b in beats],
            "hits": [[round(t, 4), round(s, 2)] for t, s in hits(curve, raw, loud)],
            "notes": [[round(t, 4), round(s, 2)] for t, s in note_changes(midi, conf)]}
