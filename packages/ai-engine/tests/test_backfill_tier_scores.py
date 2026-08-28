from scripts.backfill_tier_scores import reconstruct_tier_score


def test_reconstructs_noise_score_below_ranking_uplift() -> None:
    assert reconstruct_tier_score(
        {"total": 35.0, "rankingScore": 52.33},
        "noise",
        "engineering",
    ) == 35.0


def test_preserves_old_threshold_score_without_fabricated_downgrade() -> None:
    assert reconstruct_tier_score(
        {"total": 38.0, "rankingScore": 38.0},
        "noise",
        "engineering",
    ) == 38.0


def test_includes_bounded_repo_signal_bonus() -> None:
    assert reconstruct_tier_score(
        {"total": 46.67, "rankingScore": 57.16, "repoSignalBonus": 12.0},
        "deep_read",
        "engineering",
    ) == 57.16


def test_restores_upward_editorial_override() -> None:
    assert reconstruct_tier_score(
        {"total": 50.0, "rankingScore": 58.0},
        "deep_read",
        "paper",
    ) == 60.0
