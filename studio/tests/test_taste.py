import random

import taste


def state(trashed=(), qa=(), crit=(), models=None):
    return {"trashed": list(trashed), "qa_failed": list(qa), "critic_failed": list(crit), "models": models or {}}


def test_plate_status_kept_when_not_trashed():
    assert taste.plate_status(state(), "a.jpg") == "kept"


def test_plate_status_priority_qa_then_critic_then_manual():
    st = state(trashed=["a", "b", "c"], qa=["a"], crit=["a", "b"])
    assert taste.plate_status(st, "a") == "qa_failed"
    assert taste.plate_status(st, "b") == "critic_failed"
    assert taste.plate_status(st, "c") == "trashed"


def test_qa_failed_only_counts_while_still_in_trash():
    # restored from trash => kept, even though it was once qa_failed
    assert taste.plate_status(state(qa=["a"]), "a") == "kept"


def test_model_stats_counts_and_keep_rate():
    st = state(trashed=["b", "c"], qa=["c"], models={"a": "m", "b": "m", "c": "m", "d": "m"})
    s = taste.model_stats(st)["m"]
    assert (s["n"], s["kept"], s["trashed"], s["qa_failed"]) == (4, 2, 1, 1)
    assert s["keep_rate"] == 0.5


def test_model_stats_score_is_weighted_and_shrunk():
    st = state(models={f"k{i}": "m" for i in range(10)})
    s = taste.model_stats(st)["m"]
    assert s["score"] == round(10 * 1.0 / (10 + 3), 3)
    assert taste.model_stats(st)["google/nano-banana-pro"]["keep_rate"] is None  # unseen candidate


def test_model_stats_unknown_models_are_included():
    assert "weird/model" in taste.model_stats(state(models={"a": "weird/model"}))


def test_pick_model_only_returns_auto_models():
    random.seed(1)
    picks = {taste.pick_model(state(models={"a": "krea/krea-3"}), explore=0.5) for _ in range(200)}
    assert picks <= set(taste.AUTO_MODELS)
    assert picks == set(taste.AUTO_MODELS)


def test_pick_model_exploits_best_score_when_not_exploring():
    st = state(models={f"k{i}": "google/nano-banana-2.1" for i in range(20)})
    assert all(taste.pick_model(st, explore=0.0) == "google/nano-banana-2.1" for _ in range(20))


def test_pick_model_explore_favors_undersampled():
    random.seed(0)
    st = state(models={f"k{i}": "google/nano-banana-pro" for i in range(300)})
    picks = [taste.pick_model(st, explore=1.0) for _ in range(300)]
    assert picks.count("google/nano-banana-2.1") > picks.count("google/nano-banana-pro")


def test_taste_brief_newest_first_and_capped():
    prompts = {f"p{i}.jpg": f"prompt {i}" for i in range(30)}
    titles = {k: f"T{k[1:-4]}" for k in prompts}
    st = state(trashed=[f"p{i}.jpg" for i in range(10, 30)])
    brief = taste.taste_brief(st, titles, prompts)
    assert [t for t, _ in brief["liked"]][0] == "T9"          # newest kept first
    assert len(brief["liked"]) == 6 and len(brief["disliked"]) == 14
    assert brief["disliked"][0] == "T29"


def test_taste_brief_ignores_qa_failures():
    st = state(trashed=["a.jpg"], qa=["a.jpg"])
    brief = taste.taste_brief(st, {"a.jpg": "A"}, {"a.jpg": "x"})
    assert brief == {"liked": [], "disliked": []}


def test_novelty_identical_is_zero_and_unrelated_is_one():
    assert taste.novelty("glass cube on concrete", ["glass cube on concrete"]) == 0.0
    assert taste.novelty("glass cube on concrete", ["wet orange fabric"]) == 1.0


def test_novelty_ignores_stopwords_and_empty():
    assert taste.novelty("the of and", ["anything"]) == 0.0
    assert taste.novelty("glass cube", []) == 1.0


def test_novelty_partial_overlap():
    n = taste.novelty("glass cube concrete", ["glass cube marble"])
    assert 0.0 < n < 1.0
