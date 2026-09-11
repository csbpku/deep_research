from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.radar import content_pending_recovery as recovery


class _Cursor:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class _Connection:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.executions.append((sql, params))
        return _Cursor(self.rows)


class _Pool:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.connection_value = _Connection(rows)

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


@pytest.mark.asyncio
async def test_content_pending_recovery_refetches_then_scores(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool([{"id": "summary-1"}, {"id": "summary-2"}])
    calls: list[tuple[str, tuple[str, ...]]] = []

    async def enrich(_: Any, **kwargs: Any) -> int:
        calls.append(("enrich", kwargs["summary_ids"]))
        return 2

    async def score(_: Any, **kwargs: Any) -> int:
        calls.append(("score", kwargs["summary_ids"]))
        return 1

    monkeypatch.setattr(recovery, "run_enrichment_for_pending", enrich)
    monkeypatch.setattr(recovery, "score_missing_candidates", score)

    result = await recovery.recover_content_pending_candidates(
        pool,
        limit=2,
        concurrency=1,
    )

    assert result.to_dict() == {"selected": 2, "enriched": 2, "scored": 1}
    assert calls == [
        ("enrich", ("summary-1", "summary-2")),
        ("score", ("summary-1", "summary-2")),
    ]
    sql, params = pool.connection_value.executions[0]
    assert "'content_pending'" in sql
    assert '"enrichmentAttempts"' in sql
    assert params == (3, 15, 2)


@pytest.mark.asyncio
async def test_content_pending_recovery_is_idle_without_candidates() -> None:
    pool = _Pool([])

    result = await recovery.recover_content_pending_candidates(pool, limit=2)

    assert result.to_dict() == {"selected": 0, "enriched": 0, "scored": 0}
