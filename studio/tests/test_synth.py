import io
import wave

import numpy as np
import pytest

import rhythm
import synth


def decode(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (2, 2, synth.RATE)
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, 2).astype(np.float64) / 32768
    return x


def starts_for(seconds=6.0, n_images=30, rhythm_mode="land", paired=True):
    s = rhythm.cut_starts(n_images * (2 if paired else 1), rhythm_mode, paired)
    k = seconds / s[-1]
    return [v * k for v in s]


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


@pytest.mark.parametrize("style", synth.STYLES)
def test_every_style_has_the_right_length_level_and_does_not_clip(style):
    starts = starts_for(5.0)
    x = decode(synth.render(starts, True, style=style))
    assert len(x) == int(round(starts[-1] * synth.RATE))
    rms = np.sqrt((x ** 2).mean())
    assert 0.1 < rms < 0.22                                        # as loud as the references (0.15-0.21)
    assert np.abs(x).max() <= 0.97 + 1e-3
    assert np.abs(x[-1]).max() < 0.02 and np.abs(x[0]).max() < 0.05  # faded, no clicks at the ends


@pytest.mark.parametrize("style", synth.STYLES)
def test_dark_like_the_references_almost_nothing_above_2khz(style):
    b = band_shares(decode(synth.render(starts_for(6.0), True, style=style)))
    assert b["high"] < 0.05 and b["sub"] + b["bass"] > 0.55


def test_soil_is_a_wide_54hz_drone():
    x = decode(synth.render(starts_for(), True, style="soil", width=0.6))
    b = band_shares(x)
    assert 48 <= b["dom"] <= 62 and b["sub"] > 0.45                  # Soiltone / Ecwora: dominant ~54 Hz, 65-70% of the energy below 80 Hz
    assert 0.25 < side_mid(x) < 0.9                                  # wide stereo (reference 0.54)


def test_swell_is_a_mono_43hz_sub():
    x = decode(synth.render(starts_for(8.0), True, style="swell", width=0.6))
    b = band_shares(x)
    assert 41 <= b["dom"] <= 46 and b["sub"] > 0.6                  # Helione: 43 Hz, ~80% below 80 Hz
    assert side_mid(x) < 0.2                                         # nearly mono (reference 0.09)


def test_bass_line_sits_in_the_bass_band_and_is_mono():
    x = decode(synth.render(starts_for(6.0), True, style="bass"))
    b = band_shares(x)
    assert b["bass"] > 0.3 and b["bass"] + b["mid"] > b["sub"] * 0.8
    assert side_mid(x) < 0.15


def test_width_controls_the_stereo_spread():
    narrow = side_mid(decode(synth.render(starts_for(), True, style="soil", width=0.0)))
    wide = side_mid(decode(synth.render(starts_for(), True, style="soil", width=1.0)))
    assert wide > narrow + 0.2


def test_low_end_control_changes_how_much_sub_there_is():
    quiet = band_shares(decode(synth.render(starts_for(), True, style="soil", low=0.0)))["sub"]
    loud = band_shares(decode(synth.render(starts_for(), True, style="soil", low=1.0)))["sub"]
    assert loud > quiet + 0.1


def test_bright_control_opens_the_tone():
    dark = band_shares(decode(synth.render(starts_for(), True, style="swell", bright=0.0)))
    open_ = band_shares(decode(synth.render(starts_for(), True, style="swell", bright=1.0)))
    assert open_["high"] > dark["high"] * 1.5


def test_the_bed_pumps_with_the_cuts_and_slows_when_the_cuts_slow():
    """With full pulse the body is louder at the start of a cut than at its end; with none there is no difference."""
    starts = [i * 0.5 for i in range(13)]

    def start_over_end(pulse):
        x = decode(synth.render(starts, False, style="soil", pulse=pulse, width=0.0)).mean(axis=1)
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
    starts = starts_for(8.0)
    x = decode(synth.render(starts, True, style="soil")).mean(axis=1)
    last = starts[-3]
    body = np.sqrt((x[int(3 * synth.RATE):int(5 * synth.RATE)] ** 2).mean())
    tail = np.sqrt((x[int((last + 0.8) * synth.RATE):int((starts[-1] - 0.15) * synth.RATE)] ** 2).mean())
    assert tail < body


def test_the_variation_seed_changes_the_music_but_the_same_seed_is_identical():
    s = starts_for(4.0)
    a, b, c = (synth.render(s, True, style="bass", seed=k) for k in (1, 1, 2))
    assert a == b and a != c


def test_unknown_style_falls_back_and_a_single_cut_renders():
    assert synth.render([0.0, 1.0], False, style="nonsense")
    assert len(decode(synth.render([0.0, 1.0]))) == synth.RATE
