"""Transactional PostgreSQL checks for the radar backlog and legacy identities."""

from __future__ import annotations

import os
import uuid
from contextlib import asynccontextmanager
from datetime import date
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row

from ai_engine.radar.sync_endpoint import list_radar_runs
from ai_engine.radar.sync_runner import _existing_candidate

pytestmark = pytest.mark.requires_db


async def test_backlog_spans_runs_and_legacy_identity_only_matches_the_same_entry() -> None:
    dsn = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("requires a dedicated PostgreSQL test database")
    source_id, old_run, latest_run = (str(uuid.uuid4()) for _ in range(3))
    base_url = f"https://example.test/{source_id}/notes"
    async with await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row) as conn:
        async with conn.transaction(force_rollback=True):
            await conn.execute(
                'INSERT INTO radar_sources (id,name,"sourceType",config,"updatedAt") '
                "VALUES (%s,'fixture','vendor_changelog','{}'::jsonb,now())", (source_id,),
            )
            await conn.execute(
                'INSERT INTO radar_sync_runs (id,"sourceId","triggeredBy",status,"createdAt",'
                '"tokenInputTotal","fallbackCount") VALUES '
                "(%s,%s,'cron','completed','2099-01-01 04:00+00',0,0),"
                "(%s,%s,'cron','completed','2099-01-02 04:00+00',100,2)",
                (old_run, source_id, latest_run, source_id),
            )
            await conn.execute(
                'INSERT INTO summaries (id,title,body,url,"canonicalUrl",source,"summaryDate",'
                'status,"syncRunId","createdAt","updatedAt") VALUES '
                "(%s,'old entry','body',%s,%s,'daily','2099-01-01','candidate',%s,now(),now())",
                (str(uuid.uuid4()), base_url + "#first", base_url, old_run),
            )

            class Pool:
                @asynccontextmanager
                async def connection(self):  # type: ignore[no-untyped-def]
                    yield conn

            pool: Any = Pool()
            rows = await list_radar_runs(None, pool, None, limit=500, run_date=date(2099, 1, 2))  # type: ignore[arg-type]
            current = next(row for row in rows if row.id == latest_run)
            assert current.pendingScoreCount == 0
            assert current.sourcePendingScoreCount == 1
            assert current.fallbackCount == 2
            assert current.costStatus == "unavailable"
            assert await _existing_candidate(
                pool, base_url + "#first", legacy_page_url=base_url, legacy_entry_url=base_url + "#first",
            ) is not None
            assert await _existing_candidate(
                pool, base_url + "#second", legacy_page_url=base_url, legacy_entry_url=base_url + "#second",
            ) is None
