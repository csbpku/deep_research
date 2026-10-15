from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.radar import sync_endpoint


class _Cursor:
    def __init__(
        self,
        *,
        row: dict[str, Any] | None = None,
        rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self._row = row
        self._rows = rows or []

    async def fetchone(self) -> dict[str, Any] | None:
        return self._row

    async def fetchall(self) -> list[dict[str, Any]]:
        return self._rows


class _Connection:
    def __init__(
        self,
        *,
        reaped_ids: list[str] | None = None,
        active: bool = False,
    ) -> None:
        self.reaped_ids = reaped_ids or []
        self.active = active
        self.executions: list[tuple[str, tuple[Any, ...]]] = []
        self.commits = 0

    async def execute(
        self,
        sql: str,
        params: tuple[Any, ...] = (),
    ) -> _Cursor:
        self.executions.append((sql, params))
        if 'UPDATE "radar_sync_runs"' in sql and "STALE_RUN_REAPED" in sql:
            return _Cursor(rows=[{"id": run_id} for run_id in self.reaped_ids])
        if 'SELECT 1 FROM "radar_sync_runs"' in sql:
            return _Cursor(row={"?column?": 1} if self.active else None)
        return _Cursor()

    async def commit(self) -> None:
        self.commits += 1


class _Pool:
    def __init__(
        self,
        *,
        reaped_ids: list[str] | None = None,
        active: bool = False,
    ) -> None:
        self.connection_value = _Connection(
            reaped_ids=reaped_ids,
            active=active,
        )

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


async def test_reap_stale_radar_runs_commits_and_clears_legacy_or_expired_runs() -> None:
    pool = _Pool(reaped_ids=["expired", "legacy"])

    count = await sync_endpoint.reap_stale_radar_runs(pool)

    assert count == 2
    assert pool.connection_value.commits == 1
    sql, _ = pool.connection_value.executions[0]
    assert '"leaseExpiresAt" < now()' in sql
    assert '"leaseExpiresAt" IS NULL' in sql
    assert "interval '15 minutes'" in sql
    assert '"lockedBy" = NULL' in sql
    assert '"heartbeatAt" = NULL' in sql


async def test_cron_job_reaps_stale_runs_before_starting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(reaped_ids=["stale-run"], active=False)
    background_calls: list[dict[str, Any]] = []

    async def fake_background(**kwargs: Any) -> None:
        background_calls.append(kwargs)

    monkeypatch.setattr(sync_endpoint, "_run_background", fake_background)

    started = await sync_endpoint.run_radar_sync_job(
        pool=pool,
        adapter=FakeAdapter(),
        triggered_by="cron",
        request_id="cron-1",
    )

    assert pool.connection_value.commits == 1
    assert started is True
    assert len(background_calls) == 1
    assert background_calls[0]["request_id"] == "cron-1"


async def test_cron_job_skips_when_a_live_run_remains(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = _Pool(active=True)
    background_called = False

    async def fake_background(**kwargs: Any) -> None:
        del kwargs
        nonlocal background_called
        background_called = True

    monkeypatch.setattr(sync_endpoint, "_run_background", fake_background)

    started = await sync_endpoint.run_radar_sync_job(
        pool=pool,
        adapter=FakeAdapter(),
        triggered_by="cron",
        request_id="cron-2",
    )
    assert started is False

    assert pool.connection_value.commits == 1
    assert background_called is False


async def test_tiered_loop_rechecks_due_sources_after_active_guard(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio
    import importlib
    from datetime import datetime, timedelta, timezone
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    server = importlib.import_module('ai_engine.server.app')
    row = {'id': 'arxiv-source', 'sourceType': 'arxiv', 'config': {},
           'lastSyncAt': datetime.now(timezone.utc) - timedelta(hours=2)}
    pool = _Pool()
    pool.connection_value.execute = AsyncMock(return_value=_Cursor(rows=[row]))  # type: ignore[method-assign]
    job = AsyncMock(side_effect=[False, True])
    monkeypatch.setattr(sync_endpoint, 'run_radar_sync_job', job)
    ticks = 0

    async def tick(_: float) -> None:
        nonlocal ticks
        ticks += 1
        if ticks > 2:
            raise asyncio.CancelledError

    monkeypatch.setattr(server.asyncio, 'sleep', tick)
    app = SimpleNamespace(state=SimpleNamespace(db_pool=pool, adapter=FakeAdapter()))
    with pytest.raises(asyncio.CancelledError):
        await server._radar_tiered_sync_loop(app)
    assert job.await_count == 2
    assert all(c.kwargs['source_ids'] == {'arxiv-source'} for c in job.await_args_list)
