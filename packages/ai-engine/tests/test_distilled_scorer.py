"""Unit tests for the Distilled 7-dimension scoring rubric (v2)."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest

from ai_engine.radar.distilled_scorer import (
    DIMENSIONS,
    DIM_NAMES,
    DISTILLED_VERSION,
    RISK_SECURITY,
    SERIAL_KEYS,
    SERIAL_KEY_TO_CN,
    ScoringMonitor,
    SYSTEM_PROMPT,
    TIER_COLLECTION,
    TIER_DEEP_READ,
    TIER_NOISE,
    TIER_SKIM,
    VETO_MISMATCH,
    VETO_UNSAFE,
    anthropic_scorer,
    build_user_prompt,
    compute_score,
    default_score,
    default_scorer,
    score_with_llm,
)
from ai_engine.scoring.scoring_profiles import (
    ENGINEERING_PROFILE,
    NEWS_PROFILE,
    PAPER_PROFILE,
    PROFILE_ENGINEERING,
    PROFILE_NEWS,
    PROFILE_PAPER,
    ScoringProfile,
    active_profile,
    get_profile,
    list_profiles,
)


class _RateLimitError(RuntimeError):
    status_code = 429


# ── Fixtures ──────────────────────────────────────────────────────


def _all_zero_parsed(**overrides: object) -> dict[str, object]:
    """Return a parsed LLM response with all dimensions 0 and the
    standard envelope fields. Tests override specific fields."""
    parsed: dict[str, object] = {name: 0 for name in DIM_NAMES}
    parsed["weak_point"] = ""
    parsed["veto"] = None
    parsed["risk_flag"] = None
    parsed["suspected_repost"] = False
    parsed.update(overrides)
    return parsed


def _all_max_parsed(profile: ScoringProfile = ENGINEERING_PROFILE) -> dict[str, object]:
    """Return a parsed LLM response with all dimensions 3 → total 100."""
    parsed: dict[str, object] = {name: 3 for name in DIM_NAMES}
    parsed["weak_point"] = ""
    parsed["veto"] = None
    parsed["risk_flag"] = None
    parsed["suspected_repost"] = False
    return parsed


# ── Profile sanity ────────────────────────────────────────────────


def test_three_profiles_defined() -> None:
    profiles = list_profiles()
    assert len(profiles) == 3
    ids = {p.id for p in profiles}
    assert ids == {PROFILE_PAPER, PROFILE_ENGINEERING, PROFILE_NEWS}


def test_profile_weights_sum_to_100() -> None:
    for profile in list_profiles():
        assert sum(profile.weights.values()) == 100, profile.id


def test_profile_weights_differ_per_audience() -> None:
    """paper > engineering on 分析深度; news > engineering on 时效性."""
    assert (
        PAPER_PROFILE.weights["分析深度"]
        > ENGINEERING_PROFILE.weights["分析深度"]
    )
    assert (
        NEWS_PROFILE.weights["时效性"]
        > ENGINEERING_PROFILE.weights["时效性"]
    )


def test_get_profile_legacy_tech_blog_maps_to_engineering() -> None:
    legacy = get_profile("tech_blog")
    assert legacy.id == PROFILE_ENGINEERING


def test_get_profile_unknown_falls_back_to_engineering() -> None:
    fallback = get_profile("unknown-profile")
    assert fallback.id == PROFILE_ENGINEERING


def test_get_profile_empty_id_raises() -> None:
    with pytest.raises(ValueError):
        get_profile("")


def test_active_profile_default_is_engineering() -> None:
    import os

    prev = os.environ.pop("SCORING_PROFILE", None)
    try:
        assert active_profile().id == PROFILE_ENGINEERING
    finally:
        if prev is not None:
            os.environ["SCORING_PROFILE"] = prev


def test_active_profile_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCORING_PROFILE", PROFILE_PAPER)
    assert active_profile().id == PROFILE_PAPER


# ── Dimensions / version / prompt ────────────────────────────────


def test_dimensions_have_correct_count() -> None:
    assert len(DIMENSIONS) == 7


def test_each_dimension_has_4_level_rubric() -> None:
    for d in DIMENSIONS:
        for level in range(4):
            assert level in d.rubric
            assert len(d.rubric[level]) >= 5


def test_system_prompt_is_strict() -> None:
    assert "严苛" in SYSTEM_PROMPT
    assert "标准太松" in SYSTEM_PROMPT


def test_user_prompt_contains_rubric_and_meta() -> None:
    prompt = build_user_prompt("Test Title", "Test content here")
    # v2 contextual meta must be present.
    assert "评分画像上下文" in prompt
    assert "current_date" in prompt
    # v2 veto text must mention hard veto / risk flag / suspected repost.
    assert "硬否决" in prompt
    assert "风险标记" in prompt
    assert "suspected_repost" in prompt
    # Backward-compatible rubric.
    assert "信息增量" in prompt
    assert "评分纪律" in prompt


def test_user_prompt_uses_active_profile_weights() -> None:
    import os

    prev = os.environ.pop("SCORING_PROFILE", None)
    try:
        prompt = build_user_prompt("title", "body")
        # engineering profile: 信息增量=25, 可行动性=25
        assert "信息增量（权重 25" in prompt
        assert "可行动性（权重 25" in prompt
    finally:
        if prev is not None:
            os.environ["SCORING_PROFILE"] = prev


def test_user_prompt_meta_includes_domain_published_current() -> None:
    published = datetime(2026, 7, 1, tzinfo=timezone.utc)
    prompt = build_user_prompt(
        "title",
        "body",
        source_type="arxiv",
        url="https://arxiv.org/abs/2401.01234",
        published_at=published,
        current_date=datetime(2026, 7, 30, tzinfo=timezone.utc),
    )
    assert "arxiv.org" in prompt
    assert "source_type" in prompt
    assert "2026-07-01" in prompt
    assert "2026-07-30" in prompt


def test_version_string_is_v2() -> None:
    assert DISTILLED_VERSION == "2.0"


# ── Serialization keys ────────────────────────────────────────────


def test_serial_keys_stable_english() -> None:
    assert SERIAL_KEYS["信息增量"] == "info_increment"
    assert SERIAL_KEYS["分析深度"] == "analysis_depth"
    assert SERIAL_KEYS["可行动性"] == "actionability"
    assert SERIAL_KEYS["事实可信度"] == "fact_credibility"
    assert SERIAL_KEYS["时效性"] == "timeliness"
    assert SERIAL_KEYS["表达质量"] == "expression_quality"
    assert SERIAL_KEYS["综合信号"] == "audience_fit"
    # Round-trip mapping.
    assert SERIAL_KEY_TO_CN["info_increment"] == "信息增量"
    assert SERIAL_KEY_TO_CN["audience_fit"] == "综合信号"


# ── Basic compute_score ───────────────────────────────────────────


def test_compute_score_all_zeros() -> None:
    parsed = _all_zero_parsed(weak_point="全部维度均为0")
    result = compute_score(parsed)
    assert result.total == 0.0
    assert result.tier == TIER_NOISE
    assert result.must_read is False
    assert result.veto is None
    assert result.risk_flag is None
    assert result.suspected_repost is False
    assert result.has_risk_signal is False
    assert result.profile_id == PROFILE_ENGINEERING
    assert result.is_default is False


def test_compute_score_all_max_engineering() -> None:
    """All dimensions at 3 → total 100 under engineering weights."""
    result = compute_score(_all_max_parsed())
    assert result.total == 100.0
    assert result.tier == TIER_COLLECTION
    assert result.must_read is True
    assert result.profile_id == PROFILE_ENGINEERING


def test_compute_score_all_max_paper() -> None:
    """paper profile: must_read_total=85, core_count=2."""
    result = compute_score(_all_max_parsed(PAPER_PROFILE), profile=PAPER_PROFILE)
    assert result.total == 100.0
    assert result.tier == TIER_COLLECTION
    assert result.must_read is True
    assert result.profile_id == PROFILE_PAPER


def test_compute_score_midrange() -> None:
    """Mix of 1s and 2s → skim or deep_read tier."""
    parsed = _all_zero_parsed(
        **{
            "信息增量": 2, "分析深度": 2, "可行动性": 1,
            "事实可信度": 2, "时效性": 2, "表达质量": 1, "综合信号": 1,
            "weak_point": "可行动性不足",
        }
    )
    result = compute_score(parsed)
    # engineering: 2*25/3 + 2*20/3 + 1*25/3 + 2*10/3 + 2*10/3 + 1*5/3 + 1*5/3
    # = 16.67 + 13.33 + 8.33 + 6.67 + 6.67 + 1.67 + 1.67 = 55.0
    assert 54 <= result.total <= 56
    assert result.tier == TIER_SKIM
    assert result.must_read is False
    assert "可行动性" in result.weak_point


# ── must_read precision ───────────────────────────────────────────


def test_must_read_requires_high_core_and_total() -> None:
    """High support dims but low core → not must_read even if total high."""
    parsed = _all_zero_parsed(
        **{
            "信息增量": 1, "分析深度": 1, "可行动性": 1,
            "事实可信度": 3, "时效性": 3, "表达质量": 3, "综合信号": 3,
            "weak_point": "core dims low",
        }
    )
    result = compute_score(parsed)
    # engineering weights → total well below 88.
    assert result.total < 88
    assert result.must_read is False


def test_must_read_with_two_core_at_2_engineering() -> None:
    """engineering profile: must_read_total=88, core_count=2.

    A response with two core dims at 3 and one at 1 reaches ~87 under
    engineering weights — below must_read_total → not must_read.
    """
    parsed = _all_zero_parsed(
        **{
            "信息增量": 3, "分析深度": 3, "可行动性": 1,
            "事实可信度": 3, "时效性": 3, "表达质量": 3, "综合信号": 3,
            "weak_point": "可行动性低",
        }
    )
    result = compute_score(parsed)
    # engineering: 3*25/3 + 3*20/3 + 1*25/3 + 3*10/3 + 3*10/3 + 3*5/3 + 3*5/3
    # = 25 + 20 + 8.33 + 10 + 10 + 5 + 5 = 83.33 → < 88
    assert result.total < 88
    assert result.must_read is False


def test_must_read_paper_lower_threshold() -> None:
    """paper profile: must_read_total=85, core_count=2.

    A paper-profile score of 85 with 2 core dims ≥ 2 must be must_read.
    Build a parsed that hits ~85 under paper weights.
    """
    # paper: 信息增量=30, 分析深度=30, 可行动性=10, 事实可信度=15,
    #        时效性=5, 表达质量=5, 综合信号=5
    parsed = _all_zero_parsed(
        **{
            "信息增量": 3, "分析深度": 2, "可行动性": 1,
            "事实可信度": 3, "时效性": 3, "表达质量": 2, "综合信号": 2,
            "weak_point": "",
        }
    )
    # 3*30/3 + 2*30/3 + 1*10/3 + 3*15/3 + 3*5/3 + 2*5/3 + 2*5/3
    # = 30 + 20 + 3.33 + 15 + 5 + 3.33 + 3.33 = 80.0
    result = compute_score(parsed, profile=PAPER_PROFILE)
    # Need total ≥ 85 → not yet. Bump 可行动性 to 2 to reach 83.33.
    parsed["可行动性"] = 2
    result = compute_score(parsed, profile=PAPER_PROFILE)
    # 30 + 20 + 6.67 + 15 + 5 + 3.33 + 3.33 = 83.33 — still < 85.
    # Add one more to 时效性 (5/3 = 1.67) → 85.0 → must_read.
    parsed["时效性"] = 3
    # Actually 3*5/3 = 5 — already at 3. Let's raise 综合信号 to 3.
    parsed["综合信号"] = 3
    result = compute_score(parsed, profile=PAPER_PROFILE)
    # 30 + 20 + 6.67 + 15 + 5 + 3.33 + 5 = 85.0
    assert result.total >= 85
    assert result.must_read is True


def test_must_read_news_requires_only_one_core() -> None:
    """news profile: must_read_core_count=1.

    Even if only one core dim is at 2, the score can still be must_read
    as long as total ≥ 85.
    """
    parsed = _all_zero_parsed(
        **{
            "信息增量": 2, "分析深度": 1, "可行动性": 1,
            "事实可信度": 3, "时效性": 3, "表达质量": 3, "综合信号": 3,
            "weak_point": "",
        }
    )
    result = compute_score(parsed, profile=NEWS_PROFILE)
    # news: 2*15/3 + 1*10/3 + 1*10/3 + 3*15/3 + 3*25/3 + 3*10/3 + 3*15/3
    # = 10 + 3.33 + 3.33 + 15 + 25 + 10 + 15 = 81.66
    # Boost by raising 信息增量 to 3 → 86.66 → must_read (1 core dim ≥ 2)
    parsed["信息增量"] = 3
    result = compute_score(parsed, profile=NEWS_PROFILE)
    assert result.total >= 85
    assert result.must_read is True


# ── Hard veto / risk flag / repost flag ───────────────────────────


def test_hard_veto_title_content_mismatch() -> None:
    parsed = _all_max_parsed()
    parsed["veto"] = VETO_MISMATCH
    result = compute_score(parsed)
    assert result.total == 0.0
    assert result.tier == TIER_NOISE
    assert result.must_read is False
    assert result.veto == VETO_MISMATCH
    assert result.has_risk_signal is False
    assert result.suspected_repost is False


def test_hard_veto_unsafe_content() -> None:
    parsed = _all_max_parsed()
    parsed["veto"] = VETO_UNSAFE
    result = compute_score(parsed)
    assert result.total == 0.0
    assert result.veto == VETO_UNSAFE


def test_legacy_pure_repost_flag_migrated() -> None:
    """Old v1 callers used veto=='pure_repost' or 'suspected_repost'.
    v2 must NOT zero the scores; cap 信息增量 at 1 and force
    must_read=False."""
    parsed = _all_max_parsed()
    parsed["veto"] = "pure_repost"
    result = compute_score(parsed)
    assert result.veto is None
    assert result.suspected_repost is True
    assert result.must_read is False
    # 信息增量 is capped at 1; other dims keep their full scores.
    assert result.dimension_scores["信息增量"] == 1
    assert result.dimension_scores["分析深度"] == 3


def test_suspected_repost_caps_info_increment() -> None:
    parsed = _all_max_parsed()
    parsed["suspected_repost"] = True
    result = compute_score(parsed)
    assert result.suspected_repost is True
    assert result.must_read is False
    # Info increment capped at 1.
    assert result.dimension_scores["信息增量"] == 1
    # Total is reduced but not zeroed.
    assert result.total > 0
    assert result.total < 100


def test_security_risk_no_longer_veto() -> None:
    """v2: security_risk is a risk flag, not a veto.

    Scores remain intact (not zeroed); must_read is forced False; veto
    stays None and risk_flag / has_risk_signal carry the signal.
    """
    parsed = _all_max_parsed()
    parsed["veto"] = RISK_SECURITY  # legacy path → migrate to risk_flag
    result = compute_score(parsed)
    assert result.veto is None
    assert result.risk_flag == RISK_SECURITY
    assert result.has_risk_signal is True
    assert result.must_read is False
    # Scores are NOT zeroed.
    assert result.dimension_scores["信息增量"] == 3
    assert result.total > 80


def test_risk_flag_via_explicit_field() -> None:
    parsed = _all_max_parsed()
    parsed["risk_flag"] = RISK_SECURITY
    parsed["veto"] = None
    result = compute_score(parsed)
    assert result.risk_flag == RISK_SECURITY
    assert result.has_risk_signal is True
    assert result.veto is None
    assert result.must_read is False


def test_unknown_veto_ignored() -> None:
    """Unknown veto string is treated as None (not migrated to risk_flag)."""
    parsed = _all_max_parsed()
    parsed["veto"] = "unknown_veto"
    result = compute_score(parsed)
    assert result.total == 100.0
    assert result.veto is None
    assert result.risk_flag is None


def test_legacy_security_risk_in_veto_field_treated_as_risk() -> None:
    parsed = _all_max_parsed()
    parsed["veto"] = "security_risk"  # legacy exact
    result = compute_score(parsed)
    assert result.veto is None
    assert result.risk_flag == RISK_SECURITY
    assert result.has_risk_signal is True


# ── Clamping / normalization ──────────────────────────────────────


def test_invalid_dimension_scores_clamped() -> None:
    """Non-integer or out-of-range values are clamped to 0–3."""
    parsed = _all_zero_parsed(
        **{
            "信息增量": 5,        # > 3, clamped to 3
            "分析深度": -1,       # < 0, clamped to 0
            "可行动性": "bad",    # non-int, clamped to 0
            "事实可信度": 2,
            "时效性": 2,
            "表达质量": 2,
            "综合信号": 2,
            "weak_point": "",
        }
    )
    result = compute_score(parsed)
    assert result.dimension_scores["信息增量"] == 3
    assert result.dimension_scores["分析深度"] == 0
    assert result.dimension_scores["可行动性"] == 0


def test_english_alias_keys_resolve() -> None:
    """English serial keys (overall_signal / novelty / etc.) map to
    canonical Chinese dimensions so cross-system outputs still parse."""
    parsed: dict[str, object] = {
        "novelty": 3,
        "depth": 2,
        "actionability": 2,
        "credibility": 3,
        "timeliness": 3,
        "expression": 2,
        "overall_signal": 3,
        "weak_point": "",
        "veto": None,
        "risk_flag": None,
        "suspected_repost": False,
    }
    result = compute_score(parsed)
    assert result.dimension_scores["信息增量"] == 3
    assert result.dimension_scores["分析深度"] == 2
    assert result.dimension_scores["综合信号"] == 3


def test_unknown_keys_are_ignored() -> None:
    parsed = _all_zero_parsed(garbage_field=5, another_one="hi")
    result = compute_score(parsed)
    # All canonical dims stay 0.
    assert all(v == 0 for v in result.dimension_scores.values())


def test_weak_point_auto_generated_when_empty() -> None:
    parsed = _all_zero_parsed(
        **{
            "信息增量": 3, "分析深度": 3, "可行动性": 1,
            "事实可信度": 3, "时效性": 3, "表达质量": 3, "综合信号": 3,
            "weak_point": "",
        }
    )
    result = compute_score(parsed)
    assert "可行动性" in result.weak_point


# ── default_score / score_with_llm ────────────────────────────────


def test_default_score() -> None:
    result = default_score()
    assert result.total == 0.0
    assert result.tier == TIER_NOISE
    assert result.is_default is True
    assert result.must_read is False
    assert all(v == 0 for v in result.dimension_scores.values())
    assert result.profile_id == PROFILE_ENGINEERING


def test_default_score_uses_active_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SCORING_PROFILE", PROFILE_PAPER)
    result = default_score()
    assert result.profile_id == PROFILE_PAPER


async def test_score_with_llm_no_api_key_returns_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When no ANTHROPIC_API_KEY is set, returns default score."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    result = await score_with_llm("title", "content")
    assert result.is_default is True
    assert result.total == 0.0


async def test_score_with_llm_local_proxy_empty_key_proceeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Empty key + local proxy base URL must not short-circuit to default."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:15721")

    async def fake_scorer(title: str, content: str) -> str:
        return json.dumps(_all_max_parsed())

    result = await score_with_llm("title", "content", scorer=fake_scorer)
    assert result.is_default is False


async def test_anthropic_scorer_substitutes_placeholder_for_empty_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """anthropic_scorer sends a non-empty placeholder key to local proxies."""
    captured: dict[str, object] = {}

    class _Block:
        type = "text"
        text = (
            '{"信息增量": 2, "分析深度": 2, "可行动性": 2, "事实可信度": 2, '
            '"时效性": 2, "表达质量": 2, "综合信号": 2, "weak_point": "", '
            '"veto": null, "risk_flag": null, "suspected_repost": false}'
        )

    class _Message:
        content = [_Block()]

    class _Messages:
        async def create(self, **kwargs: object) -> _Message:
            captured.update(kwargs)
            return _Message()

    class _Client:
        def __init__(self, **kwargs: object) -> None:
            captured["api_key"] = kwargs.get("api_key")
            captured["base_url"] = kwargs.get("base_url")

        messages = _Messages()

    monkeypatch.setattr("anthropic.AsyncAnthropic", _Client)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:15721")

    raw = await anthropic_scorer("title", "content")
    assert captured["api_key"] == "sk-placeholder-for-cc-switch"
    assert captured["base_url"] == "http://127.0.0.1:15721"
    assert '"信息增量": 2' in raw


async def test_score_with_llm_custom_scorer() -> None:
    async def mock_scorer(title: str, content: str) -> str:
        return json.dumps(_all_max_parsed())

    result = await score_with_llm("title", "content", scorer=mock_scorer)
    assert result.total == 100.0
    assert result.tier == TIER_COLLECTION
    assert result.must_read is True
    assert result.is_default is False


async def test_score_with_llm_scorer_exception_returns_default() -> None:
    async def bad_scorer(title: str, content: str) -> str:
        raise RuntimeError("LLM unavailable")

    result = await score_with_llm("title", "content", scorer=bad_scorer)
    assert result.is_default is True


async def test_score_with_llm_strips_markdown_fences() -> None:
    payload = json.dumps(_all_max_parsed())
    async def fenced_scorer(title: str, content: str) -> str:
        return f"```json\n{payload}\n```"

    result = await score_with_llm("title", "content", scorer=fenced_scorer)
    assert result.is_default is False
    assert result.total > 0


async def test_default_scorer_returns_all_zeros() -> None:
    raw = await default_scorer("title", "content")
    parsed = json.loads(raw)
    for name in DIM_NAMES:
        assert parsed[name] == 0
    assert parsed["veto"] is None
    assert parsed["risk_flag"] is None
    assert parsed["suspected_repost"] is False


async def test_score_with_llm_passes_profile_to_compute(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """score_with_llm propagates the active profile to compute_score."""
    monkeypatch.setenv("SCORING_PROFILE", PROFILE_PAPER)
    async def mock_scorer(title: str, content: str) -> str:
        return json.dumps(_all_max_parsed(PAPER_PROFILE))

    result = await score_with_llm("title", "content", scorer=mock_scorer)
    assert result.profile_id == PROFILE_PAPER


async def test_score_with_llm_retries_on_429_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.radar import distilled_scorer

    monkeypatch.setattr(distilled_scorer, "_LLM_RATE_LIMIT_DELAY", 0.01)
    calls = {"count": 0}

    async def flaky_scorer(title: str, content: str) -> str:
        calls["count"] += 1
        if calls["count"] <= 2:
            raise _RateLimitError("rate limited")
        return json.dumps(_all_max_parsed())

    result = await score_with_llm("title", "content", scorer=flaky_scorer)
    assert calls["count"] == 3
    assert result.is_default is False
    assert result.total == 100.0


async def test_score_with_llm_429_exhausted_returns_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.radar import distilled_scorer

    monkeypatch.setattr(distilled_scorer, "_LLM_RATE_LIMIT_DELAY", 0.01)
    calls = {"count": 0}

    async def always_429(title: str, content: str) -> str:
        calls["count"] += 1
        raise _RateLimitError("429 too many requests")

    result = await score_with_llm("title", "content", scorer=always_429)
    assert result.is_default is True
    assert calls["count"] == distilled_scorer._LLM_RATE_LIMIT_MAX_RETRIES + 1


async def test_score_with_llm_limits_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.radar import distilled_scorer

    semaphore = asyncio.Semaphore(2)
    monkeypatch.setitem(
        distilled_scorer._loop_score_semaphores,
        asyncio.get_running_loop(),
        semaphore,
    )
    active = 0
    max_active = 0
    payload = json.dumps(_all_max_parsed())

    async def slow_scorer(title: str, content: str) -> str:
        nonlocal active, max_active
        active += 1
        max_active = max(max_active, active)
        await asyncio.sleep(0.05)
        active -= 1
        return payload

    results = await asyncio.gather(
        *(score_with_llm("title", "content", scorer=slow_scorer) for _ in range(8))
    )
    assert max_active <= 2
    assert all(r.is_default is False for r in results)


# ── ScoringMonitor ────────────────────────────────────────────────


def test_scoring_monitor_tracks_metrics() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    s1 = DistilledScore(
        total=90.0, tier=TIER_COLLECTION, must_read=True,
        dimension_scores={}, weak_point="", veto=None,
        risk_flag=None, suspected_repost=False, has_risk_signal=False,
        profile_id=PROFILE_ENGINEERING, is_default=False,
    )
    s2 = DistilledScore(
        total=60.0, tier=TIER_SKIM, must_read=False,
        dimension_scores={}, weak_point="", veto=None,
        risk_flag=None, suspected_repost=False, has_risk_signal=False,
        profile_id=PROFILE_ENGINEERING, is_default=False,
    )
    s3 = default_score()
    monitor.record(s1)
    monitor.record(s2)
    monitor.record(s3)
    assert monitor.total_count == 3
    assert monitor.default_count == 1
    assert monitor.must_read_count == 1
    assert abs(monitor.default_rate - 1/3) < 0.01
    assert abs(monitor.must_read_rate - 1/3) < 0.01
    assert abs(monitor.daily_avg - 50.0) < 0.1


def test_scoring_monitor_tracks_risk_and_repost() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    monitor.record(DistilledScore(
        total=80.0, tier=TIER_DEEP_READ, must_read=False,
        dimension_scores={}, weak_point="", veto=None,
        risk_flag=RISK_SECURITY, suspected_repost=False, has_risk_signal=True,
        profile_id=PROFILE_ENGINEERING, is_default=False,
    ))
    monitor.record(DistilledScore(
        total=40.0, tier=TIER_NOISE, must_read=False,
        dimension_scores={}, weak_point="", veto=None,
        risk_flag=None, suspected_repost=True, has_risk_signal=False,
        profile_id=PROFILE_ENGINEERING, is_default=False,
    ))
    assert monitor.risk_count == 1
    assert monitor.repost_count == 1
    assert monitor.risk_rate == 0.5
    assert monitor.repost_rate == 0.5


def test_scoring_monitor_alerts() -> None:
    monitor = ScoringMonitor()
    for _ in range(20):
        monitor.record(default_score())
    alerts = monitor.evaluate()
    assert any("default_rate" in a for a in alerts)


def test_scoring_monitor_baseline_drift_alert() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    for _ in range(10):
        monitor.record(DistilledScore(
            total=50.0, tier=TIER_SKIM, must_read=False,
            dimension_scores={}, weak_point="", veto=None,
            risk_flag=None, suspected_repost=False, has_risk_signal=False,
            profile_id=PROFILE_ENGINEERING, is_default=False,
        ))
    alerts = monitor.evaluate(baseline_daily_avg=70.0)
    assert any("dropped" in a for a in alerts)


def test_scoring_monitor_must_read_rate_alert() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    for _ in range(10):
        monitor.record(DistilledScore(
            total=50.0, tier=TIER_SKIM, must_read=False,
            dimension_scores={}, weak_point="", veto=None,
            risk_flag=None, suspected_repost=False, has_risk_signal=False,
            profile_id=PROFILE_ENGINEERING, is_default=False,
        ))
    alerts = monitor.evaluate(baseline_must_read_rate=0.5)
    assert any("must_read_rate" in a for a in alerts)


def test_scoring_monitor_no_alerts_when_healthy() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    for _ in range(10):
        monitor.record(DistilledScore(
            total=90.0, tier=TIER_COLLECTION, must_read=True,
            dimension_scores={}, weak_point="", veto=None,
            risk_flag=None, suspected_repost=False, has_risk_signal=False,
            profile_id=PROFILE_ENGINEERING, is_default=False,
        ))
    alerts = monitor.evaluate(baseline_daily_avg=88.0, baseline_must_read_rate=0.9)
    assert len(alerts) == 0


def test_scoring_monitor_risk_rate_alert() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    for _ in range(10):
        monitor.record(DistilledScore(
            total=70.0, tier=TIER_DEEP_READ, must_read=False,
            dimension_scores={}, weak_point="", veto=None,
            risk_flag=RISK_SECURITY, suspected_repost=False, has_risk_signal=True,
            profile_id=PROFILE_ENGINEERING, is_default=False,
        ))
    alerts = monitor.evaluate()
    assert any("risk_rate" in a for a in alerts)
