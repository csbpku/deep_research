"""Research experience regressions based on real production observations."""

import hashlib
from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.adapters import gpt_researcher as gr
from ai_engine.adapters.base import AdapterSource
from ai_engine.evidence_reconciliation import research_revision_hash
from ai_engine.fetcher import ai_source_urls
from ai_engine.fetcher.safe_fetch import FetchedDocument
from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.job_runner.models import JobSnapshot
from ai_engine.reviewer import _review_source_text
from ai_engine.server.app import _make_draft_factory
from tests.test_research_failure_recovery import configure


@pytest.mark.asyncio
async def test_selected_long_url_retains_text_for_writer_and_reviewer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    text = "导航内容 " * 1050 + " TaskGroup and gather have different cancellation semantics. "
    html = ("<html><body><main>" + text + "</main></body></html>").encode()

    async def fetch(url: str) -> FetchedDocument:
        return FetchedDocument(
            url=url,
            final_ip="8.8.8.8",
            status=200,
            headers={},
            content=html,
            content_type="text/html",
            elapsed_ms=1,
        )

    monkeypatch.setattr(ai_source_urls, "safe_fetch", fetch)
    fetched = await ai_source_urls._fetch_user_url({"type": "url", "value": "https://example.test/doc"})
    source = fetched.adapter_source
    assert "TaskGroup" in (source.snippet or "")
    assert len(source.snippet or "") <= 12000
    assert "TaskGroup" in str(gr._append_captured_evidence_to_context("", [source]))
    assert "TaskGroup" in _review_source_text("Compare TaskGroup and gather", (source,))


@pytest.mark.asyncio
async def test_draft_review_uses_full_revision_hash_not_body_origin_hash() -> None:
    calls: list[tuple[str, Any]] = []

    class Connection:
        @asynccontextmanager
        async def transaction(self):
            yield

        async def execute(self, sql: str, params: Any) -> None:
            calls.append((sql, params))

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield Connection()

    store = object.__new__(DbJobStore)
    store._pool = Pool()  # type: ignore[assignment]
    store._pool_open = True
    snapshot = JobSnapshot(
        job_id="e54c4492-048e-42f8-98a9-8ecf3e219ba6",
        requester_id="45ca43a3-1234-4e4f-8098-45c53972f098",
        topic="Test title",
        context=None,
        report_type="research_report",
        source_policy="only_user_sources",
        status="running",
        current_step="write",
        attempts=1,
        idempotency_key=None,
        source_refs=(),
    )
    body = "# Evidence\n\nA body."
    await _make_draft_factory(store)(snapshot, (), body, None)
    draft = next(params for sql, params in calls if 'INSERT INTO "researches"' in sql)
    review = next(params for sql, params in calls if 'INSERT INTO "research_review_runs"' in sql)
    assert draft[-1] == hashlib.sha256(body.encode()).hexdigest()
    import json

    assert json.loads(review[-1])["sourceSnapshotFormat"] == "canonical-v1"
    assert review[3] == research_revision_hash(
        {
            "title": snapshot.topic,
            "body": body,
            "background": None,
            "conclusion": None,
            "risks": None,
            "tags": [],
        }
    )
    assert review[3] != research_revision_hash({"title": "edited title", "body": body})


