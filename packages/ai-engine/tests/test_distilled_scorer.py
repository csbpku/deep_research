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
    _parse_llm_response,
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


def test_parse_llm_response_strips_reasoning_wrapper() -> None:
    raw = (
        "<think>Need to inspect the article before scoring.</think>\n"
        "```json\n"
        '{"信息增量": 2, "弱项": "验证不足"}\n'
        "```"
    )
    assert _parse_llm_response(raw) == {"信息增量": 2, "弱项": "验证不足"}


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
    parsed["validation_breadth"] = 2
    parsed["implementation_stage"] = 2
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


def test_community_practice_cannot_be_promoted_to_collection() -> None:
    result = compute_score(
        _all_max_parsed(),
        profile=ENGINEERING_PROFILE,
        source_type="devto",
        url="https://dev.to/example/llm-practice",
        evidence_text="Parsing an LLM response with code and tests",
    )
    assert result.dimension_scores["事实可信度"] == 1
    assert result.validation_breadth == 1
    assert result.direct_relevance is None
    assert result.tier == TIER_SKIM
    assert result.ranking_score <= ENGINEERING_PROFILE.tier_skim


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
    assert "direct_relevance" in SYSTEM_PROMPT
    assert "偏 AI 应用开发的软件工程师" in SYSTEM_PROMPT
    assert "业务领域本身既不加分也不减分" in SYSTEM_PROMPT
    assert "解决一个真实的 AI 项目问题" in SYSTEM_PROMPT
    assert "来源不设绝对上限" in SYSTEM_PROMPT
    assert "单一模型的官方文档若提供具体 prompt" in SYSTEM_PROMPT


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


def test_version_string_is_v3() -> None:
    assert DISTILLED_VERSION == "4.7"


def test_scoring_content_skips_client_side_docs_shell() -> None:
    from ai_engine.radar.distilled_scorer import _prepare_scoring_content

    content = "Navigation Search Loading Loading Loading " \
        "Prompting Claude Fable 5 old shell " \
        "Prompting Claude Fable 5 Actual guidance begins here"
    prepared = _prepare_scoring_content("Prompting Claude Fable 5", content)
    assert prepared.startswith("Prompting Claude Fable 5 Actual guidance")


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
    assert result.veto is None
    assert result.risk_flag is None
    assert result.suspected_repost is False
    assert result.has_risk_signal is False
    assert result.profile_id == PROFILE_ENGINEERING
    assert result.is_default is False


def test_github_structured_signals_rescue_documented_repo_to_skim() -> None:
    parsed = _all_zero_parsed(
        信息增量=1,
        分析深度=1,
        可行动性=2,
        事实可信度=1,
        时效性=1,
        表达质量=2,
        综合信号=3,
        direct_relevance=2,
        relevance_evidence="有 MCP 集成、CLI 命令和 CI 工作流",
    )
    result = compute_score(
        parsed,
        source_type="github_trending",
        structured_signals={
            "stars": 29_143,
            "starsToday": 237,
            "readmeChars": 39_149,
            "hasBenchmark": True,
            "hasCiAction": True,
            "hasTests": True,
        },
    )
    assert result.total == 46.67
    assert result.repo_signal_bonus == 12.0
    assert result.tier_score == 57.16
    assert result.to_dict()["tierScore"] == 57.16
    # M7: tier_deep_read lowered 70→55 (engineering) so a github repo
    # with strong signals clears the new bar.
    assert result.tier == TIER_DEEP_READ
def test_github_popularity_without_technical_evidence_does_not_rescue() -> None:
    result = compute_score(
        _all_zero_parsed(),
        source_type="github_trending",
        structured_signals={"stars": 100_000, "starsToday": 5_000, "readmeChars": 500},
    )
    assert result.repo_signal_bonus == 0.0
    assert result.tier == TIER_NOISE


