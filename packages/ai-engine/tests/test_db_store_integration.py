"""PostgreSQL 集成测试 — W2 review F: requires_db marker 真接测试。

跑法(需要真 PostgreSQL):
    cd packages/ai-engine
    uv run pytest tests/test_db_store_integration.py -v

跳过(本地无 DB):
    uv run pytest -m "not requires_db"
"""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path

import pytest

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.states import ReportType
from ai_engine.job_runner.db_store import AI_TABLE, DbJobStore
from ai_engine.job_runner.models import JobSnapshot


pytestmark = pytest.mark.requires_db


def _test_dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research_test",
    )


async def _clean_tables(store: DbJobStore) -> None:
    """Reset the dedicated test database so queue ordering is deterministic."""
    async with store._pool.connection() as conn:
        await conn.execute(
            'TRUNCATE TABLE "admin_actions", "product_events", "comment_stars", '
            '"comments", "ai_research_sources", "ai_research_jobs", '
            '"content_import_jobs", "research_sources", "summaries", '
            '"research_audit", "researches", "users" CASCADE'
        )
        await conn.commit()


async def _clean_optional_radar_tables(store: DbJobStore) -> None:
    """Clean Week 5 tables when the selected test database has that migration."""
    async with store.pool.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT tablename FROM pg_tables "
                "WHERE schemaname = 'public' "
                "AND tablename = ANY(%s)",
                (["radar_feedback", "radar_sync_runs", "radar_sources", "share_submissions"],),
            )
        ).fetchall()
        table_names = [f'"{row["tablename"]}"' for row in rows]
        if table_names:
            await conn.execute(f"TRUNCATE TABLE {', '.join(table_names)} RESTART IDENTITY CASCADE")
        await conn.commit()


@pytest.fixture(autouse=True)
async def isolated_database() -> None:
    store = DbJobStore(dsn=_test_dsn(), table_name=AI_TABLE)
    await store.open()
    try:
        await _clean_tables(store)
        yield
        await _clean_tables(store)
    finally:
        await store.close()


@pytest.fixture(autouse=True)
async def truncate_radar_tables() -> None:
    """Keep Week 5 queue/source rows isolated without changing old assertions."""
    store = DbJobStore(dsn=_test_dsn(), table_name=AI_TABLE)
    await store.open()
    try:
        await _clean_optional_radar_tables(store)
        yield
        await _clean_optional_radar_tables(store)
    finally:
        await store.close()


async def _new_store() -> DbJobStore:
    s = DbJobStore(dsn=_test_dsn(), table_name=AI_TABLE, lease_seconds=60, heartbeat_seconds=15)
    await s.open()
    return s


async def _prepare_user(store: DbJobStore) -> str:
    uid = str(uuid.uuid4())
    async with store._pool.connection() as conn:
        await conn.execute(
            'INSERT INTO "users" ("id", "email", "name", "role", "createdAt", "updatedAt") '
            "VALUES (%s, %s, %s, 'member', now(), now()) "
            "ON CONFLICT (id) DO NOTHING",
            (uid, f"itest-{uid[:8]}@test.local", "itest"),
        )
        await conn.commit()
    return uid


async def _snapshot(
    user_id: str,
    topic: str = "integration test",
    report_type: ReportType = "research_report",
) -> JobSnapshot:
    return JobSnapshot(
        job_id=str(uuid.uuid4()),
        requester_id=user_id,
        topic=topic,
        context=None,
        report_type=report_type,
        source_policy="prefer_user_sources",
        status="queued",
        current_step=None,
        attempts=0,
        idempotency_key=None,
        source_refs=(),
    )


