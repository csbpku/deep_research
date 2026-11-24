"""Opt-in worker verification on the review task's disposable database."""

from __future__ import annotations

import os
import uuid
from urllib.parse import urlsplit

import psycopg
import pytest

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.job_runner.store import make_job_snapshot
from ai_engine.evidence_reconciliation import research_revision_hash
from ai_engine.reviewer import ClaimVerdict, ReviewResult
from ai_engine.server.app import _make_draft_factory


@pytest.mark.requires_db
@pytest.mark.parametrize("with_risks", [False, True])
async def test_draft_factory_persists_summary_and_exact_review_revision(with_risks: bool) -> None:
    dsn = os.environ.get("TEST_DATABASE_URL", "")
    if not dsn:
        pytest.skip("TEST_DATABASE_URL is not set")
    url = urlsplit(dsn)
    assert url.hostname == "127.0.0.1" and url.path == "/pr56_publication_test"
    user_id = str(uuid.uuid4())
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        await conn.execute(
            'INSERT INTO users (id, email, name, "updatedAt") VALUES (%s, %s, \'Draft summary test\', now())',
            (user_id, f"draft-summary-{user_id}@e2e.local"),
        )
    store = DbJobStore(dsn=dsn, min_size=1, max_size=2)
    body = "## 背景\n已保存的研究背景。\n\n## 结论\n已保存的条件结论。"
    if with_risks:
        body += "\n\n## 风险\n已保存的风险说明。"
    try:
        await store.open()
        snapshot = make_job_snapshot(topic="Database summary regression", requester_id=user_id, report_type="research_report")
        await store.enqueue(snapshot)
        factory = _make_draft_factory(store)
        research_id = await factory(snapshot, (), body)
        assert research_id is not None
        assert await factory(snapshot, (), body) == research_id
        async with store.pool.connection() as conn:
            row = await (await conn.execute(
                'SELECT title, body, background, conclusion, risks, tags FROM researches WHERE id = %s',
                (research_id,),
            )).fetchone()
            assert row is not None
            assert row["background"] == "已保存的研究背景。"
            assert row["conclusion"] == "已保存的条件结论。"
            assert row["risks"] == ("已保存的风险说明。" if with_risks else None)
            runs = await (await conn.execute(
                'SELECT "revisionHash" FROM research_review_runs WHERE "researchId" = %s', (research_id,),
            )).fetchall()
            assert len(runs) == 1
            assert runs[0]["revisionHash"] == research_revision_hash(row)
    finally:
        await store.close()


async def test_published_review_is_claimed_and_completed() -> None:
    dsn = os.environ.get("REVIEW_TEST_DATABASE_URL", "")
    if not dsn:
        pytest.skip("REVIEW_TEST_DATABASE_URL is not set")
    url = urlsplit(dsn)
    assert url.hostname == "127.0.0.1" and url.path == "/pr61_65_test"
    user_id, research_id, run_id = (str(uuid.uuid4()) for _ in range(3))
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        await conn.execute('INSERT INTO users (id, email, name, "updatedAt") VALUES (%s, %s, \'Review owner\', now())', (user_id, f"review-{user_id}@e2e.local"))
        await conn.execute(
            'INSERT INTO researches (id, type, status, title, body, "authorId", "creationMethod", '
            '"originContentSha256", "aiAssisted", "reviewStatus", "updatedAt") '
            "VALUES (%s, 'research', 'published', 'Worker regression', 'A supported fact.', %s, "
            "'ai_research', %s, true, 'queued', now())",
            (research_id, user_id, "0" * 64),
        )
        await conn.execute(
            'INSERT INTO research_review_runs (id, "researchId", "revisionHash", "sourceSnapshotHash", '
            '"executionStatus") VALUES (%s, %s, %s, %s, \'queued\')',
            (run_id, research_id, "0" * 64, "0" * 64),
        )
    store = DbJobStore(dsn=dsn, min_size=1, max_size=2)
    try:
        work = await store.claim_next_review("pr61-65-validation")
        assert work is not None and work.review_run_id == run_id
        result = ReviewResult("passed", claims=(ClaimVerdict(
            claim_id="C1", claim="A supported fact.", risk="low", verdict="verified", judgment_status="settled",
        ),), coverage_status="complete")
        await store.complete_review(work, result.to_dict())
        async with await psycopg.AsyncConnection.connect(dsn) as conn:
            row = await (await conn.execute('SELECT status, "reviewStatus" FROM researches WHERE id = %s', (research_id,))).fetchone()
            assert row == ("published", "passed")
            run = await (await conn.execute('SELECT "executionStatus", outcome FROM research_review_runs WHERE id = %s', (run_id,))).fetchone()
            assert run == ("completed", "clear")
    finally:
        await store.close()
