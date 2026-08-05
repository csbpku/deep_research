from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.fetcher.safe_fetch import FetchedDocument, SafeFetchError
from ai_engine.share_submission_worker import run_one_share_submission


class _Cursor:
    def __init__(self, row: dict[str, Any] | None = None) -> None:
        self.row = row

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row


class _Connection:
    def __init__(self, *, duplicate: bool = False) -> None:
        self.executions: list[tuple[str, tuple[Any, ...]]] = []
        self.duplicate = duplicate
        self.acquired = False

    @asynccontextmanager
    async def transaction(self):  # type: ignore[no-untyped-def]
        yield

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        if 'RETURNING s."id", s."submitterId"' in sql:
            if self.acquired:
                return _Cursor(None)
            self.acquired = True
            return _Cursor({
                "id": "submission-1",
                "submitterId": "user-1",
                "url": "https://example.com/article?utm_source=x",
                "canonicalUrl": "https://example.com/article",
                "userNote": "read later",
                "attempts": 1,
            })
        if 'SELECT "attempts" FROM "share_submissions"' in sql:
            return _Cursor({"attempts": 1})
        if 'UPDATE "share_submissions" SET "canonicalUrl"' in sql:
            return _Cursor({"id": "submission-1"})
        if 'UPDATE "share_submissions" SET "fetchErrorCode"' in sql:
            return _Cursor({"id": "submission-1"})
        if 'UPDATE "share_submissions" SET "leaseExpiresAt"' in sql:
            return _Cursor({"id": "submission-1"})
        return _Cursor(None)

    async def commit(self) -> None:
        return None


class _Pool:
    def __init__(self, *, duplicate: bool = False) -> None:
        self.connection_value = _Connection(duplicate=duplicate)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def _document() -> FetchedDocument:
    return FetchedDocument(
        url="https://example.com/article?utm_source=x",
        final_ip="93.184.216.34",
        status=200,
        headers={"content-type": "text/html"},
        content=b"<title>User article</title><p>LLM agent and RAG update</p>",
        content_type="text/html",
        elapsed_ms=9,
        redirect_count=0,
    )


async def test_share_pending_is_fetched_but_not_published_before_review() -> None:
    pool = _Pool()

    async def fetcher(url: str, **kwargs: Any) -> FetchedDocument:
        return _document()

    result = await run_one_share_submission(
        pool,
        FakeAdapter(),
        worker_id="share-1",
        fetcher=fetcher,
    )
    assert result is not None
    assert result.created_candidate is False
    assert result.summary_id is None
    inserts = [item for item in pool.connection_value.executions if 'INSERT INTO "summaries"' in item[0]]
    assert inserts == []
    update = next(
        item for item in pool.connection_value.executions
        if 'UPDATE "share_submissions" SET "canonicalUrl"' in item[0]
    )
    assert update[1][0] == "https://example.com/article"


async def test_safe_fetch_failure_keeps_share_pending() -> None:
    pool = _Pool()

    async def blocked(url: str, **kwargs: Any) -> FetchedDocument:
        raise SafeFetchError("URL_FETCH_BLOCKED", "private target", host="private.test")

    result = await run_one_share_submission(
        pool,
        FakeAdapter(),
        worker_id="share-1",
        fetcher=blocked,
    )
    assert result is not None
    assert result.fetch_error_code == "URL_FETCH_BLOCKED"
    update = next(
        item for item in pool.connection_value.executions
        if 'UPDATE "share_submissions" SET "fetchErrorCode"' in item[0]
    )
    assert '"status"' in update[0]  # WHERE status = 'pending' in update
    assert update[1][0] == "URL_FETCH_BLOCKED"
    assert "private target" not in update[1]


async def test_share_worker_returns_none_when_queue_empty() -> None:
    pool = _Pool()
    pool.connection_value.acquired = True
    result = await run_one_share_submission(pool, FakeAdapter(), worker_id="share-1")
    assert result is None


async def test_share_brief_failure_schedules_retry() -> None:
    pool = _Pool()

    async def fetcher(url: str, **kwargs: Any) -> FetchedDocument:
        return _document()

    async def failed_brief(*args: Any, **kwargs: Any) -> Any:
        raise TimeoutError("adapter timeout")

    result = await run_one_share_submission(
        pool,
        FakeAdapter(),
        worker_id="share-1",
        fetcher=fetcher,
        generate_brief=failed_brief,
    )
    assert result is not None
    assert result.fetch_error_code == "AI_ENGINE_UNAVAILABLE"
    retry_update = next(
        item for item in pool.connection_value.executions if '"nextRetryAt"' in item[0]
    )
    # retry_update[1] = params tuple; first element is nextRetryAt seconds, skip check
    assert "adapter timeout" not in retry_update[1]


@pytest.mark.parametrize("secret", ["read later", "utm_source=x", "adapter timeout"])
async def test_share_worker_does_not_put_sensitive_text_in_error_fields(secret: str) -> None:
    pool = _Pool()

    async def fetcher(url: str, **kwargs: Any) -> FetchedDocument:
        return _document()

    async def failed_brief(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("adapter timeout")

    await run_one_share_submission(
        pool,
        FakeAdapter(),
        worker_id="share-1",
        fetcher=fetcher,
        generate_brief=failed_brief,
    )
    updates = [params for sql, params in pool.connection_value.executions if "fetchError" in sql]
    assert all(secret not in str(params) for params in updates)