class TestDbJobStoreIntegration:
    """真 PostgreSQL 的 DbJobStore 全链路测试。

    All tests tagged @pytest.mark.requires_db — CI 未配 DB 时自动跳过。
    """

    async def test_enqueue_and_acquire(self) -> None:
        """核心验证:enqueue 写 DB,acquire 读回并更新状态。

        W2 review #1 的 bug:acquire 返回 dict 但原代码探测 _fields 失败。
        """
        store = await _new_store()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "acquire test")
            await store.enqueue(snap)

            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, snap2 = acquired
            assert snap2.job_id == snap.job_id
            assert snap2.status == "running"
            assert snap2.topic == "acquire test"
        finally:
            await store.close()

    async def test_double_acquire_same_job_rejected(self) -> None:
        """双 worker 并发抢同一个 job,第二个拿不到。

        W2 review #8:DB 抢锁未覆盖测试——本测试覆盖。

        注意:单 worker 串行测试不模拟真并发,acquire 可能不会独占。
        改为两个独立 store(模拟两个进程)验证 SKIP LOCKED 语义。
        """
        store_a = await _new_store()
        store_b = await _new_store()
        try:
            user_id = await _prepare_user(store_a)
            snap = await _snapshot(user_id, "double acquire")
            await store_a.enqueue(snap)

            a1, a2 = await asyncio.gather(
                store_a.acquire_next_job("worker-A"),
                store_b.acquire_next_job("worker-B"),
            )
            assert sum(item is not None for item in (a1, a2)) == 1
        finally:
            await store_a.close()
            await store_b.close()

    async def test_heartbeat_renews_lease(self) -> None:
        store = await _new_store()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "heartbeat")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired
            hb = await store.heartbeat(lease)
            assert hb.renewed
            assert hb.lease_expires_at is not None
        finally:
            await store.close()

    async def test_mark_terminal_failed_no_draft(self) -> None:
        """终态 failed → draftResearchId=NULL 满足 CHECK。W2 review #3 验证。"""
        store = await _new_store()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "failed path")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired
            await store.mark_terminal(
                lease, "failed",
                current_step="plan",
                error_code="AI_ENGINE_UNAVAILABLE",
                error_message="integration test error",
                draft_research_id=None,
            )
            # 验证:get_row 能读回
            row = await store.get_row(snap.job_id)
            assert row is not None
            assert row.snapshot.status == "failed"
            assert row.last_error_code == "AI_ENGINE_UNAVAILABLE"
        finally:
            await store.close()

    async def test_mark_terminal_partial_with_sources(self) -> None:
        """终态 partial + record_progress ≥3 sources → CHECK 接受。"""
        store = await _new_store()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "partial path")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired
            # 写 3 sources 满足 CHECK
            await store.record_progress(
                lease,
                current_step="search",
                token_in=100, token_out=200, cost_cents=5,
                sources=[
                    AdapterSource(
                        source_ref={"type": "url", "value": f"https://real.example.it/item-{i}"},
                        canonical_key=f"real.example.it::partial::{i}",
                        title=f"Real source {i}",
                        snippet=f"Integration test source {i}",
                        score=0.8,
                        step_captured="search",
                        is_accessible=True,
                    )
                    for i in range(3)
                ],
            )
            await store.mark_terminal(
                lease, "partial",
                current_step="search",
                error_code="WORKER_TIMEOUT",
                error_message="partial path integration test",
                draft_research_id=None,
            )
            row = await store.get_row(snap.job_id)
            assert row is not None
            assert row.snapshot.status == "partial"
            assert len(row.last_sources) >= 3
        finally:
            await store.close()

    async def test_mark_terminal_succeeded_with_draft(self) -> None:
        """终态 succeeded + 真 draftResearchId → CHECK 接受。W2 review #3。"""
        store = await _new_store()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "succeeded path")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired
            # 先创建真 research row
            research_id = str(uuid.uuid4())
            async with store._pool.connection() as conn:
                await conn.execute(
                    'INSERT INTO "researches" ("id", "type", "status", "title", "body", "authorId", "createdAt", "updatedAt") '
                    "VALUES (%s, 'research', 'draft', %s, 'integration body', %s, now(), now())",
                    (research_id, "itest succeeded draft", user_id),
                )
                await conn.commit()
            # 写 1 source 满足 CHECK
            await store.record_progress(
                lease,
                current_step="write",
                token_in=50, token_out=50, cost_cents=2,
                sources=[
                    AdapterSource(
                        source_ref={"type": "url", "value": "https://real.example.it/succeeded-0"},
                        canonical_key="real.example.it::succeeded::0",
                        title="Real source succeeded",
                        snippet="Integration test source succeeded",
                        score=0.95,
                        step_captured="search",
                        is_accessible=True,
                    ),
                ],
            )
            await store.mark_terminal(
                lease, "succeeded",
                current_step="write",
                error_code=None,
                error_message=None,
                draft_research_id=research_id,
            )
            row = await store.get_row(snap.job_id)
            assert row is not None
            assert row.snapshot.status == "succeeded"
            assert len(row.last_sources) >= 1
            assert row.draft_research_id == research_id
        finally:
            await store.close()

    async def test_summary_brief_succeeds_without_sources_or_draft(self) -> None:
        store = await _new_store()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(
                user_id,
                "summary brief path",
                report_type="summary_brief",
            )
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired

            await store.mark_terminal(
                lease,
                "succeeded",
                current_step="write",
                error_code=None,
                error_message=None,
                draft_research_id=None,
                output_text="# Brief\n\nInline result.",
            )

            row = await store.get_row(snap.job_id)
            assert row is not None
            assert row.snapshot.status == "succeeded"
            assert row.draft_research_id is None
            assert row.output_text == "# Brief\n\nInline result."
            assert row.last_sources == ()
        finally:
            await store.close()

    async def test_reaper_requeues_expired_lease(self) -> None:
        store = await _new_store()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "reaper test")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired
            # 把 lease 拨到过去
            async with store._pool.connection() as conn:
                await conn.execute(
                    f'UPDATE "{AI_TABLE}" SET "leaseExpiresAt" = now() - interval \'1 minute\' WHERE "id" = %s',
                    (lease.job_id,),
                )
            n = await store.reap_expired_leases()
            assert n >= 1
        finally:
            await store.close()

    async def test_record_product_event(self) -> None:
        store = await _new_store()
        try:
            user_id = await _prepare_user(store)
            dedupe = str(uuid.uuid4())
            await store.record_product_event(
                user_id=user_id,
                event_name="test.integration",
                dedupe_key=dedupe,
            )
            # 重复写入应忽略(ON CONFLICT DO NOTHING)
            await store.record_product_event(
                user_id=user_id,
                event_name="test.integration",
                dedupe_key=dedupe,
            )
            # 验证写入
            async with store._pool.connection() as conn:
                cur = await conn.execute(
                    'SELECT count(*) FROM "product_events" WHERE "dedupeKey" = %s',
                    (dedupe,),
                )
                row = await cur.fetchone()
                # row is a tuple (count,) in default psycopg
                count = row[0] if isinstance(row, tuple) else row["count"] if isinstance(row, dict) else 0
                assert count == 1
        finally:
            await store.close()


