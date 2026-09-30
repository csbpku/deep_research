from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock
from types import SimpleNamespace
from typing import Any

from scripts import backfill_radar_briefs as job


class _Connection:
    def __init__(self) -> None:
        self.statements: list[tuple[str, tuple[Any, ...]]] = []

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any:
        self.statements.append((sql, params))
        return SimpleNamespace(fetchone=self._saved)

    async def _saved(self) -> dict[str, str]:
        return {"id": "one"}

    async def commit(self) -> None:
        pass


class _Pool:
    def __init__(self) -> None:
        self.conn = _Connection()

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.conn


async def test_external_judgement_uses_transient_source_and_only_persists_result(
    monkeypatch: Any,
) -> None:
    pool = _Pool()
    calls: list[dict[str, Any]] = []

    async def transient(*args: Any) -> tuple[str, str]:
        return ("Verified project details, tests and limitations. " * 15, "transient_source")

    async def generate(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return SimpleNamespace(text="该项目提供隔离执行环境，适合需要受控工具访问的代理；来源未提供独立验证结果。")

    monkeypatch.setattr(job, "transient_scoring_input", transient)
    monkeypatch.setattr(job, "generate_text", generate)
    result = await job._backfill_one(
        pool,
        {
            "id": "one", "title": "NVIDIA/OpenShell",
            "tags": ["external_reading"], "body": "NVIDIA/OpenShell",
        },
        timeout_seconds=30,
    )
    assert result.state == "updated"
    assert "Verified project details" in calls[0]["user_prompt"]
    assert calls[0]["disable_thinking"] is True
    sql, params = pool.conn.statements[0]
    assert '"interpretation" = %s' in sql
    assert "btrim(COALESCE" in sql
    assert "Verified project details" not in str(params)


async def test_missing_external_evidence_does_not_invent_judgement(
    monkeypatch: Any,
) -> None:
    pool = _Pool()

    async def no_evidence(*args: Any) -> None:
        return None

    monkeypatch.setattr(job, "transient_scoring_input", no_evidence)
    result = await job._backfill_one(
        pool, {"id": "one", "tags": ["external_reading"], "body": "short"},
        timeout_seconds=30,
    )
    assert result.state == "skipped"
    assert not pool.conn.statements


async def test_quota_is_retried_after_fifteen_minutes_without_losing_progress(
    monkeypatch: Any, tmp_path: Any,
) -> None:
    attempts = 0

    async def backfill(*args: Any, **kwargs: Any) -> job.BackfillResult:
        nonlocal attempts
        attempts += 1
        return job.BackfillResult(
            "one", "quota" if attempts == 1 else "updated",
        )

    sleep = AsyncMock()
    monkeypatch.setattr(job, "_backfill_one", backfill)
    monkeypatch.setattr(job.asyncio, "sleep", sleep)
    checkpoint = tmp_path / "judgements.json"
    counts = await job._run(
        _Pool(), [{"id": "one"}], concurrency=1,
        timeout=30, state_file=checkpoint,
    )
    assert counts == {"updated": 1, "skipped": 0, "failed": 0}
    assert sleep.await_args.args[0] == 900
    assert attempts == 2
    assert checkpoint.exists()
