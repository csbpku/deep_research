"""Unit tests: gpt-researcher source collection mapping.

Regression: Week 10 AI research jobs failed with WORKER_RETRY_EXHAUSTED
because the adapter only read ``researcher.visited_urls`` while gpt-researcher
0.15.x stores scraped pages in ``researcher.get_research_sources()``.  These
tests pin the pure mapping so the DB CHECK (succeeded requires >=1 source)
stops being hit with an empty array.
"""

import asyncio
import importlib
from types import SimpleNamespace

import pytest

from ai_engine.adapters.gpt_researcher import _collect_sources_from_research
from ai_engine.adapters.gpt_researcher import (
    _append_references,
    _ACTIVE_RESEARCH_JOB,
    _clean_report_output,
    _format_source_lines,
    _mark_unresolved_claims,
    _DEEP_RESEARCH_SETTINGS,
    _captured_sources,
    _materialize_evidence_citations,
    _hydrate_source_snippets,
    _merge_sources,
    _official_query_domains,
    _official_source_coverage,
    _official_source_seeds,
    _official_source_scope,
    _official_lane_queries,
    _repair_official_source_coverage,
    _canonicalize_web_url,
    _filter_sources_to_query_domains,
    _Job,
    _StepCaptureLogHandler,
    _TruthyVisitedUrls,
    _adaptive_deep_stop_reason,
    _deep_collection_timeout_seconds,
    _install_adaptive_deep_research,
    _should_use_deep_research,
    _record_retrieval_event,
    _resolve_retriever_selection,
    _ScopedDuckduckgo,
    _ResilientTavilySearch,
    _filter_search_results_by_topic,
    GptResearcherAdapter,
    _ensure_complete_report,
    _report_needs_completion,
    _report_has_narrative,
    _report_write_timeout_seconds,
    _write_report_with_bounded_client,
    _fact_review_timeout_seconds,
    _evidence_digest_report,
    _strip_reference_section,
    _resolved_internal_sources,
    _sources_from_researcher,
    _select_research_sources,
    _strip_overlap,
)
from ai_engine.adapters.base import AdapterSource, ResearchRequest
from ai_engine.contracts.states import AI_JOB_STEP, AI_JOB_STATUS, SOURCE_POLICY
from ai_engine.fetcher.safe_fetch import FetchedDocument
from ai_engine.reviewer import ClaimVerdict


def test_deep_research_modules_use_the_bounded_llm_helper() -> None:
    """Keep recursive planner calls on the adapter's bounded retry path."""
    adapter_module = importlib.import_module("ai_engine.adapters.gpt_researcher")
    for module_name in (
        "gpt_researcher.utils.llm",
        "gpt_researcher.agent",
        "gpt_researcher.skills.deep_research",
        "gpt_researcher.actions.query_processing",
    ):
        module = importlib.import_module(module_name)
        assert getattr(module, "create_chat_completion") is adapter_module._bounded_create_chat_completion


@pytest.mark.asyncio
async def test_locked_user_sources_are_fetched_without_open_web_search(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = AdapterSource(
        source_ref={"type": "url", "value": "https://docs.example.com/selected"},
        canonical_key="https://docs.example.com/selected",
        title="Selected documentation",
        snippet="The selected page contains the evidence needed for this brief.",
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
    )
    seen: list[str] = []

    async def fake_fetch(ref: dict[str, object], *, request_id: str | None = None) -> SimpleNamespace:
        seen.append(str(ref["value"]))
        return SimpleNamespace(is_accessible=True, adapter_source=source)

    monkeypatch.setattr(
        "ai_engine.fetcher.ai_source_urls._fetch_user_url",
        fake_fetch,
    )
    request = ResearchRequest(
        job_id="locked-source-job",
        request_id="locked-source-request",
        topic="只阅读用户指定的资料",
        context=None,
        report_type="web_brief",
        source_policy=SOURCE_POLICY["ONLY_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(
            {"type": "url", "value": "https://docs.example.com/selected", "required": True},
        ),
        timeout_seconds=60,
    )
    job = _Job(request)
    adapter = object.__new__(GptResearcherAdapter)

    loaded = await adapter._load_locked_user_sources(job)

    assert loaded is not None
    assert seen == ["https://docs.example.com/selected"]
    assert [item.canonical_key for item in loaded] == ["https://docs.example.com/selected"]
    assert job.research_progress["mode"] == "bounded_sources"
    assert job.research_progress["scope"] == "only_user_sources"
    assert job.research_progress["sourcesCaptured"] == 1


def test_deep_collection_timeout_is_independent_and_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DEEP_RESEARCH_COLLECTION_TIMEOUT_SECONDS", raising=False)
    assert _deep_collection_timeout_seconds() == 900

    monkeypatch.setenv("DEEP_RESEARCH_COLLECTION_TIMEOUT_SECONDS", "600")
    assert _deep_collection_timeout_seconds() == 600

    monkeypatch.setenv("DEEP_RESEARCH_COLLECTION_TIMEOUT_SECONDS", "30")
    assert _deep_collection_timeout_seconds() == 120

    monkeypatch.setenv("DEEP_RESEARCH_COLLECTION_TIMEOUT_SECONDS", "99999")
    assert _deep_collection_timeout_seconds() == 1500


def test_report_narrative_check_rejects_audit_and_references_only() -> None:
    report = """## 本轮运行审计
- 研究模式：深度研究

## 参考文献
1. [来源](https://example.com)
"""

    assert _report_has_narrative(report) is False


def test_report_narrative_check_rejects_a_repair_refusal() -> None:
    report = (
        '您的消息中"报告："部分的内容为空，我无法直接进行修订。'
        "请粘贴原始报告正文。"
    )

    assert _report_has_narrative(report) is False


def test_report_narrative_check_rejects_a_long_evidence_digest() -> None:
    report = (
        "# GraphRAG 选型\n\n"
        "> 本轮已完成资料检索，但报告模型没有返回可发布的研究正文。\n\n"
        "## 已抓取证据\n\n"
        + ("这是很多原文摘录。" * 200)
        + "\n\n## 待核验项\n\n- 研究结论：待补写"
    )

    assert _report_has_narrative(report) is False


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, 180), ("15", 30), ("900", 600), ("invalid", 180)],
)
def test_report_writer_timeout_is_bounded(
    monkeypatch: pytest.MonkeyPatch,
    raw: str | None,
    expected: int,
) -> None:
    if raw is None:
        monkeypatch.delenv("DEEP_REPORT_WRITE_TIMEOUT_SECONDS", raising=False)
    else:
        monkeypatch.setenv("DEEP_REPORT_WRITE_TIMEOUT_SECONDS", raw)

    assert _report_write_timeout_seconds() == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, 180), ("15", 30), ("900", 600), ("invalid", 180)],
)
def test_fact_review_timeout_is_bounded(
    monkeypatch: pytest.MonkeyPatch,
    raw: str | None,
    expected: int,
) -> None:
    if raw is None:
        monkeypatch.delenv("FACT_REVIEW_TIMEOUT_SECONDS", raising=False)
    else:
        monkeypatch.setenv("FACT_REVIEW_TIMEOUT_SECONDS", raw)

    assert _fact_review_timeout_seconds() == expected


