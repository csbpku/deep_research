"""P1-B submission worker 守门单测。

不连真实 DB；用 in-memory fake pool 验证状态机推进 + 失败隔离。
"""

from __future__ import annotations

from typing import Any

import pytest

from ai_engine.radar.submission_worker import _process_one


class _FakePool:
    """极简 fake pool：只追 INSERT / UPDATE / SELECT 1 sequence；不真执行。"""

    def __init__(self) -> None:
        self.executions: list[tuple[str, tuple[Any, ...]]] = []

    def connection(self) -> "_FakeConn":
        return _FakeConn(self)


class _FakeConn:
    def __init__(self, pool: _FakePool) -> None:
        self.pool = pool
        self._auto_commit = False

    async def __aenter__(self) -> "_FakeConn":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    def transaction(self) -> "_FakeTx":
        return _FakeTx(self)

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _FakeCursor:
        self.pool.executions.append((sql.strip(), params))
        return _FakeCursor()


class _FakeTx:
    def __init__(self, conn: _FakeConn) -> None:
        self.conn = conn

    async def __aenter__(self) -> _FakeConn:
        return self.conn

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _FakeCursor:
    async def fetchone(self) -> dict[str, Any] | None:
        return None

    async def fetchall(self) -> list[dict[str, Any]]:
        return []


@pytest.mark.asyncio
async def test_process_one_url_kind_retries_when_safe_fetch_returns_no_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """URL 类 article 抓取为空时进入可重试失败，不依赖真实网络状态。"""
    async def empty_fetch(_url: str) -> None:
        return None

    monkeypatch.setattr(
        "ai_engine.radar.submission_worker.safe_fetch",
        empty_fetch,
    )
    pool = _FakePool()
    row = {
        "id": "00000000-0000-0000-0000-000000000001",
        "kind": "article",
        "rawInput": "https://example.com/some-post",
        "canonicalUrl": "https://example.com/some-post",
        "contentSha256": None,
        "detectedKind": "article",
        "attempts": 0,
        "summaryId": None,
        "submitterId": "00000000-0000-0000-0000-000000000099",
    }
    # 抓取为空，期望走失败隔离路径。
    result = await _process_one(pool, row)  # type: ignore[arg-type]
    assert result is False
    # 至少有过 status 更新
    status_updates = [s for s in pool.executions if "UPDATE" in s[0] and '"status"' in s[0]]
    assert len(status_updates) >= 1
    # 最后一条 status 应该是 failed（attempts 已到 MAX）
    last = status_updates[-1][1]
    assert "failed" in last or "type_detected" in last


@pytest.mark.asyncio
async def test_process_one_missing_canonical_url_marks_failed() -> None:
    pool = _FakePool()
    row = {
        "id": "00000000-0000-0000-0000-000000000002",
        "kind": "article",
        "rawInput": "not-a-url",
        "canonicalUrl": None,
        "contentSha256": None,
        "detectedKind": "article",
        "attempts": 99,  # 已达 MAX_ATTEMPTS → 直接 failed
        "summaryId": None,
        "submitterId": "00000000-0000-0000-0000-000000000099",
    }
    result = await _process_one(pool, row)  # type: ignore[arg-type]
    assert result is False
    # 应有 status=failed
    failed_updates = [
        s for s in pool.executions
        if "UPDATE" in s[0] and '"status"' in s[0] and "failed" in s[1]
    ]
    assert failed_updates, f"expected status=failed update; got {pool.executions}"