class TestImportJobStoreIntegration:
    """W3: content_import_jobs 表全链路测试 (enqueue/acquire/heartbeat/mark_terminal/reap)。

    复用 DbJobStore 的 lease 语义,验证 import 表专有字段 (sourceKind/outputResearchId)。
    """

    async def test_enqueue_and_acquire_import_job(self) -> None:
        """enqueue + acquire 对 import 表:不抛 SQL 错误。W2 review #4 fix。"""
        from ai_engine.job_runner.db_store import IMPORT_TABLE

        store = DbJobStore(dsn=_test_dsn(), table_name=IMPORT_TABLE, lease_seconds=60, heartbeat_seconds=15)
        await store.open()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "import test")
            await store.enqueue(snap)

            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, snap2 = acquired
            assert snap2.job_id == snap.job_id
            assert snap2.status == "running"
        finally:
            await store.close()

    async def test_heartbeat_import_job(self) -> None:
        from ai_engine.job_runner.db_store import IMPORT_TABLE

        store = DbJobStore(dsn=_test_dsn(), table_name=IMPORT_TABLE, lease_seconds=60, heartbeat_seconds=15)
        await store.open()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "import heartbeat")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired
            hb = await store.heartbeat(lease)
            assert hb.renewed
            assert hb.lease_expires_at is not None
        finally:
            await store.close()

    async def test_mark_terminal_import_succeeded(self) -> None:
        """import 表 succeeded → outputResearchId 写入。验证不抛 SQL 错误。"""
        import uuid as _uuid
        from ai_engine.job_runner.db_store import IMPORT_TABLE

        store = DbJobStore(dsn=_test_dsn(), table_name=IMPORT_TABLE, lease_seconds=60, heartbeat_seconds=15)
        await store.open()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "import succeeded")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired

            # 先创建真 research row 作为 output
            research_id = str(_uuid.uuid4())
            async with store._pool.connection() as conn:
                await conn.execute(
                    'INSERT INTO "researches" ("id", "type", "status", "title", "body", "authorId", "createdAt", "updatedAt") '
                    "VALUES (%s, 'research', 'draft', %s, 'import test body', %s, now(), now())",
                    (research_id, "import succeeded draft", user_id),
                )
                await conn.commit()

            await store.mark_terminal(
                lease, "succeeded",
                current_step=None,
                error_code=None,
                error_message=None,
                draft_research_id=research_id,
            )
            row = await store.get_row(snap.job_id)
            assert row is not None
            assert row.snapshot.status == "succeeded"
        finally:
            await store.close()

    async def test_mark_terminal_import_failed(self) -> None:
        """import 表 failed → errorCode 写入,outputResearchId=NULL。"""
        from ai_engine.job_runner.db_store import IMPORT_TABLE

        store = DbJobStore(dsn=_test_dsn(), table_name=IMPORT_TABLE, lease_seconds=60, heartbeat_seconds=15)
        await store.open()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "import failed")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired

            await store.mark_terminal(
                lease, "failed",
                current_step=None,
                error_code="IMPORT_NOT_UTF8",
                error_message="integration test import error",
                draft_research_id=None,
            )
            row = await store.get_row(snap.job_id)
            assert row is not None
            assert row.snapshot.status == "failed"
            assert row.last_error_code == "IMPORT_NOT_UTF8"
        finally:
            await store.close()

    async def test_reaper_import_job(self) -> None:
        """import 表 reaper:过期 lease 被回收。"""
        from ai_engine.job_runner.db_store import IMPORT_TABLE

        store = DbJobStore(dsn=_test_dsn(), table_name=IMPORT_TABLE, lease_seconds=60, heartbeat_seconds=15)
        await store.open()
        try:
            user_id = await _prepare_user(store)
            snap = await _snapshot(user_id, "import reaper")
            await store.enqueue(snap)
            acquired = await store.acquire_next_job("worker-1")
            assert acquired is not None
            lease, _ = acquired
            # 拨租约到过去
            async with store._pool.connection() as conn:
                await conn.execute(
                    'UPDATE "content_import_jobs" SET "leaseExpiresAt" = now() - interval \'1 minute\' WHERE "id" = %s',
                    (lease.job_id,),
                )
            n = await store.reap_expired_leases()
            assert n >= 1
        finally:
            await store.close()

    async def test_import_worker_creates_sanitized_private_draft(
        self, tmp_path: Path
    ) -> None:
        from ai_engine.import_worker import run_one_import_job
        from ai_engine.job_runner.db_store import IMPORT_TABLE

        store = DbJobStore(dsn=_test_dsn(), table_name=IMPORT_TABLE)
        await store.open()
        try:
            user_id = await _prepare_user(store)
            job_id = str(uuid.uuid4())
            object_key = f"{uuid.uuid4()}.html"
            temp_path = tmp_path / object_key
            temp_path.write_text(
                '<h1>Imported</h1><p onclick="bad()">Body</p><script>secret()</script>',
                encoding="utf-8",
            )
            async with store.pool.connection() as conn:
                await conn.execute(
                    'INSERT INTO "content_import_jobs" '
                    '("id", "requesterId", "sourceKind", "status", "originalFilename", '
                    '"mimeType", "sizeBytes", "tempObjectKey", "converterVersion", "createdAt") '
                    "VALUES (%s, %s, 'file', 'queued', 'notes.html', 'text/html', %s, %s, '1.0.0', now())",
                    (job_id, user_id, temp_path.stat().st_size, object_key),
                )
                await conn.commit()

            assert await run_one_import_job(store, worker_id="import-test", temp_dir=tmp_path) == job_id
            async with store.pool.connection() as conn:
                row = await (
                    await conn.execute(
                        'SELECT j."status", j."outputResearchId", r."status" AS research_status, '
                        'r."body", r."creationMethod", r."aiAssisted" '
                        'FROM "content_import_jobs" j JOIN "researches" r '
                        'ON r."id" = j."outputResearchId" WHERE j."id" = %s',
                        (job_id,),
                    )
                ).fetchone()
                audit = await (
                    await conn.execute(
                        'SELECT count(*) AS count FROM "research_audit" WHERE "researchId" = %s',
                        (row["outputResearchId"],),
                    )
                ).fetchone()
            assert row["status"] == "succeeded"
            assert row["research_status"] == "draft"
            assert row["creationMethod"] == "file_import"
            assert row["aiAssisted"] is False
            assert "# Imported" in row["body"]
            assert "secret()" not in row["body"]
            assert audit["count"] == 1
            assert not temp_path.exists()
        finally:
            await store.close()