@pytest.mark.asyncio
async def test_report_writer_uses_cancellable_provider_neutral_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}

    async def fake_generate_text(**kwargs: object) -> SimpleNamespace:
        seen.update(kwargs)
        return SimpleNamespace(text="# 研究稿\n\n这是可阅读的正文。")

    monkeypatch.setattr("ai_engine.llm.client.generate_text", fake_generate_text)
    monkeypatch.setattr(
        "ai_engine.adapters.gpt_researcher._report_write_timeout_seconds",
        lambda: 30,
    )

    result = await _write_report_with_bounded_client(
        llm_spec="minimax:test-model",
        topic="timeout boundary",
        context="[S1] Official source\n原文摘录：captured",
        prompt="只使用证据包写报告。",
        report_length="standard",
        request_id="writer-test",
    )

    assert result.startswith("# 研究稿")
    assert seen["llm_spec"] == "minimax:test-model"
    assert seen["tier"] == "heavy"
    assert seen["request_id"] == "writer-test"
    assert "captured" in str(seen["user_prompt"])


@pytest.mark.asyncio
async def test_report_writer_timeout_returns_empty_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def slow_generate_text(**_: object) -> SimpleNamespace:
        await asyncio.sleep(30)
        return SimpleNamespace(text="# unreachable")

    monkeypatch.setattr("ai_engine.llm.client.generate_text", slow_generate_text)
    monkeypatch.setattr(
        "ai_engine.adapters.gpt_researcher._report_write_timeout_seconds",
        lambda: 1,
    )

    result = await _write_report_with_bounded_client(
        llm_spec="minimax:test-model",
        topic="timeout boundary",
        context="[S1] Official source",
        prompt="只使用证据包写报告。",
        report_length="standard",
        request_id="writer-timeout-test",
    )

    assert result == ""


@pytest.mark.asyncio
async def test_blank_report_skips_continuation_and_reaches_grounded_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _source(
        "https://example.com/official",
        "Official guide",
        "The official guide describes the supported workflow.",
    )

    async def fail_if_called(*_: object, **__: object) -> str:
        raise AssertionError("a blank report must not be continued")

    monkeypatch.setattr(
        "ai_engine.adapters.gpt_researcher._request_report_continuation",
        fail_if_called,
    )

    result = await _ensure_complete_report(SimpleNamespace(), "", [source])

    assert "## 参考文献" in result
    assert "https://example.com/official" in result


def test_evidence_digest_is_a_readable_fallback_not_a_fake_conclusion() -> None:
    source = AdapterSource(
        source_ref={"type": "url", "value": "https://example.com/official"},
        canonical_key="https://example.com/official",
        title="Official guide",
        snippet="The official guide describes the supported workflow.",
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
    )

    digest = _evidence_digest_report("research fallback", [source])

    assert "## 已抓取证据" in digest
    assert "The official guide describes" in digest
    assert "没有形成基于证据的完整综合结论" in digest


@pytest.mark.asyncio
async def test_bounded_llm_helper_stops_quota_failure_after_one_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter_module = importlib.import_module("ai_engine.adapters.gpt_researcher")
    calls = 0

    class QuotaError(Exception):
        status_code = 429

    class QuotaProvider:
        async def get_chat_response(self, *_args: object, **_kwargs: object) -> str:
            nonlocal calls
            calls += 1
            raise QuotaError("usage limit reached")

    monkeypatch.setattr(
        adapter_module._llm_mod,
        "get_llm",
        lambda *_args, **_kwargs: QuotaProvider(),
    )

    with pytest.raises(RuntimeError, match="Failed to get response"):
        await adapter_module._bounded_create_chat_completion(
            messages=[{"role": "user", "content": "test"}],
            model="test-model",
            llm_provider="openai",
        )

    assert calls == 1


@pytest.mark.asyncio
async def test_background_stream_without_websocket_uses_normal_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    adapter_module = importlib.import_module("ai_engine.adapters.gpt_researcher")
    stream_flags: list[bool] = []

    class Provider:
        async def get_chat_response(
            self,
            _messages: object,
            stream: bool,
            _websocket: object,
            **_kwargs: object,
        ) -> str:
            stream_flags.append(stream)
            return "# 可发布的研究稿\n\n这是后台写作返回的正文。"

    monkeypatch.setattr(
        adapter_module._llm_mod,
        "get_llm",
        lambda *_args, **_kwargs: Provider(),
    )

    result = await adapter_module._bounded_create_chat_completion(
        messages=[{"role": "user", "content": "write"}],
        model="test-model",
        llm_provider="openai",
        stream=True,
        websocket=None,
    )

    assert result.startswith("# 可发布的研究稿")
    assert stream_flags == [False]


@pytest.mark.asyncio
async def test_adapter_deadline_marks_stuck_research_as_worker_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = GptResearcherAdapter(brief_llm="openai:test")
    request = ResearchRequest(
        job_id="stuck-research",
        request_id="stuck-research",
        topic="timeout test",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        timeout_seconds=1,
    )
    job = _Job(request=request)
    adapter._jobs[request.job_id] = job

    async def stuck_run(self: GptResearcherAdapter, _job: _Job) -> None:
        await asyncio.Event().wait()

    monkeypatch.setattr(GptResearcherAdapter, "_run_impl", stuck_run)

    await adapter._run(job)
    status = await adapter.get_status(request.job_id)

    assert status.status == AI_JOB_STATUS["FAILED"]
    assert status.error_code == "WORKER_TIMEOUT"
    assert "1s timeout" in (status.error_message or "")