@pytest.mark.asyncio
async def test_no_source_fails_before_report_writer_at_search_step(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter, job, _ = configure(monkeypatch)
    job.sources = []
    calls: list[str] = []

    class Researcher:
        def __init__(self, **_: Any) -> None:
            self.context = ""

        async def conduct_research(self, **_: Any) -> None:
            pass

        def get_costs(self) -> float:
            return 0.0

    async def writer(**_: Any) -> str:
        calls.append("writer")
        return "Should not be written."

    monkeypatch.setattr(gr, "GPTResearcher", Researcher)
    monkeypatch.setattr(gr, "_sources_from_researcher", lambda *_: [])
    monkeypatch.setattr(gr, "_write_report_with_bounded_client", writer)
    await adapter._run_impl(job)
    assert calls == []
    assert job.status == "failed"
    assert job.error_code == "NO_SOURCES_FOUND"
    assert job.current_step == "search"


def test_comparison_contract_uses_confirmed_dimensions_without_forcing_infrastructure() -> None:
    prompt = gr._build_grounded_report_prompt(
        {}, [], topic="比较 Playwright 和 Cypress 的学习曲线", context="确认的决策维度：学习曲线、调试能力"
    )
    assert "学习曲线" in prompt
    assert "磁盘/运维负担" not in prompt
    assert "回滚与恢复" not in prompt


def test_review_uses_only_the_matching_immutable_long_snapshot() -> None:
    from ai_engine.job_runner import db_store
    from ai_engine.server.app import _review_source_snapshot_hash

    text = "Intro. " * 200 + "Verified TaskGroup behavior. "
    source = AdapterSource(
        source_ref={"type": "url", "value": "https://example.test/doc"},
        canonical_key="https://example.test/doc",
        title="Doc",
        snippet=text,
        score=1.0,
        step_captured="search",
    )
    long_snapshot = [
        {
            "source_ref": source.source_ref,
            "canonical_key": source.canonical_key,
            "title": source.title,
            "snippet": source.snippet,
            "score": 1.0,
            "step_captured": "search",
        }
    ]
    short_snapshot = [{**long_snapshot[0], "snippet": db_store._clip_db_text(text, 1000)}]
    digest = _review_source_snapshot_hash((source,))
    loaded = db_store._review_sources_for_run(short_snapshot, long_snapshot, digest)
    assert loaded[0].snippet == text
    changed = [{**short_snapshot[0], "snippet": "Edited source preview."}]
    assert (
        db_store._review_sources_for_run(changed, long_snapshot, digest)[0].snippet
        == "Edited source preview."
    )
    assert db_store._review_sources_for_run(short_snapshot, long_snapshot, "invalid")[0].snippet != text


@pytest.mark.asyncio
async def test_url_extraction_prefers_main_content_over_navigation(monkeypatch: pytest.MonkeyPatch) -> None:
    html = (
        "<html><head><title>Guide</title></head><body><nav>"
        + "site navigation " * 2000
        + "</nav><main><article><h1>Guide</h1><p>TaskGroup waits for tasks and cancels siblings when a task fails.</p></article></main></body></html>"
    ).encode()

    async def fetch(url: str) -> FetchedDocument:
        return FetchedDocument(
            url=url,
            final_ip="8.8.8.8",
            status=200,
            headers={},
            content=html,
            content_type="text/html",
            elapsed_ms=1,
        )

    monkeypatch.setattr(ai_source_urls, "safe_fetch", fetch)
    result = await ai_source_urls._fetch_user_url({"type": "url", "value": "https://example.test/guide"})
    assert "TaskGroup waits" in (result.adapter_source.snippet or "")


def test_review_hash_matches_bounded_persisted_snapshot() -> None:
    from dataclasses import replace
    from ai_engine.job_runner import db_store
    from ai_engine.server.app import _review_source_snapshot_hash

    source = AdapterSource(
        source_ref={"type": "url", "value": "https://example.test/doc"},
        canonical_key="https://example.test/doc",
        title="Title " * 70,
        snippet="Evidence " * 2000,
        score=1.0,
        step_captured="search",
    )
    persisted = replace(
        source,
        title=db_store._clip_db_text(source.title, 300),
        snippet=db_store._clip_db_text(source.snippet, 12000),
    )
    assert _review_source_snapshot_hash((source,)) == _review_source_snapshot_hash((persisted,))


@pytest.mark.asyncio
async def test_locked_source_selects_multiple_query_relevant_sections(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ai_engine.adapters.base import ResearchRequest

    html = (
        "<html><body><main><h1>Python asyncio</h1><p>"
        + "Unrelated introduction. " * 800
        + "</p>"
        + '<dl><dt id="asyncio.TaskGroup">class asyncio.TaskGroup</dt><dd>When one task fails, remaining tasks are cancelled.</dd></dl>'
        + "<p>"
        + "Other APIs. " * 1000
        + "</p>"
        + '<dl><dt id="asyncio.gather">asyncio.gather(*aws, return_exceptions=False)</dt><dd>By default the first exception is propagated and other awaitables continue.</dd></dl>'
        + "</main></body></html>"
    ).encode()

    async def fetch(url: str) -> FetchedDocument:
        return FetchedDocument(
            url=url,
            final_ip="8.8.8.8",
            status=200,
            headers={},
            content=html,
            content_type="text/html",
            elapsed_ms=1,
        )

    monkeypatch.setattr(ai_source_urls, "safe_fetch", fetch)
    request = ResearchRequest(
        job_id="focus",
        request_id="focus",
        topic="比较 asyncio.gather 与 TaskGroup 的异常传播和取消行为",
        context=None,
        report_type="research_report",
        source_policy="only_user_sources",
        source_refs=({"type": "url", "value": "https://docs.example.test/tasks", "required": True},),
    )
    job = gr._Job(request)
    adapter = object.__new__(gr.GptResearcherAdapter)
    sources = await adapter._load_locked_user_sources(job)
    assert sources is not None and len(sources) == 1
    excerpt = sources[0].snippet or ""
    assert len(excerpt) <= 12000
    assert "remaining tasks are cancelled" in excerpt
    assert "return_exceptions=False" in excerpt
    assert "other awaitables continue" in excerpt
    assert "return_exceptions=False" in str(gr._append_captured_evidence_to_context("", sources))
    assert "return_exceptions=False" in _review_source_text(request.topic, tuple(sources))
    assert sources[0].canonical_key == "https://docs.example.test/tasks"


def test_relevant_sections_are_bounded_and_fall_back_when_unmatched() -> None:
    html = (
        '<html><body><dl><dt id="module.alpha">alpha</dt><dd>'
        + ("Documented behavior. " * 900)
        + '<script>hidden instruction</script></dd></dl><dl><dt id="module.beta">beta</dt><dd>'
        + ("Beta behavior. " * 900)
        + "</dd></dl></body></html>"
    )
    excerpt = ai_source_urls.select_relevant_user_source_sections(
        html, "Compare alpha versus beta", limit=4000
    )
    assert excerpt is not None and len(excerpt) <= 4000
    assert "Documented behavior" in excerpt and "Beta behavior" in excerpt
    assert "hidden instruction" not in excerpt
    assert ai_source_urls.select_relevant_user_source_sections(html, "What is gamma?") is None


def test_review_uses_mixed_matching_and_changed_sources() -> None:
    from dataclasses import replace
    from ai_engine.job_runner import db_store
    from ai_engine.server.app import _review_source_snapshot_hash

    original = AdapterSource(
        source_ref={"type": "url", "value": "https://example.com/docs"},
        canonical_key="https://example.com/docs",
        title="Docs",
        snippet="long evidence " * 400,
        score=1.0,
        step_captured="search",
    )
    changed = replace(
        original,
        source_ref={"type": "url", "value": "https://example.com/edited"},
        canonical_key="https://example.com/edited",
        title="Changed",
        snippet="Old evidence text",
    )
    new_source = replace(
        original,
        source_ref={"type": "url", "value": "https://example.com/new"},
        canonical_key="https://example.com/new",
        title="Added",
        snippet="Added evidence text",
    )
    short_original = replace(original, snippet=db_store._clip_db_text(original.snippet, 1000))
    updated = replace(changed, snippet="New evidence text")

    def row(source: AdapterSource) -> dict[str, object]:
        return {
            "source_ref": source.source_ref,
            "canonical_key": source.canonical_key,
            "title": source.title,
            "snippet": source.snippet,
            "step_captured": "search",
        }

    previews = [row(short_original), row(updated), row(new_source)]
    prior = [row(original), row(changed)]
    expected = (original, updated, new_source)
    digest = _review_source_snapshot_hash(expected)
    loaded = db_store._review_sources_for_run(previews, prior, digest)
    assert [source.snippet for source in loaded] == [source.snippet for source in expected]
    assert [source.snippet for source in db_store._review_sources_for_run(previews, prior, "invalid")] == [
        source.snippet for source in (short_original, updated, new_source)
    ]


def test_relevant_api_captures_semantic_parent_section() -> None:
    html = (
        '<html><body><section id="task-groups"><h2>Task Groups</h2>'
        '<dl><dt id="asyncio.TaskGroup">class asyncio.TaskGroup</dt><dd>Tasks are awaited.</dd></dl>'
        "<p>A task failing with an exception other than CancelledError cancels siblings.</p>"
        "<p>Those exceptions are combined in an ExceptionGroup.</p></section>"
        '<section id="running-concurrently"><h2>Running tasks concurrently</h2>'
        '<dl><dt id="asyncio.gather">asyncio.gather(*aws, return_exceptions=False)</dt>'
        "<dd>Other tasks continue when the first exception is propagated.</dd></dl></section></body></html>"
    )
    excerpt = ai_source_urls.select_relevant_user_source_sections(
        html, "Compare asyncio.TaskGroup and asyncio.gather"
    )
    assert excerpt is not None
    assert "cancels siblings" in excerpt and "ExceptionGroup" in excerpt
    assert "return_exceptions=False" in excerpt


@pytest.mark.asyncio
async def test_changed_queued_evidence_is_marked_stale_before_claim(monkeypatch: pytest.MonkeyPatch) -> None:
    from unittest.mock import AsyncMock
    from ai_engine.job_runner.db_store import AI_TABLE

    calls: list[str] = []
    row = {
        "reviewRunId": "run",
        "researchId": "research",
        "aiResearchJobId": "job",
        "jobId": "job",
        "authorId": "user",
        "title": "Title",
        "body": "Report",
        "topic": "Topic",
        "reportType": "research_report",
        "attempt": 0,
        "executionStatus": "queued",
        "sourceSnapshotHash": "old-hash",
        "revisionHash": "revision",
        "runDetails": {"sourceSnapshotFormat": "canonical-v1"},
        "jobReviewDetails": {},
        "sourceSnapshot": [
            {
                "source_ref": {"type": "url", "value": "https://example.com"},
                "canonical_key": "https://example.com",
                "title": "Docs",
                "snippet": "Changed source content.",
                "step_captured": "search",
            }
        ],
        "jobSourceSnapshot": [],
    }

    class Cursor:
        async def fetchone(self):
            return row

    class Conn:
        @asynccontextmanager
        async def transaction(self):
            yield

        async def execute(self, sql: str, params: Any = None):
            calls.append(sql)
            return Cursor()

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield Conn()

    store = object.__new__(DbJobStore)
    store._pool = Pool()  # type: ignore[assignment]
    store._pool_open = True
    store._table_name = AI_TABLE
    store._max_retries = 3
    store._review_lease_seconds = 600
    monkeypatch.setattr(store, "open", AsyncMock())
    assert await store.claim_next_review("worker") is None
    assert any("\"executionStatus\" = 'stale'" in sql for sql in calls)
    assert not any("\"executionStatus\" = 'reviewing'" in sql for sql in calls)


@pytest.mark.asyncio
async def test_changed_evidence_during_review_cannot_complete_as_current(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from unittest.mock import AsyncMock
    from ai_engine.job_runner.db_store import AI_TABLE
    from ai_engine.job_runner.models import ReviewWorkItem

    calls: list[tuple[str, object]] = []
    current = {
        "sourceSnapshot": [
            {
                "source_ref": {"type": "url", "value": "https://example.com"},
                "canonical_key": "https://example.com",
                "title": "Docs",
                "snippet": "Changed after claim",
                "step_captured": "search",
            }
        ],
        "jobSourceSnapshot": [],
    }

    class Cursor:
        rowcount = 1

        async def fetchone(self):
            return current

    class Conn:
        @asynccontextmanager
        async def transaction(self):
            yield

        async def execute(self, sql: str, params: Any = None):
            calls.append((sql, params))
            return Cursor()

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield Conn()

    store = object.__new__(DbJobStore)
    store._pool = Pool()  # type: ignore[assignment]
    store._pool_open = True
    store._table_name = AI_TABLE
    monkeypatch.setattr(store, "open", AsyncMock())
    work = ReviewWorkItem(
        job_id="job",
        requester_id="user",
        topic="topic",
        report_type="research_report",
        report="body",
        sources=(),
        draft_research_id="research",
        attempts=1,
        review_details={"sourceSnapshotFormat": "canonical-v1"},
        review_run_id="run",
        source_snapshot_hash="old-hash",
        claim_token="token",
    )
    await store.complete_review(work, {"status": "passed", "review_outcome": "clear"})
    assert any("\"executionStatus\" = 'stale'" in sql for sql, _ in calls)
    assert not any(isinstance(params, tuple) and params and params[0] == "completed" for _, params in calls)
