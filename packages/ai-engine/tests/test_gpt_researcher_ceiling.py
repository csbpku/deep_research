"""P1.8: gpt-researcher ceiling preset mapping + P1.12 internal source injection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from ai_engine.adapters.gpt_researcher import (
    _format_internal_sources_for_query,
    _REPORT_LENGTH_PRESETS,
    _resolve_run_ceiling,
)


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
        ("deep", 2000, 25, 8),
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