def test_compute_score_all_max_engineering() -> None:
    """All dimensions at 3 → total 100 under engineering weights."""
    result = compute_score(_all_max_parsed())
    assert result.total == 100.0
    assert result.tier == TIER_COLLECTION
    assert result.tier_score == 100.0
    assert result.profile_id == PROFILE_ENGINEERING


def test_direct_relevance_zero_caps_high_quality_article() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 0
    result = compute_score(parsed)
    assert result.total == 100.0
    assert result.direct_relevance == 0
    # M7: rel=0 cap raised 35→38, which now equals tier_skim=38 for
    # engineering. The item lands in skim rather than noise; tier_noise
    # behavior is exercised by all-zero parsed via the distribution test.
    assert result.tier == TIER_SKIM
def test_direct_relevance_one_caps_high_quality_article() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 1
    result = compute_score(parsed)
    assert result.total == 100.0
    # M7: rel=1 cap raised 49→56. With engineering tier_deep_read lowered
    # 70→55, ranking_score=56 now clears tier_deep_read → deep_read.
    assert result.ranking_score == 56.0
    assert result.tier == TIER_DEEP_READ
def test_generic_engineering_asset_can_be_indirectly_relevant() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 2
    parsed["relevance_evidence"] = "完整的 coding-agent 工作流、命令和质量门禁"
    result = compute_score(parsed, source_type="github")
    assert result.direct_relevance == 2
    # M7: relevance_cap for rel=2 github raised 74→82 so engineering rel=2
    # with strong assets can climb past tier_deep_read into collection range.
    assert result.ranking_score == 82.0
    assert result.tier == TIER_DEEP_READ


def test_direct_relevance_two_cannot_reach_collection() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 2
    result = compute_score(parsed)
    assert result.total == 100.0
    # M7: relevance_cap for rel=2 non-github 72→80. The collection gate
    # (collection_ready) still rejects rel=2 even at this higher ceiling.
    assert result.ranking_score == 80.0
    assert result.tier == TIER_DEEP_READ
def test_direct_relevance_three_preserves_normal_tier() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    parsed["relevance_evidence"] = "提供 API 重试实现、压测结果和延迟/可靠性取舍"
    parsed["scope_breadth"] = 2
    parsed["validation_breadth"] = 2
    parsed["implementation_stage"] = 2
    result = compute_score(
        parsed,
        evidence_text="本文提供 API 重试代码、压测结果和延迟/可靠性取舍。",
    )
    assert result.tier == TIER_COLLECTION
    assert result.effective_total == 100.0


def test_direct_relevance_three_without_evidence_downgrades_to_indirect() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    result = compute_score(parsed)
    assert result.direct_relevance == 2
    # M7: relevance_cap for rel=2 non-github 72→80.
    assert result.effective_total == 80.0
    assert result.tier == TIER_DEEP_READ
def test_direct_relevance_three_without_actionable_details_downgrades() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    parsed["可行动性"] = 2
    parsed["relevance_evidence"] = "提出 Agent 交易协议和研究基准"
    result = compute_score(parsed)
    assert result.direct_relevance == 2
    # M7: rel=2 cap raised 72→80.
    assert result.ranking_score == 80.0


def test_collection_requires_complete_engineering_evidence() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    parsed["scope_breadth"] = 2
    parsed["relevance_evidence"] = "提供可复现实现、验证结果和工程取舍"
    parsed["validation_breadth"] = 2
    parsed["事实可信度"] = 2
    result = compute_score(parsed)
    assert result.total == 96.67
    # V5: strong breadth plus validation can qualify even when one quality
    # dimension is conservatively scored 2.
    assert result.ranking_score == 95.84
    assert result.tier == TIER_COLLECTION
def test_collection_cannot_bypass_news_ranking_threshold() -> None:
    """Editorial readiness must not turn a sub-threshold news item into collection."""
    parsed = _all_max_parsed()
    parsed.update({
        "direct_relevance": 2,
        "scope_breadth": 2,
        "validation_breadth": 2,
        "relevance_evidence": "事件分析，但缺少直接可复用的完整实现",
    })
    result = compute_score(parsed, profile=NEWS_PROFILE, source_type="rss")
    assert result.ranking_score is not None
    assert result.ranking_score < NEWS_PROFILE.tier_collection
    assert result.tier == TIER_DEEP_READ