@pytest.mark.asyncio
async def test_cancel_before_queue_task_starts_does_not_start_gpt_job() -> None:
    adapter = GptResearcherAdapter(brief_llm="openai:test")
    request = ResearchRequest(
        job_id="cancel-before-start",
        request_id="cancel-before-start",
        topic="cancel test",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        timeout_seconds=60,
    )
    await adapter.submit(request)

    outcome = await adapter.cancel(request.job_id)
    await asyncio.sleep(0)
    status = await adapter.get_status(request.job_id)

    assert outcome.was_queued is True
    assert outcome.was_running is False
    assert status.status == AI_JOB_STATUS["CANCELLED"]
    assert status.attempts == 0


def test_retrieval_progress_records_empty_search_without_raw_error() -> None:
    request = ResearchRequest(
        job_id="retrieval-diagnostic",
        request_id="retrieval-diagnostic",
        topic="search health",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
    )
    job = _Job(request=request)
    token = _ACTIVE_RESEARCH_JOB.set(job)
    try:
        _record_retrieval_event(provider="TavilySearch", result_count=0)
    finally:
        _ACTIVE_RESEARCH_JOB.reset(token)

    diagnostics = job.retrieval_diagnostics
    assert diagnostics["attempts"] == 1
    assert diagnostics["emptyResults"] == 1
    assert diagnostics["retrievalDegraded"] is True
    assert diagnostics["searchUnavailable"] is False
    assert diagnostics["providers"] == {
        "TavilySearch": {"attempts": 1, "emptyResults": 1, "failed": 0}
    }

    handler = _StepCaptureLogHandler(job)
    progress = handler._source_progress()
    assert progress["retrieval"] == diagnostics


def test_retriever_selection_downgrades_tavily_without_a_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("RETRIEVER", raising=False)
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)

    assert _resolve_retriever_selection() == ("duckduckgo", "tavily_not_configured")


def test_tavily_empty_result_uses_duckduckgo_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class EmptyTavily:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def search(self, max_results: int = 10) -> list[dict[str, str]]:
            return []

    class WorkingDuckDuckGo:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def search(self, max_results: int = 5) -> list[dict[str, str]]:
            return [{"href": "https://example.com/evidence", "body": "captured"}]

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher._TavilySearch", EmptyTavily)
    monkeypatch.setattr("ai_engine.adapters.gpt_researcher._Duckduckgo", WorkingDuckDuckGo)
    request = ResearchRequest(
        job_id="retrieval-fallback",
        request_id="retrieval-fallback",
        topic="search health",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
    )
    job = _Job(request=request)
    token = _ACTIVE_RESEARCH_JOB.set(job)
    try:
        result = _ResilientTavilySearch("search health").search(max_results=3)
    finally:
        _ACTIVE_RESEARCH_JOB.reset(token)

    assert result == [{"href": "https://example.com/evidence", "body": "captured"}]
    assert job.retrieval_diagnostics["fallbackAttempts"] == 1
    assert job.retrieval_diagnostics["fallbackProvider"] == "DuckDuckGo"
    providers = job.retrieval_diagnostics["providers"]
    assert isinstance(providers, dict)
    assert providers["TavilySearch"]["emptyResults"] == 1
    assert providers["Duckduckgo"]["attempts"] == 1


def test_tavily_is_skipped_after_repeated_empty_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"tavily": 0, "duckduckgo": 0}

    class EmptyTavily:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def search(self, max_results: int = 10) -> list[dict[str, str]]:
            calls["tavily"] += 1
            return []

    class WorkingDuckDuckGo:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def search(self, max_results: int = 5) -> list[dict[str, str]]:
            calls["duckduckgo"] += 1
            return [{"href": "https://example.com/evidence", "body": "captured"}]

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher._TavilySearch", EmptyTavily)
    monkeypatch.setattr("ai_engine.adapters.gpt_researcher._Duckduckgo", WorkingDuckDuckGo)
    request = ResearchRequest(
        job_id="retrieval-circuit",
        request_id="retrieval-circuit",
        topic="search health",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
    )
    job = _Job(request=request)
    token = _ACTIVE_RESEARCH_JOB.set(job)
    try:
        retriever = _ResilientTavilySearch("search health")
        assert retriever.search(max_results=3)
        assert retriever.search(max_results=3)
        assert retriever.search(max_results=3)
    finally:
        _ACTIVE_RESEARCH_JOB.reset(token)

    assert calls == {"tavily": 2, "duckduckgo": 1}
    assert job.retrieval_diagnostics["primarySkipped"] == 1


def test_scoped_duckduckgo_reuses_duplicate_queries_within_one_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    class WorkingDuckDuckGo:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def search(self, max_results: int = 5) -> list[dict[str, str]]:
            nonlocal calls
            calls += 1
            return [{"href": "https://example.com/evidence", "title": "Search evidence"}]

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher._Duckduckgo", WorkingDuckDuckGo)
    request = ResearchRequest(
        job_id="retrieval-cache",
        request_id="retrieval-cache",
        topic="search",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
    )
    job = _Job(request=request)
    token = _ACTIVE_RESEARCH_JOB.set(job)
    try:
        assert _ScopedDuckduckgo("search", query_domains=()).search(max_results=3)
        assert _ScopedDuckduckgo("search", query_domains=()).search(max_results=3)
    finally:
        _ACTIVE_RESEARCH_JOB.reset(token)

    assert calls == 1
    assert job.retrieval_diagnostics["cacheHits"] == 1


def test_adaptive_deep_stop_has_a_floor_and_uses_observable_evidence_yield() -> None:
    request = ResearchRequest(
        job_id="adaptive-stop",
        request_id="adaptive-stop",
        topic="比较 Claude、Gemini 和 ChatGPT Deep Research 的官方产品文档",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )
    sources = (
        [_source(f"https://anthropic.com/research-{index}", "Claude") for index in range(6)]
        + [_source(f"https://ai.google.dev/research-{index}", "Gemini") for index in range(6)]
        + [_source(f"https://openai.com/research-{index}", "OpenAI") for index in range(6)]
    )
    job = _Job(request=request, sources=sources)

    assert _adaptive_deep_stop_reason(
        job,
        {"followupGroupsStarted": 2, "stalledGroups": 2},
    ) is None
    assert _adaptive_deep_stop_reason(
        job,
        {"followupGroupsStarted": 3, "stalledGroups": 0},
    ) == "evidence_sufficient"

    stalled_job = _Job(request=request)
    assert _adaptive_deep_stop_reason(
        stalled_job,
        {"followupGroupsStarted": 3, "stalledGroups": 2},
    ) == "no_new_evidence"


