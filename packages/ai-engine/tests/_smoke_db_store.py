"""一次性真 PostgreSQL smoke test — W2 review 验证 DbJobStore 真能跑。

不放到正式测试文件,因为它需要本地 PostgreSQL + 干净表。
跑法: cd packages/ai-engine && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/deep_research uv run python tests/_smoke_db_store.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid

sys.path.insert(0, ".")

from ai_engine.job_runner.db_store import AI_TABLE, DbJobStore
from ai_engine.job_runner.models import JobSnapshot


async def main() -> None:
    dsn = os.environ.get(
        "DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research",
    )
    store = DbJobStore(dsn=dsn, table_name=AI_TABLE, lease_seconds=60, heartbeat_seconds=15)
    await store.open()
    try:
        # 清表
        async with store._pool.connection() as conn:
            await conn.execute(f'DELETE FROM "{AI_TABLE}"')

        # 准备一个真 user(FK)
        async with store._pool.connection() as conn:
            user_id = str(uuid.uuid4())
            await conn.execute(
                'INSERT INTO "users" ("id", "email", "name", "role", "createdAt", "updatedAt") '
                "VALUES (%s, %s, %s, 'member', now(), now()) "
                "ON CONFLICT (id) DO NOTHING",
                (user_id, f"smoke-{user_id[:8]}@test.local", "smoke"),
            )
            await conn.commit()  # psycopg default autocommit=False; commit so research INSERT 可见

        # enqueue 一个 job
        snap = JobSnapshot(
            job_id=str(uuid.uuid4()),
            requester_id=user_id,
            topic="smoke test topic",
            context="smoke context",
            report_type="research_report",
            source_policy="prefer_user_sources",
            status="queued",
            current_step=None,
            attempts=0,
            idempotency_key=None,
            source_refs=(),
        )
        await store.enqueue(snap)
        print(f"[OK] enqueued job_id={snap.job_id}")

        # acquire_next_job — 这是 review 指出的失败点
        try:
            acquired = await store.acquire_next_job(worker_id="smoke-worker")
        except Exception as e:
            print(f"[FAIL] acquire_next_job raised: {type(e).__name__}: {e}")
            raise
        assert acquired is not None, "expected to acquire the job we just enqueued"
        lease, snap2 = acquired
        print(f"[OK] acquired job_id={snap2.job_id} status={snap2.status} topic={snap2.topic}")

        # 二次 acquire — 应拿不到(同一个 worker 持锁)
        acquired2 = await store.acquire_next_job(worker_id="smoke-worker-2")
        assert acquired2 is None, f"second worker should not acquire, got {acquired2}"
        print("[OK] second worker cannot acquire while lease held")

        # heartbeat
        hb = await store.heartbeat(lease)
        assert hb.renewed, f"heartbeat should renew, got {hb}"
        print(f"[OK] heartbeat renewed until {hb.lease_expires_at}")

        # mark_terminal failed — 不需要 draft
        await store.mark_terminal(
            lease, "failed",
            current_step="plan",
            error_code="AI_ENGINE_UNAVAILABLE",
            error_message="smoke test failed path",
            draft_research_id=None,
        )
        print("[OK] mark_terminal(failed, draft=None) accepted")

        # 准备 succeeded 路径:需要一个真 researches 行
        async with store._pool.connection() as conn:
            research_id = str(uuid.uuid4())
            research_title = f"smoke title {uuid.uuid4()}"
            await conn.execute(
                'INSERT INTO "researches" ("id", "type", "status", "title", "body", "authorId", "createdAt", "updatedAt") '
                "VALUES (%s, 'research', 'draft', %s, 'smoke body', %s, now(), now())",
                (research_id, research_title, user_id),
            )
            await conn.commit()  # 让 research row 跨 connection 可见
            # 再 enqueue 一个新 job 给 succeeded 路径
            snap3 = JobSnapshot(
                job_id=str(uuid.uuid4()),
                requester_id=user_id,
                topic="succeeded path",
                context=None,
                report_type="research_report",
                source_policy="prefer_user_sources",
                status="queued",
                current_step=None,
                attempts=0,
                idempotency_key=None,
                source_refs=(),
            )
            await store.enqueue(snap3)
            acquired3 = await store.acquire_next_job(worker_id="smoke-worker-3")
            assert acquired3 is not None
            lease3, _ = acquired3
            # W2 review 修正:caller 必须 record_progress 写真 sources,
            # db_store 不再自造 _sentinel。
            from ai_engine.adapters.base import AdapterSource
            await store.record_progress(
                lease3,
                current_step="write",
                token_in=100, token_out=200, cost_cents=5,
                sources=[
                    AdapterSource(
                        source_ref={"type": "url", "value": "https://real.example.test/article-0"},
                        canonical_key="real.example.test::succeeded path::0",
                        title="Real source for succeeded path",
                        snippet="Real source smoke (placeholder URL, real record).",
                        score=0.9,
                        step_captured="search",
                        is_accessible=True,
                    ),
                ],
            )
            await store.mark_terminal(
                lease3, "succeeded",
                current_step="write",
                error_code=None,
                error_message=None,
                draft_research_id=research_id,
            )
            print(f"[OK] mark_terminal(succeeded, draft={research_id[:8]}) accepted with real source")

        # 验证 succeeded 必传 draft — ValueError
        snap4 = JobSnapshot(
            job_id=str(uuid.uuid4()),
            requester_id=user_id,
            topic="no draft",
            context=None,
            report_type="research_report",
            source_policy="prefer_user_sources",
            status="queued",
            current_step=None,
            attempts=0,
            idempotency_key=None,
            source_refs=(),
        )
        await store.enqueue(snap4)
        acquired4 = await store.acquire_next_job(worker_id="smoke-worker-4")
        lease4, _ = acquired4
        try:
            await store.mark_terminal(
                lease4, "succeeded",
                current_step="write",
                error_code=None,
                error_message=None,
                draft_research_id=None,
            )
            print("[FAIL] succeeded without draft should have raised ValueError")
            sys.exit(1)
        except ValueError as e:
            print(f"[OK] succeeded without draft rejected: {e}")

        # 验证 partial 时 draft=None(不应传)
        try:
            await store.mark_terminal(
                lease4, "partial",
                current_step="search",
                error_code="WORKER_TIMEOUT",
                error_message="smoke",
                draft_research_id="11111111-1111-1111-1111-111111111111",
            )
            print("[FAIL] partial with draft should have raised ValueError")
            sys.exit(1)
        except ValueError as e:
            print(f"[OK] partial with draft rejected: {e}")

        # reaper — enqueue 一个新 job,把 lease 过期,扫一次
        snap5 = JobSnapshot(
            job_id=str(uuid.uuid4()),
            requester_id=user_id,
            topic="reaper test",
            context=None,
            report_type="research_report",
            source_policy="prefer_user_sources",
            status="queued",
            current_step=None,
            attempts=0,
            idempotency_key=None,
            source_refs=(),
        )
        await store.enqueue(snap5)
        acquired5 = await store.acquire_next_job(worker_id="reaper-test-worker")
        lease5, _ = acquired5
        # 把 lease_expires_at 拨到过去
        async with store._pool.connection() as conn:
            await conn.execute(
                f'UPDATE "{AI_TABLE}" SET "leaseExpiresAt" = now() - interval \'1 minute\' WHERE "id" = %s',
                (lease5.job_id,),
            )
        n = await store.reap_expired_leases()
        print(f"[OK] reaper swept {n} leases (expected ≥1)")

        # 清表
        async with store._pool.connection() as conn:
            await conn.execute(f'DELETE FROM "{AI_TABLE}"')
            await conn.execute('DELETE FROM "researches" WHERE title LIKE %s', ("smoke title %",))
            await conn.execute('DELETE FROM "users" WHERE email LIKE %s', (f"smoke-{user_id[:8]}@test.local",))
        print("[OK] cleanup done")
    finally:
        await store.close()


if __name__ == "__main__":
    asyncio.run(main())