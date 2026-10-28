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