class TestIngestionIntegration:
    """W3: 真实 ingestion pipeline 集成测试 (RSS + Arxiv -> summaries 表)。"""

    async def test_ingestion_pipeline_writes_summaries(self) -> None:
        """Deterministic adapter + real DB verifies publish and URL idempotency."""
        from ai_engine.adapters.fake import FakeAdapter
        from ai_engine.ingestion.pipeline import run_ingestion as _run_ingestion
        from psycopg_pool import AsyncConnectionPool
        from psycopg.rows import dict_row

        dsn = _test_dsn()
        pool = AsyncConnectionPool(
            conninfo=dsn, min_size=1, max_size=2,
            kwargs={"row_factory": dict_row}, open=False,
        )
        await pool.open()
        await pool.wait()
        async def fake_rss(*args: object, **kwargs: object) -> list[dict[str, object]]:
            return [{
                "title": "DB ingestion",
                "url": "https://example.com/db-ingestion?utm_source=test",
                "snippet": "Verified input",
                "source": "daily",
                "content_origin": "rss",
                "tags": ["test"],
            }]

        async def fake_arxiv(*args: object, **kwargs: object) -> list[dict[str, object]]:
            return []
        try:
            args = {
                "adapter": FakeAdapter(),
                "fetch_rss": fake_rss,
                "fetch_arxiv_items": fake_arxiv,
            }
            result = await _run_ingestion(pool, **args)
            assert result.summaries_inserted == 1
            assert result.token_input_total > 0

            result2 = await _run_ingestion(pool, **args)
            assert result2.duplicates_skipped == 1
            assert len(result2.errors) == 0, f"Second run should have no errors: {result2.errors}"

            # Verify data in DB
            async with pool.connection() as conn:
                cur = await conn.execute(
                    'SELECT count(*) AS count FROM "summaries" '
                    'WHERE "source" = %s AND "status" = \'published\' '
                    'AND "publishedAt" IS NOT NULL AND "ingestionTokenCount" > 0',
                    ("daily",),
                )
                row = await cur.fetchone()
                count = row[0] if isinstance(row, tuple) else row.get("count", 0)
                assert count >= 1, "At least one summary should exist in DB"
        finally:
            await pool.close()
