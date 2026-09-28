from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.adapters.base import AdapterError
from ai_engine.job_runner.db_store import DbJobStore

REQUESTER_ID = "11111111-1111-4111-8111-111111111111"
RESEARCH_ID = "22222222-2222-4222-8222-222222222222"


class _Cursor:
    def __init__(self, row: dict[str, Any] | None) -> None:
        self.row = row

    async def fetchone(self) -> dict[str, Any] | None:
        return self.row


class _Connection:
    def __init__(self, row: dict[str, Any] | None) -> None:
        self.row = row
        self.sql = ""
        self.params: tuple[Any, ...] = ()

    async def execute(self, sql: str, params: tuple[Any, ...]) -> _Cursor:
        self.sql = sql
        self.params = params
        return _Cursor(self.row)


class _Pool:
    def __init__(self, connection: _Connection) -> None:
        self.connection_value = connection

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


def _store(row: dict[str, Any] | None) -> tuple[DbJobStore, _Connection]:
    store = DbJobStore(dsn="postgresql://unused/unused")
    connection = _Connection(row)
    store._pool = _Pool(connection)  # type: ignore[assignment]
    store._pool_open = True
    return store, connection


async def test_internal_research_ref_hydrates_latest_database_content() -> None:
    store, connection = _store({
        "title": "Private draft",
        "url": None,
        "interpretation": None,
        "body": "Latest database text",
    })

    refs = await store.resolve_internal_source_refs(
        [{"type": "research", "value": RESEARCH_ID, "required": True}],
        requester_id=REQUESTER_ID,
    )

    assert refs == ({
        "type": "research",
        "value": RESEARCH_ID,
        "required": True,
        "resolvedTitle": "Private draft",
        "resolvedSnippet": "Latest database text",
    },)
    assert "status = \'published\' OR (\"authorId\" = %s AND status = \'draft\')" in connection.sql
    assert connection.params == (RESEARCH_ID, REQUESTER_ID)


async def test_required_private_research_ref_rejects_another_users_record() -> None:
    store, connection = _store(None)

    with pytest.raises(AdapterError) as caught:
        await store.resolve_internal_source_refs(
            [{"type": "research", "value": RESEARCH_ID, "required": True}],
            requester_id=REQUESTER_ID,
        )

    assert caught.value.code == "AI_SOURCE_NOT_VISIBLE"
    assert connection.params == (RESEARCH_ID, REQUESTER_ID)


async def test_internal_summary_ref_rechecks_public_radar_visibility() -> None:
    store, connection = _store({
        "title": "Public radar item",
        "url": "https://example.com/public",
        "interpretation": "A reviewed public summary",
        "body": "Current database text",
    })

    refs = await store.resolve_internal_source_refs(
        [{"type": "summary", "value": RESEARCH_ID, "required": True}],
        requester_id=REQUESTER_ID,
    )

    assert refs == ({
        "type": "summary",
        "value": RESEARCH_ID,
        "required": True,
        "resolvedTitle": "Public radar item",
        "resolvedSnippet": "A reviewed public summary",
        "resolvedUrl": "https://example.com/public",
    },)
    assert 'share."publishedSummaryId" = s.id' in connection.sql
    assert "requester.role = 'admin'" in connection.sql
    assert "s.status::text IN ('candidate', 'published')" in connection.sql
    assert 's."syncRunId" IS NOT NULL' in connection.sql
    assert "s.\"readerQualityStatus\" = 'ready'" in connection.sql
    assert "share.status::text = 'approved'" in connection.sql
    assert connection.params == (RESEARCH_ID, REQUESTER_ID)


async def test_required_summary_ref_rejects_hidden_or_unreviewed_radar_item() -> None:
    store, connection = _store(None)

    with pytest.raises(AdapterError) as caught:
        await store.resolve_internal_source_refs(
            [{"type": "summary", "value": RESEARCH_ID, "required": True}],
            requester_id=REQUESTER_ID,
        )

    assert caught.value.code == "AI_SOURCE_NOT_VISIBLE"
    assert connection.params == (RESEARCH_ID, REQUESTER_ID)