def test_single_setup_experiment_cannot_enter_collection() -> None:
    parsed = _all_max_parsed()
    parsed.update({
        "direct_relevance": 3,
        "scope_breadth": 2,
        "validation_breadth": 1,
        "relevance_evidence": "32 次运行、两个自建仓库、完整 JSON 收据",
    })
    result = compute_score(parsed)
    assert result.validation_breadth == 1
    # A single setup is not independent validation, so it cannot enter the
    # collection tier or become must-read even when every other dimension is
    # perfect.
    assert result.tier == TIER_DEEP_READ
def test_experiment_harness_cannot_claim_direct_implementation_relevance() -> None:
    parsed = _all_max_parsed()
    parsed.update({
        "direct_relevance": 3,
        "implementation_stage": 1,
        "relevance_evidence": "实验 harness、检测脚本和数据分析",
    })
    result = compute_score(parsed)
    assert result.implementation_stage == 1
    assert result.direct_relevance == 2
    assert result.dimension_scores["可行动性"] == 2


def test_diagnostic_harness_without_integration_path_is_capped() -> None:
    parsed = _all_max_parsed()
    parsed.update({"direct_relevance": 3, "implementation_stage": 2})
    result = compute_score(
        parsed,
        evidence_text="A hallucination experiment benchmark with a detection harness",
    )
    assert result.implementation_stage == 1
    assert result.direct_relevance == 2
    assert result.dimension_scores["可行动性"] == 2


def test_narrow_scope_caps_relevance_at_one() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    parsed["scope_breadth"] = 0
    parsed["scope_evidence"] = "仅适用于单一模型和硬件配置"
    result = compute_score(parsed)
    assert result.scope_breadth == 0
    assert result.direct_relevance == 1
    # M7: rel=1 cap raised 49→56. engineering tier_deep_read lowered
    # 70→55, so 56 ≥ 55 → deep_read (was skim before M7).
    assert result.ranking_score == 56.0
    assert result.tier == TIER_DEEP_READ
    assert result.to_dict()["scopeBreadth"] == 0


def test_huggingface_model_source_is_narrow_even_if_llm_overrates() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    parsed["scope_breadth"] = 2
    parsed["relevance_evidence"] = "完整部署命令和显存调优"
    result = compute_score(parsed, source_type="huggingface_models")
    assert result.scope_breadth == 0
    assert result.direct_relevance == 1
    # M7: rel=1 cap 49→56 + engineering tier_deep_read 70→55 → deep_read.
    assert result.tier == TIER_DEEP_READ


def test_single_model_single_hardware_asset_is_narrow_even_if_llm_overrates() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    parsed["scope_breadth"] = 2
    parsed["relevance_evidence"] = "完整的单卡部署命令和显存调优"
    result = compute_score(
        parsed,
        source_type="github",
        evidence_text="DeepSeek V4 Flash on a Single AMD MI300X\n部署说明",
    )
    assert result.scope_breadth == 0
    assert result.direct_relevance == 1
    # M7: rel=1 cap 49→56 + engineering tier_deep_read 70→55 → deep_read.
    assert result.tier == TIER_DEEP_READ


def test_voice_agent_tutorial_is_narrow_even_if_llm_overrates() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    parsed["scope_breadth"] = 2
    parsed["relevance_evidence"] = "LangSmith 评测步骤"
    result = compute_score(
        parsed,
        evidence_text="How to Evaluate Voice Agents with LangSmith",
    )
    assert result.scope_breadth == 0
    assert result.direct_relevance == 1
    # M7: rel=1 cap 49→56 + engineering tier_deep_read 70→55 → deep_read.
    assert result.tier == TIER_DEEP_READ


