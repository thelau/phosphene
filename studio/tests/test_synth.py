import io
import math
import struct
import wave

import synth


def samples(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, synth.RATE)
        raw = w.readframes(w.getnframes())
    return struct.unpack(f"<{len(raw) // 2}h", raw)


def rms(xs, a, b):
    seg = xs[int(a * synth.RATE):int(b * synth.RATE)]
    return math.sqrt(sum(x * x for x in seg) / max(1, len(seg)))


def test_length_matches_the_timeline_and_does_not_clip():
    starts = [i * 0.4 for i in range(11)]
    xs = samples(synth.render(starts))
    assert len(xs) == int(starts[-1] * synth.RATE)
    assert 8000 < max(abs(x) for x in xs) <= 32767
    assert abs(xs[-1]) < 800                                     # fades out instead of ending on a click


def test_every_cut_gets_a_hit_on_the_beat():
    starts = [i * 0.4 for i in range(12)]
    xs = samples(synth.render(starts))
    for t in starts[1:8]:
        assert rms(xs, t, t + 0.04) > 2.5 * rms(xs, t - 0.04, t), t


def test_hits_follow_uneven_cuts_too():
    """A tempo curve: the hits move with the cuts."""
    d = [0.5, 0.5, 0.5, 0.25, 0.25, 0.25, 0.25, 0.9, 1.5]
    starts = [0.0]
    for x in d:
        starts.append(starts[-1] + x)
    xs = samples(synth.render(starts))
    for t in starts[1:7]:
        assert rms(xs, t, t + 0.04) > 2 * rms(xs, t - 0.04, t), t


def test_the_final_hold_has_the_loudest_hit_and_rings():
    starts = [i * 0.4 for i in range(9)] + [3.2 + 2.0]
    xs = samples(synth.render(starts))
    last = starts[-2]
    assert rms(xs, last, last + 0.2) > rms(xs, 1.2, 1.4)
    assert rms(xs, last + 0.5, last + 0.9) > rms(xs, 0.0, 0.0 + 0.0001) and rms(xs, last + 0.5, last + 0.9) > 200


def test_inverted_copies_hit_softer_than_the_original():
    starts = [i * 0.5 for i in range(13)]
    xs = samples(synth.render(starts, paired=True))
    orig = rms(xs, 1.0, 1.04)        # cut 2: an original
    copy = rms(xs, 1.5, 1.54)        # cut 3: its inverted copy
    assert orig > copy


def test_deterministic():
    starts = [i * 0.3 for i in range(8)]
    assert synth.render(starts) == synth.render(starts)


def test_a_single_cut_renders():
    assert len(samples(synth.render([0.0, 1.0]))) == synth.RATE
