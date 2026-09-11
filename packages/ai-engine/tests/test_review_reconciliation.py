from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from ai_engine.radar import review_reconciliation as rr
from ai_engine.radar.reader_quality import ReaderQuality


class _Cursor:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows or []

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(
        self,
        sql: str,
        params: tuple[Any, ...] = (),
    ) -> _Cursor:
        self.executions.append((sql, params))
        return _Cursor(self.rows)


class _Pool:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.connection_value = _Connection(rows)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def _quality(status: str = "ready") -> ReaderQuality:
    return ReaderQuality(
        status=status,  # type: ignore[arg-type]
        reason="test",
        message="test",
        char_count=1000,
        fingerprint="fingerprint",
        details={},
    )


@pytest.mark.asyncio
async def test_review_enriched_summary_runs_quality_then_content_then_render(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def claim(*_: Any, **__: Any) -> bool:
        calls.append("claim")
        return True

    async def quality(*_: Any, **__: Any) -> ReaderQuality:
        calls.append("quality")
        return _quality()

    async def review(*_: Any, **__: Any) -> Any:
        calls.append("content")
        return SimpleNamespace(status="approved", round=1, cycle_id="cycle")

    async def queue(*_: Any, **__: Any) -> bool:
        calls.append("render")
        return True

    monkeypatch.setattr(rr, "claim_content_review", claim)
    monkeypatch.setattr(rr, "load_and_persist_reader_quality", quality)
    monkeypatch.setattr(rr, "run_content_review_cycle", review)
    monkeypatch.setattr(rr, "queue_render_review", queue)

    result = await rr.review_enriched_summary(object(), summary_id="summary-1")

    assert calls == ["claim", "quality", "content", "render"]
    assert result == {
        "summary_id": "summary-1",
        "quality_status": "ready",
        "content_status": "approved",
        "quality_manual": False,
        "render_queued": True,
    }


@pytest.mark.asyncio
async def test_quality_failure_never_calls_llm_and_still_queues_browser_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def claim(*_: Any, **__: Any) -> bool:
        calls.append("claim")
        return True

    async def quality(*_: Any, **__: Any) -> ReaderQuality:
        calls.append("quality")
        return _quality("incomplete")

    async def manual(*_: Any, **__: Any) -> None:
        calls.append("manual")

    async def review(*_: Any, **__: Any) -> Any:
        calls.append("content")
        raise AssertionError("quality-gated content must not call the LLM")

    async def queue(*_: Any, **__: Any) -> bool:
        calls.append("render")
        return True

    monkeypatch.setattr(rr, "claim_content_review", claim)
    monkeypatch.setattr(rr, "load_and_persist_reader_quality", quality)
    monkeypatch.setattr(rr, "persist_quality_manual_review", manual)
    monkeypatch.setattr(rr, "run_content_review_cycle", review)
    monkeypatch.setattr(rr, "queue_render_review", queue)

    result = await rr.review_enriched_summary(object(), summary_id="summary-1")

    assert calls == ["claim", "quality", "manual", "render"]
    assert result is not None
    assert result["content_status"] == "needs_manual_review"
    assert result["quality_manual"] is True


@pytest.mark.asyncio
async def test_review_claim_skip_does_not_touch_quality_or_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def claim(*_: Any, **__: Any) -> bool:
        return False

    async def should_not_run(*_: Any, **__: Any) -> Any:
        raise AssertionError("unclaimed row must not be processed")

    monkeypatch.setattr(rr, "claim_content_review", claim)
    monkeypatch.setattr(rr, "load_and_persist_reader_quality", should_not_run)
    monkeypatch.setattr(rr, "run_content_review_cycle", should_not_run)

    assert await rr.review_enriched_summary(object(), summary_id="summary-1") is None


@pytest.mark.asyncio
async def test_quality_reconciliation_refreshes_legacy_or_snapshot_mismatched_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool([{"id": "summary-legacy"}])
    refreshed: list[str] = []

    async def fake_quality(_: Any, *, summary_id: str) -> ReaderQuality:
        refreshed.append(summary_id)
        return _quality()

    monkeypatch.setattr(rr, "load_and_persist_reader_quality", fake_quality)

    count = await rr._refresh_stale_reader_quality(pool, limit=5)

    assert count == 1
    assert refreshed == ["summary-legacy"]
    sql, params = pool.connection_value.executions[0]
    assert '"readerQualityDetails"->>\'contentSha256\'' in sql
    assert 'IS DISTINCT FROM "originalSha256"' in sql
    assert params == (rr.READER_QUALITY_VERSION, 5)


@pytest.mark.asyncio
async def test_render_reconciliation_requeues_legacy_audits_without_snapshot_hash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool([{"id": "summary-legacy-render"}])
    queued: list[str] = []

    async def fake_queue(_: Any, *, summary_id: str) -> bool:
        queued.append(summary_id)
        return True

    monkeypatch.setattr(rr, "queue_render_review", fake_queue)

    count = await rr._queue_stale_render_reviews(pool, limit=3)

    assert count == 1
    assert queued == ["summary-legacy-render"]
    sql, params = pool.connection_value.executions[0]
    assert '"renderReviewStatus" IN' in sql
    assert 'IS DISTINCT FROM "originalSha256"' in sql
    assert params == (3,)


@pytest.mark.asyncio
async def test_render_reconciliation_requeues_transient_sidecar_failures(
) -> None:
    pool = _Pool([{"id": "summary-sidecar"}])

    count = await rr._queue_transient_unavailable_render_reviews(
        pool,
        limit=3,
    )

    assert count == 1
    sql, params = pool.connection_value.executions[0]
    assert '"renderReviewStatus" = \'unavailable\'' in sql
    assert "LIKE \'ConnectError:%%\'" in sql
    assert "TRANSIENT_UNAVAILABLE_RETRY" in sql
    assert params == (rr.RENDER_REVIEW_TRANSIENT_MAX_ROUNDS, 3)