@pytest.mark.asyncio
async def test_adaptive_deep_wrapper_is_installed_and_gates_recursive_calls() -> None:
    request = ResearchRequest(
        job_id="adaptive-wrapper",
        request_id="adaptive-wrapper",
        topic="research evidence",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )
    job = _Job(request=request)
    calls: list[tuple[int, int]] = []

    class DeepResearcher:
        async def deep_research(
            self,
            *,
            query: str,
            breadth: int,
            depth: int,
            learnings: list[str] | None = None,
            citations: dict[str, str] | None = None,
            visited_urls: set[str] | None = None,
            on_progress: object = None,
        ) -> dict[str, object]:
            calls.append((breadth, depth))
            if depth > 1:
                nested = await self.deep_research(
                    query="follow up",
                    breadth=2,
                    depth=depth - 1,
                    learnings=learnings,
                    citations=citations,
                    visited_urls=visited_urls,
                    on_progress=on_progress,
                )
                return nested
            return {
                "learnings": list(learnings or []),
                "citations": dict(citations or {}),
                "visited_urls": ["https://example.com/research-evidence"],
                "context": [],
                "sources": [{
                    "url": "https://example.com/research-evidence",
                    "title": "Research evidence",
                    "content": "The recursive branch returned inspectable evidence.",
                }],
            }

    deep = DeepResearcher()
    original = deep.deep_research
    _install_adaptive_deep_research(deep, job, configured_depth=2)

    assert deep.deep_research is not original
    await deep.deep_research(
        query="root",
        breadth=4,
        depth=2,
    )

    assert calls == [(4, 2), (2, 1)]
    adaptive = job.research_progress["adaptive"]
    assert isinstance(adaptive, dict)
    assert adaptive["followupGroupsStarted"] == 1
    assert adaptive["followupGroupsCompleted"] == 1
    assert len(job.sources) == 1
    assert job.sources[0].evidence_status == "fetched"


def test_scoped_duckduckgo_restricts_query_and_filters_results_before_fetch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, str] = {}

    class MixedDuckDuckGo:
        def __init__(self, query: str, **_: object) -> None:
            observed["query"] = query

        def search(self, max_results: int = 5) -> list[dict[str, str]]:
            return [
                {"href": "https://openai.com/index/deep-research", "body": "official"},
                {"href": "https://community.openai.com/t/deep-research", "body": "third-party"},
                {"href": "https://example.com/search-snippet", "body": "unrelated"},
            ]

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher._Duckduckgo", MixedDuckDuckGo)

    result = _ScopedDuckduckgo(
        "ChatGPT Deep Research official documentation",
        query_domains=("openai.com",),
    ).search(max_results=5)

    assert observed["query"] == "ChatGPT Deep Research official documentation"
    assert result == [
        {"href": "https://openai.com/index/deep-research", "body": "official"}
    ]


def test_general_search_filters_obvious_topical_noise_and_surfaces_a_gap() -> None:
    results = [
        {"href": "https://docs.cypress.io/app/references/trade-offs", "title": "Cypress trade-offs"},
        {"href": "https://wiki.archlinux.org/title/Main_page", "title": "ArchWiki"},
        {"href": "https://pytorch.org/docs/stable/", "title": "PyTorch documentation"},
    ]

    filtered = _filter_search_results_by_topic(
        results,
        topic="比较 Playwright 和 Cypress 的工程取舍",
    )

    assert filtered == [results[0]]
    assert _filter_search_results_by_topic(
        [{"href": "https://unknown.example/page", "title": "No matching result"}],
        topic="比较 Playwright 和 Cypress 的工程取舍",
    ) == []


def test_comparison_filter_rejects_one_sided_adjacent_tools_but_keeps_first_party_docs() -> None:
    results = [
        {
            "href": "https://ironpdf.com/zh/blog/migration-guides/migrate-from-playwright-to-ironpdf",
            "title": "Playwright to IronPDF migration guide",
        },
        {
            "href": "https://playwright.dev/docs/test-intro",
            "title": "Playwright Documentation",
        },
        {
            "href": "https://testingbot.com/resources/cypress-vs-playwright",
            "title": "Cypress vs Playwright: which test runner fits?",
        },
    ]

    filtered = _filter_search_results_by_topic(
        results,
        topic="比较 Playwright 和 Cypress 的工程取舍",
    )

    assert filtered == [results[1], results[2]]


def test_captured_source_filter_removes_nested_research_noise() -> None:
    sources = [
        _source(
            "https://wiki.archlinux.org/title/Main_page",
            "ArchWiki",
        ),
        _source(
            "https://docs.cypress.io/app/references/trade-offs",
            "Trade-offs in Cypress | Cypress Documentation",
        ),
        _source(
            "https://blog.example.com/playwright-cypress-comparison",
            "Playwright vs Cypress comparison",
        ),
    ]

    from ai_engine.adapters.gpt_researcher import _filter_sources_by_topic

    filtered = _filter_sources_by_topic(
        sources,
        topic="比较 Playwright 和 Cypress 的工程取舍",
    )

    assert [source.title for source in filtered] == [
        "Trade-offs in Cypress | Cypress Documentation",
        "Playwright vs Cypress comparison",
    ]


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


def test_claim_repair_prompt_can_include_captured_excerpts_without_polluting_bibliography() -> None:
    source = _source("https://example.com/source", "Source")
    prompt_sources = _format_source_lines([source], include_excerpts=True)
    bibliography = _format_source_lines([source])

    assert "原文摘录：captured evidence" in prompt_sources
    assert "原文摘录" not in bibliography


def test_unresolved_claims_are_marked_in_body_but_not_in_references() -> None:
    claim = ClaimVerdict(
        "claim-1",
        "系统支持后台运行。",
        "high",
        "unverified",
    )
    report = (
        "# 研究稿\n\n"
        "- 系统支持后台运行。\n\n"
        "## 参考文献\n\n"
        "1. [Source](https://example.com/source)"
    )

    marked = _mark_unresolved_claims(report, (claim,))

    assert "⚠️ **待核验** 系统支持后台运行。" in marked
    assert "参考文献" not in marked


