"""P1.8: gpt-researcher ceiling preset mapping + P1.12 internal source injection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from ai_engine.adapters.gpt_researcher import (
    _append_run_audit,
    _append_captured_evidence_to_context,
    _build_grounded_report_prompt,
    _format_internal_sources_for_query,
    _REPORT_LENGTH_PRESETS,
    _resolve_run_ceiling,
)
from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.states import AI_JOB_STEP
from ai_engine.reviewer import ReviewResult


def _make_job(report_length: str | None, max_urls: int | None = None):
    """Build a minimal _Job stub with just enough state for the ceiling."""

    class _StubRequest:
        def __init__(self, report_length: str | None, max_urls: int | None) -> None:
            self.report_length = report_length
            self.max_urls_to_scrape = max_urls

    class _StubJob:
        def __init__(self, request: _StubRequest) -> None:
            self.request = request

    return _StubJob(_StubRequest(report_length, max_urls))


def test_presets_cover_all_documented_lengths() -> None:
    assert set(_REPORT_LENGTH_PRESETS.keys()) == {"brief", "standard", "deep"}


@pytest.mark.parametrize(
    "report_length, expected_total_words, expected_max_urls, expected_max_search",
    [
        ("brief", 500, 5, 3),
        ("standard", 800, 10, 5),
        ("deep", 3600, 48, 10),
    ],
)
def test_resolve_returns_preset_values(
    report_length: str, expected_total_words: int, expected_max_urls: int, expected_max_search: int
) -> None:
    job = _make_job(report_length=report_length)
    ceiling = _resolve_run_ceiling(job)
    assert ceiling["total_words"] == expected_total_words
    assert ceiling["max_urls"] == expected_max_urls
    assert ceiling["max_search_results"] == expected_max_search


def test_resolve_falls_back_to_standard_on_unknown_length() -> None:
    job = _make_job(report_length="unsupported_size")
    ceiling = _resolve_run_ceiling(job)
    # Standard preset applies.
    assert ceiling["total_words"] == 800


def test_resolve_falls_back_to_standard_when_length_missing() -> None:
    job = _make_job(report_length=None)
    ceiling = _resolve_run_ceiling(job)
    assert ceiling == _REPORT_LENGTH_PRESETS["standard"]


def test_resolve_honours_explicit_max_urls_override() -> None:
    job = _make_job(report_length="deep", max_urls=15)
    ceiling = _resolve_run_ceiling(job)
    # Other ceilings stay "deep", but max_urls is clamped to the user request.
    assert ceiling["max_urls"] == 15
    assert ceiling["total_words"] == _REPORT_LENGTH_PRESETS["deep"]["total_words"]


def test_resolve_ignores_explicit_max_urls_outside_allowed_range() -> None:
    """Out-of-range overrides are dropped to keep the preset's safety cap."""
    job = _make_job(report_length="deep", max_urls=99)
    ceiling = _resolve_run_ceiling(job)
    assert ceiling["max_urls"] == _REPORT_LENGTH_PRESETS["deep"]["max_urls"]


# P1.12: research_report prompt now ingests resolved summary/research content.


@dataclass
class _FakeAdapterSource:
    title: str
    snippet: str
    source_ref: dict[str, Any]


def test_format_internal_sources_empty_when_no_sources() -> None:
    assert _format_internal_sources_for_query([]) == ""


def test_format_internal_sources_keeps_only_summary_research_refs() -> None:
    mixed = [
        _FakeAdapterSource(
            title="External news",
            snippet="Snippet",
            source_ref={"type": "url", "value": "https://example.com/x"},
        ),
        _FakeAdapterSource(
            title="Radar item",
            snippet="LLM agent update",
            source_ref={"type": "summary", "value": "uuid-1"},
        ),
    ]
    output = _format_internal_sources_for_query(mixed)
    assert "uuid-1" in output
    assert "https://example.com/x" not in output
    assert "[summary]" in output


def test_format_internal_sources_truncates_long_snippets() -> None:
    long_snippet = "x" * 5000
    sources = [_FakeAdapterSource(
        title="Radar item",
        snippet=long_snippet,
        source_ref={"type": "summary", "value": "uuid-1"},
    )]
    output = _format_internal_sources_for_query(sources)
    # Snippet must be trimmed to 2000 chars but the header and title still appear.
    assert "Radar item" in output
    assert long_snippet[:2000] in output
    assert long_snippet[2500:] not in output
    assert "pre-ingested radar items" in output