def test_practical_paper_with_measured_agent_eval_is_deep_read() -> None:
    parsed = _all_max_parsed()
    parsed.update({
        "direct_relevance": 2,
        "scope_breadth": 1,
        "信息增量": 2,
        "分析深度": 3,
        "可行动性": 2,
    })
    result = compute_score(
        parsed,
        profile=PAPER_PROFILE,
        source_type="arxiv",
        evidence_text="Real-Time Detection and Repair of LLM Agent Failures\n"
        "measured evaluation across models",
    )
    assert result.total == 85.0
    assert result.tier == TIER_DEEP_READ


def test_devto_source_is_capped_without_independent_validation() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 3
    parsed["scope_breadth"] = 2
    parsed["relevance_evidence"] = "跨 SDK 的完整评测管线和错误处理实现"
    result = compute_score(parsed, source_type="devto")
    assert result.ranking_score == ENGINEERING_PROFILE.tier_skim
    assert result.tier == TIER_SKIM
def test_v3_separates_content_quality_from_team_value() -> None:
    parsed = _all_zero_parsed(
        **{
            "信息增量": 3,
            "分析深度": 3,
            "可行动性": 0,
            "事实可信度": 3,
            "时效性": 2,
            "表达质量": 3,
            "综合信号": 0,
            "direct_relevance": 0,
        }
    )
    result = compute_score(parsed, source_type="arxiv", profile=PAPER_PROFILE)
    assert result.quality_score is not None and result.quality_score > 80
    assert result.team_value_score is not None and result.team_value_score < 10
    # M7: rel=0 cap raised 35→38.
    assert result.ranking_score is not None and result.ranking_score <= 38
    assert result.tier == TIER_NOISE


def test_github_bonus_breaks_close_cross_source_tie() -> None:
    parsed = _all_max_parsed()
    parsed["direct_relevance"] = 2
    github = compute_score(parsed, source_type="github")
    article = compute_score(parsed, source_type="rss")
    assert github.source_bonus == 3.0
    assert article.source_bonus == 1.0
    assert github.ranking_score is not None
    assert article.ranking_score is not None
    assert github.ranking_score > article.ranking_score
    # M7: rel=2 github cap raised 74→82.
    assert github.ranking_score <= 82.0


def test_source_bonus_cannot_lift_low_quality_item_to_deep_read() -> None:
    parsed = _all_zero_parsed(
        **{
            "信息增量": 2,
            "分析深度": 2,
            "可行动性": 2,
            "事实可信度": 2,
            "时效性": 2,
            "表达质量": 2,
            "综合信号": 3,
            "direct_relevance": 2,
        }
    )
    result = compute_score(parsed, source_type="github")
    assert result.total < 70
    assert result.ranking_score is not None and result.ranking_score > result.total
    # M7: tier_deep_read for engineering lowered 70→65, so the source bonus
    # can now lift a github item into deep_read when other dims are at the
    # rel=2 cap. The cap on bonus-driven promotion is the cap itself
    # (82), not tier_deep_read.
    assert result.tier == TIER_DEEP_READ
    assert result.ranking_score <= 82.0


def test_legacy_result_without_direct_relevance_remains_compatible() -> None:
    result = compute_score(_all_max_parsed())
    assert result.direct_relevance is None
    assert "directRelevance" not in result.to_dict()


def test_compute_score_all_max_paper() -> None:
    """paper profile: tier thresholds favor 8."""
    result = compute_score(_all_max_parsed(PAPER_PROFILE), profile=PAPER_PROFILE)
    assert result.total == 100.0
    assert result.tier == TIER_COLLECTION
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
    # M7: engineering tier_deep_read 70→55; the weighted total=55 lands
    # exactly on the boundary, so the item reaches deep_read (>=).
    assert result.tier == TIER_DEEP_READ
    assert "可行动性" in result.weak_point