def test_deep_length_selects_iterative_engine_only_for_web_scope() -> None:
    deep_request = ResearchRequest(
        job_id="deep-web",
        request_id="deep-web",
        topic="compare research systems",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )
    locked_request = ResearchRequest(
        job_id="deep-locked",
        request_id="deep-locked",
        topic="verify these documents",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["ONLY_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )

    assert _should_use_deep_research(deep_request) is True
    assert _should_use_deep_research(locked_request) is False


def test_official_research_request_keeps_product_domains_as_search_boundary() -> None:
    domains = _official_query_domains(
        "Compare Claude, Gemini, and ChatGPT Deep Research official documentation"
    )

    assert "docs.anthropic.com" in domains
    assert "support.google.com" in domains
    assert "help.openai.com" in domains
    scope = _official_source_scope(domains)
    assert "Do not use third-party articles" in scope


def test_product_capability_comparison_defaults_to_first_party_baseline() -> None:
    topic = "比较 Claude、Gemini 和 ChatGPT Deep Research 的研究过程设计"

    domains = _official_query_domains(topic)

    assert "docs.anthropic.com" in domains
    assert "ai.google.dev" in domains
    assert "developers.openai.com" in domains
    assert len(_official_lane_queries(topic)) == 9


def test_general_research_does_not_invent_an_official_domain_boundary() -> None:
    assert _official_query_domains("Compare vector databases for a side project") == ()
    assert _official_source_scope(()) == ""


def test_official_source_filter_rejects_forums_under_an_allowed_root_domain() -> None:
    sources = [
        _source("https://openai.com/index/introducing-deep-research", "OpenAI"),
        _source("https://community.openai.com/t/deep-research", "Community"),
        _source("https://forum.openai.com/public/videos/replay", "Forum"),
        _source("https://help.openai.com/en/articles/10500283", "Help"),
    ]

    filtered = _filter_sources_to_query_domains(
        sources,
        ("openai.com", "help.openai.com"),
    )

    assert [source.canonical_key for source in filtered] == [
        "https://openai.com/index/introducing-deep-research",
        "https://help.openai.com/en/articles/10500283",
    ]


def test_canonicalizes_tracking_variants_without_dropping_business_query() -> None:
    assert _canonicalize_web_url(
        "HTTPS://WWW.Example.com/research/?utm_source=mail&id=42&ref=home#evidence"
    ) == "https://example.com/research?id=42"
    assert _canonicalize_web_url(
        "https://example.com/research?id=42&foo=bar"
    ) == "https://example.com/research?foo=bar&id=42"


def test_collect_sources_dedupes_fragments_www_and_tracking_variants() -> None:
    sources = _collect_sources_from_research(
        [
            {"url": "https://www.example.com/page?utm_campaign=x#intro", "title": "A", "content": "evidence"},
            {"url": "https://example.com/page?ref=mail", "title": "A better title", "content": "more evidence"},
        ],
        [],
        "canonicalization",
    )

    assert len(sources) == 1
    assert sources[0].canonical_key == "https://example.com/page"
    assert sources[0].source_ref["value"] == "https://example.com/page"
    assert sources[0].title == "A better title"


def test_materialize_evidence_citations_only_allows_captured_source_ids() -> None:
    sources = [
        _source("https://www.example.com/official", "Official guide", "Captured evidence."),
        _source("https://example.com/second", "Second guide", "More captured evidence."),
    ]

    materialized = _materialize_evidence_citations(
        "结论一 [S1]，结论二【S2】，未匹配 [S99]。",
        sources,
    )

    assert "[Official guide](https://www.example.com/official)" in materialized
    assert "[Second guide](https://example.com/second)" in materialized
    assert "来源编号未匹配" in materialized
    assert "[S99]" not in materialized


def test_canonicalizes_search_challenge_and_pagination_variants() -> None:
    assert _canonicalize_web_url(
        "https://www.anthropic.com/news/claude-for-financial-services"
        "?_bhlid=tracking&asuniq=nonce&category=123&dates=456&abc_page=2"
    ) == "https://anthropic.com/news/claude-for-financial-services"


def test_canonicalizes_locale_and_hubspot_variants() -> None:
    assert _canonicalize_web_url(
        "https://ai.google.dev/gemini-api/docs/deep-research?hl=cs"
    ) == "https://ai.google.dev/gemini-api/docs/deep-research"
    assert _canonicalize_web_url(
        "https://anthropic.com/news/how-anthropic-teams-use-claude-code"
        "?%3F__hstc=tracking&__hsfp=tracking&rd=1"
    ) == "https://anthropic.com/news/how-anthropic-teams-use-claude-code"


def test_anti_bot_placeholder_is_discovered_but_not_evidence() -> None:
    sources = _collect_sources_from_research(
        [{
            "url": "https://openai.com/index/introducing-deep-research",
            "title": "Deep research",
            "content": "Enable JavaScript and cookies to continue",
        }],
        [],
        "source quality",
    )

    assert len(sources) == 1
    assert sources[0].snippet is None
    assert sources[0].evidence_status == "discovered"
    assert _captured_sources(sources) == []


@pytest.mark.parametrize(
    "body",
    [
        "Página no encontrada. Error 404.",
        "Page not found — this resource is unavailable.",
        "页面不存在",
    ],
)
def test_branded_error_pages_are_discovered_but_not_evidence(body: str) -> None:
    sources = _collect_sources_from_research(
        [{"url": "https://example.com/missing", "title": "Missing page", "content": body}],
        [],
        "source quality",
    )

    assert len(sources) == 1
    assert sources[0].snippet is None
    assert sources[0].evidence_status == "discovered"
    assert _captured_sources(sources) == []


def test_official_lane_queries_balance_each_dimension_across_named_products() -> None:
    lanes = _official_lane_queries(
        "Compare Claude, Gemini, and ChatGPT Deep Research official documentation"
    )

    assert len(lanes) == 9
    assert ["Claude" in lane["query"] for lane in lanes[:3]] == [True, True, True]
    assert ["Gemini" in lane["query"] for lane in lanes[3:6]] == [True, True, True]
    assert ["ChatGPT" in lane["query"] for lane in lanes[6:]] == [True, True, True]
    assert all("该产品官方原文" in lane["researchGoal"] for lane in lanes)
    assert "研究前后" in lanes[0]["researchGoal"]
    assert "研究后与交付" in lanes[-1]["researchGoal"]
    # No first-pass query should force the search engine to choose between
    # multiple products; that was the source of the observed coverage skew.
    assert all("Gemini" not in lane["query"] for lane in lanes[:3])
    assert all("Claude" not in lane["query"] for lane in lanes[3:])


def test_select_research_sources_caps_web_pages_and_round_robins_official_lanes() -> None:
    sources = [
        _source(f"https://www.anthropic.com/page-{index}", "Claude")
        for index in range(1, 6)
    ] + [
        _source(f"https://ai.google.dev/page-{index}", "Gemini")
        for index in range(1, 4)
    ] + [
        _source(f"https://developers.openai.com/page-{index}", "OpenAI")
        for index in range(1, 4)
    ]

    selected = _select_research_sources(
        sources,
        6,
        topic="Compare Claude, Gemini, and ChatGPT Deep Research official documentation",
    )
    hosts = [(source.source_ref["value"] or "").split("/")[2] for source in selected]

    assert len(selected) == 6
    assert hosts[:3] == ["anthropic.com", "ai.google.dev", "developers.openai.com"]
    assert hosts.count("anthropic.com") == 2
    assert hosts.count("ai.google.dev") == 2
    assert hosts.count("developers.openai.com") == 2


def test_official_comparison_adds_verified_first_party_anchors_without_user_refs() -> None:
    seeds = _official_source_seeds(
        "比较 Claude、Gemini 和 ChatGPT Deep Research 的官方产品文档"
    )

    urls = [url for url, _ in seeds]
    assert "https://www.anthropic.com/engineering/multi-agent-research-system" in urls
    assert "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview" in urls
    assert "https://ai.google.dev/gemini-api/docs/deep-research" in urls
    assert "https://help.openai.com/articles/10500283-deepresearch-faq" in urls
    assert "https://developers.openai.com/cookbook/examples/deep_research_api/introduction_to_deep_research_api" in urls


def test_official_coverage_distinguishes_discovery_from_captured_evidence() -> None:
    discovered = _discovered_source("https://ai.google.dev/gemini-api/docs/deep-research", "Gemini")
    captured = _source("https://developers.openai.com/api/docs/guides/deep-research", "OpenAI")

    coverage = _official_source_coverage(
        "比较 Claude、Gemini 和 ChatGPT Deep Research 的官方产品文档",
        (discovered, captured),
    )

    assert coverage["gemini"]["status"] == "pending"
    assert coverage["gemini"]["captured"] == 0
    assert coverage["chatgpt"]["status"] == "partial"
    assert coverage["chatgpt"]["captured"] == 1
    assert coverage["chatgpt"]["requiredCaptured"] == 3


@pytest.mark.asyncio
async def test_official_coverage_repair_hydrates_only_missing_product_seeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    existing = [
        _source(
            "https://anthropic.com/engineering/multi-agent-research-system",
            "Claude",
        ),
        _source(
            "https://ai.google.dev/gemini-api/docs/deep-research",
            "Gemini",
        ),
        _discovered_source(
            "https://developers.openai.com/api/docs/guides/deep-research",
            "OpenAI",
        ),
    ]

    async def fake_hydrate(sources, **_kwargs):
        return [
            _source(source.canonical_key, source.title or "OpenAI")
            for source in sources
        ]

    monkeypatch.setattr(
        "ai_engine.adapters.gpt_researcher._hydrate_source_snippets",
        fake_hydrate,
    )
    repaired, stats = await _repair_official_source_coverage(
        existing,
        topic="比较 Claude、Gemini 和 ChatGPT Deep Research 的官方产品文档",
    )

    # Claude/Gemini already meet the two-page floor; only OpenAI seeds are
    # eligible for the bounded supplement.
    assert stats["attempted"] >= 1
    assert stats["captured"] >= 1
    assert any("developers.openai.com" in source.canonical_key for source in repaired)


def test_deep_branch_budget_counts_each_recursive_branch() -> None:
    assert _StepCaptureLogHandler._branch_budget(6, 2) == 24
    assert _StepCaptureLogHandler._branch_budget(6, 3) == 60
    assert _StepCaptureLogHandler._branch_budget(6, 1) == 6


def test_deep_preset_keeps_report_time_after_two_research_rounds() -> None:
    assert _DEEP_RESEARCH_SETTINGS == {"breadth": 9, "depth": 2, "concurrency": 3}


def test_deep_progress_reports_round_branch_and_total_budget() -> None:
    request = ResearchRequest(
        job_id="deep-progress",
        request_id="deep-progress",
        topic="progress mapping",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )
    job = _Job(request=request)
    handler = _StepCaptureLogHandler(job)
    progress = SimpleNamespace(
        total_depth=2,
        total_queries=6,
        completed_queries=1,
        current_query="compare official research documentation",
    )

    handler.on_deep_progress(progress)

    assert job.research_progress == {
        "mode": "deep",
        "round": 1,
        "rounds": 2,
        "branchesCompleted": 1,
        "branchesTotal": 6,
        "totalBranchesCompleted": 1,
        "totalBranches": 24,
        "adaptive": {
            "minFollowupGroups": 2,
                "maxFollowupGroups": 6,
            "followupGroupsStarted": 0,
            "followupGroupsCompleted": 0,
            "stalledGroups": 0,
            "stoppedEarly": False,
        },
        "currentFocus": "compare official research documentation",
        "pagesVisited": 0,
        "sourcesDiscovered": 0,
        "sourcesCaptured": 0,
        "collectionTimedOut": False,
        "collectionTimeboxSeconds": 900,
        "state": "searching",
    }


def test_deep_progress_accumulates_across_recursive_rounds() -> None:
    request = ResearchRequest(
        job_id="deep-progress-rounds",
        request_id="deep-progress-rounds",
        topic="progress rounds",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )
    job = _Job(request=request)
    handler = _StepCaptureLogHandler(job)
    first_round = SimpleNamespace(
        total_depth=2,
        total_queries=6,
        completed_queries=1,
        current_query="first round",
    )
    handler.on_deep_progress(first_round)
    first_round.completed_queries = 4
    handler.on_deep_progress(first_round)

    second_round = SimpleNamespace(
        total_depth=1,
        total_queries=3,
        completed_queries=1,
        current_query="evidence gap",
    )
    handler.on_deep_progress(second_round)

    assert job.research_progress["round"] == 2
    assert job.research_progress["rounds"] == 2
    assert job.research_progress["totalBranchesCompleted"] == 5
    assert job.research_progress["totalBranches"] == 24


def test_deep_progress_keeps_pages_reached_separate_from_evidence_ledger() -> None:
    request = ResearchRequest(
        job_id="deep-progress-pages",
        request_id="deep-progress-pages",
        topic="page breadth",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )
    job = _Job(request=request, pages_visited=42)
    handler = _StepCaptureLogHandler(job)

    handler.on_deep_progress(SimpleNamespace(
        total_depth=2,
        total_queries=4,
        completed_queries=2,
        current_query="coverage",
    ))

    assert job.research_progress["pagesVisited"] == 42
    assert job.research_progress["sourcesDiscovered"] == 0
    assert job.research_progress["sourcesCaptured"] == 0


def test_truthy_visited_url_set_stays_shared_when_empty() -> None:
    visited = _TruthyVisitedUrls()

    assert bool(visited) is True
    assert visited.copy() == visited
    assert type(visited.copy()) is _TruthyVisitedUrls


def test_ignores_opaque_grounding_handles_as_sources() -> None:
    sources = _collect_sources_from_research(
        [{"url": "CAESopaque-grounding-handle", "title": "Provider reference"}],
        ["CAESanother-grounding-handle", "https://example.com/usable"],
        "fallback topic",
    )

    assert [source.canonical_key for source in sources] == ["https://example.com/usable"]


def test_merges_early_url_snapshot_with_richer_evidence() -> None:
    early = _source("https://example.com/article", "")
    rich = AdapterSource(
        source_ref={"type": "url", "value": "https://example.com/article"},
        canonical_key="https://example.com/article",
        title="Official article",
        snippet="Captured evidence",
        score=0.9,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
        is_accessible=True,
    )

    merged = _merge_sources([early], [rich])

    assert merged == [rich]


@pytest.mark.asyncio
async def test_deep_step_handler_maps_iterations_and_discovered_count() -> None:
    request = ResearchRequest(
        job_id="deep-step",
        request_id="deep-step",
        topic="step mapping",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )
    job = _Job(request=request)
    handler = _StepCaptureLogHandler(job)

    await handler.on_research_step("deep_research_start", {"breadth": 4})
    assert job.current_step == AI_JOB_STEP["SEARCH"]
    await handler.on_research_step("deep_research_complete", {"visited_urls": 37})
    assert job.current_step == AI_JOB_STEP["ANALYZE"]
    assert job.search_count == 37


def test_maps_gpt_researcher_content_field_to_source_snippet() -> None:
    sources = _collect_sources_from_research(
        [
            {
                "url": "https://a.example/post",
                "title": "A good post",
                "content": "The captured article body is evidence, not only a URL.",
            },
        ],
        [],
        "fallback topic",
    )

    assert sources[0].snippet == "The captured article body is evidence, not only a URL."


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
    assert sources[2].title is None
    assert sources[1].evidence_status == "discovered"
    assert sources[2].evidence_status == "discovered"


def test_empty_inputs_return_empty_list() -> None:
    assert _collect_sources_from_research([], [], "topic") == []


@pytest.mark.asyncio
async def test_hydrates_missing_web_snippet_via_safe_fetch(monkeypatch: pytest.MonkeyPatch) -> None:
    source = _discovered_source("https://example.com/article", "")

    async def fetch(url: str, **_: object) -> FetchedDocument:
        assert url == source.canonical_key
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=b"<html><head><title>Example article</title></head><body><h1>Heading</h1><p>Direct source text for the evidence ledger.</p></body></html>",
            content_type="text/html",
            elapsed_ms=5,
        )

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher.safe_fetch", fetch)
    hydrated = await _hydrate_source_snippets([source])

    assert hydrated[0].title == "Example article"
    assert hydrated[0].snippet == "Example article Heading Direct source text for the evidence ledger."
    assert hydrated[0].evidence_status == "fetched"


@pytest.mark.asyncio
async def test_refreshes_existing_web_snippet_before_evidence_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _source(
        "https://docs.example.com/research",
        "Research docs",
        "Home Products Pricing Sign in Research agent",
    )

    async def fetch(url: str, **_: object) -> FetchedDocument:
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=(
                b"<html><head><title>Research docs</title></head><body>"
                b"<nav>Home Products Pricing Sign in</nav>"
                b"<main><h1>Research agent</h1>"
                b"<p>The agent reads multiple sources and cites the evidence.</p>"
                b"</main><footer>Privacy Terms</footer></body></html>"
            ),
            content_type="text/html",
            elapsed_ms=5,
        )

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher.safe_fetch", fetch)
    refreshed = await _hydrate_source_snippets([source], refresh_existing=True)

    assert refreshed[0].evidence_status == "fetched"
    assert "cites the evidence" in (refreshed[0].snippet or "")
    assert "Pricing" not in (refreshed[0].snippet or "")
    assert "Privacy Terms" not in (refreshed[0].snippet or "")


