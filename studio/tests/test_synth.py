import io
import wave

import numpy as np
import pytest

import synth


def decode(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (2, 2, synth.RATE)
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, 2).astype(np.float64) / 32768
    return x


def starts_for(seconds=6.0, n_images=30, paired=True):
    n = n_images * (2 if paired else 1)
    return [seconds * i / n for i in range(n + 1)]


def band_shares(x, a=0.0, b=None):
    m = x.mean(axis=1)[int(a * synth.RATE):None if b is None else int(b * synth.RATE)]
    X = np.abs(np.fft.rfft(m * np.hanning(len(m)))) ** 2
    f = np.fft.rfftfreq(len(m), 1 / synth.RATE)
    tot = X.sum()
    share = lambda lo, hi: X[(f >= lo) & (f < hi)].sum() / tot
    dom = f[(f > 25) & (f < 400)][X[(f > 25) & (f < 400)].argmax()]
    return {"sub": share(20, 80), "bass": share(80, 250), "mid": share(250, 2000), "high": share(2000, 20000), "dom": dom}


def side_mid(x):
    m, s = (x[:, 0] + x[:, 1]) / 2, (x[:, 0] - x[:, 1]) / 2
    return np.sqrt((s ** 2).mean()) / np.sqrt((m ** 2).mean())


def test_has_the_right_length_level_and_does_not_clip():
    starts = starts_for(5.0)
    x = decode(synth.render(starts, True))
    assert len(x) == int(round(starts[-1] * synth.RATE))
    rms = np.sqrt((x ** 2).mean())
    assert 0.1 < rms < 0.22                                        # as loud as the references (0.15-0.21)
    assert np.abs(x).max() <= 0.97 + 1e-3
    assert np.abs(x[-1]).max() < 0.02 and np.abs(x[0]).max() < 0.05  # faded, no clicks at the ends


def test_it_is_a_dark_wide_54hz_drone_like_soiltone_and_ecwora():
    x = decode(synth.render(starts_for(6.0), True))
    b = band_shares(x)
    assert 48 <= b["dom"] <= 62                                      # the reference: dominant ~54 Hz
    assert b["sub"] > 0.5 and b["high"] < 0.03                       # 65-70% of the energy below 80 Hz, almost nothing above 2 kHz
    assert 0.25 < side_mid(x) < 0.9                                  # wide stereo (reference 0.54)


def test_stays_in_that_family_whatever_the_settings():
    """Even with everything at the extremes it is still a low drone, not a different sound."""
    for kw in ({"space": 0.0, "power": 0.0}, {"space": 1.0, "power": 1.0}, {"low": 0.0}, {"bright": 1.0}):
        b = band_shares(decode(synth.render(starts_for(6.0), True, **kw)))
        assert b["sub"] + b["bass"] > 0.4 and b["high"] < 0.05, kw


def test_width_controls_the_stereo_spread():
    narrow = side_mid(decode(synth.render(starts_for(), True, width=0.0)))
    wide = side_mid(decode(synth.render(starts_for(), True, width=1.0)))
    assert wide > narrow + 0.2


def test_low_end_control_changes_how_much_sub_there_is():
    quiet = band_shares(decode(synth.render(starts_for(), True, low=0.0)))["sub"]
    loud = band_shares(decode(synth.render(starts_for(), True, low=1.0)))["sub"]
    assert loud > quiet + 0.1


def test_bright_control_opens_the_tone():
    dark = band_shares(decode(synth.render(starts_for(), True, bright=0.0)))
    open_ = band_shares(decode(synth.render(starts_for(), True, bright=1.0)))
    assert open_["mid"] > dark["mid"]


def test_space_adds_a_room_the_dry_sound_does_not_have():
    """A big room fills the middle of the spectrum in the quiet end of the clip; a dry one leaves it bare."""
    starts = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5]
    def tail_energy(space):
        x = decode(synth.render(starts, False, space=space, pulse=1.0)).mean(axis=1)
        X = np.fft.rfft(x[int(1.6 * synth.RATE):int(2.3 * synth.RATE)])
        f = np.fft.rfftfreq(len(x[int(1.6 * synth.RATE):int(2.3 * synth.RATE)]), 1 / synth.RATE)
        return np.abs(X[(f > 140) & (f < 1500)]).sum()
    assert tail_energy(1.0) > 1.5 * tail_energy(0.0)


def test_power_thickens_the_sound():
    """More power adds harmonics (saturation, unison): the energy above the fundamental's second harmonic grows."""
    def upper(power):
        x = decode(synth.render(starts_for(5.0), True, power=power, space=0.0)).mean(axis=1)
        X = np.abs(np.fft.rfft(x)) ** 2
        f = np.fft.rfftfreq(len(x), 1 / synth.RATE)
        return X[(f > 130) & (f < 1500)].sum() / X.sum()
    assert upper(1.0) > upper(0.0)


def test_the_bed_pumps_with_the_cuts_and_slows_when_the_cuts_slow():
    """With full pulse the body is louder at the start of a cut than at its end; with none there is no difference."""
    starts = [i * 0.5 for i in range(13)]

    def start_over_end(pulse):
        x = decode(synth.render(starts, False, pulse=pulse, width=0.0, space=0.0)).mean(axis=1)
        X = np.fft.rfft(x)
        f = np.fft.rfftfreq(len(x), 1 / synth.RATE)
        X[(f < 250) | (f > 2000)] = 0
        y = np.abs(np.fft.irfft(X, len(x)))
        r = synth.RATE
        head = np.mean([y[int((c + 0.005) * r):int((c + 0.065) * r)].mean() for c in starts[1:10]])
        tail = np.mean([y[int((c + 0.35) * r):int((c + 0.48) * r)].mean() for c in starts[1:10]])
        return head / tail
    assert start_over_end(1.0) > 1.4 and start_over_end(0.0) < 1.25


def test_the_landing_gives_way_the_last_hold_is_quieter():
    starts = [i * 0.1 for i in range(41)] + [4.0 + 2.5]           # forty short cuts, then one long final hold
    x = decode(synth.render(starts, False)).mean(axis=1)
    body = np.sqrt((x[int(2 * synth.RATE):int(3.5 * synth.RATE)] ** 2).mean())
    tail = np.sqrt((x[int(5.0 * synth.RATE):int(6.3 * synth.RATE)] ** 2).mean())
    assert tail < body


def test_the_variation_seed_changes_the_music_but_the_same_seed_is_identical():
    s = starts_for(4.0)
    a, b, c = (synth.render(s, True, seed=k) for k in (1, 1, 2))
    assert a == b and a != c


def test_a_single_cut_renders():
    assert len(decode(synth.render([0.0, 1.0]))) == synth.RATE