def test_append_run_audit_uses_pipeline_counters_not_model_text() -> None:
    report = "# 模型写出的报告\n\n模型声称本轮查了 999 个页面。"
    audited = _append_run_audit(
        report,
        {
            "mode": "deep",
            "rounds": 2,
            "totalBranches": 12,
            "pagesVisited": 37,
            "sourcesDiscovered": 30,
            "sourcesCaptured": 19,
            "retrieval": {
                "attempts": 122,
                "emptyResults": 82,
                "fallbackAttempts": 61,
                "primarySkipped": 59,
            },
            "sourceCoverage": {
                "claude": {"label": "Claude", "discovered": 11, "captured": 7},
                "gemini": {"label": "Gemini", "discovered": 10, "captured": 10},
                "chatgpt": {"label": "ChatGPT / OpenAI", "discovered": 9, "captured": 2},
            },
        },
        ReviewResult("review_unavailable", claims=()),
    )

    assert "实际打开过的页面：37 个" in audited
    assert "去重后记录的独立来源：30 个" in audited
    assert "已抓取可核对正文：19 条" in audited
    assert "检索请求：122 次；其中 82 次没有返回结果" in audited
    assert "主检索连续无结果后跳过 59 次" in audited
    assert "999 个页面" in audited  # model text remains narrative, not the audit


def test_report_writer_receives_captured_evidence_and_authoritative_run_facts() -> None:
    source = AdapterSource(
        source_ref={"type": "url", "value": "https://example.com/evidence"},
        canonical_key="https://example.com/evidence",
        title="Evidence page",
        snippet="The captured paragraph supports the decision.",
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
        evidence_status="fetched",
    )
    context = _append_captured_evidence_to_context(["research context"], [source])
    assert isinstance(context, list)
    packet = context[-1]
    assert "captured evidence packet" in packet
    assert "The captured paragraph supports the decision." in packet
    assert "https://example.com/evidence" in packet

    # The report writer must receive the bounded packet without the vendor's
    # unbounded branch context; otherwise it can cite a URL that was removed
    # from the final evidence ledger.
    bounded_context = _append_captured_evidence_to_context("", [source])
    assert isinstance(bounded_context, str)
    assert "research context" not in bounded_context
    assert "The captured paragraph supports the decision." in bounded_context

    prompt = _build_grounded_report_prompt(
        {
            "mode": "deep",
            "pagesVisited": 9,
            "sourcesDiscovered": 7,
            "retrieval": {"attempts": 11, "emptyResults": 2},
        },
        [source],
    )
    assert "实际打开过的页面：9 个" in prompt
    assert "去重后记录的独立来源：7 个" in prompt
    assert "已抓取可核对正文：1 条" in prompt
    assert "只能把已抓取正文中的内容写成事实" in prompt


def test_grounded_report_prompt_requires_a_decision_surface_for_comparisons() -> None:
    prompt = _build_grounded_report_prompt(
        {"mode": "deep", "pagesVisited": 18, "sourcesDiscovered": 15},
        [],
        topic="比较 Claude、Gemini 和 ChatGPT Deep Research 的研究体验",
    )

    assert "## 决策摘要" in prompt
    assert "## 对比矩阵" in prompt
    assert "## 分产品发现" in prompt
    assert "## 证据覆盖与冲突" in prompt
    assert "本轮未确认" in prompt
    assert "只输出报告正文" in prompt


def test_slides_prompt_has_a_page_level_content_contract() -> None:
    prompt = _build_grounded_report_prompt(
        {"mode": "bounded_sources", "pagesVisited": 1, "sourcesCaptured": 1},
        [],
        topic="评估一个 SDK",
        report_type="slides",
    )

    assert "## Slide 1: 页面标题" in prompt
    assert "每页最多 3 条短要点" in prompt
    assert "不要写长段落" in prompt
    assert "证据缺口与下一步" in prompt


def test_web_brief_prompt_is_not_a_slide_outline() -> None:
    prompt = _build_grounded_report_prompt(
        {"mode": "bounded_sources", "pagesVisited": 1, "sourcesCaptured": 1},
        [],
        topic="评估一个 SDK",
        report_type="web_brief",
    )

    assert "独立的网页简报" in prompt
    assert "## 决策摘要" in prompt
    assert "## 关键发现" in prompt
    assert "## 下一步行动" in prompt
    assert "不要使用 `Slide N` 标记" in prompt