@pytest.mark.asyncio
async def test_hydration_prefers_article_body_over_documentation_navigation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _discovered_source("https://docs.example.com/research", "")

    async def fetch(url: str, **_: object) -> FetchedDocument:
        return FetchedDocument(
            url=url,
            final_ip="93.184.216.34",
            status=200,
            headers={"content-type": "text/html"},
            content=(
                b"<html><head><title>Research docs</title></head><body>"
                b"<nav>Home Products Pricing Sign in Language English "
                b"Home Products Pricing Sign in Language English</nav>"
                b"<main><h1>Research agent</h1>"
                b"<p>The agent reads multiple sources and cites the evidence.</p>"
                b"</main><footer>Privacy Terms</footer></body></html>"
            ),
            content_type="text/html",
            elapsed_ms=5,
        )

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher.safe_fetch", fetch)
    hydrated = await _hydrate_source_snippets([source])

    assert hydrated[0].evidence_status == "fetched"
    assert "cites the evidence" in (hydrated[0].snippet or "")
    assert "Privacy Terms" not in (hydrated[0].snippet or "")


@pytest.mark.asyncio
async def test_hydration_failure_keeps_original_source(monkeypatch: pytest.MonkeyPatch) -> None:
    source = _source("https://example.com/unavailable", "Unavailable")

    async def fail(_: str, **__: object) -> FetchedDocument:
        raise RuntimeError("network failure")

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher.safe_fetch", fail)
    hydrated = await _hydrate_source_snippets([source])

    assert hydrated == [source]