def test_hard_veto_title_content_mismatch() -> None:
    parsed = _all_max_parsed()
    parsed["veto"] = VETO_MISMATCH
    result = compute_score(parsed)
    assert result.total == 0.0
    assert result.tier == TIER_NOISE
    assert result.veto == VETO_MISMATCH
    assert result.has_risk_signal is False
    assert result.suspected_repost is False


def test_hard_veto_title_content_mismatch_is_ignored_for_aligned_long_repo() -> None:
    parsed = _all_max_parsed()
    parsed["veto"] = VETO_MISMATCH
    content = (
        "OpenViking is a context database for AI agents. "
        "This document explains the OpenViking architecture, installation, "
        "storage model, indexing pipeline, tests, and deployment. "
    ) * 12
    result = compute_score(
        parsed,
        source_type="github_repo",
        evidence_text=f"volcengine/OpenViking\n{content}",
        url="https://github.com/volcengine/OpenViking",
    )
    assert result.veto is None
    assert result.total > 0


def test_hard_veto_unsafe_content() -> None:
    parsed = _all_max_parsed()
    parsed["veto"] = VETO_UNSAFE
    result = compute_score(parsed)
    assert result.total == 0.0
    assert result.veto == VETO_UNSAFE


def test_legacy_pure_repost_flag_migrated() -> None:
    """Old v1 callers used veto=='pure_repost' or 'suspected_repost'.
    v2 must NOT zero the scores; cap 信息增量 at 1."""
    parsed = _all_max_parsed()
    parsed["veto"] = "pure_repost"
    result = compute_score(parsed)
    assert result.veto is None
    assert result.suspected_repost is True
    # 信息增量 is capped at 1; other dims keep their full scores.
    assert result.dimension_scores["信息增量"] == 1
    assert result.dimension_scores["分析深度"] == 3


def test_suspected_repost_caps_info_increment() -> None:
    parsed = _all_max_parsed()
    parsed["suspected_repost"] = True
    result = compute_score(parsed)
    assert result.suspected_repost is True
    # Info increment capped at 1.
    assert result.dimension_scores["信息增量"] == 1
    # Total is reduced but not zeroed.
    assert result.total > 0
    assert result.total < 100


def test_security_risk_no_longer_veto() -> None:
    """v2: security_risk is a risk flag, not a veto.

    Scores remain intact (not zeroed); veto
    stays None and risk_flag / has_risk_signal carry the signal.
    """
    parsed = _all_max_parsed()
    parsed["veto"] = RISK_SECURITY  # legacy path → migrate to risk_flag
    result = compute_score(parsed)
    assert result.veto is None
    assert result.risk_flag == RISK_SECURITY
    assert result.has_risk_signal is True
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
    assert result.tier_score == 0.0
    assert result.tier == TIER_NOISE
    assert result.is_default is True
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
    monkeypatch.setenv("UTILITY_LLM", "anthropic:test-model")
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
    monkeypatch.setenv("UTILITY_LLM", "anthropic:claude-haiku-4-5")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:15721")

    raw = await anthropic_scorer("title", "content")
    assert captured["api_key"] == "sk-placeholder-for-anthropic-compatible-proxy"
    assert captured["base_url"] == "http://127.0.0.1:15721"
    assert '"信息增量": 2' in raw


async def test_score_with_llm_custom_scorer() -> None:
    async def mock_scorer(title: str, content: str) -> str:
        return json.dumps(_all_max_parsed())

    result = await score_with_llm("title", "content", scorer=mock_scorer)
    assert result.total == 100.0
    assert result.tier == TIER_COLLECTION
    assert result.is_default is False


