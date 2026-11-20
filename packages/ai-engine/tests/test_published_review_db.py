"""Opt-in worker verification on the review task's disposable database."""

from __future__ import annotations

import os
import uuid
from urllib.parse import urlsplit

import psycopg
import pytest

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.reviewer import ClaimVerdict, ReviewResult


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