@pytest.mark.asyncio
async def test_hydration_does_not_fetch_sources_with_existing_snippet(monkeypatch: pytest.MonkeyPatch) -> None:
    source = AdapterSource(
        source_ref={"type": "url", "value": "https://example.com/already-captured"},
        canonical_key="https://example.com/already-captured",
        title="Captured",
        snippet="Already captured source text.",
        score=0.9,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
    )

    async def fail(_: str, **__: object) -> FetchedDocument:
        raise AssertionError("existing snippets must not be fetched again")

    monkeypatch.setattr("ai_engine.adapters.gpt_researcher.safe_fetch", fail)
    hydrated = await _hydrate_source_snippets([source])

    assert hydrated == [source]


def test_snapshots_sources_before_report_writing() -> None:
    class Researcher:
        visited_urls = ["https://b.example/visited"]

        def get_research_sources(self) -> list[dict[str, str]]:
            return [{"url": "https://a.example/captured", "title": "Captured"}]

    sources = _sources_from_researcher(Researcher(), "fallback")

    assert [source.canonical_key for source in sources] == [
        "https://a.example/captured",
        "https://b.example/visited",
    ]
    assert all(source.evidence_status == "discovered" for source in sources)


def test_configured_depth_survives_nested_progress_object() -> None:
    request = ResearchRequest(
        job_id="deep-configured-depth",
        request_id="deep-configured-depth",
        topic="configured depth",
        context=None,
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        report_length="deep",
    )
    job = _Job(request=request)
    handler = _StepCaptureLogHandler(job)
    handler.configure_deep(breadth=4, depth=2)

    handler.on_deep_progress(SimpleNamespace(
        total_depth=2,
        total_queries=4,
        completed_queries=4,
        current_query="initial coverage",
    ))
    handler.on_deep_progress(SimpleNamespace(
        total_depth=1,
        total_queries=2,
        completed_queries=1,
        current_query="nested evidence gap",
    ))

    assert job.research_progress["rounds"] == 2
    assert job.research_progress["round"] == 2
    assert job.research_progress["totalBranches"] == 12


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