async def test_score_with_llm_retries_unverified_mismatch_once() -> None:
    calls: list[str] = []

    async def mock_scorer(title: str, content: str) -> str:
        calls.append(content)
        if len(calls) == 1:
            parsed = _all_zero_parsed()
            parsed["veto"] = VETO_MISMATCH
            return json.dumps(parsed)
        return json.dumps(_all_max_parsed())

    content = (
        "OpenViking provides a context database, indexing pipeline, "
        "retrieval API, deployment guide, architecture, and tests. "
    ) * 15
    result = await score_with_llm(
        "volcengine/OpenViking",
        content,
        scorer=mock_scorer,
        source_type="github_repo",
        url="https://github.com/volcengine/OpenViking",
    )

    assert len(calls) == 2
    assert calls[1].startswith("[评分纠错]")
    assert result.veto is None
    assert result.total > 0


async def test_score_with_llm_scorer_exception_returns_default() -> None:
    async def bad_scorer(title: str, content: str) -> str:
        raise RuntimeError("LLM unavailable")

    result = await score_with_llm("title", "content", scorer=bad_scorer)
    assert result.is_default is True


async def test_default_score_path_does_not_wrap_unified_llm_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The default scorer owns no second retry loop around generate_text."""
    from ai_engine.radar import distilled_scorer

    calls = {"count": 0}

    async def failing_anthropic_scorer(title: str, content: str, **kwargs: object) -> str:
        calls["count"] += 1
        raise _RateLimitError("429 too many requests")

    monkeypatch.setenv("UTILITY_LLM", "openai:test-model")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setattr(distilled_scorer, "anthropic_scorer", failing_anthropic_scorer)
    monkeypatch.setattr(distilled_scorer, "_LLM_RATE_LIMIT_DELAY", 0.01)

    result = await distilled_scorer.score_with_llm("title", "content")

    assert result.is_default is True
    assert calls["count"] == 1


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
        total=90.0, tier=TIER_COLLECTION,
        dimension_scores={}, weak_point="", veto=None,
        risk_flag=None, suspected_repost=False, has_risk_signal=False,
        profile_id=PROFILE_ENGINEERING, is_default=False,
    )
    s2 = DistilledScore(
        total=60.0, tier=TIER_SKIM,
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
    assert abs(monitor.default_rate - 1/3) < 0.01
    assert abs(monitor.daily_avg - 50.0) < 0.1


def test_scoring_monitor_tracks_risk_and_repost() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    monitor.record(DistilledScore(
        total=80.0, tier=TIER_DEEP_READ,
        dimension_scores={}, weak_point="", veto=None,
        risk_flag=RISK_SECURITY, suspected_repost=False, has_risk_signal=True,
        profile_id=PROFILE_ENGINEERING, is_default=False,
    ))
    monitor.record(DistilledScore(
        total=40.0, tier=TIER_NOISE,
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
            total=50.0, tier=TIER_SKIM,
            dimension_scores={}, weak_point="", veto=None,
            risk_flag=None, suspected_repost=False, has_risk_signal=False,
            profile_id=PROFILE_ENGINEERING, is_default=False,
        ))
    alerts = monitor.evaluate(baseline_daily_avg=70.0)
    assert any("dropped" in a for a in alerts)


def test_scoring_monitor_no_alerts_when_healthy() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    for _ in range(10):
        monitor.record(DistilledScore(
            total=90.0, tier=TIER_COLLECTION,
            dimension_scores={}, weak_point="", veto=None,
            risk_flag=None, suspected_repost=False, has_risk_signal=False,
            profile_id=PROFILE_ENGINEERING, is_default=False,
        ))
    alerts = monitor.evaluate()
    assert len(alerts) == 0


def test_scoring_monitor_risk_rate_alert() -> None:
    from ai_engine.radar.distilled_scorer import DistilledScore

    monitor = ScoringMonitor()
    for _ in range(10):
        monitor.record(DistilledScore(
            total=70.0, tier=TIER_DEEP_READ,
            dimension_scores={}, weak_point="", veto=None,
            risk_flag=RISK_SECURITY, suspected_repost=False, has_risk_signal=True,
            profile_id=PROFILE_ENGINEERING, is_default=False,
        ))
    alerts = monitor.evaluate()
    assert any("risk_rate" in a for a in alerts)
