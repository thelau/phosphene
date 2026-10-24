import random

import diversity


def test_sample_shots_shape():
    shots = diversity.sample_shots(5)
    assert len(shots) == 5
    for s in shots:
        assert set(s) == set(diversity.AXES)
        for axis, pool in diversity.AXES.items():
            assert s[axis] in pool


def test_sample_shots_avoids_recent_values():
    random.seed(1)
    recent = {"camera": diversity.CAMERAS[:-1]}
    for s in diversity.sample_shots(1, recent):
        assert s["camera"] == diversity.CAMERAS[-1]


def test_sample_shots_no_repeat_within_batch_when_pool_allows():
    shots = diversity.sample_shots(len(diversity.CAMERAS))
    assert len({s["camera"] for s in shots}) == len(diversity.CAMERAS)


def test_sample_shots_falls_back_when_everything_is_recent():
    shots = diversity.sample_shots(2, {"camera": list(diversity.CAMERAS)})
    assert all(s["camera"] in diversity.CAMERAS for s in shots)


def test_describe_mentions_every_axis():
    s = diversity.sample_shots(1)[0]
    text = diversity.describe(s)
    for v in s.values():
        assert v in text


def test_pools_have_no_duplicates():
    for name, pool in diversity.AXES.items():
        assert len(pool) == len(set(pool)), name