def _source(url: str, title: str, snippet: str = "captured evidence") -> AdapterSource:
    return AdapterSource(
        source_ref={"type": "url", "value": url},
        canonical_key=url,
        title=title,
        snippet=snippet,
        score=0.9,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
        is_accessible=True,
    )


def _discovered_source(url: str, title: str) -> AdapterSource:
    return AdapterSource(
        source_ref={"type": "url", "value": url},
        canonical_key=url,
        title=title,
        snippet=None,
        score=0.9,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
        is_accessible=True,
        evidence_status="discovered",
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


def test_append_references_derives_distinct_labels_when_titles_are_missing() -> None:
    completed = _append_references(
        "正文已经完整。",
        [
            _source("https://arxiv.org/abs/2608.02464", ""),
            _source("https://www.youtube.com/watch?v=abc123", ""),
        ],
    )

    assert "[arxiv.org（2608.02464）](https://arxiv.org/abs/2608.02464)" in completed
    assert "[YouTube 视频（abc123）](https://www.youtube.com/watch?v=abc123)" in completed


def test_append_references_replaces_duplicate_upstream_titles() -> None:
    completed = _append_references(
        "正文已经完整。",
        [
            _source("https://arxiv.org/abs/2608.02464", "同一个标题"),
            _source("https://openreview.net/forum?id=PFR4E8583W", "同一个标题"),
        ],
    )

    assert "[arxiv.org（2608.02464）](https://arxiv.org/abs/2608.02464)" in completed
    assert "[openreview.net（PFR4E8583W）](https://openreview.net/forum?id=PFR4E8583W)" in completed


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


def test_discovered_urls_never_enter_report_references_or_trusted_links() -> None:
    sources = [
        _source("https://a.example/captured", "Captured"),
        _discovered_source("https://b.example/discovered", "Discovered"),
    ]

    completed = _append_references(
        _clean_report_output(
            "正文包含 [已抓取](https://a.example/captured) 与 [仅发现](https://b.example/discovered)。",
            sources,
        ),
        sources,
    )

    assert "[Captured](https://a.example/captured)" in completed
    assert "https://b.example/discovered" not in completed
    assert "仅发现（链接未被本次来源验证）" in completed


def test_strip_reference_section_removes_existing_references_only() -> None:
    report = "正文\n\n## 参考文献\n\n1. old"
    assert _strip_reference_section(report) == "正文"


def test_clean_report_output_removes_drafting_scratchpad() -> None:
    report = (
        "The user is asking whether to adopt GraphRAG.\n\n"
        "Let me analyze the key themes.\n\n"
        "# Main title: GraphRAG report\n\n"
        "I should structure the report carefully.\n\n"
        "# 是否应该采用 GraphRAG？\n\n## 结论\n\n建议先小规模验证。"
    )

    cleaned = _clean_report_output(
        report,
        [_source("https://a.example/report", "A")],
    )

    assert cleaned.startswith("# 是否应该采用 GraphRAG？")
    assert "The user is asking" not in cleaned
    assert "Main title" not in cleaned


def test_clean_report_output_marks_links_not_seen_in_sources() -> None:
    report = (
        "# 报告\n\n"
        "[已验证](https://a.example/report)\n\n"
        "[模型自行构造](https://invented.example/post)"
    )

    cleaned = _clean_report_output(
        report,
        [_source("https://a.example/report", "A")],
    )

    assert "[已验证](https://a.example/report)" in cleaned
    assert "https://invented.example" not in cleaned
    assert "模型自行构造（链接未被本次来源验证）" in cleaned


def test_clean_report_output_rebinds_title_only_citations_after_source_capture() -> None:
    """A captured page must not remain marked as an unverified link after repair."""
    cleaned = _clean_report_output(
        "结论：[OpenAI · background mode](https://stale.example/background)；"
        "[未知页面](https://not-captured.example/page)。",
        [
            _source(
                "https://developers.openai.com/api/docs/guides/background",
                "OpenAI · background mode",
            ),
        ],
    )

    assert "[OpenAI · background mode](https://developers.openai.com/api/docs/guides/background)" in cleaned
    assert "OpenAI · background mode（链接未被本次来源验证）" not in cleaned
    assert "未知页面（链接未被本次来源验证）" in cleaned


def test_clean_report_output_matches_literal_html_entity_title_variant() -> None:
    cleaned = _clean_report_output(
        "依据 Gemini Deep Research agent | Gemini API（链接未被本次来源验证）。",
        [
            _source(
                "https://ai.google.dev/gemini-api/docs/deep-research",
                "Gemini Deep Research agent &nbsp;|&nbsp; Gemini API",
            ),
        ],
    )

    assert "[Gemini Deep Research agent | Gemini API](https://ai.google.dev/gemini-api/docs/deep-research)" in cleaned


def test_strip_overlap_drops_repeated_tail_sentence() -> None:
    previous = "最后一句话"
    chunk = "最后一句话\n\n## 结论\n\n完整。"
    assert _strip_overlap(previous, chunk) == "## 结论\n\n完整。"
