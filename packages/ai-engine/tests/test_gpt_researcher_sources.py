"""Unit tests: gpt-researcher source collection mapping.

Regression: Week 10 AI research jobs failed with WORKER_RETRY_EXHAUSTED
because the adapter only read ``researcher.visited_urls`` while gpt-researcher
0.15.x stores scraped pages in ``researcher.get_research_sources()``.  These
tests pin the pure mapping so the DB CHECK (succeeded requires >=1 source)
stops being hit with an empty array.
"""

from ai_engine.adapters.gpt_researcher import _collect_sources_from_research
from ai_engine.adapters.gpt_researcher import (
    _append_references,
    _report_needs_completion,
    _strip_reference_section,
    _resolved_internal_sources,
    _strip_overlap,
)
from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.states import AI_JOB_STEP


def test_maps_captured_sources_with_title_and_snippet() -> None:
    sources = _collect_sources_from_research(
        [
            {
                "url": "https://a.example/post",
                "title": "A good post",
                "raw_content": "  first paragraph\nsecond paragraph  ",
            },
        ],
        [],
        "fallback topic",
    )

    assert len(sources) == 1
    source = sources[0]
    assert source.canonical_key == "https://a.example/post"
    assert source.source_ref == {"type": "url", "value": "https://a.example/post"}
    assert source.title == "A good post"
    assert source.snippet == "first paragraph second paragraph"
    assert source.is_accessible is True


def test_dedupes_and_uses_visited_urls_as_fallback() -> None:
    sources = _collect_sources_from_research(
        [
            {"url": "https://a.example/post", "title": "A", "raw_content": "x"},
            {"url": "https://a.example/post", "title": "duplicate", "raw_content": "y"},
            {"url": "https://b.example/other", "title": "B", "raw_content": ""},
            "not a dict",
        ],
        ["https://a.example/post", "https://c.example/page"],
        "fallback topic",
    )

    keys = [s.canonical_key for s in sources]
    assert keys == ["https://a.example/post", "https://b.example/other", "https://c.example/page"]
    assert sources[1].title == "B"
    assert sources[1].snippet is None
    assert sources[2].title == "fallback topic"


def test_empty_inputs_return_empty_list() -> None:
    assert _collect_sources_from_research([], [], "topic") == []


def test_maps_hydrated_internal_ref_into_grounded_adapter_source() -> None:
    sources = _resolved_internal_sources(({
        "type": "summary",
        "value": "2a3b9c83-d021-4f45-8cdd-f9f4668ff809",
        "required": True,
        "resolvedTitle": "Voice Agent evaluation",
        "resolvedSnippet": "Evaluate execution, outcomes, and conversation experience.",
    },))

    assert len(sources) == 1
    assert sources[0].title == "Voice Agent evaluation"
    assert sources[0].snippet == "Evaluate execution, outcomes, and conversation experience."
    assert sources[0].source_ref == {
        "type": "summary",
        "value": "2a3b9c83-d021-4f45-8cdd-f9f4668ff809",
        "required": True,
    }


def _source(url: str, title: str) -> AdapterSource:
    return AdapterSource(
        source_ref={"type": "url", "value": url},
        canonical_key=url,
        title=title,
        snippet=None,
        score=0.9,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
        is_accessible=True,
    )


def test_report_needs_completion_when_references_missing_and_tail_abrupt() -> None:
    report = "### 程序性记忆\n\n智能体依赖记忆来执行动作"
    assert _report_needs_completion(report, [_source("https://a.example", "A")]) is True


def test_report_needs_completion_false_when_references_present() -> None:
    report = "## 结论\n\n完整结论。\n\n## 参考文献\n\n1. [A](https://a.example)"
    assert _report_needs_completion(report, [_source("https://a.example", "A")]) is False


def test_append_references_uses_collected_sources() -> None:
    report = "正文已经完整。"
    completed = _append_references(
        report,
        [
            _source("https://a.example", "Source A"),
            _source("https://b.example", "Source B"),
        ],
    )
    assert "## 参考文献" in completed
    assert "[Source A](https://a.example)" in completed
    assert "[Source B](https://b.example)" in completed


def test_append_references_replaces_model_generated_reference_section() -> None:
    report = (
        "## 结论\n\n完整结论。\n\n## 参考文献\n\n"
        "1. 只有标题没有外链\n"
    )
    completed = _append_references(
        report,
        [_source("https://a.example", "Source A")],
    )
    assert "只有标题没有外链" not in completed
    assert completed.count("## 参考文献") == 1
    assert "[Source A](https://a.example)" in completed


def test_strip_reference_section_removes_existing_references_only() -> None:
    report = "正文\n\n## 参考文献\n\n1. old"
    assert _strip_reference_section(report) == "正文"


def test_strip_overlap_drops_repeated_tail_sentence() -> None:
    previous = "最后一句话"
    chunk = "最后一句话\n\n## 结论\n\n完整。"
    assert _strip_overlap(previous, chunk) == "## 结论\n\n完整。"
