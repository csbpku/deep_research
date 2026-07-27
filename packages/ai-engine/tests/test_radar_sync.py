from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import httpx

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError
from ai_engine.radar.models import RadarCandidate, RadarSource
from ai_engine.radar.source_manager import fetch_source as dispatch_source
from ai_engine.radar.sync_runner import run_radar_sync


class _Cursor:
    def __init__(self, row: dict[str, Any] | None = None, rows: list[dict[str, Any]] | None = None) -> None:
        self.row = row
        self.rows = rows or []

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(self, sources: list[dict[str, Any]]) -> None:
        self.sources = sources
        self.executions: list[tuple[str, tuple[Any, ...]]] = []
        self.canonical_urls: set[str] = set()

    @asynccontextmanager
    async def transaction(self):  # type: ignore[no-untyped-def]
        yield

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        if 'FROM "radar_sources" WHERE "enabled"' in sql:
            return _Cursor(rows=self.sources)
        if 'SELECT "id" FROM "summaries"' in sql:
            canonical = str(params[0])
            return _Cursor({"id": "existing"} if canonical in self.canonical_urls else None)
        if 'INSERT INTO "summaries"' in sql:
            canonical = str(params[4])
            if canonical in self.canonical_urls:
                return _Cursor(None)
            self.canonical_urls.add(canonical)
            return _Cursor({"id": str(params[0])})
        if 'INSERT INTO "radar_sync_runs"' in sql:
            return _Cursor()
        return _Cursor()

    async def commit(self) -> None:
        return None


class _Pool:
    def __init__(self, sources: list[dict[str, Any]]) -> None:
        self.connection_value = _Connection(sources)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def _source(source_id: str = "source-1", source_type: str = "rss") -> dict[str, Any]:
    return {
        "id": source_id,
        "name": source_type,
        "sourceType": source_type,
        "config": {},
    }


def _candidate(url: str = "https://example.com/item") -> RadarCandidate:
    return RadarCandidate(
        title="LLM agent update",
        url=url,
        snippet="RAG update",
        published_at=datetime.now(timezone.utc),
        content_origin="rss",
        tags=("ai",),
    )


def _document(url: str = "https://example.com/item") -> FetchedDocument:
    return FetchedDocument(
        url=url,
        final_ip="93.184.216.34",
        status=200,
        headers={"content-type": "text/html"},
        content=b"<title>LLM agent update</title><p>Verified RAG source</p>",
        content_type="text/html",
        elapsed_ms=5,
        redirect_count=0,
    )


async def _safe_fetch(url: str, **kwargs: Any) -> FetchedDocument:
    return _document(url)


async def test_sync_writes_candidate_fields_and_cost() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
    )
    assert result.runs[0].status == "completed"
    assert result.runs[0].total_new == 1
    assert result.runs[0].token_input_total > 0
    insert = next(item for item in pool.connection_value.executions if 'INSERT INTO "summaries"' in item[0])
    sql, params = insert
    assert "'candidate'" in sql
    assert "'daily'" in sql
    assert params[5] == "rss"
    assert params[14] == "1.0"
    assert "仅用于排序，不自动发布" in params[15]


async def test_sync_duplicate_canonical_url_rerun_does_not_insert() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate("https://EXAMPLE.com/item/?utm_source=x#part")]

    kwargs = {
        "adapter": FakeAdapter(),
        "fetchers": {"rss": fetcher},
        "document_fetcher": _safe_fetch,
    }
    first = await run_radar_sync(pool, **kwargs)
    second = await run_radar_sync(pool, **kwargs)
    assert first.runs[0].total_new == 1
    assert second.runs[0].total_new == 0
    assert second.runs[0].total_skipped == 1


async def test_source_failure_does_not_block_other_source() -> None:
    pool = _Pool([_source("bad", "rss"), _source("good", "github")])

    async def failed(config: dict[str, Any]) -> list[RadarCandidate]:
        raise httpx.TimeoutException("timeout")

    async def good(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate("https://example.com/good")]

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": failed, "github": good},
        document_fetcher=_safe_fetch,
    )
    assert [run.status for run in result.runs] == ["failed", "completed"]
    assert result.runs[1].total_new == 1


async def test_candidate_safe_fetch_failure_makes_run_partial() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [_candidate()]

    async def blocked(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError("URL_FETCH_BLOCKED", "blocked", host="example.com")

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=blocked,
    )
    assert result.runs[0].status == "partial"
    assert result.runs[0].total_failed == 1
    assert result.runs[0].error_code == "URL_FETCH_BLOCKED"


async def test_generate_failure_isolated_from_next_candidate() -> None:
    pool = _Pool([_source()])

    async def fetcher(config: dict[str, Any]) -> list[RadarCandidate]:
        return [
            _candidate("https://example.com/one"),
            _candidate("https://example.com/two"),
        ]

    calls = 0

    async def generate(adapter: Any, item: dict[str, Any], canonical: str, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TimeoutError("brief timeout")
        from ai_engine.ingestion.pipeline import _generate_brief

        return await _generate_brief(adapter, item, canonical, **kwargs)

    result = await run_radar_sync(
        pool,
        adapter=FakeAdapter(),
        fetchers={"rss": fetcher},
        document_fetcher=_safe_fetch,
        generate_brief=generate,
    )
    assert result.runs[0].status == "partial"
    assert result.runs[0].total_failed == 1
    assert result.runs[0].total_new == 1


async def test_sync_rejects_invalid_trigger() -> None:
    pool = _Pool([])
    import pytest

    with pytest.raises(ValueError, match="cron or admin"):
        await run_radar_sync(pool, triggered_by="machine")


async def test_dispatch_source_configuration_is_passed() -> None:
    source = RadarSource("s", "rss", "rss", {"feedUrl": "https://feed.test"})
    seen: list[dict[str, Any]] = []

    async def handler(config: dict[str, Any]) -> list[RadarCandidate]:
        seen.append(config)
        return []

    await dispatch_source(source, fetchers={"rss": handler})
    assert seen == [{"feedUrl": "https://feed.test"}]


# ───────────── W7 (engineer B): S1 #7 regression ─────────────


async def test_arxiv_source_failure_surfaces_typed_root_cause() -> None:
    """Regression for S1 #7: when the arxiv fetcher fails, the sync
    runner's `error_code` must reflect the *root cause* (e.g. a
    network/timeout/parse error) instead of collapsing everything to
    ``AI_ENGINE_UNAVAILABLE``.
    """
    pool = _Pool([_source("arxiv-1", "arxiv")])

    async def broken_arxiv(config: dict[str, Any]) -> list[RadarCandidate]:
        # Simulate ``fetch_arxiv`` raising a typed RuntimeError when
        # the upstream service is unreachable.
        raise RuntimeError("arxiv_timeout:ReadTimeout")

    result = await run_radar_sync(
        pool,
        triggered_by="admin",
        adapter=FakeAdapter(),
        fetchers={"arxiv": broken_arxiv},
        document_fetcher=_safe_fetch,
    )
    assert result.runs[0].status == "failed"
    # The arxiv_timeout prefix must be translated to WORKER_TIMEOUT,
    # NOT AI_ENGINE_UNAVAILABLE — the walkthrough regression that
    # this test pins.
    assert result.runs[0].error_code == "WORKER_TIMEOUT", (
        f"expected WORKER_TIMEOUT, got {result.runs[0].error_code!r}"
    )
