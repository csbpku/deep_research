from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.ingestion.pipeline import canonicalize_url, run_ingestion


class _Cursor:
    def __init__(self, row: dict[str, str] | None) -> None:
        self._row = row

    async def fetchone(self) -> dict[str, str] | None:
        return self._row


class _Connection:
    def __init__(self, rows: list[dict[str, str] | None]) -> None:
        self.rows = rows
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    @asynccontextmanager
    async def transaction(self):  # type: ignore[no-untyped-def]
        yield

    async def execute(self, sql: str, params: tuple[Any, ...]) -> _Cursor:
        self.executions.append((sql, params))
        return _Cursor(self.rows.pop(0))


class _Pool:
    def __init__(self, rows: list[dict[str, str] | None]) -> None:
        self.connection_value = _Connection(rows)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


async def _rss(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    return [{
        "title": "Useful source",
        "url": "HTTPS://Example.com/post/?utm_source=test#section",
        "snippet": "Verified source text",
        "source": "daily",
        "content_origin": "rss",
        "tags": ["tech"],
    }]


async def _arxiv(*args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    return []


def test_canonicalize_url_removes_tracking_and_fragment() -> None:
    assert canonicalize_url("https://EXAMPLE.com/a/?utm_source=x&keep=1#part") == (
        "https://example.com/a?keep=1"
    )
    assert canonicalize_url("javascript:alert(1)") == ""


async def test_ingestion_publishes_generated_brief_with_metrics() -> None:
    pool = _Pool([{"id": "summary-id"}])
    result = await run_ingestion(
        pool,
        adapter=FakeAdapter(),
        fetch_rss=_rss,
        fetch_arxiv_items=_arxiv,
    )

    assert result.sources_attempted == 2
    assert result.sources_succeeded == 2
    assert result.summaries_inserted == 1
    assert result.generation_failed == 0
    assert result.token_input_total > 0
    assert result.token_output_total > 0
    sql, params = pool.connection_value.executions[0]
    assert "'published'" in sql
    assert params[4] == "https://example.com/post"
    assert params[9] == result.token_input_total + result.token_output_total


async def test_ingestion_counts_database_duplicate() -> None:
    pool = _Pool([None])
    result = await run_ingestion(
        pool,
        adapter=FakeAdapter(),
        fetch_rss=_rss,
        fetch_arxiv_items=_arxiv,
    )
    assert result.duplicates_skipped == 1
    assert result.summaries_inserted == 0
