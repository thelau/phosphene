import subprocess
import wave

import numpy as np
import pytest

import beats

SR = 44100


def kick(n):
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * (50 * t + 90 * (1 - np.exp(-40 * t)) / 40)) * np.exp(-t * 18)


def click_track(times, total, seed=1, noise=0.02):
    rng = np.random.default_rng(seed)
    x = np.zeros(int(total * SR))
    k = kick(int(0.25 * SR))
    for t in times:
        i = int(t * SR)
        seg = k[:max(0, min(len(k), len(x) - i))]
        x[i:i + len(seg)] += seg
    x += noise * rng.standard_normal(len(x))
    return x / (np.abs(x).max() + 1e-9) * 0.8


def save(x, path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())
    return str(path)


@pytest.mark.parametrize("bpm,lead", [(100, 0.37), (128, 1.0), (90, 0.0), (140, 0.2)])
def test_a_steady_track_gets_its_tempo_and_beats_within_a_frame_of_video(bpm, lead, tmp_path):
    times = np.arange(lead, 20, 60 / bpm)
    a = beats.analyse(save(click_track(times, 20), tmp_path / "t.wav"))
    assert a["bpm"] == pytest.approx(bpm, rel=0.015)
    found = np.array(a["beats"])
    errs = [np.abs(found - t).min() for t in times[2:-2]]
    assert max(errs) < 1 / 30                                              # every beat lands within one frame at 30 fps
    assert a["duration"] == pytest.approx(20, abs=0.1)


def test_an_irregular_glitch_track_gets_its_hits_not_a_grid(tmp_path):
    rng = np.random.default_rng(2)
    t, times = 0.5, []
    while t < 20:
        times.append(t)
        t += rng.choice([0.11, 0.17, 0.23, 0.31, 0.07, 0.5])
    a = beats.analyse(save(click_track(times, 20), tmp_path / "g.wav"))
    found = np.array([h[0] for h in a["hits"]])
    truth = np.array(times)
    recall = np.mean([np.abs(found - t).min() < 0.03 for t in truth])
    precision = np.mean([np.abs(truth - f).min() < 0.03 for f in found])
    assert recall > 0.95 and precision > 0.8                                # nearly every hit found, few invented


def test_strong_hits_are_rated_stronger_than_weak_ones(tmp_path):
    x = np.zeros(int(8 * SR))
    for i, (t, amp) in enumerate([(1.0, 1.0), (2.0, 0.15), (3.0, 1.0), (4.0, 0.15), (5.0, 1.0)]):
        k = kick(int(0.25 * SR)) * amp
        x[int(t * SR):int(t * SR) + len(k)] += k
    a = beats.analyse(save(x / np.abs(x).max() * 0.8 + 0.0 * x, tmp_path / "s.wav"))
    def strength_at(t):
        return max(s for ht, s in a["hits"] if abs(ht - t) < 0.05)
    assert strength_at(1.0) > 3 * strength_at(2.0) and strength_at(3.0) > 3 * strength_at(4.0)       # a loud hit rates well above a quiet one


def test_mp3_is_read_too(tmp_path):
    times = np.arange(0.4, 12, 0.5)
    wav = save(click_track(times, 12), tmp_path / "t.wav")
    mp3 = tmp_path / "t.mp3"
    subprocess.run([beats.FFMPEG, "-v", "error", "-y", "-i", wav, "-b:a", "128k", str(mp3)], check=True)
    a = beats.analyse(str(mp3))
    assert a["bpm"] == pytest.approx(120, rel=0.02) and len(a["hits"]) >= 20


def test_something_that_is_not_audio_is_refused(tmp_path):
    bad = tmp_path / "x.mp3"
    bad.write_bytes(b"this is not music")
    with pytest.raises(RuntimeError, match="Could not read"):
        beats.analyse(str(bad))


def test_silence_has_no_hits(tmp_path):
    a = beats.analyse(save(np.zeros(int(6 * SR)) + 1e-4 * np.random.default_rng(0).standard_normal(int(6 * SR)), tmp_path / "q.wav"))
    assert len(a["hits"]) < 6


# ---------- notes: pitch changes, for music whose notes have no attack ----------

def legato_line(notes, total):
    """A saw wave that glides between notes in 8 ms with a constant level: no transients at all, only pitch."""
    n = int(total * SR)
    f = np.zeros(n)
    t, times = 0.0, []
    for midi, dur in notes:
        f[int(t * SR):min(n, int((t + dur) * SR))] = 440 * 2 ** ((midi - 69) / 12)
        times.append(t)
        t += dur
    k = int(0.008 * SR)
    f = np.convolve(f, np.ones(k) / k, mode="same")
    phase = np.cumsum(f) / SR
    return (2 * (phase % 1) - 1) * 0.5, times


def random_line(seed, seconds=15, pool=(36, 38, 41, 43, 46, 48, 50, 53), durs=(0.125, 0.18, 0.25, 0.375)):
    rng = np.random.default_rng(seed)
    notes, t, prev = [], 0.0, None
    while t < seconds + 1:
        m = int(rng.choice([p for p in pool if p != prev]))
        d = float(rng.choice(durs))
        notes.append((m, d))
        t += d
        prev = m
    x, times = legato_line(notes, t)
    return x[:int(seconds * SR)], [tt for tt in times if tt < seconds - 0.2]


def score(found, truth, tol=0.04):
    found, truth = np.array(found), np.array(truth)
    recall = np.mean([np.abs(found - t).min() < tol for t in truth])
    precision = np.mean([np.abs(truth - f).min() < tol for f in found]) if len(found) else 0.0
    return recall, precision


def test_a_legato_bass_line_gets_its_notes_exactly(tmp_path):
    x, times = random_line(3)
    a = beats.analyse(save(x, tmp_path / "bass.wav"))
    recall, precision = score([n[0] for n in a["notes"]], times[1:])
    assert recall > 0.97 and precision > 0.95                               # every note change found, none invented, within 40 ms


def test_notes_beat_hits_on_music_without_attacks(tmp_path):
    x, times = random_line(5)
    a = beats.analyse(save(x, tmp_path / "bass.wav"))
    n_rec, n_prec = score([n[0] for n in a["notes"]], times[1:])
    h_rec, h_prec = score([h[0] for h in a["hits"]], times[1:])
    assert n_prec > h_prec + 0.2 and n_rec >= h_rec - 0.05                  # hits find the changes too, but invent many more


def test_a_slow_glide_or_vibrato_is_not_a_new_note(tmp_path):
    t = np.arange(int(8 * SR)) / SR
    f = 110 * 2 ** (0.25 * np.sin(2 * np.pi * 5.5 * t) / 12)               # a quarter-semitone vibrato
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.5
    a = beats.analyse(save(x, tmp_path / "v.wav"))
    assert len(a["notes"]) <= 2                                             # the note starting, nothing more


def test_a_sustained_chord_change_in_the_bass_is_found(tmp_path):
    notes = [(36, 1.0), (43, 1.0), (41, 1.0), (36, 1.5)]
    x, times = legato_line(notes, 4.5)
    a = beats.analyse(save(x, tmp_path / "c.wav"))
    recall, precision = score([n[0] for n in a["notes"]], times[1:])
    assert recall == 1.0 and precision >= 0.75


def test_silence_has_no_notes(tmp_path):
    a = beats.analyse(save(np.zeros(int(5 * SR)) + 1e-4 * np.random.default_rng(1).standard_normal(int(5 * SR)), tmp_path / "q.wav"))
    assert a["notes"] == []
